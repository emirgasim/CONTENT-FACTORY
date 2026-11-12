const json = (data, status=200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const words = s => (s.toLowerCase().match(/[\\p{L}\\p{N}'%$.]+/gu) || []);
const parseTs = s => { const p=s.trim().replace(",",".").split(":").map(Number); return p.length===3?p[0]*3600+p[1]*60+p[2]:p[0]*60+p[1]; };
function cuesFrom(raw) {
  const lines=raw.replace(/\\r/g,"").split("\\n"), out=[]; let cur=null;
  for(const line of lines){ const m=line.match(/^\\s*(\\d[\\d:.,]+)\\s*-->\\s*(\\d[\\d:.,]+)/); if(m){cur={start:parseTs(m[1]),end:parseTs(m[2]),text:""};out.push(cur)} else if(cur&&line.trim()&&!/^\\d+$/.test(line.trim())) cur.text+=(cur.text?" ":"")+line.trim(); }
  return out.filter(x=>x.text);
}
function hookscore(hook){
 const w=words(hook), count=(re)=>[...hook.matchAll(re)].length;
 const specificity=Math.max(0,Math.min(100,34+count(/\\b\\d[\\d,.]*\\s?(%|k|m|x|s|m|h)?\\b/gi)*22-count(/\\b(amazing|incredible|insane|crazy|huge|massive|secret|powerful|best)\\b/gi)*16));
 const address=Math.min(100,26+count(/\\b(you|your|you're|yourself|sen|sana|senin|seni)\\b/gi)*20);
 const stakes=Math.min(100,22+count(/\\b(lose|lost|waste|quit|fail|cost|risk|stop|never|kaybet|risk|dur|asla)\\b/gi)*26);
 const curiosity=Math.min(100,24+count(/\\b(why|how|what|which|until|before|but|reason|neden|nasıl|hangi|ama|önce)\\b/gi)*17+(/[?？]$/.test(hook.trim())?18:0));
 const brevity=w.length===0?0:w.length>=9&&w.length<=24?100:Math.max(10,100-Math.abs(w.length-(w.length<9?9:24))*9);
 const parts={specificity,address,stakes,curiosity,brevity}, vals=Object.values(parts), score=Math.round(.6*vals.reduce((a,b)=>a+b,0)/5+.4*Math.min(...vals));
 return {hook,score,verdict:score>=72?"Güçlü":score>=55?"Geliştirilebilir":"Zayıf",parts,weakest:Object.keys(parts).sort((a,b)=>parts[a]-parts[b])[0],word_count:w.length,note:"Otomatik puanlama editoryal bir yardımcıdır; izlenme garantisi vermez."};
}
function titleCheck(title,thumb=""){
 const issues=[],good=[],n=title.length;
 if(n>100)issues.push("100 karakteri aşıyor");else if(n>60)issues.push("Masaüstü arama görünümünde kesilebilir");else good.push("60 karakter içinde");
 if(n>40)issues.push("Mobil akışta konu ilk 40 karakterde görünmeyebilir");
 const caps=title.split(/\\s+/).filter(x=>x.length>2&&x===x.toUpperCase());
 if(caps.length>2)issues.push("Aşırı büyük harf kullanımı");
 if(!/\\d/.test(title))issues.push("Somut sayı veya tarih yok");
 if(thumb){const stop=new Set(["the","a","an","of","for","to","in","on","and","or","the","ve","ile","bir"]);const a=new Set(words(title).filter(x=>!stop.has(x))),b=new Set(words(thumb).filter(x=>!stop.has(x)));const overlap=[...a].filter(x=>b.has(x));if(overlap.length)issues.push("Kapak metni başlığı tekrar ediyor: "+overlap.join(", "));if(words(thumb).length>4)issues.push("Kapak metni 4 kelimeden uzun");}
 return {title,characters:n,score:Math.max(0,100-issues.length*18+good.length*5),issues,good};
}
function deadair(raw,floor=.45){
 const cues=cuesFrom(raw);if(!cues.length)throw Error("SRT/VTT zaman damgalı altyazı bulunamadı.");
 const cuts=[];const filler=/^\\s*(um+|uh+|er+|ah+|so|okay|ok|right|yeah|like|anyway|basically|actually|you know|i mean|ıı|eee|şey|yani)[\\s,.-]*$/i;
 cues.forEach((c,i)=>{if(filler.test(c.text))cuts.push({kind:"FILLER",start:c.start,end:c.end,why:c.text});if(i){const gap=c.start-cues[i-1].end;if(gap>floor)cuts.push({kind:"DEAD",start:+(cues[i-1].end+floor/2).toFixed(3),end:+(c.start-floor/2).toFixed(3),why:gap.toFixed(2)+"s gap"});}});
 const removed=cuts.reduce((s,c)=>s+Math.max(0,c.end-c.start),0),duration=cues.at(-1).end;
 return {duration,cue_count:cues.length,cuts,removed_seconds:+removed.toFixed(2),estimated_output_seconds:+(duration-removed).toFixed(2),note:"Bu bir kesim listesi önerisidir; burada medya dosyasına fiziksel kesim uygulanmaz."};
}
function chapters(raw,target=7){
 const cues=cuesFrom(raw);if(cues.length<6)throw Error("Bölüm önermek için en az 6 altyazı satırı gerekli.");
 const duration=cues.at(-1).end,points=[0];const step=duration/Math.max(3,Math.min(20,target));
 for(let i=1;i<target;i++){const t=Math.round(step*i);if(t-points.at(-1)>=10&&duration-t>=10)points.push(t);}
 return {valid:points.length>=3,chapters:points.map((t,i)=>({seconds:t,label:new Date(t*1000).toISOString().slice(11,19),draft_title:cues.filter(c=>c.start>=t&&c.start<(points[i+1]??duration)).slice(0,3).map(c=>c.text).join(" ").slice(0,65)||"Bölüm"})),note:"Bölüm başlıkları taslaktır; yayın öncesi düzenle."};
}
function retention(raw,duration=0){
 const rows=raw.trim().split(/\\r?\\n/).map(line=>line.split(",").map(x=>Number(x.trim().replace("%","")))).filter(x=>x.length>=2&&x.every(Number.isFinite));
 if(rows.length<8)throw Error("CSV içinde en az 8 sayısal veri satırı olmalı.");
 const xs=rows.map(x=>x[0]),ys=rows.map(x=>x[1]),pct=Math.max(...xs)<=100.5,cutoff=pct?(duration?30/duration*100:10):30;
 const hookEnd=Math.min(...rows.filter(x=>x[0]<=cutoff).map(x=>x[1]),ys[0]);
 const drops=rows.slice(1).map((r,i)=>({from:xs[i],to:r[0],lost:+(ys[i]-r[1]).toFixed(2)})).filter(x=>x.lost>0).sort((a,b)=>b.lost-a.lost).slice(0,5);
 return {points:rows.length,start:ys[0],end:ys.at(-1),hook_loss:+(ys[0]-hookEnd).toFixed(2),largest_drops:drops,note:"CSV sütunları konum ve izleyici tutma yüzdesi olarak yorumlandı."};
}
function viral(raw,min=1.5){
 let data=JSON.parse(raw);if(!Array.isArray(data))data=data.videos||[];const groups={};data.forEach(v=>(groups[v.channel||"Bilinmeyen"]=groups[v.channel||"Bilinmeyen"]||[]).push(v));
 const out=[],skipped=[];for(const [channel,vs] of Object.entries(groups)){if(vs.length<4){skipped.push({channel,count:vs.length});continue}const a=vs.map(v=>Number(v.views)||0).sort((x,y)=>x-y),mid=a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;vs.forEach(v=>{const mult=mid?(Number(v.views)||0)/mid:0;if(mult>=min)out.push({channel,title:v.title||"",views:Number(v.views)||0,channel_median:mid,multiple:+mult.toFixed(2),url:v.url||""})})}
 return {outliers:out.sort((a,b)=>b.multiple-a.multiple),skipped_channels:skipped,note:"Bu araç yalnızca sağladığın JSON verisini analiz eder; YouTube'dan otomatik veri çekmez."};
}
export async function onRequestPost({request}){
 let body;try{body=await request.json()}catch{return json({detail:"Geçersiz JSON."},400)}
 const {tool,params={}}=body||{};if(!params||typeof params!=="object"||Array.isArray(params))return json({detail:"params nesne olmalı."},400);
 try{
 let result;
 if(tool==="hookscore"){const s=String(params.hook||"").trim();if(!s||s.length>500)throw Error("Kanca 1–500 karakter olmalı.");result=hookscore(s)}
 else if(tool==="title"){const s=String(params.title||"").trim();if(!s||s.length>120)throw Error("Başlık 1–120 karakter olmalı.");result=titleCheck(s,String(params.thumb||"").slice(0,80))}
 else if(tool==="deadair"){const s=String(params.srt||"");if(!s||s.length>2000000)throw Error("SRT/VTT boş veya 2 MB sınırını aşıyor.");result=deadair(s,Math.min(3,Math.max(.1,Number(params.floor)||.45)))}
 else if(tool==="chapters"){const s=String(params.srt||"");if(!s||s.length>2000000)throw Error("SRT/VTT boş veya 2 MB sınırını aşıyor.");result=chapters(s,Math.min(20,Math.max(3,Number(params.target)||7)))}
 else if(tool==="retention"){const s=String(params.csv||"");if(!s||s.length>2000000)throw Error("CSV boş veya 2 MB sınırını aşıyor.");result=retention(s,Number(params.duration)||0)}
 else if(tool==="viral"){const s=String(params.json||"");if(!s||s.length>2000000)throw Error("JSON boş veya 2 MB sınırını aşıyor.");result=viral(s,Math.min(20,Math.max(1,Number(params.min)||1.5)))}
 else return json({detail:"Bilinmeyen analiz aracı."},400);
 return json({ok:true,tool,result});
 }catch(e){return json({detail:e.message||"Analiz hatası."},422)}
}
