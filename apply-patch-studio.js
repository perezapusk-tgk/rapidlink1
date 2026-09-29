// node apply-patch-studio.js server.js   — запускать ПОСЛЕ apply-patch.js
const fs = require('fs');
const file = process.argv[2] || 'server.js';
let s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
let bad = 0;
function rep(name, from, to) {
  const n = s.split(from).length - 1;
  if (n !== 1) { console.log('✗ ' + name + ': найдено ' + n + ', ожидалось 1'); bad++; return; }
  s = s.replace(from, function () { return to; }); console.log('✓ ' + name);
}
rep('GET /api/studio/stats',
  "app.delete('/api/studio/tenants/:id', studioAuth, function(req, res) {",
`app.get('/api/studio/stats', studioAuth, function(req, res) {
  const sid = req.studio.studio_id;
  const base = "FROM bookings b JOIN tenants t ON t.id = b.tenant_id WHERE t.studio_id = ? AND t.subdomain NOT LIKE 'demo-%' AND b.status IN ('confirmed','completed')";
  const all = db.prepare('SELECT COALESCE(SUM(b.total),0) AS rev, COUNT(b.id) AS n ' + base).get(sid);
  const mon = db.prepare('SELECT COALESCE(SUM(b.total),0) AS rev ' + base + ' AND b.date LIKE ?').get(sid, new Date().toISOString().slice(0, 7) + '%');
  let pct = 3;
  if (platformDb) { const st = platformDb.prepare('SELECT commission_percent FROM studios WHERE id = ?').get(sid); if (st && st.commission_percent != null) pct = st.commission_percent; }
  res.json({ bookings_total: all.n, revenue_total: all.rev, commission_percent: pct, commission_total: Math.round(all.rev * pct / 100), commission_month: Math.round(mon.rev * pct / 100) });
});

app.delete('/api/studio/tenants/:id', studioAuth, function(req, res) {`);
rep('зарезервированные поддомены',
  "if (!isValidSubdomain(subdomain)) return res.status(400).json({ error: 'invalid_subdomain' });",
  "if (!isValidSubdomain(subdomain)) return res.status(400).json({ error: 'invalid_subdomain' });\n  if (/^(www|api|admin|platform|studio|localhost|demo-.*)$/.test(subdomain)) return res.status(400).json({ error: 'subdomain_reserved' });");
rep('приостановленная студия не создаёт клиентов',
  "if (!studio) return res.status(404).json({ error: 'studio_not_found' });",
  "if (!studio) return res.status(404).json({ error: 'studio_not_found' });\n  if (studio.status !== 'active') return res.status(403).json({ error: 'studio_suspended' });");
rep('токен студии: 7 дней вместо 30', "{ expiresIn: '30d' }", "{ expiresIn: '7d' }");
if (bad) { console.log('\nОШИБКА: правки не применены, файл не тронут.'); process.exit(1); }
fs.writeFileSync(file + '.bak2', fs.readFileSync(file));
fs.writeFileSync(file, s);
console.log('\nГотово. Копия до правок: ' + file + '.bak2');
