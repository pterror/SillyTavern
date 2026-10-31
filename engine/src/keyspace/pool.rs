use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};

use super::Keyspace;
use super::cache::Cache;
use super::exec::{Activity, Executor, Waiters};

pub struct Pool {
    pub buffer_bytes: usize,
    pub cache: Cache,
    pub exec: Executor,
    active: AtomicI64,
    frozen: AtomicI64,
    stores: Mutex<Vec<Weak<Keyspace>>>,
    room: Waiters,
    merges: Slots,
    flushes: Slots,
}

struct Slots {
    free: AtomicUsize,
    waiters: Waiters,
}

pub struct Slot<'a>(&'a Slots);

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.0.release();
    }
}

pub struct MergeSlot(Arc<Pool>);

impl Drop for MergeSlot {
    fn drop(&mut self) {
        self.0.merges.release();
    }
}

impl Slots {
    fn release(&self) {
        self.free.fetch_add(1, Ordering::AcqRel);
        self.waiters.wake();
    }

    fn new(n: usize) -> Slots {
        Slots {
            free: AtomicUsize::new(n.max(1)),
            waiters: Waiters::default(),
        }
    }

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
        Self::with_exec(
            buffer_bytes,
            cache_bytes,
            Executor::new(threads, front_only),
            merges,
            flushes,
        )
    }

    pub fn simulated(
        buffer_bytes: usize,
        cache_bytes: usize,
        merges: usize,
        flushes: usize,
        seed: u64,
    ) -> Arc<Pool> {
        Self::with_exec(
            buffer_bytes,
            cache_bytes,
            Executor::simulated(seed),
            merges,
            flushes,
        )
    }

    fn with_exec(
        buffer_bytes: usize,
        cache_bytes: usize,
        exec: Executor,
        merges: usize,
        flushes: usize,
    ) -> Arc<Pool> {
        Arc::new(Pool {
            buffer_bytes,
            cache: Cache::new(cache_bytes),
            exec,
            active: AtomicI64::new(0),
            frozen: AtomicI64::new(0),
            stores: Mutex::new(Vec::new()),
            room: Waiters::default(),
            merges: Slots::new(merges),
            flushes: Slots::new(flushes),
        })
    }

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

    pub(super) fn froze(&self, bytes: i64) {
        self.active.fetch_sub(bytes, Ordering::Relaxed);
        self.frozen.fetch_add(bytes, Ordering::Relaxed);
    }

    pub(super) fn released(&self, frozen: i64, active: i64) {
        self.frozen.fetch_sub(frozen, Ordering::Relaxed);
        self.active.fetch_sub(active, Ordering::Relaxed);
        self.room.wake();
    }

    pub(super) fn after_insert(&self) {
        if self.active.load(Ordering::Relaxed) >= self.buffer_bytes as i64 {
            self.freeze_largest();
        }
    }

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

    pub(super) fn merge_slot(self: &Arc<Self>, a: &Arc<Activity>) -> Option<MergeSlot> {
        let slot = self.merges.take(a)?;
        std::mem::forget(slot);
        Some(MergeSlot(self.clone()))
    }

    pub(super) fn flush_slot(&self, a: &Arc<Activity>) -> Option<Slot<'_>> {
        self.flushes.take(a)
    }
}
