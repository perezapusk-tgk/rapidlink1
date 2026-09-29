// node scripts/billing-report.js 2026-09 — комиссия студий за месяц (для ручных счетов)
const Database = require('better-sqlite3'), path = require('path');
const month = process.argv[2] || new Date().toISOString().slice(0, 7);
const app = new Database(path.join(__dirname, '..', 'app.db'));
const plat = new Database(path.join(__dirname, '..', 'platform.db'));
const rows = app.prepare(`SELECT t.studio_id sid, COUNT(b.id) n, COALESCE(SUM(b.total),0) rev
  FROM bookings b JOIN tenants t ON t.id = b.tenant_id
  WHERE b.date LIKE ? AND b.status IN ('confirmed','completed') GROUP BY t.studio_id`).all(month + '%');
console.log('Отчёт за ' + month + '\nстудия;записей;выручка;процент;комиссия');
rows.forEach(r => {
  const s = plat.prepare('SELECT name, commission_percent p FROM studios WHERE id = ?').get(r.sid) || { name: '#' + r.sid, p: 3 };
  console.log([s.name, r.n, r.rev, s.p, Math.round(r.rev * s.p / 100)].join(';'));
});
