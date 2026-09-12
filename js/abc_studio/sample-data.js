// Seconds remain canonical until the user inserts a reviewed take into a score.
export function sampleNotes(result, bpm, quantize = false){
  if(!Number.isFinite(bpm) || bpm < 20 || bpm > 300) throw new Error('BPM은 20~300으로 입력하세요.');
  const step = 60 / bpm / 4, offset = result.beatOffset || 0;
  const snap = t => Math.max(0, offset + Math.round((t - offset) / step) * step);
  return result.notes.map(n => {
    const start = quantize ? snap(n.start) : n.start;
    const end = quantize ? snap(n.start + n.duration) : n.start + n.duration;
    return {...n, start, duration: Math.max(quantize ? step : .001, end - start)};
  }).map((n, i, all) => ({...n, duration: Math.min(n.duration,
    i + 1 < all.length ? Math.max(0, all[i+1].start - n.start) : n.duration)}))
    .filter(n => n.duration > 0);
}

export function encodeWav(buffer){
  const channels = Math.min(2, buffer.numberOfChannels), count = buffer.length;
  const data = new ArrayBuffer(44 + count * channels * 2), view = new DataView(data);
  const word = (pos, text) => [...text].forEach((c,i) => view.setUint8(pos+i,c.charCodeAt(0)));
  word(0,'RIFF'); view.setUint32(4,data.byteLength-8,true); word(8,'WAVE'); word(12,'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,channels,true);
  view.setUint32(24,buffer.sampleRate,true); view.setUint32(28,buffer.sampleRate*channels*2,true);
  view.setUint16(32,channels*2,true); view.setUint16(34,16,true); word(36,'data');
  view.setUint32(40,count*channels*2,true);
  const tracks = Array.from({length:channels},(_,c)=>buffer.getChannelData(c));
  for(let i=0;i<count;i++) for(let c=0;c<channels;c++){
    const x = Math.max(-1,Math.min(1,tracks[c][i]));
    view.setInt16(44+(i*channels+c)*2,Math.round(x*(x<0?32768:32767)),true);
  }
  return new Blob([data],{type:'audio/wav'});
}
