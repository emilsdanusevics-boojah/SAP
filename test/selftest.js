'use strict';

// Runs the example tasks against the offline mock launchpad.
const path = require('path');
const fs = require('fs');
const { start, getRoles } = require('./mock-server');
const { loadTasks, validate, runAll } = require('../src/runner');
const { getConfig } = require('../src/config');

const check = (cond, msg) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) process.exitCode = 1;
};

(async () => {
  const server = await start();
  const out = path.join(__dirname, '..', 'results', 'selftest');
  fs.rmSync(out, { recursive: true, force: true });
  Object.assign(process.env, {
    SAP_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    SAP_USER: 'F000035',
    SAP_PASSWORD: 'secret',
    SAP_TIMEOUT: '8000',
    SAP_STATE_DIR: path.join(out, 'state'),
  });
  const cfg = getConfig({ out });
  const results = () => JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));

  // 1. Sample tasks: GUI iframe, toasts, captures carried across tasks.
  const sample = loadTasks([path.join(__dirname, 'tasks')]);
  if (validate(sample).length) throw new Error(validate(sample).join('\n'));
  check((await runAll(sample, cfg, {})) === 0, 'sample sales-order tasks pass');

  // 2. Course features: role assignment, sections, rows, state, prerequisites.
  const course = loadTasks([path.join(__dirname, 'course-tasks')]);
  if (validate(course).length) throw new Error(validate(course).join('\n'));
  await runAll(course, cfg, {});
  const st = Object.fromEntries(results().tasks.map((t) => [t.id, t.status]));
  check(st['T-ROLES-1'] === 'passed' && st['T-ROLES-2'] === 'passed', 'role tasks pass');
  check(JSON.stringify(getRoles()) === JSON.stringify(['Z_S4C_GENERIC_ROLE', 'BR_PURCHASER']), `roles now ${getRoles().join(', ')}`);
  check(st['T-PLAY'] === 'partial', 'playground passes with one manual step (partial)');
  check(st['T-FAIL'] === 'failed' && st['T-BLOCKED'] === 'skipped', 'failed prerequisite skips the dependent task');
  const apps = JSON.parse(fs.readFileSync(path.join(out, 'state', 'apps.json'), 'utf8'));
  check(apps.Playground === 'Test-playground', 'app hash found by search is cached');

  // 3. A later run picks up the value captured in step 2.
  await runAll(loadTasks([path.join(__dirname, 'course-tasks')], 'T-NEXT-RUN'), cfg, {});
  check(results().vars.checked === '4711', 'captured value survives into the next run');

  server.close();
})();
