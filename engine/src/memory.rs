//! The memory the process takes: its resident memory as the system counts it (`Resident`), where it can be read;
//! else the bytes this crate's allocator has handed out and not had back (`committed`).
//!
//! Resident memory includes allocator rounding, retained pages, fragmentation and the host's allocations.
//! It detects pressure that the requested-byte count misses, but the loader cannot reclaim the host's memory.

use std::alloc::{GlobalAlloc, Layout};
use std::sync::atomic::{AtomicIsize, Ordering};

/// The process's resident memory, read from the system (`sysinfo`); not on wasm.
pub struct Resident {
    #[cfg(not(target_family = "wasm"))]
    system: sysinfo::System,
    #[cfg(not(target_family = "wasm"))]
    pid: Option<sysinfo::Pid>,
    /// The last bytes read, given again where a later read fails.
    last: Option<usize>,
}

impl Resident {
    pub fn new() -> Resident {
        Resident {
            #[cfg(not(target_family = "wasm"))]
            system: sysinfo::System::new(),
            #[cfg(not(target_family = "wasm"))]
            pid: sysinfo::get_current_pid().ok(),
            last: None,
        }
    }

    /// The process's resident bytes now (where a read fails after one worked, the last read); None where they
    /// can't be read.
    pub fn read(&mut self) -> Option<usize> {
        #[cfg(not(target_family = "wasm"))]
        if let Some(pid) = self.pid {
            self.system.refresh_processes_specifics(
                sysinfo::ProcessesToUpdate::Some(&[pid]),
                false,
                sysinfo::ProcessRefreshKind::nothing().with_memory(),
            );
            if let Some(bytes) = self
                .system
                .process(pid)
                .map(|p| p.memory())
                .filter(|&b| b > 0)
            {
                self.last = Some(usize::try_from(bytes).unwrap_or(usize::MAX));
            }
        }
        self.last
    }
}

impl Default for Resident {
    fn default() -> Resident {
        Resident::new()
    }
}

/// Counts kept apart, so threads allocating at once mostly touch counts of their own; a byte freed on another
/// thread than allocated it is taken off another count, and the sum is right.
const STRIPES: usize = 64;

#[repr(align(128))]
struct Stripe(AtomicIsize);

static COUNTS: [Stripe; STRIPES] = [const { Stripe(AtomicIsize::new(0)) }; STRIPES];

fn stripe() -> &'static AtomicIsize {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    // Const-initialized and without a destructor, so reaching it never allocates; `STRIPES` until first used.
    thread_local! {
        static AT: std::cell::Cell<usize> = const { std::cell::Cell::new(STRIPES) };
    }
    let at = AT
        .try_with(|a| {
            if a.get() == STRIPES {
                a.set(NEXT.fetch_add(1, Ordering::Relaxed) % STRIPES);
            }
            a.get()
        })
        .unwrap_or(0);
    &COUNTS[at].0
}

/// Bytes this crate's allocations hold now.
pub fn committed() -> usize {
    let sum: isize = COUNTS.iter().map(|s| s.0.load(Ordering::Relaxed)).sum();
    sum.max(0) as usize
}

/// An allocator counting what it hands out and has back (`committed`).
pub struct Counting<A>(pub A);

// SAFETY: every call is passed on to the inner allocator as it came; only the counts are added to.
unsafe impl<A: GlobalAlloc> GlobalAlloc for Counting<A> {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { self.0.alloc(layout) };
        if !p.is_null() {
            stripe().fetch_add(layout.size() as isize, Ordering::Relaxed);
        }
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { self.0.alloc_zeroed(layout) };
        if !p.is_null() {
            stripe().fetch_add(layout.size() as isize, Ordering::Relaxed);
        }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { self.0.dealloc(ptr, layout) };
        stripe().fetch_sub(layout.size() as isize, Ordering::Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = unsafe { self.0.realloc(ptr, layout, new_size) };
        if !p.is_null() {
            stripe().fetch_add(
                new_size as isize - layout.size() as isize,
                Ordering::Relaxed,
            );
        }
        p
    }
}
