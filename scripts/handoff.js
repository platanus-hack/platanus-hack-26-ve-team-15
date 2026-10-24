#!/usr/bin/env node

/**
 * SwarmForge Git-Commit Handoff Protocol (IA-Template)
 * Inspired by Uncle Bob's SwarmForge handoff daemon & constitution.
 * 
 * TOKEN CONSERVATION MECHANISM:
 * Instead of carrying forward thousands of tokens of multi-turn conversational chat,
 * each subagent commits its work to git and creates a minimal structured handoff.
 * 
 * The next subagent starts in a clean context window and only reads:
 * 1. The short task name
 * 2. The commit SHA
 * 3. `git show --stat <commit>`
 * 
 * Token savings: Up to 80-90% reduction in context window footprint.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HANDOFF_ROOT = path.resolve(__dirname, '..', '.handoffs');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getLatestCommit(root) {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim();
  } catch (e) {
    return 'initial-commit';
  }
}

function sendHandoff({ to, task, summary, from = 'coder', priority = '00', root = process.cwd() }) {
  if (!to || !task) {
    console.error('\x1b[31m[HANDOFF ERROR]\x1b[0m Must specify recipient role and task name.');
    console.log('Usage: node scripts/handoff.js send <toRole> <taskName> [summary]');
    process.exit(1);
  }

  const roleInbox = path.join(HANDOFF_ROOT, 'inbox', to);
  ensureDir(roleInbox);

  const commit = getLatestCommit(root);
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const fileName = `${priority}_${timestamp}_from_${from}_to_${to}.json`;
  const filePath = path.join(roleInbox, fileName);

  const payload = {
    type: 'git_handoff',
    to,
    from,
    priority,
    task,
    commit,
    summary: summary || `Handoff of ${task} at commit ${commit}`,
    timestamp: now.toISOString()
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');

  console.log(`\n\x1b[32m✔ [HANDOFF DISPATCHED]\x1b[0m Sent task "${task}" to @${to}`);
  console.log(`  Commit SHA: \x1b[1m${commit}\x1b[0m`);
  console.log(`  Handoff payload: ${path.relative(root, filePath)}`);
  console.log(`\x1b[34m⚡ Token Economy:\x1b[0m Next agent only loads \`git show ${commit}\` (~150 tokens) instead of full chat history (~8,000+ tokens).\n`);

  return payload;
}

function receiveNextHandoff(role, root = process.cwd()) {
  const roleInbox = path.join(HANDOFF_ROOT, 'inbox', role);
  const archiveDir = path.join(HANDOFF_ROOT, 'archive');
  ensureDir(roleInbox);
  ensureDir(archiveDir);

  const files = fs.readdirSync(roleInbox)
    .filter(f => f.endsWith('.json'))
    .sort(); // Sorts by priority and timestamp automatically

  if (files.length === 0) {
    console.log(`\x1b[33m[NO_PENDING_HANDOFF]\x1b[0m Inbox empty for @${role}.`);
    return null;
  }

  const nextFile = files[0];
  const srcPath = path.join(roleInbox, nextFile);
  const data = JSON.parse(fs.readFileSync(srcPath, 'utf8'));

  // Move to archive
  const destPath = path.join(archiveDir, nextFile);
  fs.renameSync(srcPath, destPath);

  console.log('\n\x1b[1m\x1b[35m' + '='.repeat(60) + '\x1b[0m');
  console.log(`\x1b[1m\x1b[35m   INCOMING HANDOFF FOR @${role.toUpperCase()}   \x1b[0m`);
  console.log('\x1b[1m\x1b[35m' + '='.repeat(60) + '\x1b[0m');
  console.log(`Task:      \x1b[1m${data.task}\x1b[0m`);
  console.log(`Sender:    @${data.from}`);
  console.log(`Commit:    \x1b[36m${data.commit}\x1b[0m`);
  console.log(`Summary:   ${data.summary}`);
  console.log(`Timestamp: ${data.timestamp}\n`);

  // Print git show diffstat if available
  try {
    const diffStat = execSync(`git show --stat --oneline ${data.commit}`, { cwd: root, encoding: 'utf8' }).trim();
    console.log('\x1b[34m--- Git Commit Diffstat ---\x1b[0m');
    console.log(diffStat + '\n');
  } catch (e) {
    // If commit not found in local git history
  }

  return data;
}

function listAllHandoffs() {
  console.log('\x1b[34m--- Active Handoff Queues (.handoffs/inbox/) ---\x1b[0m');
  const inboxRoot = path.join(HANDOFF_ROOT, 'inbox');
  if (!fs.existsSync(inboxRoot)) {
    console.log('No active handoff queues.\n');
    return;
  }

  const roles = fs.readdirSync(inboxRoot);
  let totalPending = 0;

  for (const r of roles) {
    const rDir = path.join(inboxRoot, r);
    if (!fs.statSync(rDir).isDirectory()) continue;
    const items = fs.readdirSync(rDir).filter(f => f.endsWith('.json'));
    totalPending += items.length;
    console.log(`@${r.padEnd(18)} : ${items.length} pending task(s)`);
    for (const item of items) {
      console.log(`  - ${item}`);
    }
  }

  console.log(`Total Pending: ${totalPending}\n`);
}

/**
 * Cleans up temporary test archive files
 */
function cleanupTestArchive(archiveDir) {
  if (!fs.existsSync(archiveDir)) return;
  fs.readdirSync(archiveDir)
    .filter(f => f.includes('test-cleaner'))
    .forEach(f => fs.unlinkSync(path.join(archiveDir, f)));
}

// Self-test
function runHandoffTest() {
  console.log('\x1b[34m--- Running SwarmForge Handoff Protocol Self-Tests ---\x1b[0m');
  const testRoot = path.resolve(__dirname, '..');
  const sent = sendHandoff({
    to: 'test-cleaner',
    from: 'test-coder',
    task: 'sample-tdd-slice',
    summary: 'Unit specs verified',
    root: testRoot
  });
  if (!sent || sent.task !== 'sample-tdd-slice') {
    throw new Error('Failed to send handoff payload');
  }

  const received = receiveNextHandoff('test-cleaner', testRoot);
  if (!received || received.task !== 'sample-tdd-slice') {
    throw new Error('Failed to receive next handoff payload');
  }

  cleanupTestArchive(path.join(HANDOFF_ROOT, 'archive'));
  console.log('\x1b[32m✔ SwarmForge Handoff Protocol Test Passed.\x1b[0m\n');
  process.exit(0);
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const action = args[0] || 'list';

  if (action === 'send') {
    const to = args[1];
    const task = args[2];
    const summary = args.slice(3).join(' ');
    sendHandoff({ to, task, summary });
  } else if (action === 'next') {
    const role = args[1] || 'cleaner';
    receiveNextHandoff(role);
  } else if (action === 'list') {
    listAllHandoffs();
  } else if (action === 'test') {
    runHandoffTest();
  } else {
    console.log(`
SwarmForge Git-Commit Handoff Protocol
Usage:
  node scripts/handoff.js send <toRole> <taskName> [summary]
  node scripts/handoff.js next <role>
  node scripts/handoff.js list
  node scripts/handoff.js test
`);
  }
}

module.exports = {
  sendHandoff,
  receiveNextHandoff,
  listAllHandoffs
};
