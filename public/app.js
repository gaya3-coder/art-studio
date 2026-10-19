'use strict';
// Plain JavaScript front end. The server is the authority on every rule; this file only
// presents data and shows whatever message the server sends back.

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const state = { token: store.get('token'), user: null, catalog: null, tab: null, reload: () => {}, cache: {} };
const main = $('#main');

// ---------------------------------------------------------------- helpers
async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    if (res.status === 401 && state.token) { signOut(); }
    const err = new Error((data && data.error && data.error.message) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function flash(msg, kind = 'ok') {
  const el = $('#flash');
  el.className = kind;
  el.textContent = msg || '';
}

let viewSeq = 0;
/** Loading / empty / error states for anything that loads data. */
async function view(el, loader, render, emptyMsg) {
  const seq = ++viewSeq;
  el.dataset.seq = seq;
  el.innerHTML = '<p class="state">Loading…</p>';
  try {
    const data = await loader();
    if (el.dataset.seq != seq) return; // a newer load replaced this one
    if (Array.isArray(data) && data.length === 0) { el.innerHTML = `<p class="state">${esc(emptyMsg)}</p>`; return; }
    el.innerHTML = render(data);
  } catch (e) {
    if (el.dataset.seq != seq) return;
    el.innerHTML = `<p class="state error">${esc(e.message)} <button class="btn ghost" data-retry>Retry</button></p>`;
    $('[data-retry]', el).onclick = () => view(el, loader, render, emptyMsg);
  }
}

const dayDiff = (fromStr, toStr) => Math.round((Date.parse(toStr + 'T00:00:00Z') - Date.parse(fromStr + 'T00:00:00Z')) / 86400000);
const addDays = (str, n) => new Date(Date.parse(str + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const badge = (s) => `<span class="badge ${esc(s)}">${esc(s)}</span>`;
const isAdmin = () => state.user.role === 'admin';

function field(label, name, value = '', attrs = '') {
  return `<label>${esc(label)}<input name="${name}" value="${esc(value)}" ${attrs}></label>`;
}
function select(label, name, options, value) {
  const opts = options.map((o) => `<option value="${esc(o.id)}" ${o.id === value ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
  return `<label>${esc(label)}<select name="${name}" required>${opts}</select></label>`;
}

function openDialog(title, fieldsHtml, onSubmit) {
  const dlg = $('#dlg');
  const form = $('#dlgForm');
  form.innerHTML = `<h2>${esc(title)}</h2>${fieldsHtml}<p id="dlgErr" class="hint" style="color:var(--bad)"></p>
    <div class="row"><button type="button" class="btn ghost" id="dlgCancel">Close</button><button class="btn">Save</button></div>`;
  $('#dlgCancel').onclick = () => dlg.close();
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await onSubmit(Object.fromEntries(new FormData(form)));
      dlg.close();
    } catch (e) { $('#dlgErr').textContent = e.message; }
  };
  dlg.showModal();
}

/** Run a server action, show its result, then reload the list on screen (success or failure). */
async function act(fn, okMsg) {
  try { await fn(); flash(okMsg, 'ok'); } catch (e) { flash(e.message, 'err'); }
  state.reload();
}

// ---------------------------------------------------------------- auth screen
function signOut() {
  state.token = null; state.user = null;
  store.set('token', null);
  showAuth();
}
function showAuth(msg) {
  $('#nav').innerHTML = ''; $('#who').innerHTML = '';
  flash(msg || '', 'err');
  main.innerHTML = `<div class="auth">
    <form class="stack" id="loginForm"><h2>Log in</h2>
      ${field('Email', 'email', '', 'type="email" required autocomplete="username"')}
      ${field('Password', 'password', '', 'type="password" required autocomplete="current-password"')}
      <button class="btn">Log in</button></form>
    <form class="stack" id="regForm"><h2>New customer? Sign up</h2>
      ${field('Name', 'name', '', 'required maxlength="80"')}
      ${field('Email', 'email', '', 'type="email" required')}
      ${field('Password (6+ characters)', 'password', '', 'type="password" required minlength="6" autocomplete="new-password"')}
      <button class="btn">Create account</button></form>
    <p class="demo">Studio (admin) demo login: <b>studio@artstudio.in</b> / <b>Studio@123</b></p></div>`;
  const submit = (id, path) => $(id).onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const r = await api(path, { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) });
      state.token = r.token; store.set('token', r.token);
      flash('');
      await start();
    } catch (e) { flash(e.message, 'err'); }
  };
  submit('#loginForm', '/auth/login');
  submit('#regForm', '/auth/register');
}

// ---------------------------------------------------------------- shell
const TABS = {
  customer: [['paintings', 'Paintings'], ['orders', 'My orders'], ['bookings', 'Book a wall'], ['pottery', 'Custom pottery']],
  admin: [['paintings', 'Paintings'], ['orders', 'Orders'], ['bookings', 'Wall bookings'], ['pottery', 'Pottery requests']],
};
const PAGES = { paintings: pagePaintings, orders: pageOrders, bookings: pageBookings, pottery: pagePottery };

function show(tab) {
  state.tab = tab;
  flash('');
  $('#nav').innerHTML = TABS[state.user.role]
    .map(([id, label]) => `<button data-tab="${id}" ${id === tab ? 'aria-current="page"' : ''}>${label}</button>`).join('');
  PAGES[tab]();
}

async function start() {
  if (!state.token) return showAuth();
  main.innerHTML = '<p class="state">Loading…</p>';
  try {
    state.user = (await api('/auth/me')).user;
    state.catalog = await api('/catalog');
  } catch (e) {
    if (e.status === 401) return; // signOut() already showed the login screen
    main.innerHTML = `<p class="state error">${esc(e.message)} <button class="btn ghost" onclick="start()">Retry</button></p>`;
    return;
  }
  $('#who').innerHTML = `${esc(state.user.name)} (${esc(state.user.role)}) <button class="btn ghost" id="logout">Log out</button>`;
  $('#logout').onclick = async () => { try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ } signOut(); };
  show('paintings');
}

document.addEventListener('click', (ev) => {
  const tab = ev.target.closest('[data-tab]');
  if (tab) return show(tab.dataset.tab);
  const b = ev.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const id = b.dataset.id;
  const A = {
    'buy': () => confirm('Buy this painting?') && act(() => api('/orders', { method: 'POST', body: { paintingId: id } }), 'Order placed. The painting is yours.'),
    'cancel-order': () => confirm('Cancel this order? The painting goes back on sale.') && act(() => api(`/orders/${id}/cancel`, { method: 'POST' }), 'Order cancelled.'),
    'cancel-booking': () => confirm('Cancel this booking?') && act(() => api(`/bookings/${id}/cancel`, { method: 'POST' }), 'Booking cancelled.'),
    'confirm-booking': () => act(() => api(`/bookings/${id}/confirm`, { method: 'POST' }), 'Booking confirmed.'),
    'decline-booking': () => act(() => api(`/bookings/${id}/decline`, { method: 'POST' }), 'Booking declined.'),
    'cancel-pottery': () => confirm('Cancel this request?') && act(() => api(`/pottery/${id}/cancel`, { method: 'POST' }), 'Request cancelled.'),
    'accept-pottery': () => act(() => api(`/pottery/${id}/accept`, { method: 'POST' }), 'Request accepted.'),
    'decline-pottery': () => act(() => api(`/pottery/${id}/decline`, { method: 'POST' }), 'Request declined.'),
    'edit-painting': () => editPainting(id),
    'edit-pottery': () => editPottery(id),
  };
  if (A[b.dataset.act]) A[b.dataset.act]();
});

// ---------------------------------------------------------------- paintings
function paintingForm(p = {}) {
  return `${field('Title', 'title', p.title, 'required maxlength="300"')}
    ${field('Artist', 'artist', p.artist, 'required maxlength="120"')}
    ${field('Price (INR)', 'price', p.price, 'type="number" min="1" step="any" required')}
    <label>Description<textarea name="description" rows="3" maxlength="2000">${esc(p.description || '')}</textarea></label>
    ${field('Image path or URL (optional)', 'imageUrl', p.imageUrl, 'placeholder="/images/p-001.jpg"')}`;
}
function pagePaintings() {
  main.innerHTML = `<h2>Paintings</h2>
    ${isAdmin() ? `<details style="margin-bottom:16px"><summary class="btn ghost" style="display:inline-block">Add a painting</summary>
      <form class="stack" id="addPainting" style="margin-top:10px">${paintingForm()}<button class="btn">Add painting</button></form></details>` : ''}
    <div id="list"></div>`;
  const list = $('#list');
  state.reload = () => view(list, () => api('/paintings'), (rows) => {
    state.cache.paintings = Object.fromEntries(rows.map((p) => [p.id, p]));
    return `<div class="grid">${rows.map(paintingCard).join('')}</div>`;
  }, 'There are no paintings yet.');
  state.reload();
  if (isAdmin()) $('#addPainting').onsubmit = async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    try {
      await api('/paintings', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      form.reset(); flash('Painting added.', 'ok');
    } catch (e) { flash(e.message, 'err'); }
    state.reload();
  };
}
function paintingCard(p) {
  const avail = p.status === 'available';
  let action = '';
  if (avail && !isAdmin()) action = `<button class="btn" data-act="buy" data-id="${esc(p.id)}">Buy</button>`;
  if (avail && isAdmin()) action = `<button class="btn ghost" data-act="edit-painting" data-id="${esc(p.id)}">Edit</button>`;
  return `<article class="card">
    ${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="${esc(p.title)}" loading="lazy">` : ''}
    <div class="body"><h3 title="${esc(p.title)}">${esc(p.title)}</h3>
      <div>${esc(p.artist)}</div>
      <div><span class="price">${money(p.price)}</span> ${badge(p.status)}</div>
      ${p.description ? `<details><summary>Details</summary>${esc(p.description)}</details>` : ''}
      ${action}</div></article>`;
}
function editPainting(id) {
  const p = state.cache.paintings[id];
  openDialog('Edit painting', paintingForm(p), async (v) => {
    await api(`/paintings/${id}`, { method: 'PATCH', body: v });
    flash('Painting updated.', 'ok');
    state.reload();
  });
}

// ---------------------------------------------------------------- orders
function pageOrders() {
  main.innerHTML = `<h2>${isAdmin() ? 'All orders' : 'My orders'}</h2><div id="list"></div>`;
  state.reload = () => view($('#list'), () => api('/orders'), (rows) => `<div class="table-wrap"><table>
    <tr><th>#</th><th>Painting</th>${isAdmin() ? '<th>Customer</th>' : ''}<th>Price</th><th>Status</th><th>Placed</th><th></th></tr>
    ${rows.map((o) => `<tr><td>${o.id}</td><td>${esc(o.painting.title)}<br><small>${esc(o.painting.artist)}</small></td>
      ${isAdmin() ? `<td>${esc(o.customer.name)}<br><small>${esc(o.customer.email)}</small></td>` : ''}
      <td>${money(o.price)}</td><td>${badge(o.status)}</td><td>${esc(o.createdAt)}</td>
      <td class="actions">${!isAdmin() && o.status === 'placed' ? `<button class="btn danger" data-act="cancel-order" data-id="${o.id}">Cancel</button>` : ''}</td></tr>`).join('')}
    </table></div>`, isAdmin() ? 'No orders yet.' : 'You have not bought a painting yet. Browse the Paintings tab.');
  state.reload();
}

// ---------------------------------------------------------------- wall bookings
function pageBookings() {
  const c = state.catalog, R = c.rules.booking;
  main.innerHTML = `<h2>${isAdmin() ? 'Wall bookings' : 'Book a wall painting'}</h2>
    ${isAdmin() ? '' : `<form class="stack" id="bookForm">
      ${field('Date', 'date', '', `type="date" required min="${addDays(c.today, R.minDays)}" max="${addDays(c.today, R.maxDays)}"`)}
      <p class="hint">Choose a date from ${R.minDays} to ${R.maxDays} days away. Each date can be booked only once.</p>
      ${field('Wall size (sq ft)', 'wallSizeSqFt', '', `type="number" min="${R.minSqFt}" max="${R.maxSqFt}" step="any" required`)}
      ${field('Address', 'address', '', 'required minlength="5" maxlength="300"')}
      <p class="hint">Rate: ${money(c.ratePerSqFt)} per sq ft. Estimated price: <b id="est">–</b></p>
      <p class="hint" id="taken"></p>
      <button class="btn">Request booking</button></form>`}
    <h3>${isAdmin() ? 'All bookings' : 'My bookings'}</h3><div id="list"></div>`;
  state.reload = () => {
    view($('#list'), () => api('/bookings'), (rows) => `<div class="table-wrap"><table>
      <tr><th>#</th><th>Date</th><th>Wall</th><th>Address</th>${isAdmin() ? '<th>Customer</th>' : ''}<th>Price</th><th>Status</th><th></th></tr>
      ${rows.map((b) => {
        const live = b.status === 'requested' || b.status === 'confirmed';
        const late = dayDiff(c.today, b.date) < R.cancelBeforeDays;
        let actions = '';
        if (isAdmin() && b.status === 'requested') actions = `<button class="btn" data-act="confirm-booking" data-id="${b.id}">Confirm</button>
          <button class="btn danger" data-act="decline-booking" data-id="${b.id}">Decline</button>`;
        if (!isAdmin() && live) actions = `<button class="btn danger" data-act="cancel-booking" data-id="${b.id}" ${late ? `disabled title="Can only be cancelled until ${R.cancelBeforeDays} days before the date"` : ''}>Cancel</button>`;
        return `<tr><td>${b.id}</td><td>${esc(b.date)}</td><td>${esc(b.wallSizeSqFt)} sq ft</td><td>${esc(b.address)}</td>
          ${isAdmin() ? `<td>${esc(b.customer.name)}<br><small>${esc(b.customer.email)}</small></td>` : ''}
          <td>${money(b.price)}</td><td>${badge(b.status)}</td><td class="actions">${actions}</td></tr>`;
      }).join('')}</table></div>`, isAdmin() ? 'No bookings yet.' : 'You have no bookings yet.');
    if (!isAdmin()) loadTaken();
  };
  async function loadTaken() {
    const el = $('#taken');
    try {
      const dates = await api('/bookings/taken-dates');
      el.textContent = dates.length ? 'Already booked: ' + dates.join(', ') : 'No dates are booked yet.';
    } catch (e) { el.textContent = 'Could not load booked dates: ' + e.message; }
  }
  state.reload();
  if (isAdmin()) return;
  const form = $('#bookForm');
  const est = () => {
    const n = Number(form.wallSizeSqFt.value);
    $('#est').textContent = n >= R.minSqFt && n <= R.maxSqFt ? money(Math.round(n * c.ratePerSqFt * 100) / 100) : '–';
  };
  form.wallSizeSqFt.oninput = est;
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await api('/bookings', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      form.reset(); est(); flash('Booking requested. The studio will confirm or decline it.', 'ok');
    } catch (e) { flash(e.message, 'err'); }
    state.reload();
  };
}

// ---------------------------------------------------------------- pottery
function potteryFields(r = {}, editing = false) {
  const c = state.catalog, R = c.rules.pottery;
  return `${select('Item', 'itemId', c.potteryItems, r.itemId)}
    ${select('Glaze', 'glazeId', c.glazes, r.glazeId)}
    ${field('Quantity', 'quantity', r.quantity, `type="number" min="${R.minQty}" max="${R.maxQty}" step="1" required`)}
    ${field('Needed by', 'neededBy', r.neededBy, `type="date" required ${editing ? '' : `min="${addDays(c.today, R.minDays)}"`}`)}
    <p class="hint">Quantity ${R.minQty}–${R.maxQty}. Needed-by date at least ${R.minDays} days away.</p>`;
}
function pagePottery() {
  main.innerHTML = `<h2>${isAdmin() ? 'Pottery requests' : 'Custom pottery'}</h2>
    ${isAdmin() ? '' : `<form class="stack" id="potForm">${potteryFields()}<button class="btn">Send request</button></form>`}
    <h3>${isAdmin() ? 'All requests' : 'My requests'}</h3><div id="list"></div>`;
  state.reload = () => view($('#list'), () => api('/pottery'), (rows) => {
    state.cache.pottery = Object.fromEntries(rows.map((r) => [r.id, r]));
    return `<div class="table-wrap"><table>
      <tr><th>#</th><th>Item</th><th>Glaze</th><th>Qty</th><th>Needed by</th>${isAdmin() ? '<th>Customer</th>' : ''}<th>Status</th><th></th></tr>
      ${rows.map((r) => {
        let actions = '';
        if (isAdmin() && r.status === 'requested') actions = `<button class="btn" data-act="accept-pottery" data-id="${r.id}">Accept</button>
          <button class="btn danger" data-act="decline-pottery" data-id="${r.id}">Decline</button>`;
        if (!isAdmin() && r.status === 'requested') actions = `<button class="btn ghost" data-act="edit-pottery" data-id="${r.id}">Edit</button>
          <button class="btn danger" data-act="cancel-pottery" data-id="${r.id}">Cancel</button>`;
        return `<tr><td>${r.id}</td><td>${esc(r.itemName)}</td><td>${esc(r.glazeName)}</td><td>${r.quantity}</td><td>${esc(r.neededBy)}</td>
          ${isAdmin() ? `<td>${esc(r.customer.name)}<br><small>${esc(r.customer.email)}</small></td>` : ''}
          <td>${badge(r.status)}</td><td class="actions">${actions}</td></tr>`;
      }).join('')}</table></div>`;
  }, isAdmin() ? 'No pottery requests yet.' : 'You have not made a pottery request yet.');
  state.reload();
  if (!isAdmin()) $('#potForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    try {
      await api('/pottery', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      form.reset(); flash('Request sent. The studio will accept or decline it.', 'ok');
    } catch (e) { flash(e.message, 'err'); }
    state.reload();
  };
}
function editPottery(id) {
  const r = state.cache.pottery[id];
  openDialog('Edit pottery request', potteryFields(r, true), async (v) => {
    // Send only what changed, so an unchanged (now close) needed-by date is not re-validated.
    const changed = {};
    if (v.itemId !== r.itemId) changed.itemId = v.itemId;
    if (v.glazeId !== r.glazeId) changed.glazeId = v.glazeId;
    if (Number(v.quantity) !== r.quantity) changed.quantity = v.quantity;
    if (v.neededBy !== r.neededBy) changed.neededBy = v.neededBy;
    await api(`/pottery/${id}`, { method: 'PATCH', body: changed });
    flash('Request updated.', 'ok');
    state.reload();
  });
}

start();
