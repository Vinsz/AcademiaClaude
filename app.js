import { WORKOUTS, POINTS, WEEK_GOAL } from './data.js';
import {
  todayStr, weekOf, fmtDate, fmtNum, exDef, sortSessions, lastEntry, fmtSets,
  computeRecords, sessionBasePoints, totals, weekly, weightInfo, goalsProgress,
  suggestion, nextWorkout, exerciseStats,
} from './logic.js';

// ---------- armazenamento ----------
// Dois modos:
//  'db'    -> aberto no claude.ai: dados salvos na conta (visíveis só para o dono)
//  'local' -> arquivo/site comum: dados no navegador deste aparelho
// O treino em andamento (rascunho) fica sempre no navegador.
const LOCAL_KEY = 'treino.v2';
const OLD_KEY = 'treino.v1';
const DRAFT_KEY = 'treino.draft';

let storageOk = true;
let mode = 'local';
let db = null;
let loadState = 'loading'; // loading | ready | slow | error
let dbError = '';

let state = { sessions: [], walkDocs: [], walks: [], weights: [], draft: null, rest: {} };

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function lsGet(k) {
  try { return localStorage.getItem(k); } catch (e) { return null; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, v); return true; } catch (e) { return false; }
}

function syncWalks() {
  state.walks = state.walkDocs.map((w) => w.at).sort();
}

function save() {
  // só o rascunho; os dados vão por ops.*
  lsSet(DRAFT_KEY, JSON.stringify(state.draft));
}

function saveLocal() {
  if (mode !== 'local') return;
  storageOk = lsSet(LOCAL_KEY, JSON.stringify({
    sessions: state.sessions, walkDocs: state.walkDocs, weights: state.weights, rest: state.rest,
  }));
}

function loadLocal() {
  const raw = lsGet(LOCAL_KEY);
  try {
    if (raw) {
      const d = JSON.parse(raw);
      state.sessions = d.sessions || [];
      state.walkDocs = d.walkDocs || [];
      state.weights = d.weights || [];
      state.rest = d.rest || {};
    } else {
      const old = lsGet(OLD_KEY);
      if (old) {
        const d = JSON.parse(old);
        state.sessions = d.sessions || [];
        state.walkDocs = (d.walks || []).map((at) => ({ id: uid(), at }));
        state.weights = d.weights || [];
        state.rest = d.rest || {};
        if (d.draft && !lsGet(DRAFT_KEY)) state.draft = d.draft;
        saveLocal();
      }
    }
  } catch (e) { /* dados corrompidos: começa vazio */ }
  syncWalks();
}

function loadDraft() {
  try {
    const d = JSON.parse(lsGet(DRAFT_KEY) || 'null');
    if (d) state.draft = migrateDraft(d);
  } catch (e) { /* sem rascunho */ }
}

async function persist(fn) {
  if (mode !== 'db') { saveLocal(); return; }
  try {
    await fn();
  } catch (e) {
    toast(`Não foi possível salvar (${e?.code || 'erro'}). Tente de novo.`);
  }
}

// Cada operação atualiza o estado na hora e depois grava.
const ops = {
  putSession(s) {
    state.sessions = [...state.sessions.filter((x) => x.id !== s.id), s];
    return persist(() => db.doc(`sessions/${s.id}`).set(s));
  },
  delSession(id) {
    state.sessions = state.sessions.filter((s) => s.id !== id);
    return persist(() => db.doc(`sessions/${id}`).delete());
  },
  addWalk(w) {
    state.walkDocs = [...state.walkDocs, w];
    syncWalks();
    return persist(() => db.doc(`walks/${w.id}`).set({ at: w.at }));
  },
  delWalk(id) {
    state.walkDocs = state.walkDocs.filter((w) => w.id !== id);
    syncWalks();
    return persist(() => db.doc(`walks/${id}`).delete());
  },
  setWeight(w) {
    state.weights = [...state.weights.filter((x) => x.date !== w.date), w];
    return persist(() => db.doc(`weights/${w.date}`).set(w));
  },
  delWeight(date) {
    state.weights = state.weights.filter((x) => x.date !== date);
    return persist(() => db.doc(`weights/${date}`).delete());
  },
  setRest(rest) {
    state.rest = rest;
    return persist(() => db.doc('app/settings').set({ rest }));
  },
  async replaceAll(data) {
    const old = { sessions: state.sessions, walkDocs: state.walkDocs, weights: state.weights };
    state.sessions = data.sessions;
    state.walkDocs = data.walkDocs;
    state.weights = data.weights;
    state.rest = data.rest;
    syncWalks();
    if (mode !== 'db') { saveLocal(); return; }
    for (const s of old.sessions) await db.doc(`sessions/${s.id}`).delete();
    for (const w of old.walkDocs) await db.doc(`walks/${w.id}`).delete();
    for (const w of old.weights) await db.doc(`weights/${w.date}`).delete();
    for (const s of data.sessions) await db.doc(`sessions/${s.id}`).set(s);
    for (const w of data.walkDocs) await db.doc(`walks/${w.id}`).set({ at: w.at });
    for (const w of data.weights) await db.doc(`weights/${w.date}`).set(w);
    await db.doc('app/settings').set({ rest: data.rest });
  },
};

function exportData() {
  return { version: 2, exported: new Date().toISOString(), sessions: state.sessions, walks: state.walkDocs, weights: state.weights, rest: state.rest };
}

function parseBackup(data) {
  if (!Array.isArray(data.sessions) || !Array.isArray(data.weights)) throw new Error('formato');
  const walks = (data.walks || []).map((w) => (typeof w === 'string' ? { id: uid(), at: w } : { id: w.id || uid(), at: w.at }));
  return {
    sessions: data.sessions.map((s) => ({ ...s, id: s.id || uid() })),
    walkDocs: walks,
    weights: data.weights,
    rest: data.rest || {},
  };
}

function rerender() {
  // não redesenha enquanto a pessoa digita no treino (perderia o foco)
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && tab === 'treino') return;
  render();
}

async function initDb() {
  // Fora do claude.ai não existe window.claude: modo local.
  for (let i = 0; i < 5 && !(window.claude && typeof window.claude.use === 'function'); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!(window.claude && typeof window.claude.use === 'function')) return false;
  db = await window.claude.use('db');
  if (!db) return false;

  mode = 'db';
  const pending = new Set(['sessions', 'walks', 'weights', 'app']);
  const timer = setTimeout(() => {
    if (pending.size) { loadState = 'slow'; rerender(); }
  }, 10000);
  const arrived = (name, snap) => {
    if (!snap.metadata.fromCache) pending.delete(name);
    if (!pending.size) { clearTimeout(timer); loadState = 'ready'; }
    rerender();
  };
  const fail = (e) => {
    clearTimeout(timer);
    loadState = 'error';
    dbError = e?.code || 'erro';
    rerender();
  };
  db.collection('sessions').onSnapshot((snap) => {
    state.sessions = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
    arrived('sessions', snap);
  }, fail);
  db.collection('walks').onSnapshot((snap) => {
    state.walkDocs = snap.docs.map((d) => ({ id: d.id, at: d.data().at }));
    syncWalks();
    arrived('walks', snap);
  }, fail);
  db.collection('weights').onSnapshot((snap) => {
    state.weights = snap.docs.map((d) => ({ date: d.data().date, kg: d.data().kg }));
    arrived('weights', snap);
  }, fail);
  db.doc('app/settings').onSnapshot((snap) => {
    state.rest = { ...((snap.exists && snap.data().rest) || {}) };
    arrived('app', snap);
  }, fail);
  return true;
}

// Confirmação própria (confirm() pode ser bloqueado dentro do claude.ai).
function ask(msg, okLabel = 'Confirmar') {
  return new Promise((resolve) => {
    showModal(`
      <p style="margin-bottom:18px">${esc(msg)}</p>
      <button class="btn danger" data-act="ask-yes">${esc(okLabel)}</button>
      <button class="btn secondary" data-act="ask-no" style="margin-top:10px">Cancelar</button>`);
    askResolve = (v) => { $('#modal').hidden = true; askResolve = null; resolve(v); };
  });
}
let askResolve = null;

// ---------- utilidades ----------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v, max) => `${Math.max(0, Math.min(100, max ? (v / max) * 100 : 0)).toFixed(1)}%`;
const bar = (v, max, cls = '') => `<div class="bar ${cls} ${v >= max ? 'done' : ''}"><span style="width:${pct(v, max)}"></span></div>`;
const num = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

let tab = 'inicio';
let histView = 'calendario';
let calMonth = todayStr().slice(0, 7);
let calSel = null;
let chartEx = 'extensora';

// ---------- render principal ----------
function render() {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  const v = $('#view');
  if (tab === 'inicio') v.innerHTML = viewHome();
  else if (tab === 'treino') v.innerHTML = state.draft ? viewDraft() : viewPick();
  else if (tab === 'historico') v.innerHTML = viewHistory();
  else v.innerHTML = viewWeight();
}

// ---------- Início ----------
function viewHome() {
  const t = totals(state);
  const wk = weekly(state);
  const wi = weightInfo(state.weights);
  const goals = goalsProgress(state.sessions);
  const last = sortSessions(state.sessions).at(-1);

  const dots = Array.from({ length: Math.max(wk.weekGoal, wk.sessions) }, (_, i) => `<span class="dot ${i < wk.sessions ? 'on' : ''}"></span>`).join('');

  let lastLine = '';
  if (last) {
    const base = sessionBasePoints(last).points;
    const recs = (t.records.get(last.id) || []).length;
    lastLine = `<p class="tiny" style="margin-top:10px">Último: ${fmtDate(last.date)} · Treino ${last.workout} · +${base + recs * POINTS.record} pts${recs ? ` · ${recs} recorde${recs > 1 ? 's' : ''}` : ''}</p>`;
  }

  let notice = '';
  if (loadState === 'loading' && !state.sessions.length) return '<p class="muted" style="padding:40px 0;text-align:center">Carregando seus dados…</p>';
  if (mode === 'db' && loadState === 'slow') notice = '<div class="card small chip reps">Não consegui confirmar os dados com o servidor ainda. O que aparece pode estar desatualizado.</div>';
  if (mode === 'db' && loadState === 'error') notice = `<div class="card small chip care">Não foi possível acessar os dados (${esc(dbError)}). Recarregue a página.</div>`;
  if (mode === 'local' && !storageOk) notice = '<div class="card small chip care">Não foi possível salvar neste navegador. Os dados podem se perder ao fechar.</div>';
  if (mode === 'local' && !state.sessions.length && !state.weights.length) notice += '<div class="card small">Sem dados ainda. Para trazer seu histórico, vá em Histórico → Dados → Importar backup.</div>';

  return `
    ${notice}
    <div class="card">
      <div class="row between">
        <div><div class="tiny">Nível</div><div class="big-num">${t.level}</div></div>
        <div style="text-align:right"><div class="mid-num">${t.total}</div><div class="tiny">pontos</div></div>
      </div>
      ${bar(t.inLevel, t.perLevel, 'big')}
      <p class="tiny">${t.inLevel} / ${t.perLevel} até o nível ${t.level + 1}</p>
    </div>

    <div class="card">
      <h2>Semana</h2>
      <div class="row between">
        <div class="dots" aria-label="${wk.sessions} de ${wk.weekGoal} treinos">${dots}</div>
        <div class="mid-num">${wk.sessions}/${wk.weekGoal}</div>
      </div>
      <p class="small muted" style="margin-top:8px">Sequência: <b>${wk.streak}</b> semana${wk.streak === 1 ? '' : 's'} seguida${wk.streak === 1 ? '' : 's'}
        · Escudos: <b>${wk.shields}</b></p>
      <p class="tiny">1 escudo a cada 4 semanas completas. Ele salva a sequência numa semana ruim.</p>
    </div>

    <div class="card">
      <h2>Caminhadas</h2>
      <div class="row">
        <div class="grow">
          <div class="mid-num">${wk.walks}/${wk.walkGoal}</div>
          ${bar(wk.walks, wk.walkGoal)}
          <p class="tiny">Meta sobe +2 depois de 2 semanas batidas${wk.walkHits ? ` (1/2 feita)` : ''}.</p>
        </div>
        <button class="btn-walk" data-act="walk">+ Caminhada</button>
      </div>
    </div>

    <button class="btn" data-act="go-train" style="margin-bottom:12px">${state.draft ? `${state.draft.editingId ? 'Continuar edição do' : 'Continuar'} treino ${state.draft.workout}` : 'Começar treino'}</button>

    ${wi ? `
    <div class="card">
      <h2>Peso</h2>
      <div class="row between">
        <div><span class="mid-num">${fmtNum(wi.avg)}</span> <span class="muted">kg</span></div>
        <div class="small muted">${wi.next ? `Próximo marco: <b>${fmtNum(wi.next.kg)} kg</b> (${wi.next.label})` : 'Meta atingida'}</div>
      </div>
      ${wi.next ? bar(wi.fromKg - wi.avg, wi.fromKg - wi.next.kg) : bar(1, 1)}
      <p class="tiny">${wi.next ? `${fmtNum(Math.max(0, wi.fromKg - wi.avg))} / ${fmtNum(wi.fromKg - wi.next.kg)} kg · ` : ''}média das últimas 3 pesagens</p>
      <button class="link" data-act="go-weight" style="margin-top:4px">+ Registrar peso</button>
    </div>` : ''}

    <div class="card">
      <h2>Metas</h2>
      <div class="stack">
        ${goals.map((g) => `
          <div>
            <div class="row between small"><span>${g.done ? '✓ ' : ''}${esc(g.label)}</span><span class="muted">${g.text}</span></div>
            ${bar(g.value, g.max)}
          </div>`).join('')}
      </div>
      <p class="tiny" style="margin-top:6px">Metas de carga contam a última sessão do exercício.</p>
      ${lastLine}
    </div>`;
}

// ---------- Treino: escolha ----------
function viewPick() {
  const thisWeek = weekOf(todayStr());
  const sorted = sortSessions(state.sessions);
  return `
    <h1>Qual treino hoje?</h1>
    <div class="pick">
      ${Object.entries(WORKOUTS).map(([k, w]) => {
        const last = sorted.filter((s) => s.workout === k).at(-1);
        const thisWk = sorted.filter((s) => s.workout === k && weekOf(s.date) === thisWeek).length;
        const info = thisWk ? `feito esta semana${thisWk > 1 ? ` (${thisWk}x)` : ''}` : last ? `último: ${fmtDate(last.date)}` : 'ainda não feito';
        return `
        <button data-act="start" data-w="${k}">
          <div class="letter">${k}</div>
          <div class="small">${esc(w.name)}</div>
          <div class="tiny">${w.place}${k === 'D' ? ` · ${POINTS.workoutHome} pts` : ''}</div>
          <div class="tiny">${info}</div>
        </button>`;
      }).join('')}
    </div>
    <p class="tiny" style="margin-top:12px">O D substitui o B quando você não vai à academia, ou entra como extra 48h depois do B.</p>`;
}

// Linhas do rascunho: cada exercício tem { done, groups: [{ sets, reps, kg, secs }] }
// (cardio: groups = [{ min, km }]). Um grupo = "3 séries × 15 reps com 12 kg".
function groupSets(ex, sets) {
  if (ex.type === 'cardio') return [{ min: sets[0]?.min ?? '', km: sets[0]?.km ?? '' }];
  const groups = [];
  for (const s of sets) {
    const g = groups[groups.length - 1];
    const same = g && (g.kg ?? '') === (s.kg ?? '') && (g.reps ?? '') === (s.reps ?? '') && (g.secs ?? '') === (s.secs ?? '');
    if (same) g.sets++;
    else groups.push({ sets: 1, kg: s.kg ?? '', reps: s.reps ?? '', secs: s.secs ?? '' });
  }
  return groups;
}

function defaultRows(ex) {
  const last = lastEntry(state.sessions, ex.id);
  if (ex.type === 'cardio') return { done: false, groups: [{ min: last?.sets[0]?.min ?? '', km: '' }] };
  if (last) return { done: false, groups: groupSets(ex, last.sets) };
  return { done: false, groups: [{ sets: ex.sets, kg: '', reps: ex.type === 'time' ? '' : ex.lo, secs: ex.type === 'time' ? ex.lo : '' }] };
}

// Rascunhos antigos (uma linha por série) viram grupos.
function migrateDraft(d) {
  if (!d || !d.rows) return d;
  for (const [exId, rows] of Object.entries(d.rows)) {
    if (!Array.isArray(rows)) continue;
    const ex = exDef(exId);
    if (!ex) { delete d.rows[exId]; continue; }
    const done = rows.some((r) => r.done);
    const used = done ? rows.filter((r) => r.done) : rows;
    d.rows[exId] = { done, groups: groupSets(ex, used) };
  }
  return d;
}

function startDraft(w) {
  const rows = {};
  for (const ex of WORKOUTS[w].exercises) rows[ex.id] = defaultRows(ex);
  state.draft = { workout: w, date: todayStr(), rows, pain: false, heavy: false, note: '' };
  save();
}

function editSession(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  const rows = {};
  for (const ex of WORKOUTS[s.workout].exercises) {
    const sets = s.entries[ex.id];
    rows[ex.id] = sets && sets.length ? { done: true, groups: groupSets(ex, sets) } : defaultRows(ex);
  }
  state.draft = {
    editingId: s.id, created: s.created, workout: s.workout, date: s.date, rows,
    pain: !!s.pain, heavy: !!s.heavy, note: s.note || '',
  };
  save();
  stopTimer();
  tab = 'treino';
  render();
  window.scrollTo(0, 0);
}

// ---------- Treino: sessão em andamento ----------
function viewDraft() {
  const d = state.draft;
  const def = WORKOUTS[d.workout];
  return `
    <div class="row between">
      <h1 style="margin-bottom:4px">${d.editingId ? 'Editando treino' : 'Treino'} ${d.workout}</h1>
      <input type="date" class="input" style="width:auto" value="${d.date}" data-draft="date" aria-label="Data do treino">
    </div>
    <p class="muted small" style="margin-bottom:14px">${esc(def.name)} · confira os números e toque em ✓ quando terminar o exercício</p>
    ${def.exercises.map((ex) => exCard(ex, d.rows[ex.id] || defaultRows(ex))).join('')}
    <div class="card">
      <label class="toggle"><input type="checkbox" data-draft="pain" ${d.pain ? 'checked' : ''}> Dor na coluna</label>
      <label class="toggle"><input type="checkbox" data-draft="heavy" ${d.heavy ? 'checked' : ''}> Dia pesado</label>
      <textarea rows="2" placeholder="Observações" data-draft="note">${esc(d.note)}</textarea>
      <p class="tiny" style="margin-top:6px">Treino com dor vale os mesmos pontos. Na próxima vez, o app sugere manter a carga.</p>
    </div>
    <button class="btn" data-act="finish">${d.editingId ? 'Salvar alterações' : 'Concluir treino'}</button>
    <button class="btn secondary" data-act="discard" style="margin-top:10px">${d.editingId ? 'Cancelar edição' : 'Descartar'}</button>`;
}

function exCard(ex, row) {
  const editing = state.draft?.editingId;
  const last = lastEntry(state.sessions.filter((s) => s.id !== editing), ex.id);
  const sug = suggestion(ex, last, last?.session.pain);
  const rest = state.rest[ex.id] ?? ex.rest;
  const target = ex.type === 'cardio' ? ex.target
    : `${ex.sets} × ${ex.lo === ex.hi ? ex.lo : `${ex.lo}-${ex.hi}`}${ex.type === 'time' ? 's' : ''}${rest && !editing ? ` · descanso ${rest}s` : ''}`;

  const many = row.groups.length > 1;
  const groupHtml = row.groups.map((g, i) => {
    const attrs = `data-ex="${ex.id}" data-i="${i}"`;
    const field = (k, unit, mode = 'decimal') => `<label class="field"><input inputmode="${mode}" ${attrs} data-k="${k}" value="${esc(g[k])}" aria-label="${unit}"><span>${unit}</span></label>`;
    const del = many ? `<button class="del" data-act="del-group" ${attrs} aria-label="Remover linha">✕</button>` : '<span></span>';
    if (ex.type === 'cardio') return `<div class="grp two">${field('min', 'min')}${field('km', 'km')}</div>`;
    if (ex.type === 'weight') return `<div class="grp three">${field('sets', 'séries', 'numeric')}${field('reps', 'reps', 'numeric')}${field('kg', 'kg')}${del}</div>`;
    if (ex.type === 'time') return `<div class="grp two">${field('sets', 'séries', 'numeric')}${field('secs', 'seg', 'numeric')}${del}</div>`;
    return `<div class="grp two">${field('sets', 'séries', 'numeric')}${field('reps', 'reps', 'numeric')}${del}</div>`;
  }).join('');

  return `
    <div class="card ${row.done ? 'ex-done' : ''}">
      <div class="ex-head">
        <div class="grow">
          <h3>${esc(ex.name)}${ex.optional ? ' <span class="tiny">(opcional)</span>' : ''}</h3>
          <p class="tiny">${esc(target)}</p>
        </div>
        ${ex.type !== 'cardio' && rest && !editing ? `<button class="btn-small" data-act="rest" data-ex="${ex.id}">⏱ ${rest}s</button>` : ''}
      </div>
      <p class="small muted" style="margin-top:6px">Última: ${last ? `${fmtSets(ex, last.sets)} <span class="tiny">(${fmtDate(last.session.date)})</span>` : 'sem registro'}</p>
      ${sug ? `<span class="chip ${sug.kind}">${esc(sug.text)}</span>` : ''}
      <div class="groups">${groupHtml}</div>
      ${many && ex.type !== 'cardio' ? `<p class="tiny" style="margin-top:6px">Total: <b>${row.groups.reduce((t, g) => t + (num(g.sets) || 0), 0)} séries</b> (cada linha = séries feitas com aquela carga)</p>` : ''}
      <div class="row between" style="margin-top:4px">
        ${ex.type !== 'cardio' ? `<button class="link" data-act="add-group" data-ex="${ex.id}">+ outra carga</button>` : '<span></span>'}
        <button class="done-btn ${row.done ? 'on' : ''}" data-act="check" data-ex="${ex.id}" aria-pressed="${row.done}">${row.done ? '✓ Feito' : '✓ Marcar feito'}</button>
      </div>
    </div>`;
}

function buildEntries(d) {
  const entries = {};
  for (const ex of WORKOUTS[d.workout].exercises) {
    const row = d.rows[ex.id];
    if (!row || !row.done) continue;
    const sets = [];
    for (const g of row.groups) {
      if (ex.type === 'cardio') { sets.push({ min: num(g.min), km: num(g.km) }); continue; }
      const n = Math.max(0, Math.min(20, Math.round(num(g.sets) ?? 0)));
      for (let i = 0; i < n; i++) {
        if (ex.type === 'weight') sets.push({ kg: num(g.kg) ?? 0, reps: num(g.reps) ?? 0 });
        else if (ex.type === 'time') sets.push({ secs: num(g.secs) ?? 0 });
        else sets.push({ reps: num(g.reps) ?? 0 });
      }
    }
    if (sets.length) entries[ex.id] = sets;
  }
  return entries;
}

function finishDraft() {
  const d = state.draft;
  const entries = buildEntries(d);
  if (!Object.keys(entries).length) {
    toast('Marque ✓ em pelo menos um exercício.');
    return;
  }

  if (d.editingId) {
    const session = { id: d.editingId, created: d.created ?? Date.now(), date: d.date, workout: d.workout, entries, pain: d.pain, heavy: d.heavy, note: d.note.trim() };
    ops.putSession(session);
    state.draft = null;
    save();
    stopTimer();
    tab = 'historico';
    histView = 'sessoes';
    render();
    toast('Treino atualizado.');
    return;
  }

  const before = totals(state);
  const beforeWeek = weekly(state);
  const session = { id: uid(), created: Date.now(), date: d.date, workout: d.workout, entries, pain: d.pain, heavy: d.heavy, note: d.note.trim() };
  ops.putSession(session);
  state.draft = null;
  save();
  stopTimer();

  const after = totals(state);
  const wk = weekly(state);
  const recs = after.records.get(session.id) || [];
  const base = sessionBasePoints(session);
  const goals = goalsProgress(state.sessions).filter((g) => entries[g.ex]);
  const sameWeek = weekOf(d.date) === wk.thisWeek;

  showModal(`
    <div class="sum-pts">+${after.total - before.total} pts</div>
    <p class="muted">Treino ${session.workout}${base.complete ? ' completo' : ` · ${base.done}/${base.total} exercícios`} · ${base.points} pts${recs.length ? ` + ${recs.length} recorde${recs.length > 1 ? 's' : ''}` : ''}</p>
    ${after.level > before.level ? `<p style="margin-top:10px"><b>Nível ${after.level}!</b></p>` : ''}
    ${recs.length ? `<h2 style="margin-top:16px">Recordes</h2><div class="stack">${recs.map((r) => `<div class="row between small"><span>${esc(r.name)}</span><span class="chip pr">${esc(r.label)}</span></div>`).join('')}</div>` : ''}
    ${goals.length ? `<h2 style="margin-top:16px">Metas</h2><div class="stack">${goals.map((g) => `<div><div class="row between small"><span>${esc(g.label)}</span><span class="muted">${g.text}</span></div>${bar(g.value, g.max)}</div>`).join('')}</div>` : ''}
    ${sameWeek ? `<p class="small muted" style="margin-top:16px">Semana: ${wk.sessions}/${wk.weekGoal}${wk.sessions >= wk.weekGoal && beforeWeek.sessions < wk.weekGoal ? ' · semana completa!' : ''}</p>` : ''}
    <button class="btn" data-act="close-modal" style="margin-top:18px">OK</button>`);
  tab = 'inicio';
  render();
}

// ---------- Histórico ----------
function viewHistory() {
  const seg = `
    <div class="seg">
      <button data-act="hist" data-v="calendario" class="${histView === 'calendario' ? 'on' : ''}">Calendário</button>
      <button data-act="hist" data-v="sessoes" class="${histView === 'sessoes' ? 'on' : ''}">Sessões</button>
      <button data-act="hist" data-v="evolucao" class="${histView === 'evolucao' ? 'on' : ''}">Evolução</button>
      <button data-act="hist" data-v="dados" class="${histView === 'dados' ? 'on' : ''}">Dados</button>
    </div>`;
  if (histView === 'calendario') return seg + viewCalendar();
  if (histView === 'evolucao') return seg + viewEvolution();
  if (histView === 'dados') return seg + viewData();

  const records = computeRecords(state.sessions);
  const list = sortSessions(state.sessions).reverse();
  return seg + (list.length ? list.map((s) => {
    const b = sessionBasePoints(s);
    const recs = records.get(s.id) || [];
    const exs = WORKOUTS[s.workout].exercises;
    return `
      <details class="card">
        <summary class="row between" style="list-style:none;cursor:pointer">
          <div>
            <h3>${fmtDate(s.date)} · Treino ${s.workout}</h3>
            <p class="tiny">${b.complete ? 'Completo' : `${b.done}/${b.total} exercícios`}${s.pain ? ' · dor na coluna' : ''}${s.heavy ? ' · dia pesado' : ''}</p>
          </div>
          <div style="text-align:right"><b>+${b.points + recs.length * POINTS.record}</b><div class="tiny">${recs.length ? `${recs.length} recorde${recs.length > 1 ? 's' : ''}` : 'pts'}</div></div>
        </summary>
        <table style="margin-top:10px"><tbody>
          ${exs.map((ex) => {
            const sets = s.entries[ex.id];
            const pr = recs.find((r) => r.exId === ex.id);
            return `<tr><td>${esc(ex.name)}${pr ? ' <span class="chip pr">recorde</span>' : ''}</td><td class="num ${sets ? '' : 'muted'}">${sets ? esc(fmtSets(ex, sets)) : (ex.optional ? '–' : 'pulado')}</td></tr>`;
          }).join('')}
        </tbody></table>
        ${s.note ? `<p class="small muted" style="margin-top:8px">${esc(s.note)}</p>` : ''}
        <div class="row between" style="margin-top:6px">
          <button class="link" data-act="edit-session" data-id="${s.id}">Editar</button>
          <button class="link" data-act="del-session" data-id="${s.id}" style="color:var(--care)">Apagar sessão</button>
        </div>
      </details>`;
  }).join('') : '<p class="muted">Nenhum treino ainda.</p>');
}

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function viewCalendar() {
  const [yy, mm] = calMonth.split('-').map(Number);
  const first = `${calMonth}-01`;
  const daysIn = new Date(yy, mm, 0).getDate();
  const last = `${calMonth}-${String(daysIn).padStart(2, '0')}`;
  const today = todayStr();
  const byDate = new Map();
  for (const s of sortSessions(state.sessions)) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push(s);
  }
  const walksByDate = new Map();
  for (const w of state.walks) walksByDate.set(w.slice(0, 10), (walksByDate.get(w.slice(0, 10)) || 0) + 1);

  const shift = (iso, n) => { const [a, b, c] = iso.split('-').map(Number); return todayStr(new Date(a, b - 1, c + n)); };
  let rows = '';
  for (let wk = weekOf(first); wk <= last; wk = shift(wk, 7)) {
    let cells = '';
    let count = 0;
    for (let i = 0; i < 7; i++) {
      const d = shift(wk, i);
      count += (byDate.get(d) || []).length;
      if (d.slice(0, 7) !== calMonth) { cells += '<div class="cal-cell out"></div>'; continue; }
      const ss = byDate.get(d) || [];
      const walks = walksByDate.get(d) || 0;
      const cls = ['cal-cell', ss.length ? 'has' : '', d === today ? 'today' : '', d === calSel ? 'sel' : '', d > today ? 'future' : ''].join(' ');
      cells += `<button class="${cls}" data-act="cal-day" data-date="${d}" aria-label="${Number(d.slice(8))} de ${MONTHS[mm - 1]}${ss.length ? `: treino ${ss.map((x) => x.workout).join(' e ')}` : ''}">
        <span class="cal-num">${Number(d.slice(8))}</span>
        <span class="cal-marks">${ss.map((x) => `<b class="cal-w ${x.workout === 'D' ? 'home' : ''}">${x.workout}</b>`).join('')}</span>
        ${walks ? `<span class="cal-walk" title="${walks} caminhada(s)"></span>` : ''}
      </button>`;
    }
    const wkDone = count >= WEEK_GOAL;
    const wkPast = shift(wk, 6) < today;
    rows += `${cells}<div class="cal-wk ${wkDone ? 'ok' : ''}">${wkDone ? '✓' : wkPast || weekOf(today) === wk ? `${count}/${WEEK_GOAL}` : ''}</div>`;
  }

  const monthSessions = state.sessions.filter((s) => s.date >= first && s.date <= last);
  const perW = ['A', 'B', 'C', 'D'].map((k) => [k, monthSessions.filter((s) => s.workout === k).length]).filter(([, n]) => n);
  const monthWalks = state.walks.filter((w) => w.slice(0, 10) >= first && w.slice(0, 10) <= last).length;

  let detail = '';
  if (calSel) {
    const ss = byDate.get(calSel) || [];
    const recs = computeRecords(state.sessions);
    detail = `<div class="card">
      <h3>${Number(calSel.slice(8))} de ${MONTHS[Number(calSel.slice(5, 7)) - 1]}</h3>
      ${ss.length ? ss.map((s) => {
        const b = sessionBasePoints(s);
        const r = (recs.get(s.id) || []).length;
        return `<div class="list-item row between"><div><b>Treino ${s.workout}</b> · ${esc(WORKOUTS[s.workout].name)}<div class="tiny">${b.complete ? 'Completo' : `${b.done}/${b.total} exercícios`}${r ? ` · ${r} recorde${r > 1 ? 's' : ''}` : ''}${s.pain ? ' · dor na coluna' : ''}</div>${s.note ? `<div class="tiny">${esc(s.note)}</div>` : ''}</div><b>+${b.points + r * POINTS.record}</b></div>`;
      }).join('') : '<p class="muted small" style="margin-top:6px">Sem treino neste dia.</p>'}
      ${walksByDate.get(calSel) ? `<p class="small muted" style="margin-top:8px">${walksByDate.get(calSel)} caminhada(s)</p>` : ''}
    </div>`;
  }

  return `
    <div class="card">
      <div class="row between">
        <button class="btn-small" data-act="cal-month" data-d="-1" aria-label="Mês anterior">‹</button>
        <h3 style="text-transform:capitalize">${MONTHS[mm - 1]} ${yy}</h3>
        <button class="btn-small" data-act="cal-month" data-d="1" aria-label="Próximo mês">›</button>
      </div>
      <div class="cal">
        ${['S', 'T', 'Q', 'Q', 'S', 'S', 'D'].map((d) => `<div class="cal-h">${d}</div>`).join('')}<div class="cal-h">sem.</div>
        ${rows}
      </div>
      <div class="cal-legend tiny">
        <span><b class="cal-w">A</b> treino na academia</span>
        <span><b class="cal-w home">D</b> treino em casa</span>
        <span><i class="cal-walk"></i> caminhada</span>
      </div>
    </div>
    ${detail}
    <div class="card small">
      <b>${monthSessions.length}</b> treino${monthSessions.length === 1 ? '' : 's'} no mês${perW.length ? ` · ${perW.map(([k, n]) => `${k}: ${n}`).join(' · ')}` : ''}${monthWalks ? ` · ${monthWalks} caminhada${monthWalks > 1 ? 's' : ''}` : ''}
    </div>`;
}

function viewEvolution() {
  const ex = exDef(chartEx);
  const all = exerciseStats(state.sessions, chartEx);
  const opts = Object.entries(WORKOUTS).map(([k, w]) => `<optgroup label="Treino ${k}">${w.exercises.map((e) => `<option value="${e.id}" ${e.id === chartEx ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</optgroup>`).join('');
  const head = `
    <div class="card">
      <select class="input" data-act="chart-ex" aria-label="Exercício">${opts}</select>
      <p class="tiny" style="margin-top:8px">${all.length} treino${all.length === 1 ? '' : 's'} registrado${all.length === 1 ? '' : 's'}${all.length ? ` · de ${fmtDate(all[0].date)} a ${fmtDate(all.at(-1).date)}` : ''}</p>
    </div>`;
  if (!all.length) return head + '<p class="muted small">Sem registros deste exercício ainda.</p>';

  const cfg = evoConfig(ex, all);
  const rows = cfg.rows;
  const labels = rows.map((r) => fmtDate(r.date));
  const tips = rows.map((r) => `${fmtDate(r.date)} · ${r.detail}${r.pain ? ' · dor na coluna' : ''}`);

  const tiles = cfg.tiles.map((t) => {
    const vals = rows.map((r) => r[t.key]).filter((v) => v != null);
    if (!vals.length) return '';
    const last = vals.at(-1);
    const diff = last - vals[0];
    const d = vals.length > 1 && Math.abs(diff) >= 10 ** -t.digits / 2
      ? `<span class="delta ${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '▲ +' : '▼ −'}${fmtNum(Math.abs(diff), t.digits)} ${t.unit}</span>`
      : `<span class="delta">${vals.length > 1 ? 'igual ao início' : 'primeiro registro'}</span>`;
    return `<div class="tile"><div class="tiny">${t.label}</div><div class="tile-num">${fmtNum(last, t.digits)}<span class="tile-unit"> ${t.unit}</span></div>${d}</div>`;
  }).join('');

  const charts = cfg.charts.map((c) => `
    <div class="card">
      <h3>${c.title}</h3>
      ${c.note ? `<p class="tiny">${c.note}</p>` : ''}
      ${chart({
        labels,
        tips,
        kind: c.kind,
        digits: c.digits ?? 1,
        series: c.series.map((s) => ({ ...s, values: rows.map((r) => r[s.key] ?? null) })),
      })}
    </div>`).join('');

  const skipped = all.length - rows.length;
  return `${head}
    <div class="tiles">${tiles}</div>
    <p class="tiny" style="margin:-4px 0 12px">Variação da última sessão em relação à primeira.${skipped ? ` ${skipped} sessão(ões) sem carga anotada ficaram fora dos gráficos de carga.` : ''}</p>
    ${charts}
    <div class="card">
      <h3>Registros</h3>
      <div class="table-wrap"><table><thead><tr><th>Data</th><th class="num">Registro</th>${cfg.tableExtra ? `<th class="num">${cfg.tableExtra.label}</th>` : ''}</tr></thead><tbody>
        ${all.slice().reverse().map((r) => `<tr><td>${fmtDate(r.date)}</td><td class="num">${esc(r.detail)}</td>${cfg.tableExtra ? `<td class="num">${r[cfg.tableExtra.key] != null ? fmtNum(r[cfg.tableExtra.key], 1) : '–'}</td>` : ''}</tr>`).join('')}
      </tbody></table></div>
    </div>`;
}

function evoConfig(ex, all) {
  if (ex.type === 'weight') {
    const rows = all.filter((r) => !r.noLoad);
    return {
      rows: rows.length ? rows : all,
      tiles: [
        { key: 'avgKg', label: 'Carga média', unit: 'kg', digits: 1 },
        { key: 'volume', label: 'Volume', unit: 'kg', digits: 0 },
        { key: 'e1rm', label: 'Força estimada', unit: 'kg', digits: 1 },
      ],
      charts: [
        {
          title: 'Carga por treino (kg)', kind: 'line',
          note: 'Média: peso médio de todas as repetições do dia. Máxima: a maior carga usada.',
          series: [{ name: 'Média', key: 'avgKg', color: 1 }, { name: 'Máxima', key: 'maxKg', color: 2 }],
        },
        {
          title: 'Volume por treino (kg × reps)', kind: 'bar', digits: 0,
          note: 'Soma de carga × repetições de todas as séries. Sobe quando você faz mais reps ou usa mais carga.',
          series: [{ name: 'Volume', key: 'volume', color: 1 }],
        },
        {
          title: 'Força estimada (kg)', kind: 'line',
          note: 'Quanto você levantaria em 1 repetição, estimado pela melhor série (fórmula de Epley). Serve para comparar dias com carga e reps diferentes. Não é para testar.',
          series: [{ name: 'Força estimada', key: 'e1rm', color: 1 }],
        },
      ],
      tableExtra: { label: 'Média kg', key: 'avgKg' },
    };
  }
  if (ex.type === 'reps' || ex.type === 'time') {
    const u = ex.type === 'reps' ? 'reps' : 's';
    return {
      rows: all,
      tiles: [
        { key: 'best', label: 'Melhor série', unit: u, digits: 0 },
        { key: 'total', label: 'Total do treino', unit: u, digits: 0 },
      ],
      charts: [
        { title: `Melhor série (${u})`, kind: 'line', digits: 0, series: [{ name: 'Melhor série', key: 'best', color: 1 }] },
        { title: `Total por treino (${u})`, kind: 'bar', digits: 0, series: [{ name: 'Total', key: 'total', color: 1 }] },
      ],
    };
  }
  return {
    rows: all,
    tiles: [
      { key: 'km', label: 'Distância', unit: 'km', digits: 2 },
      { key: 'speed', label: 'Velocidade média', unit: 'km/h', digits: 1 },
      { key: 'min', label: 'Tempo', unit: 'min', digits: 0 },
    ],
    charts: [
      { title: 'Distância (km)', kind: 'bar', digits: 2, series: [{ name: 'Distância', key: 'km', color: 1 }] },
      { title: 'Velocidade média (km/h)', kind: 'line', series: [{ name: 'Velocidade', key: 'speed', color: 1 }], note: 'Distância dividida pelo tempo.' },
    ],
  };
}

function viewData() {
  return `
    <div class="card stack">
      <p class="small">${mode === 'db'
        ? 'Os dados ficam salvos na sua conta do claude.ai e aparecem em qualquer aparelho onde você abrir esta página. Só você tem acesso. Exporte de vez em quando para ter uma cópia sua.'
        : 'Os dados ficam salvos só neste aparelho, neste navegador. Exporte de vez em quando para ter um backup.'}</p>
      <button class="btn" data-act="export">Exportar backup (.json)</button>
      <label class="btn secondary" style="text-align:center">Importar backup<input type="file" accept="application/json,.json" data-act="import" hidden></label>
      <p class="tiny">Importar substitui todos os dados atuais pelos do arquivo.</p>
    </div>
    <div class="card small muted">
      <h2>Como os pontos funcionam</h2>
      <p>Treino A, B ou C: ${POINTS.workout} · Treino D: ${POINTS.workoutHome} · Incompleto: proporcional (mín. ${POINTS.minIncomplete})<br>
      Recorde: +${POINTS.record} · Caminhada: ${POINTS.walk} · Pesagem da semana: ${POINTS.weighIn}<br>
      Novo nível a cada ${POINTS.perLevel} pontos. Nada tira pontos.</p>
    </div>`;
}

// ---------- Peso ----------
function viewWeight() {
  const wi = weightInfo(state.weights);
  const list = [...state.weights].sort((a, b) => (a.date < b.date ? 1 : -1));
  return `
    <h1>Peso</h1>
    <div class="card">
      <div class="row">
        <label class="field grow"><input id="w-kg" inputmode="decimal" placeholder="${wi ? fmtNum(wi.last.kg) : '92,0'}" aria-label="Peso em kg"><span>kg</span></label>
        <input id="w-date" type="date" class="input" style="width:auto" value="${todayStr()}" aria-label="Data">
      </div>
      <button class="btn" data-act="add-weight" style="margin-top:10px">Registrar</button>
      <p class="tiny" style="margin-top:6px">Uma pesagem por semana já vale ${POINTS.weighIn} pts. De manhã, em jejum, é o mais estável.</p>
    </div>
    ${wi ? `
    <div class="card">
      <div class="row between">
        <div><div class="tiny">Média das últimas 3</div><span class="mid-num">${fmtNum(wi.avg)}</span> kg</div>
        <div style="text-align:right"><div class="tiny">Desde o início</div><span class="mid-num">${wi.lostTotal > 0 ? '−' : ''}${fmtNum(Math.abs(wi.lostTotal))}</span> kg</div>
      </div>
      ${lineChart(wi.sorted.map((w) => ({ x: fmtDate(w.date), y: w.kg, tip: `${fmtDate(w.date)}: ${fmtNum(w.kg)} kg` })), wi.milestones.map((m) => ({ y: m.kg, label: `${m.label} ${fmtNum(m.kg)}` })))}
    </div>
    <div class="card">
      <h2>Marcos</h2>
      <div class="stack">
        ${wi.milestones.map((m) => {
          const total = wi.start - m.kg;
          const done = Math.max(0, wi.start - wi.avg);
          return `<div><div class="row between small"><span>${wi.avg <= m.kg ? '✓ ' : ''}${m.label}: ${fmtNum(m.kg)} kg</span><span class="muted">${fmtNum(Math.min(done, total))} / ${fmtNum(total)} kg</span></div>${bar(done, total)}</div>`;
        }).join('')}
      </div>
      <p class="tiny" style="margin-top:6px">Ritmo seguro: 0,5 a 0,75 kg por semana. Os marcos usam a média, então um dia ruim na balança não conta.</p>
    </div>
    <div class="card">
      <h2>Pesagens</h2>
      ${list.map((w) => `<div class="row between list-item"><span>${fmtDate(w.date)}</span><span><b>${fmtNum(w.kg)}</b> kg <button class="link" data-act="del-weight" data-date="${w.date}" style="color:var(--care);margin-left:10px">apagar</button></span></div>`).join('')}
    </div>` : ''}`;
}

// ---------- gráficos (linha ou barras, um eixo) ----------
function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || 1;
  const raw = span / (n - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const out = [];
  for (let v = start; v <= end + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

function chart({ labels, series, kind = 'line', refs = [], tips = [], digits = 1 }) {
  const W = 340, H = 196, L = 42, R = 14, T = 16, B = 26;
  const n = labels.length;
  const vals = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!vals.length) return '<p class="muted small" style="margin-top:10px">Sem dados para este gráfico.</p>';
  let lo = Math.min(...vals, ...refs.map((r) => r.y));
  let hi = Math.max(...vals, ...refs.map((r) => r.y));
  if (kind === 'bar') { lo = 0; hi *= 1.08; }
  if (lo === hi) { lo -= 1; hi += 1; }
  const ticks = niceTicks(lo, hi);
  lo = ticks[0]; hi = ticks.at(-1);
  if (kind === 'bar') lo = 0;
  const step = (W - L - R) / Math.max(1, kind === 'bar' ? n : n - 1);
  const x = (i) => (kind === 'bar' ? L + step * (i + 0.5) : n === 1 ? L + (W - L - R) / 2 : L + i * step);
  const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const labelEvery = Math.ceil(n / 6);
  const tstep = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
  const tdig = Number.isInteger(Math.round(tstep * 1e6) / 1e6) ? 0 : (Math.round(tstep * 10) === tstep * 10 ? 1 : 2);
  const fmtTick = (v) => fmtNum(v, tdig);

  const grid = ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmtTick(v)}</text>`).join('');
  const refSvg = refs.map((r) => `<line class="ref" x1="${L}" x2="${W - R}" y1="${y(r.y)}" y2="${y(r.y)}"/><text class="ref-label" x="${W - R}" y="${y(r.y) - 4}" text-anchor="end">${esc(r.label)}</text>`).join('');

  let marks = '';
  if (kind === 'bar') {
    const bw = Math.max(6, Math.min(26, step - 4));
    const base = y(0);
    marks = series[0].values.map((v, i) => {
      if (v == null || v <= 0) return '';
      const x0 = x(i) - bw / 2, top = y(v), r = Math.min(4, (base - top) / 2, bw / 2);
      return `<path class="barm s${series[0].color}" d="M${x0},${base} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + bw - r} Q${x0 + bw},${top} ${x0 + bw},${top + r} V${base} Z"/>`;
    }).join('');
    const li = series[0].values.length - 1;
    const lv = series[0].values[li];
    if (lv != null) marks += `<text class="dlabel" x="${x(li)}" y="${y(lv) - 6}" text-anchor="middle">${fmtNum(lv, digits)}</text>`;
  } else {
    const ends = [];
    for (const s of series) {
      const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)]));
      const segs = pts.filter(Boolean);
      if (segs.length > 1) marks += `<polyline class="line s${s.color}" points="${segs.map((p) => p.join(',')).join(' ')}"/>`;
      marks += segs.map((p) => `<circle class="pt s${s.color}" cx="${p[0]}" cy="${p[1]}" r="4"/>`).join('');
      const li = s.values.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0).at(-1);
      if (li != null) ends.push({ y: y(s.values[li]), x: x(li), text: fmtNum(s.values[li], digits) });
    }
    // rótulo do último valor de cada série, sem sobrepor
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    marks += ends.map((e) => `<text class="dlabel" x="${Math.min(e.x, W - R)}" y="${e.y - 8}" text-anchor="end">${e.text}</text>`).join('');
  }

  const xl = labels.map((lab, i) => (i % labelEvery === 0 || i === n - 1 ? `<text class="axis" x="${x(i)}" y="${H - 6}" text-anchor="middle">${lab}</text>` : '')).join('');
  const hw = Math.max(step, 24);
  const tipFor = (i) => {
    const vs = series.map((s) => (s.values[i] == null ? '' : `${series.length > 1 ? `${s.name} ` : ''}${fmtNum(s.values[i], digits)}`)).filter(Boolean).join(' · ');
    return `${tips[i] || labels[i]}${vs ? ` → ${vs}` : ''}`;
  };
  const hits = labels.map((_, i) => `<rect class="hit" data-act="tip" data-tip="${esc(tipFor(i))}" x="${x(i) - hw / 2}" y="0" width="${hw}" height="${H}"><title>${esc(tipFor(i))}</title></rect>`).join('');
  const legend = series.length > 1
    ? `<div class="legend">${series.map((s) => `<span><i class="sw s${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`
    : '';

  return `
    <div class="chart">
      ${legend}
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico">
        ${grid}${refSvg}${marks}${xl}${hits}
      </svg>
      <div class="chart-tip">${esc(tipFor(n - 1))}</div>
      <p class="tiny">Toque num ponto para ver o dia.</p>
    </div>`;
}

// compatível com o gráfico de peso
function lineChart(points, refs = []) {
  return chart({ labels: points.map((p) => p.x), tips: points.map((p) => p.tip.split(':')[0]), series: [{ name: 'Peso', values: points.map((p) => p.y), color: 1 }], refs, kind: 'line' });
}

// ---------- timer de descanso ----------
let timer = { end: 0, total: 0, exId: null, iv: null, hideAt: 0 };
let audioCtx = null;

function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.2, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.6);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.6);
  } catch (e) { /* sem som */ }
}

function startTimer(exId) {
  const ex = exDef(exId);
  const secs = state.rest[exId] ?? ex.rest;
  if (!secs) return;
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* ok */ }
  timer = { ...timer, end: Date.now() + secs * 1000, total: secs, exId, hideAt: 0, fired: false };
  $('#timer').hidden = false;
  $('#timer').classList.remove('end');
  clearInterval(timer.iv);
  timer.iv = setInterval(tick, 250);
  tick();
}

function tick() {
  const left = Math.max(0, Math.ceil((timer.end - Date.now()) / 1000));
  $('#timer-time').textContent = left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Pronto';
  $('#timer-fill').style.width = pct(timer.total - left, timer.total);
  if (!left && !timer.fired) {
    timer.fired = true;
    timer.hideAt = Date.now() + 15000;
    $('#timer').classList.add('end');
    beep();
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }
  if (timer.hideAt && Date.now() > timer.hideAt) stopTimer();
}

function stopTimer() {
  clearInterval(timer.iv);
  $('#timer').hidden = true;
}

function adjustTimer(d) {
  if (!timer.exId) return;
  timer.end += d * 1000;
  timer.total = Math.max(15, timer.total + d);
  const ex = exDef(timer.exId);
  ops.setRest({ ...state.rest, [timer.exId]: Math.max(15, (state.rest[timer.exId] ?? ex.rest) + d) });
  if (timer.fired && timer.end > Date.now()) { timer.fired = false; timer.hideAt = 0; $('#timer').classList.remove('end'); }
  if (tab === 'treino') render();
  tick();
}

// ---------- toast e modal ----------
let toastT = null;
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button data-act="toast-action">${esc(action.label)}</button>` : ''}`;
  el.hidden = false;
  el._action = action?.fn;
  clearTimeout(toastT);
  toastT = setTimeout(() => { el.hidden = true; }, 5000);
}

function showModal(html) {
  const m = $('#modal');
  m.innerHTML = `<div class="sheet">${html}</div>`;
  m.hidden = false;
}

// ---------- eventos ----------
document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) {
    tab = tabBtn.dataset.tab;
    render();
    window.scrollTo(0, 0);
    return;
  }
  if (e.target.id === 'modal') {
    if (askResolve) askResolve(false);
    else $('#modal').hidden = true;
    return;
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const d = state.draft;

  switch (act) {
    case 'walk': {
      const now = new Date();
      const stamp = `${todayStr(now)}T${now.toTimeString().slice(0, 5)}`;
      const walk = { id: uid(), at: stamp };
      ops.addWalk(walk);
      render();
      const wk = weekly(state);
      toast(`+${POINTS.walk} pts · caminhada ${wk.walks}/${wk.walkGoal}`, {
        label: 'Desfazer',
        fn: () => {
          ops.delWalk(walk.id);
          render();
        },
      });
      break;
    }
    case 'toast-action': {
      const t = $('#toast');
      t._action?.();
      t.hidden = true;
      break;
    }
    case 'go-train':
      tab = 'treino';
      render();
      window.scrollTo(0, 0);
      break;
    case 'start':
      startDraft(el.dataset.w);
      render();
      window.scrollTo(0, 0);
      break;
    case 'check': {
      const row = d.rows[el.dataset.ex];
      row.done = !row.done;
      save();
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
      if (row.done && !d.editingId && exDef(el.dataset.ex).type !== 'cardio') startTimer(el.dataset.ex);
      break;
    }
    case 'rest':
      startTimer(el.dataset.ex);
      break;
    case 'add-group': {
      const groups = d.rows[el.dataset.ex].groups;
      const prev = groups.at(-1) || {};
      groups.push({ sets: 1, reps: prev.reps ?? '', kg: prev.kg ?? '', secs: prev.secs ?? '' });
      if (num(prev.sets) > 1) prev.sets = num(prev.sets) - 1;
      save();
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
      break;
    }
    case 'del-group': {
      d.rows[el.dataset.ex].groups.splice(+el.dataset.i, 1);
      save();
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
      break;
    }
    case 'edit-session': {
      const go = () => editSession(el.dataset.id);
      const dr = state.draft;
      if (dr && dr.editingId === el.dataset.id) {
        tab = 'treino';
        render();
        window.scrollTo(0, 0);
        break;
      }
      const marked = dr ? Object.values(dr.rows || {}).filter((r) => r && r.done).length : 0;
      if (marked) {
        const what = dr.editingId ? `a edição do treino ${dr.workout} de ${fmtDate(dr.date)}` : `o treino ${dr.workout} de ${fmtDate(dr.date)}`;
        ask(`Você tem ${what} aberto, com ${marked} exercício${marked > 1 ? 's' : ''} marcado${marked > 1 ? 's' : ''}. Descartar para editar esta sessão?`, 'Descartar e editar').then((ok) => ok && go());
      } else go();
      break;
    }
    case 'finish':
      finishDraft();
      window.scrollTo(0, 0);
      break;
    case 'discard':
      ask(d.editingId ? 'Cancelar a edição? A sessão salva fica como estava.' : 'Descartar este treino? O que foi marcado será perdido.', d.editingId ? 'Cancelar edição' : 'Descartar').then((ok) => {
        if (!ok) return;
        state.draft = null;
        save();
        stopTimer();
        render();
      });
      break;
    case 'timer-adj':
      adjustTimer(+el.dataset.d);
      break;
    case 'timer-stop':
      stopTimer();
      break;
    case 'close-modal':
      $('#modal').hidden = true;
      break;
    case 'hist':
      histView = el.dataset.v;
      render();
      break;
    case 'cal-month': {
      const [yy, mm] = calMonth.split('-').map(Number);
      const d2 = new Date(yy, mm - 1 + Number(el.dataset.d), 1);
      calMonth = todayStr(d2).slice(0, 7);
      calSel = null;
      render();
      break;
    }
    case 'cal-day':
      calSel = calSel === el.dataset.date ? null : el.dataset.date;
      render();
      break;
    case 'tip': {
      const box = el.closest('.chart').querySelector('.chart-tip');
      box.textContent = el.dataset.tip;
      break;
    }
    case 'del-session':
      ask('Apagar esta sessão? Os pontos dela também saem.', 'Apagar').then((ok) => {
        if (!ok) return;
        ops.delSession(el.dataset.id);
        render();
      });
      break;
    case 'add-weight': {
      const kg = num($('#w-kg').value);
      const date = $('#w-date').value || todayStr();
      if (!kg || kg < 30 || kg > 300) { toast('Digite um peso válido em kg.'); break; }
      const isNewWeek = !state.weights.some((w) => weekOf(w.date) === weekOf(date));
      ops.setWeight({ date, kg });
      render();
      toast(isNewWeek ? `+${POINTS.weighIn} pts · pesagem registrada` : 'Pesagem registrada');
      break;
    }
    case 'del-weight':
      ask('Apagar esta pesagem?', 'Apagar').then((ok) => {
        if (!ok) return;
        ops.delWeight(el.dataset.date);
        render();
      });
      break;
    case 'go-weight':
      tab = 'peso';
      render();
      window.scrollTo(0, 0);
      setTimeout(() => $('#w-kg')?.focus(), 50);
      break;
    case 'ask-yes':
      askResolve?.(true);
      break;
    case 'ask-no':
      askResolve?.(false);
      break;
    case 'export': {
      const json = JSON.stringify(exportData(), null, 2);
      const filename = `treino-backup-${todayStr()}.json`;
      if (mode === 'db') {
        window.claude.use('downloads').then((dl) => {
          if (!dl) { toast('Download não disponível aqui.'); return; }
          return dl.save({ filename, data: json });
        }).catch((err) => { if (err?.code && err.code !== 'declined' && err.code !== 'cancelled') toast('Não foi possível baixar.'); });
        break;
      }
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      break;
    }
    default:
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.k && state.draft) {
    const row = state.draft.rows[el.dataset.ex];
    row.groups[+el.dataset.i][el.dataset.k] = el.value;
    if (el.dataset.k === 'sets') {
      const tot = el.closest('.card')?.querySelector('.groups + .tiny b');
      if (tot) tot.textContent = `${row.groups.reduce((t, g) => t + (num(g.sets) || 0), 0)} séries`;
    }
    save();
  } else if (el.dataset.draft === 'note' && state.draft) {
    state.draft.note = el.value;
    save();
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.draft && state.draft) {
    const k = el.dataset.draft;
    state.draft[k] = el.type === 'checkbox' ? el.checked : el.value;
    save();
  } else if (el.dataset.act === 'chart-ex') {
    chartEx = el.value;
    render();
  } else if (el.dataset.act === 'import' && el.files[0]) {
    el.files[0].text().then((txt) => {
      let data;
      try {
        data = parseBackup(JSON.parse(txt));
      } catch (err) {
        toast('Arquivo inválido.');
        return;
      }
      el.value = '';
      ask(`Substituir os dados atuais por este backup (${data.sessions.length} treinos, ${data.weights.length} pesagens)?`, 'Substituir').then(async (ok) => {
        if (!ok) return;
        toast('Importando…');
        try {
          await ops.replaceAll(data);
          toast('Backup importado.');
        } catch (err) {
          toast(`Falhou no meio da importação (${err?.code || 'erro'}). Tente de novo.`);
        }
        render();
      });
    });
  }
});

// ---------- início ----------
loadDraft();
initDb().then((ok) => {
  if (!ok) {
    mode = 'local';
    loadLocal();
    loadState = 'ready';
  }
  render();
});
render();

if (!window.SINGLE_FILE && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
