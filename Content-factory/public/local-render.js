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
 // Each sentence (and meaningful clause) gets its own visual. No fixed word or second cadence.
 const normalized=String(text||"").replace(/\s+/g," ").trim();
 const sentences=(normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/gu)||[normalized]).map(x=>x.trim()).filter(Boolean);
 const scenes=[];
 for(const sentence of sentences){
  const clauses=sentence.split(/(?<=[;:])\s+|(?<=—)\s+/u).map(x=>x.trim()).filter(Boolean);
  for(const clause of clauses)scenes.push(clause);
 }
 return scenes.length?scenes:[normalized];
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
  "oyun":"video game arcade","menü":"video game menu","menu":"video game menu","minecraft":"Minecraft video game landscape","pacman":"Pac-Man arcade maze","rocky":"Rocky film","stallone":"Sylvester Stallone","sylvester":"Sylvester Stallone","köpek":"dog","köpeği":"dog","köpeğin":"dog","köpeğini":"dog","butkus":"Butkus dog","senaryo":"screenplay","senaryoyu":"screenplay",
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
 if(/non.?commercial|\bnc\b|\bnd\b|no.?derivatives/.test(s))return false;
 return /cc0|cc\s*0|public domain|\bpdm\b|(^|[^a-z])(?:cc[- ]?)?by(?:[- ]?sa)?(?:[^a-z]|$)|creative commons attribution(?:-sharealike)?/.test(s);
}

function metaValue(meta,key){return String(meta?.[key]?.value||"").replace(/<[^>]*>/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim();}
async function searchCommons(query,continuation=null){
 const params=new URLSearchParams({
  action:"query",format:"json",origin:"*",generator:"search",gsrsearch:query,
  gsrnamespace:"6",gsrlimit:"50",prop:"imageinfo",
  iiprop:"url|extmetadata|thumbmime",iiurlwidth:"1400"
 });
 if(continuation)params.set("gsrcontinue",String(continuation));
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),16000);
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
  return {items,continuation:data.continue?.gsrcontinue??null};
 }finally{clearTimeout(timer);}
}
function loadImage(item){
 return new Promise((resolve,reject)=>{
  const img=new Image(),timer=setTimeout(()=>{img.src="";reject(Error("Görsel zaman aşımı"));},12000);
  img.crossOrigin="anonymous";img.decoding="async";img.referrerPolicy="no-referrer";
  img.onload=()=>{clearTimeout(timer);resolve({...item,img});};
  img.onerror=()=>{clearTimeout(timer);reject(Error("Görsel yüklenemedi veya CORS izni yok"));};
  img.src=item.proxyUrl||item.url;
 });
}
function searchQueryVariants(sceneText,title){
 const topic=extractSearchTerms(title,""),scene=extractSearchTerms(sceneText,"");
 const raw=(String(title||"")+" "+String(sceneText||"")).toLocaleLowerCase("tr-TR");
 const variants=[scene+" "+topic,scene,topic];
 if(/rocky|stallone|butkus/.test(raw))variants.unshift("Sylvester Stallone Rocky film dog Butkus");
 if(/minecraft|blok|oyun/.test(raw))variants.unshift("Minecraft video game landscape gameplay");
 return [...new Set(variants.map(x=>x.replace(/\s+/g," ").trim()).filter(x=>x.length>=3))].slice(0,5);
}

function sceneImageTarget(scene){
 // One context-matched visual per complete sentence/clause; scene duration is proportional to spoken word count.
 return 1;
}
async function searchOpenverse(query){
 const params=new URLSearchParams({q:query,page_size:"30",license:"cc0,pdm,by,by-sa",filter_dead:"true",extension:"jpg,jpeg,png,webp"});
 const response=await fetch("https://api.openverse.org/v1/images/?"+params.toString(),{mode:"cors",credentials:"omit"});
 if(!response.ok)throw Error("Openverse HTTP "+response.status);
 const data=await response.json();
 return (data.results||[]).map(x=>({
  title:x.title||"Openverse image",url:x.thumbnail||x.url,pageUrl:x.foreign_landing_url||x.detail_url,
  author:x.creator||"Not specified",license:String(x.license||"").toUpperCase(),
  licenseUrl:x.license_url||"",width:x.width||0,height:x.height||0,source:"Openverse / "+(x.source||"open collection")
 })).filter(x=>x.url&&x.pageUrl&&permittedLicense(x.license));
}
async function searchLibraryOfCongress(query){
 const params=new URLSearchParams({fo:"json",q:query,c:"30",sp:"1"});
 const response=await fetch("https://www.loc.gov/search/?"+params.toString(),{mode:"cors",credentials:"omit"});
 if(!response.ok)throw Error("Library of Congress HTTP "+response.status);
 const data=await response.json();
 return (data.results||[]).map(x=>{
  const rights=Array.isArray(x.rights)?x.rights.join(" "):String(x.rights||"");
  const open=/public domain|no known restrictions|no known copyright restrictions|unrestricted/i.test(rights);
  const url=Array.isArray(x.image_url)?(x.image_url.find(u=>/\.jpe?g|\.png|\.webp/i.test(u))||x.image_url[0]):x.image_url;
  return {title:x.title||"Library of Congress image",url,pageUrl:x.id||x.url,author:x.contributor||"Library of Congress",license:open?"Public domain / no known restrictions":"",licenseUrl:"https://www.loc.gov/legal/",width:0,height:0,source:"Library of Congress"};
 }).filter(x=>x.url&&x.pageUrl&&x.license);
}
async function searchSource(source,query,continuation=null){
 if(source==="Wikimedia Commons"){
  const page=await searchCommons(query,continuation);
  return {...page,items:page.items.map(x=>({...x,source:"Wikimedia Commons"}))};
 }
 if(source==="Openverse")return{items:await searchOpenverse(query),continuation:null};
 if(source==="Library of Congress")return{items:await searchLibraryOfCongress(query),continuation:null};
 return{items:[],continuation:null};
}
async function searchSceneAssets(timeline,title,ownImages){
 const assets=new Array(timeline.length).fill(null),credits=[],usedUrls=new Set(),own=ownImages||[];
 const jobs=timeline.map((scene,i)=>({scene,i,queries:searchQueryVariants(scene.caption,title)}));
 let cursor=0;
 const workers=Array.from({length:4},async()=>{
  while(cursor<jobs.length){
   const job=jobs[cursor++];
   for(const query of job.queries){
    if(assets[job.i])break;
    try{
     const response=await fetch("/api/visual-search?q="+encodeURIComponent(query),{headers:{"Accept":"application/json"},cache:"force-cache"});
     if(!response.ok)throw Error("Stok görsel araması HTTP "+response.status);
     const payload=await response.json();
     for(const item of payload.items||[]){
      if(assets[job.i])break;
      if(!item.url||usedUrls.has(item.url))continue;
      usedUrls.add(item.url);
      try{const loaded=await loadImage(item);assets[job.i]=loaded;credits.push(loaded);}
      catch(error){console.warn("Stock image proxy could not load:",item.title,error);}
     }
    }catch(error){console.warn("Stock search failed:",query,error);}
   }
   if(!assets[job.i]&&own.length)assets[job.i]=own[job.i%own.length];
  }
 });
 await Promise.all(workers);
 const unique=assets.filter(Boolean).filter((item,index,list)=>list.findIndex(x=>(x.originalUrl||x.url)===(item.originalUrl||item.url))===index);
 if(!unique.length)throw Error("Konuya uygun gerçek stok fotoğrafı bulunamadı. Piksel çizim veya geometrik görsel üretmek yerine render durduruldu. İnternet bağlantısını kontrol edip yeniden dene.");
 for(let i=0;i<assets.length;i++)if(!assets[i])assets[i]=unique[i%unique.length];
 return{assets,credits:unique,required:timeline.length,found:assets.filter(Boolean).length,unique:unique.length};
}

function loadOwnImages(files){
 return Promise.all(files.map(file=>new Promise((resolve,reject)=>{
  const url=URL.createObjectURL(file),img=new Image();img.onload=()=>resolve({img,url,title:file.name,own:true});img.onerror=()=>{URL.revokeObjectURL(url);reject(Error(file.name+" okunamadı"));};img.src=url;
 })));
}


function buildAudioMotion(buffer){
 const hop=Math.max(256,Math.floor(buffer.sampleRate*.025)),count=Math.ceil(buffer.length/hop),values=new Float32Array(count);
 for(let frame=0;frame<count;frame++){
  const start=frame*hop,end=Math.min(buffer.length,start+hop);let sum=0,samples=0;
  for(let channel=0;channel<buffer.numberOfChannels;channel++){const data=buffer.getChannelData(channel);for(let i=start;i<end;i+=4){const v=data[i];sum+=v*v;samples++;}}
  values[frame]=Math.sqrt(sum/Math.max(1,samples));
 }
 const peak=Math.max(.001,percentile(Array.from(values),.92));
 return{step:hop/buffer.sampleRate,values,peak};
}
function audioMotionAt(motion,time){
 if(!motion?.values?.length)return{energy:.25,hit:0};
 const position=Math.max(0,time/motion.step),index=Math.min(motion.values.length-1,Math.floor(position));
 const next=Math.min(motion.values.length-1,index+1),fraction=position-index;
 const current=motion.values[index]*(1-fraction)+motion.values[next]*fraction,previous=motion.values[Math.max(0,index-2)];
 return{energy:Math.max(0,Math.min(1.4,current/motion.peak)),hit:Math.max(0,Math.min(1,(current-previous)/motion.peak*2.8))};
}
function drawBackdrop(ctx,w,h,t,style,motion){
 const {energy,hit}=audioMotionAt(motion,t),pulse=.72+energy*.42+hit*.34;
 const gradient=ctx.createLinearGradient(w*(.12+Math.sin(t*.22)*.2),0,w*(.82+Math.cos(t*.19)*.12),h);
 gradient.addColorStop(0,style.bg);gradient.addColorStop(.52,style.accent);gradient.addColorStop(1,style.accent2);
 ctx.fillStyle=gradient;ctx.fillRect(0,0,w,h);
 ctx.save();ctx.globalCompositeOperation="screen";
 const glow=(x,y,r,color,alpha)=>{const g=ctx.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,color);g.addColorStop(1,"rgba(0,0,0,0)");ctx.globalAlpha=alpha;ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();};
 glow(w*(.14+.12*Math.sin(t*.42)),h*(.22+.05*Math.cos(t*.6)),w*(.42+.08*pulse),style.accent2,.42);
 glow(w*(.88+.07*Math.cos(t*.34)),h*(.72+.07*Math.sin(t*.51)),w*(.48+.1*pulse),style.accent,.38);
 ctx.globalAlpha=.16+.09*energy;ctx.strokeStyle="#FFFFFF";ctx.lineWidth=Math.max(3,w*.006);
 for(let ring=0;ring<5;ring++){const radius=w*(.13+ring*.07)+Math.sin(t*2.4+ring)*w*.012*pulse;ctx.beginPath();ctx.ellipse(w*(.5+.28*Math.sin(t*.18+ring)),h*(.48+.22*Math.cos(t*.16+ring)),radius,radius*1.28,t*.08+ring*.22,0,Math.PI*2);ctx.stroke();}
 ctx.globalAlpha=.16+.14*hit;ctx.lineWidth=Math.max(5,w*.009);ctx.beginPath();
 for(let x=0;x<=w;x+=w/60){const phase=x/w*Math.PI*5-t*3.1,y=h*(.52+Math.sin(phase)*(.035+.045*energy)+Math.sin(phase*.43+t)*.02);if(x===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}ctx.stroke();
 ctx.globalAlpha=.12+.12*energy;ctx.fillStyle=style.hookPlate;
 for(let i=0;i<18;i++){const x=((i*.173*w+t*w*.035)%w),y=(.12+(i%6)*.145)*h+Math.sin(t*1.5+i)*h*.018*pulse,r=w*(.004+(i%3)*.002)*(1+hit);ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
 ctx.restore();
}
function drawImageInFrame(ctx,image,x,y,width,height,time,style,motion){
 const {energy,hit}=audioMotionAt(motion,time),zoom=1.045+.04*energy+.018*hit;
 const iw=image.width,ih=image.height,scale=Math.max(width/iw,height/ih)*zoom,sw=width/scale,sh=height/scale;
 const panX=.5+.10*Math.sin(time*.38+style.shapeSeed),panY=.5+.07*Math.cos(time*.31+style.shapeSeed);
 const sx=Math.max(0,Math.min(iw-sw,(iw-sw)*panX)),sy=Math.max(0,Math.min(ih-sh,(ih-sh)*panY));
 ctx.drawImage(image,sx,sy,sw,sh,x,y,width,height);
}



function drawFrame(ctx,w,h,time,duration,timeline,assets,title,styles,hook,motion){
 const scene=timeline.find(x=>time>=x.start&&time<x.end)||timeline[timeline.length-1];
 const style=styles[scene.index],local=Math.max(0,time-scene.start),progress=Math.max(0,Math.min(1,time/duration));
 const image=assets[scene.index]?.img||null;
 drawBackdrop(ctx,w,h,time,style,motion);
 const frameW=w*.90,frameH=h*.375,x=(w-frameW)/2,y=h*.235;
 ctx.save();ctx.shadowColor=style.accent2;ctx.shadowBlur=w*(.035+audioMotionAt(motion,time).hit*.025);ctx.shadowOffsetY=h*.012;
 ctx.fillStyle="#101018";ctx.beginPath();ctx.roundRect(x-w*.014,y-w*.014,frameW+w*.028,frameH+w*.028,w*.035);ctx.fill();ctx.restore();
 ctx.save();ctx.beginPath();ctx.roundRect(x,y,frameW,frameH,w*.022);ctx.clip();
 if(!image)throw Error("Stok görsel eksik; yapay çizimle devam edilmeyecek.");
 drawImageInFrame(ctx,image,x,y,frameW,frameH,local,style,motion);
 const shade=ctx.createLinearGradient(0,y,0,y+frameH);shade.addColorStop(0,"rgba(0,0,0,.02)");shade.addColorStop(.72,"rgba(0,0,0,0)");shade.addColorStop(1,"rgba(0,0,0,.18)");
 ctx.fillStyle=shade;ctx.fillRect(x,y,frameW,frameH);ctx.restore();
 ctx.save();ctx.strokeStyle=style.hookPlate;ctx.lineWidth=Math.max(4,w*.006);ctx.globalAlpha=.9;ctx.beginPath();ctx.roundRect(x,y,frameW,frameH,w*.022);ctx.stroke();ctx.restore();
 const caption=scene.caption.trim();
 let font=Math.round(w*(caption.split(/\s+/).length<5?.078:caption.split(/\s+/).length<9?.069:.061)),lines=[];
 ctx.textAlign="center";ctx.textBaseline="middle";
 do{ctx.font="900 "+font+"px system-ui, -apple-system, sans-serif";lines=wrapLines(ctx,caption,w*.84,3);if(lines.length>3)font-=2;}while(lines.length>3&&font>w*.045);
 const lineHeight=font*1.14,plaqueHeight=lines.length*lineHeight+font*.62,plaqueWidth=w*.91;
 const plaqueX=(w-plaqueWidth)/2,plaqueY=h*.735-plaqueHeight/2;
 rounded(ctx,plaqueX,plaqueY,plaqueWidth,plaqueHeight,w*.012,style.captionPlate);
 if(hook){
  // Same bold font, point size and line rhythm as the lower caption; pill width follows text.
  ctx.font="900 "+font+"px system-ui, -apple-system, sans-serif";
  const hookLines=wrapLines(ctx,hook,w*.84,2);
  const hookLineHeight=font*1.14;
  const hookTextWidth=Math.max(0,...hookLines.map(line=>ctx.measureText(line).width));
  const hookWidth=Math.min(w*.9,hookTextWidth+w*.06);
  const hookHeight=hookLines.length*hookLineHeight+font*.5;
  const hookX=(w-hookWidth)/2,hookY=h*.075;
  rounded(ctx,hookX,hookY,hookWidth,hookHeight,w*.018,"#FFFFFF");
  ctx.fillStyle="#101018";ctx.textAlign="center";ctx.textBaseline="middle";
  hookLines.forEach((line,i)=>ctx.fillText(line,w/2,hookY+font*.25+hookLineHeight*(i+.5)));
 }
 ctx.fillStyle=style.captionText;lines.forEach((line,i)=>ctx.fillText(line,w/2,plaqueY+font*.31+lineHeight*(i+.5)));
 const barH=Math.max(8,h*.009),barY=h*.982;ctx.fillStyle=style.progressTrack;ctx.fillRect(0,barY,w,barH);ctx.fillStyle=style.progressFill;ctx.fillRect(0,barY,w*progress,barH);
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
 const text=$("#scriptText").value.trim(),title=$("#topicTitle").value.trim()||"Shorts",hook=$("#hookText").value.trim(),file=state.reference;
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
 const timeline=timelineFor(text,clean.duration),audioMotion=buildAudioMotion(clean),seed=randomSeed(),rawStyles=makeSceneStyles(timeline.length,seed),contrastAudit=auditSceneContrast(rawStyles),styles=contrastAudit.styles;
 const ownImages=await loadOwnImages(state.visualFiles||[]);
 setProgress(15);setText("#renderStatus",timeline.length+" cümle/ifade sahnesi için farklı açık görsel kaynaklarında konuya uygun görseller aranıyor…");
 const found=await searchSceneAssets(timeline,title,ownImages),assets=found.assets;
 const imageCount=found.found;
  if(found.unique<Math.min(2,timeline.length))throw Error("Yeterli sayıda konuya uygun gerçek stok fotoğrafı bulunamadı ("+found.unique+" farklı görsel). Sahte çizim veya geometrik görsel yerine render durduruldu. Biraz sonra tekrar dene.");
 setProgress(30);setText("#renderStatus",imageCount+"/"+found.required+" cümle sahnesine görsel bulundu. "+contrastAudit.scenes+" sahne kontrast kontrolünden geçti (en düşük "+contrastAudit.minContrast.toFixed(1)+":1).");
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
  source.onended=()=>{drawFrame(ctx,w,h,clean.duration,clean.duration,timeline,assets,title,styles,hook,audioMotion);videoTrack?.requestFrame?.();setProgress(96);finishDelay=setTimeout(finish,350);};
  try{recorder.start();}catch(e){fail(Error("Safari kayıt başlatamadı: "+e.message));return;}
  startedAt=audioContext.currentTime;
  finishTimer=setTimeout(()=>{if(!stopped)fail(Error("Sesin tamamı çalınmadan render zaman aşımına uğradı. Safari'yi önde tut ve 720p ile tekrar dene."));},Math.ceil(clean.duration*1000)+18000);
  const frame=()=>{
   if(stopped)return;
   const elapsed=Math.min(clean.duration,Math.max(0,audioContext.currentTime-startedAt));
   drawFrame(ctx,w,h,elapsed,clean.duration,timeline,assets,title,styles,hook,audioMotion);
   setProgress(30+Math.round(62*elapsed/clean.duration));
   if(elapsed<clean.duration-.02)raf=requestAnimationFrame(frame);
  };
  drawFrame(ctx,w,h,0,clean.duration,timeline,assets,title,styles,hook,audioMotion);
  raf=requestAnimationFrame(frame);source.start();
 });
 let blob;
 try{blob=await result;await verifyVideoDuration(blob,clean.duration);}
 finally{await cleanup();}
 revoke(state.videoUrl);revoke(state.audioUrl);revoke(state.creditsUrl);
 state.videoUrl=URL.createObjectURL(blob);state.audioUrl=URL.createObjectURL(wavBlob(clean));
 const creditLines=["CONTENT FACTORY — KAYNAK VE LİSANS KAYDI","Başlık: "+title,"Kanca: "+(hook||"(manuel kanca girilmedi)"),"Orijinal ses: "+decoded.duration.toFixed(2)+" sn","Üretilen video: "+clean.duration.toFixed(2)+" sn","Temizlenen sessizlik: "+analysis.removed.toFixed(2)+" sn","Arka plan: Ses genliğiyle eşzamanlı hareket eden canlı degrade, ışık halkaları ve dalga animasyonu","Kontrast kalite kontrolü: "+contrastAudit.scenes+" sahne, minimum "+contrastAudit.minContrast.toFixed(1)+":1, WCAG AA eşiği 4.5:1 üzerinde",""];
 for(let i=0;i<assets.length;i++){for(let j=0;j<(assets[i]?1:0);j++){const item=assets[i];if(!item)continue;if(item.own){creditLines.push("Sahne "+(i+1)+": Kullanıcının yüklediği görsel — "+item.title);}else{creditLines.push("Sahne "+(i+1)+": "+item.title,"Kaynak: "+(item.source||"Açık görsel koleksiyonu"),"Yazar: "+item.author,"Lisans: "+item.license,"Lisans bağlantısı: "+item.licenseUrl,"Dosya sayfası: "+item.pageUrl,"");}}}
 if(!imageCount)creditLines.push("Commons aramasında uygun görsel bulunamadı; bu sahneler özgün grafik illüstrasyonlarıyla oluşturuldu.");
 creditLines.push("Not: Wikimedia Commons dosyalarının her biri kendi dosya sayfasındaki lisans ve atıf koşullarıyla yeniden kullanılmalıdır.");
 state.creditsUrl=URL.createObjectURL(new Blob([creditLines.join("\n")],{type:"text/plain;charset=utf-8"}));
 $("#finalVideo").src=state.videoUrl;
 $("#renderStats").textContent="MP4 · "+w+"×"+h+" · "+clean.duration.toFixed(1)+" sn (orijinal "+decoded.duration.toFixed(1)+" sn) · "+analysis.removed.toFixed(1)+" sn sessizlik azaltıldı · "+imageCount+"/"+timeline.length+" sahnede internet/kullanıcı görseli · ses tepkili animasyonlu degrade · kontrast kontrolü "+contrastAudit.minContrast.toFixed(1)+":1";
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