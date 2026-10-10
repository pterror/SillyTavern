//! The shared in-memory buffer: entries sorted by key, their bytes in large chunks the buffer owns and frees
//! whole, the map holding only fixed-size references into them.
//!
//! Each entry's value carries the sequence number of the insert that wrote it. A snapshot read sees, per key, the
//! newest value at or before its sequence; an insert keeps the value it replaces only while a live snapshot may
//! still read it (`Readers`), and folds in place otherwise.

use std::borrow::Borrow;
use std::collections::BTreeMap;
use std::ops::Bound;

use super::val::Val;

/// Chunks grow from the smallest to the largest, each as large as all before it, so a small buffer stays small and
/// a large one is a few allocations the allocator hands back whole.
const MIN_CHUNK: usize = 4 << 10;
const MAX_CHUNK: usize = 1 << 20;

/// Memory per entry besides its bytes in the chunks: the map's share. Measured: 85 bytes per entry of 12 bytes of
/// key and value (`measure calibrate`), before the sequence number and the older values' list (8 + 24).
pub const ENTRY_OVERHEAD: usize = 104;
/// Memory per older value kept for a snapshot, besides its bytes.
const OLDER_OVERHEAD: usize = 40;

/// The sequence numbers of the live snapshots, ascending: whether one may read a value written at `from` and
/// replaced at `to` (from ≤ its sequence < to).
pub struct Readers<'a>(pub &'a [u64]);

impl Readers<'_> {
    fn reads(&self, from: u64, to: u64) -> bool {
        let i = self.0.partition_point(|&r| r < from);
        self.0.get(i).is_some_and(|&r| r < to)
    }
}

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
    Max(u64),
    Map(Vec<(u32, u32)>),
    MaxMap(Vec<(u32, u32)>),
}

impl Stored {
    fn val(&self) -> Val {
        match self {
            Stored::Put(b) => Val::Put(b.get().to_vec()),
            Stored::Del => Val::Del,
            Stored::Add(n) => Val::Add(*n),
            Stored::Max(n) => Val::Max(*n),
            Stored::Map(p) => Val::Map(p.clone()),
            Stored::MaxMap(p) => Val::MaxMap(p.clone()),
        }
    }
}

/// A key's newest value with the sequence that wrote it, and older values a snapshot may still read (oldest
/// first).
struct Slot {
    seq: u64,
    val: Stored,
    older: Vec<(u64, Stored)>,
}

impl Slot {
    /// The value a snapshot at `seq` reads (None: none yet).
    fn at(&self, seq: u64) -> Option<&Stored> {
        if self.seq <= seq {
            return Some(&self.val);
        }
        self.older
            .iter()
            .rev()
            .find(|(s, _)| *s <= seq)
            .map(|(_, v)| v)
    }
}

pub struct Mem {
    map: BTreeMap<Bytes, Slot>,
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
            Val::Max(n) => Stored::Max(n),
            Val::Map(p) => {
                self.bytes += p.capacity() * 8;
                Stored::Map(p)
            }
            Val::MaxMap(p) => {
                self.bytes += p.capacity() * 8;
                Stored::MaxMap(p)
            }
        }
    }

    /// Inserts `val` over the key's value at sequence `seq` (above every sequence before); returns how many bytes
    /// the buffer grew by. The value replaced is kept while one of `readers` may read it.
    pub(super) fn insert(&mut self, key: &[u8], val: Val, seq: u64, readers: &Readers) -> i64 {
        let before = self.bytes;
        let Some(slot) = self.map.get(key) else {
            let k = self.alloc(key);
            let s = self.store(val);
            self.map.insert(
                k,
                Slot {
                    seq,
                    val: s,
                    older: Vec::new(),
                },
            );
            self.bytes += ENTRY_OVERHEAD;
            return self.bytes as i64 - before as i64;
        };
        let keep = readers.reads(slot.seq, seq);
        if !keep {
            // Folded in place: no snapshot reads the value replaced.
            let slot = self.map.get_mut(key).unwrap();
            let folded = match (&mut slot.val, val) {
                // A counter's sum over a counter, or a maximum over a maximum, is kept in place: no new bytes.
                (Stored::Add(old), Val::Add(n)) => {
                    *old = old.wrapping_add(n);
                    None
                }
                (Stored::Max(old), Val::Max(n)) => {
                    *old = n.max(*old);
                    None
                }
                (Stored::Map(old), Val::Map(n)) => {
                    let cap = old.capacity();
                    let merged = super::val::map_over(&n, std::mem::take(old));
                    self.bytes = self.bytes + merged.capacity() * 8 - cap * 8;
                    *old = merged;
                    None
                }
                (Stored::MaxMap(old), Val::MaxMap(n)) => {
                    let cap = old.capacity();
                    let merged = super::val::map_max(&n, std::mem::take(old));
                    self.bytes = self.bytes + merged.capacity() * 8 - cap * 8;
                    *old = merged;
                    None
                }
                (old, v) => Some(v.over(&old.val())),
            };
            let slot = self.map.get_mut(key).unwrap();
            slot.seq = seq;
            if let Some(v) = folded {
                if let Stored::Map(p) | Stored::MaxMap(p) = &slot.val {
                    self.bytes -= p.capacity() * 8;
                }
                let stored = self.store(v);
                self.map.get_mut(key).unwrap().val = stored;
            }
            self.prune(key, readers);
            return self.bytes as i64 - before as i64;
        }
        let v = val.over(&slot.val.val());
        let stored = self.store(v);
        let slot = self.map.get_mut(key).unwrap();
        let old = std::mem::replace(&mut slot.val, stored);
        slot.older.push((slot.seq, old));
        slot.seq = seq;
        self.bytes += OLDER_OVERHEAD;
        self.prune(key, readers);
        self.bytes as i64 - before as i64
    }

    /// Drops the key's older values no live snapshot reads.
    fn prune(&mut self, key: &[u8], readers: &Readers) {
        let slot = self.map.get_mut(key).unwrap();
        if slot.older.is_empty() {
            return;
        }
        let mut kept = Vec::new();
        let mut freed = 0;
        let older = std::mem::take(&mut slot.older);
        for (i, (s, v)) in older.iter().enumerate() {
            let next = older.get(i + 1).map_or(slot.seq, |x| x.0);
            if readers.reads(*s, next) {
                kept.push(i);
            } else {
                freed += OLDER_OVERHEAD
                    + match v {
                        Stored::Map(p) | Stored::MaxMap(p) => p.capacity() * 8,
                        _ => 0,
                    };
            }
        }
        slot.older = older
            .into_iter()
            .enumerate()
            .filter(|(i, _)| kept.contains(i))
            .map(|(_, x)| x)
            .collect();
        self.bytes -= freed;
    }

    /// The value a snapshot at `seq` reads.
    pub fn get_at(&self, key: &[u8], seq: u64) -> Option<Val> {
        self.map.get(key).and_then(|s| s.at(seq)).map(Stored::val)
    }

    /// Entries in `[start, end)` as a snapshot at `seq` reads them, in order, until `live` of them aren't
    /// deletions.
    pub(super) fn page_at(
        &self,
        start: &[u8],
        end: &[u8],
        live: usize,
        seq: u64,
    ) -> Vec<(Vec<u8>, Val)> {
        let mut out = Vec::new();
        let mut n = 0;
        for (k, slot) in self
            .map
            .range::<[u8], _>((Bound::Included(start), Bound::Excluded(end)))
        {
            if n == live {
                break;
            }
            let Some(v) = slot.at(seq) else { continue };
            let v = v.val();
            if v != Val::Del {
                n += 1;
            }
            out.push((k.get().to_vec(), v));
        }
        out
    }

    pub fn get(&self, key: &[u8]) -> Option<Val> {
        self.map.get(key).map(|s| s.val.val())
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn iter(&self) -> impl Iterator<Item = (&[u8], Val)> {
        self.map.iter().map(|(k, v)| (k.get(), v.val.val()))
    }

    /// Entries in `[start, end)`, in order.
    pub fn range<'a>(&'a self, start: &[u8], end: &[u8]) -> impl Iterator<Item = (&'a [u8], Val)> {
        self.map
            .range::<[u8], _>((Bound::Included(start), Bound::Excluded(end)))
            .map(|(k, v)| (k.get(), v.val.val()))
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
            m.insert(
                &k,
                Val::Put(vec![i as u8; (i % 40) as usize]),
                1,
                &Readers(&[]),
            );
        }
        m.insert(b"c", Val::Add(2), 1, &Readers(&[]));
        m.insert(b"c", Val::Add(3), 1, &Readers(&[]));
        assert_eq!(m.get(b"c"), Some(Val::Add(5)));
        m.insert(b"c", Val::Put(counter_bytes(10)), 1, &Readers(&[]));
        m.insert(b"c", Val::Add(1), 1, &Readers(&[]));
        assert_eq!(m.get(b"c"), Some(Val::Put(counter_bytes(11))));
        m.insert(b"c", Val::Del, 1, &Readers(&[]));
        assert_eq!(m.get(b"c"), Some(Val::Del));
        for i in 200_000u32..300_000 {
            let k = (i % 100_000).to_be_bytes();
            assert_eq!(m.get(&k), Some(Val::Put(vec![i as u8; (i % 40) as usize])));
        }
        assert!(m.chunks.len() > 5);
        let keys: Vec<Vec<u8>> = m.iter().map(|(k, _)| k.to_vec()).collect();
        assert!(keys.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn a_snapshot_reads_the_values_at_its_sequence() {
        let mut m = Mem::default();
        m.insert(b"a", Val::Add(1), 1, &Readers(&[]));
        m.insert(b"m", Val::Map(vec![(1, 5)]), 1, &Readers(&[]));
        // A snapshot at 1 lives while 2 and 3 are inserted.
        m.insert(b"a", Val::Add(10), 2, &Readers(&[1]));
        m.insert(b"m", Val::Map(vec![(2, 6)]), 2, &Readers(&[1]));
        m.insert(b"b", Val::Put(b"x".to_vec()), 2, &Readers(&[1]));
        m.insert(b"a", Val::Add(100), 3, &Readers(&[1]));
        assert_eq!(m.get_at(b"a", 1), Some(Val::Add(1)));
        assert_eq!(m.get_at(b"a", 3), Some(Val::Add(111)));
        assert_eq!(m.get_at(b"m", 1), Some(Val::Map(vec![(1, 5)])));
        assert_eq!(m.get(b"m"), Some(Val::Map(vec![(1, 5), (2, 6)])));
        assert_eq!(m.get_at(b"b", 1), None);
        assert_eq!(
            m.page_at(b"a", b"z", 10, 1)
                .into_iter()
                .map(|(k, _)| k)
                .collect::<Vec<_>>(),
            vec![b"a".to_vec(), b"m".to_vec()]
        );
        // Once no snapshot reads them, the older values go at the next insert of their key.
        m.insert(b"a", Val::Add(1000), 4, &Readers(&[]));
        assert!(m.map.get(&b"a"[..]).unwrap().older.is_empty());
        assert_eq!(m.get(b"a"), Some(Val::Add(1111)));
    }
}
