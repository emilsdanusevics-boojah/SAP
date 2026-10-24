#!/usr/bin/env node
'use strict';

const { getConfig } = require('./src/config');
const { loadTasks, validate, unresolvedVars, runAll } = require('./src/runner');
const { State } = require('./src/state');

const USAGE = `Usage: node run.js [task files or folders...] [options]

Selecting
  --grep <regex>      only tasks whose id, title, exercise number or tag matches
                      (e.g. --grep "^IEE2E-0(3|4)$", --grep unit6, --grep fi-ap)
  --list              list the selected tasks and exit
  --validate          check task files only, no browser

Running
  --headed            show the browser
  --slowmo <ms>       slow every browser action down (good for watching)
  --interactive       wait for you at "manual" steps instead of skipping them
  --pause-on-fail     open the Playwright inspector when a step fails (with --headed)
  --trace             save a Playwright trace per task (npx playwright show-trace)
  --manual-login      log in yourself in the browser window (MFA), then tests continue
  --var key=value     set a variable usable as \${key} (repeatable)
  --out <dir>         output folder (default: results)

State (values carried between exercises and runs, in .state/)
  --show-state        print saved values (sales order, PO, asset numbers...) and exit
  --reset-state       forget saved values and cached app links, then continue
  --help`;

function parseArgs(argv) {
  const opts = { paths: [], vars: {} };
  const flags = {
    '--headed': 'headed',
    '--trace': 'trace',
    '--validate': 'validate',
    '--list': 'list',
    '--manual-login': 'manualLogin',
    '--interactive': 'interactive',
    '--pause-on-fail': 'pauseOnFail',
    '--show-state': 'showState',
    '--reset-state': 'resetState',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (flags[a]) opts[flags[a]] = true;
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
  const cfg = getConfig(opts);

  if (opts.resetState) {
    State.reset(cfg);
    console.log('Saved state cleared.');
  }
  if (opts.showState) {
    const s = new State(cfg);
    console.log(`Group: ${cfg.group || '(not set)'}\nSaved values:`);
    for (const [k, v] of Object.entries(s.vars)) console.log(`  ${k} = ${v}`);
    return;
  }

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
    const saved = Object.keys(new State(cfg).vars).concat(Object.keys(opts.vars));
    for (const w of unresolvedVars(tasks, saved)) console.warn(`warning: ${w}`);
  }
  if (opts.validate || opts.list) {
    const line = (t) => `  ${String(t.exercise ?? '').padStart(2)}  ${t.id.padEnd(10)} ${t.title || ''}  (${t.steps.length} steps)`;
    console.log(`${tasks.length} task(s)${opts.validate ? ' OK' : ''}:\n${tasks.map(line).join('\n')}`);
    return;
  }
  process.exitCode = await runAll(tasks, cfg, opts.vars);
})().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
