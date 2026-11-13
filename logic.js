// Regras do jogo: pontos, recordes, sequência, metas e sugestões.
// Tudo aqui é calculado a partir dos dados salvos; nada de pontuação fica gravado.

import {
  WORKOUTS, GOALS, POINTS, TARGET_WEIGHT, WEEK_GOAL,
  WALK_GOAL_START, WALK_GOAL_STEP, WALK_GOAL_MAX, SHIELD_EVERY,
} from './data.js';

// ---------- datas ----------
export function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDate(s) {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Segunda-feira da semana da data (yyyy-mm-dd).
export function weekOf(s) {
  const d = parseDate(s);
  const dow = (d.getDay() + 6) % 7; // 0 = segunda
  d.setDate(d.getDate() - dow);
  return todayStr(d);
}

function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return todayStr(d);
}

export function fmtDate(s) {
  const [, m, d] = s.split('-');
  return `${d}/${m}`;
}

export function fmtNum(n, digits = 1) {
  if (n == null || Number.isNaN(n)) return '–';
  const v = Math.round(n * 10 ** digits) / 10 ** digits;
  return String(v).replace('.', ',');
}

// ---------- exercícios ----------
const EX_INDEX = {};
for (const [wk, def] of Object.entries(WORKOUTS)) {
  for (const ex of def.exercises) EX_INDEX[ex.id] = { ...ex, workout: wk };
}
export const exDef = (id) => EX_INDEX[id];

export function sortSessions(sessions) {
  return [...sessions].sort((a, b) => (a.date === b.date ? (a.created || 0) - (b.created || 0) : a.date < b.date ? -1 : 1));
}

// Último registro de um exercício antes de uma data (exclusivo) ou no geral.
export function lastEntry(sessions, exId, beforeDate) {
  const sorted = sortSessions(sessions);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i];
    if (beforeDate && s.date > beforeDate) continue;
    const e = s.entries[exId];
    if (e && e.length) return { session: s, sets: e };
  }
  return null;
}

export function fmtSets(ex, sets) {
  if (!sets || !sets.length) return '–';
  if (ex.type === 'cardio') {
    const s = sets[0];
    const parts = [];
    if (s.min) parts.push(`${fmtNum(s.min)} min`);
    if (s.km) parts.push(`${fmtNum(s.km, 2)} km`);
    if (s.note) parts.push(s.note);
    return parts.join(', ') || '–';
  }
  if (ex.type === 'time') return sets.map((s) => `${s.secs}s`).join(', ');
  if (ex.type === 'reps') return sets.map((s) => s.reps).join(', ') + ' reps';
  // weight: agrupa por carga mantendo a ordem
  const groups = [];
  for (const s of sets) {
    const g = groups[groups.length - 1];
    if (g && g.kg === s.kg) g.reps.push(s.reps);
    else groups.push({ kg: s.kg, reps: [s.reps] });
  }
  return groups.map((g) => (g.kg ? `${fmtNum(g.kg)} kg × ${g.reps.join(', ')}` : `${g.reps.join(', ')} reps`)).join(' + ');
}

// ---------- métrica por exercício (usada em recordes e gráficos) ----------
// Retorna { key: [a, b], value, label } — key compara em ordem lexicográfica.
export function metric(ex, sets) {
  if (!sets || !sets.length) return null;
  if (ex.type === 'weight') {
    const maxKg = Math.max(...sets.map((s) => s.kg || 0));
    const reps = sets.filter((s) => (s.kg || 0) === maxKg).reduce((a, s) => a + (s.reps || 0), 0);
    if (!maxKg) return { key: [0, reps], value: reps, label: `${reps} reps`, detail: `${reps} reps sem carga anotada` };
    return { key: [maxKg, reps], value: maxKg, label: `${fmtNum(maxKg)} kg`, detail: `${reps} reps com ${fmtNum(maxKg)} kg` };
  }
  if (ex.type === 'reps') {
    const total = sets.reduce((a, s) => a + (s.reps || 0), 0);
    const best = Math.max(...sets.map((s) => s.reps || 0));
    return { key: [best, total], value: best, label: `${best} reps`, detail: `${total} reps no total` };
  }
  if (ex.type === 'time') {
    const best = Math.max(...sets.map((s) => s.secs || 0));
    const total = sets.reduce((a, s) => a + (s.secs || 0), 0);
    return { key: [best, total], value: best, label: `${best}s`, detail: `${total}s no total` };
  }
  const s = sets[0];
  if (s.km == null) return null;
  return { key: [s.km, 0], value: s.km, label: `${fmtNum(s.km, 2)} km`, detail: `${fmtNum(s.min)} min` };
}

const gt = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

// Recordes por sessão: a primeira vez num exercício não conta como recorde.
export function computeRecords(sessions) {
  const best = {};
  const bySession = new Map();
  for (const s of sortSessions(sessions)) {
    const recs = [];
    for (const [exId, sets] of Object.entries(s.entries)) {
      const ex = exDef(exId);
      if (!ex) continue;
      const m = metric(ex, sets);
      if (!m) continue;
      if (best[exId] && gt(m.key, best[exId])) recs.push({ exId, name: ex.name, label: m.label, detail: m.detail });
      if (!best[exId] || gt(m.key, best[exId])) best[exId] = m.key;
    }
    bySession.set(s.id, recs);
  }
  return bySession;
}

// ---------- pontos ----------
export function sessionBasePoints(s) {
  const def = WORKOUTS[s.workout];
  const required = def.exercises.filter((e) => !e.optional);
  const done = required.filter((e) => s.entries[e.id] && s.entries[e.id].length).length;
  const base = s.workout === 'D' ? POINTS.workoutHome : POINTS.workout;
  if (done >= required.length) return { points: base, done, total: required.length, complete: true };
  const pts = Math.min(base, Math.max(POINTS.minIncomplete, Math.round((base * done) / required.length)));
  return { points: done === 0 ? 0 : pts, done, total: required.length, complete: false };
}

export function weighInWeeks(weights) {
  return new Set(weights.map((w) => weekOf(w.date))).size;
}

export function totals(state) {
  const records = computeRecords(state.sessions);
  let sessionPts = 0;
  let recordCount = 0;
  for (const s of state.sessions) {
    sessionPts += sessionBasePoints(s).points;
    recordCount += (records.get(s.id) || []).length;
  }
  const walkPts = state.walks.length * POINTS.walk;
  const weighPts = weighInWeeks(state.weights) * POINTS.weighIn;
  const total = sessionPts + recordCount * POINTS.record + walkPts + weighPts;
  return {
    total,
    level: Math.floor(total / POINTS.perLevel) + 1,
    inLevel: total % POINTS.perLevel,
    perLevel: POINTS.perLevel,
    recordCount,
    records,
  };
}

// ---------- semanas, sequência e caminhadas ----------
function countBy(list, fn) {
  const m = new Map();
  for (const x of list) {
    const k = fn(x);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

export function weekly(state, today = todayStr()) {
  const thisWeek = weekOf(today);
  const sessionsPerWeek = countBy(state.sessions, (s) => weekOf(s.date));
  const walksPerWeek = countBy(state.walks, (w) => weekOf(w));

  const starts = [...state.sessions.map((s) => s.date), ...state.walks.map((w) => w.slice(0, 10))];
  const first = starts.length ? weekOf(starts.sort()[0]) : thisWeek;

  let streak = 0;
  let shields = 0;
  let completed = 0;
  let walkGoal = WALK_GOAL_START;
  let walkHits = 0;
  const history = [];

  for (let wk = first; wk < thisWeek; wk = addDays(wk, 7)) {
    const n = sessionsPerWeek.get(wk) || 0;
    let usedShield = false;
    if (n >= WEEK_GOAL) {
      streak++;
      completed++;
      if (completed % SHIELD_EVERY === 0) shields++;
    } else if (streak > 0 && shields > 0) {
      shields--;
      usedShield = true;
    } else {
      streak = 0;
    }
    const walks = walksPerWeek.get(wk) || 0;
    const hitWalk = walks >= walkGoal;
    history.push({ week: wk, sessions: n, walks, walkGoal, usedShield });
    if (hitWalk) {
      walkHits++;
      if (walkHits >= 2) {
        walkGoal = Math.min(WALK_GOAL_MAX, walkGoal + WALK_GOAL_STEP);
        walkHits = 0;
      }
    } else {
      walkHits = 0;
    }
  }

  const nowSessions = sessionsPerWeek.get(thisWeek) || 0;
  const thisDone = nowSessions >= WEEK_GOAL;
  return {
    thisWeek,
    sessions: nowSessions,
    weekGoal: WEEK_GOAL,
    streak: streak + (thisDone ? 1 : 0),
    shields: shields + (thisDone && (completed + 1) % SHIELD_EVERY === 0 ? 1 : 0),
    walks: walksPerWeek.get(thisWeek) || 0,
    walkGoal,
    walkHits,
    history,
  };
}

// ---------- peso ----------
export function weightInfo(weights) {
  const sorted = [...weights].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!sorted.length) return null;
  const start = sorted[0].kg;
  const last3 = sorted.slice(-3);
  const avg = last3.reduce((a, w) => a + w.kg, 0) / last3.length;
  const milestones = [
    { label: '−5%', kg: Math.round(start * 0.95 * 10) / 10 },
    { label: '−10%', kg: Math.round(start * 0.9 * 10) / 10 },
    { label: 'Meta', kg: TARGET_WEIGHT },
  ].filter((m) => m.kg >= TARGET_WEIGHT && m.kg < start);
  const next = milestones.find((m) => avg > m.kg) || null;
  const prevKg = next ? (milestones[milestones.indexOf(next) - 1]?.kg ?? start) : start;
  return {
    start,
    avg,
    last: sorted[sorted.length - 1],
    sorted,
    milestones,
    next,
    fromKg: prevKg,
    progress: next ? Math.max(0, Math.min(1, (prevKg - avg) / (prevKg - next.kg))) : 1,
    lostTotal: start - avg,
  };
}

// ---------- metas fixas ----------
export function goalsProgress(sessions) {
  return GOALS.map((g) => {
    if (g.kind === 'time') {
      let best = 0;
      for (const s of sessions) for (const x of s.entries[g.ex] || []) best = Math.max(best, x.secs || 0);
      return { ...g, value: best, max: g.secs, text: `${best}s / ${g.secs}s`, done: best >= g.secs };
    }
    const le = lastEntry(sessions, g.ex);
    const max = g.sets * g.reps;
    let value = 0;
    if (le) {
      const reps = le.sets.filter((x) => (x.kg || 0) >= g.kg).map((x) => x.reps || 0).sort((a, b) => b - a).slice(0, g.sets);
      value = reps.reduce((a, r) => a + Math.min(r, g.reps), 0);
    }
    return { ...g, value, max, text: `${value} / ${max} reps`, done: value >= max };
  });
}

// ---------- sugestão de progressão ----------
// Retorna { kind: 'up' | 'reps' | 'keep' | 'care', text }
export function suggestion(ex, last, lastHadPain) {
  if (!last || ex.type === 'cardio') return null;
  const sets = last.sets;
  if (lastHadPain) return { kind: 'care', text: 'Manter: teve dor na última. Se voltar, reduza a amplitude ou troque.' };

  if (ex.type === 'weight') {
    const maxKg = Math.max(...sets.map((s) => s.kg || 0));
    if (!maxKg) return { kind: 'keep', text: 'Anote a carga usada para o app acompanhar a evolução' };
    const top = sets.filter((s) => (s.kg || 0) === maxKg);
    if (top.length < ex.sets) return { kind: 'keep', text: `Manter ${fmtNum(maxKg)} kg e completar as ${ex.sets} séries` };
    const minReps = Math.min(...top.slice(0, ex.sets).map((s) => s.reps || 0));
    const bigStep = ex.repsFirst || (ex.step && maxKg > 0 && ex.step / maxKg > 0.3 ? ex.hi + 5 : null);
    if (minReps < ex.hi) return { kind: 'keep', text: `Manter ${fmtNum(maxKg)} kg, buscar ${ex.hi} reps em todas` };
    if (bigStep && minReps < bigStep) {
      return { kind: 'reps', text: `Degrau grande (+${fmtNum(ex.step)} kg): subir reps até ${bigStep} ou descer mais devagar` };
    }
    const next = ex.step ? maxKg + ex.step : Math.round(maxKg * 1.075 * 2) / 2;
    return { kind: 'up', text: `Subir para ${fmtNum(next)} kg e voltar a ${ex.lo} reps (se a última série não foi até a falha)` };
  }

  if (ex.type === 'reps') {
    const minReps = Math.min(...sets.map((s) => s.reps || 0));
    if (sets.length < ex.sets) return { kind: 'keep', text: `Completar as ${ex.sets} séries` };
    if (minReps >= ex.hi) return { kind: 'up', text: `Tentar ${minReps + 2} reps` };
    return { kind: 'keep', text: `Buscar ${ex.hi} reps em todas` };
  }

  // time
  const minSecs = Math.min(...sets.map((s) => s.secs || 0));
  if (sets.length < ex.sets) return { kind: 'keep', text: `Completar as ${ex.sets} séries` };
  if (minSecs >= ex.hi) return { kind: 'up', text: `Tentar ${minSecs + 5}s` };
  return { kind: 'keep', text: `Buscar ${ex.hi}s em todas` };
}

// Próximo treino da rotação A → B → C.
export function nextWorkout(sessions) {
  const order = ['A', 'B', 'C'];
  const sorted = sortSessions(sessions).filter((s) => order.includes(s.workout));
  if (!sorted.length) return 'A';
  const last = sorted[sorted.length - 1].workout;
  return order[(order.indexOf(last) + 1) % order.length];
}

// Série histórica de um exercício para o gráfico.
export function exerciseSeries(sessions, exId) {
  const ex = exDef(exId);
  const out = [];
  for (const s of sortSessions(sessions)) {
    const sets = s.entries[exId];
    const m = sets && metric(ex, sets);
    if (m) out.push({ date: s.date, value: m.value, label: m.label, detail: fmtSets(ex, sets) });
  }
  return out;
}

// Estatísticas por sessão de um exercício, para os gráficos de evolução.
//   weight: carga média (ponderada pelas reps), carga máxima, volume (kg × reps),
//           força estimada (1RM pela fórmula de Epley, melhor série)
//   reps/time: melhor série e total
//   cardio: distância, minutos e velocidade média
export function exerciseStats(sessions, exId) {
  const ex = exDef(exId);
  const out = [];
  for (const s of sortSessions(sessions)) {
    const sets = s.entries[exId];
    if (!sets || !sets.length) continue;
    const row = { date: s.date, detail: fmtSets(ex, sets), pain: !!s.pain };
    if (ex.type === 'weight') {
      const reps = sets.reduce((a, x) => a + (x.reps || 0), 0);
      const vol = sets.reduce((a, x) => a + (x.kg || 0) * (x.reps || 0), 0);
      row.maxKg = Math.max(...sets.map((x) => x.kg || 0));
      if (!row.maxKg) { row.noLoad = true; row.reps = reps; out.push(row); continue; }
      row.avgKg = reps ? vol / reps : 0;
      row.volume = vol;
      row.reps = reps;
      row.e1rm = Math.max(...sets.map((x) => (x.kg || 0) * (1 + (x.reps || 0) / 30)));
    } else if (ex.type === 'reps') {
      row.best = Math.max(...sets.map((x) => x.reps || 0));
      row.total = sets.reduce((a, x) => a + (x.reps || 0), 0);
    } else if (ex.type === 'time') {
      row.best = Math.max(...sets.map((x) => x.secs || 0));
      row.total = sets.reduce((a, x) => a + (x.secs || 0), 0);
    } else {
      const c = sets[0];
      row.km = c.km ?? null;
      row.min = c.min ?? null;
      row.speed = c.km && c.min ? c.km / (c.min / 60) : null;
    }
    out.push(row);
  }
  return out;
}
