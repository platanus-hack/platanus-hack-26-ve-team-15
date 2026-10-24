// AgentShield: what counts as an exposed environment file. Each case builds a real throwaway git repository.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { scanDirectory } = require('./agent-shield.js');

// Built at run time so this file does not trip the scanner itself.
const FAKE_KEY = 'sk-ant-api' + '03-' + 'x'.repeat(85);

function workspace({ git = true, ignore = '.env\n.env.*\n!.env.example\n', files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-'));
  if (git) execFileSync('git', ['init', '-q'], { cwd: dir });
  if (ignore !== null) fs.writeFileSync(path.join(dir, '.gitignore'), ignore);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const kinds = (dir) => scanDirectory(dir, [], dir).map((i) => `${i.type}:${i.filePath}`);

test('an env file that git ignores and does not track is left alone, contents included', () => {
  const dir = workspace({ files: { '.env': `ANTHROPIC_API_KEY=${FAKE_KEY}\n`, 'backend/.env': 'A=1\n', '.env.local': 'B=2\n' } });
  assert.deepEqual(kinds(dir), []);
});

test('an env file that git tracks is an exposure, even when .gitignore lists it', () => {
  const dir = workspace({ files: { '.env': 'A=1\n' } });
  execFileSync('git', ['add', '-f', '.env'], { cwd: dir });
  assert.deepEqual(kinds(dir), ['EXPOSED_ENV_FILE:.env']);
});

test('an env file that git does not ignore is an exposure', () => {
  const dir = workspace({ ignore: 'node_modules/\n', files: { '.env': 'A=1\n', 'backend/.env.production': 'B=2\n' } });
  assert.deepEqual(kinds(dir).sort(), ['EXPOSED_ENV_FILE:.env', 'EXPOSED_ENV_FILE:backend/.env.production']);
});

test('with no git to ask, an env file is an exposure', () => {
  const dir = workspace({ git: false, files: { '.env': 'A=1\n' } });
  assert.deepEqual(kinds(dir), ['EXPOSED_ENV_FILE:.env']);
});

test('.env.example is never reported', () => {
  const dir = workspace({ ignore: null, files: { '.env.example': 'ANTHROPIC_API_KEY=\n' } });
  assert.deepEqual(kinds(dir), []);
});

test('a secret in any other file is still caught, ignored or not', () => {
  const dir = workspace({ ignore: 'ignored.js\n', files: { 'config.js': `const k = "${FAKE_KEY}";\n`, 'ignored.js': `const k = "${FAKE_KEY}";\n` } });
  assert.deepEqual(kinds(dir).sort(), ['SECRET_LEAK:config.js', 'SECRET_LEAK:ignored.js']);
});

test('a file called like an env file but not starting with .env is not special', () => {
  const dir = workspace({ files: { 'baliza-backend.env': 'A=1\n', 'notes.env.txt': 'B=2\n' } });
  assert.deepEqual(kinds(dir), []);
});
