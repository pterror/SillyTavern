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
    kind_by_header, skip_body,
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
    /// Bytes inside the log, not at its end, that hold no whole group.
    Corrupt(Corruption),
    Closed,
    /// A log file that cleaning has removed: nothing points into it any more.
    Gone(u64),
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
            LogError::Corrupt(c) => write!(
                f,
                "record log file {} is damaged: bytes {}..{}, after its first {} groups, hold no whole group, \
                 but {} whole groups follow (bytes {}..{}). Nothing was changed; the log won't open until the \
                 damage is repaired.",
                c.file,
                c.damaged_from,
                c.damaged_to,
                c.groups_before,
                c.groups_after,
                c.damaged_to,
                c.after_to
            ),
            LogError::Closed => write!(f, "the record log is closed"),
            LogError::Gone(file) => write!(
                f,
                "record log file {file} has been cleaned away; read from a later position"
            ),
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

/// Where a log file is damaged: offsets in the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Corruption {
    pub file: String,
    /// Whole groups before the damage.
    pub groups_before: u64,
    pub damaged_from: u64,
    /// Where the first whole group after the damage starts.
    pub damaged_to: u64,
    /// Whole groups from `damaged_to` on, one after another.
    pub groups_after: u64,
    /// Where they end.
    pub after_to: u64,
}

/// The checksum a group starts from: its position's, so a group's bytes check out only where they were
/// written (a group that begins with a pad would otherwise also check out from any zero byte in that block).
fn group_seed(position: u64) -> u32 {
    crc32c::crc32c(&position.to_le_bytes())
}

/// The end of a whole group of at least one record starting at `start`, from the bytes `rest` that start at
/// offset `base`. Only the layout and the checksum are checked: ids and times are differences from earlier
/// records in the block, which may be in the damage.
fn whole_group_at(block: u64, file: u64, rest: &[u8], base: u64, start: u64) -> Option<u64> {
    let end = base + rest.len() as u64;
    let (mut offset, mut crc, mut records) = (start, group_seed(position(file, start)), 0);
    while offset < end {
        let i = (offset - base) as usize;
        match rest[i] {
            PAD if offset % block == 0 => return None,
            PAD => {
                crc = crc32c::crc32c_append(crc, &[PAD]);
                offset = block_start(block, offset) + block;
            }
            TRAILER => {
                if offset % block + TRAILER_LEN as u64 > block || records == 0 {
                    return None;
                }
                let stored = rest.get(i + 1..i + TRAILER_LEN)?;
                return (u32::from_le_bytes(stored.try_into().unwrap()) == crc)
                    .then_some(offset + TRAILER_LEN as u64);
            }
            _ => {
                let mut at = i;
                let (kind, bits) = kind_by_header(get_uvarint(rest, &mut at).ok()?)?;
                skip_body(kind, bits, rest, &mut at).ok()?;
                let item_end = base + at as u64;
                if offset % block != 0
                    && block_start(block, offset) != block_start(block, item_end - 1)
                {
                    return None;
                }
                crc = crc32c::crc32c_append(crc, &rest[i..at]);
                records += 1;
                offset = after(block, offset, item_end);
            }
        }
    }
    None
}

/// Whether a whole group starts anywhere in `rest` (the bytes after the last whole group, from offset `base`):
/// if one does, the bytes before it are damage, not a torn last group.
fn find_damage(cfg: &Config, file: u64, rest: &[u8], base: u64) -> Option<Corruption> {
    let end = base + rest.len() as u64;
    let (start, mut group_end) = (base + 1..end)
        .find_map(|s| whole_group_at(cfg.block_size, file, rest, base, s).map(|e| (s, e)))?;
    let mut groups_after = 1;
    while let Some(e) = whole_group_at(cfg.block_size, file, rest, base, group_end) {
        (groups_after, group_end) = (groups_after + 1, e);
    }
    Some(Corruption {
        file: String::new(),
        groups_before: 0,
        damaged_from: base,
        damaged_to: start,
        groups_after,
        after_to: group_end,
    })
}

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
    /// The length of the item `next` returned last.
    last_len: u64,
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
            crc: group_seed(position(file_index, start)),
            last_len: 0,
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
                    self.ctx = ctx;
                    self.last_len = end - start;
                    self.offset = match item {
                        Item::Pad => block_start(block, start) + block,
                        _ => after(block, start, end),
                    };
                    self.crc = match item {
                        Item::Trailer(_) => group_seed(position(self.file_index, self.offset)),
                        _ => crc32c::crc32c_append(self.crc, &self.buf[at0..at]),
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

/// A record with its position and encoded length.
pub type Positioned = (u64, Record, u64);

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

/// Where the next group goes.
#[derive(Debug, Clone, Copy)]
pub struct Cursor {
    pub file: u64,
    pub offset: u64,
    ctx: Ctx,
}

/// The tail file's write handle, kept by the thread that writes groups: under wasm a file descriptor belongs
/// to the thread that opened it.
pub struct TailFile {
    file: u64,
    /// Whether `file` exists on disk.
    exists: bool,
    handle: Option<File>,
}

impl TailFile {
    /// Writes a group's bytes (from `Layout::close`) into `file` and syncs them, creating `file` first if the
    /// group starts it. Returns the bytes written.
    pub fn write(&mut self, log: &Log, file: u64, runs: &[(u64, Vec<u8>)]) -> LogResult<u64> {
        let shared = &log.shared;
        if self.file != file || !self.exists {
            let handle = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(shared.dir.join(file_name(&shared.cfg, file)))?;
            sync_dir(&shared.dir)?;
            *self = TailFile {
                file,
                exists: true,
                handle: Some(handle),
            };
        }
        if self.handle.is_none() {
            self.handle = Some(
                OpenOptions::new()
                    .write(true)
                    .open(shared.dir.join(file_name(&shared.cfg, file)))?,
            );
        }
        let handle = self.handle.as_ref().unwrap();
        let mut bytes = 0;
        for (at, run) in runs {
            write_all_at(handle, run, *at)?;
            bytes += run.len() as u64;
        }
        handle.sync_data()?;
        let mut stats = shared.stats.lock().unwrap();
        stats.rounds += 1;
        stats.bytes += bytes;
        Ok(bytes)
    }
}

/// How opening finds the log's last file.
#[derive(Debug, Clone, Copy)]
pub enum Start {
    /// List the directory.
    List,
    /// Probe upward from this file: every file from it to the last exists.
    From(u64),
}

/// What opening found.
pub struct Opened {
    pub log: Log,
    pub cursor: Cursor,
    pub tail: TailFile,
    /// The first file, when the directory was listed.
    pub first_file: Option<u64>,
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
    /// Opens the log in `dir` (created if missing) with its own writer thread for `append`: see `open_parts`.
    pub fn open(dir: &Path, cfg: Config) -> LogResult<Log> {
        let Opened {
            log, cursor, tail, ..
        } = Log::open_parts(dir, cfg, Start::List)?;
        log.shared.queue.lock().unwrap().closed = false;
        let writer_shared = log.shared.clone();
        let writer = std::thread::Builder::new()
            .name("st-engine-log".into())
            .spawn(move || writer_loop(&writer_shared, tail, cursor))?;
        *log.writer.lock().unwrap() = Some(writer);
        Ok(log)
    }

    /// Opens the log in `dir` (created if missing) for a caller that writes the groups itself (`append`
    /// refuses): finds the last file, reads it to its last group whose checksum holds, and cuts off what
    /// follows if that is a group a crash tore before its sync returned (never acknowledged). If a whole group
    /// follows the damage, it fails with `Corrupt` and changes nothing. Later files can't exist: a file is
    /// created only after the round before it synced.
    pub fn open_parts(dir: &Path, cfg: Config, start: Start) -> LogResult<Opened> {
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
        let (mut first_file, mut last) = (None, None);
        match start {
            Start::List => {
                for entry in fs::read_dir(dir)? {
                    if let Some(file) = entry?
                        .file_name()
                        .to_str()
                        .and_then(|n| parse_file_name(&cfg, n))
                    {
                        last = last.max(Some(file));
                        first_file = Some(first_file.map_or(file, |f: u64| f.min(file)));
                    }
                }
            }
            Start::From(mut file) => {
                while dir.join(file_name(&cfg, file)).exists() {
                    last = Some(file);
                    file += 1;
                }
            }
        }
        let tail_file = last.unwrap_or(match start {
            Start::List => 0,
            Start::From(f) => f,
        });
        let mut cursor = Cursor {
            file: tail_file,
            offset: 0,
            ctx: Ctx::default(),
        };
        if let Some(file) = last {
            let path = dir.join(file_name(&cfg, file));
            let read_handle = File::open(&path)?;
            let len = read_handle.metadata()?.len();
            let reader = LogFile::new(read_handle);
            let mut scanner = Scanner::new(&cfg, file, &reader, 0, len);
            let mut groups = 0;
            loop {
                match scanner.next() {
                    Ok(Some((_, Item::Trailer(true)))) => {
                        (cursor.offset, cursor.ctx) = (scanner.offset, scanner.ctx);
                        groups += 1;
                    }
                    Ok(Some((_, Item::Trailer(false))))
                    | Ok(None)
                    | Err(LogError::Format { .. }) => break,
                    Ok(Some(_)) => {}
                    Err(e) => return Err(e),
                }
            }
            if len > cursor.offset {
                // Only the last group can be torn by a crash. If a whole group follows the damage, synced and
                // acknowledged records would be lost by cutting there: refuse instead, changing nothing.
                let mut rest = vec![0; (len - cursor.offset) as usize];
                let n = reader.read_at(&mut rest, cursor.offset)?;
                rest.truncate(n);
                if let Some(corruption) = find_damage(&cfg, file, &rest, cursor.offset) {
                    return Err(LogError::Corrupt(Corruption {
                        file: file_name(&cfg, file),
                        groups_before: groups,
                        ..corruption
                    }));
                }
                let handle = OpenOptions::new().write(true).open(&path)?;
                handle.set_len(cursor.offset)?;
                handle.sync_data()?;
            }
        }
        let shared = Arc::new(Shared {
            cfg,
            dir: dir.to_path_buf(),
            queue: Mutex::new(Queue {
                pending: VecDeque::new(),
                closed: true,
            }),
            wake: Condvar::new(),
            durable: Mutex::new(End {
                file: cursor.file,
                offset: cursor.offset,
            }),
            #[cfg(not(target_family = "wasm"))]
            readers: Mutex::new(VecDeque::new()),
            stats: Mutex::new(Stats::default()),
        });
        Ok(Opened {
            log: Log {
                shared,
                writer: Mutex::new(None),
            },
            cursor,
            tail: TailFile {
                file: cursor.file,
                exists: last.is_some(),
                handle: None,
            },
            first_file,
        })
    }

    pub fn config(&self) -> &Config {
        &self.shared.cfg
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

    /// Makes the log up to `end` (a group's end, synced) readable.
    pub fn set_durable(&self, end: Cursor) {
        *self.shared.durable.lock().unwrap() = End {
            file: end.file,
            offset: end.offset,
        };
    }

    pub fn stats(&self) -> Stats {
        *self.shared.stats.lock().unwrap()
    }

    /// The path of a log file.
    pub fn file_path(&self, file: u64) -> PathBuf {
        self.shared.dir.join(file_name(&self.shared.cfg, file))
    }

    /// Removes a log file nothing will read again.
    pub fn remove_file(&self, file: u64) -> io::Result<()> {
        #[cfg(not(target_family = "wasm"))]
        self.shared
            .readers
            .lock()
            .unwrap()
            .retain(|(f, _)| *f != file);
        match fs::remove_file(self.file_path(file)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    fn open_reader(&self, file: u64) -> LogResult<Arc<LogFile>> {
        match File::open(self.file_path(file)) {
            Ok(f) => Ok(Arc::new(LogFile::new(f))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Err(LogError::Gone(file)),
            Err(e) => Err(e.into()),
        }
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

    /// The record at `pos`, which must be a durable record's start, and its encoded length.
    pub fn read_sized(&self, pos: u64) -> LogResult<(Record, u64)> {
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
                Item::Record(r) if at == offset => return Ok((r, scanner.last_len)),
                _ if at >= offset => break,
                _ => {}
            }
        }
        Err(LogError::Position(pos, "not a record's start"))
    }

    /// The record at `pos`, which must be a durable record's start.
    pub fn read(&self, pos: u64) -> LogResult<Record> {
        self.read_sized(pos).map(|(r, _)| r)
    }

    /// Up to `limit` durable records from `from` (0, a record's position, or a `next` returned here), with
    /// their positions and encoded lengths, and the position to continue from. A file that cleaning removed
    /// is `Gone`.
    pub fn iterate_sized(&self, from: u64, limit: usize) -> LogResult<(Vec<Positioned>, u64)> {
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
                    out.push((at, r, scanner.last_len));
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

    /// Up to `limit` durable records from `from`, as `iterate_sized` without the lengths.
    pub fn iterate(&self, from: u64, limit: usize) -> LogResult<(Vec<(u64, Record)>, u64)> {
        let (records, next) = self.iterate_sized(from, limit)?;
        Ok((records.into_iter().map(|(p, r, _)| (p, r)).collect(), next))
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

fn writer_loop(shared: &Arc<Shared>, mut tail: TailFile, mut cursor: Cursor) {
    let log = Log {
        shared: shared.clone(),
        writer: Mutex::new(None),
    };
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
        match write_round(&log, &mut tail, &mut cursor, &mut batch, &mut done) {
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

/// A group's bytes, laid out from a cursor as runs of contiguous bytes.
pub struct Layout {
    block: u64,
    pub file: u64,
    offset: u64,
    ctx: Ctx,
    pub runs: Vec<(u64, Vec<u8>)>,
    crc: u32,
}

/// A layout's state, to go back to.
#[derive(Clone, Copy)]
pub struct Mark {
    offset: u64,
    ctx: Ctx,
    runs: usize,
    last_run: Option<usize>,
    crc: u32,
}

impl Mark {
    pub fn offset(&self) -> u64 {
        self.offset
    }
}

impl Layout {
    /// A group starting at `at`, or at the next file's start once `at`'s file has reached its target size.
    pub fn start(cfg: &Config, at: Cursor) -> Layout {
        let at = if at.offset >= cfg.file_target {
            Cursor {
                file: at.file + 1,
                offset: 0,
                ctx: Ctx::default(),
            }
        } else {
            at
        };
        Layout {
            block: cfg.block_size,
            file: at.file,
            offset: at.offset,
            ctx: at.ctx,
            runs: Vec::new(),
            crc: group_seed(position(at.file, at.offset)),
        }
    }

    /// Bytes laid out in the group's file so far, from its start.
    pub fn offset(&self) -> u64 {
        self.offset
    }

    pub fn is_empty(&self) -> bool {
        self.runs.is_empty()
    }

    pub fn mark(&self) -> Mark {
        Mark {
            offset: self.offset,
            ctx: self.ctx,
            runs: self.runs.len(),
            last_run: self.runs.last().map(|r| r.1.len()),
            crc: self.crc,
        }
    }

    pub fn restore(&mut self, m: Mark) {
        (self.offset, self.ctx, self.crc) = (m.offset, m.ctx, m.crc);
        self.runs.truncate(m.runs);
        if let (Some(len), Some(last)) = (m.last_run, self.runs.last_mut()) {
            last.1.truncate(len);
        }
    }

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

    /// Lays out a record; returns its position and encoded length.
    pub fn record(&mut self, rec: &Record) -> (u64, u64) {
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
        (position(self.file, at), bytes.len() as u64)
    }

    /// Ends the group with its trailer; returns where the next group goes.
    pub fn close(&mut self) -> Cursor {
        let at = self.make_room(TRAILER_LEN as u64);
        let mut bytes = [TRAILER; TRAILER_LEN];
        bytes[1..].copy_from_slice(&self.crc.to_le_bytes());
        self.push(at, &bytes);
        self.offset = at + TRAILER_LEN as u64;
        Cursor {
            file: self.file,
            offset: self.offset,
            ctx: self.ctx,
        }
    }
}

/// The largest commit a group can take: a group ends past `file_target` by at most its last commit, and
/// offsets stay below 2^FILE_SHIFT.
pub fn max_commit(cfg: &Config) -> u64 {
    (1u64 << FILE_SHIFT) - cfg.file_target - cfg.block_size
}

/// Writes one group from the front of `batch` and syncs it, moving the commits it took to `done` with their
/// results. Commits it has no room for stay in `batch`.
fn write_round(
    log: &Log,
    tail: &mut TailFile,
    cursor: &mut Cursor,
    batch: &mut VecDeque<Pending>,
    done: &mut Vec<(Pending, LogResult<Vec<u64>>)>,
) -> LogResult<()> {
    let cfg = log.shared.cfg;
    let mut layout = Layout::start(&cfg, *cursor);
    let mut written = 0;
    while layout.offset < cfg.file_target || written == 0 {
        let Some(p) = batch.pop_front() else { break };
        let mark = layout.mark();
        let positions: Vec<u64> = p.records.iter().map(|r| layout.record(r).0).collect();
        let size = layout.offset - mark.offset;
        if size > max_commit(&cfg) {
            layout.restore(mark);
            done.push((p, Err(LogError::TooLarge(size))));
            continue;
        }
        written += 1;
        done.push((p, Ok(positions)));
    }
    if written == 0 {
        return Ok(());
    }
    let end = layout.close();
    tail.write(log, layout.file, &layout.runs)?;
    *cursor = end;
    log.set_durable(end);
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
