import chalk from 'chalk';
import path from 'path';
import fs from 'fs-extra';
import open from 'open';

export async function reportCommand(options) {
  const dir = path.resolve(options.dir);

  if (!await fs.pathExists(dir)) {
    console.log(chalk.red(`\n  No reports found at: ${dir}\n`));
    process.exit(1);
  }

  let sessions = await fs.readdir(dir);
  sessions = sessions.filter(s => !s.startsWith('.'));

  if (sessions.length === 0) {
    console.log(chalk.yellow('\n  No sessions found. Run a test first!\n'));
    process.exit(0);
  }

  // Sort by actual modification time (most recent first)
  const withStats = await Promise.all(
    sessions.map(async (s) => {
      const stat = await fs.stat(path.join(dir, s));
      return { name: s, mtime: stat.mtime };
    })
  );
  const sorted = withStats.sort((a, b) => b.mtime - a.mtime);
  const latest = sorted[0].name;
  const reportPath = path.join(dir, latest, 'report.html');

  if (!await fs.pathExists(reportPath)) {
    console.log(chalk.red(`\n  Report not found: ${reportPath}\n`));
    process.exit(1);
  }

  console.log(chalk.green(`\n  Opening report: ${reportPath}\n`));
  console.log(chalk.dim(`  Session: ${latest}\n`));
  await open(reportPath);
}
