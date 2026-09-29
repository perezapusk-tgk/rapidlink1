// node scripts/set-pin.js +79001112233 4821   (запускать в корне проекта)
const Database = require('better-sqlite3'), bcrypt = require('bcrypt'), path = require('path');
const [phone, pin] = process.argv.slice(2);
if (!phone || !/^\d{4,6}$/.test(pin || '')) { console.log('Использование: node scripts/set-pin.js +79001112233 4821'); process.exit(1); }
const db = new Database(path.join(__dirname, '..', 'app.db'));
if (!db.prepare('PRAGMA table_info(washers)').all().some(c => c.name === 'pin_hash')) db.exec('ALTER TABLE washers ADD COLUMN pin_hash TEXT');
const norm = phone.replace(/\D/g, ''), h = bcrypt.hashSync(pin, 10);
let n = 0;
db.prepare('SELECT id, phone FROM washers').all().forEach(w => {
  if ((w.phone || '').replace(/\D/g, '') === norm) { db.prepare('UPDATE washers SET pin_hash=? WHERE id=?').run(h, w.id); n++; }
});
console.log(n ? 'PIN установлен (' + n + ')' : 'Мойщик с таким телефоном не найден');
