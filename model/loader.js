/* Загрузка 3D-модели: геометрия и сети приходят с сервера кабинета только для совета дома; кэш — IndexedDB браузера. */
(function(){
  if (window.top !== window.self) document.documentElement.classList.add('embedded');
  const lt = document.getElementById('loadtext');
  const say = t => { lt.textContent = t; };
  const db = () => new Promise((ok, no) => { const r = indexedDB.open('dom9-model', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const idbGet = async k => { try { const d = await db(); return await new Promise(ok => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => ok(q.result); q.onerror = () => ok(null); }); } catch (e) { return null; } };
  const idbSet = async (k, v) => { try { const d = await db(); d.transaction('kv', 'readwrite').objectStore('kv').put(v, k); } catch (e) {} };
  (async () => {
    let s = null; try { s = JSON.parse(localStorage.getItem('dom9.session') || 'null'); } catch (e) {}
    if (!s || !['admin', 'council'].includes(s.role)) { say('Модель доступна совету дома после входа в кабинет.'); return; }
    const pj = await fetch('../data/public.json?' + Date.now(), { cache: 'no-store' }).then(r => r.json());
    const call = a => fetch(pj.api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: a, token: s.token }) }).then(r => r.json());
    say('Проверяем версию модели…');
    const v = await call('model_version').catch(() => ({ ok: false, error: 'Сервер кабинета недоступен' }));
    if (!v.ok) { say(v.error); return; }
    if (!v.version) { say('Модель ещё не подготовлена на сервере.'); return; }
    let m = await idbGet('model');
    if (!m || m.version !== v.version) {
      say('Загружаем модель с сервера кабинета — около 8 МБ, это 10–30 секунд…');
      m = await call('model').catch(() => ({ ok: false, error: 'Не удалось загрузить модель' }));
      if (!m.ok) { say(m.error); return; }
      idbSet('model', m);
    }
    window.KP9_DATA = m.geometry; window.KP9_NETWORKS = m.networks || { registration: { matrix: [[1, 0], [0, 1]], translation: [0, 0] }, lines: [] }; window.KP9_GEOBASE = m.geobase || '';
    say('Открываем 3D-модель…');
    const sc = document.createElement('script'); sc.src = 'viewer.js'; document.body.appendChild(sc);
  })();
})();
