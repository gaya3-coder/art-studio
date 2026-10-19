
'use strict';

// Art Studio frontend.
// The server remains the authority for authentication, orders and bookings.

const $ = (s, r = document) => r.querySelector(s);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

const money = (n) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(n);

const store = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try {
      v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
    } catch {}
  },
};

const state = {
  token: store.get('token'),
  user: null,
  catalog: null,
  tab: null,
  reload: () => {},
  cache: {},
};

const main = $('#main');

const IMAGE_PATHS = {
  wall: '/images/book-wall-painting.jpg',
  pottery: '/images/custom-pottery.jpg',
};

// ----------------------------------------------------------------
// API helpers

async function api(path, { method = 'GET', body } = {}) {
  let res;

  try {
    res = await fetch('/api' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token
          ? { Authorization: 'Bearer ' + state.token }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(
      'Could not reach the server. Check your connection and try again.'
    );
  }

  let data = null;
  try {
    data = await res.json();
  } catch {}

  if (!res.ok) {
    if (res.status === 401 && state.token) signOut();

    const err = new Error(
      (data && data.error && data.error.message) ||
      `Request failed (${res.status})`
    );

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

async function view(el, loader, render, emptyMsg) {
  const seq = ++viewSeq;
  el.dataset.seq = seq;
  el.innerHTML = '<p class="state">Loading…</p>';

  try {
    const data = await loader();

    if (el.dataset.seq != seq) return;

    if (Array.isArray(data) && data.length === 0) {
      el.innerHTML = `<p class="state">${esc(emptyMsg)}</p>`;
      return;
    }

    el.innerHTML = render(data);
  } catch (e) {
    if (el.dataset.seq != seq) return;

    el.innerHTML = `
      <div class="state error">
        ${esc(e.message)}
        <button class="btn ghost" data-retry>Retry</button>
      </div>`;

    $('[data-retry]', el).onclick = () =>
      view(el, loader, render, emptyMsg);
  }
}

const dayDiff = (fromStr, toStr) =>
  Math.round(
    (Date.parse(toStr + 'T00:00:00Z') -
      Date.parse(fromStr + 'T00:00:00Z')) / 86400000
  );

const addDays = (str, n) =>
  new Date(
    Date.parse(str + 'T00:00:00Z') + n * 86400000
  ).toISOString().slice(0, 10);

const badge = (s) =>
  `<span class="badge ${esc(s)}">${esc(s)}</span>`;

const isAdmin = () => state.user?.role === 'admin';

function field(label, name, value = '', attrs = '') {
  return `
    <label>
      ${esc(label)}
      <input name="${esc(name)}" value="${esc(value)}" ${attrs}>
    </label>`;
}

function select(label, name, options, value) {
  const opts = options.map((o) => `
    <option value="${esc(o.id)}"
      ${String(o.id) === String(value) ? 'selected' : ''}>
      ${esc(o.name)}
    </option>`).join('');

  return `
    <label>
      ${esc(label)}
      <select name="${esc(name)}" required>${opts}</select>
    </label>`;
}

// ----------------------------------------------------------------
// Password visibility

function addPasswordToggles(root) {
  root.querySelectorAll('input[type="password"]').forEach((input) => {
    if (input.dataset.toggleAdded) return;
    input.dataset.toggleAdded = 'true';

    const wrapper = document.createElement('div');
    wrapper.className = 'password-wrap';
    wrapper.style.position = 'relative';
    wrapper.style.width = '100%';

    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);

    input.style.paddingRight = '48px';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'password-toggle';
    toggle.setAttribute('aria-label', 'Show password');
    toggle.setAttribute('aria-pressed', 'false');
    toggle.title = 'Show password';
    toggle.textContent = 'Show';

    Object.assign(toggle.style, {
      position: 'absolute',
      right: '8px',
      top: '50%',
      transform: 'translateY(-50%)',
      border: '0',
      background: 'transparent',
      color: 'var(--accent)',
      cursor: 'pointer',
      fontSize: '0.8rem',
      fontWeight: '600',
      padding: '6px',
      width: 'auto',
    });

    toggle.addEventListener('click', () => {
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      toggle.textContent = visible ? 'Hide' : 'Show';
      toggle.title = visible ? 'Hide password' : 'Show password';
      toggle.setAttribute('aria-label', toggle.title);
      toggle.setAttribute('aria-pressed', String(visible));
    });

    wrapper.appendChild(toggle);
  });
}

// ----------------------------------------------------------------
// Image preview modal

function ensureImageDialog() {
  let dlg = $('#paintingPreview');

  if (dlg) return dlg;

  dlg = document.createElement('dialog');
  dlg.id = 'paintingPreview';
  dlg.className = 'painting-preview';

  dlg.innerHTML = `
    <div class="preview-inner">
      <button type="button" class="preview-close"
        aria-label="Close image preview" title="Close">×</button>
      <img class="preview-image" alt="">
      <h2 class="preview-title"></h2>
      <p class="preview-description"></p>
    </div>`;

  document.body.appendChild(dlg);

  const close = $('.preview-close', dlg);
  close.addEventListener('click', () => dlg.close());

  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) dlg.close();
  });

  dlg.addEventListener('close', () => {
    const img = $('.preview-image', dlg);
    img.removeAttribute('src');
  });

  return dlg;
}

function showPaintingPreview(p) {
  if (!p?.imageUrl) {
    flash('This painting does not have an image yet.', 'err');
    return;
  }

  const dlg = ensureImageDialog();
  const img = $('.preview-image', dlg);

  img.src = p.imageUrl;
  img.alt = p.title || 'Painting preview';

  $('.preview-title', dlg).textContent = p.title || '';
  $('.preview-description', dlg).textContent =
    [p.artist, p.description].filter(Boolean).join(' — ');

  if (!dlg.open) dlg.showModal();
}

// ----------------------------------------------------------------
// Shared dialog

function openDialog(title, fieldsHtml, onSubmit) {
  const dlg = $('#dlg');
  const form = $('#dlgForm');

  form.innerHTML = `
    <h2>${esc(title)}</h2>
    ${fieldsHtml}
    <p id="dlgErr" class="hint" style="color:var(--bad)"></p>
    <div class="row">
      <button type="button" class="btn ghost" id="dlgCancel">Close</button>
      <button class="btn">Save</button>
    </div>`;

  addPasswordToggles(form);

  $('#dlgCancel').onclick = () => dlg.close();

  form.onsubmit = async (ev) => {
    ev.preventDefault();

    try {
      await onSubmit(Object.fromEntries(new FormData(form)));
      dlg.close();
    } catch (e) {
      $('#dlgErr').textContent = e.message;
    }
  };

  dlg.showModal();
}

async function act(fn, okMsg) {
  try {
    await fn();
    flash(okMsg, 'ok');
  } catch (e) {
    flash(e.message, 'err');
  }

  state.reload();
}

// ----------------------------------------------------------------
// Authentication

function signOut() {
  state.token = null;
  state.user = null;
  store.set('token', null);
  showAuth();
}

function showAuth(msg) {
  $('#nav').innerHTML = '';
  $('#who').innerHTML = '';

  flash(msg || '', msg ? 'err' : '');

  main.innerHTML = `
    <section class="auth">
      <form class="stack" id="loginForm">
        <h2>Welcome back</h2>
        <p class="hint">Log in to explore the Art Studio collection.</p>

        ${field(
          'Email',
          'email',
          '',
          'type="email" required autocomplete="username"'
        )}

        ${field(
          'Password',
          'password',
          '',
          'type="password" required autocomplete="current-password"'
        )}

        <button class="btn">Log in</button>
      </form>

      <form class="stack" id="regForm">
        <h2>Create your account</h2>
        <p class="hint">Join us and discover art made with care.</p>

        ${field('Name', 'name', '', 'required maxlength="80"')}

        ${field(
          'Email',
          'email',
          '',
          'type="email" required autocomplete="email"'
        )}

        ${field(
          'Password (6+ characters)',
          'password',
          '',
          'type="password" required minlength="6" autocomplete="new-password"'
        )}

        <button class="btn">Create account</button>
      </form>
    </section>

    <p class="demo">
      Studio admin demo login:
      <b>studio@artstudio.in</b>
      <span aria-hidden="true"> / </span>
      <b>Studio@123</b>
    </p>`;

  addPasswordToggles(main);

  const submit = (id, path) => {
    $(id).onsubmit = async (ev) => {
      ev.preventDefault();

      const form = ev.currentTarget;
      const button = $('button[type="submit"]', form) ||
        $('button:not([type])', form);

      if (button) button.disabled = true;

      try {
        const r = await api(path, {
          method: 'POST',
          body: Object.fromEntries(new FormData(form)),
        });

        state.token = r.token;
        store.set('token', r.token);
        flash('');
        await start();
      } catch (e) {
        flash(e.message, 'err');
      } finally {
        if (button && button.isConnected) button.disabled = false;
      }
    };
  };

  submit('#loginForm', '/auth/login');
  submit('#regForm', '/auth/register');
}

// ----------------------------------------------------------------
// Navigation

const TABS = {
  customer: [
    ['paintings', 'Paintings'],
    ['orders', 'My orders'],
    ['bookings', 'Book a wall'],
    ['pottery', 'Custom pottery'],
  ],
  admin: [
    ['paintings', 'Paintings'],
    ['orders', 'Orders'],
    ['bookings', 'Wall bookings'],
    ['pottery', 'Pottery requests'],
  ],
};

const PAGES = {
  paintings: pagePaintings,
  orders: pageOrders,
  bookings: pageBookings,
  pottery: pagePottery,
};

function show(tab) {
  state.tab = tab;
  flash('');

  $('#nav').innerHTML = TABS[state.user.role]
    .map(([id, label]) => `
      <button data-tab="${id}"
        ${id === tab ? 'aria-current="page"' : ''}>
        ${label}
      </button>`)
    .join('');

  PAGES[tab]();
}

async function start() {
  if (!state.token) return showAuth();

  main.innerHTML = '<p class="state">Loading…</p>';

  try {
    state.user = (await api('/auth/me')).user;
    state.catalog = await api('/catalog');
  } catch (e) {
    if (e.status === 401) return;

    main.innerHTML = `
      <div class="state error">
        ${esc(e.message)}
        <button class="btn ghost" id="startRetry">Retry</button>
      </div>`;

    $('#startRetry').onclick = start;
    return;
  }

  $('#who').innerHTML = `
    <span class="user-details">
      ${esc(state.user.name)} (${esc(state.user.role)})
    </span>
    <button class="btn ghost" id="logout">Log out</button>`;

  $('#logout').onclick = async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {}

    signOut();
  };

  show('paintings');
}

// ----------------------------------------------------------------
// Global click actions

document.addEventListener('click', (ev) => {
  const tab = ev.target.closest('[data-tab]');

  if (tab) return show(tab.dataset.tab);

  const image = ev.target.closest('[data-painting-preview]');

  if (image) {
    const p = state.cache.paintings?.[image.dataset.paintingPreview];
    if (p) showPaintingPreview(p);
    return;
  }

  const button = ev.target.closest('[data-act]');

  if (!button || button.disabled) return;

  const id = button.dataset.id;

  const actions = {
    buy: () => {
      if (!confirm('Buy this painting?')) return;

      return act(
        () => api('/orders', {
          method: 'POST',
          body: { paintingId: id },
        }),
        'Order placed. The painting is yours.'
      );
    },

    'notify-interest': () => {
      const key = 'artstudio-interest';
      let interests = [];

      try {
        interests = JSON.parse(store.get(key) || '[]');
        if (!Array.isArray(interests)) interests = [];
      } catch {
        interests = [];
      }

      if (!interests.includes(String(id))) {
        interests.push(String(id));
        store.set(key, JSON.stringify(interests));
      }

      button.textContent = 'Interest Saved';
      button.disabled = true;

      flash(
        'Your interest is saved in this browser. Automatic notifications are not configured yet.',
        'ok'
      );
    },

    'cancel-order': () => {
      if (!confirm('Cancel this order? The painting goes back on sale.')) return;

      return act(
        () => api(`/orders/${id}/cancel`, { method: 'POST' }),
        'Order cancelled.'
      );
    },

    'cancel-booking': () => {
      if (!confirm('Cancel this booking?')) return;

      return act(
        () => api(`/bookings/${id}/cancel`, { method: 'POST' }),
        'Booking cancelled.'
      );
    },

    'confirm-booking': () =>
      act(
        () => api(`/bookings/${id}/confirm`, { method: 'POST' }),
        'Booking confirmed.'
      ),

    'decline-booking': () =>
      act(
        () => api(`/bookings/${id}/decline`, { method: 'POST' }),
        'Booking declined.'
      ),

    'cancel-pottery': () => {
      if (!confirm('Cancel this request?')) return;

      return act(
        () => api(`/pottery/${id}/cancel`, { method: 'POST' }),
        'Request cancelled.'
      );
    },

    'accept-pottery': () =>
      act(
        () => api(`/pottery/${id}/accept`, { method: 'POST' }),
        'Request accepted.'
      ),

    'decline-pottery': () =>
      act(
        () => api(`/pottery/${id}/decline`, { method: 'POST' }),
        'Request declined.'
      ),
      
    'edit-painting': () => editPainting(id),
    'delete-painting': async () => {
      if (!confirm('Are you sure you want to delete this painting?')) return;

      try {
        await api(`/api/paintings/${encodeURIComponent(id)}`, {
          method: 'DELETE'
        });
        await render();
        alert('Painting deleted successfully.');
      } catch (err) {
        alert(err.message || 'Could not delete painting.');
      }
    },
    'edit-pottery': () => editPottery(id),
  };


  if (actions[button.dataset.act]) actions[button.dataset.act]();
});

// Close the enlarged painting view with Escape.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;

  const dlg = $('#paintingPreview');
  if (dlg?.open) dlg.close();
});

// ----------------------------------------------------------------
// Paintings

function paintingForm(p = {}) {
  return `
    ${field('Title', 'title', p.title, 'required maxlength="300"')}
    ${field('Artist', 'artist', p.artist, 'required maxlength="120"')}
    ${field(
      'Price (INR)',
      'price',
      p.price,
      'type="number" min="1" step="any" required'
    )}

    <label>
      Description
      <textarea name="description" rows="3" maxlength="2000">${esc(
        p.description || ''
      )}</textarea>
    </label>

    ${field(
      'Image path or URL (optional)',
      'imageUrl',
      p.imageUrl,
      'placeholder="/images/p-001.jpg"'
    )}`;
}

function pagePaintings() {
  main.innerHTML = `
    <section class="page-heading">
      <p class="eyebrow">THE ART COLLECTION</p>
      <h2>Discover original artwork</h2>
      <p class="hint">Explore paintings made to bring your space to life.</p>
    </section>

    ${isAdmin() ? `
      <details class="admin-add">
        <summary class="btn ghost">Add a painting</summary>
        <form class="stack" id="addPainting" style="margin-top:12px">
          ${paintingForm()}
          <button class="btn">Add painting</button>
        </form>
      </details>` : ''}

    <div id="list"></div>`;

  const list = $('#list');

  state.reload = () => view(
    list,
    () => api('/paintings'),
    (rows) => {
      state.cache.paintings = Object.fromEntries(
        rows.map((p) => [p.id, p])
      );

      return `<div class="grid">${rows.map(paintingCard).join('')}</div>`;
    },
    'There are no paintings yet.'
  );

  state.reload();

  if (isAdmin()) {
    $('#addPainting').onsubmit = async (ev) => {
      ev.preventDefault();

      const form = ev.currentTarget;

      try {
        await api('/paintings', {
          method: 'POST',
          body: Object.fromEntries(new FormData(form)),
        });

        form.reset();
        flash('Painting added.', 'ok');
      } catch (e) {
        flash(e.message, 'err');
      }

      state.reload();
    };
  }
}


function paintingCard(p) {
  const available = p.status === 'available';

  let action = '';

  if (!isAdmin() && available) {
    action = `
      <button class="btn" data-act="buy" data-id="${esc(p.id)}">
        Buy painting
      </button>`;
  } else if (!isAdmin() && !available) {
    const saved = (() => {
      try {
        const items = JSON.parse(store.get('artstudio-interest') || '[]');
        return Array.isArray(items) && items.includes(String(p.id));
      } catch {
        return false;
      }
    })();

    action = `
      <button class="btn ghost" data-act="notify-interest"
        data-id="${esc(p.id)}" ${saved ? 'disabled' : ''}>
        ${saved ? 'Interest Saved' : 'Notify Me When Available'}
      </button>
      <p class="hint">Sold artwork. Save your interest on this browser.</p>`;
  } else {
    action = `
      <button class="btn ghost" data-act="edit-painting"
        data-id="${esc(p.id)}">Edit painting</button>
      ${available ? `
        <button class="btn danger" data-act="delete-painting"
          data-id="${esc(p.id)}">Delete painting</button>
      ` : ''}
    `;
  }

  return `
    <article class="painting-card">
      <img src="${esc(p.imageUrl || '')}" alt="${esc(p.title)}">
      <h3>${esc(p.title)}</h3>
      <p>${esc(p.artist)}</p>
      <p>${esc(p.description || '')}</p>
      <p>₹${Number(p.price).toLocaleString('en-IN')}</p>
      <p>${esc(p.status)}</p>
      <div class="card-actions">${action}</div>
    </article>`;
}


function editPainting(id) {
  const p = state.cache.paintings[id];
  if (!p) return;

  openDialog('Edit painting', paintingForm(p), async (v) => {
    await api(`/paintings/${id}`, {
      method: 'PATCH',
      body: v,
    });

    flash('Painting updated.', 'ok');
    state.reload();
  });
}

// ----------------------------------------------------------------
// Orders

function pageOrders() {
  main.innerHTML = `
    <h2>${isAdmin() ? 'All orders' : 'My orders'}</h2>
    <div id="list"></div>`;

  state.reload = () => view(
    $('#list'),
    () => api('/orders'),
    (rows) => `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Painting</th>
              ${isAdmin() ? '<th>Customer</th>' : ''}
              <th>Price</th>
              <th>Status</th>
              <th>Placed</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((o) => `
              <tr>
                <td>${esc(o.id)}</td>
                <td>
                  ${esc(o.painting.title)}<br>
                  <small>${esc(o.painting.artist)}</small>
                </td>
                ${isAdmin() ? `
                  <td>
                    ${esc(o.customer.name)}<br>
                    <small>${esc(o.customer.email)}</small>
                  </td>` : ''}
                <td>${money(o.price)}</td>
                <td>${badge(o.status)}</td>
                <td>${esc(o.createdAt)}</td>
                <td class="actions">
                  ${!isAdmin() && o.status === 'placed' ? `
                    <button class="btn danger" data-act="cancel-order"
                      data-id="${esc(o.id)}">Cancel</button>` : ''}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`,
    isAdmin()
      ? 'No orders yet.'
      : 'You have not bought a painting yet. Browse the Paintings tab.'
  );

  state.reload();
}

// ----------------------------------------------------------------
// Service section layout

function serviceHero(title, eyebrow, description, imagePath, imageAlt) {
  return `
    <section class="service-hero">
      <div class="service-copy">
        <p class="eyebrow">${esc(eyebrow)}</p>
        <h2>${esc(title)}</h2>
        <p>${esc(description)}</p>
      </div>
      <div class="service-image">
        <img src="${esc(imagePath)}" alt="${esc(imageAlt)}"
          loading="lazy">
      </div>
    </section>`;
}

// ----------------------------------------------------------------
// Wall bookings

function pageBookings() {
  const c = state.catalog;
  const R = c.rules.booking;

  main.innerHTML = `
    ${isAdmin() ? `
      <h2>Wall bookings</h2>` : `
      ${serviceHero(
        'Bring your walls to life',
        'MADE FOR YOUR SPACE',
        'Transform an empty wall into something special with custom artwork designed around your space.',
        IMAGE_PATHS.wall,
        'Hand-painted wall art'
      )}`}

    ${isAdmin() ? '' : `
      <form class="stack service-form" id="bookForm">
        ${field(
          'Date',
          'date',
          '',
          `type="date" required min="${addDays(c.today, R.minDays)}" max="${addDays(c.today, R.maxDays)}"`
        )}

        <p class="hint">
          Choose a date from ${R.minDays} to ${R.maxDays} days away.
          Each date can be booked only once.
        </p>

        ${field(
          'Wall size (sq ft)',
          'wallSizeSqFt',
          '',
          `type="number" min="${R.minSqFt}" max="${R.maxSqFt}" step="any" required`
        )}

        ${field(
          'Address',
          'address',
          '',
          'required minlength="5" maxlength="300"'
        )}

        <p class="hint">
          Rate: ${money(c.ratePerSqFt)} per sq ft.
          Estimated price: <b id="est">–</b>
        </p>

        <p class="hint" id="taken"></p>
        <button class="btn">Request booking</button>
      </form>`}

    <h3>${isAdmin() ? 'All bookings' : 'My bookings'}</h3>
    <div id="list"></div>`;

  state.reload = () => {
    view(
      $('#list'),
      () => api('/bookings'),
      (rows) => `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th><th>Date</th><th>Wall</th><th>Address</th>
                ${isAdmin() ? '<th>Customer</th>' : ''}
                <th>Price</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((b) => {
                const live =
                  b.status === 'requested' || b.status === 'confirmed';
                const late =
                  dayDiff(c.today, b.date) < R.cancelBeforeDays;

                let actions = '';

                if (isAdmin() && b.status === 'requested') {
                  actions = `
                    <button class="btn" data-act="confirm-booking"
                      data-id="${esc(b.id)}">Confirm</button>
                    <button class="btn danger" data-act="decline-booking"
                      data-id="${esc(b.id)}">Decline</button>`;
                }

                if (!isAdmin() && live) {
                  actions = `
                    <button class="btn danger" data-act="cancel-booking"
                      data-id="${esc(b.id)}"
                      ${late ? `disabled title="Cancellation deadline passed"` : ''}>
                      Cancel
                    </button>`;
                }

                return `
                  <tr>
                    <td>${esc(b.id)}</td>
                    <td>${esc(b.date)}</td>
                    <td>${esc(b.wallSizeSqFt)} sq ft</td>
                    <td>${esc(b.address)}</td>
                    ${isAdmin() ? `
                      <td>
                        ${esc(b.customer.name)}<br>
                        <small>${esc(b.customer.email)}</small>
                      </td>` : ''}
                    <td>${money(b.price)}</td>
                    <td>${badge(b.status)}</td>
                    <td class="actions">${actions}</td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`,
      isAdmin() ? 'No bookings yet.' : 'You have no bookings yet.'
    );

    if (!isAdmin()) loadTaken();
  };

  async function loadTaken() {
    const el = $('#taken');

    try {
      const dates = await api('/bookings/taken-dates');

      if (el) {
        el.textContent = dates.length
          ? 'Already booked: ' + dates.join(', ')
          : 'No dates are booked yet.';
      }
    } catch (e) {
      if (el) el.textContent = 'Could not load booked dates: ' + e.message;
    }
  }

  state.reload();

  if (isAdmin()) return;

  const form = $('#bookForm');

  const estimate = () => {
    const n = Number(form.wallSizeSqFt.value);

    $('#est').textContent =
      n >= R.minSqFt && n <= R.maxSqFt
        ? money(Math.round(n * c.ratePerSqFt * 100) / 100)
        : '–';
  };

  form.wallSizeSqFt.oninput = estimate;

  form.onsubmit = async (ev) => {
    ev.preventDefault();

    try {
      await api('/bookings', {
        method: 'POST',
        body: Object.fromEntries(new FormData(form)),
      });

      form.reset();
      estimate();
      flash(
        'Booking requested. The studio will confirm or decline it.',
        'ok'
      );
    } catch (e) {
      flash(e.message, 'err');
    }

    state.reload();
  };
}

// ----------------------------------------------------------------
// Custom pottery

function potteryFields(r = {}, editing = false) {
  const c = state.catalog;
  const R = c.rules.pottery;

  return `
    ${select('Item', 'itemId', c.potteryItems, r.itemId)}
    ${select('Glaze', 'glazeId', c.glazes, r.glazeId)}

    ${field(
      'Quantity',
      'quantity',
      r.quantity,
      `type="number" min="${R.minQty}" max="${R.maxQty}" step="1" required`
    )}

    ${field(
      'Needed by',
      'neededBy',
      r.neededBy,
      `type="date" required ${editing ? '' : `min="${addDays(c.today, R.minDays)}"`}`
    )}

    <p class="hint">
      Quantity ${R.minQty}–${R.maxQty}.
      Needed-by date at least ${R.minDays} days away.
    </p>`;
}

function pagePottery() {
  main.innerHTML = `
    ${isAdmin() ? `
      <h2>Pottery requests</h2>` : `
      ${serviceHero(
        'Made by hand, made for you',
        'THE POTTERY STUDIO',
        'Explore custom pottery and request handmade pieces in your preferred glaze and quantity.',
        IMAGE_PATHS.pottery,
        'Handmade pottery and ceramic pieces'
      )}`}

    ${isAdmin() ? '' : `
      <form class="stack service-form" id="potForm">
        ${potteryFields()}
        <button class="btn">Send request</button>
      </form>`}

    <h3>${isAdmin() ? 'All requests' : 'My requests'}</h3>
    <div id="list"></div>`;

  state.reload = () => view(
    $('#list'),
    () => api('/pottery'),
    (rows) => {
      state.cache.pottery = Object.fromEntries(
        rows.map((r) => [r.id, r])
      );

      return `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Item</th>
                <th>Glaze</th>
                <th>Qty</th>
                <th>Needed by</th>
                ${isAdmin() ? '<th>Customer</th>' : ''}
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((r) => {
                let actions = '';

                if (isAdmin() && r.status === 'requested') {
                  actions = `
                    <button class="btn"
                      data-act="accept-pottery"
                      data-id="${esc(r.id)}">Accept</button>
                    <button class="btn danger"
                      data-act="decline-pottery"
                      data-id="${esc(r.id)}">Decline</button>`;
                }

                if (!isAdmin() && r.status === 'requested') {
                  actions = `
                    <button class="btn ghost"
                      data-act="edit-pottery"
                      data-id="${esc(r.id)}">Edit</button>
                    <button class="btn danger"
                      data-act="cancel-pottery"
                      data-id="${esc(r.id)}">Cancel</button>`;
                }

                return `
                  <tr>
                    <td>${esc(r.id)}</td>
                    <td>${esc(r.itemName)}</td>
                    <td>${esc(r.glazeName)}</td>
                    <td>${esc(r.quantity)}</td>
                    <td>${esc(r.neededBy)}</td>
                    ${isAdmin() ? `
                      <td>
                        ${esc(r.customer.name)}<br>
                        <small>${esc(r.customer.email)}</small>
                      </td>` : ''}
                    <td>${badge(r.status)}</td>
                    <td class="actions">${actions}</td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`;
    },
    isAdmin()
      ? 'No pottery requests yet.'
      : 'You have not made a pottery request yet.'
  );

  state.reload();

  if (isAdmin()) return;

  const form = $('#potForm');

  form.onsubmit = async (ev) => {
    ev.preventDefault();

    try {
      await api('/pottery', {
        method: 'POST',
        body: Object.fromEntries(new FormData(form)),
      });

      form.reset();

      flash(
        'Request sent. The studio will accept or decline it.',
        'ok'
      );
    } catch (e) {
      flash(e.message, 'err');
    }

    state.reload();
  };
}
function editPottery(id) {
  const r = state.cache.pottery[id];
  if (!r) return;

  openDialog('Edit pottery request', potteryFields(r, true), async (v) => {
    const changed = {};

    if (v.itemId !== String(r.itemId)) changed.itemId = v.itemId;
    if (v.glazeId !== String(r.glazeId)) changed.glazeId = v.glazeId;
    if (Number(v.quantity) !== r.quantity) changed.quantity = v.quantity;
    if (v.neededBy !== r.neededBy) changed.neededBy = v.neededBy;

    await api(`/pottery/${id}`, {
      method: 'PATCH',
      body: changed,
    });

    flash('Request updated.', 'ok');
    state.reload();
  });
}

// ----------------------------------------------------------------
// Start the application

start();
