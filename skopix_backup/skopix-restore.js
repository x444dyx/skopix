#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────
//  SKOPIX RESTORE
//  Works on Mac, Windows, and Linux — no dependencies needed.
//  Usage: node skopix-restore.js
//     or: node skopix-restore.js /path/to/skopix-backup-2026-05-26.zip
// ─────────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import readline from 'readline';

const SKOPIX_DIR = path.join(os.homedir(), '.skopix');

const c = {
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
};

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('  ' + question, ans => { rl.close(); resolve(ans.trim()); });
  });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function countFiles(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
    else count++;
  }
  return count;
}

function findBackups() {
  const searchDirs = [
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Downloads'),
    os.homedir(),
    process.cwd(),
  ];
  const found = [];
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('skopix-backup') && f.endsWith('.zip')) {
        found.push(path.join(dir, f));
      }
    }
  }
  return found;
}

console.log('');
console.log(c.cyan(c.bold('  SKOPIX RESTORE')));
console.log('  ' + c.dim('─'.repeat(50)));

// Find backup file
let src = process.argv[2];

if (!src) {
  const found = findBackups();
  if (found.length === 0) {
    console.log('  ' + c.red('✖') + ' No backup files found on Desktop or Downloads.');
    console.log('  Run: node skopix-restore.js /path/to/backup.zip');
    process.exit(1);
  } else if (found.length === 1) {
    src = found[0];
    console.log('  Found: ' + c.cyan(src));
  } else {
    console.log('  Found multiple backups:');
    found.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
    const choice = await ask('Which one to restore? (1-' + found.length + '): ');
    const idx = parseInt(choice) - 1;
    if (isNaN(idx) || idx < 0 || idx >= found.length) {
      console.log('  ' + c.red('✖') + ' Invalid choice'); process.exit(1);
    }
    src = found[idx];
  }
}

if (!fs.existsSync(src)) {
  console.log('  ' + c.red('✖') + ' File not found: ' + src);
  process.exit(1);
}

console.log('  Backup : ' + c.cyan(src));
console.log('');

// Warn about overwrite
if (fs.existsSync(SKOPIX_DIR)) {
  const existing = countFiles(SKOPIX_DIR);
  console.log('  ' + c.yellow('⚠') + '  This will overwrite ~/.skopix (' + existing + ' files)');
  const confirm = await ask('Continue? (y/N): ');
  if (confirm.toLowerCase() !== 'y') {
    console.log('  ' + c.yellow('⚠') + '  Restore cancelled.');
    process.exit(0);
  }

  // Auto-backup existing data first
  const autoBackup = path.join(os.tmpdir(), 'skopix-pre-restore-' + Date.now());
  copyDir(SKOPIX_DIR, autoBackup);
  console.log('  ' + c.dim('Auto-backed up existing data to: ' + autoBackup));
}

console.log('  Restoring...');

try {
  const tmpDir = path.join(os.tmpdir(), 'skopix-restore-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  const isWindows = process.platform === 'win32';
  if (isWindows) {
    const ps = `Expand-Archive -Path "${src}" -DestinationPath "${tmpDir}" -Force`;
    execSync(`powershell -Command "${ps}"`, { stdio: 'pipe' });
  } else {
    execSync(`unzip -o "${src}" -d "${tmpDir}"`, { stdio: 'pipe' });
  }

  // Find .skopix inside the extracted folder
  const inner = path.join(tmpDir, '.skopix');
  const actualSrc = fs.existsSync(inner) ? inner : tmpDir;

  if (fs.existsSync(SKOPIX_DIR)) fs.rmSync(SKOPIX_DIR, { recursive: true, force: true });
  copyDir(actualSrc, SKOPIX_DIR);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const restored = countFiles(SKOPIX_DIR);
  console.log('');
  console.log('  ' + c.green('✔') + ' Restored ' + restored + ' files to ' + c.cyan(SKOPIX_DIR));
  console.log('  ' + c.green('✔') + ' Restart Skopix to see your data');
  console.log('');
} catch (e) {
  console.log('  ' + c.red('✖') + ' Restore failed: ' + e.message);
  process.exit(1);
}
