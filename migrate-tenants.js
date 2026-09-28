const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbFile = path.join(__dirname, 'app.db');
if (!fs.existsSync(dbFile)) {
  console.error('app.db не найден. Сначала запустите migrate.js');
  process.exit(1);
}

const db = new Database(dbFile);
const cols = db.prepare('PRAGMA table_info(bookings)').all();
const alreadyMigrated = cols.some(function(c) { return c.name === 'tenant_id'; });

if (alreadyMigrated) {
  console.log('• Миграция tenant_id уже применена');
  db.close();
  process.exit(0);
}

console.log('→ Применяю миграцию tenant_id...');
db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  studio_id INTEGER,
  subdomain TEXT UNIQUE,
  vertical_code TEXT,
  business_name TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tenants_studio ON tenants(studio_id);
CREATE INDEX IF NOT EXISTS idx_tenants_subdomain ON tenants(subdomain);
`);

function addTenantId(table) {
  const tableCols = db.prepare('PRAGMA table_info(' + table + ')').all();
  if (tableCols.some(function(c) { return c.name === 'tenant_id'; })) return;
  db.exec('ALTER TABLE ' + table + ' ADD COLUMN tenant_id INTEGER DEFAULT 1');
  db.exec('UPDATE ' + table + ' SET tenant_id = 1 WHERE tenant_id IS NULL');
  console.log('  + tenant_id → ' + table);
}

['users', 'classes', 'services', 'washers', 'bookings', 'fines', 'kv'].forEach(addTenantId);

const existing = db.prepare('SELECT COUNT(*) as cnt FROM tenants').get().cnt;
if (existing === 0) {
  db.prepare('INSERT INTO tenants (id, studio_id, subdomain, vertical_code, business_name, contact_name, contact_phone, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(1, 1, 'pena24', 'wash', 'ПЕНА24 Ярославль', 'Владелец', '+79990000000', 'active', new Date().toISOString());
  console.log('  + первый тенант: ПЕНА24 Ярославль');
}

console.log('✓ Миграция завершена');
db.close();
