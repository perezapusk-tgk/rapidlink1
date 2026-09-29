// НЕОБЯЗАТЕЛЬНО. node apply-patch-migrations.js  (в корне проекта)
// Защита: migrate.js и migrate-platform.js больше не удаляют существующую БД без FORCE=1.
const fs = require('fs');
let bad = 0;
const UNLINK = "if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);";
const GUARD = "if (fs.existsSync(dbFile)) {\n  if (fs.statSync(dbFile).size > 0 && process.env.FORCE !== '1') {\n    console.error('Файл ' + dbFile + ' уже существует: пересоздание удалит ВСЕ данные. Если это точно нужно, запустите с FORCE=1.');\n    process.exit(1);\n  }\n  fs.unlinkSync(dbFile);\n}";
const out = {};
['migrate.js', 'migrate-platform.js'].forEach(function (f) {
  const s = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  const n = s.split(UNLINK).length - 1;
  if (n !== 1) { console.log('✗ ' + f + ': найдено ' + n); bad++; return; }
  out[f] = s.replace(UNLINK, function () { return GUARD; }); console.log('✓ ' + f);
});
if (bad) { console.log('\nФайлы НЕ изменены.'); process.exit(1); }
for (const f in out) { fs.writeFileSync(f + '.bak', fs.readFileSync(f)); fs.writeFileSync(f, out[f]); }
console.log('\nГотово. Копии: *.bak');
