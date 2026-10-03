//! The storage engine (design: `.plans/2026-10-03-storage-from-needs.md`).
//!
//! Stage 1 exports one trivial function so the whole path (build, release, fetch, load,
//! native and wasm) is exercised before the engine exists.

use napi_derive::napi;

/// Returns the crate's name, so a caller can tell the binding loaded.
#[napi]
pub fn ping() -> &'static str {
    "st-engine"
}
