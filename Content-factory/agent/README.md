# Content Factory Agent Hub

This folder ports the MIT-licensed YouTube Agent Skill pack into Content Factory. Claude Code is not required.

## Management model
- **ChatGPT conversation:** primary reasoning, research, planning, scriptwriting, decisions and task direction.
- **Content Factory:** stores the skill pack and runs deterministic Python helpers.
- **Human approval:** nothing is published automatically.

## 11 installed skills
See [registry.json](registry.json). The skill instructions are stored in `skills/`; reusable tools are in `tools/`.

## Local setup
Requires Python 3.10+; the six helper tools use the Python standard library.

```bash
cd Content-factory/agent
python runner.py list
python runner.py tool hookscore --hook "Bu gerçeği öğrenince fikrin değişecek."
python runner.py tool title --title "Başlık" --thumb "Kapak metni"
python runner.py tool deadair transcript.srt
python runner.py tool chapters transcript.srt --target 8
python runner.py tool retention retention.csv --duration 600
python runner.py tool viral collected.json --min 2.0
```

## Chat-to-panel workflow
1. Ask ChatGPT to research or plan a YouTube task.
2. ChatGPT selects one of the 11 skill definitions and prepares the exact inputs.
3. Run the corresponding deterministic helper in Content Factory when the skill has one.
4. Review the result; approve edits and publishing yourself.

## Important boundaries
This pack is not an autonomous LLM. The 11 skill files are operating playbooks; six Python scripts are deterministic analysis helpers. They do not browse YouTube by themselves, call an LLM, upload videos, or publish. Live research is handled by ChatGPT/web; optional account integrations must be connected separately. No Anthropic/Claude API key is used.

## Original project
Source: https://github.com/Jakeschincariol/youtube-agent-skill
License: MIT. Original license is retained at the repository root of the imported pack where applicable.
