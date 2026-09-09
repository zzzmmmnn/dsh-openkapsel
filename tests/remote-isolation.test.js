import assert from 'node:assert/strict';
import { exec as execCommand } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply, REMOTE_TOOL_NAMES } from '../index.js';

function fakeShell(specs) {
  return {
    resolve(spec) {
      return spec;
    },
    run(spec) {
      specs.push(spec);
      return new Promise((resolve) => {
        const child = execCommand(spec.command, {
          shell: process.platform === 'win32' ? 'pwsh.exe' : '/bin/bash',
          cwd: spec.workdir,
          maxBuffer: spec.stdoutMaxBytes,
          timeout: spec.timeoutMs,
          signal: spec.signal,
          env: { ...process.env, ...(spec.env ?? {}) },
        }, (error, stdout, stderr) => {
          resolve({
            exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
            signal: error?.signal ?? null,
            stdout: { text: stdout },
            stderr: { text: stderr },
          });
        });
        child.stdin.on('error', () => {});
        child.stdin.end(spec.stdin);
      });
    },
  };
}

function json(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(body.length),
  });
  response.end(body);
}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

test('two agents mutate only their own remote workspace and never the local cwd', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-openkapsel-test-'));
  const stateDir = join(temporary, 'state');
  const localA = join(temporary, 'local-a');
  const localB = join(temporary, 'local-b');
  const files = new Map([['read-a', new Map()], ['read-b', new Map()]]);
  const controls = new Map([['read-a', 'control-a'], ['read-b', 'control-b']]);
  const requestLog = [];
  const contextPatchBodies = [];
  const writeBodies = [];
  let contextEntries = [];

  const server = createServer(async (request, response) => {
    const match = /^\/kapsel\/w\/(read-[ab])\/(.*)$/.exec(request.url ?? '');
    if (!match) return json(response, 404, { error: 'not_found' });
    const [, workspace, endpointWithQuery] = match;
    const endpoint = endpointWithQuery.split('?', 1)[0];
    requestLog.push({ workspace, method: request.method, endpoint });
    if (request.headers.authorization !== `Bearer ${controls.get(workspace)}`) {
      return json(response, 401, { error: 'unauthorized' });
    }
    if (request.method === 'GET' && endpoint === '') {
      return json(response, 200, {
        name: workspace,
        capabilities: { write: true, shell: true },
        authentication: { control_token_expires_at: '2099-01-01T00:00:00Z' },
      });
    }
    if (request.method === 'GET' && endpoint === 'fs/list') {
      return json(response, 200, {
        path: '/remote/workspace',
        entries: [{ name: 'remote-file.txt', path: '/remote/workspace/remote-file.txt', type: 'file' }],
        total: 1,
      });
    }
    if (request.method === 'GET' && endpoint === 'fs/stat') {
      return json(response, 200, {
        path: '/remote/workspace',
        fields: ['type', 'size'],
        type: 'directory',
        size: 4096,
      });
    }
    if (request.method === 'GET' && endpoint === 'context') {
      return json(response, 200, { entries: contextEntries });
    }
    if (request.method === 'POST' && endpoint === 'context') {
      return json(response, 201, { id: 99 });
    }
    if (request.method === 'PATCH' && endpoint === 'context/plans/1') {
      const body = JSON.parse((await requestBody(request)).toString('utf8'));
      contextPatchBodies.push(body);
      return json(response, 200, { id: 1, ...body });
    }
    if (request.method === 'POST' && endpoint === 'fs/write') {
      const body = JSON.parse((await requestBody(request)).toString('utf8'));
      writeBodies.push(body);
      files.get(workspace).set(body.path, body.content);
      return json(response, 200, { path: body.path, written: true });
    }
    return json(response, 404, { error: 'unknown_endpoint' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  const registered = new Map();
  const guards = [];
  const shellSpecs = [];
  const skills = [];
  const sandboxModes = new Map([
    ['session-a', 'workspace-write'],
    ['session-b', 'danger-full-access'],
  ]);
  const approvalRequests = [];
  const ctx = {
    shell: fakeShell(shellSpecs),
    sandboxPolicy: {
      resolve({ session }) {
        return {
          mode: sandboxModes.get(session.header.id) ?? 'read-only',
          workspaceRoot: session.header.cwd,
          sessionId: session.header.id,
        };
      },
    },
    tools: {
      presentAs(mode) {
        assert.equal(mode, 'native');
      },
      register(tool) {
        registered.set(tool.name, tool);
        return () => registered.delete(tool.name);
      },
      guard(guard) {
        guards.push(guard);
        return () => {};
      },
    },
    skills: {
      register(skill) {
        skills.push(skill);
        return () => {};
      },
    },
    get(name) {
      if (name === 'approval') {
        return {
          async request(request) {
            approvalRequests.push(request);
            return 'allowed-once';
          },
        };
      }
      return undefined;
    },
  };

  try {
    apply(ctx, { stateDir, enforceRemoteOnly: true });
    assert.equal(skills.length, 1);
    assert.equal(skills[0].source, 'bundled');
    assert.equal(typeof skills[0].content, 'string');
    assert.deepEqual([...registered.keys()].sort(), [...REMOTE_TOOL_NAMES].sort());
    assert.equal(guards.length, 1);
    assert.match(guards[0]({ name: 'bash' }), /denied/);
    assert.match(guards[0]({ name: 'run_code' }), /denied/);
    assert.equal(guards[0]({ name: 'kapsel_fs_write' }), undefined);

    mkdirSync(localA);
    mkdirSync(localB);
    writeFileSync(join(localA, 'sentinel.txt'), 'unchanged-a');
    writeFileSync(join(localB, 'sentinel.txt'), 'unchanged-b');
    const agentA = { id: 'session-a', session: { header: { id: 'session-a', cwd: localA } } };
    const agentB = { id: 'session-b', session: { header: { id: 'session-b', cwd: localB } } };
    const signal = new AbortController().signal;

    const statusBeforeConfig = await registered.get('kapsel_status').execute({}, { agent: agentA, signal });
    assert.equal(statusBeforeConfig.taskname, 'dsh');

    const configA = await registered.get('kapsel_config').execute({
      workspace_url: `${origin}/kapsel/w/read-a`,
      control_token: 'control-a',
      create_plan: false,
    }, { agent: agentA, signal });
    const configB = await registered.get('kapsel_config').execute({
      workspace_url: `${origin}/kapsel/w/read-b`,
      control_token: 'control-b',
      create_plan: false,
    }, { agent: agentB, signal });
    assert.deepEqual(configA.config, { action: 'created', mode: '0600' });
    assert.deepEqual(configB.config, { action: 'created', mode: '0600' });
    assert.equal(configA.dsh_sandbox_mode, 'workspace-write');
    assert.equal(configB.dsh_sandbox_mode, 'danger-full-access');
    assert.equal(registered.get('kapsel_http').parameters.properties.json.type, 'object');

    const requestsBeforeInvalidJson = requestLog.length;
    await assert.rejects(
      registered.get('kapsel_http').execute({
        method: 'PATCH',
        endpoint: 'context/plans/1',
        json: '',
        taskname: 'macos-web',
        message: 'complete demo',
      }, { agent: agentA, signal }),
      /invalid arguments.*json.*object/,
    );
    assert.equal(requestLog.length, requestsBeforeInvalidJson);

    await registered.get('kapsel_http').execute({
      method: 'PATCH',
      endpoint: 'context/plans/1',
      json: {
        status: 'completed',
        debrief: { summary: 'Completed the demo.', outcome: 'succeeded', memory_actions: [] },
      },
      taskname: 'macos-web',
      message: 'complete demo',
    }, { agent: agentA, signal });
    assert.deepEqual(contextPatchBodies[0], {
      taskname: 'macos-web',
      status: 'completed',
      debrief: { summary: 'Completed the demo.', outcome: 'succeeded', memory_actions: [] },
    });

    await registered.get('kapsel_plan_update').execute({
      plan_id: 1,
      taskname: 'macos-web',
      content: 'Updated plan text.',
    }, { agent: agentA, signal });
    assert.deepEqual(contextPatchBodies[1], {
      taskname: 'macos-web',
      content: 'Updated plan text.',
    });

    const listValue = await registered.get('kapsel_fs_list').execute({ path: '.' }, { agent: agentA, signal });
    const listRendered = registered.get('kapsel_fs_list').output.render({ path: '.' }, listValue);
    assert.match(listRendered[0].text, /remote-file\.txt/);
    assert.doesNotMatch(listRendered[0].text, /^\{\s*"path": "\."\s*\}$/);

    const statValue = await registered.get('kapsel_fs_stat').execute({ path: '.' }, { agent: agentA, signal });
    const statRendered = registered.get('kapsel_fs_stat').output.render({ path: '.' }, statValue);
    assert.match(statRendered[0].text, /"type": "directory"/);
    assert.match(statRendered[0].text, /"size": 4096/);

    sandboxModes.set('session-a', 'read-only');
    const contextPostsBeforeReadOnlyConfig = requestLog.filter(
      (entry) => entry.method === 'POST' && entry.endpoint === 'context',
    ).length;
    const readOnlyConfig = await registered.get('kapsel_config').execute({
      workspace_url: `${origin}/kapsel/w/read-a`,
      control_token: 'control-a',
    }, { agent: agentA, signal });
    assert.equal(readOnlyConfig.dsh_sandbox_mode, 'read-only');
    assert.equal(readOnlyConfig.plan_id, null);
    assert.equal(requestLog.filter(
      (entry) => entry.method === 'POST' && entry.endpoint === 'context',
    ).length, contextPostsBeforeReadOnlyConfig);

    await assert.rejects(
      registered.get('kapsel_fs_write').execute({
        path: 'denied.txt', content: 'denied', plan_id: 1, taskname: 'test', message: 'deny write',
      }, { agent: agentA, callId: 'denied-call', signal }),
      /read-only mode.*sandbox_permissions="workspace-write"/,
    );
    assert.equal(files.get('read-a').has('denied.txt'), false);
    assert.equal(approvalRequests.length, 0);

    await assert.rejects(
      registered.get('kapsel_fs_replace').execute({
        path: 'denied.txt', old: 'a', new: 'b', plan_id: 1, taskname: 'test', message: 'deny edit',
      }, { agent: agentA, callId: 'denied-edit', signal }),
      /read-only mode/,
    );
    await assert.rejects(
      registered.get('kapsel_shell_exec').execute({
        command: 'touch denied.txt', plan_id: 1, taskname: 'test', message: 'deny shell',
      }, { agent: agentA, callId: 'denied-shell', signal }),
      /read-only mode/,
    );
    await assert.rejects(
      registered.get('kapsel_http').execute({
        method: 'POST', endpoint: 'context', json: {}, plan_id: 1, taskname: 'test', message: 'deny post',
      }, { agent: agentA, callId: 'denied-http', signal }),
      /read-only mode/,
    );
    const requestsBeforeEscalatedRead = requestLog.length;
    await assert.rejects(
      registered.get('kapsel_http').execute({
        method: 'GET',
        endpoint: 'fs/list',
        sandbox_permissions: 'workspace-write',
        justification: 'A read does not need escalation.',
      }, { agent: agentA, callId: 'invalid-read-escalation', signal }),
      /valid only for a mutating HTTP method/,
    );
    assert.equal(requestLog.length, requestsBeforeEscalatedRead);
    assert.equal(approvalRequests.length, 0);

    await registered.get('kapsel_fs_write').execute({
      path: 'approved.txt',
      content: 'approved',
      plan_id: 1,
      taskname: 'test',
      message: 'approved write',
      sandbox_permissions: 'workspace-write',
      justification: 'Write the requested remote test file once.',
    }, { agent: agentA, callId: 'approved-call', signal });
    assert.equal(files.get('read-a').get('approved.txt'), 'approved');
    assert.equal(approvalRequests.length, 1);
    assert.equal(approvalRequests[0].toolName, 'kapsel_fs_write');
    assert.match(approvalRequests[0].reason, /Write the requested remote test file once/);

    sandboxModes.set('session-a', 'workspace-write');

    await registered.get('kapsel_fs_write').execute({
      path: 'from-a.txt', content: 'A', plan_id: 1, taskname: 'test', message: 'write A',
    }, { agent: agentA, signal });
    await registered.get('kapsel_fs_write').execute({
      path: 'from-b.txt', content: 'B', plan_id: 2, taskname: 'test', message: 'write B',
    }, { agent: agentB, signal });

    assert.equal(files.get('read-a').get('from-a.txt'), 'A');
    assert.equal(files.get('read-a').has('from-b.txt'), false);
    assert.equal(files.get('read-b').get('from-b.txt'), 'B');
    assert.equal(files.get('read-b').has('from-a.txt'), false);

    contextEntries = [{ id: 1, type: 'plan', status: 'in_progress', taskname: 'restored-task' }];
    await registered.get('kapsel_fs_write').execute({
      path: 'fallback-context.txt',
      content: 'fallback',
      taskname: '   ',
      message: '   ',
    }, { agent: agentA, signal });
    assert.equal(writeBodies.at(-1).plan_id, 1);
    assert.equal(writeBodies.at(-1).taskname, 'restored-task');
    assert.equal(writeBodies.at(-1).message, 'dsh-openkapsel operation');
    assert.equal(readFileSync(join(localA, 'sentinel.txt'), 'utf8'), 'unchanged-a');
    assert.equal(readFileSync(join(localB, 'sentinel.txt'), 'utf8'), 'unchanged-b');
    assert.equal(readdirSync(localA).includes('.openkapsel.env'), false);
    assert.equal(readdirSync(localB).includes('.openkapsel.env'), false);
    assert.equal(readdirSync(stateDir).length, 2);
    for (const directory of readdirSync(stateDir)) {
      assert.equal(readdirSync(join(stateDir, directory)).includes('.openkapsel.env'), true);
    }
    assert.ok(shellSpecs.length >= 6);
    for (const spec of shellSpecs) {
      assert.equal(spec.sandboxPolicy.mode, 'workspace-write');
      assert.ok(spec.sandboxPolicy.workspaceRoot.startsWith(join(stateDir, '')));
      assert.match(spec.command, /python3? -B -E -s -c/);
      assert.equal(typeof spec.stdin, 'string');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(temporary, { recursive: true, force: true });
  }
});
