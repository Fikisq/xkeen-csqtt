//! Portable native API checks: cargo test --example xray_api_checks
//! Does not build or start the router's platform-specific application.
#[path = "../src/xray_api.rs"]
mod xray_api;
#[path = "../src/xray_routing_codec.rs"]
mod xray_routing_codec;
#[path = "../src/xray_wire.rs"]
mod xray_wire;
fn main() {}
