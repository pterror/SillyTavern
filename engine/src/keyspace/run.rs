//! Runs: immutable sorted files of entries, each with its own multi-level index.
//!
//! A run file is its blocks, then a 64-byte footer. Data blocks hold the entries; each index block holds, per
//! child block, the child's last key and its handle (`Val::Put` of varint offset, varint length). Index blocks
//! are written as soon as they fill, so writing a run of any size holds one block per level in memory, and the
//! top index block is a single block, the only part of a run kept in memory while it is open.
//!
//! Footer: magic, top block offset (u64) and length (u32), index levels (u32), entries (u64), the log position
//! the run covers (u64), the first and last flush it holds (u64 each), CRC-32C of the bytes before it (u32),
//! zero padding; all little-endian.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use super::block::{Block, BlockBuilder, Cursor, KIND_DATA, KIND_INDEX};
use super::cache::Cache;
use super::val::Val;
use super::{KsError, KsResult};
use crate::log::format::{get_uvarint, put_uvarint};

const MAGIC: &[u8; 8] = b"st-run\0\x01";
const FOOTER: usize = 64;

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

    fn from_val(v: &Val) -> Option<Handle> {
        let Val::Put(b) = v else { return None };
        let mut at = 0;
        let offset = get_uvarint(b, &mut at).ok()?;
        let len = get_uvarint(b, &mut at).ok()?;
        (at == b.len()).then_some(Handle { offset, len })
    }
}

pub fn run_name(lo: u64, hi: u64) -> String {
    format!("run-{lo:016x}-{hi:016x}.run")
}

/// The flushes a run file's name says it holds.
pub fn parse_run_name(name: &str) -> Option<(u64, u64)> {
    let mid = name.strip_prefix("run-")?.strip_suffix(".run")?;
    let (lo, hi) = mid.split_once('-')?;
    let (lo, hi) = (
        u64::from_str_radix(lo, 16).ok()?,
        u64::from_str_radix(hi, 16).ok()?,
    );
    (lo <= hi && run_name(lo, hi) == name).then_some((lo, hi))
}

// ---- reading a file from any thread ----

/// A run file's read handle. Under wasm a file descriptor belongs to the thread that opened it, so each thread
/// opens its own (a few kept per thread).
struct RunFile {
    #[cfg(not(target_family = "wasm"))]
    file: File,
    #[cfg(target_family = "wasm")]
    path: PathBuf,
}

#[cfg(target_family = "wasm")]
thread_local! {
    static HANDLES: std::cell::RefCell<Vec<(PathBuf, std::rc::Rc<File>)>> = const { std::cell::RefCell::new(Vec::new()) };
}

impl RunFile {
    fn open(path: &Path) -> io::Result<RunFile> {
        #[cfg(not(target_family = "wasm"))]
        return Ok(RunFile {
            file: File::open(path)?,
        });
        #[cfg(target_family = "wasm")]
        {
            File::open(path)?;
            Ok(RunFile {
                path: path.to_path_buf(),
            })
        }
    }

    fn read_exact_at(&self, buf: &mut [u8], offset: u64) -> io::Result<()> {
        #[cfg(not(target_family = "wasm"))]
        return read_exact_at(&self.file, buf, offset);
        #[cfg(target_family = "wasm")]
        {
            let file = HANDLES.with(|h| -> io::Result<std::rc::Rc<File>> {
                let mut h = h.borrow_mut();
                if let Some(i) = h.iter().position(|(p, _)| *p == self.path) {
                    let e = h.remove(i);
                    h.push(e);
                } else {
                    if h.len() == 16 {
                        h.remove(0);
                    }
                    h.push((self.path.clone(), std::rc::Rc::new(File::open(&self.path)?)));
                }
                Ok(h.last().unwrap().1.clone())
            })?;
            read_exact_at(&file, buf, offset)
        }
    }

    #[cfg(target_family = "wasm")]
    fn forget(&self) {
        HANDLES.with(|h| h.borrow_mut().retain(|(p, _)| *p != self.path));
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

/// Blocks fetched by lookups and page reads, counted for measurement.
#[derive(Default)]
pub struct ReadCounts {
    /// Index and data blocks fetched (from the cache or the file); top blocks are resident and not counted.
    pub blocks: AtomicU64,
    /// Of those, read from the file.
    pub file_reads: AtomicU64,
}

pub struct Run {
    pub uid: u64,
    pub path: PathBuf,
    file: RunFile,
    pub lo: u64,
    pub hi: u64,
    pub covered: u64,
    pub entries: u64,
    /// The file's size.
    pub bytes: u64,
    levels: u32,
    top: Arc<Block>,
    /// The run's largest key (empty for a run with no entries).
    pub max_key: Vec<u8>,
    /// Set once a merge has replaced this run: its file is removed when the last reader lets go of it.
    pub obsolete: AtomicBool,
}

impl Drop for Run {
    fn drop(&mut self) {
        if self.obsolete.load(Ordering::Acquire) {
            #[cfg(target_family = "wasm")]
            self.file.forget();
            let _ = fs::remove_file(&self.path);
        }
    }
}

impl Run {
    pub fn open(path: &Path, lo: u64, hi: u64) -> KsResult<Run> {
        let corrupt = |why: String| KsError::Corrupt {
            file: path.display().to_string(),
            why,
        };
        let file = RunFile::open(path)?;
        let bytes = fs::metadata(path)?.len();
        if bytes < FOOTER as u64 {
            return Err(corrupt("shorter than a footer".into()));
        }
        let mut f = [0u8; FOOTER];
        file.read_exact_at(&mut f, bytes - FOOTER as u64)?;
        let u64_at = |i: usize| u64::from_le_bytes(f[i..i + 8].try_into().unwrap());
        let u32_at = |i: usize| u32::from_le_bytes(f[i..i + 4].try_into().unwrap());
        if &f[..8] != MAGIC || crc32c::crc32c(&f[..56]) != u32_at(56) {
            return Err(corrupt("footer doesn't check out".into()));
        }
        let top = Handle {
            offset: u64_at(8),
            len: u64::from(u32_at(16)),
        };
        let (levels, entries, covered) = (u32_at(20), u64_at(24), u64_at(32));
        if (u64_at(40), u64_at(48)) != (lo, hi) {
            return Err(corrupt("footer holds other flushes than its name".into()));
        }
        if levels == 0 || top.offset + top.len > bytes - FOOTER as u64 {
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
            top,
            max_key,
            obsolete: AtomicBool::new(false),
        })
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
        Handle::from_val(&c.val().map_err(|e| self.corrupt(e))?)
            .ok_or_else(|| self.corrupt("index entry isn't a handle".into()))
    }

    /// The run's value for `key`.
    pub fn get(&self, key: &[u8], cache: &Cache, counts: &ReadCounts) -> KsResult<Option<Val>> {
        if key > self.max_key.as_slice() {
            return Ok(None);
        }
        let mut block = self.top.clone();
        for level in (0..self.levels).rev() {
            let c = Cursor::seek(block, key).map_err(|e| self.corrupt(e))?;
            if !c.valid {
                return Ok(None);
            }
            let kind = if level == 0 { KIND_DATA } else { KIND_INDEX };
            block = self.read_block(self.child(&c)?, kind, Some(cache), Some(counts))?;
        }
        let c = Cursor::seek(block, key).map_err(|e| self.corrupt(e))?;
        if c.valid && c.key == key {
            return Ok(Some(c.val().map_err(|e| self.corrupt(e))?));
        }
        Ok(None)
    }
}

// ---- iterating ----

/// A sorted stream of entries, the current one at `key()`.
pub trait Source {
    fn key(&self) -> Option<&[u8]>;
    fn val(&self) -> KsResult<Val>;
    fn advance(&mut self) -> KsResult<()>;
}

/// A run's entries from a key on, in order.
pub struct RunIter<'a> {
    run: Arc<Run>,
    cache: Option<&'a Cache>,
    counts: Option<&'a ReadCounts>,
    /// One cursor per level, top first; the last is in a data block.
    path: Vec<Cursor>,
}

impl<'a> RunIter<'a> {
    /// At the first entry at or after `from`. Without a cache, blocks are read from the file and not kept
    /// (merges read whole runs once).
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

    /// Fills the path below its last cursor, seeking `from` (or taking each block's first entry); moves on to
    /// the next child wherever a block has nothing at or after `from`.
    fn descend(&mut self, mut from: Option<&[u8]>) -> KsResult<()> {
        loop {
            let depth = self.path.len();
            let last = self.path.last().unwrap();
            if !last.valid {
                // This block is done: step its parent on, or end.
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
}

/// Entries held in memory, in order.
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

/// Merges sources, the first the newest: yields each key once, with its values folded newest first.
pub struct Merge<'a> {
    sources: Vec<Box<dyn Source + 'a>>,
}

impl<'a> Merge<'a> {
    pub fn new(sources: Vec<Box<dyn Source + 'a>>) -> Merge<'a> {
        Merge { sources }
    }

    /// The next key and its values' fold.
    pub fn next_entry(&mut self) -> KsResult<Option<(Vec<u8>, Val)>> {
        let Some(key) = self
            .sources
            .iter()
            .filter_map(|s| s.key())
            .min()
            .map(<[u8]>::to_vec)
        else {
            return Ok(None);
        };
        let mut vals = Vec::new();
        for s in &mut self.sources {
            if s.key() == Some(key.as_slice()) {
                vals.push(s.val()?);
                s.advance()?;
            }
        }
        Ok(Some((key, super::val::fold(vals).unwrap())))
    }
}

// ---- writing ----

pub struct RunWriter {
    out: BufWriter<File>,
    offset: u64,
    block_size: usize,
    data: BlockBuilder,
    /// Index builders, lowest level first, with the blocks each has written.
    index: Vec<(BlockBuilder, u64)>,
    entries: u64,
}

impl RunWriter {
    pub fn create(path: &Path, block_size: usize) -> io::Result<RunWriter> {
        let file = OpenOptions::new().write(true).create_new(true).open(path)?;
        Ok(RunWriter {
            out: BufWriter::with_capacity(1 << 20, file),
            offset: 0,
            block_size,
            data: BlockBuilder::default(),
            index: Vec::new(),
            entries: 0,
        })
    }

    pub fn entries(&self) -> u64 {
        self.entries
    }

    /// Bytes written so far.
    pub fn offset(&self) -> u64 {
        self.offset
    }

    fn write_block(&mut self, bytes: &[u8]) -> io::Result<Handle> {
        self.out.write_all(bytes)?;
        let h = Handle {
            offset: self.offset,
            len: bytes.len() as u64,
        };
        self.offset += h.len;
        Ok(h)
    }

    /// Adds a child's last key and handle to the index level `level`, writing that level's block first if it
    /// is full.
    fn push_index(&mut self, level: usize, key: &[u8], h: Handle) -> io::Result<()> {
        if self.index.len() == level {
            self.index.push((BlockBuilder::default(), 0));
        }
        let v = h.val();
        let b = &self.index[level].0;
        if !b.is_empty() && b.size() + key.len() + 32 > self.block_size {
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

    /// Adds an entry; keys must come in increasing order.
    pub fn add(&mut self, key: &[u8], val: &Val) -> io::Result<()> {
        if !self.data.is_empty()
            && self.data.size() + key.len() + val.payload_len() + 24 > self.block_size
        {
            self.flush_data()?;
        }
        self.data.add(key, val);
        self.entries += 1;
        Ok(())
    }

    /// Writes the rest and the footer, and syncs the file. Returns the file's size.
    pub fn finish(mut self, covered: u64, lo: u64, hi: u64) -> io::Result<u64> {
        if !self.data.is_empty() {
            self.flush_data()?;
        }
        if self.index.is_empty() {
            self.index.push((BlockBuilder::default(), 0));
        }
        // Every level but the highest has written blocks; the highest has not, and its block is the top.
        let mut level = 0;
        while level + 1 < self.index.len() {
            if !self.index[level].0.is_empty() {
                self.flush_index(level)?;
            }
            level += 1;
        }
        let top_bytes = self.index[level].0.finish(KIND_INDEX);
        let top = self.write_block(&top_bytes)?;
        let mut f = Vec::with_capacity(FOOTER);
        f.extend_from_slice(MAGIC);
        f.extend_from_slice(&top.offset.to_le_bytes());
        f.extend_from_slice(&(top.len as u32).to_le_bytes());
        f.extend_from_slice(&(self.index.len() as u32).to_le_bytes());
        f.extend_from_slice(&self.entries.to_le_bytes());
        f.extend_from_slice(&covered.to_le_bytes());
        f.extend_from_slice(&lo.to_le_bytes());
        f.extend_from_slice(&hi.to_le_bytes());
        let crc = crc32c::crc32c(&f);
        f.extend_from_slice(&crc.to_le_bytes());
        f.resize(FOOTER, 0);
        self.write_block(&f)?;
        let file = self.out.into_inner().map_err(|e| e.into_error())?;
        file.sync_data()?;
        Ok(self.offset)
    }
}
