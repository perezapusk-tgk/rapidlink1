// node apply-patch.js path/to/server.js
// Точечные правки безопасности и надёжности. Делает server.js.bak.
// Если хотя бы один якорь не найден — файл НЕ меняется, скрипт сообщает, какой именно.
const fs = require('fs');
const file = process.argv[2] || 'server.js';
let s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
let bad = 0;
function rep(name, from, to, expected, firstK) {
  expected = expected || 1;
  const parts = s.split(from), n = parts.length - 1;
  if (n !== expected) { console.log('✗ ' + name + ': найдено ' + n + ', ожидалось ' + expected); bad++; return; }
  let out = parts[0];
  for (let i = 1; i <= n; i++) out += (!firstK || i <= firstK ? to : from) + parts[i];
  s = out; console.log('✓ ' + name);
}

/* --- лимиты попыток --- */
rep('лимитер: ключ по IP или IP+телефон/логин',
  "const k = req.ip, now = Date.now(), rec = hits.get(k);",
  "const k = opts.byBody ? req.ip + '|' + String((req.body && (req.body.phone || req.body.username || req.body.license_key)) || '') : req.ip, now = Date.now(), rec = hits.get(k);");
rep('лимитеры логина: 15 попыток с IP и 8 на логин/телефон за 10 минут',
  "const loginLimiter = rateLimit({ windowMs: 60000, max: 10 });",
  "const loginLimiter = rateLimit({ windowMs: 600000, max: 15 });\nconst phoneLimiter = rateLimit({ windowMs: 600000, max: 8, byBody: true });");
rep('вход мойщика: лимитер по телефону',
  "app.post('/api/washer/login', loginLimiter, function(req, res) {",
  "app.post('/api/washer/login', loginLimiter, phoneLimiter, function(req, res) {");
rep('вход админа: лимитер по логину',
  "app.post('/api/admin/login', loginLimiter, function(req, res) {",
  "app.post('/api/admin/login', loginLimiter, phoneLimiter, function(req, res) {");

/* --- секрет, миграции до открытия БД, WAL --- */
rep('JWT_SECRET из окружения + миграции ДО открытия БД',
  "const db = new Database(path.join(__dirname, 'app.db'));",
`if (process.env.JWT_SECRET) CONFIG.jwtSecret = process.env.JWT_SECRET;
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
db.pragma('journal_mode = WAL'); // нужен для потоковых копий Litestream`);
rep('WAL для platform.db',
  "platformDb = new Database(path.join(__dirname, 'platform.db'));",
  "platformDb = new Database(path.join(__dirname, 'platform.db'));\n  platformDb.pragma('journal_mode = WAL');");
rep('колонка washers.pin_hash',
  "let platformDb = null;",
`try {
  if (!db.prepare('PRAGMA table_info(washers)').all().some(function(c) { return c.name === 'pin_hash'; })) db.exec('ALTER TABLE washers ADD COLUMN pin_hash TEXT');
} catch (e) { console.error('pin_hash:', e.message); }
let platformDb = null;`);
rep('пароли по умолчанию: предупреждение; тенант 1 принадлежит платформе, а не студии №1',
  "const app = express();",
`// Тенант 1 (ваша мойка) не должен принадлежать студии №1: иначе первый покупатель увидит и сможет заархивировать его.
try { db.prepare('UPDATE tenants SET studio_id = 0 WHERE id = 1 AND (studio_id IS NULL OR studio_id != 0)').run(); } catch (e) {}
try {
  if (db.prepare('SELECT password_hash FROM users').all().some(function(u) { return bcrypt.compareSync('admin123', u.password_hash); }))
    console.error('!!! ПАРОЛЬ АДМИНА ПО УМОЛЧАНИЮ (admin123). Задайте ADMIN_USERNAME и ADMIN_PASSWORD в окружении.');
  if (platformDb && platformDb.prepare('SELECT password_hash FROM platform_admins').all().some(function(u) { return bcrypt.compareSync('rapidlink2026', u.password_hash); }))
    console.error('!!! ПАРОЛЬ ВЛАДЕЛЬЦА ПО УМОЛЧАНИЮ (rapidlink2026). Задайте PLATFORM_ADMIN и PLATFORM_PASSWORD в окружении.');
} catch (e) {}
const app = express();`);

/* --- роли и изоляция тенантов --- */
rep('authMiddleware: только админы, не токены мойщика/студии/владельца',
  "req.user = p; next();",
  "if (['washer', 'studio', 'platform_owner'].indexOf(p.role) !== -1) return res.status(403).json({ error: 'not admin' });\n    req.user = p; next();");
rep('bookings: изоляция тенантов (patch, complete)',
  "db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id)",
  "db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id || 1)", 3, 2);
rep('washers: изоляция тенантов (patch, delete)',
  "db.prepare('SELECT * FROM washers WHERE id = ?').get(req.params.id)",
  "db.prepare('SELECT * FROM washers WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id || 1)", 2);
rep('services: изоляция тенантов',
  "db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id)",
  "db.prepare('SELECT * FROM services WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id || 1)");
rep('fines: мойщик из своего тенанта',
  "db.prepare('INSERT INTO fines(",
  "if (!db.prepare('SELECT id FROM washers WHERE id = ? AND tenant_id = ?').get(washer_id, req.user.tenant_id || 1)) return res.status(404).json({ error: 'washer not found' });\n  db.prepare('INSERT INTO fines(");
rep('назначение мойщика: только из своего тенанта',
  "db.prepare('UPDATE bookings SET assigned_washer_id = ?",
  "if (assigned_washer_id !== undefined && assigned_washer_id !== null && !db.prepare('SELECT id FROM washers WHERE id = ? AND tenant_id = ?').get(assigned_washer_id, req.user.tenant_id || 1)) return res.status(400).json({ error: 'invalid washer' });\n  db.prepare('UPDATE bookings SET assigned_washer_id = ?");
rep('список мойщиков без pin_hash (+ признак has_pin)',
  "db.prepare('SELECT * FROM washers WHERE tenant_id = ?').all(req.user.tenant_id || 1)",
  "db.prepare('SELECT id, name, phone, commission, tenant_id, (pin_hash IS NOT NULL) AS has_pin FROM washers WHERE tenant_id = ?').all(req.user.tenant_id || 1)");

/* --- вход мойщика по PIN --- */
rep('вход мойщика: pin обязателен',
  "if (!phone) return res.status(400).json({ error: 'phone required' });\n  const tid = resolveTenantId(req);\n  const norm =",
  "if (!phone || !body.pin) return res.status(400).json({ error: 'phone and pin required' });\n  const tid = resolveTenantId(req);\n  const norm =");
rep('вход мойщика: проверка PIN',
  "if (!washer) return res.status(401).json({ error: 'not_found' });",
  "if (!washer || !washer.pin_hash || !bcrypt.compareSync(String(body.pin), washer.pin_hash)) return res.status(401).json({ error: 'invalid_credentials' });");
rep('эндпоинт установки PIN админом',
  "/* ============ КАБИНЕТ МОЙЩИКА ============ */",
`app.post('/api/admin/washers/:id/pin', authMiddleware, function(req, res) {
  const pin = String((req.body || {}).pin || '');
  if (!/^\\d{4,6}$/.test(pin)) return res.status(400).json({ error: 'pin must be 4-6 digits' });
  const rec = db.prepare('SELECT id FROM washers WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id || 1);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE washers SET pin_hash = ? WHERE id = ?').run(bcrypt.hashSync(pin, 10), rec.id);
  res.json({ ok: true });
});

/* ============ КАБИНЕТ МОЙЩИКА ============ */`);

if (bad) { console.log('\nОШИБКА: ' + bad + ' правок не применено. Файл НЕ изменён. Пришлите этот вывод.'); process.exit(1); }
fs.writeFileSync(file + '.bak', fs.readFileSync(file));
fs.writeFileSync(file, s);
console.log('\nГотово. Резервная копия: ' + file + '.bak');
