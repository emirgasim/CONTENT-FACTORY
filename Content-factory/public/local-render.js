(() => {
"use strict";
const $ = s => document.querySelector(s);
const state = window.cfState;
if (!state) { console.error("Content Factory state missing"); return; }
let localImages = [];
const setText = (selector, value) => { const el=$(selector); if(el) el.textContent=value; };
const setProgress = value => { const el=$("#renderProgress"); if(el) el.style.width=Math.max(0,Math.min(100,value))+"%"; };
const revoke = url => { if(url) URL.revokeObjectURL(url); };

function capabilities() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  const ok = !!Audio && !!HTMLCanvasElement.prototype.captureStream && !!window.MediaRecorder;
  const mp4 = !!window.MediaRecorder && (MediaRecorder.isTypeSupported("video/mp4;codecs=avc1.42E01E,mp4a.40.2") || MediaRecorder.isTypeSupported("video/mp4"));
  setText("#localCapability", ok && mp4 ? "Bu iPhone Safari MP4 (H.264/AAC) kodlamasını destekliyor. Üretim cihaz üzerinde yapılacak." : "Bu tarayıcıda gerekli yerel MP4 üretim desteği doğrulanamadı.");
  const btn=$("#startRender");
  if(btn) btn.disabled=!ok || !mp4 || !state.reference || !$("#scriptText").value.trim();
}
function splitIntoScenes(text) {
  const sentences=(text.match(/[^.!?]+[.!?]?/g)||[text]).map(s=>s.trim()).filter(Boolean);
  const scenes=[];
  for(const sentence of sentences) {
    const words=sentence.split(/\s+/);
    for(let i=0;i<words.length;i+=9) scenes.push(words.slice(i,i+9).join(" "));
  }
  return scenes.length?scenes:[text];
}
function timelineFor(text,duration) {
  const scenes=splitIntoScenes(text);
  const weights=scenes.map(s=>Math.max(1,s.split(/\s+/).length));
  const total=weights.reduce((a,b)=>a+b,0);
  let cursor=0;
  return scenes.map((caption,index)=>{
    const start=cursor;
    cursor+=duration*weights[index]/total;
    return {caption,index,start,end:index===scenes.length-1?duration:cursor};
  });
}
function detectSpeech(buffer) {
  const rate=buffer.sampleRate, channels=buffer.numberOfChannels;
  const step=Math.max(1,Math.floor(rate*.04)), count=Math.ceil(buffer.length/step), energy=new Float32Array(count);
  for(let w=0;w<count;w++) {
    const from=w*step,to=Math.min(buffer.length,from+step);
    let sum=0,n=0;
    for(let c=0;c<channels;c++) {
      const data=buffer.getChannelData(c);
      for(let i=from;i<to;i+=4) { sum+=data[i]*data[i]; n++; }
    }
    energy[w]=Math.sqrt(sum/Math.max(1,n));
  }
  const active=Array.from(energy,x=>x>.009);
  for(let i=1;i<active.length-1;i++) if(!active[i]&&active[i-1]&&active[i+1]) active[i]=true;
  const pad=Math.ceil(.14*rate/step), maxGap=Math.ceil(.62*rate/step), groups=[];
  let start=-1,last=-1;
  for(let i=0;i<active.length;i++) {
    if(active[i]) { if(start<0) start=i; last=i; }
    else if(start>=0 && i-last>maxGap) {
      groups.push([Math.max(0,start-pad),Math.min(count,last+pad+1)]);
      start=-1; last=-1;
    }
  }
  if(start>=0) groups.push([Math.max(0,start-pad),Math.min(count,last+pad+1)]);
  if(!groups.length) return {ranges:[[0,buffer.length]],removed:0};
  const ranges=[];
  for(const g of groups) {
    const next=[g[0]*step,Math.min(buffer.length,g[1]*step)];
    if(ranges.length && next[0]-ranges[ranges.length-1][1]<rate*.18) ranges[ranges.length-1][1]=next[1];
    else ranges.push(next);
  }
  const kept=ranges.reduce((n,r)=>n+r[1]-r[0],0);
  const removed=Math.max(0,buffer.duration-kept/rate);
  return removed<.35?{ranges:[[0,buffer.length]],removed:0}:{ranges,removed};
}
function concatenateAudio(source,analysis) {
  const rate=source.sampleRate,channels=source.numberOfChannels;
  const total=analysis.ranges.reduce((n,r)=>n+r[1]-r[0],0);
  const out=new AudioBuffer({length:total,numberOfChannels:channels,sampleRate:rate});
  let cursor=0;
  for(const range of analysis.ranges) {
    const from=range[0],to=range[1],length=to-from;
    for(let c=0;c<channels;c++) out.getChannelData(c).set(source.getChannelData(c).subarray(from,to),cursor);
    cursor+=length;
  }
  return out;
}
function wavBlob(buffer) {
  const channels=buffer.numberOfChannels,frames=buffer.length,rate=buffer.sampleRate;
  const bytes=44+frames*channels*2,ab=new ArrayBuffer(bytes),v=new DataView(ab);
  const write=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  write(0,"RIFF");v.setUint32(4,bytes-8,true);write(8,"WAVE");write(12,"fmt ");
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,channels,true);
  v.setUint32(24,rate,true);v.setUint32(28,rate*channels*2,true);v.setUint16(32,channels*2,true);v.setUint16(34,16,true);write(36,"data");v.setUint32(40,bytes-44,true);
  let p=44;
  for(let i=0;i<frames;i++) for(let c=0;c<channels;c++) {
    const x=Math.max(-1,Math.min(1,buffer.getChannelData(c)[i]));
    v.setInt16(p,x<0?x*32768:x*32767,true);p+=2;
  }
  return new Blob([ab],{type:"audio/wav"});
}
function loadImages(files) {
  return Promise.all(files.map(file=>new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file),img=new Image();
    img.onload=()=>resolve({img,url});
    img.onerror=()=>{URL.revokeObjectURL(url);reject(Error(file.name+" görseli okunamadı."));};
    img.src=url;
  })));
}
function rounded(ctx,x,y,w,h,r,color) {
  ctx.fillStyle=color;ctx.beginPath();
  if(ctx.roundRect) ctx.roundRect(x,y,w,h,r); else ctx.rect(x,y,w,h);
  ctx.fill();
}
function linesFor(ctx,text,maxWidth,maxLines) {
  const words=text.split(/\s+/),lines=[];let line="";
  for(const word of words) {
    const test=(line+" "+word).trim();
    if(ctx.measureText(test).width>maxWidth&&line){lines.push(line);line=word;} else line=test;
  }
  if(line) lines.push(line);
  return lines.slice(0,maxLines);
}
function drawFrame(ctx,w,h,time,duration,timeline,images,title) {
  const scene=timeline.find(x=>time>=x.start&&time<x.end)||timeline[timeline.length-1];
  const palettes=[
    {bg:"#FFE500",ink:"#111111",accent:"#FF3D8D",soft:"#FFFFFF"},
    {bg:"#00D9F5",ink:"#101020",accent:"#FF4E00",soft:"#FFFFFF"},
    {bg:"#FF3B9D",ink:"#FFFFFF",accent:"#FFE500",soft:"#191225"},
    {bg:"#FF6A00",ink:"#17100A",accent:"#B9FF00",soft:"#FFFFFF"},
    {bg:"#B8F500",ink:"#101010",accent:"#6B39FF",soft:"#FFFFFF"},
    {bg:"#6538FF",ink:"#FFFFFF",accent:"#00F0C8",soft:"#16102A"}
  ];
  const p=palettes[scene.index%palettes.length],phase=(time-scene.start)/Math.max(.01,scene.end-scene.start);
  const pulse=.5+.5*Math.sin(time*3.2),drift=Math.sin(time*1.25)*w*.025;
  ctx.fillStyle=p.bg;ctx.fillRect(0,0,w,h);
  const image=images.length?images[scene.index%images.length].img:null;
  if(image){
    ctx.save();ctx.globalAlpha=.25;
    const scale=Math.max(w/image.width,h/image.height)*(1.08+.035*pulse),iw=image.width*scale,ih=image.height*scale;
    ctx.translate(drift,0);ctx.drawImage(image,(w-iw)/2,(h-ih)/2,iw,ih);ctx.restore();
  }
  // Oversized graphic shapes create a distinct poster-like composition on every beat.
  const layout=scene.index%5;
  ctx.save();
  if(layout===0){
    ctx.fillStyle=p.accent;ctx.beginPath();ctx.arc(w*.88,h*.16,w*(.23+.018*pulse),0,Math.PI*2);ctx.fill();
    ctx.fillStyle=p.soft;ctx.save();ctx.translate(w*.78,h*.73);ctx.rotate(-.16+phase*.04);ctx.fillRect(-w*.52,-h*.025,w*.7,h*.05);ctx.restore();
  } else if(layout===1){
    ctx.fillStyle=p.accent;ctx.beginPath();ctx.moveTo(w*.68,0);ctx.lineTo(w,h*.0);ctx.lineTo(w,h*.58);ctx.lineTo(w*.46,h*.38);ctx.closePath();ctx.fill();
    ctx.fillStyle=p.soft;ctx.fillRect(0,h*.73,w,h*.27);
  } else if(layout===2){
    ctx.fillStyle=p.accent;ctx.beginPath();ctx.arc(w*.18,h*.83,w*.32,0,Math.PI*2);ctx.fill();
    ctx.fillStyle=p.soft;ctx.beginPath();ctx.arc(w*.83,h*.17,w*.14,0,Math.PI*2);ctx.fill();
  } else if(layout===3){
    ctx.fillStyle=p.accent;ctx.save();ctx.translate(w*.5,h*.5);ctx.rotate(-.14);ctx.fillRect(-w*.62,-h*.13,w*1.24,h*.26);ctx.restore();
  } else {
    ctx.fillStyle=p.accent;ctx.beginPath();ctx.moveTo(0,h*.64);ctx.lineTo(w,h*.38);ctx.lineTo(w,h);ctx.lineTo(0,h);ctx.closePath();ctx.fill();
    ctx.fillStyle=p.soft;ctx.beginPath();ctx.arc(w*.82,h*.2,w*.12,0,Math.PI*2);ctx.fill();
  }
  ctx.restore();

  const caption=scene.caption.trim();
  const hasNumber=/\d/.test(caption),isQuestion=/\?|neden|nasıl|gerçek|sır|gizli/i.test(caption);
  const words=caption.split(/\s+/);
  const maxWidth=w*.82;
  const fontSize=Math.round(w*(words.length<6?.102:words.length<10?.086:.073));
  ctx.fillStyle=p.ink;
  ctx.font="900 "+fontSize+"px system-ui, -apple-system, sans-serif";
  ctx.textBaseline="middle";
  let lines=linesFor(ctx,caption,maxWidth,6);
  // Keep the headline visually dominant and fit it to the portrait canvas.
  let size=fontSize;
  while(lines.length>5&&size>w*.052){
    size-=2;ctx.font="900 "+size+"px system-ui, -apple-system, sans-serif";
    lines=linesFor(ctx,caption,maxWidth,6);
  }
  const lineHeight=size*1.12,totalHeight=lines.length*lineHeight;
  let startY=Math.max(h*.28,Math.min(h*.54,(h-totalHeight)*.48));
  if(layout===1)startY=h*.34;
  if(layout===3)startY=h*.39;
  lines.forEach((line,i)=>ctx.fillText(line,w*.085,startY+i*lineHeight));

  // A single punchy visual cue, not repeated micro-labels or duplicated subtitles.
  if(hasNumber){
    const number=(caption.match(/\d+[.,]?\d*%?/g)||[])[0];
    ctx.save();ctx.fillStyle=p.accent;ctx.font="900 "+Math.round(w*.12)+"px system-ui";
    ctx.textAlign="right";ctx.fillText(number,w*.91,h*.87);ctx.restore();
  } else if(isQuestion){
    ctx.save();ctx.fillStyle=p.accent;ctx.font="900 "+Math.round(w*.19)+"px system-ui";
    ctx.fillText("?",w*.08,h*.88);ctx.restore();
  } else {
    ctx.save();ctx.fillStyle=p.ink;ctx.globalAlpha=.85;
    ctx.beginPath();ctx.arc(w*.89,h*.88,w*.045*(.8+pulse*.2),0,Math.PI*2);ctx.fill();ctx.restore();
  }
  // Minimal progress indicator only; no unrelated channel labels or repeated caption strip.
  ctx.fillStyle="rgba(0,0,0,.22)";ctx.fillRect(0,h*.985,w,h*.015);
  ctx.fillStyle=p.ink;ctx.fillRect(0,h*.985,w*Math.min(1,time/duration),h*.015);
}
async function renderLocally() {
  const text=$("#scriptText").value.trim(),title=$("#topicTitle").value.trim()||"Content Factory Shorts",file=state.reference;
  if(!text||!file) throw Error("Önce metin ve ses dosyası ekle.");
  const Audio=window.AudioContext||window.webkitAudioContext;
  if(!Audio||!HTMLCanvasElement.prototype.captureStream||!window.MediaRecorder) throw Error("Safari bu iPhone'da gerekli yerel video özelliklerini desteklemiyor.");
  const mime=["video/mp4;codecs=avc1.42E01E,mp4a.40.2","video/mp4"].find(x=>MediaRecorder.isTypeSupported(x));
  if(!mime) throw Error("Bu iPhone Safari sürümünde MP4 kodlayıcı bulunamadı. Hiçbir dosya üretilmedi.");
  setProgress(4);setText("#renderStatus","Ses dosyası iPhone belleğine alınıyor…");
  const audioContext=new Audio();
  await audioContext.resume();
  const decoded=await audioContext.decodeAudioData(await file.arrayBuffer());
  if(decoded.duration>180) throw Error("İlk iPhone sürümünde en fazla 3 dakikalık ses destekleniyor.");
  setProgress(14);setText("#renderStatus","Ses dalgası inceleniyor ve uzun sessizlikler temizleniyor…");
  const analysis=detectSpeech(decoded),clean=concatenateAudio(decoded,analysis);
  if(clean.duration<4) throw Error("Temizlenmiş ses çok kısa. Başka bir kayıt seç.");
  const timeline=timelineFor(text,clean.duration);
  setProgress(21);setText("#renderStatus","Görsel sahneler hazırlanıyor…");
  const images=await loadImages(state.visualFiles||[]);
  const quality=$("#localQuality")?.value||"1080",w=quality==="720"?720:1080,h=quality==="720"?1280:1920,fps=24;
  const canvas=document.createElement("canvas");canvas.width=w;canvas.height=h;
  canvas.style.cssText="position:fixed;left:-3000px;top:0;width:2px;height:2px;";
  document.body.append(canvas);
  const ctx=canvas.getContext("2d",{alpha:false});
  if(!ctx) throw Error("Canvas çizim alanı açılamadı.");
  const videoStream=canvas.captureStream(fps),audioDestination=audioContext.createMediaStreamDestination();
  const source=audioContext.createBufferSource();source.buffer=clean;source.connect(audioDestination);
  const stream=new MediaStream([...videoStream.getVideoTracks(),...audioDestination.stream.getAudioTracks()]);
  const chunks=[];
  let recorder;
  try { recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:quality==="720"?3500000:6500000,audioBitsPerSecond:160000}); }
  catch(e){canvas.remove();throw Error("MP4 kaydedici açılamadı: "+e.message);}
  let wakeLock=null;
  try { if(navigator.wakeLock) wakeLock=await navigator.wakeLock.request("screen"); } catch {}
  let raf=0,started=0,stopped=false,finishTimer=0;
  const stopTracks=()=>stream.getTracks().forEach(t=>t.stop());
  const stopRecorder=()=>{
    if(stopped)return;
    stopped=true;
    cancelAnimationFrame(raf);
    clearTimeout(finishTimer);
    if(recorder.state!=="inactive")recorder.stop();
  };
  const result=new Promise((resolve,reject)=>{
    recorder.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data);};
    recorder.onerror=()=>{stopTracks();reject(Error("Safari video kodlama işlemini durdurdu."));};
    recorder.onstop=()=>{
      stopTracks();
      const blob=new Blob(chunks,{type:recorder.mimeType||mime});
      if(blob.size<80000) reject(Error("MP4 dosyası çok küçük; Safari kayıt verisi üretmedi."));
      else resolve(blob);
    };
    source.onended=stopRecorder;
    recorder.start();
    finishTimer=setTimeout(()=>{
      if(!stopped){
        if(source.playbackState===source.FINISHED)stopRecorder();
        else {stopTracks();reject(Error("iPhone ses/video kaydı zamanında tamamlanmadı. Safari'yi açık tutup 720p ile yeniden dene."));}
      }
    },Math.ceil(clean.duration*1000)+12000);
    const frame=now=>{
      if(stopped)return;
      if(!started)started=now;
      const elapsed=Math.min(clean.duration,(now-started)/1000);
      drawFrame(ctx,w,h,elapsed,clean.duration,timeline,images,title);
      setProgress(24+Math.round(70*elapsed/clean.duration));
      if(elapsed<clean.duration)raf=requestAnimationFrame(frame);
      else stopRecorder();
    };
    frame(performance.now());
    source.start();
  });
  let blob;
  try { blob=await result; }
  finally {
    stopTracks();canvas.remove();images.forEach(x=>URL.revokeObjectURL(x.url));
    try{if(wakeLock)await wakeLock.release();}catch{}
    try{await audioContext.close();}catch{}
  }
  revoke(state.videoUrl);revoke(state.audioUrl);revoke(state.creditsUrl);
  state.videoUrl=URL.createObjectURL(blob);
  state.audioUrl=URL.createObjectURL(wavBlob(clean));
  const credits="CONTENT FACTORY · IPHONE LOCAL RENDER\nGörsel kaynakları: Kullanıcının yüklediği görseller ve özgün Canvas grafikleri.\nHarici stok API'si, ücretli servis veya API anahtarı kullanılmadı.\nTemizlenen sessizlik: "+analysis.removed.toFixed(2)+" saniye.\nKodlayıcı: "+(recorder.mimeType||mime)+"\nSenkronizasyon: Metin, temiz ses süresine kelime sayısı ağırlıklı dağıtıldı. Bu sürüm otomatik konuşma tanıma veya kelime düzeyinde hizalama yapmaz.";
  state.creditsUrl=URL.createObjectURL(new Blob([credits],{type:"text/plain;charset=utf-8"}));
  $("#finalVideo").src=state.videoUrl;
  $("#renderStats").textContent="MP4 · "+w+"×"+h+" · "+clean.duration.toFixed(1)+" sn · "+analysis.removed.toFixed(1)+" sn sessizlik azaltıldı · "+timeline.length+" sahne · "+images.length+" yüklenen görsel";
  $("#renderResult").classList.remove("hidden");setProgress(100);
  setText("#renderStatus","MP4 bu iPhone'da oluşturuldu. Önizle ve Dosyalar'a kaydet.");
}
async function run() {
  const button=$("#startRender");
  if(state.rendering)return;
  state.rendering=true;button.disabled=true;button.textContent="iPhone'da üretiliyor…";
  $("#renderPanel").classList.remove("hidden");$("#renderResult").classList.add("hidden");setProgress(1);
  try { await renderLocally();button.textContent="Video hazırlandı"; }
  catch(e) { setText("#renderStatus","Üretim durdu: "+e.message);button.textContent="Tekrar dene · iPhone'da Shorts üret"; }
  finally { state.rendering=false;button.disabled=!(state.reference&&$("#scriptText").value.trim()); }
}
function download(url,name) {
  if(!url)return;
  const a=document.createElement("a");a.href=url;a.download=name;document.body.append(a);a.click();a.remove();
}
function init() {
  const old=$("#settingsToggle");
  if(old) old.onclick=()=>$("#engineSettings").classList.toggle("hidden");
  $("#startRender").onclick=run;
  $("#downloadVideo").onclick=()=>download(state.videoUrl,($("#topicTitle").value.trim()||"shorts").replace(/[^a-z0-9-_]/gi,"_")+".mp4");
  $("#downloadCleanAudio").onclick=()=>download(state.audioUrl,"shorts-cleaned-voice.wav");
  $("#downloadCredits").onclick=()=>download(state.creditsUrl,"render-notes.txt");
  $("#visualFiles").onchange=e=>{
    state.visualFiles=Array.from(e.target.files||[]).slice(0,8);
    setText("#visualStatus",state.visualFiles.length+" görsel seçildi. Fotoğraflar bu iPhone'da işlenecek.");
  };
  $("#scriptText").addEventListener("input",capabilities);
  $("#localQuality").addEventListener("change",capabilities);
  capabilities();
  const statusNode=$("#recordStatus");if(statusNode&&window.MutationObserver)new MutationObserver(capabilities).observe(statusNode,{childList:true,subtree:true,characterData:true});
  $("#audioFile").addEventListener("change",()=>setTimeout(capabilities,50));
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
})();