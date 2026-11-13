#!/usr/bin/env python3
"""Content Factory Agent Hub: deterministic local tools; no LLM/API key required."""
from __future__ import annotations
import argparse, json, subprocess, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent
TOOLS=ROOT/"tools"
COMMANDS={
 "hookscore":("hookscore.py",["--hook"],"Score a spoken hook."),
 "title":("title.py",["--title","--thumb"],"Lint title and thumbnail pairing."),
 "deadair":("deadair.py",[],"Create an edit decision list from SRT."),
 "chapters":("chapters.py",[],"Create and validate YouTube chapters from SRT."),
 "retention":("retention.py",[],"Analyze a YouTube retention CSV."),
 "viral":("swipe.py",[],"Rank niche outliers from collected JSON.")
}
def main():
 p=argparse.ArgumentParser(description="Content Factory YouTube Agent Hub")
 sub=p.add_subparsers(dest="command",required=True)
 sub.add_parser("list",help="List installed skills and local tools")
 t=sub.add_parser("tool",help="Run a deterministic Python helper")
 t.add_argument("name",choices=COMMANDS)
 t.add_argument("args",nargs=argparse.REMAINDER)
 a=p.parse_args()
 if a.command=="list":
  manifest=json.loads((ROOT/"registry.json").read_text(encoding="utf-8"))
  print(json.dumps({"skills":manifest["skills"],"tools":{k:v[2] for k,v in COMMANDS.items()}},ensure_ascii=False,indent=2));return 0
 filename,_,_=COMMANDS[a.name]
 script=TOOLS/filename
 if not script.is_file(): print("Tool file missing: "+str(script),file=sys.stderr);return 2
 result=subprocess.run([sys.executable,str(script),*a.args],text=True)
 return result.returncode
if __name__=="__main__": raise SystemExit(main())
