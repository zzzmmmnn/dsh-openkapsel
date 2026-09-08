import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { shellQuote } from '../index.js';

test('POSIX quoting preserves adversarial and generated arguments through Bash', () => {
  const values = ['', "'", "a'b", '\n', '\r\n', '\\', '$(printf INJECTED)',
    '`printf INJECTED`', '; printf INJECTED #', '"quoted"', ' spaces\t',
    '-n', '中文🌍', "'\n$(printf INJECTED)\\"];
  // Deterministic generated cases exercise combinations, not just individual characters.
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
  const command = ['python3', '-c',
    'import json,sys; print(json.dumps(sys.argv[1:]))', ...values]
    .map(shellQuote).join(' ');
  const output = execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', command], {
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(output), values);
});

test('NUL is rejected because operating-system argv cannot represent it', () => {
  for (const value of ['\0', 'before\0after', '\0suffix', 'prefix\0']) {
    assert.throws(() => shellQuote(value), /must not contain NUL/);
  }
});
