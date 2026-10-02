/* TorclixGroup: создание app.db (данные точек: записи, услуги, мойщики). */
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const { VERTICALS } = require('./verticals-data');

const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const dbFile = path.join(DATA_DIR, 'app.db');
if (fs.existsSync(dbFile)) {
  if (fs.statSync(dbFile).size > 0 && process.env.FORCE !== '1') {
    console.error('Файл ' + dbFile + ' уже существует: пересоздание удалит ВСЕ данные. Если это точно нужно, запустите с FORCE=1.');
    process.exit(1);
  }
  fs.unlinkSync(dbFile);
}
const db = new Database(dbFile);

db.exec(`
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT, role TEXT, tenant_id INTEGER DEFAULT 1);
CREATE TABLE washers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, commission REAL DEFAULT 0.5, tenant_id INTEGER DEFAULT 1);
CREATE TABLE classes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, tenant_id INTEGER DEFAULT 1);
CREATE TABLE services (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price INTEGER, duration INTEGER, vehicle_class INTEGER, tenant_id INTEGER DEFAULT 1);
CREATE TABLE bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_code TEXT, name TEXT, phone TEXT, vehicle_class_id INTEGER,
  services_json TEXT, total INTEGER, date TEXT, hour INTEGER, status TEXT,
  assigned_washer_id INTEGER, created_at TEXT, updated_at TEXT, tenant_id INTEGER DEFAULT 1
);
CREATE TABLE fines (id INTEGER PRIMARY KEY AUTOINCREMENT, washer_id INTEGER, amount INTEGER, reason TEXT, created_at TEXT, tenant_id INTEGER DEFAULT 1);
CREATE INDEX idx_bookings_date_hour ON bookings(date, hour, status);
CREATE INDEX idx_bookings_phone ON bookings(phone);
`);

// Первая точка: автомойка. Класс услуги привязывается к НАСТОЯЩЕМУ id класса
// (в прежней версии id начинались с 1, а услуги с 0, из-за чего цены сдвигались на класс).
const classIns = db.prepare('INSERT INTO classes(name, tenant_id) VALUES(?, 1)');
const svcIns = db.prepare('INSERT INTO services(name, price, duration, vehicle_class, tenant_id) VALUES(?, ?, ?, ?, 1)');
const wash = VERTICALS.filter(function (v) { return v.code === 'wash'; })[0];
Object.keys(wash.services).forEach(function (className) {
  const cid = classIns.run(className).lastInsertRowid;
  Object.keys(wash.services[className]).forEach(function (svcName) {
    const arr = wash.services[className][svcName];
    svcIns.run(svcName, arr[0], arr[1], cid);
  });
});

const washerIns = db.prepare('INSERT INTO washers(name, phone, commission, tenant_id) VALUES(?, ?, ?, 1)');
washerIns.run('Иван Петров', '+79990001111', 0.5);
washerIns.run('Пётр Сидоров', '+79990002222', 0.45);

const kvIns = db.prepare('INSERT INTO kv(key, value) VALUES(?, ?)');
kvIns.run('capacity', '2');
kvIns.run('business_name', 'ПЕНА24');
kvIns.run('city', 'Ярославль');

const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
db.prepare('INSERT INTO users (username, password_hash, role, tenant_id) VALUES (?, ?, ?, 1)').run(adminUsername, bcrypt.hashSync(adminPassword, 10), 'admin');

console.log('Migration complete.');
db.close();
