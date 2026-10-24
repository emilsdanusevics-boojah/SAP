'use strict';

// Runs the example tasks against the offline mock launchpad.
const path = require('path');
const fs = require('fs');
const { start } = require('./mock-server');
const { loadTasks, validate, runAll } = require('../src/runner');
const { getConfig } = require('../src/config');

(async () => {
  const server = await start();
  const out = path.join(__dirname, '..', 'results', 'selftest');
  fs.rmSync(out, { recursive: true, force: true });
  Object.assign(process.env, {
    SAP_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    SAP_USER: 'tester',
    SAP_PASSWORD: 'secret',
    SAP_TIMEOUT: '8000',
    SAP_AUTH_FILE: path.join(out, 'state.json'),
  });
  const tasks = loadTasks([path.join(__dirname, '..', 'tasks')]);
  const problems = validate(tasks);
  if (problems.length) throw new Error(problems.join('\n'));
  const code = await runAll(tasks, getConfig({ out }), {});
  server.close();
  process.exit(code);
})();
