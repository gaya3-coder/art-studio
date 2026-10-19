'use strict';
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (msg) => new HttpError(400, 'VALIDATION', msg);
const conflict = (msg) => new HttpError(409, 'CONFLICT', msg);
const notFound = (what = 'Record') => new HttpError(404, 'NOT_FOUND', `${what} not found`);

// ---- passwords: scrypt with a per-user random salt -------------------------------------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// ---- dates: plain YYYY-MM-DD strings, "today" decided in the studio timezone -----------------
function todayString(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz }); // en-CA => YYYY-MM-DD
}
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return t;
}
/** Whole days from today (studio tz) to the given date string; null if the string is not a real date. */
function daysFromToday(s, tz) {
  const t = parseDate(s);
  if (t === null) return null;
  return Math.round((t - parseDate(todayString(tz))) / 86400000);
}

// ---- small validators -----------------------------------------------------------------------
function str(v, field, { min = 1, max = 300 } = {}) {
  if (typeof v !== 'string') throw bad(`${field} is required`);
  const t = v.trim();
  if (t.length < min) throw bad(min === 1 ? `${field} is required` : `${field} must be at least ${min} characters`);
  if (t.length > max) throw bad(`${field} must be at most ${max} characters`);
  return t;
}
function num(v, field, { min, max, integer = false } = {}) {
  if (typeof v === 'string' && v.trim() !== '') v = Number(v);
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${field} must be a number`);
  if (integer && !Number.isInteger(v)) throw bad(`${field} must be a whole number`);
  if (min !== undefined && v < min) throw bad(`${field} must be at least ${min}`);
  if (max !== undefined && v > max) throw bad(`${field} must be at most ${max}`);
  return v;
}

module.exports = { HttpError, bad, conflict, notFound, hashPassword, verifyPassword, todayString, daysFromToday, str, num };
