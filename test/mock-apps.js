// Browser-side mock apps for the offline self-test (served by mock-server.js).
const APPS = {
  'Maintain Business Users': 'BusinessUser-maintain',
  Playground: 'Test-playground',
  'Manage Sales Orders': 'SalesOrder-manage',
};

function toast(text) {
  const t = document.createElement('div');
  t.className = 'sapMMessageToast';
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1200);
}

// Launchpad search: button reveals a search box whose suggestions navigate.
document.addEventListener('DOMContentLoaded', () => {
  const hdr = document.getElementById('shell-header');
  hdr.insertAdjacentHTML(
    'beforeend',
    '<button id="sf" aria-label="Search">S</button><span id="sfwrap" hidden>' +
      '<input type="search" aria-label="Search in apps" id="sfi"><ul role="listbox" id="sugg"></ul></span>'
  );
  const wrap = document.getElementById('sfwrap');
  const input = document.getElementById('sfi');
  const sugg = document.getElementById('sugg');
  document.getElementById('sf').onclick = () => {
    wrap.hidden = false;
    input.focus();
  };
  input.oninput = () => {
    const q = input.value.toLowerCase();
    sugg.innerHTML = Object.keys(APPS)
      .filter((t) => q && t.toLowerCase().includes(q))
      .map((t) => `<li role="option" data-h="${APPS[t]}">${t}</li>`)
      .join('');
    sugg.querySelectorAll('li').forEach(
      (li) =>
        (li.onclick = () => {
          wrap.hidden = true;
          input.value = '';
          sugg.innerHTML = '';
          location.hash = li.dataset.h;
        })
    );
  };
});

const checkbox = () => '<span role="checkbox" aria-checked="false" tabindex="0" style="display:inline-block;width:12px;height:12px;border:1px solid"></span>';
function wireCheckboxes(root) {
  root.querySelectorAll('[role="checkbox"]').forEach(
    (cb) => (cb.onclick = () => cb.setAttribute('aria-checked', cb.getAttribute('aria-checked') === 'true' ? 'false' : 'true'))
  );
}
const checkedRows = (root) =>
  [...root.querySelectorAll('tbody [role="row"]')].filter((r) => r.querySelector('[aria-checked="true"]')).map((r) => r.dataset.role);

function businessUsers(c) {
  c.innerHTML =
    '<input type="search" aria-label="Search" placeholder="Search" id="q"><button id="go">Go</button>' +
    '<table role="grid"><tbody id="rows"></tbody></table>';
  const q = document.getElementById('q');
  document.getElementById('go').onclick = () => {
    document.getElementById('rows').innerHTML = q.value
      ? `<tr role="row" id="urow"><td role="gridcell">${q.value}</td><td role="gridcell">Course User</td></tr>`
      : '';
    document.getElementById('urow').onclick = () => showUser(c, q.value);
  };
  q.onkeydown = (e) => e.key === 'Enter' && document.getElementById('go').click();
}

async function showUser(c, user) {
  let { roles, catalog } = await fetch('/api/roles').then((r) => r.json());
  let edit = false;
  const roleRows = (list, withBox) =>
    list.map((r) => `<tr role="row" data-role="${r}"><td role="gridcell">${withBox ? checkbox() : ''}${r}</td></tr>`).join('');
  const render = () => {
    c.innerHTML =
      `<h2>${user}</h2>${edit ? '<button id="save">Save</button>' : '<button id="edit">Edit</button>'}` +
      '<section role="region"><h3>Assigned Business Roles</h3>' +
      (edit ? '<button id="add">Add</button><button id="rem">Remove</button>' : '') +
      `<table role="grid"><thead><tr role="row"><th role="columnheader">Role</th></tr></thead><tbody>${roleRows(roles, edit)}</tbody></table></section>`;
    wireCheckboxes(c);
    if (!edit) return (document.getElementById('edit').onclick = () => ((edit = true), render()));
    document.getElementById('rem').onclick = () => {
      const gone = checkedRows(c.querySelector('section'));
      roles = roles.filter((r) => !gone.includes(r));
      render();
    };
    document.getElementById('save').onclick = async () => {
      await new Promise((r) => setTimeout(r, 300));
      await fetch('/api/roles', { method: 'POST', body: JSON.stringify(roles) });
      edit = false;
      render();
      toast('Business user saved');
    };
    document.getElementById('add').onclick = () => {
      const d = document.createElement('div');
      d.setAttribute('role', 'dialog');
      d.innerHTML =
        '<input type="search" aria-label="Search" id="dq"><table role="grid"><tbody id="drows"></tbody></table><button id="ok">OK</button>';
      document.body.appendChild(d);
      const dq = d.querySelector('#dq');
      dq.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        d.querySelector('#drows').innerHTML = roleRows(catalog.filter((r) => r.includes(dq.value)), true);
        wireCheckboxes(d);
      };
      d.querySelector('#ok').onclick = () => {
        roles = [...new Set([...roles, ...checkedRows(d)])];
        d.remove();
        render();
      };
    };
  };
  render();
}

function playground(c) {
  c.innerHTML = `
  <section role="region"><h3>Header</h3><label for="hcc">Company Code</label><input id="hcc"></section>
  <section role="region"><h3>Line Items</h3><label for="lcc">Company Code</label><input id="lcc">
    <table role="grid"><thead><tr role="row"><th role="columnheader">G/L Account</th><th role="columnheader">Debit</th></tr></thead>
    <tbody>
      <tr role="row"><td role="gridcell"><input value="10010000"></td><td role="gridcell"><input value="500"></td></tr>
      <tr role="row"><td role="gridcell"><input id="gl2"></td><td role="gridcell"><input></td></tr>
    </tbody></table>
    <button>Create</button>
  </section>
  <table role="grid"><tbody><tr role="row"><td role="gridcell">Petty Cash</td><td role="gridcell"><a href="#" id="amt">1.234,00</a></td></tr></tbody></table>
  <div id="out"></div>
  <label for="desc">Material Description</label><input id="desc">
  <footer><button id="final">Create</button></footer>`;
  document.getElementById('amt').onclick = (e) => {
    e.preventDefault();
    document.getElementById('out').textContent = 'Drilled into Petty Cash';
  };
  document.getElementById('final').onclick = () => {
    const v = (id) => document.getElementById(id).value;
    toast(`Saved ${v('hcc')}/${v('lcc')}/${v('gl2')}/${v('desc')} as document 4711`);
  };
}

window.mockRoute = (hash, c) => {
  if (hash === 'BusinessUser-maintain') businessUsers(c);
  else if (hash === 'Test-playground') playground(c);
  else return false;
  return true;
};
