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
let VIEW = null, BACK = null;  // экран истории: 'all' — все уборки, { id } — одна уборка; null — обычный
// открытая форма дела: ADDING — id помещения («+ свой пункт»), EDITING — id дела (свайп → «Править»); DRAFT — введённое
let ADDING = null, EDITING = null, DRAFT = null, pendingRender = false;
let OPEN = null, drag = null, suppressClick = false;  // свайп: у какого дела открыты «Править / Удалить», текущее перетаскивание
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
const dayOf = s => { const d = new Date(s.started), y = d.getFullYear(); return `${d.getDate()} ${MON_GEN[d.getMonth()]}${y !== new Date().getFullYear() ? ' ' + y : ''}`; };
const WAVE = '<svg class="ls-wave" viewBox="0 0 190 8" aria-hidden="true"><path d="M1 4 Q 6 0 11 4 T 21 4 T 31 4 T 41 4 T 51 4 T 61 4 T 71 4 T 81 4 T 91 4 T 101 4 T 111 4 T 121 4 T 131 4 T 141 4 T 151 4 T 161 4 T 171 4 T 181 4"/></svg>';
// карандаш у дела: виден при наведении мышью (на телефоне вместо него свайп)
const PEN = '<svg viewBox="0 0 16 16"><path d="M10.5 2.5l3 3L6 13H3v-3z M9 4l3 3"/></svg>';
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
async function putFile(file, data, sha, message = 'отметки из приложения', text = JSON.stringify(data, null, 1) + '\n') {
  const body = { message, content: b64enc(text), branch: BRANCH };
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
  for (const x of b.extra || []) {
    const i = extra.findIndex(y => y.id === x.id);
    if (i < 0) extra.push(x); else if ((x.at || 0) > (extra[i].at || 0)) extra[i] = x;
  }
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
  bgRender();
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
    if (!S || last !== S.id) { const r = await getFile(`sessions/${last}.json`); if (saving) return; S = r.data; SHA = r.sha; return bgRender(); }
    const r = await getFile(file());
    if (saving || r.sha === SHA) return;
    S = merge(S, r.data); SHA = r.sha; setNet('ok'); bgRender();
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
// свои пункты уборки — в конце своей подгруппы; без подгруппы — в конце помещения, подгруппой «Свои пункты».
// Пункт «в постоянный список» лежит и в tasks.json, и в extra (чтобы второй телефон увидел сразу) — берём один раз.
const sections = () => TASKS.sections.map(sec => {
  const tasks = [...sec.tasks], grouped = tasks.some(x => x.group);
  for (const x of (S.extra || []).filter(y => y.sec === sec.id && !y.del)) {
    if (inTasks(x.id)) continue;
    const at = x.group ? tasks.map(t => t.group).lastIndexOf(x.group) : -1;
    if (at >= 0) tasks.splice(at + 1, 0, x); else tasks.push(grouped ? { ...x, group: 'Свои пункты' } : x);
  }
  return { ...sec, tasks };
});
const groupsOf = sec => [...new Set(sec.tasks.map(x => x.group).filter(Boolean))];
const inTasks = id => TASKS.sections.some(z => z.tasks.some(t => t.id === id));
const secById = id => TASKS.sections.find(x => x.id === id);
// фоновая перерисовка (опрос, сохранение) ждёт, пока открыта форма — иначе на телефоне закроется клавиатура
function bgRender() {
  if (((ADDING || EDITING) && root.querySelector('.addform')) || (drag && drag.horiz)) { pendingRender = true; return; }
  render();
}
// подряд идущие дела одной подгруппы → [{ group, tasks }]
function byGroup(tasks) {
  const out = [];
  for (const x of tasks) {
    const last = out[out.length - 1], g = x.group || '';
    if (last && last.group === g) last.tasks.push(x); else out.push({ group: g, tasks: [x] });
  }
  return out;
}
const isDone = id => !!(S.marks[id] && S.marks[id].by);
function verdict(t) {
  if (t.maria === t.gleb) return t.maria ? `Ничья: ${pts(t.maria)} на ${pts(t.gleb)}` : 'Пока никто ничего, всё впереди';
  const [w, l] = t.maria > t.gleb ? ['maria', 'gleb'] : ['gleb', 'maria'];
  return `Впереди ${PEOPLE[w]} на ${pts(t[w] - t[l])}`;
}

/* ---------- экраны ---------- */
function render() {
  if (!TASKS) return;
  if (VIEW === 'all') return allView();
  if (VIEW) return oneView(VIEW.id);
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
        ${byGroup(sec.tasks).map(gr => `${gr.group ? `<p class="grp">${esc(gr.group)}</p>` : ''}
        <ul class="rows">${gr.tasks.map(x => {
          if (EDITING === x.id) return `<li>${itemForm('edit')}</li>`;
          const m = S.marks[x.id], by = m && m.by;
          return `<li class="sw ${OPEN === x.id ? 'open' : ''}" data-sw="${esc(x.id)}">
            <div class="acts"><button class="act edit" data-edit="${esc(x.id)}">Править</button><button class="act delete" data-del="${esc(x.id)}">Удалить</button></div>
            <button class="row ${by ? 'done' : ''}" data-task="${esc(x.id)}" data-pts="${x.pts}">
            <span class="box" aria-hidden="true">${by ? '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>' : ''}</span>
            <span class="name">${esc(x.name)}</span>
            <span class="pen" data-pen="${esc(x.id)}" title="Править" aria-hidden="true">${PEN}</span>
            ${by ? `<span class="tag ${by}">${PEOPLE[by]}</span>` : ''}
            <span class="pts">+${x.pts}</span>
          </button></li>`;
        }).join('')}</ul>`).join('')}
        ${ADDING === sec.id ? itemForm('add') : `<button class="add" data-add="${sec.id}">+ свой пункт</button>`}`}
      </section>`;
    }).join('')}
    <div class="foot">
      <button class="btn" id="finish">Закончить уборку</button>
      <p class="cap"><span class="hint-touch">Свайп влево по делу — править или удалить</span><span class="hint-mouse">Карандаш у дела при наведении — править или удалить</span></p>
      <button class="link" id="all">Прошлые уборки</button>
      ${footLinks()}
    </div>`;
}

// форма дела: добавление («+ свой пункт») и правка (свайп влево → «Править») — одна и та же
function itemForm(mode) {
  const d = DRAFT, gs = groupsOf(secById(d.sec));
  const chips = (name, vals, cur) => vals.map(v => { const [val, label] = Array.isArray(v) ? v : [v, v];
    return `<label class="chip"><input type="radio" name="${name}" value="${esc(val)}" ${String(val) === String(cur) ? 'checked' : ''}><span>${esc(label)}</span></label>`; }).join('');
  return `<form class="addform">
    <input name="name" value="${esc(d.name)}" placeholder="Что сделать?" autocomplete="off" aria-label="Что сделать">
    <div class="seg"><span class="cap lbl">Баллы</span>${chips('pts', [1, 2, 3, 4, 5], d.pts)}</div>
    ${mode === 'edit' ? `<div class="seg"><span class="cap lbl">Помещение</span>${chips('sec', TASKS.sections.map(x => [x.id, x.name]), d.sec)}</div>` : ''}
    ${gs.length ? `<div class="seg"><span class="cap lbl">Подгруппа</span>${chips('group', gs, d.group)}</div>` : ''}
    <div class="opts">
      <label><input type="radio" name="keep" value="once" ${d.keep !== 'always' ? 'checked' : ''}> Только эта уборка</label>
      <label><input type="radio" name="keep" value="always" ${d.keep === 'always' ? 'checked' : ''}> ${mode === 'edit' && d.wasPerm ? 'В постоянном списке' : 'В постоянный список'}</label>
    </div>
    ${d.err ? `<p class="msg">${esc(d.err)}</p>` : ''}
    <div class="seg"><button class="btn main" type="submit" ${d.busy ? 'disabled' : ''}>${d.busy ? 'Сохраняю…' : mode === 'edit' ? 'Сохранить' : 'Добавить'}</button><button class="link" type="button" id="formcancel">Отмена</button>
      ${mode === 'edit' ? `<button class="link del" type="button" id="itemdel" ${d.busy ? 'disabled' : ''}>Удалить</button>` : ''}</div>
  </form>`;
}
function closeForm() { ADDING = null; EDITING = null; DRAFT = null; pendingRender = false; render(); }
function openEdit(id) {
  const sec = sections().find(x => x.tasks.some(y => y.id === id)); if (!sec) return;
  const t = sec.tasks.find(y => y.id === id), own = (S.extra || []).find(y => y.id === id);
  const group = inTasks(id) ? t.group : (own && own.group) || '';
  ADDING = null; EDITING = id;
  DRAFT = { name: t.name, pts: t.pts, sec: sec.id, group: group || '', keep: inTasks(id) ? 'always' : 'once', wasPerm: inTasks(id) };
  render();
}

// tasks.json пишем в том же виде, что и руками: одно дело — одна строка
function tasksText(d) {
  const J = v => JSON.stringify(v);
  return `{\n  "scale": ${J(d.scale)},\n  "sections": [\n${d.sections.map(s => `    {\n      "id": ${J(s.id)},\n      "name": ${J(s.name)},\n${s.note ? `      "note": ${J(s.note)},\n` : ''}      "tasks": [\n${s.tasks.map(t => `        { "id": ${J(t.id)}, "name": ${J(t.name)}, "pts": ${t.pts}${t.group ? `, "group": ${J(t.group)}` : ''} }`).join(',\n')}\n      ]\n    }`).join(',\n')}\n  ]\n}\n`;
}
// постоянный список: свежий tasks.json → убрать дело, где бы оно ни было → (если task) вставить в конец подгруппы
// нужного помещения → записать; при конфликте — заново. Так работают и добавление, и правка, и удаление.
async function changeForever(id, task, secId, message) {
  for (let i = 0; ; i++) {
    const r = await getFile('tasks.json');
    for (const sec of r.data.sections) sec.tasks = sec.tasks.filter(t => t.id !== id);
    if (task) {
      const sec = r.data.sections.find(x => x.id === secId);
      const at = task.group ? sec.tasks.map(t => t.group).lastIndexOf(task.group) : -1;
      sec.tasks.splice(at >= 0 ? at + 1 : sec.tasks.length, 0, task);
    }
    try { await putFile('tasks.json', r.data, r.sha, message, tasksText(r.data)); return r.data; }
    catch (e) { if (![409, 422].includes(e.status) || i >= 4) throw e; }
  }
}
// свой пункт этой уборки: добавить или заменить; время — чтобы при слиянии двух телефонов победила последняя правка
function putExtra(x) {
  S.extra = S.extra || [];
  const i = S.extra.findIndex(y => y.id === x.id), v = { ...x, at: Date.now() };
  if (i < 0) S.extra.push(v); else S.extra[i] = v;
}

function homeView() {
  const past = LIST.filter(id => !S || id !== S.id).reverse();
  root.innerHTML = `
    ${head(S ? `Последняя уборка ${dayOf(S)}` : 'Список дел с баллами: кто что сделал, тот и получил')}
    ${S ? `<section class="result">
      <p class="sec-name">${esc(resultLine(totals(S)))}</p>
      ${scoreBlock(totals(S), 0)}
      <p class="cap links"><button class="link" data-hist="${esc(S.id)}">Кто что сделал</button> · <button class="link" id="reopen">Продолжить эту уборку</button></p>
    </section>` : ''}
    <button class="btn main big" id="start">Начать уборку</button>
    ${past.length ? `<section class="block"><p class="sec-name">Прошлые уборки</p>${histRows(past)}</section>` : ''}
    <div class="foot">${footLinks()}</div>`;
  loadHistory(past);
}
function resultLine(t) {
  if (t.maria === t.gleb) return t.maria ? `Ничья: по ${pts(t.maria)}` : 'Уборка закончилась, не начавшись. Бывает';
  const [w, l] = t.maria > t.gleb ? ['maria', 'gleb'] : ['gleb', 'maria'];
  return `${w === 'maria' ? 'Победила' : 'Победил'} ${PEOPLE[w]}: ${t[w]} против ${t[l]}`;
}
async function loadHistory(ids) {
  const need = ids.filter(id => !HISTORY[id] && !(S && S.id === id));
  if (!need.length) return;
  await Promise.all(need.map(async id => { try { HISTORY[id] = (await getFile(`sessions/${id}.json`)).data; } catch (e) { /* покажем позже */ } }));
  if (VIEW || !S || (S.fin && S.fin.v)) bgRender();
}

/* ---------- история: все уборки и одна уборка ---------- */
const sessionOf = id => (S && S.id === id) ? S : HISTORY[id];
function histRows(ids) {
  return `<ul class="rows">${ids.map(id => {
    const h = sessionOf(id);
    if (!h) return `<li class="hist cap">${esc(id)}…</li>`;
    const t = totals(h), live = !(h.fin && h.fin.v);
    return `<li><button class="histrow" data-hist="${esc(id)}">
      <span>${dayOf(h)}${live ? ' <span class="cap">· идёт</span>' : ''}</span>
      <span class="cap">Мария ${t.maria} · Глеб ${t.gleb} <span class="chev" aria-hidden="true">›</span></span>
    </button></li>`;
  }).join('')}</ul>`;
}
function allView() {
  const ids = [...LIST].reverse();
  root.innerHTML = `
    ${head('Все уборки: дата и счёт, внутри — кто что сделал')}
    <button class="link back" id="back">← Назад</button>
    ${ids.length ? `<section class="block">${histRows(ids)}</section>` : '<p class="cap">Уборок ещё не было</p>'}`;
  loadHistory(ids);
}
// что за дело: название и помещение — из самой отметки, иначе из нынешнего списка или своих пунктов уборки
function markInfo(id, m, h) {
  const order = (room, i) => ({ ri: TASKS.sections.findIndex(x => x.name === room), i });
  for (const [si, sec] of TASKS.sections.entries()) {
    const i = sec.tasks.findIndex(x => x.id === id);
    if (i >= 0) return { name: m.name || sec.tasks[i].name, room: m.room || sec.name, ...order(m.room || sec.name, i), at: m.at };
  }
  const x = (h.extra || []).find(y => y.id === id);
  const sec = x && TASKS.sections.find(y => y.id === x.sec);
  const room = m.room || (sec ? sec.name : 'Другое');
  return { name: m.name || (x ? x.name : id), room, ...order(room, 999), at: m.at };
}
function oneView(id) {
  const h = sessionOf(id);
  if (!h) { root.innerHTML = `${head('Загружаю…')}`; loadHistory([id]); return; }
  const t = totals(h);
  const person = p => {
    const done = Object.entries(h.marks || {}).filter(([, m]) => m.by === p).map(([k, m]) => ({ ...markInfo(k, m, h), pts: m.pts }));
    done.sort((a, b) => ((a.ri < 0 ? 99 : a.ri) - (b.ri < 0 ? 99 : b.ri)) || (a.i - b.i) || (a.at - b.at));
    const rooms = [];
    for (const x of done) { const last = rooms[rooms.length - 1]; if (last && last.room === x.room) last.items.push(x); else rooms.push({ room: x.room, items: [x] }); }
    return `<section class="block">
      <div class="who"><span class="tag ${p}">${PEOPLE[p]}</span><span class="cap">${pts(t[p])} · ${t[p + 'N']} ${plural(t[p + 'N'], 'дело', 'дела', 'дел')}</span></div>
      ${rooms.length ? rooms.map(r => `<p class="grp">${esc(r.room)}</p><ul class="rows">${r.items.map(x => `<li class="drow"><span>${esc(x.name)}</span><span class="pts">+${x.pts}</span></li>`).join('')}</ul>`).join('')
        : `<p class="cap">${p === 'maria' ? 'Ничего не отметила' : 'Ничего не отметил'}</p>`}
    </section>`;
  };
  root.innerHTML = `
    ${head(`Уборка ${dayOf(h)}${h.fin && h.fin.v ? '' : ' · идёт'}`)}
    <button class="link back" id="back">← Назад</button>
    <section class="result">
      <p class="sec-name">${esc(h.fin && h.fin.v ? resultLine(t) : verdict(t))}</p>
      ${scoreBlock(t, 0)}
    </section>
    ${person('maria')}
    ${person('gleb')}`;
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
  const b = e.target.closest('button');
  // открыт свайп: нажатие мимо «Править / Удалить» его закрывает, галочку при этом не ставим
  if (OPEN && !e.target.closest('.acts')) { closeSwipe(); if (!b || b.dataset.task) return; }
  if (!b) return;
  const pen = e.target.closest('[data-pen]');
  if (pen) { openEdit(pen.dataset.pen); return; }
  if (b.dataset.task) {
    const id = b.dataset.task, m = S.marks[id];
    // название и помещение пишем в отметку: история не зависит от будущих правок списка
    const sec = sections().find(x => x.tasks.some(y => y.id === id)), task = sec && sec.tasks.find(y => y.id === id);
    S.marks[id] = (m && m.by) ? { by: null, at: Date.now(), pts: +b.dataset.pts }
      : { by: MARKER, at: Date.now(), pts: +b.dataset.pts, name: task ? task.name : id, room: sec ? sec.name : '' };
    render(); queueSave(); return;
  }
  if (b.dataset.hist) { BACK = VIEW === 'all' ? 'all' : null; VIEW = { id: b.dataset.hist }; render(); window.scrollTo(0, 0); return; }
  if (b.id === 'all') { BACK = null; VIEW = 'all'; render(); window.scrollTo(0, 0); return; }
  if (b.id === 'back') { VIEW = BACK; BACK = null; render(); window.scrollTo(0, 0); return; }
  if (b.dataset.marker) { MARKER = b.dataset.marker; render(); return; }
  if (b.dataset.sec) { closed[b.dataset.sec] = !closed[b.dataset.sec]; LS.set('cl-closed', JSON.stringify(closed)); render(); return; }
  if (b.dataset.add) {
    const gs = groupsOf(secById(b.dataset.add));
    EDITING = null; ADDING = b.dataset.add; DRAFT = { name: '', pts: 2, sec: b.dataset.add, group: gs[0] || '', keep: 'once' };
    render(); const f = root.querySelector('.addform input[name=name]'); if (f) f.focus(); return;
  }
  if (b.id === 'formcancel') { closeForm(); return; }
  if (b.id === 'itemdel') { await deleteTask(EDITING); return; }
  if (b.dataset.edit) { OPEN = null; openEdit(b.dataset.edit); return; }
  if (b.dataset.del) { await deleteTask(b.dataset.del); return; }
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
// черновик формы — в DRAFT, чтобы перерисовка по нажатию галочки не стёрла введённое
root.addEventListener('input', e => {
  const f = e.target.closest('.addform'); if (!f || !DRAFT) return;
  const t = e.target; DRAFT[t.name] = t.name === 'pts' ? +t.value : t.value;
  if (t.name === 'sec') { const gs = groupsOf(secById(t.value)); if (!gs.includes(DRAFT.group)) DRAFT.group = gs[0] || ''; render(); }
});
const SAVE_ERR = 'Не получилось сохранить в постоянный список. Проверь интернет и нажми ещё раз.';
async function saveItem() {
  const d = DRAFT, name = (d.name || '').trim();
  if (!name) { d.err = 'Напиши, что сделать'; render(); return; }
  const editing = EDITING, id = editing || (d.keep === 'always' ? 'u-' : 'x-') + Date.now().toString(36);
  // в постоянном списке дело без подгруппы потеряется среди чужих — ставим первую подгруппу помещения
  const group = d.group || (d.keep === 'always' ? groupsOf(secById(d.sec))[0] : '') || undefined;
  const task = { id, name, pts: d.pts, group };
  if (d.keep === 'always' || d.wasPerm) {
    d.busy = true; d.err = ''; render();
    const msg = d.keep !== 'always' ? `из постоянного списка: ${name}` : editing && d.wasPerm ? `правка: ${name}` : `в постоянный список: ${name}`;
    try { TASKS = await changeForever(id, d.keep === 'always' ? task : null, d.sec, msg); }
    catch (err) { d.busy = false; d.err = SAVE_ERR; render(); return; }
  }
  // в уборке: разовый — свой пункт; постоянный — копия для второго телефона, если пункт уже был в уборке или новый
  const own = (S.extra || []).find(y => y.id === id);
  if (d.keep !== 'always' || own || !editing) putExtra({ ...task, sec: d.sec });
  // отметка уже стоит — переносим новые баллы, название и помещение
  const m = S.marks[id];
  if (m && m.by) S.marks[id] = { ...m, pts: d.pts, name, room: secById(d.sec).name, at: Date.now() };
  queueSave(); closeForm();
}
// удалить дело: из постоянного списка (если оно там) и из уборки; отметка снимается
async function deleteTask(id) {
  const sec = sections().find(x => x.tasks.some(y => y.id === id)), t = sec && sec.tasks.find(y => y.id === id);
  const name = t ? t.name : id, wasPerm = inTasks(id), fromForm = EDITING === id && DRAFT;
  if (!confirm(`Удалить «${name}»${wasPerm ? ' из постоянного списка' : ''}?`)) return;
  if (wasPerm) {
    if (fromForm) { DRAFT.busy = true; DRAFT.err = ''; render(); } else setNet('saving');
    try { TASKS = await changeForever(id, null, null, `удалено: ${name}`); }
    catch (err) { if (fromForm) { DRAFT.busy = false; DRAFT.err = SAVE_ERR; render(); } else { setNet('err'); alert(SAVE_ERR); } return; }
  }
  const own = (S.extra || []).find(y => y.id === id);
  if (own) putExtra({ ...own, del: true });
  const m = S.marks[id];
  if (m && m.by) S.marks[id] = { ...m, by: null, at: Date.now() };
  OPEN = null; queueSave(); closeForm();
}

// свайп влево по делу открывает «Править / Удалить». Ряд двигаем сами; вертикальную прокрутку
// отдаём телефону (touch-action: pan-y), поэтому по вертикали pointermove не приходит — придёт pointercancel
const GAP = 10;  // между баллами и кнопками, когда ряд уехал
let ACTS_W = 150; // ширина «Править / Удалить» — меряем на первом свайпе
function closeSwipe() { const li = root.querySelector('.sw.open'); if (li) li.classList.remove('open'); OPEN = null; }
root.addEventListener('pointerdown', e => {
  suppressClick = false;
  if (e.pointerType === 'mouse') return;  // мышью — карандаш, свайп только пальцем
  const row = e.target.closest('.sw > .row'); if (!row) return;
  const li = row.parentElement, acts = li.querySelector('.acts');
  if (acts && acts.offsetWidth) { ACTS_W = acts.offsetWidth + GAP; root.style.setProperty('--sw-open', `-${ACTS_W}px`); }
  drag = { id: li.dataset.sw, li, row, x0: e.clientX, y0: e.clientY, dx: 0, base: OPEN === li.dataset.sw ? -ACTS_W : 0, horiz: null, pid: e.pointerId };
});
root.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pid) return;
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
  if (drag.horiz === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
    drag.horiz = Math.abs(dx) > Math.abs(dy);
    if (!drag.horiz) { drag = null; return; }
    if (OPEN && OPEN !== drag.id) closeSwipe();
    drag.li.classList.add('drag'); drag.row.classList.add('dragging');
    try { drag.row.setPointerCapture(drag.pid); } catch (err) { /* без захвата тоже работает */ }
  }
  if (!drag.horiz) return;
  drag.dx = dx;
  drag.row.style.transform = `translateX(${Math.max(-ACTS_W - 20, Math.min(0, drag.base + dx))}px)`;
});
function endDrag(e) {
  if (!drag || (e && e.pointerId !== drag.pid)) return;
  const d = drag; drag = null;
  if (!d.horiz) return;  // обычное нажатие — это отметка, её делает click
  suppressClick = true;  // click после свайпа не должен ставить галочку
  d.row.classList.remove('dragging'); d.li.classList.remove('drag'); d.row.style.transform = '';
  if (d.base + d.dx < -ACTS_W / 2) { OPEN = d.id; d.li.classList.add('open'); }
  else { if (OPEN === d.id) OPEN = null; d.li.classList.remove('open'); }
  if (pendingRender) { pendingRender = false; render(); }
}
root.addEventListener('pointerup', endDrag);
root.addEventListener('pointercancel', endDrag);
root.addEventListener('click', e => { if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopImmediatePropagation(); } }, true);

root.addEventListener('submit', async e => {
  if (e.target.classList.contains('addform')) { e.preventDefault(); await saveItem(); return; }
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
