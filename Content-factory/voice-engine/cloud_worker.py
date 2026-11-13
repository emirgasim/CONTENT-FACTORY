from __future__ import annotations
import argparse,json,os,re,shutil,sys,tempfile,time
from pathlib import Path
import requests
from requests.exceptions import RequestException
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
import gateway
from timeline_renderer import render_timeline_mp4
from urllib.parse import urlparse
import ipaddress,socket
CHUNK=16*1024*1024
def api_base(): return os.environ["CONTENT_FACTORY_URL"].rstrip("/")+"/api/internal/shorts/jobs"
def headers(): return {"X-Factory-Worker-Secret":os.environ["CF_WORKER_SECRET"]}
def request_json(method,url,**kwargs):
 last_error=None
 request_headers={**headers(),**kwargs.pop("headers",{})}
 for attempt in range(4):
  try:
   response=requests.request(method,url,headers=request_headers,timeout=180,**kwargs)
   response.raise_for_status()
   return response.json() if response.content else {}
  except RequestException as exc:
   last_error=exc
   status=getattr(getattr(exc,"response",None),"status_code",None)
   if status not in (408,425,429,500,502,503,504) or attempt==3:raise
   time.sleep(1.5*(attempt+1))
 raise last_error
def get_input(job_id,asset,destination):
 response=requests.get(f"{api_base()}/{job_id}/{asset}",headers=headers(),stream=True,timeout=(30,180))
 response.raise_for_status()
 with open(destination,"wb") as target:
  for chunk in response.iter_content(1024*1024):
   if chunk:target.write(chunk)
def upload_file(job_id,name,path):
 size=path.stat().st_size;parts=(size+CHUNK-1)//CHUNK
 with path.open("rb") as source:
  for part in range(parts):
   chunk=source.read(CHUNK)
   response=requests.put(f"{api_base()}/{job_id}/output-{name}",params={"part":part,"total":parts},headers=headers(),data=chunk,timeout=(30,180))
   response.raise_for_status()
 return {"parts":parts,"size":size}
def upload_review_image(job_id,scene,candidate,path):
 size=path.stat().st_size;parts=(size+CHUNK-1)//CHUNK
 with path.open("rb") as source:
  for part in range(parts):
   chunk=source.read(CHUNK)
   response=requests.put(f"{api_base()}/{job_id}/candidate-{scene}-{candidate}",params={"part":part,"total":parts},headers=headers(),data=chunk,timeout=(30,180))
   response.raise_for_status()
 return {"parts":parts,"size":size,"key":f"jobs/{job_id}/review/scene-{scene}/candidate-{candidate}"}

def make_sentence_groups(rows,duration):
 # Identical word-aligned visual beats are used for research and final render.
 # Each visual beat is capped for pacing; total narration duration is unrestricted.
 beats=gateway.build_visual_beats(rows,duration,max_words=7,max_seconds=2.8)
 scenes=[]
 for index,beat in enumerate(beats,1):
  start=max(0.0,float(beat.get("start",0.0)))
  end=max(start+0.08,min(float(duration),float(beat.get("end",start+0.5))))
  text=re.sub(r"\s+"," ",str(beat.get("text","")).strip())
  if text:scenes.append({"index":index,"start":round(start,3),"end":round(end,3),"duration":round(end-start,3),"text":text})
 return scenes

def download_external_image(url,destination):
 parsed=urlparse(url)
 if parsed.scheme!="https" or not parsed.hostname or parsed.username or parsed.password:
  raise RuntimeError("Harici görsel adresi güvenli HTTPS adresi olmalı.")
 try:
  addresses={entry[4][0] for entry in socket.getaddrinfo(parsed.hostname,None)}
  if not addresses or any(not ipaddress.ip_address(ip).is_global for ip in addresses):
   raise RuntimeError("Harici görsel adresi herkese açık bir sunucuya ait değil.")
 except RuntimeError:
  raise
 except Exception as exc:
  raise RuntimeError("Harici görsel adresi doğrulanamadı: "+str(exc)[:180])
 response=requests.get(url,headers={"User-Agent":"ContentFactory/1.0"},stream=True,timeout=(20,90),allow_redirects=False)
 response.raise_for_status()
 content_type=response.headers.get("Content-Type","").split(";")[0].lower()
 if not content_type.startswith("image/"):
  raise RuntimeError("Harici kaynak bir görsel dosyası döndürmedi.")
 total=0
 with open(destination,"wb") as target:
  for chunk in response.iter_content(1024*1024):
   if not chunk:continue
   total+=len(chunk)
   if total>25*1024*1024:raise RuntimeError("Harici görsel 25 MB sınırını aşıyor.")
   target.write(chunk)
 if total<1024:raise RuntimeError("Harici görsel dosyası boş veya eksik.")
 with gateway.Image.open(destination) as image:image.verify()
 return Path(destination)

def render_approved_timeline(job_id,meta,work,source,selections):
 source_duration=gateway.probe_duration(source)
 rows=gateway.transcribe_audio(source)
 if not rows:raise RuntimeError("Seslendirmeden kelime zaman kodları çıkarılamadı.")
 edit_plan=gateway.build_edit_plan(rows,source_duration)
 cleaned=work/"cleaned.wav"
 gateway.render_edited_audio(source,cleaned,edit_plan)
 rows=gateway.remap_rows_to_edited_timeline(rows,edit_plan)
 duration=gateway.probe_duration(cleaned)
 groups=make_sentence_groups(rows,duration)
 if not groups:raise RuntimeError("Ses için cümle tabanlı sahne zaman çizelgesi oluşturulamadı.")
 by_index={int(g["index"]):g for g in groups}
 items=selections.get("scenes") or []
 items=sorted(items,key=lambda x:int(x.get("order",0) or 0))
 if not items:raise RuntimeError("Onaylanmış sahne listesi boş.")
 render_scenes=[]
 source_records=[]
 for position,item in enumerate(items,1):
  scene_no=int(item.get("scene") or item.get("sourceSceneIndex") or item.get("index") or 0)
  base=by_index.get(scene_no)
  if not base:raise RuntimeError("Seçilen sahne ses zaman çizelgesinde bulunamadı: "+str(scene_no))
  metadata=dict(item.get("metadata") or {})
  external_url=str(item.get("external_url") or item.get("externalUrl") or "").strip()
  if external_url:
   image_path=download_external_image(external_url,work/("approved-external-"+str(position)+".img"))
   metadata.setdefault("url",external_url)
   metadata.setdefault("page_url",external_url)
   metadata.setdefault("source","External image")
  else:
   candidate=str(item.get("candidate") or "")
   if not candidate:raise RuntimeError("Sahne "+str(scene_no)+" için onaylanmış görsel kimliği eksik.")
   image_path=work/("approved-"+str(scene_no)+"-"+candidate+".jpg")
   get_input(job_id,"candidate-"+str(scene_no)+"-"+candidate,image_path)
   with gateway.Image.open(image_path) as image:image.verify()
  scene_duration=max(0.4,min(180.0,float(item.get("duration") or base.get("duration") or (float(base["end"])-float(base["start"])))))
  render_scenes.append({
   "order":position,
   "scene":scene_no,
   "image_path":str(image_path),
   "duration":scene_duration,
   "text":str(item.get("text") or base.get("text") or "")[:300],
   "transition":str(item.get("transition") or "cut"),
   "framing":item.get("framing") or {"scale":1.0,"panX":0,"panY":0}
  })
  source_records.append(metadata)
  update_status(job_id,status="processing",progress=48+int(20*position/len(items)),message="Onaylı görseller hazırlanıyor ("+str(position)+"/"+str(len(items))+").")
 total=sum(float(x["duration"]) for x in render_scenes)
 if total<duration:
  render_scenes[-1]["duration"]+=duration-total
 elif total>duration:
  factor=duration/total
  for scene in render_scenes:scene["duration"]=max(0.4,float(scene["duration"])*factor)
  excess=sum(float(x["duration"]) for x in render_scenes)-duration
  for scene in reversed(render_scenes):
   reduction=min(excess,max(0.0,float(scene["duration"])-0.4))
   scene["duration"]-=reduction
   excess-=reduction
   if excess<=0.001:break
  if excess>0.02:raise RuntimeError("Sahne süreleri seslendirme süresine sığdırılamadı.")
  render_scenes[-1]["duration"]+=max(0.0,duration-sum(float(x["duration"]) for x in render_scenes))
 # xfade transitions overlap by 0.35s; extend the tail so the final video still covers the full narration.
 transition_count=sum(1 for x in render_scenes[1:] if str(x.get("transition","cut")) in {"fade","dissolve","zoom_in","slide_left"} and float(x["duration"])>0.45)
 if transition_count:
  render_scenes[-1]["duration"]+=0.35*transition_count
 output=work/"shorts.mp4"
 update_status(job_id,status="processing",progress=72,message="Onayladığın kurgu timeline üzerinde birleştiriliyor.")
 render_timeline_mp4(
  scenes=render_scenes,
  voice_audio_path=str(cleaned),
  output_mp4_path=str(output),
  audio_mix=selections.get("audio_mix") or {"voiceVolume":1.0,"musicVolume":0.35},
  width=1080,height=1920,fps=30
 )
 rendered_duration=gateway.probe_duration(output)
 out_width,out_height=gateway.probe_video_dimensions(output)
 if (out_width,out_height)!=(1080,1920):
  raise RuntimeError("Çözünürlük kalite kontrolü başarısız: "+str(out_width)+"x"+str(out_height))
 delta=abs(rendered_duration-duration)
 if delta>0.60:
  raise RuntimeError("Video ve ses süreleri uyuşmuyor: "+str(round(rendered_duration,2))+"s / "+str(round(duration,2))+"s.")
 credits=[
  "CONTENT FACTORY — KAYNAK VE LİSANS KAYDI",
  "Video başlığı: "+str(meta.get("title","Shorts")),
  "Süre: "+str(round(rendered_duration,2))+" saniye",
  "Kurgu stratejisi: "+str(edit_plan.get("strategy","unknown")),
  "Kurgu kesme sayısı: "+str(len(edit_plan.get("cuts",[]))),
  "Sahne sayısı: "+str(len(render_scenes)),
  "",
  "Kullanılan medya:"
 ]
 for item in source_records:
  credits.extend([
   "- "+str(item.get("title","Adsız görsel")),
   "  Kaynak: "+str(item.get("source","Açık görsel koleksiyonu")),
   "  Sanatçı: "+str(item.get("author","Belirtilmemiş")),
   "  Lisans: "+str(item.get("license","Belirtilmemiş")),
   "  Lisans bağlantısı: "+str(item.get("license_url","Belirtilmemiş")),
   "  Görsel adresi: "+str(item.get("url","")),
   "  Kaynak sayfası: "+str(item.get("page_url","")),
   ""
  ])
 credits.extend([
  "Not: Görsellerin yeniden kullanım koşullarını yayımdan önce kaynak sayfasından doğrulayın."
 ])
 (work/"sources-and-licenses.txt").write_text("\n".join(credits),encoding="utf-8")
 return {
  "status":"completed",
  "duration":round(rendered_duration,2),
  "removed_silence":round(float(edit_plan.get("removed_seconds",0.0)),2),
  "edit_cut_count":len(edit_plan.get("cuts",[])),
  "scene_count":len(render_scenes),
  "source_count":len(source_records),
  "caption_count":sum(1 for x in render_scenes if str(x.get("text","")).strip()),
  "qc_duration_delta":round(delta,3),
  "edit_strategy":str(edit_plan.get("strategy","unknown"))
}

def prepare_review(job_id,meta,work,source):
 duration=gateway.probe_duration(source)
 rows=gateway.transcribe_audio(source)
 if not rows:raise RuntimeError("Seslendirmeden metin çözümlenemedi.")
 edit_plan=gateway.build_edit_plan(rows,duration)
 cleaned=work/"review-cleaned.wav"
 gateway.render_edited_audio(source,cleaned,edit_plan)
 rows=gateway.remap_rows_to_edited_timeline(rows,edit_plan)
 duration=gateway.probe_duration(cleaned)
 groups=make_sentence_groups(rows,duration)
 if not groups:raise RuntimeError("Ses için sahne zaman çizelgesi oluşturulamadı.")
 manifest={"hook":meta.get("hook",""),"duration":round(duration,2),"scenes":[]}
 query_cache={}
 for index,group in enumerate(groups):
  scene_text=str(group.get("text","")).strip()
  context=" ".join(str(x.get("text","")) for x in groups[max(0,index-1):index+2])
  # Keep the visual target short and entity-focused: CLIP has a 77-token
  # text window, so long narration/context prompts can truncate the actual subject.
  visual_target=gateway.english_visual_query(scene_text)
  visual_target=re.sub(r"\bsilvestre\b","Sylvester",visual_target,flags=re.I)
  visual_target=re.sub(r"\bsylvester\b(?!\s+stallone)","Sylvester Stallone",visual_target,flags=re.I)
  lower_scene=scene_text.casefold()
  # Turkish Whisper frequently mishears the proper name "Rocky" as "rakı".
  # Correct this only in the visual-search intent; preserve the original transcript.
  rocky_reference=bool(re.search(r"\brak[iı]\s+balboa\b|\brocky\s+balboa\b",lower_scene))
  if rocky_reference:
   visual_target="Rocky Balboa Sylvester Stallone boxing film character"
  elif "stallone" in lower_scene or "silvestre" in lower_scene or "sylvester" in lower_scene:
   visual_target="Sylvester Stallone arriving; Sylvester Stallone, Rocky actor"
  if not visual_target:
   visual_target=gateway.translate_visual_query(scene_text)[:180]
  brief=("Narrated scene: "+scene_text+". Nearby context: "+context)[:420]
  queries=[]
  query_candidates=[
   visual_target,
   gateway.translate_visual_query(scene_text),
   gateway.translate_visual_query(str(meta.get("title",""))+" "+scene_text),
   gateway.extract_keywords(str(meta.get("title",""))+" "+scene_text),
  ]
  if rocky_reference:
   query_candidates.extend([
    "Rocky Balboa Sylvester Stallone boxing movie photograph",
    "Sylvester Stallone Rocky Balboa film still boxing ring",
    "Rocky Balboa 1976 film Sylvester Stallone real photograph",
    "Sylvester Stallone as Rocky Balboa press photo"
   ])
  elif "stallone" in lower_scene or "silvestre" in lower_scene or "sylvester" in lower_scene:
   query_candidates.extend(["Sylvester Stallone arriving","Sylvester Stallone Rocky actor photograph","Sylvester Stallone candid photo"])
  for q in query_candidates:
   q=" ".join(str(q or "").split())
   if q and q.lower() not in [x.lower() for x in queries]:queries.append(q[:180])
  pairs=[];seen=set()
  # More focused query variants and a larger candidate pool prevent a single
  # weak translation/search response from failing an otherwise valid scene.
  for q in queries[:8]:
   candidates=query_cache.get(q)
   if candidates is None:
    candidates=gateway.search_public_assets(q,limit=24);query_cache[q]=candidates
   for candidate in candidates[:16]:
    url=str(candidate.get("url","")).strip()
    if not url or url in seen:continue
    seen.add(url)
    path=gateway.download_image_asset(candidate,work,1000+index*100+len(pairs))
    if path:pairs.append((path,candidate))
    if len(pairs)>=36:break
   if len(pairs)>=36:break
  ranked=gateway.rank_scene_images(visual_target,pairs)
  options=[]
  for rank_index,(score,(path,source_info)) in enumerate(ranked[:4]):
   # CLIP ranker tags only verified visual matches.
   if source_info.get("visual_match_verified")!="true":continue
   candidate_id=str(len(options)+1)
   stored=upload_review_image(job_id,index+1,candidate_id,path)
   options.append({"id":candidate_id,"asset":f"candidate-{index+1}-{candidate_id}","score":round(float(score),4),"title":source_info.get("title","Image"),"source":source_info.get("source","Open web"),"author":source_info.get("author","Unknown"),"license":source_info.get("license","Check source terms"),"license_url":source_info.get("license_url",""),"page_url":source_info.get("page_url",""),"size":stored["size"],"parts":stored["parts"]})
  if not options:raise RuntimeError("Sahne "+str(index+1)+" için görsel olarak doğrulanmış seçenek bulunamadı: "+scene_text[:140])
  manifest["scenes"].append({"index":index+1,"start":round(float(group.get("start",0)),2),"end":round(float(group.get("end",0)),2),"text":scene_text,"options":options})
  update_status(job_id,status="processing",progress=15+int(65*(index+1)/len(groups)),message="Görseller araştırılıyor ("+str(index+1)+"/"+str(len(groups))+")")
 request_json("PUT",f"{api_base()}/{job_id}",json={"type":"review","manifest":manifest})
 if not update_status(job_id,status="awaiting_approval",progress=85,message="Görseller hazır. Her sahneyi inceleyip onayla.",scene_count=len(groups)):
  raise RuntimeError("Görsel onay listesi kaydedildi ancak iş durumu güncellenemedi.")
def update_status(job_id,**values):
 try:
  request_json("PUT",f"{api_base()}/{job_id}",json=values)
  return True
 except Exception as exc:
  # Progress telemetry must never terminate a render. Final status is retried
  # separately after output upload, and the worker logs the original API error.
  print("[cloud-status] non-fatal status update failure:",type(exc).__name__,str(exc)[:500],flush=True)
  return False
def render(job_id,phase='research'):
 if len(job_id)!=32 or any(c not in "0123456789abcdef" for c in job_id):raise ValueError("Invalid job ID")
 meta=request_json("GET",f"{api_base()}/{job_id}")
 work=Path(tempfile.mkdtemp(prefix="cf-cloud-"+job_id[:8]+"-"))
 try:
  update_status(job_id,status="processing",progress=3,message="Bulut işçisi proje dosyalarını alıyor.")
  suffix=Path(meta["audio"]["name"]).suffix.lower()
  if suffix not in {".mp3",".m4a",".wav",".aac",".mp4",".mpeg",".mpga",".ogg",".opus",".webm",".flac",".bin"}:suffix=".bin"
  source=work/("source"+suffix);get_input(job_id,"audio",source)
  user_images=[]
  for i,item in enumerate(meta.get("images",[])):
   asset=f"image-{i+1:02d}";ext=Path(item["name"]).suffix.lower()
   if ext not in {".jpg",".jpeg",".png",".webp"}:ext=".img"
   path=work/(f"reference-{i+1}{ext}");get_input(job_id,asset,path);user_images.append(path.name)
  job={"job_id":job_id,"status":"queued","progress":4,"message":"Dosyalar alındı; ses ve sahneler analiz ediliyor.","created_at":meta["created_at"],"updated_at":time.time(),"expires_at":meta["expires_at"],"directory":str(work),"source_audio":source.name,"title":meta["title"],"hook":meta.get("hook",""),"text":meta["text"],"user_images":user_images,"error":None}
  with gateway.JOBS_LOCK:gateway.JOBS[job_id]=job
  if phase=="research":
   prepare_review(job_id,meta,work,source)
   return
  if phase!="render":raise ValueError("Invalid worker phase")
  selections=request_json("GET",f"{api_base()}/{job_id}/selection")
  approved=[]
  for scene in selections.get("scenes",[]):
   scene_no=int(scene["scene"]);candidate=str(scene["candidate"]);asset=work/(f"approved-{scene_no}-{candidate}.jpg")
   get_input(job_id,f"candidate-{scene_no}-{candidate}",asset)
   info=scene.get("metadata",{});info["visual_match_verified"]="true";approved.append((asset,info))
  result=render_approved_timeline(job_id,meta,work,source,selections)
  update_status(job_id,status="uploading",progress=96,message="MP4 ve kaynak dosyaları geçici depolamaya aktarılıyor.")
  manifest={}
  for local,name in [("shorts.mp4","video"),("cleaned.wav","audio"),("sources-and-licenses.txt","credits")]:
   path=work/local
   if not path.is_file():raise RuntimeError("Render çıktısı bulunamadı: "+local)
   manifest[name]=upload_file(job_id,name,path)
  request_json("PUT",f"{api_base()}/{job_id}/manifest",json={"type":"manifest","manifest":manifest})
  final_status=update_status(job_id,status="completed",progress=100,message="MP4 hazır. iPhone'una indir; ardından projeyi silebilirsin.",duration=round(float(result.get("duration",0)),2),removed_silence=round(float(result.get("removed_silence",0)),2),edit_cut_count=int(result.get("edit_cut_count",0)),scene_count=int(result.get("scene_count",0)),source_count=int(result.get("source_count",0)),caption_count=int(result.get("caption_count",0)),qc_duration_delta=float(result.get("qc_duration_delta",0)),edit_strategy=str(result.get("edit_strategy","unknown")),video_bytes=manifest["video"]["size"])
  if not final_status:
   raise RuntimeError("Video üretildi ve dosyalar yüklendi ancak tamamlandı durumu Cloudflare'a kaydedilemedi. Son durum kaydı başarısız.")
 except Exception as exc:
  try:update_status(job_id,status="failed",progress=100,message="Bulut render başarısız.",error=str(exc)[:1800])
  except Exception:pass
  raise
 finally:
  shutil.rmtree(work,ignore_errors=True)
if __name__=="__main__":
 parser=argparse.ArgumentParser();parser.add_argument("--job-id",required=True);parser.add_argument("--phase",choices=["research","render"],default="research");args=parser.parse_args();render(args.job_id,args.phase)
