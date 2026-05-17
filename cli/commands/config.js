import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import dotenv from 'dotenv';

const ENV_FILE = '.skopix.env';

export async function configCommand(options) {
  const envPath = path.resolve(process.cwd(), ENV_FILE);

  if (options.list) {
    if (!await fs.pathExists(envPath)) {
      console.log(chalk.yellow('\n  No config found. Run `skopix init` first.\n'));
      return;
    }
    const config = dotenv.parse(await fs.readFile(envPath));
    console.log(chalk.cyan.bold('\n  Skopix Configuration\n'));
    for (const [key, value] of Object.entries(config)) {
      const masked = key.includes('KEY') || key.includes('TOKEN') || key.includes('PASSWORD')
        ? value.slice(0, 4) + '****'
        : value;
      console.log(`  ${chalk.white(key)} = ${chalk.yellow(masked)}`);
    }
    console.log();
    return;
  }

  if (options.set) {
    const [key, ...rest] = options.set.split('=');
    const value = rest.join('=');
    if (!key || !value) {
      console.log(chalk.red('\n  Usage: skopix config --set KEY=value\n'));
      return;
    }

    let existing = {};
    if (await fs.pathExists(envPath)) {
      existing = dotenv.parse(await fs.readFile(envPath));
    }
    existing[key.trim()] = value.trim();

    const lines = ['# Skopix Configuration', ''];
    for (const [k, v] of Object.entries(existing)) {
      lines.push(`${k}=${v}`);
    }
    await fs.writeFile(envPath, lines.join('\n') + '\n');
    console.log(chalk.green(`\n  ✓ Set ${key} in ${ENV_FILE}\n`));
    return;
  }

  if (options.get) {
    if (!await fs.pathExists(envPath)) {
      console.log(chalk.yellow('\n  No config found.\n'));
      return;
    }
    const config = dotenv.parse(await fs.readFile(envPath));
    const value = config[options.get];
    if (value === undefined) {
      console.log(chalk.yellow(`\n  Key not found: ${options.get}\n`));
    } else {
      console.log(chalk.green(`\n  ${options.get} = ${value}\n`));
    }
    return;
  }

  console.log(chalk.dim('\n  Use --list, --set, or --get. See skopix config --help\n'));
}
