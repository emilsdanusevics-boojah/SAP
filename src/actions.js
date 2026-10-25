'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {
  locate,
  searchScopes,
  fieldBuilders,
  escapeRe,
  clickBuilders,
  rowBuilders,
  settle,
  collectMessages,
  appFrame,
  sectionLocator,
} = require('./ui5');
const { homeUrl, SHELL } = require('./login');

// Each action receives (ctx, arg) where arg is the already-interpolated value
// from the YAML step. ctx = { page, cfg, vars, log, state, stepTimeout, since, outDir, task, saveVars }.

// The role every course user must keep: removing it locks the user out.
const PROTECTED_ROLE = 'Z_S4C_GENERIC_ROLE';

const asObj = (arg, key) => (typeof arg === 'object' && arg !== null && !Array.isArray(arg) ? arg : { [key]: arg });
const scopeOf = (a) => ({ frame: a.frame, within: a.within, dialogOnly: !!a.dialog, index: a.index || 0 });
// "Factory Calendar ID | Factory Calendar" or [a, b] -> alternative labels
const alternatives = (x) => [].concat(x).flatMap((l) => String(l).split(/\s+\|\s+/));

async function findField(ctx, a) {
  const builders = a.selector ? [(s) => s.locator(a.selector)] : fieldBuilders(alternatives(a.label));
  let loc = await locate(ctx.page, builders, { timeout: ctx.stepTimeout, what: `field "${[].concat(a.label || a.selector).join('" / "')}"`, ...scopeOf(a) });
  // getByLabel can land on a UI5 wrapper div; drill down to the real input.
  const tag = await loc.evaluate((e) => e.tagName.toLowerCase()).catch(() => '');
  // sap.m.Select: the label points at a 1px hidden helper; the clickable control is its root.
  const id = (await loc.getAttribute('id').catch(() => null)) || '';
  const m = id.match(/^(.*)-(hiddenSelect|hiddenInput)$/);
  if (m) {
    const root = loc.locator(`xpath=ancestor::*[@id="${m[1]}"]`).first();
    if ((await root.count()) > 0) return root;
  }
  if (!['input', 'textarea', 'select'].includes(tag)) {
    const inner = loc.locator('input:not([type="hidden"]), textarea').first();
    if ((await inner.count()) > 0) loc = inner;
  }
  return loc;
}

const isUi5Select = (field) => field.evaluate((e) => e.classList.contains('sapMSlt')).catch(() => false);

// Open a dropdown and click the option; returns false when no option matches.
async function pickOption(ctx, field, a) {
  await field.click();
  const option = await locate(
    ctx.page,
    [(s) => s.getByRole('option', { name: a.value, exact: true }), (s) => s.getByRole('option', { name: a.value })],
    { timeout: 3000, what: `option "${a.value}"`, frame: a.frame }
  ).catch(() => null);
  if (option) await option.click();
  return !!option;
}

async function typeInto(ctx, field, { value, enter, type }) {
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

async function fillOne(ctx, a) {
  const field = await findField(ctx, a);
  if (process.env.DEBUG_FIELD) ctx.log.info(`    [field] ${a.label} -> ${await field.evaluate((e) => `${e.tagName}#${e.id} labelledby=${e.getAttribute('aria-labelledby')}`).catch(() => '?')}`);
  if (await isUi5Select(field)) {
    const shown = (await field.innerText().catch(() => '')).trim();
    if (shown && shown.startsWith(String(a.value))) return;
    if (!(await pickOption(ctx, field, a))) throw new Error(`No option "${a.value}" in "${a.label}"`);
    await settle(ctx.page, ctx.stepTimeout);
    return;
  }
  // Re-entering a value a field already shows ("1010 (DE Company Code)") can reset the form.
  const current = String((await field.inputValue().catch(() => null)) ?? '').trim();
  const value = String(a.value ?? '');
  if (value && !a.enter && (current === value || current.startsWith(`${value} (`))) return;
  await typeInto(ctx, field, a);
}

async function readFieldValue(ctx, a) {
  const field = await findField(ctx, a);
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
  setVar(ctx, capture.var, m[1] ?? m[0]);
}

function setVar(ctx, name, value) {
  ctx.vars[name] = String(value).trim();
  ctx.saveVars();
  ctx.log.info(`  captured ${name} = ${ctx.vars[name]}`);
}

const norm = (t) => t.replace(/\s+/g, ' ').replace(/\s*[:*]\s*$/, '').trim();

// A table cell addressed by column header text and row (1-based, or the first row containing a text).
const inputValue = (cell) =>
  cell
    .locator('input:not([type="hidden"]), textarea')
    .first()
    .inputValue()
    .catch(() => null);

// row: 1-based data row, negative counts from the end; rowContains: first row with that text;
// firstEmpty: true -> first row whose input in this column is empty (new item lines in GUI tables).
// Grid tables: the header row owns its column headers via aria-owns instead of containing them.
const isHeaderRow = (r) =>
  r.evaluate((e) =>
    (e.getAttribute('aria-owns') || '')
      .split(/\s+/)
      .some((id) => id && document.getElementById(id)?.getAttribute('role') === 'columnheader')
  );

// The n-th data row (1-based; negative counts from the end), skipping header rows.
async function nthDataRow(rows, n) {
  const data = [];
  const count = await rows.count();
  for (let i = 0; i < count; i++) if (!(await isHeaderRow(rows.nth(i)).catch(() => false))) data.push(rows.nth(i));
  return data[n < 0 ? data.length + n : n - 1] || rows.nth(count + 1000);
}

async function findCell(ctx, { row = 1, rowContains, firstEmpty, column, within, dialog }) {
  const deadline = Date.now() + ctx.stepTimeout;
  let seen = [];
  for (;;) {
    for (const scope of await searchScopes(ctx.page, { within, dialogOnly: !!dialog })) {
      const labelled = await labelledItemField(scope, { row, rowContains, column });
      if (labelled) return labelled;
      const headers = scope.locator('[role="columnheader"], th').filter({ visible: true });
      const names = (await headers.allInnerTexts().catch(() => [])).map(norm);
      if (names.length) seen = names;
      const wanted = alternatives(column).map((c) => c.toLowerCase());
      const col = names.findIndex((n) => wanted.includes(n.toLowerCase()));
      if (col < 0) {
        // Responsive tables move columns that do not fit into a pop-in row below each item.
        const popin = await popinField(scope, { row, rowContains, column });
        if (popin) return popin;
        continue;
      }
      const ariaCol = await headers.nth(col).getAttribute('aria-colindex');
      const rows = scope
        .locator(':is([role="row"], tbody tr):not(:has([role="columnheader"], th))')
        .filter({ visible: true });
      const cellOf = (r) => (ariaCol ? r.locator(`[aria-colindex="${ariaCol}"]`).first() : r.locator('[role="gridcell"], td').nth(col));
      if (firstEmpty) {
        const n = await rows.count();
        for (let i = 0; i < n; i++) if ((await inputValue(cellOf(rows.nth(i)))) === '') return cellOf(rows.nth(i));
        continue;
      }
      const r = rowContains ? rows.filter({ hasText: rowContains }).first() : await nthDataRow(rows, row);
      if (!(await r.count())) continue;
      return cellOf(r);
    }
    if (Date.now() > deadline) {
      const which = firstEmpty ? 'first empty row' : `row ${rowContains || row}`;
      throw new Error(`Cell "${column}" / ${which} not found${seen.length ? `. Columns: ${seen.join(', ')}` : ''}`);
    }
    await ctx.page.waitForTimeout(300);
  }
}

// Line items laid out as a list with an inline label per field ("1 Company Code [..] G/L Account [..]
// Debit [..]") instead of a table with column headers: the field labelled `column` in the n-th item.
async function labelledItemField(scope, { row = 1, rowContains, column }) {
  const labels = alternatives(column);
  const pattern = `^\\s*(${labels.map(escapeRe).join('|')})\\s*[:*]?\\s*$`;
  // A self-contained selector: an inner locator built from `scope` would be searched for inside each item.
  let items = scope
    .locator(`:is(.sapMLIB, [role="listitem"]):has(:is(label, .sapMLabel) :text-matches(${JSON.stringify(pattern)}, "i"))`)
    .filter({ visible: true });
  if (rowContains) items = items.filter({ hasText: rowContains });
  const n = await items.count().catch(() => 0);
  if (!n) return null;
  const item = rowContains ? items.first() : items.nth(row < 0 ? n + row : row - 1);
  if (!(await item.count())) return null;
  for (const build of fieldBuilders(labels)) {
    const f = build(item).filter({ visible: true }).first();
    if ((await f.count().catch(() => 0)) > 0) return f;
  }
  return null;
}

// The field labelled `column` in the pop-in (sub-row) of the n-th row of a responsive table.
async function popinField(scope, { row = 1, rowContains, column }) {
  let rows = scope.locator('tr.sapMLIB:not(.sapMListTblSubRow):not(:has(th))').filter({ visible: true });
  if (rowContains) rows = rows.filter({ hasText: rowContains });
  const n = await rows.count().catch(() => 0);
  if (!n) return null;
  const r = rowContains ? rows.first() : rows.nth(row < 0 ? n + row : row - 1);
  const sub = r.locator('xpath=following-sibling::tr[1][contains(concat(" ", @class, " "), " sapMListTblSubRow ")]');
  if (!(await sub.count().catch(() => 0))) return null;
  for (const build of fieldBuilders(alternatives(column))) {
    const f = build(sub).filter({ visible: true }).first();
    if ((await f.count().catch(() => 0)) > 0) return f;
  }
  return null;
}

async function findRow(ctx, a) {
  // { row: 1, within } picks the n-th data row (e.g. a new row whose values sit in inputs).
  if (a.row !== undefined && a.contains === undefined) {
    // A self-contained selector: an inner locator built from a `within` scope would never match.
    const dataRows = (s) => s.locator('[role="row"]:not(:has([role="columnheader"], th))');
    const n = Number(a.row);
    const deadline = Date.now() + ctx.stepTimeout;
    for (;;) {
      for (const scope of await searchScopes(ctx.page, scopeOf(a))) {
        const rows = dataRows(scope).filter({ visible: true });
        const r = await nthDataRow(rows, n);
        if ((await r.count().catch(() => 0)) > 0) return r;
      }
      if (Date.now() > deadline) throw new Error(`Could not find table row ${a.row}${a.within ? ` in "${a.within}"` : ''}`);
      await ctx.page.waitForTimeout(300);
    }
  }
  return locate(ctx.page, rowBuilders(a.contains), { timeout: ctx.stepTimeout, what: `table row containing "${a.contains}"`, ...scopeOf(a) });
}

// A grid-table cell that a row references through aria-owns (selector, row action).
async function ownedCell(row, re) {
  const ids = ((await row.getAttribute('aria-owns').catch(() => null)) || '').split(/\s+/);
  const id = ids.find((i) => re.test(i));
  if (!id) return null;
  const cell = row.locator(`xpath=ancestor::*[contains(concat(" ", @class, " "), " sapUiTable ")][1]`).locator(`[id="${id}"]`).first();
  return (await cell.count()) > 0 ? cell : null;
}

// Tick a row's selection checkbox / radio button (or click the row if it has none).
async function tickRow(row) {
  const selector = row
    .locator('[role="checkbox"], [role="radio"], input[type="checkbox"], input[type="radio"], .sapMCb, .sapMRb')
    .first();
  if ((await selector.count()) > 0) {
    const checked = await selector.getAttribute('aria-checked').catch(() => null);
    if (checked !== 'true') await selector.click();
    return;
  }
  // Grid table: the row owns its selector cell by id (aria-owns "...-rowsel0") without containing it.
  const owned = await ownedCell(row, /-rowsel\d+$/);
  if (owned) return owned.click();
  // Classic GUI table: the selector sits in the fixed left part, "<id>-mrss-cont-left-Row-<n>"
  // next to the content row "<id>-mrss-cont-none-Row-<n>".
  const rowId = (await row.getAttribute('id').catch(() => null)) || '';
  if (/-mrss-cont-none-Row-\d+$/.test(rowId)) {
    const left = row.locator('xpath=ancestor::*[last()]').locator(`[id="${rowId.replace('-cont-none-', '-cont-left-')}"] td`).first();
    if ((await left.count()) > 0) return left.click();
  }
  const idx = await row.getAttribute('data-sap-ui-rowindex').catch(() => null);
  if (idx !== null) {
    const cell = row.page().locator(`.sapUiTableRowSelectionCell[data-sap-ui-rowindex="${idx}"]`).first();
    if ((await cell.count()) > 0) return cell.click();
  }
  await row.click();
}

const actions = {
  // openApp: "SalesOrder-manage"                         (launchpad hash)
  // openApp: { title: "Manage Sales Orders" }            (pinned/cached hash, else launchpad search)
  // openApp: { hash: "...", params: "a=1", title: "..." }
  async openApp(ctx, arg) {
    const a = asObj(arg, 'hash');
    const known = a.hash || (a.title && ctx.state.appHash(a.title));
    if (known) {
      await gotoHash(ctx, known.replace(/^#/, '') + (a.params ? `?${a.params}` : ''));
      const err = await appOpenError(ctx);
      if (!err) return;
      if (!a.title) throw new Error(`App ${known} did not open: ${err}`);
      ctx.log.warn(`  hash ${known} failed (${err}); searching for "${a.title}" instead`);
      ctx.state.forgetApp(a.title);
    }
    if (!a.title) throw new Error('openApp needs "hash" or "title"');
    await openViaSearch(ctx, a.title);
    const err = await appOpenError(ctx);
    if (err) throw new Error(`App "${a.title}" did not open: ${err}`);
    ctx.state.rememberApp(a.title, new URL(ctx.page.url()).hash.slice(1).split('&/')[0]);
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

  // refresh: true   (F5, e.g. after role changes)
  async refresh(ctx) {
    await ctx.page.reload({ waitUntil: 'domcontentloaded' });
    await ctx.page.locator(SHELL).first().waitFor({ state: 'visible', timeout: ctx.stepTimeout });
    await settle(ctx.page, ctx.stepTimeout);
  },

  // fill: { label: "Sold-To Party", value: "17100001" }
  // fill: { "Sold-To Party": "17100001", "Cust. Reference": "PO-${rand}" }
  // fill: { within: "Bank Accounts", fields: { "Bank Key": "50070024" } }
  // fill: { "Lot Sizing Procedure | Lot size": FX }      (alternative labels)
  // fill: { label: [Descr., Material Description], value: ... }
  // Options: selector, enter: true, type: true (keystrokes), within, index, dialog, frame: app|main
  async fill(ctx, arg) {
    if ('label' in arg || 'selector' in arg) return fillOne(ctx, arg);
    const { fields, ...shared } = 'fields' in arg ? arg : { fields: arg };
    // A key may list alternative labels: "Descr. | Material Description".
    for (const [label, value] of Object.entries(fields)) await fillOne(ctx, { ...shared, label, value });
  },

  // clear: "G/L Account"  |  { label, within }
  async clear(ctx, arg) {
    await fillOne(ctx, { ...asObj(arg, 'label'), value: '' });
  },

  // select: { label: "Statement Type", value: "Normal (Actual - Actual)" }   (Select / ComboBox / <select>)
  // select: { combobox: 0, value: "Goods Receipt" }   (n-th unlabelled dropdown, e.g. in Post Goods Movement)
  async select(ctx, a) {
    const field =
      a.combobox !== undefined
        ? await locate(ctx.page, [(s) => s.getByRole('combobox')], {
            timeout: ctx.stepTimeout,
            what: `dropdown #${a.combobox}`,
            ...scopeOf({ ...a, index: a.combobox }),
          })
        : await findField(ctx, a);
    const tag = await field.evaluate((e) => e.tagName.toLowerCase());
    if (tag === 'select') {
      await field.selectOption({ label: a.value }).catch(() => field.selectOption(a.value));
    } else if (!(await pickOption(ctx, field, a))) {
      // Editable ComboBox / input with suggestions: type the value and confirm.
      await field.fill(a.value);
      await field.press('Enter');
    }
    await settle(ctx.page, ctx.stepTimeout);
  },

  async check(ctx, arg) {
    await setCheckbox(ctx, asObj(arg, 'label'), true);
  },

  async uncheck(ctx, arg) {
    await setCheckbox(ctx, asObj(arg, 'label'), false);
  },

  // click: Save
  // click: [OK, Ok]                       (first one found)
  // click: { text: "Add", within: "Assigned Business Roles" }
  // click: { text: "Save", dialog: true } (only inside an open popup)
  // click: { inRow: "Petty Cash", role: link }   (first link in that table row; add text to pick one)
  // click: { text, role, index, selector, frame, double: true }
  async click(ctx, arg) {
    const a = asObj(arg, 'text');
    // click: { field: "Cost Center Categories" } clicks into a field found by its label (opens its dialog).
    if (a.field) {
      await (await findField(ctx, { ...a, label: a.field })).click();
      await settle(ctx.page, ctx.stepTimeout);
      return;
    }
    const builders = a.selector
      ? [(s) => s.locator(a.selector)]
      : a.inRow
        ? inRowBuilders(a)
        : clickBuilders(a.text, a.role);
    const target = await locate(ctx.page, builders, {
      timeout: ctx.stepTimeout,
      what: `"${[].concat(a.text || a.selector || a.role || 'link').join('" or "')}"${a.inRow ? ` in row "${a.inRow}"` : ''}`,
      ...scopeOf(a),
    });
    await target.click(a.double ? { clickCount: 2 } : {});
    await settle(ctx.page, ctx.stepTimeout);
  },

  // selectRow: "65100000"  |  { contains: [BR_PURCHASER, BR_PRODMASTER_SPECIALIST], within, dialog }
  async selectRow(ctx, arg) {
    const a = asObj(arg, 'contains');
    for (const text of [].concat(a.contains)) {
      await tickRow(await findRow(ctx, { ...a, contains: text }));
    }
    await settle(ctx.page, ctx.stepTimeout);
  },

  // openRow: "IEE2E-035"  |  { contains, within }  |  { row: 1, within }  -> navigate into the row (">" or row click)
  async openRow(ctx, arg) {
    const a = asObj(arg, 'contains');
    const row = await findRow(ctx, a);
    let nav = row.locator('.sapMLIBImgNav, .sapUiTableRowActionIcon, [aria-label*="navigat" i], [title*="navigat" i]').first();
    if ((await nav.count()) === 0) {
      const act = await ownedCell(row, /-rowact\d+$/);
      if (act) nav = act.locator('.sapUiTableRowActionIcon, [role="button"], .sapUiIcon').first();
    }
    if ((await nav.count()) > 0) await nav.click();
    else await row.locator('[role="gridcell"], td').filter({ hasText: a.contains }).first().click().catch(() => row.click());
    await settle(ctx.page, ctx.stepTimeout);
  },

  // fillCell: { row: 2, column: "G/L Account", value: "10010000" }   (row is 1-based, data rows only)
  // fillCell: { rowContains: "S11-035", column: "SLoc", value: "101A", within: "Items" }
  async fillCell(ctx, a) {
    const cell = await findCell(ctx, a);
    const isField = await cell.evaluate((e) => ['INPUT', 'TEXTAREA'].includes(e.tagName)).catch(() => false);
    const input = isField ? cell : cell.locator('input:not([type="hidden"]), textarea').first();
    await typeInto(ctx, input, a);
  },

  // clickCell: { rowContains: "${prNo1}", column: "Assign Source of Supply" }   (link/button in that cell)
  async clickCell(ctx, a) {
    const cell = await findCell(ctx, a);
    const inner = cell.locator('a, [role="link"], button, [role="button"]').first();
    await ((await inner.count()) > 0 ? inner : cell).click();
    await settle(ctx.page, ctx.stepTimeout);
  },

  // addFilter: "Profit Center"  -> "Adapt Filters", search, tick, OK
  async addFilter(ctx, arg) {
    const names = [].concat(arg);
    await actions.click(ctx, { text: ['Adapt Filters', 'Filters'], role: 'button' });
    for (const name of names) {
      const search = await locate(
        ctx.page,
        [(s) => s.getByRole('searchbox'), (s) => s.getByPlaceholder(/search/i)],
        { timeout: ctx.stepTimeout, what: 'filter search field', dialogOnly: true }
      );
      await search.fill(name);
      await settle(ctx.page, ctx.stepTimeout);
      const row = await locate(ctx.page, rowBuilders(name), { timeout: 5000, what: name, dialogOnly: true }).catch(() => null);
      if (row) {
        await tickRow(row);
        continue;
      }
      // Newer dialog: the list holds only visible filters; others come from "Add Filter: Select or Type Name".
      await search.fill('');
      const add = await locate(
        ctx.page,
        [...fieldBuilders(['Add Filter']), (s) => s.getByPlaceholder(/select or type name/i)],
        { timeout: ctx.stepTimeout, what: `filter "${name}"`, dialogOnly: true }
      );
      const box = (await add.evaluate((e) => e.tagName === 'INPUT').catch(() => false)) ? add : add.locator('input').first();
      await box.fill(name);
      const option = await locate(
        ctx.page,
        [(s) => s.getByRole('option', { name, exact: true }), (s) => s.getByRole('option', { name })],
        { timeout: ctx.stepTimeout, what: `filter option "${name}"` }
      );
      await option.click();
      await settle(ctx.page, ctx.stepTimeout);
    }
    await actions.click(ctx, { text: ['OK', 'Ok', 'Apply'], dialog: true, role: 'button' });
  },

  // upload: { file: "uploads/F2121_035_PlanCostRate.xlsx" }   (sets the page's file input)
  async upload(ctx, arg) {
    const a = asObj(arg, 'file');
    const file = path.resolve(a.file);
    if (!fs.existsSync(file)) throw new Error(`Upload file not found: ${file}`);
    await pollUntil(
      ctx,
      async () => {
        for (const scope of await searchScopes(ctx.page, scopeOf(a))) {
          const input = scope.locator(a.selector || 'input[type="file"]').first();
          if ((await input.count().catch(() => 0)) > 0) {
            await input.setInputFiles(file);
            return { ok: true };
          }
        }
        return { ok: false };
      },
      'No file input found on the page'
    );
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
    await locate(ctx.page, builders, { timeout: ctx.stepTimeout, what: `"${a.text || a.selector}"`, ...scopeOf(a) });
  },

  // expectText: "Standard Order"  |  { text, exact, within, not: true }
  async expectText(ctx, arg) {
    const a = asObj(arg, 'text');
    const builders = alternatives(a.text).map((t) => (s) => s.getByText(t, { exact: !!a.exact }));
    if (a.not) {
      const found = await locate(ctx.page, builders, { timeout: 1500, what: a.text, ...scopeOf(a) }).catch(() => null);
      if (found) throw new Error(`Text "${a.text}" should not be visible`);
      return;
    }
    await locate(ctx.page, builders, { timeout: ctx.stepTimeout, what: `text "${a.text}"`, ...scopeOf(a) });
  },

  // detect: { text: "65100650", var: glExists }  |  { row: "IEE2E-650", var, within, dialog, timeout }
  // Sets var to "yes" when the text / table row shows up within timeout (default 5 s), else "". Never fails;
  // combine with `when: "${glExists}"` / `unless: "${glExists}"` on later steps.
  async detect(ctx, a) {
    const builders = a.row !== undefined ? rowBuilders(a.row) : alternatives(a.text).map((t) => (s) => s.getByText(t, { exact: !!a.exact }));
    const found = await locate(ctx.page, builders, { timeout: Number(a.timeout || 5000), what: a.row ?? a.text, ...scopeOf(a) }).catch(() => null);
    ctx.vars[a.var] = found ? 'yes' : '';
    ctx.saveVars();
    ctx.log.info(`  ${a.var} = ${found ? 'yes' : 'no'}`);
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
  // expectMessage: { contains: "created", capture: { var: salesOrder, regex: "Order (\\d+)" } }
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
    return { message: res.text };
  },

  // expectNoError: true  -> fails if an error message box/strip/status bar is visible
  async expectNoError(ctx) {
    for (const scope of await searchScopes(ctx.page)) {
      const errBox = scope.locator(
        '.sapMMessageBoxError:visible, .sapMMsgStripError:visible, .lsMessageBar--error:visible, .lsMessageBar[class*="Error"]:visible'
      );
      if ((await errBox.count().catch(() => 0)) > 0) throw new Error(`Error shown: ${(await errBox.first().innerText()).trim()}`);
    }
  },

  // capture: { var: soldTo, from: field, label: "Sold-To Party" }
  // capture: { var: docNo, from: message, regex: "(\\d{8,10})" }
  // capture: { var: prNo, from: cell, column: "Purchase Requisition", row: 1 }
  // capture: { var: title, from: text, selector: ".sapUxAPObjectPageHeaderIdentifierTitle", regex: "..." }
  // capture: { var: hash, from: url, regex: "SalesOrder=(\\d+)" }
  async capture(ctx, a) {
    const from = a.from || 'message';
    let source;
    if (from === 'field') source = await readFieldValue(ctx, a);
    else if (from === 'url') source = ctx.page.url();
    else if (from === 'cell') source = (await (await findCell(ctx, a)).innerText()).trim();
    else if (from === 'text') {
      const loc = await locate(ctx.page, [(s) => s.locator(a.selector)], { timeout: ctx.stepTimeout, what: a.selector, ...scopeOf(a) });
      source = (await loc.innerText()).trim();
    } else source = await messagesText(ctx);
    if (!a.regex && from !== 'message') setVar(ctx, a.var, source);
    else applyCapture(ctx, source, a);
  },

  // set: { customer: "17100001" }
  async set(ctx, obj) {
    Object.assign(ctx.vars, obj);
    ctx.saveVars();
  },

  async screenshot(ctx, name) {
    const file = path.join(ctx.outDir, `${ctx.task.id}-${String(name || 'shot').replace(/[^\w.-]+/g, '_')}.png`);
    await ctx.page.screenshot({ path: file, fullPage: true });
    return { screenshot: file };
  },

  async log(ctx, text) {
    ctx.log.info(`  note: ${text}`);
  },

  // Close extra browser tabs an app opened (PDF preview, T-account view, ...).
  async closePopups(ctx) {
    for (const p of ctx.page.context().pages()) if (p !== ctx.page) await p.close();
    await ctx.page.bringToFront();
  },

  // manual: "Prepare the Excel file ..."
  // Something a human has to do or judge. With --interactive the run waits for
  // Enter in the terminal; otherwise the step is reported as "manual" and skipped.
  async manual(ctx, arg) {
    const a = asObj(arg, 'text');
    if (!ctx.cfg.interactive) {
      throw Object.assign(new Error(`Manual step (run with --headed --interactive to do it): ${a.text}`), { manual: true });
    }
    ctx.log.warn(`  ✋ ${a.text}\n     Do this in the browser window, then press Enter here to continue.`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolve) => rl.question('', resolve));
    rl.close();
    await settle(ctx.page, ctx.stepTimeout);
  },

  // pause: true  -> opens the Playwright inspector (use with --headed) to debug a task
  async pause(ctx) {
    await ctx.page.pause();
  },

  // Course housekeeping: "Use Maintain Business Users to assign role X to your user".
  // assignBusinessRoles: { add: [BR_GL_ACCOUNTANT] }
  // assignBusinessRoles: { add: [...], removeOthers: true }   (keeps Z_S4C_GENERIC_ROLE, always)
  // Roles already assigned are skipped, so the step can be re-run safely.
  async assignBusinessRoles(ctx, a) {
    const add = [].concat(a.add || []);
    // The tenant titles it "Business Roles Assigned (29)"; older releases "Assigned Business Roles".
    const section = a.section || /^(Assigned Business Roles|Business Roles Assigned)(\s*\(\d+\))?$/;
    const user = a.user || ctx.cfg.businessUser;
    if (!user) throw new Error('assignBusinessRoles needs SAP_USER');

    await actions.openApp(ctx, { title: a.app || 'Maintain Business Users' });
    await fillOne(ctx, { label: 'Search', value: user, enter: true });
    await softClick(ctx, 'Go');
    await actions.openRow(ctx, user);
    // A draft left by an earlier run opens straight in edit mode (Save shown, no Edit).
    const mode = await locate(ctx.page, [...clickBuilders('Edit', 'button'), ...clickBuilders('Save', 'button')], {
      timeout: ctx.stepTimeout,
      what: 'Edit or Save',
    });
    if ((await mode.innerText().catch(() => '')).trim() === 'Edit') {
      await mode.click();
      await settle(ctx.page, ctx.stepTimeout);
    }

    const area = await sectionLocator(ctx.page, section);
    const areaText = await area.innerText({ timeout: ctx.stepTimeout });

    if (a.removeOthers) {
      const keep = [PROTECTED_ROLE, ...add, ...[].concat(a.keep || [])];
      const rows = area.locator('[role="row"]:not(:has([role="columnheader"], th))');
      // Rows must show role IDs to match `keep`; a table listing only names could lose the generic role.
      if (!/\b(BR|Z|SAP_BR)_[A-Z0-9_]+/.test(areaText.replace(PROTECTED_ROLE, ''))) {
        ctx.log.warn('  roles are listed by name only - skipped removing other roles');
      } else {
        let removed = 0;
        for (let i = 0; i < (await rows.count()); i++) {
          const text = await rows.nth(i).innerText();
          if (!text.trim() || keep.some((k) => text.includes(k))) continue;
          if (text.includes(PROTECTED_ROLE) || /generic role/i.test(text)) continue; // belt and braces
          await tickRow(rows.nth(i));
          removed++;
        }
        if (removed) await actions.click(ctx, { text: 'Remove', within: section });
        ctx.log.info(`  removed ${removed} other role(s); kept ${PROTECTED_ROLE}`);
      }
    }

    // The Add dialog only offers roles the user does not have yet.
    const added = [];
    for (const role of add) {
      if (areaText.includes(role)) {
        ctx.log.info(`  ${role} already assigned`);
        continue;
      }
      await actions.click(ctx, { text: 'Add', within: section });
      const search = await locate(
        ctx.page,
        [(s) => s.getByRole('searchbox'), (s) => s.getByPlaceholder(/search/i)],
        { timeout: ctx.stepTimeout, what: 'role search field', dialogOnly: true }
      );
      await search.fill(role);
      await search.press('Enter');
      const go = await locate(ctx.page, clickBuilders('Go', 'button'), { timeout: 2000, what: 'Go', dialogOnly: true }).catch(() => null);
      if (go) await go.click();
      await settle(ctx.page, ctx.stepTimeout);
      const row = await locate(ctx.page, rowBuilders(role), { timeout: 5000, what: role, dialogOnly: true }).catch(() => null);
      if (!row) {
        ctx.log.info(`  ${role} not offered in Add - already assigned`);
        await actions.click(ctx, { text: 'Cancel', dialog: true, role: 'button' });
        continue;
      }
      const name = ((await row.innerText().catch(() => '')).split(/\t|\n/).map((t) => t.trim()).filter(Boolean)[0]) || role;
      await tickRow(row);
      await actions.click(ctx, { text: ['OK', 'Ok'], dialog: true, role: 'button' });
      added.push({ role, name });
    }

    await actions.click(ctx, 'Save');
    // Saved = back in display mode (Edit visible again); only then leave the page.
    await locate(ctx.page, clickBuilders('Edit', 'button'), { timeout: ctx.stepTimeout, what: 'display mode after Save' });
    await actions.expectNoError(ctx);
    for (const { name } of added) await actions.expectText(ctx, { text: name, within: section });
    await actions.home(ctx);
    await actions.refresh(ctx);
  },
};

function inRowBuilders(a) {
  const role = a.role || 'link';
  const rows = [
    (s) => s.getByRole('row').filter({ hasText: a.inRow }),
    (s) => s.locator('tr, [role="listitem"], .sapMLIB').filter({ hasText: a.inRow }),
  ];
  const targets = a.text ? [].concat(a.text).map((t) => (row) => row.getByRole(role, { name: t })) : [(row) => row.getByRole(role)];
  return rows.flatMap((row) => targets.map((target) => (s) => target(row(s))));
}

async function setCheckbox(ctx, a, on) {
  const labels = alternatives(a.label);
  const box = await locate(
    ctx.page,
    [
      ...labels.map((l) => (s) => s.getByRole('checkbox', { name: l, exact: true })),
      ...labels.map((l) => (s) => s.getByRole('checkbox', { name: l })),
      ...fieldBuilders(labels),
    ],
    { timeout: ctx.stepTimeout, what: `checkbox "${a.label}"`, ...scopeOf(a) }
  );
  const state = await box.getAttribute('aria-checked').catch(() => null);
  const isOn = state === null ? await box.isChecked().catch(() => !on) : state === 'true';
  if (isOn !== on) await box.click();
  await settle(ctx.page, ctx.stepTimeout);
}

async function softClick(ctx, text) {
  const target = await locate(ctx.page, clickBuilders(text, 'button'), { timeout: 2000, what: text }).catch(() => null);
  if (target) {
    await target.click();
    await settle(ctx.page, ctx.stepTimeout);
  }
}

async function gotoHash(ctx, hash) {
  await ctx.page.goto(`${ctx.cfg.baseUrl}/ui?sap-language=${ctx.cfg.language}#${hash}`, { waitUntil: 'domcontentloaded' });
  await ctx.page.locator(SHELL).first().waitFor({ state: 'visible', timeout: ctx.stepTimeout });
  await settle(ctx.page, ctx.stepTimeout);
}

// Launchpad error dialogs shown when an intent cannot be resolved or is not authorised.
async function appOpenError(ctx) {
  const re = /could not open app|cannot be opened|navigation to this application is not supported|not authorized|app could not be found|failed to load/i;
  const hit = ctx.page.mainFrame().getByText(re).filter({ visible: true }).first();
  if ((await hit.count().catch(() => 0)) === 0) return null;
  const text = (await hit.innerText().catch(() => 'error')).trim();
  await softClick(ctx, ['Close', 'OK']);
  return text;
}

async function openViaSearch(ctx, title) {
  const { page } = ctx;
  await actions.home(ctx);
  let input = await locate(page, [(s) => s.getByRole('searchbox'), (s) => s.locator('input[type="search"]')], {
    timeout: 1500,
    what: 'search input',
    frame: 'main',
  }).catch(() => null);
  if (!input) {
    const opener = await locate(
      page,
      [(s) => s.locator('#sf'), (s) => s.getByRole('button', { name: /^search$/i }), (s) => s.getByRole('button', { name: /search/i })],
      { timeout: ctx.stepTimeout, what: 'launchpad search button', frame: 'main' }
    );
    await opener.click();
    input = await locate(
      page,
      [(s) => s.getByRole('searchbox'), (s) => s.locator('input[type="search"]'), (s) => s.getByPlaceholder(/search/i)],
      { timeout: ctx.stepTimeout, what: 'search input', frame: 'main' }
    );
  }
  await input.fill(title);
  const before = page.url();
  // Suggestion list first (fast path), then the full results page.
  const suggestion = await locate(
    page,
    [(s) => s.getByRole('option', { name: title, exact: true }), (s) => s.getByRole('option', { name: title })],
    { timeout: 6000, what: 'suggestion', frame: 'main' }
  ).catch(() => null);
  if (suggestion) {
    await suggestion.click();
  } else if (/ - /.test(title)) {
    // "Title - Subtitle": tiles show the subtitle on its own line, so search for the title and
    // open the tile that also carries the subtitle.
    const [main, sub] = title.split(/ - (.+)/);
    await input.fill(main);
    await input.press('Enter');
    await settle(page, ctx.stepTimeout);
    const tile = await locate(
      page,
      [(s) => s.locator(':is(a, [role="link"], [role="button"], li, [class*="Tile"], [class*="tile"])').filter({ hasText: main }).filter({ hasText: sub })],
      { timeout: ctx.stepTimeout, what: `app "${main}" with subtitle "${sub}" in search results`, frame: 'main', index: 0 }
    );
    await tile.getByText(main, { exact: true }).first().click();
  } else {
    await input.press('Enter');
    await settle(page, ctx.stepTimeout);
    const result = await locate(
      page,
      [
        (s) => s.getByRole('link', { name: title, exact: true }),
        (s) => s.getByRole('button', { name: title, exact: true }),
        (s) => s.getByRole('link', { name: title }),
        (s) => s.getByText(title, { exact: true }),
      ],
      { timeout: ctx.stepTimeout, what: `app "${title}" in search results (is the business role assigned?)`, frame: 'main' }
    );
    await result.click();
  }
  await page.waitForURL((u) => u.toString() !== before && !/#(Shell-home|Action-search)/.test(u.toString()), {
    timeout: ctx.stepTimeout,
  });
  await page.locator(SHELL).first().waitFor({ state: 'visible', timeout: ctx.stepTimeout });
  await settle(page, ctx.stepTimeout);
}

module.exports = { actions, PROTECTED_ROLE };
