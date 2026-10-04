//! A store: the record log (P1) and the derived keyspace (P2) kept in step (design
//! `.plans/2026-10-03-storage-from-needs.md` 3, 4.1–4.4).
//!
//! A store owns no threads: its work runs as activities on the process's engine threads (`keyspace::exec`), one
//! bounded step per task, so stores take turns. Commits go through two activities. The prepare activity takes
//! commits in arrival order and, for each, runs its records' derivers against everything before it (published
//! entries, plus the entries of groups not yet synced), lays the records out in the open group and keeps their
//! entries with it. The sync activity takes the open group whenever no sync is running, writes and syncs it,
//! then publishes its entries to the keyspace's buffer and resolves its commits. So derivation of one group
//! overlaps the sync of the one before, and nothing reads an entry whose record isn't durable.
//!
//! Layout: the log's files in the store's directory, the runs in `runs/`.
//!
//! Memory: every store opened with `Store::open` shares one `Pool`, so the threads, the buffers (B) and the block
//! cache (C) are bounded for the process, not per store; `open_in` takes a pool of its own.
//!
//! Opening never reads more than the runs' footers and top blocks and the log after the newest run's covered
//! position: it probes the log's files upward from that position's file, since cleaning removes only files
//! below it. The prepare activity's first step replays the records after that position into the buffer before taking
//! any commit; reads of derived data wait for it.
//!
//! Cleaning: a log file whose records' dead bytes pass `1 - u` of its size is queued when a flush finds it
//! there. The clean activity copies its live records (each after a `moved` marker naming where it was) to the log's
//! end through the commit path, so the copies' entries are repointed in log order like any commit, then
//! removes the file once the runs cover the log past the copies, so replay never meets a record pointing into
//! it.

pub mod derive;
pub mod kinds;

use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock, Weak};

use derive::{Loc, Out, Pending, View, apply, deriver};
use kinds::{file_of, key};

use crate::keyspace::exec::Activity;
use crate::keyspace::pool::Pool;
use crate::keyspace::run::Run;
use crate::keyspace::val::{Val, counter_value, fold};
use crate::keyspace::{Hooks, Keyspace, KsConfig, KsError, Mem};
use crate::log::format::{FieldRef, Record, Value, kind_by_name};
use crate::log::{self, Cursor, Layout, Log, LogError, Opened, Start, TailFile, max_commit};

#[derive(Debug)]
pub enum StoreError {
    /// A commit that can't be applied; nothing was written.
    Refused(String),
    Log(LogError),
    Ks(KsError),
    /// A derived entry that doesn't hold what its structure says.
    Entry(String),
    /// Replay failed; the store serves nothing until reopened.
    Replay(String),
    /// A write or sync failed; commits fail until the store is reopened.
    Failed(String),
    Closed,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Refused(why) => write!(f, "refused: {why}"),
            StoreError::Log(e) => e.fmt(f),
            StoreError::Ks(e) => e.fmt(f),
            StoreError::Entry(why) => write!(f, "derived entry inconsistent: {why}"),
            StoreError::Replay(why) => write!(f, "replaying the log failed: {why}"),
            StoreError::Failed(why) => write!(
                f,
                "the store stopped after a failed write ({why}); reopen it"
            ),
            StoreError::Closed => write!(f, "the store is closed"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<LogError> for StoreError {
    fn from(e: LogError) -> Self {
        StoreError::Log(e)
    }
}

impl From<KsError> for StoreError {
    fn from(e: KsError) -> Self {
        StoreError::Ks(e)
    }
}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Log(LogError::Io(e))
    }
}

pub type StoreResult<T> = Result<T, StoreError>;

#[derive(Debug, Clone, Copy)]
pub struct StoreConfig {
    pub log: log::Config,
    pub ks: KsConfig,
    /// u: a log file is cleaned once less than this fraction of its bytes is live.
    pub live_fraction: f64,
    /// Bytes of records the cleaner hands the commit path at a time.
    pub relocate_bytes: u64,
}

impl Default for StoreConfig {
    fn default() -> Self {
        StoreConfig {
            log: log::Config::default(),
            ks: KsConfig {
                log_bytes: LOG_BYTES,
                fan_in: FAN_IN,
                block_size: RUN_BLOCK_SIZE,
                max_frozen: 1,
            },
            live_fraction: LIVE_FRACTION,
            relocate_bytes: 256 << 10,
        }
    }
}

// Provisional, set from measurements at 10^6–10^8 entries: the plan's stage 3 records them and the reasons.
/// B, shared by every store in the process (`Pool`).
pub const BUFFER_BYTES: usize = 64 << 20;
/// L.
pub const LOG_BYTES: u64 = 64 << 20;
/// δ.
pub const FAN_IN: usize = 4;
/// C, shared by every store in the process.
pub const CACHE_BYTES: usize = 64 << 20;
pub const RUN_BLOCK_SIZE: usize = 16 << 10;
/// u.
pub const LIVE_FRACTION: f64 = 0.5;

/// The engine's threads for the whole process; how many take only short steps (a lone commit is never stuck behind
/// busy stores); and how many flushes and merges may hold at once: the rest are always free for commits.
pub const THREADS: usize = 10;
pub const FRONT_THREADS: usize = 2;
pub const FLUSH_SLOTS: usize = 2;
pub const MERGE_SLOTS: usize = 2;

/// The pool every store opened by `Store::open` shares.
pub fn global_pool() -> Arc<Pool> {
    static POOL: std::sync::OnceLock<Arc<Pool>> = std::sync::OnceLock::new();
    POOL.get_or_init(|| {
        Pool::new(
            BUFFER_BYTES,
            CACHE_BYTES,
            THREADS,
            FRONT_THREADS,
            MERGE_SLOTS,
            FLUSH_SLOTS,
        )
    })
    .clone()
}

pub type CommitDone = Box<dyn FnOnce(StoreResult<Vec<u64>>) + Send>;
type JobDone = Box<dyn FnOnce(StoreResult<()>) + Send>;

enum Job {
    Commit(Vec<Record>, CommitDone),
    /// Records of a file being cleaned, with their positions: the live ones are copied to the log's end.
    Relocate(Vec<(u64, Record)>, JobDone),
}

enum Done {
    Commit(CommitDone, Vec<u64>),
    Job(JobDone),
}

impl Done {
    fn succeed(self) {
        match self {
            Done::Commit(d, positions) => d(Ok(positions)),
            Done::Job(d) => d(Ok(())),
        }
    }

    fn fail(self, why: &str) {
        match self {
            Done::Commit(d, _) => d(Err(StoreError::Failed(why.into()))),
            Done::Job(d) => d(Err(StoreError::Failed(why.into()))),
        }
    }
}

/// Commits laid out for one sync, with their entries and records.
#[derive(Default)]
struct Group {
    layout: Option<Layout>,
    dones: Vec<Done>,
    entries: BTreeMap<Vec<u8>, Val>,
    records: Pending,
}

struct Pipe {
    queue: VecDeque<Job>,
    /// Where the next group starts.
    cursor: Cursor,
    open: Group,
    /// The group being synced: its entries and records are seen by the prepare activity until published.
    syncing: Option<Group>,
    closed: bool,
    failed: Option<String>,
}

enum Replay {
    Running(Vec<Box<dyn FnOnce() + Send>>),
    Done,
    Failed(String),
}

#[derive(Default)]
struct Counters {
    replay_bytes: AtomicU64,
    replay_records: AtomicU64,
    replay_micros: AtomicU64,
    cleaned_files: AtomicU64,
    relocated_records: AtomicU64,
    relocated_bytes: AtomicU64,
    removed_bytes: AtomicU64,
}

/// Counts kept for measurement.
#[derive(Debug, Default, Clone, Copy)]
pub struct StoreStats {
    pub log_rounds: u64,
    pub log_bytes: u64,
    pub ks: crate::keyspace::KsStats,
    pub replay_bytes: u64,
    pub replay_records: u64,
    pub replay_micros: u64,
    pub cleaned_files: u64,
    pub relocated_records: u64,
    pub relocated_bytes: u64,
    /// Bytes of log files removed after cleaning.
    pub removed_bytes: u64,
}

struct Inner {
    me: Weak<Inner>,
    cfg: StoreConfig,
    log: Log,
    ks: Arc<Keyspace>,
    pipe: Mutex<Pipe>,
    /// The tail file's write handle, used by the sync activity only.
    tail: Mutex<TailFile>,
    /// Replays first, then lays out one job per step.
    prepare_act: Arc<Activity>,
    /// Writes, syncs and publishes one group per step.
    sync_act: Arc<Activity>,
    clean_act: Arc<Activity>,
    /// Where replay starts; `replayed` once it has run.
    replay_from: u64,
    replayed: AtomicBool,
    ready: Mutex<Replay>,
    ready_cv: Condvar,
    /// Held for reading across an entry lookup and the log read it leads to; for writing to remove a file.
    gate: RwLock<()>,
    clean: Mutex<CleanState>,
    /// Signalled when cleaning's state changes (for `Store::clean`).
    clean_cv: Condvar,
    counters: Counters,
}

#[derive(Default)]
struct CleanState {
    stop: bool,
    /// The file being cleaned and where its next unread record is.
    file: Option<(u64, u64)>,
    /// A batch of its records is in the commit path.
    relocating: bool,
}

pub struct Store {
    inner: Arc<Inner>,
    closed: AtomicBool,
}

impl Store {
    /// Opens the store in `dir` (created if missing). Returns before replay; reads wait for it, and commits
    /// are taken after it.
    pub fn open(dir: &Path, cfg: StoreConfig) -> StoreResult<Store> {
        Store::open_in(dir, cfg, global_pool())
    }

    /// Opens the store in `dir` sharing `pool`'s buffer budget, block cache and flush and merge slots.
    pub fn open_in(dir: &Path, cfg: StoreConfig, pool: Arc<Pool>) -> StoreResult<Store> {
        let ks = Keyspace::open(&dir.join("runs"), cfg.ks, pool)?;
        let covered = ks.covered();
        let start = if ks.has_runs() {
            Start::From(file_of(covered))
        } else {
            Start::List
        };
        let Opened {
            log,
            cursor,
            tail,
            first_file,
        } = Log::open_parts(dir, cfg.log, start)?;
        if !ks.has_runs() && first_file.is_some_and(|f| f != 0) {
            return Err(StoreError::Ks(KsError::Corrupt {
                file: dir.join("runs").display().to_string(),
                why: format!(
                    "no runs, but the log starts at file {}: the runs that covered its cleaned files are \
                     missing",
                    first_file.unwrap()
                ),
            }));
        }
        if log.durable_end() < covered {
            return Err(StoreError::Ks(KsError::Corrupt {
                file: dir.display().to_string(),
                why: format!(
                    "the runs cover the log up to {covered}, but it ends at {}",
                    log.durable_end()
                ),
            }));
        }
        let exec = &ks.pool().exec;
        let inner = Arc::new_cyclic(|me: &Weak<Inner>| {
            let activity = |step: fn(&Inner) -> bool| {
                let a = Activity::new(exec);
                let me = me.clone();
                a.set_step(Box::new(move || me.upgrade().is_some_and(|i| step(&i))));
                a
            };
            Inner {
                me: me.clone(),
                cfg,
                log,
                ks: ks.clone(),
                pipe: Mutex::new(Pipe {
                    queue: VecDeque::new(),
                    cursor,
                    open: Group::default(),
                    syncing: None,
                    closed: false,
                    failed: None,
                }),
                tail: Mutex::new(tail),
                prepare_act: activity(Inner::prepare_step),
                sync_act: activity(Inner::sync_step),
                clean_act: activity(Inner::clean_step),
                replay_from: covered,
                replayed: AtomicBool::new(false),
                ready: Mutex::new(Replay::Running(Vec::new())),
                ready_cv: Condvar::new(),
                gate: RwLock::new(()),
                clean: Mutex::new(CleanState::default()),
                clean_cv: Condvar::new(),
                counters: Counters::default(),
            }
        });
        ks.start(Box::new(StoreHooks(Arc::downgrade(&inner))))?;
        inner.prepare_act.kick();
        Ok(Store {
            inner,
            closed: AtomicBool::new(false),
        })
    }

    /// Commits `records` together: `done` gets each record's position once all are durable and their entries
    /// published, or the reason none was written.
    pub fn commit(&self, records: Vec<Record>, done: CommitDone) {
        if let Some(r) = records.iter().find(|r| r.kind.internal) {
            return done(Err(StoreError::Refused(format!(
                "{} records are written by the engine only",
                r.kind.name
            ))));
        }
        self.inner.submit(Job::Commit(records, done));
    }

    pub fn commit_wait(&self, records: Vec<Record>) -> StoreResult<Vec<u64>> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.commit(records, Box::new(move |r| drop(tx.send(r))));
        rx.recv().unwrap_or(Err(StoreError::Closed))
    }

    /// While replay runs, keeps `f` to run on the replaying engine thread once it ends (however it ends) and
    /// returns None; after, hands `f` back. `f` must not wait for the engine (a commit, a flush).
    pub fn after_replay(&self, f: Box<dyn FnOnce() + Send>) -> Option<Box<dyn FnOnce() + Send>> {
        match &mut *self.inner.ready.lock().unwrap() {
            Replay::Running(waiting) => {
                waiting.push(f);
                None
            }
            _ => Some(f),
        }
    }

    /// Whether replay is done, without waiting.
    pub fn is_ready(&self) -> StoreResult<bool> {
        match &*self.inner.ready.lock().unwrap() {
            Replay::Running(_) => Ok(false),
            Replay::Done => Ok(true),
            Replay::Failed(why) => Err(StoreError::Replay(why.clone())),
        }
    }

    /// Waits for replay.
    pub fn wait_ready(&self) -> StoreResult<()> {
        self.inner.wait_ready()
    }

    pub fn keyspace(&self) -> &Keyspace {
        &self.inner.ks
    }

    pub fn log(&self) -> &Log {
        &self.inner.log
    }

    /// A derived value read: waits for replay, and holds off file removal between finding a position and
    /// reading it.
    fn derived<T>(&self, f: impl FnOnce(&View) -> StoreResult<T>) -> StoreResult<T> {
        self.inner.wait_ready()?;
        let _g = self.inner.gate.read().unwrap();
        let view = View {
            layers: Vec::new(),
            pending: Vec::new(),
            ks: &self.inner.ks,
            log: &self.inner.log,
        };
        f(&view)
    }

    pub fn fav(&self, entity: u64) -> StoreResult<Option<bool>> {
        self.derived(|v| {
            let Some(b) = v.get(&key::id(key::FAV, entity))? else {
                return Ok(None);
            };
            let (rec, _) = v.record(kinds::parse_loc(&b)?.pos)?;
            Ok(Some(rec.values[1] == Value::Bit(true)))
        })
    }

    /// A text field's value, WTF-8.
    pub fn text(&self, entity: u64, field: &FieldRef) -> StoreResult<Option<Vec<u8>>> {
        self.derived(|v| kinds::text_value(v, entity, field))
    }

    /// The position of the entity's latest record.
    pub fn version(&self, entity: u64) -> StoreResult<Option<u64>> {
        self.derived(|v| {
            v.get(&key::id(key::VERSION, entity))?
                .map(|b| kinds::parse_pos(&b))
                .transpose()
        })
    }

    /// A derived entry's value.
    pub fn get(&self, key: &[u8]) -> StoreResult<Option<Vec<u8>>> {
        self.derived(|v| v.get(key))
    }

    /// Up to `limit` derived entries in `[start, end)`.
    pub fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> StoreResult<Vec<(Vec<u8>, Vec<u8>)>> {
        self.derived(|v| v.scan(start, end, limit))
    }

    pub fn read(&self, pos: u64) -> StoreResult<Record> {
        Ok(self.inner.log.read(pos)?)
    }

    /// The change feed: up to `limit` records committed from `from` (0 or a `next` returned here) on, and the
    /// position to continue from. Cleaning's copies aren't changes and are left out; a position in a file
    /// cleaning removed is `LogError::Gone`.
    pub fn feed(&self, from: u64, limit: usize) -> StoreResult<(Vec<(u64, Record)>, u64)> {
        let mut out = Vec::new();
        let mut next = from;
        // The record after a `moved` marker is its copy.
        let mut copy = false;
        loop {
            let (batch, batch_next) = self.inner.log.iterate(next, limit.clamp(1, 4096) + 1)?;
            if batch.is_empty() {
                return Ok((out, batch_next));
            }
            for (p, r) in batch {
                if out.len() == limit && !copy {
                    return Ok((out, p));
                }
                if std::mem::take(&mut copy) {
                    continue;
                }
                if r.kind.name == "moved" {
                    copy = true;
                    continue;
                }
                out.push((p, r));
            }
            next = batch_next;
        }
    }

    pub fn durable_end(&self) -> u64 {
        self.inner.log.durable_end()
    }

    pub fn stats(&self) -> StoreStats {
        let l = self.inner.log.stats();
        let c = &self.inner.counters;
        StoreStats {
            log_rounds: l.rounds,
            log_bytes: l.bytes,
            ks: self.inner.ks.stats(),
            replay_bytes: c.replay_bytes.load(Ordering::Relaxed),
            replay_records: c.replay_records.load(Ordering::Relaxed),
            replay_micros: c.replay_micros.load(Ordering::Relaxed),
            cleaned_files: c.cleaned_files.load(Ordering::Relaxed),
            relocated_records: c.relocated_records.load(Ordering::Relaxed),
            relocated_bytes: c.relocated_bytes.load(Ordering::Relaxed),
            removed_bytes: c.removed_bytes.load(Ordering::Relaxed),
        }
    }

    /// Runs the cleaner now, without waiting for a flush to wake it.
    pub fn wake_cleaner(&self) {
        self.inner.clean_act.kick();
    }

    /// Cleans until nothing queued is left to clean: removes cleaned files the runs now cover past, and cleans
    /// every file queued that they cover. Not from an engine thread.
    pub fn clean(&self) -> StoreResult<()> {
        self.inner.wait_ready()?;
        self.inner.clean_act.kick();
        let mut c = self.inner.clean.lock().unwrap();
        loop {
            drop(c);
            self.inner.clean_act.wait_idle();
            c = self.inner.clean.lock().unwrap();
            if !c.relocating {
                return Ok(());
            }
            c = self.inner.clean_cv.wait(c).unwrap();
        }
    }

    /// Finishes queued commits and stops: later commits fail with `Closed`. With `flush`, the buffer is flushed
    /// so the next open replays nothing. Not from an engine thread.
    fn shut(&self, flush: bool) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let i = &self.inner;
        i.clean.lock().unwrap().stop = true;
        i.pipe.lock().unwrap().closed = true;
        loop {
            i.prepare_act.kick();
            i.sync_act.kick();
            i.prepare_act.wait_idle();
            i.sync_act.wait_idle();
            let p = i.pipe.lock().unwrap();
            if p.queue.is_empty() && p.open.dones.is_empty() && p.syncing.is_none() {
                break;
            }
            drop(p);
            // The sync step may be waiting for room that another store's flush frees.
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        i.clean_act.wait_idle();
        if flush && i.is_ready() {
            i.ks.freeze_at(i.log.durable_end());
            // If the flush fails, the next open replays what it held.
            let _ = i.ks.wait_flushed();
        }
        i.ks.stop();
    }

    /// Finishes queued commits, flushes the buffer so the next open replays nothing, and stops. Later commits
    /// fail with `Closed`.
    pub fn close(&self) {
        self.shut(true);
    }

    /// Stops as a crash would, with nothing flushed (for tests of replay).
    #[cfg(test)]
    fn abandon(&self) {
        self.shut(false);
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        self.close();
    }
}

impl Inner {
    fn submit(&self, job: Job) {
        let mut p = self.pipe.lock().unwrap();
        if p.closed {
            drop(p);
            return fail_job(job, StoreError::Closed);
        }
        p.queue.push_back(job);
        drop(p);
        self.prepare_act.kick();
    }

    fn is_ready(&self) -> bool {
        matches!(*self.ready.lock().unwrap(), Replay::Done)
    }

    fn wait_ready(&self) -> StoreResult<()> {
        let mut r = self.ready.lock().unwrap();
        loop {
            match &*r {
                Replay::Running(_) => r = self.ready_cv.wait(r).unwrap(),
                Replay::Done => return Ok(()),
                Replay::Failed(why) => return Err(StoreError::Replay(why.clone())),
            }
        }
    }

    fn set_ready(&self, result: Result<(), String>) {
        let waiting = {
            let mut r = self.ready.lock().unwrap();
            let next = match result {
                Ok(()) => Replay::Done,
                Err(why) => Replay::Failed(why),
            };
            match std::mem::replace(&mut *r, next) {
                Replay::Running(w) => w,
                _ => Vec::new(),
            }
        };
        self.ready_cv.notify_all();
        for f in waiting {
            f();
        }
    }

    fn view<'a>(
        &'a self,
        layers: Vec<&'a BTreeMap<Vec<u8>, Val>>,
        pending: Vec<&'a Pending>,
    ) -> View<'a> {
        View {
            layers,
            pending,
            ks: &self.ks,
            log: &self.log,
        }
    }

    // ---- replay ----

    /// Derives the records after `from` into the buffer, as at their commits.
    fn replay(&self, from: u64) -> StoreResult<()> {
        let started = std::time::Instant::now();
        let end = self.log.durable_end();
        let mut entries = BTreeMap::new();
        let mut next = from;
        let mut moved_from = None;
        let mut records = 0;
        loop {
            let (batch, batch_next) = self.log.iterate_sized(next, 4096)?;
            if batch.is_empty() {
                break;
            }
            for (pos, rec, len) in batch {
                records += 1;
                if rec.kind.name == "moved" {
                    moved_from = Some(match rec.values[0] {
                        Value::Id(p) => p,
                        _ => unreachable!(),
                    });
                    continue;
                }
                let mut out = Out::default();
                let view = self.view(vec![&entries], Vec::new());
                let at = Loc { pos, len };
                let d = deriver(rec.kind);
                match moved_from.take() {
                    Some(from) => d.repoint(&rec, from, at, &view, &mut out),
                    None => d.derive(&rec, at, &view, &mut out),
                }
                .map_err(|e| {
                    StoreError::Replay(format!("the {} record at {pos}: {e}", rec.kind.name))
                })?;
                out.apply(&mut entries);
            }
            next = batch_next;
        }
        self.counters
            .replay_records
            .store(records, Ordering::Relaxed);
        let bytes = self.log_bytes_between(from, end)?;
        self.counters.replay_bytes.store(bytes, Ordering::Relaxed);
        self.ks.insert(entries, Some((end, bytes)));
        self.counters
            .replay_micros
            .store(started.elapsed().as_micros() as u64, Ordering::Relaxed);
        Ok(())
    }

    /// Bytes of log from `from` to `end`.
    fn log_bytes_between(&self, from: u64, end: u64) -> StoreResult<u64> {
        let offset = |p: u64| p & ((1 << log::FILE_SHIFT) - 1);
        let mut bytes = 0;
        for f in file_of(from)..=file_of(end) {
            let to = if f == file_of(end) {
                offset(end)
            } else {
                std::fs::metadata(self.log.file_path(f))?.len()
            };
            bytes += to - if f == file_of(from) { offset(from) } else { 0 };
        }
        Ok(bytes)
    }

    // ---- the prepare activity ----

    /// Replays (first step only), then lays out the next queued job.
    fn prepare_step(&self) -> bool {
        if !self.replayed.load(Ordering::Acquire) {
            let replayed = self.replay(self.replay_from).map_err(|e| e.to_string());
            if let Err(why) = &replayed {
                self.pipe.lock().unwrap().failed = Some(why.clone());
            }
            self.replayed.store(true, Ordering::Release);
            self.set_ready(replayed);
            self.clean_act.kick();
            return true;
        }
        let mut p = self.pipe.lock().unwrap();
        // A full open group waits for the sync step to take it; with no room in the pool, nothing more is
        // prepared either, so entries waiting to be published stay within what the pool's flushes can free.
        let full = p
            .open
            .layout
            .as_ref()
            .is_some_and(|l| l.offset() >= self.cfg.log.file_target);
        if full || p.queue.is_empty() || !self.ks.pool().room_or_wait(&self.prepare_act) {
            return false;
        }
        let Some(job) = p.queue.pop_front() else {
            return false;
        };
        if let Some(why) = &p.failed {
            let e = StoreError::Failed(why.clone());
            drop(p);
            fail_job(job, e);
            return true;
        }
        self.prepare(&mut p, job);
        let more = !p.queue.is_empty();
        drop(p);
        self.sync_act.kick();
        more
    }

    /// Lays out one job in the open group with its entries, or fails it, writing nothing of it.
    fn prepare(&self, p: &mut Pipe, job: Job) {
        let Pipe {
            cursor,
            open,
            syncing,
            ..
        } = p;
        let layout = open
            .layout
            .get_or_insert_with(|| Layout::start(&self.cfg.log, *cursor));
        let mark = layout.mark();
        let mut entries = BTreeMap::new();
        let mut records = Pending::new();
        let mut layers_below: Vec<&BTreeMap<Vec<u8>, Val>> = vec![&open.entries];
        let mut pending_below: Vec<&Pending> = vec![&open.records];
        if let Some(s) = syncing.as_ref() {
            layers_below.push(&s.entries);
            pending_below.push(&s.records);
        }
        let result = (|| -> StoreResult<Vec<u64>> {
            let mut positions = Vec::new();
            let step = |layout: &mut Layout,
                        entries: &mut BTreeMap<Vec<u8>, Val>,
                        records: &mut Pending,
                        rec: Record,
                        moved_from: Option<u64>|
             -> StoreResult<Option<u64>> {
                let d = deriver(rec.kind);
                let layers = [&*entries]
                    .into_iter()
                    .chain(layers_below.iter().copied())
                    .collect();
                let pending = [&*records]
                    .into_iter()
                    .chain(pending_below.iter().copied())
                    .collect();
                let view = self.view(layers, pending);
                let rec = match moved_from {
                    Some(from) => {
                        if !d.is_live(&rec, from, &view)? {
                            return Ok(None);
                        }
                        let marker =
                            Record::new(kind_by_name("moved").unwrap(), vec![Value::Id(from)])
                                .expect("a moved record");
                        let (mpos, mlen) = layout.record(&marker);
                        drop(view);
                        records.insert(mpos, (marker, mlen));
                        rec
                    }
                    None => {
                        let rec = d.prepare(rec, &view)?;
                        drop(view);
                        rec
                    }
                };
                let d = deriver(rec.kind);
                let (pos, len) = layout.record(&rec);
                let at = Loc { pos, len };
                let mut out = Out::default();
                {
                    let layers = [&*entries]
                        .into_iter()
                        .chain(layers_below.iter().copied())
                        .collect();
                    let pending = [&*records]
                        .into_iter()
                        .chain(pending_below.iter().copied())
                        .collect();
                    let view = self.view(layers, pending);
                    match moved_from {
                        Some(from) => d.repoint(&rec, from, at, &view, &mut out)?,
                        None => d.derive(&rec, at, &view, &mut out)?,
                    }
                }
                records.insert(pos, (rec, len));
                out.apply(entries);
                Ok(Some(pos))
            };
            match &job {
                Job::Commit(recs, _) => {
                    for r in recs {
                        let pos = step(layout, &mut entries, &mut records, r.clone(), None)?;
                        positions.push(pos.unwrap());
                    }
                }
                Job::Relocate(recs, _) => {
                    for (from, r) in recs {
                        if r.kind.name == "moved" {
                            continue;
                        }
                        if step(layout, &mut entries, &mut records, r.clone(), Some(*from))?
                            .is_some()
                        {
                            self.counters
                                .relocated_records
                                .fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
            }
            let size = layout.offset() - mark.offset();
            if size > max_commit(&self.cfg.log) {
                return Err(StoreError::Refused(format!(
                    "a commit of {size} bytes is larger than a log file can hold"
                )));
            }
            Ok(positions)
        })();
        match result {
            Ok(positions) => {
                if layout.is_empty() {
                    open.layout = None;
                }
                for (k, v) in entries {
                    apply(&mut open.entries, k, v);
                }
                if let Job::Relocate(..) = job {
                    let bytes: u64 = records.values().map(|(_, l)| *l).sum();
                    self.counters
                        .relocated_bytes
                        .fetch_add(bytes, Ordering::Relaxed);
                }
                open.records.extend(records);
                open.dones.push(match job {
                    Job::Commit(_, d) => Done::Commit(d, positions),
                    Job::Relocate(_, d) => Done::Job(d),
                });
            }
            Err(e) => {
                layout.restore(mark);
                if layout.is_empty() {
                    open.layout = None;
                }
                fail_job(job, e);
            }
        }
    }

    // ---- the sync activity ----

    /// Writes, syncs and publishes the open group, once the pool has room for its entries.
    fn sync_step(&self) -> bool {
        let mut p = self.pipe.lock().unwrap();
        if p.open.dones.is_empty() || !self.ks.pool().room_or_wait(&self.sync_act) {
            return false;
        }
        let mut group = std::mem::take(&mut p.open);
        let dones = std::mem::take(&mut group.dones);
        // A group of jobs that wrote nothing (an empty commit, a relocation whose records had all died) still
        // resolves in its turn: after every group before it has published.
        let Some(layout) = group.layout.as_mut() else {
            drop(p);
            for d in dones {
                d.succeed();
            }
            return true;
        };
        let end = layout.close();
        p.cursor = end;
        let (file, runs) = (layout.file, std::mem::take(&mut layout.runs));
        p.syncing = Some(group);
        drop(p);
        // A full open group may now take more.
        self.prepare_act.kick();
        let written = self.tail.lock().unwrap().write(&self.log, file, &runs);
        let mut p = self.pipe.lock().unwrap();
        let group = p.syncing.take().unwrap();
        match written {
            Ok(bytes) => {
                self.log.set_durable(end);
                self.ks
                    .insert(group.entries, Some((position_of(end), bytes)));
                drop(p);
                for d in dones {
                    d.succeed();
                }
            }
            Err(e) => {
                // What reached the file is unknown, so nothing more is appended; reopening recovers to the
                // last group whose checksum holds. Groups prepared on top of this one fail with it.
                let why = e.to_string();
                p.failed = Some(why.clone());
                let open = std::mem::take(&mut p.open);
                let queued: Vec<Job> = p.queue.drain(..).collect();
                drop(p);
                for d in dones.into_iter().chain(open.dones) {
                    d.fail(&why);
                }
                for j in queued {
                    fail_job(j, StoreError::Failed(why.clone()));
                }
            }
        }
        true
    }

    // ---- cleaning ----

    /// One step of cleaning: hands the next batch of the file being cleaned to the commit path (and waits, by
    /// returning, for it to come back), finishes the file, or picks the next one.
    fn clean_step(&self) -> bool {
        if !self.is_ready() {
            return false;
        }
        match self.clean_next() {
            Ok(more) => more,
            Err(e) => {
                eprintln!("st-engine: cleaning the log failed: {e}");
                let mut c = self.clean.lock().unwrap();
                c.file = None;
                self.clean_cv.notify_all();
                false
            }
        }
    }

    fn clean_next(&self) -> StoreResult<bool> {
        let mut c = self.clean.lock().unwrap();
        if c.stop || c.relocating {
            return Ok(false);
        }
        let Some((file, next)) = c.file else {
            drop(c);
            self.remove_cleaned()?;
            let Some(file) = self.next_to_clean()? else {
                return Ok(false);
            };
            self.clean.lock().unwrap().file = Some((file, log::position(file, 0)));
            return Ok(true);
        };
        let mut batch = Vec::new();
        let (mut at, mut bytes) = (next, 0);
        while bytes < self.cfg.relocate_bytes && file_of(at) == file {
            let (recs, n) = self.log.iterate_file(at, 256)?;
            for (pos, rec, len) in recs {
                bytes += len;
                batch.push((pos, rec));
            }
            at = n;
        }
        if batch.is_empty() {
            c.file = None;
            drop(c);
            self.ks.insert(
                [
                    (key::id(key::DEAD, file), Val::Del),
                    (key::id(key::CLEAN, file), Val::Del),
                    (
                        key::id(key::GONE, file),
                        Val::Put(kinds::pos_bytes(self.log.durable_end())),
                    ),
                ],
                None,
            );
            self.counters.cleaned_files.fetch_add(1, Ordering::Relaxed);
            self.clean_cv.notify_all();
            return Ok(true);
        }
        c.file = Some((file, at));
        c.relocating = true;
        drop(c);
        self.submit(Job::Relocate(batch, self.relocated()));
        Ok(false)
    }

    /// What a relocation batch does when it comes back: lets cleaning go on (from the file's start again, if
    /// the batch failed).
    fn relocated(&self) -> JobDone {
        let me = self.me.clone();
        Box::new(move |r| {
            let Some(i) = me.upgrade() else { return };
            {
                let mut c = i.clean.lock().unwrap();
                c.relocating = false;
                if let Err(e) = r {
                    eprintln!("st-engine: cleaning the log failed: {e}");
                    c.file = None;
                }
            }
            i.clean_cv.notify_all();
            i.clean_act.kick();
        })
    }

    /// Removes cleaned files the runs now cover past.
    fn remove_cleaned(&self) -> StoreResult<()> {
        let covered = self.ks.covered();
        let gone = key::of(key::GONE);
        for (k, v) in self.ks.scan(&gone, &key::prefix_end(&gone), usize::MAX)? {
            let file = file_from_key(&k)?;
            if kinds::parse_pos(&v)? <= covered {
                let size = std::fs::metadata(self.log.file_path(file)).map_or(0, |m| m.len());
                {
                    let _g = self.gate.write().unwrap();
                    self.log.remove_file(file)?;
                }
                self.counters
                    .removed_bytes
                    .fetch_add(size, Ordering::Relaxed);
                self.ks.insert([(k, Val::Del)], None);
            }
        }
        Ok(())
    }

    /// The next queued file to clean: one the runs cover entirely (opening finds the log's files from the
    /// newest run's file up) and still under u live. Queued files back above u are dequeued.
    fn next_to_clean(&self) -> StoreResult<Option<u64>> {
        let covered = self.ks.covered();
        let queued = key::of(key::CLEAN);
        for (k, _) in self
            .ks
            .scan(&queued, &key::prefix_end(&queued), usize::MAX)?
        {
            let file = file_from_key(&k)?;
            if file >= file_of(covered) {
                continue;
            }
            let dead = self
                .ks
                .get(&key::id(key::DEAD, file))?
                .and_then(|b| counter_value(&b))
                .unwrap_or(0);
            let size = std::fs::metadata(self.log.file_path(file))?.len();
            if (size as f64 - dead as f64) >= self.cfg.live_fraction * size as f64 {
                self.ks.insert([(k, Val::Del)], None);
                continue;
            }
            return Ok(Some(file));
        }
        Ok(None)
    }
}

fn position_of(c: Cursor) -> u64 {
    log::position(c.file, c.offset)
}

fn file_from_key(k: &[u8]) -> StoreResult<u64> {
    let mut at = 0;
    crate::keyspace::val::get_u64(k, &mut at)
        .and_then(|_| crate::keyspace::val::get_u64(k, &mut at))
        .ok_or_else(|| StoreError::Entry("a log file key doesn't decode".into()))
}

fn fail_job(job: Job, e: StoreError) {
    match job {
        Job::Commit(_, d) => d(Err(e)),
        Job::Relocate(_, d) => d(Err(e)),
    }
}

/// Queues log files for cleaning when a flush finds their live fraction under u; wakes the cleaner after it.
struct StoreHooks(Weak<Inner>);

impl Hooks for StoreHooks {
    fn flush_extra(
        &self,
        ks: &Keyspace,
        mem: &Mem,
        older: &[Arc<Run>],
    ) -> Result<Vec<(Vec<u8>, Val)>, KsError> {
        let Some(inner) = self.0.upgrade() else {
            return Ok(Vec::new());
        };
        let dead = key::of(key::DEAD);
        let mut out = Vec::new();
        for (k, v) in mem.range(&dead, &key::prefix_end(&dead)) {
            if !matches!(v, Val::Add(_)) {
                continue;
            }
            let mut vals = vec![v.clone()];
            for r in older {
                if let Some(o) = r.get(k, ks.cache(), &ks.counts)? {
                    let done = !o.is_partial();
                    vals.push(o);
                    if done {
                        break;
                    }
                }
            }
            let total = fold(vals)
                .and_then(Val::resolved)
                .and_then(|b| counter_value(&b))
                .unwrap_or(0);
            let Ok(file) = file_from_key(k) else { continue };
            let Ok(meta) = std::fs::metadata(inner.log.file_path(file)) else {
                continue;
            };
            let size = meta.len() as f64;
            if size - (total as f64) < inner.cfg.live_fraction * size {
                out.push((key::id(key::CLEAN, file), Val::Put(Vec::new())));
            }
        }
        Ok(out)
    }

    fn flushed(&self, _: &Keyspace) {
        if let Some(inner) = self.0.upgrade() {
            inner.clean_act.kick();
        }
    }
}

#[cfg(test)]
mod tests;
