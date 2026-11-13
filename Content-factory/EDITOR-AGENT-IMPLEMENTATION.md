# Autonomous Editor implementation notes

The browser editor is available at `/editor.html` after the Pages deployment. It provides a mobile-first preview, scene timeline, candidate selection, command panel, and undo/redo for supported draft edits.

Supported deterministic commands in this initial implementation:
- Select a numbered scene.
- Move a numbered scene to the beginning.
- Set a scene duration in seconds (draft timeline only).
- Select the next available candidate for a scene.
- Navigate to next/previous scene.
- Undo and redo scene selection and draft timeline edits.

Important scope boundary: the existing background renderer currently accepts approved candidate IDs only. It does not yet consume timeline duration/order/motion overrides, so the UI explicitly labels those edits as draft-only and does not claim they are rendered. The approval action sends selected candidate IDs through the existing authenticated render workflow.

No paid LLM API is used. The command interpreter is deterministic in this first iteration; a self-hosted open model can be added later if compute capacity is provisioned.
