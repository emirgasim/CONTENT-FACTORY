from __future__ import annotations
import argparse,json,os,shutil,sys,tempfile,time
from pathlib import Path
import requests
from requests.exceptions import RequestException
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
import gateway
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
def prepare_review(job_id,meta,work,source):
 duration=gateway.probe_duration(source)
 rows=gateway.transcribe_audio(source)
 if not rows:raise RuntimeError("Seslendirmeden metin çözümlenemedi.")
 edit_plan=gateway.build_edit_plan(rows,duration)
 cleaned=work/"review-cleaned.wav"
 gateway.render_edited_audio(source,cleaned,edit_plan)
 rows=gateway.remap_rows_to_edited_timeline(rows,edit_plan)
 duration=gateway.probe_duration(cleaned)
 groups=gateway.build_visual_beats(rows,duration,max_words=7,max_seconds=2.8)
 if not groups:raise RuntimeError("Ses için sahne zaman çizelgesi oluşturulamadı.")
 manifest={"hook":meta.get("hook",""),"duration":round(duration,2),"scenes":[]}
 query_cache={}
 for index,group in enumerate(groups):
  scene_text=str(group.get("text","")).strip()
  context=" ".join(str(x.get("text","")) for x in groups[max(0,index-1):index+2])
  brief=("Story topic: "+str(meta.get("title",""))+". Exact narrated scene: "+scene_text+". Context: "+context)[:420]
  queries=[]
  for q in (gateway.translate_visual_query(str(meta.get("title",""))+" "+scene_text),gateway.translate_visual_query(scene_text),gateway.extract_keywords(str(meta.get("title",""))+" "+scene_text)):
   q=" ".join(str(q or "").split())
   if q and q.lower() not in [x.lower() for x in queries]:queries.append(q[:180])
  pairs=[];seen=set()
  for q in queries[:3]:
   candidates=query_cache.get(q)
   if candidates is None:
    candidates=gateway.search_public_assets(q,limit=20);query_cache[q]=candidates
   for candidate in candidates[:12]:
    url=str(candidate.get("url","")).strip()
    if not url or url in seen:continue
    seen.add(url)
    path=gateway.download_image_asset(candidate,work,1000+index*30+len(pairs))
    if path:pairs.append((path,candidate))
    if len(pairs)>=12:break
   if len(pairs)>=12:break
  ranked=gateway.rank_scene_images(brief,pairs)
  options=[]
  for score,(path,source_info) in enumerate([pair for _score,pair in ranked[:4]]):
   # CLIP ranker tags only verified visual matches.
   if source_info.get("visual_match_verified")!="true":continue
   candidate_id=str(len(options)+1)
   stored=upload_review_image(job_id,index+1,candidate_id,path)
   options.append({"id":candidate_id,"asset":f"candidate-{index+1}-{candidate_id}","score":round(float(ranked[score][0]),4) if score<len(ranked) else 0,"title":source_info.get("title","Image"),"source":source_info.get("source","Open web"),"author":source_info.get("author","Unknown"),"license":source_info.get("license","Check source terms"),"license_url":source_info.get("license_url",""),"page_url":source_info.get("page_url",""),"size":stored["size"],"parts":stored["parts"]})
  if not options:raise RuntimeError("Sahne "+str(index+1)+" için görsel olarak doğrulanmış seçenek bulunamadı: "+scene_text[:140])
  manifest["scenes"].append({"index":index+1,"start":round(float(group.get("start",0)),2),"end":round(float(group.get("end",0)),2),"text":scene_text,"options":options})
  update_status(job_id,status="processing",progress=15+int(65*(index+1)/len(groups)),message="Görseller araştırılıyor ("+str(index+1)+"/"+str(len(groups))+")")
 request_json("PUT",f"{api_base()}/{job_id}",json={"type":"review","manifest":manifest})
 update_status(job_id,status="awaiting_approval",progress=85,message="Görseller hazır. Her sahneyi inceleyip onayla.",scene_count=len(groups))
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
  if phase=="research":\n   prepare_review(job_id,meta,work,source)\n   return\n  if phase!="render":raise ValueError("Invalid worker phase")\n  selections=request_json("GET",f"{api_base()}/{job_id}/selection")\n  approved=[]\n  for scene in selections.get("scenes",[]):\n   scene_no=int(scene["scene"]);candidate=str(scene["candidate"]);asset=work/(f"approved-{scene_no}-{candidate}.jpg")\n   get_input(job_id,f"candidate-{scene_no}-{candidate}",asset)\n   info=scene.get("metadata",{});info["visual_match_verified"]="true";approved.append((asset,info))\n  original_update=gateway.update_job
  def persistent_update(current_id,**values):
   original_update(current_id,**values)
   with gateway.JOBS_LOCK:snapshot=dict(gateway.JOBS.get(current_id,{}))
   if snapshot:
    allowed=("status","progress","message","error","duration","removed_silence","edit_cut_count","scene_count","source_count","caption_count","qc_duration_delta","edit_strategy")
    cloud_state={k:snapshot[k] for k in allowed if k in snapshot}
    # The local renderer uses "running"; the cloud job API uses "processing".
    if cloud_state.get("status")=="running":
     cloud_state["status"]="processing"
    # Keep API status vocabulary aligned with the local renderer.
    if cloud_state.get("status")=="running":
     cloud_state["status"]="processing"
    if cloud_state.get("status")=="completed":
     cloud_state.update({"status":"uploading","progress":96,"message":"MP4 ve kaynak dosyaları geçici depolamaya aktarılıyor."})
    if not update_status(job_id,**cloud_state):
     print("[cloud-status] render continues despite progress API failure",flush=True)
  gateway.update_job=persistent_update
  try:gateway.render_short_job(job_id,approved_scene_assets=approved)
  finally:gateway.update_job=original_update
  with gateway.JOBS_LOCK:result=dict(gateway.JOBS.get(job_id,{}))
  if result.get("status")!="completed":raise RuntimeError(result.get("error") or "Video render tamamlanamadı.")
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
