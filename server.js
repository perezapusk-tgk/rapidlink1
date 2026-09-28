/*
RapidLink — backend платформы записи.
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

const db = new Database(path.join(__dirname, 'app.db'));
let platformDb = null;
if (fs.existsSync(path.join(__dirname, 'platform.db'))) {
  platformDb = new Database(path.join(__dirname, 'platform.db'));
}

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
    const k = req.ip, now = Date.now(), rec = hits.get(k);
    if (!rec || now - rec.start > windowMs) { hits.set(k, { start: now, count: 1 }); return next(); }
    rec.count++;
    if (rec.count > max) return res.status(429).json({ error: 'too_many_requests' });
    next();
  };
}
const loginLimiter = rateLimit({ windowMs: 60000, max: 10 });
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

function resolveTenantId(req) {
  const s = req.query.tenant || (req.hostname || '').split('.')[0];
  if (!s || s === 'demo-2-pkbp' || s === 'localhost' || s === 'www') return 1;
  const row = db.prepare('SELECT id FROM tenants WHERE subdomain = ?').get(s);
  return row ? row.id : 1;
      }/* ============ ПУБЛИЧНЫЕ ============ */

app.get('/api/vertical', function(req, res) {
  const tid = resolveTenantId(req);
  const services = db.prepare('SELECT id,name,price,duration,vehicle_class FROM services WHERE tenant_id = ? ORDER BY vehicle_class, id').all(tid);
  const classes = db.prepare('SELECT id,name FROM classes WHERE tenant_id = ? ORDER BY id').all(tid);
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);
  res.json({ services, classes, capacity: 2, businessName: tenant ? tenant.business_name : '', city: '', tenant_id: tid, vertical_code: tenant ? tenant.vertical_code : 'wash' });
});

app.get('/api/slots', function(req, res) {
  const tid = resolveTenantId(req);
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const counts = {};
  db.prepare('SELECT hour, COUNT(*) as cnt FROM bookings WHERE date = ? AND status = ? AND tenant_id = ? GROUP BY hour').all(date, 'confirmed', tid).forEach(function(r) { counts[r.hour] = r.cnt; });
  const slots = [];
  for (let h = 0; h < 24; h++) { const used = counts[h] || 0; slots.push({ hour: h, remaining: Math.max(0, 2 - used) }); }
  res.json({ date, capacity: 2, slots });
});

app.post('/api/bookings', bookingLimiter, function(req, res) {
  const tid = resolveTenantId(req);
  const body = req.body || {};
  const name = body.name, phone = body.phone, vehicle_class_id = body.vehicle_class_id;
  const service_ids = body.service_ids, date = body.date, hour = body.hour;
  if (!name || !name.trim() || name.length > 100) return res.status(400).json({ error: 'invalid name' });
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'invalid phone' });
  if (!Number.isInteger(vehicle_class_id)) return res.status(400).json({ error: 'invalid vehicle_class_id' });
  if (!Array.isArray(service_ids) || !service_ids.length || !service_ids.every(Number.isInteger)) return res.status(400).json({ error: 'invalid service_ids' });
  if (!isValidDate(date)) return res.status(400).json({ error: 'invalid date' });
  if (!isValidHour(hour)) return res.status(400).json({ error: 'invalid hour' });
  try {
    const result = db.transaction(function() {
      const cnt = db.prepare('SELECT COUNT(*) as cnt FROM bookings WHERE date=? AND hour=? AND status=? AND tenant_id=?').get(date, hour, 'confirmed', tid);
      if (cnt.cnt >= 2) { const e = new Error('slot_full'); e.code = 'slot_full'; throw e; }
      const placeholders = service_ids.map(function() { return '?'; }).join(',');
      const svcStmt = db.prepare('SELECT id, name, price FROM services WHERE id IN (' + placeholders + ') AND vehicle_class = ? AND tenant_id = ?');
      const svcRows = svcStmt.all.apply(svcStmt, service_ids.concat([vehicle_class_id, tid]));
      if (svcRows.length !== service_ids.length) { const e = new Error('invalid_services'); e.code = 'invalid_services'; throw e; }
      const total = svcRows.reduce(function(s, r) { return s + r.price; }, 0);
      const code = (Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase());
      db.prepare('INSERT INTO bookings(booking_code, name, phone, vehicle_class_id, services_json, total, date, hour, status, created_at, tenant_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(code, name.trim(), phone.trim(), vehicle_class_id, JSON.stringify(service_ids), total, date, hour, 'confirmed', new Date().toISOString(), tid);
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

app.post('/api/admin/login', loginLimiter, function(req, res) {
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
  res.json({ bookings: rows });
});

app.patch('/api/admin/bookings/:id', authMiddleware, function(req, res) {
  const body = req.body || {};
  const assigned_washer_id = body.assigned_washer_id, status = body.status;
  const rec = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bookings SET assigned_washer_id = ?, status = ?, updated_at = ? WHERE id = ?').run(assigned_washer_id !== undefined ? assigned_washer_id : rec.assigned_washer_id, status || rec.status, new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/bookings/:id/complete', authMiddleware, function(req, res) {
  const rec = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run('completed', new Date().toISOString(), rec.id);
  sendTelegram('🚗 <b>Готова</b> № ' + rec.booking_code + ' · ' + rec.name);
  res.json({ ok: true });
});

app.get('/api/admin/washers', authMiddleware, function(req, res) {
  res.json({ washers: db.prepare('SELECT * FROM washers WHERE tenant_id = ?').all(req.user.tenant_id || 1) });
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
  const rec = db.prepare('SELECT * FROM washers WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE washers SET name = ?, phone = ?, commission = ? WHERE id = ?').run(name !== undefined ? name : rec.name, phone !== undefined ? phone : rec.phone, commission !== undefined ? parseFloat(commission) : rec.commission, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/washers/:id', authMiddleware, function(req, res) {
  const rec = db.prepare('SELECT * FROM washers WHERE id = ?').get(req.params.id);
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

app.patch('/api/admin/services/:id', authMiddleware, function(req, res) {
  const body = req.body || {};
  const price = body.price, name = body.name, duration = body.duration;
  const rec = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
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
