/* Запускается ПЕРЕД server.js (см. start.sh): если баз нет, пробует восстановить их из зашифрованной копии.
   Если копия существует, но недоступна, останавливает запуск, чтобы не создать пустую базу поверх живых данных.
   Обойти осознанно: BACKUP_FORCE_START=1. */
const fs = require('fs');
const path = require('path');
const DATA_DIR = process.env.DATA_DIR || __dirname;
const NAMES = ['app.db', 'platform.db'];
function missing(f) { const p = path.join(DATA_DIR, f); return !fs.existsSync(p) || fs.statSync(p).size === 0; }

(async function () {
  const need = NAMES.filter(missing);
  if (!need.length) { console.log('boot: базы на месте, восстановление не нужно'); return; }
  const backup = require('./backup');
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await backup.restoreLatest(need, DATA_DIR);
      if (r.disabled) { console.warn('boot: резервные копии не настроены, базы будут созданы заново'); return; }
      if (r.restored && r.restored.length) { console.log('boot: восстановлено из ' + r.source + ': ' + r.restored.join(', ')); return; }
      console.log('boot: копий пока нет (первый запуск), базы будут созданы заново');
      return;
    } catch (e) {
      lastErr = e; console.error('boot: попытка ' + attempt + ' не удалась: ' + e.message);
      if (/BACKUP_PASSPHRASE/.test(e.message)) break; // повтор не поможет
      await new Promise(function (r) { setTimeout(r, 4000 * attempt); });
    }
  }
  if (process.env.BACKUP_FORCE_START === '1') { console.error('boot: ВНИМАНИЕ, запуск без восстановления (BACKUP_FORCE_START=1)'); return; }
  console.error('boot: копия есть, но восстановить её не удалось. Запуск остановлен, чтобы не затереть данные пустой базой. Причина: ' + (lastErr && lastErr.message));
  process.exit(1);
})();
