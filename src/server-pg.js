'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { getPool, closePool } = require('./db-pg');
const U = require('./util');
const { HttpError, bad, conflict, notFound, str, num } = U;

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const RULES = {
  booking: {
    minDays: 7,
    maxDays: 90,
    minSqFt: 10,
    maxSqFt: 500,
    cancelBeforeDays: 3,
  },
  pottery: {
    minQty: 1,
    maxQty: 12,
    minDays: 14,
  },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

function loadEnvFile() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;

  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);

    if (
      m &&
      !line.trim().startsWith('#') &&
      process.env[m[1]] === undefined
    ) {
      process.env[m[1]] = m[2];
    }
  }
}

const isUnique = (e) =>
  e && (e.code === '23505' || /unique constraint/i.test(String(e.message)));

const toId = (v) => {
  if (!/^\d+$/.test(String(v))) throw notFound();
  return Number(v);
};

const created = (body) => ({ status: 201, body });

async function initializeDatabase() {
  const pool = getPool();

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
      ux_orders_one_active_per_painting
    ON orders(painting_id)
    WHERE status = 'placed'
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
      ux_bookings_one_live_per_date
    ON bookings(date)
    WHERE status IN ('requested', 'confirmed')
  `);

  const count = await pool.query(
    'SELECT COUNT(*)::int AS n FROM paintings'
  );

  if (count.rows[0].n > 0) return;

  const seedFile = path.join(ROOT, 'seed', 'seed.json');

  if (!fs.existsSync(seedFile)) {
    throw new Error(`Seed file not found: ${seedFile}`);
  }

  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const p of seed.paintings || []) {
      const img = p.imageUrl
        ? '/' + p.imageUrl.replace(/^\/+/, '')
        : '';

      await client.query(
        `INSERT INTO paintings
          (id, title, artist, description, price, image_url, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          p.id,
          p.title,
          p.artist,
          p.description || '',
          p.price,
          img,
          p.status || 'available',
        ]
      );
    }

    for (const i of seed.potteryItems || []) {
      await client.query(
        `INSERT INTO pottery_items (id, name)
         VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [i.id, i.name]
      );
    }

    for (const g of seed.glazes || []) {
      await client.query(
        `INSERT INTO glazes (id, name)
         VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [g.id, g.name]
      );
    }

    await client.query(
      `INSERT INTO settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      ['ratePerSqFt', String(seed.mural.ratePerSqFt)]
    );

    await client.query(
      `INSERT INTO settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      ['currency', seed.currency || 'INR']
    );

    const s = seed.studioAccount;

    if (s && s.email && s.password) {
      await client.query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO NOTHING`,
        [
          'Studio',
          s.email.toLowerCase(),
          U.hashPassword(s.password),
          'admin',
        ]
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function createApp(opts = {}) {
  const tz = opts.tz || 'Asia/Kolkata';
  const sessionMs = (opts.sessionHours || 24) * 3600 * 1000;
  const pool = getPool();

  let initPromise;

  const ready = () => {
    if (!initPromise) {
      initPromise = initializeDatabase().catch((e) => {
        initPromise = null;
        throw e;
      });
    }

    return initPromise;
  };

  const routes = [];

  const route = (method, pattern, roles, handler) => {
    const keys = [];

    const re = new RegExp(
      '^' +
        pattern.replace(
          /:(\w+)/g,
          (_, k) => (keys.push(k), '([^/]+)')
        ) +
        '$'
    );

    routes.push({ method, re, keys, roles, handler });
  };

  const setting = async (k) => {
    const r = await pool.query(
      'SELECT value FROM settings WHERE key = $1',
      [k]
    );

    if (!r.rows[0]) {
      throw new Error(`Missing setting: ${k}`);
    }

    return r.rows[0].value;
  };

  const publicUser = (u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
  });

  const ownerOf = (user) =>
    user.role === 'admin' ? null : user.id;

  const paintingOut = (r) => ({
    id: r.id,
    title: r.title,
    artist: r.artist,
    description: r.description,
    price: r.price,
    imageUrl: r.image_url,
    status: r.status,
  });

  const withCustomer = (user, r, out) => {
    if (user.role === 'admin') {
      out.customer = {
        id: r.user_id,
        name: r.uname,
        email: r.uemail,
      };
    }

    return out;
  };

  const orderOut = (user, r) =>
    withCustomer(user, r, {
      id: r.id,
      paintingId: r.painting_id,
      price: r.price,
      status: r.status,
      createdAt: r.created_at,
      painting: {
        title: r.ptitle,
        artist: r.partist,
        imageUrl: r.pimage,
      },
    });

  const bookingOut = (user, r) =>
    withCustomer(user, r, {
      id: r.id,
      date: r.date,
      wallSizeSqFt: r.wall_size_sqft,
      address: r.address,
      ratePerSqFt: r.rate_per_sqft,
      price: r.price,
      status: r.status,
      createdAt: r.created_at,
    });

  const potteryOut = (user, r) =>
    withCustomer(user, r, {
      id: r.id,
      itemId: r.item_id,
      itemName: r.item_name,
      glazeId: r.glaze_id,
      glazeName: r.glaze_name,
      quantity: r.quantity,
      neededBy: r.needed_by,
      status: r.status,
      createdAt: r.created_at,
    });

  const ORDER_SQL = `
    SELECT
      o.*,
      p.title AS ptitle,
      p.artist AS partist,
      p.image_url AS pimage,
      u.name AS uname,
      u.email AS uemail
    FROM orders o
    JOIN paintings p ON p.id = o.painting_id
    JOIN users u ON u.id = o.user_id
  `;

  const BOOKING_SQL = `
    SELECT b.*, u.name AS uname, u.email AS uemail
    FROM bookings b
    JOIN users u ON u.id = b.user_id
  `;

  const POTTERY_SQL = `
    SELECT
      r.*,
      i.name AS item_name,
      g.name AS glaze_name,
      u.name AS uname,
      u.email AS uemail
    FROM pottery_requests r
    JOIN pottery_items i ON i.id = r.item_id
    JOIN glazes g ON g.id = r.glaze_id
    JOIN users u ON u.id = r.user_id
  `;

  const getOrder = async (user, id, client = pool) =>
    (
      await client.query(
        `${ORDER_SQL}
         WHERE o.id = $1
           AND ($2::bigint IS NULL OR o.user_id = $2)`,
        [id, ownerOf(user)]
      )
    ).rows[0];

  const getBooking = async (user, id, client = pool) =>
    (
      await client.query(
        `${BOOKING_SQL}
         WHERE b.id = $1
           AND ($2::bigint IS NULL OR b.user_id = $2)`,
        [id, ownerOf(user)]
      )
    ).rows[0];

  const getPottery = async (user, id, client = pool) =>
    (
      await client.query(
        `${POTTERY_SQL}
         WHERE r.id = $1
           AND ($2::bigint IS NULL OR r.user_id = $2)`,
        [id, ownerOf(user)]
      )
    ).rows[0];

  const statusFilter = (query) =>
    query.get('status') || null;

  const tx = async (fn) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  };

  const imageField = (v) => {
    if (v === undefined || v === null || v === '') return '';

    const s = str(v, 'imageUrl', { max: 500 });

    if (!/^(\/|https?:\/\/)/.test(s)) {
      throw bad('imageUrl must start with / or http(s)://');
    }

    return s;
  };

  const quantity = (v) =>
    num(v, 'quantity', {
      min: RULES.pottery.minQty,
      max: RULES.pottery.maxQty,
      integer: true,
    });

  const neededBy = (v) => {
    const s = str(v, 'neededBy', { max: 10 });
    const d = U.daysFromToday(s, tz);

    if (d === null) {
      throw bad('neededBy must be a real date in YYYY-MM-DD format');
    }

    if (d < RULES.pottery.minDays) {
      throw bad(
        `neededBy must be at least ${RULES.pottery.minDays} days from today`
      );
    }

    return s;
  };

  const potteryRefs = async (itemId, glazeId, client = pool) => {
    if (
      !(await client.query(
        'SELECT 1 FROM pottery_items WHERE id = $1',
        [itemId]
      )).rowCount
    ) {
      throw bad('Unknown pottery item');
    }

    if (
      !(await client.query(
        'SELECT 1 FROM glazes WHERE id = $1',
        [glazeId]
      )).rowCount
    ) {
      throw bad('Unknown glaze');
    }
  };

  const startSession = async (userId) => {
    const token = crypto.randomBytes(32).toString('hex');

    await pool.query(
      `INSERT INTO sessions (token, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [token, userId, Date.now() + sessionMs]
    );

    return token;
  };
    // Authentication
  route('POST', '/api/auth/register', null, async ({ body }) => {
    const name = str(body.name, 'name', { max: 80 });
    const email = str(body.email, 'email', { max: 200 }).toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw bad('email is not valid');
    }

    const password = str(body.password, 'password', {
      min: 6,
      max: 200,
    });

    try {
      const result = await pool.query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [name, email, U.hashPassword(password), 'customer']
      );

      const user = result.rows[0];

      return created({
        token: await startSession(user.id),
        user: publicUser(user),
      });
    } catch (e) {
      if (isUnique(e)) {
        throw conflict('An account with this email already exists');
      }

      throw e;
    }
  });

  route('POST', '/api/auth/login', null, async ({ body }) => {
    const email =
      typeof body.email === 'string'
        ? body.email.trim().toLowerCase()
        : '';

    const user = (
      await pool.query(
        'SELECT * FROM users WHERE email = $1',
        [email]
      )
    ).rows[0];

    if (
      !user ||
      typeof body.password !== 'string' ||
      !U.verifyPassword(body.password, user.password_hash)
    ) {
      throw new HttpError(
        401,
        'UNAUTHENTICATED',
        'Invalid email or password'
      );
    }

    return {
      token: await startSession(user.id),
      user: publicUser(user),
    };
  });

  route('POST', '/api/auth/logout', [], async ({ token }) => {
    await pool.query(
      'DELETE FROM sessions WHERE token = $1',
      [token]
    );

    return { ok: true };
  });

  route('GET', '/api/auth/me', [], async ({ user }) => ({
    user: publicUser(user),
  }));

  route('GET', '/api/catalog', [], async () => ({
    currency: await setting('currency'),
    ratePerSqFt: Number(await setting('ratePerSqFt')),
    potteryItems: (
      await pool.query(
        'SELECT id, name FROM pottery_items ORDER BY id'
      )
    ).rows,
    glazes: (
      await pool.query(
        'SELECT id, name FROM glazes ORDER BY id'
      )
    ).rows,
    rules: RULES,
    today: U.todayString(tz),
  }));

  // Paintings
  route('GET', '/api/paintings', [], async ({ query }) => {
    const status = statusFilter(query);

    const result = await pool.query(
      `SELECT * FROM paintings
       WHERE deleted_at IS NULL
         AND ($1::text IS NULL OR status = $1)
       ORDER BY id`,
      [status]
    );

    return result.rows.map(paintingOut);
  });

  route('GET', '/api/paintings/:id', [], async ({ params }) => {
    const painting = (
      await pool.query(
        'SELECT * FROM paintings WHERE id = $1',
        [params.id]
      )
    ).rows[0];

    if (!painting) throw notFound('Painting');

    return paintingOut(painting);
  });

  route('POST', '/api/paintings', ['admin'], async ({ body }) => {
    const title = str(body.title, 'title', { max: 300 });
    const artist = str(body.artist, 'artist', { max: 120 });
    const description = body.description
      ? str(body.description, 'description', { max: 2000 })
      : '';
    const price = num(body.price, 'price', {
      min: 1,
      max: 10000000,
    });
    const image = imageField(body.imageUrl);

    const painting = await tx(async (client) => {
      const result = await client.query(`
        SELECT COALESCE(MAX(SUBSTRING(id FROM 3)::int), 0) AS m
        FROM paintings
        WHERE id ~ '^p-[0-9]+$'
      `);

      const id =
        'p-' + String(Number(result.rows[0].m) + 1).padStart(3, '0');

      return (
        await client.query(
          `INSERT INTO paintings
            (id, title, artist, description, price, image_url, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [id, title, artist, description, price, image, 'available']
        )
      ).rows[0];
    });

    return created(paintingOut(painting));
  });

  route('PATCH', '/api/paintings/:id', ['admin'], async ({ params, body }) => {
    const painting = await tx(async (client) => {
      const old = (
        await client.query(
          'SELECT * FROM paintings WHERE id = $1 FOR UPDATE',
          [params.id]
        )
      ).rows[0];

      if (!old) throw notFound('Painting');
      if (old.status !== 'available') {
        throw conflict('A sold painting cannot be edited');
      }

      const next = {
        title: body.title === undefined
          ? old.title
          : str(body.title, 'title', { max: 300 }),
        artist: body.artist === undefined
          ? old.artist
          : str(body.artist, 'artist', { max: 120 }),
        description: body.description === undefined
          ? old.description
          : body.description
            ? str(body.description, 'description', { max: 2000 })
            : '',
        price: body.price === undefined
          ? old.price
          : num(body.price, 'price', { min: 1, max: 10000000 }),
        image: body.imageUrl === undefined
          ? old.image_url
          : imageField(body.imageUrl),
      };

      const result = await client.query(
        `UPDATE paintings
         SET title = $1, artist = $2, description = $3,
             price = $4, image_url = $5
         WHERE id = $6 AND status = 'available'
         RETURNING *`,
        [
          next.title,
          next.artist,
          next.description,
          next.price,
          next.image,
          old.id,
        ]
      );

      if (!result.rowCount) {
        throw conflict('A sold painting cannot be edited');
      }

      return result.rows[0];
    });

    return paintingOut(painting);
  });

  route('DELETE', '/api/paintings/:id', ['admin'], async ({ params }) =>
    tx(async (client) => {
      const painting = (
        await client.query(
          'SELECT * FROM paintings WHERE id = $1 FOR UPDATE',
          [params.id]
        )
      ).rows[0];

      if (!painting) throw notFound('Painting');

      if (painting.status !== 'available') {
        throw conflict('Only available paintings can be deleted');
      }

      const orders = await client.query(
        'SELECT 1 FROM orders WHERE painting_id = $1',
        [painting.id]
      );

      if (orders.rowCount) {
        throw conflict(
          'This painting has order history and cannot be deleted'
        );
      }
      await client.query(
  'UPDATE paintings SET deleted_at = NOW() WHERE id = $1',
  [painting.id]
);
      return {
        ok: true,
        message: 'Painting deleted successfully',
      };
    })
  );

  route('GET', '/api/admin/deleted-paintings', ['admin'], async () => {
  const result = await pool.query(
    `SELECT * FROM paintings
     WHERE deleted_at IS NOT NULL
     ORDER BY deleted_at DESC`
  );

  return result.rows.map(paintingOut);
});

route('POST', '/api/admin/paintings/:id/restore', ['admin'], async ({ params }) => {
  const result = await pool.query(
    `UPDATE paintings
     SET deleted_at = NULL
     WHERE id = $1 AND deleted_at IS NOT NULL
     RETURNING *`,
    [params.id]
  );

  if (!result.rowCount) throw notFound('Deleted painting');

  return {
    ok: true,
    message: 'Painting restored successfully',
    painting: paintingOut(result.rows[0]),
  };
});

  // Orders
  route('POST', '/api/orders', ['customer'], async ({ user, body }) => {
    const paintingId = str(body.paintingId, 'paintingId', { max: 50 });
    let id;
    try {
  id = await tx(async (client) => {
    const painting = (
      await client.query(
        'SELECT * FROM paintings WHERE id = $1 FOR UPDATE',
        [paintingId]
      )
    ).rows[0];
        if (!painting) throw notFound('Painting');

        const claim = await client.query(
          `UPDATE paintings SET status = 'sold'
           WHERE id = $1 AND status = 'available'
           RETURNING id`,
          [paintingId]
        );

        if (!claim.rowCount) {
          throw conflict('Sorry, this painting has just been sold.');
        }

        return (
          await client.query(
            `INSERT INTO orders (user_id, painting_id, price, status)
             VALUES ($1, $2, $3, 'placed')
             RETURNING id`,
            [user.id, paintingId, painting.price]
          )
        ).rows[0].id;
      });
    } catch (e) {
      if (isUnique(e)) {
        throw conflict('Sorry, this painting has just been sold.');
      }

      throw e;
    }

    return created(orderOut(user, await getOrder(user, id)));
  });

  route('GET', '/api/orders', [], async ({ user, query }) => {
    const status = statusFilter(query);

    return (
      await pool.query(
        `${ORDER_SQL}
         WHERE ($1::bigint IS NULL OR o.user_id = $1)
           AND ($2::text IS NULL OR o.status = $2)
         ORDER BY o.id DESC`,
        [ownerOf(user), status]
      )
    ).rows.map((r) => orderOut(user, r));
  });

  route('GET', '/api/orders/:id', [], async ({ user, params }) => {
    const order = await getOrder(user, toId(params.id));

    if (!order) throw notFound('Order');

    return orderOut(user, order);
  });

  route('POST', '/api/orders/:id/cancel', ['customer'], async ({ user, params }) => {
    const id = toId(params.id);

    await tx(async (client) => {
      const order = await getOrder(user, id, client);

      if (!order) throw notFound('Order');

      if (order.status !== 'placed') {
        throw conflict(`This order is already ${order.status}`);
      }

      await client.query(
        `UPDATE orders SET status = 'cancelled'
         WHERE id = $1 AND status = 'placed'`,
        [id]
      );

      await client.query(
        `UPDATE paintings SET status = 'available'
         WHERE id = $1`,
        [order.painting_id]
      );
    });

    return orderOut(user, await getOrder(user, id));
  });
    // Wall bookings
  const LIVE = "('requested','confirmed')";

  route('GET', '/api/bookings/taken-dates', [], async () =>
    (
      await pool.query(
        `SELECT date FROM bookings
         WHERE status IN ${LIVE}
         ORDER BY date`
      )
    ).rows.map((r) => r.date)
  );

  route('POST', '/api/bookings', ['customer'], async ({ user, body }) => {
    const R = RULES.booking;
    const date = str(body.date, 'date', { max: 10 });
    const days = U.daysFromToday(date, tz);

    if (days === null) {
      throw bad('date must be a real date in YYYY-MM-DD format');
    }

    if (days < R.minDays || days > R.maxDays) {
      throw bad(
        `date must be between ${R.minDays} and ${R.maxDays} days from today`
      );
    }

    const size = num(body.wallSizeSqFt, 'wallSizeSqFt', {
      min: R.minSqFt,
      max: R.maxSqFt,
    });
    const address = str(body.address, 'address', { min: 5, max: 300 });
    const rate = Number(await setting('ratePerSqFt'));
    const price = Math.round(size * rate * 100) / 100;
    let id;

    try {
      id = await tx(async (client) => {
        const existing = await client.query(
          `SELECT 1 FROM bookings
           WHERE date = $1 AND status IN ${LIVE}
           FOR UPDATE`,
          [date]
        );

        if (existing.rowCount) {
          throw conflict(
            'Sorry, that date has just been taken. Please choose another date.'
          );
        }

        return (
          await client.query(
            `INSERT INTO bookings
              (user_id, date, wall_size_sqft, address,
               rate_per_sqft, price, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'requested')
             RETURNING id`,
            [user.id, date, size, address, rate, price]
          )
        ).rows[0].id;
      });
    } catch (e) {
      if (isUnique(e)) {
        throw conflict(
          'Sorry, that date has just been taken. Please choose another date.'
        );
      }

      throw e;
    }

    return created(bookingOut(user, await getBooking(user, id)));
  });

  route('GET', '/api/bookings', [], async ({ user, query }) => {
    const status = statusFilter(query);

    return (
      await pool.query(
        `${BOOKING_SQL}
         WHERE ($1::bigint IS NULL OR b.user_id = $1)
           AND ($2::text IS NULL OR b.status = $2)
         ORDER BY b.date`,
        [ownerOf(user), status]
      )
    ).rows.map((r) => bookingOut(user, r));
  });

  route('GET', '/api/bookings/:id', [], async ({ user, params }) => {
    const booking = await getBooking(user, toId(params.id));

    if (!booking) throw notFound('Booking');

    return bookingOut(user, booking);
  });

  route('POST', '/api/bookings/:id/cancel', ['customer'], async ({ user, params }) => {
    const id = toId(params.id);

    await tx(async (client) => {
      const booking = await getBooking(user, id, client);

      if (!booking) throw notFound('Booking');

      if (!['requested', 'confirmed'].includes(booking.status)) {
        throw conflict(`This booking is already ${booking.status}`);
      }

      if (
        U.daysFromToday(
          String(booking.date).slice(0, 10),
          tz
        ) < RULES.booking.cancelBeforeDays
      ) {
        throw conflict(
          `A booking can only be cancelled until ${RULES.booking.cancelBeforeDays} days before the date`
        );
      }

      await client.query(
        `UPDATE bookings SET status = 'cancelled'
         WHERE id = $1 AND status IN ${LIVE}`,
        [id]
      );
    });

    return bookingOut(user, await getBooking(user, id));
  });

  const bookingDecision = (verb, status) =>
    route(
      'POST',
      `/api/bookings/:id/${verb}`,
      ['admin'],
      async ({ user, params }) => {
        const id = toId(params.id);

        await tx(async (client) => {
          const booking = await getBooking(user, id, client);

          if (!booking) throw notFound('Booking');

          if (booking.status !== 'requested') {
            throw conflict(
              `Only a requested booking can be ${status}; this one is ${booking.status}`
            );
          }

          await client.query(
            `UPDATE bookings SET status = $1
             WHERE id = $2 AND status = 'requested'`,
            [status, id]
          );
        });

        return bookingOut(user, await getBooking(user, id));
      }
    );

  bookingDecision('confirm', 'confirmed');
  bookingDecision('decline', 'declined');

  // Pottery requests
  route('POST', '/api/pottery', ['customer'], async ({ user, body }) => {
    const itemId = str(body.itemId, 'itemId', { max: 50 });
    const glazeId = str(body.glazeId, 'glazeId', { max: 50 });

    await potteryRefs(itemId, glazeId);

    const qty = quantity(body.quantity);
    const by = neededBy(body.neededBy);

    const id = (
      await pool.query(
        `INSERT INTO pottery_requests
          (user_id, item_id, glaze_id, quantity, needed_by, status)
         VALUES ($1, $2, $3, $4, $5, 'requested')
         RETURNING id`,
        [user.id, itemId, glazeId, qty, by]
      )
    ).rows[0].id;

    return created(potteryOut(user, await getPottery(user, id)));
  });

  route('GET', '/api/pottery', [], async ({ user, query }) => {
    const status = statusFilter(query);

    return (
      await pool.query(
        `${POTTERY_SQL}
         WHERE ($1::bigint IS NULL OR r.user_id = $1)
           AND ($2::text IS NULL OR r.status = $2)
         ORDER BY r.id DESC`,
        [ownerOf(user), status]
      )
    ).rows.map((r) => potteryOut(user, r));
  });

  route('GET', '/api/pottery/:id', [], async ({ user, params }) => {
    const request = await getPottery(user, toId(params.id));

    if (!request) throw notFound('Pottery request');

    return potteryOut(user, request);
  });

  route('PATCH', '/api/pottery/:id', ['customer'], async ({ user, params, body }) => {
    const id = toId(params.id);

    await tx(async (client) => {
      const request = await getPottery(user, id, client);

      if (!request) throw notFound('Pottery request');

      if (request.status !== 'requested') {
        throw conflict(
          `Only a request that is still "requested" can be edited; this one is ${request.status}`
        );
      }

      const itemId = body.itemId === undefined
        ? request.item_id
        : str(body.itemId, 'itemId', { max: 50 });

      const glazeId = body.glazeId === undefined
        ? request.glaze_id
        : str(body.glazeId, 'glazeId', { max: 50 });

      await potteryRefs(itemId, glazeId, client);

      const qty = body.quantity === undefined
        ? request.quantity
        : quantity(body.quantity);

      const by = body.neededBy === undefined
        ? request.needed_by
        : neededBy(body.neededBy);

      await client.query(
        `UPDATE pottery_requests
         SET item_id = $1, glaze_id = $2,
             quantity = $3, needed_by = $4
         WHERE id = $5 AND status = 'requested'`,
        [itemId, glazeId, qty, by, id]
      );
    });

    return potteryOut(user, await getPottery(user, id));
  });

  route('POST', '/api/pottery/:id/cancel', ['customer'], async ({ user, params }) => {
    const id = toId(params.id);

    await tx(async (client) => {
      const request = await getPottery(user, id, client);

      if (!request) throw notFound('Pottery request');

      if (request.status !== 'requested') {
        throw conflict(
          `Only a request that is still "requested" can be cancelled; this one is ${request.status}`
        );
      }

      await client.query(
        `UPDATE pottery_requests SET status = 'cancelled'
         WHERE id = $1 AND status = 'requested'`,
        [id]
      );
    });

    return potteryOut(user, await getPottery(user, id));
  });

  const potteryDecision = (verb, status) =>
    route(
      'POST',
      `/api/pottery/:id/${verb}`,
      ['admin'],
      async ({ user, params }) => {
        const id = toId(params.id);

        await tx(async (client) => {
          const request = await getPottery(user, id, client);

          if (!request) throw notFound('Pottery request');

          if (request.status !== 'requested') {
            throw conflict(
              `Only a requested item can be ${status}; this one is ${request.status}`
            );
          }

          await client.query(
            `UPDATE pottery_requests SET status = $1
             WHERE id = $2 AND status = 'requested'`,
            [status, id]
          );
        });

        return potteryOut(user, await getPottery(user, id));
      }
    );

  potteryDecision('accept', 'accepted');
  potteryDecision('decline', 'declined');

  // HTTP helpers
  function send(res, status, body) {
    const data = JSON.stringify(body);

    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });

    res.end(data);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;

      req.on('data', (chunk) => {
        size += chunk.length;

        if (size > 100_000) {
          reject(
            new HttpError(413, 'TOO_LARGE', 'Request body too large')
          );
          req.destroy();
          return;
        }

        chunks.push(chunk);
      });

      req.on('end', () => {
        if (!chunks.length) return resolve({});

        try {
          const value = JSON.parse(
            Buffer.concat(chunks).toString('utf8')
          );

          if (
            value === null ||
            typeof value !== 'object' ||
            Array.isArray(value)
          ) {
            throw new Error();
          }

          resolve(value);
        } catch {
          reject(bad('Request body must be a JSON object'));
        }
      });

      req.on('error', reject);
    });
  }

  async function authenticate(req) {
    const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(
      req.headers.authorization || ''
    );

    if (!match) return null;

    const token = match[1].toLowerCase();

    const session = (
      await pool.query(
        'SELECT * FROM sessions WHERE token = $1',
        [token]
      )
    ).rows[0];

    if (!session) return null;

    if (Number(session.expires_at) < Date.now()) {
      await pool.query(
        'DELETE FROM sessions WHERE token = $1',
        [token]
      );

      return null;
    }

    const user = (
      await pool.query(
        'SELECT * FROM users WHERE id = $1',
        [session.user_id]
      )
    ).rows[0];

    return user ? { user, token } : null;
  }

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? '/index.html' : pathname;
    let file;

    try {
      file = path.resolve(PUBLIC_DIR, '.' + decodeURIComponent(rel));
    } catch {
      return send(res, 400, {
        error: {
          code: 'BAD_PATH',
          message: 'Invalid path',
        },
      });
    }

    if (
      !(file === PUBLIC_DIR || file.startsWith(PUBLIC_DIR + path.sep)) ||
      !fs.existsSync(file) ||
      !fs.statSync(file).isFile()
    ) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });

    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    try {
      await ready();

      const url = new URL(req.url, 'http://localhost');

      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          throw new HttpError(
            405,
            'METHOD_NOT_ALLOWED',
            'Method not allowed'
          );
        }

        return serveStatic(res, url.pathname);
      }

      let pathMatched = false;

      for (const r of routes) {
        const match = r.re.exec(url.pathname);

        if (!match) continue;

        pathMatched = true;

        if (r.method !== req.method) continue;

        const params = {};

        r.keys.forEach((key, i) => {
          params[key] = decodeURIComponent(match[i + 1]);
        });

        let auth = null;

        if (r.roles) {
          auth = await authenticate(req);

          if (!auth) {
            throw new HttpError(
              401,
              'UNAUTHENTICATED',
              'Please log in'
            );
          }

          if (
            r.roles.length &&
            !r.roles.includes(auth.user.role)
          ) {
            throw new HttpError(
              403,
              'FORBIDDEN',
              'Your role is not allowed to do this'
            );
          }
        }

        const body = req.method === 'GET'
          ? {}
          : await readBody(req);

        const output = await r.handler({
          req,
          params,
          query: url.searchParams,
          body,
          user: auth && auth.user,
          token: auth && auth.token,
        });

        if (
          output &&
          output.status &&
          output.body !== undefined
        ) {
          return send(res, output.status, output.body);
        }

        return send(res, 200, output);
      }

      if (pathMatched) {
        throw new HttpError(
          405,
          'METHOD_NOT_ALLOWED',
          'Method not allowed'
        );
      }

      throw new HttpError(
        404,
        'NOT_FOUND',
        'Endpoint not found'
      );
    } catch (e) {
      if (e instanceof HttpError) {
        return send(res, e.status, {
          error: {
            code: e.code,
            message: e.message,
          },
        });
      }

      console.error(e);

      return send(res, 500, {
        error: {
          code: 'INTERNAL',
          message: 'Something went wrong on the server',
        },
      });
    }
  }

  return {
    pool,
    server: http.createServer(handle),
    close: async () => {
      await closePool();
    },
  };
}

if (require.main === module) {
  loadEnvFile();

  const port = Number(process.env.PORT) || 3000;

  const app = createApp({
    tz: process.env.STUDIO_TZ || 'Asia/Kolkata',
    sessionHours: Number(process.env.SESSION_HOURS) || 24,
  });

  app.server.listen(port, () => {
    console.log(
      `Art Studio (PostgreSQL) running at http://localhost:${port}`
    );
  });
}

module.exports = {
  createApp,
  initializeDatabase,
};
