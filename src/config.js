'use strict';

const fs = require('fs');
const path = require('path');

// Minimal .env loader so the project needs no extra dependency.
// Values already present in the real environment win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

function getConfig(cli = {}) {
  loadDotEnv(path.join(process.cwd(), '.env'));
  const env = process.env;
  const user = env.SAP_USER || '';
  const stateDir = path.resolve(env.SAP_STATE_DIR || '.state');
  return {
    baseUrl: (env.SAP_BASE_URL || 'https://my414802.s4hana.cloud.sap').replace(/\/+$/, ''),
    user,
    password: env.SAP_PASSWORD || '',
    // The course's "###": explicit, or the last three digits of the user (F000035 -> 035).
    group: env.SAP_GROUP || (user.match(/(\d{3})$/) || [])[1] || '',
    language: env.SAP_LANGUAGE || 'EN',
    dateFormat: env.SAP_DATE_FORMAT || 'DD.MM.YYYY',
    decimal: env.SAP_DECIMAL || ',',
    timeout: Number(env.SAP_TIMEOUT || 30000),
    headless: !cli.headed,
    slowMo: Number(cli.slowmo || 0),
    trace: !!cli.trace,
    manualLogin: !!cli.manualLogin || env.SAP_MANUAL_LOGIN === '1',
    interactive: !!cli.interactive,
    pauseOnFail: !!cli.pauseOnFail,
    outDir: path.resolve(cli.out || 'results'),
    stateDir,
    authFile: path.resolve(env.SAP_AUTH_FILE || path.join(stateDir, 'auth.json')),
    appsFile: path.resolve('apps.yaml'),
    chromiumPath: env.CHROMIUM_PATH || undefined,
  };
}

module.exports = { getConfig };
