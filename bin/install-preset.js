#!/usr/bin/env node

import { installPreset } from '../preset-install.js';

try {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--force')) {
    throw new Error('Usage: dsh-openkapsel-install-preset [--force]');
  }
  const { target, action } = installPreset({ force: args.includes('--force') });
  console.log(`OpenKapsel Remote preset ${action}: ${target}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
