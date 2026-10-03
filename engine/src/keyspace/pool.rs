//! What every open keyspace in the process shares, so memory doesn't grow with the number of stores: the buffer
//! budget B, the block cache C, and the slots bounding how many flushes and merges (each holding a writer's
//! buffers) run at once.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};

use super::Keyspace;
use super::cache::Cache;

pub struct Pool {
    /// B: once the stores' buffers taking inserts hold this much, the largest is frozen and flushed.
    pub buffer_bytes: usize,
    pub cache: Cache,
    /// Bytes in buffers taking inserts, and in frozen buffers waiting for their flush.
    active: AtomicI64,
    frozen: AtomicI64,
    stores: Mutex<Vec<Weak<Keyspace>>>,
    room: Mutex<()>,
    room_cv: Condvar,
    merges: Slots,
    flushes: Slots,
}

/// A counting semaphore.
struct Slots {
    free: Mutex<usize>,
    cv: Condvar,
}

pub struct Slot<'a>(&'a Slots);

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        *self.0.free.lock().unwrap() += 1;
        self.0.cv.notify_one();
    }
}

impl Slots {
    fn new(n: usize) -> Slots {
        Slots {
            free: Mutex::new(n.max(1)),
            cv: Condvar::new(),
        }
    }

    fn take(&self) -> Slot<'_> {
        let mut free = self.free.lock().unwrap();
        while *free == 0 {
            free = self.cv.wait(free).unwrap();
        }
        *free -= 1;
        Slot(self)
    }
}

impl Pool {
    pub fn new(
        buffer_bytes: usize,
        cache_bytes: usize,
        merges: usize,
        flushes: usize,
    ) -> Arc<Pool> {
        Arc::new(Pool {
            buffer_bytes,
            cache: Cache::new(cache_bytes),
            active: AtomicI64::new(0),
            frozen: AtomicI64::new(0),
            stores: Mutex::new(Vec::new()),
            room: Mutex::new(()),
            room_cv: Condvar::new(),
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
        let _g = self.room.lock().unwrap();
        self.room_cv.notify_all();
    }

    /// After an insert: once the active buffers reach B, asks the store with the largest one to freeze it;
    /// then waits while the active and frozen buffers together hold 2B (their flushes free it).
    pub(super) fn after_insert(&self) {
        let b = self.buffer_bytes as i64;
        if self.active.load(Ordering::Relaxed) >= b {
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
        let mut g = self.room.lock().unwrap();
        while self.active.load(Ordering::Relaxed) + self.frozen.load(Ordering::Relaxed) >= 2 * b
            && self.frozen.load(Ordering::Relaxed) > 0
        {
            g = self.room_cv.wait(g).unwrap();
        }
    }

    pub(super) fn merge_slot(&self) -> Slot<'_> {
        self.merges.take()
    }

    pub(super) fn flush_slot(&self) -> Slot<'_> {
        self.flushes.take()
    }
}
