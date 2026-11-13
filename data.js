// Definição dos treinos, metas e histórico inicial.
// Tipos de exercício:
//   weight  -> séries com kg + reps
//   reps    -> séries só com reps (peso corporal)
//   time    -> séries em segundos
//   cardio  -> minutos + km (uma linha só)

export const WORKOUTS = {
  A: {
    name: 'Superior + esteira',
    place: 'Academia',
    exercises: [
      { id: 'esteira', name: 'Esteira', type: 'cardio', target: '20-30 min, ritmo moderado' },
      { id: 'supino', name: 'Supino reto', type: 'weight', sets: 3, lo: 12, hi: 15, rest: 90, step: 2 },
      { id: 'puxada', name: 'Puxada frontal', type: 'weight', sets: 3, lo: 12, hi: 15, rest: 90, step: 7 },
      { id: 'desenv', name: 'Desenvolvimento de ombros (máquina)', type: 'weight', sets: 3, lo: 12, hi: 12, rest: 60, step: 2 },
      { id: 'rosca', name: 'Rosca direta', type: 'weight', sets: 3, lo: 12, hi: 12, rest: 60, step: 1 },
      { id: 'triceps_polia', name: 'Tríceps na polia', type: 'weight', sets: 3, lo: 12, hi: 12, rest: 60, step: 2 },
      { id: 'prancha', name: 'Prancha', type: 'time', sets: 3, lo: 30, hi: 30, rest: 45 },
    ],
  },
  B: {
    name: 'Inferior adaptado',
    place: 'Academia',
    exercises: [
      { id: 'bicicleta', name: 'Bicicleta reclinada', type: 'cardio', target: '10-15 min' },
      { id: 'legpress', name: 'Leg press', type: 'weight', sets: 4, lo: 15, hi: 15, rest: 90, step: 9, repsFirst: 20 },
      { id: 'extensora', name: 'Cadeira extensora', type: 'weight', sets: 3, lo: 15, hi: 15, rest: 60, step: 7 },
      { id: 'flexora', name: 'Cadeira flexora', type: 'weight', sets: 3, lo: 15, hi: 15, rest: 60, step: 7 },
      { id: 'abducao', name: 'Abdução de quadril', type: 'weight', sets: 3, lo: 20, hi: 20, rest: 60, step: 7 },
      { id: 'panturrilha', name: 'Panturrilha em pé', type: 'reps', sets: 3, lo: 20, hi: 35, rest: 45 },
      { id: 'prancha_lateral', name: 'Prancha lateral (cada lado)', type: 'time', sets: 3, lo: 20, hi: 25, rest: 45 },
      { id: 'ponte_b', name: 'Ponte de glúteo', type: 'reps', sets: 3, lo: 15, hi: 15, rest: 45, optional: true },
    ],
  },
  C: {
    name: 'Superior completo + elíptico',
    place: 'Academia',
    exercises: [
      { id: 'eliptico', name: 'Elíptico', type: 'cardio', target: '15 min' },
      { id: 'remada', name: 'Remada sentada (máquina)', type: 'weight', sets: 3, lo: 12, hi: 15, rest: 90, step: 7 },
      { id: 'crossover', name: 'Cross over (polia alta)', type: 'weight', sets: 3, lo: 12, hi: 12, rest: 60, step: 1 },
      { id: 'elev_lateral', name: 'Elevação lateral', type: 'weight', sets: 3, lo: 12, hi: 12, rest: 60, step: 1 },
      { id: 'puxada_fechada', name: 'Puxada fechada (triângulo)', type: 'weight', sets: 3, lo: 12, hi: 12, rest: 90, step: 7 },
      { id: 'rosca_martelo', name: 'Rosca martelo', type: 'weight', sets: 3, lo: 12, hi: 15, rest: 60, step: 1 },
      { id: 'triceps_testa', name: 'Tríceps testa', type: 'weight', sets: 3, lo: 12, hi: 15, rest: 60, step: 1 },
      { id: 'core_c', name: 'Pallof press (polia)', type: 'weight', sets: 3, lo: 10, hi: 12, rest: 45, step: 1 },
    ],
  },
  D: {
    name: 'Pernas em casa',
    place: 'Casa',
    exercises: [
      { id: 'aquecimento', name: 'Aquecimento', type: 'cardio', target: '5 min' },
      { id: 'agach_livre', name: 'Agachamento livre (cadeira atrás)', type: 'reps', sets: 3, lo: 15, hi: 15, rest: 60 },
      { id: 'afundo', name: 'Afundo reverso (cada perna)', type: 'reps', sets: 3, lo: 10, hi: 10, rest: 60 },
      { id: 'ponte_d', name: 'Ponte de glúteo', type: 'reps', sets: 3, lo: 15, hi: 15, rest: 45 },
      { id: 'sumo', name: 'Agachamento sumô', type: 'reps', sets: 3, lo: 15, hi: 15, rest: 60 },
      { id: 'parede', name: 'Cadeira na parede', type: 'time', sets: 3, lo: 30, hi: 45, rest: 60 },
      { id: 'pant_unilateral', name: 'Panturrilha unilateral (cada)', type: 'reps', sets: 3, lo: 15, hi: 15, rest: 45 },
      { id: 'bird_dog', name: 'Bird dog (cada lado)', type: 'reps', sets: 3, lo: 8, hi: 8, rest: 45 },
    ],
  },
};

// Metas fixas com barra de progresso.
// kind 'sets': melhor sessão com carga >= kg, soma de reps limitada a reps por série.
// kind 'time': melhor série em segundos.
export const GOALS = [
  { id: 'g_ext', label: 'Extensora 19 kg 3x15', ex: 'extensora', kind: 'sets', kg: 19, sets: 3, reps: 15 },
  { id: 'g_leg', label: 'Leg press 24 kg 4x20 (antes de subir pra 33)', ex: 'legpress', kind: 'sets', kg: 24, sets: 4, reps: 20 },
  { id: 'g_remada', label: 'Remada sentada 19 kg 3x15', ex: 'remada', kind: 'sets', kg: 19, sets: 3, reps: 15 },
  { id: 'g_prancha', label: 'Prancha de 60 segundos', ex: 'prancha', kind: 'time', secs: 60 },
];

export const TARGET_WEIGHT = 80;

export const POINTS = {
  workout: 100,
  workoutHome: 60,
  minIncomplete: 40,
  record: 25,
  walk: 10,
  weighIn: 20,
  perLevel: 500,
};

export const WEEK_GOAL = 3;
export const WALK_GOAL_START = 3;
export const WALK_GOAL_STEP = 2;
export const WALK_GOAL_MAX = 14;
export const SHIELD_EVERY = 4;
