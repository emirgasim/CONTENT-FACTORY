const json=(message,status)=>Response.json({error:message},{status,headers:{"Cache-Control":"no-store"}});
function allowed(host){return host==="api.openverse.org"||host==="upload.wikimedia.org"||host.endsWith(".wikimedia.org")||host==="tile.loc.gov"||host==="www.loc.gov"||host.endsWith(".loc.gov")||host==="images.pexels.com";}
export async function onRequestGet({request}){
 const raw=new URL(request.url).searchParams.get("url");
 if(!raw)return json("Image URL is required.",400);
 let target;try{target=new URL(raw);}catch{return json("Invalid image URL.",400);}
 if(target.protocol!=="https:"||!allowed(target.hostname))return json("Image host is not permitted.",403);
 const upstream=await fetch(target,{headers:{"User-Agent":"ContentFactoryShorts/1.0 (open-media-image-proxy)","Accept":"image/avif,image/webp,image/png,image/jpeg,*/*"}});
 if(!upstream.ok)return json("Image provider returned HTTP "+upstream.status,502);
 const type=(upstream.headers.get("content-type")||"").split(";")[0].toLowerCase();
 if(!["image/jpeg","image/png","image/webp"].includes(type))return json("Provider did not return a supported image.",415);
 const length=Number(upstream.headers.get("content-length")||0);
 if(length>18*1024*1024)return json("Image exceeds the 18 MB limit.",413);
 return new Response(upstream.body,{headers:{"Content-Type":type,"Cache-Control":"public, max-age=86400","X-Content-Type-Options":"nosniff"}});
}
