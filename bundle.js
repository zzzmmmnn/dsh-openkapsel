import { installPreset } from './preset-install.js';

// Legacy DSH bootstrap, retained for explicit pre-0.2 integrations.
// Modern profiles use the declarative preset in cordis.patch.yml instead.
export const name = 'openkapsel-preset-bootstrap';
export function apply() {
  installPreset();
}
