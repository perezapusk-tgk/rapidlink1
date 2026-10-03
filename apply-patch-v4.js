// node apply-patch-v4.js server.js — ПОСЛЕ v3.
// Подписи по вертикалям, доступы клиентов (смотреть в любой момент, сбрасывать), пауза и удаление сайтов владельцем платформы.
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

rep('помощники: подписи вертикалей и шифрование доступов',
  'function tenantFromReferer(req) {',
String.raw`/* ===== TorclixGroup v4: подписи вертикалей, доступы клиентов ===== */
const nodeCrypto = require('crypto');
const VD = require('./verticals-data');
function labelsFor(code) { try { return VD.labelsFor(code); } catch (e) { return VD.labelsFor('wash'); } }
[['tenants', 'admin_login', 'TEXT'], ['tenants', 'admin_pass_enc', 'TEXT']].forEach(function(c) {
  try {
    if (!db.prepare('PRAGMA table_info(' + c[0] + ')').all().some(function(x) { return x.name === c[1]; })) db.exec('ALTER TABLE ' + c[0] + ' ADD COLUMN ' + c[1] + ' ' + c[2]);
  } catch (e) { console.error('ALTER ' + c[0] + '.' + c[1] + ':', e.message); }
});
let _credKey = null;
function credKey() { if (!_credKey) _credKey = nodeCrypto.scryptSync(String(CONFIG.jwtSecret), 'torclix-cred-v1', 32); return _credKey; }
function encSecret(text) {
  const iv = nodeCrypto.randomBytes(12), c = nodeCrypto.createCipheriv('aes-256-gcm', credKey(), iv);
  const e = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), e]).toString('base64');
}
function decSecret(b64) {
  try {
    const b = Buffer.from(b64, 'base64'), d = nodeCrypto.createDecipheriv('aes-256-gcm', credKey(), b.slice(0, 12));
    d.setAuthTag(b.slice(12, 28));
    return Buffer.concat([d.update(b.slice(28)), d.final()]).toString('utf8');
  } catch (e) { return null; }
}

function tenantFromReferer(req) {`);

rep('каталог клиента: подписи вертикали',
  "vertical_code: tenant ? tenant.vertical_code : 'wash', vertical: vinfo });",
  "vertical_code: tenant ? tenant.vertical_code : 'wash', vertical: vinfo, labels: labelsFor(tenant ? tenant.vertical_code : 'wash') });");
rep('настройки админки: подписи вертикали',
  "res.json({ settings: Object.assign({ business_name: t.business_name || '', contact_phone: t.contact_phone || '', vertical_code: t.vertical_code || 'wash', subdomain: t.subdomain || '' }, tenantCfg(tid)) });",
  "res.json({ settings: Object.assign({ business_name: t.business_name || '', contact_phone: t.contact_phone || '', vertical_code: t.vertical_code || 'wash', subdomain: t.subdomain || '', labels: labelsFor(t.vertical_code || 'wash') }, tenantCfg(tid)) });");

/* ---- пауза сайта ---- */
rep('сайт на паузе: 503 с понятным кодом',
  "if (row && row.status !== 'active') return res.status(404).json({ error: 'tenant_not_found' });",
  "if (row && row.status === 'pending') return res.status(503).json({ error: 'tenant_pending' });\n  if (row && row.status !== 'active') return res.status(404).json({ error: 'tenant_not_found' });");
rep('вход админа: сайт на паузе или в архиве',
  "const token = jwt.sign({ id: user.id, username: user.username, role: user.role, tenant_id: user.tenant_id || 1 }",
  "const tstat = db.prepare('SELECT status FROM tenants WHERE id = ?').get(user.tenant_id || 1);\n  if (tstat && tstat.status === 'pending') return res.status(403).json({ error: 'tenant_pending' });\n  if (tstat && tstat.status !== 'active') return res.status(403).json({ error: 'tenant_archived' });\n  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, tenant_id: user.tenant_id || 1 }");
rep('лимит клиентов: пауза тоже занимает место', "status = 'active' AND subdomain NOT LIKE 'demo-%'", "status IN ('active','pending') AND subdomain NOT LIKE 'demo-%'", 2);

/* ---- доступы клиентов ---- */
rep('доступы демо-клиента сохраняются',
  ".run(dl, bcrypt.hashSync(dp, 10), 'admin', tenantId);",
  ".run(dl, bcrypt.hashSync(dp, 10), 'admin', tenantId);\n            db.prepare('UPDATE tenants SET admin_login = ?, admin_pass_enc = ? WHERE id = ?').run(dl, encSecret(dp), tenantId);");
rep('доступы нового клиента сохраняются',
  ".run(login, bcrypt.hashSync(pass, 10), 'admin', tid);",
  ".run(login, bcrypt.hashSync(pass, 10), 'admin', tid);\n      db.prepare('UPDATE tenants SET admin_login = ?, admin_pass_enc = ? WHERE id = ?').run(login, encSecret(pass), tid);");
rep('список клиентов студии без зашифрованного пароля',
  "db.prepare('SELECT * FROM tenants WHERE studio_id = ? ORDER BY created_at DESC').all(req.studio.studio_id)",
  "db.prepare('SELECT id, studio_id, subdomain, vertical_code, business_name, contact_name, contact_phone, status, created_at, admin_login FROM tenants WHERE studio_id = ? ORDER BY created_at DESC').all(req.studio.studio_id)");
rep('доступы: просмотр и сброс пароля (студия)',
  "app.delete('/api/studio/tenants/:id', studioAuth, function(req, res) {",
String.raw`function studioTenant(req) { return db.prepare('SELECT * FROM tenants WHERE id = ? AND studio_id = ?').get(req.params.id, req.studio.studio_id); }
function tenantAdminUser(t) {
  let u = t.admin_login ? db.prepare('SELECT id, username FROM users WHERE username = ? AND tenant_id = ?').get(t.admin_login, t.id) : null;
  if (!u) u = db.prepare("SELECT id, username FROM users WHERE tenant_id = ? AND role = 'admin' ORDER BY id LIMIT 1").get(t.id);
  return u || null;
}
app.get('/api/studio/tenants/:id/credentials', studioAuth, function(req, res) {
  const t = studioTenant(req);
  if (!t) return res.status(404).json({ error: 'not found' });
  const u = tenantAdminUser(t);
  const pass = t.admin_pass_enc ? decSecret(t.admin_pass_enc) : null;
  res.json({ login: u ? u.username : (t.admin_login || null), password: pass, status: t.status, subdomain: t.subdomain });
});
app.post('/api/studio/tenants/:id/reset-password', studioAuth, function(req, res) {
  const t = studioTenant(req);
  if (!t) return res.status(404).json({ error: 'not found' });
  const u = tenantAdminUser(t);
  if (!u) return res.status(404).json({ error: 'admin_not_found' });
  const pass = 'tx' + Math.random().toString(36).slice(2, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(pass, 10), u.id);
  db.prepare('UPDATE tenants SET admin_login = ?, admin_pass_enc = ? WHERE id = ?').run(u.username, encSecret(pass), t.id);
  res.json({ ok: true, login: u.username, password: pass });
});

app.delete('/api/studio/tenants/:id', studioAuth, function(req, res) {`);

/* ---- владелец: сайты клиентов ---- */
rep('владелец: список сайтов, пауза, удаление',
  "app.get('/api/platform/backup/status', platformOwnerAuth, function(req, res) {",
String.raw`app.get('/api/platform/tenants', platformOwnerAuth, function(req, res) {
  const studios = {};
  if (platformDb) platformDb.prepare('SELECT id, name FROM studios').all().forEach(function(st) { studios[st.id] = st.name; });
  const rows = db.prepare('SELECT t.id, t.studio_id, t.subdomain, t.vertical_code, t.business_name, t.contact_name, t.contact_phone, t.status, t.created_at, (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = t.id) AS bookings FROM tenants t ORDER BY t.id DESC').all();
  res.json({ tenants: rows.map(function(r) { return Object.assign({}, r, { studio_name: r.studio_id > 0 ? (studios[r.studio_id] || ('#' + r.studio_id)) : 'Платформа' }); }) });
});

app.patch('/api/platform/tenants/:id/status', platformOwnerAuth, function(req, res) {
  const status = (req.body || {}).status;
  if (['active', 'pending', 'archived'].indexOf(status) === -1) return res.status(400).json({ error: 'invalid_status' });
  const t = db.prepare('SELECT id FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), t.id);
  res.json({ ok: true });
});

app.delete('/api/platform/tenants/:id', platformOwnerAuth, function(req, res) {
  const t = db.prepare('SELECT id, subdomain FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.id === 1) return res.status(400).json({ error: 'main_tenant_protected' });
  if ((req.body || {}).confirm !== t.subdomain) return res.status(400).json({ error: 'confirm_required' });
  const removed = {};
  db.transaction(function() {
    ['bookings', 'fines', 'washers', 'services', 'classes', 'users', 'kv'].forEach(function(tbl) {
      try { removed[tbl] = db.prepare('DELETE FROM ' + tbl + ' WHERE tenant_id = ?').run(t.id).changes; } catch (e) {}
    });
    db.prepare('DELETE FROM tenants WHERE id = ?').run(t.id);
  })();
  res.json({ ok: true, removed: removed });
});

app.get('/api/platform/backup/status', platformOwnerAuth, function(req, res) {`);

if (bad) { console.log('\nОШИБКА: ' + bad + ' правок не применено. Файл НЕ изменён.'); process.exit(1); }
fs.writeFileSync(file + '.bak6', fs.readFileSync(file)); fs.writeFileSync(file, s); console.log('\nГотово.');
