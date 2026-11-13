const MAX_AUDIO=30*1024*1024,MAX_IMAGE=8*1024*1024,MAX_IMAGES=8,TTL_SECONDS=86400,CHUNK=16*1024*1024;
const json=(data,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store"}});
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
async function digest(value){return hex(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))));}
function safeName(value,fallback){const name=String(value||fallback).split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._-]/g,"_").slice(0,100);return name||fallback;}
async function putFile(kv,key,file){const buffer=await file.arrayBuffer(),parts=Math.ceil(buffer.byteLength/CHUNK);for(let i=0;i<parts;i++){const start=i*CHUNK,end=Math.min(start+CHUNK,buffer.byteLength);await kv.put(key+"/"+i,buffer.slice(start,end),{expirationTtl:TTL_SECONDS});}return {key,parts,size:buffer.byteLength};}
export async function onRequestPost({request,env}){
 const kv=env.SHORTS_TEMP;
 if(!kv)return json({error:"Ücretsiz geçici depolama bağlantısı eksik. Cloudflare Pages ayarlarında SHORTS_TEMP KV binding oluşturulmalı."},503);
 if(!env.GITHUB_ACTIONS_TOKEN)return json({error:"GitHub bulut işçisi henüz etkinleştirilmedi. Pages secret GITHUB_ACTIONS_TOKEN gerekli."},503);
 let form;try{form=await request.formData();}catch{return json({error:"Gönderilen proje formu okunamadı."},400);}
 const script=String(form.get("text")||"").trim(),title=String(form.get("title")||"Shorts").trim().slice(0,120),hook=String(form.get("hook")||"").trim().slice(0,100),audio=form.get("audio");
 if(!script||script.length>5000||!hook||!audio||typeof audio.arrayBuffer!=="function")return json({error:"Başlık, zorunlu kanca, metin ve ses dosyası gerekli."},400);
 if(audio.size<1||audio.size>MAX_AUDIO)return json({error:"Ses dosyası boş veya 30 MB sınırını aşıyor."},413);
 const images=form.getAll("images").filter(x=>x&&typeof x.arrayBuffer==="function"&&x.size>0);
 if(images.length>MAX_IMAGES||images.some(x=>x.size>MAX_IMAGE))return json({error:"En fazla 8 referans görsel, her biri en fazla 8 MB olabilir."},413);
 const ip=request.headers.get("CF-Connecting-IP")||"unknown",ipKey="limits/"+(await digest(ip)),now=Date.now();
 const old=await kv.get(ipKey,"json");let limit=old||{start:now,count:0};
 if(now-Number(limit.start)>3600000)limit={start:now,count:0};
 if(limit.count>=4)return json({error:"Bu bağlantıdan saatlik 4 üretim sınırına ulaşıldı. Biraz sonra tekrar dene."},429);
 const id=crypto.randomUUID().replace(/-/g,""),ownerToken=hex(crypto.getRandomValues(new Uint8Array(32))),prefix="jobs/"+id+"/";
 try{
  const audioName=safeName(audio.name,"narration.m4a"),audioFile=await putFile(kv,prefix+"input/audio",audio);
  const imageFiles=[];
  for(let i=0;i<images.length;i++){const name=safeName(images[i].name,"reference-"+i+".jpg"),stored=await putFile(kv,prefix+"input/image-"+String(i+1).padStart(2,"0"),images[i]);imageFiles.push({...stored,name,type:images[i].type||"image/jpeg"});}
  const createdAt=new Date(now).toISOString(),expiresAt=new Date(now+TTL_SECONDS*1000).toISOString();
  const meta={job_id:id,title,hook,text:script,audio:{...audioFile,name:audioName,type:audio.type||"application/octet-stream"},images:imageFiles,created_at:createdAt,expires_at:expiresAt};
  await kv.put(prefix+"input.json",JSON.stringify(meta),{expirationTtl:TTL_SECONDS});
  await kv.put(prefix+"owner.json",JSON.stringify({token_hash:await digest(ownerToken)}),{expirationTtl:TTL_SECONDS});
  await kv.put(prefix+"status.json",JSON.stringify({job_id:id,status:"queued",progress:1,message:"Bulut render kuyruğuna alındı.",created_at:createdAt,updated_at:createdAt,expires_at:expiresAt}),{expirationTtl:TTL_SECONDS});
  limit.count++;await kv.put(ipKey,JSON.stringify(limit),{expirationTtl:3600});
  const gh=await fetch("https://api.github.com/repos/emirgasim/CONTENT-FACTORY/actions/workflows/shorts-background.yml/dispatches",{method:"POST",headers:{"Authorization":"Bearer "+String(env.GITHUB_ACTIONS_TOKEN||"").trim(),"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","Content-Type":"application/json","User-Agent":"ContentFactory-CloudRenderer"},body:JSON.stringify({ref:"main",inputs:{job_id:id}})});
  if(gh.status!==204){
   let details="";
   try{const body=await gh.json();details=String(body.message||"")+(body.errors?.length?" · "+body.errors.map(x=>typeof x==="string"?x:(x.message||JSON.stringify(x))).join("; "):"");}
   catch{details=(await gh.text().catch(()=>"")).slice(0,500);}
   const reason=details||"GitHub yanıt gövdesi boş.";
   throw Error("GitHub workflow dispatch reddedildi (HTTP "+gh.status+"): "+reason+" [Request-ID: "+(gh.headers.get("x-github-request-id")||"yok")+"].");
  }
  return json({job_id:id,job_token:ownerToken,status:"queued",expires_at:expiresAt,message:"GitHub bulut işçisi işi kabul etti. iPhone ekranı kapansa da render devam eder."},202);
 }catch(error){
  const page=await kv.list({prefix,limit:1000});if(page.keys.length)await kv.delete(page.keys.map(x=>x.name));
  return json({error:"Bulut işi başlatılamadı: "+String(error.message||error)},502);
 }
}