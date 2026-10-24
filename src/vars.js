'use strict';

// Variable interpolation for task files.
//
// Built-ins (all dates use SAP_DATE_FORMAT unless "|FORMAT" is appended):
//   ${grp}                  your group/user number, e.g. 035  (the "###" in the course)
//   ${user}                 your logon user, e.g. F000035
//   ${today}                today
//   ${date(+10d)}           today +/- days (d), months (m) or years (y); "+10" means days
//   ${monthStart(-1m)}      first day of this month (after applying the offset)
//   ${monthEnd}, ${yearStart}, ${yearEnd(+1y)}
//   ${day(15, -1m)}         the 15th of last month
//   ${on(1, 7)}             January 7 of the current year
//   ${today|YYYYMMDD}       explicit format (YYYY, YY, MM, M, DD, D)
//   ${year}, ${year(-1)}    current year (+/- offset)
//   ${month}                current month, two digits
//   ${num(2612.50)}         number with SAP_DECIMAL as decimal separator
//   ${rand}, ${timestamp}
//   ${env.NAME}             environment variable
//   ${anyVar}               task vars, --var values, or values captured by earlier tasks

const pad = (n) => String(n).padStart(2, '0');

function formatDate(d, fmt) {
  return fmt.replace(/YYYY|YY|MM|M|DD|D/g, (t) =>
    ({
      YYYY: d.getFullYear(),
      YY: String(d.getFullYear()).slice(-2),
      MM: pad(d.getMonth() + 1),
      M: d.getMonth() + 1,
      DD: pad(d.getDate()),
      D: d.getDate(),
    })[t]
  );
}

const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();

function addMonths(d, n) {
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, daysIn(d.getFullYear(), d.getMonth())));
}

// "+10d -1m" / "+3" -> mutates d
function applyOffset(d, spec) {
  for (const m of String(spec || '').matchAll(/([+-]\d+)\s*([dmy]?)/gi)) {
    const n = Number(m[1]);
    const unit = (m[2] || 'd').toLowerCase();
    if (unit === 'd') d.setDate(d.getDate() + n);
    else if (unit === 'm') addMonths(d, n);
    else addMonths(d, 12 * n);
  }
}

function dateToken(name, args) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  if (name === 'on') return new Date(d.getFullYear(), Number(args[0]) - 1, Number(args[1]), 12);
  if (name === 'day') {
    applyOffset(d, args[1]);
    d.setDate(Math.min(Number(args[0]), daysIn(d.getFullYear(), d.getMonth())));
    return d;
  }
  applyOffset(d, args[0]);
  if (name === 'monthStart') d.setDate(1);
  if (name === 'monthEnd') d.setDate(daysIn(d.getFullYear(), d.getMonth()));
  if (name === 'yearStart') d.setMonth(0, 1);
  if (name === 'yearEnd') d.setMonth(11, 31);
  return d;
}

const DATE_TOKENS = new Set(['today', 'date', 'day', 'on', 'monthStart', 'monthEnd', 'yearStart', 'yearEnd']);

function resolveToken(token, vars, cfg) {
  const [expr, fmt] = token.split('|').map((s) => s.trim());
  const m = expr.match(/^([\w.]+)(?:\((.*)\))?$/);
  if (!m) throw new Error(`Bad variable \${${token}}`);
  const [, name, rawArgs] = m;
  const args = rawArgs === undefined ? [] : rawArgs.split(',').map((s) => s.trim());

  if (DATE_TOKENS.has(name)) return formatDate(dateToken(name, args), fmt || cfg.dateFormat);
  if (name === 'year') return String(new Date().getFullYear() + Number(args[0] || 0));
  if (name === 'month') return pad(new Date().getMonth() + 1);
  if (name === 'num') return String(args[0]).replace('.', cfg.decimal);
  if (name === 'rand') return String(Math.floor(100000 + Math.random() * 900000));
  if (name === 'timestamp') return new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  if (name === 'user') return cfg.user;
  if (name === 'grp') {
    if (!cfg.group) throw new Error('${grp} needs SAP_GROUP (e.g. 035) or a SAP_USER ending in 3 digits');
    return cfg.group;
  }
  if (name.startsWith('env.')) return process.env[name.slice(4)] ?? '';
  if (name in vars) return String(vars[name]);
  throw new Error(
    `Unknown variable \${${name}} - define it in vars, pass --var ${name}=..., or run the exercise that captures it first`
  );
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
