const MAX_AUDIO=30*1024*1024,MAX_IMAGE=8*1024*1024,MAX_IMAGES=8,TTL_HOURS=24;
const json=(data,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store"}});
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
async function digest(value){return hex(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))));}
function safeName(value,fallback){const name=String(value||fallback).split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._-]/g,"_").slice(0,100);return name||fallback;}
async function removePrefix(bucket,prefix){let cursor;do{const page=await bucket.list({prefix,cursor,limit:1000});if(page.objects.length)await bucket.delete(page.objects.map(x=>x.key));cursor=page.truncated?page.cursor:undefined;}while(cursor);}
export async function onRequestPost({request,env}){
 if(!env.SHORTS_JOBS)return json({error:"Cloudflare R2 bağlantısı eksik. SHORTS_JOBS bucket binding kurulmalı."},503);
 if(!env.GITHUB_ACTIONS_TOKEN)return json({error:"GitHub bulut işçisi henüz etkinleştirilmedi. Pages secret GITHUB_ACTIONS_TOKEN gerekli."},503);
 let form;try{form=await request.formData();}catch{return json({error:"Gönderilen proje formu okunamadı."},400);}
 const script=String(form.get("text")||"").trim(),title=String(form.get("title")||"Shorts").trim().slice(0,120),hook=String(form.get("hook")||"").trim().slice(0,100),audio=form.get("audio");
 if(!script||script.length>5000||!hook||!audio||typeof audio.arrayBuffer!=="function")return json({error:"Başlık, zorunlu kanca, metin ve ses dosyası gerekli."},400);
 if(audio.size<1||audio.size>MAX_AUDIO)return json({error:"Ses dosyası boş veya 30 MB sınırını aşıyor."},413);
 const images=form.getAll("images").filter(x=>x&&typeof x.arrayBuffer==="function"&&x.size>0);
 if(images.length>MAX_IMAGES||images.some(x=>x.size>MAX_IMAGE))return json({error:"En fazla 8 referans görsel, her biri en fazla 8 MB olabilir."},413);
 const ip=request.headers.get("CF-Connecting-IP")||"unknown",ipKey="limits/"+(await digest(ip))+".json",now=Date.now();
 const old=await env.SHORTS_JOBS.get(ipKey);let limit=old?await old.json():{start:now,count:0};
 if(now-Number(limit.start)>3600000)limit={start:now,count:0};
 if(limit.count>=4)return json({error:"Bu bağlantıdan saatlik 4 üretim sınırına ulaşıldı. Biraz sonra tekrar dene."},429);
 const id=crypto.randomUUID().replace(/-/g,""),ownerToken=hex(crypto.getRandomValues(new Uint8Array(32))),prefix="jobs/"+id+"/";
 const suffix=(safeName(audio.name,"narration.m4a").match(/\.[a-zA-Z0-9]{2,5}$/)||[".bin"])[0].toLowerCase(),audioKey=prefix+"input/audio"+suffix,imageKeys=[];
 try{
  await env.SHORTS_JOBS.put(audioKey,await audio.arrayBuffer(),{httpMetadata:{contentType:audio.type||"application/octet-stream"}});
  for(let i=0;i<images.length;i++){const name=safeName(images[i].name,"reference-"+i+".jpg"),key=prefix+"input/images/"+String(i+1).padStart(2,"0")+"-"+name;await env.SHORTS_JOBS.put(key,await images[i].arrayBuffer(),{httpMetadata:{contentType:images[i].type||"image/jpeg"}});imageKeys.push({key,name,type:images[i].type||"image/jpeg"});}
  const createdAt=new Date(now).toISOString(),expiresAt=new Date(now+TTL_HOURS*3600000).toISOString();
  const meta={job_id:id,title,hook,text:script,audio:{key:audioKey,name:safeName(audio.name,"narration"+suffix),type:audio.type||"application/octet-stream"},images:imageKeys,created_at:createdAt,expires_at:expiresAt};
  await env.SHORTS_JOBS.put(prefix+"input.json",JSON.stringify(meta),{httpMetadata:{contentType:"application/json"}});
  await env.SHORTS_JOBS.put(prefix+"owner.json",JSON.stringify({token_hash:await digest(ownerToken)}),{httpMetadata:{contentType:"application/json"}});
  await env.SHORTS_JOBS.put(prefix+"status.json",JSON.stringify({job_id:id,status:"queued",progress:1,message:"Bulut render kuyruğuna alındı.",created_at:createdAt,updated_at:createdAt,expires_at:expiresAt}),{httpMetadata:{contentType:"application/json"}});
  const gh=await fetch("https://api.github.com/repos/emirgasim/CONTENT-FACTORY/actions/workflows/shorts-background.yml/dispatches",{method:"POST",headers:{"Authorization":"Bearer "+env.GITHUB_ACTIONS_TOKEN,"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","Content-Type":"application/json"},body:JSON.stringify({ref:"main",inputs:{job_id:id}})});
  if(gh.status!==204)throw Error("GitHub render işçisi başlatılamadı (HTTP "+gh.status+").");
  limit.count++;await env.SHORTS_JOBS.put(ipKey,JSON.stringify(limit),{expirationTtl:3600,httpMetadata:{contentType:"application/json"}});
  return json({job_id:id,job_token:ownerToken,status:"queued",expires_at:expiresAt,message:"Bulut render başlatıldı. iPhone ekranı kapansa da iş devam eder."},202);
 }catch(error){await removePrefix(env.SHORTS_JOBS,prefix);return json({error:"Bulut işi başlatılamadı: "+String(error.message||error)},502);}
}