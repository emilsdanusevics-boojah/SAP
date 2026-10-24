'use strict';

// A tiny stand-in for the Fiori launchpad so the runner itself can be tested
// offline: IAS-style two-step login, shell header with app search, an iframe
// "GUI" app with a table and a disappearing toast, a main-frame list report,
// a Maintain Business Users imitation and a playground (see mock-apps.js).
const http = require('http');

const fs = require('fs');
const path = require('path');

const orders = {};
// Business roles of the mock user (Maintain Business Users).
let roles = ['Z_S4C_GENERIC_ROLE', 'BR_OLD_ROLE'];
const ROLE_CATALOG = ['Z_S4C_GENERIC_ROLE', 'BR_GL_ACCOUNTANT', 'BR_PURCHASER', 'BR_OLD_ROLE'];

const login = (step) => `<!doctype html><title>Sign In</title><form method="post" action="/login">
  ${step === 1
    ? '<label for="j_username">Email or User Name</label><input id="j_username" name="j_username"><button id="logOnFormSubmit" type="submit">Continue</button>'
    : '<input type="hidden" name="j_username"><label for="j_password">Password</label><input id="j_password" type="password" name="j_password"><button id="logOnFormSubmit" type="submit">Sign In</button>'}
</form>`;

const shell = `<!doctype html><title>Home</title>
<header id="shell-header"><span>SAP</span><button onclick="history.back()">Back</button></header>
<main id="content"></main>
<script src="/mock-apps.js"></script>
<script>
function toast(text) {
  const t = document.createElement('div'); t.className = 'sapMMessageToast'; t.textContent = text;
  document.body.appendChild(t); setTimeout(() => t.remove(), 1200);
}
function route() {
  const [hash, query] = location.hash.slice(1).split('?');
  const c = document.getElementById('content');
  if (hash === 'SalesOrder-create' || hash === 'SalesOrder-display') {
    c.innerHTML = '<iframe id="application-' + hash + '" src="/gui/' + hash + '" style="width:100%;height:600px"></iframe>';
  } else if (hash === 'SalesOrder-manage') {
    c.innerHTML = '<label for="so-inner" id="so-lbl">Sales Order:</label><div><input id="so-inner" aria-labelledby="so-lbl"></div>'
      + '<button id="go">Go</button><ul id="list"></ul>';
    document.getElementById('go').onclick = async () => {
      const so = document.getElementById('so-inner').value;
      const r = await fetch('/api/order/' + so).then(r => r.json());
      document.getElementById('list').innerHTML = r.order ? '<li><a href="#" id="hit">' + so + '</a></li>' : '';
      const hit = document.getElementById('hit');
      if (hit) hit.onclick = (e) => { e.preventDefault(); c.innerHTML = '<h1>Standard Order ' + so + '</h1>'; };
    };
  } else if (!(window.mockRoute && mockRoute(hash, c))) {
    c.innerHTML = '<h1>My Home</h1>';
  }
}
addEventListener('hashchange', route); route();
</script>`;

const gui = (app) => `<!doctype html><body>
${app === 'SalesOrder-create' ? `
<div id="org">
  <span>Order Type</span><input id="f1">
  <span>Sales Organization</span><input id="f2">
  <span>Distribution Channel</span><input id="f3">
  <span>Division</span><input id="f4">
</div>
<div id="head" hidden>
  <span id="l5">Sold-To Party</span><input id="f5" aria-labelledby="l5">
  <span id="l6">Cust. Reference</span><input id="f6" aria-labelledby="l6">
  <table role="grid"><thead><tr><th role="columnheader">Item</th><th role="columnheader">Material</th><th role="columnheader">Order Quantity</th></tr></thead>
  <tbody><tr role="row"><td role="gridcell">10</td><td role="gridcell"><input id="m"></td><td role="gridcell"><input id="q"></td></tr></tbody></table>
  <button id="save">Save</button>
</div>
<div id="sbar" class="lsMessageBar"></div>
<script>
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !document.getElementById('org').hidden && f1.value === 'OR' && f2.value === '1710') {
      document.getElementById('org').hidden = true; document.getElementById('head').hidden = false;
    }
  });
  save.onclick = async () => {
    // Simulate a slow backend, then the status bar message.
    await new Promise(r => setTimeout(r, 400));
    const r = await fetch('/api/order', { method: 'POST', body: JSON.stringify({ soldTo: f5.value, material: m.value, qty: q.value }) }).then(r => r.json());
    sbar.textContent = 'Standard Order ' + r.id + ' has been saved';
    parent.toast && parent.toast('Document saved');
  };
</script>` : `
<label for="o">Order</label><input id="o">
<div id="out"></div>
<script>
  o.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const r = await fetch('/api/order/' + o.value).then(r => r.json());
    out.innerHTML = r.order ? '<label for="st">Sold-To Party</label><input id="st" readonly value="' + r.order.soldTo + '"><p>Item 10 ' + r.order.material + '</p>'
      : '<div class="lsMessageBar">Order does not exist</div>';
  });
</script>`}
</body>`;

function body(req) {
  return new Promise((res) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => res(d)); });
}

function start(port = 0) {
  const server = http.createServer(async (req, res) => {
    const authed = /mocksession=1/.test(req.headers.cookie || '');
    const send = (code, html, headers = {}) => { res.writeHead(code, { 'content-type': 'text/html', ...headers }); res.end(html); };
    if (req.url === '/login' && req.method === 'POST') {
      const form = new URLSearchParams(await body(req));
      if (!form.get('j_password')) return send(200, login(2));
      if (form.get('j_password') !== 'secret') return send(200, login(2).replace('<form', '<div id="errorMessage">Sorry, we could not authenticate you.</div><form'));
      return send(302, '', { location: '/ui', 'set-cookie': 'mocksession=1; Path=/' });
    }
    if (req.url.startsWith('/login')) return send(200, login(1));
    if (!authed) return send(302, '', { location: '/login' });
    if (req.url.startsWith('/ui')) return send(200, shell);
    if (req.url === '/mock-apps.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(fs.readFileSync(path.join(__dirname, 'mock-apps.js')));
    }
    if (req.url === '/api/roles' && req.method === 'POST') {
      roles = JSON.parse(await body(req));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    if (req.url === '/api/roles') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ roles, catalog: ROLE_CATALOG }));
    }
    if (req.url.startsWith('/gui/')) return send(200, gui(req.url.slice(5)));
    if (req.url === '/api/order' && req.method === 'POST') {
      const id = String(Object.keys(orders).length + 3000123);
      orders[id] = JSON.parse(await body(req));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id }));
    }
    if (req.url.startsWith('/api/order/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ order: orders[req.url.split('/').pop()] || null }));
    }
    send(404, 'not found');
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

module.exports = { start, getRoles: () => roles };
