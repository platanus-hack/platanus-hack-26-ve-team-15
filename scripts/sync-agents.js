#!/usr/bin/env node

/**
 * Sync script: Mirrors .claude/skills/ (source of truth) into .agents/skills/
 * Ensures multi-agent compatibility (Claude Code & Antigravity/Cursor) without drift.
 */

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '..', '.claude', 'skills');
const DEST_DIR = path.resolve(__dirname, '..', '.agents', 'skills');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyRecursive(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function getFileMap(dir, base = '') {
  const map = {};
  if (!fs.existsSync(dir)) return map;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(map, getFileMap(full, rel));
    } else {
      map[rel] = fs.readFileSync(full, 'utf8');
    }
  }
  return map;
}

function sync() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`Source directory ${SRC_DIR} does not exist.`);
    process.exit(1);
  }
  ensureDir(DEST_DIR);

  // Clean obsolete skills in DEST_DIR
  const srcSkills = new Set(fs.readdirSync(SRC_DIR).filter(f => fs.statSync(path.join(SRC_DIR, f)).isDirectory()));
  for (const entry of fs.readdirSync(DEST_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() && !srcSkills.has(entry.name)) {
      fs.rmSync(path.join(DEST_DIR, entry.name), { recursive: true, force: true });
      console.log(`  - Removed obsolete skill: ${entry.name}`);
    }
  }

  // Copy each skill
  for (const skill of srcSkills) {
    copyRecursive(path.join(SRC_DIR, skill), path.join(DEST_DIR, skill));
  }

  console.log(`\x1b[32m✓ Synced ${srcSkills.size} skills from .claude/skills to .agents/skills.\x1b[0m`);
}

function check() {
  const srcMap = getFileMap(SRC_DIR);
  const destMap = getFileMap(DEST_DIR);

  let mismatch = false;
  for (const [file, content] of Object.entries(srcMap)) {
    if (destMap[file] !== content) {
      console.error(`\x1b[31m[DESYNC]\x1b[0m ${file} differs between .claude/skills and .agents/skills`);
      mismatch = true;
    }
  }
  for (const file of Object.keys(destMap)) {
    if (!(file in srcMap)) {
      console.error(`\x1b[31m[ORPHAN]\x1b[0m ${file} exists in .agents/skills but not in .claude/skills`);
      mismatch = true;
    }
  }

  if (mismatch) {
    console.error(`\n\x1b[31mError: Skills are out of sync! Run "npm run sync:agents" to reconcile.\x1b[0m\n`);
    process.exit(1);
  } else {
    console.log(`\x1b[32m✓ Skill sync verification passed: .agents/skills matches .claude/skills exactly.\x1b[0m`);
    process.exit(0);
  }
}

const action = process.argv[2] || 'sync';
if (action === 'check') {
  check();
} else {
  sync();
}
