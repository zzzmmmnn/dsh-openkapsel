import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const preset = readFileSync(new URL('../preset/kapsel/agent.cordis.yml', import.meta.url), 'utf8');

test('remote preset excludes every local filesystem and shell provider', () => {
  const forbidden = [
    '@deepseek-ai/dsh-tool-bash',
    '@deepseek-ai/dsh-tool-bash-persistent',
    '@deepseek-ai/dsh-tool-pwsh',
    '@deepseek-ai/dsh-tool-pwsh-persistent',
    '@deepseek-ai/dsh-tool-fs',
    '@deepseek-ai/dsh-tool-fs-search',
    '@deepseek-ai/dsh-tool-str-replace-editor',
    '@deepseek-ai/dsh-tool-jobs',
    '@deepseek-ai/dsh-fs-local',
    '@deepseek-ai/dsh-agent-instructions',
    '@deepseek-ai/dsh-skill-filesystem',
  ];
  for (const packageName of forbidden) {
    assert.equal(preset.includes(packageName), false, packageName);
  }
  assert.match(preset, /name: 'dsh-openkapsel'/);
  assert.match(preset, /enforceRemoteOnly: true/);
});
