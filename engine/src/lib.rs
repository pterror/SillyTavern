//! The storage engine (design: `.plans/2026-10-03-storage-from-needs.md`).

pub mod keyspace;
pub mod log;
mod log_binding;

use napi_derive::napi;

/// Returns the crate's name, so a caller can tell the binding loaded.
#[napi]
pub fn ping() -> &'static str {
    "st-engine"
}
