//! The block cache: run blocks by (run, offset), least recently used evicted first, at most `capacity` bytes.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use super::block::Block;

type Key = (u64, u64);

#[derive(Default)]
struct Inner {
    map: HashMap<Key, (Arc<Block>, u64)>,
    by_use: BTreeMap<u64, Key>,
    bytes: usize,
    tick: u64,
}

pub struct Cache {
    capacity: usize,
    inner: Mutex<Inner>,
    pub hits: AtomicU64,
    pub misses: AtomicU64,
}

impl Cache {
    pub fn new(capacity: usize) -> Cache {
        Cache {
            capacity,
            inner: Mutex::new(Inner::default()),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
        }
    }

    pub fn get(&self, key: Key) -> Option<Arc<Block>> {
        let mut g = self.inner.lock().unwrap();
        let inner = &mut *g;
        inner.tick += 1;
        let tick = inner.tick;
        let Some((block, used)) = inner.map.get_mut(&key) else {
            drop(g);
            self.misses.fetch_add(1, Ordering::Relaxed);
            return None;
        };
        inner.by_use.remove(used);
        *used = tick;
        inner.by_use.insert(tick, key);
        let block = block.clone();
        drop(g);
        self.hits.fetch_add(1, Ordering::Relaxed);
        Some(block)
    }

    pub fn insert(&self, key: Key, block: Arc<Block>) {
        if block.size() > self.capacity {
            return;
        }
        let mut g = self.inner.lock().unwrap();
        let inner = &mut *g;
        inner.tick += 1;
        let tick = inner.tick;
        inner.bytes += block.size();
        if let Some((old, used)) = inner.map.insert(key, (block, tick)) {
            inner.bytes -= old.size();
            inner.by_use.remove(&used);
        }
        inner.by_use.insert(tick, key);
        while inner.bytes > self.capacity {
            let (_, k) = inner.by_use.pop_first().unwrap();
            let (b, _) = inner.map.remove(&k).unwrap();
            inner.bytes -= b.size();
        }
    }

    /// Bytes held.
    pub fn bytes(&self) -> usize {
        self.inner.lock().unwrap().bytes
    }
}
