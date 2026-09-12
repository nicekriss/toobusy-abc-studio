import { mkVoice } from './score.js';

export const MIC_ROLES = {
  instrument: { id: 'Ins', name: 'Ins Melody', snm: 'Inst.', label: '인스 멜로디' },
  vocal: { id: 'Vocal', name: 'Vocal Melody', snm: 'Vocal', label: '보컬 멜로디' }
};
const normalized = value => String(value || '').trim().toLowerCase();

export function microphoneTarget(voices, role) {
  const spec = MIC_ROLES[role];
  if (!spec) throw new Error('녹음할 멜로디 종류를 선택하세요.');
  return voices.find(v => normalized(v.id) === normalized(spec.id))
    || voices.find(v => [spec.name, spec.label].some(name => normalized(v.name) === normalized(name)))
    || null;
}

// Keep the actual destination and score generation, not a mutable tab index.
export function planMicrophoneTake(state, role) {
  return {
    role, voices: state.voices, target: microphoneTarget(state.voices, role),
    base: Math.max(0, Math.round(state.playhead)),
    timing: JSON.stringify([state.meta, state.snap])
  };
}

export function validateMicrophoneTake(state, plan) {
  if (state.voices !== plan.voices || (plan.target && !state.voices.includes(plan.target))
      || plan.timing !== JSON.stringify([state.meta, state.snap])) {
    throw new Error('녹음 중 악보나 박자 설정이 바뀌었어요. 원하는 악보에서 다시 녹음하세요.');
  }
}

// Preparation never changes the score; callers can take one undo snapshot before applying.
export function prepareMicrophoneTake(state, plan, notes) {
  validateMicrophoneTake(state, plan);
  if (!notes.length) return null;
  let voice = plan.target || microphoneTarget(state.voices, plan.role);
  const isNew = !voice;
  if (isNew) {
    const spec = MIC_ROLES[plan.role];
    let id = spec.id, suffix = 2;
    while (state.voices.some(v => normalized(v.id) === normalized(id))) id = `${spec.id}_${suffix++}`;
    voice = { ...mkVoice(id, state.voices.length), name: spec.name, snm: spec.snm, clef: 'treble' };
  }
  return { voice, isNew, notes: notes.map(n => ({ s: plan.base + n.s, d: n.d, p: n.p })) };
}

export function applyMicrophoneTake(state, take) {
  if (take.isNew) state.voices.push(take.voice);
  take.voice.notes.push(...take.notes);
  take.voice.notes.sort((a, b) => a.s - b.s);
  take.voice.visible = true;
  state.active = state.voices.indexOf(take.voice);
  state.sel.clear();
  for (const note of take.notes) state.sel.add(note);
}
