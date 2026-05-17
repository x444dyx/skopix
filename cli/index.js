#!/usr/bin/env node
import { program } from 'commander';
import chalk from 'chalk';
import boxen from 'boxen';
import { runCommand } from './commands/run.js';
import { initCommand } from './commands/init.js';
import { reportCommand } from './commands/report.js';
import { configCommand } from './commands/config.js';
import { dashboardCommand } from './commands/dashboard.js';

const banner = chalk.cyan(`
  ███████╗██╗  ██╗ ██████╗ ██████╗ ██╗██╗  ██╗
  ██╔════╝██║ ██╔╝██╔═══██╗██╔══██╗██║╚██╗██╔╝
  ███████╗█████╔╝ ██║   ██║██████╔╝██║ ╚███╔╝ 
  ╚════██║██╔═██╗ ██║   ██║██╔═══╝ ██║ ██╔██╗ 
  ███████║██║  ██╗╚██████╔╝██║     ██║██╔╝ ██╗
  ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═╝
`);

console.log(banner);
console.log(chalk.dim('  AI-powered QA agent. Tests your app like a human would.\n'));

program
  .name('skopix')
  .description('AI-powered QA testing agent')
  .version('1.0.0');

program
  .command('run')
  .description('Run a QA test session on a URL')
  .requiredOption('-u, --url <url>', 'Target URL to test')
  .requiredOption('-g, --goal <goal>', 'Testing goal (e.g. "complete the checkout flow")')
  .option('-c, --credentials <file>', 'Path to credentials YAML file')
  .option('-o, --output <dir>', 'Output directory for reports', './skopix-reports')
  .option('-m, --max-steps <number>', 'Maximum steps the agent will take', '20')
  .option('--headless', 'Run browser in headless mode', false)
  .option('--no-video', 'Disable video recording')
  .option('--provider <provider>', 'LLM provider: gemini | ollama', 'gemini')
  .option('--model <model>', 'Model name override')
  .option('--jira', 'Push issues to Jira (requires JIRA_* env vars)')
  .option('--linear', 'Push issues to Linear (requires LINEAR_API_KEY env var)')
  .option('--github', 'Push issues to GitHub Issues (requires GITHUB_* env vars)')
  .option('--test-name <name>', 'Name of the test (for context in created issues)')
  .option('--suite-name <name>', 'Name of the suite this test belongs to (for context)')
  .action(runCommand);

program
  .command('init')
  .description('Initialise Skopix config in the current directory')
  .action(initCommand);

program
  .command('report')
  .description('Open the latest report in your browser')
  .option('-d, --dir <dir>', 'Reports directory', './skopix-reports')
  .action(reportCommand);

program
  .command('config')
  .description('View or set configuration values')
  .option('--set <key=value>', 'Set a config value')
  .option('--get <key>', 'Get a config value')
  .option('--list', 'List all config values')
  .action(configCommand);

program
  .command('dashboard')
  .description('Launch the web dashboard')
  .option('-p, --port <port>', 'Port to run the server on', '9000')
  .option('-d, --dir <dir>', 'Reports directory', './skopix-reports')
  .option('-h, --host <host>', 'Host to bind to (default 127.0.0.1; use 0.0.0.0 for team mode)')
  .option('--team', 'Enable multi-user team mode (requires SQLite)')
  .option('--no-open', 'Do not auto-open the browser')
  .action(dashboardCommand);

program.parse();
