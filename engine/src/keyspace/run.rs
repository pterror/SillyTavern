use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use super::block::{Block, BlockBuilder, Cursor, KIND_DATA, KIND_INDEX, RevCursor};
use super::cache::Cache;
use super::val::Val;
use super::{KsError, KsResult};
use crate::log::format::{get_uvarint, put_uvarint};

const MAGIC: &[u8; 8] = b"st-run\0\x01";
const MAGIC_KINDS: &[u8; 8] = b"st-run\0\x02";
const FOOTER: usize = 64;
const KINDS_BYTES: usize = 36;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Kinds([u64; 4]);

impl Kinds {
    pub const ALL: Kinds = Kinds([u64::MAX; 4]);
    pub const NONE: Kinds = Kinds([0; 4]);

    fn bit(key: &[u8]) -> Option<usize> {
        let n = usize::from(*key.first()?);
        let b = key.get(1..1 + n).filter(|_| n <= 8)?;
        let v = b.iter().fold(0u64, |v, &x| v << 8 | u64::from(x));
        Some(v.min(255) as usize)
    }

    fn add(&mut self, key: &[u8]) {
        match Kinds::bit(key) {
            Some(b) => self.0[b / 64] |= 1 << (b % 64),
            None => *self = Kinds::ALL,
        }
    }

    fn union(&mut self, other: Kinds) {
        for (a, b) in self.0.iter_mut().zip(other.0) {
            *a |= b;
        }
    }

    fn may_hold(&self, from: &[u8], to: &[u8]) -> bool {
        let (Some(a), Some(b)) = (Kinds::bit(from), Kinds::bit(to)) else {
            return true;
        };
        (a..=b.max(a)).any(|k| self.0[k / 64] >> (k % 64) & 1 == 1)
    }

    fn bytes(&self) -> Vec<u8> {
        let mut out: Vec<u8> = self.0.iter().flat_map(|x| x.to_le_bytes()).collect();
        let crc = crc32c::crc32c(&out);
        out.extend_from_slice(&crc.to_le_bytes());
        out
    }

    fn parse(b: &[u8]) -> Option<Kinds> {
        let (set, crc) = b.split_at(32);
        if crc32c::crc32c(set).to_le_bytes() != crc {
            return None;
        }
        let mut k = Kinds::NONE;
        for (i, w) in set.chunks(8).enumerate() {
            k.0[i] = u64::from_le_bytes(w.try_into().unwrap());
        }
        Some(k)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Handle {
    pub offset: u64,
    pub len: u64,
}

impl Handle {
    fn val(self) -> Val {
        let mut b = Vec::new();
        put_uvarint(&mut b, self.offset);
        put_uvarint(&mut b, self.len);
        Val::Put(b)
    }

    fn from_bytes(b: &[u8]) -> Option<Handle> {
        let mut at = 0;
        let offset = get_uvarint(b, &mut at).ok()?;
        let len = get_uvarint(b, &mut at).ok()?;
        (at == b.len()).then_some(Handle { offset, len })
    }
}

pub fn run_name(lo: u64, hi: u64) -> String {
    format!("run-{lo:016x}-{hi:016x}.run")
}

pub fn parse_run_name(name: &str) -> Option<(u64, u64)> {
    let mid = name.strip_prefix("run-")?.strip_suffix(".run")?;
    let (lo, hi) = mid.split_once('-')?;
    let (lo, hi) = (
        u64::from_str_radix(lo, 16).ok()?,
        u64::from_str_radix(hi, 16).ok()?,
    );
    (lo <= hi && run_name(lo, hi) == name).then_some((lo, hi))
}

enum RunFile {
    #[cfg(not(target_family = "wasm"))]
    File(File),
    #[cfg(target_family = "wasm")]
    Path(PathBuf),
    Memory(Memory),
}

struct Memory {
    bytes: RwLock<Option<Box<[u8]>>>,
    file: OnceLock<Box<RunFile>>,
    len: u64,
}

#[cfg(target_family = "wasm")]
thread_local! {
    static HANDLES: std::cell::RefCell<Vec<(PathBuf, std::rc::Rc<File>)>> = const { std::cell::RefCell::new(Vec::new()) };
}

impl RunFile {
    fn open(path: &Path) -> io::Result<RunFile> {
        #[cfg(not(target_family = "wasm"))]
        return Ok(RunFile::File(File::open(path)?));
        #[cfg(target_family = "wasm")]
        {
            File::open(path)?;
            Ok(RunFile::Path(path.to_path_buf()))
        }
    }

    fn len(&self, path: &Path) -> io::Result<u64> {
        match self {
            RunFile::Memory(m) => Ok(m.len),
            _ => Ok(fs::metadata(path)?.len()),
        }
    }

    fn read_exact_at(&self, buf: &mut [u8], offset: u64) -> io::Result<()> {
        match self {
            #[cfg(not(target_family = "wasm"))]
            RunFile::File(file) => read_exact_at(file, buf, offset),
            #[cfg(target_family = "wasm")]
            RunFile::Path(path) => {
                let file = HANDLES.with(|h| -> io::Result<std::rc::Rc<File>> {
                    let mut h = h.borrow_mut();
                    if let Some(i) = h.iter().position(|(p, _)| p == path) {
                        let e = h.remove(i);
                        h.push(e);
                    } else {
                        if h.len() == 16 {
                            h.remove(0);
                        }
                        h.push((path.clone(), std::rc::Rc::new(File::open(path)?)));
                    }
                    Ok(h.last().unwrap().1.clone())
                })?;
                read_exact_at(&file, buf, offset)
            }
            RunFile::Memory(m) => {
                if let Some(f) = m.file.get() {
                    return f.read_exact_at(buf, offset);
                }
                let held = m.bytes.read().unwrap_or_else(|e| e.into_inner());
                let Some(b) = held.as_ref() else {
                    drop(held);
                    let f = m
                        .file
                        .get()
                        .expect("a run's bytes leave memory once its file is written");
                    return f.read_exact_at(buf, offset);
                };
                let from = usize::try_from(offset).unwrap_or(usize::MAX);
                let bytes = from
                    .checked_add(buf.len())
                    .and_then(|to| b.get(from..to))
                    .ok_or_else(|| io::Error::from(io::ErrorKind::UnexpectedEof))?;
                buf.copy_from_slice(bytes);
                Ok(())
            }
        }
    }

    #[cfg(target_family = "wasm")]
    fn forget(&self) {
        match self {
            RunFile::Path(path) => HANDLES.with(|h| h.borrow_mut().retain(|(p, _)| p != path)),
            RunFile::Memory(m) => {
                if let Some(f) = m.file.get() {
                    f.forget();
                }
            }
        }
    }

    fn on_disk(&self) -> bool {
        match self {
            RunFile::Memory(m) => m.file.get().is_some(),
            _ => true,
        }
    }
}

fn read_exact_at(file: &File, mut buf: &mut [u8], mut offset: u64) -> io::Result<()> {
    while !buf.is_empty() {
        #[cfg(unix)]
        let n = std::os::unix::fs::FileExt::read_at(file, buf, offset)?;
        #[cfg(windows)]
        let n = std::os::windows::fs::FileExt::seek_read(file, buf, offset)?;
        #[cfg(not(any(unix, windows)))]
        let n = {
            use std::io::{Read, Seek, SeekFrom};
            let mut f = file;
            f.seek(SeekFrom::Start(offset))?;
            f.read(buf)?
        };
        if n == 0 {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
        }
        buf = &mut buf[n..];
        offset += n as u64;
    }
    Ok(())
}

static NEXT_UID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct ReadCounts {
    pub blocks: AtomicU64,
    pub file_reads: AtomicU64,
}

const ESTIMATE_SAMPLES: u64 = 4;

#[derive(Debug, Default, Clone, Copy)]
struct Split {
    before: f64,
    entries: f64,
}

pub struct Run {
    pub uid: u64,
    pub path: PathBuf,
    file: RunFile,
    pub lo: u64,
    pub hi: u64,
    pub covered: u64,
    pub entries: u64,
    pub bytes: u64,
    levels: u32,
    pub dels: u64,
    top: Arc<Block>,
    pub max_key: Vec<u8>,
    pub kinds: Kinds,
    pub obsolete: AtomicBool,
}

impl Drop for Run {
    fn drop(&mut self) {
        if self.file.on_disk() && self.obsolete.load(Ordering::Acquire) {
            #[cfg(target_family = "wasm")]
            self.file.forget();
            let _ = crate::faults::op(crate::faults::Op::Remove, &self.path)
                .and_then(|()| fs::remove_file(&self.path));
        }
    }
}

impl Run {
    pub fn open(path: &Path, lo: u64, hi: u64) -> KsResult<Run> {
        Run::read(path, RunFile::open(path)?, lo, hi)
    }

    pub fn in_memory(path: &Path, bytes: Vec<u8>, lo: u64, hi: u64) -> KsResult<Run> {
        let len = bytes.len() as u64;
        let m = Memory {
            bytes: RwLock::new(Some(bytes.into_boxed_slice())),
            file: OnceLock::new(),
            len,
        };
        Run::read(path, RunFile::Memory(m), lo, hi)
    }

    pub fn in_memory_now(&self) -> bool {
        matches!(&self.file, RunFile::Memory(m) if m.file.get().is_none())
    }

    pub fn write_out(&self) -> KsResult<u64> {
        let RunFile::Memory(m) = &self.file else {
            return Ok(0);
        };
        if m.file.get().is_some() {
            return Ok(0);
        }
        {
            let held = m.bytes.read().unwrap_or_else(|e| e.into_inner());
            let Some(b) = held.as_ref() else {
                return Ok(0);
            };
            let mut f = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&self.path)?;
            if let Some(n) = crate::faults::write(&self.path, 0, b.len())? {
                f.write_all(&b[..n])?;
                return Err(crate::faults::torn().into());
            }
            f.write_all(b)?;
            crate::faults::op(crate::faults::Op::Sync, &self.path)?;
            f.sync_data()?;
        }
        let _ = m.file.set(Box::new(RunFile::open(&self.path)?));
        *m.bytes.write().unwrap_or_else(|e| e.into_inner()) = None;
        Ok(m.len)
    }

    fn read(path: &Path, file: RunFile, lo: u64, hi: u64) -> KsResult<Run> {
        let corrupt = |why: String| KsError::Corrupt {
            file: path.display().to_string(),
            why,
        };
        let bytes = file.len(path)?;
        if bytes < FOOTER as u64 {
            return Err(corrupt("shorter than a footer".into()));
        }
        let mut f = [0u8; FOOTER];
        file.read_exact_at(&mut f, bytes - FOOTER as u64)?;
        let u64_at = |i: usize| u64::from_le_bytes(f[i..i + 8].try_into().unwrap());
        let u32_at = |i: usize| u32::from_le_bytes(f[i..i + 4].try_into().unwrap());
        if (&f[..8] != MAGIC && &f[..8] != MAGIC_KINDS) || crc32c::crc32c(&f[..56]) != u32_at(56) {
            return Err(corrupt("footer doesn't check out".into()));
        }
        let (kinds, blocks_end) = if &f[..8] == MAGIC_KINDS {
            if bytes < (FOOTER + KINDS_BYTES) as u64 {
                return Err(corrupt("shorter than a footer and its kinds".into()));
            }
            let mut k = [0u8; KINDS_BYTES];
            let at = bytes - (FOOTER + KINDS_BYTES) as u64;
            file.read_exact_at(&mut k, at)?;
            let kinds = Kinds::parse(&k).ok_or_else(|| corrupt("its kinds don't check out".into()))?;
            (kinds, at)
        } else {
            (Kinds::ALL, bytes - FOOTER as u64)
        };
        let top = Handle {
            offset: u64_at(8),
            len: u64::from(u32_at(16)),
        };
        let (levels, entries, covered) = (u32_at(20), u64_at(24), u64_at(32));
        let dels = u64::from(u32_at(60));
        if (u64_at(40), u64_at(48)) != (lo, hi) {
            return Err(corrupt("footer holds other flushes than its name".into()));
        }
        if levels == 0 || top.offset + top.len > blocks_end {
            return Err(corrupt("top block outside the file".into()));
        }
        let mut buf = vec![0; top.len as usize];
        file.read_exact_at(&mut buf, top.offset)?;
        let top = Arc::new(Block::parse(buf).map_err(corrupt)?);
        if top.kind != KIND_INDEX {
            return Err(corrupt("top block isn't an index block".into()));
        }
        let mut max_key = Vec::new();
        let mut c = Cursor::first(top.clone()).map_err(corrupt)?;
        while c.valid {
            max_key.clone_from(&c.key);
            c.advance().map_err(corrupt)?;
        }
        Ok(Run {
            uid: NEXT_UID.fetch_add(1, Ordering::Relaxed),
            path: path.to_path_buf(),
            file,
            lo,
            hi,
            covered,
            entries,
            bytes,
            levels,
            dels,
            top,
            max_key,
            kinds,
            obsolete: AtomicBool::new(false),
        })
    }

    pub fn may_hold(&self, from: &[u8], to: &[u8]) -> bool {
        self.kinds.may_hold(from, to)
    }

    pub fn top_size(&self) -> usize {
        self.top.size()
    }

    fn corrupt(&self, why: String) -> KsError {
        KsError::Corrupt {
            file: self.path.display().to_string(),
            why,
        }
    }

    fn read_block(
        &self,
        h: Handle,
        kind: u8,
        cache: Option<&Cache>,
        counts: Option<&ReadCounts>,
    ) -> KsResult<Arc<Block>> {
        if let Some(c) = counts {
            c.blocks.fetch_add(1, Ordering::Relaxed);
        }
        let key = (self.uid, h.offset);
        if let Some(b) = cache.and_then(|c| c.get(key)) {
            return Ok(b);
        }
        if let Some(c) = counts {
            c.file_reads.fetch_add(1, Ordering::Relaxed);
        }
        if h.offset + h.len > self.bytes {
            return Err(self.corrupt(format!("block at {} outside the file", h.offset)));
        }
        let mut buf = vec![0; h.len as usize];
        self.file.read_exact_at(&mut buf, h.offset)?;
        let block =
            Block::parse(buf).map_err(|e| self.corrupt(format!("block at {}: {e}", h.offset)))?;
        if block.kind != kind {
            return Err(self.corrupt(format!("block at {} has the wrong kind", h.offset)));
        }
        let block = Arc::new(block);
        if let Some(c) = cache {
            c.insert(key, block.clone());
        }
        Ok(block)
    }

    fn child(&self, c: &Cursor) -> KsResult<Handle> {
        c.put_bytes()
            .and_then(Handle::from_bytes)
            .ok_or_else(|| self.corrupt("index entry isn't a handle".into()))
    }

    pub fn data_blocks(&self) -> KsResult<Vec<(Vec<u8>, Handle)>> {
        let mut level: Vec<(Vec<u8>, Handle)> = Vec::new();
        let mut c = Cursor::first(self.top.clone()).map_err(|e| self.corrupt(e))?;
        while c.valid {
            level.push((c.key.clone(), self.child(&c)?));
            c.advance().map_err(|e| self.corrupt(e))?;
        }
        for _ in 1..self.levels {
            let mut below = Vec::new();
            for (_, h) in &level {
                let b = self.read_block(*h, KIND_INDEX, None, None)?;
                let mut c = Cursor::first(b).map_err(|e| self.corrupt(e))?;
                while c.valid {
                    below.push((c.key.clone(), self.child(&c)?));
                    c.advance().map_err(|e| self.corrupt(e))?;
                }
            }
            level = below;
        }
        Ok(level)
    }

    fn children(&self, b: Arc<Block>) -> KsResult<Vec<(Vec<u8>, Handle)>> {
        let mut out = Vec::new();
        let mut c = Cursor::first(b).map_err(|e| self.corrupt(e))?;
        while c.valid {
            out.push((c.key.clone(), self.child(&c)?));
            c.advance().map_err(|e| self.corrupt(e))?;
        }
        Ok(out)
    }

    fn data_block_at(
        &self,
        key: &[u8],
        cache: &Cache,
        counts: &ReadCounts,
    ) -> KsResult<Option<(Handle, Split)>> {
        if key > self.max_key.as_slice() {
            return Ok(None);
        }
        let mut block = self.top.clone();
        for level in (0..self.levels).rev() {
            let c = Cursor::seek(block, key).map_err(|e| self.corrupt(e))?;
            if !c.valid {
                return Ok(None);
            }
            let h = self.child(&c)?;
            let kind = if level == 0 { KIND_DATA } else { KIND_INDEX };
            block = self.read_block(h, kind, Some(cache), Some(counts))?;
            if level == 0 {
                let mut c = Cursor::first(block).map_err(|e| self.corrupt(e))?;
                let mut s = Split::default();
                while c.valid {
                    s.entries += 1.0;
                    if c.key.as_slice() < key {
                        s.before += 1.0;
                    }
                    c.advance().map_err(|e| self.corrupt(e))?;
                }
                return Ok(Some((h, s)));
            }
        }
        Ok(None)
    }

    fn data_block_holding(
        &self,
        at: u64,
        cache: &Cache,
        counts: &ReadCounts,
    ) -> KsResult<(f64, f64)> {
        let mut block = self.top.clone();
        for level in (0..self.levels).rev() {
            let ks = self.children(block)?;
            let i = if level == 0 {
                ks.partition_point(|(_, h)| h.offset <= at)
                    .saturating_sub(1)
            } else {
                ks.partition_point(|(_, h)| h.offset < at)
                    .min(ks.len().saturating_sub(1))
            };
            let Some(&(_, h)) = ks.get(i) else {
                return Ok((0.0, 0.0));
            };
            let kind = if level == 0 { KIND_DATA } else { KIND_INDEX };
            block = self.read_block(h, kind, Some(cache), Some(counts))?;
            if level == 0 {
                let mut c = Cursor::first(block).map_err(|e| self.corrupt(e))?;
                let mut n = 0.0;
                while c.valid {
                    n += 1.0;
                    c.advance().map_err(|e| self.corrupt(e))?;
                }
                return Ok((n, h.len as f64));
            }
        }
        Ok((0.0, 0.0))
    }

    pub fn estimate(
        &self,
        lo: &[u8],
        hi: &[u8],
        cache: &Cache,
        counts: &ReadCounts,
    ) -> KsResult<f64> {
        if lo >= hi || lo > self.max_key.as_slice() {
            return Ok(0.0);
        }
        let Some((first, f)) = self.data_block_at(lo, cache, counts)? else {
            return Ok(0.0);
        };
        let (last, l) = match self.data_block_at(hi, cache, counts)? {
            Some(b) => b,
            None => {
                let (h, mut s) = self
                    .data_block_at(&self.max_key, cache, counts)?
                    .ok_or_else(|| self.corrupt("its last key has no data block".into()))?;
                s.before = s.entries;
                (h, s)
            }
        };
        if first == last {
            return Ok(l.before - f.before);
        }
        let ends = f.entries - f.before + l.before;
        let (from, to) = (first.offset + first.len, last.offset);
        if to <= from {
            return Ok(ends);
        }
        let (mut entries, mut len) = (0.0, 0.0);
        for q in 0..ESTIMATE_SAMPLES {
            let at = from + (to - from) * (2 * q + 1) / (2 * ESTIMATE_SAMPLES);
            let (n, l) = self.data_block_holding(at, cache, counts)?;
            entries += n;
            len += l;
        }
        Ok(ends
            + if len > 0.0 {
                (to - from) as f64 * entries / len
            } else {
                0.0
            })
    }

    pub fn get_sorted(
        &self,
        keys: &[&[u8]],
        cache: &Cache,
        counts: &ReadCounts,
    ) -> KsResult<Vec<Option<Val>>> {
        let mut out = vec![None; keys.len()];
        let mut held: Option<(Arc<Block>, Vec<u8>)> = None;
        for (i, key) in keys.iter().enumerate() {
            if *key > self.max_key.as_slice() {
                break;
            }
            if !self.may_hold(key, key) {
                continue;
            }
            if held.as_ref().is_none_or(|(_, last)| *key > last.as_slice()) {
                held = None;
                let mut block = self.top.clone();
                for level in (0..self.levels).rev() {
                    let c = Cursor::seek(block, key).map_err(|e| self.corrupt(e))?;
                    if !c.valid {
                        break;
                    }
                    let kind = if level == 0 { KIND_DATA } else { KIND_INDEX };
                    let child =
                        self.read_block(self.child(&c)?, kind, Some(cache), Some(counts))?;
                    if level == 0 {
                        held = Some((child, c.key.clone()));
                        break;
                    }
                    block = child;
                }
            }
            let Some((block, _)) = &held else { continue };
            let c = Cursor::seek(block.clone(), key).map_err(|e| self.corrupt(e))?;
            if c.valid && c.key.as_slice() == *key {
                out[i] = Some(c.val().map_err(|e| self.corrupt(e))?);
            }
        }
        Ok(out)
    }

    pub fn get(&self, key: &[u8], cache: &Cache, counts: &ReadCounts) -> KsResult<Option<Val>> {
        if key > self.max_key.as_slice() || !self.may_hold(key, key) {
            return Ok(None);
        }
        SEEK_KEY.with_borrow_mut(|k| {
            let mut block = self.top.clone();
            for level in (0..self.levels).rev() {
                let Some(at) = block.seek_at_least(key, k).map_err(|e| self.corrupt(e))? else {
                    return Ok(None);
                };
                let h = block
                    .put_bytes(at)
                    .and_then(Handle::from_bytes)
                    .ok_or_else(|| self.corrupt("index entry isn't a handle".into()))?;
                let kind = if level == 0 { KIND_DATA } else { KIND_INDEX };
                block = self.read_block(h, kind, Some(cache), Some(counts))?;
            }
            match block.seek_at_least(key, k).map_err(|e| self.corrupt(e))? {
                Some(at) if k.as_slice() == key => {
                    Ok(Some(block.value(at).map_err(|e| self.corrupt(e))?))
                }
                _ => Ok(None),
            }
        })
    }
}

thread_local! {
    static SEEK_KEY: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

pub trait Source {
    fn key(&self) -> Option<&[u8]>;
    fn val(&self) -> KsResult<Val>;
    fn advance(&mut self) -> KsResult<()>;

    fn seek(&mut self, target: &[u8]) -> KsResult<()> {
        while self.key().is_some_and(|k| k < target) {
            self.advance()?;
        }
        Ok(())
    }
}

pub struct RunIter<'a> {
    run: Arc<Run>,
    cache: Option<&'a Cache>,
    counts: Option<&'a ReadCounts>,
    path: Vec<Cursor>,
}

impl<'a> RunIter<'a> {
    pub fn new(
        run: Arc<Run>,
        from: &[u8],
        cache: Option<&'a Cache>,
        counts: Option<&'a ReadCounts>,
    ) -> KsResult<RunIter<'a>> {
        let mut it = RunIter {
            path: Vec::new(),
            run,
            cache,
            counts,
        };
        let top = Cursor::seek(it.run.top.clone(), from).map_err(|e| it.run.corrupt(e))?;
        it.path.push(top);
        it.descend(Some(from))?;
        Ok(it)
    }

    fn descend(&mut self, mut from: Option<&[u8]>) -> KsResult<()> {
        loop {
            let depth = self.path.len();
            let last = self.path.last().unwrap();
            if !last.valid {
                self.path.pop();
                let Some(parent) = self.path.last_mut() else {
                    return Ok(());
                };
                parent.advance().map_err(|e| self.run.corrupt(e))?;
                from = None;
                continue;
            }
            if depth as u32 == self.run.levels + 1 {
                return Ok(());
            }
            let level = self.run.levels - depth as u32;
            let kind = if level == 0 { KIND_DATA } else { KIND_INDEX };
            let h = self.run.child(last)?;
            let block = self.run.read_block(h, kind, self.cache, self.counts)?;
            let c = match from {
                Some(k) => Cursor::seek(block, k),
                None => Cursor::first(block),
            }
            .map_err(|e| self.run.corrupt(e))?;
            self.path.push(c);
        }
    }
}

impl Source for RunIter<'_> {
    fn key(&self) -> Option<&[u8]> {
        self.path
            .last()
            .filter(|c| c.valid)
            .map(|c| c.key.as_slice())
    }

    fn val(&self) -> KsResult<Val> {
        self.path
            .last()
            .unwrap()
            .val()
            .map_err(|e| self.run.corrupt(e))
    }

    fn advance(&mut self) -> KsResult<()> {
        let Some(c) = self.path.last_mut() else {
            return Ok(());
        };
        c.advance().map_err(|e| self.run.corrupt(e))?;
        self.descend(None)
    }

    fn seek(&mut self, target: &[u8]) -> KsResult<()> {
        if self.key().is_none_or(|k| k >= target) {
            return Ok(());
        }
        let data = self.path.len() - 1;
        let keep = (0..data)
            .rev()
            .find(|&j| self.path[j].valid && self.path[j].key.as_slice() >= target);
        match keep {
            Some(j) => {
                self.path.truncate(j + 2);
                self.path[j + 1]
                    .reseek(target)
                    .map_err(|e| self.run.corrupt(e))?;
            }
            None => {
                self.path.clear();
                let top =
                    Cursor::seek(self.run.top.clone(), target).map_err(|e| self.run.corrupt(e))?;
                self.path.push(top);
            }
        }
        self.descend(Some(target))
    }
}

pub struct RunRevIter<'a> {
    run: Arc<Run>,
    cache: Option<&'a Cache>,
    counts: Option<&'a ReadCounts>,
    start: Vec<u8>,
    path: Vec<RevCursor>,
}

impl<'a> RunRevIter<'a> {
    pub fn new(
        run: Arc<Run>,
        before: &[u8],
        start: &[u8],
        cache: Option<&'a Cache>,
        counts: Option<&'a ReadCounts>,
    ) -> KsResult<RunRevIter<'a>> {
        let mut it = RunRevIter {
            path: Vec::new(),
            run,
            cache,
            counts,
            start: start.to_vec(),
        };
        let top = RevCursor::covering(it.run.top.clone(), before).map_err(|e| it.run.corrupt(e))?;
        it.path.push(top);
        it.descend(Some(before))?;
        Ok(it)
    }

    fn descend(&mut self, mut before: Option<&[u8]>) -> KsResult<()> {
        loop {
            let depth = self.path.len();
            let last = self.path.last().unwrap();
            if !last.valid {
                self.path.pop();
                let Some(parent) = self.path.last_mut() else {
                    return Ok(());
                };
                parent.prev().map_err(|e| self.run.corrupt(e))?;
                before = None;
                continue;
            }
            if last.key() < self.start.as_slice() {
                self.path.clear();
                return Ok(());
            }
            if depth as u32 == self.run.levels + 1 {
                return Ok(());
            }
            let level = self.run.levels - depth as u32;
            let kind = if level == 0 { KIND_DATA } else { KIND_INDEX };
            let h = last
                .put_bytes()
                .and_then(Handle::from_bytes)
                .ok_or_else(|| self.run.corrupt("index entry isn't a handle".into()))?;
            let block = self.run.read_block(h, kind, self.cache, self.counts)?;
            let c = match before {
                Some(b) if level == 0 => RevCursor::before(block, b),
                Some(b) => RevCursor::covering(block, b),
                None => RevCursor::last(block),
            }
            .map_err(|e| self.run.corrupt(e))?;
            self.path.push(c);
        }
    }
}

impl Source for RunRevIter<'_> {
    fn key(&self) -> Option<&[u8]> {
        if self.path.len() as u32 != self.run.levels + 1 {
            return None;
        }
        self.path.last().map(|c| c.key())
    }

    fn val(&self) -> KsResult<Val> {
        self.path
            .last()
            .unwrap()
            .val()
            .map_err(|e| self.run.corrupt(e))
    }

    fn advance(&mut self) -> KsResult<()> {
        let Some(c) = self.path.last_mut() else {
            return Ok(());
        };
        c.prev().map_err(|e| self.run.corrupt(e))?;
        self.descend(None)
    }
}

pub struct MergeRev<'a> {
    sources: Vec<Box<dyn Source + 'a>>,
    heap: BinaryHeap<(Vec<u8>, Reverse<usize>)>,
    started: bool,
}

impl<'a> MergeRev<'a> {
    pub fn new(sources: Vec<Box<dyn Source + 'a>>) -> MergeRev<'a> {
        MergeRev {
            sources,
            heap: BinaryHeap::new(),
            started: false,
        }
    }

    pub fn next_entry(&mut self) -> KsResult<Option<(Vec<u8>, Val)>> {
        if !self.started {
            self.started = true;
            for (i, s) in self.sources.iter().enumerate() {
                if let Some(k) = s.key() {
                    self.heap.push((k.to_vec(), Reverse(i)));
                }
            }
        }
        let Some((key, Reverse(first))) = self.heap.pop() else {
            return Ok(None);
        };
        let mut at = vec![first];
        while let Some((k, _)) = self.heap.peek()
            && *k == key
        {
            let (_, Reverse(i)) = self.heap.pop().unwrap();
            at.push(i);
        }
        let mut vals = Vec::with_capacity(at.len());
        for i in at {
            let s = &mut self.sources[i];
            vals.push(s.val()?);
            s.advance()?;
            if let Some(k) = s.key() {
                self.heap.push((k.to_vec(), Reverse(i)));
            }
        }
        let v = super::val::fold(&key, vals).unwrap();
        Ok(Some((key, v)))
    }
}

pub struct VecSource {
    entries: Vec<(Vec<u8>, Val)>,
    at: usize,
}

impl VecSource {
    pub fn new(entries: Vec<(Vec<u8>, Val)>) -> VecSource {
        VecSource { entries, at: 0 }
    }
}

impl Source for VecSource {
    fn key(&self) -> Option<&[u8]> {
        self.entries.get(self.at).map(|(k, _)| k.as_slice())
    }

    fn val(&self) -> KsResult<Val> {
        Ok(self.entries[self.at].1.clone())
    }

    fn advance(&mut self) -> KsResult<()> {
        self.at += 1;
        Ok(())
    }
}

pub struct Merge<'a, S: Source + ?Sized + 'a = dyn Source + 'a> {
    sources: Vec<Box<S>>,
    heap: BinaryHeap<Reverse<(Vec<u8>, usize)>>,
    started: bool,
    _life: std::marker::PhantomData<&'a ()>,
}

impl<'a, S: Source + ?Sized + 'a> Merge<'a, S> {
    pub fn new(sources: Vec<Box<S>>) -> Merge<'a, S> {
        Merge {
            sources,
            heap: BinaryHeap::new(),
            started: false,
            _life: std::marker::PhantomData,
        }
    }

    fn start(&mut self) {
        if !self.started {
            self.started = true;
            for (i, s) in self.sources.iter().enumerate() {
                if let Some(k) = s.key() {
                    self.heap.push(Reverse((k.to_vec(), i)));
                }
            }
        }
    }

    pub fn peek(&mut self) -> Option<&[u8]> {
        self.start();
        self.heap.peek().map(|Reverse((k, _))| k.as_slice())
    }

    pub fn seek(&mut self, target: &[u8]) -> KsResult<()> {
        self.start();
        while let Some(Reverse((k, _))) = self.heap.peek()
            && k.as_slice() < target
        {
            let Reverse((_, i)) = self.heap.pop().unwrap();
            let s = &mut self.sources[i];
            s.seek(target)?;
            if let Some(k) = s.key() {
                self.heap.push(Reverse((k.to_vec(), i)));
            }
        }
        Ok(())
    }

    pub fn next_entry(&mut self) -> KsResult<Option<(Vec<u8>, Val)>> {
        self.start();
        let Some(Reverse((key, first))) = self.heap.pop() else {
            return Ok(None);
        };
        let mut at = vec![first];
        while let Some(Reverse((k, _))) = self.heap.peek()
            && *k == key
        {
            let Reverse((_, i)) = self.heap.pop().unwrap();
            at.push(i);
        }
        let mut vals = Vec::with_capacity(at.len());
        for i in at {
            let s = &mut self.sources[i];
            vals.push(s.val()?);
            s.advance()?;
            if let Some(k) = s.key() {
                self.heap.push(Reverse((k.to_vec(), i)));
            }
        }
        let v = super::val::fold(&key, vals).unwrap();
        Ok(Some((key, v)))
    }
}

pub fn restamp(path: &Path, covered: u64, lo: u64, hi: u64) -> io::Result<()> {
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    let bytes = file.metadata()?.len();
    let mut f = [0u8; FOOTER];
    read_exact_at(&file, &mut f, bytes - FOOTER as u64)?;
    if &f[..8] != MAGIC && &f[..8] != MAGIC_KINDS {
        return Err(io::Error::other("not a run file"));
    }
    f[32..40].copy_from_slice(&covered.to_le_bytes());
    f[40..48].copy_from_slice(&lo.to_le_bytes());
    f[48..56].copy_from_slice(&hi.to_le_bytes());
    let crc = crc32c::crc32c(&f[..56]);
    f[56..60].copy_from_slice(&crc.to_le_bytes());
    #[cfg(unix)]
    std::os::unix::fs::FileExt::write_all_at(&file, &f, bytes - FOOTER as u64)?;
    #[cfg(not(unix))]
    {
        use std::io::{Seek, SeekFrom};
        let mut w = &file;
        w.seek(SeekFrom::Start(bytes - FOOTER as u64))?;
        w.write_all(&f)?;
    }
    file.sync_data()
}

pub struct RunWriter {
    out: RunOut,
    path: Option<PathBuf>,
    offset: u64,
    block_size: usize,
    data: BlockBuilder,
    index: Vec<(BlockBuilder, u64)>,
    entries: u64,
    dels: u64,
    kinds: Kinds,
}

#[cfg(test)]
mod writer_tests {
    use super::*;

    fn kinded(kind: u64, rest: u32) -> Vec<u8> {
        let mut k = Vec::new();
        crate::keyspace::val::put_u64(&mut k, kind);
        k.extend_from_slice(&rest.to_be_bytes());
        k
    }

    #[test]
    fn a_run_skips_reads_of_kinds_it_holds_none_of() {
        let mut writer = RunWriter::in_memory(256, 0);
        let mine: Vec<Vec<u8>> = (0..200).map(|i| kinded(32, i)).collect();
        for k in &mine {
            writer.add(k, &Val::Add(1)).unwrap();
        }
        let bytes = writer.finish_in_memory(0, 0, 0).unwrap();
        let run = Run::in_memory(Path::new("kinds.run"), bytes.clone(), 0, 0).unwrap();
        let cache = Cache::new(1 << 20);
        let counts = ReadCounts::default();
        for other in [kinded(18, 5), kinded(33, 0), kinded(300, 1)] {
            assert_eq!(run.get(&other, &cache, &counts).unwrap(), None);
        }
        assert_eq!(counts.blocks.load(Ordering::Relaxed), 0);
        assert!(!run.may_hold(&kinded(18, 0), &kinded(31, 0)));
        assert!(run.may_hold(&kinded(18, 0), &kinded(40, 0)));
        for k in &mine {
            assert_eq!(run.get(k, &cache, &counts).unwrap(), Some(Val::Add(1)));
        }
        let mut old = bytes;
        let at = old.len() - FOOTER;
        old[at..at + 8].copy_from_slice(MAGIC);
        let crc = crc32c::crc32c(&old[at..at + 56]);
        old[at + 56..at + 60].copy_from_slice(&crc.to_le_bytes());
        let run = Run::in_memory(Path::new("old.run"), old, 0, 0).unwrap();
        assert_eq!(run.kinds, Kinds::ALL);
        assert!(run.may_hold(&kinded(18, 0), &kinded(18, 0)));
        for k in &mine {
            assert_eq!(run.get(k, &cache, &counts).unwrap(), Some(Val::Add(1)));
        }
    }

    #[test]
    fn oversized_index_keys_finish_and_remain_seekable() {
        for count in [1u32, 2, 3, 17, 64] {
            let keys: Vec<_> = (0..count)
                .map(|i| {
                    let mut key = i.to_be_bytes().to_vec();
                    key.extend(vec![b'x'; 1024]);
                    key
                })
                .collect();
            let mut writer = RunWriter::in_memory(256, 0);
            for key in &keys {
                writer.add(key, &Val::Add(1)).unwrap();
                assert!(writer.index.len() <= 7);
            }
            let bytes = writer.finish_in_memory(0, 0, 0).unwrap();
            assert!(bytes.len() < (count as usize + 1) * 4096);
            let run = Arc::new(Run::in_memory(Path::new("synthetic.run"), bytes, 0, 0).unwrap());
            for key in &keys {
                let mut it = RunIter::new(run.clone(), key, None, None).unwrap();
                assert_eq!(it.key(), Some(key.as_slice()));
                it.advance().unwrap();
            }
        }
    }
}

enum RunOut {
    File(BufWriter<File>),
    Memory(Vec<u8>),
}

impl RunWriter {
    pub fn create(path: &Path, block_size: usize) -> io::Result<RunWriter> {
        let file = OpenOptions::new().write(true).create_new(true).open(path)?;
        let mut w = RunWriter::to(
            RunOut::File(BufWriter::with_capacity(1 << 20, file)),
            block_size,
        );
        w.path = Some(path.to_path_buf());
        Ok(w)
    }

    pub fn in_memory(block_size: usize, capacity: usize) -> RunWriter {
        RunWriter::to(RunOut::Memory(Vec::with_capacity(capacity)), block_size)
    }

    fn to(out: RunOut, block_size: usize) -> RunWriter {
        RunWriter {
            out,
            path: None,
            offset: 0,
            block_size,
            data: BlockBuilder::default(),
            index: Vec::new(),
            entries: 0,
            dels: 0,
            kinds: Kinds::NONE,
        }
    }

    pub fn entries(&self) -> u64 {
        self.entries
    }

    pub fn offset(&self) -> u64 {
        self.offset
    }

    fn write_block(&mut self, bytes: &[u8]) -> io::Result<Handle> {
        match &mut self.out {
            RunOut::File(out) => {
                if let Some(path) = &self.path
                    && let Some(n) = crate::faults::write(path, self.offset, bytes.len())?
                {
                    out.write_all(&bytes[..n])?;
                    return Err(crate::faults::torn());
                }
                out.write_all(bytes)?
            }
            RunOut::Memory(out) => out.extend_from_slice(bytes),
        }
        let h = Handle {
            offset: self.offset,
            len: bytes.len() as u64,
        };
        self.offset += h.len;
        Ok(h)
    }

    fn push_index(&mut self, level: usize, key: &[u8], h: Handle) -> io::Result<()> {
        if self.index.len() == level {
            self.index.push((BlockBuilder::default(), 0));
        }
        let v = h.val();
        let b = &self.index[level].0;
        if b.len() >= 2 && b.size() + key.len() + 32 > self.block_size {
            self.flush_index(level)?;
        }
        self.index[level].0.add(key, &v);
        Ok(())
    }

    fn flush_index(&mut self, level: usize) -> io::Result<()> {
        let last = self.index[level].0.last_key().to_vec();
        let bytes = self.index[level].0.finish(KIND_INDEX);
        self.index[level].1 += 1;
        let h = self.write_block(&bytes)?;
        self.push_index(level + 1, &last, h)
    }

    fn flush_data(&mut self) -> io::Result<()> {
        let last = self.data.last_key().to_vec();
        let bytes = self.data.finish(KIND_DATA);
        let h = self.write_block(&bytes)?;
        self.push_index(0, &last, h)
    }

    pub fn append_run(&mut self, run: &Run) -> KsResult<()> {
        if !self.data.is_empty() {
            self.flush_data()?;
        }
        let mut buf = Vec::new();
        for (last, h) in run.data_blocks()? {
            buf.resize(h.len as usize, 0);
            run.file.read_exact_at(&mut buf, h.offset)?;
            let at = self.write_block(&buf)?;
            self.push_index(0, &last, at)?;
        }
        self.entries += run.entries;
        self.kinds.union(run.kinds);
        Ok(())
    }

    pub fn add(&mut self, key: &[u8], val: &Val) -> io::Result<()> {
        if !self.data.is_empty()
            && self.data.size() + key.len() + val.payload_len() + 24 > self.block_size
        {
            self.flush_data()?;
        }
        self.data.add(key, val);
        self.kinds.add(key);
        self.entries += 1;
        if matches!(val, Val::Del) {
            self.dels += 1;
        }
        Ok(())
    }

    fn close(&mut self, covered: u64, lo: u64, hi: u64) -> io::Result<()> {
        if !self.data.is_empty() {
            self.flush_data()?;
        }
        if self.index.is_empty() {
            self.index.push((BlockBuilder::default(), 0));
        }
        let mut level = 0;
        while level + 1 < self.index.len() {
            if !self.index[level].0.is_empty() {
                self.flush_index(level)?;
            }
            level += 1;
        }
        let top_bytes = self.index[level].0.finish(KIND_INDEX);
        let top = self.write_block(&top_bytes)?;
        let kinds = self.kinds.bytes();
        self.write_block(&kinds)?;
        let mut f = Vec::with_capacity(FOOTER);
        f.extend_from_slice(MAGIC_KINDS);
        f.extend_from_slice(&top.offset.to_le_bytes());
        f.extend_from_slice(&(top.len as u32).to_le_bytes());
        f.extend_from_slice(&(self.index.len() as u32).to_le_bytes());
        f.extend_from_slice(&self.entries.to_le_bytes());
        f.extend_from_slice(&covered.to_le_bytes());
        f.extend_from_slice(&lo.to_le_bytes());
        f.extend_from_slice(&hi.to_le_bytes());
        let crc = crc32c::crc32c(&f);
        f.extend_from_slice(&crc.to_le_bytes());
        f.extend_from_slice(&u32::try_from(self.dels).unwrap_or(u32::MAX).to_le_bytes());
        f.resize(FOOTER, 0);
        self.write_block(&f)?;
        Ok(())
    }

    pub fn finish(mut self, covered: u64, lo: u64, hi: u64) -> io::Result<u64> {
        self.close(covered, lo, hi)?;
        match self.out {
            RunOut::File(out) => {
                let file = out.into_inner().map_err(|e| e.into_error())?;
                if let Some(path) = &self.path {
                    crate::faults::op(crate::faults::Op::Sync, path)?;
                }
                file.sync_data()?
            }
            RunOut::Memory(_) => return Err(io::Error::other("a run in memory has no file")),
        }
        Ok(self.offset)
    }

    pub fn finish_in_memory(mut self, covered: u64, lo: u64, hi: u64) -> io::Result<Vec<u8>> {
        self.close(covered, lo, hi)?;
        match self.out {
            RunOut::Memory(bytes) => Ok(bytes),
            RunOut::File(_) => Err(io::Error::other("a run written to a file isn't in memory")),
        }
    }
}
