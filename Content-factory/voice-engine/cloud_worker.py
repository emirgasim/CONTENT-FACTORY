from __future__ import annotations
import argparse,json,os,shutil,sys,tempfile,time
from pathlib import Path
import requests
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
import gateway
CHUNK=16*1024*1024
def api_base(): return os.environ["CONTENT_FACTORY_URL"].rstrip("/")+"/api/internal/shorts/jobs"
def headers(): return {"X-Factory-Worker-Secret":os.environ["CF_WORKER_SECRET"]}
def request_json(method,url,**kwargs):
 response=requests.request(method,url,headers={**headers(),**kwargs.pop("headers",{})},timeout=180,**kwargs)
 response.raise_for_status()
 return response.json() if response.content else {}
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
def update_status(job_id,**values):request_json("PUT",f"{api_base()}/{job_id}",json=values)
def render(job_id):
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
  original_update=gateway.update_job
  def persistent_update(current_id,**values):
   original_update(current_id,**values)
   with gateway.JOBS_LOCK:snapshot=dict(gateway.JOBS.get(current_id,{}))
   if snapshot:
    allowed=("status","progress","message","error","duration","removed_silence","scene_count","source_count")
    cloud_state={k:snapshot[k] for k in allowed if k in snapshot}
    # The local renderer uses "running"; the cloud job API uses "processing".
    if cloud_state.get("status")=="running":
     cloud_state["status"]="processing"
    # Keep API status vocabulary aligned with the local renderer.
    if cloud_state.get("status")=="running":
     cloud_state["status"]="processing"
    if cloud_state.get("status")=="completed":
     cloud_state.update({"status":"uploading","progress":96,"message":"MP4 ve kaynak dosyaları geçici depolamaya aktarılıyor."})
    update_status(job_id,**cloud_state)
  gateway.update_job=persistent_update
  try:gateway.render_short_job(job_id)
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
  update_status(job_id,status="completed",progress=100,message="MP4 hazır. iPhone'una indir; ardından projeyi silebilirsin.",duration=round(float(result.get("duration",0)),2),removed_silence=round(float(result.get("removed_silence",0)),2),scene_count=int(result.get("scene_count",0)),source_count=int(result.get("source_count",0)),video_bytes=manifest["video"]["size"])
 except Exception as exc:
  try:update_status(job_id,status="failed",progress=100,message="Bulut render başarısız.",error=str(exc)[:1800])
  except Exception:pass
  raise
 finally:
  shutil.rmtree(work,ignore_errors=True)
if __name__=="__main__":
 parser=argparse.ArgumentParser();parser.add_argument("--job-id",required=True);args=parser.parse_args();render(args.job_id)
