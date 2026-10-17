# Xray routing compatibility fixtures

This developer tool is not installed on the router. The panel uses native Rust gRPC.
Pinned reference: Xray 26.9.9, commit 52a412d9e2f5c2a5142b1b4e2ab3771dacb8b120.
All input is synthetic; no live configuration is included.

Regenerate in this directory:

```sh
go run . < cases.json > ../../backend/src/xray_routing_fixtures.json
```

Run the portable Rust checks from backend:

```sh
cargo test --example xray_api_checks
```

The tests compare decoded protobuf fields, private CIDR-cache reuse, HTTP/2 flow control, gRPC error trailers and reconnection. File/category existence remains validated by Xray before installing runtime rules.