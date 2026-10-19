'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { openDb, seedIfEmpty } = require('./db');
const U = require('./util');
const { HttpError, bad, conflict, notFound, str, num } = U;

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// Business rules from the brief, in one place.
const RULES = {
  booking: { minDays: 7, maxDays: 90, minSqFt: 10, maxSqFt: 500, cancelBeforeDays: 3 },
  pottery: { minQty: 1, maxQty: 12, minDays: 14 },
};

function loadEnvFile() {
  // Tiny .env loader so we need no dependency. Real environment variables win.
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

function createApp(opts = {}) {
  const tz = opts.tz || 'Asia/Kolkata';
  const sessionMs = (opts.sessionHours || 24) * 3600 * 1000;
  const db = openDb(opts.dbFile || ':memory:');
  seedIfEmpty(db, opts.seedFile || path.join(ROOT, 'seed', 'seed.json'));
  const q = (sql) => db.prepare(sql);

  /** Run fn inside one write transaction. BEGIN IMMEDIATE takes the write lock up front. */
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }
  const isUnique = (e) => /UNIQUE constraint/i.test(String(e && e.message));
  const setting = (k) => q('SELECT value FROM settings WHERE key=?').get(k).value;
  const toId = (v) => {
    if (!/^\d+$/.test(v)) throw notFound();
    return Number(v);
  };

  // ------------------------------------------------------------------ serializers
  const paintingOut = (r) => ({
    id: r.id, title: r.title, artist: r.artist, description: r.description,
    price: r.price, imageUrl: r.image_url, status: r.status,
  });
  const withCustomer = (user, r, out) => {
    if (user.role === 'admin') out.customer = { id: r.user_id, name: r.uname, email: r.uemail };
    return out;
  };
  const orderOut = (user, r) => withCustomer(user, r, {
    id: r.id, paintingId: r.painting_id, price: r.price, status: r.status, createdAt: r.created_at,
    painting: { title: r.ptitle, artist: r.partist, imageUrl: r.pimage },
  });
  const bookingOut = (user, r) => withCustomer(user, r, {
    id: r.id, date: r.date, wallSizeSqFt: r.wall_size_sqft, address: r.address,
    ratePerSqFt: r.rate_per_sqft, price: r.price, status: r.status, createdAt: r.created_at,
  });
  const potteryOut = (user, r) => withCustomer(user, r, {
    id: r.id, itemId: r.item_id, itemName: r.item_name, glazeId: r.glaze_id, glazeName: r.glaze_name,
    quantity: r.quantity, neededBy: r.needed_by, status: r.status, createdAt: r.created_at,
  });

  // ------------------------------------------------------------------ queries (ownership lives here)
  // `owner` is null for admin (sees everything) or the customer's id (sees only their own rows).
  // A row that is not theirs simply is not found, so the API answers 404, never 403, for someone
  // else's record.
  const ownerOf = (user) => (user.role === 'admin' ? null : user.id);

  const ORDER_SQL = `SELECT o.*, p.title AS ptitle, p.artist AS partist, p.image_url AS pimage,
      u.name AS uname, u.email AS uemail
    FROM orders o JOIN paintings p ON p.id=o.painting_id JOIN users u ON u.id=o.user_id`;
  const BOOKING_SQL = `SELECT b.*, u.name AS uname, u.email AS uemail
    FROM bookings b JOIN users u ON u.id=b.user_id`;
  const POTTERY_SQL = `SELECT r.*, i.name AS item_name, g.name AS glaze_name, u.name AS uname, u.email AS uemail
    FROM pottery_requests r JOIN pottery_items i ON i.id=r.item_id JOIN glazes g ON g.id=r.glaze_id
    JOIN users u ON u.id=r.user_id`;

  const getOrder = (user, id) =>
    q(`${ORDER_SQL} WHERE o.id=? AND (? IS NULL OR o.user_id=?)`).get(id, ownerOf(user), ownerOf(user));
  const getBooking = (user, id) =>
    q(`${BOOKING_SQL} WHERE b.id=? AND (? IS NULL OR b.user_id=?)`).get(id, ownerOf(user), ownerOf(user));
  const getPottery = (user, id) =>
    q(`${POTTERY_SQL} WHERE r.id=? AND (? IS NULL OR r.user_id=?)`).get(id, ownerOf(user), ownerOf(user));
  const statusFilter = (query) => query.get('status') || null;

  // ------------------------------------------------------------------ routes
  const routes = [];
  /** roles: null = public, [] = any logged-in user, ['customer'] / ['admin'] = that role only. */
  const route = (method, pattern, roles, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, roles, handler });
  };
  const created = (body) => ({ status: 201, body });

  // ---- auth
  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });
  const startSession = (userId) => {
    const token = crypto.randomBytes(32).toString('hex');
    q('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(token, userId, Date.now() + sessionMs);
    return token;
  };
  route('POST', '/api/auth/register', null, ({ body }) => {
    const name = str(body.name, 'name', { max: 80 });
    const email = str(body.email, 'email', { max: 200 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('email is not valid');
    const password = str(body.password, 'password', { min: 6, max: 200 });
    if (q('SELECT 1 FROM users WHERE email=?').get(email)) throw conflict('An account with this email already exists');
    let id;
    try {
      // Public sign-up can only ever create customers. Studio accounts are not self-service.
      id = q('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)')
        .run(name, email, U.hashPassword(password), 'customer').lastInsertRowid;
    } catch (e) {
      if (isUnique(e)) throw conflict('An account with this email already exists');
      throw e;
    }
    const user = q('SELECT * FROM users WHERE id=?').get(id);
    return created({ token: startSession(user.id), user: publicUser(user) });
  });
  route('POST', '/api/auth/login', null, ({ body }) => {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const user = q('SELECT * FROM users WHERE email=?').get(email);
    if (!user || typeof body.password !== 'string' || !U.verifyPassword(body.password, user.password_hash)) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid email or password');
    }
    return { token: startSession(user.id), user: publicUser(user) };
  });
  route('POST', '/api/auth/logout', [], ({ token }) => {
    q('DELETE FROM sessions WHERE token=?').run(token);
    return { ok: true };
  });
  route('GET', '/api/auth/me', [], ({ user }) => ({ user: publicUser(user) }));

  route('GET', '/api/catalog', [], () => ({
    currency: setting('currency'),
    ratePerSqFt: Number(setting('ratePerSqFt')),
    potteryItems: q('SELECT id,name FROM pottery_items ORDER BY id').all(),
    glazes: q('SELECT id,name FROM glazes ORDER BY id').all(),
    rules: RULES,
    today: U.todayString(tz),
  }));

  // ---- paintings
  route('GET', '/api/paintings', [], ({ query }) => {
    const st = statusFilter(query);
    return q('SELECT * FROM paintings WHERE (? IS NULL OR status=?) ORDER BY id').all(st, st).map(paintingOut);
  });
  route('GET', '/api/paintings/:id', [], ({ params }) => {
    const p = q('SELECT * FROM paintings WHERE id=?').get(params.id);
    if (!p) throw notFound('Painting');
    return paintingOut(p);
  });
  const imageField = (v) => {
    if (v === undefined || v === null || v === '') return '';
    const s = str(v, 'imageUrl', { max: 500 });
    if (!/^(\/|https?:\/\/)/.test(s)) throw bad('imageUrl must start with / or http(s)://');
    return s;
  };
  route('POST', '/api/paintings', ['admin'], ({ body }) => {
    const title = str(body.title, 'title', { max: 300 });
    const artist = str(body.artist, 'artist', { max: 120 });
    const description = body.description ? str(body.description, 'description', { max: 2000 }) : '';
    const price = num(body.price, 'price', { min: 1, max: 10000000 });
    const image = imageField(body.imageUrl);
    return created(paintingOut(tx(() => {
      const { m } = q("SELECT COALESCE(MAX(CAST(SUBSTR(id,3) AS INTEGER)),0) AS m FROM paintings WHERE id GLOB 'p-[0-9]*'").get();
      const id = 'p-' + String(m + 1).padStart(3, '0');
      q('INSERT INTO paintings (id,title,artist,description,price,image_url,status) VALUES (?,?,?,?,?,?,?)')
        .run(id, title, artist, description, price, image, 'available');
      return q('SELECT * FROM paintings WHERE id=?').get(id);
    })));
  });
  route('PATCH', '/api/paintings/:id', ['admin'], ({ params, body }) => {
    return paintingOut(tx(() => {
      const p = q('SELECT * FROM paintings WHERE id=?').get(params.id);
      if (!p) throw notFound('Painting');
      if (p.status !== 'available') throw conflict('A sold painting cannot be edited');
      const next = {
        title: body.title === undefined ? p.title : str(body.title, 'title', { max: 300 }),
        artist: body.artist === undefined ? p.artist : str(body.artist, 'artist', { max: 120 }),
        description: body.description === undefined ? p.description : (body.description ? str(body.description, 'description', { max: 2000 }) : ''),
        price: body.price === undefined ? p.price : num(body.price, 'price', { min: 1, max: 10000000 }),
        image: body.imageUrl === undefined ? p.image_url : imageField(body.imageUrl),
      };
      // The status guard in the WHERE clause makes "only while available" hold even under races.
      const r = q("UPDATE paintings SET title=?,artist=?,description=?,price=?,image_url=? WHERE id=? AND status='available'")
        .run(next.title, next.artist, next.description, next.price, next.image, p.id);
      if (r.changes === 0) throw conflict('A sold painting cannot be edited');
      return q('SELECT * FROM paintings WHERE id=?').get(p.id);
    }));
  });

  // ---- orders (buy a painting)
  route('POST', '/api/orders', ['customer'], ({ user, body }) => {
    const paintingId = str(body.paintingId, 'paintingId', { max: 50 });
    const id = tx(() => {
      const p = q('SELECT * FROM paintings WHERE id=?').get(paintingId);
      if (!p) throw notFound('Painting');
      // Atomic claim: only one caller can flip available -> sold. Everyone else sees 0 changes.
      const claim = q("UPDATE paintings SET status='sold' WHERE id=? AND status='available'").run(paintingId);
      if (claim.changes === 0) throw conflict('Sorry, this painting has just been sold.');
      return q("INSERT INTO orders (user_id,painting_id,price,status) VALUES (?,?,?,'placed')")
        .run(user.id, paintingId, p.price).lastInsertRowid;
    });
    return created(orderOut(user, getOrder(user, Number(id))));
  });
  route('GET', '/api/orders', [], ({ user, query }) => {
    const st = statusFilter(query);
    return q(`${ORDER_SQL} WHERE (? IS NULL OR o.user_id=?) AND (? IS NULL OR o.status=?) ORDER BY o.id DESC`)
      .all(ownerOf(user), ownerOf(user), st, st).map((r) => orderOut(user, r));
  });
  route('GET', '/api/orders/:id', [], ({ user, params }) => {
    const r = getOrder(user, toId(params.id));
    if (!r) throw notFound('Order');
    return orderOut(user, r);
  });
  route('POST', '/api/orders/:id/cancel', ['customer'], ({ user, params }) => {
    const id = toId(params.id);
    tx(() => {
      const o = getOrder(user, id);
      if (!o) throw notFound('Order');
      if (o.status !== 'placed') throw conflict(`This order is already ${o.status}`);
      q("UPDATE orders SET status='cancelled' WHERE id=? AND status='placed'").run(id);
      q("UPDATE paintings SET status='available' WHERE id=?").run(o.painting_id); // back on sale
    });
    return orderOut(user, getOrder(user, id));
  });

  // ---- wall bookings
  const LIVE = "('requested','confirmed')";
  route('GET', '/api/bookings/taken-dates', [], () =>
    q(`SELECT date FROM bookings WHERE status IN ${LIVE} ORDER BY date`).all().map((r) => r.date));
  route('POST', '/api/bookings', ['customer'], ({ user, body }) => {
    const R = RULES.booking;
    const date = str(body.date, 'date', { max: 10 });
    const days = U.daysFromToday(date, tz);
    if (days === null) throw bad('date must be a real date in YYYY-MM-DD format');
    if (days < R.minDays || days > R.maxDays) throw bad(`date must be between ${R.minDays} and ${R.maxDays} days from today`);
    const size = num(body.wallSizeSqFt, 'wallSizeSqFt', { min: R.minSqFt, max: R.maxSqFt });
    const address = str(body.address, 'address', { min: 5, max: 300 });
    const rate = Number(setting('ratePerSqFt'));
    const price = Math.round(size * rate * 100) / 100;
    const taken = () => conflict('Sorry, that date has just been taken. Please choose another date.');
    let id;
    try {
      id = tx(() => {
        if (q(`SELECT 1 FROM bookings WHERE date=? AND status IN ${LIVE}`).get(date)) throw taken();
        return q("INSERT INTO bookings (user_id,date,wall_size_sqft,address,rate_per_sqft,price,status) VALUES (?,?,?,?,?,?,'requested')")
          .run(user.id, date, size, address, rate, price).lastInsertRowid;
      });
    } catch (e) {
      if (isUnique(e)) throw taken(); // the partial unique index caught a race the SELECT could not
      throw e;
    }
    return created(bookingOut(user, getBooking(user, Number(id))));
  });
  route('GET', '/api/bookings', [], ({ user, query }) => {
    const st = statusFilter(query);
    return q(`${BOOKING_SQL} WHERE (? IS NULL OR b.user_id=?) AND (? IS NULL OR b.status=?) ORDER BY b.date`)
      .all(ownerOf(user), ownerOf(user), st, st).map((r) => bookingOut(user, r));
  });
  route('GET', '/api/bookings/:id', [], ({ user, params }) => {
    const r = getBooking(user, toId(params.id));
    if (!r) throw notFound('Booking');
    return bookingOut(user, r);
  });
  route('POST', '/api/bookings/:id/cancel', ['customer'], ({ user, params }) => {
    const id = toId(params.id);
    tx(() => {
      const b = getBooking(user, id);
      if (!b) throw notFound('Booking');
      if (!['requested', 'confirmed'].includes(b.status)) throw conflict(`This booking is already ${b.status}`);
      if (U.daysFromToday(b.date, tz) < RULES.booking.cancelBeforeDays) {
        throw conflict(`A booking can only be cancelled until ${RULES.booking.cancelBeforeDays} days before the date`);
      }
      q(`UPDATE bookings SET status='cancelled' WHERE id=? AND status IN ${LIVE}`).run(id); // frees the date
    });
    return bookingOut(user, getBooking(user, id));
  });
  const bookingDecision = (verb, status) => route('POST', `/api/bookings/:id/${verb}`, ['admin'], ({ user, params }) => {
    const id = toId(params.id);
    tx(() => {
      const b = getBooking(user, id);
      if (!b) throw notFound('Booking');
      if (b.status !== 'requested') throw conflict(`Only a requested booking can be ${status}; this one is ${b.status}`);
      q("UPDATE bookings SET status=? WHERE id=? AND status='requested'").run(status, id);
    });
    return bookingOut(user, getBooking(user, id));
  });
  bookingDecision('confirm', 'confirmed');
  bookingDecision('decline', 'declined');

  // ---- pottery requests
  const potteryRefs = (itemId, glazeId) => {
    if (!q('SELECT 1 FROM pottery_items WHERE id=?').get(itemId)) throw bad('Unknown pottery item');
    if (!q('SELECT 1 FROM glazes WHERE id=?').get(glazeId)) throw bad('Unknown glaze');
  };
  const neededBy = (v) => {
    const s = str(v, 'neededBy', { max: 10 });
    const d = U.daysFromToday(s, tz);
    if (d === null) throw bad('neededBy must be a real date in YYYY-MM-DD format');
    if (d < RULES.pottery.minDays) throw bad(`neededBy must be at least ${RULES.pottery.minDays} days from today`);
    return s;
  };
  const quantity = (v) => num(v, 'quantity', { min: RULES.pottery.minQty, max: RULES.pottery.maxQty, integer: true });
  route('POST', '/api/pottery', ['customer'], ({ user, body }) => {
    const itemId = str(body.itemId, 'itemId', { max: 50 });
    const glazeId = str(body.glazeId, 'glazeId', { max: 50 });
    potteryRefs(itemId, glazeId);
    const qty = quantity(body.quantity);
    const by = neededBy(body.neededBy);
    const id = q("INSERT INTO pottery_requests (user_id,item_id,glaze_id,quantity,needed_by,status) VALUES (?,?,?,?,?,'requested')")
      .run(user.id, itemId, glazeId, qty, by).lastInsertRowid;
    return created(potteryOut(user, getPottery(user, Number(id))));
  });
  route('GET', '/api/pottery', [], ({ user, query }) => {
    const st = statusFilter(query);
    return q(`${POTTERY_SQL} WHERE (? IS NULL OR r.user_id=?) AND (? IS NULL OR r.status=?) ORDER BY r.id DESC`)
      .all(ownerOf(user), ownerOf(user), st, st).map((r) => potteryOut(user, r));
  });
  route('GET', '/api/pottery/:id', [], ({ user, params }) => {
    const r = getPottery(user, toId(params.id));
    if (!r) throw notFound('Pottery request');
    return potteryOut(user, r);
  });
  route('PATCH', '/api/pottery/:id', ['customer'], ({ user, params, body }) => {
    const id = toId(params.id);
    tx(() => {
      const r = getPottery(user, id);
      if (!r) throw notFound('Pottery request');
      if (r.status !== 'requested') throw conflict(`Only a request that is still "requested" can be edited; this one is ${r.status}`);
      const itemId = body.itemId === undefined ? r.item_id : str(body.itemId, 'itemId', { max: 50 });
      const glazeId = body.glazeId === undefined ? r.glaze_id : str(body.glazeId, 'glazeId', { max: 50 });
      potteryRefs(itemId, glazeId);
      const qty = body.quantity === undefined ? r.quantity : quantity(body.quantity);
      const by = body.neededBy === undefined ? r.needed_by : neededBy(body.neededBy);
      q("UPDATE pottery_requests SET item_id=?,glaze_id=?,quantity=?,needed_by=? WHERE id=? AND status='requested'")
        .run(itemId, glazeId, qty, by, id);
    });
    return potteryOut(user, getPottery(user, id));
  });
  route('POST', '/api/pottery/:id/cancel', ['customer'], ({ user, params }) => {
    const id = toId(params.id);
    tx(() => {
      const r = getPottery(user, id);
      if (!r) throw notFound('Pottery request');
      if (r.status !== 'requested') throw conflict(`Only a request that is still "requested" can be cancelled; this one is ${r.status}`);
      q("UPDATE pottery_requests SET status='cancelled' WHERE id=? AND status='requested'").run(id);
    });
    return potteryOut(user, getPottery(user, id));
  });
  const potteryDecision = (verb, status) => route('POST', `/api/pottery/:id/${verb}`, ['admin'], ({ user, params }) => {
    const id = toId(params.id);
    tx(() => {
      const r = getPottery(user, id);
      if (!r) throw notFound('Pottery request');
      if (r.status !== 'requested') throw conflict(`Only a requested item can be ${status}; this one is ${r.status}`);
      q("UPDATE pottery_requests SET status=? WHERE id=? AND status='requested'").run(status, id);
    });
    return potteryOut(user, getPottery(user, id));
  });
  potteryDecision('accept', 'accepted');
  potteryDecision('decline', 'declined');

  // ------------------------------------------------------------------ http plumbing
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

  function send(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    res.end(data);
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 100_000) { reject(new HttpError(413, 'TOO_LARGE', 'Request body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
          resolve(v);
        } catch { reject(bad('Request body must be a JSON object')); }
      });
      req.on('error', reject);
    });
  }
  function authenticate(req) {
    const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(req.headers.authorization || '');
    if (!m) return null;
    const s = q('SELECT * FROM sessions WHERE token=?').get(m[1].toLowerCase());
    if (!s) return null;
    if (s.expires_at < Date.now()) { q('DELETE FROM sessions WHERE token=?').run(s.token); return null; }
    // The role is read from the database on every request, never trusted from the client.
    const user = q('SELECT * FROM users WHERE id=?').get(s.user_id);
    return user ? { user, token: s.token } : null;
  }
  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.join(PUBLIC_DIR, decodeURIComponent(rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
        return serveStatic(req, res, url.pathname);
      }
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        let auth = null;
        if (r.roles) {
          auth = authenticate(req);
          if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Please log in');                 // 401: no/invalid session
          if (r.roles.length && !r.roles.includes(auth.user.role)) {
            throw new HttpError(403, 'FORBIDDEN', 'Your role is not allowed to do this');          // 403: wrong role
          }
        }
        const body = req.method === 'GET' ? {} : await readBody(req);
        const out = r.handler({ req, params, query: url.searchParams, body, user: auth && auth.user, token: auth && auth.token });
        if (out && out.status && out.body !== undefined) return send(res, out.status, out.body);
        return send(res, 200, out);
      }
      if (pathMatched) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: { code: e.code, message: e.message } });
      console.error(e);
      return send(res, 500, { error: { code: 'INTERNAL', message: 'Something went wrong on the server' } });
    }
  }

  return { db, server: http.createServer(handle), close: () => db.close() };
}

if (require.main === module) {
  loadEnvFile();
  const port = Number(process.env.PORT) || 3000;
  const app = createApp({
    dbFile: process.env.DB_PATH || path.join(ROOT, 'data', 'studio.db'),
    tz: process.env.STUDIO_TZ || 'Asia/Kolkata',
    sessionHours: Number(process.env.SESSION_HOURS) || 24,
  });
  app.server.listen(port, () => console.log(`Art Studio running at http://localhost:${port}`));
}

module.exports = { createApp };
