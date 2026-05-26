#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────
//  SKOPIX BACKUP
//  Works on Mac, Windows, and Linux — no dependencies needed.
//  Usage: node skopix-backup.js
// ─────────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const SKOPIX_DIR = path.join(os.homedir(), '.skopix');
const TODAY = new Date().toISOString().slice(0, 10);
const BACKUP_NAME = `skopix-backup-${TODAY}.zip`;
const DESKTOP = path.join(os.homedir(), 'Desktop');
const DEST = path.join(DESKTOP, BACKUP_NAME);

const c = {
  cyan:  (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red:   (s) => `\x1b[31m${s}\x1b[0m`,
  dim:   (s) => `\x1b[2m${s}\x1b[0m`,
  bold:  (s) => `\x1b[1m${s}\x1b[0m`,
};

function countFiles(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
    else count++;
  }
  return count;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

console.log('');
console.log(c.cyan(c.bold('  SKOPIX BACKUP')));
console.log('  ' + c.dim('─'.repeat(50)));

if (!fs.existsSync(SKOPIX_DIR)) {
  console.log('  ' + c.red('✖') + ' ~/.skopix not found — nothing to back up');
  process.exit(1);
}

const fileCount = countFiles(SKOPIX_DIR);
const size = formatBytes(dirSize(SKOPIX_DIR));
console.log('  Source : ' + c.cyan(SKOPIX_DIR));
console.log('  Files  : ' + fileCount + ' files (' + size + ')');
console.log('  Saving : ' + c.cyan(DEST));
console.log('');

if (fs.existsSync(DEST)) fs.unlinkSync(DEST);

try {
  const isWindows = process.platform === 'win32';
  if (isWindows) {
    const ps = `Compress-Archive -Path "${SKOPIX_DIR}\\*" -DestinationPath "${DEST}" -Force`;
    execSync(`powershell -Command "${ps}"`, { stdio: 'pipe' });
  } else {
    execSync(`cd "${os.homedir()}" && zip -r "${DEST}" .skopix`, { stdio: 'pipe' });
  }
  console.log('  ' + c.green('✔') + ' Backup saved to:');
  console.log('  ' + c.cyan(DEST));
  console.log('');
  console.log('  ' + c.dim('Restore with: node skopix-restore.js'));
  console.log('');
} catch (e) {
  console.log('  ' + c.red('✖') + ' Backup failed: ' + e.message);
  process.exit(1);
}
