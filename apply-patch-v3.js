// node apply-patch-v3.js server.js — ПОСЛЕ apply-patch-v2.js: подключает резервные копии (backup.js) и страницу состояния для владельца.
const fs = require('fs');
const file = process.argv[2] || 'server.js';
let s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
let bad = 0;
function rep(name, from, to) {
  const n = s.split(from).length - 1;
  if (n !== 1) { console.log('✗ ' + name + ': найдено ' + n); bad++; return; }
  s = s.replace(from, function () { return to; }); console.log('✓ ' + name);
}
rep('состояние копий и запуск вручную',
  "app.get('/api/platform/backup', platformOwnerAuth, function(req, res) {",
String.raw`app.get('/api/platform/backup/status', platformOwnerAuth, function(req, res) {
  res.json(backupMod ? backupMod.status() : { configured: [], passphrase_ok: false, providers: {} });
});

app.post('/api/platform/backup/run', platformOwnerAuth, function(req, res) {
  if (!backupMod) return res.status(503).json({ error: 'backup_not_available' });
  backupMod.run(true, 'manual').then(function(r) { res.json({ ok: true, result: r }); }).catch(function(e) { res.status(500).json({ error: 'backup_failed', message: e.message }); });
});

app.get('/api/platform/backup', platformOwnerAuth, function(req, res) {`);
rep('запуск резервного копирования',
  'const PORT = process.env.PORT || 3000;',
String.raw`let backupMod = null;
try { backupMod = require('./backup'); backupMod.start({ db: db, platformDb: platformDb }); } catch (e) { console.error('backup:', e.message); }

const PORT = process.env.PORT || 3000;`);
if (bad) { console.log('\nОШИБКА: файл НЕ изменён.'); process.exit(1); }
fs.writeFileSync(file + '.bak5', fs.readFileSync(file)); fs.writeFileSync(file, s); console.log('\nГотово.');
