#!/usr/bin/env node

/**
 * CRAP Score Calculator (Change Risk Anti-Pattern)
 * Author: Brandon (@branmarvel)
 * Repository: IA-Template
 * 
 * Inspired by Uncle Bob's crap4clj and Alberto Savoia & Bob Evans' CRAP metric formula.
 * 
 * Formula:
 *   CRAP(m) = CC^2 * (1 - cov)^3 + CC
 * 
 * Where:
 *   CC  = Cyclomatic Complexity of function
 *   cov = Statement/Line coverage (0.0 to 1.0)
 * 
 * Target Threshold: CRAP < 8.
 * Functions with CRAP >= 8 are high-risk under-tested code and fail the gauntlet.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DEFAULT_THRESHOLD = 8;

/**
 * Loads gauntlet.config.json if available
 */
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
 * Strips comments, strings, and regex literals to avoid false CC branches across languages.
 */
function sanitizeCodeForCC(code) {
  // 1. Remove multi-line comments and single-line comments (// and #)
  let s = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?:\/\/|#).*/g, '');
  // 2. Remove strings (preserving delimiters)
  s = s.replace(/`(?:\\.|[^`\\])*`/g, '""');
  s = s.replace(/"""[\s\S]*?"""/g, '""'); // Python triple-quotes
  s = s.replace(/'''[\s\S]*?'''/g, '""'); // Python triple single-quotes
  s = s.replace(/"(?:\\.|[^"\\])*"/g, '""');
  s = s.replace(/'(?:\\.|[^'\\])*'/g, '""');
  // 3. Remove regex literals preceded by operator or keyword (avoiding arithmetic division)
  s = s.replace(/(^|[=(:[,!&|?{;]|\breturn\s+|\bthrow\s+)\s*\/(?:\\.|[^/\r\n\\])+\/[gimsuy]*/g, '$1""');
  // 4. Strip optional chaining ?. (not a branch decision)
  s = s.replace(/\?\.(?!\d)/g, '');
  return s;
}

/**
 * Computes Cyclomatic Complexity (CC) of a code snippet
 * using branch-decision token counting across multi-language syntax.
 */
function calculateCyclomaticComplexity(code) {
  let s = sanitizeCodeForCC(code);
  let complexity = 1;

  // Nullish coalescing ?? counts as 1 branch
  const nullishMatches = s.match(/\?\?/g);
  if (nullishMatches) {
    complexity += nullishMatches.length;
    s = s.replace(/\?\?/g, '');
  }

  // Ternary ? operator counts as 1 branch
  const ternaryMatches = s.match(/\?/g);
  if (ternaryMatches) {
    complexity += ternaryMatches.length;
  }

  // Branch control patterns (JS/TS/Go/Dart/Python/Rust)
  const branchPatterns = [
    /\bif\b/g,
    /\bfor\b/g,
    /\bwhile\b/g,
    /\bcase\b/g,
    /\bcatch\b/g,
    /\bexcept\b/g,
    /\belif\b/g,
    /\band\b/g,
    /\bor\b/g,
    /&&/g,
    /\|\|/g
  ];

  for (const pattern of branchPatterns) {
    const matches = s.match(pattern);
    if (matches) {
      complexity += matches.length;
    }
  }

  return complexity;
}

function matchJsFunction(line) {
  const m = line.match(/(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(/) ||
            line.match(/(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>/);
  return m ? m[1] : null;
}

function matchMultiLangFunction(line) {
  // Go: func Receiver? Name(...)
  const mGo = line.match(/^\s*func\s+(?:\([^)]+\)\s+)?([a-zA-Z0-9_$]+)\s*\(/);
  if (mGo) return mGo[1];

  // Python: def Name(...)
  const mPy = line.match(/^\s*(?:async\s+)?def\s+([a-zA-Z0-9_$]+)\s*\(/);
  if (mPy) return mPy[1];

  // Rust: fn Name(...)
  const mRs = line.match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_$]+)\s*\(/);
  if (mRs) return mRs[1];

  // Dart / Java / C# method: [ReturnType] methodName(...) {
  const mTypedMethod = line.match(/^\s*(?:[a-zA-Z0-9_<>,\[\]?]+\s+)+([a-zA-Z0-9_$]+)\s*\([^)]*\)\s*(?:async\s*)?\{/);
  if (mTypedMethod && !/^(if|for|while|switch|catch)\b/.test(mTypedMethod[1])) {
    return mTypedMethod[1];
  }

  // Simple JS method: methodName(...) {
  const mMethod = line.match(/^\s*(?:async\s+)?([a-zA-Z0-9_$]+)\s*\([^)]*\)\s*\{/);
  if (mMethod && !/^(if|for|while|switch|catch)\b/.test(mMethod[1])) {
    return mMethod[1];
  }

  return null;
}

/**
 * Helper to match function names from lines of code across JS/TS/Go/Dart/Python/Rust
 */
function matchFunctionName(line) {
  return matchJsFunction(line) || matchMultiLangFunction(line);
}

/**
 * Finds end line of Python function via indentation tracking
 */
function findPythonFunctionEnd(lines, startIdx) {
  const startIndent = (lines[startIdx].match(/^\s*/) || [''])[0].length;
  for (let j = startIdx + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim().length === 0 || line.trim().startsWith('#')) continue;
    const curIndent = (line.match(/^\s*/) || [''])[0].length;
    if (curIndent <= startIndent) return j;
  }
  return lines.length;
}

/**
 * Finds the end line of a function body via brace matching or Python indentation
 */
function findFunctionEnd(lines, startIdx, isPython = false) {
  if (isPython) return findPythonFunctionEnd(lines, startIdx);
  let braceCount = 0;
  let foundStart = false;

  for (let j = startIdx; j < lines.length; j++) {
    const curLine = lines[j];
    const openBraces = (curLine.match(/\{/g) || []).length;
    const closeBraces = (curLine.match(/\}/g) || []).length;

    if (openBraces > 0) foundStart = true;
    braceCount += openBraces - closeBraces;

    if (foundStart && braceCount <= 0) {
      return j + 1;
    }
  }

  return Math.min(startIdx + 20, lines.length);
}

/**
 * Extracts functions and methods from multi-language source code with line ranges
 */
function extractFunctions(filePath, content) {
  const lines = content.split('\n');
  const functions = [];
  const isPython = Boolean(filePath && filePath.endsWith('.py'));

  for (let i = 0; i < lines.length; i++) {
    const fnName = matchFunctionName(lines[i]);
    if (!fnName) continue;

    const startLine = i + 1;
    const endLine = findFunctionEnd(lines, i, isPython);
    const fnCode = lines.slice(startLine - 1, endLine).join('\n');

    functions.push({
      name: fnName,
      file: filePath,
      startLine,
      endLine,
      code: fnCode
    });
  }

  return functions;
}

/**
 * Calculates CRAP score given CC and coverage (0 to 1)
 */
function calculateCrap(cc, coverage) {
  const cov = coverage === null || isNaN(coverage) ? 0.0 : Math.max(0, Math.min(1, coverage));
  return Math.pow(cc, 2) * Math.pow(1 - cov, 3) + cc;
}

/**
 * Parses a single LCOV record section
 */
function parseLcovSection(sec, projectRoot, coverageMap) {
  const fileMatch = sec.match(/SF:(.+)/);
  if (!fileMatch) return;
  const relFile = path.relative(projectRoot, fileMatch[1]).replace(/\\/g, '/');
  const linesHit = (sec.match(/DA:(\d+),([1-9]\d*)/g) || []).length;
  const linesTotal = (sec.match(/DA:(\d+),(\d+)/g) || []).length;
  coverageMap[relFile] = linesTotal > 0 ? (linesHit / linesTotal) : 0;
}

/**
 * Reads coverage from lcov.info if available
 */
function parseLcovCoverage(projectRoot) {
  const coverageMap = {};
  const possiblePaths = [
    path.join(projectRoot, 'coverage', 'lcov.info'),
    path.join(projectRoot, 'build', 'coverage', 'lcov.info')
  ];

  const lcovPath = possiblePaths.find(p => fs.existsSync(p));
  if (!lcovPath) return null;

  try {
    const content = fs.readFileSync(lcovPath, 'utf8');
    content.split('end_of_record').forEach(sec => parseLcovSection(sec, projectRoot, coverageMap));
    return coverageMap;
  } catch (e) {
    return null;
  }
}

/**
 * Checks if a relative path matches any excluded directory patterns
 */
function isPathExcluded(relPath, excludeDirs = []) {
  const norm = relPath.replace(/\\/g, '/');
  return excludeDirs.some(dir => norm === dir || norm.startsWith(dir + '/'));
}

/**
 * Calculates line/range coverage from function execution ranges
 */
function calculateFunctionsCoverage(functions = []) {
  let totalRanges = 0;
  let hitRanges = 0;
  for (const fn of functions) {
    for (const r of (fn.ranges || [])) {
      totalRanges++;
      if (r.count > 0) hitRanges++;
    }
  }
  return totalRanges > 0 ? (hitRanges / totalRanges) : 1.0;
}

/**
 * Processes a single V8 script dump item
 */
function processV8Item(item, projectRoot, coverageMap) {
  if (!item || !item.url || !item.url.startsWith('file://')) return;
  const filePath = path.relative(projectRoot, new URL(item.url).pathname).replace(/\\/g, '/');
  if (filePath.startsWith('node_modules') || filePath.startsWith('..')) return;

  const fileCov = calculateFunctionsCoverage(item.functions);
  coverageMap[filePath] = Math.max(coverageMap[filePath] || 0, fileCov);
}

/**
 * Parses V8 coverage dumps generated via NODE_V8_COVERAGE
 */
function parseV8Coverage(projectRoot) {
  const v8Dir = path.join(projectRoot, '.v8-coverage');
  if (!fs.existsSync(v8Dir)) return null;

  const coverageMap = {};
  try {
    const files = fs.readdirSync(v8Dir).filter(f => f.endsWith('.json'));
    if (files.length === 0) return null;

    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(v8Dir, file), 'utf8'));
      (data.result || []).forEach(item => processV8Item(item, projectRoot, coverageMap));
    }
    return Object.keys(coverageMap).length > 0 ? coverageMap : null;
  } catch (e) {
    return null;
  }
}

/**
 * Resolves coverage map from all available sources
 */
function resolveCoverageMap(projectRoot) {
  return parseLcovCoverage(projectRoot) || parseV8Coverage(projectRoot);
}

/**
 * Checks if a directory entry is a valid source code file
 */
function isSourceFile(name) {
  return /\.(js|ts|mjs|cjs|jsx|tsx|dart|go|py|rs|java|kt|cs|c|cpp|h)$/.test(name) && !name.endsWith('.d.ts');
}

/**
 * Recursively collects JS/TS source files from standard directories
 */
function collectSourceFiles(dir, root, out, excludeDirs = []) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (isPathExcluded(rel, excludeDirs)) continue;

    if (entry.isDirectory()) {
      collectSourceFiles(full, root, out, excludeDirs);
    } else if (isSourceFile(entry.name)) {
      out.push(rel);
    }
  }
}

/**
 * Resolves list of files to scan
 */
function resolveScanList(targetFiles, root, sourceDirs, excludeDirs = []) {
  if (targetFiles.length > 0) {
    return targetFiles.filter(f => !isPathExcluded(f, excludeDirs));
  }
  const dirs = sourceDirs || ['scripts', 'src', 'lib'];
  const out = [];
  dirs.map(d => path.join(root, d)).forEach(d => collectSourceFiles(d, root, out, excludeDirs));
  return out;
}

/**
 * Evaluates functions in a single file against CRAP threshold
 */
function analyzeSingleFile(relFile, root, coverageMap, threshold) {
  const fullPath = path.join(root, relFile);
  if (!fs.existsSync(fullPath)) return [];

  const content = fs.readFileSync(fullPath, 'utf8');
  const fns = extractFunctions(relFile, content);
  
  // Real measured coverage or null if not measured
  const isTestFile = relFile.includes('test') || relFile.includes('spec');
  const fileCov = coverageMap ? (coverageMap[relFile] ?? (isTestFile ? 1.0 : 0.0)) : null;

  return fns.map(fn => {
    const cc = calculateCyclomaticComplexity(fn.code);
    const effectiveCov = fileCov !== null ? fileCov : 1.0; // In unknown coverage, baseline against CC
    const crap = calculateCrap(cc, effectiveCov);
    return {
      name: fn.name,
      file: relFile,
      line: fn.startLine,
      cc,
      coverage: fileCov,
      crap: parseFloat(crap.toFixed(1)),
      violates: crap >= threshold
    };
  });
}

/**
 * Main analysis function
 */
function runCrapAnalysis(options = {}) {
  const root = options.root || process.cwd();
  const cfg = loadGauntletConfig(root);
  const threshold = options.threshold || (cfg.crap && cfg.crap.threshold) || DEFAULT_THRESHOLD;
  const sourceDirs = (cfg && cfg.sourceDirs) || ['scripts', 'src', 'lib'];
  const excludeDirs = (cfg && cfg.crap && cfg.crap.excludeDirs) || ['scripts/gauntlet', 'node_modules', 'scaffolds', '.handoffs', '.v8-coverage'];
  const filesToScan = resolveScanList(options.files || [], root, sourceDirs, excludeDirs);
  const covMap = resolveCoverageMap(root);

  const results = [];
  let violations = 0;

  for (const relFile of filesToScan) {
    const fileRecords = analyzeSingleFile(relFile, root, covMap, threshold);
    for (const rec of fileRecords) {
      if (rec.violates) violations++;
      results.push(rec);
    }
  }

  results.sort((a, b) => b.crap - a.crap);
  return { results, violations, threshold, hasCoverage: Boolean(covMap) };
}

// CLI Execution
if (require.main === module) {
  const args = process.argv.slice(2);
  let threshold = DEFAULT_THRESHOLD;
  const files = [];
  let diffMode = false;
  let quickMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--threshold' && args[i + 1]) {
      threshold = parseFloat(args[++i]);
    } else if (args[i] === '--diff') {
      diffMode = true;
    } else if (args[i] === '--quick' || args[i] === '-q') {
      quickMode = true;
    } else if (args[i] === '--test') {
      // Self-test
      const tests = [
        ['else-if single count', 'function f(a,b){ if(a){} else if(b){} }', 3],
        ['nullish coalescing ??', 'function f(a){ return a ?? 1; }', 2],
        ['optional chaining ?.', 'function f(a){ return a?.b?.c; }', 1],
        ['switch case branches', 'function f(a){ switch(a){ case 1: break; default: break; } }', 2],
        ['division vs regex', 'function f(a,b,c){ return a / b + (c ? 1 : 2) / 3; }', 2],
      ];
      let passed = true;
      for (const [lbl, code, exp] of tests) {
        const val = calculateCyclomaticComplexity(code);
        if (val !== exp) {
          console.error(`✖ FAIL: ${lbl} (expected ${exp}, got ${val})`);
          passed = false;
        }
      }
      if (passed) {
        console.log('\x1b[32m✔ All CRAP Cyclomatic Complexity self-tests passed.\x1b[0m');
        process.exit(0);
      }
      process.exit(1);
    } else if (!args[i].startsWith('--')) {
      files.push(args[i]);
    }
  }

  if (diffMode && files.length === 0) {
    try {
      const cfg = loadGauntletConfig(process.cwd());
      const excludeDirs = (cfg && cfg.crap && cfg.crap.excludeDirs) || ['scripts/gauntlet', 'node_modules', 'scaffolds', '.handoffs', '.v8-coverage'];
      const gitOut = execSync('git diff --name-only HEAD', { encoding: 'utf8' }).trim();
      const untracked = execSync('git ls-files --others --exclude-standard', { encoding: 'utf8' }).trim();
      const combined = [gitOut, untracked].filter(Boolean).join('\n').split('\n');
      for (const f of combined) {
        const norm = f.replace(/\\/g, '/');
        if (isSourceFile(norm) && fs.existsSync(norm) && !isPathExcluded(norm, excludeDirs)) {
          files.push(norm);
        }
      }
    } catch (e) {}
  }

  console.log(`\x1b[34m--- Uncle Bob's CRAP Quality Metric (Threshold: < ${threshold}) ---\x1b[0m`);
  const { results, violations, hasCoverage } = runCrapAnalysis({ threshold, files });

  if (!hasCoverage) {
    console.log('\x1b[33m⚡ Note: Real coverage report not found. Evaluating Cyclomatic Complexity.\x1b[0m');
  }

  if (results.length === 0) {
    console.log('\x1b[32m✔ No functions detected or all files empty.\x1b[0m');
    process.exit(0);
  }

  // Print summary table
  console.log(
    'Function'.padEnd(28) +
    'Location'.padEnd(35) +
    'CC'.padEnd(6) +
    'Cov%'.padEnd(8) +
    'CRAP'.padEnd(8) +
    'Status'
  );
  console.log('-'.repeat(95));

  for (const r of results.slice(0, 20)) {
    const loc = `${r.file}:${r.line}`;
    const status = r.violates ? '\x1b[31mCRAPPY (FAIL)\x1b[0m' : '\x1b[32mCLEAN\x1b[0m';
    const covStr = r.coverage !== null ? `${(r.coverage * 100).toFixed(0)}%` : 'n/a';
    console.log(
      r.name.slice(0, 26).padEnd(28) +
      loc.slice(0, 33).padEnd(35) +
      String(r.cc).padEnd(6) +
      covStr.padEnd(8) +
      String(r.crap).padEnd(8) +
      status
    );
  }

  if (violations > 0) {
    console.error(`\n\x1b[31m[CRAP GATE BLOCKED]\x1b[0m Found ${violations} function(s) with CRAP >= ${threshold}.`);
    console.error(`Guideline: Reduce cyclomatic complexity (split functions, remove nested branches) or add tests until CRAP < ${threshold}.\n`);
    process.exit(1);
  } else {
    console.log(`\n\x1b[32m✔ All ${results.length} analyzed function(s) passed Uncle Bob's CRAP metric (CRAP < ${threshold}).\x1b[0m\n`);
    process.exit(0);
  }
}

module.exports = {
  calculateCyclomaticComplexity,
  calculateCrap,
  extractFunctions,
  runCrapAnalysis,
  parseV8Coverage,
  isPathExcluded,
  loadGauntletConfig
};
