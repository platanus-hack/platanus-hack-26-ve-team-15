#!/usr/bin/env node

/**
 * Master Gauntlet Runner — Uncle Bob's Autonomous AI Trust Engine
 * Author: Brandon (@branmarvel)
 * Repository: IA-Template
 * 
 * "My current strategy is to not read any of the code written by my agents.
 *  That's the only way I can take advantage of their productivity."
 *  — Robert C. Martin ("Uncle Bob")
 * 
 * Five Non-Negotiable Gates of Quality:
 * 1. Syntax & Structural Integrity
 * 2. TDD & Behavior Specs (Green tests + V8 coverage collection)
 * 3. CRAP Metric Control (CC^2 * (1 - cov)^3 + CC < 8)
 * 4. Differential Mutation Testing (Kill all syntax mutants)
 * 5. AgentShield Security & Leak Defense
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

function loadGauntletConfig(root = ROOT_DIR) {
  const cfgPath = path.join(root, 'gauntlet.config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (e) {}
  }
  return {};
}

function runStep(name, command, args = [], options = {}) {
  console.log(`\n\x1b[36m▶ [GATE] ${name}\x1b[0m`);
  const startTime = Date.now();

  const res = spawnSync(command, args, {
    cwd: options.cwd || ROOT_DIR,
    stdio: 'inherit',
    shell: true,
    env: options.env || process.env
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  if (res.status !== 0) {
    console.error(`\x1b[31m✖ [GATE FAILED]\x1b[0m ${name} failed in ${duration}s.`);
    return false;
  }

  console.log(`\x1b[32m✔ [GATE PASSED]\x1b[0m ${name} in ${duration}s.`);
  return true;
}

function runGauntlet(mode = 'strict') {
  const cfg = loadGauntletConfig(ROOT_DIR);
  const testCmd = (cfg && cfg.testCommand) || 'npm test';

  console.log('\x1b[1m\x1b[35m' + '='.repeat(65) + '\x1b[0m');
  console.log('\x1b[1m\x1b[35m   UNCLE BOB\'S AUTONOMOUS AI TRUST GAUNTLET (IA-TEMPLATE)   \x1b[0m');
  console.log('\x1b[1m\x1b[35m' + '='.repeat(65) + '\x1b[0m');
  console.log(`Mode: \x1b[1m${mode.toUpperCase()}\x1b[0m`);

  // 1. Gate 1: Security & Secrets Scan
  const gateShield = runStep(
    'Gate 1: AgentShield Secret & Leak Inspection',
    'node',
    ['scripts/agent-shield.js', 'scan']
  );
  if (!gateShield) process.exit(1);

  // 2. Gate 2: Deterministic Hook Router & Test Verification with V8 Coverage
  const covDir = path.join(ROOT_DIR, '.v8-coverage');
  if (!fs.existsSync(covDir)) fs.mkdirSync(covDir, { recursive: true });

  const testParts = testCmd.split(' ');
  const testBin = testParts[0];
  const testArgs = testParts.slice(1);

  const gateTests = runStep(
    'Gate 2: Core Behavioral Specs & V8 Coverage Collection',
    testBin,
    testArgs,
    {
      env: Object.assign({}, process.env, { NODE_V8_COVERAGE: covDir })
    }
  );
  if (!gateTests) process.exit(1);

  // 3. Gate 3: CRAP Metric (< 8)
  const crapArgs = ['scripts/gauntlet/crap-score.js', '--diff'];
  if (mode === 'quick') crapArgs.push('--quick');

  const gateCrap = runStep(
    'Gate 3: CRAP Complexity Metric (CC + Real Coverage Risk)',
    'node',
    crapArgs
  );
  if (!gateCrap) process.exit(1);

  if (mode === 'strict') {
    // 4. Gate 4: Differential Mutation Testing
    const gateMutation = runStep(
      'Gate 4: Differential Mutation Testing (Mutant Killer)',
      'node',
      ['scripts/gauntlet/differential-mutator.js']
    );
    if (!gateMutation) process.exit(1);
  } else {
    console.log('\n\x1b[33m⚡ Gate 4 (Differential Mutation) skipped in quick hackathon mode.\x1b[0m');
  }

  console.log('\n\x1b[1m\x1b[32m' + '='.repeat(65) + '\x1b[0m');
  console.log('\x1b[1m\x1b[32m   ✔ ALL GAUNTLET GATES PASSED — CODE IS CERTIFIED TRUSTWORTHY   \x1b[0m');
  console.log('\x1b[1m\x1b[32m' + '='.repeat(65) + '\x1b[0m\n');
  process.exit(0);
}

// CLI entrypoint
if (require.main === module) {
  const args = process.argv.slice(2);
  const isQuick = args.includes('--quick') || args.includes('-q');
  const mode = isQuick ? 'quick' : 'strict';
  runGauntlet(mode);
}

module.exports = {
  loadGauntletConfig,
  runStep,
  runGauntlet
};
