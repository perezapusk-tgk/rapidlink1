const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const root = __dirname;
const configPath = path.join(root, 'config.json');

if (!fs.existsSync(configPath)) {
  const demo = {
    jwtSecret: process.env.JWT_SECRET || ('DEMO_' + crypto.randomBytes(32).toString('hex')),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    allowedOrigin: null
  };
  fs.writeFileSync(configPath, JSON.stringify(demo, null, 2));
  console.log('✓ config.json создан');
  if (demo.telegramBotToken) console.log('✓ Telegram-бот подключён');
}

console.log('\n→ Запускаю migrate.js');
execSync('node migrate.js', { stdio: 'inherit', cwd: root });

console.log('\n→ Запускаю migrate-tenants.js');
execSync('node migrate-tenants.js', { stdio: 'inherit', cwd: root });

if (fs.existsSync(path.join(root, 'platform.db'))) {
  fs.unlinkSync(path.join(root, 'platform.db'));
  console.log('\n• Удаляю старую platform.db');
}
console.log('\n→ Запускаю migrate-platform.js');
execSync('node migrate-platform.js', { stdio: 'inherit', cwd: root });

console.log('\n════════════════════════════════════════════════');
console.log('  ГОТОВО. Запускайте: npm start');
console.log('  Клиент:    http://localhost:3000/');
console.log('  Админка:   http://localhost:3000/admin.html');
console.log('  Мойщик:    http://localhost:3000/washer.html');
console.log('  Студия:    http://localhost:3000/studio.html');
console.log('  Владелец:  http://localhost:3000/platform.html');
console.log('════════════════════════════════════════════════');
