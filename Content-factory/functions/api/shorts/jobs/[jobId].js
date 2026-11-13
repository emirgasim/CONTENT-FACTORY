const json=(data,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store"}});
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
async function digest(value){return hex(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))));}
async function owns(kv,id,request){if(!/^[a-f0-9]{32}$/.test(id))return false;const token=request.headers.get("X-Job-Token")||"";if(token.length<32)return false;const obj=await kv.get("jobs/"+id+"/owner.json","json");return !!obj&&(await digest(token))===obj.token_hash;}
async function removePrefix(kv,prefix){let cursor;do{const page=await kv.list({prefix,cursor,limit:1000});if(page.keys.length)await Promise.all(page.keys.map(x=>kv.delete(x.name)));cursor=page.list_complete?undefined:page.cursor;}while(cursor);}
export async function onRequestGet({request,env,params}){const kv=env.SHORTS_TEMP;if(!kv)return json({error:"Geçici KV depolama bağlı değil."},503);const id=String(params.jobId||"");if(!await owns(kv,id,request))return json({error:"İş bulunamadı veya erişim anahtarı geçersiz."},404);const status=await kv.get("jobs/"+id+"/status.json");if(!status)return json({error:"İş süresi dolmuş veya silinmiş."},404);const data=JSON.parse(status);if(data.status==="awaiting_approval"){data.review=await kv.get("jobs/"+id+"/review/manifest.json","json");}return json(data);}
export async function onRequestDelete({request,env,params}){const kv=env.SHORTS_TEMP;if(!kv)return json({error:"Geçici KV depolama bağlı değil."},503);const id=String(params.jobId||"");if(!await owns(kv,id,request))return json({error:"İş bulunamadı veya erişim anahtarı geçersiz."},404);await removePrefix(kv,"jobs/"+id+"/");return json({ok:true,deleted:true,message:"Ses, metin, referans görseller, ara dosyalar ve MP4 geçici depolamadan silindi."});}
export async function onRequestPost({request,env,params}){
 const kv=env.SHORTS_TEMP,id=String(params.jobId||"");
 if(!kv||!await owns(kv,id,request))return json({error:"İş bulunamadı veya erişim anahtarı geçersiz."},404);
 const status=await kv.get("jobs/"+id+"/status.json","json");
 if(!status||status.status!=="awaiting_approval")return json({error:"Bu proje görsel onayı beklemiyor."},409);
 let body;try{body=await request.json()}catch{return json({error:"Geçersiz seçim verisi."},400);}
 const manifest=await kv.get("jobs/"+id+"/review/manifest.json","json");
 if(!manifest?.scenes?.length||!body?.selections||typeof body.selections!=="object")return json({error:"Görsel seçimi eksik."},400);
 const scenes=[];
 for(const scene of manifest.scenes){
  const chosen=String(body.selections[String(scene.index)]||"");
  const option=scene.options.find(x=>String(x.id)===chosen);
  if(!option)return json({error:"Her sahne için geçerli bir görsel seçmelisin. Sahne "+scene.index},400);
  scenes.push({scene:scene.index,candidate:option.id,metadata:{title:option.title,author:option.author,license:option.license,license_url:option.license_url,page_url:option.page_url,url:"",source:option.source}});
 }
 await kv.put("jobs/"+id+"/selection.json",JSON.stringify({scenes}),{expirationTtl:86400});
 const gh=await fetch("https://api.github.com/repos/emirgasim/CONTENT-FACTORY/actions/workflows/shorts-background.yml/dispatches",{method:"POST",headers:{"Authorization":"Bearer "+String(env.GITHUB_ACTIONS_TOKEN||"").trim(),"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","Content-Type":"application/json","User-Agent":"ContentFactory-CloudRenderer"},body:JSON.stringify({ref:"main",inputs:{job_id:id,phase:"render"}})});
 if(gh.status!==204)return json({error:"Onay kaydedildi ancak render başlatılamadı (HTTP "+gh.status+")."},502);
 await kv.put("jobs/"+id+"/status.json",JSON.stringify({...status,status:"queued",progress:88,message:"Onayladığın görsellerle video üretiliyor.",updated_at:new Date().toISOString()}),{expirationTtl:86400});
 return json({ok:true,status:"queued"});
}
