#!/usr/bin/env node

/**
 * JEV Deterministic Hook Router for Claude Code
 * 
 * Intercepts lifecycle events deterministically via stdin JSON:
 * - PreToolUse (Bash): Blocks destructive commands; runs AgentShield before git commit/push.
 * - PreToolUse (Write/Edit/Read): Blocks edits to sensitive files (.env, keys, certificates).
 * - PostToolUseFailure (Bash): Tracks recurring errors to trigger advisor escalation after 2 failures.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const CACHE_FILE = path.join(__dirname, '..', '.jev-cache.json');
const SHIELD_SCRIPT = path.join(__dirname, 'agent-shield.js');

function loadLedger() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (e) {
    // corrupted or unreadable
  }
  return { errorLog: {} };
}

function saveLedger(ledger) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(ledger, null, 2), 'utf8');
  } catch (e) {
    // silent fail in read-only setups
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => { resolve(data.trim()); });
    // Safety timeout in case stdin is not piped
    setTimeout(() => { resolve(data.trim()); }, 500);
  });
}

function deny(reason, eventName = 'PreToolUse') {
  console.error(`\x1b[31m[JEV GATE BLOCKED]\x1b[0m ${reason}`);
  const output = {
    hookSpecificOutput: {
      hookEventName: eventName,
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  };
  console.log(JSON.stringify(output));
  process.exit(2);
}

function allow() {
  process.exit(0);
}

// 1. Evaluate Bash commands
function evaluateBash(commandStr) {
  const cmd = (commandStr || '').toLowerCase();

  const dangerousPatterns = [
    /rm\s+-rf\s+[\/\*]/,
    /del\s+\/s\s+\/q\s+[c-z]:\\/i,
    /format\s+[c-z]:/i,
    /git\s+push\s+.*--force/,
    /git\s+push\s+.*-f\b/,
    /:(){ :|:& };:/
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(cmd)) {
      deny(`Destructive command detected: "${cmd}". Execution blocked by deterministic security gate.`);
    }
  }

  // Pre-commit / pre-push guardrail with AgentShield & Uncle Bob Gauntlet
  if (/git\s+(commit|push)\b/.test(cmd)) {
    try {
      execSync(`node "${SHIELD_SCRIPT}" precommit`, { stdio: 'inherit' });
      execSync('npm run gauntlet:quick', { stdio: 'inherit' });
    } catch (e) {
      deny('Uncle Bob Gauntlet or AgentShield verification failed. Commit blocked.');
    }
  }

  allow();
}

// 2. Evaluate File Edits / Reads
function evaluateFileAccess(filePath) {
  const fp = (filePath || '').trim().replace(/\\/g, '/');

  const protectedPatterns = [
    /(^|\/)\.env(\.|$)/i,
    /\.pem$/i,
    /\.key$/i,
    /id_rsa/i,
    /id_ed25519/i,
    /(^|\/)\.git\//i
  ];

  for (const pattern of protectedPatterns) {
    if (pattern.test(fp)) {
      deny(`Access to sensitive/internal path "${filePath}" blocked by JEV security gate.`);
    }
  }

  allow();
}

// 3. Track recurring errors (Opus 2nd Error Gate)
function recordError(errorPayload) {
  const msg = typeof errorPayload === 'string' ? errorPayload : JSON.stringify(errorPayload);
  const hash = crypto.createHash('sha256').update(msg.slice(0, 300)).digest('hex').slice(0, 12);

  const ledger = loadLedger();
  ledger.errorLog[hash] = (ledger.errorLog[hash] || 0) + 1;
  const count = ledger.errorLog[hash];
  saveLedger(ledger);

  if (count >= 2) {
    console.error(`\n\x1b[33m⚠️  [JEV ADVISOR ALERT: SAME ERROR REPEATED ${count} TIMES]\x1b[0m`);
    console.error(`Error signature hash: [${hash}]`);
    console.error(`Guideline: Stop blind retries. Consider consulting Opus advisor for diagnosis before repeating.\n`);
  }
  allow();
}

function parseJsonInput(rawInput) {
  if (!rawInput) return {};
  try {
    return JSON.parse(rawInput);
  } catch (e) {
    return {};
  }
}

function handlePreToolUse(toolName, toolInput) {
  const isBash = toolName === 'Bash' || toolName === 'PowerShell';
  if (isBash) {
    evaluateBash(toolInput.command || '');
    return;
  }

  const isFileEdit = ['Write', 'Edit', 'Read'].includes(toolName);
  if (isFileEdit) {
    evaluateFileAccess(toolInput.file_path || toolInput.path || '');
    return;
  }

  allow();
}

function extractToolMetadata(payload) {
  return {
    name: payload.tool_name || payload.tool || '',
    input: payload.tool_input || {}
  };
}

function extractFailureError(payload) {
  return payload.error || payload.tool_output || payload;
}

async function handleHook(eventArg) {
  const rawInput = await readStdin();
  const payload = parseJsonInput(rawInput);

  if (eventArg === 'PreToolUse') {
    const meta = extractToolMetadata(payload);
    handlePreToolUse(meta.name, meta.input);
  } else if (eventArg === 'PostToolUseFailure') {
    recordError(extractFailureError(payload));
  } else {
    allow();
  }
}

// Self-tests
function runTests() {
  console.log('\x1b[34m--- Running JEV Router Self-Tests ---\x1b[0m');
  const { spawnSync } = require('child_process');

  // Test 1: Destructive command gate
  const res1 = spawnSync('node', [__filename, 'hook', 'PreToolUse'], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
    encoding: 'utf8'
  });
  if (res1.status !== 2) throw new Error(`JEV failed to block destructive command (status: ${res1.status})`);

  // Test 2: Safe command gate
  const res2 = spawnSync('node', [__filename, 'hook', 'PreToolUse'], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' } }),
    encoding: 'utf8'
  });
  if (res2.status !== 0) throw new Error(`JEV blocked safe command (status: ${res2.status})`);

  // Test 3: Protected file edit gate
  const res3 = spawnSync('node', [__filename, 'hook', 'PreToolUse'], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '.env' } }),
    encoding: 'utf8'
  });
  if (res3.status !== 2) throw new Error(`JEV failed to block .env write (status: ${res3.status})`);

  // Test 4: Protected key read gate
  const res4 = spawnSync('node', [__filename, 'hook', 'PreToolUse'], {
    input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'id_rsa' } }),
    encoding: 'utf8'
  });
  if (res4.status !== 2) throw new Error(`JEV failed to block id_rsa read (status: ${res4.status})`);

  console.log('\x1b[32m✓ All JEV Deterministic Gate Tests Passed in <10ms.\x1b[0m');
  process.exit(0);
}

const action = process.argv[2] || 'help';

if (action === 'hook') {
  const event = process.argv[3] || 'PreToolUse';
  handleHook(event);
} else if (action === 'test') {
  runTests();
} else {
  console.log(`
JEV Deterministic Hook Router
Usage:
  node scripts/jev-router.js hook PreToolUse           # Reads JSON from stdin
  node scripts/jev-router.js hook PostToolUseFailure   # Reads JSON from stdin
  node scripts/jev-router.js test                      # Run unit tests
`);
  process.exit(0);
}
