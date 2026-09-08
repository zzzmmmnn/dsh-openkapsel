#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const force = process.argv.slice(2).includes('--force');
const source = fileURLToPath(new URL('../preset/kapsel/', import.meta.url));
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const target = join(dshHome, '.agent-presets', 'kapsel');
const files = ['agent.cordis.yml', 'preset.yml'];

for (const filename of files) {
  if (existsSync(join(target, filename)) && !force) {
    console.error(`Refusing to replace ${target}; rerun with --force.`);
    process.exitCode = 1;
    process.exit();
  }
}

mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
mkdirSync(target, { recursive: true, mode: 0o700 });
chmodSync(target, 0o700);
for (const filename of files) {
  const destination = join(target, filename);
  copyFileSync(join(source, filename), destination);
  chmodSync(destination, 0o600);
}

console.log(`Installed OpenKapsel Remote preset at ${target}`);
