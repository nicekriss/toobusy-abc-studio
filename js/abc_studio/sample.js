import { sampleNotes, encodeWav } from './sample-data.js';

export function installSampleUI({commit, audioContext, stopPlayback = () => {}}){
  const $ = id => document.getElementById(id);
  const api = new URL('../../../abc-studio/audio/', import.meta.url);
  let buffer = null, fileName = '', result = null, job = null, generation = 0, previewGeneration = 0;
  let busy = false, available = false, originalUrl = null, melodyUrl = null, pollTimer = null, pollResolve = null;
  const say = text => { $('sampleStatus').textContent = text; };
  const pause = () => { for(const id of ['sampleOriginal','sampleVocal','sampleMelody']) $(id).pause(); };
  for(const id of ['sampleOriginal','sampleVocal','sampleMelody']) $(id).onplay = () => {
    for(const other of ['sampleOriginal','sampleVocal','sampleMelody']) if(other !== id) $(other).pause();
  };
  function setBusy(value){
    busy = value;
    for(const id of ['sampleFile','sampleFrom','sampleTo','sampleMode']) $(id).disabled = value;
    $('sampleAnalyze').disabled = value || !buffer || !available;
    $('sampleCancel').hidden = !value;
  }
  function clearPreview(){
    pause(); result = null; previewGeneration++;
    $('samplePreview').hidden = true;
    for(const id of ['sampleOriginal','sampleVocal','sampleMelody']){ $(id).removeAttribute('src'); $(id).load(); }
    for(const url of [originalUrl, melodyUrl]) if(url) URL.revokeObjectURL(url);
    originalUrl = melodyUrl = null;
  }
  async function releaseJob(){
    const old = job; job = null;
    if(old) await fetch(new URL('jobs/'+old,api),{method:'DELETE'}).catch(()=>{});
  }
  async function cancel(){
    generation++;
    clearPreview();
    clearTimeout(pollTimer); if(pollResolve){ pollResolve(); pollResolve = null; }
    await releaseJob(); setBusy(false); say('분석을 취소했습니다.');
  }
  async function checkAvailable(){
    try{
      const response = await fetch(new URL('status',api));
      if(!response.ok) throw new Error();
      const status = await response.json(); available = status.available;
      $('sampleSetup').textContent = available
        ? (status.modelReady ? 'ComfyUI가 실행 중인 컴퓨터에서 분석합니다. 음원은 외부 서비스로 전송하지 않습니다.'
          : '최초 분석 시 보컬 분리 모델 약 335 MB를 받습니다. 음원은 외부 서비스로 전송하지 않습니다.')
        : '음원 분석 패키지 설치가 필요합니다. 저장소의 설치 안내에 따라 requirements.txt를 설치하세요.';
    }catch(_){
      available = false;
      $('sampleSetup').textContent = '음원 분석 서버에 연결되지 않았습니다. 업데이트 후 ComfyUI를 재시작하고 스튜디오를 다시 열어주세요.';
    }
    setBusy(busy);
  }
  $('sampleBtn').onclick = () => {
    stopPlayback();
    $('welcome').classList.add('hidden'); $('humming').classList.add('hidden');
    $('sampleDialog').classList.remove('hidden'); checkAvailable();
  };
  const close = async () => { if(busy) await cancel(); pause(); $('sampleDialog').classList.add('hidden'); };
  $('sampleClose').onclick = close;
  $('sampleCancel').onclick = cancel;
  $('sampleFile').onchange = async e => {
    const file = e.target.files[0]; if(!file) return;
    const token = ++generation; buffer = null; clearPreview(); await releaseJob();
    setBusy(true); say('파일 읽는 중…');
    try{
      if(file.size > 128*1024*1024) throw new Error('파일이 너무 큽니다. 128 MB 이하의 노래 샘플을 선택하세요.');
      const decoded = await audioContext().decodeAudioData(await file.arrayBuffer());
      if(token !== generation) return;
      buffer = decoded; fileName = file.name;
      $('sampleName').textContent = file.name+' · '+decoded.duration.toFixed(1)+'초';
      $('sampleFrom').value = 0; $('sampleTo').value = Math.min(30,decoded.duration).toFixed(2);
      say('보컬이 나오는 구간을 선택하고 분석하세요. 한 번에 최대 90초입니다.');
    }catch(e){ if(token === generation) say('파일을 열지 못했습니다. '+e.message); }
    finally{ if(token === generation) setBusy(false); }
  };
  for(const id of ['sampleFrom','sampleTo','sampleMode']) $(id).onchange = () => {
    clearPreview(); releaseJob(); say('설정을 바꿨습니다. 다시 분석하세요.');
  };
  async function melodyPreview(){
    if(!result) return;
    const token = ++previewGeneration;
    try{
      const notes = sampleNotes(result,Number($('sampleBpm').value),$('sampleQuantize').checked);
      $('sampleNew').disabled = true; $('sampleInsert').disabled = true;
      const duration = Math.max(result.duration,...notes.map(n=>n.start+n.duration));
      const off = new OfflineAudioContext(1,Math.ceil((duration+.2)*22050),22050);
      for(const note of notes){
        const osc = off.createOscillator(), gain = off.createGain();
        osc.type = 'triangle'; osc.frequency.value = 440*2**((note.pitch-69)/12);
        const end = note.start+note.duration;
        gain.gain.setValueAtTime(0,note.start);
        gain.gain.linearRampToValueAtTime(.18,note.start+Math.min(.008,note.duration/4));
        gain.gain.setValueAtTime(.18,Math.max(note.start+.008,end-.015));
        gain.gain.linearRampToValueAtTime(0,end);
        osc.connect(gain); gain.connect(off.destination); osc.start(note.start); osc.stop(end+.01);
      }
      const rendered = await off.startRendering();
      if(token !== previewGeneration) return false;
      if(melodyUrl) URL.revokeObjectURL(melodyUrl);
      melodyUrl = URL.createObjectURL(encodeWav(rendered)); $('sampleMelody').src = melodyUrl;
      $('sampleNew').disabled = false; $('sampleInsert').disabled = false;
      return true;
    }catch(e){
      if(token !== previewGeneration) return;
      $('sampleNew').disabled = true; $('sampleInsert').disabled = true; say(e.message);
      return false;
    }
  }
  $('sampleBpm').onchange = melodyPreview;
  $('sampleQuantize').onchange = melodyPreview;
  $('sampleAnalyze').onclick = async () => {
    const from = Number($('sampleFrom').value), to = Number($('sampleTo').value);
    if(!buffer || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > buffer.duration+.01 || to-from < .2 || to-from > 90){
      say('파일 안에서 0.2~90초 길이의 구간을 선택하세요.'); return;
    }
    const token = ++generation; clearPreview(); await releaseJob(); setBusy(true);
    $('sampleProgress').value = 0; say('선택한 구간 준비 중…');
    try{
      const off = new OfflineAudioContext(Math.min(2,buffer.numberOfChannels),Math.round((to-from)*44100),44100);
      const source = off.createBufferSource(); source.buffer = buffer; source.connect(off.destination); source.start(0,from,to-from);
      const pcm = await off.startRendering(); if(token !== generation) return;
      const wav = encodeWav(pcm); originalUrl = URL.createObjectURL(wav); $('sampleOriginal').src = originalUrl;
      const form = new FormData(); form.append('audio',wav,'sample.wav'); form.append('mode',$('sampleMode').value);
      const response = await fetch(new URL('jobs',api),{method:'POST',body:form});
      const started = await response.json(); if(!response.ok) throw new Error(started.error || '분석을 시작하지 못했습니다.');
      if(token !== generation){ await fetch(new URL('jobs/'+started.id,api),{method:'DELETE'}); return; }
      job = started.id;
      while(token === generation){
        const res = await fetch(new URL('jobs/'+job,api)); const state = await res.json();
        if(token !== generation) return;
        if(!res.ok || state.state === 'error') throw new Error(state.error || state.message);
        say(state.message); $('sampleProgress').value = state.percent || 0;
        if(state.state === 'done'){
          result = state.result;
          $('sampleBpm').value = result.bpm || 120;
          $('sampleTempo').textContent = result.bpm ? '추정 BPM · 필요하면 수정' : 'BPM 미검출 · 120은 임시값';
          $('sampleQuantize').checked = false;
          $('sampleSummary').textContent = result.notes.length+'개 음 · 확인이 필요한 음 '+result.lowConfidenceNotes+'개. '+result.warnings.join(' ');
          $('sampleVocal').src = new URL('jobs/'+job+'/vocals',api).href;
          $('samplePreview').hidden = false;
          const ready = await melodyPreview();
          if(token === generation && ready) say('아직 악보를 바꾸지 않았습니다. 미리듣기 후 넣을 곳을 선택하세요.');
          break;
        }
        await new Promise(resolve => { pollResolve = resolve; pollTimer = setTimeout(resolve,1000); }); pollResolve = null;
      }
    }catch(e){ if(token === generation) say('분석 실패: '+e.message); }
    finally{ if(token === generation) setBusy(false); }
  };
  for(const [id,newScore] of [['sampleNew',true],['sampleInsert',false]]) $(id).onclick = async () => {
    if(!result) return;
    try{
      const bpm = Number($('sampleBpm').value);
      const notes = sampleNotes(result,bpm,$('sampleQuantize').checked);
      commit(notes,{bpm,newScore,title:fileName.replace(/\.[^.]+$/,'')});
      await close();
    }catch(e){ say(e.message); }
  };
  window.addEventListener('pagehide',() => {
    if(job) fetch(new URL('jobs/'+job,api),{method:'DELETE',keepalive:true}).catch(()=>{});
    pause();
  });
}
