//! What every open keyspace in the process shares, so memory doesn't grow with the number of stores: the threads
//! (`Executor`), the buffer budget B, the block cache C, and the slots bounding how many flushes and merges (each
//! holding a writer's buffers, and a thread for its length) run at once.

use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};

use super::Keyspace;
use super::cache::Cache;
use super::exec::{Activity, Executor, Waiters};

pub struct Pool {
    /// B: once the stores' buffers taking inserts hold this much, the largest is frozen and flushed.
    pub buffer_bytes: usize,
    pub cache: Cache,
    pub exec: Executor,
    /// Bytes in buffers taking inserts, and in frozen buffers waiting for their flush.
    active: AtomicI64,
    frozen: AtomicI64,
    stores: Mutex<Vec<Weak<Keyspace>>>,
    room: Waiters,
    merges: Slots,
    flushes: Slots,
}

/// A counting semaphore whose takers wait by being kicked, not by blocking a thread.
struct Slots {
    free: AtomicUsize,
    waiters: Waiters,
}

pub struct Slot<'a>(&'a Slots);

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.0.free.fetch_add(1, Ordering::AcqRel);
        self.0.waiters.wake();
    }
}

impl Slots {
    fn new(n: usize) -> Slots {
        Slots {
            free: AtomicUsize::new(n.max(1)),
            waiters: Waiters::default(),
        }
    }

    /// A slot, or None and `a` is kicked when one frees.
    fn take(&self, a: &Arc<Activity>) -> Option<Slot<'_>> {
        let got = self.waiters.check_or_wait(a, || {
            self.free
                .try_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1))
                .is_ok()
        });
        got.then_some(Slot(self))
    }
}

impl Pool {
    pub fn new(
        buffer_bytes: usize,
        cache_bytes: usize,
        threads: usize,
        front_only: usize,
        merges: usize,
        flushes: usize,
    ) -> Arc<Pool> {
        Arc::new(Pool {
            buffer_bytes,
            cache: Cache::new(cache_bytes),
            exec: Executor::new(threads, front_only),
            active: AtomicI64::new(0),
            frozen: AtomicI64::new(0),
            stores: Mutex::new(Vec::new()),
            room: Waiters::default(),
            merges: Slots::new(merges),
            flushes: Slots::new(flushes),
        })
    }

    /// Bytes in buffers taking inserts, and in frozen ones.
    pub fn buffered(&self) -> (u64, u64) {
        let get = |a: &AtomicI64| a.load(Ordering::Relaxed).max(0) as u64;
        (get(&self.active), get(&self.frozen))
    }

    pub(super) fn register(&self, ks: &Arc<Keyspace>) {
        let mut stores = self.stores.lock().unwrap();
        stores.retain(|w| w.strong_count() > 0);
        stores.push(Arc::downgrade(ks));
    }

    pub(super) fn add_active(&self, delta: i64) {
        self.active.fetch_add(delta, Ordering::Relaxed);
    }

    /// A buffer of `bytes` was frozen.
    pub(super) fn froze(&self, bytes: i64) {
        self.active.fetch_sub(bytes, Ordering::Relaxed);
        self.frozen.fetch_add(bytes, Ordering::Relaxed);
    }

    /// `frozen` bytes of frozen buffers were flushed, and `active` bytes of buffers taking inserts dropped (a
    /// store that stopped).
    pub(super) fn released(&self, frozen: i64, active: i64) {
        self.frozen.fetch_sub(frozen, Ordering::Relaxed);
        self.active.fetch_sub(active, Ordering::Relaxed);
        self.room.wake();
    }

    /// After an insert: once the active buffers reach B, asks the store with the largest one to freeze it.
    pub(super) fn after_insert(&self) {
        if self.active.load(Ordering::Relaxed) >= self.buffer_bytes as i64 {
            self.freeze_largest();
        }
    }

    /// Freezes the largest active buffer, as a publish finding no room does (for tests that insert directly).
    #[cfg(test)]
    pub(super) fn request_room(&self) {
        self.freeze_largest();
    }

    fn freeze_largest(&self) {
        let largest = self
            .stores
            .lock()
            .unwrap()
            .iter()
            .filter_map(Weak::upgrade)
            .filter(|ks| !ks.freeze_requested())
            .map(|ks| (ks.active_bytes(), ks))
            .filter(|(n, _)| *n > 0)
            .max_by_key(|(n, _)| *n);
        if let Some((_, ks)) = largest {
            ks.request_freeze();
        }
    }

    /// Whether there is room to publish more entries: the active and frozen buffers hold less than 2B. If not, the
    /// largest active buffer is frozen (if any isn't yet) and `a` is kicked when a flush frees memory.
    pub fn room_or_wait(&self, a: &Arc<Activity>) -> bool {
        let room = self.room.check_or_wait(a, || {
            self.active.load(Ordering::Relaxed) + self.frozen.load(Ordering::Relaxed)
                < 2 * self.buffer_bytes as i64
        });
        if !room {
            self.freeze_largest();
        }
        room
    }

    pub(super) fn merge_slot(&self, a: &Arc<Activity>) -> Option<Slot<'_>> {
        self.merges.take(a)
    }

    pub(super) fn flush_slot(&self, a: &Arc<Activity>) -> Option<Slot<'_>> {
        self.flushes.take(a)
    }
}
