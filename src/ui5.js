'use strict';

// Helpers that know how SAP Fiori / UI5 / WebGUI pages behave.

// Containers that hold user-facing messages: UI5 toasts, message boxes,
// message strips/popovers, and the WebGUI (classic transaction) status bar.
const MESSAGE_SELECTORS = [
  '.sapMMessageToast',
  '.sapMMessageBox',
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

// Where to look for an element, most specific first: an open dialog in the
// app frame, the app frame, an open dialog in the shell, the shell itself.
async function searchScopes(page, which = 'auto', dialogOnly = false) {
  const frames = [];
  const app = which === 'main' ? null : await appFrame(page);
  if (app) frames.push(app);
  if (which !== 'app' || !app) frames.push(page.mainFrame());
  const scopes = [];
  for (const f of frames) {
    const dialogs = f.locator('[role="dialog"]:visible, [role="alertdialog"]:visible');
    if ((await dialogs.count().catch(() => 0)) > 0) scopes.push(dialogs.last());
    if (!dialogOnly) scopes.push(f);
  }
  return scopes;
}

// Try each locator builder in each scope until one yields a visible element.
async function locate(page, builders, { timeout, what, frame = 'auto', index = 0, dialogOnly = false }) {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const scope of await searchScopes(page, frame, dialogOnly)) {
      for (const build of builders) {
        let loc;
        try {
          loc = build(scope).filter({ visible: true }).nth(index);
          if ((await loc.count()) > 0) return loc;
        } catch {
          // Frame detached mid-navigation or invalid selector for this scope; try next.
        }
      }
    }
    if (Date.now() > deadline) throw new Error(`Could not find ${what} within ${timeout} ms`);
    await page.waitForTimeout(300);
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function fieldBuilders(label) {
  const loose = new RegExp(`^\\s*${escapeRe(label)}\\s*[:*]?\\s*$`, 'i');
  const xpLabel = JSON.stringify(label); // valid XPath string literal unless label has both quote kinds
  return [
    (s) => s.getByLabel(label, { exact: true }),
    (s) => s.getByRole('textbox', { name: label, exact: true }),
    (s) => s.getByRole('combobox', { name: label, exact: true }),
    (s) => s.getByRole('spinbutton', { name: label, exact: true }),
    (s) => s.getByLabel(loose),
    (s) => s.getByTitle(label, { exact: true }).locator('xpath=self::input|self::textarea'),
    // WebGUI / plain layouts: input that follows a text node equal to the label.
    (s) => s.locator(`xpath=//*[normalize-space(text())=${xpLabel}]/following::input[not(@type="hidden")][1]`),
    (s) => s.getByLabel(label),
  ];
}

function clickBuilders(text, role) {
  const roles = role ? [role] : ['button', 'link', 'tab', 'menuitem', 'option', 'treeitem', 'checkbox', 'radio'];
  return [
    ...roles.map((r) => (s) => s.getByRole(r, { name: text, exact: true })),
    (s) => s.getByTitle(text, { exact: true }),
    (s) => s.getByText(text, { exact: true }),
    ...roles.slice(0, 2).map((r) => (s) => s.getByRole(r, { name: text })),
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
  locate,
  fieldBuilders,
  clickBuilders,
  waitForUI5,
  settle,
  collectMessages,
};
