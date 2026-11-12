const $=s=>document.querySelector(s);
const state={reference:null,referenceUrl:null,videoUrl:null,audioUrl:null,creditsUrl:null,jobId:null,recorder:null,recordChunks:[],recordStream:null,recordTimer:null,recordStarted:0,discardRecordingOnStop:false};
const DB_NAME="content-factory-local",STORE="voice-profile";
function engineUrl(){return ($("#engineUrl").value||localStorage.getItem("cf-engine-url")||"").trim().replace(/\/+$/,"")}
function token(){return ($("#engineToken").value||localStorage.getItem("cf-engine-token")||"").trim()}
function headers(){const h={};if(token())h["X-Factory-Token"]=token();return h}
function setStatus(id,text){$(id).textContent=text}
function setProgress(p){$("#renderProgress").style.width=Math.max(0,Math.min(100,p))+"%"}
function openDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(STORE))req.result.createObjectStore(STORE)};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
async function putVoice(blob,name,type){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,"readwrite");tx.objectStore(STORE).put({blob,name,type},"reference");tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>{db.close();reject(tx.error)}})}
async function getVoice(){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,"readonly"),req=tx.objectStore(STORE).get("reference");req.onsuccess=()=>{db.close();const x=req.result;resolve(x?new File([x.blob],x.name,{type:x.type||"audio/wav"}):null)};req.onerror=()=>{db.close();reject(req.error)}})}
async function deleteVoice(){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,"readwrite");tx.objectStore(STORE).delete("reference");tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>{db.close();reject(tx.error)}})}
function revoke(url){if(url)URL.revokeObjectURL(url)}
function resetResult(){revoke(state.videoUrl);revoke(state.audioUrl);revoke(state.creditsUrl);state.videoUrl=null;state.audioUrl=null;state.creditsUrl=null;state.jobId=null;$("#renderPanel").classList.add("hidden");$("#renderResult").classList.add("hidden");$("#startRender").disabled=!state.reference||!$("#scriptText").value.trim();$("#startRender").textContent="Sessizlikleri temizle ve videoyu hazırla";setProgress(0)}
function openShorts(){resetResult();$("#editor").classList.remove("hidden");$("#editor").scrollIntoView({behavior:"smooth"})}
function saveEngine(){localStorage.setItem("cf-engine-url",$("#engineUrl").value.trim());localStorage.setItem("cf-engine-token",$("#engineToken").value.trim());setStatus("#engineStatus","Motor bağlantı ayarları kaydedildi.")}
async function checkEngine(){const base=engineUrl();if(!base){setStatus("#engineStatus","Önce servis adresini gir.");return}setStatus("#engineStatus","Bağlantı kontrol ediliyor…");try{const r=await fetch(base+"/health",{headers:headers()});const j=await r.json();if(!r.ok)throw Error(j.detail||j.error||r.status);if(j.video_renderer!==true)throw Error("Servise ulaşıldı ancak FFmpeg video motoru çalışmıyor.");setStatus("#engineStatus","Bağlantı başarılı · MP4 motoru hazır.")}catch(e){setStatus("#engineStatus","Bağlantı kurulamadı: "+e.message)}}
function loadReference(){const ok=!!state.reference;const scriptReady=!!$("#scriptText").value.trim();$("#recordStatus").textContent=!ok?"Henüz mikrofon kaydı veya ses dosyası seçilmedi.":scriptReady?"Ses ve metin hazır. Videoyu oluşturmaya başlayabilirsin.":"Ses hazır. Önce 01 bölümüne seslendirme metnini ekle.";$("#startRender").disabled=!ok||!scriptReady}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000)}
async function fetchBlob(path){const r=await fetch(engineUrl()+path,{headers:headers()});if(!r.ok){let message="Dosya indirilemedi ("+r.status+")";try{const j=await r.json();message=j.detail||j.error||message}catch{}throw Error(message)}return await r.blob()}
async function approveAndRender(){
 const text=$("#scriptText").value.trim();
 const title=$("#topicTitle").value.trim()||"Content Factory Shorts";
 const base=engineUrl();
 const button=$("#startRender");
 if(!text){setStatus("#recordStatus","Önce seslendirme metnini yapıştır.");$("#scriptText").focus();return}
 if(!state.reference){setStatus("#recordStatus","Önce mikrofonla ses kaydet veya hazır bir ses dosyası seç.");return}
 if(!base||!token()){
  setStatus("#recordStatus","Ses hazır; ancak video motoru bağlantısı eksik. Motor ayarlarında servis adresi ve erişim anahtarı gerekli.");
  $("#engineSettings").classList.remove("hidden");
  $("#engineSettings").scrollIntoView({behavior:"smooth"});
  return;
 }
 button.disabled=true;
 button.textContent="Motor kontrol ediliyor…";
 $("#renderPanel").classList.remove("hidden");
 $("#renderResult").classList.add("hidden");
 setProgress(3);
 setStatus("#renderStatus","Video motoru kontrol ediliyor…");
 try{
  const healthResponse=await fetch(base+"/health",{headers:headers()});
  if(!healthResponse.ok)throw Error("Video motoruna ulaşılamadı (HTTP "+healthResponse.status+"). Motor adresini kontrol et.");
  const health=await healthResponse.json();
  if(health.video_renderer===false)throw Error("Video motorunda FFmpeg bulunamadı; MP4 üretimi başlatılamıyor.");
  setStatus("#renderStatus","Ses dosyası gönderiliyor; uzun sessizlikler temizlenecek…");
  button.textContent="Video hazırlanıyor…";
  const fd=new FormData();
  fd.append("text",text);
  fd.append("title",title);
  fd.append("audio",state.reference,state.reference.name||"narration-audio");
  const r=await fetch(base+"/api/shorts/render",{method:"POST",headers:headers(),body:fd});
  if(!r.ok){let m="Video işi başlatılamadı (HTTP "+r.status+").";try{const j=await r.json();m=j.detail||j.error||m}catch{}throw Error(m)}
  const job=await r.json();
  state.jobId=job.job_id;
  if(!state.jobId)throw Error("Video motoru iş numarası döndürmedi.");
  await pollJob(state.jobId,title);
  button.textContent="Video hazırlandı";
 }catch(e){
  setStatus("#renderStatus","İşlem başlatılamadı: "+e.message);
  button.disabled=false;
  button.textContent="Tekrar dene · Sessizlikleri temizle ve videoyu hazırla";
 }
}
async function pollJob(id,title){const base=engineUrl();let lastStatus="";for(let attempt=0;attempt<600;attempt++){const r=await fetch(base+"/api/jobs/"+encodeURIComponent(id),{headers:headers()});if(!r.ok)throw Error("İş durumu okunamadı ("+r.status+")");const j=await r.json();setProgress(j.progress||5);if(j.message!==lastStatus){setStatus("#renderStatus",j.message||j.status||"İşleniyor…");lastStatus=j.message}if(j.status==="failed")throw Error(j.error||"Render başarısız oldu.");if(j.status==="completed"){const vid=await fetchBlob("/api/jobs/"+encodeURIComponent(id)+"/video");const aud=await fetchBlob("/api/jobs/"+encodeURIComponent(id)+"/audio");const cr=await fetchBlob("/api/jobs/"+encodeURIComponent(id)+"/credits");revoke(state.videoUrl);revoke(state.audioUrl);revoke(state.creditsUrl);state.videoUrl=URL.createObjectURL(vid);state.audioUrl=URL.createObjectURL(aud);state.creditsUrl=URL.createObjectURL(cr);$("#finalVideo").src=state.videoUrl;$("#renderStats").textContent="Süre: "+Number(j.duration||0).toFixed(1)+" sn · Sessizlik azaltıldı: "+Number(j.removed_silence||0).toFixed(1)+" sn · Görsel sahne: "+(j.scene_count||0);$("#renderResult").classList.remove("hidden");setProgress(100);setStatus("#renderStatus","Video hazır. MP4'ü indirip CapCut'a aktarabilirsin.");return}await new Promise(resolve=>setTimeout(resolve,2200))}throw Error("Render zaman aşımına uğradı. Motorun çalışma durumunu kontrol et.")}
$("#settingsToggle").onclick=()=>$("#engineSettings").classList.toggle("hidden");
$("#saveEngine").onclick=saveEngine;$("#checkEngine").onclick=checkEngine;
$("#startShorts").onclick=openShorts;
$("#closeEditor").onclick=()=>$("#editor").classList.add("hidden");

$("#scriptText").oninput=()=>{const n=$("#scriptText").value.length;$("#scriptCount").textContent=n+" karakter · hedef 40–45 saniye";$("#startRender").disabled=!state.reference||!$("#scriptText").value.trim();if(state.reference)$("#recordStatus").textContent=$("#scriptText").value.trim()?"Ses ve metin hazır. Videoyu oluşturmaya başlayabilirsin.":"Ses hazır. Önce 01 bölümüne seslendirme metnini ekle.";};
$("#clearScript").onclick=()=>{$("#scriptText").value="";$("#scriptCount").textContent="0 karakter · hedef 40–45 saniye";resetResult()};
$("#startRender").onclick=approveAndRender;
$("#downloadVideo").onclick=()=>{if(state.videoUrl){const a=document.createElement("a");a.href=state.videoUrl;a.download=(($("#topicTitle").value.trim()||"shorts").replace(/[^a-z0-9-_]/gi,"_"))+".mp4";a.click()}};
$("#downloadCleanAudio").onclick=()=>{if(state.audioUrl){const a=document.createElement("a");a.href=state.audioUrl;a.download="shorts-cleaned-voice.wav";a.click()}};
$("#downloadCredits").onclick=()=>{if(state.creditsUrl){const a=document.createElement("a");a.href=state.creditsUrl;a.download="sources-and-licenses.txt";a.click()}};
$("#nextTopic").onclick=()=>{$("#topicTitle").value="";$("#scriptText").value="";$("#scriptCount").textContent="0 karakter · hedef 40–45 saniye";resetResult();$("#renderPanel").classList.add("hidden");$("#editor").scrollIntoView({behavior:"smooth"});};
$("#engineUrl").value=localStorage.getItem("cf-engine-url")||"";$("#engineToken").value=localStorage.getItem("cf-engine-token")||"";loadReference();


function stopTracks(){if(state.recordStream){state.recordStream.getTracks().forEach(t=>t.stop());state.recordStream=null}}
function timerTick(){const seconds=Math.floor((Date.now()-state.recordStarted)/1000);$("#recordTimer").textContent=String(Math.floor(seconds/60)).padStart(2,"0")+":"+String(seconds%60).padStart(2,"0")}
async function startRecording(){if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){$("#recordStatus").textContent="Bu tarayıcı mikrofon kaydını desteklemiyor. iPhone Safari'de siteye mikrofon izni verip tekrar dene.";return}try{state.recordStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});const types=["audio/mp4","audio/webm;codecs=opus","audio/webm"];const mime=types.find(t=>MediaRecorder.isTypeSupported?.(t));state.recorder=new MediaRecorder(state.recordStream,mime?{mimeType:mime}:undefined);state.recordChunks=[];state.recorder.ondataavailable=e=>{if(e.data?.size)state.recordChunks.push(e.data)};state.recorder.onstop=()=>{if(state.discardRecordingOnStop){state.discardRecordingOnStop=false;stopTracks();return}const blob=new Blob(state.recordChunks,{type:state.recorder.mimeType||"audio/mp4"});if(blob.size<5000){$("#recordStatus").textContent="Kayıt çok kısa veya boş. Lütfen yeniden dene.";state.reference=null}else{const ext=blob.type.includes("mp4")?"m4a":"webm";state.reference=new File([blob],"my-voice-reference."+ext,{type:blob.type});revoke(state.referenceUrl);state.referenceUrl=URL.createObjectURL(state.reference);$("#referencePreview").src=state.referenceUrl;$("#referencePreview").classList.remove("hidden");$("#recordStatus").textContent="Mikrofon kaydı hazır: "+(blob.size/1024/1024).toFixed(2)+" MB."}stopTracks();$("#recordState").textContent="Kayıt tamamlandı";$("#recordIndicator").classList.remove("recording");$("#startRecording").disabled=false;$("#stopRecording").disabled=true;$("#redoRecording").disabled=false;$("#redoRecording").classList.remove("hidden");loadReference()};state.recordStarted=Date.now();state.recorder.start(250);$("#recordState").textContent="Kayıt yapılıyor";$("#recordIndicator").classList.add("recording");$("#startRecording").disabled=true;$("#stopRecording").disabled=false;$("#redoRecording").disabled=true;$("#recordTimer").textContent="00:00";state.recordTimer=setInterval(timerTick,250);$("#recordStatus").textContent="Konuşabilirsin. Kaydı bitirdiğinde ses bu sayfada hazırlanacak."}catch(e){stopTracks();$("#recordStatus").textContent="Mikrofon açılamadı: "+e.message+" · iPhone Ayarlar > Safari > Mikrofon izinlerini kontrol et."}}
function stopRecording(){if(state.recordTimer){clearInterval(state.recordTimer);state.recordTimer=null}if(state.recorder&&state.recorder.state!=="inactive")state.recorder.stop()}
$("#startRecording").onclick=()=>{state.reference=null;revoke(state.referenceUrl);state.referenceUrl=null;$("#audioFile").value="";$("#referencePreview").removeAttribute("src");$("#referencePreview").classList.add("hidden");loadReference();startRecording()};$("#stopRecording").onclick=stopRecording;$("#redoRecording").onclick=()=>{state.reference=null;revoke(state.referenceUrl);state.referenceUrl=null;$("#audioFile").value="";$("#referencePreview").removeAttribute("src");$("#referencePreview").classList.add("hidden");$("#recordTimer").textContent="00:00";loadReference();startRecording()};$("#audioFile").onchange=e=>{const file=e.target.files?.[0];if(!file)return;const audioExt=/\.(mp3|m4a|wav|aac|mp4|mpeg|mpga|ogg|opus|webm|flac)$/i.test(file.name);const audioMime=/^(audio\/|video\/mp4$|application\/octet-stream$)/i.test(file.type||"");if(!audioExt&&!audioMime){alert("Lütfen MP3, M4A, WAV, AAC veya desteklenen bir ses dosyası seç.");e.target.value="";return}if(file.size>30*1024*1024){alert("Ses dosyası en fazla 30 MB olabilir.");e.target.value="";return}if(state.recorder&&state.recorder.state!=="inactive"){state.discardRecordingOnStop=true;state.recorder.stop()}stopTracks();revoke(state.referenceUrl);state.reference=file;state.referenceUrl=URL.createObjectURL(file);$("#referencePreview").src=state.referenceUrl;$("#referencePreview").classList.remove("hidden");$("#recordState").textContent="Hazır ses yüklendi";$("#recordStatus").textContent="Yüklenen ses hazır: "+file.name+" · "+(file.size/1024/1024).toFixed(2)+" MB";$("#startRecording").disabled=false;$("#stopRecording").disabled=true;$("#redoRecording").disabled=true;$("#redoRecording").classList.add("hidden");$("#recordIndicator").classList.remove("recording");loadReference()};
window.addEventListener("pagehide",()=>{if(state.recorder&&state.recorder.state!=="inactive")state.recorder.stop();stopTracks()});
\n
const AGENT_SKILLS=[
["yt-audit","Kanal denetimi"],["yt-chapters","Video bölümleri"],["yt-comment","Yorum analizi"],["yt-edit","Kurgu / sessizlik"],["yt-package","Başlık ve kapak"],["yt-plan","Yayın planı"],["yt-retention","İzleyici tutma"],["yt-script","Senaryo ve kancalar"],["yt-seo","YouTube SEO"],["yt-shorts","Uzun videodan Shorts"],["yt-viral","Viral analiz"]
];
function agentFields(){
 const t=$("#agentTool").value, root=$("#agentFields");
 const specs={
 hookscore:[["hook","Kanca metni","textarea"]],
 title:[["title","Video başlığı","input"],["thumb","Kapak metni (isteğe bağlı)","input"]],
 deadair:[["srt","SRT / VTT altyazı içeriği","textarea"],["floor","Sessizlik eşiği (sn) · varsayılan 0.45","input"]],
 chapters:[["srt","SRT / VTT altyazı içeriği","textarea"],["target","Hedef bölüm sayısı · varsayılan 7","input"]],
 retention:[["csv","YouTube retention CSV içeriği","textarea"],["duration","Video süresi (saniye, isteğe bağlı)","input"]],
 viral:[["json","Video verileri JSON içeriği","textarea"]]
 };
 root.innerHTML="";
 (specs[t]||[]).forEach(([id,label,type])=>{
 const wrap=document.createElement("label");wrap.className="field-label";wrap.textContent=label;
 const el=document.createElement(type==="textarea"?"textarea":"input");el.id="agent-"+id;
 if(type==="textarea"){el.rows=5;el.placeholder=id==="srt"?"1\\n00:00:00,000 --> 00:00:02,000\\nKonuşma metni…":id==="csv"?"Elapsed time,Audience retention\\n0,100\\n10,80":"İçeriği buraya yapıştır…"}else{el.type="text";el.placeholder=id==="floor"?"0.45":id==="target"?"7":""}
 wrap.append(el);root.append(wrap);
 });
}
async function loadAgentHub(){
 const root=$("#agentSkills");root.innerHTML="";
 AGENT_SKILLS.forEach(([id,label])=>{const b=document.createElement("button");b.className="agent-skill";b.textContent=label;b.title=id;b.onclick=()=>{const prompt="YouTube Agent görevi: "+label+" ("+id+"). Bu uzmanlık kılavuzunu kullanarak içeriğimi hazırla. Önce gerekli girdileri değerlendir, sonra sonucu ve doğrulama notlarını sun.";navigator.clipboard?.writeText(prompt).then(()=>setStatus("#agentStatus","ChatGPT görev metni kopyalandı: "+label)).catch(()=>setStatus("#agentStatus",prompt));};root.append(b)});
 agentFields();
 const base=engineUrl();if(!base){setStatus("#agentStatus","Video motoru bağlantısı yapılınca ajan araçları etkinleşir.");return}
 try{const r=await fetch(base+"/api/agent/registry",{headers:headers()});if(!r.ok)throw Error("HTTP "+r.status);const data=await r.json();setStatus("#agentStatus",data.skills.length+" uzmanlık · "+data.tools.length+" araç bulundu.")}catch(e){setStatus("#agentStatus","Ajan servisi bağlanamadı: "+e.message)}
}
async function runAgentTool(){
 const tool=$("#agentTool").value,params={};
 const keys={hookscore:["hook"],title:["title","thumb"],deadair:["srt","floor"],chapters:["srt","target"],retention:["csv","duration"],viral:["json"]}[tool];
 keys.forEach(k=>{const el=$("#agent-"+k);if(el)params[k]=el.value.trim()});
 const output=$("#agentOutput"),button=$("#runAgent");
 if(!engineUrl()){setStatus("#agentStatus","Önce Video motoru bölümünden servis adresini kaydet.");return}
 button.disabled=true;button.textContent="Analiz ediliyor…";output.classList.remove("hidden");output.textContent="Ajan aracı çalıştırılıyor…";
 try{const r=await fetch(engineUrl()+"/api/agent/run",{method:"POST",headers:{"Content-Type":"application/json",...headers()},body:JSON.stringify({tool,params})});const data=await r.json();if(!r.ok)throw Error(data.detail||"Araç çalıştırılamadı.");output.textContent=JSON.stringify(data.result,null,2);setStatus("#agentStatus","Analiz tamamlandı · "+tool)}catch(e){output.textContent="Hata: "+e.message;setStatus("#agentStatus","Analiz tamamlanamadı")}finally{button.disabled=false;button.textContent="Analiz aracını çalıştır"}
}
\n\n$("#agentTool").addEventListener("change",agentFields);$("#runAgent").addEventListener("click",runAgentTool);loadAgentHub();\n