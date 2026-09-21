import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apply } from '../index.js';

const mapping = {
  id: 'abcdefghijklmnopqrstuvwx', name: 'laptop', online: true, mounted: false,
  mount_references: 0, native_mounts_enabled: false,
  capabilities: { file_stream: { version: 1, descriptor_stat: true, directory_details: true, search_prefix: true } },
};
const partial = { matches: [], truncated: true, unavailable_mappings: [{ mapping_id: mapping.id, code: 'mapping_offline' }] };

function fixture(t, config = {}, mode = 'workspace-write', response) {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-rpc-first-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const tools = new Map(), calls = [], skills = [], prompts = [];
  let failure;
  const ctx = {
    shell: {
      resolve: spec => spec,
      async run(spec) {
        const { args } = JSON.parse(spec.stdin);
        const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
        const call = { method: args[0], endpoint: args[1], body: value('--json') ? JSON.parse(value('--json')) : undefined,
          timeout: value('--timeout'), plan: value('--plan-id'), taskname: value('--taskname'), message: value('--message'), spec };
        calls.push(call);
        if (failure) {
          if (failure instanceof Error) throw failure;
          return { exitCode: 1, stderr: { text: failure }, stdout: { text: '' } };
        }
        const result = response ?? (call.endpoint === 'context' ? (call.method === 'GET' ? { entries: [{ id: 7, taskname: 'test' }] } : { id: 7 })
          : call.endpoint === 'mappings' ? { mappings: [mapping] }
          : call.endpoint === 'fs/search' ? partial : { task_id: 'task_test', location: 'server' });
        return { exitCode: 0, stdout: { text: JSON.stringify(result) } };
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
    await assert.rejects(f.tools.get('kapsel_shell_exec').execute({ command: 'echo once', target: 'server', mount_mappings: ['laptop'], plan_id: 7 }, f.exec), /Inspect \/tasks.*never automatically replay/);
    assert.equal(f.calls.length, 1);
    await assert.rejects(f.tools.get('kapsel_http').execute({ method: 'POST', endpoint: 'shell/exec', json: { command: 'echo once' }, plan_id: 7 }, f.exec), /Inspect \/tasks/);
    assert.equal(f.calls.length, 2);
  }
});

test('RPC-only status and incomplete query metadata pass through without mounts', async t => {
  const f = fixture(t, {}, 'read-only');
  assert.deepEqual(await f.tools.get('kapsel_mappings').execute({}, f.exec), { mappings: [mapping] });
  assert.deepEqual(await f.tools.get('kapsel_fs_search').execute({ query: 'needle', path: '.' }, f.exec), partial);
  assert.deepEqual(f.calls.map(c => c.endpoint), ['mappings', 'fs/search']);
  assert.ok(f.calls.every(c => c.method === 'GET' && !c.plan));
});

test('bundled skill and prompt teach RPC-first mapping usage', t => {
  const f = fixture(t);
  const text = f.skills[0].content;
  for (const term of ['mount_mappings', 'api/mappings.json', 'file_stream', 'unavailable_mappings', 'rpc.file has been removed']) assert.ok(text.includes(term), term);
  assert.doesNotMatch(text, /It may fall back to FUSE|`rpc\.file`, `rpc\.git`/);
  assert.match(f.prompts.join('\n'), /mounted=false/);
  assert.match(f.prompts.join('\n'), /mount_mappings/);
});


test('atomic Plan requests and all returned child IDs pass through in one call', async t => {
  const receipt = { id: 20, request_id: 'feature-01', replayed: false, subplans: [
    { index: 0, ref: 'code', id: 21, plan_id: 20 }, { index: 1, ref: 'tests', id: 22, plan_id: 20 },
  ] };
  const f = fixture(t, {}, 'workspace-write', receipt);
  const json = { type: 'plan', taskname: 'feature', content: 'Implement', request_id: 'feature-01',
    subplans: [{ ref: 'code', content: 'Code' }, { ref: 'tests', content: 'Verify' }] };
  const result = await f.tools.get('kapsel_http').execute({ method: 'POST', endpoint: 'context', json }, f.exec);
  assert.deepEqual(result.body, receipt);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].endpoint, 'context');
  assert.deepEqual(f.calls[0].body, json);
  assert.equal(f.calls[0].plan, undefined);
  assert.match(f.skills[0].content, /Create a plan and direct subplans in one call/);
  assert.match(f.prompts.join('\n'), /subplans.*request_id/);
});

test('atomic Plan creation retains approval policy and does not replay failed requests', async t => {
  const args = { method: 'POST', endpoint: 'context', json: { type: 'plan', content: 'Once', taskname: 'feature',
    request_id: 'feature-02', subplans: [{ ref: 'child', content: 'Child' }] } };
  const denied = fixture(t, {}, 'read-only');
  await assert.rejects(denied.tools.get('kapsel_http').execute(args, denied.exec), /read-only/);
  assert.equal(denied.calls.length, 0);
  const failed = fixture(t);
  failed.fail('response lost');
  await assert.rejects(failed.tools.get('kapsel_http').execute(args, failed.exec), /response lost/);
  assert.equal(failed.calls.length, 1);
  assert.equal(failed.calls[0].body.request_id, 'feature-02');
});
