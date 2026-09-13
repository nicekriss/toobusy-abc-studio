import test from 'node:test';
import assert from 'node:assert/strict';
import { S, mkVoice, toABC, parseABC, scalePitchClasses } from '../../js/abc_studio/score.js';

const sorted = key => [...scalePitchClasses(key)].sort((a, b) => a - b);

test('a key names its own seven pitch classes', () => {
  assert.deepEqual(sorted('C'), [0, 2, 4, 5, 7, 9, 11]);
  assert.deepEqual(sorted('Am'), [0, 2, 4, 5, 7, 9, 11], 'relative minor shares the signature');
  assert.deepEqual(sorted('G'), [0, 2, 4, 6, 7, 9, 11], 'F sharpens');
  assert.deepEqual(sorted('F'), [0, 2, 4, 5, 7, 9, 10], 'B flattens');
  assert.deepEqual(sorted('Bb'), [0, 2, 3, 5, 7, 9, 10]);
  assert.deepEqual(sorted('F#'), [1, 3, 5, 6, 8, 10, 11]);
  assert.deepEqual(sorted('Ddor'), [0, 2, 4, 5, 7, 9, 11], 'modes keep their signature');
});

test('K:none leaves nothing out of key', () => {
  assert.equal(scalePitchClasses('none').size, 12);
  assert.equal(scalePitchClasses('HP').size, 12);
});

function score(pitches, key) {
  S.meta = { X: '1', T: 'key test', M: [4, 4], L: [1, 16], Q: { unit: [1, 4], bpm: 120 }, extra: [], K: key };
  S.voices = [mkVoice('1', 0)];
  S.chords = [];
  S.voices[0].notes = pitches.map((p, i) => ({ s: i * 48, d: 48, p }));
}

test('changing the key never moves a note', () => {
  // The picker only relabels. Whatever the signature, the exporter has to
  // spell the same sounding pitches, or a user would silently lose their tune.
  const pitches = [60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71];
  for (const key of ['C', 'Am', 'G', 'F', 'Bb', 'Eb', 'F#', 'C#m', 'Ebm', 'none']) {
    score(pitches, key);
    const text = toABC();
    assert.deepEqual(parseABC(text).voices[0].notes.map(n => n.p), pitches, key + '\n' + text);
  }
});

test('the exported header carries the chosen key', () => {
  for (const key of ['C', 'F#m', 'Bb', 'none']) {
    score([60, 62, 64], key);
    assert.match(toABC(), new RegExp('^K: ?' + key.replace('#', '\#') + '\s*$', 'm'), key);
  }
});

test('switching key on an existing score keeps every pitch', () => {
  const pitches = [59, 60, 61, 66, 68, 70];
  score(pitches, 'C');
  const before = parseABC(toABC()).voices[0].notes.map(n => n.p);
  S.meta.K = 'F#';
  const after = parseABC(toABC()).voices[0].notes.map(n => n.p);
  assert.deepEqual(after, before);
  assert.deepEqual(after, pitches);
});
