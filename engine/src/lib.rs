//! The storage engine (design: `.plans/2026-10-03-storage-from-needs.md`).

// Native builds allocate with mimalloc, which returns freed memory to the system; glibc's allocator kept each
// engine thread's arena at its peak. Only this crate's allocations: Node's memory is its own. Wasm keeps the
// default allocator. Either is counted (`memory::committed`).
#[cfg(not(target_family = "wasm"))]
#[global_allocator]
static ALLOCATOR: memory::Counting<mimalloc::MiMalloc> = memory::Counting(mimalloc::MiMalloc);
#[cfg(target_family = "wasm")]
#[global_allocator]
static ALLOCATOR: memory::Counting<std::alloc::System> = memory::Counting(std::alloc::System);

pub mod faults;
pub mod keyspace;
pub mod log;
pub mod memory;
pub mod search;
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
