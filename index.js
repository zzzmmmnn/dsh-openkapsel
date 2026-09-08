/**
 * dsh-openkapsel — OpenKapsel workspace bridge for the DeepSeek Harness.
 *
 * A thin Host-side Cordis plugin. It does NOT reimplement the OpenKapsel REST
 * client in Node; instead it REUSES the workspace-published `openkapsel-rest`
 * skill's own Python helpers (`openkapsel_http.py`, `openkapsel_config.py`),
 * which are vendored under `skill/`. Each `kapsel_*` tool shells out to those
 * helpers through the harness `shell` (bash) executor, so authentication,
 * Context attribution, error handling, and credential renewal stay owned by the
 * maintained skill code — not by this plugin.
 *
 * Flow:
 *   1. `kapsel_config(workspace_url, control_token)` runs
 *      `openkapsel_config.py init` to write a session-private credential file
 *      under the DSH state directory (never the local project), then
 *      selects/creates an active root Plan for mutation attribution.
 *   2. The plugin registers the vendored skill into `ctx.skills`, so the model
 *      can `skill("openkapsel-rest")` and read the authoritative REST contract.
 *   3. The typed tools and the generic `kapsel_http` execute
 *      `openkapsel_http.py METHOD endpoint …` in that private state directory.
 *
 * Requires `python3` on PATH (the skill itself is Python).
 */
import { chmodSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { approveEscalation, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox';

export const name = 'kapsel';

export const inject = ['shell', 'tools', 'skills', 'sandboxPolicy'];

/** Vendored skill directory, resolved relative to this module. */
const SKILL_DIR = fileURLToPath(new URL('./skill/openkapsel-rest/', import.meta.url));

const SKILL_NAME = 'openkapsel-rest';
const DEFAULT_TASKNAME = 'dsh';
const MESSAGE_MAX = 200;
const TASKNAME_MAX = 32;
const TASKNAME_DESCRIPTION =
  'Context task grouping name. Resolution order: this call, the selected active Plan/session value, kapsel_config, plugin config, then "dsh".';
const MESSAGE_DESCRIPTION =
  'Short Context operation message. Blank or omitted values use a safe operation-specific default.';

export const REMOTE_TOOL_NAMES = Object.freeze([
  'kapsel_config',
  'kapsel_status',
  'kapsel_plan_update',
  'kapsel_http',
  'kapsel_fs_list',
  'kapsel_fs_read',
  'kapsel_fs_stat',
  'kapsel_fs_write',
  'kapsel_fs_replace',
  'kapsel_shell_exec',
  'kapsel_task_output',
]);

// No model-authored code runtime is admitted on the DSH host.
export const SAFE_AUXILIARY_TOOL_NAMES = Object.freeze([
  'skill',
  'ask_user_question',
  'todo_write',
]);

const REMOTE_ONLY_TOOL_NAMES = new Set([
  ...REMOTE_TOOL_NAMES,
  ...SAFE_AUXILIARY_TOOL_NAMES,
]);

const REMOTE_WRITE_ESCALATION_PARAMETERS = {
  sandbox_permissions: {
    type: 'string',
    enum: ['workspace-write'],
    description:
      'One-call DSH approval request for a remote mutation denied by read-only mode. Retry the denied call with "workspace-write" and justification.',
  },
  justification: {
    type: 'string',
    description:
      'Required with sandbox_permissions: one sentence explaining why this remote workspace mutation is needed.',
  },
};

export function shellQuote(value) {
  if (String(value).includes('\0')) {
    throw new Error('Shell transport arguments must not contain NUL');
  }
  // POSIX single-quote escaping: 'x' -> '\''  within '…'.
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isContextManagementEndpoint(endpoint) {
  const path = String(endpoint).split(/[?#]/, 1)[0].replace(/^\/+/, '');
  return path === 'context' || path.startsWith('context/');
}

function firstNonEmptyText(values, fallback, maxLength) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text.slice(0, maxLength);
  }
  return fallback.slice(0, maxLength);
}

function resolvedTaskname(...values) {
  return firstNonEmptyText(values, DEFAULT_TASKNAME, TASKNAME_MAX);
}

function resolvedMessage(value) {
  return firstNonEmptyText([value], 'dsh-openkapsel operation', MESSAGE_MAX);
}

export function apply(ctx, config = {}) {
  const shell = ctx.shell; // injected
  const sandboxPolicy = ctx.sandboxPolicy; // injected

  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const stateRoot = config.stateDir || join(dshHome, 'state', 'dsh-openkapsel');
  if (!isAbsolute(stateRoot)) {
    throw new Error('dsh-openkapsel: stateDir must be an absolute path');
  }
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  chmodSync(stateRoot, 0o700);

  // A preset is mounted once and shared by every session selecting it. Never
  // keep active workspace or Plan data in one plugin-global object.
  const sessionStates = new WeakMap();

  const PY_HTTP = join(SKILL_DIR, 'scripts', 'openkapsel_http.py');
  const PY_CONFIG = join(SKILL_DIR, 'scripts', 'openkapsel_config.py');

  function policyOf(exec) {
    if (!exec?.agent?.session) {
      throw new Error('dsh-openkapsel: tool execution is missing its owning session');
    }
    return sandboxPolicy.resolve({ session: exec.agent.session });
  }

  /**
   * Authorize one remote mutation against the DSH session policy. For this
   * bridge, workspace-write and danger-full-access are equivalent: the remote
   * OpenKapsel token remains the authoritative path/capability boundary.
   */
  async function authorizeRemoteMutation(args, exec, toolName, subject) {
    validateEscalationArgs(args.sandbox_permissions, args.justification);
    const standingPolicy = policyOf(exec);
    if (args.sandbox_permissions === undefined) {
      if (standingPolicy.mode !== 'read-only') return standingPolicy.mode;
      throw new Error(
        'DSH sandbox denied this remote mutation in read-only mode. '
        + 'Retry the same call with sandbox_permissions="workspace-write" and a one-sentence justification to request one-call approval.',
      );
    }
    return approveEscalation({
      requestedMode: args.sandbox_permissions,
      justification: args.justification,
      effectiveMode: standingPolicy.mode,
      subject,
    }, {
      approver: ctx.get('approval'),
      agent: exec.agent,
      callId: exec.callId,
      toolName,
      signal: exec.signal,
    });
  }

  function stateOf(exec) {
    const agent = exec?.agent;
    if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) {
      throw new Error('dsh-openkapsel: tool execution is missing its owning agent');
    }
    let state = sessionStates.get(agent);
    if (state) return state;

    const agentId = String(agent.id ?? agent.session?.header?.id ?? '');
    if (!agentId) throw new Error('dsh-openkapsel: owning agent has no session id');
    const directoryName = createHash('sha256').update(agentId).digest('hex');
    const directory = join(stateRoot, directoryName);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    state = {
      planId: null,
      // Keep the fallback materialized so a Host restart can reuse persisted
      // credentials without first requiring kapsel_config in the new process.
      taskname: resolvedTaskname(config.taskname),
      sessionId: agent.id ?? agent.session?.header?.id,
      directory,
      envFile: join(directory, '.openkapsel.env'),
    };
    sessionStates.set(agent, state);
    return state;
  }

  /** Run a Python helper, capturing stdout; throws on non-zero exit. */
  async function runPython(argvTail, { script, workdir, sessionId, timeoutMs, stdoutMaxBytes, signal } = {}) {
    const command = ['python3', '-B', '-E', '-s', script, ...argvTail].map(shellQuote).join(' ');
    const result = await shell.run(
      shell.resolve({
        command,
        workdir,
        timeoutMs,
        stdoutMaxBytes: stdoutMaxBytes ?? 4_000_000,
        signal,
        sandboxPolicy: {
          mode: 'workspace-write',
          workspaceRoot: workdir,
          ...(sessionId ? { sessionId } : {}),
        },
      }),
    );
    if (result.exitCode !== 0) {
      const detail = (result.stderr?.text ?? '').trim() || (result.stdout?.text ?? '').trim();
      throw new Error(`openkapsel: ${detail || `python helper exited ${result.exitCode}`}`);
    }
    return result.stdout?.text ?? '';
  }

  /**
   * Execute one OpenKapsel REST call through `openkapsel_http.py`.
   * Context (`plan_id`/`taskname`/`message`) is passed together when `planId` is
   * supplied; the helper merges it into JSON bodies and header-Carrying
   * bodyless requests as the server requires.
   */
  async function http(method, endpoint, options = {}) {
    const { query, json, planId, taskname, message, exec, signal, timeoutMs, stdoutMaxBytes } = options;
    const state = stateOf(exec);
    const argv = [method, endpoint, '--env-file', state.envFile];
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === '') continue;
      argv.push('--query', `${k}=${String(v)}`);
    }
    if (json !== undefined && json !== null) argv.push('--json', JSON.stringify(json));
    if (planId !== undefined && planId !== null) {
      argv.push('--plan-id', String(planId), '--taskname', String(taskname), '--message', String(message));
    }
    const out = await runPython(argv, {
      script: PY_HTTP,
      workdir: state.directory,
      sessionId: state.sessionId,
      timeoutMs,
      stdoutMaxBytes,
      signal,
    });
    return parseJson(out);
  }

  async function ensurePlan(exec, { allowCreate = true } = {}) {
    const state = stateOf(exec);
    if (state.planId) return state.planId;
    const taskname = resolvedTaskname(state.taskname, config.taskname);
    const listing = await http('GET', 'context', {
      query: { type: 'plan', status: 'in_progress', root_plans: true, limit: 20 },
      exec,
      signal: exec.signal,
    });
    const entries = listing?.entries ?? (Array.isArray(listing) ? listing : []);
    if (entries.length > 0) {
      state.planId = entries[0].id;
      state.taskname = resolvedTaskname(entries[0].taskname, state.taskname, config.taskname);
      return state.planId;
    }
    if (!allowCreate) return null;
    const created = await http('POST', 'context', {
      json: { type: 'plan', taskname, content: 'DeepSeek Harness (dsh-openkapsel) workspace access session.' },
      exec,
      signal: exec.signal,
    });
    state.planId = created?.id ?? null;
    return state.planId;
  }

  /** Resolve the (plan_id, taskname, message) Context every mutation requires. */
  async function mutationContext(args, exec) {
    const state = stateOf(exec);
    const planId = args.plan_id ?? (await ensurePlan(exec));
    // ensurePlan may recover the taskname from a persisted active Plan after a
    // Host restart, so resolve the final taskname only after Plan selection.
    const taskname = resolvedTaskname(args.taskname, state.taskname, config.taskname);
    const message = resolvedMessage(args.message);
    if (planId === null || planId === undefined) {
      throw new Error('no active OpenKapsel Plan; run kapsel_config (create_plan defaults true) or pass plan_id');
    }
    return { planId, taskname, message };
  }

  // ── vendored skill registration ───────────────────────────────────────────
  function vendoredSkillContent() {
    const parts = [];
    for (const line of readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8').split('\n')) {
      parts.push(line.startsWith('---') ? '' : line); // drop frontmatter fence
    }
    for (const ref of readdirSync(join(SKILL_DIR, 'references')).sort()) {
      parts.push(`\n\n---\n\n# references/${ref}\n\n` + readFileSync(join(SKILL_DIR, 'references', ref), 'utf8'));
    }
    return parts.join('\n');
  }

  const skillDescription =
    /^description:\s*(.+)$/m.exec(readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8'))?.[1] ??
    'Operate an OpenKapsel workspace through its REST, raw-transfer, sharing, preview, and FastAPI HTTP surfaces.';

  ctx.skills.register({
    name: SKILL_NAME,
    description: skillDescription,
    source: 'bundled',
    content: vendoredSkillContent(),
    resourceBase: { kind: 'directory', path: SKILL_DIR },
  });

  // ── shared output helpers ────────────────────────────────────────────────
  function valueText(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return text;
  }

  function renderText(_args, value) {
    return [{ type: 'text', text: valueText(value) }];
  }

  // ── tools ─────────────────────────────────────────────────────────────────
  const tools = [
    defineTool({
      name: 'kapsel_config',
      description:
        'Configure the OpenKapsel workspace the kapsel_* tools operate on: writes credentials to this DSH session\'s private plugin state (never the local project), then by default selects or creates an active root Plan used to attribute mutations. Run it again to switch workspaces or rotate credentials.',
      parameters: {
        workspace_url: {
          type: 'string',
          required: true,
          description: 'OpenKapsel read-only capability URL, e.g. https://host/kapsel/w/<READ_TOKEN>.',
        },
        control_token: {
          type: 'string',
          required: true,
          description: 'Matching privileged control token (Authorization: Bearer). Required for writes/shell/context.',
        },
        taskname: { type: 'string', description: `${TASKNAME_DESCRIPTION} This value becomes the session default.` },
        create_plan: { type: 'boolean', description: 'Select/create an active root Plan (default true).' },
        force: { type: 'boolean', description: 'Replace different credentials already stored for this DSH session.' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
      async execute(args, exec) {
        const state = stateOf(exec);
        const taskname = resolvedTaskname(args.taskname, config.taskname);
        state.taskname = taskname;
        state.planId = null;

        const initArgv = ['init', args.workspace_url, args.control_token];
        if (args.force) initArgv.push('--force');
        const initOut = await runPython(initArgv, {
          script: PY_CONFIG,
          workdir: state.directory,
          sessionId: state.sessionId,
          signal: exec.signal,
        });
        let init = parseJson(initOut);
        if (init && typeof init === 'object') {
          // Do not reveal host-private state paths to the model or its logs.
          init = { action: init.action ?? null, mode: init.mode ?? '0600' };
        }

        let discovery = null;
        try {
          discovery = await http('GET', '/', { exec, signal: exec.signal });
        } catch {
          /* non-fatal — the capability summary is best-effort */
        }

        let planId = null;
        if (args.create_plan !== false) {
          try {
            planId = await ensurePlan(exec, {
              // Configuring a read-only session may select an existing Plan but
              // must not create one as a hidden remote mutation.
              allowCreate: policyOf(exec).mode !== 'read-only',
            });
          } catch (err) {
            // Still report a successful config; surface the plan failure separately.
            init = { ...(init ?? {}), plan_error: String(err?.message ?? err) };
          }
        }

        return {
          config: init,
          plan_id: planId,
          dsh_sandbox_mode: policyOf(exec).mode,
          workspace: { name: discovery?.name ?? null, capabilities: discovery?.capabilities ?? null },
        };
      },
    }),

    defineTool({
      name: 'kapsel_status',
      description:
        'Report the OpenKapsel workspace currently selected in this DSH session: Discovery capability summary and the active Plan id. Tokens and host-private state paths are never echoed.',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
      async execute(_args, exec) {
        const state = stateOf(exec);
        let discovery = null;
        try {
          discovery = await http('GET', '/', { exec, signal: exec.signal });
        } catch {
          /* not configured yet */
        }
        return {
          plan_id: state.planId ?? null,
          taskname: state.taskname || null,
          dsh_sandbox_mode: policyOf(exec).mode,
          workspace: discovery
            ? {
                name: discovery.name ?? null,
                capabilities: discovery.capabilities ?? null,
                mcp: discovery.mcp?.enabled ? { tool_count: discovery.mcp.available_tool_count } : null,
              }
            : null,
        };
      },
    }),

    defineTool({
      name: 'kapsel_plan_update',
      description:
        'Update or complete an OpenKapsel Plan (PATCH /context/plans/<id>). Use this instead of kapsel_http for Plan updates so the target Plan id cannot be confused with the optional parent Plan id. Completion requires a structured debrief.',
      parameters: {
        plan_id: { type: 'integer', required: true, description: 'Target Plan id to update.' },
        taskname: { type: 'string', description: TASKNAME_DESCRIPTION },
        content: { type: 'string', description: 'Replacement Plan content.' },
        status: {
          type: 'string',
          enum: ['in_progress', 'completed', 'cancelled'],
          description: 'Replacement Plan status.',
        },
        parent_plan_id: { type: 'integer', description: 'Move this Plan below another Plan.' },
        move_to_root: { type: 'boolean', description: 'Move this Plan to the root level.' },
        debrief: {
          type: 'object',
          additionalProperties: false,
          description: 'Required with status="completed" and invalid for other statuses.',
          properties: {
            summary: { type: 'string', required: true, description: 'Concise completion summary.' },
            outcome: {
              type: 'string',
              required: true,
              enum: ['succeeded', 'partial', 'no_change'],
            },
            memory_actions: {
              type: 'array',
              required: true,
              items: { type: 'object', additionalProperties: true },
              description: 'Memory actions from the OpenKapsel Memory contract; use [] when none apply.',
            },
          },
        },
        ...REMOTE_WRITE_ESCALATION_PARAMETERS,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
      async execute(args, exec) {
        await authorizeRemoteMutation(args, exec, 'kapsel_plan_update', 'remote Plan update');
        if (args.parent_plan_id !== undefined && args.move_to_root === true) {
          throw new Error('parent_plan_id and move_to_root cannot be used together');
        }
        if (args.status === 'completed' && args.debrief === undefined) {
          throw new Error('completing an OpenKapsel Plan requires a debrief object');
        }
        if (args.debrief !== undefined && args.status !== 'completed') {
          throw new Error('debrief is valid only with status="completed"');
        }
        if (
          args.content === undefined
          && args.status === undefined
          && args.parent_plan_id === undefined
          && args.move_to_root !== true
        ) {
          throw new Error('Plan update requires content, status, parent_plan_id, or move_to_root');
        }

        const state = stateOf(exec);
        const taskname = resolvedTaskname(args.taskname, state.taskname, config.taskname);
        const json = { taskname };
        if (args.content !== undefined) json.content = args.content;
        if (args.status !== undefined) json.status = args.status;
        if (args.parent_plan_id !== undefined) json.plan_id = args.parent_plan_id;
        if (args.move_to_root === true) json.plan_id = null;
        if (args.debrief !== undefined) json.debrief = args.debrief;
        return http('PATCH', `context/plans/${encodeURIComponent(args.plan_id)}`, {
          json,
          exec,
          signal: exec.signal,
        });
      },
    }),

    defineTool({
      name: 'kapsel_http',
      description:
        'Send a generic request to the selected OpenKapsel workspace through the openkapsel_http helper and return the parsed (or raw) response. Use it for every surface beyond the typed tools — Context except Plan updates, Memory, sharing, preview, schedules — by following the `openkapsel-rest` skill (load it with the `skill` tool). Use kapsel_plan_update for Plan updates and completion.',
      parameters: {
        method: { type: 'string', required: true, enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'HTTP method.' },
        endpoint: { type: 'string', required: true, description: 'Workspace-relative path (e.g. "fs/list", "context") or a control-authenticated /transfer/ URL.' },
        query: { type: 'object', additionalProperties: true, description: 'Query-string parameters.' },
        json: {
          type: 'object',
          additionalProperties: true,
          description: 'JSON object request body for POST/PUT/PATCH/DELETE. Put every endpoint-specific field inside this object, for example json: {"status":"completed","debrief":{...}}.',
        },
        plan_id: { type: 'number', description: 'Plan id for a mutation (creates/joins one automatically when omitted).' },
        taskname: { type: 'string', description: TASKNAME_DESCRIPTION },
        message: { type: 'string', description: MESSAGE_DESCRIPTION },
        ...REMOTE_WRITE_ESCALATION_PARAMETERS,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
      async execute(args, exec) {
        const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(args.method).toUpperCase());
        let ctxFields = null;
        let requestJson = args.json;
        if (isMutation) {
          await authorizeRemoteMutation(args, exec, 'kapsel_http', 'remote REST mutation');
          if (isContextManagementEndpoint(args.endpoint)) {
            // Context endpoints create/update the attribution graph itself.
            // Their `plan_id` is endpoint data (for example, a Plan parent),
            // not the ordinary mutation-attribution field.
            requestJson = { ...(requestJson ?? {}) };
            if (requestJson.taskname === undefined) {
              const state = stateOf(exec);
              requestJson.taskname = resolvedTaskname(args.taskname, state.taskname, config.taskname);
            }
          } else {
            ctxFields = await mutationContext(args, exec);
          }
        } else {
          validateEscalationArgs(args.sandbox_permissions, args.justification);
          if (args.sandbox_permissions !== undefined) {
            throw new Error('sandbox_permissions is valid only for a mutating HTTP method');
          }
        }
        const body = await http(String(args.method).toUpperCase(), args.endpoint, {
          query: args.query,
          json: requestJson,
          planId: ctxFields?.planId,
          taskname: ctxFields?.taskname,
          message: ctxFields?.message,
          exec,
          signal: exec.signal,
        });
        return { body };
      },
    }),

    defineTool({
      name: 'kapsel_fs_list',
      description: 'List immediate children of a workspace directory (GET /fs/list).',
      parameters: {
        path: { type: 'string', description: 'Workspace-relative path. Defaults to ".".' },
        offset: { type: 'integer', description: 'Pagination offset.' },
        limit: { type: 'integer', description: 'Maximum entries.' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
      async execute(args, exec) {
        return http('GET', 'fs/list', {
          query: { path: args.path ?? '.', offset: args.offset, limit: args.limit },
          exec,
          signal: exec.signal,
        });
      },
    }),

    defineTool({
      name: 'kapsel_fs_read',
      description: 'Read a UTF-8 text file from the workspace (GET /fs/read).',
      parameters: {
        path: { type: 'string', required: true, description: 'Workspace-relative file path.' },
        offset: { type: 'integer', description: 'Character offset to skip before reading.' },
        byte_offset: { type: 'integer', description: 'Byte offset (preferred over offset).' },
        limit: { type: 'integer', description: 'Maximum characters/bytes to return.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{
          type: 'text',
          text: typeof value?.content === 'string' ? value.content : valueText(value),
        }],
      },
      async execute(args, exec) {
        return http('GET', 'fs/read', {
          query: { path: args.path, offset: args.offset, byte_offset: args.byte_offset, limit: args.limit },
          exec,
          signal: exec.signal,
        });
      },
    }),

    defineTool({
      name: 'kapsel_fs_stat',
      description: 'Return metadata for a workspace path (GET /fs/stat): type, size, timestamps, ETag, content type, options.',
      parameters: {
        path: { type: 'string', required: true, description: 'Workspace-relative path.' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Optional fields, e.g. ["type","size","etag","sha256"].' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
      async execute(args, exec) {
        const fields = (args.fields ?? ['type', 'size', 'etag', 'modified_at']).join(',');
        return http('GET', 'fs/stat', {
          query: { path: args.path, fields },
          exec,
          signal: exec.signal,
        });
      },
    }),

    defineTool({
      name: 'kapsel_fs_write',
      description: 'Create or replace a UTF-8 text file in the workspace (POST /fs/write). Requires the control token and a Plan.',
      parameters: {
        path: { type: 'string', required: true, description: 'Workspace-relative file path.' },
        content: { type: 'string', required: true, description: 'Complete new file content.' },
        create_parents: { type: 'boolean', description: 'Create missing parent directories.' },
        plan_id: { type: 'number' },
        taskname: { type: 'string', description: TASKNAME_DESCRIPTION },
        message: { type: 'string', description: MESSAGE_DESCRIPTION },
        ...REMOTE_WRITE_ESCALATION_PARAMETERS,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
      async execute(args, exec) {
        await authorizeRemoteMutation(args, exec, 'kapsel_fs_write', 'remote file write');
        const ctxFields = await mutationContext(args, exec);
        return http('POST', 'fs/write', {
          json: { path: args.path, content: args.content, ...(args.create_parents ? { create_parents: true } : {}) },
          planId: ctxFields.planId,
          taskname: ctxFields.taskname,
          message: ctxFields.message,
          exec,
          signal: exec.signal,
        });
      },
    }),

    defineTool({
      name: 'kapsel_fs_replace',
      description:
        'Replace literal text in a workspace file (POST /fs/replace). `old` must occur exactly once by default; set expected_matches or replace_all to change that.',
      parameters: {
        path: { type: 'string', required: true },
        old: { type: 'string', required: true, description: 'Exact original text to replace.' },
        new: { type: 'string', required: true, description: 'Replacement text (use "" to delete).' },
        expected_matches: { type: 'integer', description: 'Exact number of occurrences expected.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
        plan_id: { type: 'number' },
        taskname: { type: 'string', description: TASKNAME_DESCRIPTION },
        message: { type: 'string', description: MESSAGE_DESCRIPTION },
        ...REMOTE_WRITE_ESCALATION_PARAMETERS,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
      async execute(args, exec) {
        await authorizeRemoteMutation(args, exec, 'kapsel_fs_replace', 'remote file edit');
        const ctxFields = await mutationContext(args, exec);
        const json = { path: args.path, old: args.old, new: args.new };
        if (args.expected_matches !== undefined) json.expected_matches = args.expected_matches;
        if (args.replace_all) json.replace_all = true;
        return http('POST', 'fs/replace', {
          json,
          planId: ctxFields.planId,
          taskname: ctxFields.taskname,
          message: ctxFields.message,
          exec,
          signal: exec.signal,
        });
      },
    }),

    defineTool({
      name: 'kapsel_shell_exec',
      description:
        'Run a command in the workspace Shell (POST /shell/exec). Returns a task_id; poll its output with kapsel_task_output. Shell mode and limits are per the workspace Discovery document.',
      parameters: {
        command: { type: 'string', required: true, description: 'The command line to run.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the workspace root (".").' },
        timeout_seconds: { type: 'number', description: 'Optional task timeout in seconds.' },
        interactive: { type: 'boolean', description: 'Keep stdin available (true) or non-interactive (default false).' },
        plan_id: { type: 'number' },
        taskname: { type: 'string', description: TASKNAME_DESCRIPTION },
        message: { type: 'string', description: MESSAGE_DESCRIPTION },
        ...REMOTE_WRITE_ESCALATION_PARAMETERS,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
      async execute(args, exec) {
        await authorizeRemoteMutation(args, exec, 'kapsel_shell_exec', 'remote shell command');
        const ctxFields = await mutationContext(args, exec);
        const json = {
          command: args.command,
          ...(args.cwd !== undefined ? { cwd: args.cwd } : { cwd: '.' }),
          ...(args.timeout_seconds !== undefined ? { timeout_seconds: args.timeout_seconds } : {}),
          interactive: args.interactive === true,
        };
        return http('POST', 'shell/exec', {
          json,
          planId: ctxFields.planId,
          taskname: ctxFields.taskname,
          message: ctxFields.message,
          exec,
          signal: exec.signal,
          timeoutMs: 60_000,
        });
      },
    }),

    defineTool({
      name: 'kapsel_task_output',
      description:
        'Poll incremental stdout/stderr of a Shell task (GET /tasks/<id>/output). Advance cursors to the returned stdout.next_offset / stderr.next_offset between calls; use wait_seconds for long polling.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Task id returned by kapsel_shell_exec.' },
        stdout_offset: { type: 'integer', description: 'Byte cursor for stdout. Defaults to 0.' },
        stderr_offset: { type: 'integer', description: 'Byte cursor for stderr. Defaults to 0.' },
        limit: { type: 'integer', description: 'Maximum bytes per stream.' },
        wait_seconds: { type: 'number', description: 'Seconds to long-poll for new output.' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
      async execute(args, exec) {
        return http('GET', `tasks/${encodeURIComponent(args.task_id)}/output`, {
          query: {
            stdout_offset: args.stdout_offset ?? 0,
            stderr_offset: args.stderr_offset ?? 0,
            limit: args.limit ?? 65536,
            wait_seconds: args.wait_seconds,
          },
          exec,
          signal: exec.signal,
          timeoutMs: 90_000,
        });
      },
    }),
  ];

  for (const tool of tools) ctx.tools.register(tool);

  if (config.enforceRemoteOnly !== false) {
    ctx.tools.presentAs('native');
    ctx.tools.guard((exec) => {
      if (REMOTE_ONLY_TOOL_NAMES.has(exec.name)) return undefined;
      return `dsh-openkapsel remote-only mode denied local or undeclared tool "${exec.name}"`;
    });
  }

  // ── prompt guidance ───────────────────────────────────────────────────────
  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt) {
    systemPrompt.section({
      name: 'kapsel',
      order: 195,
      text: `OpenKapsel workspace access is available through the \`kapsel_*\` tools. When a user supplies an OpenKapsel workspace URL and control token, call \`kapsel_config\` once to initialize it, then operate the remote workspace through the typed tools or \`kapsel_http\`. Use \`kapsel_plan_update\` for Plan updates and completion; its typed debrief avoids ambiguous generic request fields. The authoritative REST contract is the vendored \`${SKILL_NAME}\` skill — load it with the \`skill\` tool before nontrivial operations. DSH \`read-only\` mode permits remote reads but denies remote writes, edits, Shell commands, and mutating HTTP methods. After such a denial, retry the exact call with \`sandbox_permissions: "workspace-write"\` and a one-sentence \`justification\` only when the mutation is necessary; approval applies to that call alone. DSH \`workspace-write\` and \`danger-full-access\` are equivalent for this bridge because the OpenKapsel token remains the remote authority boundary. Never print or commit the control token.`,
    });
  }

  return undefined;
}
