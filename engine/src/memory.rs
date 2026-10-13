//! The memory this crate's allocations take: the bytes its allocator has handed out and not had back.
//!
//! Counted at the global allocator (`Counting`), not read from mimalloc's own statistics: on Linux mimalloc counts
//! the arenas it commits up front, and its count neither follows what is in use nor falls when memory is freed.

use std::alloc::{GlobalAlloc, Layout};
use std::sync::atomic::{AtomicIsize, Ordering};

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
