// node apply-patch-v2.js server.js — запускать ПОСЛЕ apply-patch.js, apply-patch-studio.js, apply-patch-extra.js
// TorclixGroup v2: каталог данных, рабочие часы и вместимость точки, длительность записи (несколько часов подряд),
// вертикали из verticals-data.js, статистика для кейса, экспорт данных, копия базы для владельца,
// подписка в биллинге, лимит вертикалей по тарифу.
const fs = require('fs');
const file = process.argv[2] || 'server.js';
let s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
let bad = 0;
function rep(name, from, to, expected) {
  expected = expected || 1;
  const n = s.split(from).length - 1;
  if (n !== expected) { console.log('✗ ' + name + ': найдено ' + n + ', ожидалось ' + expected); bad++; return; }
  s = s.split(from).join(to); console.log('✓ ' + name);
}

rep('название', 'RapidLink — backend платформы записи.', 'TorclixGroup — backend платформы записи.');

/* ---- каталог данных (постоянный диск, Docker, домашний сервер) ---- */
rep('DATA_DIR', "const CONFIG_FILE = path.join(__dirname, 'config.json');",
  "const CONFIG_FILE = path.join(__dirname, 'config.json');\nconst DATA_DIR = process.env.DATA_DIR || __dirname;\ntry { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}");
rep('DATA_DIR: dbMissing', 'const p = path.join(__dirname, f);', 'const p = path.join(DATA_DIR, f);');
['app.db', 'platform.db'].forEach(function (f) {
  const from = "path.join(__dirname, '" + f + "')", n = s.split(from).length - 1;
  s = s.split(from).join("path.join(DATA_DIR, '" + f + "')"); console.log((n ? '✓ ' : '✗ ') + 'DATA_DIR: ' + f + ' (' + n + ')'); if (!n) bad++;
});

/* ---- вспомогательные функции точки ---- */
rep('помощники: настройки точки и занятость',
  'function tenantFromReferer(req) {',
String.raw`/* ===== TorclixGroup v2: настройки точки, длительность записи ===== */
[['bookings', 'duration', 'INTEGER'], ['tenants', 'open_hour', 'INTEGER'], ['tenants', 'close_hour', 'INTEGER'], ['tenants', 'capacity', 'INTEGER'], ['tenants', 'city', 'TEXT'], ['tenants', 'address', 'TEXT']].forEach(function(c) {
  try {
    if (!db.prepare('PRAGMA table_info(' + c[0] + ')').all().some(function(x) { return x.name === c[1]; })) db.exec('ALTER TABLE ' + c[0] + ' ADD COLUMN ' + c[1] + ' ' + c[2]);
  } catch (e) { console.error('ALTER ' + c[0] + '.' + c[1] + ':', e.message); }
});
const VERTICAL_DEFAULTS = {
  wash: { open: 0, close: 24, cap: 2 }, barber: { open: 10, close: 21, cap: 2 }, massage: { open: 10, close: 21, cap: 2 },
  detailing: { open: 9, close: 19, cap: 1 }, tire: { open: 8, close: 20, cap: 2 }, nails: { open: 10, close: 20, cap: 3 },
  grooming: { open: 10, close: 19, cap: 2 }, autoservice: { open: 9, close: 19, cap: 2 }, photostudio: { open: 9, close: 22, cap: 1 }, yoga: { open: 7, close: 22, cap: 1 }
};
function tenantCfg(tid) {
  let t = null;
  try { t = db.prepare('SELECT open_hour, close_hour, capacity, city, address FROM tenants WHERE id = ?').get(tid); } catch (e) {}
  return {
    open_hour: t && Number.isInteger(t.open_hour) ? t.open_hour : 0,
    close_hour: t && Number.isInteger(t.close_hour) ? t.close_hour : 24,
    capacity: t && Number.isInteger(t.capacity) && t.capacity > 0 ? t.capacity : 2,
    city: (t && t.city) || '', address: (t && t.address) || ''
  };
}
function spanHours(min) { return Math.max(1, Math.min(24, Math.ceil((parseInt(min, 10) || 60) / 60))); }
function needHours(cfg, hour, durationMin) {
  const full = spanHours(durationMin), win = cfg.close_hour - cfg.open_hour;
  if (full > win) return Math.max(1, cfg.close_hour - hour); // работа на несколько дней занимает остаток дня
  return full;
}
function usageByHour(tid, date, excludeId) {
  const cfg = tenantCfg(tid), use = [];
  for (let h = 0; h < 24; h++) use.push(0);
  db.prepare("SELECT id, hour, duration FROM bookings WHERE date = ? AND tenant_id = ? AND status IN ('confirmed','in_progress')").all(date, tid).forEach(function(r) {
    if (excludeId && r.id === excludeId) return;
    const n = needHours(cfg, r.hour, r.duration);
    for (let k = r.hour; k < Math.min(24, r.hour + n); k++) use[k]++;
  });
  return use;
}
function slotRemaining(cfg, use, hour, durationMin) {
  if (hour < cfg.open_hour || hour >= cfg.close_hour) return 0;
  const full = spanHours(durationMin), win = cfg.close_hour - cfg.open_hour;
  if (full <= win && hour + full > cfg.close_hour) return 0; // не успеем до закрытия
  const need = needHours(cfg, hour, durationMin);
  let mx = 0;
  for (let k = hour; k < hour + need && k < 24; k++) mx = Math.max(mx, use[k]);
  return Math.max(0, cfg.capacity - mx);
}
function slotFull(tid, date, hour, durationMin, excludeId) {
  return slotRemaining(tenantCfg(tid), usageByHour(tid, date, excludeId), hour, durationMin) <= 0;
}

function tenantFromReferer(req) {`);

rep('каталог: настройки точки и описание вертикали',
  "res.json({ services: services, classes: classes, capacity: 2, businessName: tenant ? tenant.business_name : '', city: '', tenant_id: tid, vertical_code: tenant ? tenant.vertical_code : 'wash' });",
String.raw`let vinfo = null;
  try { if (platformDb && tenant) vinfo = platformDb.prepare('SELECT code, name, entity_label, entity_placeholder, client_hero_title, client_hero_lede, client_icon FROM verticals WHERE code = ?').get(tenant.vertical_code) || null; } catch (e) {}
  const cfg = tenantCfg(tid);
  res.json({ services: services, classes: classes, capacity: cfg.capacity, open_hour: cfg.open_hour, close_hour: cfg.close_hour, businessName: tenant ? tenant.business_name : '', city: cfg.city, address: cfg.address, tenant_id: tid, vertical_code: tenant ? tenant.vertical_code : 'wash', vertical: vinfo });`);

rep('слоты: часы работы, вместимость, длительность',
`  const counts = {};
  db.prepare('SELECT hour, COUNT(*) as cnt FROM bookings WHERE date = ? AND status = ? AND tenant_id = ? GROUP BY hour').all(date, 'confirmed', tid).forEach(function(r) { counts[r.hour] = r.cnt; });
  const slots = [];
  for (let h = 0; h < 24; h++) { const used = counts[h] || 0; slots.push({ hour: h, remaining: Math.max(0, 2 - used) }); }
  res.json({ date: date, capacity: 2, slots: slots });`,
String.raw`const cfg = tenantCfg(tid);
  const dur = Math.max(15, Math.min(1440, parseInt(req.query.duration, 10) || 60));
  const use = usageByHour(tid, date, null);
  const slots = [];
  for (let h = 0; h < 24; h++) slots.push({ hour: h, remaining: slotRemaining(cfg, use, h, dur), open: h >= cfg.open_hour && h < cfg.close_hour });
  res.json({ date: date, capacity: cfg.capacity, open_hour: cfg.open_hour, close_hour: cfg.close_hour, duration: dur, slots: slots });`);

/* ---- запись клиента ---- */
rep('запись клиента: вместимость считается после выбора услуг',
`      const cnt = db.prepare('SELECT COUNT(*) as cnt FROM bookings WHERE date=? AND hour=? AND status=? AND tenant_id=?').get(date, hour, 'confirmed', tid);
      if (cnt.cnt >= 2) { const e = new Error('slot_full'); e.code = 'slot_full'; throw e; }
`, '');
rep('запись клиента: длительность услуг',
  "SELECT id, name, price FROM services WHERE id IN (' + placeholders + ') AND vehicle_class = ? AND tenant_id = ? AND active = 1",
  "SELECT id, name, price, duration FROM services WHERE id IN (' + placeholders + ') AND vehicle_class = ? AND tenant_id = ? AND active = 1");
rep('запись клиента: проверка слота по длительности',
  "const total = svcRows.reduce(function(s, r) { return s + r.price; }, 0);",
  "const total = svcRows.reduce(function(s, r) { return s + r.price; }, 0);\n      const durMin = svcRows.reduce(function(s, r) { return s + (r.duration || 60); }, 0);\n      if (slotFull(tid, date, hour, durMin, null)) { const e = new Error('slot_full'); e.code = 'slot_full'; throw e; }");
rep('запись клиента: duration в БД',
  "total, date, hour, status, created_at, tenant_id, car, consent_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(code, name.trim(), phone.trim(), vehicle_class_id, JSON.stringify(service_ids), total, date, hour, 'confirmed', new Date().toISOString(), tid, car, new Date().toISOString());",
  "total, date, hour, status, created_at, tenant_id, car, consent_at, duration) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(code, name.trim(), phone.trim(), vehicle_class_id, JSON.stringify(service_ids), total, date, hour, 'confirmed', new Date().toISOString(), tid, car, new Date().toISOString(), durMin);");

/* ---- запись из админки ---- */
rep('админка: длительность услуг',
  "'SELECT id, name, price FROM services WHERE id IN (' + ph + ') AND vehicle_class = ? AND tenant_id = ?'",
  "'SELECT id, name, price, duration FROM services WHERE id IN (' + ph + ') AND vehicle_class = ? AND tenant_id = ?'");
rep('админка: duration в подготовленной записи',
  "date: date, hour: hour, washerId: washerId, total: total } };",
  "date: date, hour: hour, washerId: washerId, total: total, duration: svcRows.length ? svcRows.reduce(function(a, r) { return a + (r.duration || 60); }, 0) : 60 } };");
rep('админка: создание, проверка слота',
`      const cnt = db.prepare("SELECT COUNT(*) as cnt FROM bookings WHERE date=? AND hour=? AND status='confirmed' AND tenant_id=?").get(d.date, d.hour, tid);
      if (cnt.cnt >= 2 && !force) { const e = new Error('slot_full'); e.code = 'slot_full'; throw e; }`,
`      if (!force && slotFull(tid, d.date, d.hour, d.duration, null)) { const e = new Error('slot_full'); e.code = 'slot_full'; throw e; }`);
rep('админка: создание, duration в БД',
  "tenant_id, car, extra_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(code, d.name, d.phone, d.vehicle_class_id, JSON.stringify(d.service_ids), d.total, d.date, d.hour, 'confirmed', d.washerId, new Date().toISOString(), tid, d.car, JSON.stringify(d.extras));",
  "tenant_id, car, extra_json, duration) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(code, d.name, d.phone, d.vehicle_class_id, JSON.stringify(d.service_ids), d.total, d.date, d.hour, 'confirmed', d.washerId, new Date().toISOString(), tid, d.car, JSON.stringify(d.extras), d.duration);");
rep('админка: правка, проверка слота',
`    const cnt = db.prepare("SELECT COUNT(*) as cnt FROM bookings WHERE date=? AND hour=? AND status='confirmed' AND tenant_id=? AND id != ?").get(d.date, d.hour, tid, rec.id);
    if (cnt.cnt >= 2) return res.status(409).json({ error: 'slot_full' });`,
`    if (slotFull(tid, d.date, d.hour, d.duration, rec.id)) return res.status(409).json({ error: 'slot_full' });`);
rep('админка: правка, duration в БД',
  "assigned_washer_id = ?, status = ?, updated_at = ? WHERE id = ?').run(d.name, d.phone, d.car, d.vehicle_class_id, JSON.stringify(d.service_ids), JSON.stringify(d.extras), d.total, d.date, d.hour, d.washerId, status, new Date().toISOString(), rec.id);",
  "assigned_washer_id = ?, status = ?, duration = ?, updated_at = ? WHERE id = ?').run(d.name, d.phone, d.car, d.vehicle_class_id, JSON.stringify(d.service_ids), JSON.stringify(d.extras), d.total, d.date, d.hour, d.washerId, status, d.duration, new Date().toISOString(), rec.id);");

/* ---- админка: настройки, статистика, экспорт ---- */
rep('админка: настройки точки, статистика для кейса, экспорт',
  "app.get('/api/admin/washers', authMiddleware, function(req, res) {",
String.raw`app.get('/api/admin/settings', authMiddleware, function(req, res) {
  const tid = req.user.tenant_id || 1;
  const t = db.prepare('SELECT business_name, contact_phone, vertical_code, subdomain FROM tenants WHERE id = ?').get(tid) || {};
  res.json({ settings: Object.assign({ business_name: t.business_name || '', contact_phone: t.contact_phone || '', vertical_code: t.vertical_code || 'wash', subdomain: t.subdomain || '' }, tenantCfg(tid)) });
});

app.put('/api/admin/settings', authMiddleware, function(req, res) {
  const tid = req.user.tenant_id || 1, b = req.body || {};
  const open = parseInt(b.open_hour, 10), close = parseInt(b.close_hour, 10), cap = parseInt(b.capacity, 10);
  const str = function(v, n) { return typeof v === 'string' ? v.trim().slice(0, n) : ''; };
  if (!Number.isInteger(open) || open < 0 || open > 23) return res.status(400).json({ error: 'invalid open_hour' });
  if (!Number.isInteger(close) || close <= open || close > 24) return res.status(400).json({ error: 'invalid close_hour' });
  if (!Number.isInteger(cap) || cap < 1 || cap > 50) return res.status(400).json({ error: 'invalid capacity' });
  const name = str(b.business_name, 100);
  if (!name) return res.status(400).json({ error: 'invalid business_name' });
  db.prepare('UPDATE tenants SET business_name = ?, contact_phone = ?, city = ?, address = ?, open_hour = ?, close_hour = ?, capacity = ?, updated_at = ? WHERE id = ?')
    .run(name, str(b.contact_phone, 30), str(b.city, 60), str(b.address, 120), open, close, cap, new Date().toISOString(), tid);
  res.json({ ok: true });
});

app.get('/api/admin/stats', authMiddleware, function(req, res) {
  const tid = req.user.tenant_id || 1;
  const to = isValidDate(req.query.to) ? req.query.to : new Date().toISOString().slice(0, 10);
  let from = req.query.from;
  if (!isValidDate(from)) { const d = new Date(to + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 29); from = d.toISOString().slice(0, 10); }
  const rows = db.prepare('SELECT phone, date, hour, status, total, services_json, extra_json FROM bookings WHERE tenant_id = ? AND date >= ? AND date <= ?').all(tid, from, to);
  const names = {};
  db.prepare('SELECT id, name FROM services WHERE tenant_id = ?').all(tid).forEach(function(sv) { names[sv.id] = sv.name; });
  const live = rows.filter(function(r) { return r.status !== 'cancelled'; });
  const revenue = live.reduce(function(a, r) { return a + (r.total || 0); }, 0);
  const phones = {};
  live.forEach(function(r) { const p = String(r.phone || '').replace(/\D/g, ''); if (p) phones[p] = (phones[p] || 0) + 1; });
  const uniq = Object.keys(phones).length, repeat = Object.keys(phones).filter(function(p) { return phones[p] >= 2; }).length;
  const byDay = {}, byWeekday = [0, 0, 0, 0, 0, 0, 0], byHour = [], top = {};
  for (let h = 0; h < 24; h++) byHour.push(0);
  live.forEach(function(r) {
    byDay[r.date] = byDay[r.date] || { bookings: 0, revenue: 0 };
    byDay[r.date].bookings++; byDay[r.date].revenue += (r.total || 0);
    byWeekday[new Date(r.date + 'T12:00:00Z').getUTCDay()]++;
    if (r.hour >= 0 && r.hour < 24) byHour[r.hour]++;
    let list = [];
    try { list = JSON.parse(r.services_json || '[]').map(function(id) { return names[id] || ('#' + id); }); } catch (e) {}
    try { list = list.concat((r.extra_json ? JSON.parse(r.extra_json) : []).map(function(x) { return x.name; })); } catch (e) {}
    list.forEach(function(n) { top[n] = (top[n] || 0) + 1; });
  });
  res.json({
    from: from, to: to, bookings_total: rows.length, bookings_active: live.length, cancelled: rows.length - live.length,
    completed: live.filter(function(r) { return r.status === 'completed'; }).length, revenue: revenue,
    avg_check: live.length ? Math.round(revenue / live.length) : 0, unique_clients: uniq, repeat_clients: repeat,
    repeat_share: uniq ? Math.round(repeat * 100 / uniq) : 0, cancel_rate: rows.length ? Math.round((rows.length - live.length) * 100 / rows.length) : 0,
    by_day: Object.keys(byDay).sort().map(function(d) { return { date: d, bookings: byDay[d].bookings, revenue: byDay[d].revenue }; }),
    by_weekday: byWeekday, by_hour: byHour,
    top_services: Object.keys(top).map(function(n) { return { name: n, count: top[n] }; }).sort(function(a, b) { return b.count - a.count; }).slice(0, 8)
  });
});

app.get('/api/admin/export/all', authMiddleware, function(req, res) {
  const tid = req.user.tenant_id || 1;
  const data = {
    exported_at: new Date().toISOString(),
    bookings: db.prepare('SELECT * FROM bookings WHERE tenant_id = ?').all(tid),
    services: db.prepare('SELECT * FROM services WHERE tenant_id = ?').all(tid),
    classes: db.prepare('SELECT * FROM classes WHERE tenant_id = ?').all(tid),
    washers: db.prepare('SELECT id, name, phone, commission FROM washers WHERE tenant_id = ?').all(tid),
    fines: db.prepare('SELECT * FROM fines WHERE tenant_id = ?').all(tid)
  };
  res.setHeader('Content-Disposition', 'attachment; filename=torclix_export_' + new Date().toISOString().slice(0, 10) + '.json');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(data, null, 2));
});

app.get('/api/admin/washers', authMiddleware, function(req, res) {`);

/* ---- тарифы, лицензии, студии ---- */
rep('лицензии: лимиты по тарифам', 'const limits = { start: [10, 1], business: [100, 10], enterprise: [-1, -1] };', 'const limits = { start: [3, 1], business: [15, 4], enterprise: [-1, -1] };');
rep('лицензии: префикс ключей', "const prefixes = { start: 'STRT', business: 'BIZN', enterprise: 'ENTR' };", "const prefixes = { start: 'STRT', business: 'BIZN', enterprise: 'PREM' };");
rep('лицензии: ключ TRCX-', "const key = 'RPLK-' + prefixes[tier]", "const key = 'TRCX-' + prefixes[tier]");
rep('студия: комиссия по тарифу',
  "VALUES (?, ?, ?, ?, 3.0, ?, ?, ?, ?)').run('studio-' + license.id, 'Студия #' + license.id, license.tier, key, license.max_tenants,",
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('studio-' + license.id, 'Студия #' + license.id, license.tier, key, (license.tier === 'enterprise' ? 2.0 : 3.0), license.max_tenants,");
rep('студия: считаются только активные клиенты, не демо',
  "const cnt = db.prepare('SELECT COUNT(*) as c FROM tenants WHERE studio_id = ?').get(sid);",
  "const cnt = db.prepare(\"SELECT COUNT(*) as c FROM tenants WHERE studio_id = ? AND status = 'active' AND subdomain NOT LIKE 'demo-%'\").get(sid);");
rep('студия: лимит вертикалей по тарифу',
  "if (!vertical) return res.status(400).json({ error: 'unknown_vertical' });",
String.raw`if (!vertical) return res.status(400).json({ error: 'unknown_vertical' });
  if (studio.max_verticals > 0) {
    const usedV = db.prepare("SELECT DISTINCT vertical_code FROM tenants WHERE studio_id = ? AND status = 'active' AND subdomain NOT LIKE 'demo-%'").all(sid).map(function(r) { return r.vertical_code; });
    if (usedV.indexOf(vertical_code) === -1 && usedV.length >= studio.max_verticals) return res.status(400).json({ error: 'vertical_limit_reached', max: studio.max_verticals });
  }`);
rep('студия: рабочие часы по вертикали для нового клиента',
  'const tid = info.lastInsertRowid;',
  "const tid = info.lastInsertRowid;\n      { const vd = VERTICAL_DEFAULTS[vertical_code] || VERTICAL_DEFAULTS.wash; db.prepare('UPDATE tenants SET open_hour = ?, close_hour = ?, capacity = ? WHERE id = ?').run(vd.open, vd.close, vd.cap, tid); }");

/* ---- старт: вертикали, исправление привязки услуг, колонки платформы ---- */
rep('старт: обновление вертикалей и колонок',
  'const app = express();',
String.raw`try { if (platformDb) require('./verticals-data').upsertVerticals(platformDb); } catch (e) { console.error('verticals:', e.message); }
try {
  // В прежней версии услуги первой точки были привязаны к классам со сдвигом на 1 (0..6 вместо 1..7). Исправляем один раз.
  if (db.prepare('SELECT 1 FROM services WHERE tenant_id = 1 AND vehicle_class = 0 LIMIT 1').get()) {
    db.prepare('UPDATE services SET vehicle_class = vehicle_class + 1 WHERE tenant_id = 1').run();
    console.log('→ исправлена привязка услуг к классам (первая точка)');
  }
} catch (e) {}
const TIER_FEES = { start: 1990, business: 4990, enterprise: 12990 };
if (platformDb) {
  try { platformDb.exec('ALTER TABLE studios ADD COLUMN fee_free_until TEXT'); } catch (e) {}
  try { platformDb.exec('ALTER TABLE billing_invoices ADD COLUMN subscription_fee INTEGER DEFAULT 0'); } catch (e) {}
}
const app = express();`);

/* ---- биллинг: подписка + комиссия, копия базы ---- */
(function () {
  const a = s.indexOf('function billingRows(month) {');
  const b = s.indexOf("app.patch('/api/platform/billing/:id'");
  if (a < 0 || b < 0 || b < a) { console.log('✗ биллинг: блок не найден'); bad++; return; }
  const block = String.raw`function billingRows(month) {
  const revs = db.prepare("SELECT t.studio_id AS sid, COUNT(b.id) AS n, COALESCE(SUM(b.total),0) AS rev FROM bookings b JOIN tenants t ON t.id = b.tenant_id WHERE b.date LIKE ? AND b.status IN ('confirmed','in_progress','completed') AND t.studio_id > 0 AND t.subdomain NOT LIKE 'demo-%' GROUP BY t.studio_id").all(month + '-%');
  const by = {};
  revs.forEach(function(r) { by[r.sid] = r; });
  const y = parseInt(month.slice(0, 4), 10), m = parseInt(month.slice(5, 7), 10);
  const periodStart = month + '-01', periodEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const studios = platformDb.prepare("SELECT id, name, tier, commission_percent, fee_free_until FROM studios WHERE status = 'active' ORDER BY id").all();
  const rows = studios.map(function(st) {
    const r = by[st.id] || { n: 0, rev: 0 };
    const pct = st.commission_percent != null ? st.commission_percent : 3;
    const commission = Math.round(r.rev * pct / 100);
    const fee = (st.fee_free_until && st.fee_free_until >= periodEnd) ? 0 : (TIER_FEES[st.tier] || 0);
    const inv = platformDb.prepare('SELECT * FROM billing_invoices WHERE studio_id = ? AND period_start = ?').get(st.id, periodStart) || null;
    return { studio_id: st.id, studio_name: st.name, tier: st.tier, bookings: r.n, revenue: r.rev, commission_percent: pct, commission: commission, subscription_fee: fee, fee_free_until: st.fee_free_until || '', amount_due: commission + fee, invoice: inv };
  });
  return { month: month, period_start: periodStart, period_end: periodEnd, rows: rows };
}

app.get('/api/platform/billing', platformOwnerAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const data = billingRows(month);
  data.total_due = data.rows.reduce(function(a, r) { return a + r.amount_due; }, 0);
  data.total_fee = data.rows.reduce(function(a, r) { return a + r.subscription_fee; }, 0);
  data.total_commission = data.rows.reduce(function(a, r) { return a + r.commission; }, 0);
  res.json(data);
});

app.post('/api/platform/billing/generate', platformOwnerAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const month = (req.body || {}).month;
  if (!/^\d{4}-\d{2}$/.test(String(month))) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const data = billingRows(month);
  let created = 0, updated = 0;
  data.rows.forEach(function(r) {
    if (r.amount_due <= 0) return;
    if (!r.invoice) {
      platformDb.prepare('INSERT INTO billing_invoices (studio_id, period_start, period_end, total_revenue, commission_percent, amount_due, subscription_fee, paid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)').run(r.studio_id, data.period_start, data.period_end, r.revenue, r.commission_percent, r.amount_due, r.subscription_fee, new Date().toISOString());
      created++;
    } else if (!r.invoice.paid) {
      platformDb.prepare('UPDATE billing_invoices SET total_revenue = ?, commission_percent = ?, amount_due = ?, subscription_fee = ? WHERE id = ?').run(r.revenue, r.commission_percent, r.amount_due, r.subscription_fee, r.invoice.id);
      updated++;
    }
  });
  res.json({ ok: true, created: created, updated: updated });
});

app.patch('/api/platform/studios/:id/fee-free', platformOwnerAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const d = (req.body || {}).date;
  if (d !== '' && d !== null && d !== undefined && !isValidDate(d)) return res.status(400).json({ error: 'invalid date' });
  const st = platformDb.prepare('SELECT id FROM studios WHERE id = ?').get(req.params.id);
  if (!st) return res.status(404).json({ error: 'not found' });
  platformDb.prepare('UPDATE studios SET fee_free_until = ? WHERE id = ?').run(d || null, st.id);
  res.json({ ok: true });
});

app.get('/api/platform/backup', platformOwnerAuth, function(req, res) {
  const which = req.query.db === 'platform' ? 'platform' : 'app';
  const src = which === 'platform' ? platformDb : db;
  if (!src) return res.status(503).json({ error: 'platform_not_ready' });
  const tmp = path.join(require('os').tmpdir(), 'torclix-' + which + '-' + Date.now() + '.db');
  src.backup(tmp).then(function() {
    res.download(tmp, 'torclix-' + which + '-' + new Date().toISOString().slice(0, 10) + '.db', function() { fs.unlink(tmp, function() {}); });
  }).catch(function() { res.status(500).json({ error: 'backup_failed' }); });
});

`;
  s = s.slice(0, a) + block + s.slice(b); console.log('✓ биллинг: подписка + комиссия, копия базы');
})();

if (bad) { console.log('\nОШИБКА: ' + bad + ' правок не применено. Файл НЕ изменён.'); process.exit(1); }
fs.writeFileSync(file + '.bak4', fs.readFileSync(file));
fs.writeFileSync(file, s);
console.log('\nГотово. Копия до правок: ' + file + '.bak4');
