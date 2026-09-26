# Repository workflow

- `main` belongs to the repository owner. Do not commit, push, reset, or merge into `main` unless the owner explicitly requests that exact action.
- Codex and Harness share the `codex` branch. Commit and push project work only there, and let the owner choose what enters `main`.
- Before pushing `codex`, fetch it and account for commits made by the other agent. Never force-push the shared branch.
- Do not commit credentials, tokens, private keys, live router configuration, logs, or local diagnostic files.
