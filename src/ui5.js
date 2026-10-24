'use strict';

// Helpers that know how SAP Fiori / UI5 / WebGUI pages behave.

// Containers that hold user-facing messages: UI5 toasts, message boxes,
// message strips/popovers, and the WebGUI (classic transaction) status bar.
const MESSAGE_SELECTORS = [
  '.sapMMessageToast',
  '.sapMMessageBox',
  // sap.m.Dialog with a state ("Success: Documents have been created ..."), e.g. Create Supplier Invoice.
  '[role="dialog"][class*="sapMDialogSuccess"]',
  '[role="dialog"][class*="sapMDialogError"]',
  '[role="dialog"][class*="sapMDialogWarning"]',
  '.sapMMsgStrip',
  '.sapMMessagePopover',
  '.sapMMsgView',
  '[role="alertdialog"]',
  '[role="alert"]',
  '[role="status"]',
  '.lsMessageBar',
  '.lsMessageArea',
  '[id*="sbar_msg"]',
  '.urMsgBarTxt',
].join(',');

// Elements that wrap a whole titled area (object page section, form, panel,
// dialog, tab). Used to scope a lookup with `within: "<section title>"`.
const SECTION_SELECTORS = [
  '.sapUxAPObjectPageSubSection',
  '.sapUxAPObjectPageSection',
  'section',
  '[role="region"]',
  '[role="dialog"]',
  '[role="tabpanel"]',
  '[role="group"]',
  '[role="listitem"]',
  '.sapFCard',
  '.sapUiForm',
  '.sapMPanel',
  'fieldset',
].join(',');

// Whole page sections only (no cards/groups): for reading a section's content.
const PAGE_SECTION_SELECTORS = '.sapUxAPObjectPageSection, section, [role="region"], .sapMPanel, [role="dialog"]';

// Installed into every frame before any page script runs. Toasts vanish after
// a few seconds, so we record every message as it appears instead of hoping to
// catch it on screen later.
function messageRecorderScript(selectors) {
  const store = (window.__sapTesterMessages = window.__sapTesterMessages || []);
  const record = (el) => {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const last = store[store.length - 1];
    if (last && last.text === text && Date.now() - last.at < 1000) return;
    store.push({ text, at: Date.now() });
  };
  const inspect = (node) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return;
    const host = el.closest && el.closest(selectors);
    if (host) setTimeout(() => record(host), 80);
    if (el.querySelectorAll) el.querySelectorAll(selectors).forEach((m) => setTimeout(() => record(m), 80));
  };
  document.addEventListener('focusin', (e) => (window.__sapTesterLastFocus = e.target), true);
  const start = () => {
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'characterData') inspect(m.target);
        else m.addedNodes.forEach(inspect);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start);
}

// Fiori launchpad renders classic GUI transactions (and some apps) in an
// iframe. Return the visible application iframe if there is one.
async function appFrame(page) {
  const iframes = page.locator(
    'iframe[id^="application-"], iframe.sapUShellApplicationContainer, iframe[data-help-id="application-frame"]'
  );
  const n = await iframes.count().catch(() => 0);
  for (let i = n - 1; i >= 0; i--) {
    const el = iframes.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const handle = await el.elementHandle().catch(() => null);
    const frame = handle && (await handle.contentFrame());
    if (frame) return frame;
  }
  return null;
}

// A section title as written in a task also matches the title with a row count: "Company Codes (1)".
function sectionTitle(title) {
  if (title instanceof RegExp) return title;
  return new RegExp(`^\\s*${String(title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*\\(\\d+\\))?\\s*$`);
}

// Where to look for an element, most specific first: an open dialog in the
// app frame, the app frame, an open dialog in the shell, the shell itself.
// `within` narrows each scope to the innermost section titled with that text.
async function searchScopes(page, { frame = 'auto', dialogOnly = false, within } = {}) {
  const frames = [];
  const app = frame === 'main' ? null : await appFrame(page);
  if (app) frames.push(app);
  if (frame !== 'app' || !app) frames.push(page.mainFrame());
  const scopes = [];
  for (const f of frames) {
    // Every open dialog, the most recent first (another, inactive dialog can also be in the DOM).
    const dialogs = f.locator('[role="dialog"]:visible, [role="alertdialog"]:visible');
    const n = await dialogs.count().catch(() => 0);
    for (let i = n - 1; i >= 0; i--) scopes.push(dialogs.nth(i));
    if (!dialogOnly) scopes.push(f);
  }
  if (!within) return scopes;
  // Every container holding the title, innermost first, so the lookup widens
  // outward until the target is found (cards, sub-sections, sections...).
  const title = sectionTitle(within);
  const narrowed = [];
  for (const s of scopes) {
    const containers = s.locator(SECTION_SELECTORS).filter({ has: s.getByText(title, { exact: true }) });
    const n = await containers.count().catch(() => 0);
    for (let i = n - 1; i >= Math.max(0, n - 6); i--) narrowed.push(containers.nth(i));
  }
  return narrowed;
}

// The page section titled `title` (for reading its content as a whole).
async function sectionLocator(page, title) {
  for (const s of await searchScopes(page)) {
    const sec = s.locator(PAGE_SECTION_SELECTORS).filter({ has: s.getByText(sectionTitle(title), { exact: true }) }).last();
    if ((await sec.count().catch(() => 0)) > 0) return sec;
  }
  throw new Error(`Section "${title}" not found`);
}

// Try each locator builder in each scope until one yields a visible element.
async function locate(page, builders, { timeout, what, index = 0, ...scopeOpts }) {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const scope of await searchScopes(page, scopeOpts)) {
      for (const build of builders) {
        try {
          const loc = build(scope).filter({ visible: true }).nth(index);
          if ((await loc.count()) > 0) return loc;
        } catch {
          // Frame detached mid-navigation or invalid selector for this scope; try next.
        }
      }
    }
    if (Date.now() > deadline) {
      const where = scopeOpts.within ? ` in "${scopeOpts.within}"` : '';
      throw new Error(`Could not find ${what}${where} within ${timeout} ms`);
    }
    await page.waitForTimeout(300);
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const FILLABLE =
  'input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, select, [contenteditable="true"], ' +
  '[role="textbox"], [role="combobox"], [role="searchbox"], [role="spinbutton"], [role="checkbox"]';

// Only things you can type into (or UI5 wrappers holding one): a button
// labelled "Search" must not win over the search field.
function fieldBuilders(labels) {
  return [].concat(labels).flatMap(fieldBuildersFor).map((build) => (s) => {
    const loc = build(s);
    return loc.and(s.locator(FILLABLE)).or(loc.filter({ has: s.locator('input:not([type="hidden"]), textarea') }));
  });
}

function fieldBuildersFor(label) {
  const loose = new RegExp(`^\\s*${escapeRe(label)}\\s*[:*]?\\s*$`, 'i');
  const xpLabel = JSON.stringify(label); // valid XPath string literal unless label has both quote kinds
  return [
    (s) => s.getByLabel(label, { exact: true }),
    (s) => s.getByRole('textbox', { name: label, exact: true }),
    (s) => s.getByRole('combobox', { name: label, exact: true }),
    (s) => s.getByRole('searchbox', { name: label, exact: true }),
    (s) => s.getByRole('spinbutton', { name: label, exact: true }),
    (s) => s.getByLabel(loose),
    (s) => s.getByPlaceholder(label, { exact: true }),
    (s) => s.getByTitle(label, { exact: true }).locator('xpath=self::input|self::textarea'),
    // WebGUI / plain layouts: input that follows a text node equal to the label.
    // Unlinked labels (e.g. in dialogs) whose text carries the colon: "Project Name:".
    (s) => s.locator(`xpath=//*[normalize-space(text())=${xpLabel} or normalize-space(text())=concat(${xpLabel}, ":")]/following::input[not(@type="hidden")][1]`),
    (s) => s.getByLabel(label),
  ];
}

function clickBuilders(texts, role) {
  const roles = role ? [role] : ['button', 'link', 'tab', 'menuitem', 'menuitemradio', 'option', 'treeitem', 'checkbox', 'radio'];
  const list = [].concat(texts);
  return [
    ...list.flatMap((t) => roles.map((r) => (s) => s.getByRole(r, { name: t, exact: true }))),
    ...list.map((t) => (s) => s.getByTitle(t, { exact: true })),
    ...list.map((t) => (s) => s.getByText(t, { exact: true })),
    ...list.flatMap((t) => roles.slice(0, 2).map((r) => (s) => s.getByRole(r, { name: t }))),
  ];
}

// Rows of sap.m tables/lists, grid tables and WebGUI tables.
function rowBuilders(contains) {
  return [
    (s) => s.getByRole('row').filter({ hasText: contains }),
    (s) => s.locator('tr, [role="listitem"], [role="option"], .sapMLIB').filter({ hasText: contains }),
  ];
}

// Wait until UI5 reports no pending requests, timeouts or rendering. Uses the
// same auto-waiter OPA5/wdi5 use; falls back to "no visible busy indicator"
// for non-UI5 frames (e.g. WebGUI) or if the module cannot be loaded.
async function waitForUI5(target, timeout) {
  try {
    await target.waitForFunction(
      () => {
        const w = window;
        const domIdle = () =>
          document.readyState === 'complete' &&
          ![...document.querySelectorAll('.sapUiLocalBusyIndicator, .sapMBusyDialog, .sapUiBusy, .lsLoadingIndicator')].some(
            (e) => e.offsetParent !== null
          );
        if (!(w.sap && w.sap.ui && w.sap.ui.require)) return domIdle();
        if (w.__sapTesterWaiter === undefined) {
          w.__sapTesterWaiter = null;
          w.sap.ui.require(
            ['sap/ui/test/autowaiter/_autoWaiter'],
            (aw) => (w.__sapTesterWaiter = aw),
            () => (w.__sapTesterWaiter = false)
          );
          return false;
        }
        if (w.__sapTesterWaiter === null) return false; // still loading
        if (w.__sapTesterWaiter === false) return domIdle();
        return !w.__sapTesterWaiter.hasToWait() && domIdle();
      },
      null,
      { timeout, polling: 250 }
    );
  } catch {
    // Some apps poll forever (the auto-waiter then never settles). Carry on and
    // let the next step's own wait decide.
  }
}

async function settle(page, timeout) {
  await waitForUI5(page.mainFrame(), timeout);
  const app = await appFrame(page);
  if (app) await waitForUI5(app, timeout);
}

// Every message recorded since `since` (ms epoch) across all frames, plus
// anything currently visible in a message container.
async function collectMessages(page, since = 0) {
  const out = [];
  for (const frame of page.frames()) {
    const items = await frame
      .evaluate(
        ({ since, sel }) => {
          const recorded = (window.__sapTesterMessages || []).filter((m) => m.at >= since).map((m) => m.text);
          const visible = [...document.querySelectorAll(sel)]
            .filter((e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed')
            .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean);
          return [...recorded, ...visible];
        },
        { since, sel: MESSAGE_SELECTORS }
      )
      .catch(() => []);
    out.push(...items);
  }
  return [...new Set(out)];
}

module.exports = {
  MESSAGE_SELECTORS,
  messageRecorderScript,
  appFrame,
  searchScopes,
  sectionLocator,
  locate,
  fieldBuilders,
  escapeRe,
  clickBuilders,
  rowBuilders,
  waitForUI5,
  settle,
  collectMessages,
};
