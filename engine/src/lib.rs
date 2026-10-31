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
#[cfg(not(feature = "measure"))]
mod store_binding;

#[cfg(not(feature = "measure"))]
#[napi_derive::napi]
pub fn ping() -> &'static str {
    "st-engine"
}
