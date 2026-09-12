import assert from 'node:assert/strict';
import { S, mkVoice, toABC, parseABC } from '../../js/abc_studio/score.js';
import { pitchTrack, trackToNotes } from '../../js/abc_studio/pitch.js';
import { sampleNotes, encodeWav } from '../../js/abc_studio/sample-data.js';

function roundtrip(pitches, key='C', spacing=48){
  S.meta={X:'1',T:'test',M:[4,4],L:[1,16],Q:{unit:[1,4],bpm:120},extra:[],K:key};
  S.voices=[mkVoice('1',0)]; S.chords=[];
  S.voices[0].notes=pitches.map((p,i)=>({s:i*spacing,d:spacing,p}));
  const text=toABC();
  assert.deepEqual(parseABC(text).voices[0].notes.map(n=>n.p),pitches,text);
}
roundtrip([61,60,61,60]);
roundtrip([63,62,66,65,68,67,70,69]);
roundtrip([66,65,66,65],'G');
roundtrip([70,71,70,71],'F');
roundtrip([61,73,60,72]);
roundtrip([61,61,60,60,60], 'C');
for(const key of ['C','Am','G','F','Bb','F#','Cb'])
  roundtrip(Array.from({length:24},(_,i)=>48+i),key);

S.meta.K='C';
S.voices[0].notes=[61,60,66,65,69,69,70,69].map((p,i)=>({p,s:29+48*i,d:35}));
assert.deepEqual(parseABC(toABC()).voices[0].notes.map(({s,d,p})=>({s,d,p})),
  S.voices[0].notes.map(({s,d,p})=>({s,d,p})), 'fractional lengths and ties must preserve the take');

for(let p=60;p<72;p++){
  const hz=440*2**((p-69)/12);
  const pcm=Float32Array.from({length:8000},(_,i)=>.2*Math.sin(2*Math.PI*hz*i/16000));
  const t=pitchTrack(pcm,16000);
  assert.deepEqual(trackToNotes(t.track,t.spf,{key:false,grid:false}).map(n=>n.p),[p]);
}
const repeated=trackToNotes([...Array(30).fill(69),...Array(4).fill(null),...Array(30).fill(69)],.01,{key:false,grid:false});
assert.equal(repeated.length,2,'a real rest must separate repeated pitches');
const take={beatOffset:.13,notes:[{pitch:61,start:.13,duration:.24},{pitch:60,start:.63,duration:.24}]};
for(const bpm of [91,120,173]) assert.deepEqual(sampleNotes(take,bpm,false),take.notes);
assert.equal(sampleNotes(take,120,true)[0].start,.13,'quantization must respect detected beat phase');
assert.throws(()=>sampleNotes(take,NaN));
const wav=await encodeWav({numberOfChannels:2,length:2,sampleRate:44100,
  getChannelData:c=>new Float32Array(c?[1,-1]:[0,.5])}).arrayBuffer();
const v=new DataView(wav);
assert.equal(v.getUint16(22,true),2); assert.equal(v.getUint32(24,true),44100);
assert.equal(v.getInt16(46,true),32767); assert.equal(v.getInt16(50,true),-32768);
console.log('PASS: accidentals, key signatures, pitch fidelity, repeated notes, timing, beat phase, stereo WAV');
