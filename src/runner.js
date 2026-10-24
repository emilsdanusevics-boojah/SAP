'use strict';

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { chromium } = require('playwright');
const { actions } = require('./actions');
const { interpolate } = require('./vars');
const { ensureLoggedIn } = require('./login');
const { messageRecorderScript, MESSAGE_SELECTORS, settle } = require('./ui5');
const { writeReports } = require('./report');

const STEP_META = new Set(['name', 'optional', 'timeout']);
// Steps that inspect the result of the previous action keep its message window.
const INSPECTING = new Set(['expectMessage', 'expectText', 'expectField', 'expectNoError', 'capture', 'screenshot', 'log', 'set']);

const color = (c, s) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);
const log = {
  info: (m) => console.log(m),
  pass: (m) => console.log(color(32, m)),
  fail: (m) => console.log(color(31, m)),
  warn: (m) => console.log(color(33, m)),
};

function listTaskFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    const p = path.resolve(input);
    if (!fs.existsSync(p)) throw new Error(`No such file or directory: ${input}`);
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p).sort()) if (/\.ya?ml$/i.test(f)) files.push(path.join(p, f));
    } else files.push(p);
  }
  return files;
}

// A file holds one task, or `tasks: [...]` for several.
function loadTasks(inputs, grep) {
  const tasks = [];
  for (const file of listTaskFiles(inputs)) {
    const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(doc?.tasks) ? doc.tasks : [doc];
    list.forEach((t, i) => tasks.push({ id: t.id || `${path.basename(file, path.extname(file))}-${i + 1}`, file, ...t }));
  }
  if (!grep) return tasks;
  const re = new RegExp(grep, 'i');
  return tasks.filter((t) => re.test(t.id) || re.test(t.title || '') || (t.tags || []).some((g) => re.test(g)));
}

function stepAction(step) {
  if (typeof step === 'string') return { action: step, arg: true };
  const keys = Object.keys(step || {}).filter((k) => !STEP_META.has(k));
  if (keys.length !== 1) return { error: `step must have exactly one action, found: ${keys.join(', ') || 'none'}` };
  return { action: keys[0], arg: step[keys[0]] };
}

function validate(tasks) {
  const problems = [];
  const ids = new Set();
  for (const t of tasks) {
    const where = `${path.basename(t.file)} [${t.id}]`;
    if (ids.has(t.id)) problems.push(`${where}: duplicate task id`);
    ids.add(t.id);
    if (!Array.isArray(t.steps) || !t.steps.length) problems.push(`${where}: no steps`);
    (t.steps || []).forEach((s, i) => {
      const { action, error } = stepAction(s);
      if (error) problems.push(`${where} step ${i + 1}: ${error}`);
      else if (!actions[action]) problems.push(`${where} step ${i + 1}: unknown action "${action}"`);
    });
  }
  return problems;
}

function describe(action, arg) {
  if (arg === true || arg === undefined) return action;
  const text = typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
  return `${action} ${text.length > 90 ? `${text.slice(0, 87)}...` : text}`;
}

async function runTask(task, page, cfg, sharedVars) {
  const result = { id: task.id, title: task.title || task.id, file: task.file, status: 'passed', steps: [], startedAt: Date.now() };
  const vars = Object.assign(sharedVars, task.vars ? interpolate(task.vars, sharedVars, cfg) : {});
  const ctx = { page, cfg, vars, log, task, outDir: cfg.outDir, since: Date.now() };

  log.info(`\n▶ ${task.id}: ${result.title}`);
  if (task.description) log.info(`  ${String(task.description).trim().split('\n').join('\n  ')}`);

  // Start every task from the launchpad unless it opts out (to continue where the last one ended).
  if (task.startFromHome !== false) await actions.home({ ...ctx, stepTimeout: cfg.timeout });

  for (let i = 0; i < task.steps.length; i++) {
    const raw = task.steps[i];
    const { action, arg: rawArg } = stepAction(raw);
    const meta = typeof raw === 'object' ? raw : {};
    const step = { index: i + 1, action, status: 'passed', startedAt: Date.now() };
    try {
      const arg = interpolate(rawArg, vars, cfg);
      step.name = meta.name || describe(action, arg);
      ctx.stepTimeout = Number(meta.timeout || cfg.timeout);
      if (!INSPECTING.has(action)) ctx.since = Date.now();
      const extra = await actions[action](ctx, arg);
      if (extra) Object.assign(step, extra);
      log.pass(`  ✔ ${step.index}. ${step.name}`);
    } catch (err) {
      step.name = step.name || meta.name || describe(action, rawArg);
      step.error = err.message.split('\n')[0];
      step.status = meta.optional ? 'warned' : 'failed';
      const shot = path.join(cfg.outDir, `${task.id}-step${step.index}-failure.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      step.screenshot = shot;
      (meta.optional ? log.warn : log.fail)(`  ${meta.optional ? '⚠' : '✘'} ${step.index}. ${step.name}\n      ${step.error}`);
    }
    step.duration = Date.now() - step.startedAt;
    result.steps.push(step);
    if (step.status === 'failed') {
      result.status = 'failed';
      result.error = `Step ${step.index} (${step.name}): ${step.error}`;
      break;
    }
  }
  // Mark the steps that never ran so the report shows the whole task.
  for (let i = result.steps.length; i < task.steps.length; i++) {
    const { action } = stepAction(task.steps[i]);
    result.steps.push({ index: i + 1, action, name: task.steps[i].name || describe(action, stepAction(task.steps[i]).arg), status: 'skipped' });
  }
  result.duration = Date.now() - result.startedAt;
  return result;
}

async function runAll(tasks, cfg, cliVars) {
  fs.mkdirSync(cfg.outDir, { recursive: true });
  const browser = await chromium.launch({ headless: cfg.headless, slowMo: cfg.slowMo, executablePath: cfg.chromiumPath });
  const context = await browser.newContext({
    storageState: fs.existsSync(cfg.authFile) ? cfg.authFile : undefined,
    viewport: { width: 1600, height: 900 },
    locale: 'en-US',
  });
  await context.addInitScript(messageRecorderScript, MESSAGE_SELECTORS);
  context.setDefaultTimeout(cfg.timeout);
  if (cfg.trace) await context.tracing.start({ screenshots: true, snapshots: true });

  const page = await context.newPage();
  const run = { startedAt: Date.now(), baseUrl: cfg.baseUrl, user: cfg.user, tasks: [] };
  const sharedVars = { ...cliVars };
  try {
    await ensureLoggedIn(page, cfg, log);
    await settle(page, cfg.timeout);
    for (const task of tasks) {
      if (cfg.trace) await context.tracing.startChunk({ title: task.id });
      const res = await runTask(task, page, cfg, sharedVars);
      if (cfg.trace) {
        res.trace = path.join(cfg.outDir, `${task.id}-trace.zip`);
        await context.tracing.stopChunk({ path: res.trace });
      }
      run.tasks.push(res);
      (res.status === 'passed' ? log.pass : log.fail)(`  ${res.status.toUpperCase()} in ${(res.duration / 1000).toFixed(1)}s`);
    }
  } catch (err) {
    run.fatal = err.message;
    log.fail(`\nRun aborted: ${err.message}`);
    await page.screenshot({ path: path.join(cfg.outDir, 'fatal.png'), fullPage: true }).catch(() => {});
  } finally {
    if (cfg.trace) await context.tracing.stop().catch(() => {});
    await browser.close();
  }
  run.finishedAt = Date.now();
  run.vars = sharedVars;
  const files = writeReports(run, cfg.outDir);

  const passed = run.tasks.filter((t) => t.status === 'passed').length;
  log.info(`\n${passed}/${tasks.length} tasks passed. Reports: ${files.join(', ')}`);
  return run.fatal || passed !== tasks.length ? 1 : 0;
}

module.exports = { loadTasks, validate, runAll };
