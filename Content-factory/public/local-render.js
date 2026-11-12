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
function pixel(ctx,x,y,size,color){ctx.fillStyle=color;ctx.fillRect(Math.round(x),Math.round(y),size,size)}
function drawPixelArt(ctx,x,y,w,h,caption,index,time,palette){
 const s=Math.max(5,Math.floor(w/42)),cols=palette;
 const word=caption.toLocaleLowerCase("tr-TR");
 const drawBlock=(gx,gy,c)=>pixel(ctx,x+gx*s,y+gy*s,s,c);
 // Pixel-art illustration is built from topic cues; fallback is a bold abstract world icon.
 if(/pac.?man|oyun|arcade|labirent|hayalet|hayalet|piksel|kod|bilgisayar/i.test(word)){
  for(let r=0;r<9;r++)for(let c=0;c<15;c++)if(r===0||r===8||c===0||c===14||((r===2||r===6)&&c>2&&c<12))drawBlock(c,r,cols.dark);
  for(let c=2;c<13;c+=2)drawBlock(c,4,cols.gold);
  const px=4+Math.round((Math.sin(time*2)+1)*3),py=4;
  for(let yy=0;yy<5;yy++)for(let xx=0;xx<5;xx++){
   const dx=xx-2,dy=yy-2;if(dx*dx+dy*dy<=5&&!(xx>2&&Math.abs(yy-2)<=1))drawBlock(px+xx,py+yy,cols.gold);
  }
  for(let yy=0;yy<5;yy++)for(let xx=0;xx<5;xx++)if(yy===0||xx===0||xx===4||yy===4)drawBlock(10+xx,py+yy,cols.red);
  drawBlock(11,5,"#FFFFFF");drawBlock(13,5,"#FFFFFF");
 }else if(/minecraft|blok|inşa|dünya|harita|orman|ağaç/i.test(word)){
  for(let c=0;c<15;c++)for(let r=7;r<10;r++)drawBlock(c,r,r===7?cols.grass:cols.dirt);
  for(const [tx,ty] of [[2,3],[7,2],[12,3]]){
   for(let yy=0;yy<4;yy++)for(let xx=0;xx<4;xx++)drawBlock(tx+xx,ty+yy,cols.leaf);
   for(let yy=0;yy<3;yy++)drawBlock(tx+1,ty+4+yy,cols.wood);
  }
  for(let c=0;c<4;c++)drawBlock(3+c,1,cols.cloud);
  for(let c=0;c<3;c++)drawBlock(10+c,0,cols.cloud);
 }else if(/uzay|gezegen|dünya|ay|mars|yıldız|evren/i.test(word)){
  for(let i=0;i<24;i++){const sx=(i*37%15),sy=(i*19%8);drawBlock(sx,sy,cols.cloud)}
  for(let yy=0;yy<8;yy++)for(let xx=0;xx<8;xx++){const dx=xx-3.5,dy=yy-3.5;if(dx*dx+dy*dy<15)drawBlock(4+xx,1+yy,cols.blue)}
  for(let yy=0;yy<3;yy++)for(let xx=0;xx<3;xx++)drawBlock(6+xx,3+yy,cols.grass);
 }else if(/göz|gizem|sır|gizli|gerçek|kimse|insan|yüz|vücut/i.test(word)){
  for(let yy=0;yy<7;yy++)for(let xx=0;xx<13;xx++){
   const dx=(xx-6)/6.5,dy=(yy-3)/3.5;
   if(dx*dx+dy*dy<1)drawBlock(xx+1,yy+1,cols.cloud);
  }
  for(let yy=0;yy<5;yy++)for(let xx=0;xx<5;xx++){const dx=xx-2,dy=yy-2;if(dx*dx+dy*dy<5)drawBlock(5+xx,2+yy,cols.blue)}
  drawBlock(7,4,cols.dark);
 }else{
  // A vivid, animated pixel emblem when no topic-specific motif is recognized.
  const spin=time*.8+index;
  for(let yy=0;yy<11;yy++)for(let xx=0;xx<11;xx++){
   const dx=xx-5,dy=yy-5,dist=Math.abs(dx)+Math.abs(dy);
   if(dist<8&&((xx+yy+index)%3!==0))drawBlock(2+xx,1+yy,dist<4?cols.gold:(dist<6?cols.red:cols.blue));
  }
  drawBlock(7+Math.round(Math.sin(spin)*2),5,cols.cloud);
 }
}
function drawFrame(ctx,w,h,time,duration,timeline,images,title){
 const scene=timeline.find(x=>time>=x.start&&time<x.end)||timeline[timeline.length-1];
 const palettes=[
  {bg:"#FFD900",ink:"#101010",accent:"#FF3C8D",soft:"#FFFFFF",dark:"#10102A",gold:"#FFD900",red:"#FF3C45",blue:"#2D9CFF",grass:"#20C64A",dirt:"#9B552D",leaf:"#25B94C",wood:"#8A4D2B",cloud:"#FFFFFF"},
  {bg:"#00CFF5",ink:"#101020",accent:"#FF4A00",soft:"#FFFFFF",dark:"#10102A",gold:"#FFE600",red:"#FF3C45",blue:"#247BFF",grass:"#20C64A",dirt:"#9B552D",leaf:"#25B94C",wood:"#8A4D2B",cloud:"#FFFFFF"},
  {bg:"#FF3D9A",ink:"#FFFFFF",accent:"#FFE500",soft:"#21102A",dark:"#10102A",gold:"#FFE600",red:"#FF3C45",blue:"#247BFF",grass:"#20C64A",dirt:"#9B552D",leaf:"#25B94C",wood:"#8A4D2B",cloud:"#FFFFFF"},
  {bg:"#FF6A00",ink:"#17100A",accent:"#B9FF00",soft:"#FFFFFF",dark:"#10102A",gold:"#FFE600",red:"#FF3C45",blue:"#247BFF",grass:"#20C64A",dirt:"#9B552D",leaf:"#25B94C",wood:"#8A4D2B",cloud:"#FFFFFF"},
  {bg:"#B8F500",ink:"#101010",accent:"#6B39FF",soft:"#FFFFFF",dark:"#10102A",gold:"#FFE600",red:"#FF3C45",blue:"#247BFF",grass:"#20C64A",dirt:"#9B552D",leaf:"#25B94C",wood:"#8A4D2B",cloud:"#FFFFFF"},
  {bg:"#6538FF",ink:"#FFFFFF",accent:"#00F0C8",soft:"#16102A",dark:"#10102A",gold:"#FFE600",red:"#FF3C45",blue:"#247BFF",grass:"#20C64A",dirt:"#9B552D",leaf:"#25B94C",wood:"#8A4D2B",cloud:"#FFFFFF"}
 ];
 const p=palettes[scene.index%palettes.length],phase=(time-scene.start)/Math.max(.01,scene.end-scene.start),pulse=.5+.5*Math.sin(time*3.4);
 ctx.fillStyle=p.bg;ctx.fillRect(0,0,w,h);
 // Large diagonal bands and circles mimic the punchy reference motion design.
 ctx.save();ctx.translate(Math.sin(time*1.1)*w*.035,0);
 ctx.fillStyle=p.accent;ctx.globalAlpha=.7;
 ctx.beginPath();ctx.moveTo(w*.72,0);ctx.lineTo(w,0);ctx.lineTo(w,h*.62);ctx.lineTo(w*.47,h*.3);ctx.closePath();ctx.fill();
 ctx.globalAlpha=.95;ctx.beginPath();ctx.arc(w*.08,h*.78,w*(.19+.015*pulse),0,Math.PI*2);ctx.fill();
 ctx.strokeStyle=p.ink;ctx.lineWidth=Math.max(3,w*.008);ctx.globalAlpha=.75;
 for(let i=0;i<3;i++){ctx.beginPath();ctx.arc(w*.85,h*.15,w*(.1+i*.045),0,Math.PI*2);ctx.stroke()}
 ctx.restore();
 // Large framed illustration card occupies the visual center, as in the supplied examples.
 const cardW=w*.72,cardH=h*.39,cardX=(w-cardW)/2+Math.sin(time*1.7)*w*.012,cardY=h*.105+Math.sin(time*2.1)*h*.008;
 ctx.save();ctx.shadowColor="rgba(0,0,0,.35)";ctx.shadowBlur=w*.035;ctx.shadowOffsetY=h*.012;
 ctx.fillStyle="#101020";ctx.beginPath();ctx.roundRect(cardX-w*.012,cardY-w*.012,cardW+w*.024,cardH+w*.024,w*.035);ctx.fill();ctx.restore();
 ctx.save();ctx.beginPath();ctx.roundRect(cardX,cardY,cardW,cardH,w*.022);ctx.clip();
 ctx.fillStyle="#A8DFFF";ctx.fillRect(cardX,cardY,cardW,cardH);
 ctx.fillStyle="#72B7F3";ctx.fillRect(cardX,cardY+cardH*.58,cardW,cardH*.42);
 ctx.fillStyle="#FFFFFF";ctx.fillRect(cardX+cardW*.12,cardY+cardH*.12,cardW*.16,cardH*.045);
 ctx.fillRect(cardX+cardW*.65,cardY+cardH*.2,cardW*.2,cardH*.045);
 if(images.length){
  const img=images[scene.index%images.length].img,scale=Math.max(cardW/img.width,cardH/img.height)*(1.05+.03*pulse),iw=img.width*scale,ih=img.height*scale;
  ctx.drawImage(img,cardX+(cardW-iw)/2,cardY+(cardH-ih)/2,iw,ih);
  ctx.fillStyle="rgba(0,0,0,.08)";ctx.fillRect(cardX,cardY,cardW,cardH);
 }else{
  const pixelW=cardW*.82,pixelH=cardH*.75,px=cardX+(cardW-pixelW)/2,py=cardY+(cardH-pixelH)/2;
  drawPixelArt(ctx,px,py,pixelW,pixelH,scene.caption,scene.index,time,p);
 }
 ctx.restore();
 // Large scene caption, broken into bold kinetic lines; no micro-labels or duplicate subtitles.
 const caption=scene.caption.trim(),words=caption.split(/\s+/),font=Math.round(w*(words.length<5?.095:words.length<9?.082:.07));
 ctx.fillStyle=p.ink;ctx.font="1000 "+font+"px system-ui, -apple-system, sans-serif";ctx.textBaseline="middle";
 let lines=linesFor(ctx,caption,w*.86,4),size=font;
 while(lines.length>3&&size>w*.052){size-=2;ctx.font="1000 "+size+"px system-ui";lines=linesFor(ctx,caption,w*.86,4)}
 const lineH=size*1.1,total=lines.length*lineH;
 let y=Math.min(h*.79,Math.max(h*.60,h*.70-total/2));
 lines.forEach((line,i)=>{
  const jitter=Math.sin(time*4+i*1.8)*w*.006;
  ctx.save();ctx.translate(jitter,0);
  if(i===0&&lines.length>1){ctx.fillStyle=p.soft;ctx.fillRect(w*.055,y-lineH*.42,w*.89,lineH*.84);ctx.fillStyle="#111111"}
  ctx.fillText(line,w*.075,y+i*lineH);ctx.restore();
 });
 // Punchy corner sticker; avoid repetitive channel labels.
 ctx.save();ctx.translate(w*.82,h*.79);ctx.rotate(Math.sin(time*2)*.06);
 ctx.fillStyle=p.accent;ctx.beginPath();ctx.arc(0,0,w*.095,0,Math.PI*2);ctx.fill();
 ctx.fillStyle=p.ink;ctx.font="1000 "+Math.round(w*.105)+"px system-ui";ctx.textAlign="center";ctx.textBaseline="middle";
 ctx.fillText(/\d/.test(caption)?(caption.match(/\d+/)||["!"])[0]:"!",0,0);ctx.restore();
 ctx.fillStyle="rgba(0,0,0,.18)";ctx.fillRect(0,h*.985,w,h*.015);
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