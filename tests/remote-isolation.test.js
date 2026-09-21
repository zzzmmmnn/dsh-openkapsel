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
  const mappingBodies = [];
  const mappingId = 'abcdefghijklmnopqrstuvwx';
  const transferId = 'zyxwvutsrqponmlkjihgfedcb';
  const clientTaskId = 'client-task-1234';
  const rpcTaskId = 'client.' + mappingId + '.rpc-task-1234';
  let contextEntries = [];

  const server = createServer(async (request, response) => {
    const match = /^\/kapsel\/w\/(read-[ab])\/(.*)$/.exec(request.url ?? '');
    if (!match) return json(response, 404, { error: 'not_found' });
    const [, workspace, endpointWithQuery] = match;
    const endpoint = endpointWithQuery.split('?', 1)[0];
    requestLog.push({ workspace, method: request.method, endpoint });
    if (['fs/read_many', 'fs/manifest', 'fs/search'].includes(endpoint) || endpoint.startsWith('git/')) {
      const data = request.method === 'POST' ? JSON.parse((await requestBody(request)).toString('utf8')) : null;
      return json(response, 200, { items: [], endpoint, query: [...new URL(request.url, 'http://localhost').searchParams], body: data });
    }
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
    if (request.method === 'GET' && endpoint === 'mappings') {
      return json(response, 200, { mappings: [{
        id: mappingId, name: 'laptop', online: true, writable: true,
        capabilities: { rpc: { vendor: {
          state: 'available', version: 1, read_only: false,
          description: 'Inspect or update vendor metadata.',
          operations: ['inspect', 'update', 'task_update'],
          operation_specs: {
            inspect: {
              description: 'Inspect one integer.',
              input_schema: {
                type: 'object', properties: { value: { type: 'integer' } },
                required: ['value'], additionalProperties: false,
              },
              write: false,
              execution: 'sync',
            },
            update: {
              description: 'Update one integer.',
              input_schema: {
                type: 'object', properties: { value: { type: 'integer' } },
                required: ['value'], additionalProperties: false,
              },
              write: true,
              execution: 'sync',
            },
            task_update: {
              description: 'Update one integer asynchronously.',
              input_schema: {
                type: 'object', properties: { value: { type: 'integer' } },
                required: ['value'], additionalProperties: false,
              },
              write: true,
              execution: 'task',
            },
          },
        } } },
      }] });
    }
    if (request.method === 'GET' && endpoint === 'archive/list') {
      return json(response, 200, { path: 'laptop/sample.zip', location: 'client', entries: [{ name: 'hello.txt', type: 'file' }] });
    }
    if (request.method === 'GET' && endpoint === 'archive/read') {
      return json(response, 200, { path: 'laptop/sample.zip', location: 'client', member: 'hello.txt', content: 'hello' });
    }
    if (request.method === 'POST' && (
      endpoint === `mappings/${mappingId}/rpc/vendor/inspect`
      || endpoint === `mappings/${mappingId}/rpc/vendor/update`
      || endpoint === `mappings/${mappingId}/rpc/vendor/task_update`
    )) {
      const body = JSON.parse((await requestBody(request)).toString('utf8'));
      mappingBodies.push({ endpoint, body });
      if (endpoint.endsWith('/task_update')) {
        return json(response, 202, {
          task_id: rpcTaskId,
          kind: 'rpc',
          rpc_family: 'vendor',
          rpc_operation: 'task_update',
          execution: 'task',
          status: 'running',
        });
      }
      const operation = endpoint.endsWith('/update') ? 'update' : 'inspect';
      return json(response, 200, {
        mapping_id: mappingId,
        family: 'vendor',
        operation,
        result: operation === 'update' ? { updated: body.args?.value } : { ok: true, value: body.args?.value },
      });
    }
    if (request.method === 'POST' && (endpoint === 'fs/copy' || endpoint === 'fs/move')) {
      mappingBodies.push({ endpoint, body: JSON.parse((await requestBody(request)).toString('utf8')) });
      return json(response, 202, { id: transferId, state: 'running' });
    }
    if (endpoint === `fs/transfers/${transferId}` && request.method === 'GET') {
      return json(response, 200, { id: transferId, state: 'running' });
    }
    if (endpoint.startsWith(`fs/transfers/${transferId}/`) && request.method === 'POST') {
      mappingBodies.push({ endpoint, body: JSON.parse((await requestBody(request)).toString('utf8')) });
      return json(response, 200, { id: transferId, state: 'cancelled' });
    }
    if (endpoint === 'recycle/list' && request.method === 'GET') {
      return json(response, 200, { root: 'laptop', entries: [{ recycle_id: 'recycle-1' }] });
    }
    if ((endpoint === 'recycle/restore' || endpoint === 'recycle/purge') && request.method === 'POST') {
      mappingBodies.push({ endpoint, body: JSON.parse((await requestBody(request)).toString('utf8')) });
      return json(response, 200, { restored: endpoint === 'recycle/restore' });
    }
    const taskBase = `mappings/${mappingId}/tasks`;
    if (endpoint === taskBase && request.method === 'GET') return json(response, 200, { tasks: [] });
    if (endpoint === taskBase && request.method === 'POST') {
      mappingBodies.push({ endpoint, body: JSON.parse((await requestBody(request)).toString('utf8')) });
      return json(response, 202, { task_id: clientTaskId });
    }
    if (endpoint === `${taskBase}/${clientTaskId}` && request.method === 'GET') {
      return json(response, 200, { task_id: clientTaskId, output: Buffer.from('lo').toString('base64'), next_offset: 5 });
    }
    if (endpoint === 'shell/exec' && request.method === 'POST') {
      mappingBodies.push({ endpoint, body: JSON.parse((await requestBody(request)).toString('utf8')) });
      return json(response, 202, { task_id: 'client.' + mappingId + '.' + clientTaskId, location: 'client' });
    }
    if (endpoint === `tasks/${rpcTaskId}` && request.method === 'GET') {
      return json(response, 200, {
        task_id: rpcTaskId, kind: 'rpc', rpc_family: 'vendor', rpc_operation: 'task_update',
        execution: 'task', write: true, status: 'running', running: true,
      });
    }
    if (endpoint === `tasks/${rpcTaskId}/output` && request.method === 'GET') {
      return json(response, 200, {
        task_id: rpcTaskId, kind: 'rpc', rpc_family: 'vendor', rpc_operation: 'task_update',
        execution: 'task', status: 'running', finished: false,
        stdout: { data: 'progress\n', next_offset: 9, available_end: 9, gap: false },
        stderr: { data: '', next_offset: 0, available_end: 0, gap: false },
      });
    }
    if ((endpoint === `tasks/${rpcTaskId}/interrupt` || endpoint === `tasks/${rpcTaskId}/kill`) && request.method === 'POST') {
      mappingBodies.push({ endpoint, body: JSON.parse((await requestBody(request)).toString('utf8')) });
      return json(response, 200, { task_id: rpcTaskId, kind: 'rpc', status: 'running' });
    }
    if (endpoint.startsWith(`${taskBase}/${clientTaskId}/`) && request.method === 'POST') {
      mappingBodies.push({ endpoint, body: JSON.parse((await requestBody(request)).toString('utf8')) });
      return json(response, 200, { task_id: clientTaskId, state: 'running' });
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

    const mappings = await registered.get('kapsel_mappings').execute({}, { agent: agentA, signal });
    assert.equal(mappings.mappings[0].name, 'laptop');
    assert.equal(mappings.mappings[0].capabilities.rpc.vendor.description, 'Inspect or update vendor metadata.');
    assert.equal(
      mappings.mappings[0].capabilities.rpc.vendor.operation_specs.inspect.input_schema.properties.value.type,
      'integer',
    );
    const operation = { plan_id: 1, taskname: 'mapping-test', message: 'exercise mapping operation' };
    const copy = await registered.get('kapsel_fs_copy').execute({
      source: 'document.txt', destination: 'laptop/document.txt', ...operation,
    }, { agent: agentA, signal });
    assert.equal(copy.id, transferId);
    assert.deepEqual(mappingBodies.at(-1), {
      endpoint: 'fs/copy',
      body: { source: 'document.txt', destination: 'laptop/document.txt',
        plan_id: 1, taskname: 'mapping-test', message: 'exercise mapping operation' },
    });
    await registered.get('kapsel_fs_move').execute({
      source: 'laptop/document.txt', destination: 'document.txt', ...operation,
    }, { agent: agentA, signal });
    assert.equal(mappingBodies.at(-1).endpoint, 'fs/move');
    assert.equal((await registered.get('kapsel_transfer').execute({
      transfer_id: transferId, action: 'status',
    }, { agent: agentA, signal })).state, 'running');
    await registered.get('kapsel_transfer').execute({
      transfer_id: transferId, action: 'cancel', ...operation,
    }, { agent: agentA, signal });
    assert.equal(mappingBodies.at(-1).endpoint, `fs/transfers/${transferId}/cancel`);
    await registered.get('kapsel_transfer').execute({
      transfer_id: transferId, action: 'resume', ...operation,
    }, { agent: agentA, signal });
    assert.equal(mappingBodies.at(-1).endpoint, `fs/transfers/${transferId}/resume`);

    assert.equal((await registered.get('kapsel_recycle').execute({
      action: 'list', root: 'laptop',
    }, { agent: agentA, signal })).entries[0].recycle_id, 'recycle-1');
    await registered.get('kapsel_recycle').execute({
      action: 'restore', root: 'laptop', recycle_id: 'recycle-1', ...operation,
    }, { agent: agentA, signal });
    assert.equal(mappingBodies.at(-1).body.root, 'laptop');
    const requestsBeforeUnconfirmedPurge = requestLog.length;
    await assert.rejects(registered.get('kapsel_recycle').execute({
      action: 'purge', root: 'laptop', recycle_id: 'recycle-1', ...operation,
    }, { agent: agentA, signal }), /confirm=true/);
    assert.equal(requestLog.length, requestsBeforeUnconfirmedPurge);
    await registered.get('kapsel_recycle').execute({
      action: 'purge', root: 'laptop', recycle_id: 'recycle-1', confirm: true, ...operation,
    }, { agent: agentA, signal });
    assert.equal(mappingBodies.at(-1).body.confirm, true);

    assert.deepEqual((await registered.get('kapsel_client_task').execute({
      mapping_id: mappingId, action: 'list',
    }, { agent: agentA, signal })).tasks, []);
    const started = await registered.get('kapsel_client_task').execute({
      mapping_id: mappingId, action: 'start', argv: ['python3', '-V'], cwd: '.', ...operation,
    }, { agent: agentA, signal });
    assert.equal(started.task_id, clientTaskId);
    assert.deepEqual(mappingBodies.at(-1).body.argv, ['python3', '-V']);
    const clientOutput = await registered.get('kapsel_client_task').execute({
      mapping_id: mappingId, action: 'status', task_id: clientTaskId, offset: 3,
    }, { agent: agentA, signal });
    assert.equal(clientOutput.next_offset, 5);
    assert.equal(Buffer.from(clientOutput.output, 'base64').toString('utf8'), 'lo');
    await registered.get('kapsel_client_task').execute({
      mapping_id: mappingId, action: 'stdin', task_id: clientTaskId, stdin_text: 'héllo', ...operation,
    }, { agent: agentA, signal });
    assert.equal(mappingBodies.at(-1).body.data, Buffer.from('héllo').toString('base64'));
    await registered.get('kapsel_client_task').execute({
      mapping_id: mappingId, action: 'stdin', task_id: clientTaskId, eof: true, ...operation,
    }, { agent: agentA, signal });
    assert.equal(mappingBodies.at(-1).body.eof, true);
    for (const action of ['interrupt', 'kill']) {
      await registered.get('kapsel_client_task').execute({
        mapping_id: mappingId, action, task_id: clientTaskId, ...operation,
      }, { agent: agentA, signal });
      assert.equal(mappingBodies.at(-1).endpoint, `mappings/${mappingId}/tasks/${clientTaskId}/${action}`);
    }
    const unified = await registered.get('kapsel_shell_exec').execute({
      command: 'echo mapped', cwd: 'laptop/project', target: 'client', ...operation,
    }, { agent: agentA, signal });
    assert.equal(unified.location, 'client');
    assert.equal(mappingBodies.at(-1).endpoint, 'shell/exec');
    assert.equal(mappingBodies.at(-1).body.target, 'client');
    assert.equal(mappingBodies.at(-1).body.cwd, 'laptop/project');
    assert.equal(Object.hasOwn(mappingBodies.at(-1).body, 'mount_mappings'), false);
    const nativeDependencies = ['laptop', mappingId];
    await registered.get('kapsel_shell_exec').execute({
      command: 'python laptop/project/main.py', cwd: '.', target: 'server',
      mount_mappings: nativeDependencies, ...operation,
    }, { agent: agentA, signal });
    assert.deepEqual(mappingBodies.at(-1).body.mount_mappings, nativeDependencies);
    assert.equal(mappingBodies.at(-1).body.target, 'server');
    assert.equal(mappingBodies.at(-1).body.plan_id, 1);
    assert.equal(shellSpecs.at(-1).timeoutMs, 130_000);
    const helperArguments = JSON.parse(shellSpecs.at(-1).stdin).args;
    assert.equal(helperArguments[helperArguments.indexOf('--timeout') + 1], '120');
    await registered.get('kapsel_http').execute({
      method: 'POST', endpoint: 'shell/exec',
      json: { command: 'python laptop/project/main.py', cwd: '.', target: 'server', mount_mappings: nativeDependencies },
      ...operation,
    }, { agent: agentA, signal });
    assert.deepEqual(mappingBodies.at(-1).body.mount_mappings, nativeDependencies);
    assert.equal(mappingBodies.at(-1).body.plan_id, 1);
    assert.equal(shellSpecs.at(-1).timeoutMs, 130_000);

    sandboxModes.set('session-a', 'read-only');
    const readStart = requestLog.length;
    for (const [name, args] of [
      ['kapsel_git', { action: 'status' }],
      ['kapsel_fs_read_many', { paths: ['a', 'b'] }],
      ['kapsel_fs_manifest', { recursive: true, path: '.' }],
      ['kapsel_http', { method: 'POST', endpoint: 'fs/read_many', json: { paths: ['a'] } }],
      ['kapsel_http', { method: 'POST', endpoint: 'fs/manifest', json: { items: [{ path: 'a' }] } }],
      ['kapsel_archive', { action: 'list', path: 'laptop/sample.zip' }],
      ['kapsel_archive', { action: 'read', path: 'laptop/sample.zip', member: 'hello.txt' }],
      ['kapsel_rpc', { mapping_id: mappingId, family: 'vendor', operation: 'inspect', args: { value: 7 } }],
      ['kapsel_http', { method: 'POST', endpoint: `mappings/${mappingId}/rpc/vendor/inspect`, json: { args: { value: 8 } } }],
    ]) await registered.get(name).execute(args, { agent: agentA, signal });
    const filtered = await registered.get('kapsel_fs_search').execute({ query: 'hello', include: ['*.py', '*.js'] }, { agent: agentA, signal });
    assert.deepEqual(filtered.query.filter(([key]) => key === 'include').map(([, value]) => value), ['*.py', '*.js']);
    assert.equal(requestLog.slice(readStart).some(item => item.endpoint === 'context'), false);
    const requestsBeforeDeniedMapping = requestLog.length;
    for (const [toolName, args] of [
      ['kapsel_fs_copy', { source: 'a', destination: 'laptop/a', ...operation }],
      ['kapsel_transfer', { transfer_id: transferId, action: 'cancel', ...operation }],
      ['kapsel_recycle', { action: 'purge', recycle_id: 'recycle-1', confirm: true, ...operation }],
      ['kapsel_client_task', { mapping_id: mappingId, action: 'start', argv: ['python3'], ...operation }],
    ]) {
      await assert.rejects(registered.get(toolName).execute(args, { agent: agentA, signal }), /read-only mode/);
    }
    assert.equal(requestLog.length, requestsBeforeDeniedMapping);
    assert.equal((await registered.get('kapsel_mappings').execute({}, { agent: agentA, signal })).mappings.length, 1);
    assert.equal((await registered.get('kapsel_transfer').execute({
      transfer_id: transferId, action: 'status',
    }, { agent: agentA, signal })).state, 'running');
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
      registered.get('kapsel_rpc').execute({
        mapping_id: mappingId,
        family: 'vendor',
        operation: 'update',
        args: { value: 9 },
        plan_id: 1,
        taskname: 'test',
        message: 'deny rpc write',
      }, { agent: agentA, callId: 'denied-rpc', signal }),
      /read-only mode.*sandbox_permissions="workspace-write"/,
    );
    assert.equal(mappingBodies.some((item) => item.endpoint.endsWith('/rpc/vendor/update')), false);

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

    const approvedRpc = await registered.get('kapsel_rpc').execute({
      mapping_id: mappingId,
      family: 'vendor',
      operation: 'update',
      args: { value: 10 },
      plan_id: 1,
      taskname: 'test',
      message: 'approved rpc write',
      sandbox_permissions: 'workspace-write',
      justification: 'Update the requested remote RPC value once.',
    }, { agent: agentA, callId: 'approved-rpc', signal });
    assert.equal(approvedRpc.result.updated, 10);
    assert.equal(mappingBodies.at(-1).body.plan_id, 1);
    assert.equal(mappingBodies.at(-1).body.taskname, 'test');
    assert.equal(mappingBodies.at(-1).body.message, 'approved rpc write');
    assert.equal(approvalRequests.at(-1).toolName, 'kapsel_rpc');

    const taskRpc = await registered.get('kapsel_rpc').execute({
      mapping_id: mappingId,
      family: 'vendor',
      operation: 'task_update',
      args: { value: 11 },
      timeout_seconds: 120,
      plan_id: 1,
      taskname: 'test',
      message: 'approved task rpc write',
      sandbox_permissions: 'workspace-write',
      justification: 'Run the requested long remote RPC task once.',
    }, { agent: agentA, callId: 'approved-task-rpc', signal });
    assert.equal(taskRpc.kind, 'rpc');
    assert.equal(taskRpc.execution, 'task');
    assert.equal(taskRpc.task_id, 'client.' + mappingId + '.rpc-task-1234');
    assert.equal(mappingBodies.at(-1).body.timeout_seconds, 120);
    assert.equal(mappingBodies.at(-1).body.plan_id, 1);
    assert.equal(mappingBodies.at(-1).body.taskname, 'test');
    assert.equal(mappingBodies.at(-1).body.message, 'approved task rpc write');
    assert.equal(approvalRequests.at(-1).toolName, 'kapsel_rpc');

    const rpcStatus = await registered.get('kapsel_client_task').execute({
      mapping_id: mappingId,
      action: 'status',
      task_id: rpcTaskId,
    }, { agent: agentA, signal });
    assert.equal(rpcStatus.kind, 'rpc');
    assert.equal(rpcStatus.rpc_operation, 'task_update');
    assert.equal(requestLog.at(-1).endpoint, `tasks/${rpcTaskId}`);

    const rpcOutput = await registered.get('kapsel_task_output').execute({
      task_id: rpcTaskId,
      stdout_offset: 0,
    }, { agent: agentA, signal });
    assert.equal(rpcOutput.kind, 'rpc');
    assert.equal(rpcOutput.stdout.data, 'progress\n');
    assert.equal(requestLog.at(-1).endpoint, `tasks/${rpcTaskId}/output`);

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
    assert.equal(approvalRequests.length, 3);
    assert.equal(approvalRequests[0].toolName, 'kapsel_rpc');
    assert.equal(approvalRequests[1].toolName, 'kapsel_rpc');
    assert.equal(approvalRequests[2].toolName, 'kapsel_fs_write');
    assert.match(approvalRequests[2].reason, /Write the requested remote test file once/);

    sandboxModes.set('session-a', 'workspace-write');

    for (const action of ['interrupt', 'kill']) {
      await registered.get('kapsel_client_task').execute({
        mapping_id: mappingId,
        action,
        task_id: rpcTaskId,
        plan_id: 1,
        taskname: 'test',
        message: action + ' rpc task',
      }, { agent: agentA, signal });
      assert.equal(mappingBodies.at(-1).endpoint, `tasks/${rpcTaskId}/${action}`);
    }

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
