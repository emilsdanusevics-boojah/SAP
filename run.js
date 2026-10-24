#!/usr/bin/env node
'use strict';

const { getConfig } = require('./src/config');
const { loadTasks, validate, runAll } = require('./src/runner');

const USAGE = `Usage: node run.js [task files or folders...] [options]

Options:
  --headed            show the browser
  --slowmo <ms>       slow every browser action down (good for watching)
  --grep <regex>      run only tasks whose id, title or tag matches
  --var key=value     set a variable usable as \${key} (repeatable)
  --trace             save a Playwright trace per task (npx playwright show-trace)
  --manual-login      log in yourself in the browser window (MFA), then tests continue
  --out <dir>         output folder (default: results)
  --validate          check task files only, no browser
  --help`;

function parseArgs(argv) {
  const opts = { paths: [], vars: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--headed') opts.headed = true;
    else if (a === '--trace') opts.trace = true;
    else if (a === '--validate') opts.validate = true;
    else if (a === '--manual-login') opts.manualLogin = true;
    else if (a === '--slowmo') opts.slowmo = next();
    else if (a === '--grep') opts.grep = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--var') {
      const [k, ...v] = next().split('=');
      opts.vars[k] = v.join('=');
    } else if (a.startsWith('--')) throw new Error(`Unknown option ${a}\n\n${USAGE}`);
    else opts.paths.push(a);
  }
  if (!opts.paths.length) opts.paths.push('tasks');
  return opts;
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return console.log(USAGE);

  const tasks = loadTasks(opts.paths, opts.grep);
  const problems = validate(tasks);
  if (problems.length) {
    console.error(`Task file problems:\n  ${problems.join('\n  ')}`);
    process.exit(2);
  }
  if (!tasks.length) {
    console.error('No tasks matched.');
    process.exit(2);
  }
  if (opts.validate) {
    console.log(`${tasks.length} task(s) OK:\n${tasks.map((t) => `  ${t.id}  ${t.title || ''}  (${t.steps.length} steps)`).join('\n')}`);
    return;
  }
  process.exitCode = await runAll(tasks, getConfig(opts), opts.vars);
})().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
