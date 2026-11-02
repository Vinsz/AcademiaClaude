import { WORKOUTS, POINTS } from './data.js';
import {
  todayStr, weekOf, fmtDate, fmtNum, exDef, sortSessions, lastEntry, fmtSets,
  computeRecords, sessionBasePoints, totals, weekly, weightInfo, goalsProgress,
  suggestion, nextWorkout, exerciseSeries,
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
    if (d) state.draft = d;
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
  addSession(s) {
    state.sessions = [...state.sessions, s];
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
let histView = 'sessoes';
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
  const next = state.draft ? state.draft.workout : nextWorkout(state.sessions);
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

    <button class="btn" data-act="go-train" style="margin-bottom:12px">${state.draft ? 'Continuar' : 'Começar'} treino ${next}</button>

    ${wi ? `
    <div class="card">
      <h2>Peso</h2>
      <div class="row between">
        <div><span class="mid-num">${fmtNum(wi.avg)}</span> <span class="muted">kg</span></div>
        <div class="small muted">${wi.next ? `Próximo marco: <b>${fmtNum(wi.next.kg)} kg</b> (${wi.next.label})` : 'Meta atingida'}</div>
      </div>
      ${wi.next ? bar(wi.fromKg - wi.avg, wi.fromKg - wi.next.kg) : bar(1, 1)}
      <p class="tiny">${wi.next ? `${fmtNum(Math.max(0, wi.fromKg - wi.avg))} / ${fmtNum(wi.fromKg - wi.next.kg)} kg · ` : ''}média das últimas 3 pesagens</p>
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
  const sug = nextWorkout(state.sessions);
  return `
    <h1>Qual treino hoje?</h1>
    <div class="pick">
      ${Object.entries(WORKOUTS).map(([k, w]) => `
        <button data-act="start" data-w="${k}" class="${k === sug ? 'suggested' : ''}">
          <div class="letter">${k}</div>
          <div class="small">${esc(w.name)}</div>
          <div class="tiny">${w.place}${k === sug ? ' · próximo' : ''}${k === 'D' ? ` · ${POINTS.workoutHome} pts` : ''}</div>
        </button>`).join('')}
    </div>
    <p class="tiny" style="margin-top:12px">O D substitui o B quando você não vai à academia, ou entra como extra 48h depois do B.</p>`;
}

function defaultRows(ex) {
  const last = lastEntry(state.sessions, ex.id);
  if (ex.type === 'cardio') {
    const s = last?.sets[0];
    return [{ min: s?.min ?? '', km: '', done: false }];
  }
  if (last) return last.sets.map((s) => ({ kg: s.kg ?? '', reps: s.reps ?? '', secs: s.secs ?? '', done: false }));
  return Array.from({ length: ex.sets }, () => ({ kg: '', reps: ex.type === 'time' ? '' : ex.lo, secs: ex.type === 'time' ? ex.lo : '', done: false }));
}

function startDraft(w) {
  const rows = {};
  for (const ex of WORKOUTS[w].exercises) rows[ex.id] = defaultRows(ex);
  state.draft = { workout: w, date: todayStr(), rows, pain: false, heavy: false, note: '' };
  save();
}

// ---------- Treino: sessão em andamento ----------
function viewDraft() {
  const d = state.draft;
  const def = WORKOUTS[d.workout];
  return `
    <div class="row between">
      <h1 style="margin-bottom:4px">Treino ${d.workout}</h1>
      <input type="date" class="input" style="width:auto" value="${d.date}" data-draft="date" aria-label="Data do treino">
    </div>
    <p class="muted small" style="margin-bottom:14px">${esc(def.name)} · toque em ✓ ao terminar cada série</p>
    ${def.exercises.map((ex) => exCard(ex, d.rows[ex.id] || [])).join('')}
    <div class="card">
      <label class="toggle"><input type="checkbox" data-draft="pain" ${d.pain ? 'checked' : ''}> Dor na coluna</label>
      <label class="toggle"><input type="checkbox" data-draft="heavy" ${d.heavy ? 'checked' : ''}> Dia pesado</label>
      <textarea rows="2" placeholder="Observações" data-draft="note">${esc(d.note)}</textarea>
      <p class="tiny" style="margin-top:6px">Treino com dor vale os mesmos pontos. Na próxima vez, o app sugere manter a carga.</p>
    </div>
    <button class="btn" data-act="finish">Concluir treino</button>
    <button class="btn secondary" data-act="discard" style="margin-top:10px">Descartar</button>`;
}

function exCard(ex, rows) {
  const last = lastEntry(state.sessions, ex.id);
  const sug = suggestion(ex, last, last?.session.pain);
  const doneCount = rows.filter((r) => r.done).length;
  const rest = state.rest[ex.id] ?? ex.rest;
  const target = ex.type === 'cardio' ? ex.target
    : `${ex.sets} × ${ex.lo === ex.hi ? ex.lo : `${ex.lo}-${ex.hi}`}${ex.type === 'time' ? 's' : ''}${rest ? ` · descanso ${rest}s` : ''}`;

  const rowHtml = rows.map((r, i) => {
    const attrs = `data-ex="${ex.id}" data-i="${i}"`;
    const check = `<button class="check ${r.done ? 'on' : ''}" data-act="check" ${attrs} aria-label="Série ${i + 1} feita">✓</button>`;
    const field = (k, unit, mode = 'decimal') => `<label class="field"><input inputmode="${mode}" ${attrs} data-k="${k}" value="${esc(r[k])}" aria-label="${unit}"><span>${unit}</span></label>`;
    if (ex.type === 'weight') return `<div class="set ${r.done ? 'done' : ''}"><span class="n">${i + 1}</span>${field('kg', 'kg')}${field('reps', 'reps', 'numeric')}${check}</div>`;
    if (ex.type === 'cardio') return `<div class="set ${r.done ? 'done' : ''}"><span class="n"></span>${field('min', 'min')}${field('km', 'km')}${check}</div>`;
    if (ex.type === 'time') return `<div class="set one ${r.done ? 'done' : ''}"><span class="n">${i + 1}</span>${field('secs', 's', 'numeric')}${check}</div>`;
    return `<div class="set one ${r.done ? 'done' : ''}"><span class="n">${i + 1}</span>${field('reps', 'reps', 'numeric')}${check}</div>`;
  }).join('');

  return `
    <div class="card ${doneCount ? 'ex-done' : ''}">
      <div class="ex-head">
        <div class="grow">
          <h3>${esc(ex.name)}${ex.optional ? ' <span class="tiny">(opcional)</span>' : ''}</h3>
          <p class="tiny">${esc(target)}</p>
        </div>
        ${ex.type !== 'cardio' && rest ? `<button class="btn-small" data-act="rest" data-ex="${ex.id}">⏱ ${rest}s</button>` : ''}
      </div>
      <p class="small muted" style="margin-top:6px">Última: ${last ? `${fmtSets(ex, last.sets)} <span class="tiny">(${fmtDate(last.session.date)})</span>` : 'sem registro'}</p>
      ${sug ? `<span class="chip ${sug.kind}">${esc(sug.text)}</span>` : ''}
      <div class="sets">${rowHtml}</div>
      ${ex.type !== 'cardio' ? `
      <div class="row">
        <button class="link" data-act="add-set" data-ex="${ex.id}">+ série</button>
        ${rows.length > 1 ? `<button class="link" data-act="del-set" data-ex="${ex.id}">− série</button>` : ''}
      </div>` : ''}
    </div>`;
}

function finishDraft() {
  const d = state.draft;
  const entries = {};
  for (const ex of WORKOUTS[d.workout].exercises) {
    const rows = (d.rows[ex.id] || []).filter((r) => r.done);
    if (!rows.length) continue;
    if (ex.type === 'cardio') entries[ex.id] = rows.map((r) => ({ min: num(r.min), km: num(r.km) }));
    else if (ex.type === 'weight') entries[ex.id] = rows.map((r) => ({ kg: num(r.kg) ?? 0, reps: num(r.reps) ?? 0 }));
    else if (ex.type === 'time') entries[ex.id] = rows.map((r) => ({ secs: num(r.secs) ?? 0 }));
    else entries[ex.id] = rows.map((r) => ({ reps: num(r.reps) ?? 0 }));
  }
  if (!Object.keys(entries).length) {
    toast('Marque ✓ em pelo menos uma série.');
    return;
  }
  const before = totals(state);
  const beforeWeek = weekly(state);
  const session = { id: uid(), created: Date.now(), date: d.date, workout: d.workout, entries, pain: d.pain, heavy: d.heavy, note: d.note.trim() };
  ops.addSession(session);
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
      <button data-act="hist" data-v="sessoes" class="${histView === 'sessoes' ? 'on' : ''}">Sessões</button>
      <button data-act="hist" data-v="evolucao" class="${histView === 'evolucao' ? 'on' : ''}">Evolução</button>
      <button data-act="hist" data-v="dados" class="${histView === 'dados' ? 'on' : ''}">Dados</button>
    </div>`;
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
        <button class="link" data-act="del-session" data-id="${s.id}" style="color:var(--care);margin-top:6px">Apagar sessão</button>
      </details>`;
  }).join('') : '<p class="muted">Nenhum treino ainda.</p>');
}

function viewEvolution() {
  const series = exerciseSeries(state.sessions, chartEx);
  const ex = exDef(chartEx);
  const unit = { weight: 'carga máxima (kg)', reps: 'melhor série (reps)', time: 'melhor série (s)', cardio: 'distância (km)' }[ex.type];
  const opts = Object.entries(WORKOUTS).map(([k, w]) => `<optgroup label="Treino ${k}">${w.exercises.map((e) => `<option value="${e.id}" ${e.id === chartEx ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</optgroup>`).join('');
  return `
    <div class="card">
      <select class="input" data-act="chart-ex" aria-label="Exercício">${opts}</select>
      <h3 style="margin-top:14px">${esc(ex.name)}</h3>
      <p class="tiny">${unit}</p>
      ${series.length ? lineChart(series.map((p) => ({ x: fmtDate(p.date), y: p.value, tip: `${fmtDate(p.date)}: ${p.detail}` }))) : '<p class="muted small" style="margin-top:10px">Sem registros ainda.</p>'}
    </div>
    ${series.length ? `
    <div class="card">
      <table><thead><tr><th>Data</th><th class="num">Registro</th></tr></thead><tbody>
        ${series.slice().reverse().map((p) => `<tr><td>${fmtDate(p.date)}</td><td class="num">${esc(p.detail)}</td></tr>`).join('')}
      </tbody></table>
    </div>` : ''}`;
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

// ---------- gráfico de linha (uma série, com referências opcionais) ----------
function lineChart(points, refs = []) {
  const W = 340, H = 190, L = 40, R = 12, T = 12, B = 26;
  const ys = [...points.map((p) => p.y), ...refs.map((r) => r.y)];
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (lo === hi) { lo -= 1; hi += 1; }
  const padY = (hi - lo) * 0.1;
  lo -= padY; hi += padY;
  const x = (i) => (points.length === 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (points.length - 1));
  const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const ticks = [lo + padY, (lo + hi) / 2, hi - padY];
  const labelEvery = Math.ceil(points.length / 6);
  const step = points.length > 1 ? (W - L - R) / (points.length - 1) : W;

  return `
    <div class="chart">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico de evolução">
        ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmtNum(v)}</text>`).join('')}
        ${refs.map((r) => `<line class="ref" x1="${L}" x2="${W - R}" y1="${y(r.y)}" y2="${y(r.y)}"/><text class="ref-label" x="${W - R}" y="${y(r.y) - 4}" text-anchor="end">${esc(r.label)}</text>`).join('')}
        ${points.length > 1 ? `<polyline class="line" points="${points.map((p, i) => `${x(i)},${y(p.y)}`).join(' ')}"/>` : ''}
        ${points.map((p, i) => `<circle class="pt" cx="${x(i)}" cy="${y(p.y)}" r="5"/>`).join('')}
        ${points.map((p, i) => (i % labelEvery === 0 || i === points.length - 1 ? `<text class="axis" x="${x(i)}" y="${H - 6}" text-anchor="middle">${p.x}</text>` : '')).join('')}
        ${points.map((p, i) => `<rect class="hit" data-act="tip" data-tip="${esc(p.tip)}" x="${x(i) - Math.max(step, 24) / 2}" y="0" width="${Math.max(step, 24)}" height="${H}"><title>${esc(p.tip)}</title></rect>`).join('')}
      </svg>
      <div class="chart-tip">${esc(points.at(-1).tip)}</div>
    </div>`;
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
      if (!state.draft) startDraft(nextWorkout(state.sessions));
      render();
      window.scrollTo(0, 0);
      break;
    case 'start':
      startDraft(el.dataset.w);
      render();
      window.scrollTo(0, 0);
      break;
    case 'check': {
      const row = d.rows[el.dataset.ex][+el.dataset.i];
      row.done = !row.done;
      save();
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
      if (row.done && exDef(el.dataset.ex).type !== 'cardio') startTimer(el.dataset.ex);
      break;
    }
    case 'rest':
      startTimer(el.dataset.ex);
      break;
    case 'add-set': {
      const rows = d.rows[el.dataset.ex];
      const prev = rows.at(-1) || {};
      rows.push({ kg: prev.kg ?? '', reps: prev.reps ?? '', secs: prev.secs ?? '', done: false });
      save();
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
      break;
    }
    case 'del-set': {
      d.rows[el.dataset.ex].pop();
      save();
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
      break;
    }
    case 'finish':
      finishDraft();
      window.scrollTo(0, 0);
      break;
    case 'discard':
      ask('Descartar este treino? O que foi marcado será perdido.', 'Descartar').then((ok) => {
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
    state.draft.rows[el.dataset.ex][+el.dataset.i][el.dataset.k] = el.value;
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
