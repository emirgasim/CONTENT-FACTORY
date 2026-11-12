(() => {
"use strict";
const $ = s => document.querySelector(s);
const state = window.cfState;
if (!state) { console.error("Content Factory state missing"); return; }
const setText=(selector,value)=>{const el=$(selector);if(el)el.textContent=value;};
const setProgress=value=>{const el=$("#renderProgress");if(el)el.style.width=Math.max(0,Math.min(100,value))+"%";};
const revoke=url=>{if(url)URL.revokeObjectURL(url);};
const COMMONS="https://commons.wikimedia.org/w/api.php";
const STOP=new Set("ve veya ama fakat çünkü gibi için ile bir bu şu o da de ki ne mi mı mu mü daha çok az her bazı nasıl neden niçin zaman olan olarak sonra önce kadar göre ise hem ya yani diye tüm bütün çok şey yeni eski ilk son gerçekten aslında video görüntü dünya yıllar yılında milyonlarca kişi gördü görmüş görür oldu dönen dönən yıllarca aslında gerçek ana".split(" "));
let lastRunSeed=0;

function capabilities(){
 const Audio=window.AudioContext||window.webkitAudioContext;
 const supported=!!Audio&&!!HTMLCanvasElement.prototype.captureStream&&!!window.MediaRecorder;
 const mp4=!!window.MediaRecorder&&(MediaRecorder.isTypeSupported("video/mp4;codecs=avc1.42E01E,mp4a.40.2")||MediaRecorder.isTypeSupported("video/mp4"));
 setText("#localCapability",supported&&mp4?"iPhone Safari MP4 kaydını destekliyor. Ses, görsel ve montaj cihazda işlenecek.":"Bu Safari sürümünde MP4 kayıt desteği doğrulanamadı.");
 const button=$("#startRender");if(button)button.disabled=!(supported&&mp4&&state.reference&&$("#scriptText").value.trim()&&$("#hookText").value.trim());
}
function splitIntoScenes(text){
 const sentences=(text.match(/[^.!?]+[.!?]?/g)||[text]).map(x=>x.trim()).filter(Boolean),out=[];
 for(const sentence of sentences){const words=sentence.split(/\s+/);for(let i=0;i<words.length;i+=9)out.push(words.slice(i,i+9).join(" "));}
 return out.length?out:[text];
}
function timelineFor(text,duration){
 const scenes=splitIntoScenes(text),weights=scenes.map(x=>Math.max(1,x.split(/\s+/).length)),total=weights.reduce((a,b)=>a+b,0);let cursor=0;
 return scenes.map((caption,index)=>{const start=cursor;cursor+=duration*weights[index]/total;return{caption,index,start,end:index===scenes.length-1?duration:cursor};});
}
function percentile(values,p){
 if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*p))];
}

/* Conservative silence detection: speech is never discarded just to make the edit shorter. */
function detectSpeech(buffer){
 const rate=buffer.sampleRate,channels=buffer.numberOfChannels,step=Math.max(1,Math.floor(rate*.04)),count=Math.ceil(buffer.length/step),energy=new Float32Array(count);
 for(let w=0;w<count;w++){
  const from=w*step,to=Math.min(buffer.length,from+step);let sum=0,n=0;
  for(let c=0;c<channels;c++){const data=buffer.getChannelData(c);for(let i=from;i<to;i+=4){sum+=data[i]*data[i];n++;}}
  energy[w]=Math.sqrt(sum/Math.max(1,n));
 }
 const peak=percentile(Array.from(energy),.95),noise=percentile(Array.from(energy),.18);
 const threshold=Math.max(.0012,Math.min(.006,Math.max(noise*2.1,peak*.018)));
 const active=Array.from(energy,x=>x>threshold);
 const maxHole=Math.ceil(.22*rate/step);
 for(let i=1;i<active.length-1;){
  if(!active[i]){let j=i;while(j<active.length&&!active[j])j++;if(i>0&&j<active.length&&j-i<=maxHole)for(let k=i;k<j;k++)active[k]=true;i=j;}
  else i++;
 }
 const padBefore=Math.ceil(.28*rate/step),padAfter=Math.ceil(.42*rate/step),removeGap=Math.ceil(1.15*rate/step),groups=[];
 let start=-1,last=-1;
 for(let i=0;i<active.length;i++){
  if(active[i]){if(start<0)start=i;last=i;}
  else if(start>=0&&i-last>removeGap){groups.push([Math.max(0,start-padBefore),Math.min(count,last+padAfter+1)]);start=-1;last=-1;}
 }
 if(start>=0)groups.push([Math.max(0,start-padBefore),Math.min(count,last+padAfter+1)]);
 if(!groups.length)return{ranges:[[0,buffer.length]],removed:0,threshold,trimmed:false};
 const ranges=[];
 for(const g of groups){
  const next=[Math.max(0,g[0]*step),Math.min(buffer.length,g[1]*step)];
  if(ranges.length&&next[0]-ranges[ranges.length-1][1]<rate*.2)ranges[ranges.length-1][1]=next[1];else ranges.push(next);
 }
 const kept=ranges.reduce((n,r)=>n+r[1]-r[0],0),removed=Math.max(0,buffer.duration-kept/rate),ratio=removed/Math.max(.01,buffer.duration);
 // If detection would remove more than 7% of the narration, preserve the complete original audio.
 if(ratio>.07||removed>3.5)return{ranges:[[0,buffer.length]],removed:0,threshold,trimmed:false,guard:"Konuşma kaybını önlemek için sesin tamamı korundu."};
 return{ranges,removed,threshold,trimmed:removed>.05};
}
function concatenateAudio(source,analysis){
 const rate=source.sampleRate,channels=source.numberOfChannels,total=analysis.ranges.reduce((n,r)=>n+r[1]-r[0],0);
 const out=new AudioBuffer({length:Math.max(1,total),numberOfChannels:channels,sampleRate:rate});let cursor=0;
 for(const [from,to] of analysis.ranges){const length=to-from;for(let c=0;c<channels;c++)out.getChannelData(c).set(source.getChannelData(c).subarray(from,to),cursor);cursor+=length;}
 return out;
}
function wavBlob(buffer){
 const channels=buffer.numberOfChannels,frames=buffer.length,rate=buffer.sampleRate,bytes=44+frames*channels*2,ab=new ArrayBuffer(bytes),v=new DataView(ab);
 const write=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
 write(0,"RIFF");v.setUint32(4,bytes-8,true);write(8,"WAVE");write(12,"fmt ");v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,channels,true);v.setUint32(24,rate,true);v.setUint32(28,rate*channels*2,true);v.setUint16(32,channels*2,true);v.setUint16(34,16,true);write(36,"data");v.setUint32(40,bytes-44,true);
 let p=44;for(let i=0;i<frames;i++)for(let c=0;c<channels;c++){const x=Math.max(-1,Math.min(1,buffer.getChannelData(c)[i]));v.setInt16(p,x<0?x*32768:x*32767,true);p+=2;}
 return new Blob([ab],{type:"audio/wav"});
}
function makeRng(seed){let x=seed>>>0;return()=>{x+=0x6D2B79F5;let t=x;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}
function randomSeed(){const a=new Uint32Array(1);if(window.crypto?.getRandomValues)crypto.getRandomValues(a);else a[0]=Math.floor(Math.random()*4294967295);return a[0]||Date.now()>>>0;}
function hsl(h,s,l){return "hsl("+Math.round((h%360+360)%360)+" "+Math.round(s)+"% "+Math.round(l)+"%)";}
function makeSceneStyles(count,seed){
 const rnd=makeRng(seed),styles=[];
 const themes=[
  {bg:"#FFE600",captionPlate:"#FFF4A8",captionText:"#101018",hookPlate:"#FFFFFF",hookText:"#101018",accent:"#FF2492",accent2:"#00A8FF"},
  {bg:"#FF2694",captionPlate:"#A80056",captionText:"#FFFFFF",hookPlate:"#FFF36A",hookText:"#101018",accent:"#FFE000",accent2:"#00D7F5"},
  {bg:"#00BFF3",captionPlate:"#0047AE",captionText:"#FFFFFF",hookPlate:"#FFF36A",hookText:"#101018",accent:"#FF2795",accent2:"#FFE000"},
  {bg:"#FF6A00",captionPlate:"#FFE2B8",captionText:"#101018",hookPlate:"#FFFFFF",hookText:"#101018",accent:"#00D7F5",accent2:"#F50083"},
  {bg:"#B8F500",captionPlate:"#F0FFA2",captionText:"#101018",hookPlate:"#FFFFFF",hookText:"#101018",accent:"#693BFF",accent2:"#FF278A"},
  {bg:"#762BFF",captionPlate:"#4A13BF",captionText:"#FFFFFF",hookPlate:"#FFE600",hookText:"#101018",accent:"#00E5C0",accent2:"#FF3D9A"},
  {bg:"#FF3D27",captionPlate:"#FFE2B8",captionText:"#101018",hookPlate:"#FFFFFF",hookText:"#101018",accent:"#FFE000",accent2:"#00C7FF"},
  {bg:"#00B989",captionPlate:"#005641",captionText:"#FFFFFF",hookPlate:"#FFE600",hookText:"#101018",accent:"#FF2B91",accent2:"#2580FF"},
  {bg:"#165CFF",captionPlate:"#0639B4",captionText:"#FFFFFF",hookPlate:"#FFE600",hookText:"#101018",accent:"#FF2B91",accent2:"#00E5C0"},
  {bg:"#F500A3",captionPlate:"#AC006F",captionText:"#FFFFFF",hookPlate:"#FFE600",hookText:"#101018",accent:"#00D8FF",accent2:"#B8F500"},
  {bg:"#FFB000",captionPlate:"#FFF0B8",captionText:"#101018",hookPlate:"#FFFFFF",hookText:"#101018",accent:"#F00085",accent2:"#00BFF3"},
  {bg:"#00D7D0",captionPlate:"#B4FFF5",captionText:"#101018",hookPlate:"#FFFFFF",hookText:"#101018",accent:"#FF2897",accent2:"#7138FF"}
 ];
 let previous=-1;
 for(let i=0;i<count;i++){
  let index=Math.floor(rnd()*themes.length);
  if(index===previous)index=(index+1+Math.floor(rnd()*(themes.length-1)))%themes.length;
  const p=themes[index];
  styles.push({...p,layout:Math.floor(rnd()*7),shapeSeed:rnd()*1000,
   driftX:(rnd()-.5)*.1,driftY:(rnd()-.5)*.08,rotation:(rnd()-.5)*.24,
   shapeCount:8+Math.floor(rnd()*15),scale:.94+rnd()*.12,
   hue:index,progressFill:"#101018",progressTrack:"#FFFFFF"});
  previous=index;
 }
 return styles;
}

const contrastScratch=document.createElement("canvas");
contrastScratch.width=contrastScratch.height=1;
const contrastCtx=contrastScratch.getContext("2d",{willReadFrequently:true});
function colorRgb(color){
 contrastCtx.clearRect(0,0,1,1);
 contrastCtx.fillStyle="#000000";
 contrastCtx.fillStyle=color;
 contrastCtx.fillRect(0,0,1,1);
 const d=contrastCtx.getImageData(0,0,1,1).data;
 return [d[0],d[1],d[2]];
}
function luminance(color){
 const rgb=Array.isArray(color)?color:colorRgb(color);
 const c=rgb.map(v=>{v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4);});
 return .2126*c[0]+.7152*c[1]+.0722*c[2];
}
function contrastRatio(a,b){
 const l1=luminance(a),l2=luminance(b);
 return (Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05);
}
function bestBlackWhite(background){
 const black="#101018",white="#FFFFFF";
 return contrastRatio(background,black)>=contrastRatio(background,white)?black:white;
}
function buildContrastSafeStyle(style){
 const captionRatio=contrastRatio(style.captionPlate,style.captionText);
 const hookRatio=contrastRatio(style.hookPlate,style.hookText);
 const progressRatio=contrastRatio(style.progressFill,style.progressTrack);
 if(captionRatio<7||hookRatio<7||progressRatio<4.5)throw Error("Kontrast kalite kontrolü başarısız.");
 return {...style,minContrast:Math.min(captionRatio,hookRatio),captionContrast:captionRatio,hookContrast:hookRatio};
}
function auditSceneContrast(styles){
 const audited=styles.map(buildContrastSafeStyle);
 const min=Math.min(...audited.map(x=>Math.min(x.captionContrast,x.hookContrast)));
 if(!audited.length||min<7)throw Error("Kontrast kalite kontrolü geçmedi. Render başlatılmadı.");
 return {styles:audited,minContrast:min,scenes:audited.length,corrected:0,passed:true};
}

function extractSearchTerms(text,title){
 const aliases={
  "oyun":"video game arcade","menü":"video game menu","menu":"video game menu","minecraft":"Minecraft voxel game","pacman":"Pac-Man arcade maze",
  "harita":"map","gizem":"mystery","gizli":"secret","sır":"mystery","tarih":"history","dünya":"earth planet",
  "uzay":"outer space","gezegen":"planet","insan":"human","hayvan":"animal","kedi":"cat","köpek":"dog",
  "bilgisayar":"computer","teknoloji":"technology","yasa":"law","yasak":"banned","yasaklanan":"banned",
  "ürün":"product","ağaç":"tree","orman":"forest","deniz":"ocean","deprem":"earthquake","kirpik":"eyelashes",
  "manzara":"landscape scenery","manzarayı":"landscape scenery","manzarada":"landscape scenery","manzaranın":"landscape scenery","bulanık":"blurry image","gördü":"viewed","oyunun":"video game","oyununda":"video game","menüsünde":"video game menu","dünyasından":"virtual world","şehir":"city skyline","köprü":"bridge","uçak":"airplane","araba":"car",
  "okul":"school","çizgi":"cartoon animation","oyuncak":"toy","fabrika":"factory","telefon":"mobile phone",
  "internet":"internet technology","robot":"robot","korku":"horror","canavar":"monster","hayalet":"ghost",
  "göz":"eye closeup","kalp":"heart anatomy","beyin":"human brain","deney":"science experiment",
  "ilaç":"medicine","yasak":"banned","ürün":"consumer product","spor":"sport","futbol":"football soccer"
 };
 const tokens=value=>String(value||"").toLocaleLowerCase("tr-TR").match(/[\p{L}\p{N}]{3,}/gu)||[];
 const topicTokens=tokens(title).filter(x=>!STOP.has(x));
 const sceneTokens=tokens(text).filter(x=>!STOP.has(x));
 const topic=[],scene=[];
 for(const word of topicTokens){if(aliases[word]&&!topic.includes(aliases[word]))topic.push(aliases[word]);if(!topic.includes(word))topic.push(word);}
 for(const word of sceneTokens){if(aliases[word]&&!scene.includes(aliases[word]))scene.push(aliases[word]);if(!scene.includes(word))scene.push(word);}
 const query=[...topic.slice(0,5),...scene.slice(0,5)].join(" ");
 return query.slice(0,180)||String(title||text).slice(0,100);
}
function permittedLicense(label){
 const s=String(label||"").toLowerCase();
 if(/non.?commercial|\bnc\b|cc\s*by[- ]nc|\bnd\b|cc\s*by[- ]nd|no.?derivatives/.test(s))return false;
 return /cc0|cc 0|cc[- ]by(?:[- ]sa)?|public domain/.test(s);
}
function metaValue(meta,key){return String(meta?.[key]?.value||"").replace(/<[^>]*>/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim();}
async function searchCommons(query){
 const params=new URLSearchParams({
  action:"query",format:"json",origin:"*",generator:"search",gsrsearch:query,
  gsrnamespace:"6",gsrlimit:"15",prop:"imageinfo",
  iiprop:"url|extmetadata|thumbmime",iiurlwidth:"1200"
 });
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),14000);
 try{
  const response=await fetch(COMMONS+"?"+params.toString(),{signal:controller.signal,mode:"cors",credentials:"omit"});
  if(!response.ok)throw Error("Commons HTTP "+response.status);
  const data=await response.json(),pages=Object.values(data.query?.pages||{});
  const items=[];
  for(const page of pages){
   const info=page.imageinfo?.[0],meta=info?.extmetadata||{},license=metaValue(meta,"LicenseShortName");
   if(!info||!permittedLicense(license)||!/^image\/(jpeg|png|webp)$/i.test(info.thumbmime||info.mime||""))continue;
   const url=info.thumburl||info.url;if(!url)continue;
   if((info.width&&info.width<700)||(info.height&&info.height<500))continue;
   items.push({
    title:String(page.title||"Wikimedia image"),url,pageUrl:"https://commons.wikimedia.org/wiki/"+encodeURIComponent(String(page.title||"").replace(/ /g,"_")),
    author:metaValue(meta,"Artist")||metaValue(meta,"Credit")||"Belirtilmemiş",
    license,licenseUrl:metaValue(meta,"LicenseUrl"),width:info.width||0,height:info.height||0
   });
  }
  return items;
 }finally{clearTimeout(timer);}
}
function loadImage(item){
 return new Promise((resolve,reject)=>{
  const img=new Image(),timer=setTimeout(()=>{img.src="";reject(Error("Görsel zaman aşımı"));},12000);
  img.crossOrigin="anonymous";img.decoding="async";
  img.onload=()=>{clearTimeout(timer);resolve({...item,img});};
  img.onerror=()=>{clearTimeout(timer);reject(Error("Görsel yüklenemedi veya CORS izni yok"));};
  img.src=item.url;
 });
}
function searchQueryVariants(sceneText,title){
 const main=extractSearchTerms(sceneText,title);
 const secondary=extractSearchTerms(title,"");
 const sceneOnly=extractSearchTerms(sceneText,"");
 return [...new Set([main,secondary,sceneOnly].filter(Boolean))];
}
async function searchSceneAssets(timeline,title,ownImages){
 const assets=new Array(timeline.length).fill(null),credits=[],usedUrls=new Set();
 const jobs=timeline.map((scene,i)=>({scene,i,queries:searchQueryVariants(scene.caption,title)}));
 let cursor=0;
 const workers=Array.from({length:3},async()=>{
  while(cursor<jobs.length){
   const job=jobs[cursor++];
   for(const query of job.queries){
    try{
     const results=await searchCommons(query);
     let loaded=null;
     for(const item of results.slice(0,10)){
      if(usedUrls.has(item.url))continue;
      try{loaded=await loadImage(item);usedUrls.add(item.url);break;}catch{}
     }
     if(loaded){assets[job.i]=loaded;credits.push(loaded);break;}
    }catch(e){console.warn("Commons search failed",query,e);}
   }
   if(!assets[job.i]&&ownImages.length)assets[job.i]=ownImages[job.i%ownImages.length];
  }
 });
 await Promise.all(workers);
 return{assets,credits};
}
function loadOwnImages(files){
 return Promise.all(files.map(file=>new Promise((resolve,reject)=>{
  const url=URL.createObjectURL(file),img=new Image();img.onload=()=>resolve({img,url,title:file.name,own:true});img.onerror=()=>{URL.revokeObjectURL(url);reject(Error(file.name+" okunamadı"));};img.src=url;
 })));
}
function drawPixelArt(ctx,x,y,size,caption,style,time){
 const unit=Math.max(6,Math.floor(size/18)),cols=[style.accent,style.accent2,style.paper,style.ink];
 const word=caption.toLowerCase();
 const block=(gx,gy,color=cols[(gx+gy)%cols.length])=>{ctx.fillStyle=color;ctx.fillRect(x+gx*unit,y+gy*unit,unit,unit);};
 if(/pac.?man|oyun|arcade|labirent|piksel|kod|bilgisayar/.test(word)){
  for(let row=0;row<13;row++)for(let col=0;col<18;col++)if(row===0||row===12||col===0||col===17||((row===3||row===9)&&col>3&&col<14))block(col,row,style.ink);
  for(let col=2;col<16;col+=2)block(col,6,style.paper);
  const px=4+(Math.floor((Math.sin(time*2)+1)*2));
  for(let yy=0;yy<5;yy++)for(let xx=0;xx<5;xx++){const dx=xx-2,dy=yy-2;if(dx*dx+dy*dy<=5&&!(xx>2&&Math.abs(yy-2)<=1))block(px+xx,4+yy,style.accent);}
  for(let yy=0;yy<5;yy++)for(let xx=0;xx<5;xx++)if(yy===0||xx===0||xx===4||yy===4)block(11+xx,4+yy,style.accent2);
 }else if(/minecraft|blok|inşa|harita|orman|ağaç|doğa/.test(word)){
  for(let col=0;col<18;col++)for(let row=10;row<14;row++)block(col,row,row===10?style.accent2:"#8B552D");
  for(const [tx,ty] of [[2,5],[7,3],[13,5]]){for(let yy=0;yy<5;yy++)for(let xx=0;xx<5;xx++)block(tx+xx,ty+yy,style.accent);for(let yy=0;yy<3;yy++)block(tx+2,ty+5+yy,"#8B552D");}
  for(let col=2;col<6;col++)block(col,2,style.paper);
 }else{
  for(let row=0;row<14;row++)for(let col=0;col<18;col++){
   const dx=col-9,dy=row-7,dist=Math.hypot(dx,dy);
   if(dist<5.5&&((col+row)%3!==0))block(col,row,dist<2.5?style.accent2:dist<4?style.accent:style.paper);
  }
  for(let i=0;i<6;i++)block(6+i,7,style.ink);
 }
}
function drawBackdrop(ctx,w,h,t,style){
 ctx.fillStyle=style.bg;ctx.fillRect(0,0,w,h);
 const drift=Math.sin(t*1.1)*w*.018;
 ctx.save();ctx.translate(drift,Math.cos(t*.8)*h*.012);ctx.globalAlpha=1;
 if(style.layout===0){
  ctx.fillStyle=style.accent;ctx.beginPath();ctx.moveTo(w*.72,0);ctx.lineTo(w,0);ctx.lineTo(w,h*.48);ctx.lineTo(w*.56,h*.27);ctx.closePath();ctx.fill();
  ctx.fillStyle=style.accent2;ctx.beginPath();ctx.arc(w*.06,h*.84,w*.22,0,Math.PI*2);ctx.fill();
 }else if(style.layout===1){
  ctx.fillStyle=style.accent;ctx.fillRect(w*.76,0,w*.24,h*.48);
  ctx.fillStyle=style.accent2;ctx.beginPath();ctx.arc(w*.08,h*.18,w*.16,0,Math.PI*2);ctx.fill();
  ctx.fillStyle=style.hookPlate;for(let i=0;i<5;i++)ctx.fillRect(w*(.12+i*.038),h*.74,w*.014,h*.07);
 }else if(style.layout===2){
  ctx.fillStyle=style.accent;ctx.beginPath();ctx.arc(w*.94,h*.14,w*.24,0,Math.PI*2);ctx.fill();
  ctx.fillStyle=style.accent2;ctx.beginPath();ctx.arc(w*.04,h*.83,w*.27,0,Math.PI*2);ctx.fill();
  ctx.strokeStyle=style.hookPlate;ctx.lineWidth=w*.012;for(let i=0;i<3;i++){ctx.beginPath();ctx.arc(w*.84,h*.16,w*(.09+i*.055),0,Math.PI*2);ctx.stroke();}
 }else if(style.layout===3){
  ctx.fillStyle=style.accent;ctx.beginPath();ctx.moveTo(0,h*.16);ctx.lineTo(w*.3,0);ctx.lineTo(w*.46,h*.35);ctx.lineTo(0,h*.52);ctx.closePath();ctx.fill();
  ctx.fillStyle=style.accent2;ctx.beginPath();ctx.moveTo(w*.72,h);ctx.lineTo(w,h*.62);ctx.lineTo(w,h);ctx.closePath();ctx.fill();
 }else if(style.layout===4){
  ctx.fillStyle=style.accent;for(let i=0;i<7;i++){ctx.save();ctx.translate(w*(.82+(i%2)*.06),h*(.12+i*.07));ctx.rotate(t*.18+i*.3);ctx.fillRect(-w*.016,-h*.12,w*.032,h*.24);ctx.restore();}
  ctx.fillStyle=style.accent2;ctx.beginPath();ctx.arc(w*.08,h*.78,w*.2,0,Math.PI*2);ctx.fill();
 }else if(style.layout===5){
  ctx.fillStyle=style.accent;ctx.fillRect(0,h*.08,w*.11,h*.36);ctx.fillRect(w*.89,h*.56,w*.11,h*.34);
  ctx.fillStyle=style.accent2;ctx.beginPath();ctx.moveTo(w*.7,0);ctx.lineTo(w,0);ctx.lineTo(w,h*.23);ctx.closePath();ctx.fill();
 }else{
  ctx.fillStyle=style.accent;ctx.beginPath();ctx.moveTo(0,h*.64);ctx.lineTo(w*.22,h*.47);ctx.lineTo(w*.38,h*.68);ctx.lineTo(w*.56,h*.49);ctx.lineTo(w*.76,h*.68);ctx.lineTo(0,h*.94);ctx.closePath();ctx.fill();
  ctx.fillStyle=style.accent2;ctx.beginPath();ctx.arc(w*.94,h*.15,w*.17,0,Math.PI*2);ctx.fill();
 }
 ctx.fillStyle=style.hookPlate;const dot=w*.006;
 for(let row=0;row<6;row++)for(let col=0;col<6;col++){const xx=w*.08+col*w*.027,yy=h*.035+row*h*.018;ctx.globalAlpha=.34;ctx.beginPath();ctx.arc(xx,yy,dot,0,Math.PI*2);ctx.fill();}
 ctx.restore();
}
function drawImageInSquare(ctx,image,x,y,size,time,style){
 const zoom=1.04+.035*(.5+.5*Math.sin(time*1.1+style.shapeSeed)),iw=image.width,ih=image.height;
 const scale=Math.max(size/iw,size/ih)*zoom,sw=size/scale,sh=size/scale;
 const panX=.5+.12*Math.sin(time*.48+style.shapeSeed),panY=.5+.08*Math.cos(time*.42+style.shapeSeed);
 const sx=Math.max(0,Math.min(iw-sw,(iw-sw)*panX)),sy=Math.max(0,Math.min(ih-sh,(ih-sh)*panY));
 ctx.drawImage(image,sx,sy,sw,sh,x,y,size,size);
}
function drawFrame(ctx,w,h,time,duration,timeline,assets,title,styles,hook){
 const scene=timeline.find(x=>time>=x.start&&time<x.end)||timeline[timeline.length-1];
 const style=styles[scene.index],local=Math.max(0,time-scene.start),progress=Math.max(0,Math.min(1,time/duration));
 const image=assets[scene.index]?.img;
 drawBackdrop(ctx,w,h,time,style);
 // Fixed center / chest-level square visual stage.
 const size=Math.min(w*.83,h*.49),x=(w-size)/2,y=h*.175;
 ctx.save();ctx.shadowColor="rgba(0,0,0,.3)";ctx.shadowBlur=w*.035;ctx.shadowOffsetY=h*.012;ctx.fillStyle="#101018";
 ctx.beginPath();ctx.roundRect(x-w*.014,y-w*.014,size+w*.028,size+w*.028,w*.035);ctx.fill();ctx.restore();
 ctx.save();ctx.beginPath();ctx.roundRect(x,y,size,size,w*.018);ctx.clip();
 if(image)drawImageInSquare(ctx,image,x,y,size,local,style);
 else{ctx.fillStyle="#A7E3FF";ctx.fillRect(x,y,size,size);drawPixelArt(ctx,x+size*.08,y+size*.10,size*.84,scene.caption,style,local);}
 // Solid color tabs frame the illustration, avoiding overlays across the image.
 ctx.fillStyle=style.accent;ctx.fillRect(x,y,size*.2,Math.max(8,w*.014));
 ctx.fillStyle=style.accent2;ctx.fillRect(x+size*.8,y+size*.97,size*.2,Math.max(8,w*.014));
 ctx.restore();

 // Hook: manually entered one-line/ two-line attention banner at the top.
 if(hook){
  const hookFont=Math.round(w*.044);ctx.font="900 "+hookFont+"px system-ui, -apple-system, sans-serif";
  const hookLines=wrapLines(ctx,hook,w*.82,2),hookHeight=hookLines.length*hookFont*1.16+hookFont*.72;
  const hookWidth=w*.9,hookX=(w-hookWidth)/2,hookY=h*.035;
  rounded(ctx,hookX,hookY,hookWidth,hookHeight,w*.018,style.hookPlate);
  ctx.fillStyle=style.hookText;ctx.textAlign="center";ctx.textBaseline="middle";
  hookLines.forEach((line,i)=>ctx.fillText(line,w/2,hookY+hookFont*.36+hookFont*1.16*(i+.5)));
 }

 // Caption: no outline/stroke. Black sits on a light plate, white on a saturated plate.
 const caption=scene.caption.trim();
 let font=Math.round(w*(caption.split(/\s+/).length<5?.078:caption.split(/\s+/).length<9?.069:.061));
 let lines=[];
 ctx.textAlign="center";ctx.textBaseline="middle";
 do{ctx.font="900 "+font+"px system-ui, -apple-system, sans-serif";lines=wrapLines(ctx,caption,w*.83,3);if(lines.length>3)font-=2;}while(lines.length>3&&font>w*.045);
 const lineHeight=font*1.14,plaqueHeight=lines.length*lineHeight+font*.62,plaqueWidth=w*.91;
 const plaqueX=(w-plaqueWidth)/2,plaqueY=h*.735-plaqueHeight/2;
 rounded(ctx,plaqueX,plaqueY,plaqueWidth,plaqueHeight,0,style.captionPlate);
 ctx.fillStyle=style.captionText;
 lines.forEach((line,i)=>ctx.fillText(line,w/2,plaqueY+font*.31+lineHeight*(i+.5)));

 // Video-duration bar uses the exact audio clock fraction on every frame.
 const barH=Math.max(8,h*.009),barY=h*.982;
 ctx.fillStyle=style.progressTrack;ctx.fillRect(0,barY,w,barH);
 ctx.fillStyle=style.progressFill;ctx.fillRect(0,barY,w*progress,barH);
}
function wrapLines(ctx,text,maxWidth,maxLines){
 const words=text.split(/\s+/),lines=[];let line="";
 for(const word of words){const test=(line+" "+word).trim();if(ctx.measureText(test).width>maxWidth&&line){lines.push(line);line=word;}else line=test;}
 if(line)lines.push(line);return lines.slice(0,maxLines);
}
async function verifyVideoDuration(blob,expected){
 const url=URL.createObjectURL(blob);
 try{return await new Promise((resolve,reject)=>{
  const video=document.createElement("video");video.preload="metadata";video.muted=true;
  const timer=setTimeout(()=>{URL.revokeObjectURL(url);reject(Error("MP4 süresi okunamadı; dosya doğrulanamadı."));},12000);
  video.onloadedmetadata=()=>{clearTimeout(timer);const duration=video.duration;URL.revokeObjectURL(url);if(!Number.isFinite(duration)||Math.abs(duration-expected)>Math.max(1.5,expected*.04))reject(Error("Render süresi kontrolü başarısız: beklenen "+expected.toFixed(1)+" sn, oluşan "+(Number(duration)||0).toFixed(1)+" sn. Eksik video indirmeye sunulmadı."));else resolve(duration);};
  video.onerror=()=>{clearTimeout(timer);URL.revokeObjectURL(url);reject(Error("Safari oluşturduğu MP4 dosyasını doğrulayamadı."));};video.src=url;
 });}catch(e){throw e;}
}
async function renderLocally(){
 const text=$("#scriptText").value.trim(),title=$("#topicTitle").value.trim()||"Content Factory Shorts",hook=$("#hookText").value.trim(),file=state.reference;
 if(!text||!file)throw Error("Önce metin ve ses dosyası ekle.");
 if(!hook)throw Error("Her Shorts için üstte görünecek kanca yazısını gir.");
 const Audio=window.AudioContext||window.webkitAudioContext;
 if(!Audio||!HTMLCanvasElement.prototype.captureStream||!window.MediaRecorder)throw Error("Safari bu iPhone'da yerel video üretimini desteklemiyor.");
 const mime=["video/mp4;codecs=avc1.42E01E,mp4a.40.2","video/mp4"].find(x=>MediaRecorder.isTypeSupported(x));
 if(!mime)throw Error("Bu iPhone Safari sürümünde MP4 kodlayıcı bulunamadı. WebM dosyası MP4 diye sunulmayacak.");
 setProgress(3);setText("#renderStatus","Ses dosyası iPhone belleğine alınıyor…");
 const audioContext=new Audio();await audioContext.resume();
 const decoded=await audioContext.decodeAudioData(await file.arrayBuffer());
 if(decoded.duration>180)throw Error("İlk iPhone sürümünde en fazla 3 dakikalık ses destekleniyor.");
 setProgress(10);setText("#renderStatus","Ses dalgası analiz ediliyor; konuşmayı koruyan sessizlik temizliği yapılıyor…");
 const analysis=detectSpeech(decoded),clean=concatenateAudio(decoded,analysis);
 if(clean.duration<4)throw Error("Temizlenmiş ses çok kısa. Farklı bir kayıt seç.");
 const timeline=timelineFor(text,clean.duration),seed=randomSeed(),rawStyles=makeSceneStyles(timeline.length,seed),contrastAudit=auditSceneContrast(rawStyles),styles=contrastAudit.styles;
 const ownImages=await loadOwnImages(state.visualFiles||[]);
 setProgress(15);setText("#renderStatus",timeline.length+" sahne için internette açık lisanslı görseller aranıyor…");
 const found=await searchSceneAssets(timeline,title,ownImages),assets=found.assets;
 const imageCount=assets.filter(Boolean).length;
 setProgress(30);setText("#renderStatus",imageCount+" sahne görseli bulundu. "+contrastAudit.scenes+" sahne kontrast kontrolünden geçti (en düşük "+contrastAudit.minContrast.toFixed(1)+":1).");
 const quality=$("#localQuality")?.value||"1080",w=quality==="720"?720:1080,h=quality==="720"?1280:1920,fps=24;
 const canvas=document.createElement("canvas");canvas.width=w;canvas.height=h;canvas.style.cssText="position:fixed;left:-3000px;top:0;width:2px;height:2px;";document.body.append(canvas);
 const ctx=canvas.getContext("2d",{alpha:false});if(!ctx)throw Error("Canvas çizim alanı açılamadı.");
 const canvasStream=canvas.captureStream(fps),videoTrack=canvasStream.getVideoTracks()[0],audioDestination=audioContext.createMediaStreamDestination(),source=audioContext.createBufferSource();
 source.buffer=clean;source.connect(audioDestination);
 const stream=new MediaStream([...canvasStream.getVideoTracks(),...audioDestination.stream.getAudioTracks()]);
 let recorder;try{recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:quality==="720"?3800000:7000000,audioBitsPerSecond:192000});}
 catch(e){canvas.remove();throw Error("iPhone MP4 kodlayıcısı başlatılamadı: "+e.message);}
 let wakeLock=null;try{if(navigator.wakeLock)wakeLock=await navigator.wakeLock.request("screen");}catch{}
 let raf=0,stopped=false,startedAt=0,finishTimer=0,finishDelay=0,settled=false;
 const stopTracks=()=>stream.getTracks().forEach(t=>t.stop());
 const cleanup=async()=>{cancelAnimationFrame(raf);clearTimeout(finishTimer);clearTimeout(finishDelay);stopTracks();canvas.remove();ownImages.forEach(x=>revoke(x.url));try{if(wakeLock)await wakeLock.release();}catch{}try{await audioContext.close();}catch{}};
 const result=new Promise((resolve,reject)=>{
  const fail=error=>{if(settled)return;settled=true;stopped=true;cancelAnimationFrame(raf);clearTimeout(finishTimer);if(recorder.state!=="inactive")try{recorder.stop();}catch{};reject(error);};
  const finish=()=>{if(stopped)return;stopped=true;cancelAnimationFrame(raf);clearTimeout(finishTimer);if(recorder.state==="recording")recorder.stop();};
  recorder.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data);};
  const chunks=[];
  recorder.onerror=()=>fail(Error("Safari MP4 kodlama işlemini durdurdu."));
  recorder.onstop=()=>{stopTracks();if(settled)return;const blob=new Blob(chunks,{type:recorder.mimeType||mime});if(blob.size<80000)fail(Error("MP4 kaydı boş veya eksik. Kaliteyi 720p yapıp yeniden dene."));else{settled=true;resolve(blob);}};
  source.onended=()=>{drawFrame(ctx,w,h,clean.duration,clean.duration,timeline,assets,title,styles,hook);videoTrack?.requestFrame?.();setProgress(96);finishDelay=setTimeout(finish,350);};
  try{recorder.start();}catch(e){fail(Error("Safari kayıt başlatamadı: "+e.message));return;}
  startedAt=audioContext.currentTime;
  finishTimer=setTimeout(()=>{if(!stopped)fail(Error("Sesin tamamı çalınmadan render zaman aşımına uğradı. Safari'yi önde tut ve 720p ile tekrar dene."));},Math.ceil(clean.duration*1000)+18000);
  const frame=()=>{
   if(stopped)return;
   const elapsed=Math.min(clean.duration,Math.max(0,audioContext.currentTime-startedAt));
   drawFrame(ctx,w,h,elapsed,clean.duration,timeline,assets,title,styles,hook);
   setProgress(30+Math.round(62*elapsed/clean.duration));
   if(elapsed<clean.duration-.02)raf=requestAnimationFrame(frame);
  };
  drawFrame(ctx,w,h,0,clean.duration,timeline,assets,title,styles,hook);
  raf=requestAnimationFrame(frame);source.start();
 });
 let blob;
 try{blob=await result;await verifyVideoDuration(blob,clean.duration);}
 finally{await cleanup();}
 revoke(state.videoUrl);revoke(state.audioUrl);revoke(state.creditsUrl);
 state.videoUrl=URL.createObjectURL(blob);state.audioUrl=URL.createObjectURL(wavBlob(clean));
 const creditLines=["CONTENT FACTORY — KAYNAK VE LİSANS KAYDI","Başlık: "+title,"Kanca: "+(hook||"(manuel kanca girilmedi)"),"Orijinal ses: "+decoded.duration.toFixed(2)+" sn","Üretilen video: "+clean.duration.toFixed(2)+" sn","Temizlenen sessizlik: "+analysis.removed.toFixed(2)+" sn","Arka plan: Bu rendera özel rastgele oluşturulmuş renk/şekil kompozisyonu","Kontrast kalite kontrolü: "+contrastAudit.scenes+" sahne, minimum "+contrastAudit.minContrast.toFixed(1)+":1, WCAG AA eşiği 4.5:1 üzerinde",""];
 for(let i=0;i<assets.length;i++){const item=assets[i];if(!item)continue;if(item.own){creditLines.push("Sahne "+(i+1)+": Kullanıcının yüklediği görsel — "+item.title);}else{creditLines.push("Sahne "+(i+1)+": "+item.title,"Yazar: "+item.author,"Lisans: "+item.license,"Lisans bağlantısı: "+item.licenseUrl,"Dosya sayfası: "+item.pageUrl,"");}}
 if(!imageCount)creditLines.push("Commons aramasında uygun görsel bulunamadı; bu sahneler özgün grafik illüstrasyonlarıyla oluşturuldu.");
 creditLines.push("Not: Wikimedia Commons dosyalarının her biri kendi dosya sayfasındaki lisans ve atıf koşullarıyla yeniden kullanılmalıdır.");
 state.creditsUrl=URL.createObjectURL(new Blob([creditLines.join("\n")],{type:"text/plain;charset=utf-8"}));
 $("#finalVideo").src=state.videoUrl;
 $("#renderStats").textContent="MP4 · "+w+"×"+h+" · "+clean.duration.toFixed(1)+" sn (orijinal "+decoded.duration.toFixed(1)+" sn) · "+analysis.removed.toFixed(1)+" sn sessizlik azaltıldı · "+imageCount+"/"+timeline.length+" sahnede internet/kullanıcı görseli · solid cartoon arka plan · kontrast kontrolü "+contrastAudit.minContrast.toFixed(1)+":1";
 $("#renderResult").classList.remove("hidden");setProgress(100);
 setText("#renderStatus","MP4 tamamlandı ve süre doğrulandı. Önizle, MP4'ü ve kaynak/lisans listesini kaydet.");
}
async function run(){
 const button=$("#startRender");if(state.rendering)return;
 state.rendering=true;button.disabled=true;button.textContent="iPhone'da Shorts üretiliyor…";
 $("#renderPanel").classList.remove("hidden");$("#renderResult").classList.add("hidden");setProgress(1);
 try{await renderLocally();button.textContent="Video hazırlandı";}
 catch(e){setText("#renderStatus","Üretim durdu: "+e.message);button.textContent="Tekrar dene · iPhone'da Shorts üret";}
 finally{state.rendering=false;button.disabled=!(state.reference&&$("#scriptText").value.trim()&&$("#hookText").value.trim());}
}
function download(url,name){if(!url)return;const a=document.createElement("a");a.href=url;a.download=name;document.body.append(a);a.click();a.remove();}
function init(){
 const old=$("#settingsToggle");if(old)old.onclick=()=>$("#engineSettings").classList.toggle("hidden");
 $("#startRender").onclick=run;
 $("#downloadVideo").onclick=()=>download(state.videoUrl,($("#topicTitle").value.trim()||"shorts").replace(/[^a-z0-9-_]/gi,"_")+".mp4");
 $("#downloadCleanAudio").onclick=()=>download(state.audioUrl,"shorts-cleaned-voice.wav");
 $("#downloadCredits").onclick=()=>download(state.creditsUrl,"sources-and-licenses.txt");
 $("#visualFiles").onchange=async e=>{state.visualFiles=Array.from(e.target.files||[]).slice(0,8);setText("#visualStatus",state.visualFiles.length+" referans görsel seçildi. İnternet görselleri her sahne için ayrıca aranacak.");};
 $("#scriptText").addEventListener("input",capabilities);$("#hookText").addEventListener("input",capabilities);$("#localQuality").addEventListener("change",capabilities);
 capabilities();
 const status=$("#recordStatus");if(status&&window.MutationObserver)new MutationObserver(capabilities).observe(status,{childList:true,subtree:true,characterData:true});
 $("#audioFile").addEventListener("change",()=>setTimeout(capabilities,50));
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
})();