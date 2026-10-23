# Repository workflow

- `main` belongs to the repository owner. Do not commit, push, reset, or merge into `main` unless the owner explicitly requests that exact action.
- Codex and Harness share the `codex` branch. Commit and push project work only there, and let the owner choose what enters `main`.
- Before pushing `codex`, fetch it and account for commits made by the other agent. Never force-push the shared branch.
- Do not commit credentials, tokens, private keys, live router configuration, logs, or local diagnostic files.

# Workspace files and commits

- Keep agent-created reports, archives, checkouts, and build outputs on drive `E:`. Use `E:\cudy\diagnostic-notes` for local reports and `E:\cudy\build-tools` for temporary build outputs. Do not leave these files on `C:` or `D:`. System-managed caches are exempt when their location cannot be controlled.
- Keep audit notes, measurements, logs, screenshots, and scratch files outside this Git repository unless the owner explicitly asks to publish a specific file.
- Do not add extra `AGENTS.md`, `AUDIT*`, handoff, or diagnostic text files to commits unless the owner explicitly asks. Keep this existing `AGENTS.md` as the single repository instruction file.
- Before a commit, inspect `git status --short` and `git diff --cached --name-only`. Stage intended project files by explicit path; do not use blanket `git add .`.
- Do not commit or push without the owner's explicit request.
