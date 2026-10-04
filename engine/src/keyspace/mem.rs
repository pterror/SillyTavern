//! The shared in-memory buffer: entries sorted by key, their bytes in large chunks the buffer owns and frees
//! whole, the map holding only fixed-size references into them.

use std::borrow::Borrow;
use std::collections::BTreeMap;
use std::ops::Bound;

use super::val::Val;

/// Chunks grow from the smallest to the largest, each as large as all before it, so a small buffer stays small and
/// a large one is a few allocations the allocator hands back whole.
const MIN_CHUNK: usize = 4 << 10;
const MAX_CHUNK: usize = 1 << 20;

/// Memory per entry besides its bytes in the chunks: the map's share. Measured: 85 bytes per entry of 12 bytes of
/// key and value (`measure calibrate`).
pub const ENTRY_OVERHEAD: usize = 72;

/// Bytes in one of the buffer's chunks. A chunk's memory never moves and is freed only with the buffer.
struct Bytes {
    ptr: *const u8,
    len: usize,
}

// SAFETY: a `Bytes` only reads chunk memory the owning `Mem` keeps alive and never writes it.
unsafe impl Send for Bytes {}
unsafe impl Sync for Bytes {}

impl Bytes {
    fn get(&self) -> &[u8] {
        // SAFETY: points into a live chunk of the `Mem` that holds this `Bytes` (see the type's doc).
        unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
    }
}

impl PartialEq for Bytes {
    fn eq(&self, o: &Self) -> bool {
        self.get() == o.get()
    }
}
impl Eq for Bytes {}
impl PartialOrd for Bytes {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Bytes {
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        self.get().cmp(o.get())
    }
}
impl Borrow<[u8]> for Bytes {
    fn borrow(&self) -> &[u8] {
        self.get()
    }
}

enum Stored {
    Put(Bytes),
    Del,
    Add(i64),
}

impl Stored {
    fn val(&self) -> Val {
        match self {
            Stored::Put(b) => Val::Put(b.get().to_vec()),
            Stored::Del => Val::Del,
            Stored::Add(n) => Val::Add(*n),
        }
    }
}

pub struct Mem {
    map: BTreeMap<Bytes, Stored>,
    /// Never grown or touched through a reference once made: bytes are written through `base`.
    chunks: Vec<Vec<u8>>,
    /// The last chunk's start, and how much of it is used.
    base: *mut u8,
    used: usize,
    cap: usize,
    /// Memory held: the chunks, and the map at `ENTRY_OVERHEAD` per entry.
    bytes: usize,
    /// The log position its entries cover, once frozen.
    pub(super) covered: u64,
    /// Frozen for the pool's budget, rather than for L or a close.
    pub(super) full: bool,
}

// SAFETY: `base` points into a chunk the `Mem` owns; it is written only through `&mut Mem` (`alloc`), and what
// `Bytes` read was written before they were made.
unsafe impl Send for Mem {}
unsafe impl Sync for Mem {}

impl Default for Mem {
    fn default() -> Self {
        Mem {
            map: BTreeMap::new(),
            chunks: Vec::new(),
            base: std::ptr::null_mut(),
            used: 0,
            cap: 0,
            bytes: 0,
            covered: 0,
            full: false,
        }
    }
}

impl Mem {
    fn alloc(&mut self, b: &[u8]) -> Bytes {
        if self.used + b.len() > self.cap {
            let held = self.chunks.iter().map(Vec::len).sum::<usize>();
            let size = held.clamp(MIN_CHUNK, MAX_CHUNK).max(b.len());
            let mut chunk = vec![0u8; size];
            self.base = chunk.as_mut_ptr();
            self.chunks.push(chunk);
            (self.used, self.cap) = (0, size);
            self.bytes += size;
        }
        // SAFETY: `used + len <= cap` bytes of the chunk at `base`, written nowhere else.
        let ptr = unsafe { self.base.add(self.used) };
        unsafe { std::ptr::copy_nonoverlapping(b.as_ptr(), ptr, b.len()) };
        self.used += b.len();
        Bytes { ptr, len: b.len() }
    }

    fn store(&mut self, v: Val) -> Stored {
        match v {
            Val::Put(b) => Stored::Put(self.alloc(&b)),
            Val::Del => Stored::Del,
            Val::Add(n) => Stored::Add(n),
        }
    }

    /// Inserts `val` over the key's value; returns how many bytes the buffer grew by.
    pub(super) fn insert(&mut self, key: &[u8], val: Val) -> i64 {
        let before = self.bytes;
        let stored = match self.map.get(key) {
            // A counter's sum over a counter is kept in place: no new bytes for each add.
            Some(Stored::Add(old)) if matches!(val, Val::Add(_)) => {
                let Val::Add(n) = val else { unreachable!() };
                Stored::Add(old.wrapping_add(n))
            }
            Some(old) => {
                let v = val.over(&old.val());
                self.store(v)
            }
            None => {
                let k = self.alloc(key);
                let s = self.store(val);
                self.map.insert(k, s);
                self.bytes += ENTRY_OVERHEAD;
                return self.bytes as i64 - before as i64;
            }
        };
        *self.map.get_mut(key).unwrap() = stored;
        self.bytes as i64 - before as i64
    }

    pub fn get(&self, key: &[u8]) -> Option<Val> {
        self.map.get(key).map(Stored::val)
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn iter(&self) -> impl Iterator<Item = (&[u8], Val)> {
        self.map.iter().map(|(k, v)| (k.get(), v.val()))
    }

    /// Entries in `[start, end)`, in order.
    pub fn range<'a>(&'a self, start: &[u8], end: &[u8]) -> impl Iterator<Item = (&'a [u8], Val)> {
        self.map
            .range::<[u8], _>((Bound::Included(start), Bound::Excluded(end)))
            .map(|(k, v)| (k.get(), v.val()))
    }

    /// Entries in `[start, end)` in order, until `live` of them aren't deletions.
    pub(super) fn page(&self, start: &[u8], end: &[u8], live: usize) -> Vec<(Vec<u8>, Val)> {
        let mut out = Vec::new();
        let mut n = 0;
        for (k, v) in self.range(start, end) {
            if n == live {
                break;
            }
            if v != Val::Del {
                n += 1;
            }
            out.push((k.to_vec(), v));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keyspace::val::counter_bytes;

    #[test]
    fn entries_fold_as_they_arrive_and_outlive_many_chunks() {
        let mut m = Mem::default();
        for i in 0u32..300_000 {
            let k = (i % 100_000).to_be_bytes();
            m.insert(&k, Val::Put(vec![i as u8; (i % 40) as usize]));
        }
        m.insert(b"c", Val::Add(2));
        m.insert(b"c", Val::Add(3));
        assert_eq!(m.get(b"c"), Some(Val::Add(5)));
        m.insert(b"c", Val::Put(counter_bytes(10)));
        m.insert(b"c", Val::Add(1));
        assert_eq!(m.get(b"c"), Some(Val::Put(counter_bytes(11))));
        m.insert(b"c", Val::Del);
        assert_eq!(m.get(b"c"), Some(Val::Del));
        for i in 200_000u32..300_000 {
            let k = (i % 100_000).to_be_bytes();
            assert_eq!(m.get(&k), Some(Val::Put(vec![i as u8; (i % 40) as usize])));
        }
        assert!(m.chunks.len() > 5);
        let keys: Vec<Vec<u8>> = m.iter().map(|(k, _)| k.to_vec()).collect();
        assert!(keys.windows(2).all(|w| w[0] < w[1]));
    }
}
