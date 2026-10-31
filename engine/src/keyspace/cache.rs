use std::collections::{BTreeMap, HashMap};
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use super::block::Block;

type Key = (u64, u64);

#[derive(Default)]
struct KeyHasher(u64);

impl Hasher for KeyHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.write_u64(u64::from(b));
        }
    }

    fn write_u64(&mut self, n: u64) {
        self.0 = (self.0.rotate_left(5) ^ n).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
}

#[derive(Default)]
struct Inner {
    map: HashMap<Key, (Arc<Block>, u64), BuildHasherDefault<KeyHasher>>,
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
        *used = tick;
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
        if let Some((old, _)) = inner.map.insert(key, (block, tick)) {
            inner.bytes -= old.size();
        }
        inner.by_use.insert(tick, key);
        while inner.bytes > self.capacity {
            let (placed, k) = inner.by_use.pop_first().unwrap();
            let Some(&(_, used)) = inner.map.get(&k) else {
                continue;
            };
            if used > placed {
                inner.by_use.entry(used).or_insert(k);
                continue;
            }
            let (b, _) = inner.map.remove(&k).unwrap();
            inner.bytes -= b.size();
        }
    }

    pub fn bytes(&self) -> usize {
        self.inner.lock().unwrap().bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keyspace::block::{BlockBuilder, KIND_DATA};
    use crate::keyspace::val::Val;

    fn block() -> Arc<Block> {
        let mut b = BlockBuilder::default();
        b.add(b"k", &Val::Put(vec![0; 100]));
        Arc::new(Block::parse(b.finish(KIND_DATA)).unwrap())
    }

    #[test]
    fn the_least_recently_used_block_goes_first_and_the_bytes_stay_in_bounds() {
        let size = block().size();
        let cache = Cache::new(size * 3);
        for i in 0..3 {
            cache.insert((1, i), block());
        }
        assert!(cache.get((1, 0)).is_some());
        cache.insert((1, 3), block());
        assert!(cache.get((1, 1)).is_none());
        assert!(cache.get((1, 0)).is_some());
        cache.insert((1, 2), block());
        assert_eq!(cache.bytes(), size * 3);
        cache.get((1, 0));
        cache.insert((1, 4), block());
        assert!(cache.get((1, 3)).is_none());
        for k in [(1, 2), (1, 4), (1, 0)] {
            assert!(cache.get(k).is_some(), "{k:?}");
        }
        assert_eq!(cache.bytes(), size * 3);
        for i in 5..200 {
            cache.insert((2, i), block());
            cache.get((2, i - 1));
            assert!(cache.get((1, 0)).is_some(), "{i}");
            assert!(cache.bytes() <= size * 3);
        }
    }
}
