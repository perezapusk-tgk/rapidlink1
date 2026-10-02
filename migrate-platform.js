/* TorclixGroup: создание platform.db (студии, лицензии, вертикали, счета, владелец). */
const Database = require('better-sqlite3');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const { VERTICALS, upsertVerticals } = require('./verticals-data');

const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const dbFile = path.join(DATA_DIR, 'platform.db');
if (fs.existsSync(dbFile)) {
  if (fs.statSync(dbFile).size > 0 && process.env.FORCE !== '1') {
    console.error('Файл ' + dbFile + ' уже существует: пересоздание удалит ВСЕ данные. Если это точно нужно, запустите с FORCE=1.');
    process.exit(1);
  }
  fs.unlinkSync(dbFile);
}
const db = new Database(dbFile);

function genLicense(tier) {
  const prefixes = { start: 'STRT', business: 'BIZN', enterprise: 'PREM' };
  const part = function () { return crypto.randomBytes(2).toString('hex').toUpperCase(); };
  return 'TRCX-' + (prefixes[tier] || 'DEMO') + '-' + part() + '-' + part() + '-' + part();
}

db.exec(`
CREATE TABLE studios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subdomain TEXT UNIQUE, name TEXT, owner_email TEXT, owner_phone TEXT,
  tier TEXT, license_key TEXT UNIQUE, commission_percent REAL DEFAULT 3.0,
  max_tenants INTEGER DEFAULT -1, max_verticals INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active', paid_at TEXT, created_at TEXT, updated_at TEXT,
  fee_free_until TEXT
);
CREATE TABLE verticals (
  code TEXT PRIMARY KEY, name TEXT, entity_label TEXT, entity_placeholder TEXT,
  client_hero_title TEXT, client_hero_lede TEXT, client_icon TEXT,
  default_services_json TEXT, tier_required TEXT DEFAULT 'start',
  is_public INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 100
);
CREATE TABLE licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE, tier TEXT, studio_id INTEGER, activated_at TEXT,
  expires_at TEXT, max_tenants INTEGER, max_verticals INTEGER,
  status TEXT DEFAULT 'issued', notes TEXT, created_at TEXT
);
CREATE TABLE billing_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  studio_id INTEGER, period_start TEXT, period_end TEXT,
  total_revenue INTEGER DEFAULT 0, commission_percent REAL, amount_due INTEGER DEFAULT 0,
  paid INTEGER DEFAULT 0, paid_at TEXT, payment_method TEXT, notes TEXT, created_at TEXT,
  subscription_fee INTEGER DEFAULT 0
);
CREATE TABLE platform_admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE, password_hash TEXT, role TEXT DEFAULT 'owner', created_at TEXT
);
CREATE INDEX idx_studios_subdomain ON studios(subdomain);
CREATE INDEX idx_invoices_studio ON billing_invoices(studio_id, period_start);
`);

upsertVerticals(db);
VERTICALS.forEach(function (v) { console.log('  + ' + v.name); });

const insertLicense = db.prepare("INSERT INTO licenses (key, tier, max_tenants, max_verticals, status, notes, created_at) VALUES (?, ?, ?, ?, 'issued', ?, ?)");
[['start', 3, 1], ['business', 15, 4], ['enterprise', -1, -1]].forEach(function (row) {
  const key = genLicense(row[0]);
  insertLicense.run(key, row[0], row[1], row[2], 'Демо ' + row[0], new Date().toISOString());
  console.log('  + лицензия ' + row[0] + ': ' + key);
});

const adminUser = process.env.PLATFORM_ADMIN || 'owner';
const adminPass = process.env.PLATFORM_PASSWORD || 'torclix2026';
db.prepare('INSERT INTO platform_admins (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
  .run(adminUser, bcrypt.hashSync(adminPass, 10), 'owner', new Date().toISOString());
console.log('  + владелец: ' + adminUser);
db.close();
console.log('\n✓ platform.db создана: ' + VERTICALS.length + ' вертикалей, 3 лицензии\n');
