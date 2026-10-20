// Opt in with DSH_RUNTIME_PACKAGE=/absolute/path/to/@deepseek-ai/dsh/package.json.
// Uses the installed DSH loader and Shell executor against a local mock workspace.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';

test('a clean DSH profile loads the remote mode and initializes through the real Shell executor', {
  skip: !process.env.DSH_RUNTIME_PACKAGE, timeout: 60_000,
}, async t => {
  const installAnchor = resolve(process.env.DSH_RUNTIME_PACKAGE);
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-kapsel-runtime-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = temporary;
  let ctx, workspace;
  t.after(async () => {
    try {
      if (workspace?.listening) await new Promise(resolve => workspace.close(resolve));
      await ctx?.fiber.dispose();
    }
    finally {
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  const profileDir = join(temporary, 'profiles', 'web');
  const installed = join(profileDir, 'node_modules', 'dsh-openkapsel');
  mkdirSync(installed, { recursive: true });
  const source = fileURLToPath(new URL('../', import.meta.url));
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  // Copy the published files only; source node_modules must not hide host API errors.
  for (const entry of ['package.json', ...pkg.files]) {
    cpSync(join(source, entry), join(installed, entry), { recursive: true });
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dependencies: { 'dsh-openkapsel': `file:${installed}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-openkapsel'] } },
  }));
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n');
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n');

  const hostRequire = createRequire(installAnchor);
  const hostModule = name => import(pathToFileURL(hostRequire.resolve(`@deepseek-ai/${name}`)).href);
  const { loadProfileDirectory, readProfilePatches, createRuntimeResolution, PluginPackages, boot } = await hostModule('dsh-app-boot');
  const { createScope } = await hostModule('dsh-scope');
  const profile = loadProfileDirectory('dsh', profileDir, installAnchor);
  const context = { dir: profileDir, patchPath: profile.patchPath, installAnchor, home: temporary, overlays: [], telemetryDisabledEnv: '1' };
  const resolution = await createRuntimeResolution({ installAnchor, profile, home: temporary });
  // These transport/UI rows are unrelated to mode activation and need no socket.
  const disabled = ['webserver', 'connection', 'web-startup', 'web-runtime', 'session-log-download',
    'open-in-app', 'directory-picker', 'session-controller', 'client-hmr', 'file-upload', 'ui-deliverables',
    'schedule', 'harness-dev-context'];
  const patches = [...readProfilePatches('dsh', context, profile), ...disabled.map(id => ({ id, disabled: true }))];
  ctx = await boot('openkapsel-runtime-test', join(profileDir, 'cordis.yml'), patches,
    async host => { await host.plugin(PluginPackages, { resolution }); });

  const registry = ctx.get('agentPresets');
  const presets = await registry.list();
  const remote = presets.filter(preset => preset.id === 'kapsel');
  assert.equal(remote.length, 1, JSON.stringify(presets));
  assert.equal(remote[0].name, 'OpenKapsel Remote');
  assert.equal(remote[0].broken, undefined, JSON.stringify(remote[0]));
  assert.equal(registry.defaultId, 'standard');
  assert.equal(existsSync(join(temporary, '.agent-presets', 'kapsel')), false,
    'modern registration must not depend on copying legacy preset files');
  const remoteKey = {};
  const remoteScope = createScope(ctx, remoteKey);
  assert.equal((await registry.mount(remoteScope.ctx, 'kapsel')).id, 'kapsel');
  const tools = ctx.get('tools');
  const names = tools.schemas(remoteKey).map(tool => tool.name);
  assert.ok(names.includes('kapsel_config'));
  assert.ok(names.includes('kapsel_shell_exec'));
  assert.ok(names.includes('kapsel_function_request_approval'));
  for (const forbidden of ['bash', 'read', 'write', 'run_code']) assert.ok(!names.includes(forbidden), forbidden);
  const standardKey = {};
  const standardScope = createScope(ctx, standardKey);
  await registry.mount(standardScope.ctx, 'standard');
  assert.ok(!tools.schemas(standardKey).some(tool => tool.name.startsWith('kapsel_')));

  // Loading schemas alone does not exercise the host Shell API. Execute both
  // fixed Python helpers through the real host, without model/server credentials.
  const requests = [];
  workspace = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url.includes('/fs/query/list')
      ? { entries: [{ name: 'runtime.txt' }] }
      : { name: 'Runtime workspace', capabilities: { files: { read: true } },
        authentication: { credentials_expires_at: new Date(Date.now() + 3 * 86400000).toISOString() } }));
  });
  workspace.listen(0, '127.0.0.1');
  await once(workspace, 'listening');
  const session = ctx.get('sessions').create(undefined, { meta: { cwd: temporary, agentPreset: 'kapsel' } });
  const exec = { agent: { id: session.id, session, ctx: remoteScope.ctx }, signal: new AbortController().signal };
  const configure = tools.get('kapsel_config', remoteKey);
  await assert.rejects(configure.execute({ workspace_url: 'invalid', control_token: 'test-control', create_plan: false }, exec), /openkapsel:/);
  const configured = await configure.execute({
    workspace_url: `http://127.0.0.1:${workspace.address().port}/w/read_runtime`,
    control_token: 'test-control', create_plan: false,
  }, exec);
  assert.equal(configured.config.action, 'created');
  assert.equal(configured.workspace.name, 'Runtime workspace');
  assert.equal(configured.dsh_sandbox_mode, 'workspace-write');
  const listed = await tools.get('kapsel_fs_list', remoteKey).execute({ path: '.' }, exec);
  assert.deepEqual(listed.entries, [{ name: 'runtime.txt' }]);
  assert.ok(requests.some(url => url.includes('/fs/query/list')));
  assert.equal(existsSync(join(temporary, '.openkapsel.env')), false);
});
