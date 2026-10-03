//! P1, the record log (design `.plans/2026-10-03-storage-from-needs.md` 3 and 4.1): records appended in commit
//! order by one writer thread, grouped so every commit that arrives while a sync runs joins the next sync.
//!
//! Files: `log-<first block seq, 16 hex digits>.blk` in the log's directory. A position is
//! `(file index << FILE_SHIFT) | offset in the file`, so the file holding a position follows from the position
//! alone and nothing per file is kept in memory. A file takes rounds until it reaches `file_target`; a round's
//! group never crosses files, so every file starts with an item.
//!
//! Within a file, items never cross a block boundary, except a record larger than the room left in a block,
//! which starts at a block start; the item after it starts at the next block start. So every block start that
//! isn't inside such a record is an item boundary, and a record is decoded by reading its block from the start.

pub mod format;

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;

use format::{
    Ctx, FormatError, PAD, Record, TRAILER, TRAILER_LEN, decode_body, encode, get_uvarint,
    kind_by_header,
};

/// Bits of a position holding the offset in its file.
pub const FILE_SHIFT: u32 = 36;
/// A file takes no new round once it reaches this size; it bounds what opening the log reads.
pub const FILE_TARGET: u64 = 16 << 20;
/// Provisional; the plan's stage 2 records how it was measured, and stage 3 retunes it with cleaning.
pub const BLOCK_SIZE: u64 = 4 << 10;

#[derive(Debug, Clone, Copy)]
pub struct Config {
    pub block_size: u64,
    pub file_target: u64,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            block_size: BLOCK_SIZE,
            file_target: FILE_TARGET,
        }
    }
}

#[derive(Debug)]
pub enum LogError {
    Io(io::Error),
    Format {
        position: u64,
        error: FormatError,
    },
    /// A position that isn't a durable record's start (or, for iterating, an item boundary).
    Position(u64, &'static str),
    /// A commit larger than a log file can hold.
    TooLarge(u64),
    /// An earlier write or sync failed, so nothing more is appended until the log is reopened.
    Failed,
    Closed,
}

impl std::fmt::Display for LogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LogError::Io(e) => write!(f, "record log I/O error: {e}"),
            LogError::Format { position, error } => {
                write!(f, "record log at position {position}: {error}")
            }
            LogError::Position(p, why) => write!(f, "record log position {p}: {why}"),
            LogError::TooLarge(n) => write!(
                f,
                "a commit of {n} bytes is larger than a log file can hold"
            ),
            LogError::Failed => write!(f, "the record log stopped after a failed write; reopen it"),
            LogError::Closed => write!(f, "the record log is closed"),
        }
    }
}

impl std::error::Error for LogError {}

impl From<io::Error> for LogError {
    fn from(e: io::Error) -> Self {
        LogError::Io(e)
    }
}

pub type LogResult<T> = Result<T, LogError>;

pub fn position(file: u64, offset: u64) -> u64 {
    (file << FILE_SHIFT) | offset
}

fn split(pos: u64) -> (u64, u64) {
    (pos >> FILE_SHIFT, pos & ((1 << FILE_SHIFT) - 1))
}

fn file_name(cfg: &Config, file: u64) -> String {
    format!("log-{:016x}.blk", position(file, 0) / cfg.block_size)
}

fn parse_file_name(cfg: &Config, name: &str) -> Option<u64> {
    let hex = name.strip_prefix("log-")?.strip_suffix(".blk")?;
    let first_block = u64::from_str_radix(hex, 16).ok()?;
    let (file, offset) = split(first_block.checked_mul(cfg.block_size)?);
    (offset == 0 && file_name(cfg, file) == name).then_some(file)
}

// ---- placement: shared by the writer and every reader ----

fn block_start(block: u64, offset: u64) -> u64 {
    offset - offset % block
}

/// Where an item of `len` bytes goes from the item boundary `offset`: at `offset` if it fits in the block or
/// `offset` is a block start, else (after a pad at `offset`) at the next block start.
fn place(block: u64, offset: u64, len: u64) -> Option<u64> {
    let in_block = offset % block;
    (in_block != 0 && in_block + len > block).then(|| block_start(block, offset) + block)
}

/// The item boundary after an item at `start` that ends at `end`: `end`, unless the item crossed into a
/// later block, then the start of the block after the one it ends in.
fn after(block: u64, start: u64, end: u64) -> u64 {
    if end.is_multiple_of(block) || block_start(block, start) == block_start(block, end) {
        end
    } else {
        block_start(block, end) + block
    }
}

// ---- reading a file ----

struct LogFile {
    #[cfg(any(unix, windows))]
    file: File,
    #[cfg(not(any(unix, windows)))]
    file: Mutex<File>,
}

impl LogFile {
    fn new(file: File) -> Self {
        #[cfg(any(unix, windows))]
        return LogFile { file };
        #[cfg(not(any(unix, windows)))]
        return LogFile {
            file: Mutex::new(file),
        };
    }

    /// Reads up to `buf.len()` bytes at `offset`; fewer only at the end of the file.
    fn read_at(&self, mut buf: &mut [u8], mut offset: u64) -> io::Result<usize> {
        let mut total = 0;
        while !buf.is_empty() {
            #[cfg(unix)]
            let n = std::os::unix::fs::FileExt::read_at(&self.file, buf, offset)?;
            #[cfg(windows)]
            let n = std::os::windows::fs::FileExt::seek_read(&self.file, buf, offset)?;
            #[cfg(not(any(unix, windows)))]
            let n = {
                use std::io::{Read, Seek, SeekFrom};
                let mut f = self.file.lock().unwrap();
                f.seek(SeekFrom::Start(offset))?;
                f.read(buf)?
            };
            if n == 0 {
                break;
            }
            total += n;
            offset += n as u64;
            buf = &mut buf[n..];
        }
        Ok(total)
    }
}

/// One item read from a file.
enum Item {
    Record(Record),
    Pad,
    /// A trailer, and whether its checksum holds.
    Trailer(bool),
}

/// Reads one file's items in order from a block start, keeping the decoding context and the running
/// checksum of the current group.
struct Scanner<'a> {
    block: u64,
    file_index: u64,
    file: &'a LogFile,
    /// Never read at or past this offset.
    limit: u64,
    /// Bytes of the file from `buf_start`.
    buf: Vec<u8>,
    buf_start: u64,
    /// The next item's offset.
    offset: u64,
    ctx: Ctx,
    crc: u32,
}

impl<'a> Scanner<'a> {
    fn new(cfg: &Config, file_index: u64, file: &'a LogFile, start: u64, limit: u64) -> Self {
        debug_assert_eq!(start % cfg.block_size, 0);
        Scanner {
            block: cfg.block_size,
            file_index,
            file,
            limit,
            buf: Vec::new(),
            buf_start: start,
            offset: start,
            ctx: Ctx::default(),
            crc: 0,
        }
    }

    fn buf_end(&self) -> u64 {
        self.buf_start + self.buf.len() as u64
    }

    /// Reads on to `end` (capped by the limit and the file's end).
    fn fill_to(&mut self, end: u64) -> io::Result<()> {
        let (want, have) = (end.min(self.limit), self.buf_end());
        if want > have {
            let old = self.buf.len();
            self.buf.resize(old + (want - have) as usize, 0);
            let n = self.file.read_at(&mut self.buf[old..], have)?;
            self.buf.truncate(old + n);
        }
        Ok(())
    }

    fn error(&self, offset: u64, error: FormatError) -> LogError {
        LogError::Format {
            position: position(self.file_index, offset),
            error,
        }
    }

    /// The next item and its offset; None at the limit or the end of the file.
    fn next(&mut self) -> LogResult<Option<(u64, Item)>> {
        let block = self.block;
        let start = self.offset;
        if start.is_multiple_of(block) {
            self.ctx = Ctx::default();
            // Bytes before the current block are never needed again.
            self.buf
                .drain(..((start - self.buf_start) as usize).min(self.buf.len()));
            self.buf_start = start;
        }
        self.fill_to(block_start(block, start) + block)?;
        if self.buf_end() <= start {
            return Ok(None);
        }
        loop {
            let at0 = (start - self.buf_start) as usize;
            let bytes = &self.buf;
            let mut ctx = self.ctx;
            let decoded = match bytes[at0] {
                PAD if start.is_multiple_of(block) => {
                    Err(FormatError::Invalid("a pad at a block start".into()))
                }
                PAD => Ok((Item::Pad, at0 + 1)),
                TRAILER => match bytes.get(at0 + 1..at0 + TRAILER_LEN) {
                    Some(c) => Ok((
                        Item::Trailer(u32::from_le_bytes(c.try_into().unwrap()) == self.crc),
                        at0 + TRAILER_LEN,
                    )),
                    None => Err(FormatError::Incomplete),
                },
                _ => {
                    let mut at = at0;
                    get_uvarint(bytes, &mut at)
                        .and_then(|h| {
                            kind_by_header(h).ok_or_else(|| {
                                FormatError::Invalid(format!("unknown record header {h}"))
                            })
                        })
                        .and_then(|(kind, bits)| decode_body(kind, bits, bytes, &mut at, &mut ctx))
                        .map(|rec| (Item::Record(rec), at))
                }
            };
            match decoded {
                Ok((item, at)) => {
                    let end = self.buf_start + at as u64;
                    if !start.is_multiple_of(block)
                        && block_start(block, start) != block_start(block, end - 1)
                    {
                        return Err(self.error(
                            start,
                            FormatError::Invalid("an item crosses a block boundary".into()),
                        ));
                    }
                    if !matches!(item, Item::Trailer(_)) {
                        self.crc = crc32c::crc32c_append(self.crc, &self.buf[at0..at]);
                    } else {
                        self.crc = 0;
                    }
                    self.ctx = ctx;
                    self.offset = match item {
                        Item::Pad => block_start(block, start) + block,
                        _ => after(block, start, end),
                    };
                    return Ok(Some((start, item)));
                }
                Err(FormatError::Incomplete) => {
                    // Only a record at a block start continues into the next block.
                    let before = self.buf_end();
                    if start.is_multiple_of(block) {
                        self.fill_to(before + block)?;
                    }
                    if self.buf_end() == before {
                        return Err(self.error(start, FormatError::Incomplete));
                    }
                }
                Err(error) => return Err(self.error(start, error)),
            }
        }
    }
}

// ---- the log ----

/// The end of the durable log: the item boundary after the last synced trailer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct End {
    file: u64,
    offset: u64,
}

impl End {
    fn position(&self) -> u64 {
        position(self.file, self.offset)
    }
}

pub type Done = Box<dyn FnOnce(LogResult<Vec<u64>>) + Send>;

struct Pending {
    records: Vec<Record>,
    done: Done,
}

#[derive(Default)]
struct Queue {
    pending: VecDeque<Pending>,
    closed: bool,
}

/// Counts kept for measurement.
#[derive(Debug, Default, Clone, Copy)]
pub struct Stats {
    /// Sync rounds: groups written and synced.
    pub rounds: u64,
    /// Bytes written by appends, pads and trailers included.
    pub bytes: u64,
}

struct Shared {
    cfg: Config,
    dir: PathBuf,
    queue: Mutex<Queue>,
    wake: Condvar,
    durable: Mutex<End>,
    /// Open read handles, most recently used last. Not under wasm, where a file descriptor belongs to the
    /// thread that opened it.
    #[cfg(not(target_family = "wasm"))]
    readers: Mutex<VecDeque<(u64, Arc<LogFile>)>>,
    stats: Mutex<Stats>,
}

#[cfg(not(target_family = "wasm"))]
const READERS: usize = 4;

/// The writer thread's state.
struct Tail {
    file: u64,
    /// Whether `file` exists on disk.
    exists: bool,
    /// Opened by the writer thread itself: under wasm a file descriptor belongs to the thread that opened it.
    handle: Option<File>,
    /// The next item's offset in `file`.
    offset: u64,
    ctx: Ctx,
}

pub struct Log {
    shared: Arc<Shared>,
    writer: Mutex<Option<JoinHandle<()>>>,
}

fn sync_dir(dir: &Path) -> io::Result<()> {
    // A new file's directory entry is durable once its directory is synced. On Windows, as in SQLite, no
    // directory is synced: NTFS journals the entry, and a directory can't be opened as a file there.
    #[cfg(not(windows))]
    File::open(dir)?.sync_all()?;
    #[cfg(windows)]
    let _ = dir;
    Ok(())
}

impl Log {
    /// Opens the log in `dir` (created if missing): finds the last file, reads it to its last group whose
    /// checksum holds, and cuts off what follows (a group a crash tore before its sync returned, so never
    /// acknowledged). Reads at most one file.
    pub fn open(dir: &Path, cfg: Config) -> LogResult<Log> {
        assert!(
            cfg.block_size.is_power_of_two()
                && cfg.block_size >= 64
                && cfg.file_target < 1 << (FILE_SHIFT - 1)
        );
        if !dir.exists() {
            fs::create_dir_all(dir)?;
            if let Some(parent) = dir.parent() {
                sync_dir(parent)?;
            }
        }
        let mut last = None;
        for entry in fs::read_dir(dir)? {
            if let Some(file) = entry?
                .file_name()
                .to_str()
                .and_then(|n| parse_file_name(&cfg, n))
            {
                last = last.max(Some(file));
            }
        }
        let mut tail = Tail {
            file: last.unwrap_or(0),
            exists: last.is_some(),
            handle: None,
            offset: 0,
            ctx: Ctx::default(),
        };
        if let Some(file) = last {
            let path = dir.join(file_name(&cfg, file));
            let handle = OpenOptions::new().write(true).open(&path)?;
            let len = handle.metadata()?.len();
            let reader = LogFile::new(File::open(&path)?);
            let mut scanner = Scanner::new(&cfg, file, &reader, 0, len);
            loop {
                match scanner.next() {
                    Ok(Some((_, Item::Trailer(true)))) => {
                        (tail.offset, tail.ctx) = (scanner.offset, scanner.ctx)
                    }
                    Ok(Some((_, Item::Trailer(false))))
                    | Ok(None)
                    | Err(LogError::Format { .. }) => break,
                    Ok(Some(_)) => {}
                    Err(e) => return Err(e),
                }
            }
            if len > tail.offset {
                handle.set_len(tail.offset)?;
                handle.sync_data()?;
            }
        }
        let shared = Arc::new(Shared {
            cfg,
            dir: dir.to_path_buf(),
            queue: Mutex::new(Queue::default()),
            wake: Condvar::new(),
            durable: Mutex::new(End {
                file: tail.file,
                offset: tail.offset,
            }),
            #[cfg(not(target_family = "wasm"))]
            readers: Mutex::new(VecDeque::new()),
            stats: Mutex::new(Stats::default()),
        });
        let writer_shared = shared.clone();
        let writer = std::thread::Builder::new()
            .name("st-engine-log".into())
            .spawn(move || writer_loop(&writer_shared, tail))?;
        Ok(Log {
            shared,
            writer: Mutex::new(Some(writer)),
        })
    }

    /// Appends `records` as one commit: durable together, in one sync group. `done` runs on the writer thread
    /// with their positions once that group's sync has returned, or with the error.
    pub fn append(&self, records: Vec<Record>, done: Done) {
        let mut q = self.shared.queue.lock().unwrap();
        if q.closed {
            drop(q);
            return done(Err(LogError::Closed));
        }
        q.pending.push_back(Pending { records, done });
        drop(q);
        self.shared.wake.notify_one();
    }

    /// Appends and waits for the sync.
    pub fn append_wait(&self, records: Vec<Record>) -> LogResult<Vec<u64>> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.append(records, Box::new(move |r| drop(tx.send(r))));
        rx.recv().unwrap_or(Err(LogError::Closed))
    }

    /// The position after the last durable record.
    pub fn durable_end(&self) -> u64 {
        self.shared.durable.lock().unwrap().position()
    }

    pub fn stats(&self) -> Stats {
        *self.shared.stats.lock().unwrap()
    }

    fn open_reader(&self, file: u64) -> LogResult<Arc<LogFile>> {
        let path = self.shared.dir.join(file_name(&self.shared.cfg, file));
        Ok(Arc::new(LogFile::new(File::open(path)?)))
    }

    #[cfg(target_family = "wasm")]
    fn reader(&self, file: u64) -> LogResult<Arc<LogFile>> {
        self.open_reader(file)
    }

    #[cfg(not(target_family = "wasm"))]
    fn reader(&self, file: u64) -> LogResult<Arc<LogFile>> {
        let mut readers = self.shared.readers.lock().unwrap();
        if let Some(i) = readers.iter().position(|(f, _)| *f == file) {
            let r = readers.remove(i).unwrap();
            readers.push_back(r.clone());
            return Ok(r.1);
        }
        let f = self.open_reader(file)?;
        if readers.len() == READERS {
            readers.pop_front();
        }
        readers.push_back((file, f.clone()));
        Ok(f)
    }

    /// The record at `pos`, which must be a durable record's start.
    pub fn read(&self, pos: u64) -> LogResult<Record> {
        let end = *self.shared.durable.lock().unwrap();
        if pos >= end.position() {
            return Err(LogError::Position(pos, "not durable"));
        }
        let (file, offset) = split(pos);
        let reader = self.reader(file)?;
        let limit = if file == end.file {
            end.offset
        } else {
            u64::MAX
        };
        let mut scanner = Scanner::new(
            &self.shared.cfg,
            file,
            &reader,
            block_start(self.shared.cfg.block_size, offset),
            limit,
        );
        while let Some((at, item)) = scanner.next()? {
            match item {
                Item::Record(r) if at == offset => return Ok(r),
                _ if at >= offset => break,
                _ => {}
            }
        }
        Err(LogError::Position(pos, "not a record's start"))
    }

    /// Up to `limit` durable records from `from` (0, a record's position, or a `next` returned here), with
    /// their positions, and the position to continue from.
    pub fn iterate(&self, from: u64, limit: usize) -> LogResult<(Vec<(u64, Record)>, u64)> {
        let end = *self.shared.durable.lock().unwrap();
        if from > end.position() {
            return Err(LogError::Position(from, "not durable"));
        }
        let block = self.shared.cfg.block_size;
        let mut out = Vec::new();
        let mut next = from;
        let (mut file, offset) = split(from);
        let mut scan_from = block_start(block, offset);
        while out.len() < limit && next < end.position() {
            let reader = self.reader(file)?;
            let file_limit = if file == end.file {
                end.offset
            } else {
                u64::MAX
            };
            let mut scanner = Scanner::new(&self.shared.cfg, file, &reader, scan_from, file_limit);
            while out.len() < limit {
                let Some((at, item)) = scanner.next()? else {
                    break;
                };
                let at = position(file, at);
                if at < next {
                    continue;
                }
                if at > next {
                    return Err(LogError::Position(next, "not an item boundary"));
                }
                if let Item::Record(r) = item {
                    out.push((at, r));
                }
                next = position(file, scanner.offset);
            }
            if out.len() == limit || file == end.file {
                break;
            }
            // This file is done: the log goes on in the next.
            file += 1;
            scan_from = 0;
            next = position(file, 0);
        }
        Ok((out, next))
    }

    /// Lets the writer finish what is queued, then stops it. Later appends fail with `Closed`.
    pub fn close(&self) {
        self.shared.queue.lock().unwrap().closed = true;
        self.shared.wake.notify_one();
        if let Some(w) = self.writer.lock().unwrap().take() {
            let _ = w.join();
        }
    }
}

impl Drop for Log {
    fn drop(&mut self) {
        self.close();
    }
}

fn writer_loop(shared: &Shared, mut tail: Tail) {
    let mut failed = false;
    loop {
        let mut batch = {
            let mut q = shared.queue.lock().unwrap();
            while q.pending.is_empty() && !q.closed {
                q = shared.wake.wait(q).unwrap();
            }
            if q.pending.is_empty() {
                return;
            }
            std::mem::take(&mut q.pending)
        };
        if failed {
            for p in batch {
                (p.done)(Err(LogError::Failed));
            }
            continue;
        }
        let mut done = Vec::new();
        match write_round(shared, &mut tail, &mut batch, &mut done) {
            Ok(()) => {
                for (p, result) in done {
                    (p.done)(result);
                }
                // Commits the round had no room for go first in the next.
                if !batch.is_empty() {
                    let mut q = shared.queue.lock().unwrap();
                    while let Some(p) = batch.pop_back() {
                        q.pending.push_front(p);
                    }
                }
            }
            Err(e) => {
                // What reached the file is unknown, so nothing more is appended; reopening recovers to the
                // last group whose checksum holds.
                failed = true;
                let msg = e.to_string();
                for p in done.into_iter().map(|(p, _)| p).chain(batch) {
                    (p.done)(Err(LogError::Io(io::Error::other(msg.clone()))));
                }
            }
        }
    }
}

/// A round's bytes, laid out from the tail as runs of contiguous bytes.
struct Layout {
    block: u64,
    offset: u64,
    ctx: Ctx,
    runs: Vec<(u64, Vec<u8>)>,
    crc: u32,
}

impl Layout {
    fn push(&mut self, at: u64, bytes: &[u8]) {
        match self.runs.last_mut() {
            Some((start, run)) if *start + run.len() as u64 == at => run.extend_from_slice(bytes),
            _ => self.runs.push((at, bytes.to_vec())),
        }
    }

    /// Lays out an item of `len` bytes from here: a pad first if it must go to the next block. Returns
    /// where it starts.
    fn make_room(&mut self, len: u64) -> u64 {
        if let Some(next_block) = place(self.block, self.offset, len) {
            self.push(self.offset, &[PAD]);
            self.crc = crc32c::crc32c_append(self.crc, &[PAD]);
            self.offset = next_block;
        }
        if self.offset.is_multiple_of(self.block) {
            self.ctx = Ctx::default();
        }
        self.offset
    }

    fn record(&mut self, rec: &Record) -> u64 {
        let at_block_start = self.offset.is_multiple_of(self.block);
        let mut ctx = if at_block_start {
            Ctx::default()
        } else {
            self.ctx
        };
        let mut bytes = Vec::new();
        encode(rec, &mut ctx, &mut bytes);
        let at = self.make_room(bytes.len() as u64);
        if !at_block_start && at.is_multiple_of(self.block) {
            // Moved to the next block: encode again against its fresh context.
            ctx = Ctx::default();
            bytes.clear();
            encode(rec, &mut ctx, &mut bytes);
        }
        self.push(at, &bytes);
        self.crc = crc32c::crc32c_append(self.crc, &bytes);
        self.ctx = ctx;
        self.offset = after(self.block, at, at + bytes.len() as u64);
        at
    }

    fn trailer(&mut self) {
        let at = self.make_room(TRAILER_LEN as u64);
        let mut bytes = [TRAILER; TRAILER_LEN];
        bytes[1..].copy_from_slice(&self.crc.to_le_bytes());
        self.push(at, &bytes);
        self.crc = 0;
        self.offset = at + TRAILER_LEN as u64;
    }
}

/// Writes one group from the front of `batch` and syncs it, moving the commits it took to `done` with their
/// results. Commits it has no room for stay in `batch`.
fn write_round(
    shared: &Shared,
    tail: &mut Tail,
    batch: &mut VecDeque<Pending>,
    done: &mut Vec<(Pending, LogResult<Vec<u64>>)>,
) -> LogResult<()> {
    let cfg = shared.cfg;
    if tail.exists && tail.offset >= cfg.file_target {
        *tail = Tail {
            file: tail.file + 1,
            exists: false,
            handle: None,
            offset: 0,
            ctx: Ctx::default(),
        };
    }
    if !tail.exists {
        let handle = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(shared.dir.join(file_name(&cfg, tail.file)))?;
        sync_dir(&shared.dir)?;
        (tail.exists, tail.handle) = (true, Some(handle));
    }
    if tail.handle.is_none() {
        tail.handle = Some(
            OpenOptions::new()
                .write(true)
                .open(shared.dir.join(file_name(&cfg, tail.file)))?,
        );
    }
    let mut layout = Layout {
        block: cfg.block_size,
        offset: tail.offset,
        ctx: tail.ctx,
        runs: Vec::new(),
        crc: 0,
    };
    // A round ends past `file_target` by at most its last commit, and offsets stay below 2^FILE_SHIFT.
    let max_commit = (1u64 << FILE_SHIFT) - cfg.file_target - cfg.block_size;
    let mut written = 0;
    while layout.offset < cfg.file_target || written == 0 {
        let Some(p) = batch.pop_front() else { break };
        let before = (
            layout.offset,
            layout.ctx,
            layout.runs.len(),
            layout.runs.last().map(|r| r.1.len()),
            layout.crc,
        );
        let positions: Vec<u64> = p
            .records
            .iter()
            .map(|r| position(tail.file, layout.record(r)))
            .collect();
        let size = layout.offset - before.0;
        if size > max_commit {
            (layout.offset, layout.ctx, _, _, layout.crc) = before;
            layout.runs.truncate(before.2);
            if let (Some(len), Some(last)) = (before.3, layout.runs.last_mut()) {
                last.1.truncate(len);
            }
            done.push((p, Err(LogError::TooLarge(size))));
            continue;
        }
        written += 1;
        done.push((p, Ok(positions)));
    }
    if written == 0 {
        return Ok(());
    }
    layout.trailer();
    let handle = tail.handle.as_ref().unwrap();
    let mut bytes = 0;
    for (at, run) in &layout.runs {
        write_all_at(handle, run, *at)?;
        bytes += run.len() as u64;
    }
    handle.sync_data()?;
    {
        let mut stats = shared.stats.lock().unwrap();
        stats.rounds += 1;
        stats.bytes += bytes;
    }
    tail.offset = layout.offset;
    tail.ctx = layout.ctx;
    *shared.durable.lock().unwrap() = End {
        file: tail.file,
        offset: tail.offset,
    };
    Ok(())
}

fn write_all_at(file: &File, bytes: &[u8], offset: u64) -> io::Result<()> {
    #[cfg(unix)]
    return std::os::unix::fs::FileExt::write_all_at(file, bytes, offset);
    #[cfg(not(unix))]
    {
        let (mut bytes, mut offset) = (bytes, offset);
        while !bytes.is_empty() {
            #[cfg(windows)]
            let n = std::os::windows::fs::FileExt::seek_write(file, bytes, offset)?;
            #[cfg(not(windows))]
            let n = {
                use std::io::{Seek, SeekFrom, Write};
                let mut f = file;
                f.seek(SeekFrom::Start(offset))?;
                f.write(bytes)?
            };
            if n == 0 {
                return Err(io::Error::from(io::ErrorKind::WriteZero));
            }
            bytes = &bytes[n..];
            offset += n as u64;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
