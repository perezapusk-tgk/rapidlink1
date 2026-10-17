/* Клиентский Telegram-бот: подтверждение записи, напоминания и кнопки «Приду / Отменить».
   Работает на бесплатном Render без постоянного процесса: напоминания отправляет tick(),
   его вызывает GitHub Actions по расписанию (см. .github/workflows/reminders.yml) и таймер, пока сервис не спит.
   Модуль не зависит от express и better-sqlite3: db, fetch и время передаются снаружи (это позволяет его тестировать). */
const crypto = require('crypto');

function create(opts) {
  /* tokenFor(tid) — токен бота ЭТОЙ точки ('' = у точки нет бота). Токены разных точек никогда не смешиваются. */
  const tokenFor = opts.tokenFor || function () { return opts.token || ''; };
  const db = opts.db;
  const base = opts.baseUrl || 'https://api.telegram.org';
  const fetchFn = opts.fetchFn || fetch;
  const nowFn = opts.now || function () { return new Date(); };
  const notifyOwner = opts.notifyOwner || function () {};          // notifyOwner(tenantId, htmlText)
  const hasRoom = opts.hasRoom || function () { return true; };            // есть ли свободное место в слоте
  const createBooking = opts.createBooking || function () { throw new Error('createBooking не задан'); };
  const log = opts.log || console;
  /* Часовой пояс бизнеса: смещение от UTC в минутах (Москва = 180). Даты записей хранятся как местные. */
  const offsetMin = Number.isFinite(opts.utcOffsetMin) ? opts.utcOffsetMin : 180;
  let running = false;

  /* enabled(tid): есть ли у точки бот. enabled() без аргумента — модуль работает (таблицы созданы). */
  function enabled(tid) { return tid === undefined ? true : !!tokenFor(tid); }

  function init() {
    const cols = db.prepare('PRAGMA table_info(bookings)').all().map(function (c) { return c.name; });
    [['tg_id', 'TEXT'], ['rem24_at', 'TEXT'], ['rem2_at', 'TEXT'], ['client_confirmed_at', 'TEXT'], ['review_asked_at', 'TEXT'], ['ready_at', 'TEXT']].forEach(function (c) {
      if (cols.indexOf(c[0]) === -1) db.exec('ALTER TABLE bookings ADD COLUMN ' + c[0] + ' ' + c[1]);
    });
    db.exec("CREATE TABLE IF NOT EXISTS waitlist (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, date TEXT, hour INTEGER, name TEXT, phone TEXT, car TEXT, vehicle_class_id INTEGER, service_ids_json TEXT, tg_id TEXT, consent_at TEXT, status TEXT DEFAULT 'waiting', created_at TEXT, notified_at TEXT)");
    db.exec('CREATE INDEX IF NOT EXISTS idx_waitlist_slot ON waitlist(tenant_id, date, hour, status)');
    db.exec('CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, booking_id INTEGER UNIQUE, tg_id TEXT, rating INTEGER, text TEXT, awaiting_text INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, created_at TEXT)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_reviews_tenant ON reviews(tenant_id, hidden, id)');
  }

  /* Проверка подписи данных Mini App (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app) */
  function verifyInitData(initData, tid, maxAgeSec) {
    const token = tokenFor(tid);
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

  async function rawApi(token, method, payload) {
    if (!token) { const e = new Error('no bot for tenant'); e.noBot = true; throw e; }
    let r;
    try {
      r = await fetchFn(base + '/bot' + token + '/' + method, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {})
      });
    } catch (e) { throw new Error('network error: ' + method); }   // без URL: в нём токен
    let j = null;
    try { j = await r.json(); } catch (e) { /* не JSON */ }
    if (j && j.ok) return j.result;
    const err = new Error((j && j.description) || ('HTTP ' + r.status));
    err.code = j && j.error_code; err.blocked = !!(j && (j.error_code === 403 || /blocked|deactivated|chat not found/i.test(j.description || '')));
    throw err;
  }
  /* api для конкретной точки: токен берётся по tenant_id */
  function apiFor(tid) { return function (method, payload) { return rawApi(tokenFor(tid), method, payload); }; }

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
        const st = db.prepare('SELECT name FROM services WHERE tenant_id = ? AND id IN (' + ids.map(function () { return '?'; }).join(',') + ')');
        names = st.all.apply(st, [rec.tenant_id].concat(ids)).map(function (r) { return r.name; }).join(', ');
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
    return apiFor(rec.tenant_id)('sendMessage', {
      chat_id: rec.tg_id, text: text, parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: withButtons ? keyboard(rec.booking_code) : undefined
    });
  }

  /* сразу после записи */
  async function sendBookingConfirmation(rec) {
    if (!enabled(rec.tenant_id) || !rec.tg_id) return false;
    const d = describe(rec);
    const text = '✅ <b>Вы записаны</b>' + (d.biz ? '\n' + esc(d.biz) : '') + '\n📅 ' + whenText(rec, 'now') +
      (d.names ? '\n🧾 ' + esc(d.names) : '') + '\n№ ' + esc(rec.booking_code) +
      '\n\nНапомню о визите здесь. Если планы изменились — нажмите «Отменить запись», так освободится место для других.';
    try { await sendTo(rec, text, true); return true; } catch (e) { log.warn('[tg] confirm:', e.message); return false; }
  }


  /* ===== «Готово»: одно сообщение клиенту, когда запись отмечена выполненной. Текст зависит от вертикали. ===== */
  const READY_GROUP = { wash: 'wash', detailing: 'wash', autoservice: 'service', tire: 'service', barber: 'beauty', nails: 'beauty',
    massage: 'wellness', yoga: 'wellness', grooming: 'pet', photostudio: 'studio' };
  const READY_TEXTS = {
    wash: [
      ['🚗✨ <b>Ваша машина готова!</b>', 'Сияет так, что фонари позавидуют. Подъезжайте, она вас заждалась.'],
      ['🫧 <b>Пена смыта, блеск включён!</b>', 'Машина готова и ждёт вас на выдаче. Выглядит как с витрины.'],
      ['🏁 <b>Финиш! Ваша машина готова</b>', 'Чистая, свежая и в отличном настроении. Можно забирать.']
    ],
    service: [
      ['🔧✅ <b>Машина готова!</b>', 'Работы завершены, всё проверено. Можно забирать и спокойно ехать.'],
      ['🏁 <b>Всё готово!</b>', 'Ваша машина ждёт вас. Счастливого пути!']
    ],
    beauty: [
      ['✨ <b>Готово — вы выглядите отлично!</b>', 'Осталось забрать комплименты. Спасибо, что выбрали нас!'],
      ['💫 <b>Работа завершена!</b>', 'Результат вам понравится. До новой встречи!']
    ],
    wellness: [
      ['🌿 <b>Сеанс завершён</b>', 'Не спешите, дайте себе минуту. Спасибо, что заботитесь о себе.']
    ],
    pet: [
      ['🐾 <b>Ваш питомец готов!</b>', 'Чистый, пушистый и очень довольный. Можно забирать.']
    ],
    studio: [
      ['📸 <b>Всё готово!</b>', 'Спасибо за съёмку. Надеемся, получились кадры, которыми захочется делиться.']
    ],
    generic: [
      ['✅ <b>Всё готово!</b>', 'Ваша запись выполнена. Спасибо, что выбрали нас!']
    ]
  };
  function readyText(rec) {
    const t = db.prepare('SELECT business_name, vertical_code FROM tenants WHERE id = ?').get(rec.tenant_id) || {};
    const list = READY_TEXTS[READY_GROUP[t.vertical_code] || 'generic'];
    const v = list[Number(rec.id) % list.length];             // вариант зависит от номера записи: разные клиенты видят разные фразы
    return v[0] + (t.business_name ? '\n' + esc(t.business_name) : '') + '\n\n' + v[1] + '\n\n№ ' + esc(rec.booking_code);
  }
  const readyBusy = new Set();
  /* Отправляется один раз на запись (ready_at); повторная смена статуса сообщение не дублирует. */
  async function notifyReady(id) {
    id = Number(id);
    if (!id || readyBusy.has(id)) return false;
    const rec = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!rec || rec.status !== 'completed' || !rec.tg_id || rec.ready_at || !tokenFor(rec.tenant_id)) return false;
    readyBusy.add(id);
    try {
      await sendTo(rec, readyText(rec), false);
      db.prepare('UPDATE bookings SET ready_at = ? WHERE id = ? AND ready_at IS NULL').run(nowFn().toISOString(), id);
      return true;
    } catch (e) {
      if (e.blocked) db.prepare('UPDATE bookings SET ready_at = ? WHERE id = ? AND ready_at IS NULL').run('blocked', id);
      else if (!e.noBot) log.warn('[tg] ready:', e.message);
      return false;
    } finally { readyBusy.delete(id); }
  }

  /* Напоминания. Окна: «за сутки» (24ч…2ч до визита) и «за 2 часа» (2ч…0). Запись, сделанная меньше чем за окно до визита, напоминание не получает. */
  async function tick() {
    if (running) return { sent: 0, skipped: 0, asked: 0, busy: running };
    running = true;
    let sent = 0, skipped = 0, asked = 0;
    try {
      const now = nowFn().getTime();
      const rows = db.prepare("SELECT * FROM bookings WHERE status = 'confirmed' AND tg_id IS NOT NULL AND tg_id != '' AND (rem24_at IS NULL OR rem2_at IS NULL)").all();
      for (const rec of rows) {
        if (!tokenFor(rec.tenant_id)) continue;          // у точки нет бота: не трогаем, ничего не отмечаем
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
          if (e.noBot) continue;
          if (e.blocked) { mark('rem24_at', 'blocked'); mark('rem2_at', 'blocked'); skipped++; }
          else log.warn('[tg] reminder:', e.message); // повторим на следующем запуске
        }
      }
      asked = await askReviews();
      expireWaitlist();
    } finally { running = false; }
    return { sent: sent, skipped: skipped, asked: asked };
  }

  async function answer(api, id, text) { try { await api('answerCallbackQuery', { callback_query_id: id, text: text, show_alert: false }); } catch (e) { /* не критично */ } }
  async function dropButtons(api, msg, suffix) {
    if (!msg) return;
    try { await api('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: (msg.text || '') + '\n\n' + suffix }); }
    catch (e) { try { await api('editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }); } catch (e2) { /* ok */ } }
  }


  /* ===================== ЛИСТ ОЖИДАНИЯ ===================== */
  function posInQueue(tid, date, hour, id) {
    return db.prepare("SELECT COUNT(*) AS c FROM waitlist WHERE tenant_id = ? AND date = ? AND hour = ? AND status IN ('waiting','notified') AND id <= ?").get(tid, date, hour, id).c;
  }
  /* d: name, phone, car, vehicle_class_id, service_ids, date, hour — уже проверены сервером; user — из подписанных данных Mini App */
  function joinWaitlist(tid, d, user) {
    const tgId = String(user.id);
    const dup = db.prepare("SELECT id FROM waitlist WHERE tenant_id = ? AND tg_id = ? AND date = ? AND hour = ? AND status IN ('waiting','notified')").get(tid, tgId, d.date, d.hour);
    if (dup) return { already: true, position: posInQueue(tid, d.date, d.hour, dup.id) };
    const active = db.prepare("SELECT COUNT(*) AS c FROM waitlist WHERE tg_id = ? AND status IN ('waiting','notified')").get(tgId).c;
    if (active >= 5) { const e = new Error('too_many'); e.code = 'too_many'; throw e; }
    const iso = nowFn().toISOString();
    const r = db.prepare("INSERT INTO waitlist (tenant_id, date, hour, name, phone, car, vehicle_class_id, service_ids_json, tg_id, consent_at, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'waiting', ?)")
      .run(tid, d.date, d.hour, String(d.name).trim(), String(d.phone).trim(), d.car || '', d.vehicle_class_id, JSON.stringify(d.service_ids), tgId, iso, iso);
    const id = Number(r.lastInsertRowid);
    const pos = posInQueue(tid, d.date, d.hour, id);
    notifyOwner(tid, '⏳ <b>Лист ожидания</b>\n' + esc(d.name) + ', ' + esc(d.phone) + '\n' + d.date + ' в ' + hh(d.hour) + ' (в очереди: ' + pos + ')');
    return { id: id, position: pos };
  }
  async function notifyWaitlist(tid, date, hour) {
    if (!enabled(tid)) return 0;
    const api = apiFor(tid);
    if (instantOf(date, hour) <= nowFn().getTime()) return 0;
    if (!hasRoom(tid, date, hour)) return 0;
    const t = db.prepare('SELECT business_name FROM tenants WHERE id = ?').get(tid);
    const rows = db.prepare("SELECT * FROM waitlist WHERE tenant_id = ? AND date = ? AND hour = ? AND status IN ('waiting','notified') ORDER BY id LIMIT 10").all(tid, date, hour);
    let n = 0;
    for (const w of rows) {
      try {
        await api('sendMessage', {
          chat_id: w.tg_id, parse_mode: 'HTML',
          text: '🔔 <b>Освободилось место!</b>' + (t && t.business_name ? '\n' + esc(t.business_name) : '') + '\n📅 ' + w.date + ' в ' + hh(w.hour) +
            '\n\nКто первый нажмёт — тот и записан.',
          reply_markup: { inline_keyboard: [[{ text: '✅ Занять место', callback_data: 'wl:' + w.id }, { text: 'Не нужно', callback_data: 'wx:' + w.id }]] }
        });
        db.prepare("UPDATE waitlist SET status = 'notified', notified_at = ? WHERE id = ?").run(nowFn().toISOString(), w.id);
        n++;
      } catch (e) {
        if (e.blocked) db.prepare("UPDATE waitlist SET status = 'blocked' WHERE id = ?").run(w.id);
        else log.warn('[tg] waitlist notify:', e.message);
      }
    }
    return n;
  }
  function expireWaitlist() {
    const now = nowFn().getTime();
    db.prepare("SELECT id, date, hour FROM waitlist WHERE status IN ('waiting','notified')").all().forEach(function (w) {
      if (instantOf(w.date, w.hour) <= now) db.prepare("UPDATE waitlist SET status = 'expired' WHERE id = ?").run(w.id);
    });
  }
  async function claimWaitlist(api, cq, id, tid) {
    const w = db.prepare('SELECT * FROM waitlist WHERE id = ? AND tg_id = ? AND tenant_id = ?').get(id, String(cq.from && cq.from.id), tid);
    if (!w || ['waiting', 'notified'].indexOf(w.status) === -1) return answer(api, cq.id, 'Эта заявка уже неактуальна');
    if (instantOf(w.date, w.hour) <= nowFn().getTime()) { db.prepare("UPDATE waitlist SET status = 'expired' WHERE id = ?").run(w.id); return answer(api, cq.id, 'Это время уже прошло'); }
    const lost = async function () {
      db.prepare("UPDATE waitlist SET status = 'waiting' WHERE id = ?").run(w.id);
      await answer(api, cq.id, 'Место уже заняли. Вы остаётесь в листе ожидания.');
      await dropButtons(api, cq.message, '😔 Место уже занял другой клиент. Вы остаётесь в листе ожидания — сообщу, если освободится снова.');
    };
    if (!hasRoom(w.tenant_id, w.date, w.hour)) return lost();
    let res;
    try {
      res = createBooking({ tenant_id: w.tenant_id, name: w.name, phone: w.phone, car: w.car, vehicle_class_id: w.vehicle_class_id, service_ids: JSON.parse(w.service_ids_json || '[]'), date: w.date, hour: w.hour, consent_at: w.consent_at });
    } catch (e) {
      if (e.code === 'slot_full' || e.code === 'slot_closed') return lost();
      log.warn('[tg] waitlist claim:', e.message);
      return answer(api, cq.id, 'Не получилось записать. Попробуйте оформить запись заново.');
    }
    db.prepare("UPDATE waitlist SET status = 'booked' WHERE id = ?").run(w.id);
    db.prepare('UPDATE bookings SET tg_id = ? WHERE id = ?').run(w.tg_id, res.rec.id);
    await answer(api, cq.id, 'Вы записаны!');
    await dropButtons(api, cq.message, '✅ Место за вами!');
    await sendBookingConfirmation(Object.assign({}, res.rec, { tg_id: w.tg_id }));
    notifyOwner(w.tenant_id, '✅ <b>Запись из листа ожидания</b>\n№ ' + esc(res.rec.booking_code) + ', ' + esc(w.name) + ', ' + esc(w.phone) + '\n' + w.date + ' в ' + hh(w.hour));
  }

  /* ========================= ОТЗЫВЫ ========================= */
  function starLine(n) { return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n); }
  function visitPassed(rec) { return rec.status === 'completed' || instantOf(rec.date, rec.hour) <= nowFn().getTime() - 3600000; }
  /* Через час после визита спрашиваем оценку (только тех, кто записался через Telegram). Старше 3 суток не спрашиваем. */
  /* Просьба оценить: ОДИН раз на запись, только после «Готово» (не раньше чем через 30 минут) и не чаще одного раза в 12 часов одному клиенту. */
  async function askReviews() {
    const now = nowFn().getTime();
    const rows = db.prepare("SELECT * FROM bookings WHERE status = 'completed' AND ready_at IS NOT NULL AND tg_id IS NOT NULL AND tg_id != '' AND review_asked_at IS NULL").all();
    let asked = 0;
    for (const rec of rows) {
      if (!tokenFor(rec.tenant_id)) continue;                // у точки нет бота
      const mark = function (v) { db.prepare('UPDATE bookings SET review_asked_at = ? WHERE id = ?').run(v, rec.id); };
      if (rec.ready_at === 'blocked') { mark('blocked'); continue; }
      const at = Date.parse(rec.ready_at);
      if (!(at > 0)) { mark('skip'); continue; }
      if (at > now - 30 * 60000) continue;                   // ещё рано
      if (at < now - 3 * 86400000) { mark('skip'); continue; }
      const recent = db.prepare("SELECT 1 AS x FROM bookings WHERE tenant_id = ? AND tg_id = ? AND review_asked_at > ? AND review_asked_at LIKE '20%' LIMIT 1").get(rec.tenant_id, rec.tg_id, new Date(now - 12 * 3600000).toISOString());
      if (recent) { mark('skip'); continue; }                // не засыпаем клиента просьбами
      const d = describe(rec);
      const stars = [1, 2, 3, 4, 5].map(function (n) { return { text: String(n) + '★', callback_data: 'rv:' + rec.booking_code + ':' + n }; });
      try {
        await apiFor(rec.tenant_id)('sendMessage', { chat_id: rec.tg_id, parse_mode: 'HTML', text: '⭐ <b>Как всё прошло?</b>' + (d.biz ? '\n' + esc(d.biz) : '') + '\n\nПоставьте оценку — это займёт секунду.', reply_markup: { inline_keyboard: [stars] } });
        mark(nowFn().toISOString()); asked++;
      } catch (e) {
        if (e.noBot) continue;
        if (e.blocked) mark('blocked');
        else log.warn('[tg] review ask:', e.message);
      }
    }
    return asked;
  }
  function ownerReviewNote(rec, rating, text) {
    notifyOwner(rec.tenant_id, (rating <= 3 ? '⚠️ <b>Низкая оценка</b>' : '⭐ <b>Новый отзыв</b>') + ' ' + starLine(rating) + '\n№ ' + esc(rec.booking_code) + ', ' + esc(rec.name) + ', ' + esc(rec.phone) +
      (text ? '\n«' + esc(text) + '»' : ''));
  }
  function saveRating(rec, rating, text, awaiting) {
    const iso = nowFn().toISOString();
    const ex = db.prepare('SELECT id FROM reviews WHERE booking_id = ?').get(rec.id);
    if (ex) { db.prepare('UPDATE reviews SET rating = ?, text = COALESCE(?, text), awaiting_text = ? WHERE id = ?').run(rating, text, awaiting ? 1 : 0, ex.id); return ex.id; }
    return Number(db.prepare('INSERT INTO reviews (tenant_id, booking_id, tg_id, rating, text, awaiting_text, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(rec.tenant_id, rec.id, rec.tg_id, rating, text, awaiting ? 1 : 0, iso).lastInsertRowid);
  }
  function cleanText(t) { return String(t || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, 500); }

  /* Отзыв из Mini App: по подписанным данным находим последний прошедший визит без отзыва */
  function submitReview(tid, user, rating, text) {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) { const e = new Error('invalid_rating'); e.code = 'invalid_rating'; throw e; }
    const rows = db.prepare("SELECT b.* FROM bookings b WHERE b.tenant_id = ? AND b.tg_id = ? AND b.status IN ('completed','confirmed') AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id) ORDER BY b.date DESC, b.hour DESC").all(tid, String(user.id));
    const rec = rows.filter(visitPassed)[0];
    if (!rec) { const e = new Error('no_visit'); e.code = 'no_visit'; throw e; }
    const t = cleanText(text);
    saveRating(rec, rating, t || null, false);
    ownerReviewNote(rec, rating, t);
    return { ok: true };
  }
  function listReviews(tid, limit, offset) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 3, 1), 20), off = Math.max(parseInt(offset, 10) || 0, 0);
    const agg = db.prepare('SELECT COUNT(*) AS c, AVG(rating) AS a FROM reviews WHERE tenant_id = ? AND hidden = 0').get(tid);
    const rows = db.prepare('SELECT r.rating, r.text, r.created_at, b.name FROM reviews r JOIN bookings b ON b.id = r.booking_id WHERE r.tenant_id = ? AND r.hidden = 0 ORDER BY r.id DESC LIMIT ? OFFSET ?').all(tid, lim, off);
    return {
      count: agg.c, avg: agg.c ? Math.round(agg.a * 10) / 10 : null,
      items: rows.map(function (r) { return { rating: r.rating, text: r.text || '', name: (String(r.name || '').trim().split(/\s+/)[0]) || 'Клиент', date: String(r.created_at || '').slice(0, 10) }; })
    };
  }

  /* входящие обновления от Telegram (webhook) */
  async function handleUpdate(u, tid) {
    tid = Number(tid);
    if (!u || !tid || !enabled(tid)) return;
    const api = apiFor(tid);
    if (u.callback_query) {
      const cq = u.callback_query;
      const wl = /^(wl|wx):(\d{1,12})$/.exec(cq.data || '');
      if (wl) {
        if (wl[1] === 'wl') return claimWaitlist(api, cq, parseInt(wl[2], 10), tid);
        const w = db.prepare('SELECT id FROM waitlist WHERE id = ? AND tg_id = ? AND tenant_id = ?').get(parseInt(wl[2], 10), String(cq.from && cq.from.id), tid);
        if (w) db.prepare("UPDATE waitlist SET status = 'cancelled' WHERE id = ?").run(w.id);
        await answer(api, cq.id, 'Хорошо, убрал из листа ожидания');
        return dropButtons(api, cq.message, 'Вы удалены из листа ожидания.');
      }
      const rv = /^rv:([A-Z0-9-]{4,16}):([1-5])$/.exec(cq.data || '');
      if (rv) {
        const rec = db.prepare('SELECT * FROM bookings WHERE booking_code = ? AND tg_id = ? AND tenant_id = ?').get(rv[1], String(cq.from && cq.from.id), tid);
        if (!rec) return answer(api, cq.id, 'Запись не найдена');
        const rating = parseInt(rv[2], 10);
        const had = db.prepare('SELECT id FROM reviews WHERE booking_id = ?').get(rec.id);
        saveRating(rec, rating, null, true);
        await answer(api, cq.id, 'Спасибо!');
        await dropButtons(api, cq.message, 'Спасибо за оценку ' + starLine(rating) + '\nЕсли хотите, напишите пару слов ответным сообщением — я передам.');
        if (!had) ownerReviewNote(rec, rating, '');
        return;
      }
      const m = /^(ok|no):([A-Z0-9-]{4,16})$/.exec(cq.data || '');
      if (!m) return answer(api, cq.id, '');
      const rec = db.prepare('SELECT * FROM bookings WHERE booking_code = ? AND tg_id = ? AND tenant_id = ?').get(m[2], String(cq.from && cq.from.id), tid);
      if (!rec) return answer(api, cq.id, 'Запись не найдена');
      if (m[1] === 'ok') {
        if (rec.status !== 'confirmed') return answer(api, cq.id, 'Эта запись уже неактуальна');
        db.prepare('UPDATE bookings SET client_confirmed_at = ? WHERE id = ?').run(nowFn().toISOString(), rec.id);
        await answer(api, cq.id, 'Отлично, ждём вас!');
        await dropButtons(api, cq.message, '✅ Вы подтвердили визит');
        notifyOwner(tid, '✅ Клиент подтвердил визит\n№ ' + rec.booking_code + ', ' + rec.name + '\n' + rec.date + ' ' + hh(rec.hour));
        return;
      }
      if (rec.status !== 'confirmed') return answer(api, cq.id, 'Запись уже отменена или завершена');
      if (instantOf(rec.date, rec.hour) <= nowFn().getTime()) return answer(api, cq.id, 'Время записи уже наступило');
      db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'confirmed'").run(rec.id);
      try { db.prepare('UPDATE bookings SET updated_at = ? WHERE id = ?').run(nowFn().toISOString(), rec.id); } catch (e) { /* колонки может не быть */ }
      await answer(api, cq.id, 'Запись отменена');
      await dropButtons(api, cq.message, '❌ Запись отменена. Место освободилось.');
      notifyOwner(tid, '❌ Клиент отменил запись\n№ ' + rec.booking_code + ', ' + rec.name + ', ' + rec.phone + '\n' + rec.date + ' ' + hh(rec.hour) + '\nСлот свободен.');
      await notifyWaitlist(rec.tenant_id, rec.date, rec.hour);
      return;
    }
    if (u.message && u.message.chat && u.message.from && u.message.text && !/^\//.test(u.message.text)) {
      const rv = db.prepare('SELECT r.id AS rid, r.rating AS rrating, r.created_at AS rcreated, b.* FROM reviews r JOIN bookings b ON b.id = r.booking_id WHERE r.tg_id = ? AND r.tenant_id = ? AND r.awaiting_text = 1 ORDER BY r.id DESC').get(String(u.message.from.id), tid);
      if (rv && Date.parse(rv.rcreated) > nowFn().getTime() - 2 * 86400000) {
        const txt = cleanText(u.message.text);
        db.prepare('UPDATE reviews SET text = ?, awaiting_text = 0 WHERE id = ?').run(txt, rv.rid);
        ownerReviewNote(rv, rv.rrating, txt);
        try { await api('sendMessage', { chat_id: u.message.chat.id, text: 'Спасибо! Отзыв сохранён.' }); } catch (e) { /* ok */ }
      }
      return;
    }
    if (u.message && u.message.chat && /^\/start/.test(u.message.text || '')) {
      try { await api('sendMessage', { chat_id: u.message.chat.id, text: 'Здравствуйте! Здесь я пришлю подтверждение записи и напомню о визите. Записаться можно через кнопку меню рядом с полем ввода.' }); } catch (e) { /* ok */ }
    }
  }

  return { enabled: enabled, init: init, verifyInitData: verifyInitData, sendBookingConfirmation: sendBookingConfirmation, tick: tick,
    handleUpdate: handleUpdate, notifyReady: notifyReady, readyText: readyText, askReviews: askReviews, _instantOf: instantOf,
    joinWaitlist: joinWaitlist, notifyWaitlist: notifyWaitlist, submitReview: submitReview, listReviews: listReviews, instantOf: instantOf };
}

module.exports = { create: create };
