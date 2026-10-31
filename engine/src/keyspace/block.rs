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
    pub fn len(&self) -> usize {
        self.n
    }

    pub fn is_empty(&self) -> bool {
        self.n == 0
    }

    pub fn size(&self) -> usize {
        self.buf.len() + self.restarts.len() * 4 + TAIL
    }

    pub fn last_key(&self) -> &[u8] {
        &self.last
    }

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

    fn decode(&self, at: usize, key: &mut Vec<u8>) -> Result<(usize, usize), String> {
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
        let val_at = p;
        let tag = get_uvarint(buf, &mut p).map_err(|_| bad())?;
        let len = usize::try_from(tag >> 3).map_err(|_| bad())?;
        p = p
            .checked_add(len)
            .filter(|&e| e <= buf.len())
            .ok_or_else(bad)?;
        Ok((val_at, p))
    }

    pub fn seek_at_least(&self, target: &[u8], key: &mut Vec<u8>) -> Result<Option<usize>, String> {
        let (mut lo, mut hi) = (0, self.restarts);
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if self.restart_key(mid)? <= target {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let mut at = if self.restarts == 0 {
            self.entries_end
        } else {
            self.restart(lo)
        };
        key.clear();
        while at < self.entries_end {
            let (val_at, next) = self.decode(at, key)?;
            if key.as_slice() >= target {
                return Ok(Some(val_at));
            }
            at = next;
        }
        Ok(None)
    }

    pub fn value(&self, at: usize) -> Result<Val, String> {
        let mut p = at;
        Val::decode(&self.bytes[..self.entries_end], &mut p)
            .ok_or_else(|| "a value doesn't decode".to_string())
    }

    fn restart_key(&self, i: usize) -> Result<&[u8], String> {
        let buf = &self.bytes[..self.entries_end];
        let mut p = self.restart(i);
        let bad = || "entry doesn't decode".to_string();
        if get_uvarint(buf, &mut p).map_err(|_| bad())? != 0 {
            return Err(bad());
        }
        let unshared = get_uvarint(buf, &mut p).map_err(|_| bad())? as usize;
        buf.get(p..p.checked_add(unshared).ok_or_else(bad)?)
            .ok_or_else(bad)
    }

    pub fn put_bytes(&self, at: usize) -> Option<&[u8]> {
        let buf = &self.bytes[..self.entries_end];
        let mut p = at;
        let tag = get_uvarint(buf, &mut p).ok()?;
        if tag & 7 != 0 {
            return None;
        }
        let len = usize::try_from(tag >> 3).ok()?;
        buf.get(p..p.checked_add(len)?)
    }

    fn last_restart_below(&self, target: &[u8]) -> Result<Option<usize>, String> {
        let (mut lo, mut hi) = (0, self.restarts);
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.restart_key(mid)? < target {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        Ok(lo.checked_sub(1))
    }

    fn segment(&self, i: usize) -> Result<Vec<(Vec<u8>, usize)>, String> {
        let end = if i + 1 < self.restarts {
            self.restart(i + 1)
        } else {
            self.entries_end
        };
        let mut out: Vec<(Vec<u8>, usize)> = Vec::with_capacity(RESTART);
        let mut key = Vec::new();
        let mut at = self.restart(i);
        while at < end {
            let (val_at, next) = self.decode(at, &mut key)?;
            out.push((key.clone(), val_at));
            at = next;
        }
        Ok(out)
    }
}

pub struct RevCursor {
    block: Arc<Block>,
    seg: usize,
    entries: Vec<(Vec<u8>, usize)>,
    at: usize,
    pub valid: bool,
}

impl RevCursor {
    fn at_segment(block: Arc<Block>, seg: Option<usize>) -> Result<RevCursor, String> {
        let mut c = RevCursor {
            block,
            seg: 0,
            entries: Vec::new(),
            at: 0,
            valid: false,
        };
        if let Some(seg) = seg {
            c.entries = c.block.segment(seg)?;
            c.seg = seg;
            c.valid = !c.entries.is_empty();
        }
        Ok(c)
    }

    pub fn last(block: Arc<Block>) -> Result<RevCursor, String> {
        let seg = block.restarts.checked_sub(1);
        let mut c = RevCursor::at_segment(block, seg)?;
        c.at = c.entries.len().saturating_sub(1);
        Ok(c)
    }

    pub fn before(block: Arc<Block>, target: &[u8]) -> Result<RevCursor, String> {
        let seg = block.last_restart_below(target)?;
        let mut c = RevCursor::at_segment(block, seg)?;
        let n = c.entries.partition_point(|(k, _)| k.as_slice() < target);
        c.at = n.saturating_sub(1);
        c.valid &= n > 0;
        Ok(c)
    }

    pub fn covering(block: Arc<Block>, target: &[u8]) -> Result<RevCursor, String> {
        if block.restarts == 0 {
            return RevCursor::at_segment(block, None);
        }
        let seg = block.last_restart_below(target)?.unwrap_or(0);
        let mut c = RevCursor::at_segment(block, Some(seg))?;
        let n = c.entries.partition_point(|(k, _)| k.as_slice() < target);
        if n < c.entries.len() {
            c.at = n;
        } else if seg + 1 < c.block.restarts {
            let block = c.block.clone();
            c = RevCursor::at_segment(block, Some(seg + 1))?;
        } else {
            c.at = c.entries.len() - 1;
        }
        Ok(c)
    }

    pub fn key(&self) -> &[u8] {
        &self.entries[self.at].0
    }

    pub fn val(&self) -> Result<Val, String> {
        self.block.value(self.entries[self.at].1)
    }

    pub fn put_bytes(&self) -> Option<&[u8]> {
        self.block.put_bytes(self.entries[self.at].1)
    }

    pub fn prev(&mut self) -> Result<(), String> {
        if !self.valid {
            return Ok(());
        }
        if self.at > 0 {
            self.at -= 1;
        } else if self.seg > 0 {
            self.seg -= 1;
            self.entries = self.block.segment(self.seg)?;
            self.at = self.entries.len().saturating_sub(1);
            self.valid = !self.entries.is_empty();
        } else {
            self.valid = false;
        }
        Ok(())
    }
}

pub struct Cursor {
    block: Arc<Block>,
    next: usize,
    pub key: Vec<u8>,
    val_at: usize,
    pub valid: bool,
}

impl Cursor {
    pub fn first(block: Arc<Block>) -> Result<Cursor, String> {
        let mut c = Cursor {
            block,
            next: 0,
            key: Vec::new(),
            val_at: 0,
            valid: false,
        };
        c.advance()?;
        Ok(c)
    }

    pub fn val(&self) -> Result<Val, String> {
        self.block.value(self.val_at)
    }

    pub fn put_bytes(&self) -> Option<&[u8]> {
        self.block.put_bytes(self.val_at)
    }

    pub fn seek(block: Arc<Block>, target: &[u8]) -> Result<Cursor, String> {
        let (mut lo, mut hi) = (0, block.restarts);
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if block.restart_key(mid)? <= target {
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
            val_at: 0,
            valid: false,
        };
        c.advance()?;
        while c.valid && c.key.as_slice() < target {
            c.advance()?;
        }
        Ok(c)
    }

    pub fn reseek(&mut self, target: &[u8]) -> Result<(), String> {
        *self = Cursor::seek(self.block.clone(), target)?;
        Ok(())
    }

    pub fn advance(&mut self) -> Result<(), String> {
        if self.next >= self.block.entries_end {
            self.valid = false;
            return Ok(());
        }
        let (val_at, next) = self.block.decode(self.next, &mut self.key)?;
        (self.val_at, self.next, self.valid) = (val_at, next, true);
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
            assert_eq!(c.val().unwrap(), Val::Put(i.to_le_bytes().to_vec()));
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
    fn reverse_cursors_find_every_key_and_every_gap() {
        let mut b = BlockBuilder::default();
        for i in 0..100 {
            b.add(&key(i), &Val::Put(i.to_le_bytes().to_vec()));
        }
        let block = Arc::new(Block::parse(b.finish(KIND_DATA)).unwrap());
        for i in 0..100 {
            let c = RevCursor::before(block.clone(), &key(i)).unwrap();
            if i == 0 {
                assert!(!c.valid);
            } else {
                assert!(c.valid && c.key() == key(i - 1));
                assert_eq!(c.val().unwrap(), Val::Put((i - 1).to_le_bytes().to_vec()));
            }
            let c = RevCursor::covering(block.clone(), &key(i)).unwrap();
            assert!(c.valid && c.key() == key(i));
            let mut gap = key(i);
            *gap.last_mut().unwrap() -= 1;
            let c = RevCursor::covering(block.clone(), &gap).unwrap();
            assert!(c.valid && c.key() == key(i));
            let c = RevCursor::before(block.clone(), &gap).unwrap();
            assert_eq!(c.valid, i > 0);
        }
        assert!(RevCursor::covering(block.clone(), b"zz").unwrap().key() == key(99));
        assert!(RevCursor::before(block.clone(), b"zz").unwrap().key() == key(99));
        let mut c = RevCursor::last(block).unwrap();
        let mut n = 100;
        while c.valid {
            n -= 1;
            assert_eq!(c.key(), key(n));
            c.prev().unwrap();
        }
        assert_eq!(n, 0);
        let empty = Arc::new(Block::parse(BlockBuilder::default().finish(KIND_DATA)).unwrap());
        assert!(!RevCursor::last(empty.clone()).unwrap().valid);
        assert!(!RevCursor::before(empty.clone(), b"a").unwrap().valid);
        assert!(!RevCursor::covering(empty, b"a").unwrap().valid);
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
