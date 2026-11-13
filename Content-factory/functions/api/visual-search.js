const json=(data,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"public, max-age=300","Access-Control-Allow-Origin":"*"}});
const headers={"Accept":"application/json","User-Agent":"ContentFactoryShorts/1.0 (open-media-search)"};
const clean=s=>String(s||"").replace(/<[^>]*>/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim();
function permitted(label){const s=String(label||"").toLowerCase();return /^(cc0|pdm|by|by-sa|cc-by|cc-by-sa)$/.test(s)||/public domain|creative commons attribution(?:-sharealike)?|cc0/.test(s);}
function normalize(item){const url=String(item.url||"");if(!url)return null;return {...item,url,proxyUrl:"/api/visual-image?url="+encodeURIComponent(url)};}
async function openverse(q){
 const u=new URL("https://api.openverse.org/v1/images/");
 u.searchParams.set("q",q);u.searchParams.set("page_size","30");
 u.searchParams.set("license","cc0,pdm,by,by-sa");u.searchParams.set("filter_dead","true");
 u.searchParams.set("extension","jpg,jpeg,png,webp");u.searchParams.set("mature","false");
 const r=await fetch(u,{headers});if(!r.ok)throw Error("Openverse HTTP "+r.status);
 const d=await r.json();
 return (d.results||[]).map(x=>normalize({title:clean(x.title)||"Openverse photograph",url:x.thumbnail||x.url,pageUrl:x.foreign_landing_url||x.detail_url,author:clean(x.creator)||"Creator not listed",license:String(x.license||"").toUpperCase(),licenseUrl:x.license_url||"",width:Number(x.width)||0,height:Number(x.height)||0,source:"Openverse"})).filter(Boolean).filter(x=>permitted(x.license)&&x.pageUrl);
}
async function commons(q){
 const u=new URL("https://commons.wikimedia.org/w/api.php");
 for(const [k,v] of Object.entries({action:"query",format:"json",generator:"search",gsrsearch:q,gsrnamespace:"6",gsrlimit:"40",prop:"imageinfo",iiprop:"url|extmetadata|mime|size",iiurlwidth:"1600"}))u.searchParams.set(k,v);
 const r=await fetch(u,{headers});if(!r.ok)throw Error("Commons HTTP "+r.status);
 const d=await r.json();
 return Object.values(d.query?.pages||{}).map(p=>{
  const info=p.imageinfo?.[0],m=info?.extmetadata||{};
  const val=k=>clean(m[k]?.value||"");
  const license=val("LicenseShortName"),url=info?.thumburl||info?.url;
  if(!info||!url||!permitted(license)||!/image\/(jpeg|png|webp)/i.test(info.thumbmime||info.mime||""))return null;
  if((info.width&&info.width<650)||(info.height&&info.height<450))return null;
  return normalize({title:clean(p.title)||"Wikimedia photograph",url,pageUrl:"https://commons.wikimedia.org/wiki/"+encodeURIComponent(String(p.title||"").replace(/ /g,"_")),author:val("Artist")||val("Credit")||"Creator not listed",license,licenseUrl:val("LicenseUrl"),width:info.width||0,height:info.height||0,source:"Wikimedia Commons"});
 }).filter(Boolean);
}
async function loc(q){
 const u=new URL("https://www.loc.gov/search/");
 u.searchParams.set("fo","json");u.searchParams.set("q",q);u.searchParams.set("c","30");u.searchParams.set("sp","1");
 const r=await fetch(u,{headers});if(!r.ok)throw Error("Library of Congress HTTP "+r.status);
 const d=await r.json();
 return (d.results||[]).map(x=>{
  const rights=Array.isArray(x.rights)?x.rights.join(" "):String(x.rights||"");
  if(!/public domain|no known restrictions|no known copyright restrictions|unrestricted/i.test(rights))return null;
  const urls=Array.isArray(x.image_url)?x.image_url:[x.image_url];
  const url=urls.find(v=>/\.(jpe?g|png|webp)(?:$|\?)/i.test(String(v)))||urls[0];
  return normalize({title:clean(x.title)||"Library of Congress photograph",url,pageUrl:x.id||x.url,author:clean(x.contributor)||"Library of Congress",license:"Public domain / no known restrictions",licenseUrl:"https://www.loc.gov/legal/",width:0,height:0,source:"Library of Congress"});
 }).filter(Boolean);
}
export async function onRequestGet({request}){
 const q=clean(new URL(request.url).searchParams.get("q"));
 if(q.length<2||q.length>180)return json({error:"Search query must be 2–180 characters."},400);
 const results=await Promise.allSettled([openverse(q),commons(q),loc(q)]);
 const items=[],seen=new Set();
 for(const result of results){if(result.status!=="fulfilled")continue;for(const item of result.value){if(!item?.url||seen.has(item.url))continue;seen.add(item.url);items.push(item);if(items.length>=45)break;}if(items.length>=45)break;}
 return json({query:q,items,providers:{openverse:results[0].status,commons:results[1].status,loc:results[2].status}});
}
