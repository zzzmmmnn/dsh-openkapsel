import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { helperTransport } from '../helper-transport.js';

const shells = process.platform === 'win32'
  ? ['pwsh.exe', 'powershell.exe'] : ['/bin/bash'];

for (const shell of shells) {
  test(`helper arguments round-trip through ${shell} without entering command text`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'kapsel transport '));
    const script = join(directory, "echo ' 中文.py");
    try {
      writeFileSync(script, 'import json,sys\nprint(json.dumps(sys.argv[1:]))\n');
      const values = ['', "'", '"', '\n', '\r\n', '\\', '$(printf INJECTED)',
        '`printf INJECTED`', '; exit 91 #', ' spaces\t', '-n', '中文🌍',
        'C:\\Users\\a b\\', '$env:USERPROFILE', '%PATH%'];
      const alphabet = [..."abc ' \\\"$();`#\n\t\r中文🌍"];
      let seed = 123456789;
      for (let i = 0; i < 400; i++) {
        let value = '';
        for (let j = 0; j < i % 80; j++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          value += alphabet[seed % alphabet.length];
        }
        values.push(value);
      }
      const spec = helperTransport(script, values);
      assert.equal(spec.command, helperTransport('different.py', ['secret']).command);
      assert.match(spec.stdin, /^[\x00-\x7f]*$/);
      const flags = process.platform === 'win32'
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', spec.command]
        : ['--noprofile', '--norc', '-c', spec.command];
      const output = execFileSync(shell, flags, { input: spec.stdin, encoding: 'utf8' });
      assert.deepEqual(JSON.parse(output), values);
      writeFileSync(script, 'raise SystemExit(17)\n');
      assert.throws(() => execFileSync(shell, flags, { input: spec.stdin }),
        (error) => error.status === 17);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('Windows selects python and PowerShell; other hosts select python3', () => {
  assert.match(helperTransport('x.py', [], 'win32').command, /& python /);
  assert.match(helperTransport('x.py', [], 'win32').command, /exit \$LASTEXITCODE$/);
  for (const platform of ['darwin', 'linux']) {
    assert.match(helperTransport('x.py', [], platform).command, /^python3 /);
  }
});

test('NUL arguments are rejected before Shell execution', () => {
  for (const value of ['\0', 'before\0after']) {
    assert.throws(() => helperTransport('x.py', [value]), /without NUL/);
    assert.throws(() => helperTransport(value, []), /without NUL/);
  }
});
