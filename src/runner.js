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
const { State } = require('./state');

const STEP_META = new Set(['name', 'optional', 'timeout', 'when', 'unless']);
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
  const walk = (p) => {
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p).sort()) walk(path.join(p, f));
    } else if (/\.ya?ml$/i.test(p)) files.push(p);
  };
  for (const input of inputs) {
    const p = path.resolve(input);
    if (!fs.existsSync(p)) throw new Error(`No such file or directory: ${input}`);
    walk(p);
  }
  return files;
}

// A file holds one task, or `tasks: [...]` for several. Tasks run in exercise order.
// Tasks marked `skip: <reason>` only run when --grep names them.
function loadTasks(inputs, grep) {
  const tasks = [];
  for (const file of listTaskFiles(inputs)) {
    const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(doc?.tasks) ? doc.tasks : [doc];
    list.forEach((t, i) => tasks.push({ id: t.id || `${path.basename(file, path.extname(file))}-${i + 1}`, file, ...t }));
  }
  tasks.sort((a, b) => (a.exercise ?? 1e9) - (b.exercise ?? 1e9));
  if (!grep) return tasks.filter((t) => !t.skip);
  const re = new RegExp(grep, 'i');
  return tasks.filter(
    (t) => re.test(t.id) || re.test(t.title || '') || re.test(String(t.exercise ?? '')) || (t.tags || []).some((g) => re.test(g))
  );
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

const BUILTIN_VARS = new Set(['grp', 'user', 'userId', 'today', 'date', 'day', 'on', 'monthStart', 'monthEnd', 'yearStart', 'yearEnd', 'year', 'month', 'num', 'rand', 'timestamp']);

// Variables a task reads that nothing defines or captures before it (in exercise order).
// Warnings only: --var or values saved by an earlier run can still supply them.
function unresolvedVars(tasks, alreadyKnown = []) {
  const known = new Set(alreadyKnown);
  const warnings = [];
  const produced = (step) => {
    const { action, arg } = stepAction(step);
    if (action === 'capture' && arg?.var) return [arg.var];
    if (action === 'expectMessage' && arg?.capture?.var) return [arg.capture.var];
    if (action === 'set' && arg && typeof arg === 'object') return Object.keys(arg);
    if (action === 'detect' && arg?.var) return [arg.var];
    return [];
  };
  for (const t of tasks) {
    Object.keys(t.vars || {}).forEach((v) => known.add(v));
    const missing = new Set();
    for (const step of t.steps || []) {
      // A variable in when/unless may legitimately be unset (it counts as empty).
      const { when, unless, ...checked } = typeof step === 'object' ? step : {};
      for (const m of JSON.stringify(typeof step === 'object' ? checked : step).matchAll(/\$\{([\w.]+)/g)) {
        const name = m[1];
        if (!BUILTIN_VARS.has(name) && !name.startsWith('env.') && !known.has(name)) missing.add(name);
      }
      produced(step).forEach((v) => known.add(v));
    }
    if (missing.size) warnings.push(`${t.id}: uses ${[...missing].map((v) => `\${${v}}`).join(', ')} not captured by an earlier task`);
  }
  return warnings;
}

function describe(action, arg) {
  if (arg === true || arg === undefined) return action;
  const text = typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
  return `${action} ${text.length > 90 ? `${text.slice(0, 87)}...` : text}`;
}

function skippedSteps(task, from) {
  return task.steps.slice(from).map((s, i) => {
    const { action, arg } = stepAction(s);
    return { index: from + i + 1, action, name: s.name || describe(action, arg), status: 'skipped' };
  });
}

async function leaveGui(page, cfg) {
  const inGui = page.frames().some((f) => /\/sap\/bc\/gui\//.test(f.url()));
  if (!inGui) return;
  // In-app navigation lets the launchpad exit the GUI app (it ends the GUI session).
  await page.evaluate(() => { window.location.hash = '#Shell-home'; }).catch(() => {});
  await page.waitForTimeout(5000);
}

const truthy = (v) => !['', '0', 'false', 'no'].includes(String(v ?? '').trim().toLowerCase());

// A variable nothing has set yet counts as empty in a condition.
function conditionValue(expr, vars, cfg) {
  try {
    return interpolate(expr, vars, cfg);
  } catch (err) {
    if (/Unknown variable/.test(err.message)) return '';
    throw err;
  }
}

function conditionSkip(meta, vars, cfg) {
  if ('when' in meta && !truthy(conditionValue(meta.when, vars, cfg))) return `when ${meta.when} not met`;
  if ('unless' in meta && truthy(conditionValue(meta.unless, vars, cfg))) return `unless ${meta.unless} met`;
  return null;
}

async function runTask(task, page, cfg, shared) {
  const result = {
    id: task.id,
    exercise: task.exercise,
    title: task.title || task.id,
    file: task.file,
    status: 'passed',
    steps: [],
    startedAt: Date.now(),
  };
  const { vars, state } = shared;
  const ctx = {
    page,
    cfg,
    vars,
    log,
    state,
    task,
    outDir: cfg.outDir,
    since: Date.now(),
    saveVars: () => state.saveVars(vars),
  };

  log.info(`\n▶ ${task.exercise ? `Exercise ${task.exercise} ` : ''}[${task.id}] ${result.title}`);

  const blocked = (task.requires || []).filter((id) => shared.failed.has(id));
  if (blocked.length) {
    result.status = 'skipped';
    result.error = `Prerequisite failed in this run: ${blocked.join(', ')}`;
    result.steps = skippedSteps(task, 0);
    log.warn(`  skipped - ${result.error}`);
    return result;
  }

  try {
    Object.assign(vars, task.vars ? interpolate(task.vars, vars, cfg) : {});
    // Start every task from the launchpad unless it opts out (to continue where the last one ended).
    if (task.startFromHome !== false) await actions.home({ ...ctx, stepTimeout: cfg.timeout });
  } catch (err) {
    result.status = 'failed';
    result.error = `Setup: ${err.message.split('\n')[0]}`;
    result.steps = skippedSteps(task, 0);
    log.fail(`  ✘ ${result.error}`);
    return result;
  }

  for (let i = 0; i < task.steps.length; i++) {
    const raw = task.steps[i];
    const { action, arg: rawArg } = stepAction(raw);
    const meta = typeof raw === 'object' ? raw : {};
    const step = { index: i + 1, action, status: 'passed', startedAt: Date.now() };
    // when: "${x}" runs the step only if x is set; unless: "${x}" only if it is not.
    const skipReason = conditionSkip(meta, vars, cfg);
    if (skipReason) {
      Object.assign(step, { name: meta.name || describe(action, rawArg), status: 'skipped', error: skipReason, duration: 0 });
      result.steps.push(step);
      log.info(`  – ${step.index}. ${step.name} (skipped: ${skipReason})`);
      continue;
    }
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
      step.status = err.manual ? 'manual' : meta.optional ? 'warned' : 'failed';
      if (step.status !== 'manual') {
        const shot = path.join(cfg.outDir, `${task.id}-step${step.index}-failure.png`);
        await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
        step.screenshot = shot;
      }
      const mark = { manual: '✋', warned: '⚠', failed: '✘' }[step.status];
      (step.status === 'failed' ? log.fail : log.warn)(`  ${mark} ${step.index}. ${step.name}\n      ${step.error}`);
      if (step.status === 'failed' && cfg.pauseOnFail && !cfg.headless) {
        log.warn('      Paused: inspect the page in the Playwright inspector, then press Resume.');
        await page.pause();
      }
    }
    step.duration = Date.now() - step.startedAt;
    result.steps.push(step);
    if (step.status === 'failed') {
      result.status = 'failed';
      result.error = `Step ${step.index} (${step.name}): ${step.error}`;
      result.steps.push(...skippedSteps(task, i + 1));
      break;
    }
  }
  if (result.status === 'passed' && result.steps.some((s) => s.status === 'manual')) result.status = 'partial';
  result.duration = Date.now() - result.startedAt;
  return result;
}

async function runAll(tasks, cfg, cliVars) {
  fs.mkdirSync(cfg.outDir, { recursive: true });
  const state = new State(cfg);
  // Saved values from earlier runs, overridden by --var.
  const shared = { state, vars: { ...state.vars, ...cliVars }, failed: new Set() };

  const browser = await chromium.launch({ headless: cfg.headless, slowMo: cfg.slowMo, executablePath: cfg.chromiumPath });
  const context = await browser.newContext({
    storageState: fs.existsSync(cfg.authFile) ? cfg.authFile : undefined,
    viewport: { width: 1600, height: 900 },
    locale: 'en-US',
    acceptDownloads: true,
  });
  await context.addInitScript(messageRecorderScript, MESSAGE_SELECTORS);
  context.setDefaultTimeout(cfg.timeout);
  if (cfg.trace) await context.tracing.start({ screenshots: true, snapshots: true });

  const page = await context.newPage();
  const run = { startedAt: Date.now(), baseUrl: cfg.baseUrl, user: cfg.user, group: cfg.group, tasks: [] };
  try {
    await ensureLoggedIn(page, cfg, log);
    await settle(page, cfg.timeout);
    // ${userId}: the technical user ID (e.g. CB9980011258) that "Created By" filters expect.
    if (!shared.vars.userId) {
      const id = await page.evaluate(() => window.sap?.ushell?.Container?.getUser?.()?.getId?.()).catch(() => null);
      if (id) shared.vars.userId = id;
    }
    for (const task of tasks) {
      if (cfg.trace) await context.tracing.startChunk({ title: task.id });
      const res = await runTask(task, page, cfg, shared);
      await leaveGui(page, cfg);
      if (cfg.trace) {
        res.trace = path.join(cfg.outDir, `${task.id}-trace.zip`);
        await context.tracing.stopChunk({ path: res.trace });
      }
      if (res.status === 'failed' || res.status === 'skipped') shared.failed.add(task.id);
      run.tasks.push(res);
      const paint = { passed: log.pass, partial: log.warn, skipped: log.warn }[res.status] || log.fail;
      paint(`  ${res.status.toUpperCase()}${res.duration ? ` in ${(res.duration / 1000).toFixed(1)}s` : ''}`);
      state.saveVars(shared.vars);
    }
  } catch (err) {
    run.fatal = err.message;
    log.fail(`\nRun aborted: ${err.message}`);
    await page.screenshot({ path: path.join(cfg.outDir, 'fatal.png'), fullPage: true }).catch(() => {});
  } finally {
    // Leave classic GUI transactions through the launchpad so their sessions are closed (and their
    // locks released); closing the browser while one is open leaves an orphaned, locking session.
    await leaveGui(page, cfg);
    if (cfg.trace) await context.tracing.stop().catch(() => {});
    await browser.close();
  }
  run.finishedAt = Date.now();
  run.vars = shared.vars;
  const files = writeReports(run, cfg.outDir);

  const count = (s) => run.tasks.filter((t) => t.status === s).length;
  log.info(
    `\n${count('passed')} passed, ${count('partial')} partial (manual steps), ${count('failed')} failed, ` +
      `${count('skipped')} skipped of ${tasks.length}. Reports: ${files.join(', ')}`
  );
  return run.fatal || count('failed') || count('skipped') ? 1 : 0;
}

module.exports = { loadTasks, validate, unresolvedVars, runAll };
