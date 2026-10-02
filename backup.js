/* TorclixGroup — зашифрованные резервные копии баз без платных сервисов и зарубежных карт.
   Куда: закрытый Telegram-канал (основной) и/или приватный репозиторий GitHub (запасной).
   Копия шифруется (AES-256-GCM) паролем BACKUP_PASSPHRASE ДО отправки: внешние сервисы видят только шифртекст.
   Восстановление при старте делает boot.js. Зависимостей, кроме уже установленного node-fetch, нет. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
// Встроенный fetch (Node 18+); если его нет, берём node-fetch, который уже есть в проекте
const fetch = (typeof globalThis.fetch === 'function') ? globalThis.fetch.bind(globalThis) : require('node-fetch');

const MAGIC = Buffer.from('TRCXBK1');
const TG_BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const GH_BASE = process.env.GITHUB_API_BASE || 'https://api.github.com';

function passphrase() { return process.env.BACKUP_PASSPHRASE || ''; }
let _key = null;
function key() { if (!_key) _key = crypto.scryptSync(passphrase(), 'torclix-backup-v1', 32); return _key; }

function pack(files) {
  const out = [];
  files.forEach(function (f) {
    const n = Buffer.from(f.name), h = Buffer.alloc(8);
    h.writeUInt32BE(n.length, 0); h.writeUInt32BE(f.data.length, 4);
    out.push(h, n, f.data);
  });
  return Buffer.concat(out);
}
function unpack(buf) {
  const files = []; let i = 0;
  while (i < buf.length) {
    const nl = buf.readUInt32BE(i), dl = buf.readUInt32BE(i + 4); i += 8;
    const name = buf.slice(i, i + nl).toString(); i += nl;
    files.push({ name: name, data: buf.slice(i, i + dl) }); i += dl;
  }
  return files;
}
function seal(buf) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(zlib.gzipSync(buf)), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), enc]);
}
function unseal(buf) {
  if (buf.length < 36 || !buf.slice(0, 7).equals(MAGIC)) throw new Error('не похоже на копию TorclixGroup');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), buf.slice(7, 19));
  d.setAuthTag(buf.slice(19, 35));
  try { return zlib.gunzipSync(Buffer.concat([d.update(buf.slice(35)), d.final()])); }
  catch (e) { throw new Error('не удалось расшифровать копию: неверный BACKUP_PASSPHRASE'); }
}

function multipart(fields, file) {
  const b = '----torclix' + crypto.randomBytes(8).toString('hex'), parts = [];
  Object.keys(fields).forEach(function (k) { parts.push(Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + fields[k] + '\r\n')); });
  parts.push(Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="' + file.field + '"; filename="' + file.name + '"\r\nContent-Type: application/octet-stream\r\n\r\n'), file.data, Buffer.from('\r\n--' + b + '--\r\n'));
  return { body: Buffer.concat(parts), type: 'multipart/form-data; boundary=' + b };
}

/* ---------- провайдеры: upload(buf, label), download() -> Buffer | null (null = копии ещё нет) ---------- */
const telegram = {
  name: 'telegram',
  token: function () { return process.env.BACKUP_TELEGRAM_TOKEN || ''; },
  chat: function () { return process.env.BACKUP_TELEGRAM_CHAT_ID || ''; },
  enabled: function () { return !!(this.token() && this.chat()); },
  intervalMin: function () { return parseFloat(process.env.BACKUP_INTERVAL_MIN) || 10; },
  api: async function (method, body, isMultipart) {
    const url = TG_BASE + '/bot' + this.token() + '/' + method;
    const opts = { method: 'POST' };
    if (isMultipart) { opts.body = body.body; opts.headers = { 'Content-Type': body.type }; }
    else { opts.body = JSON.stringify(body); opts.headers = { 'Content-Type': 'application/json' }; }
    const r = await fetch(url, opts), j = await r.json().catch(function () { return null; });
    if (!j || !j.ok) throw new Error('Telegram ' + method + ': ' + ((j && j.description) || ('HTTP ' + r.status)));
    return j.result;
  },
  upload: async function (buf, label) {
    const m = await this.api('sendDocument', multipart({ chat_id: this.chat(), caption: 'TorclixGroup backup ' + label, disable_notification: 'true' }, { field: 'document', name: 'torclix-' + label.replace(/[^0-9T-]/g, '') + '.bin', data: buf }), true);
    await this.api('pinChatMessage', { chat_id: this.chat(), message_id: m.message_id, disable_notification: true });
  },
  download: async function () {
    const chat = await this.api('getChat', { chat_id: this.chat() });
    const doc = chat && chat.pinned_message && chat.pinned_message.document;
    if (!doc) return null;
    const f = await this.api('getFile', { file_id: doc.file_id });
    const r = await fetch(TG_BASE + '/file/bot' + this.token() + '/' + f.file_path);
    if (!r.ok) throw new Error('Telegram file: HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  }
};

const github = {
  name: 'github',
  token: function () { return process.env.BACKUP_GITHUB_TOKEN || ''; },
  repo: function () { return process.env.BACKUP_GITHUB_REPO || ''; },
  file: function () { return process.env.BACKUP_GITHUB_PATH || 'backups/torclix.bin'; },
  enabled: function () { return !!(this.token() && this.repo()); },
  intervalMin: function () { return parseFloat(process.env.BACKUP_GITHUB_INTERVAL_MIN) || 60; },
  headers: function (accept) { return { Authorization: 'Bearer ' + this.token(), Accept: accept || 'application/vnd.github+json', 'User-Agent': 'torclix-backup', 'X-GitHub-Api-Version': '2022-11-28' }; },
  url: function () { return GH_BASE + '/repos/' + this.repo() + '/contents/' + this.file().split('/').map(encodeURIComponent).join('/'); },
  upload: async function (buf, label) {
    let sha;
    const g = await fetch(this.url(), { headers: this.headers() });
    if (g.status === 200) sha = (await g.json()).sha; else if (g.status !== 404) throw new Error('GitHub GET: HTTP ' + g.status);
    const body = { message: 'backup ' + label, content: buf.toString('base64') };
    if (sha) body.sha = sha;
    const p = await fetch(this.url(), { method: 'PUT', headers: Object.assign(this.headers(), { 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
    if (!p.ok) throw new Error('GitHub PUT: HTTP ' + p.status);
  },
  download: async function () {
    const r = await fetch(this.url(), { headers: this.headers('application/vnd.github.raw+json') });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('GitHub GET: HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  }
};
const PROVIDERS = [telegram, github];

function configured() { return passphrase().length >= 12 ? PROVIDERS.filter(function (p) { return p.enabled(); }) : []; }

/* ---------- восстановление (используется boot.js) ---------- */
/* Возвращает { restored: [имена], source } | { restored: [], notFound: true }; бросает ошибку, если копия есть, но недоступна или не расшифровалась */
async function restoreLatest(wantedNames, dataDir) {
  const provs = configured();
  if (!provs.length) return { restored: [], disabled: true };
  const errors = []; let anyNotFound = false;
  for (const p of provs) {
    try {
      const raw = await p.download();
      if (!raw) { anyNotFound = true; continue; }
      const files = unpack(unseal(raw)), restored = [];
      files.forEach(function (f) {
        if (wantedNames.indexOf(f.name) === -1) return;
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, f.name), f.data); restored.push(f.name);
      });
      return { restored: restored, source: p.name };
    } catch (e) { errors.push(p.name + ': ' + e.message); }
  }
  if (errors.length) throw new Error(errors.join('; '));
  return { restored: [], notFound: anyNotFound };
}

/* ---------- резервное копирование в работающем сервере ---------- */
const state = { started: false, providers: {}, lastChanges: -1, running: false };
PROVIDERS.forEach(function (p) { state.providers[p.name] = { last_ok: null, last_error: null, last_size: 0, last_try: 0 }; });
let handles = [];

function changes() {
  return handles.reduce(function (a, h) { try { return a + h.db.prepare('SELECT total_changes() AS c').get().c; } catch (e) { return a; } }, 0);
}
async function snapshot() {
  const files = [];
  for (const h of handles) {
    const tmp = path.join(os.tmpdir(), 'torclix-snap-' + h.name + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
    h.db.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'"); // согласованный снимок без остановки записи
    files.push({ name: h.name, data: fs.readFileSync(tmp) });
    fs.unlink(tmp, function () {});
  }
  return files;
}
async function run(force, reason) {
  if (state.running) return { skipped: 'busy' };
  const provs = configured();
  if (!provs.length) return { skipped: 'not_configured' };
  const cur = changes();
  if (!force && cur === state.lastChanges) return { skipped: 'no_changes' };
  const now = Date.now();
  const due = provs.filter(function (p) { return force || now - state.providers[p.name].last_try >= p.intervalMin() * 60000; });
  if (!due.length) return { skipped: 'not_due' };
  state.running = true;
  try {
    const sealed = seal(pack(await snapshot()));
    const label = new Date().toISOString().slice(0, 19).replace(/[:]/g, '') + (reason ? ' ' + reason : '');
    const result = {};
    for (const p of due) {
      const st = state.providers[p.name]; st.last_try = Date.now();
      try { await p.upload(sealed, label); st.last_ok = new Date().toISOString(); st.last_error = null; st.last_size = sealed.length; result[p.name] = 'ok'; }
      catch (e) { st.last_error = e.message; console.error('[backup] ' + p.name + ': ' + e.message); result[p.name] = 'error'; }
    }
    if (Object.keys(result).some(function (k) { return result[k] === 'ok'; })) state.lastChanges = cur;
    return result;
  } finally { state.running = false; }
}

function start(opts) {
  handles = [{ name: 'app.db', db: opts.db }];
  if (opts.platformDb) handles.push({ name: 'platform.db', db: opts.platformDb });
  const provs = configured();
  if (!provs.length) { console.warn('!!! Резервные копии НЕ настроены (нужны BACKUP_PASSPHRASE от 12 символов и Telegram или GitHub): данные могут пропасть при перезапуске.'); return; }
  console.log('→ Резервные копии: ' + provs.map(function (p) { return p.name; }).join(', ') + ' (шифрование включено)');
  state.started = true;
  setTimeout(function () { run(true, 'start').catch(function (e) { console.error('[backup]', e.message); }); }, 15000);
  setInterval(function () { run(false, '').catch(function (e) { console.error('[backup]', e.message); }); }, 20000).unref();
  let stopping = false;
  function shutdown() {
    if (stopping) return; stopping = true;
    const t = setTimeout(function () { process.exit(0); }, 20000);
    run(true, 'shutdown').catch(function () {}).then(function () { clearTimeout(t); process.exit(0); });
  }
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}

function status() {
  return { configured: configured().map(function (p) { return p.name; }), passphrase_ok: passphrase().length >= 12, providers: state.providers };
}

module.exports = { start: start, run: run, status: status, restoreLatest: restoreLatest, _seal: seal, _unseal: unseal, _pack: pack, _unpack: unpack };
