pub mod format;

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;

use format::{
    Ctx, FormatError, PAD, Record, TRAILER, TRAILER_LEN, advance_body, decode_body, encode,
    get_uvarint, kind_by_header, skip_body,
};

pub const FILE_SHIFT: u32 = 36;
pub const FILE_TARGET: u64 = 16 << 20;
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
    Position(u64, &'static str),
    TooLarge(u64),
    Failed,
    Corrupt(Corruption),
    Closed,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Corruption {
    pub file: String,
    pub groups_before: u64,
    pub damaged_from: u64,
    pub damaged_to: u64,
    pub groups_after: u64,
    pub after_to: u64,
}

fn group_seed(position: u64) -> u32 {
    crc32c::crc32c(&position.to_le_bytes())
}

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

pub fn file_name(cfg: &Config, file: u64) -> String {
    format!("log-{:016x}.blk", position(file, 0) / cfg.block_size)
}

fn parse_file_name(cfg: &Config, name: &str) -> Option<u64> {
    let hex = name.strip_prefix("log-")?.strip_suffix(".blk")?;
    let first_block = u64::from_str_radix(hex, 16).ok()?;
    let (file, offset) = split(first_block.checked_mul(cfg.block_size)?);
    (offset == 0 && file_name(cfg, file) == name).then_some(file)
}

fn block_start(block: u64, offset: u64) -> u64 {
    offset - offset % block
}

fn place(block: u64, offset: u64, len: u64) -> Option<u64> {
    let in_block = offset % block;
    (in_block != 0 && in_block + len > block).then(|| block_start(block, offset) + block)
}

fn after(block: u64, start: u64, end: u64) -> u64 {
    if end.is_multiple_of(block) || block_start(block, start) == block_start(block, end) {
        end
    } else {
        block_start(block, end) + block
    }
}

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

enum Item {
    Record(Record),
    Skipped,
    Pad,
    Trailer(bool),
}

struct Scanner<'a> {
    block: u64,
    file_index: u64,
    file: &'a LogFile,
    limit: u64,
    buf: Vec<u8>,
    buf_start: u64,
    offset: u64,
    ctx: Ctx,
    crc: u32,
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

    fn next(&mut self) -> LogResult<Option<(u64, Item)>> {
        self.next_item(true)
    }

    fn at(&self) -> u64 {
        self.offset
    }

    fn next_item(&mut self, decode: bool) -> LogResult<Option<(u64, Item)>> {
        let block = self.block;
        let start = self.offset;
        if start.is_multiple_of(block) {
            self.ctx = Ctx::default();
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
                        .and_then(|(kind, bits)| {
                            if decode {
                                decode_body(kind, bits, bytes, &mut at, &mut ctx).map(Item::Record)
                            } else {
                                advance_body(kind, bits, bytes, &mut at, &mut ctx).map(|()| Item::Skipped)
                            }
                        })
                        .map(|item| (item, at))
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

#[derive(Debug, Default, Clone, Copy)]
pub struct Stats {
    pub rounds: u64,
    pub bytes: u64,
}

struct Shared {
    cfg: Config,
    dir: PathBuf,
    queue: Mutex<Queue>,
    wake: Condvar,
    durable: Mutex<End>,
    #[cfg(not(target_family = "wasm"))]
    readers: Mutex<VecDeque<(u64, Arc<LogFile>)>>,
    stats: Mutex<Stats>,
}

#[cfg(not(target_family = "wasm"))]
const READERS: usize = 4;

#[derive(Debug, Clone, Copy)]
pub struct Cursor {
    pub file: u64,
    pub offset: u64,
    ctx: Ctx,
}

impl Cursor {
    pub fn file_start(file: u64) -> Cursor {
        Cursor {
            file,
            offset: 0,
            ctx: Ctx::default(),
        }
    }
}

pub struct TailFile {
    file: u64,
    exists: bool,
    handle: Option<File>,
}

impl TailFile {
    pub fn existing(file: u64) -> TailFile {
        TailFile {
            file,
            exists: true,
            handle: None,
        }
    }

    pub fn write(&mut self, log: &Log, file: u64, runs: &[(u64, Vec<u8>)]) -> LogResult<u64> {
        let shared = &log.shared;
        let path = shared.dir.join(file_name(&shared.cfg, file));
        if self.file != file || !self.exists {
            let handle = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(&path)?;
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
            write_hooked(&path, handle, run, *at)?;
            bytes += run.len() as u64;
        }
        crate::faults::op(crate::faults::Op::Sync, &path)?;
        handle.sync_data()?;
        #[cfg(target_family = "wasm")]
        {
            self.handle = None;
        }
        let mut stats = shared.stats.lock().unwrap();
        stats.rounds += 1;
        stats.bytes += bytes;
        Ok(bytes)
    }
}

#[derive(Debug, Clone, Copy)]
pub enum Start {
    List,
    From(u64),
}

pub struct Opened {
    pub log: Log,
    pub cursor: Cursor,
    pub tail: TailFile,
    pub first_file: Option<u64>,
}

pub struct Log {
    shared: Arc<Shared>,
    writer: Mutex<Option<JoinHandle<()>>>,
}

fn sync_dir(dir: &Path) -> io::Result<()> {
    crate::faults::op(crate::faults::Op::SyncDir, dir)?;
    #[cfg(not(windows))]
    File::open(dir)?.sync_all()?;
    #[cfg(windows)]
    let _ = dir;
    Ok(())
}

impl Log {
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
                crate::faults::set_len(&path, cursor.offset)?;
                handle.set_len(cursor.offset)?;
                crate::faults::op(crate::faults::Op::Sync, &path)?;
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

    pub fn append_wait(&self, records: Vec<Record>) -> LogResult<Vec<u64>> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.append(records, Box::new(move |r| drop(tx.send(r))));
        rx.recv().unwrap_or(Err(LogError::Closed))
    }

    pub fn durable_end(&self) -> u64 {
        self.shared.durable.lock().unwrap().position()
    }

    pub fn set_durable(&self, end: Cursor) {
        *self.shared.durable.lock().unwrap() = End {
            file: end.file,
            offset: end.offset,
        };
    }

    pub fn stats(&self) -> Stats {
        *self.shared.stats.lock().unwrap()
    }

    pub fn file_path(&self, file: u64) -> PathBuf {
        self.shared.dir.join(file_name(&self.shared.cfg, file))
    }

    pub fn remove_file(&self, file: u64) -> io::Result<()> {
        #[cfg(not(target_family = "wasm"))]
        self.shared
            .readers
            .lock()
            .unwrap()
            .retain(|(f, _)| *f != file);
        crate::faults::op(crate::faults::Op::Remove, &self.file_path(file))?;
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
        while let Some((at, item)) = scanner.next_item(scanner.at() == offset)? {
            match item {
                Item::Record(r) if at == offset => return Ok((r, scanner.last_len)),
                _ if at >= offset => break,
                _ => {}
            }
        }
        Err(LogError::Position(pos, "not a record's start"))
    }

    pub fn read_many(&self, positions: &[u64]) -> LogResult<Vec<(Record, u64)>> {
        let end = *self.shared.durable.lock().unwrap();
        let block = self.shared.cfg.block_size;
        let mut order: Vec<usize> = (0..positions.len()).collect();
        order.sort_by_key(|&i| positions[i]);
        let mut out: Vec<Option<(Record, u64)>> = vec![None; positions.len()];
        let mut i = 0;
        while i < order.len() {
            let pos = positions[order[i]];
            if pos >= end.position() {
                return Err(LogError::Position(pos, "not durable"));
            }
            let (file, offset) = split(pos);
            let start = block_start(block, offset);
            let mut j = i;
            while j < order.len() {
                let (f, o) = split(positions[order[j]]);
                if f != file || block_start(block, o) != start {
                    break;
                }
                j += 1;
            }
            let reader = self.reader(file)?;
            let limit = if file == end.file {
                end.offset
            } else {
                u64::MAX
            };
            let mut scanner = Scanner::new(&self.shared.cfg, file, &reader, start, limit);
            let mut next = i;
            while next < j {
                let wanted = split(positions[order[next]]).1 == scanner.at();
                let Some((at, item)) = scanner.next_item(wanted)? else {
                    break;
                };
                if split(positions[order[next]]).1 < at {
                    return Err(LogError::Position(
                        positions[order[next]],
                        "not a record's start",
                    ));
                }
                if let Item::Record(r) = item {
                    while next < j && split(positions[order[next]]).1 == at {
                        out[order[next]] = Some((r.clone(), scanner.last_len));
                        next += 1;
                    }
                }
            }
            if next < j {
                return Err(LogError::Position(
                    positions[order[next]],
                    "not a record's start",
                ));
            }
            i = j;
        }
        Ok(out
            .into_iter()
            .map(|r| r.expect("every position read"))
            .collect())
    }

    pub fn read_staged(&self, dir: &Path, pos: u64) -> LogResult<(Record, u64)> {
        let (file, offset) = split(pos);
        let reader = match File::open(dir.join(file_name(&self.shared.cfg, file))) {
            Ok(f) => LogFile::new(f),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(LogError::Gone(file)),
            Err(e) => return Err(e.into()),
        };
        let mut scanner = Scanner::new(
            &self.shared.cfg,
            file,
            &reader,
            block_start(self.shared.cfg.block_size, offset),
            u64::MAX,
        );
        while let Some((at, item)) = scanner.next_item(scanner.at() == offset)? {
            match item {
                Item::Record(r) if at == offset => return Ok((r, scanner.last_len)),
                _ if at >= offset => break,
                _ => {}
            }
        }
        Err(LogError::Position(pos, "not a record's start"))
    }

    pub fn write_staged(&self, dir: &Path, file: u64, runs: &[(u64, Vec<u8>)]) -> LogResult<u64> {
        let path = dir.join(file_name(&self.shared.cfg, file));
        let handle = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)?;
        let mut bytes = 0;
        for (at, run) in runs {
            write_all_at(&handle, run, *at)?;
            bytes += run.len() as u64;
        }
        handle.sync_data()?;
        Ok(bytes)
    }

    pub fn file_name(&self, file: u64) -> String {
        file_name(&self.shared.cfg, file)
    }

    pub fn read(&self, pos: u64) -> LogResult<Record> {
        self.read_sized(pos).map(|(r, _)| r)
    }

    pub fn iterate_sized(&self, from: u64, limit: usize) -> LogResult<(Vec<Positioned>, u64)> {
        self.iterate_from(from, limit, false)
    }

    pub fn iterate_file(&self, from: u64, limit: usize) -> LogResult<(Vec<Positioned>, u64)> {
        self.iterate_from(from, limit, true)
    }

    fn iterate_from(
        &self,
        from: u64,
        limit: usize,
        one_file: bool,
    ) -> LogResult<(Vec<Positioned>, u64)> {
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
            file += 1;
            scan_from = 0;
            next = position(file, 0);
            if one_file {
                break;
            }
        }
        Ok((out, next))
    }

    pub fn iterate(&self, from: u64, limit: usize) -> LogResult<(Vec<(u64, Record)>, u64)> {
        let (records, next) = self.iterate_sized(from, limit)?;
        Ok((records.into_iter().map(|(p, r, _)| (p, r)).collect(), next))
    }

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
                if !batch.is_empty() {
                    let mut q = shared.queue.lock().unwrap();
                    while let Some(p) = batch.pop_back() {
                        q.pending.push_front(p);
                    }
                }
            }
            Err(e) => {
                failed = true;
                let msg = e.to_string();
                for p in done.into_iter().map(|(p, _)| p).chain(batch) {
                    (p.done)(Err(LogError::Io(io::Error::other(msg.clone()))));
                }
            }
        }
    }
}

pub struct Layout {
    block: u64,
    pub file: u64,
    offset: u64,
    ctx: Ctx,
    pub runs: Vec<(u64, Vec<u8>)>,
    crc: u32,
}

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
    pub fn start(cfg: &Config, at: Cursor, stay: bool) -> Layout {
        let at = if at.offset >= cfg.file_target && !stay {
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

pub fn max_commit(cfg: &Config) -> u64 {
    (1u64 << FILE_SHIFT) - cfg.file_target - cfg.block_size
}

fn write_round(
    log: &Log,
    tail: &mut TailFile,
    cursor: &mut Cursor,
    batch: &mut VecDeque<Pending>,
    done: &mut Vec<(Pending, LogResult<Vec<u64>>)>,
) -> LogResult<()> {
    let cfg = log.shared.cfg;
    let mut layout = Layout::start(&cfg, *cursor, false);
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

fn write_hooked(path: &Path, file: &File, bytes: &[u8], offset: u64) -> io::Result<()> {
    match crate::faults::write(path, offset, bytes.len())? {
        None => write_all_at(file, bytes, offset),
        Some(n) => {
            write_all_at(file, &bytes[..n], offset)?;
            Err(crate::faults::torn())
        }
    }
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
