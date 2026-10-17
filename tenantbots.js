/* Свой Telegram-бот у каждой точки (мойки, барбершопа и т.д.).
   Токен бота хранится в app.db ТОЛЬКО в зашифрованном виде (AES-256-GCM, ключ из BOT_SECRET_KEY).
   Уведомления владельцу точки приходят от бота этой же точки и только в его чат.
   Модуль не зависит от express: db, fetch и время передаются снаружи (так его можно тестировать). */
const crypto = require('crypto');

const TOKEN_RE = /^\d{5,12}:[A-Za-z0-9_-]{30,}$/;
const RESERVED_SUBDOMAINS = ['demo-2-pkbp', 'localhost', 'www'];
const PAIR_TTL_MS = 15 * 60000;
const MAX_PAIR_FAILS = 10;

function create(opts) {
  const db = opts.db;
  const fetchFn = opts.fetchFn || fetch;
  const log = opts.log || console;
  const base = opts.baseUrl || 'https://api.telegram.org';
  const nowFn = opts.now || function () { return new Date(); };
  const publicUrl = opts.publicUrl || function () { return ''; };
  const subdomainOf = opts.subdomainOf || function () { return null; };
  /* Старый общий бот платформы: работает только для главной точки (id 1), чтобы не сломать уже запущенное. */
  const legacyClientToken = opts.legacyClientToken || '';
  const legacyOwnerToken = opts.legacyOwnerToken || '';
  const legacyOwnerChat = opts.legacyOwnerChat || '';
  const KEY = crypto.scryptSync(String(opts.botSecretKey || opts.fallbackSecret || ''), 'rapidlink-tenant-bot-v1', 32);
  const cache = new Map();

  function enc(s) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const e = Buffer.concat([c.update(String(s), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), e]).toString('base64');
  }
  function dec(b64) {
    const b = Buffer.from(String(b64), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, b.slice(0, 12));
    d.setAuthTag(b.slice(12, 28));
    return Buffer.concat([d.update(b.slice(28)), d.final()]).toString('utf8');
  }
  function safeEq(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  /* Вызов Telegram API. Токен есть в URL, поэтому текст ошибок НИКОГДА не содержит URL. */
  async function call(token, method, body) {
    let r;
    try {
      r = await fetchFn(base + '/bot' + token + '/' + method, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
      });
    } catch (e) { throw new Error('network error: ' + method); }
    let j = null;
    try { j = await r.json(); } catch (e) { /* не JSON */ }
    if (j && j.ok) return j.result;
    const err = new Error((j && j.description) || ('HTTP ' + r.status));
    err.code = j && j.error_code;
    throw err;
  }

  function init() {
    db.exec('CREATE TABLE IF NOT EXISTS tenant_bots (' +
      'tenant_id INTEGER PRIMARY KEY, token_enc TEXT NOT NULL, bot_id TEXT UNIQUE, bot_username TEXT, ' +
      'webhook_secret TEXT NOT NULL, owner_chat_id TEXT, pair_code TEXT, pair_expires_at TEXT, pair_fails INTEGER DEFAULT 0, ' +
      "status TEXT DEFAULT 'pending', created_at TEXT, paired_at TEXT)");
  }

  function dropCache(tid) { if (tid === undefined) cache.clear(); else cache.delete(Number(tid)); }

  /* Бот точки с расшифрованным токеном или null (нет бота / ключ не подходит) */
  function getBot(tid) {
    tid = Number(tid);
    const c = cache.get(tid);
    if (c && Date.now() - c.t < 30000) return c.bot;
    let bot = null;
    try {
      const r = db.prepare('SELECT * FROM tenant_bots WHERE tenant_id = ?').get(tid);
      if (r) bot = Object.assign({}, r, { token: dec(r.token_enc) });
    } catch (e) { bot = null; }
    cache.set(tid, { t: Date.now(), bot: bot });
    return bot;
  }
  function legacyActive(tid) { return Number(tid) === 1 && !!legacyClientToken && !getBot(1); }
  /* Токен, которым точка общается с клиентами. Пусто = у точки нет бота, ничего не отправляем. */
  function tokenFor(tid) {
    const b = getBot(tid);
    if (b) return b.token;
    return Number(tid) === 1 ? legacyClientToken : '';
  }

  /* Уведомление владельцу: только через бота этой точки и только в её чат */
  function notify(tid, text) {
    tid = Number(tid) || 1;
    const b = getBot(tid);
    let token = '', chat = '';
    if (b) { token = b.token; chat = b.owner_chat_id || ''; }
    else if (tid === 1) { token = legacyOwnerToken; chat = legacyOwnerChat; }
    if (!token || !chat) return Promise.resolve(false);
    return call(token, 'sendMessage', { chat_id: chat, text: String(text).slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true })
      .then(function () { return true; })
      .catch(function (e) { log.warn('[bot] notify tenant ' + tid + ': ' + e.message); return false; });
  }

  function miniAppUrl(tid) {
    const pub = String(publicUrl() || '').replace(/\/+$/, '');
    const s = subdomainOf(Number(tid));
    if (!s || RESERVED_SUBDOMAINS.indexOf(s) !== -1) return pub + '/';
    return pub + '/?tenant=' + encodeURIComponent(s);
  }
  function webhookUrl(tid) { return String(publicUrl() || '').replace(/\/+$/, '') + '/tg/webhook/' + Number(tid); }
  function legacySecret() { return crypto.createHash('sha256').update('tgwh:' + legacyClientToken).digest('hex').slice(0, 32); }
  function newPairCode() { return String(crypto.randomInt(100000, 1000000)); }

  function menuButton(token, tid) {
    return call(token, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Записаться', web_app: { url: miniAppUrl(tid) } } });
  }

  async function register(tid, rawToken) {
    tid = Number(tid);
    const token = String(rawToken || '').trim();
    const fail = function (code) { const e = new Error(code); e.code = code; return e; };
    if (!TOKEN_RE.test(token)) throw fail('bad_token_format');
    if (!/^https:\/\//.test(String(publicUrl() || ''))) throw fail('no_public_url');
    let me;
    try { me = await call(token, 'getMe'); } catch (e) { throw fail('telegram_rejected'); }
    if (!me || !me.is_bot) throw fail('telegram_rejected');
    const botId = String(me.id);
    const other = db.prepare('SELECT tenant_id FROM tenant_bots WHERE bot_id = ? AND tenant_id != ?').get(botId, tid);
    if (other) throw fail('bot_used_elsewhere');
    if (legacyClientToken && tid !== 1 && legacyClientToken.split(':')[0] === botId) throw fail('bot_used_elsewhere');

    const secret = crypto.randomBytes(24).toString('hex');
    try { await call(token, 'setWebhook', { url: webhookUrl(tid), secret_token: secret, allowed_updates: ['message', 'callback_query'] }); }
    catch (e) { log.warn('[bot] setWebhook tenant ' + tid + ': ' + e.message); throw fail('webhook_failed'); }
    try { await menuButton(token, tid); } catch (e) { log.warn('[bot] menu tenant ' + tid + ': ' + e.message); }

    const old = db.prepare('SELECT * FROM tenant_bots WHERE tenant_id = ?').get(tid);
    const sameBot = !!(old && old.bot_id === botId);
    if (old && !sameBot) {            // прежний бот точки отключаем, чтобы он перестал принимать сообщения
      try { const ot = dec(old.token_enc); await call(ot, 'deleteWebhook', {}); await call(ot, 'setChatMenuButton', { menu_button: { type: 'default' } }); } catch (e) { /* не критично */ }
    }
    const keepOwner = sameBot && old.owner_chat_id;
    const code = keepOwner ? null : newPairCode();
    const exp = keepOwner ? null : new Date(nowFn().getTime() + PAIR_TTL_MS).toISOString();
    try {
      db.prepare('INSERT INTO tenant_bots (tenant_id, token_enc, bot_id, bot_username, webhook_secret, owner_chat_id, pair_code, pair_expires_at, pair_fails, status, created_at, paired_at) VALUES (?,?,?,?,?,?,?,?,0,?,?,?) ' +
        'ON CONFLICT(tenant_id) DO UPDATE SET token_enc = excluded.token_enc, bot_id = excluded.bot_id, bot_username = excluded.bot_username, webhook_secret = excluded.webhook_secret, ' +
        'owner_chat_id = excluded.owner_chat_id, pair_code = excluded.pair_code, pair_expires_at = excluded.pair_expires_at, pair_fails = 0, status = excluded.status, paired_at = excluded.paired_at')
        .run(tid, enc(token), botId, me.username || '', secret, keepOwner ? old.owner_chat_id : null, code, exp,
          keepOwner ? 'active' : 'pending', nowFn().toISOString(), keepOwner ? old.paired_at : null);
    } catch (e) {
      if (/UNIQUE|constraint/i.test(e.message)) throw fail('bot_used_elsewhere');
      throw e;
    }
    dropCache(tid);
    return status(tid);
  }

  function status(tid) {
    tid = Number(tid);
    const row = db.prepare('SELECT * FROM tenant_bots WHERE tenant_id = ?').get(tid);
    if (!row) return { state: legacyActive(tid) ? 'legacy' : 'none' };
    if (!getBot(tid)) return { state: 'broken', bot_username: row.bot_username };
    const pairActive = !row.owner_chat_id && !!row.pair_code && Date.parse(row.pair_expires_at) > nowFn().getTime() && (row.pair_fails || 0) < MAX_PAIR_FAILS;
    return {
      state: row.owner_chat_id ? 'active' : 'pending',
      bot_username: row.bot_username,
      paired_at: row.paired_at || null,
      pair_code: pairActive ? row.pair_code : null,
      pair_expires_at: pairActive ? row.pair_expires_at : null,
      pair_link: pairActive && row.bot_username ? 'https://t.me/' + row.bot_username + '?start=' + row.pair_code : null
    };
  }

  /* Видит ли Telegram наш сервер: помогает понять, почему бот молчит */
  async function webhookHealth(tid) {
    const b = getBot(tid);
    if (!b) return null;
    try {
      const info = await call(b.token, 'getWebhookInfo', {});
      return { ok: info.url === webhookUrl(tid) && !info.last_error_message, error: info.last_error_message || (info.url === webhookUrl(tid) ? null : 'webhook_url_mismatch') };
    } catch (e) { return { ok: false, error: 'check_failed' }; }
  }

  /* Новый код привязки (сменить чат, куда приходят уведомления) */
  function repair(tid) {
    tid = Number(tid);
    if (!getBot(tid)) { const e = new Error('no_bot'); e.code = 'no_bot'; throw e; }
    db.prepare("UPDATE tenant_bots SET owner_chat_id = NULL, paired_at = NULL, pair_code = ?, pair_expires_at = ?, pair_fails = 0, status = 'pending' WHERE tenant_id = ?")
      .run(newPairCode(), new Date(nowFn().getTime() + PAIR_TTL_MS).toISOString(), tid);
    dropCache(tid);
    return status(tid);
  }

  async function test(tid) {
    const b = getBot(tid);
    if (!b) { const e = new Error('no_bot'); e.code = 'no_bot'; throw e; }
    if (!b.owner_chat_id) { const e = new Error('not_paired'); e.code = 'not_paired'; throw e; }
    try { await call(b.token, 'sendMessage', { chat_id: b.owner_chat_id, text: '✅ Тестовое уведомление: бот подключён, сюда будут приходить новые записи, отмены и отзывы.' }); }
    catch (e) { const er = new Error('send_failed'); er.code = 'send_failed'; throw er; }
    return true;
  }

  async function remove(tid) {
    tid = Number(tid);
    const row = db.prepare('SELECT * FROM tenant_bots WHERE tenant_id = ?').get(tid);
    if (!row) return false;
    try { const t = dec(row.token_enc); await call(t, 'deleteWebhook', {}); await call(t, 'setChatMenuButton', { menu_button: { type: 'default' } }); } catch (e) { /* не критично */ }
    db.prepare('DELETE FROM tenant_bots WHERE tenant_id = ?').run(tid);
    dropCache(tid);
    return true;
  }

  /* Привязка владельца: код из панели, отправленный боту в личные сообщения (или ссылка t.me/бот?start=КОД).
     Возвращает true, если сообщение обработано здесь и клиентскому обработчику передавать не нужно. */
  async function handlePairing(bot, u) {
    const m = u && u.message;
    if (!m || !m.chat || m.chat.type !== 'private' || typeof m.text !== 'string') return false;
    const mm = /^(?:\/start\s+)?(\d{6})$/.exec(m.text.trim());
    if (!mm) return false;
    const active = !bot.owner_chat_id && !!bot.pair_code && Date.parse(bot.pair_expires_at) > nowFn().getTime() && (bot.pair_fails || 0) < MAX_PAIR_FAILS;
    if (!active) return false;
    if (!safeEq(mm[1], bot.pair_code)) {
      db.prepare('UPDATE tenant_bots SET pair_fails = COALESCE(pair_fails, 0) + 1 WHERE tenant_id = ?').run(bot.tenant_id);
      dropCache(bot.tenant_id);
      return true;
    }
    db.prepare("UPDATE tenant_bots SET owner_chat_id = ?, pair_code = NULL, pair_expires_at = NULL, pair_fails = 0, status = 'active', paired_at = ? WHERE tenant_id = ? AND owner_chat_id IS NULL")
      .run(String(m.chat.id), nowFn().toISOString(), bot.tenant_id);
    dropCache(bot.tenant_id);
    try { await call(bot.token, 'sendMessage', { chat_id: m.chat.id, text: '✅ Готово. Новые записи, отмены и отзывы этой точки будут приходить сюда.' }); } catch (e) { /* не критично */ }
    return true;
  }

  /* После смены адреса сервера: заново привязываем вебхуки и кнопки всех ботов */
  async function resync() {
    const rows = db.prepare('SELECT tenant_id FROM tenant_bots').all();
    let ok = 0;
    for (const r of rows) {
      const b = getBot(r.tenant_id);
      if (!b) continue;
      try {
        await call(b.token, 'setWebhook', { url: webhookUrl(b.tenant_id), secret_token: b.webhook_secret, allowed_updates: ['message', 'callback_query'] });
        await menuButton(b.token, b.tenant_id);
        ok++;
      } catch (e) { log.warn('[bot] resync tenant ' + b.tenant_id + ': ' + e.message); }
    }
    return ok;
  }
  async function legacySetWebhook() {
    const pub = String(publicUrl() || '').replace(/\/+$/, '');
    if (!legacyClientToken || !pub) return false;
    await call(legacyClientToken, 'setWebhook', { url: pub + '/tg/webhook', secret_token: legacySecret(), allowed_updates: ['message', 'callback_query'] });
    return true;
  }

  return { init: init, getBot: getBot, tokenFor: tokenFor, notify: notify, register: register, status: status, webhookHealth: webhookHealth,
    repair: repair, test: test, remove: remove, handlePairing: handlePairing, resync: resync, legacySetWebhook: legacySetWebhook,
    legacyActive: legacyActive, legacySecret: legacySecret, miniAppUrl: miniAppUrl, webhookUrl: webhookUrl, dropCache: dropCache, safeEq: safeEq,
    _enc: enc, _dec: dec };
}

module.exports = { create: create, TOKEN_RE: TOKEN_RE };
