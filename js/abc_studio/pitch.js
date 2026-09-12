import { S, keyInfo, LETTERS, BASE, secPerTick, clamp, LOMIDI, HIMIDI } from "./score.js";
const snapT = t => S.snap > 1 ? Math.round(t / S.snap) * S.snap : Math.round(t);
function detectPitch(buf, sr, minHz, maxHz){
  const n = buf.length;
  let rms = 0;
  for(let i=0;i<n;i++) rms += buf[i]*buf[i];
  rms = Math.sqrt(rms/n);
  if(rms < 0.006) return null;
  const maxLag = Math.min(n-2, Math.floor(sr/minHz));
  const minLag = Math.max(2, Math.floor(sr/maxHz));
  if(maxLag <= minLag+2) return null;
  const span = n - maxLag;
  const cm = new Float32Array(maxLag+1);
  let running = 0;
  for(let lag=1; lag<=maxLag; lag++){
    let sum = 0;
    for(let i=0;i<span;i++){ const df = buf[i] - buf[i+lag]; sum += df*df; }
    running += sum;
    cm[lag] = sum * lag / (running || 1e-9);
  }
  const TH = 0.15;
  let best = -1;
  for(let lag=minLag+1; lag<maxLag; lag++){
    if(cm[lag] < TH){
      while(lag+1 < maxLag && cm[lag+1] < cm[lag]) lag++;
      best = lag; break;
    }
  }
  if(best < 0){
    let mn = Infinity;
    for(let lag=minLag+1; lag<maxLag; lag++) if(cm[lag] < mn){ mn = cm[lag]; best = lag; }
    if(best < 0 || mn > 0.45) return null;
  }
  const y1 = cm[best-1] || cm[best], y2 = cm[best], y3 = cm[best+1] || cm[best];
  const den = y1 - 2*y2 + y3;
  const shift = den !== 0 ? 0.5*(y1 - y3)/den : 0;
  const hz = sr / (best + clamp(shift, -1, 1));
  if(!isFinite(hz) || hz < minHz || hz > maxHz) return null;
  return {hz:hz, clarity:1 - y2};
}
async function renderMono16k(ab, from, dur){
  const len = Math.max(1600, Math.ceil(dur * 16000));
  const off = new OfflineAudioContext(1, len, 16000);
  const src = off.createBufferSource();
  src.buffer = ab; src.connect(off.destination);
  src.start(0, from, dur);
  const out = await off.startRendering();
  return out.getChannelData(0);
}
function pitchTrack(pcm, sr){
  const hop = Math.round(sr*0.01), win = 1024, out = [];
  for(let i=0; i+win<=pcm.length; i+=hop){
    const r = detectPitch(pcm.subarray(i, i+win), sr, 70, 1100);
    out.push(r && r.clarity > 0.5 ? 69 + 12*Math.log2(r.hz/440) : null);
  }
  return {track:out, spf:hop/sr};
}
function medianFilter(a, k){
  const out = new Array(a.length), h = k >> 1;
  for(let i=0;i<a.length;i++){
    if(a[i] == null){ out[i] = null; continue; }
    const w = [];
    for(let j=i-h;j<=i+h;j++) if(j>=0 && j<a.length && a[j] != null) w.push(a[j]);
    out[i] = w.length ? w.sort((x,y)=>x-y)[w.length >> 1] : null;
  }
  return out;
}
function scaleSet(){
  const ki = keyInfo(S.meta.K), set = new Set();
  for(const L of LETTERS) set.add(((BASE[L] + (ki.acc[L]||0)) % 12 + 12) % 12);
  return set;
}
function snapToScale(p, set){
  const pc = ((p % 12) + 12) % 12;
  if(set.has(pc)) return p;
  if(set.has((pc + 11) % 12)) return p - 1;
  if(set.has((pc + 1) % 12)) return p + 1;
  return p;
}
function trackToNotes(track, spf, opt){
  const med = medianFilter(track, 3);
  const segs = []; let cur = null;
  for(let i=0;i<med.length;i++){
    const p = med[i] == null ? null : Math.round(med[i]);
    if(p == null){ if(cur) segs.push(cur); cur = null; continue; }
    if(cur && cur.p === p) cur.end = i;
    else { if(cur) segs.push(cur); cur = {p:p, start:i, end:i}; }
  }
  if(cur) segs.push(cur);
  const minF = Math.max(3, Math.round(0.04 / spf));
  const kept = segs.filter(s => s.end - s.start + 1 >= minF);
  const merged = [];
  for(const s of kept){
    const last = merged[merged.length-1];
    if(last && last.p === s.p && s.start - last.end === 1) last.end = s.end;
    else merged.push({p:s.p, start:s.start, end:s.end});
  }
  const spt = secPerTick(), set = scaleSet(), minD = opt.grid ? Math.max(3, S.snap) : 1;
  const notes = [];
  for(const s of merged){
    let p = opt.key ? snapToScale(s.p, set) : s.p;
    let t0 = s.start * spf / spt, t1 = (s.end + 1) * spf / spt;
    if(opt.grid){ t0 = snapT(t0); t1 = snapT(t1); }
    notes.push({s:Math.max(0, Math.round(t0)), d:Math.max(minD, Math.round(t1 - t0)),
                p:clamp(p, LOMIDI, HIMIDI), sf:s.start, ef:s.end, raw:s.p});
  }
  notes.sort((a,b) => a.s - b.s);
  for(let i=0;i<notes.length-1;i++){
    if(notes[i].s + notes[i].d > notes[i+1].s) notes[i].d = notes[i+1].s - notes[i].s;
  }
  return notes.filter(n => n.d > 0);
}

export { detectPitch, renderMono16k, pitchTrack, medianFilter, scaleSet, snapToScale, trackToNotes };
