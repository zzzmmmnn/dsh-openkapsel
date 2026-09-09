import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./preset/kapsel/', import.meta.url));
const filenames = ['agent.cordis.yml', 'preset.yml'];
const receiptName = '.dsh-openkapsel-install.json';
const hash = (data) => createHash('sha256').update(data).digest('hex');

function regular(path, directory = false) {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) {
      throw new Error(`OpenKapsel preset target must be a regular ${directory ? 'directory' : 'file'}: ${path}`);
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function atomicWrite(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Install only our preset. A receipt permits updates to untouched files. */
export function installPreset({ home = process.env.DSH_HOME || join(homedir(), '.dsh'), force = false } = {}) {
  const root = join(home, '.agent-presets');
  const target = join(root, 'kapsel');
  regular(root, true);
  regular(target, true);
  const receiptPath = join(target, receiptName);
  let previous = {};
  if (regular(receiptPath)) {
    try { previous = JSON.parse(readFileSync(receiptPath, 'utf8')).files || {}; }
    catch { /* An invalid receipt cannot authorize overwriting modified files. */ }
  }
  const files = filenames.map(name => ({ name, data: readFileSync(join(source, name)) }));
  const conflicts = [];
  let changed = false;
  for (const file of files) {
    const path = join(target, file.name);
    if (!regular(path)) { changed = true; continue; }
    const existing = readFileSync(path);
    if (existing.equals(file.data)) continue;
    changed = true;
    if (!force && hash(existing) !== previous[file.name]) conflicts.push(file.name);
  }
  if (conflicts.length) {
    throw new Error(`OpenKapsel preset has local changes (${conflicts.join(', ')}). Files were preserved. To replace them, run dsh plugin --profile <profile> exec dsh-openkapsel-install-preset --force.`);
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const path = join(target, file.name);
    if (!existsSync(path) || !readFileSync(path).equals(file.data)) atomicWrite(path, file.data);
  }
  const receipt = JSON.stringify({ files: Object.fromEntries(files.map(file => [file.name, hash(file.data)])) }, null, 2) + '\n';
  if (!existsSync(receiptPath) || readFileSync(receiptPath, 'utf8') !== receipt) atomicWrite(receiptPath, receipt);
  return { target, action: changed ? 'installed' : 'unchanged' };
}
