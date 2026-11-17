/**
 * Кабинет дома 9 (Красная Пресня, 9) — сервер на Google Apps Script.
 *
 * Что делает:
 *  1. Вход собственников по коду на e-mail (белый список в таблице «Доступ»), отдельный вход администратора: код + PIN.
 *  2. Выдаёт закрытые данные кабинета по токену сессии (HMAC, 30 дней). Закрытые данные не попадают на GitHub.
 *  3. Принимает заявки, сообщения председателю, предложения и запросы доступа → таблица + письмо председателю.
 *  4. Каждые 10 минут проверяет источники в Drive (cabinet.json, реестр замечаний, баланс 2026);
 *     при изменении пересобирает data/public.json (без ПДн) и публикует его в GitHub → сайт обновляется сам.
 *
 * Первый запуск: заполнить CONFIG ниже → выполнить setup() → выполнить setAdminPin() с вашим PIN →
 * Развернуть → Новое развёртывание → Веб-приложение (Выполнять от: меня; Доступ: все) → скопировать URL в Script Properties API_URL
 * (или выполнить setApiUrl('...')) → выполнить buildNow().
 */

const CONFIG = {
  ADMIN_EMAIL: 'lychitsv@gmail.com',
  NOTIFY_EMAIL: 'lychitsv@gmail.com',          // куда приходят уведомления о заявках
  DATA_FOLDER_ID: '176t4atmVmvP_DzDTYgnCzIBnbbqDW6wK',                           // папка «Данные (редакции)»: cabinet_ГГГГ-ММ-ДД_ЧЧММ.json, берётся самая свежая редакция
  DEFECTS_SHEET_ID: '1PmvTqY2fSc4NOcJ_xWQ8QYoBj0mGjypQnysajJq8caM', // Открытый реестр замечаний — фасад
  BALANCE_SHEET_ID: '1vkPnxZrGtm0Wwv5sUeVlyvV6zTmGoBzndA3Vj21zeQo', // Баланс взаиморасчётов с ООО «Брендон» 2026
  GITHUB_REPO: 'lychits/dom9',
  GITHUB_BRANCH: 'main',
  GITHUB_PATH: 'data/public.json',
  SITE_URL: 'https://lychits.github.io/dom9/',
  SESSION_DAYS: 30,
  COUNCIL_FOLDER_ID: '1QsjEW1c9U4wkYTG2f3rqiSC7RLfHyUWn', // «Шахматка и модель (только совет)»: chess_*.json, model_*
  MODEL_SRC_FOLDER_ID: '1jjTxew4dKWSWBuJ4ZgQccKEx4LHZMk23', // 3D-модель: архивы Presnya_9_*.zip
  CHESS_SRC_FOLDER_ID: '1hgVsvLIZ257PHo6yDRxYJDS28itw_zEX', // шахматка: contacts_*.json (живые контакты)
  API_URL: 'https://script.google.com/macros/s/AKfycbwnBEef74LtvPzr7NbHJotobkYEehBwSkM8tBGfEjG824BsE7WS0k_leBW-KUMwl62Jqw/exec',
};

const P = PropertiesService.getScriptProperties();
const prop = (k, d) => P.getProperty(k) || d || '';
const cfg = k => prop(k, CONFIG[k]);

/* ======================= HTTP ======================= */
function doGet() {
  return json_({ ok: true, service: 'dom9', site: CONFIG.SITE_URL });
}

function doPost(e) {
  let req = {};
  try { req = JSON.parse(e.postData.contents || '{}'); } catch (err) { return json_({ ok: false, error: 'Неверный запрос' }); }
  try {
    switch (req.action) {
      case 'login': return json_(login_(req));
      case 'verify': return json_(verify_(req));
      case 'data': return json_(data_(req));
      case 'logout': return json_(logout_(req));
      case 'submit': return json_(submit_(req));
      case 'admin_status': requireAdmin_(req); return json_({ ok: true, status: adminStatus_() });
      case 'admin_rebuild': requireAdmin_(req); build_(true); return json_({ ok: true, status: adminStatus_() });
      case 'admin_access': requireAdmin_(req); decideAccess_(req.id, !!req.approve); return json_({ ok: true, status: adminStatus_() });
      case 'model_version': requireCouncil_(req); return json_({ ok: true, version: modelFiles_().version });
      case 'model': requireCouncil_(req); return json_(Object.assign({ ok: true }, modelPayload_()));
      default: return json_({ ok: false, error: 'Неизвестное действие' });
    }
  } catch (err) {
    log_('ERR ' + req.action + ': ' + err.message);
    return json_({ ok: false, error: err.message });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ======================= ВХОД ======================= */
function login_(req) {
  const email = norm_(req.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Проверьте e-mail');
  const cache = CacheService.getScriptCache();
  const rk = 'rl_' + email, n = +(cache.get(rk) || 0);
  if (n >= 5) throw new Error('Слишком много запросов. Попробуйте через час');
  cache.put(rk, String(n + 1), 3600);
  const user = findUser_(email);
  const isAdmin = email === norm_(CONFIG.ADMIN_EMAIL);
  if (user || isAdmin) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    cache.put('code_' + email, JSON.stringify({ h: hash_(code), tries: 0 }), 600);
    MailApp.sendEmail({
      to: email,
      subject: 'Код входа в кабинет дома 9: ' + code,
      htmlBody: '<p>Код для входа в кабинет собственника дома Красная Пресня, 9:</p><p style="font-size:24px;font-weight:700;letter-spacing:3px">' + code +
        '</p><p>Действует 10 минут. Если вы не запрашивали код — просто удалите письмо.</p><p>' + CONFIG.SITE_URL + '</p>',
      name: 'Дом 9 · кабинет',
    });
    log_('LOGIN code sent ' + mask_(email));
  } else {
    log_('LOGIN unknown ' + mask_(email));
  }
  // Ответ одинаковый — по нему нельзя узнать, есть ли адрес в реестре
  return { ok: true, needPin: isAdmin, message: 'Если адрес есть в реестре, код придёт в течение минуты' };
}

function verify_(req) {
  const email = norm_(req.email);
  const cache = CacheService.getScriptCache();
  const raw = cache.get('code_' + email);
  if (!raw) throw new Error('Код устарел — запросите новый');
  const c = JSON.parse(raw);
  if (c.tries >= 5) { cache.remove('code_' + email); throw new Error('Слишком много попыток — запросите новый код'); }
  if (c.h !== hash_(String(req.code || '').trim())) {
    c.tries++; cache.put('code_' + email, JSON.stringify(c), 600);
    throw new Error('Неверный код');
  }
  const isAdmin = email === norm_(CONFIG.ADMIN_EMAIL);
  let role, name, flat, ver;
  if (isAdmin) {
    let ph = prop('ADMIN_PIN_HASH');
    if (!ph) { // первый вход: личность подтверждена кодом из почты — PIN задаётся здесь же
      if (String(req.pin || '').length < 6) throw new Error('Первый вход администратора: придумайте PIN не короче 6 символов и введите его в поле PIN');
      P.setProperty('ADMIN_PIN_HASH', hash_(String(req.pin))); ph = prop('ADMIN_PIN_HASH'); log_('ADMIN PIN set via first login');
    }
    if (hash_(String(req.pin || '')) !== ph) { c.tries++; cache.put('code_' + email, JSON.stringify(c), 600); throw new Error('Неверный PIN'); }
    role = 'admin'; name = prop('ADMIN_NAME', 'Виктор Лычиц'); flat = prop('ADMIN_FLAT', '37'); ver = +prop('ADMIN_VER', '1');
  } else {
    const u = findUser_(email);
    if (!u) throw new Error('Доступ не найден');
    role = u.role; name = u.name; flat = u.flat; ver = u.ver;
    touchUser_(u.row);
  }
  cache.remove('code_' + email);
  const exp = Date.now() + CONFIG.SESSION_DAYS * 864e5;
  const token = sign_({ e: email, r: role, v: ver, x: exp });
  log_('VERIFY ok ' + role + ' ' + mask_(email));
  countLogin_();
  return { ok: true, session: { token, email, name, flat, role } };
}

function logout_(req) {
  const s = session_(req);
  if (s.r === 'admin') P.setProperty('ADMIN_VER', String(+prop('ADMIN_VER', '1') + 1));
  else { const u = findUser_(s.e); if (u) bumpVer_(u.row); }
  return { ok: true };
}

function session_(req) {
  const t = String(req.token || '');
  const [p, sig] = t.split('.');
  if (!p || !sig || sig !== hmac_(p)) throw new Error('Сессия недействительна');
  const s = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(p)).getDataAsString());
  if (Date.now() > s.x) throw new Error('Сессия истекла');
  if (s.r === 'admin') {
    if (s.v !== +prop('ADMIN_VER', '1')) throw new Error('Сессия завершена');
  } else {
    const u = findUser_(s.e);
    if (!u || u.ver !== s.v) throw new Error('Сессия завершена');
    s.r = u.role; // роль берём актуальную из таблицы
  }
  return s;
}
function requireCouncil_(req) { const s = session_(req); if (s.r !== 'admin' && s.r !== 'council') throw new Error('Только для совета дома'); return s; }
function requireAdmin_(req) { const s = session_(req); if (s.r !== 'admin') throw new Error('Только для администратора'); return s; }

/* ======================= ДАННЫЕ ======================= */
function data_(req) {
  const s = session_(req);
  const m = readMaster_();
  const d = { public: m.public, closed: m.closed };
  const def = parseDefects_();
  d.closed.defects = Object.assign({}, def.summary, { items: def.items });
  if (s.r === 'council' || s.r === 'admin') {
    d.council = m.council || {};
    try { d.council.chess = readChess_(); } catch (err) { log_('CHESS err ' + err.message); }
  }
  d.generatedAt = prop('LAST_BUILD_ISO', m.generatedAt || '');
  return { ok: true, data: d, user: { role: s.r } };
}

/* Мастер-данные: каждая правка — новая редакция-файл, старые не перезаписываются. Берём последнюю по имени. */
function latestMasterFile_() {
  const fid = cfg('DATA_FOLDER_ID');
  if (!fid) throw new Error('Не задан DATA_FOLDER_ID');
  const it = DriveApp.getFolderById(fid).getFiles(); let best = null;
  while (it.hasNext()) { const f = it.next(); const n = f.getName(); if (/^cabinet_\d{4}-\d{2}-\d{2}_\d{4}\.json$/.test(n) && (!best || n > best.getName())) best = f; }
  if (!best) throw new Error('В папке данных нет файлов cabinet_*.json');
  return best;
}
function readMaster_() { return JSON.parse(latestMasterFile_().getBlob().getDataAsString('UTF-8')); }

/* Реестр замечаний: A Номер, B Дата, C Аварийно, D Подъезд, E Расположение, F Этаж, G Категория, H Описание, I Фото, J Статус, … N Устранено */
function parseDefects_() {
  try {
    const sh = SpreadsheetApp.openById(CONFIG.DEFECTS_SHEET_ID).getSheets()[0];
    const v = sh.getDataRange().getDisplayValues().slice(1).filter(r => /^КП-/.test(r[0]));
    const items = v.map(r => ({ n: r[0], d: r[1], em: /да/i.test(r[2]), ent: r[3], loc: r[4], cat: r[6].split(';')[0], text: r[7].slice(0, 280), st: r[9] || 'Новое', fixed: !!r[13] }));
    const open = items.filter(i => !i.fixed);
    const summary = {
      total: items.length, emergency: items.filter(i => i.em).length, open: open.length,
      updated: Utilities.formatDate(DriveApp.getFileById(CONFIG.DEFECTS_SHEET_ID).getLastUpdated(), 'Europe/Moscow', 'dd.MM.yyyy'),
    };
    return { summary, items };
  } catch (err) {
    log_('DEFECTS err ' + err.message);
    return { summary: {}, items: [] };
  }
}

/* Контроль: последнее сальдо по подписанному акту сверки в балансе 2026 (колонка I) */
function balanceCheck_() {
  try {
    const v = SpreadsheetApp.openById(CONFIG.BALANCE_SHEET_ID).getSheets()[0].getDataRange().getValues();
    let last = null;
    v.slice(1).forEach(r => { if (/КОНТРОЛЬ/.test(String(r[1])) && typeof r[8] === 'number') last = { date: r[0], bal: r[8] }; });
    return last;
  } catch (err) { log_('BALANCE err ' + err.message); return null; }
}

/* ======================= ШАХМАТКА (только совет) ======================= */
function latestIn_(folderId, re) {
  const it = DriveApp.getFolderById(folderId).getFiles(); let best = null;
  while (it.hasNext()) { const f = it.next(); if (re.test(f.getName()) && (!best || f.getName() > best.getName())) best = f; }
  return best;
}
function readChess_() {
  const f = latestIn_(CONFIG.COUNCIL_FOLDER_ID, /^chess_.*\.json$/);
  if (!f) return null;
  const chess = JSON.parse(f.getBlob().getDataAsString('UTF-8')).chess;
  // живые контакты: последний contacts_*.json в папке шахматки дополняет контакты по квартирам
  try {
    const cf = latestIn_(CONFIG.CHESS_SRC_FOLDER_ID, /^contacts_.*\.json$/);
    if (cf) {
      const dig = v => String(v || '').replace(/\D/g, '').slice(-10);
      JSON.parse(cf.getBlob().getDataAsString('UTF-8')).forEach(j => {
        const keys = (j.apts && j.apts.length) ? j.apts : (j.porches && j.porches.length ? j.porches.map(p => 'п' + p) : ['—']);
        keys.forEach(a => {
          const lst = chess.contacts[a] = chess.contacts[a] || [];
          (j.tels && j.tels.length ? j.tels : ['']).forEach(t => {
            if (lst.some(c => (dig(t) && dig(c.phone) === dig(t)) || c.name === j.name)) return;
            lst.push({ name: j.name, role: j.title || '', phone: t, email: (j.emails || [])[0] || '', note: (j.notes || []).join('; '), added: '' });
          });
        });
      });
      chess.contactsUpdated = fmt_(cf.getLastUpdated());
    }
  } catch (err) { log_('CONTACTS err ' + err.message); }
  chess.file = f.getName();
  return chess;
}

/* ======================= 3D-МОДЕЛЬ (только совет) ======================= */
function modelFiles_() {
  const g = latestIn_(CONFIG.COUNCIL_FOLDER_ID, /^model_geometry_.*\.js$/);
  const n = latestIn_(CONFIG.COUNCIL_FOLDER_ID, /^model_networks_.*\.js$/);
  const b = latestIn_(CONFIG.COUNCIL_FOLDER_ID, /^model_geobase_.*\.jpg$/);
  return { g, n, b, version: g ? g.getName() + '@' + g.getLastUpdated().getTime() : '' };
}
function modelPayload_() {
  const m = modelFiles_();
  if (!m.g) throw new Error('Геометрия модели ещё не извлечена: выполните extractModelNow() в редакторе');
  const strip = t => t.replace(/^\s*window\.[A-Z0-9_]+\s*=\s*/, '').replace(/;\s*$/, '');
  const geometry = JSON.parse(strip(m.g.getBlob().getDataAsString('UTF-8')));
  const networks = m.n ? JSON.parse(strip(m.n.getBlob().getDataAsString('UTF-8'))) : null;
  const geobase = m.b ? 'data:image/jpeg;base64,' + Utilities.base64Encode(m.b.getBlob().getBytes()) : '';
  return { version: m.version, geometry, networks, geobase };
}
/* Извлекает geometry.js, networks-data.js и геоподоснову из самого свежего архива модели Presnya_9_*.zip */
function extractModelNow() { extractModel_(true); }
function extractModel_(force) {
  const it = DriveApp.getFolderById(CONFIG.MODEL_SRC_FOLDER_ID).getFiles(); let best = null;
  while (it.hasNext()) { const f = it.next(); if (/^Presnya_9_.*\.zip$/i.test(f.getName()) && !/ARCHIVE/i.test(f.getName()) && (!best || f.getDateCreated() > best.getDateCreated())) best = f; }
  if (!best) return;
  const key = best.getId() + '@' + best.getLastUpdated().getTime();
  if (!force && (key === prop('MODEL_ZIP') || key === prop('MODEL_ZIP_SKIP'))) return;
  const blobs = Utilities.unzip(best.getBlob());
  const pick = n => blobs.filter(b => (b.getName() || '').replace(/\\/g, '/').split('/').pop() === n)[0];
  const g = pick('geometry.js');
  if (!g) { P.setProperty('MODEL_ZIP_SKIP', key); log_('MODEL no geometry in ' + best.getName()); return; }
  const tag = (best.getName().match(/\d{4}-\d{2}-\d{2}/) || [Utilities.formatDate(new Date(), 'Europe/Moscow', 'yyyy-MM-dd')])[0] + '_' + Utilities.formatDate(new Date(), 'Europe/Moscow', 'HHmm');
  const folder = DriveApp.getFolderById(CONFIG.COUNCIL_FOLDER_ID);
  folder.createFile(g.setName('model_geometry_' + tag + '.js'));
  const n = pick('networks-data.js'); if (n) folder.createFile(n.setName('model_networks_' + tag + '.js'));
  const b = pick('geobase-10m.jpg'); if (b) folder.createFile(b.setName('model_geobase_' + tag + '.jpg'));
  P.setProperty('MODEL_ZIP', key);
  log_('MODEL extracted from ' + best.getName());
}

/* ======================= СБОРКА И ПУБЛИКАЦИЯ ======================= */
function checkAndBuild() { try { extractModel_(false); } catch (e) { log_('MODEL err ' + e.message); } build_(false); }        // триггер каждые 10 минут
function buildNow() { build_(true); }              // вручную из редактора

function build_(force) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    const mf = latestMasterFile_();
    const ids = [CONFIG.DEFECTS_SHEET_ID, CONFIG.BALANCE_SHEET_ID];
    const stamp = mf.getName() + '|' + ids.map(id => { try { return DriveApp.getFileById(id).getLastUpdated().getTime(); } catch (e) { return 0; } }).join('|');
    if (!force && stamp === prop('SRC_STAMP')) return;
    const m = readMaster_();
    const def = parseDefects_();
    const pub = JSON.parse(JSON.stringify(m.public));
    // в открытую часть уходят только общие сведения о доме (about, location, history, contacts, directory)
    ['meta','months','years','ops2026','works','appeals','events','docs','defects','dates','oss','council','todo','transparency','status_extra','base_groups'].forEach(k => delete pub[k]);
    const bc = balanceCheck_();
    let warn = '';
    const cm = (m.closed && m.closed.meta) || {};
    if (bc && cm.balAct && Math.abs(bc.bal - cm.balAct) > 0.01) warn = 'Сальдо в балансе 2026 (' + bc.bal + ') ≠ cabinet.json (' + cm.balAct + ') — обновите финансы';
    P.setProperty('BALANCE_WARN', warn);
    const nowIso = new Date().toISOString();
    const out = { public: pub, generatedAt: nowIso, api: cfg('API_URL') };
    const body = JSON.stringify(out);
    const h = hash_(JSON.stringify({ public: pub, api: out.api }));
    P.setProperty('LAST_BUILD', fmt_(new Date()));
    P.setProperty('LAST_BUILD_ISO', nowIso);
    if (h !== prop('PUB_HASH') || force) {
      githubPut_(CONFIG.GITHUB_PATH, body, 'Данные кабинета: сборка ' + fmt_(new Date()));
      P.setProperty('PUB_HASH', h);
      P.setProperty('LAST_PUSH', fmt_(new Date()));
      log_('PUSH public.json ' + body.length + ' B' + (warn ? ' · ' + warn : ''));
    } else {
      log_('BUILD no changes in public part');
    }
    P.setProperty('SRC_STAMP', stamp);
  } finally { lock.releaseLock(); }
}

function githubPut_(path, content, message) {
  const token = prop('GITHUB_TOKEN');
  if (!token) throw new Error('Не задан GITHUB_TOKEN (Script Properties)');
  const url = 'https://api.github.com/repos/' + CONFIG.GITHUB_REPO + '/contents/' + path;
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  let sha;
  const g = UrlFetchApp.fetch(url + '?ref=' + CONFIG.GITHUB_BRANCH, { headers, muteHttpExceptions: true });
  if (g.getResponseCode() === 200) sha = JSON.parse(g.getContentText()).sha;
  const r = UrlFetchApp.fetch(url, {
    method: 'put', headers, muteHttpExceptions: true, contentType: 'application/json',
    payload: JSON.stringify({ message, branch: CONFIG.GITHUB_BRANCH, sha, content: Utilities.base64Encode(content, Utilities.Charset.UTF_8) }),
  });
  if (r.getResponseCode() >= 300) throw new Error('GitHub ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 200));
}

/* ======================= ФОРМЫ ======================= */
const KIND_RU = { appeal: 'Заявка', anon: 'Сообщение председателю', idea: 'Предложение', access: 'Запрос доступа' };
function submit_(req) {
  const kind = req.kind; const p = req.payload || {};
  if (!KIND_RU[kind]) throw new Error('Неизвестный тип');
  const text = Object.keys(p).map(k => String(p[k] || '').slice(0, 3000)).join(' | ');
  if (text.replace(/[\s|]/g, '').length < 3) throw new Error('Заполните форму');
  const cache = CacheService.getScriptCache();
  const ip = 'sub_' + (req.token ? hash_(req.token).slice(0, 12) : 'anon');
  const c = +(cache.get(ip) || 0); if (c > 10) throw new Error('Слишком много отправок, попробуйте позже'); cache.put(ip, String(c + 1), 3600);
  const ss = access_();
  const year = new Date().getFullYear();
  const seq = +prop('SEQ_' + year, '0') + 1; P.setProperty('SEQ_' + year, String(seq));
  const n = year + '-' + String(seq).padStart(4, '0');
  if (kind === 'access') {
    ss.getSheetByName('Заявки').appendRow([n, new Date(), String(p.name || ''), String(p.flat || ''), norm_(p.email), 'новая']);
  } else {
    let who = '';
    if (kind !== 'anon' && req.token) { try { const s = session_(req); const u = findUser_(s.e); who = s.r === 'admin' ? 'администратор' : (u ? (u.name + ', кв. ' + u.flat) : ''); } catch (e) {} }
    const urgent = /Авария|Срочно/.test(p.urgency || '');
    ss.getSheetByName('Входящие').appendRow([n, new Date(), KIND_RU[kind], kind === 'anon' ? 'конфиденциально' : who, text, urgent ? 'срочно' : '', 'новое']);
  }
  MailApp.sendEmail(CONFIG.NOTIFY_EMAIL, 'Дом 9 · ' + KIND_RU[kind] + ' № ' + n, KIND_RU[kind] + ' № ' + n + '\n\n' + text + '\n\nТаблица: ' + ss.getUrl());
  log_('SUBMIT ' + kind + ' ' + n);
  return { ok: true, n };
}

/* ======================= ДОСТУП ======================= */
// Лист «Доступ»: A email | B ФИО | C кв. | D роль (owner|council) | E активен (да/нет) | F ver | G добавлен | H последний вход
function findUser_(email) {
  email = norm_(email);
  const sh = access_().getSheetByName('Доступ');
  const v = sh.getDataRange().getValues();
  for (let i = 1; i < v.length; i++) {
    if (norm_(v[i][0]) === email && /^да$/i.test(String(v[i][4]).trim())) {
      return { row: i + 1, email, name: String(v[i][1]), flat: String(v[i][2]), role: /council|совет/i.test(v[i][3]) ? 'council' : 'owner', ver: +v[i][5] || 1 };
    }
  }
  return null;
}
function touchUser_(row) { access_().getSheetByName('Доступ').getRange(row, 8).setValue(new Date()); }
function bumpVer_(row) { const r = access_().getSheetByName('Доступ').getRange(row, 6); r.setValue((+r.getValue() || 1) + 1); }

function decideAccess_(id, approve) {
  const ss = access_(); const sh = ss.getSheetByName('Заявки');
  const v = sh.getDataRange().getValues();
  for (let i = 1; i < v.length; i++) {
    if (String(v[i][0]) === String(id)) {
      sh.getRange(i + 1, 6).setValue(approve ? 'одобрено ' + fmt_(new Date()) : 'отклонено ' + fmt_(new Date()));
      if (approve) {
        ss.getSheetByName('Доступ').appendRow([norm_(v[i][4]), v[i][2], v[i][3], 'owner', 'да', 1, new Date(), '']);
        MailApp.sendEmail(norm_(v[i][4]), 'Доступ к кабинету дома 9 открыт',
          'Здравствуйте!\n\nДоступ к кабинету собственника дома Красная Пресня, 9 открыт.\nВход: ' + CONFIG.SITE_URL + ' → «Войти» → ваш e-mail → код из письма.\n\nСовет дома');
      }
      log_('ACCESS ' + (approve ? 'approve ' : 'reject ') + id);
      return;
    }
  }
  throw new Error('Заявка не найдена');
}

function adminStatus_() {
  const ss = access_();
  const users = ss.getSheetByName('Доступ').getDataRange().getValues().slice(1).filter(r => /^да$/i.test(String(r[4]).trim())).length;
  const req = ss.getSheetByName('Заявки').getDataRange().getValues().slice(1).filter(r => r[5] === 'новая')
    .map(r => ({ id: String(r[0]), date: fmtD_(r[1]), name: r[2], flat: r[3], email: r[4] }));
  const inbox = ss.getSheetByName('Входящие').getDataRange().getValues().slice(1).reverse().slice(0, 30)
    .map(r => ({ n: String(r[0]), date: fmtD_(r[1]), kind: r[2], text: (r[3] ? r[3] + ' — ' : '') + String(r[4]).slice(0, 400), urgent: r[5] === 'срочно' }));
  const src = [['Реестр замечаний — фасад', CONFIG.DEFECTS_SHEET_ID], ['Баланс 2026 с ООО «Брендон»', CONFIG.BALANCE_SHEET_ID]]
    .map(([name, id]) => { try { return { name, ok: true, modified: fmt_(DriveApp.getFileById(id).getLastUpdated()) }; } catch (e) { return { name, ok: false, note: e.message }; } });
  try { const mf = latestMasterFile_(); src.unshift({ name: 'Мастер-данные: ' + mf.getName(), ok: true, modified: fmt_(mf.getLastUpdated()) }); } catch (e) { src.unshift({ name: 'Мастер-данные', ok: false, note: e.message }); }
  const bw = prop('BALANCE_WARN'); if (bw) src.push({ name: 'Сверка сальдо', ok: false, note: bw });
  const logs = (prop('LOG') || '').split('\n').slice(-40).reverse().join('\n');
  return { lastBuild: prop('LAST_BUILD', '—'), lastPush: prop('LAST_PUSH', '—'), users, logins7: logins7_(), sources: src, requests: req, inbox, log: logs, links: { access: ss.getUrl() } };
}

/* ======================= УСТАНОВКА ======================= */
function setup() {
  if (!prop('SECRET')) P.setProperty('SECRET', Utilities.getUuid() + Utilities.getUuid());
  access_();
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkAndBuild').timeBased().everyMinutes(10).create();
  log_('SETUP done');
  Logger.log('Готово. Таблица доступа: ' + access_().getUrl());
}
/** Впишите свой PIN (6+ символов) в кавычки, выполните один раз, затем сотрите его из кода. */
function setAdminPin() {
  const PIN = '';
  if (String(PIN).length < 6) throw new Error('PIN — не короче 6 символов');
  P.setProperty('ADMIN_PIN_HASH', hash_(PIN));
  P.setProperty('ADMIN_VER', String(+prop('ADMIN_VER', '1') + 1));
  Logger.log('PIN сохранён. Удалите его из текста функции.');
}
function setApiUrl(url) { P.setProperty('API_URL', url || ScriptApp.getService().getUrl()); Logger.log(cfg('API_URL')); }

function access_() {
  let id = prop('ACCESS_SHEET_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  const ss = SpreadsheetApp.create('Кабинет дома 9 — доступ и входящие');
  const mk = (name, head) => { const sh = ss.insertSheet(name); sh.appendRow(head); sh.setFrozenRows(1); sh.getRange(1, 1, 1, head.length).setFontWeight('bold'); };
  mk('Доступ', ['email', 'ФИО', 'кв.', 'роль (owner/council)', 'активен (да/нет)', 'ver', 'добавлен', 'последний вход']);
  mk('Заявки', ['№', 'дата', 'ФИО', 'кв.', 'email', 'статус']);
  mk('Входящие', ['№', 'дата', 'тип', 'от кого', 'текст', 'срочность', 'статус']);
  ss.deleteSheet(ss.getSheets()[0]);
  P.setProperty('ACCESS_SHEET_ID', ss.getId());
  return ss;
}

/* ======================= УТИЛИТЫ ======================= */
function sign_(o) { const p = Utilities.base64EncodeWebSafe(JSON.stringify(o)); return p + '.' + hmac_(p); }
function hmac_(s) { return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, prop('SECRET'))); }
function hash_(s) { return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s) + prop('SECRET'))); }
function norm_(e) { return String(e || '').trim().toLowerCase(); }
function mask_(e) { return e.replace(/^(.).*(@.*)$/, '$1***$2'); }
function fmt_(d) { return Utilities.formatDate(d, 'Europe/Moscow', 'dd.MM.yyyy HH:mm'); }
function fmtD_(d) { return d instanceof Date ? Utilities.formatDate(d, 'Europe/Moscow', 'dd.MM') : String(d); }
function log_(m) { const l = (prop('LOG') + '\n' + fmt_(new Date()) + ' ' + m).split('\n').slice(-120).join('\n'); P.setProperty('LOG', l); }
function countLogin_() { const a = JSON.parse(prop('LOGINS', '[]')).filter(t => t > Date.now() - 7 * 864e5); a.push(Date.now()); P.setProperty('LOGINS', JSON.stringify(a.slice(-500))); }
function logins7_() { return JSON.parse(prop('LOGINS', '[]')).filter(t => t > Date.now() - 7 * 864e5).length; }
