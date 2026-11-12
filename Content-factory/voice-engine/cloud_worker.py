from __future__ import annotations
import argparse,json,os,shutil,sys,tempfile,time
from pathlib import Path
from datetime import datetime,timezone
import boto3
from botocore.config import Config
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
import gateway
def r2_client():
 account=os.environ["CLOUDFLARE_ACCOUNT_ID"]
 return boto3.client("s3",endpoint_url=f"https://{account}.r2.cloudflarestorage.com",region_name="auto",aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],config=Config(signature_version="s3v4",retries={"max_attempts":4}))
def bucket_name(): return os.getenv("R2_BUCKET_NAME") or "content-factory-short-jobs"
def job_key(job_id,suffix): return f"jobs/{job_id}/{suffix}"
def put_json(s3,key,data): s3.put_object(Bucket=bucket_name(),Key=key,Body=json.dumps(data,ensure_ascii=False).encode(),ContentType="application/json",CacheControl="no-store")
def get_json(s3,key): return json.loads(s3.get_object(Bucket=bucket_name(),Key=key)["Body"].read())
def public_status(job):
 allowed=("job_id","status","progress","message","created_at","updated_at","expires_at","error","duration","removed_silence","scene_count","source_count","video_bytes")
 return {k:job[k] for k in allowed if k in job}
def delete_prefix(s3,prefix):
 for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket_name(),Prefix=prefix):
  objects=[{"Key":x["Key"]} for x in page.get("Contents",[])]
  if objects:s3.delete_objects(Bucket=bucket_name(),Delete={"Objects":objects,"Quiet":True})
def render(job_id):
 if len(job_id)!=32 or any(c not in "0123456789abcdef" for c in job_id):raise ValueError("Invalid job ID")
 s3=r2_client();meta=get_json(s3,job_key(job_id,"input.json"));work=Path(tempfile.mkdtemp(prefix="cf-cloud-"+job_id[:8]+"-"))
 try:
  original=Path(meta["audio"]["name"]).name;suffix=Path(original).suffix.lower()
  if suffix not in {".mp3",".m4a",".wav",".aac",".mp4",".mpeg",".mpga",".ogg",".opus",".webm",".flac",".bin"}:suffix=".bin"
  source=work/("source"+suffix);s3.download_file(bucket_name(),meta["audio"]["key"],str(source))
  user_images=[]
  for i,item in enumerate(meta.get("images",[])):
   ext=Path(item["name"]).suffix.lower()
   if ext not in {".jpg",".jpeg",".png",".webp"}:ext=".img"
   path=work/(f"reference-{i+1}{ext}");s3.download_file(bucket_name(),item["key"],str(path));user_images.append(path.name)
  job={"job_id":job_id,"status":"queued","progress":2,"message":"Bulut işçisi dosyaları aldı.","created_at":meta["created_at"],"updated_at":time.time(),"expires_at":meta["expires_at"],"directory":str(work),"source_audio":source.name,"title":meta["title"],"hook":meta.get("hook",""),"text":meta["text"],"user_images":user_images,"error":None}
  with gateway.JOBS_LOCK:gateway.JOBS[job_id]=job
  original_update=gateway.update_job
  def persistent_update(current_id,**values):
   original_update(current_id,**values)
   with gateway.JOBS_LOCK:snapshot=dict(gateway.JOBS.get(current_id,{}))
   if snapshot:
    cloud_state=public_status(snapshot)
    if cloud_state.get("status")=="completed":cloud_state.update({"status":"uploading","progress":96,"message":"MP4 ve kaynak dosyaları geçici bulut alanına yükleniyor…"})
    put_json(s3,job_key(job_id,"status.json"),cloud_state)
  gateway.update_job=persistent_update
  try:gateway.render_short_job(job_id)
  finally:gateway.update_job=original_update
  with gateway.JOBS_LOCK:result=dict(gateway.JOBS.get(job_id,{}))
  if result.get("status")!="completed":
   put_json(s3,job_key(job_id,"status.json"),public_status(result));raise RuntimeError(result.get("error") or "Video render tamamlanamadı.")
  for local,remote,mime in [("shorts.mp4","output/shorts.mp4","video/mp4"),("cleaned.wav","output/cleaned.wav","audio/wav"),("sources-and-licenses.txt","output/sources-and-licenses.txt","text/plain; charset=utf-8")]:
   path=work/local
   if not path.is_file():raise RuntimeError("Render çıktısı bulunamadı: "+local)
   s3.upload_file(str(path),bucket_name(),job_key(job_id,remote),ExtraArgs={"ContentType":mime})
  result["video_bytes"]=(work/"shorts.mp4").stat().st_size
  result["message"]="MP4 hazır. İndirip 'İndirdim, projeyi sil' düğmesiyle bulut materyallerini temizleyebilirsin."
  result["updated_at"]=time.time();put_json(s3,job_key(job_id,"status.json"),public_status(result))
 except Exception as exc:
  try:status=get_json(s3,job_key(job_id,"status.json"))
  except Exception:status={"job_id":job_id,"created_at":meta.get("created_at",""),"expires_at":meta.get("expires_at","")}
  status.update({"status":"failed","progress":100,"message":"Bulut render başarısız.","error":str(exc)[:1800],"updated_at":time.time()})
  put_json(s3,job_key(job_id,"status.json"),status);raise
 finally:shutil.rmtree(work,ignore_errors=True)
def cleanup(ttl_hours=24):
 s3=r2_client();now=datetime.now(timezone.utc);roots=set()
 for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket_name(),Prefix="jobs/",Delimiter="/"):
  for item in page.get("CommonPrefixes",[]):roots.add(item["Prefix"])
 removed=0
 for prefix in roots:
  expired=False
  try:
   status=get_json(s3,prefix+"status.json");expires=status.get("expires_at")
   if expires:expired=datetime.fromisoformat(expires.replace("Z","+00:00"))<=now
   else:
    created=status.get("created_at")
    expired=(now-datetime.fromisoformat(created.replace("Z","+00:00"))).total_seconds()>ttl_hours*3600 if created else True
  except Exception:expired=True
  if expired:delete_prefix(s3,prefix);removed+=1
 # Rate-limit counters are small R2 objects; discard stale counters after 48 hours.
 for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket_name(),Prefix="limits/"):
  for item in page.get("Contents",[]):
   try:
    value=json.loads(s3.get_object(Bucket=bucket_name(),Key=item["Key"])["Body"].read())
    if now.timestamp()*1000-float(value.get("start",0))>48*3600*1000:
     s3.delete_object(Bucket=bucket_name(),Key=item["Key"])
   except Exception:
    s3.delete_object(Bucket=bucket_name(),Key=item["Key"])
 print(f"Removed {removed} expired projects and stale rate-limit records. TTL={ttl_hours}h")
if __name__=="__main__":
 parser=argparse.ArgumentParser();parser.add_argument("--job-id");parser.add_argument("--cleanup",action="store_true");parser.add_argument("--ttl-hours",type=int,default=24);args=parser.parse_args()
 if args.cleanup:cleanup(args.ttl_hours)
 elif args.job_id:render(args.job_id)
 else:parser.error("--job-id or --cleanup is required")
