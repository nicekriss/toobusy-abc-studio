export function installSampleUI({commit, stopPlayback = () => {}}){
  const $ = id => document.getElementById(id);
  const api = new URL('../../../abc-studio/audio/', import.meta.url);
  const players = ['sampleOriginal','sampleVocal','sampleInstrumental','sampleMelody'];
  let file = null, result = null, job = null, generation = 0, busy = false, available = false;
  let controller = null, timer = null, resolvePoll = null, maxUpload = 512*1024*1024;
  const say = text => { $('sampleStatus').textContent = text; };
  const pause = () => players.forEach(id => $(id).pause());
  for(const id of players) $(id).onplay = () => players.filter(other=>other!==id).forEach(other=>$(other).pause());
  function setBusy(value){
    busy = value;
    for(const id of ['sampleFile','sampleFrom','sampleTo','sampleMode']) $(id).disabled = value;
    $('sampleAnalyze').disabled = value || !file || !available;
    $('sampleCancel').hidden = !value;
    $('sampleNew').disabled = value || !result;
  }
  function clearPreview(){
    pause(); result = null; $('samplePreview').hidden = true;
    for(const id of players){ $(id).removeAttribute('src'); $(id).load(); }
  }
  async function releaseJob(){
    const old = job; job = null;
    if(old) await fetch(new URL('jobs/'+old,api),{method:'DELETE'}).catch(()=>{});
  }
  async function cancel(){
    generation++; controller?.abort(); controller = null;
    clearTimeout(timer); resolvePoll?.(); resolvePoll = null;
    clearPreview(); await releaseJob(); setBusy(false); say('분석을 취소했습니다.');
  }
  async function checkAvailable(){
    try{
      const response = await fetch(new URL('status',api));
      if(!response.ok) throw new Error();
      const status = await response.json();
      available = status.available && status.engine === 'SheetSage2';
      maxUpload = status.maxUploadBytes || maxUpload;
      $('sampleSetup').textContent = available
        ? 'SheetSage2 · 이 컴퓨터에서 인스·보컬·박자를 함께 분석합니다. 긴 곡은 구간을 겹쳐 분석한 뒤 이어 붙입니다.'
        : 'SheetSage2 설치가 필요합니다. 최신 설치기를 실행하고 ComfyUI를 다시 시작하세요.';
    }catch(_){ available = false; $('sampleSetup').textContent = '분석 서버에 연결되지 않았습니다. ComfyUI 실행 상태를 확인하세요.'; }
    setBusy(busy);
  }
  $('sampleBtn').onclick = () => {
    stopPlayback(); $('welcome').classList.add('hidden'); $('humming').classList.add('hidden');
    $('sampleDialog').classList.remove('hidden'); checkAvailable();
  };
  const close = async () => { if(busy) await cancel(); pause(); $('sampleDialog').classList.add('hidden'); };
  $('sampleClose').onclick = close;
  $('sampleCancel').onclick = cancel;
  $('sampleFile').onchange = async e => {
    generation++; clearPreview(); await releaseJob(); file = e.target.files[0] || null;
    if(file && file.size > maxUpload){ file = null; say('512 MB 이하의 음원 파일을 선택하세요.'); }
    else if(file){
      $('sampleName').textContent = file.name + ' · ' + (file.size/1024/1024).toFixed(1)+' MB';
      $('sampleFrom').value = 0; $('sampleTo').value = '';
      say('기본은 곡 전체입니다. 일부만 필요하면 시작·종료 시간을 지정하세요.');
    }
    setBusy(false);
  };
  for(const id of ['sampleFrom','sampleTo','sampleMode']) $(id).onchange = () => {
    generation++; clearPreview(); releaseJob(); setBusy(false); say('설정을 바꿨습니다. 다시 분석하세요.');
  };
  $('sampleAnalyze').onclick = async () => {
    const from = Number($('sampleFrom').value), to = $('sampleTo').value.trim() ? Number($('sampleTo').value) : null;
    if(!file || !Number.isFinite(from) || from < 0 || (to!==null && (!Number.isFinite(to) || to-from<.2))){
      say('시작·종료 시간을 확인하세요. 종료를 비우면 곡 끝까지 분석합니다.'); return;
    }
    const token = ++generation; clearPreview(); setBusy(true); await releaseJob();
    if(token !== generation) return;
    controller = new AbortController();
    job = crypto.randomUUID().replaceAll('-','');
    $('sampleProgress').removeAttribute('value'); say('음원 업로드 중…');
    try{
      const form = new FormData(); form.append('audio',file,'source.audio');
      form.append('id',job);
      form.append('from',String(from)); form.append('to',to===null?'':String(to)); form.append('mode',$('sampleMode').value);
      const response = await fetch(new URL('jobs',api),{method:'POST',body:form,signal:controller.signal});
      const started = await response.json(); if(!response.ok) throw new Error(started.error || '분석을 시작하지 못했습니다.');
      if(token !== generation){ await fetch(new URL('jobs/'+started.id,api),{method:'DELETE'}); return; }
      job = started.id;
      while(token === generation){
        const response = await fetch(new URL('jobs/'+job,api),{signal:controller.signal});
        const state = await response.json();
        if(!response.ok || state.state==='error') throw new Error(state.error || state.message);
        if(token !== generation) return;
        say(state.message); $('sampleProgress').value = state.percent || 0;
        if(state.state==='done'){
          result = state.result;
          if(result.engine !== 'SheetSage2' || !result.abc) throw new Error('SheetSage2 ABC 결과가 없습니다.');
          $('sampleSummary').textContent = `보컬 ${result.vocalNotes}개 음 · 인스 ${result.instrumentalNotes}개 음 · ${result.duration.toFixed(1)}초. ` + result.warnings.join(' ');
          for(const [id,name] of [['sampleOriginal','original'],['sampleVocal','vocal'],['sampleInstrumental','instrumental'],['sampleMelody','melody']])
            $(id).src = new URL('jobs/'+job+'/files/'+name+'.wav',api).href;
          for(const [id,name] of [['sampleDownload','score.abc'],['sampleMidi','transcription.mid']]) $(id).href = new URL('jobs/'+job+'/files/'+name,api).href;
          $('samplePreview').hidden = false;
          say('미리듣기로 확인한 뒤 두 멜로디를 악보로 가져오세요.'); break;
        }
        await new Promise(resolve => { resolvePoll = resolve; timer = setTimeout(resolve,1000); }); resolvePoll = null;
      }
    }catch(e){ if(token===generation) say('분석 실패: '+e.message); }
    finally{ if(token===generation){ controller=null; setBusy(false); } }
  };
  $('sampleNew').onclick = async () => {
    if(!result) return;
    try{ commit(result.abc); await close(); }
    catch(e){ say(e.message); }
  };
  window.addEventListener('pagehide',() => {
    controller?.abort();
    if(job) fetch(new URL('jobs/'+job,api),{method:'DELETE',keepalive:true}).catch(()=>{});
    pause();
  });
}
