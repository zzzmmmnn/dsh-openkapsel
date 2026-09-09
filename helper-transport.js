// Only this fixed bootstrap is interpreted by the Host Shell. Helper paths
// and model-supplied arguments travel as ASCII JSON on stdin.
const bootstrap = `import json, runpy, sys
from pathlib import Path
payload = json.loads(sys.stdin.buffer.read().decode('ascii'))
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
script = payload['script']
sys.argv = [script, *payload['args']]
sys.path.insert(0, str(Path(script).parent))
runpy.run_path(script, run_name='__main__')
`;

export function helperTransport(script, args, platform = process.platform) {
  for (const value of [script, ...args]) {
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new Error('Helper arguments must be strings without NUL');
    }
  }
  const code = `exec(bytes.fromhex('${Buffer.from(bootstrap).toString('hex')}'))`;
  const command = platform === 'win32'
    ? `$ErrorActionPreference = 'Stop'; & python -B -E -s -c "${code}"; exit $LASTEXITCODE`
    : `python3 -B -E -s -c "${code}"`;
  return {
    command,
    // ASCII also avoids differences in PowerShell 5.1/7 stdin encodings.
    stdin: JSON.stringify({ script, args }).replace(/[\u007f-\uffff]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`),
  };
}
