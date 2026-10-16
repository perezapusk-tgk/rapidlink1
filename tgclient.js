/* Клиентский Telegram-бот: подтверждение записи, напоминания и кнопки «Приду / Отменить».
   Работает на бесплатном Render без постоянного процесса: напоминания отправляет tick(),
   его вызывает GitHub Actions по расписанию (см. .github/workflows/reminders.yml) и таймер, пока сервис не спит.
   Модуль не зависит от express и better-sqlite3: db, fetch и время передаются снаружи (это позволяет его тестировать). */
const crypto = require('crypto');

function create(opts) {
  const token = opts.token || '';
  const db = opts.db;
  const base = opts.baseUrl || 'https://api.telegram.org';
  const fetchFn = opts.fetchFn || fetch;
  const nowFn = opts.now || function () { return new Date(); };
  const notifyOwner = opts.notifyOwner || function () {};
  const log = opts.log || console;
  /* Часовой пояс бизнеса: смещение от UTC в минутах (Москва = 180). Даты записей хранятся как местные. */
  const offsetMin = Number.isFinite(opts.utcOffsetMin) ? opts.utcOffsetMin : 180;
  let running = false;

  function enabled() { return !!token; }
  function webhookSecret() { return crypto.createHash('sha256').update('tgwh:' + token).digest('hex').slice(0, 32); }

  function init() {
    const cols = db.prepare('PRAGMA table_info(bookings)').all().map(function (c) { return c.name; });
    [['tg_id', 'TEXT'], ['rem24_at', 'TEXT'], ['rem2_at', 'TEXT'], ['client_confirmed_at', 'TEXT']].forEach(function (c) {
      if (cols.indexOf(c[0]) === -1) db.exec('ALTER TABLE bookings ADD COLUMN ' + c[0] + ' ' + c[1]);
    });
  }

  /* Проверка подписи данных Mini App (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app) */
  function verifyInitData(initData, maxAgeSec) {
    if (!token || typeof initData !== 'string' || initData.length < 20 || initData.length > 4096) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
    params.delete('hash');
    const dcs = Array.from(params.entries()).map(function (e) { return e[0] + '=' + e[1]; }).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
    const a = Buffer.from(calc, 'hex'), b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    const age = Math.floor(nowFn().getTime() / 1000) - authDate;
    if (!authDate || age < -60 || age > (maxAgeSec || 86400)) return null;
    try { const u = JSON.parse(params.get('user') || 'null'); return u && Number.isInteger(u.id) ? u : null; } catch (e) { return null; }
  }

  async function api(method, payload) {
    const r = await fetchFn(base + '/bot' + token + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {})
    });
    let j = null;
    try { j = await r.json(); } catch (e) { /* не JSON */ }
    if (j && j.ok) return j.result;
    const err = new Error((j && j.description) || ('HTTP ' + r.status));
    err.code = j && j.error_code; err.blocked = !!(j && (j.error_code === 403 || /blocked|deactivated|chat not found/i.test(j.description || '')));
    throw err;
  }

  /* момент записи как UTC-время: date 'YYYY-MM-DD' и hour — местные */
  function instantOf(date, hour) {
    const p = String(date).split('-').map(Number);
    return Date.UTC(p[0], p[1] - 1, p[2], hour, 0, 0) - offsetMin * 60000;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function hh(h) { return (h < 10 ? '0' : '') + h + ':00'; }
  function describe(rec) {
    const t = db.prepare('SELECT business_name FROM tenants WHERE id = ?').get(rec.tenant_id);
    let names = '';
    try {
      const ids = JSON.parse(rec.services_json || '[]');
      if (ids.length) {
        const st = db.prepare('SELECT name FROM services WHERE id IN (' + ids.map(function () { return '?'; }).join(',') + ')');
        names = st.all.apply(st, ids).map(function (r) { return r.name; }).join(', ');
      }
    } catch (e) { /* без списка услуг */ }
    return { biz: t && t.business_name ? t.business_name : '', names: names };
  }
  function keyboard(code) {
    return { inline_keyboard: [[{ text: '✅ Приду', callback_data: 'ok:' + code }, { text: '❌ Отменить запись', callback_data: 'no:' + code }]] };
  }
  function whenText(rec, mode) {
    if (mode === 'rem2') return 'через пару часов, в ' + hh(rec.hour);
    if (mode === 'rem24') return 'завтра, ' + rec.date + ' в ' + hh(rec.hour);
    return rec.date + ' в ' + hh(rec.hour);
  }

  async function sendTo(rec, text, withButtons) {
    return api('sendMessage', {
      chat_id: rec.tg_id, text: text, parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: withButtons ? keyboard(rec.booking_code) : undefined
    });
  }

  /* сразу после записи */
  async function sendBookingConfirmation(rec) {
    if (!enabled() || !rec.tg_id) return false;
    const d = describe(rec);
    const text = '✅ <b>Вы записаны</b>' + (d.biz ? '\n' + esc(d.biz) : '') + '\n📅 ' + whenText(rec, 'now') +
      (d.names ? '\n🧾 ' + esc(d.names) : '') + '\n№ ' + esc(rec.booking_code) +
      '\n\nНапомню о визите здесь. Если планы изменились — нажмите «Отменить запись», так освободится место для других.';
    try { await sendTo(rec, text, true); return true; } catch (e) { log.warn('[tg] confirm:', e.message); return false; }
  }

  /* Напоминания. Окна: «за сутки» (24ч…2ч до визита) и «за 2 часа» (2ч…0). Запись, сделанная меньше чем за окно до визита, напоминание не получает. */
  async function tick() {
    if (!enabled() || running) return { sent: 0, skipped: 0, busy: running };
    running = true;
    let sent = 0, skipped = 0;
    try {
      const now = nowFn().getTime();
      const rows = db.prepare("SELECT * FROM bookings WHERE status = 'confirmed' AND tg_id IS NOT NULL AND tg_id != '' AND (rem24_at IS NULL OR rem2_at IS NULL)").all();
      for (const rec of rows) {
        const diffH = (instantOf(rec.date, rec.hour) - now) / 3600000;
        if (diffH <= 0) continue;
        const created = rec.created_at ? Date.parse(rec.created_at) : 0;
        const leadH = created ? (instantOf(rec.date, rec.hour) - created) / 3600000 : 999;
        const mark = function (col, v) { db.prepare('UPDATE bookings SET ' + col + ' = ? WHERE id = ?').run(v, rec.id); };
        let mode = null;
        if (diffH <= 2 && !rec.rem2_at) mode = 'rem2';
        else if (diffH <= 24 && diffH > 2 && !rec.rem24_at) mode = 'rem24';
        if (!mode) continue;
        const col = mode === 'rem2' ? 'rem2_at' : 'rem24_at';
        const window = mode === 'rem2' ? 2 : 24;
        if (leadH < window + 0.5) { mark(col, 'skip'); if (mode === 'rem2' && !rec.rem24_at) mark('rem24_at', 'skip'); skipped++; continue; }
        if (mode === 'rem2' && !rec.rem24_at) mark('rem24_at', 'skip'); // 24ч-окно уже пропущено
        const d = describe(rec);
        const text = '⏰ <b>Напоминание о записи</b>' + (d.biz ? '\n' + esc(d.biz) : '') + '\n📅 ' + whenText(rec, mode) +
          (d.names ? '\n🧾 ' + esc(d.names) : '') + '\n\nВсё в силе?';
        try { await sendTo(rec, text, true); mark(col, nowFn().toISOString()); sent++; }
        catch (e) {
          if (e.blocked) { mark('rem24_at', 'blocked'); mark('rem2_at', 'blocked'); skipped++; }
          else log.warn('[tg] reminder:', e.message); // повторим на следующем запуске
        }
      }
    } finally { running = false; }
    return { sent: sent, skipped: skipped };
  }

  async function answer(id, text) { try { await api('answerCallbackQuery', { callback_query_id: id, text: text, show_alert: false }); } catch (e) { /* не критично */ } }
  async function dropButtons(msg, suffix) {
    if (!msg) return;
    try { await api('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: (msg.text || '') + '\n\n' + suffix }); }
    catch (e) { try { await api('editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }); } catch (e2) { /* ok */ } }
  }

  /* входящие обновления от Telegram (webhook) */
  async function handleUpdate(u) {
    if (!enabled() || !u) return;
    if (u.callback_query) {
      const cq = u.callback_query;
      const m = /^(ok|no):([A-Z0-9-]{4,16})$/.exec(cq.data || '');
      if (!m) return answer(cq.id, '');
      const rec = db.prepare('SELECT * FROM bookings WHERE booking_code = ? AND tg_id = ?').get(m[2], String(cq.from && cq.from.id));
      if (!rec) return answer(cq.id, 'Запись не найдена');
      if (m[1] === 'ok') {
        if (rec.status !== 'confirmed') return answer(cq.id, 'Эта запись уже неактуальна');
        db.prepare('UPDATE bookings SET client_confirmed_at = ? WHERE id = ?').run(nowFn().toISOString(), rec.id);
        await answer(cq.id, 'Отлично, ждём вас!');
        await dropButtons(cq.message, '✅ Вы подтвердили визит');
        notifyOwner('✅ Клиент подтвердил визит\n№ ' + rec.booking_code + ', ' + rec.name + '\n' + rec.date + ' ' + hh(rec.hour));
        return;
      }
      if (rec.status !== 'confirmed') return answer(cq.id, 'Запись уже отменена или завершена');
      if (instantOf(rec.date, rec.hour) <= nowFn().getTime()) return answer(cq.id, 'Время записи уже наступило');
      db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'confirmed'").run(rec.id);
      try { db.prepare('UPDATE bookings SET updated_at = ? WHERE id = ?').run(nowFn().toISOString(), rec.id); } catch (e) { /* колонки может не быть */ }
      await answer(cq.id, 'Запись отменена');
      await dropButtons(cq.message, '❌ Запись отменена. Место освободилось.');
      notifyOwner('❌ Клиент отменил запись\n№ ' + rec.booking_code + ', ' + rec.name + ', ' + rec.phone + '\n' + rec.date + ' ' + hh(rec.hour) + '\nСлот свободен.');
      return;
    }
    if (u.message && u.message.chat && /^\/start/.test(u.message.text || '')) {
      try { await api('sendMessage', { chat_id: u.message.chat.id, text: 'Здравствуйте! Здесь я пришлю подтверждение записи и напомню о визите. Записаться можно через кнопку меню рядом с полем ввода.' }); } catch (e) { /* ok */ }
    }
  }

  async function setWebhook(publicUrl) {
    if (!enabled() || !publicUrl) return false;
    await api('setWebhook', { url: publicUrl.replace(/\/+$/, '') + '/tg/webhook', secret_token: webhookSecret(), allowed_updates: ['message', 'callback_query'] });
    return true;
  }

  return { enabled: enabled, init: init, verifyInitData: verifyInitData, sendBookingConfirmation: sendBookingConfirmation, tick: tick,
    handleUpdate: handleUpdate, setWebhook: setWebhook, webhookSecret: webhookSecret, _instantOf: instantOf };
}

module.exports = { create: create };
