'use strict';

const path = require('path');
const { locate, fieldBuilders, clickBuilders, settle, collectMessages, appFrame } = require('./ui5');
const { homeUrl, SHELL } = require('./login');

// Each action receives (ctx, arg) where arg is the already-interpolated value
// from the YAML step. ctx = { page, cfg, vars, log, stepTimeout, since, outDir, task }.

const asObj = (arg, key) => (typeof arg === 'object' && arg !== null ? arg : { [key]: arg });

async function findField(ctx, { label, selector, frame }) {
  const builders = selector ? [(s) => s.locator(selector)] : fieldBuilders(label);
  let loc = await locate(ctx.page, builders, { timeout: ctx.stepTimeout, what: `field "${label || selector}"`, frame });
  // getByLabel can land on a UI5 wrapper div; drill down to the real input.
  const tag = await loc.evaluate((e) => e.tagName.toLowerCase()).catch(() => '');
  if (!['input', 'textarea', 'select'].includes(tag)) {
    const inner = loc.locator('input:not([type="hidden"]), textarea').first();
    if ((await inner.count()) > 0) loc = inner;
  }
  return loc;
}

async function fillOne(ctx, { label, selector, value, enter, type, frame }) {
  const field = await findField(ctx, { label, selector, frame });
  await field.click();
  if (type) {
    // Some WebGUI fields only react to real keystrokes.
    await field.fill('');
    await field.pressSequentially(String(value), { delay: 30 });
  } else {
    await field.fill(String(value));
  }
  // Tab fires UI5 change/validation (and WebGUI field transport); Enter submits.
  await field.press(enter ? 'Enter' : 'Tab');
  await settle(ctx.page, ctx.stepTimeout);
}

async function readFieldValue(ctx, arg) {
  const field = await findField(ctx, arg);
  return field.evaluate((e) => ('value' in e ? e.value : e.innerText) || '');
}

async function messagesText(ctx) {
  return (await collectMessages(ctx.page, ctx.since)).join(' | ');
}

async function pollUntil(ctx, fn, what) {
  const deadline = Date.now() + ctx.stepTimeout;
  let last;
  for (;;) {
    last = await fn();
    if (last.ok) return last;
    if (Date.now() > deadline) throw new Error(`${what}${last.detail ? ` - ${last.detail}` : ''}`);
    await ctx.page.waitForTimeout(300);
  }
}

function applyCapture(ctx, source, capture) {
  if (!capture) return;
  const re = new RegExp(capture.regex || '(\\d+)');
  const m = source.match(re);
  if (!m) throw new Error(`Capture "${capture.var}": /${re.source}/ did not match "${source}"`);
  ctx.vars[capture.var] = m[1] ?? m[0];
  ctx.log.info(`  captured ${capture.var} = ${ctx.vars[capture.var]}`);
}

const actions = {
  // openApp: "SalesOrder-create"                 (semantic object-action hash)
  // openApp: { hash: "SalesOrder-create", params: "SalesOrder=123" }
  // openApp: { title: "Manage Sales Orders" }    (via launchpad search)
  async openApp(ctx, arg) {
    const a = asObj(arg, 'hash');
    if (a.hash) {
      const hash = a.hash.replace(/^#/, '') + (a.params ? `?${a.params}` : '');
      await ctx.page.goto(`${ctx.cfg.baseUrl}/ui?sap-language=${ctx.cfg.language}#${hash}`, { waitUntil: 'domcontentloaded' });
    } else if (a.title) {
      await openViaSearch(ctx, a.title);
    } else {
      throw new Error('openApp needs "hash" or "title"');
    }
    await ctx.page.locator(SHELL).first().waitFor({ state: 'visible', timeout: ctx.stepTimeout });
    await settle(ctx.page, ctx.stepTimeout);
  },

  // transaction: VA03   -> classic GUI transaction inside the launchpad
  async transaction(ctx, tcode) {
    await actions.openApp(ctx, { hash: 'Shell-startGUI', params: `sap-ui2-tcode=${encodeURIComponent(tcode)}` });
  },

  async home(ctx) {
    await ctx.page.goto(homeUrl(ctx.cfg), { waitUntil: 'domcontentloaded' });
    await ctx.page.locator(SHELL).first().waitFor({ state: 'visible', timeout: ctx.stepTimeout });
    await settle(ctx.page, ctx.stepTimeout);
  },

  async back(ctx) {
    await ctx.page.goBack({ waitUntil: 'domcontentloaded' });
    await settle(ctx.page, ctx.stepTimeout);
  },

  // fill: { label: "Sold-To Party", value: "17100001" }
  // fill: { "Sold-To Party": "17100001", "Cust. Reference": "PO-${rand}" }
  // Options: selector, enter: true, type: true (keystrokes), frame: app|main
  async fill(ctx, arg) {
    if ('label' in arg || 'selector' in arg) return fillOne(ctx, arg);
    for (const [label, value] of Object.entries(arg)) await fillOne(ctx, { label, value });
  },

  // select: { label: "Order Type", value: "Standard Order" }   (sap.m.Select / ComboBox)
  async select(ctx, { label, selector, value, frame }) {
    const field = await findField(ctx, { label, selector, frame });
    const tag = await field.evaluate((e) => e.tagName.toLowerCase());
    if (tag === 'select') {
      await field.selectOption({ label: value }).catch(() => field.selectOption(value));
    } else {
      await field.click();
      const option = await locate(
        ctx.page,
        [(s) => s.getByRole('option', { name: value, exact: true }), (s) => s.getByRole('option', { name: value })],
        { timeout: 3000, what: `option "${value}"`, frame }
      ).catch(() => null);
      if (option) {
        await option.click();
      } else {
        // Editable ComboBox: type the value and confirm.
        await field.fill(value);
        await field.press('Enter');
      }
    }
    await settle(ctx.page, ctx.stepTimeout);
  },

  async check(ctx, arg) {
    const a = asObj(arg, 'label');
    const box = await locate(ctx.page, [(s) => s.getByRole('checkbox', { name: a.label }), ...fieldBuilders(a.label)], {
      timeout: ctx.stepTimeout,
      what: `checkbox "${a.label}"`,
    });
    await box.check({ force: true });
  },

  async uncheck(ctx, arg) {
    const a = asObj(arg, 'label');
    const box = await locate(ctx.page, [(s) => s.getByRole('checkbox', { name: a.label }), ...fieldBuilders(a.label)], {
      timeout: ctx.stepTimeout,
      what: `checkbox "${a.label}"`,
    });
    await box.uncheck({ force: true });
  },

  // click: Save
  // click: { text: "Go", role: button, index: 0, frame: app|main, selector: "css=..." }
  // click: { text: "Save", dialog: true }   only inside an open popup/dialog
  async click(ctx, arg) {
    const a = asObj(arg, 'text');
    const builders = a.selector ? [(s) => s.locator(a.selector)] : clickBuilders(a.text, a.role);
    const target = await locate(ctx.page, builders, {
      timeout: ctx.stepTimeout,
      what: `"${a.text || a.selector}"`,
      frame: a.frame,
      index: a.index || 0,
      dialogOnly: !!a.dialog,
    });
    await target.click(a.double ? { clickCount: 2 } : {});
    await settle(ctx.page, ctx.stepTimeout);
  },

  // fillCell: { row: 1, column: "Material", value: "TG11" }   (row is 1-based, data rows only)
  async fillCell(ctx, { row = 1, column, value, enter }) {
    const scope = (await appFrame(ctx.page)) || ctx.page.mainFrame();
    const headers = scope.locator('[role="columnheader"]:visible, th:visible');
    await headers.first().waitFor({ timeout: ctx.stepTimeout });
    const names = (await headers.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    const col = names.findIndex((n) => n === column || n.replace(/[:*]$/, '').trim() === column);
    if (col < 0) throw new Error(`Column "${column}" not found. Columns: ${names.join(', ')}`);
    const header = headers.nth(col);
    const ariaCol = await header.getAttribute('aria-colindex');
    const rows = scope.locator('[role="row"]:visible, tbody tr:visible').filter({ has: scope.locator('input, [role="gridcell"], td') });
    const r = rows.nth(row - 1);
    const cell = ariaCol ? r.locator(`[aria-colindex="${ariaCol}"]`) : r.locator('[role="gridcell"], td').nth(col);
    const input = cell.locator('input, textarea').first();
    await input.click();
    await input.fill(String(value));
    await input.press(enter ? 'Enter' : 'Tab');
    await settle(ctx.page, ctx.stepTimeout);
  },

  // press: Enter | F8 | Control+S ...      (sent to the app, even if focus left its iframe)
  // press: { key: Enter, label: "Order" }  (sent to a specific field)
  async press(ctx, arg) {
    const a = asObj(arg, 'key');
    if (a.label || a.selector) {
      await (await findField(ctx, a)).press(a.key);
    } else {
      const app = await appFrame(ctx.page);
      const focusInApp =
        app && (await app.evaluate(() => document.hasFocus() && document.activeElement !== document.body).catch(() => false));
      if (app && !focusInApp) {
        // Focus left the app iframe (e.g. Tab past its last field): return it to
        // the last field used there, like a user clicking back before pressing.
        await app.evaluate(() => {
          window.focus();
          const last = window.__sapTesterLastFocus;
          if (last && last.isConnected) last.focus();
        });
      }
      await ctx.page.keyboard.press(a.key);
    }
    await settle(ctx.page, ctx.stepTimeout);
  },

  async wait(ctx, ms) {
    await ctx.page.waitForTimeout(Number(ms));
  },

  // waitFor: "Item Overview"  |  { text, selector, state: visible|hidden }
  async waitFor(ctx, arg) {
    const a = asObj(arg, 'text');
    if (a.state === 'hidden') {
      const scope = (await appFrame(ctx.page)) || ctx.page.mainFrame();
      const loc = a.selector ? scope.locator(a.selector) : scope.getByText(a.text);
      await loc.first().waitFor({ state: 'hidden', timeout: ctx.stepTimeout });
      return;
    }
    const builders = a.selector ? [(s) => s.locator(a.selector)] : [(s) => s.getByText(a.text)];
    await locate(ctx.page, builders, { timeout: ctx.stepTimeout, what: `"${a.text || a.selector}"` });
  },

  // expectText: "Standard Order"  |  { text, not: true }
  async expectText(ctx, arg) {
    const a = asObj(arg, 'text');
    if (a.not) {
      const found = await locate(ctx.page, [(s) => s.getByText(a.text)], { timeout: 1500, what: a.text }).catch(() => null);
      if (found) throw new Error(`Text "${a.text}" should not be visible`);
      return;
    }
    await locate(ctx.page, [(s) => s.getByText(a.text, { exact: !!a.exact })], {
      timeout: ctx.stepTimeout,
      what: `text "${a.text}"`,
    });
  },

  // expectField: { label: "Net Value", value: "100.00" } | { label, contains } | { label, notEmpty: true }
  async expectField(ctx, a) {
    await pollUntil(
      ctx,
      async () => {
        const v = (await readFieldValue(ctx, a)).trim();
        const ok =
          (a.value !== undefined && v === String(a.value)) ||
          (a.contains !== undefined && v.includes(String(a.contains))) ||
          (a.notEmpty && v !== '');
        return { ok, detail: `actual value "${v}"` };
      },
      `Field "${a.label || a.selector}" check failed`
    );
  },

  // expectMessage: "has been saved"
  // expectMessage: { contains: "Standard Order", capture: { var: salesOrder, regex: "Standard Order (\\d+)" } }
  // expectMessage: { regex: "Order \\d+ (saved|created)", notContains: "error" }
  async expectMessage(ctx, arg) {
    const a = asObj(arg, 'contains');
    const re = a.regex ? new RegExp(a.regex, 'i') : null;
    const res = await pollUntil(
      ctx,
      async () => {
        const text = await messagesText(ctx);
        const hit = re ? re.test(text) : a.contains ? text.toLowerCase().includes(String(a.contains).toLowerCase()) : text !== '';
        return { ok: hit, text, detail: text ? `messages seen: "${text}"` : 'no messages seen' };
      },
      `Expected message ${re ? `/${a.regex}/` : `"${a.contains ?? 'any'}"`} did not appear`
    );
    if (a.notContains && res.text.toLowerCase().includes(String(a.notContains).toLowerCase())) {
      throw new Error(`Message contains "${a.notContains}": ${res.text}`);
    }
    applyCapture(ctx, res.text, a.capture);
  },

  // expectNoError: true  -> fails if an error message/box appeared during this task step window
  async expectNoError(ctx) {
    const scope = (await appFrame(ctx.page)) || ctx.page.mainFrame();
    const errBox = scope.locator('.sapMMessageBoxError:visible, .sapMMsgStripError:visible, .lsMessageBar--error:visible');
    if ((await errBox.count()) > 0) throw new Error(`Error shown: ${(await errBox.first().innerText()).trim()}`);
  },

  // capture: { var: soldTo, from: field, label: "Sold-To Party" }
  // capture: { var: docNo, from: message, regex: "(\\d{8,10})" }
  // capture: { var: docNo, from: text, selector: ".sapMObjectNumber", regex: "..." }
  // capture: { var: hash, from: url, regex: "SalesOrder=(\\d+)" }
  async capture(ctx, a) {
    const from = a.from || 'message';
    let source;
    if (from === 'field') source = await readFieldValue(ctx, a);
    else if (from === 'url') source = ctx.page.url();
    else if (from === 'text') {
      const loc = await locate(ctx.page, [(s) => s.locator(a.selector)], { timeout: ctx.stepTimeout, what: a.selector });
      source = (await loc.innerText()).trim();
    } else source = await messagesText(ctx);
    if (!a.regex && from !== 'message') {
      ctx.vars[a.var] = source.trim();
      ctx.log.info(`  captured ${a.var} = ${ctx.vars[a.var]}`);
    } else applyCapture(ctx, source, a);
  },

  // set: { customer: "17100001" }
  async set(ctx, obj) {
    Object.assign(ctx.vars, obj);
  },

  async screenshot(ctx, name) {
    const file = path.join(ctx.outDir, `${ctx.task.id}-${String(name || 'shot').replace(/[^\w.-]+/g, '_')}.png`);
    await ctx.page.screenshot({ path: file, fullPage: true });
    return { screenshot: file };
  },

  async log(ctx, text) {
    ctx.log.info(`  note: ${text}`);
  },

  // pause: true  -> opens the Playwright inspector (use with --headed) to debug a task
  async pause(ctx) {
    await ctx.page.pause();
  },
};

async function openViaSearch(ctx, title) {
  const { page } = ctx;
  await actions.home(ctx);
  const searchBtn = await locate(
    page,
    [(s) => s.locator('#sf'), (s) => s.getByRole('button', { name: /^search$/i }), (s) => s.getByTitle(/search/i)],
    { timeout: ctx.stepTimeout, what: 'launchpad search', frame: 'main' }
  );
  await searchBtn.click();
  const input = await locate(
    page,
    [(s) => s.getByRole('searchbox'), (s) => s.locator('input[type="search"]'), (s) => s.getByPlaceholder(/search/i)],
    { timeout: ctx.stepTimeout, what: 'search input', frame: 'main' }
  );
  await input.fill(title);
  await input.press('Enter');
  await settle(page, ctx.stepTimeout);
  const result = await locate(
    page,
    [
      (s) => s.getByRole('link', { name: title, exact: true }),
      (s) => s.getByRole('button', { name: title, exact: true }),
      (s) => s.getByRole('option', { name: title }),
      (s) => s.getByText(title, { exact: true }),
    ],
    { timeout: ctx.stepTimeout, what: `app "${title}" in search results`, frame: 'main' }
  );
  await result.click();
}

module.exports = { actions };
