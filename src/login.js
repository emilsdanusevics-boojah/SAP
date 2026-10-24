'use strict';

const fs = require('fs');
const path = require('path');

// Launchpad header across Fiori 2/3 and Horizon shells.
const SHELL = '#shell-header, .sapUshellShellHead, #shell-header-logo, ui5-shellbar, .sapUshellShellHeader';
// SAP Cloud Identity (IAS) login, classic ABAP/Fiori login, and generic forms.
const USER = '#j_username, #USERNAME_FIELD-inner, input[name="j_username"], input[name="sap-user"], input[name="username"], input[type="email"]';
const PASS = '#j_password, #PASSWORD_FIELD-inner, input[name="j_password"], input[name="sap-password"], input[type="password"]';
const SUBMIT = '#logOnFormSubmit, #LOGIN_LINK, button[type="submit"], input[type="submit"]';
const ERROR = '#errorMessage, .sapUiSegmentLoginError, .error-message, [role="alert"]';

function homeUrl(cfg) {
  return `${cfg.baseUrl}/ui?sap-language=${encodeURIComponent(cfg.language)}#Shell-home`;
}

async function waitForShellOrLogin(page, timeout) {
  const either = page.locator(`${SHELL}, ${USER}, ${PASS}`).first();
  await either.waitFor({ state: 'visible', timeout });
  return (await page.locator(SHELL).first().isVisible().catch(() => false)) ? 'shell' : 'login';
}

async function ensureLoggedIn(page, cfg, log) {
  await page.goto(homeUrl(cfg), { waitUntil: 'domcontentloaded', timeout: cfg.timeout * 2 });
  if ((await waitForShellOrLogin(page, cfg.timeout * 2)) === 'shell') {
    log.info('Session reused - already on the launchpad');
    return;
  }

  if (cfg.manualLogin) {
    log.info('Manual login: complete the sign-in (incl. MFA) in the browser window. Waiting up to 5 minutes...');
    await page.locator(SHELL).first().waitFor({ state: 'visible', timeout: 5 * 60 * 1000 });
  } else {
    if (!cfg.user || !cfg.password) {
      throw new Error('Login required but SAP_USER / SAP_PASSWORD are not set (see .env.example), or use --manual-login');
    }
    log.info(`Logging in as ${cfg.user}`);
    await page.locator(USER).first().fill(cfg.user);
    const pass = page.locator(PASS).first();
    if (!(await pass.isVisible().catch(() => false))) {
      // Two-step IAS form: username first, then "Continue".
      await page.locator(SUBMIT).first().click();
      await pass.waitFor({ state: 'visible', timeout: cfg.timeout });
    }
    await pass.fill(cfg.password);
    await page.locator(SUBMIT).first().click();
    try {
      await page.locator(SHELL).first().waitFor({ state: 'visible', timeout: cfg.timeout * 2 });
    } catch (e) {
      const err = await page.locator(ERROR).first().innerText().catch(() => '');
      throw new Error(
        `Login did not reach the launchpad${err ? `: ${err.trim().replace(/\.$/, '')}` : ''}. ` +
          'Check credentials; if the tenant asks for MFA or a password change, run once with --headed --manual-login.'
      );
    }
  }

  fs.mkdirSync(path.dirname(cfg.authFile), { recursive: true });
  await page.context().storageState({ path: cfg.authFile });
  log.info('Logged in; session saved for later runs');
}

module.exports = { ensureLoggedIn, homeUrl, SHELL };
