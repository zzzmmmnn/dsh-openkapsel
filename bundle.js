import { installPreset } from './preset-install.js';

// Host-plane bootstrap only. Tools and guard belong to the selected preset.
export const name = 'openkapsel-preset-bootstrap';
export function apply() {
  installPreset();
}
