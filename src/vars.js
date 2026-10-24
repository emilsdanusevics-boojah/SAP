'use strict';

function formatDate(d, fmt) {
  const pad = (n) => String(n).padStart(2, '0');
  return fmt
    .replace('YYYY', d.getFullYear())
    .replace('MM', pad(d.getMonth() + 1))
    .replace('DD', pad(d.getDate()));
}

// Built-ins:
//   ${today}            today in SAP_DATE_FORMAT
//   ${date(+7)}         today +/- N days
//   ${rand}             6-digit random number (unique references)
//   ${timestamp}        yyyymmddhhmmss
//   ${env.NAME}         environment variable
//   ${anyVar}           task vars, --var values, or values captured earlier in the run
function resolveToken(token, vars, cfg) {
  if (token === 'today') return formatDate(new Date(), cfg.dateFormat);
  const dm = token.match(/^date\(([+-]?\d+)\)$/);
  if (dm) {
    const d = new Date();
    d.setDate(d.getDate() + Number(dm[1]));
    return formatDate(d, cfg.dateFormat);
  }
  if (token === 'rand') return String(Math.floor(100000 + Math.random() * 900000));
  if (token === 'timestamp') return new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  if (token.startsWith('env.')) return process.env[token.slice(4)] ?? '';
  if (token in vars) return String(vars[token]);
  throw new Error(`Unknown variable \${${token}} - define it in vars, pass --var ${token}=..., or run the task that captures it first`);
}

function interpolate(value, vars, cfg) {
  if (typeof value === 'string') return value.replace(/\$\{([^}]+)\}/g, (_, t) => resolveToken(t.trim(), vars, cfg));
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars, cfg));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [interpolate(k, vars, cfg), interpolate(v, vars, cfg)]));
  }
  return value;
}

module.exports = { interpolate, formatDate };
