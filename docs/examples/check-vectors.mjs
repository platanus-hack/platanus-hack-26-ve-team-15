// Fails if docs/examples/examples.json is not exactly what generate-examples.mjs produces now.
// The vectors are shared by the Android and backend tests, so a stale file would make them disagree.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const fresh = execFileSync(process.execPath, [join(dir, 'generate-examples.mjs')], { encoding: 'utf8' });
const committed = readFileSync(join(dir, 'examples.json'), 'utf8');

if (fresh.trim() !== committed.trim()) {
  console.error('docs/examples/examples.json is out of date.');
  console.error('Run: node docs/examples/generate-examples.mjs > docs/examples/examples.json');
  process.exit(1);
}
console.log('examples.json matches the generator.');
