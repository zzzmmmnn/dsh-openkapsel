import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apply } from '../index.js';

const mapping = {
  id: 'abcdefghijklmnopqrstuvwx', name: 'laptop', online: true, mounted: false,
  mount_references: 0, native_mounts_enabled: false,
  capabilities: {
    file_stream: { version: 1, descriptor_stat: true, directory_details: true, search_prefix: true },
    rpc: { git: { state: 'available', operation_specs: { status: { write: false, execution: 'sync' } } } },
  },
};
const partial = { matches: [], truncated: true, unavailable_mappings: [{ mapping_id: mapping.id, code: 'mapping_offline' }] };
const serverDiscovery = {
  capabilities: { mappings: { rpc: { families: {
    git: { server_rpc: true, sync_reads: ['status', 'diff'], task_writes: ['commit', 'fetch'] },
    archive: { server_rpc: true, sync_reads: ['list', 'read'], task_writes: ['create', 'extract'] },
  } } } },
};

function fixture(t, config = {}, mode = 'workspace-write', response) {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-rpc-first-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const tools = new Map(), calls = [], skills = [], prompts = [];
  let failure;
  const ctx = {
    shell: {
      resolve: spec => spec,
      async execute(spec) {
        return { result: async () => {
          const { args } = JSON.parse(spec.stdin);
          const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
          const call = { method: args[0], endpoint: args[1], body: value('--json') ? JSON.parse(value('--json')) : undefined,
            timeout: value('--timeout'), plan: value('--plan-id'), taskname: value('--taskname'), message: value('--message'), spec };
          calls.push(call);
          if (failure) {
            if (failure instanceof Error) throw failure;
            return { exitCode: 1, stderr: { text: failure }, stdout: { text: '' } };
          }
          const result = call.endpoint === 'conversation' ? (call.method === 'GET' ? { next_conversation_id: 0 } : { conversation_id: 0, writer_nonce: '@Ab12@' }) : response ?? (call.endpoint === 'context' ? (call.method === 'GET' ? { entries: [{ id: 7, taskname: 'test' }] } : { id: 7 })
            : call.endpoint === '/' ? serverDiscovery
            : call.endpoint === 'mapping' ? { mappings: [mapping] }
            : call.endpoint === 'fs/query/grep' ? partial : { task_id: 'task_test', location: 'server' });
          return { exitCode: 0, stdout: { text: JSON.stringify(result) } };
        } };
      },
    },
    sandboxPolicy: { resolve: () => ({ mode }) },
    tools: { register: tool => tools.set(tool.name, tool), presentAs() {}, guard() {} },
    skills: { register: skill => skills.push(skill) },
    get: name => name === 'systemPrompt' ? { section: section => prompts.push(section.text) } : undefined,
  };
  apply(ctx, { ...config, stateDir });
  const exec = { agent: { id: 'rpc-first-test', session: { header: { id: 'rpc-first-test' } } }, signal: new AbortController().signal };
  return { tools, calls, skills, prompts, exec, fail: value => { failure = value; } };
}

test('typed Shell preserves mapping dependencies, Context, and auto defaults', async t => {
  const f = fixture(t);
  const shell = f.tools.get('kapsel_shell_exec');
  const schema = shell.parameters.properties.mount_mappings;
  assert.equal(schema.type, 'array');
  assert.equal(schema.items.type, 'string');
  assert.match(schema.description, /at most 256 non-empty/);
  assert.ok(!shell.parameters.required?.includes('mount_mappings'));
  const deps = ['laptop', mapping.id];
  await shell.execute({ command: 'python laptop/main.py', cwd: '.', target: 'server', mount_mappings: deps,
    timeout_seconds: 9, interactive: true, plan_id: 7, taskname: 'build', message: 'Use server runtime' }, f.exec);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, { command: 'python laptop/main.py', cwd: '.', target: 'server', mount_mappings: deps, timeout_seconds: 9, interactive: true });
  assert.equal(f.calls[0].plan, '7');
  assert.equal(f.calls[0].taskname, 'build');
  assert.equal(f.calls[0].message, 'Use server runtime');
  await shell.execute({ command: 'echo auto', plan_id: 7 }, f.exec);
  assert.equal(f.calls.at(-1).body.target, 'auto');
  assert.equal(f.calls.at(-1).body.cwd, '.');
  assert.ok(!Object.hasOwn(f.calls.at(-1).body, 'mount_mappings'));
  await shell.execute({ command: 'echo auto', cwd: '.', mount_mappings: deps, plan_id: 7 }, f.exec);
  assert.equal(f.calls.at(-1).body.target, 'auto');
  assert.deepEqual(f.calls.at(-1).body.mount_mappings, deps);
  await shell.execute({ command: 'echo client', cwd: 'laptop', target: 'client', mount_mappings: [], plan_id: 7 }, f.exec);
  assert.deepEqual(f.calls.at(-1).body.mount_mappings, []);
});

test('invalid or explicit client dependencies cannot create Plans or dispatch requests', async t => {
  const f = fixture(t);
  for (const mount_mappings of [null, 'laptop', {}, [1], [''], ['bad\0name'], Array(257).fill('laptop')]) {
    await assert.rejects(f.tools.get('kapsel_shell_exec').execute({ command: 'echo test', mount_mappings }, f.exec));
  }
  await assert.rejects(f.tools.get('kapsel_shell_exec').execute({ command: 'echo test', target: 'client', mount_mappings: ['laptop'] }, f.exec), /server execution/);
  assert.equal(f.calls.length, 0);
});

test('native dependencies do not bypass read-only approval or create Plans on denial', async t => {
  const f = fixture(t, {}, 'read-only');
  const body = { command: 'echo denied', target: 'server', mount_mappings: ['laptop'] };
  await assert.rejects(f.tools.get('kapsel_shell_exec').execute(body, f.exec), /read-only/);
  await assert.rejects(f.tools.get('kapsel_http').execute({ method: 'POST', endpoint: 'shell/exec', json: body }, f.exec), /read-only/);
  assert.equal(f.calls.length, 0);
});

test('Shell request budget covers both typed and generic paths independently of task timeout', async t => {
  for (const seconds of [undefined, 1, 300, 3600]) {
    const f = fixture(t, { shellRequestTimeoutSeconds: seconds });
    const body = { command: 'echo test', target: 'server', mount_mappings: ['laptop'], timeout_seconds: 9 };
    await f.tools.get('kapsel_shell_exec').execute({ ...body, plan_id: 7 }, f.exec);
    await f.tools.get('kapsel_http').execute({ method: 'POST', endpoint: '/shell/exec', json: body, plan_id: 7 }, f.exec);
    assert.equal(f.calls.length, 2);
    for (const call of f.calls) {
      assert.equal(call.timeout, String(seconds ?? 120));
      assert.equal(call.spec.timeoutMs, (seconds ?? 120) * 1000 + 10_000);
      assert.equal(call.body.timeout_seconds, 9);
      assert.deepEqual(call.body.mount_mappings, ['laptop']);
    }
    await f.tools.get('kapsel_fs_list').execute({ path: '.' }, f.exec);
    assert.equal(f.calls.at(-1).timeout, undefined);
    assert.equal(f.calls.at(-1).spec.timeoutMs, 130_000);
  }
});

test('Shell request budget rejects invalid configuration before initialization', () => {
  for (const value of [null, false, true, '', '120', 0, -1, 3601, NaN, Infinity]) {
    assert.throws(() => apply({}, { shellRequestTimeoutSeconds: value }), /shellRequestTimeoutSeconds/);
  }
});

test('failed or cancelled starts keep uncertain outcome visible and are never retried', async t => {
  for (const failure of ['request timed out', new Error('request cancelled')]) {
    const f = fixture(t);
    f.fail(failure);
    await assert.rejects(f.tools.get('kapsel_shell_exec').execute({ command: 'echo once', target: 'server', mount_mappings: ['laptop'], plan_id: 7 }, f.exec), /Inspect \/task.*never automatically replay/);
    assert.equal(f.calls.length, 1);
    await assert.rejects(f.tools.get('kapsel_http').execute({ method: 'POST', endpoint: 'shell/exec', json: { command: 'echo once' }, plan_id: 7 }, f.exec), /Inspect \/task/);
    assert.equal(f.calls.length, 2);
  }
});

test('RPC-only status and incomplete query metadata pass through without mounts', async t => {
  const f = fixture(t, {}, 'read-only');
  assert.deepEqual(await f.tools.get('kapsel_mapping_list').execute({}, f.exec), { mappings: [mapping] });
  assert.deepEqual(await f.tools.get('kapsel_fs_grep').execute({ query: 'needle', path: '.' }, f.exec), partial);
  assert.deepEqual(f.calls.map(c => c.endpoint), ['mapping', 'fs/query/grep']);
  assert.ok(f.calls.every(c => c.method === 'GET' && !c.plan));
});

test('kapsel_rpc targets server when mapping_id is omitted and preserves read/write policy', async t => {
  const readonly = fixture(t, {}, 'read-only');
  const rpc = readonly.tools.get('kapsel_rpc');
  assert.ok(!rpc.parameters.required?.includes('mapping_id'));
  await rpc.execute({ family: 'git', operation: 'status', args: { path: '.' } }, readonly.exec);
  assert.deepEqual(readonly.calls.map(c => [c.method, c.endpoint]), [
    ['GET', '/'],
    ['POST', 'rpc/git/status'],
  ]);
  assert.equal(readonly.calls[1].plan, undefined);

  await readonly.tools.get('kapsel_http').execute({
    method: 'POST', endpoint: 'rpc/archive/list', json: { args: { path: 'sample.zip' } },
  }, readonly.exec);
  assert.deepEqual(readonly.calls.slice(-2).map(c => [c.method, c.endpoint]), [
    ['GET', '/'],
    ['POST', 'rpc/archive/list'],
  ]);
  assert.equal(readonly.calls.at(-1).plan, undefined);

  const writable = fixture(t);
  await writable.tools.get('kapsel_rpc').execute({
    family: 'git', operation: 'commit', args: { message: 'test' }, timeout_seconds: 30,
    plan_id: 7, taskname: 'git', message: 'Commit server repository',
  }, writable.exec);
  assert.equal(writable.calls[0].endpoint, '/');
  assert.equal(writable.calls[1].endpoint, 'rpc/git/commit');
  assert.deepEqual(writable.calls[1].body, { args: { message: 'test' }, timeout_seconds: 30 });
  assert.equal(writable.calls[1].plan, '7');
  assert.equal(writable.calls[1].taskname, 'git');
  assert.equal(writable.calls[1].message, 'Commit server repository');

  await assert.rejects(
    writable.tools.get('kapsel_rpc').execute({ family: 'git', operation: 'unknown' }, writable.exec),
    /not advertised/,
  );
  assert.equal(writable.calls.at(-1).endpoint, '/');
});

test('mapping RPC prefers the short mapping name and remains read-only', async t => {
  const f = fixture(t, {}, 'read-only');
  await f.tools.get('kapsel_rpc').execute({
    mapping_id: mapping.name, family: 'git', operation: 'status', args: { cwd: '.' },
  }, f.exec);
  assert.deepEqual(f.calls.map(c => [c.method, c.endpoint]), [
    ['GET', 'mapping'],
    ['POST', 'mapping/laptop/rpc/git/status'],
  ]);
  assert.equal(f.calls.at(-1).plan, undefined);
});

test('bundled skill and prompt teach unified server and mapping RPC usage', t => {
  const f = fixture(t);
  const text = f.skills[0].content;
  for (const term of ['mount_mappings', 'api/mappings.json', 'file_stream', 'unavailable_mappings', 'rpc.file has been removed', 'POST /rpc/<family>/<operation>']) assert.ok(text.includes(term), term);
  assert.doesNotMatch(text, /It may fall back to FUSE|`rpc\.file`, `rpc\.git`/);
  assert.match(f.prompts.join('\n'), /server workspace/);
  assert.match(f.prompts.join('\n'), /mounted=false/);
  assert.match(f.prompts.join('\n'), /mount_mappings/);
});


test('atomic Plan requests and all returned child IDs pass through in one call', async t => {
  const receipt = { id: 20, request_id: 'feature-01', replayed: false, todos: [
    { index: 0, ref: 'code', id: 21, plan_id: 20 }, { index: 1, ref: 'tests', id: 22, plan_id: 20 },
  ] };
  const f = fixture(t, {}, 'workspace-write', receipt);
  const json = { type: 'plan', taskname: 'feature', content: 'Implement', request_id: 'feature-01',
    todos: [{ ref: 'code', content: 'Code' }, { ref: 'tests', content: 'Verify' }], conversation_id: 0, writer_nonce: '@Ab12@', conversation_entries: [{ role: 'ai', content: 'Start feature.' }] };
  const result = await f.tools.get('kapsel_http').execute({ method: 'POST', endpoint: 'context', json }, f.exec);
  assert.deepEqual(result.body, receipt);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].endpoint, 'context');
  assert.deepEqual(f.calls[0].body, json);
  assert.equal(f.calls[0].plan, undefined);
  assert.match(f.skills[0].content, /Create a Plan and its executable todo checklist/);
  assert.match(f.prompts.join('\n'), /todos.*request_id/);
});

test('legacy REST subplans remain pass-through without inventing a todos field', async t => {
  const receipt = { id: 30, todos: [{ index: 0, id: 31, plan_id: 30 }] };
  const f = fixture(t, {}, 'workspace-write', receipt);
  const json = { type: 'plan', taskname: 'legacy', content: 'Maintain REST compatibility',
    subplans: [{ content: 'Existing caller' }], conversation_id: 0,
    writer_nonce: '@Ab12@', conversation_entries: [{ role: 'ai', content: 'Legacy REST plan.' }] };
  const result = await f.tools.get('kapsel_http').execute({ method: 'POST', endpoint: 'context', json }, f.exec);
  assert.deepEqual(result.body, receipt);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, json);
  assert.equal(Object.hasOwn(f.calls[0].body, 'todos'), false);
});

test('atomic Plan creation retains approval policy and does not replay failed requests', async t => {
  const args = { method: 'POST', endpoint: 'context', json: { type: 'plan', content: 'Once', taskname: 'feature',
    request_id: 'feature-02', todos: [{ ref: 'child', content: 'Child' }], conversation_id: 0, writer_nonce: '@Ab12@', conversation_entries: [{ role: 'ai', content: 'Start feature.' }] } };
  const denied = fixture(t, {}, 'read-only');
  await assert.rejects(denied.tools.get('kapsel_http').execute(args, denied.exec), /read-only/);
  assert.equal(denied.calls.length, 0);
  const failed = fixture(t);
  failed.fail('response lost');
  await assert.rejects(failed.tools.get('kapsel_http').execute(args, failed.exec), /response lost/);
  assert.equal(failed.calls.length, 1);
  assert.equal(failed.calls[0].body.request_id, 'feature-02');
});

test('automatic Plan creation bootstraps Conversation and retains returned writer nonce', async t => {
  const f = fixture(t);
  const result = await f.tools.get('kapsel_http').execute({
    method: 'POST', endpoint: 'context', json: { type: 'plan', taskname: 'bootstrap', content: 'Start job' },
  }, f.exec);
  assert.equal(result.body.id, 7);
  assert.deepEqual(f.calls.map(x => [x.method, x.endpoint]), [
    ['GET', 'conversation'], ['POST', 'conversation'], ['POST', 'context'],
  ]);
  assert.equal(f.calls[1].body.conversation_id, 0);
  assert.match(f.calls[1].body.request_id, /^dsh-[a-f0-9]{20}-0$/);
  assert.deepEqual(f.calls[1].body.entries.map(x => x.role), ['user', 'ai']);
  assert.equal(f.calls[2].body.conversation_id, 0);
  assert.equal(f.calls[2].body.writer_nonce, '@Ab12@');
  assert.equal(f.calls[2].body.conversation_entries[0].role, 'ai');
  assert.deepEqual(f.calls[2].body.todos, []);
});

test('typed Plan updates require revisions, have immutable parentage, and append Conversation', async t => {
  const f = fixture(t);
  const plan = f.tools.get('kapsel_plan_update');
  assert.equal(plan.parameters.properties.parent_plan_id, undefined);
  assert.equal(plan.parameters.properties.move_to_root, undefined);
  assert.ok(plan.parameters.required.includes('expected_revision'));
  await assert.rejects(plan.execute({ plan_id: 7, content: 'New' }, f.exec), /expected_revision/);
  assert.equal(f.calls.length, 0);
  await plan.execute({ plan_id: 7, expected_revision: 2, content: 'New' }, f.exec);
  assert.deepEqual(f.calls.map(c => c.endpoint), ['conversation', 'conversation', 'context/plans/7']);
  const body = f.calls.at(-1).body;
  assert.equal(body.expected_revision, 2);
  assert.equal(body.conversation_id, 0);
  assert.equal(body.writer_nonce, '@Ab12@');
  assert.equal(body.conversation_entries[0].role, 'ai');
  assert.equal(body.plan_id, undefined);
  assert.match(f.skills[0].content, /restricted-http.md/);
});

test('closing the session Plan clears the cached Plan for typed and generic updates', async t => {
  for (const form of ['typed', 'http']) {
    const f = fixture(t);
    const cfg = await f.tools.get('kapsel_config').execute({
      workspace_url: 'https://example.test/kapsel/w/test_read', control_token: 'test_control',
    }, f.exec);
    assert.equal(cfg.plan_id, 7);
    assert.equal((await f.tools.get('kapsel_status').execute({}, f.exec)).plan_id, 7);
    const debrief = { items: [], outcome: 'succeeded', memory_actions: [], memory_feedback: [], memory_conflicts: [] };
    if (form === 'typed') {
      await f.tools.get('kapsel_plan_update').execute({
        plan_id: 7, expected_revision: 1, status: 'completed', debrief,
      }, f.exec);
    } else {
      await f.tools.get('kapsel_http').execute({
        method: 'PATCH', endpoint: 'context/plans/7', json: { expected_revision: 1, status: 'completed', debrief },
      }, f.exec);
    }
    assert.equal((await f.tools.get('kapsel_status').execute({}, f.exec)).plan_id, null);
  }
});

test('indexed fs_find supports omitted queries, globs, ordering and read-only access', async t => {
  const f = fixture(t, {}, 'read-only');
  await f.tools.get('kapsel_fs_find').execute({ path: 'laptop', mode: 'glob', query: '*.py',
    sort_by: 'modified', sort_order: 'desc', max_results: 25 }, f.exec);
  await f.tools.get('kapsel_fs_find').execute({ path: '.', max_results: 5 }, f.exec);
  assert.deepEqual(f.calls.map(c => [c.method, c.endpoint]), [
    ['GET', 'fs/query/find'], ['GET', 'fs/query/find'],
  ]);
  assert.ok(f.calls.every(c => !c.plan));
  assert.equal(f.calls[0].body, undefined);
  assert.equal(f.calls[1].body, undefined);
});

test('explicit Shell and File grants bind nonce without executing, approved Shell passes nonce', async t => {
  const f = fixture(t);
  const approval = f.tools.get('kapsel_shell_request_approval');
  await assert.rejects(approval.execute({ target: 'auto', reason: 'bad', plan_id: 7 }, f.exec), /explicit target/);
  assert.equal(f.calls.length, 0);
  await approval.execute({ target: 'server', reason: 'Run tests', plan_id: 7 }, f.exec);
  assert.deepEqual(f.calls.map(c => c.endpoint), ['conversation', 'conversation', 'shell/approval/request']);
  assert.deepEqual(f.calls[2].body, { target: 'server', reason: 'Run tests', writer_nonce: '@Ab12@' });
  assert.equal(f.calls[2].plan, '7');
  await f.tools.get('kapsel_shell_exec').execute({ command: 'true', target: 'server', approved: true, plan_id: 7 }, f.exec);
  assert.equal(f.calls.at(-1).endpoint, 'shell/exec');
  assert.equal(f.calls.at(-1).body.approved, true);
  assert.equal(f.calls.at(-1).body.writer_nonce, '@Ab12@');
  await f.tools.get('kapsel_files_request_approval').execute({
    access: 'read', target: 'laptop', reason: 'Read external tree', path: '/Users',
    plan_id: 7,
  }, f.exec);
  assert.equal(f.calls.at(-1).endpoint, 'files/approval/request');
  assert.deepEqual(f.calls.at(-1).body, { access: 'read', target: 'laptop',
    reason: 'Read external tree', path: '/Users', writer_nonce: '@Ab12@' });
  await f.tools.get('kapsel_http').execute({
    method: 'POST', endpoint: 'files/approval/request', plan_id: 7,
    json: { access: 'write', target: 'server', reason: 'Edit temporary file' },
  }, f.exec);
  assert.equal(f.calls.at(-1).body.writer_nonce, '@Ab12@');
  await f.tools.get('kapsel_http').execute({
    method: 'POST', endpoint: 'fs/read/files', plan_id: 7,
    json: { paths: ['/Users/test.txt'], target: 'laptop', approved: true },
  }, f.exec);
  assert.equal(f.calls.at(-1).body.writer_nonce, '@Ab12@');
  assert.equal(f.calls.at(-1).plan, '7');
});


test('function-owned Approval validates arguments and binds session nonce on typed and generic routes', async t => {
  const f = fixture(t);
  const generic = f.tools.get('kapsel_function_request_approval');
  await assert.rejects(generic.execute({ function: 'shell.exec', target: 'auto', reason: 'Why', plan_id: 7 }, f.exec), /explicit target/);
  await assert.rejects(generic.execute({ function: 'shell.exec', target: 'server', args: [], reason: 'Why', plan_id: 7 }, f.exec), /must be an object/);
  assert.equal(f.calls.length, 0);
  await generic.execute({
    function: 'files.write', target: 'laptop', args: { path: '/Users', access: 'write' },
    reason: 'Update plugin', plan_id: 7, taskname: 'plugin',
  }, f.exec);
  assert.deepEqual(f.calls.map(c => c.endpoint), ['conversation', 'conversation', 'function/approval/request']);
  assert.deepEqual(f.calls[2].body, {
    function: 'files.write', target: 'laptop', args: { path: '/Users', access: 'write' },
    reason: 'Update plugin', writer_nonce: '@Ab12@',
  });
  assert.equal(f.calls[2].plan, '7');
  await f.tools.get('kapsel_http').execute({
    method: 'POST', endpoint: '/function/approval/request', plan_id: 7,
    json: { function: 'shell.exec', target: 'server', args: {}, reason: 'Test', writer_nonce: '@Wrong@' },
  }, f.exec);
  assert.equal(f.calls.at(-1).endpoint, '/function/approval/request');
  assert.equal(f.calls.at(-1).body.writer_nonce, '@Ab12@');
  assert.equal(f.calls.at(-1).plan, '7');
  assert.match(f.prompts.join('\n'), /kapsel_function_request_approval/);
  assert.match(f.skills[0].content, /completed Plan is immutable/i);
});

test('closed cached Plan is discarded on server rejection without replaying the mutation', async t => {
  const f = fixture(t);
  await f.tools.get('kapsel_config').execute({
    workspace_url: 'https://example.test/kapsel/w/test_read', control_token: 'test_control',
  }, f.exec);
  assert.equal((await f.tools.get('kapsel_status').execute({}, f.exec)).plan_id, 7);
  f.fail('completed plan cannot be modified');
  const count = f.calls.length;
  await assert.rejects(f.tools.get('kapsel_fs_write').execute({ path: 'tmp.txt', content: 'only once' }, f.exec), /completed plan cannot be modified/);
  assert.equal(f.calls.length, count + 1);
  f.fail(null);
  assert.equal((await f.tools.get('kapsel_status').execute({}, f.exec)).plan_id, null);
});
