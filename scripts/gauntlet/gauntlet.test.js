#!/usr/bin/env node

/**
 * Unit Tests for Uncle Bob's Gauntlet Tools
 * Tests crap-score, differential-mutator, and gauntlet-runner.
 */

const assert = require('assert');
const path = require('path');
const { calculateCyclomaticComplexity, calculateCrap, extractFunctions, runCrapAnalysis } = require('./crap-score');
const { findMutationSites, runTestSuite } = require('./differential-mutator');

console.log('\x1b[34m--- Running Gauntlet Engine Unit Tests ---\x1b[0m');

// 1. Test Cyclomatic Complexity
const linearCode = 'function foo(a) { const b = a + 1; return b; }';
assert.strictEqual(calculateCyclomaticComplexity(linearCode), 1, 'Linear code must have CC = 1');

const branchedCode = `
  function bar(a, b) {
    if (a > 10) {
      for (let i = 0; i < 5; i++) {
        if (b && a) return 1;
      }
    } else if (b < 0) {
      return -1;
    }
    return 0;
  }
`;
const branchedCC = calculateCyclomaticComplexity(branchedCode);
assert.ok(branchedCC >= 5, `Branched code CC should be >= 5 (got ${branchedCC})`);

// 2. Test CRAP Score Formula
// Formula: CC^2 * (1 - cov)^3 + CC
const cc = 10;
const crap100 = calculateCrap(cc, 1.0);
assert.strictEqual(crap100, 10, 'At 100% coverage, CRAP score must equal CC');

const crap0 = calculateCrap(cc, 0.0);
assert.strictEqual(crap0, 110, 'At 0% coverage, CRAP score must equal CC^2 + CC = 110');

const crap50 = calculateCrap(cc, 0.5);
// 100 * (0.5)^3 + 10 = 100 * 0.125 + 10 = 22.5
assert.strictEqual(parseFloat(crap50.toFixed(1)), 22.5, 'At 50% coverage, CRAP score must be 22.5');

// 3. Test Function Extraction
const sampleModule = `
  function alpha(x) { return x * 2; }
  const beta = (y) => { if (y) return true; return false; };
`;
const extracted = extractFunctions('sample.js', sampleModule);
assert.strictEqual(extracted.length, 2, `Should extract 2 functions (got ${extracted.length})`);
assert.strictEqual(extracted[0].name, 'alpha');
assert.strictEqual(extracted[1].name, 'beta');

// Test multi-language function extraction (Go, Python, Dart, Rust)
const multiLangSource = `
func CalculateTax(val int) int { return val * 2; }
def process_user_event(evt):
    return True
fn verify_token(raw: &str) -> bool { true }
Widget build(BuildContext context) { return Container(); }
`;
const multiExtracted = extractFunctions('multi.go', multiLangSource);
const multiNames = multiExtracted.map(f => f.name);
assert.ok(multiNames.includes('CalculateTax'), 'Should extract Go function');
assert.ok(multiNames.includes('process_user_event'), 'Should extract Python function');
assert.ok(multiNames.includes('verify_token'), 'Should extract Rust function');
assert.ok(multiNames.includes('build'), 'Should extract Dart method');

// 4. Test Mutation Site Identification
const mutantTarget = 'if (status === 200 && isAuth !== false) { return true; }';
const sites = findMutationSites(mutantTarget);
assert.ok(sites.length >= 4, `Should find at least 4 mutation sites (got ${sites.length})`);
const repls = sites.map(s => s.replacement);
assert.ok(repls.includes('!=='), 'Should offer !== for ===');
assert.ok(repls.includes('||'), 'Should offer || for &&');
assert.ok(repls.includes('true'), 'Should offer true for false');

// Test Python boolean and logical mutation sites
const pySites = findMutationSites('if is_active and not False: return True');
const pyRepls = pySites.map(s => s.replacement);
assert.ok(pyRepls.includes('or'), 'Should offer or for and in Python');
assert.ok(pyRepls.includes('True'), 'Should offer True for False in Python');
assert.ok(pyRepls.includes('False'), 'Should offer False for True in Python');

// 5. Test Test Suite Runner Helper
assert.strictEqual(runTestSuite('node -e "process.exit(0)"', process.cwd()), true);
assert.strictEqual(runTestSuite('node -e "process.exit(1)"', process.cwd()), false);

// 6. Test CRAP Analysis Engine
const crapResult = runCrapAnalysis({
  root: path.resolve(__dirname, '..', '..'),
  threshold: 8,
  files: ['scripts/gauntlet/gauntlet.test.js']
});
assert.ok(Array.isArray(crapResult.results), 'Results should be an array');
assert.strictEqual(crapResult.violations, 0, 'gauntlet.test.js should have 0 violations');

// 7. Test Handoff Protocol Engine
const { sendHandoff, receiveNextHandoff } = require('../handoff');
const handoffSent = sendHandoff({
  to: 'test-harness',
  from: 'test-runner',
  task: 'verify-handoff',
  summary: 'Verify unit assertions',
  root: path.resolve(__dirname, '..', '..')
});
assert.strictEqual(handoffSent.to, 'test-harness');
assert.strictEqual(handoffSent.task, 'verify-handoff');
assert.ok(handoffSent.commit && handoffSent.commit.length > 0);

const handoffReceived = receiveNextHandoff('test-harness', path.resolve(__dirname, '..', '..'));
assert.strictEqual(handoffReceived.to, 'test-harness');
assert.strictEqual(handoffReceived.task, 'verify-handoff');

// 8. Test CRAP Exclude Dirs & Path Filtering
const { isPathExcluded, parseV8Coverage } = require('./crap-score');
assert.strictEqual(isPathExcluded('node_modules/foo/bar.js', ['node_modules']), true);
assert.strictEqual(isPathExcluded('scripts/my-script.js', ['node_modules', 'scaffolds']), false);
assert.strictEqual(isPathExcluded('scaffolds/fullstack-web/app.js', ['scaffolds']), true);

// 9. Test Scaffold Generator Config, Recursive Copy & CLI
const os = require('os');
const fs = require('fs');
const {
  generateScaffoldGauntletConfig,
  copyDirRecursive,
  getScaffoldConfig,
  runCli,
  TEMPLATES
} = require('../scaffold-generator');
assert.ok(TEMPLATES['fullstack-web'], 'Templates should contain fullstack-web');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-test-'));
const srcSub = path.join(tmpDir, 'src');
// Test deep nested directory creation (kills recursive: true mutant)
const dstSub = path.join(tmpDir, 'nested', 'level', 'dst');
fs.mkdirSync(srcSub);
fs.writeFileSync(path.join(srcSub, 'test.txt'), 'hello', 'utf8');
copyDirRecursive(srcSub, dstSub);
assert.strictEqual(fs.readFileSync(path.join(dstSub, 'test.txt'), 'utf8'), 'hello');

// Test fallback scaffold config (kills || -> && mutant)
const fallbackConfig = getScaffoldConfig('unknown-template-xyz');
assert.strictEqual(fallbackConfig.name, 'unknown-template-xyz');

generateScaffoldGauntletConfig('fullstack-web', dstSub);
const generatedConfig = JSON.parse(fs.readFileSync(path.join(dstSub, 'gauntlet.config.json'), 'utf8'));
assert.strictEqual(generatedConfig.name, 'fullstack-web');
assert.strictEqual(generatedConfig.crap.threshold, 8);

// Test CLI router outcomes (kills CLI branch mutants)
assert.strictEqual(runCli([]), 'list');
assert.strictEqual(runCli(['list']), 'list');
const cliDeployTarget = path.join(tmpDir, 'cli-deploy');
assert.strictEqual(runCli(['fullstack-web', cliDeployTarget]), 'deploy');
assert.ok(fs.existsSync(path.join(cliDeployTarget, 'package.json')));

fs.rmSync(tmpDir, { recursive: true, force: true });

// 10. Test Gauntlet Runner Config Loader
const { loadGauntletConfig } = require('./gauntlet-runner');
const rootConfig = loadGauntletConfig(path.resolve(__dirname, '..', '..'));
assert.strictEqual(rootConfig.name, 'ia-template');

// 11. Test Repository Adopter Engine
const {
  detectProjectTech,
  adoptRepository,
  copyFileSafe,
  getTechConfig,
  isValidTargetDir
} = require('../adopt');

// Test isValidTargetDir
assert.strictEqual(isValidTargetDir(null), false);
assert.strictEqual(isValidTargetDir(''), false);
assert.strictEqual(isValidTargetDir('/non/existent/path/gauntlet/test/999'), false);

// Test copyFileSafe with nested directories (kills mutant recursive: true -> false)
const copyTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-safe-'));
const dummySrc = path.join(copyTestDir, 'source.txt');
fs.writeFileSync(dummySrc, 'hello world', 'utf8');
const nestedDest = path.join(copyTestDir, 'level1', 'level2', 'nested-dest.txt');
copyFileSafe(dummySrc, nestedDest);
assert.ok(fs.existsSync(nestedDest));
assert.strictEqual(fs.readFileSync(nestedDest, 'utf8'), 'hello world');

// Test getTechConfig fallback (kills mutant || -> &&)
assert.strictEqual(getTechConfig('python').testCommand, 'pytest --cov=. --cov-report=lcov:coverage/lcov.info');
assert.strictEqual(getTechConfig('unknown_lang').testCommand, 'npm test');

const adoptMockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-mock-'));
assert.strictEqual(isValidTargetDir(adoptMockDir), true);

// Test tech detection
fs.writeFileSync(path.join(adoptMockDir, 'pubspec.yaml'), 'name: my_app\n', 'utf8');
assert.strictEqual(detectProjectTech(adoptMockDir), 'flutter');
fs.unlinkSync(path.join(adoptMockDir, 'pubspec.yaml'));

fs.writeFileSync(path.join(adoptMockDir, 'go.mod'), 'module example.com/app\n', 'utf8');
assert.strictEqual(detectProjectTech(adoptMockDir), 'go');
fs.unlinkSync(path.join(adoptMockDir, 'go.mod'));

// Test adoption in existing project with package.json
const existingPkg = { name: 'existing-app', version: '2.0.0', scripts: { dev: 'next dev' } };
fs.writeFileSync(path.join(adoptMockDir, 'package.json'), JSON.stringify(existingPkg, null, 2), 'utf8');

adoptRepository(adoptMockDir);

// Verify package.json was merged, not overwritten
const updatedPkg = JSON.parse(fs.readFileSync(path.join(adoptMockDir, 'package.json'), 'utf8'));
assert.strictEqual(updatedPkg.name, 'existing-app');
assert.strictEqual(updatedPkg.scripts.dev, 'next dev');
assert.ok(updatedPkg.scripts.gauntlet, 'Should have gauntlet script merged');

// Verify harness files transferred
assert.ok(fs.existsSync(path.join(adoptMockDir, 'AGENTS.md')));
assert.ok(fs.existsSync(path.join(adoptMockDir, 'gauntlet.config.json')));
assert.ok(fs.existsSync(path.join(adoptMockDir, 'scripts', 'gauntlet', 'gauntlet-runner.js')));

// Verify .gitignore updated (kills mutant missing.length > 0 -> <= 0)
const gitignoreContent = fs.readFileSync(path.join(adoptMockDir, '.gitignore'), 'utf8');
assert.ok(gitignoreContent.includes('.v8-coverage/'), 'Gitignore must include .v8-coverage/');
assert.ok(gitignoreContent.includes('.handoffs/'), 'Gitignore must include .handoffs/');

// Verify target file path isn't a directory for isValidTargetDir
assert.strictEqual(isValidTargetDir(path.join(adoptMockDir, 'package.json')), false);

fs.rmSync(adoptMockDir, { recursive: true, force: true });
fs.rmSync(copyTestDir, { recursive: true, force: true });

console.log('\x1b[32m✔ All Uncle Bob Gauntlet Unit Tests Passed Successfully.\x1b[0m');
process.exit(0);
