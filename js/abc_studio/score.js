const PPQ = 48, WHOLE = PPQ * 4;
const BASE = {C:0,D:2,E:4,F:5,G:7,A:9,B:11};
const LETTERS = ['C','D','E','F','G','A','B'];
const SHARP_ORDER = ['F','C','G','D','A','E','B'];
const FLAT_ORDER  = ['B','E','A','D','G','C','F'];
const FIFTH = {F:-1,C:0,G:1,D:2,A:3,E:4,B:5};
const MODE = {maj:0,ion:0,dor:-2,phr:-4,lyd:1,mix:-1,min:-3,aeo:-3,loc:-5,m:-3};
const VCOLORS = ['#4a7fc1','#c4677f','#5f9e6a','#8f7bbd','#b58a3e','#4a9b96'];
const DIMNOTE = '#ccd0d8';
const LOMIDI = 21, HIMIDI = 108, NROWS = HIMIDI - LOMIDI + 1;
const GL = 74, GR = 24, GC = 30, GT = GR + GC;
const GB = 62, SB = 13;
const BASE_PX = 1.6, BASE_ROW = 22;
const NOTE_KO = ['도','도♯','레','레♯','미','파','파♯','솔','솔♯','라','라♯','시'];
const BLACK = {1:1,3:1,6:1,8:1,10:1};

const clamp = (v,a,b)=> v<a?a:v>b?b:v;
function gcd(a,b){ a=Math.abs(a); b=Math.abs(b); while(b){ const t=a%b; a=b; b=t; } return a||1; }

const S = {
  meta:{X:'1',T:'',M:[4,4],L:[1,16],Q:{unit:[1,4],bpm:91},extra:[],K:'Amin'},
  voices:[], chords:[], active:0,
  tool:'draw', snap:12, newDur:12, zoom:1, px:BASE_PX, rowH:BASE_ROW,
  scrollX:0, scrollY:0, sel:new Set(), undo:[], playhead:0, playing:false
};
const barTicks  = ()=> Math.round(WHOLE * S.meta.M[0] / S.meta.M[1]);
const unitTicks = ()=> Math.round(WHOLE * S.meta.L[0] / S.meta.L[1]);
function secPerTick(){
  const q = S.meta.Q, unitT = WHOLE * q.unit[0] / q.unit[1];
  return (60 / q.bpm) / unitT;
}
function keyInfo(kstr){
  const acc = {C:0,D:0,E:0,F:0,G:0,A:0,B:0};
  const s = String(kstr||'C').trim();
  if(/^(none|hp|hp\b)/i.test(s)) return {acc,n:0};
  const m = /^([A-Ga-g])([#b♯♭]?)\s*([A-Za-z]*)/.exec(s);
  if(!m) return {acc,n:0};
  const L = m[1].toUpperCase();
  const a = (m[2]==='#'||m[2]==='♯') ? 1 : (m[2]==='b'||m[2]==='♭') ? -1 : 0;
  let mode = (m[3]||'').toLowerCase().slice(0,3);
  if(mode === '') mode = 'maj';
  const off = (mode in MODE) ? MODE[mode] : (mode[0] in MODE ? MODE[mode[0]] : 0);
  let n = clamp(FIFTH[L] + 7*a + off, -7, 7);
  if(n>0) for(let i=0;i<n;i++)  acc[SHARP_ORDER[i]] = 1;
  if(n<0) for(let i=0;i<-n;i++) acc[FLAT_ORDER[i]]  = -1;
  return {acc, n};
}
/* The seven pitch classes the key actually uses. The roll shades everything
   else, so a beginner can see which rows belong to the chosen key without
   reading a key signature. */
function scalePitchClasses(kstr){
  // K:none carries no key signature at all, so nothing is out of key there.
  if(/^(none|hp)/i.test(String(kstr||'').trim())) return new Set([0,1,2,3,4,5,6,7,8,9,10,11]);
  const acc = keyInfo(kstr).acc;
  const set = new Set();
  for(const L of LETTERS) set.add((((BASE[L] + acc[L]) % 12) + 12) % 12);
  return set;
}
function mkVoice(id, idx){
  return {id:id, name:id, snm:'', clef:'', notes:[], visible:true, color:VCOLORS[idx % VCOLORS.length]};
}

/* ===================== ABC 읽기 ===================== */
function parseABC(text){
  const warns = [];
  const lines = String(text).replace(/\r/g,'').split('\n');
  const meta = {X:'1',T:'',M:[4,4],L:null,Q:{unit:[1,4],bpm:120},extra:[],K:'C'};
  const voices = [], vmap = new Map(), chords = [];
  let inBody = false;

  function stripComment(s){
    let q = false;
    for(let i=0;i<s.length;i++){
      if(s[i]==='"') q = !q;
      else if(s[i]==='%' && !q) return s.slice(0,i);
    }
    return s;
  }
  function applyParams(v,p){
    const nm = /name\s*=\s*"([^"]*)"/.exec(p) || /nm\s*=\s*"([^"]*)"/.exec(p);
    const sn = /snm\s*=\s*"([^"]*)"/.exec(p) || /sname\s*=\s*"([^"]*)"/.exec(p);
    const cl = /clef\s*=\s*([^\s"]+)/.exec(p);
    if(nm) v.name = nm[1];
    if(sn) v.snm = sn[1];
    if(cl) v.clef = cl[1];
  }
  function ensureVoice(id, params){
    let v = vmap.get(id);
    if(!v){ v = mkVoice(id, voices.length); v._acc = {}; v.cursor = 0; v._last = null; v._tieFrom = null; voices.push(v); vmap.set(id,v); }
    if(params) applyParams(v, params);
    return v;
  }

  const body = [];
  for(const raw of lines){
    const line = stripComment(raw);
    if(!line.trim()) continue;
    const m = /^([A-Za-z]):(.*)$/.exec(line);
    if(m && (!inBody || 'VKLMQTIWwsm'.indexOf(m[1]) >= 0)){
      const f = m[1], val = m[2].trim();
      if(f === 'X') meta.X = val;
      else if(f === 'T'){ if(!meta.T) meta.T = val; }
      else if(f === 'M'){
        if(/^C\|/i.test(val)) meta.M = [2,2];
        else if(/^C$/i.test(val)) meta.M = [4,4];
        else { const mm = /(\d+)\s*\/\s*(\d+)/.exec(val); if(mm) meta.M = [+mm[1], +mm[2]]; }
      }
      else if(f === 'L'){ const mm = /(\d+)\s*\/\s*(\d+)/.exec(val); if(mm) meta.L = [+mm[1], +mm[2]]; }
      else if(f === 'Q'){
        const mm = /(\d+)\s*\/\s*(\d+)\s*=\s*(\d+(?:\.\d+)?)/.exec(val);
        if(mm) meta.Q = {unit:[+mm[1],+mm[2]], bpm:parseFloat(mm[3])};
        else { const b = /(\d+(?:\.\d+)?)/.exec(val); if(b) meta.Q = {unit:[1,4], bpm:parseFloat(b[1])}; }
      }
      else if(f === 'K'){
        if(!inBody){ meta.K = val || 'C'; inBody = true; }
        else body.push({t:'key', v:val});
      }
      else if(f === 'V'){
        const vm = /^\s*(\S+)\s*([\s\S]*)$/.exec(val) || [null,'1',''];
        const v = ensureVoice(vm[1], vm[2]);
        if(inBody) body.push({t:'voice', v:v.id});
      }
      else if(!inBody && 'CZNOrBDFGHSR'.indexOf(f) >= 0) meta.extra.push(f + ':' + val);
      continue;
    }
    if(inBody) body.push({t:'music', v:line});
  }
  if(!meta.L) meta.L = (meta.M[0]/meta.M[1] < 0.75) ? [1,16] : [1,8];
  if(!voices.length) ensureVoice('1','');
  let cur = voices[0];

  const uT = Math.round(WHOLE * meta.L[0] / meta.L[1]);
  const bT = Math.round(WHOLE * meta.M[0] / meta.M[1]);
  let kacc = keyInfo(meta.K).acc;
  let warnedTuplet = false, warnedRepeat = false;

  function readLen(s,i){
    let num = '', den = '', slash = 0;
    while(i < s.length && s[i] >= '0' && s[i] <= '9') num += s[i++];
    while(i < s.length && s[i] === '/'){ slash++; i++; }
    if(slash) while(i < s.length && s[i] >= '0' && s[i] <= '9') den += s[i++];
    const N = num ? parseInt(num,10) : 1;
    const D = den ? parseInt(den,10) : (slash ? Math.pow(2,slash) : 1);
    return {mult: N/D, i:i};
  }
  function readPitch(s,i){
    let acc = null;
    while(i < s.length && (s[i]==='^' || s[i]==='_' || s[i]==='=')){
      if(s[i] === '^') acc = (acc === null ? 0 : acc) + 1;
      else if(s[i] === '_') acc = (acc === null ? 0 : acc) - 1;
      else acc = 0;
      i++;
    }
    const ch = s[i];
    if(!ch || !/[A-Ga-g]/.test(ch)) return null;
    const L = ch.toUpperCase();
    let oct = (ch === L) ? 4 : 5;
    i++;
    while(i < s.length && (s[i] === ',' || s[i] === "'")){ if(s[i] === ',') oct--; else oct++; i++; }
    return {letter:L, oct:oct, acc:acc, i:i};
  }
  function midiOf(v,p){
    const k = p.letter + p.oct;
    let a;
    if(p.acc !== null){ v._acc[k] = p.acc; a = p.acc; }
    else if(k in v._acc) a = v._acc[k];
    else a = kacc[p.letter] || 0;
    return 12*(p.oct+1) + BASE[p.letter] + a;
  }
  function addNote(v, dur, midi){
    if(v._tieFrom && v._tieFrom.p === midi){ v._tieFrom.d += dur; v._last = v._tieFrom; v._tieFrom = null; v.cursor += dur; return v._last; }
    v._tieFrom = null;
    const n = {s:v.cursor, d:dur, p:midi};
    v.notes.push(n); v.cursor += dur; v._last = n;
    return n;
  }
  function addRest(v, dur){ v._tieFrom = null; const r = {s:v.cursor, d:dur, rest:true}; v.cursor += dur; v._last = r; return r; }

  let broken = 0, tiePend = false;

  for(const seg of body){
    if(seg.t === 'voice'){ cur = vmap.get(seg.v) || cur; continue; }
    if(seg.t === 'key'){ kacc = keyInfo(seg.v).acc; continue; }
    const s = seg.v;
    let i = 0;
    while(i < s.length){
      const c = s[i];
      if(c === ' ' || c === '\t'){ i++; continue; }
      if(c === '"'){
        let j = s.indexOf('"', i+1); if(j < 0) j = s.length;
        const txt = s.slice(i+1, j).trim(); i = j + 1;
        if(txt && !/^[\^_<>@]/.test(txt) && !chords.some(x => x.s === cur.cursor)) chords.push({s:cur.cursor, text:txt});
        continue;
      }
      if(c === '{'){ const j = s.indexOf('}', i); i = j < 0 ? s.length : j+1; continue; }
      if(c === '!'){ const j = s.indexOf('!', i+1); i = j < 0 ? s.length : j+1; continue; }
      if(c === '+'){ const j = s.indexOf('+', i+1); i = j < 0 ? s.length : j+1; continue; }
      if(c === '\\' || c === '*' || c === ')' || c === '$'){ i++; continue; }
      if(c === '('){
        const tm = /^\((\d+)(?::(\d*))?(?::(\d*))?/.exec(s.slice(i));
        if(tm){
          if(!warnedTuplet){ warns.push('잇단음표는 길이를 정확히 옮기지 못합니다'); warnedTuplet = true; }
          i += tm[0].length; continue;
        }
        i++; continue;
      }
      if(c === '-'){ if(cur._last && !cur._last.rest) cur._tieFrom = cur._last; i++; continue; }
      if(c === '>' || c === '<'){
        let k = 0; while(s[i] === c){ k++; i++; }
        const f = 2 - Math.pow(2,-k), g = Math.pow(2,-k);
        const prev = cur._last;
        if(prev){
          const nd = Math.max(1, Math.round(prev.d * (c === '>' ? f : g)));
          cur.cursor += nd - prev.d; prev.d = nd;
          broken = (c === '>') ? g : f;
        }
        continue;
      }
      const bm = /^(\[\||\|\]|\|\||::|:\|:|:\||\|:|\|)/.exec(s.slice(i));
      if(bm){
        if(bm[0].indexOf(':') >= 0 && !warnedRepeat){ warns.push('도돌이표는 펼치지 않고 한 번만 지나갑니다'); warnedRepeat = true; }
        cur._acc = {}; i += bm[0].length;
        const vm = /^\d+(?:[,-]\d+)*\.?/.exec(s.slice(i));
        if(vm && bm[0].indexOf('[') >= 0) i += vm[0].length;
        continue;
      }
      if(c === '['){
        const inl = /^\[([A-Za-z]):([^\]]*)\]/.exec(s.slice(i));
        if(inl){
          if(inl[1] === 'K') kacc = keyInfo(inl[2]).acc;
          i += inl[0].length; continue;
        }
        const vt = /^\[\d/.exec(s.slice(i));
        if(vt){ i += 2; continue; }
        const close = s.indexOf(']', i);
        if(close > 0){
          const inner = s.slice(i+1, close);
          const after = readLen(s, close+1);
          const start = cur.cursor;
          let maxd = 0, k = 0, first = null;
          while(k < inner.length){
            const p = readPitch(inner, k);
            if(!p){ k++; continue; }
            const ln = readLen(inner, p.i); k = ln.i;
            const d = Math.max(1, Math.round(uT * ln.mult * after.mult * (broken || 1)));
            cur.cursor = start;
            const nn = addNote(cur, d, midiOf(cur,p));
            if(!first) first = nn;
            if(d > maxd) maxd = d;
          }
          cur.cursor = start + (maxd || 0);
          if(first) cur._last = first;
          broken = 0; i = after.i; continue;
        }
        i++; continue;
      }
      if(c === 'z' || c === 'x'){
        const ln = readLen(s, i+1);
        addRest(cur, Math.max(1, Math.round(uT * ln.mult * (broken || 1))));
        broken = 0; i = ln.i; continue;
      }
      if(c === 'Z'){
        const ln = readLen(s, i+1);
        addRest(cur, bT * Math.max(1, Math.round(ln.mult)));
        broken = 0; i = ln.i; continue;
      }
      const p = readPitch(s, i);
      if(p){
        const ln = readLen(s, p.i);
        addNote(cur, Math.max(1, Math.round(uT * ln.mult * (broken || 1))), midiOf(cur,p));
        broken = 0; i = ln.i; continue;
      }
      i++;
    }
  }
  for(const v of voices){
    v.notes = v.notes.filter(n => !n.rest).sort((a,b) => a.s - b.s || a.p - b.p);
    delete v._acc; delete v._last; delete v._tieFrom; delete v.cursor;
    v.visible = true;
  }
  chords.sort((a,b) => a.s - b.s);
  return {meta, voices, chords, warns};
}

/* ===================== ABC 쓰기 ===================== */
function lenStr(d, uT){
  let n = Math.round(d), q = uT;
  const g = gcd(n, q); n /= g; q /= g;
  if(q === 1) return n === 1 ? '' : String(n);
  if(n === 1) return '/' + q;
  return n + '/' + q;
}
function pitchStr(p, ki, accidentals = new Map()){
  const pc = ((p % 12) + 12) % 12;
  let letter = null, acc = '';
  for(const L of LETTERS) if(((BASE[L] + (ki.acc[L]||0)) % 12 + 12) % 12 === pc){ letter = L; acc = ''; break; }
  if(letter === null) for(const L of LETTERS) if(BASE[L] % 12 === pc && (ki.acc[L]||0) !== 0){ letter = L; acc = '='; break; }
  if(letter === null){
    const order = ki.n < 0 ? [-1,1] : [1,-1];
    for(const d of order){
      for(const L of LETTERS) if((((BASE[L] + d) % 12) + 12) % 12 === pc){ letter = L; acc = d > 0 ? '^' : '_'; break; }
      if(letter) break;
    }
  }
  if(letter === null){ letter = 'C'; acc = ''; }
  const semis = acc === '^' ? 1 : acc === '_' ? -1 : acc === '=' ? 0 : (ki.acc[letter] || 0);
  const oct = Math.round((p - semis - BASE[letter]) / 12) - 1;
  const slot = letter + oct;
  const previous = accidentals.has(slot) ? accidentals.get(slot) : (ki.acc[letter] || 0);
  let out = semis === previous ? '' : semis > 0 ? '^' : semis < 0 ? '_' : '=';
  accidentals.set(slot, semis);
  if(oct >= 5){ out += letter.toLowerCase(); for(let i = 5; i < oct; i++) out += "'"; }
  else { out += letter; for(let i = oct; i < 4; i++) out += ','; }
  return out;
}
function toABC(){
  const uT = unitTicks(), bT = barTicks(), ki = keyInfo(S.meta.K);
  let end = 0;
  for(const v of S.voices) for(const n of v.notes) end = Math.max(end, n.s + n.d);
  for(const c of S.chords) end = Math.max(end, c.s + 1);
  const bars = Math.max(1, Math.ceil(end / bT));

  const out = [];
  out.push('X:' + (S.meta.X || '1'));
  out.push('T:' + (S.meta.T || ''));
  for(const e of S.meta.extra) out.push(e);
  out.push('M:' + S.meta.M[0] + '/' + S.meta.M[1]);
  out.push('L:' + S.meta.L[0] + '/' + S.meta.L[1]);
  out.push('Q:' + S.meta.Q.unit[0] + '/' + S.meta.Q.unit[1] + '=' + S.meta.Q.bpm);
  for(const v of S.voices){
    let h = 'V: ' + v.id;
    if(v.clef) h += ' clef=' + v.clef;
    if(v.name && v.name !== v.id) h += ' name="' + v.name + '"';
    if(v.snm) h += ' snm="' + v.snm + '"';
    out.push(h);
  }
  out.push('K:' + S.meta.K);

  S.voices.forEach((v, vi) => {
    out.push('V: ' + v.id);
    for(const l of voiceBody(v, vi === 0, bars, uT, bT, ki)) out.push(l);
  });
  return out.join('\n') + '\n';
}
function voiceBody(v, withChords, bars, uT, bT, ki){
  const accidentals = new Map();
  const groups = new Map();
  for(const n of v.notes){ if(!groups.has(n.s)) groups.set(n.s, []); groups.get(n.s).push(n); }
  const starts = [...groups.keys()].sort((a,b) => a - b);
  const chords = withChords ? S.chords.slice().sort((a,b) => a.s - b.s) : [];
  let ci = 0, si = 0, carry = null;
  const barStr = [], barRestOnly = [];

  function chordsUpTo(t){
    let s = '';
    while(ci < chords.length && chords[ci].s <= t){ s += '"' + chords[ci].text + '"'; ci++; }
    return s;
  }
  function nextChordTick(){ return ci < chords.length ? chords[ci].s : Infinity; }
  function renderGroup(g, d){
    const body = g.length === 1 ? pitchStr(g[0].p, ki, accidentals)
      : '[' + g.map(n => pitchStr(n.p, ki, accidentals)).join('') + ']';
    return body + lenStr(d, uT);
  }

  for(let b = 0; b < bars; b++){
    accidentals.clear();
    const b0 = b * bT, b1 = b0 + bT;
    let t = b0, str = '', onlyRest = true;

    if(carry){
      const d = Math.min(carry.remain, bT);
      str += renderGroup(carry.g, d) + (carry.remain > d ? '-' : '');
      carry.remain -= d; if(carry.remain <= 0) carry = null;
      t = b0 + d; onlyRest = false;
    }
    const fill = (to) => {
      while(t < to){
        const pre = chordsUpTo(t);
        const nc = nextChordTick();
        const stop = (nc > t && nc < to) ? nc : to;
        str += pre + 'z' + lenStr(stop - t, uT);
        t = stop;
      }
    };
    while(si < starts.length && starts[si] < b1){
      const st = starts[si];
      if(st < t){ si++; continue; }
      fill(st);
      str += chordsUpTo(t);
      const g = groups.get(st);
      let d = Math.min.apply(null, g.map(n => n.d));
      const fit = Math.min(d, b1 - t);
      str += renderGroup(g, fit) + (d > fit ? '-' : '');
      if(d > fit) carry = {g:g, remain:d - fit};
      onlyRest = false; t += fit; si++;
      if(t >= b1) break;
    }
    if(t < b1){ const had = nextChordTick() < b1; fill(b1); if(had) onlyRest = false; }
    barStr.push(str); barRestOnly.push(onlyRest);
  }

  const lines = [];
  let i = 0, lineBars = 0, line = '';
  while(i < bars){
    if(barRestOnly[i]){
      let n = 0;
      while(i + n < bars && barRestOnly[i + n]) n++;
      if(n >= 2){
        if(line){ lines.push(line); line = ''; lineBars = 0; }
        lines.push('Z' + n + '|');
        i += n; continue;
      }
    }
    line += barStr[i] + '|';
    lineBars++; i++;
    if(lineBars >= 4){ lines.push(line); line = ''; lineBars = 0; }
  }
  if(line) lines.push(line);
  return lines.length ? lines : ['z' + lenStr(bT, uT) + '|'];
}


export { PPQ, WHOLE, BASE, LETTERS, SHARP_ORDER, FLAT_ORDER, FIFTH, MODE, VCOLORS, DIMNOTE, LOMIDI, HIMIDI, NROWS, GL, GR, GC, GT, GB, SB, BASE_PX, BASE_ROW, NOTE_KO, BLACK, clamp, gcd, S, barTicks, unitTicks, secPerTick, keyInfo, scalePitchClasses, mkVoice, parseABC, lenStr, pitchStr, toABC, voiceBody };
