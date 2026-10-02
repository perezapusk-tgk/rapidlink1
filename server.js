/*
Torclix Group — backend платформы записи.
*/
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const fs = require('fs');

const CONFIG_FILE = path.join(__dirname, 'config.json');
let CONFIG = { jwtSecret: 'replace-me', telegramBotToken: '', telegramChatId: '', allowedOrigin: null };
if (fs.existsSync(CONFIG_FILE)) {
  try { CONFIG = Object.assign(CONFIG, JSON.parse(fs.readFileSync(CONFIG_FILE))); }
  catch (e) { console.warn('config err', e); }
}

if (process.env.JWT_SECRET) CONFIG.jwtSecret = process.env.JWT_SECRET;
if (process.env.TELEGRAM_BOT_TOKEN) CONFIG.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
if (process.env.TELEGRAM_CHAT_ID) CONFIG.telegramChatId = process.env.TELEGRAM_CHAT_ID;
if (!CONFIG.jwtSecret || CONFIG.jwtSecret === 'replace-me' || String(CONFIG.jwtSecret).length < 32) {
  console.error('FATAL: задайте JWT_SECRET (32+ символов) в переменных окружения. Запуск остановлен.');
  process.exit(1);
}
// Миграции ДО открытия БД: new Database() сам создаёт пустой файл, поэтому старая проверка после него не срабатывала никогда.
function dbMissing(f) { const p = path.join(__dirname, f); return !fs.existsSync(p) || fs.statSync(p).size === 0; }
if (dbMissing('app.db')) {
  console.log('→ app.db нет или пуста — запускаю миграции...');
  try {
    require('child_process').execSync('node migrate.js', { stdio: 'inherit', cwd: __dirname });
    require('child_process').execSync('node migrate-tenants.js', { stdio: 'inherit', cwd: __dirname });
  } catch (e) { console.error('Migration error:', e.message); }
}
if (dbMissing('platform.db')) {
  console.log('→ platform.db нет или пуста — запускаю миграции...');
  try { require('child_process').execSync('node migrate-platform.js', { stdio: 'inherit', cwd: __dirname }); }
  catch (e) { console.error('Platform migration error:', e.message); }
}
const db = new Database(path.join(__dirname, 'app.db'));
db.pragma('journal_mode = WAL'); // нужен для потоковых копий Litestream
try {
  if (!db.prepare('PRAGMA table_info(washers)').all().some(function(c) { return c.name === 'pin_hash'; })) db.exec('ALTER TABLE washers ADD COLUMN pin_hash TEXT');
  if (!db.prepare('PRAGMA table_info(bookings)').all().some(function(c) { return c.name === 'car'; })) db.exec('ALTER TABLE bookings ADD COLUMN car TEXT');
  if (!db.prepare('PRAGMA table_info(bookings)').all().some(function(c) { return c.name === 'extra_json'; })) db.exec('ALTER TABLE bookings ADD COLUMN extra_json TEXT');
  var bcols = db.prepare('PRAGMA table_info(bookings)').all().map(function(c) { return c.name; });
  if (bcols.indexOf('extra_json') === -1) db.exec('ALTER TABLE bookings ADD COLUMN extra_json TEXT');
  if (bcols.indexOf('consent_at') === -1) db.exec('ALTER TABLE bookings ADD COLUMN consent_at TEXT');
  if (!db.prepare('PRAGMA table_info(services)').all().some(function(c) { return c.name === 'active'; })) db.exec('ALTER TABLE services ADD COLUMN active INTEGER DEFAULT 1');
} catch (e) { console.error('pin_hash:', e.message); }
let platformDb = null;
if (fs.existsSync(path.join(__dirname, 'platform.db'))) {
  platformDb = new Database(path.join(__dirname, 'platform.db'));
  platformDb.pragma('journal_mode = WAL');
}

// Тенант 1 (ваша мойка) не должен принадлежать студии №1: иначе первый покупатель увидит и сможет заархивировать его.
try { db.prepare('UPDATE tenants SET studio_id = 0 WHERE id = 1 AND (studio_id IS NULL OR studio_id != 0)').run(); } catch (e) {}
try {
  if (db.prepare('SELECT password_hash FROM users').all().some(function(u) { return bcrypt.compareSync('admin123', u.password_hash); }))
    console.error('!!! ПАРОЛЬ АДМИНА ПО УМОЛЧАНИЮ (admin123). Задайте ADMIN_USERNAME и ADMIN_PASSWORD в окружении.');
  if (platformDb && platformDb.prepare('SELECT password_hash FROM platform_admins').all().some(function(u) { return bcrypt.compareSync('rapidlink2026', u.password_hash); }))
    console.error('!!! ПАРОЛЬ ВЛАДЕЛЬЦА ПО УМОЛЧАНИЮ (rapidlink2026). Задайте PLATFORM_ADMIN и PLATFORM_PASSWORD в окружении.');
} catch (e) {}
const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: function(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

function rub(n) { return n.toLocaleString('ru-RU') + ' ₽'; }

function sendTelegram(text) {
  if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) return;
  fetch('https://api.telegram.org/bot' + CONFIG.telegramBotToken + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CONFIG.telegramChatId, text, parse_mode: 'HTML' })
  }).then(function(r) { return r.text(); }).catch(function(e) { console.warn('tg', e); });
}

function rateLimit(opts) {
  const windowMs = opts.windowMs, max = opts.max;
  const hits = new Map();
  return function(req, res, next) {
    const k = opts.byBody ? req.ip + '|' + String((req.body && (req.body.phone || req.body.username || req.body.license_key)) || '') : req.ip, now = Date.now(), rec = hits.get(k);
    if (!rec || now - rec.start > windowMs) { hits.set(k, { start: now, count: 1 }); return next(); }
    rec.count++;
    if (rec.count > max) return res.status(429).json({ error: opts.code || 'too_many_requests' });
    next();
  };
}
const loginLimiter = rateLimit({ windowMs: 600000, max: 15 });
const phoneLimiter = rateLimit({ windowMs: 600000, max: 8, byBody: true });
// Сотрудники: блокировка всего на 1 минуту, но не более 30 попыток в сутки на связку IP+телефон (защита PIN от перебора)
const washerIpLimiter = rateLimit({ windowMs: 60000, max: 20 });
const washerMinLimiter = rateLimit({ windowMs: 60000, max: 5, byBody: true });
const washerDayLimiter = rateLimit({ windowMs: 86400000, max: 30, byBody: true, code: 'locked_today' });
const bookingLimiter = rateLimit({ windowMs: 60000, max: 10 });

function isValidDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function isValidHour(h) { const n = parseInt(h, 10); return Number.isInteger(n) && n >= 0 && n <= 23; }
function isValidPhone(p) { return typeof p === 'string' && p.replace(/\D/g, '').length >= 10; }
function isValidSubdomain(s) { return typeof s === 'string' && /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(s); }

function authMiddleware(req, res, next) {
  const h = req.headers['authorization'];
  if (!h) return res.status(401).json({ error: 'no auth' });
  try {
    const p = jwt.verify(h.split(' ')[1], CONFIG.jwtSecret);
    if (['washer', 'studio', 'platform_owner'].indexOf(p.role) !== -1) return res.status(403).json({ error: 'not admin' });
    req.user = p; next();
  } catch (e) { return res.status(401).json({ error: 'invalid' }); }
}
function washerAuth(req, res, next) {
  const h = req.headers['authorization'];
  if (!h) return res.status(401).json({ error: 'no auth' });
  try {
    const p = jwt.verify(h.split(' ')[1], CONFIG.jwtSecret);
    if (p.role !== 'washer') return res.status(403).json({ error: 'not washer' });
    req.washer = p; next();
  } catch (e) { return res.status(401).json({ error: 'invalid' }); }
}
function studioAuth(req, res, next) {
  const h = req.headers['authorization'];
  if (!h) return res.status(401).json({ error: 'no auth' });
  try {
    const p = jwt.verify(h.split(' ')[1], CONFIG.jwtSecret);
    if (p.role !== 'studio') return res.status(403).json({ error: 'not studio' });
    req.studio = p; next();
  } catch (e) { return res.status(401).json({ error: 'invalid' }); }
}
function platformOwnerAuth(req, res, next) {
  const h = req.headers['authorization'];
  if (!h) return res.status(401).json({ error: 'no auth' });
  try {
    const p = jwt.verify(h.split(' ')[1], CONFIG.jwtSecret);
    if (p.role !== 'platform_owner') return res.status(403).json({ error: 'not owner' });
    req.owner = p; next();
  } catch (e) { return res.status(401).json({ error: 'invalid' }); }
}

function tenantFromReferer(req) {
  try { const r = req.headers.referer; if (!r) return null; const t = new URL(r).searchParams.get('tenant'); return t ? String(t) : null; }
  catch (e) { return null; }
}
function resolveTenantId(req) {
  const s = req.query.tenant || tenantFromReferer(req) || (req.hostname || '').split('.')[0];
  if (!s || s === 'demo-2-pkbp' || s === 'localhost' || s === 'www') return 1;
  const row = db.prepare('SELECT id FROM tenants WHERE subdomain = ?').get(s);
  return row ? row.id : 1;
}

app.get('/healthz', function(req, res) { res.json({ ok: true }); });

app.use('/api', function(req, res, next) {
  const RESERVED = ['demo-2-pkbp', 'localhost', 'www'];
  const explicit = req.query.tenant || tenantFromReferer(req);
  const s = explicit || (req.hostname || '').split('.')[0];
  if (!s || RESERVED.indexOf(s) !== -1) return next();
  let row;
  try { row = db.prepare('SELECT status FROM tenants WHERE subdomain = ?').get(String(s)); } catch (e) { return next(); }
  if (row && row.status !== 'active') return res.status(404).json({ error: 'tenant_not_found' });
  if (!row && explicit) return res.status(404).json({ error: 'tenant_not_found' });
  next();
});

/* ============ ПУБЛИЧНЫЕ ============ */

app.get('/api/vertical', function(req, res) {
  const tid = resolveTenantId(req);
  const services = db.prepare('SELECT id,name,price,duration,vehicle_class FROM services WHERE tenant_id = ? AND active = 1 ORDER BY vehicle_class, id').all(tid);
  const classes = db.prepare('SELECT id,name FROM classes WHERE tenant_id = ? ORDER BY id').all(tid);
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);
  res.json({ services: services, classes: classes, capacity: 2, businessName: tenant ? tenant.business_name : '', city: '', tenant_id: tid, vertical_code: tenant ? tenant.vertical_code : 'wash' });
});

app.get('/api/slots', function(req, res) {
  const tid = resolveTenantId(req);
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const counts = {};
  db.prepare('SELECT hour, COUNT(*) as cnt FROM bookings WHERE date = ? AND status = ? AND tenant_id = ? GROUP BY hour').all(date, 'confirmed', tid).forEach(function(r) { counts[r.hour] = r.cnt; });
  const slots = [];
  for (let h = 0; h < 24; h++) { const used = counts[h] || 0; slots.push({ hour: h, remaining: Math.max(0, 2 - used) }); }
  res.json({ date: date, capacity: 2, slots: slots });
});

app.post('/api/bookings', bookingLimiter, function(req, res) {
  const tid = resolveTenantId(req);
  const body = req.body || {};
  const name = body.name, phone = body.phone, vehicle_class_id = body.vehicle_class_id;
  const service_ids = body.service_ids, date = body.date, hour = body.hour;
  const car = typeof body.car === 'string' ? body.car.trim().slice(0, 100) : '';
  if (!name || !name.trim() || name.length > 100) return res.status(400).json({ error: 'invalid name' });
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'invalid phone' });
  if (!Number.isInteger(vehicle_class_id)) return res.status(400).json({ error: 'invalid vehicle_class_id' });
  if (!Array.isArray(service_ids) || !service_ids.length || !service_ids.every(Number.isInteger)) return res.status(400).json({ error: 'invalid service_ids' });
  if (!isValidDate(date)) return res.status(400).json({ error: 'invalid date' });
  if (!isValidHour(hour)) return res.status(400).json({ error: 'invalid hour' });
  if (body.consent !== true) return res.status(400).json({ error: 'consent_required' });
  try {
    const result = db.transaction(function() {
      const cnt = db.prepare('SELECT COUNT(*) as cnt FROM bookings WHERE date=? AND hour=? AND status=? AND tenant_id=?').get(date, hour, 'confirmed', tid);
      if (cnt.cnt >= 2) { const e = new Error('slot_full'); e.code = 'slot_full'; throw e; }
      const placeholders = service_ids.map(function() { return '?'; }).join(',');
      const svcStmt = db.prepare('SELECT id, name, price FROM services WHERE id IN (' + placeholders + ') AND vehicle_class = ? AND tenant_id = ? AND active = 1');
      const svcRows = svcStmt.all.apply(svcStmt, service_ids.concat([vehicle_class_id, tid]));
      if (svcRows.length !== service_ids.length) { const e = new Error('invalid_services'); e.code = 'invalid_services'; throw e; }
      const total = svcRows.reduce(function(s, r) { return s + r.price; }, 0);
      const code = (Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase());
      db.prepare('INSERT INTO bookings(booking_code, name, phone, vehicle_class_id, services_json, total, date, hour, status, created_at, tenant_id, car, consent_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(code, name.trim(), phone.trim(), vehicle_class_id, JSON.stringify(service_ids), total, date, hour, 'confirmed', new Date().toISOString(), tid, car, new Date().toISOString());
      const rec = db.prepare('SELECT * FROM bookings WHERE booking_code = ?').get(code);
      const cls = db.prepare('SELECT name FROM classes WHERE id=?').get(vehicle_class_id);
      return { rec: rec, cls: cls, svcRows: svcRows };
    })();
    const names = result.svcRows.map(function(r) { return r.name; }).join(', ');
    sendTelegram('🆕 <b>Новая запись</b>\n№ ' + result.rec.booking_code + '\n' + result.rec.name + ', ' + result.rec.phone + '\nКласс: ' + (result.cls ? result.cls.name : '') + '\nУслуги: ' + names + '\nКогда: ' + date + ', ' + String(hour).padStart(2, '0') + ':00\nИтого: ' + rub(result.rec.total));
    res.json({ ok: true, booking: result.rec });
  } catch (e) {
    if (e.code === 'slot_full') return res.status(409).json({ error: 'slot_full' });
    if (e.code === 'invalid_services') return res.status(400).json({ error: 'invalid_services' });
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/bookings', function(req, res) {
  const tid = resolveTenantId(req);
  if (!isValidPhone(req.query.phone)) return res.status(400).json({ error: 'valid phone required' });
  res.json({ bookings: db.prepare('SELECT * FROM bookings WHERE phone = ? AND tenant_id = ? ORDER BY created_at DESC').all(req.query.phone, tid) });
});

app.delete('/api/bookings/:code', function(req, res) {
  const tid = resolveTenantId(req);
  const phone = (req.body || {}).phone;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const rec = db.prepare('SELECT * FROM bookings WHERE booking_code = ? AND phone = ? AND tenant_id = ?').get(req.params.code, phone, tid);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run('cancelled', new Date().toISOString(), rec.id);
  sendTelegram('❌ <b>Отмена</b> № ' + rec.booking_code + ' · ' + rec.name);
  res.json({ ok: true });
});

/* ============ АДМИН ТЕНАНТА ============ */

app.post('/api/admin/login', loginLimiter, phoneLimiter, function(req, res) {
  const body = req.body || {};
  const username = body.username, password = body.password;
  if (!username || !password) return res.status(400).json({ error: 'missing' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'invalid' });
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'invalid' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, tenant_id: user.tenant_id || 1 }, CONFIG.jwtSecret, { expiresIn: '12h' });
  res.json({ token: token });
});

app.get('/api/admin/bookings', authMiddleware, function(req, res) {
  const tid = req.user.tenant_id || 1;
  const date = req.query.date;
  let rows;
  if (date) rows = db.prepare('SELECT b.*, c.name as class_name FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.date = ? AND b.tenant_id = ? ORDER BY b.hour').all(date, tid);
  else rows = db.prepare('SELECT b.*, c.name as class_name FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.tenant_id = ? ORDER BY b.created_at DESC LIMIT 200').all(tid);
  const svcNames = {};
  db.prepare('SELECT id, name FROM services WHERE tenant_id = ?').all(tid).forEach(function(sv) { svcNames[sv.id] = sv.name; });
  rows.forEach(function(r) {
    let names = [], extras = [];
    try { names = JSON.parse(r.services_json).map(function(id) { return svcNames[id] || ('#' + id); }); } catch (e) {}
    try { extras = JSON.parse(r.extra_json || '[]'); } catch (e) {}
    r.extras = extras;
    r.services_names = names.concat(extras.map(function(x) { return x.name; }));
  });
  res.json({ bookings: rows });
});

app.get('/api/admin/classes', authMiddleware, function(req, res) {
  res.json({ classes: db.prepare('SELECT id, name FROM classes WHERE tenant_id = ? ORDER BY id').all(req.user.tenant_id || 1) });
});

function cleanExtras(x) {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x) || x.length > 10) return null;
  const out = [];
  for (let i = 0; i < x.length; i++) {
    const nm = x[i] && typeof x[i].name === 'string' ? x[i].name.trim().slice(0, 100) : '';
    const pr = x[i] ? parseInt(x[i].price, 10) : NaN;
    if (!nm || !Number.isInteger(pr) || pr < 0 || pr > 1000000) return null;
    out.push({ name: nm, price: pr });
  }
  return out;
}

function prepareAdminBooking(tid, body) {
  const name = body.name, vehicle_class_id = body.vehicle_class_id, date = body.date, hour = body.hour;
  const phone = body.phone ? String(body.phone).trim() : '';
  const car = typeof body.car === 'string' ? body.car.trim().slice(0, 100) : '';
  const service_ids = body.service_ids === undefined ? [] : body.service_ids;
  const extras = cleanExtras(body.extras);
  const washerId = (body.assigned_washer_id === undefined || body.assigned_washer_id === null || body.assigned_washer_id === '') ? null : parseInt(body.assigned_washer_id, 10);
  if (!name || !String(name).trim() || String(name).length > 100) return { err: 'invalid name' };
  if (phone && !isValidPhone(phone)) return { err: 'invalid phone' };
  if (!Number.isInteger(vehicle_class_id)) return { err: 'invalid vehicle_class_id' };
  if (!Array.isArray(service_ids) || !service_ids.every(Number.isInteger)) return { err: 'invalid service_ids' };
  if (extras === null) return { err: 'invalid extras' };
  if (!service_ids.length && !extras.length) return { err: 'invalid service_ids' };
  if (!isValidDate(date)) return { err: 'invalid date' };
  if (!isValidHour(hour)) return { err: 'invalid hour' };
  if (!db.prepare('SELECT id FROM classes WHERE id = ? AND tenant_id = ?').get(vehicle_class_id, tid)) return { err: 'invalid vehicle_class_id' };
  if (washerId !== null && !db.prepare('SELECT id FROM washers WHERE id = ? AND tenant_id = ?').get(washerId, tid)) return { err: 'invalid washer' };
  let svcRows = [];
  if (service_ids.length) {
    const ph = service_ids.map(function() { return '?'; }).join(',');
    const st = db.prepare('SELECT id, name, price FROM services WHERE id IN (' + ph + ') AND vehicle_class = ? AND tenant_id = ?');
    svcRows = st.all.apply(st, service_ids.concat([vehicle_class_id, tid]));
    if (svcRows.length !== service_ids.length) return { err: 'invalid_services' };
  }
  let total = svcRows.reduce(function(a, r) { return a + r.price; }, 0) + extras.reduce(function(a, r) { return a + r.price; }, 0);
  if (body.total !== undefined && body.total !== null && body.total !== '') {
    const t = parseInt(body.total, 10);
    if (!Number.isInteger(t) || t < 0 || t > 10000000) return { err: 'invalid total' };
    total = t;
  }
  return { ok: { name: String(name).trim(), phone: phone, car: car, vehicle_class_id: vehicle_class_id, service_ids: service_ids, extras: extras, date: date, hour: hour, washerId: washerId, total: total } };
}

app.post('/api/admin/bookings', authMiddleware, function(req, res) {
  const tid = req.user.tenant_id || 1;
  const p = prepareAdminBooking(tid, req.body || {});
  if (p.err) return res.status(400).json({ error: p.err });
  const d = p.ok, force = (req.body || {}).force === true;
  try {
    const rec = db.transaction(function() {
      const cnt = db.prepare("SELECT COUNT(*) as cnt FROM bookings WHERE date=? AND hour=? AND status='confirmed' AND tenant_id=?").get(d.date, d.hour, tid);
      if (cnt.cnt >= 2 && !force) { const e = new Error('slot_full'); e.code = 'slot_full'; throw e; }
      const code = (Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase());
      db.prepare('INSERT INTO bookings(booking_code, name, phone, vehicle_class_id, services_json, total, date, hour, status, assigned_washer_id, created_at, tenant_id, car, extra_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(code, d.name, d.phone, d.vehicle_class_id, JSON.stringify(d.service_ids), d.total, d.date, d.hour, 'confirmed', d.washerId, new Date().toISOString(), tid, d.car, JSON.stringify(d.extras));
      return db.prepare('SELECT * FROM bookings WHERE booking_code = ?').get(code);
    })();
    sendTelegram('🆕 <b>Запись от администратора</b>\n№ ' + rec.booking_code + '\n' + rec.name + (d.car ? ', ' + d.car : '') + '\nКогда: ' + d.date + ', ' + String(d.hour).padStart(2, '0') + ':00\nИтого: ' + rub(rec.total));
    res.json({ ok: true, booking: rec });
  } catch (e) {
    if (e.code === 'slot_full') return res.status(409).json({ error: 'slot_full' });
    res.status(500).json({ error: 'internal_error' });
  }
});

app.put('/api/admin/bookings/:id', authMiddleware, function(req, res) {
  const tid = req.user.tenant_id || 1;
  const rec = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, tid);
  if (!rec) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  const p = prepareAdminBooking(tid, body);
  if (p.err) return res.status(400).json({ error: p.err });
  const d = p.ok;
  const status = body.status === undefined ? rec.status : body.status;
  if (['confirmed', 'in_progress', 'completed', 'cancelled'].indexOf(status) === -1) return res.status(400).json({ error: 'invalid status' });
  if (status === 'confirmed' && (d.date !== rec.date || d.hour !== rec.hour || rec.status !== 'confirmed') && body.force !== true) {
    const cnt = db.prepare("SELECT COUNT(*) as cnt FROM bookings WHERE date=? AND hour=? AND status='confirmed' AND tenant_id=? AND id != ?").get(d.date, d.hour, tid, rec.id);
    if (cnt.cnt >= 2) return res.status(409).json({ error: 'slot_full' });
  }
  db.prepare('UPDATE bookings SET name = ?, phone = ?, car = ?, vehicle_class_id = ?, services_json = ?, extra_json = ?, total = ?, date = ?, hour = ?, assigned_washer_id = ?, status = ?, updated_at = ? WHERE id = ?').run(d.name, d.phone, d.car, d.vehicle_class_id, JSON.stringify(d.service_ids), JSON.stringify(d.extras), d.total, d.date, d.hour, d.washerId, status, new Date().toISOString(), rec.id);
  res.json({ ok: true });
});

app.patch('/api/admin/bookings/:id', authMiddleware, function(req, res) {
  const body = req.body || {};
  const assigned_washer_id = body.assigned_washer_id, status = body.status;
  const rec = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id || 1);
  if (!rec) return res.status(404).json({ error: 'not found' });
  if (assigned_washer_id !== undefined && assigned_washer_id !== null && !db.prepare('SELECT id FROM washers WHERE id = ? AND tenant_id = ?').get(assigned_washer_id, req.user.tenant_id || 1)) return res.status(400).json({ error: 'invalid washer' });
  db.prepare('UPDATE bookings SET assigned_washer_id = ?, status = ?, updated_at = ? WHERE id = ?').run(assigned_washer_id !== undefined ? assigned_washer_id : rec.assigned_washer_id, status || rec.status, new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/bookings/:id/complete', authMiddleware, function(req, res) {
  const rec = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id || 1);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run('completed', new Date().toISOString(), rec.id);
  sendTelegram('🚗 <b>Готова</b> № ' + rec.booking_code + ' · ' + rec.name);
  res.json({ ok: true });
});

app.get('/api/admin/washers', authMiddleware, function(req, res) {
  res.json({ washers: db.prepare('SELECT id, name, phone, commission, tenant_id, (pin_hash IS NOT NULL) AS has_pin FROM washers WHERE tenant_id = ?').all(req.user.tenant_id || 1) });
});

app.post('/api/admin/washers', authMiddleware, function(req, res) {
  const body = req.body || {};
  const name = body.name, phone = body.phone, commission = body.commission;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const info = db.prepare('INSERT INTO washers(name, phone, commission, tenant_id) VALUES(?,?,?,?)').run(name.trim(), (phone || '').trim(), commission !== undefined ? parseFloat(commission) : 0.5, req.user.tenant_id || 1);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.patch('/api/admin/washers/:id', authMiddleware, function(req, res) {
  const body = req.body || {};
  const name = body.name, phone = body.phone, commission = body.commission;
  const rec = db.prepare('SELECT * FROM washers WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id || 1);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE washers SET name = ?, phone = ?, commission = ? WHERE id = ?').run(name !== undefined ? name : rec.name, phone !== undefined ? phone : rec.phone, commission !== undefined ? parseFloat(commission) : rec.commission, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/washers/:id', authMiddleware, function(req, res) {
  const rec = db.prepare('SELECT * FROM washers WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id || 1);
  if (!rec) return res.status(404).json({ error: 'not found' });
  const cnt = db.prepare('SELECT COUNT(*) as c FROM bookings WHERE assigned_washer_id = ?').get(req.params.id);
  if (cnt && cnt.c > 0) return res.status(400).json({ error: 'washer_has_bookings', count: cnt.c });
  db.prepare('DELETE FROM washers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/fines', authMiddleware, function(req, res) {
  const body = req.body || {};
  const washer_id = body.washer_id, amount = body.amount, reason = body.reason;
  if (!washer_id || amount === undefined) return res.status(400).json({ error: 'missing' });
  if (!db.prepare('SELECT id FROM washers WHERE id = ? AND tenant_id = ?').get(washer_id, req.user.tenant_id || 1)) return res.status(404).json({ error: 'washer not found' });
  db.prepare('INSERT INTO fines(washer_id, amount, reason, created_at, tenant_id) VALUES(?,?,?,?,?)').run(washer_id, amount, reason || '', new Date().toISOString(), req.user.tenant_id || 1);
  res.json({ ok: true });
});

app.get('/api/admin/reports/daily', authMiddleware, function(req, res) {
  const tid = req.user.tenant_id || 1;
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const rows = db.prepare('SELECT w.id as washer_id, w.name as washer_name, w.commission, COUNT(b.id) as bookings_count, COALESCE(SUM(b.total),0) as total_sum FROM washers w LEFT JOIN bookings b ON b.assigned_washer_id = w.id AND b.date = ? AND b.status IN (?, ?) WHERE w.tenant_id = ? GROUP BY w.id').all(date, 'confirmed', 'completed', tid);
  const finesRows = db.prepare('SELECT washer_id, COALESCE(SUM(amount),0) as fines_sum FROM fines WHERE date(created_at) = ? AND tenant_id = ? GROUP BY washer_id').all(date, tid);
  const fb = {};
  finesRows.forEach(function(f) { fb[f.washer_id] = f.fines_sum; });
  const result = rows.map(function(r) {
    const fines_sum = fb[r.washer_id] || 0;
    return { washer_id: r.washer_id, washer_name: r.washer_name, commission: r.commission, bookings_count: r.bookings_count, total_sum: r.total_sum, fines_sum: fines_sum, payout: Math.round(r.total_sum * r.commission - fines_sum) };
  });
  res.json({ date: date, rows: result });
});

app.get('/api/admin/services', authMiddleware, function(req, res) {
  res.json({ services: db.prepare('SELECT s.*, c.name as class_name FROM services s LEFT JOIN classes c ON c.id = s.vehicle_class WHERE s.tenant_id = ? ORDER BY s.vehicle_class, s.id').all(req.user.tenant_id || 1) });
});

app.post('/api/admin/services', authMiddleware, function(req, res) {
  const tid = req.user.tenant_id || 1;
  const items = (req.body || {}).items;
  if (!Array.isArray(items) || !items.length || items.length > 60) return res.status(400).json({ error: 'invalid items' });
  const classIds = db.prepare('SELECT id FROM classes WHERE tenant_id = ?').all(tid).map(function(r) { return r.id; });
  let created = 0, skipped = 0;
  db.transaction(function() {
    items.forEach(function(it) {
      const nm = it && typeof it.name === 'string' ? it.name.trim().slice(0, 120) : '';
      const dur = parseInt(it && it.duration, 10);
      if (!nm || !(dur > 0 && dur <= 1440) || !it.prices || typeof it.prices !== 'object') return;
      Object.keys(it.prices).forEach(function(cid) {
        const c = parseInt(cid, 10), pr = parseInt(it.prices[cid], 10);
        if (classIds.indexOf(c) === -1 || !(pr >= 0 && pr <= 10000000)) return;
        if (db.prepare('SELECT id FROM services WHERE name = ? AND vehicle_class = ? AND tenant_id = ?').get(nm, c, tid)) { skipped++; return; }
        db.prepare('INSERT INTO services(name, price, duration, vehicle_class, tenant_id, active) VALUES(?,?,?,?,?,1)').run(nm, pr, dur, c, tid);
        created++;
      });
    });
  })();
  res.json({ ok: true, created: created, skipped: skipped });
});

app.post('/api/admin/services/:id/active', authMiddleware, function(req, res) {
  const rec = db.prepare('SELECT id FROM services WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id || 1);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE services SET active = ? WHERE id = ?').run((req.body || {}).active ? 1 : 0, rec.id);
  res.json({ ok: true });
});

app.patch('/api/admin/services/:id', authMiddleware, function(req, res) {
  const body = req.body || {};
  const price = body.price, name = body.name, duration = body.duration;
  const rec = db.prepare('SELECT * FROM services WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id || 1);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE services SET price = ?, name = ?, duration = ? WHERE id = ?').run(price !== undefined ? parseInt(price, 10) : rec.price, name !== undefined ? name : rec.name, duration !== undefined ? parseInt(duration, 10) : rec.duration, req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/export/bookings', authMiddleware, function(req, res) {
  const tid = req.user.tenant_id || 1;
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const rows = db.prepare('SELECT b.booking_code, b.name, b.phone, c.name AS class_name, b.services_json, b.total, b.hour, b.status FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.date = ? AND b.tenant_id = ?').all(date, tid);
  const esc = function(s) { return '"' + String(s).replace(/"/g, '""') + '"'; };
  const csv = ['code;name;phone;class;services;total;hour;status'].concat(rows.map(function(r) { return [r.booking_code, esc(r.name), r.phone, r.class_name, esc(r.services_json), r.total, r.hour, r.status].join(';'); })).join('\n');
  res.setHeader('Content-disposition', 'attachment; filename=bookings_' + date + '.csv');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send('\uFEFF' + csv);
});

app.post('/api/admin/washers/:id/pin', authMiddleware, function(req, res) {
  const pin = String((req.body || {}).pin || '');
  if (!/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: 'pin must be 4-6 digits' });
  const rec = db.prepare('SELECT id FROM washers WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id || 1);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE washers SET pin_hash = ? WHERE id = ?').run(bcrypt.hashSync(pin, 10), rec.id);
  res.json({ ok: true });
});

/* ============ КАБИНЕТ МОЙЩИКА ============ */

app.post('/api/washer/login', washerIpLimiter, washerMinLimiter, washerDayLimiter, function(req, res) {
  const body = req.body || {};
  const phone = body.phone;
  if (!phone || !body.pin) return res.status(400).json({ error: 'phone and pin required' });
  const tid = resolveTenantId(req);
  const norm = phone.replace(/\D/g, '');
  const allWashers = db.prepare('SELECT * FROM washers WHERE tenant_id = ?').all(tid);
  const washer = allWashers.find(function(w) { return (w.phone || '').replace(/\D/g, '') === norm && norm.length >= 10; });
  if (!washer || !washer.pin_hash || !bcrypt.compareSync(String(body.pin), washer.pin_hash)) return res.status(401).json({ error: 'invalid_credentials' });
  const token = jwt.sign({ washer_id: washer.id, name: washer.name, role: 'washer', tenant_id: tid }, CONFIG.jwtSecret, { expiresIn: '14h' });
  res.json({ token: token, washer: { id: washer.id, name: washer.name, phone: washer.phone, commission: washer.commission } });
});

app.get('/api/washer/bookings', washerAuth, function(req, res) {
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const rows = db.prepare('SELECT b.*, c.name as class_name FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.assigned_washer_id = ? AND b.date = ? ORDER BY b.hour').all(req.washer.washer_id, date);
  const finesRow = db.prepare('SELECT COALESCE(SUM(amount),0) as sum FROM fines WHERE washer_id = ? AND date(created_at) = ?').get(req.washer.washer_id, date);
  const washer = db.prepare('SELECT * FROM washers WHERE id = ?').get(req.washer.washer_id);
  const ok = rows.filter(function(r) { return r.status === 'confirmed' || r.status === 'completed'; });
  const total_sum = ok.reduce(function(s, r) { return s + r.total; }, 0);
  const fines_sum = finesRow ? finesRow.sum : 0;
  const commission = washer ? washer.commission : 0.5;
  res.json({ date: date, bookings: rows, summary: { total_sum: total_sum, fines_sum: fines_sum, payout: Math.round(total_sum * commission - fines_sum), commission: commission } });
});

app.post('/api/washer/bookings/:id/status', washerAuth, function(req, res) {
  const status = (req.body || {}).status;
  if (status !== 'in_progress' && status !== 'completed') return res.status(400).json({ error: 'invalid status' });
  const rec = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  if (rec.assigned_washer_id !== req.washer.washer_id) return res.status(403).json({ error: 'not your booking' });
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), rec.id);
  if (status === 'completed') sendTelegram('🚗 <b>Готова</b> № ' + rec.booking_code + ' · мастер ' + req.washer.name);
  res.json({ ok: true });
});

app.get('/api/washer/earnings', washerAuth, function(req, res) {
  const wid = req.washer.washer_id;
  const washer = db.prepare('SELECT * FROM washers WHERE id = ?').get(wid);
  if (!washer) return res.status(404).json({ error: 'not found' });
  const comm = washer.commission || 0.5;
  const iso = function(d) { return d.toISOString().slice(0, 10); };
  const today = iso(new Date());
  function sumForRange(from, to) {
    const rows = db.prepare('SELECT b.date, COALESCE(SUM(b.total),0) as day_sum, COUNT(b.id) as cnt FROM bookings b WHERE b.assigned_washer_id = ? AND b.date >= ? AND b.date <= ? AND b.status IN (?, ?) GROUP BY b.date ORDER BY b.date DESC').all(wid, from, to, 'confirmed', 'completed');
    const finesRows = db.prepare('SELECT date(created_at) as d, COALESCE(SUM(amount),0) as sum FROM fines WHERE washer_id = ? AND date(created_at) >= ? AND date(created_at) <= ? GROUP BY date(created_at)').all(wid, from, to);
    const fb = {};
    finesRows.forEach(function(f) { fb[f.d] = f.sum; });
    let ts = 0, tf = 0, tb = 0;
    const days = rows.map(function(r) {
      const fines = fb[r.date] || 0;
      const share = Math.round(r.day_sum * comm);
      ts += r.day_sum; tf += fines; tb += r.cnt;
      return { date: r.date, bookings: r.cnt, revenue: r.day_sum, share: share, fines: fines, payout: share - fines };
    });
    return { total_revenue: ts, total_fines: tf, total_bookings: tb, total_share: Math.round(ts * comm), total_payout: Math.round(ts * comm) - tf, days: days };
  }
  const t = new Date();
  const w = new Date(t); w.setDate(w.getDate() - 6);
  const m = new Date(t); m.setDate(m.getDate() - 29);
  res.json({ commission: comm, washer_name: washer.name, today: sumForRange(today, today), week: sumForRange(iso(w), today), month: sumForRange(iso(m), today) });
});

app.post('/api/washer/request-payout', washerAuth, function(req, res) {
  const washer = db.prepare('SELECT * FROM washers WHERE id = ?').get(req.washer.washer_id);
  if (!washer) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  const amt = parseInt(body.amount, 10);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'invalid amount' });
  sendTelegram('💰 <b>Запрос выплаты</b>\n' + washer.name + '\n' + amt.toLocaleString('ru-RU') + ' ₽' + (body.comment ? '\n' + body.comment : ''));
  res.json({ ok: true });
});

/* ============ СТУДИЯ ============ */

app.post('/api/studio/login', loginLimiter, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const body = req.body || {};
  const key = (body.license_key || '').trim().toUpperCase();
  if (!key) return res.status(400).json({ error: 'license_key required' });
  const license = platformDb.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
  if (!license) return res.status(401).json({ error: 'invalid_license' });
  if (license.status === 'revoked') return res.status(403).json({ error: 'revoked' });
  if (license.status === 'issued') platformDb.prepare('UPDATE licenses SET status = ?, activated_at = ? WHERE id = ?').run('active', new Date().toISOString(), license.id);
  let studio = platformDb.prepare('SELECT * FROM studios WHERE license_key = ?').get(key);
  let isNewStudio = false;
  if (!studio) {
    const info = platformDb.prepare('INSERT INTO studios (subdomain, name, tier, license_key, commission_percent, max_tenants, max_verticals, status, created_at) VALUES (?, ?, ?, ?, 3.0, ?, ?, ?, ?)').run('studio-' + license.id, 'Студия #' + license.id, license.tier, key, license.max_tenants, license.max_verticals, 'active', new Date().toISOString());
    studio = platformDb.prepare('SELECT * FROM studios WHERE id = ?').get(info.lastInsertRowid);
    isNewStudio = true;
  }
  let demoTenantCreated = false;
  let demoLogin = null, demoPass = null;
  if (isNewStudio) {
    try {
      const existingDemo = db.prepare('SELECT id FROM tenants WHERE studio_id = ? AND subdomain LIKE ?').get(studio.id, 'demo-%');
      if (!existingDemo) {
        const demoSubdomainName = 'demo-' + studio.id;
        const demoVertical = platformDb.prepare('SELECT * FROM verticals WHERE code = ?').get('wash');
        if (demoVertical) {
          const demoResult = db.transaction(function() {
            const info = db.prepare('INSERT INTO tenants (studio_id, subdomain, vertical_code, business_name, contact_name, contact_phone, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(studio.id, demoSubdomainName, 'wash', 'Демо: Мойка на Ленина', 'Демо-владелец', '+79990000000', 'active', new Date().toISOString());
            const tenantId = info.lastInsertRowid;
            const preset = JSON.parse(demoVertical.default_services_json);
            const classIns = db.prepare('INSERT INTO classes (name, tenant_id) VALUES (?, ?)');
            const svcIns = db.prepare('INSERT INTO services (name, price, duration, vehicle_class, tenant_id) VALUES (?, ?, ?, ?, ?)');
            Object.keys(preset).forEach(function(entityName) {
              const services = preset[entityName];
              const cr = classIns.run(entityName, tenantId);
              Object.keys(services).forEach(function(svcName) {
                const arr = services[svcName];
                svcIns.run(svcName, arr[0], arr[1], cr.lastInsertRowid, tenantId);
              });
            });
            db.prepare('INSERT INTO washers (name, phone, commission, tenant_id) VALUES (?, ?, ?, ?)').run('Иван Петров', '+79001112233', 0.5, tenantId);
            db.prepare('INSERT INTO washers (name, phone, commission, tenant_id) VALUES (?, ?, ?, ?)').run('Пётр Сидоров', '+79004445566', 0.45, tenantId);
            const dl = 'demo_' + studio.id;
            const dp = 'demo' + Math.random().toString(36).slice(2, 8);
            db.prepare('INSERT INTO users (username, password_hash, role, tenant_id) VALUES (?, ?, ?, ?)').run(dl, bcrypt.hashSync(dp, 10), 'admin', tenantId);
            const today = new Date().toISOString().slice(0, 10);
            const demoSvc = db.prepare('SELECT id, price FROM services WHERE tenant_id = ? LIMIT 2').all(tenantId);
            if (demoSvc.length > 0) {
              const total = demoSvc.reduce(function(s, x) { return s + x.price; }, 0);
              const svcIds = demoSvc.map(function(x) { return x.id; });
              const insBooking = db.prepare('INSERT INTO bookings (booking_code, name, phone, vehicle_class_id, services_json, total, date, hour, status, assigned_washer_id, created_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
              insBooking.run('DEMO-01', 'Алексей', '+79001112233', demoSvc[0].id, JSON.stringify(svcIds), total, today, 10, 'confirmed', 1, new Date().toISOString(), tenantId);
              insBooking.run('DEMO-02', 'Мария', '+79004445566', demoSvc[0].id, JSON.stringify([svcIds[0]]), demoSvc[0].price, today, 14, 'confirmed', null, new Date().toISOString(), tenantId);
              insBooking.run('DEMO-03', 'Игорь', '+79007778899', demoSvc[0].id, JSON.stringify([svcIds[0]]), demoSvc[0].price, today, 16, 'completed', 1, new Date().toISOString(), tenantId);
            }
            return { login: dl, pass: dp };
          })();
          demoTenantCreated = true;
          demoLogin = demoResult.login;
          demoPass = demoResult.pass;
        }
      }
    } catch (e) {
      console.error('Demo tenant create error:', e);
    }
  }
  const token = jwt.sign({ studio_id: studio.id, tier: studio.tier, role: 'studio' }, CONFIG.jwtSecret, { expiresIn: '7d' });
  res.json({
    token: token,
    studio: { id: studio.id, name: studio.name, tier: studio.tier, max_tenants: studio.max_tenants, max_verticals: studio.max_verticals, commission_percent: studio.commission_percent },
    is_new: isNewStudio,
    demo_created: demoTenantCreated,
    demo_login: demoLogin,
    demo_password: demoPass
  });
});

app.get('/api/studio/me', studioAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  res.json({ studio: platformDb.prepare('SELECT * FROM studios WHERE id = ?').get(req.studio.studio_id) });
});

app.get('/api/studio/verticals', studioAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  res.json({ verticals: platformDb.prepare('SELECT code, name, entity_label, client_icon FROM verticals WHERE is_public = 1 ORDER BY sort_order').all() });
});

app.get('/api/studio/tenants', studioAuth, function(req, res) {
  res.json({ tenants: db.prepare('SELECT * FROM tenants WHERE studio_id = ? ORDER BY created_at DESC').all(req.studio.studio_id) });
});

app.post('/api/studio/tenants', studioAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const sid = req.studio.studio_id;
  const studio = platformDb.prepare('SELECT * FROM studios WHERE id = ?').get(sid);
  if (!studio) return res.status(404).json({ error: 'studio_not_found' });
  if (studio.status !== 'active') return res.status(403).json({ error: 'studio_suspended' });
  const body = req.body || {};
  const subdomain = body.subdomain, vertical_code = body.vertical_code, business_name = body.business_name;
  const contact_name = body.contact_name, contact_phone = body.contact_phone;
  if (!isValidSubdomain(subdomain)) return res.status(400).json({ error: 'invalid_subdomain' });
  if (/^(www|api|admin|platform|studio|localhost|demo-.*)$/.test(subdomain)) return res.status(400).json({ error: 'subdomain_reserved' });
  if (!vertical_code) return res.status(400).json({ error: 'vertical_required' });
  if (!business_name || !business_name.trim()) return res.status(400).json({ error: 'business_name_required' });
  const cnt = db.prepare('SELECT COUNT(*) as c FROM tenants WHERE studio_id = ?').get(sid);
  if (studio.max_tenants > 0 && cnt.c >= studio.max_tenants) return res.status(400).json({ error: 'tenant_limit_reached', max: studio.max_tenants });
  if (db.prepare('SELECT id FROM tenants WHERE subdomain = ?').get(subdomain)) return res.status(409).json({ error: 'subdomain_taken' });
  const vertical = platformDb.prepare('SELECT * FROM verticals WHERE code = ?').get(vertical_code);
  if (!vertical) return res.status(400).json({ error: 'unknown_vertical' });
  try {
    const result = db.transaction(function() {
      const info = db.prepare('INSERT INTO tenants (studio_id, subdomain, vertical_code, business_name, contact_name, contact_phone, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(sid, subdomain, vertical_code, business_name.trim(), (contact_name || '').trim(), (contact_phone || '').trim(), 'active', new Date().toISOString());
      const tid = info.lastInsertRowid;
      const preset = JSON.parse(vertical.default_services_json);
      const classIns = db.prepare('INSERT INTO classes (name, tenant_id) VALUES (?, ?)');
      const svcIns = db.prepare('INSERT INTO services (name, price, duration, vehicle_class, tenant_id) VALUES (?, ?, ?, ?, ?)');
      Object.keys(preset).forEach(function(entityName) {
        const services = preset[entityName];
        const cr = classIns.run(entityName, tid);
        Object.keys(services).forEach(function(svcName) {
          const arr = services[svcName];
          svcIns.run(svcName, arr[0], arr[1], cr.lastInsertRowid, tid);
        });
      });
      const login = 'admin_' + tid;
      const pass = 'rl' + Math.random().toString(36).slice(2, 10);
      db.prepare('INSERT INTO users (username, password_hash, role, tenant_id) VALUES (?, ?, ?, ?)').run(login, bcrypt.hashSync(pass, 10), 'admin', tid);
      return { tid: tid, login: login, pass: pass };
    })();
    res.json({ ok: true, tenant_id: result.tid, admin_login: result.login, admin_password: result.pass, subdomain: subdomain });
  } catch (e) {
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
});

app.get('/api/studio/stats', studioAuth, function(req, res) {
  const sid = req.studio.studio_id;
  const base = "FROM bookings b JOIN tenants t ON t.id = b.tenant_id WHERE t.studio_id = ? AND t.subdomain NOT LIKE 'demo-%' AND b.status IN ('confirmed','completed')";
  const all = db.prepare('SELECT COALESCE(SUM(b.total),0) AS rev, COUNT(b.id) AS n ' + base).get(sid);
  const mon = db.prepare('SELECT COALESCE(SUM(b.total),0) AS rev ' + base + ' AND b.date LIKE ?').get(sid, new Date().toISOString().slice(0, 7) + '%');
  let pct = 3;
  if (platformDb) { const st = platformDb.prepare('SELECT commission_percent FROM studios WHERE id = ?').get(sid); if (st && st.commission_percent != null) pct = st.commission_percent; }
  res.json({ bookings_total: all.n, revenue_total: all.rev, commission_percent: pct, commission_total: Math.round(all.rev * pct / 100), commission_month: Math.round(mon.rev * pct / 100) });
});

app.delete('/api/studio/tenants/:id', studioAuth, function(req, res) {
  const rec = db.prepare('SELECT * FROM tenants WHERE id = ? AND studio_id = ?').get(req.params.id, req.studio.studio_id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE tenants SET status = ? WHERE id = ?').run('archived', req.params.id);
  res.json({ ok: true });
});

/* ============ ВЛАДЕЛЕЦ ПЛАТФОРМЫ ============ */

app.post('/api/platform/login', loginLimiter, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const body = req.body || {};
  const username = body.username, password = body.password;
  if (!username || !password) return res.status(400).json({ error: 'missing' });
  const user = platformDb.prepare('SELECT * FROM platform_admins WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'invalid' });
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'invalid' });
  const token = jwt.sign({ id: user.id, username: user.username, role: 'platform_owner' }, CONFIG.jwtSecret, { expiresIn: '12h' });
  res.json({ token: token });
});

app.get('/api/platform/summary', platformOwnerAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const studiosCount = platformDb.prepare('SELECT COUNT(*) as c FROM studios').get().c;
  const tenantsCount = db.prepare('SELECT COUNT(*) as c FROM tenants').get().c;
  const revRow = db.prepare('SELECT COALESCE(SUM(total),0) as sum FROM bookings WHERE status IN (?, ?)').get('confirmed', 'completed');
  const totalRevenue = revRow ? revRow.sum : 0;
  res.json({ studios_count: studiosCount, tenants_count: tenantsCount, total_revenue: totalRevenue, platform_commission: Math.round(totalRevenue * 0.03) });
});

app.get('/api/platform/studios', platformOwnerAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const studios = platformDb.prepare('SELECT * FROM studios ORDER BY created_at DESC').all();
  const enriched = studios.map(function(s) {
    const cntRow = db.prepare('SELECT COUNT(*) as c FROM tenants WHERE studio_id = ?').get(s.id);
    const revRow = db.prepare('SELECT COALESCE(SUM(total),0) as sum FROM bookings WHERE tenant_id IN (SELECT id FROM tenants WHERE studio_id = ?) AND status IN (?, ?)').get(s.id, 'confirmed', 'completed');
    const rev = revRow ? revRow.sum : 0;
    return { id: s.id, subdomain: s.subdomain, name: s.name, tier: s.tier, license_key: s.license_key, commission_percent: s.commission_percent, status: s.status, created_at: s.created_at, tenants_count: cntRow ? cntRow.c : 0, revenue: rev, commission_amount: Math.round(rev * (s.commission_percent / 100)) };
  });
  res.json({ studios: enriched });
});

app.get('/api/platform/licenses', platformOwnerAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const licenses = platformDb.prepare('SELECT * FROM licenses ORDER BY id DESC').all();
  const enriched = licenses.map(function(l) {
    let studioName = null;
    if (l.studio_id) {
      const s = platformDb.prepare('SELECT name FROM studios WHERE id = ?').get(l.studio_id);
      if (s) studioName = s.name;
    }
    return { id: l.id, key: l.key, tier: l.tier, status: l.status, max_tenants: l.max_tenants, max_verticals: l.max_verticals, studio_id: l.studio_id, studio_name: studioName, created_at: l.created_at };
  });
  res.json({ licenses: enriched });
});

app.post('/api/platform/licenses', platformOwnerAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const body = req.body || {};
  const tier = body.tier, count = body.count, notes = body.notes;
  if (['start', 'business', 'enterprise'].indexOf(tier) === -1) return res.status(400).json({ error: 'invalid_tier' });
  const cnt = Math.max(1, Math.min(100, parseInt(count, 10) || 1));
  const limits = { start: [10, 1], business: [100, 10], enterprise: [-1, -1] };
  const max_tenants = limits[tier][0], max_verticals = limits[tier][1];
  const prefixes = { start: 'STRT', business: 'BIZN', enterprise: 'ENTR' };
  const crypto = require('crypto');
  const generated = [];
  const ins = platformDb.prepare('INSERT INTO licenses (key, tier, max_tenants, max_verticals, status, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < cnt; i++) {
    const part = function() { return crypto.randomBytes(2).toString('hex').toUpperCase(); };
    const key = 'RPLK-' + prefixes[tier] + '-' + part() + '-' + part() + '-' + part();
    ins.run(key, tier, max_tenants, max_verticals, 'issued', notes || ('Пакет ' + cnt + ' шт.'), new Date().toISOString());
    generated.push(key);
  }
  res.json({ ok: true, keys: generated, tier: tier, count: cnt });
});

app.patch('/api/platform/licenses/:id', platformOwnerAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const body = req.body || {};
  const status = body.status;
  if (['issued', 'active', 'revoked'].indexOf(status) === -1) return res.status(400).json({ error: 'invalid_status' });
  const rec = platformDb.prepare('SELECT * FROM licenses WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  platformDb.prepare('UPDATE licenses SET status = ? WHERE id = ?').run(status, req.params.id);
  if (status === 'revoked') {
    platformDb.prepare('UPDATE studios SET status = ? WHERE license_key = ?').run('suspended', rec.key);
  }
  res.json({ ok: true });
});

/* ============ БИЛЛИНГ КОМИССИИ (вручную) ============ */

function billingRows(month) {
  const revs = db.prepare("SELECT t.studio_id AS sid, COUNT(b.id) AS n, COALESCE(SUM(b.total),0) AS rev FROM bookings b JOIN tenants t ON t.id = b.tenant_id WHERE b.date LIKE ? AND b.status IN ('confirmed','completed') AND t.studio_id > 0 AND t.subdomain NOT LIKE 'demo-%' GROUP BY t.studio_id").all(month + '-%');
  const y = parseInt(month.slice(0, 4), 10), m = parseInt(month.slice(5, 7), 10);
  const periodStart = month + '-01', periodEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const rows = revs.map(function(r) {
    const st = platformDb.prepare('SELECT id, name, tier, commission_percent FROM studios WHERE id = ?').get(r.sid) || { id: r.sid, name: '#' + r.sid, tier: '', commission_percent: 3 };
    const pct = st.commission_percent != null ? st.commission_percent : 3;
    const inv = platformDb.prepare('SELECT * FROM billing_invoices WHERE studio_id = ? AND period_start = ?').get(r.sid, periodStart) || null;
    return { studio_id: r.sid, studio_name: st.name, tier: st.tier, bookings: r.n, revenue: r.rev, commission_percent: pct, amount_due: Math.round(r.rev * pct / 100), invoice: inv };
  });
  return { month: month, period_start: periodStart, period_end: periodEnd, rows: rows };
}

app.get('/api/platform/billing', platformOwnerAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const data = billingRows(month);
  data.total_due = data.rows.reduce(function(a, r) { return a + r.amount_due; }, 0);
  res.json(data);
});

app.post('/api/platform/billing/generate', platformOwnerAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const month = (req.body || {}).month;
  if (!/^\d{4}-\d{2}$/.test(String(month))) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const data = billingRows(month);
  let created = 0, updated = 0;
  data.rows.forEach(function(r) {
    if (r.revenue <= 0) return;
    if (!r.invoice) {
      platformDb.prepare('INSERT INTO billing_invoices (studio_id, period_start, period_end, total_revenue, commission_percent, amount_due, paid, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)').run(r.studio_id, data.period_start, data.period_end, r.revenue, r.commission_percent, r.amount_due, new Date().toISOString());
      created++;
    } else if (!r.invoice.paid) {
      platformDb.prepare('UPDATE billing_invoices SET total_revenue = ?, commission_percent = ?, amount_due = ? WHERE id = ?').run(r.revenue, r.commission_percent, r.amount_due, r.invoice.id);
      updated++;
    }
  });
  res.json({ ok: true, created: created, updated: updated });
});

app.patch('/api/platform/billing/:id', platformOwnerAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const body = req.body || {};
  const rec = platformDb.prepare('SELECT * FROM billing_invoices WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  const paid = body.paid ? 1 : 0;
  platformDb.prepare('UPDATE billing_invoices SET paid = ?, paid_at = ?, payment_method = ?, notes = ? WHERE id = ?').run(paid, paid ? new Date().toISOString() : null, body.payment_method !== undefined ? String(body.payment_method).slice(0, 100) : rec.payment_method, body.notes !== undefined ? String(body.notes).slice(0, 500) : rec.notes, rec.id);
  res.json({ ok: true });
});

/* ============ ЗАПУСК ============ */
let backupMod = null;
try { backupMod = require('./backup'); backupMod.start({ db: db, platformDb: platformDb }); } catch (e) { console.error('backup:', e.message); }
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Torclix Group listening on', PORT));
