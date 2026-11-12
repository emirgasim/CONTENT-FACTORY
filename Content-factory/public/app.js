const $ = s => document.querySelector(s);
const state = { projects: [], activeId: null, media: null };
const layouts = ["Sunucu tam ekran","Sunucu sağda + stok solda","Sunucu solda + stok sağda","Bölünmüş ekran","Küçük pencerede sunucu (PiP)","Tam ekran stok video","Tam ekran infografik","Hareketli kolaj","Kinetik tipografi"];
const uid = () => crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+Math.random());
const active = () => state.projects.find(p=>p.id===state.activeId);
function persist(){ localStorage.setItem("cf-projects",JSON.stringify(state.projects)); renderProjects(); }
function load(){ try{state.projects=JSON.parse(localStorage.getItem("cf-projects")||"[]")}catch{state.projects=[]} renderProjects(); }
function newProject(format){
  const p={id:uid(),format,name:format==="shorts"?"Yeni Shorts Serisi":"Yeni Uzun Video",topic:"",audience:"Genel izleyici",tone:"Merak uyandırıcı",script:"",topics:[],scenes:[],createdAt:new Date().toISOString(),media:null};
  if(format==="shorts") p.topics=["Konu 1","Konu 2"];
  state.projects.unshift(p); state.activeId=p.id; persist(); openEditor();
}
function renderProjects(){
  $("#projectList").innerHTML="";
  $("#emptyState").classList.toggle("hidden",state.projects.length>0);
  state.projects.forEach(p=>{
    const el=document.createElement("button"); el.className="project-card"; el.innerHTML=`<small>${p.format==="shorts"?"SHORTS PROJECT":"LONG VIDEO PROJECT"}</small><b></b><p></p>`;
    el.querySelector("b").textContent=p.name; el.querySelector("p").textContent=p.topic||"Konu henüz belirlenmedi";
    el.onclick=()=>{state.activeId=p.id;openEditor()}; $("#projectList").append(el);
  });
}
function openEditor(){
  const p=active(); if(!p)return;
  $("#editor").classList.remove("hidden"); $("#editorTitle").textContent=p.format==="shorts"?"Shorts proje editörü":"Uzun video editörü";
  $("#projectName").value=p.name; $("#projectTopic").value=p.topic; $("#projectAudience").value=p.audience; $("#projectTone").value=p.tone; $("#projectScript").value=p.script;
  state.media=p.media||null; showMedia(); renderScenes(); $("#editor").scrollIntoView({behavior:"smooth"});
}
function saveFields(){const p=active();if(!p)return;p.name=$("#projectName").value;p.topic=$("#projectTopic").value;p.audience=$("#projectAudience").value;p.tone=$("#projectTone").value;p.script=$("#projectScript").value;p.media=state.media;persist()}
function renderScenes(){
  const p=active(); if(!p)return; $("#sceneList").innerHTML="";
  p.scenes.forEach((s,i)=>{
    const row=document.createElement("div");row.className="scene-row";
    const start=document.createElement("input");start.type="text";start.placeholder="00:00";start.value=s.start||"";
    const layout=document.createElement("select");layouts.forEach(v=>{const o=document.createElement("option");o.textContent=v;o.value=v;layout.append(o)});layout.value=s.layout;
    const note=document.createElement("input");note.placeholder="Anlatım / görsel açıklaması";note.value=s.note||"";
    const del=document.createElement("button");del.textContent="×";del.title="Sahneyi sil";
    [start,layout,note].forEach(x=>x.addEventListener("change",()=>{s.start=start.value;s.layout=layout.value;s.note=note.value;persist()}));
    del.onclick=()=>{p.scenes.splice(i,1);persist();renderScenes()};
    row.append(start,layout,note,del);$("#sceneList").append(row);
  });
  $("#sceneCount").textContent=`${p.scenes.length} sahne`;
}
function showMedia(){
  const el=$("#mediaInfo"); if(!state.media){el.textContent="Henüz medya seçilmedi.";return}
  el.textContent=`${state.media.name} · ${state.media.type||"bilinmeyen tür"} · ${state.media.sizeMB} MB${state.media.duration?` · ${Math.round(state.media.duration)} sn`:""}`;
}
function download(name,data,type="application/json"){
  const blob=new Blob([data],{type}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);
}
document.querySelectorAll("[data-format]").forEach(b=>b.onclick=()=>newProject(b.dataset.format));
$("#saveProject").onclick=()=>{saveFields();alert("Proje bu tarayıcıya kaydedildi.")};
$("#closeEditor").onclick=()=>$("#editor").classList.add("hidden");
$("#addScene").onclick=()=>{const p=active();if(!p)return;p.scenes.push({id:uid(),start:"00:00",layout:"Sunucu tam ekran",note:""});persist();renderScenes()};
$("#mediaFile").onchange=async e=>{
  const f=e.target.files[0];if(!f)return;
  let duration=null;
  if(f.type.startsWith("video/")||f.type.startsWith("audio/")){
    const url=URL.createObjectURL(f);
    duration=await new Promise(resolve=>{const m=document.createElement(f.type.startsWith("video/")?"video":"audio");m.preload="metadata";m.onloadedmetadata=()=>{resolve(m.duration);URL.revokeObjectURL(url)};m.onerror=()=>{resolve(null);URL.revokeObjectURL(url)};m.src=url});
  }
  state.media={name:f.name,type:f.type,sizeMB:(f.size/1024/1024).toFixed(1),duration};
  showMedia();saveFields();
};
$("#exportProject").onclick=()=>{saveFields();download("content-factory-project.json",JSON.stringify(state.projects,null,2))};
$("#exportEdl").onclick=()=>{saveFields();const p=active();if(p)download(`${(p.name||"project").replace(/[^a-z0-9-_]/gi,"_")}-timeline.json`,JSON.stringify({project:p,format:"content-factory-edl-v1"},null,2))};
$("#importProject").onclick=()=>$("#projectFile").click();
$("#projectFile").onchange=async e=>{
  const f=e.target.files[0];if(!f)return;
  try{const data=JSON.parse(await f.text());const incoming=Array.isArray(data)?data:[data];incoming.forEach(p=>{if(!p.id)p.id=uid();state.projects.unshift(p)});persist();alert("Proje içe aktarıldı.")}catch{alert("Bu JSON dosyası okunamadı.")}e.target.value="";
};
load();
