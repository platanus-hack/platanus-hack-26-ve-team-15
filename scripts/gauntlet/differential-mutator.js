#!/usr/bin/env node

/**
 * Differential Mutation Testing Tool
 * Author: Brandon (@branmarvel)
 * Repository: IA-Template
 * 
 * Inspired by Uncle Bob's clj-mutate and mutation testing philosophy.
 * 
 * Philosophy:
 * "A test suite that passes is not proof that the code works.
 *  A test suite that FAILS when code is mutated is proof that the tests are real."
 * 
 * If code is mutated and tests still pass, the mutant SURVIVES.
 * Surviving mutants reveal blind spots, missing assertions, and dead code.
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

function loadGauntletConfig(root = process.cwd()) {
  const cfgPath = path.join(root, 'gauntlet.config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (e) {}
  }
  return {};
}

/**
 * Masks strings, regexes, and comments on a line with spaces,
 * preserving line length and character offsets so mutation sites map 1:1.
 */
function maskLine(line) {
  // Replace string content with spaces (preserving length and delimiters)
  let masked = line.replace(/(`)(?:\\.|[^`\\])*(`)/g, (m, q1, q2) => q1 + ' '.repeat(m.length - 2) + q2);
  masked = masked.replace(/(")(?:\\.|[^"\\])*(")/g, (m, q1, q2) => q1 + ' '.repeat(m.length - 2) + q2);
  masked = masked.replace(/(')(?:\\.|[^'\\])*(')/g, (m, q1, q2) => q1 + ' '.repeat(m.length - 2) + q2);
  // Replace regex content with spaces
  masked = masked.replace(/((?:^|[=(:[,!&|?{;]|\breturn\s+|\bthrow\s+)\s*\/)(?:\\.|[^/\r\n\\])+(\/[gimsuy]*)/g, 
    (m, p1, p2) => p1 + ' '.repeat(m.length - p1.length - p2.length) + p2);
  // Strip single-line comments (// and #)
  masked = masked.replace(/((\/\/|#).*)/, (m) => ' '.repeat(m.length));
  return masked;
}

const MUTATION_OPERATORS = [
  // Equality
  { pattern: /===/g, replace: '!==' },
  { pattern: /!==/g, replace: '===' },
  { pattern: /(?<!=)==(?!=)/g, replace: '!=' },
  { pattern: /!=(?!=)/g, replace: '==' },

  // Relational (ordered >= / <= before > / <, and avoid arrow functions =>)
  { pattern: />=/g, replace: '<' },
  { pattern: /<=/g, replace: '>' },
  { pattern: /(?<![=-])>(?!=)/g, replace: '<=' },
  { pattern: /(?<!=)<(?![=-])/g, replace: '>=' },

  // Logical
  { pattern: /&&/g, replace: '||' },
  { pattern: /\|\|/g, replace: '&&' },
  { pattern: /\band\b/g, replace: 'or' },
  { pattern: /\bor\b/g, replace: 'and' },

  // Boolean Literals (JS/Go/Dart/Rust & Python)
  { pattern: /\btrue\b/g, replace: 'false' },
  { pattern: /\bfalse\b/g, replace: 'true' },
  { pattern: /\bTrue\b/g, replace: 'False' },
  { pattern: /\bFalse\b/g, replace: 'True' }
];

/**
 * Finds all potential mutation sites in a given file
 */
function findMutationSites(content) {
  const lines = content.split('\n');
  const sites = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    // Skip comments and blank lines
    if (/^\s*(\/\/|\/\*|\*)/.test(line) || line.trim().length === 0) continue;
    // Skip boilerplate guards and directives
    if (line.includes('@no-mutate') || line.includes('@gauntlet-ignore') || /require\.main\s*===/.test(line)) continue;

    const masked = maskLine(line);

    for (const op of MUTATION_OPERATORS) {
      let match;
      const regex = new RegExp(op.pattern.source, 'g');
      while ((match = regex.exec(masked)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        const mutatedLine = line.slice(0, start) + op.replace + line.slice(end);

        sites.push({
          lineNum: lineIdx + 1,
          original: match[0],
          replacement: op.replace,
          originalLine: line,
          mutatedLine
        });
      }
    }
  }

  return sites;
}

/**
 * Runs the configured test command
 * Returns true if tests pass, false if tests fail.
 */
function runTestSuite(testCmd, cwd) {
  try {
    const res = spawnSync(testCmd, {
      shell: true,
      cwd,
      stdio: 'pipe',
      timeout: 15000 // 15s timeout
    });
    return res.status === 0;
  } catch (e) {
    return false;
  }
}

/**
 * Inspects git status to find modified JS/TS files
 */
function findGitModifiedFiles(root, excludeDirs) {
  try {
    const gitDiff = execSync('git diff --name-only HEAD', { cwd: root, encoding: 'utf8' }).trim();
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: root, encoding: 'utf8' }).trim();
    const excludes = excludeDirs || ['scripts/gauntlet', 'node_modules', 'scaffolds'];
    return [gitDiff, untracked]
      .filter(Boolean)
      .join('\n')
      .split('\n')
      .filter(f => {
        if (!/\.(js|ts|mjs|cjs|jsx|tsx|dart|go|py|rs|java|kt|cs|c|cpp|h)$/.test(f)) return false;
        if (f.includes('test') || f.includes('spec')) return false;
        if (excludes.some(ex => f.startsWith(ex) || f.includes('/' + ex + '/'))) return false;
        return fs.existsSync(path.join(root, f));
      })
      .map(f => f.replace(/\\/g, '/'));
  } catch (e) {
    return [];
  }
}

/**
 * Resolves target files from git diff or explicit parameters
 */
function resolveTargetFiles(files, root, excludeDirs) {
  if (files.length > 0) return files;
  return findGitModifiedFiles(root, excludeDirs);
}

/**
 * Ensures base test suite passes before mutation
 */
function verifyBaseline(testCmd, root, dryRun) {
  if (dryRun) return true;
  process.stdout.write('Checking baseline tests... ');
  const baseGreen = runTestSuite(testCmd, root);
  if (!baseGreen) {
    console.error('\x1b[31mFAILED\x1b[0m');
    console.error('\x1b[31m[MUTATION ERROR]\x1b[0m Baseline tests are failing before mutation! Fix tests first.\n');
    return false;
  }
  console.log('\x1b[32mGREEN\x1b[0m');
  return true;
}

/**
 * Applies a single mutation, runs tests, reverts mutation, and reports survival
 */
function testSingleMutant(fullPath, originalContent, site, testCmd, root) {
  const lines = originalContent.split('\n');
  lines[site.lineNum - 1] = site.mutatedLine;
  fs.writeFileSync(fullPath, lines.join('\n'), 'utf8');

  const testPassed = runTestSuite(testCmd, root);
  fs.writeFileSync(fullPath, originalContent, 'utf8');

  return testPassed; // If true, mutant survived (tests failed to catch it)
}

/**
 * Mutates all candidate sites for a single file
 */
function mutateFileSites(relPath, root, maxMutants, dryRun, testCmd, stats) {
  const fullPath = path.join(root, relPath);
  if (!fs.existsSync(fullPath)) return;

  const originalContent = fs.readFileSync(fullPath, 'utf8');
  const sites = findMutationSites(originalContent).slice(0, maxMutants);
  if (sites.length === 0) return;

  console.log(`\nInspecting \x1b[1m${relPath}\x1b[0m (${sites.length} sites)...`);

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    stats.total++;

    if (dryRun) {
      console.log(`  [SCAN #${i + 1}] L${site.lineNum}: "${site.original}" -> "${site.replacement}"`);
      continue;
    }

    const survivor = testSingleMutant(fullPath, originalContent, site, testCmd, root);
    if (survivor) {
      stats.survived++;
      stats.survivorsList.push({ file: relPath, site });
      console.log(`  [MUTANT #${i + 1}] L${site.lineNum}: \x1b[31mSURVIVED\x1b[0m ("${site.original}" -> "${site.replacement}")`);
    } else {
      stats.killed++;
      console.log(`  [MUTANT #${i + 1}] L${site.lineNum}: \x1b[32mKILLED\x1b[0m`);
    }
  }
}

/**
 * Executes differential mutation on target files
 */
function runMutation({ files, testCmd, cwd, dryRun, maxMutants = 20 }) {
  const root = cwd || process.cwd();
  const cfg = loadGauntletConfig(root);
  const activeTestCmd = testCmd || (cfg && cfg.testCommand) || 'npm test';
  const excludeDirs = (cfg && cfg.mutation && cfg.mutation.excludeDirs) || ['scripts/gauntlet', 'node_modules', 'scaffolds'];
  const mutantLimit = maxMutants || (cfg && cfg.mutation && cfg.mutation.maxMutants) || 20;

  console.log(`\x1b[34m--- Uncle Bob's Differential Mutation Gauntlet ---\x1b[0m`);
  console.log(`Test command: "${activeTestCmd}"`);

  const targetFiles = resolveTargetFiles(files, root, excludeDirs);
  console.log(`Target files: ${targetFiles.join(', ') || 'None modified'}\n`);

  if (targetFiles.length === 0) {
    console.log('\x1b[32m✔ No modified production files detected for mutation. Gauntlet passed.\x1b[0m\n');
    return { passed: true, total: 0, killed: 0, survived: 0 };
  }

  if (!verifyBaseline(activeTestCmd, root, dryRun)) {
    return { passed: false, baselineFailed: true };
  }

  const stats = { total: 0, killed: 0, survived: 0, survivorsList: [] };
  targetFiles.forEach(f => mutateFileSites(f, root, mutantLimit, dryRun, activeTestCmd, stats));

  if (dryRun) {
    console.log(`\n\x1b[32m✔ Mutation scan completed. Found ${stats.total} potential mutation site(s).\x1b[0m\n`);
    return { passed: true, total: stats.total, killed: 0, survived: 0 };
  }

  return evaluateMutationOutcome(stats.total, stats.killed, stats.survived, stats.survivorsList);
}

/**
 * Prints final verdict and summary
 */
function evaluateMutationOutcome(total, killed, survived, survivorsList) {
  const score = total > 0 ? ((killed / total) * 100).toFixed(1) : 100;
  console.log(`\n` + '='.repeat(60));
  console.log(`Mutation Score: \x1b[1m${score}%\x1b[0m (${killed}/${total} killed, ${survived} survived)`);

  if (survived > 0) {
    console.error(`\n\x1b[31m[MUTATION GATE BLOCKED]\x1b[0m ${survived} mutant(s) survived!`);
    for (const s of survivorsList) {
      console.error(`  - ${s.file}:${s.site.lineNum}: ${s.site.original} -> ${s.site.replacement}`);
      console.error(`    Code: ${s.site.originalLine.trim()}`);
    }
    console.error(`\nUncle Bob Rule: Add or strengthen unit tests until all critical mutants are killed.\n`);
    return { passed: false, total, killed, survived };
  }

  console.log(`\x1b[32m✔ All differential mutants killed! Test suite is structurally sound.\x1b[0m\n`);
  return { passed: true, total, killed, survived };
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  let dryRun = false;
  let testCmd = null;
  const files = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scan' || args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--cmd' && args[i + 1]) {
      testCmd = args[++i];
    } else if (args[i] === '--test') {
      // Self-test with arrow function and string/regex literals
      const sample = "const re = /a==b/; const s = 'x > y'; const f = (x) => x === 1;";
      const sites = findMutationSites(sample);
      console.log(`[TEST] Found ${sites.length} mutation sites in sample code (expected 1).`);
      if (sites.length === 1 && sites[0].original === '===' && sites[0].replacement === '!==') {
        console.log('\x1b[32m✔ Differential mutator self-test passed without false-positive mutations.\x1b[0m');
        process.exit(0);
      }
      process.exit(1);
    } else if (!args[i].startsWith('--')) {
      files.push(args[i]);
    }
  }

  const res = runMutation({ files, testCmd, dryRun });
  process.exit(res.passed ? 0 : 1);
}

module.exports = {
  findMutationSites,
  runTestSuite,
  runMutation
};
