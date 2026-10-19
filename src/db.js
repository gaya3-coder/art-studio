'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./util');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer','admin'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS paintings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL CHECK (price > 0),
  image_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','sold'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  painting_id TEXT NOT NULL REFERENCES paintings(id),
  price REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('placed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Backstop: a painting can have at most one active order, enforced by the database itself.
CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_one_active_per_painting
  ON orders(painting_id) WHERE status = 'placed';

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  wall_size_sqft REAL NOT NULL,
  address TEXT NOT NULL,
  rate_per_sqft REAL NOT NULL,
  price REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested','confirmed','declined','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Backstop: a date can be held by only one live (requested/confirmed) booking.
-- Declined and cancelled bookings release the date.
CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_one_live_per_date
  ON bookings(date) WHERE status IN ('requested','confirmed');

CREATE TABLE IF NOT EXISTS pottery_items (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS glazes (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pottery_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  item_id TEXT NOT NULL REFERENCES pottery_items(id),
  glaze_id TEXT NOT NULL REFERENCES glazes(id),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 12),
  needed_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested','accepted','declined','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/** Load seed/seed.json once (only when the paintings table is empty). */
function seedIfEmpty(db, seedFile) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM paintings').get();
  if (n > 0) return false;
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  db.exec('BEGIN');
  try {
    const addP = db.prepare(
      'INSERT INTO paintings (id,title,artist,description,price,image_url,status) VALUES (?,?,?,?,?,?,?)');
    for (const p of seed.paintings) {
      const img = p.imageUrl ? '/' + p.imageUrl.replace(/^\/+/, '') : '';
      addP.run(p.id, p.title, p.artist, p.description || '', p.price, img, p.status);
    }
    const addI = db.prepare('INSERT INTO pottery_items (id,name) VALUES (?,?)');
    seed.potteryItems.forEach((i) => addI.run(i.id, i.name));
    const addG = db.prepare('INSERT INTO glazes (id,name) VALUES (?,?)');
    seed.glazes.forEach((g) => addG.run(g.id, g.name));
    db.prepare('INSERT INTO settings (key,value) VALUES (?,?)')
      .run('ratePerSqFt', String(seed.mural.ratePerSqFt));
    db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('currency', seed.currency || 'INR');
    // The seed calls the studio account role "studio"; in this app that is the Admin role.
    const s = seed.studioAccount;
    db.prepare('INSERT OR IGNORE INTO users (name,email,password_hash,role) VALUES (?,?,?,?)')
      .run('Studio', s.email.toLowerCase(), hashPassword(s.password), 'admin');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return true;
}

module.exports = { openDb, seedIfEmpty };
