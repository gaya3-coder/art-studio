'use strict';
// End-to-end checks against a real HTTP server on a throwaway database. Run: npm test
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/server');
const U = require('../src/util');

const TZ = 'Asia/Kolkata';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-'));
const app = createApp({ dbFile: path.join(tmp, 't.db'), tz: TZ });
let base;
let passed = 0;

const plusDays = (n) => {
  const [y, m, d] = U.todayString(TZ).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
async function call(method, url, token, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

(async () => {
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;

  const reg = async (name, email) => (await call('POST', '/api/auth/register', null, { name, email, password: 'secret12' })).body.token;
  const admin = (await call('POST', '/api/auth/login', null, { email: 'studio@artstudio.in', password: 'Studio@123' })).body.token;
  const A = await reg('Asha', 'asha@example.com');
  const B = await reg('Bala', 'bala@example.com');

  console.log('Auth & roles');
  await check('no token -> 401', async () => {
    assert.equal((await call('GET', '/api/paintings')).status, 401);
    assert.equal((await call('POST', '/api/orders', null, { paintingId: 'p-001' })).status, 401);
    assert.equal((await call('GET', '/api/paintings', 'f'.repeat(64))).status, 401);
  });
  await check('bad password -> 401, duplicate email -> 409', async () => {
    assert.equal((await call('POST', '/api/auth/login', null, { email: 'asha@example.com', password: 'nope' })).status, 401);
    assert.equal((await call('POST', '/api/auth/register', null, { name: 'x', email: 'ASHA@example.com', password: 'secret12' })).status, 409);
  });
  await check('sign-up cannot create an admin', async () => {
    const r = await call('POST', '/api/auth/register', null, { name: 'Sneaky', email: 's@example.com', password: 'secret12', role: 'admin' });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.role, 'customer');
  });
  await check('customer cannot add painting (403); admin can (201)', async () => {
    const p = { title: 'New', artist: 'Me', price: 1000 };
    assert.equal((await call('POST', '/api/paintings', A, p)).status, 403);
    assert.equal((await call('POST', '/api/paintings', admin, p)).status, 201);
  });
  await check('admin cannot buy / book / request (403)', async () => {
    assert.equal((await call('POST', '/api/orders', admin, { paintingId: 'p-001' })).status, 403);
    assert.equal((await call('POST', '/api/bookings', admin, { date: plusDays(10), wallSizeSqFt: 50, address: '1 Main Road' })).status, 403);
    assert.equal((await call('POST', '/api/pottery', admin, { itemId: 'i-01', glazeId: 'g-01', quantity: 1, neededBy: plusDays(20) })).status, 403);
  });

  console.log('Paintings & orders');
  let orderId;
  await check('5 simultaneous buys of one painting -> exactly one wins', async () => {
    const rs = await Promise.all([A, B, A, B, A].map((t) => call('POST', '/api/orders', t, { paintingId: 'p-001' })));
    const wins = rs.filter((r) => r.status === 201);
    assert.equal(wins.length, 1);
    assert.equal(rs.filter((r) => r.status === 409).length, 4);
    orderId = wins[0].body.id;
    assert.equal((await call('GET', '/api/paintings/p-001', A)).body.status, 'sold');
  });
  await check('seed-sold painting -> 409; unknown painting -> 404', async () => {
    assert.equal((await call('POST', '/api/orders', B, { paintingId: 'p-004' })).status, 409);
    assert.equal((await call('POST', '/api/orders', B, { paintingId: 'p-999' })).status, 404);
  });
  await check('admin edit: sold -> 409, available -> 200, customer -> 403', async () => {
    assert.equal((await call('PATCH', '/api/paintings/p-001', admin, { price: 5 })).status, 409);
    const r = await call('PATCH', '/api/paintings/p-002', admin, { price: 2000 });
    assert.equal(r.status, 200);
    assert.equal(r.body.price, 2000);
    assert.equal((await call('PATCH', '/api/paintings/p-002', A, { price: 1 })).status, 403);
  });
  await check('ownership: other customer gets 404, admin sees all', async () => {
    const owner = (await call('GET', `/api/orders/${orderId}`, A));
    const other = (await call('GET', `/api/orders/${orderId}`, B));
    assert.equal(owner.status === 200 || other.status === 200, true);
    const loser = owner.status === 200 ? B : A, winner = owner.status === 200 ? A : B;
    assert.equal((await call('GET', `/api/orders/${orderId}`, loser)).status, 404);
    assert.equal((await call('GET', '/api/orders', loser)).body.length, 0);
    assert.equal((await call('GET', `/api/orders/${orderId}`, admin)).status, 200);
    assert.equal((await call('POST', `/api/orders/${orderId}/cancel`, loser)).status, 404);
    assert.equal((await call('POST', `/api/orders/${orderId}/cancel`, admin)).status, 403);
    assert.equal((await call('POST', `/api/orders/${orderId}/cancel`, winner)).status, 200);
    assert.equal((await call('POST', `/api/orders/${orderId}/cancel`, winner)).status, 409);
    assert.equal((await call('GET', '/api/paintings/p-001', loser)).body.status, 'available');
    assert.equal((await call('POST', '/api/orders', loser, { paintingId: 'p-001' })).status, 201); // can be bought again
  });

  console.log('Wall bookings');
  let bk;
  await check('date window 7..90 and size 10..500', async () => {
    const ok = { wallSizeSqFt: 50, address: '12 Park Street, Hyderabad' };
    assert.equal((await call('POST', '/api/bookings', A, { ...ok, date: plusDays(6) })).status, 400);
    assert.equal((await call('POST', '/api/bookings', A, { ...ok, date: plusDays(91) })).status, 400);
    assert.equal((await call('POST', '/api/bookings', A, { ...ok, date: '2026-02-30' })).status, 400);
    assert.equal((await call('POST', '/api/bookings', A, { ...ok, date: plusDays(20), wallSizeSqFt: 9 })).status, 400);
    assert.equal((await call('POST', '/api/bookings', A, { ...ok, date: plusDays(20), wallSizeSqFt: 501 })).status, 400);
    assert.equal((await call('POST', '/api/bookings', A, { ...ok, date: plusDays(20), address: '' })).status, 400);
    const lo = await call('POST', '/api/bookings', A, { ...ok, date: plusDays(7) });
    const hi = await call('POST', '/api/bookings', A, { ...ok, date: plusDays(90), wallSizeSqFt: 500 });
    assert.equal(lo.status, 201);
    assert.equal(hi.status, 201);
    assert.equal(hi.body.price, 500 * 150);
    assert.equal(lo.body.status, 'requested');
  });
  await check('5 simultaneous bookings of one date -> exactly one wins', async () => {
    const body = { date: plusDays(30), wallSizeSqFt: 100, address: '5 Lake View Road' };
    const rs = await Promise.all([A, B, A, B, A].map((t) => call('POST', '/api/bookings', t, body)));
    assert.equal(rs.filter((r) => r.status === 201).length, 1);
    assert.equal(rs.filter((r) => r.status === 409).length, 4);
    bk = rs.find((r) => r.status === 201);
    assert.equal(bk.body.price, 100 * 150);
  });
  await check('declined booking frees the date; confirmed/requested hold it', async () => {
    const id = bk.body.id;
    assert.equal((await call('POST', `/api/bookings/${id}/confirm`, A)).status, 403);
    assert.equal((await call('POST', `/api/bookings/${id}/decline`, admin)).body.status, 'declined');
    assert.equal((await call('POST', `/api/bookings/${id}/confirm`, admin)).status, 409);
    assert.equal((await call('GET', '/api/bookings/taken-dates', B)).body.includes(plusDays(30)), false);
    const again = await call('POST', '/api/bookings', B, { date: plusDays(30), wallSizeSqFt: 40, address: '9 Hill Road' });
    assert.equal(again.status, 201);
    assert.equal((await call('POST', `/api/bookings/${again.body.id}/confirm`, admin)).body.status, 'confirmed');
    assert.equal((await call('POST', '/api/bookings', A, { date: plusDays(30), wallSizeSqFt: 40, address: '9 Hill Road' })).status, 409);
    bk = again;
  });
  await check('cancel: owner only, until 3 days before', async () => {
    const id = bk.body.id; // owned by B, confirmed
    assert.equal((await call('GET', `/api/bookings/${id}`, A)).status, 404);
    assert.equal((await call('POST', `/api/bookings/${id}/cancel`, A)).status, 404);
    assert.equal((await call('POST', `/api/bookings/${id}/cancel`, admin)).status, 403);
    app.db.prepare('UPDATE bookings SET date=? WHERE id=?').run(plusDays(2), id); // simulate time passing
    assert.equal((await call('POST', `/api/bookings/${id}/cancel`, B)).status, 409);
    app.db.prepare('UPDATE bookings SET date=? WHERE id=?').run(plusDays(3), id);
    assert.equal((await call('POST', `/api/bookings/${id}/cancel`, B)).body.status, 'cancelled');
    assert.equal((await call('GET', '/api/bookings/taken-dates', A)).body.includes(plusDays(3)), false);
  });

  await check('database itself rejects a second live booking / second active order (backstop)', async () => {
    const day = plusDays(60);
    const ins = app.db.prepare("INSERT INTO bookings (user_id,date,wall_size_sqft,address,rate_per_sqft,price,status) VALUES (1,?,10,'x',150,1500,'requested')");
    ins.run(day);
    assert.throws(() => ins.run(day), /UNIQUE/);
    const ord = app.db.prepare("INSERT INTO orders (user_id,painting_id,price,status) VALUES (1,'p-003',1,'placed')");
    ord.run();
    assert.throws(() => ord.run(), /UNIQUE/);
  });

  console.log('Pottery');
  let pr;
  await check('validation: qty 1..12, needed-by >= 14 days, known item/glaze', async () => {
    const ok = { itemId: 'i-03', glazeId: 'g-04', quantity: 4, neededBy: plusDays(14) };
    assert.equal((await call('POST', '/api/pottery', A, { ...ok, quantity: 0 })).status, 400);
    assert.equal((await call('POST', '/api/pottery', A, { ...ok, quantity: 13 })).status, 400);
    assert.equal((await call('POST', '/api/pottery', A, { ...ok, quantity: 2.5 })).status, 400);
    assert.equal((await call('POST', '/api/pottery', A, { ...ok, neededBy: plusDays(13) })).status, 400);
    assert.equal((await call('POST', '/api/pottery', A, { ...ok, glazeId: 'g-99' })).status, 400);
    assert.equal((await call('POST', '/api/pottery', A, { ...ok, itemId: 'nope' })).status, 400);
    pr = await call('POST', '/api/pottery', A, ok);
    assert.equal(pr.status, 201);
    assert.equal(pr.body.status, 'requested');
    assert.equal((await call('POST', '/api/pottery', A, { ...ok, quantity: 12 })).status, 201);
  });
  await check('edit/cancel only while requested, owner only', async () => {
    const id = pr.body.id;
    assert.equal((await call('PATCH', `/api/pottery/${id}`, B, { quantity: 2 })).status, 404);
    assert.equal((await call('PATCH', `/api/pottery/${id}`, A, { quantity: 6, glazeId: 'g-01' })).body.quantity, 6);
    assert.equal((await call('PATCH', `/api/pottery/${id}`, A, { neededBy: plusDays(5) })).status, 400);
    assert.equal((await call('POST', `/api/pottery/${id}/accept`, A)).status, 403);
    assert.equal((await call('POST', `/api/pottery/${id}/accept`, admin)).body.status, 'accepted');
    assert.equal((await call('PATCH', `/api/pottery/${id}`, A, { quantity: 3 })).status, 409);
    assert.equal((await call('POST', `/api/pottery/${id}/cancel`, A)).status, 409);
    assert.equal((await call('POST', `/api/pottery/${id}/decline`, admin)).status, 409);
  });
  await check('lists: customer sees only own, admin sees all', async () => {
    const mine = (await call('GET', '/api/pottery', A)).body.length;
    assert.equal(mine, 2);
    assert.equal((await call('GET', '/api/pottery', B)).body.length, 0);
    assert.equal((await call('GET', '/api/pottery', admin)).body.length, 2);
    assert.equal((await call('GET', '/api/pottery?status=accepted', admin)).body.length, 1);
  });

  await new Promise((r) => app.server.close(r));
  app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} checks passed${process.exitCode ? ', some FAILED' : ''}`);
})();
