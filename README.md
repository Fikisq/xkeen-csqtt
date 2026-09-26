# XKeen UI with CSQTT and WDTT Plus

This repository contains a Keenetic/Entware panel built from a Rust/axum backend and a React/Vite frontend. The `router/` directory contains service wrappers for the separate CSQTT and WDTT Plus clients. The clients are not built by this repository.

## Repository branches

`main` is maintained by the repository owner. Work in progress is shared on `codex`; changes are promoted to `main` by the owner.

## Build

The frontend uses Bun (`frontend/bun.lock`). The backend is in `backend/` and embeds the frontend output. `.github/workflows/build-rust.yml` describes the cross builds for ARM64, MIPS and MIPSEL. A release binary must be built and published before the network installer can install this fork.

## Installation and configuration

`setup.sh` is the panel installer. CSQTT and WDTT Plus need their own client binaries and credentials; see the scripts under `router/` for their runtime paths. Do not commit credentials, device configuration, live logs, or infrastructure notes. The `diagnostics/` directory contains manual diagnostic scripts and is not part of the normal router installation.

CSQTT 2.5.0 has not been integrated into the router scripts. They currently target the CSQTT 2.1.9 native client. Do not substitute the Android APK for a router binary.
