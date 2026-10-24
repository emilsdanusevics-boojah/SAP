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
  return {
    baseUrl: (env.SAP_BASE_URL || 'https://my414802.s4hana.cloud.sap').replace(/\/+$/, ''),
    user: env.SAP_USER || '',
    password: env.SAP_PASSWORD || '',
    language: env.SAP_LANGUAGE || 'EN',
    dateFormat: env.SAP_DATE_FORMAT || 'MM/DD/YYYY',
    timeout: Number(env.SAP_TIMEOUT || 30000),
    headless: !cli.headed,
    slowMo: Number(cli.slowmo || 0),
    trace: !!cli.trace,
    manualLogin: !!cli.manualLogin || env.SAP_MANUAL_LOGIN === '1',
    outDir: path.resolve(cli.out || 'results'),
    authFile: path.resolve(env.SAP_AUTH_FILE || '.auth/state.json'),
    chromiumPath: env.CHROMIUM_PATH || undefined,
  };
}

module.exports = { getConfig };
