import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installPreset } from '../preset-install.js';
import { load } from 'js-yaml';

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kapsel-bundle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('bundle declares a selectable preset with the canonical remote composition', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.exports['./bundle'], './bundle.js');
  const patch = load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'));
  const metadata = load(readFileSync(new URL('../preset/kapsel/preset.yml', import.meta.url), 'utf8'));
  const plugins = load(readFileSync(new URL('../preset/kapsel/agent.cordis.yml', import.meta.url), 'utf8'));
  assert.deepEqual(patch, [{ insert: [{
    id: 'preset-openkapsel', name: '@deepseek-ai/dsh-agent-preset',
    config: { id: 'kapsel', ...metadata, plugins },
  }] }]);
  // No profile-global bridge/guard or default-mode override is installed.
  assert.equal(patch[0].insert[0].config.plugins.at(-1).config.enforceRemoteOnly, true);
});

test('fresh installation is idempotent and adopts identical manual installs', t => {
  const dir = home(t);
  const first = installPreset({ home: dir });
  assert.equal(first.action, 'installed');
  assert.equal(installPreset({ home: dir }).action, 'unchanged');
  unlinkSync(join(first.target, '.dsh-openkapsel-install.json'));
  assert.equal(installPreset({ home: dir }).action, 'unchanged');
  assert.ok(JSON.parse(readFileSync(join(first.target, '.dsh-openkapsel-install.json'))).files['preset.yml']);
});

test('updates tracked files but preserves local edits until explicit force', t => {
  const dir = home(t);
  const { target } = installPreset({ home: dir });
  const path = join(target, 'preset.yml');
  const current = readFileSync(path, 'utf8');
  const receiptPath = join(target, '.dsh-openkapsel-install.json');
  const receipt = JSON.parse(readFileSync(receiptPath));
  writeFileSync(path, 'previous package version');
  receipt.files['preset.yml'] = createHash('sha256').update('previous package version').digest('hex');
  writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.equal(installPreset({ home: dir }).action, 'installed');
  assert.equal(readFileSync(path, 'utf8'), current);
  writeFileSync(path, 'user customization');
  const before = readFileSync(receiptPath, 'utf8');
  assert.throws(() => installPreset({ home: dir }), /local changes/);
  assert.equal(readFileSync(path, 'utf8'), 'user customization');
  assert.equal(readFileSync(receiptPath, 'utf8'), before);
  installPreset({ home: dir, force: true });
  assert.equal(readFileSync(path, 'utf8'), current);
});

test('refuses symlink destinations even with force', { skip: process.platform === 'win32' }, t => {
  const dir = home(t);
  const { target } = installPreset({ home: dir });
  const external = join(dir, 'external');
  writeFileSync(external, 'untouched');
  unlinkSync(join(target, 'preset.yml'));
  symlinkSync(external, join(target, 'preset.yml'));
  assert.throws(() => installPreset({ home: dir, force: true }), /regular file/);
  assert.equal(readFileSync(external, 'utf8'), 'untouched');
});

test('bootstrap runs without tool services and honors DSH_HOME', t => {
  const dir = home(t);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { apply } from ${JSON.stringify(new URL('../bundle.js', import.meta.url).href)}; apply();`],
  { env: { ...process.env, DSH_HOME: dir }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(dir, '.agent-presets/kapsel/agent.cordis.yml'), 'utf8'), /dsh-openkapsel/);
});
