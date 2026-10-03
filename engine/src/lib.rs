//! The storage engine (design: `.plans/2026-10-03-storage-from-needs.md`).

pub mod keyspace;
pub mod log;
pub mod store;
// Measurement builds are programs of their own, without node to provide Node-API.
#[cfg(not(feature = "measure"))]
mod store_binding;

/// Returns the crate's name, so a caller can tell the binding loaded.
#[cfg(not(feature = "measure"))]
#[napi_derive::napi]
pub fn ping() -> &'static str {
    "st-engine"
}
