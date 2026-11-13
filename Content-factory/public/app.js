const $=s=>document.querySelector(s);
const state={inputMode:"audio",reference:null,referenceUrl:null,videoUrl:null,videoBlob:null,audioUrl:null,creditsUrl:null,jobId:null,jobToken:null,recorder:null,recordChunks:[],recordStream:null,recordTimer:null,recordStarted:0,discardRecordingOnStop:false};
window.cfState=state;
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
function resetResult(){revoke(state.videoUrl);revoke(state.audioUrl);revoke(state.creditsUrl);state.videoUrl=null;state.videoBlob=null;state.audioUrl=null;state.creditsUrl=null;state.jobId=null;state.jobToken=null;localStorage.removeItem("cf-cloud-job-id");localStorage.removeItem("cf-cloud-job-token");$("#finalVideo").removeAttribute("src");$("#finalVideo").load();$("#renderPanel").classList.add("hidden");$("#renderResult").classList.add("hidden");$("#visualReview").classList.add("hidden");$("#visualScenes").innerHTML="";activeReview=null;$("#startRender").disabled=!state.reference||!$("#hookText").value.trim();$("#startRender").textContent="Bulutta Shorts üret";setProgress(0)}
function openShorts(){resetResult();$("#editor").classList.remove("hidden");$("#editor").scrollIntoView({behavior:"smooth"})}
function saveEngine(){localStorage.setItem("cf-engine-url",$("#engineUrl").value.trim());localStorage.setItem("cf-engine-token",$("#engineToken").value.trim());setStatus("#engineStatus","Motor bağlantı ayarları kaydedildi.")}
async function checkEngine(){const base=engineUrl();if(!base){setStatus("#engineStatus","Önce servis adresini gir.");return}setStatus("#engineStatus","Bağlantı kontrol ediliyor…");try{const r=await fetch(base+"/health",{headers:headers()});const j=await r.json();if(!r.ok)throw Error(j.detail||j.error||r.status);if(j.video_renderer!==true)throw Error("Servise ulaşıldı ancak FFmpeg video motoru çalışmıyor.");setStatus("#engineStatus","Bağlantı başarılı · MP4 motoru hazır.")}catch(e){setStatus("#engineStatus","Bağlantı kurulamadı: "+e.message)}}
function loadReference(){const ok=!!state.reference;$("#recordStatus").textContent=!ok?"Henüz mikrofon kaydı veya ses dosyası seçilmedi.":$("#hookText").value.trim()?"Ses ve kanca hazır. Ses otomatik çözümlenecek.":"Ses hazır. Kanca cümlesini ekle.";$("#startRender").disabled=!ok||!$("#hookText").value.trim()}
async function downloadBlob(blob,name){if(!blob||!blob.size)throw Error("MP4 dosyası hazır değil. Videoyu yeniden oluştur.");const file=new File([blob],name,{type:blob.type||"video/mp4"});if(navigator.share&&navigator.canShare?.({files:[file]})){await navigator.share({files:[file],title:name});return "share"}const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=name;a.rel="noopener";a.style.display="none";document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),300000);return "download"}
async function fetchBlob(path){const r=await fetch(engineUrl()+path,{headers:headers()});if(!r.ok){let message="Dosya indirilemedi ("+r.status+")";try{const j=await r.json();message=j.detail||j.error||message}catch{}throw Error(message)}return await r.blob()}
async function approveAndRender(){
 const title=$("#hookText").value.trim().slice(0,120)||"Content Factory Shorts",hook=$("#hookText").value.trim(),button=$("#startRender"),script=$("#scriptInput").value.trim();
 if(!hook){setStatus("#recordStatus","Her video için üstte görünecek kanca yazısını gir.");$("#hookText").focus();return}
 if(state.inputMode==="audio"&&!state.reference){setStatus("#recordStatus","Önce mikrofonla kaydet veya hazır ses dosyası seç.");return}if(state.inputMode==="text"&&!script){setStatus("#recordStatus","Önce paragraf metnini gir.");return}
 button.disabled=true;button.textContent="Bulut kuyruğuna yükleniyor…";
 $("#renderPanel").classList.remove("hidden");$("#renderResult").classList.add("hidden");setProgress(2);
 setStatus("#renderStatus","Ses, metin ve referans materyalleri güvenli geçici bulut alanına yükleniyor…");
 try{
  const fd=new FormData();fd.append("title",title);fd.append("hook",hook);
  fd.append("input_mode",state.inputMode);if(state.inputMode==="audio")fd.append("audio",state.reference,state.reference.name||"narration-audio");else fd.append("text",script);
  
  const response=await fetch("/api/shorts/jobs",{method:"POST",body:fd});
  const job=await response.json();if(!response.ok)throw Error(job.error||"Bulut işi başlatılamadı.");
  state.jobId=job.job_id;state.jobToken=job.job_token;
  localStorage.setItem("cf-cloud-job-id",state.jobId);localStorage.setItem("cf-cloud-job-token",state.jobToken);
  setStatus("#renderStatus","Bulut render başlatıldı. Safari'yi kapatsan da render devam eder.");
  await pollCloudJob(state.jobId,title);
  button.textContent="Video hazır";
 }catch(error){
  setStatus("#renderStatus","İş başlatılamadı: "+error.message);
  button.disabled=false;button.textContent="Tekrar dene · Bulutta Shorts üret";
 }
}

let activeReview=null;
function escHtml(value){return String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));}
function showVisualReview(job){
 const review=job.review;
 if(!review||!Array.isArray(review.scenes)||!review.scenes.length)throw Error("Görsel inceleme listesi alınamadı.");
 activeReview=review;
 $("#visualReview").classList.remove("hidden");
 $("#renderPanel").classList.remove("hidden");
 $("#renderResult").classList.add("hidden");
 $("#visualScenes").innerHTML=review.scenes.map(scene=>{
  const options=scene.options.map((option,index)=>{
   const asset=encodeURIComponent(option.asset);
   const url="/api/shorts/jobs/"+encodeURIComponent(state.jobId)+"/"+asset+"?token="+encodeURIComponent(state.jobToken);
   return '<label style="display:inline-block;vertical-align:top;width:min(46%,240px);margin:6px;padding:8px;border:1px solid #777;border-radius:12px;cursor:pointer"><input type="radio" name="scene-'+scene.index+'" value="'+escHtml(option.id)+'" '+(index===0?"checked":"")+'><img src="'+url+'" alt="Sahne görseli" style="width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;margin-top:6px"><strong style="display:block;font-size:13px;margin-top:5px">'+escHtml(option.title)+'</strong><small>'+escHtml(option.source)+' · '+escHtml(option.license)+'</small>'+(option.page_url?'<br><a href="'+escHtml(option.page_url)+'" target="_blank" rel="noopener">Kaynağı aç</a>':"")+'</label>';
  }).join("");
  return '<section style="padding:14px 0;border-bottom:1px solid #777"><strong>Sahne '+scene.index+' · '+Number(scene.start).toFixed(1)+'–'+Number(scene.end).toFixed(1)+' sn</strong><p>'+escHtml(scene.text)+'</p><div>'+options+'</div></section>';
 }).join("");
 $("#visualReviewStatus").textContent=review.scenes.length+" sahne için görsel seçenekleri hazır. Her sahnede bir görsel seç.";
 $("#approveVisuals").disabled=false;
}
async function approveVisualSelection(){
 if(!activeReview||!state.jobId||!state.jobToken)return;
 const selections={};
 for(const scene of activeReview.scenes){
  const chosen=document.querySelector('input[name="scene-'+scene.index+'"]:checked');
  if(!chosen){setStatus("#visualReviewStatus","Sahne "+scene.index+" için bir görsel seç.");return;}
  selections[String(scene.index)]=chosen.value;
 }
 const button=$("#approveVisuals");button.disabled=true;button.textContent="Onay gönderiliyor…";
 try{
  const response=await fetch("/api/shorts/jobs/"+encodeURIComponent(state.jobId),{method:"POST",headers:{"X-Job-Token":state.jobToken,"Content-Type":"application/json"},body:JSON.stringify({selections})});
  const data=await response.json();if(!response.ok)throw Error(data.error||"Görsel onayı kaydedilemedi.");
  $("#visualReview").classList.add("hidden");
  setStatus("#renderStatus","Görseller onaylandı. Video yalnızca seçtiğin görsellerle hazırlanıyor.");
  await pollCloudJob(state.jobId,$("#hookText").value.trim()||"Shorts");
 }catch(error){setStatus("#visualReviewStatus","Onay başarısız: "+error.message);button.disabled=false;button.textContent="Tekrar dene · Seçimlerimi onayla";}
}

async function pollCloudJob(id,title){
 let lastMessage="";
 for(let attempt=0;attempt<7200;attempt++){
  const response=await fetch("/api/shorts/jobs/"+encodeURIComponent(id),{headers:{"X-Job-Token":state.jobToken,"Cache-Control":"no-store"}});
  if(!response.ok){let msg="İş durumu okunamadı ("+response.status+").";try{msg=(await response.json()).error||msg}catch{}throw Error(msg)}
  const job=await response.json();setProgress(job.progress||3);
  if(job.message&&job.message!==lastMessage){setStatus("#renderStatus",job.message);lastMessage=job.message}
  if(job.status==="awaiting_approval"){showVisualReview(job);setStatus("#renderStatus","Görsel araştırması tamamlandı. Videoyu üretmek için sahneleri onayla.");$("#startRender").textContent="Görseller onay bekliyor";return;}
  if(job.status==="failed"){$("#deleteCloudProject").classList.remove("hidden");$("#deleteCloudProject").textContent="Başarısız projeyi ve dosyaları sil";$("#renderCleanupStatus").textContent="Bu iş başarısız oldu. Geçici bulut dosyalarını hemen temizleyebilirsin.";throw Error(job.error||"Bulut render başarısız oldu.");}
  if(job.status==="completed"){
   const headers={"X-Job-Token":state.jobToken};
   async function output(name){const r=await fetch("/api/shorts/jobs/"+encodeURIComponent(id)+"/"+name,{headers});if(!r.ok){let msg="Çıktı indirilemedi ("+r.status+").";try{msg=(await r.json()).error||msg}catch{}throw Error(msg)}return r.blob()}
   const [video,audio,credits]=await Promise.all([output("video"),output("audio"),output("credits")]);
   revoke(state.videoUrl);revoke(state.audioUrl);revoke(state.creditsUrl);
   state.videoBlob=video;state.videoUrl=URL.createObjectURL(video);state.audioUrl=URL.createObjectURL(audio);state.creditsUrl=URL.createObjectURL(credits);
   $("#finalVideo").src=state.videoUrl;
   $("#renderStats").textContent="Süre: "+Number(job.duration||0).toFixed(1)+" sn · Sessizlik azaltıldı: "+Number(job.removed_silence||0).toFixed(1)+" sn · Görsel sahne: "+(job.scene_count||0)+" · Bulutta render edildi";
   $("#renderCleanupStatus").textContent="Geçici proje, indirme onayından sonra hemen silinir. Onay gelmezse 24 saat içinde otomatik temizlenir.";
   $("#deleteCloudProject").classList.add("hidden");$("#deleteCloudProject").textContent="İndirdim, projeyi sil";
   $("#renderResult").classList.remove("hidden");setProgress(100);
   setStatus("#renderStatus","MP4 hazır. Şimdi iPhone'una indir; indirme tamamlanınca proje dosyalarını sil.");
   return;
  }
  await new Promise(resolve=>setTimeout(resolve,3000));
 }
 throw Error("İş 6 saat içinde tamamlanmadı. Bulut işçisi/GitHub Actions durumunu kontrol et.");
}
async function resumeCloudJob(){
 const id=localStorage.getItem("cf-cloud-job-id"),token=localStorage.getItem("cf-cloud-job-token");
 if(!id||!token)return;
 state.jobId=id;state.jobToken=token;
 $("#editor").classList.remove("hidden");$("#renderPanel").classList.remove("hidden");
 $("#startRender").disabled=true;$("#startRender").textContent="Bulut işi sürüyor…";
 try{await pollCloudJob(id,$("#hookText").value.trim()||"Shorts");$("#startRender").textContent="Video hazır";}
 catch(error){setStatus("#renderStatus","Kayıtlı bulut işi: "+error.message);$("#startRender").disabled=false;$("#startRender").textContent="Tekrar dene · Bulutta Shorts üret";}
}
async function deleteCloudProject(options={}){
  if(!state.jobId||!state.jobToken)return;
  const preserveLocalOutput=options.preserveLocalOutput===true;
  const button=$("#deleteCloudProject");button.disabled=true;button.textContent="Bulut dosyaları siliniyor…";
  try{
   const response=await fetch("/api/shorts/jobs/"+encodeURIComponent(state.jobId),{method:"DELETE",headers:{"X-Job-Token":state.jobToken}});
   const data=await response.json();if(!response.ok)throw Error(data.error||"Silme başarısız.");
   state.jobId=state.jobToken=null;
   localStorage.removeItem("cf-cloud-job-id");localStorage.removeItem("cf-cloud-job-token");
   try{await deleteVoice()}catch{}
   state.reference=null;
   $("#audioFile").value="";$("#visualFiles").value="";$("#scriptText").value="";$("#referencePreview").removeAttribute("src");$("#referencePreview").classList.add("hidden");
   if(!preserveLocalOutput){
    revoke(state.videoUrl);revoke(state.audioUrl);revoke(state.creditsUrl);
    state.videoUrl=state.videoBlob=state.audioUrl=state.creditsUrl=null;
    $("#renderResult").classList.add("hidden");
    $("#renderStatus").textContent="Proje temizlendi. Bulut ses, metin, görseller, ara dosyalar ve MP4 silindi.";
   }else{
    $("#renderStatus").textContent="MP4 telefona aktarıldı. Buluttaki ses, metin, görseller, ara dosyalar ve MP4 otomatik silindi.";
    $("#renderCleanupStatus").textContent="Bulut temizliği tamamlandı. MP4'ün yerel kopyası bu ekranda açık kalır.";
   }
   $("#hookText").value="";$("#topicTitle").value="";
   $("#deleteCloudProject").classList.add("hidden");$("#deleteCloudProject").textContent="İndirdim, projeyi sil";
   $("#recordStatus").textContent="Geçici proje dosyaları silindi. Yeni Shorts için ses veya metin ekleyebilirsin.";
   $("#startRender").disabled=true;$("#startRender").textContent="Bulutta Shorts üret";
  }catch(error){setStatus("#renderStatus","Silme işlemi tamamlanamadı: "+error.message);button.disabled=false;button.textContent="Bulut dosyalarını yeniden sil";}
 }
$("#settingsToggle").onclick=()=>$("#engineSettings").classList.toggle("hidden");
// The iPhone is only a control panel; rendering runs in the GitHub Actions cloud worker.
$("#startShorts").onclick=openShorts;
$("#closeEditor").onclick=()=>$("#editor").classList.add("hidden");

$("#hookText").oninput=updateStartButton;function updateStartButton(){const ready=state.inputMode==="text"?!!$("#scriptInput").value.trim():!!state.reference;$("#startRender").disabled=!ready||!$("#hookText").value.trim();}function setInputMode(mode){state.inputMode=mode;const text=mode==="text";$("#audioInputPanel").classList.toggle("hidden",text);$("#textInputPanel").classList.toggle("hidden",!text);$("#audioModeBtn").className="btn "+(!text?"btn-primary":"btn-ghost");$("#textModeBtn").className="btn "+(text?"btn-primary":"btn-ghost");updateStartButton();$("#recordStatus").textContent=text?"Metin modu seçildi.":"Ses modu seçildi.";}$("#audioModeBtn").onclick=()=>setInputMode("audio");$("#textModeBtn").onclick=()=>setInputMode("text");$("#scriptInput").oninput=()=>{$("#scriptInputCount").textContent=$("#scriptInput").value.length.toLocaleString("tr-TR")+" / 30.000 karakter";updateStartButton();};
$("#startRender").onclick=approveAndRender;$("#approveVisuals").onclick=approveVisualSelection;$("#deleteCloudProject").onclick=deleteCloudProject;
$("#downloadVideo").onclick=async()=>{const button=$("#downloadVideo");button.disabled=true;try{const name=($("#hookText").value.trim()||"shorts").replace(/[^a-z0-9-_]/gi,"_")+".mp4";const method=await downloadBlob(state.videoBlob,name);if(state.jobId&&state.jobToken)await deleteCloudProject({preserveLocalOutput:true});else $("#renderCleanupStatus").textContent=method==="share"?"MP4 paylaşım işlemi tamamlandı.":"MP4 indirme işlemi başlatıldı.";}catch(error){if(error.name!=="AbortError")setStatus("#renderCleanupStatus","MP4 aktarımı veya bulut temizliği tamamlanamadı: "+error.message+" · Tekrar dene.");}finally{button.disabled=false;}};
$("#downloadCleanAudio").onclick=()=>downloadBlob(state.audioUrl,"shorts-cleaned-voice.wav");
$("#downloadCredits").onclick=()=>downloadBlob(state.creditsUrl,"sources-and-licenses.txt");
$("#nextTopic").onclick=()=>{$("#hookText").value="";resetResult();$("#renderPanel").classList.add("hidden");$("#editor").scrollIntoView({behavior:"smooth"});};
$("#engineUrl").value="";$("#engineToken").value="";loadReference();


function stopTracks(){if(state.recordStream){state.recordStream.getTracks().forEach(t=>t.stop());state.recordStream=null}}
function timerTick(){const seconds=Math.floor((Date.now()-state.recordStarted)/1000);$("#recordTimer").textContent=String(Math.floor(seconds/60)).padStart(2,"0")+":"+String(seconds%60).padStart(2,"0")}
async function startRecording(){if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){$("#recordStatus").textContent="Bu tarayıcı mikrofon kaydını desteklemiyor. iPhone Safari'de siteye mikrofon izni verip tekrar dene.";return}try{state.recordStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});const types=["audio/mp4","audio/webm;codecs=opus","audio/webm"];const mime=types.find(t=>MediaRecorder.isTypeSupported?.(t));state.recorder=new MediaRecorder(state.recordStream,mime?{mimeType:mime}:undefined);state.recordChunks=[];state.recorder.ondataavailable=e=>{if(e.data?.size)state.recordChunks.push(e.data)};state.recorder.onstop=()=>{if(state.discardRecordingOnStop){state.discardRecordingOnStop=false;stopTracks();return}const blob=new Blob(state.recordChunks,{type:state.recorder.mimeType||"audio/mp4"});if(blob.size<5000){$("#recordStatus").textContent="Kayıt çok kısa veya boş. Lütfen yeniden dene.";state.reference=null}else{const ext=blob.type.includes("mp4")?"m4a":"webm";state.reference=new File([blob],"my-voice-reference."+ext,{type:blob.type});revoke(state.referenceUrl);state.referenceUrl=URL.createObjectURL(state.reference);$("#referencePreview").src=state.referenceUrl;$("#referencePreview").classList.remove("hidden");$("#recordStatus").textContent="Mikrofon kaydı hazır: "+(blob.size/1024/1024).toFixed(2)+" MB."}stopTracks();$("#recordState").textContent="Kayıt tamamlandı";$("#recordIndicator").classList.remove("recording");$("#startRecording").disabled=false;$("#stopRecording").disabled=true;$("#redoRecording").disabled=false;$("#redoRecording").classList.remove("hidden");loadReference()};state.recordStarted=Date.now();state.recorder.start(250);$("#recordState").textContent="Kayıt yapılıyor";$("#recordIndicator").classList.add("recording");$("#startRecording").disabled=true;$("#stopRecording").disabled=false;$("#redoRecording").disabled=true;$("#recordTimer").textContent="00:00";state.recordTimer=setInterval(timerTick,250);$("#recordStatus").textContent="Konuşabilirsin. Kaydı bitirdiğinde ses bu sayfada hazırlanacak."}catch(e){stopTracks();$("#recordStatus").textContent="Mikrofon açılamadı: "+e.message+" · iPhone Ayarlar > Safari > Mikrofon izinlerini kontrol et."}}
function stopRecording(){if(state.recordTimer){clearInterval(state.recordTimer);state.recordTimer=null}if(state.recorder&&state.recorder.state!=="inactive")state.recorder.stop()}
$("#startRecording").onclick=()=>{state.reference=null;revoke(state.referenceUrl);state.referenceUrl=null;$("#audioFile").value="";$("#referencePreview").removeAttribute("src");$("#referencePreview").classList.add("hidden");loadReference();startRecording()};$("#stopRecording").onclick=stopRecording;$("#redoRecording").onclick=()=>{state.reference=null;revoke(state.referenceUrl);state.referenceUrl=null;$("#audioFile").value="";$("#referencePreview").removeAttribute("src");$("#referencePreview").classList.add("hidden");$("#recordTimer").textContent="00:00";loadReference();startRecording()};$("#audioFile").onchange=e=>{const file=e.target.files?.[0];if(!file)return;const audioExt=/\.(mp3|m4a|wav|aac|mp4|mpeg|mpga|ogg|opus|webm|flac)$/i.test(file.name);const audioMime=/^(audio\/|video\/mp4$|application\/octet-stream$)/i.test(file.type||"");if(!audioExt&&!audioMime){alert("Lütfen MP3, M4A, WAV, AAC veya desteklenen bir ses dosyası seç.");e.target.value="";return}if(file.size>30*1024*1024){alert("Ses dosyası en fazla 30 MB olabilir.");e.target.value="";return}if(state.recorder&&state.recorder.state!=="inactive"){state.discardRecordingOnStop=true;state.recorder.stop()}stopTracks();revoke(state.referenceUrl);state.reference=file;state.referenceUrl=URL.createObjectURL(file);$("#referencePreview").src=state.referenceUrl;$("#referencePreview").classList.remove("hidden");$("#recordState").textContent="Hazır ses yüklendi";$("#recordStatus").textContent="Yüklenen ses hazır: "+file.name+" · "+(file.size/1024/1024).toFixed(2)+" MB";$("#startRecording").disabled=false;$("#stopRecording").disabled=true;$("#redoRecording").disabled=true;$("#redoRecording").classList.add("hidden");$("#recordIndicator").classList.remove("recording");loadReference()};
window.addEventListener("pagehide",()=>{if(state.recorder&&state.recorder.state!=="inactive")state.recorder.stop();stopTracks()});

const AGENT_SKILLS=[
{id:"yt-audit",label:"Kanal denetimi",mode:"chat",description:"Kanalını paketleme, içerik kalitesi, yayın düzeni ve izleyici tutma açısından değerlendirir. Sonunda tek öncelikli iyileştirme verir.",help:"Kanal bağlantısını gir. Son 10 başlığı ve son 3 videonun ilk 15 saniyesini eklersen denetim çok daha somut olur.",fields:[["channelUrl","YouTube kanal bağlantısı","input","https://www.youtube.com/@kanaladi",true],["recentTitles","Son 10 video başlığı (her satıra bir başlık)","textarea","Başlıkları alt alta yapıştır…",false],["recentOpeners","Son 3 videonun ilk 15 saniyesi / açılış metni","textarea","Video 1: …\nVideo 2: …\nVideo 3: …",false],["uploadRhythm","Yayın sıklığı / son yayın tarihleri","input","Örn. haftada 2 Shorts, ayda 1 uzun video",false],["retentionCsv","Varsa izleyici tutma CSV verisi","textarea","İsteğe bağlı: CSV içeriğini yapıştır…",false]]},
{id:"yt-chapters",label:"Video bölümleri",mode:"tool",tool:"chapters",description:"Zaman damgalı altyazıdan YouTube bölümleri için taslak çıkarır.",help:"SRT veya VTT altyazı içeriğini ekle. İlk bölüm 00:00 olmalı ve bölümler en az 10 saniye sürmelidir.",fields:[["srt","SRT / VTT altyazı içeriği","textarea","1\n00:00:00,000 --> 00:00:03,000\nKonuşma metni…",true],["target","Hedef bölüm sayısı","input","7",false]]},
{id:"yt-comment",label:"Yorum analizi",mode:"chat",description:"Yorumları soru, düzeltme, olumlu geri bildirim ve cevap verilmemesi gereken kışkırtmalar olarak ayırır; cevap taslakları hazırlar.",help:"Yorumları mümkünse her satıra bir tane gelecek şekilde yapıştır. Kullanıcı adı veya özel bilgi eklemek zorunda değilsin.",fields:[["comments","YouTube yorumları","textarea","Yorumları buraya yapıştır…",true],["voice","Cevap üslubu / dikkat edilecek noktalar","textarea","Kısa, doğal, samimi; doğrulanmamış iddia yok…",false]]},
{id:"yt-edit",label:"Kurgu / sessizlik",mode:"tool",tool:"deadair",description:"SRT/VTT altyazı zamanlarına göre uzun duraklamaları ve dolgu ifadelerini işaretler.",help:"Bu araç videoyu doğrudan kesmez; CapCut'ta uygulayabileceğin zaman kodlu kesim listesi üretir.",fields:[["srt","SRT / VTT altyazı içeriği","textarea","Altyazı dosyasının metnini yapıştır…",true],["floor","Korunacak sessizlik eşiği (saniye)","input","0.45",false]]},
{id:"yt-package",label:"Başlık ve kapak",mode:"tool",tool:"title",description:"Başlığın uzunluğunu, mobil görünümünü ve kapak metniyle tekrarını kontrol eder.",help:"Bu kontrol başlık kalitesine dair teknik uyarı verir; tıklanma oranını garanti etmez.",fields:[["title","Video başlığı","input","Başlığı yaz…",true],["thumb","Kapak metni (isteğe bağlı)","input","Kapakta görünen kısa metin…",false]]},
{id:"yt-plan",label:"Yayın planı",mode:"chat",description:"Gerçek zamanına ve hazırladığın işlere uygun haftalık veya aylık YouTube yayın planı hazırlar.",help:"Planı gerçek kapasiteye göre kurmak için haftalık zamanını ve yarım kalmış içeriklerini belirt.",fields:[["hours","Haftalık ayırabileceğin süre","input","Örn. 8 saat",true],["unfinished","Hazır veya yarım kalmış işler","textarea","Hazır videolar, çekilmiş sesler, taslaklar…",false],["goal","Hedeflenen yayın sayısı ve format","input","Örn. 3 Shorts + 1 uzun video",false],["analytics","YouTube Studio'dan bilinen iyi yayın gün/saatleri","input","Bilmiyorsan boş bırak",false]]},
{id:"yt-retention",label:"İzleyici tutma",mode:"tool",tool:"retention",description:"YouTube Studio retention CSV verisindeki açılış kaybını ve en sert düşüşleri bulur.",help:"CSV içeriğini YouTube Studio dışa aktarımından yapıştır. Sütunlar zaman/konum ve izleyici tutma yüzdesi olmalı.",fields:[["csv","Audience retention CSV içeriği","textarea","CSV içeriğini yapıştır…",true],["duration","Video süresi (saniye, isteğe bağlı)","input","Örn. 615",false]]},
{id:"yt-script",label:"Senaryo ve kancalar",mode:"chat",description:"21 kanca yaklaşımından beş açılış alternatifi, puanlama ve ekranda görülecek sahnelerle senaryo hazırlar.",help:"Konu, hedef izleyici ve istediğin süreyi belirt. Senaryoda kaynak gerektiren iddialar doğrulanmalı.",fields:[["topic","Video konusu / fikri","textarea","Videonun fikrini anlat…",true],["audience","Hedef izleyici","input","Örn. Türkçe Shorts izleyicisi",false],["duration","Hedef süre ve format","input","Örn. 40–45 saniye, 9:16 Shorts",false],["constraints","Üslup ve özel kurallar","textarea","Ton, yasaklı ifadeler, kaynak beklentisi…",false],["hookCandidates","Puanlamak istediğin kanca taslakları (her satıra bir tane)","textarea","Kancaları alt alta yapıştır…",false]]},
{id:"yt-seo",label:"YouTube SEO",mode:"chat",description:"Arama niyetine göre başlık, ilk iki açıklama satırı, açıklama ve anlamlı etiketler üretir.",help:"Anahtar kelimeyi ve videonun gerçekten ne sunduğunu belirt. Alakasız etiket doldurmayacağız.",fields:[["topic","Video konusu ve içeriğin özeti","textarea","Video ne anlatıyor?…",true],["keyword","Öncelikli arama ifadesi","input","İzleyicinin arayacağı ifade…",false],["title","Mevcut başlık (varsa)","input","Mevcut başlık…",false],["audience","Hedef izleyici / dil","input","Örn. Türkiye, Türkçe",false]]},
{id:"yt-shorts",label:"Uzun videodan Shorts",mode:"chat",description:"Uzun videonun altyazısından tek başına anlaşılabilen, 20–55 saniyelik Shorts adayları bulur.",help:"Zaman kodlu SRT/VTT altyazıyı ekle. En iyi beş kesit için zaman aralığı, yeni kanca ve döngü fikri hazırlanır.",fields:[["transcript","Zaman kodlu SRT / VTT altyazı","textarea","Altyazıyı buraya yapıştır…",true],["count","İstenen Shorts adedi","input","5",false],["style","Kurgu / anlatım tercihi","textarea","Sessiz, konuşmalı, altyazılı, yüz kamerası…",false]]},
{id:"yt-viral",label:"Viral analiz",mode:"tool",tool:"viral",description:"Verdiğin video listesini her kanalın kendi medyan görüntülenmesiyle karşılaştırır.",help:"Her kanaldan en az dört video içeren JSON verisi gerekir. Araç YouTube'dan otomatik veri çekmez.",fields:[["json","Video verileri JSON","textarea",'[{"channel":"Kanal","title":"Video başlığı","views":120000,"url":"https://..."}]',true]]}
];
let activeSkill=null;
function skillById(id){return AGENT_SKILLS.find(x=>x.id===id)}
function renderSkillInputs(skill){
 const root=$("#skillInputs");root.innerHTML="";
 skill.fields.forEach(([id,label,type,placeholder,required])=>{
  const wrap=document.createElement("label");wrap.className="skill-field";
  const cap=document.createElement("span");cap.textContent=label+(required?" *":"");wrap.append(cap);
  const el=document.createElement(type==="textarea"?"textarea":"input");el.id="skill-"+id;el.placeholder=placeholder||"";el.required=!!required;
  if(type==="textarea")el.rows=id==="recentTitles"?5:7;
  wrap.append(el);root.append(wrap);
 });
}
function selectSkill(id){
 const skill=skillById(id);if(!skill)return;activeSkill=skill;
 document.querySelectorAll(".agent-skill").forEach(b=>b.classList.toggle("active",b.dataset.skill===id));
 $("#skillTitle").textContent=skill.label;$("#skillDescription").textContent=skill.description;
 $("#skillMode").textContent=skill.mode==="tool"?"PANELDE ÇALIŞAN ANALİZ":"CHATGPT GÖREVİ";
 $("#skillHelp").textContent=skill.help;
 $("#skillAction").textContent=skill.mode==="tool"?"Analizi şimdi çalıştır":"Denetim / görev paketini hazırla";$("#scoreHooks").classList.toggle("hidden",skill.id!=="yt-script");
 $("#skillResult").classList.add("hidden");$("#skillResult").replaceChildren();
 $("#skillPromptWrap").classList.add("hidden");$("#skillPrompt").value="";
 renderSkillInputs(skill);$("#skillWorkspace").classList.remove("hidden");
 $("#skillWorkspace").scrollIntoView({behavior:"smooth",block:"start"});
 setStatus("#agentStatus",skill.label+" çalışma ekranı açık. Gerekli bilgileri doldur.");
}
function setStatus(selector,message){$(selector).textContent=message}
function collectSkillParams(skill){
 const values={};let missing=[];
 skill.fields.forEach(([id,label,,placeholder,required])=>{const el=$("#skill-"+id);const value=(el?.value||"").trim();values[id]=value;if(required&&!value)missing.push(label)});
 if(missing.length)throw Error("Önce şu alanları doldur: "+missing.join(", "));
 return values;
}
function appendLine(root,label,value){
 const row=document.createElement("div");row.className="result-line";
 const b=document.createElement("b");b.textContent=label;const p=document.createElement("span");p.textContent=String(value??"");
 row.append(b,p);root.append(row);
}
function renderToolResult(tool,data){
 const root=$("#skillResult");root.replaceChildren();root.classList.remove("hidden");
 const heading=document.createElement("h4");heading.textContent="Analiz sonucu";root.append(heading);
 if(tool==="title"){appendLine(root,"Puan",data.score+"/100");appendLine(root,"Başlık",data.title);(data.good||[]).forEach(x=>appendLine(root,"Olumlu",x));(data.issues||[]).forEach(x=>appendLine(root,"Düzelt",x))}
 else if(tool==="deadair"){appendLine(root,"Orijinal süre",data.duration+" sn");appendLine(root,"İşaretlenen kesinti",data.removed_seconds+" sn");appendLine(root,"Tahmini son süre",data.estimated_output_seconds+" sn");(data.cuts||[]).forEach(x=>appendLine(root,x.kind,x.start+"–"+x.end+" sn · "+x.why));}
 else if(tool==="chapters"){appendLine(root,"Bölüm kontrolü",data.valid?"Taslak uygun":"Taslak kontrol edilmeli");(data.chapters||[]).forEach(x=>appendLine(root,x.label,x.draft_title+" · "+x.seconds+" sn"))}
 else if(tool==="retention"){appendLine(root,"Açılış kaybı",data.hook_loss+" puan");appendLine(root,"Başlangıç / bitiş",data.start+"% / "+data.end+"%");(data.largest_drops||[]).forEach(x=>appendLine(root,"Düşüş",x.from+" → "+x.to+" · -"+x.lost+"%"))}
 else if(tool==="viral"){appendLine(root,"Öne çıkan video sayısı",(data.outliers||[]).length);(data.outliers||[]).slice(0,10).forEach(x=>appendLine(root,x.channel,x.title+" · "+x.multiple+"× kanal medyanı"))}
 else {appendLine(root,"Sonuç",JSON.stringify(data))}
 if(data.note)appendLine(root,"Not",data.note);
}
function buildChatPrompt(skill,values){
 const task={
 "yt-audit":"YouTube kanalını baştan sona denetle. Kanal bağlantısını web üzerinden incele; erişilemeyen veya doğrulanamayan veriyi açıkça belirt. Son 10 başlığı bir set olarak, küçük ekranda kapak okunabilirliğini, son 3 videonun ilk 15 saniyesini, yükleme düzenini ve varsa retention verisini değerlendir. Yirmi maddelik genel liste çıkarma: tek en önemli düzeltmeyi seç. Ayrıca somut olarak çalışan üç şeyi, henüz dokunulmaması gerekenleri ve bu hafta yapılacak tek eylemi yaz. Kaynak ve gözlemleri birbirinden ayır.",
 "yt-comment":"Yorumları önce soru, düzeltme, olumlu geri bildirim ve bait olarak sayısal şekilde ayır. Sonra yalnızca uygun olanlara 30 kelimenin altında, doğal cevaplar hazırla. Doğrulanamayan düzeltmelerle tartışma; bait yorumlarına cevap önermeme. Sabitlenecek tek yorumu gerekçesiyle öner.",
 "yt-plan":"Gerçek kapasiteye göre haftalık yayın planı hazırla. Önce haftalık saat ve yarım kalmış işler bilgisini dikkate al. Bir ana video, bir düşük maliyetli içerik ve ana videodan türetilen üç Shorts öner. Gün/saat verisi yoksa yayın günlerini uydurma.",
 "yt-script":"YouTube senaryosu üret. Beş farklı açılış kancası yaz, her birini kanca kriterlerine göre karşılaştır ve en iyi ikisini seç. Sonra açılış, merak dönüşü, gelişme, payoff ve kapanıştan oluşan konuşma metnini hazırla. Her bölüm için [EKRANDA] görsel yönü ver. Süreyi yaklaşık 150 kelime/dakika ile hesapla. Sayısal iddia veya kaynak uydurma.",
 "yt-seo":"Arama niyetini tanımla. Üç gerçek arama sorgusu, bunlarla uyumlu başlık, ilk iki açıklama satırı, tam açıklama ve en fazla 15 alakalı etiket üret. Başlık ve açıklama gerçekte videoda olmayan bir vaat içermesin.",
 "yt-shorts":"Transkriptten bağlam olmadan da anlaşılabilen 20–55 saniyelik bölümleri bul. En iyi beş adayı zaman kodları ve ilk cümleleriyle sırala. Her biri için yeni açılış kancası, ilk 2 saniye ekran yazısı, kapanış/döngü ve 9:16 kadraj notu yaz."
 }[skill.id];
 return "CONTENT FACTORY · "+skill.label.toUpperCase()+"\n\nGÖREV\n"+task+"\n\nKULLANICI GİRDİLERİ\n"+Object.entries(values).map(([k,v])=>k.toUpperCase()+":\n"+(v||"(verilmedi)")).join("\n\n")+"\n\nÇALIŞMA KURALLARI\n- Bu konuşmada ChatGPT olarak çalış; Claude veya harici ücretli API kullanma.\n- Verilmeyen veriyi uydurma; eksikse sor veya belirsizliğini açıkla.\n- Gerekliyse güncel ve kamuya açık bilgileri web üzerinden doğrula, kaynakları belirt.\n- Sonucu uygulanabilir ve Türkçe hazırla.\n- Hiçbir şeyi kullanıcı onayı olmadan yayımlama.\n\nSonunda sor: Onaylıyor musun, değiştirelim mi?";
}
async function runSelectedSkill(){
 if(!activeSkill)return;
 const button=$("#skillAction");button.disabled=true;
 try{
  const values=collectSkillParams(activeSkill);
  if(activeSkill.mode==="tool"){
   button.textContent="Analiz çalışıyor…";setStatus("#agentStatus",activeSkill.label+" verisi analiz ediliyor.");
   const params={};
   if(activeSkill.id==="yt-package"){params.title=values.title;params.thumb=values.thumb}
   if(activeSkill.id==="yt-edit"){params.srt=values.srt;params.floor=values.floor||"0.45"}
   if(activeSkill.id==="yt-chapters"){params.srt=values.srt;params.target=values.target||"7"}
   if(activeSkill.id==="yt-retention"){params.csv=values.csv;params.duration=values.duration||""}
   if(activeSkill.id==="yt-viral"){params.json=values.json}
   const response=await fetch("/api/agent/run",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tool:activeSkill.tool,params})});
   const result=await response.json();if(!response.ok)throw Error(result.detail||"Analiz başarısız.");
   renderToolResult(activeSkill.tool,result.result);setStatus("#agentStatus",activeSkill.label+" tamamlandı. Sonuç aşağıda.");
  }else{
   const prompt=buildChatPrompt(activeSkill,values);$("#skillPrompt").value=prompt;$("#skillPromptWrap").classList.remove("hidden");
   $("#skillResult").classList.add("hidden");setStatus("#agentStatus","Görev paketi hazır. Şimdi kopyalayıp bu ChatGPT sohbetine yapıştır.");
   $("#skillPromptWrap").scrollIntoView({behavior:"smooth",block:"nearest"});
  }
 }catch(e){setStatus("#agentStatus",e.message);$("#skillResult").classList.remove("hidden");$("#skillResult").textContent="İşlem yapılamadı: "+e.message}
 finally{button.disabled=false;button.textContent=activeSkill?.mode==="tool"?"Analizi şimdi çalıştır":"Görev paketini oluştur"}
}
async function scoreHookCandidates(){
 const raw=$("#skill-hookCandidates")?.value||"";
 const hooks=raw.split(/\\r?\\n/).map(x=>x.trim()).filter(Boolean).slice(0,10);
 if(!hooks.length){setStatus("#agentStatus","Önce puanlanacak kanca taslaklarını alt alta yaz.");return}
 const button=$("#scoreHooks");button.disabled=true;button.textContent="Kancalar puanlanıyor…";
 try{
  const scored=await Promise.all(hooks.map(async hook=>{const r=await fetch("/api/agent/run",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tool:"hookscore",params:{hook}})});const d=await r.json();if(!r.ok)throw Error(d.detail||"Kanca puanlanamadı.");return d.result}));
  scored.sort((a,b)=>b.score-a.score);const root=$("#skillResult");root.replaceChildren();root.classList.remove("hidden");
  const heading=document.createElement("h4");heading.textContent="Kanca puanları · en güçlüden en zayıfa";root.append(heading);
  scored.forEach((x,i)=>appendLine(root,"#"+(i+1)+" · "+x.score+"/100",x.hook+" · "+x.verdict+" · En zayıf alan: "+x.weakest));
  setStatus("#agentStatus",scored.length+" kanca puanlandı. Skorlar izlenme garantisi değildir.");
 }catch(e){setStatus("#agentStatus","Kanca puanlama hatası: "+e.message)}
 finally{button.disabled=false;button.textContent="Yazdığım kancaları puanla"}
}
function loadAgentHub(){
 const root=$("#agentSkills");root.replaceChildren();
 AGENT_SKILLS.forEach(skill=>{const b=document.createElement("button");b.className="agent-skill";b.textContent=skill.label;b.title=skill.id;b.dataset.skill=skill.id;b.addEventListener("click",()=>selectSkill(skill.id));root.append(b)});
 fetch("/api/agent/registry").then(r=>r.ok?r.json():Promise.reject(Error("HTTP "+r.status))).then(data=>setStatus("#agentStatus",data.skills.length+" uzmanlık hazır · "+data.tools.length+" panel içi analiz aracı. Bir uzmanlık seçerek başla.")).catch(e=>setStatus("#agentStatus","Ajan listesi okunamadı: "+e.message));
}
$("#skillAction").addEventListener("click",runSelectedSkill);$("#scoreHooks").addEventListener("click",scoreHookCandidates);
$("#closeSkill").addEventListener("click",()=>{$("#skillWorkspace").classList.add("hidden");activeSkill=null;document.querySelectorAll(".agent-skill").forEach(b=>b.classList.remove("active"))});
$("#copySkillPrompt").addEventListener("click",async()=>{try{await navigator.clipboard.writeText($("#skillPrompt").value);setStatus("#agentStatus","Görev kopyalandı. Bu sohbet alanına yapıştırıp gönder.")}catch(e){$("#skillPrompt").focus();$("#skillPrompt").select();setStatus("#agentStatus","Metni seçip Kopyala komutunu kullan.")}});
loadAgentHub();resumeCloudJob();
