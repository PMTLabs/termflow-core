#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from './commands/init.js';

const program = new Command();

program
  .name('tk')
  .description('Terminal Kit - Initialize multi-team agent workflow assets')
  .version('1.0.0');

program
  .command('init')
  .description('Initialize multi-team agent workflow assets in the current directory')
  .option('-f, --force', 'Overwrite existing files without prompting')
  .option('--no-docs', 'Skip documentation files')
  .option('--api-url <url>', 'Set custom API URL', 'http://localhost:42031')
  .action(initCommand);

program.parse();
