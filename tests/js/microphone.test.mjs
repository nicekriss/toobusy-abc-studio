import test from 'node:test';
import assert from 'node:assert/strict';
import { S, mkVoice, toABC, parseABC } from '../../js/abc_studio/score.js';
import { pitchTrack, trackToNotes } from '../../js/abc_studio/pitch.js';
import { microphoneTarget, planMicrophoneTake, prepareMicrophoneTake, applyMicrophoneTake } from '../../js/abc_studio/microphone.js';

function reset(ids = ['Vocal', 'Ins']) {
  S.meta = {X:'1', T:'recording', M:[4,4], L:[1,16], Q:{unit:[1,4],bpm:120}, extra:[], K:'C'};
  S.voices = ids.map(mkVoice); S.chords = []; S.active = 0; S.playhead = 96; S.sel = new Set();
}
const notes = [{s:0, d:24, p:61}, {s:36, d:24, p:60}];

test('explicit roles route a complete take, independent of current tab and subsequent playhead', () => {
  for (const role of ['instrument', 'vocal']) {
    reset();
    const plan = planMicrophoneTake(S, role);
    S.active = role === 'instrument' ? 0 : 1; S.playhead = 999;
    const take = prepareMicrophoneTake(S, plan, notes);
    applyMicrophoneTake(S, take);
    const id = role === 'instrument' ? 'Ins' : 'Vocal';
    assert.equal(S.voices[S.active].id, id);
    assert.deepEqual(S.voices.find(v => v.id === id).notes, [{s:96,d:24,p:61},{s:132,d:24,p:60}]);
    assert.equal(S.voices.find(v => v.id !== id).notes.length, 0);
    const parsed = parseABC(toABC());
    assert.deepEqual(parsed.voices.find(v => v.id === id).notes.map(n => n.p), [61,60]);
  }
});

test('missing part is created on successful insertion only and reused after ABC roundtrip', () => {
  reset(['Custom']);
  S.voices[0].notes.push({s:0,d:48,p:55});
  const before = toABC();
  const plan = planMicrophoneTake(S, 'vocal');
  assert.equal(prepareMicrophoneTake(S, plan, []), null);
  const take = prepareMicrophoneTake(S, plan, notes);
  assert.equal(toABC(), before, 'opening, silence and preparation must not alter the score');
  applyMicrophoneTake(S, take);
  assert.equal(S.voices[0].notes[0].p, 55);
  assert.equal(S.voices[1].id, 'Vocal');
  assert.equal(S.voices[1].name, 'Vocal Melody');
  S.voices = parseABC(toABC()).voices;
  applyMicrophoneTake(S, prepareMicrophoneTake(S, planMicrophoneTake(S, 'vocal'), notes));
  assert.equal(S.voices.length, 2);
  assert.equal(S.voices[1].notes.length, 4);
});

test('reordered voices keep identity; replaced score, removed target and changed timing are rejected', () => {
  reset();
  let plan = planMicrophoneTake(S, 'instrument');
  S.voices.reverse();
  assert.equal(prepareMicrophoneTake(S, plan, notes).voice.id, 'Ins');
  S.voices = S.voices.slice();
  assert.throws(() => prepareMicrophoneTake(S, plan, notes), /악보/);
  plan = planMicrophoneTake(S, 'vocal');
  S.voices.splice(S.voices.indexOf(plan.target), 1);
  assert.throws(() => prepareMicrophoneTake(S, plan, notes), /악보/);
  plan = planMicrophoneTake(S, 'instrument');
  S.meta.Q.bpm = 91;
  assert.throws(() => prepareMicrophoneTake(S, plan, notes), /박자/);
});

test('part matching uses explicit id or name, never voice order or substring', () => {
  reset(['Bass', 'Lead']);
  assert.equal(microphoneTarget(S.voices, 'instrument'), null);
  S.voices[0].name = 'Vocal backing';
  assert.equal(microphoneTarget(S.voices, 'vocal'), null);
  S.voices[1].name = 'Ins Melody';
  assert.equal(microphoneTarget(S.voices, 'instrument'), S.voices[1]);
  assert.throws(() => planMicrophoneTake(S, 'guess'));
});

test('a harmonic-rich signal goes to either selected role without timbre classification', () => {
  for (const role of ['instrument', 'vocal']) {
    reset([]);
    const pcm = Float32Array.from({length:16000}, (_, i) => {
      const x = 2 * Math.PI * 440 * i / 16000;
      return .15 * Math.sin(x) + .08 * Math.sin(2*x) + .04 * Math.sin(3*x);
    });
    const track = pitchTrack(pcm, 16000);
    const detected = trackToNotes(track.track, track.spf, {key:false,grid:false});
    assert.deepEqual(detected.map(n => n.p), [69]);
    applyMicrophoneTake(S, prepareMicrophoneTake(S, planMicrophoneTake(S, role), detected));
    assert.equal(S.voices[0].id, role === 'instrument' ? 'Ins' : 'Vocal');
    assert.deepEqual(parseABC(toABC()).voices[0].notes.map(n => n.p), [69]);
  }
});
