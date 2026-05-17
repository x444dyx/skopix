import chalk from 'chalk';

export function formatStep(step, current, total) {
  const statusIcon = step.success ? chalk.green('✓') : chalk.red('✗');
  const confBar = confidenceBar(step.confidence);
  const actionLabel = chalk.cyan.bold(step.action.padEnd(14));

  if (step.action === 'BATCH' && step.batchResults) {
    const batchInfo = chalk.magenta(`[${step.batchResults.length} actions]`);
    console.log(
      `  ${chalk.dim(`[${current}/${total}]`)} ${statusIcon} ${actionLabel} ${batchInfo}`
    );
    step.batchResults.forEach((r, i) => {
      const subIcon = r.success ? chalk.green('✓') : chalk.red('✗');
      console.log(
        `        ${chalk.dim(`${i + 1}.`)} ${subIcon} ${chalk.cyan(r.action.padEnd(8))} ${chalk.dim('→')} ${chalk.white(truncate(r.target || '—', 50))}`
      );
    });
  } else {
    console.log(
      `  ${chalk.dim(`[${current}/${total}]`)} ${statusIcon} ${actionLabel} ${chalk.dim('→')} ${chalk.white(truncate(step.target || step.value || '—', 45))}`
    );
  }

  if (step.reasoning) {
    console.log(`  ${chalk.dim('     reasoning:')} ${chalk.dim(truncate(step.reasoning, 70))}`);
  }

  if (step.observation) {
    console.log(`  ${chalk.dim('  observation:')} ${chalk.white(truncate(step.observation, 70))}`);
  }

  if (step.confidence !== undefined) {
    console.log(`  ${chalk.dim('   confidence:')} ${confBar} ${chalk.dim(step.confidence + '/10')}`);
  }

  if (step.issues && step.issues.length > 0) {
    for (const issue of step.issues) {
      const severity = (issue.severity || 'low').toLowerCase();
      const sev = severityColor(severity);
      console.log(`  ${chalk.dim('         issue:')} ${sev(`[${severity.toUpperCase()}]`)} ${chalk.yellow(issue.title || '(no title)')}`);
    }
  }

  if (step.error) {
    console.log(`  ${chalk.dim('         error:')} ${chalk.red(step.error)}`);
  }

  console.log();
}

export function formatIssue(issue, index) {
  const sev = severityColor(issue.severity);
  console.log(`  ${chalk.dim(`${index + 1}.`)} ${sev(`[${issue.severity.toUpperCase()}]`)} ${chalk.white.bold(issue.title)}`);
  console.log(`     ${chalk.dim(issue.description)}`);
  console.log(`     ${chalk.dim('URL:')} ${chalk.cyan(issue.url)}`);
  console.log();
}

export function printSummary({ sessionId, steps, issues, goalAchieved, stuck, duration, reportPath, videoPath, failReason }) {
  const durationStr = formatDuration(duration);
  const status = goalAchieved
    ? chalk.green.bold('PASSED ✓')
    : stuck
    ? chalk.yellow.bold('STUCK ⚠')
    : chalk.red.bold('FAILED ✗');

  console.log();
  console.log(chalk.cyan('━'.repeat(60)));
  console.log(chalk.white.bold('  SESSION SUMMARY'));
  console.log(chalk.cyan('━'.repeat(60)));
  console.log(`  Status:    ${status}`);
  if (failReason) {
    console.log(`  Reason:    ${chalk.dim(failReason)}`);
  }
  console.log(`  Session:   ${chalk.dim(sessionId)}`);
  console.log(`  Steps:     ${chalk.white(steps)}`);
  console.log(`  Issues:    ${issues > 0 ? chalk.red(issues) : chalk.green(issues)}`);
  console.log(`  Duration:  ${chalk.white(durationStr)}`);

  if (reportPath) {
    console.log(`  Report:    ${chalk.cyan(reportPath)}`);
  }
  if (videoPath) {
    console.log(`  Video:     ${chalk.cyan(videoPath)}`);
  }

  console.log(chalk.cyan('━'.repeat(60)));
  console.log();

  if (issues > 0) {
    console.log(chalk.yellow(`  ⚠ ${issues} issue(s) detected. Check the report for details.`));
  }

  if (reportPath) {
    console.log(chalk.dim(`\n  Run 'skopix report' to open the latest report in your browser.\n`));
  }
}

function confidenceBar(confidence = 0) {
  const filled = Math.round(confidence / 2);
  const empty = 5 - filled;
  const bar = chalk.green('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
  return bar;
}

function severityColor(severity) {
  switch ((severity || '').toLowerCase()) {
    case 'critical': return chalk.red.bold;
    case 'high': return chalk.red;
    case 'medium': return chalk.yellow;
    case 'low': return chalk.blue;
    default: return chalk.white;
  }
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
