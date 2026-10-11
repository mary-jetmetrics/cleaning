'use strict';
// Уборка вдвоём: список дел с баллами и отметки «кто сделал». Оболочка публичная, данные —
// в закрытом репозитории mary-jetmetrics/cleaning-data, доступ по ключу (fine-grained token),
// который вводится один раз на устройстве или приходит ссылкой #k=…&me=gleb.
const OWNER = 'mary-jetmetrics', REPO = 'cleaning-data', BRANCH = 'main';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const PEOPLE = { maria: 'Мария', gleb: 'Глеб' };
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* без хранилища — войдёт заново */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* нечего удалять */ } },
};
let TOKEN = LS.get('cl-token');
let ME = LS.get('cl-me') || 'maria';
let MARKER = ME;              // за кого сейчас отмечаем
let TASKS = null;             // список дел из tasks.json
let LIST = [];                // id всех уборок, по порядку
let S = null, SHA = null;     // текущая уборка и sha её файла
const HISTORY = {};           // id → прошлая уборка
let saving = false, dirty = false, saveTimer = null, net = 'ok';
const closed = JSON.parse(LS.get('cl-closed') || '{}');
const root = document.getElementById('root');

/* ---------- общее ---------- */
const MON_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return (m > 10 && m < 20) ? c : k === 1 ? a : (k >= 2 && k <= 4) ? b : c; };
const pts = n => `${n} ${plural(n, 'балл', 'балла', 'баллов')}`;
const b64enc = str => { const bytes = new TextEncoder().encode(str); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); };
const b64dec = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOf = s => { const d = new Date(s.started); return `${d.getDate()} ${MON_GEN[d.getMonth()]}`; };
const WAVE = '<svg class="ls-wave" viewBox="0 0 190 8" aria-hidden="true"><path d="M1 4 Q 6 0 11 4 T 21 4 T 31 4 T 41 4 T 51 4 T 61 4 T 71 4 T 81 4 T 91 4 T 101 4 T 111 4 T 121 4 T 131 4 T 141 4 T 151 4 T 161 4 T 171 4 T 181 4"/></svg>';
const head = sub => `<header class="head"><h1 class="ls-title">Уборка</h1>${WAVE}${sub ? `<p class="cap">${sub}</p>` : ''}</header>`;

/* ---------- GitHub ---------- */
async function gh(path, opts = {}) {
  const headers = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch(API + path, { cache: 'no-store', ...opts, headers });
  if (!r.ok) { const e = new Error(`GitHub ${r.status}`); e.status = r.status; throw e; }
  return r;
}
async function getFile(file) { const j = await (await gh(`/contents/${file}?ref=${BRANCH}`)).json(); return { sha: j.sha, data: JSON.parse(b64dec(j.content)) }; }
async function putFile(file, data, sha) {
  const body = { message: 'отметки из приложения', content: b64enc(JSON.stringify(data, null, 1) + '\n'), branch: BRANCH };
  if (sha) body.sha = sha;
  return (await (await gh(`/contents/${file}`, { method: 'PUT', body: JSON.stringify(body) })).json()).content.sha;
}
async function listSessions() {
  try { return (await (await gh(`/contents/sessions?ref=${BRANCH}`)).json()).map(f => f.name).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)).sort(); }
  catch (e) { if (e.status === 404) return []; throw e; }
}

/* ---------- уборка: слияние двух телефонов и сохранение ---------- */
// у каждой отметки есть время: из двух версий побеждает более поздняя, так отметки Марии и Глеба не затирают друг друга
function merge(a, b) {
  const marks = { ...a.marks };
  for (const [k, m] of Object.entries(b.marks || {})) if (!marks[k] || m.at > marks[k].at) marks[k] = m;
  const extra = [...(a.extra || [])];
  for (const x of b.extra || []) if (!extra.some(y => y.id === x.id)) extra.push(x);
  const fin = (b.fin && (!a.fin || b.fin.at > a.fin.at)) ? b.fin : a.fin;
  return { ...a, marks, extra, fin };
}
const file = () => `sessions/${S.id}.json`;
function queueSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); }
async function save() {
  if (saving) { dirty = true; return; }
  saving = true; dirty = false; setNet('saving');
  try {
    for (let i = 0; ; i++) {
      try { SHA = await putFile(file(), S, SHA); break; }
      catch (e) {
        if (![409, 422].includes(e.status) || i >= 4) throw e;
        const r = await getFile(file()); S = merge(S, r.data); SHA = r.sha;
      }
    }
    setNet('ok');
  } catch (e) { setNet('err'); dirty = true; }
  saving = false;
  render();
  if (dirty) setTimeout(save, net === 'err' ? 5000 : 0);
}
async function poll() {
  if (!TOKEN || !TASKS || document.hidden || saving) return;
  try {
    const names = await listSessions();
    if (saving) return;
    LIST = names;
    const last = names[names.length - 1];
    if (!last) return;
    if (!S || last !== S.id) { const r = await getFile(`sessions/${last}.json`); if (saving) return; S = r.data; SHA = r.sha; return render(); }
    const r = await getFile(file());
    if (saving || r.sha === SHA) return;
    S = merge(S, r.data); SHA = r.sha; setNet('ok'); render();
  } catch (e) { /* следующая попытка через 8 секунд */ }
}
function setNet(v) { net = v; const el = document.getElementById('net'); if (el) el.textContent = NET[v]; }
const NET = { ok: 'сохранено', saving: 'сохраняю…', err: 'нет связи, повторю' };

/* ---------- подсчёт ---------- */
function totals(s) {
  const t = { maria: 0, gleb: 0, mariaN: 0, glebN: 0 };
  for (const m of Object.values(s.marks || {})) if (m.by && m.by in PEOPLE) { t[m.by] += m.pts; t[m.by + 'N']++; }
  return t;
}
const sections = () => TASKS.sections.map(sec => ({ ...sec, tasks: [...sec.tasks, ...(S.extra || []).filter(x => x.sec === sec.id)] }));
const isDone = id => !!(S.marks[id] && S.marks[id].by);
function verdict(t) {
  if (t.maria === t.gleb) return t.maria ? `Ничья: ${pts(t.maria)} на ${pts(t.gleb)}` : 'Пока никто ничего, всё впереди';
  const [w, l] = t.maria > t.gleb ? ['maria', 'gleb'] : ['gleb', 'maria'];
  return `Впереди ${PEOPLE[w]} на ${pts(t[w] - t[l])}`;
}

/* ---------- экраны ---------- */
function render() {
  if (!TASKS) return;
  if (!S || (S.fin && S.fin.v)) return homeView();
  listView();
}

function scoreBlock(t, all, done) {
  const sum = all || 1;
  return `<div class="score">
    <div class="people">
      ${['maria', 'gleb'].map(p => `<div class="person"><span class="tag ${p}">${PEOPLE[p]}</span><span class="num">${t[p]}</span><span class="cap">${plural(t[p], 'балл', 'балла', 'баллов')} · ${t[p + 'N']} ${plural(t[p + 'N'], 'дело', 'дела', 'дел')}</span></div>`).join('')}
    </div>
    ${all ? `<div class="bar" aria-hidden="true"><i class="maria" style="width:${t.maria / sum * 100}%"></i><i class="gleb" style="width:${t.gleb / sum * 100}%"></i></div>
    <p class="cap">${verdict(t)} · сделано ${done.n} из ${done.of}</p>` : ''}
  </div>`;
}

function listView() {
  const secs = sections();
  const t = totals(S);
  let all = 0, n = 0, of = 0;
  secs.forEach(sec => sec.tasks.forEach(x => { all += x.pts; of++; if (isDone(x.id)) n++; }));
  root.innerHTML = `
    ${head(`${dayOf(S)} · <span id="net">${NET[net]}</span>`)}
    <div class="sticky">
      ${scoreBlock(t, all, { n, of })}
      <div class="seg" role="group" aria-label="За кого отмечаю">
        <span class="cap">Отмечаю за</span>
        ${['maria', 'gleb'].map(p => `<button class="btn ${MARKER === p ? 'main' : ''}" data-marker="${p}">${PEOPLE[p]}</button>`).join('')}
      </div>
    </div>
    ${secs.map(sec => {
      const d = sec.tasks.filter(x => isDone(x.id)).length;
      const shut = closed[sec.id];
      return `<section class="block ${shut ? 'shut' : ''}">
        <button class="sec-head" data-sec="${sec.id}" aria-expanded="${!shut}">
          <span class="sec-name">${esc(sec.name)}</span>
          <span class="cap">${d} / ${sec.tasks.length}</span>
          <span class="chev" aria-hidden="true">${shut ? '›' : '⌄'}</span>
        </button>
        ${shut ? '' : `${sec.note ? `<p class="cap note">${esc(sec.note)}</p>` : ''}
        <ul class="rows">${sec.tasks.map(x => {
          const m = S.marks[x.id], by = m && m.by;
          return `<li><button class="row ${by ? 'done' : ''}" data-task="${esc(x.id)}" data-pts="${x.pts}">
            <span class="box" aria-hidden="true">${by ? '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>' : ''}</span>
            <span class="name">${esc(x.name)}</span>
            ${by ? `<span class="tag ${by}">${PEOPLE[by]}</span>` : ''}
            <span class="pts">+${x.pts}</span>
          </button></li>`;
        }).join('')}</ul>
        <button class="add" data-add="${sec.id}">+ свой пункт</button>`}
      </section>`;
    }).join('')}
    <div class="foot">
      <button class="btn" id="finish">Закончить уборку</button>
      ${footLinks()}
    </div>`;
}

function homeView() {
  const past = LIST.filter(id => !S || id !== S.id).slice(-10).reverse();
  root.innerHTML = `
    ${head(S ? `Последняя уборка ${dayOf(S)}` : 'Список дел с баллами: кто что сделал, тот и получил')}
    ${S ? `<section class="result">
      <p class="sec-name">${esc(resultLine(totals(S)))}</p>
      ${scoreBlock(totals(S), 0)}
      <button class="link" id="reopen">Продолжить эту уборку</button>
    </section>` : ''}
    <button class="btn main big" id="start">Начать уборку</button>
    ${past.length ? `<section class="block"><p class="sec-name">Прошлые уборки</p><ul class="rows">
      ${past.map(id => { const h = HISTORY[id]; if (!h) return `<li class="hist cap">${id}…</li>`; const t = totals(h); return `<li class="hist"><span>${dayOf(h)}</span><span class="cap">Мария ${t.maria} · Глеб ${t.gleb}</span></li>`; }).join('')}
    </ul></section>` : ''}
    <div class="foot">${footLinks()}</div>`;
  loadHistory(past);
}
function resultLine(t) {
  if (t.maria === t.gleb) return t.maria ? `Ничья: по ${pts(t.maria)}` : 'Уборка закончилась, не начавшись. Бывает';
  const [w, l] = t.maria > t.gleb ? ['maria', 'gleb'] : ['gleb', 'maria'];
  return `${w === 'maria' ? 'Победила' : 'Победил'} ${PEOPLE[w]}: ${t[w]} против ${t[l]}`;
}
async function loadHistory(ids) {
  const need = ids.filter(id => !HISTORY[id]);
  if (!need.length) return;
  await Promise.all(need.map(async id => { try { HISTORY[id] = (await getFile(`sessions/${id}.json`)).data; } catch (e) { /* покажем позже */ } }));
  if (!S || (S.fin && S.fin.v)) homeView();
}
function footLinks() {
  return `<p class="cap links">Это устройство: ${PEOPLE[ME]} · <button class="link" id="share">Ссылка для ${ME === 'maria' ? 'Глеба' : 'Марии'}</button> · <button class="link" id="logout">Выйти</button></p>`;
}

function loginView(msg) {
  root.innerHTML = `
    ${head('Вход один раз на устройстве')}
    ${msg ? `<p class="msg">${esc(msg)}</p>` : ''}
    <form class="block login" id="login">
      <label class="cap" for="key">Ключ доступа</label>
      <input id="key" type="password" autocomplete="off" placeholder="github_pat_…" required>
      <span class="cap">Кто ты</span>
      <div class="seg">${['maria', 'gleb'].map(p => `<label class="btn radio"><input type="radio" name="me" value="${p}" ${ME === p ? 'checked' : ''}> ${PEOPLE[p]}</label>`).join('')}</div>
      <button class="btn main" type="submit">Войти</button>
    </form>`;
}

/* ---------- действия ---------- */
async function startNew() {
  const d = new Date(); let id = isoDate(d), k = 2;
  while (LIST.includes(id)) id = `${isoDate(d)}-${k++}`;
  S = { id, started: d.toISOString(), marks: {}, extra: [] }; SHA = null; LIST.push(id);
  render(); await save();
}

root.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.task) {
    const id = b.dataset.task, m = S.marks[id];
    S.marks[id] = (m && m.by) ? { by: null, at: Date.now(), pts: +b.dataset.pts } : { by: MARKER, at: Date.now(), pts: +b.dataset.pts };
    render(); queueSave(); return;
  }
  if (b.dataset.marker) { MARKER = b.dataset.marker; render(); return; }
  if (b.dataset.sec) { closed[b.dataset.sec] = !closed[b.dataset.sec]; LS.set('cl-closed', JSON.stringify(closed)); render(); return; }
  if (b.dataset.add) {
    const name = (prompt('Что сделать?') || '').trim(); if (!name) return;
    const p = Math.max(1, Math.min(5, parseInt(prompt('Сколько баллов, от 1 до 5?', '2'), 10) || 2));
    S.extra = S.extra || []; S.extra.push({ id: 'x-' + Date.now().toString(36), sec: b.dataset.add, name, pts: p });
    render(); queueSave(); return;
  }
  if (b.id === 'finish') { if (!confirm('Закончить уборку и посмотреть итог?')) return; S.fin = { v: true, at: Date.now() }; render(); queueSave(); window.scrollTo(0, 0); return; }
  if (b.id === 'reopen') { S.fin = { v: false, at: Date.now() }; render(); queueSave(); return; }
  if (b.id === 'start') { b.disabled = true; await startNew(); return; }
  if (b.id === 'share') {
    const other = ME === 'maria' ? 'gleb' : 'maria';
    const url = `${location.origin}${location.pathname}#k=${encodeURIComponent(TOKEN)}&me=${other}`;
    try { await navigator.clipboard.writeText(url); b.textContent = 'Скопировано, отправь'; } catch (err) { prompt('Скопируй ссылку', url); }
    return;
  }
  if (b.id === 'logout') { if (!confirm('Выйти на этом устройстве?')) return; LS.del('cl-token'); TOKEN = null; loginView(); }
});
root.addEventListener('submit', e => {
  if (e.target.id !== 'login') return;
  e.preventDefault();
  TOKEN = e.target.key.value.trim(); LS.set('cl-token', TOKEN);
  ME = e.target.me.value; MARKER = ME; LS.set('cl-me', ME);
  boot();
});

/* ---------- старт ---------- */
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('k')) { TOKEN = h.get('k'); LS.set('cl-token', TOKEN); }
  if (h.get('me') in PEOPLE) { ME = h.get('me'); MARKER = ME; LS.set('cl-me', ME); }
  if (location.hash) history.replaceState(null, '', location.pathname);
}
let polling = false;
async function boot() {
  readHash();
  if (!TOKEN) return loginView();
  root.innerHTML = `${head('Загружаю…')}`;
  try {
    TASKS = (await getFile('tasks.json')).data;
    LIST = await listSessions();
    if (LIST.length) { const r = await getFile(`sessions/${LIST[LIST.length - 1]}.json`); S = r.data; SHA = r.sha; }
    render();
    if (!polling) { polling = true; setInterval(poll, 8000); document.addEventListener('visibilitychange', poll); }
  } catch (e) {
    if ([401, 403, 404].includes(e.status)) { LS.del('cl-token'); TOKEN = null; return loginView('Ключ не подошёл. Проверь, что он для репозитория cleaning-data и не просрочен.'); }
    root.innerHTML = `${head('Нет связи с GitHub. Обнови страницу через минуту.')}`;
  }
}
boot();
