//! A run's blocks: sorted entries with their keys prefix-compressed against the entry before, a full key every
//! `RESTART` entries so a lookup can binary-search, and a checksum.
//!
//! Layout: entries, each `shared varint, unshared varint, unshared key bytes, value (Val::encode)`; then the
//! restart offsets (u32 LE each), their count (u32 LE), the block kind (u8) and a CRC-32C of everything
//! before it (u32 LE).

use std::sync::Arc;

use super::val::Val;
use crate::log::format::{get_uvarint, put_uvarint};

pub const RESTART: usize = 16;
pub const KIND_DATA: u8 = 0;
pub const KIND_INDEX: u8 = 1;
const TAIL: usize = 4 + 1 + 4;

#[derive(Default)]
pub struct BlockBuilder {
    buf: Vec<u8>,
    restarts: Vec<u32>,
    last: Vec<u8>,
    n: usize,
}

impl BlockBuilder {
    pub fn is_empty(&self) -> bool {
        self.n == 0
    }

    /// The block's size if it were finished now.
    pub fn size(&self) -> usize {
        self.buf.len() + self.restarts.len() * 4 + TAIL
    }

    pub fn last_key(&self) -> &[u8] {
        &self.last
    }

    /// Adds an entry; keys must come in increasing order.
    pub fn add(&mut self, key: &[u8], val: &Val) {
        debug_assert!(self.n == 0 || key > self.last.as_slice());
        let shared = if self.n.is_multiple_of(RESTART) {
            self.restarts.push(self.buf.len() as u32);
            0
        } else {
            key.iter()
                .zip(&self.last)
                .take_while(|(a, b)| a == b)
                .count()
        };
        put_uvarint(&mut self.buf, shared as u64);
        put_uvarint(&mut self.buf, (key.len() - shared) as u64);
        self.buf.extend_from_slice(&key[shared..]);
        val.encode(&mut self.buf);
        self.last.clear();
        self.last.extend_from_slice(key);
        self.n += 1;
    }

    /// The finished block's bytes; the builder is empty again (its last key kept).
    pub fn finish(&mut self, kind: u8) -> Vec<u8> {
        let mut out = std::mem::take(&mut self.buf);
        for r in self.restarts.drain(..) {
            out.extend_from_slice(&r.to_le_bytes());
        }
        out.extend_from_slice(&(self.n.div_ceil(RESTART) as u32).to_le_bytes());
        out.push(kind);
        let crc = crc32c::crc32c(&out);
        out.extend_from_slice(&crc.to_le_bytes());
        self.n = 0;
        out
    }
}

/// A checked block.
pub struct Block {
    bytes: Vec<u8>,
    entries_end: usize,
    restarts: usize,
    pub kind: u8,
}

impl Block {
    pub fn parse(bytes: Vec<u8>) -> Result<Block, String> {
        let len = bytes.len();
        if len < TAIL {
            return Err("block shorter than its tail".into());
        }
        let crc = u32::from_le_bytes(bytes[len - 4..].try_into().unwrap());
        if crc32c::crc32c(&bytes[..len - 4]) != crc {
            return Err("block checksum doesn't hold".into());
        }
        let kind = bytes[len - 5];
        let restarts = u32::from_le_bytes(bytes[len - 9..len - 5].try_into().unwrap()) as usize;
        let entries_end = (len - TAIL)
            .checked_sub(restarts.checked_mul(4).ok_or("restart count overflows")?)
            .ok_or("restart count larger than the block")?;
        let block = Block {
            bytes,
            entries_end,
            restarts,
            kind,
        };
        for i in 0..restarts {
            if block.restart(i) >= entries_end {
                return Err("restart offset outside the entries".into());
            }
        }
        Ok(block)
    }

    pub fn size(&self) -> usize {
        self.bytes.len()
    }

    fn restart(&self, i: usize) -> usize {
        let at = self.entries_end + i * 4;
        u32::from_le_bytes(self.bytes[at..at + 4].try_into().unwrap()) as usize
    }

    /// Decodes the entry at `at`, whose key shares a prefix with `key` (the entry before it), into `key`.
    /// Returns the value and where the next entry starts.
    fn decode(&self, at: usize, key: &mut Vec<u8>) -> Result<(Val, usize), String> {
        let buf = &self.bytes[..self.entries_end];
        let mut p = at;
        let bad = || "entry doesn't decode".to_string();
        let shared = get_uvarint(buf, &mut p).map_err(|_| bad())? as usize;
        let unshared = get_uvarint(buf, &mut p).map_err(|_| bad())? as usize;
        if shared > key.len() {
            return Err(bad());
        }
        let suffix = buf
            .get(p..p.checked_add(unshared).ok_or_else(bad)?)
            .ok_or_else(bad)?;
        key.truncate(shared);
        key.extend_from_slice(suffix);
        p += unshared;
        let val = Val::decode(buf, &mut p).ok_or_else(bad)?;
        Ok((val, p))
    }

    fn restart_key(&self, i: usize) -> Result<Vec<u8>, String> {
        let mut key = Vec::new();
        self.decode(self.restart(i), &mut key)?;
        Ok(key)
    }
}

/// A position in a block: the current entry, or past the end.
pub struct Cursor {
    block: Arc<Block>,
    next: usize,
    pub key: Vec<u8>,
    pub val: Val,
    pub valid: bool,
}

impl Cursor {
    pub fn first(block: Arc<Block>) -> Result<Cursor, String> {
        let mut c = Cursor {
            block,
            next: 0,
            key: Vec::new(),
            val: Val::Del,
            valid: false,
        };
        c.advance()?;
        Ok(c)
    }

    /// At the first entry whose key is at least `target`.
    pub fn seek(block: Arc<Block>, target: &[u8]) -> Result<Cursor, String> {
        // The last restart whose key is at most the target.
        let (mut lo, mut hi) = (0, block.restarts);
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if block.restart_key(mid)?.as_slice() <= target {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let start = if block.restarts == 0 {
            block.entries_end
        } else {
            block.restart(lo)
        };
        let mut c = Cursor {
            block,
            next: start,
            key: Vec::new(),
            val: Val::Del,
            valid: false,
        };
        c.advance()?;
        while c.valid && c.key.as_slice() < target {
            c.advance()?;
        }
        Ok(c)
    }

    pub fn advance(&mut self) -> Result<(), String> {
        if self.next >= self.block.entries_end {
            self.valid = false;
            return Ok(());
        }
        let (val, next) = self.block.decode(self.next, &mut self.key)?;
        (self.val, self.next, self.valid) = (val, next, true);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(i: u32) -> Vec<u8> {
        format!("key{:06}", i * 2).into_bytes()
    }

    #[test]
    fn seek_finds_every_key_and_every_gap() {
        let mut b = BlockBuilder::default();
        for i in 0..100 {
            b.add(&key(i), &Val::Put(i.to_le_bytes().to_vec()));
        }
        let block = Arc::new(Block::parse(b.finish(KIND_DATA)).unwrap());
        assert_eq!(block.kind, KIND_DATA);
        for i in 0..100 {
            let c = Cursor::seek(block.clone(), &key(i)).unwrap();
            assert!(c.valid && c.key == key(i));
            assert_eq!(c.val, Val::Put(i.to_le_bytes().to_vec()));
            // Between key(i - 1) and key(i).
            let mut gap = key(i);
            *gap.last_mut().unwrap() -= 1;
            let c = Cursor::seek(block.clone(), &gap).unwrap();
            assert!(c.valid && c.key == key(i));
        }
        assert!(!Cursor::seek(block.clone(), b"zz").unwrap().valid);
        let mut c = Cursor::first(block).unwrap();
        let mut n = 0;
        while c.valid {
            assert_eq!(c.key, key(n));
            n += 1;
            c.advance().unwrap();
        }
        assert_eq!(n, 100);
    }

    #[test]
    fn a_damaged_block_is_refused() {
        let mut b = BlockBuilder::default();
        b.add(b"a", &Val::Del);
        let bytes = b.finish(KIND_INDEX);
        for i in 0..bytes.len() {
            let mut d = bytes.clone();
            d[i] ^= 1;
            assert!(Block::parse(d).is_err(), "byte {i}");
        }
        let empty = Block::parse(BlockBuilder::default().finish(KIND_INDEX)).unwrap();
        assert!(!Cursor::first(Arc::new(empty)).unwrap().valid);
    }
}
