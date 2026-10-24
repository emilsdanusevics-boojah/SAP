'use strict';

const fs = require('fs');
const path = require('path');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const secs = (ms) => (ms ? `${(ms / 1000).toFixed(1)}s` : '');

function html(run, outDir) {
  const rel = (p) => (p ? path.relative(outDir, p) : '');
  const passed = run.tasks.filter((t) => t.status === 'passed').length;
  const rows = run.tasks
    .map(
      (t) => `
  <details class="task ${t.status}" ${t.status === 'failed' ? 'open' : ''}>
    <summary><span class="badge">${t.status}</span> ${t.exercise ? `Ex ${t.exercise} · ` : ''}<b>${esc(t.id)}</b> ${esc(t.title)} <span class="dur">${secs(t.duration)}</span></summary>
    ${t.error ? `<p class="err">${esc(t.error)}</p>` : ''}
    ${t.trace ? `<p>Trace: <code>${esc(rel(t.trace))}</code> — open with <code>npx playwright show-trace</code></p>` : ''}
    <table>
      <tr><th>#</th><th>Step</th><th>Status</th><th>Time</th><th>Details</th></tr>
      ${t.steps
        .map(
          (s) => `<tr class="${s.status}"><td>${s.index}</td><td>${esc(s.name)}</td><td>${s.status}</td><td>${secs(s.duration)}</td>
        <td>${s.error ? `<span class="err">${esc(s.error)}</span>` : ''}${s.screenshot ? ` <a href="${esc(rel(s.screenshot))}">screenshot</a>` : ''}</td></tr>`
        )
        .join('')}
    </table>
  </details>`
    )
    .join('');
  const vars = Object.entries(run.vars || {})
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>IEE2E Test Report</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --bg:#fff; --fg:#1d2d3e; --muted:#5b738b; --line:#d9dee3; --pass:#256f3a; --fail:#aa0808; --warn:#8d5300; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12171c; --fg:#e8edf2; --muted:#9aa9b8; --line:#2c3640; --pass:#5dc27a; --fail:#ff6b6b; --warn:#e8a64a; } }
  body { background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, sans-serif; margin:0 auto; padding:16px; max-width:1100px; }
  h1 { font-size:20px; margin:0 0 4px } .meta { color:var(--muted); margin-bottom:16px }
  .task { border:1px solid var(--line); border-radius:6px; margin:8px 0; padding:8px 12px }
  summary { cursor:pointer } .dur { color:var(--muted); float:right }
  .badge { text-transform:uppercase; font-size:11px; font-weight:700; padding:2px 6px; border-radius:4px; border:1px solid currentColor }
  .passed .badge, tr.passed td:nth-child(3) { color:var(--pass) } .failed .badge, tr.failed td:nth-child(3), .err { color:var(--fail) }
  .partial .badge, tr.warned td:nth-child(3), tr.manual td:nth-child(3) { color:var(--warn) }
  .skipped .badge, tr.skipped { color:var(--muted) }
  table { border-collapse:collapse; width:100%; margin-top:8px; display:block; overflow-x:auto }
  th, td { text-align:left; padding:4px 8px; border-bottom:1px solid var(--line); vertical-align:top }
  a { color:inherit }
</style></head><body>
<h1>IEE2E Exercise Test Report</h1>
<div class="meta">${esc(run.baseUrl)} · user ${esc(run.user || '(session)')} · group ${esc(run.group || '?')} · ${new Date(run.startedAt).toLocaleString()} ·
<b>${passed}/${run.tasks.length} passed</b> · ${secs(run.finishedAt - run.startedAt)}</div>
${run.fatal ? `<p class="err"><b>Run aborted:</b> ${esc(run.fatal)}</p>` : ''}
${rows}
${vars ? `<h2>Captured / run variables</h2><table><tr><th>Name</th><th>Value</th></tr>${vars}</table>` : ''}
</body></html>`;
}

function junit(run) {
  const cases = run.tasks
    .map((t) => {
      const body =
        t.status === 'failed' ? `<failure message="${esc(t.error)}"/>` : t.status === 'skipped' ? `<skipped message="${esc(t.error)}"/>` : '';
      return `  <testcase classname="sap.tasks" name="${esc(`${t.id} ${t.title}`)}" time="${(t.duration || 0) / 1000}">${body}</testcase>`;
    })
    .join('\n');
  const failures = run.tasks.filter((t) => t.status === 'failed').length;
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="SAP learning tasks" tests="${run.tasks.length}" failures="${failures}" errors="${run.fatal ? 1 : 0}">
${cases}
</testsuite>
`;
}

function writeReports(run, outDir) {
  const files = {
    'results.json': JSON.stringify(run, null, 2),
    'report.html': html(run, outDir),
    'junit.xml': junit(run),
  };
  return Object.entries(files).map(([name, content]) => {
    const p = path.join(outDir, name);
    fs.writeFileSync(p, content);
    return path.relative(process.cwd(), p);
  });
}

module.exports = { writeReports };
