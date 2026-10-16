//! Bulk loads: many records written as one, for imports and one-off conversions. The commit path would derive,
//! buffer, flush and merge per group; a load instead lays its records out in log files of its own, derives
//! their entries on worker threads (each partition's records in order on one worker, `Deriver::partition`),
//! sorts what the workers spill, and merges it once into one run.
//!
//! The load is invisible until it is installed, all at once: its log files are staged in `load/` in the store's
//! directory, numbered right after the log's tail file (commits meanwhile stay in that file), and its run is
//! written there too. Installing holds commits briefly: it flushes the buffer, moves the staged files into the
//! log and puts the run in place as the newest one, covering the log to the load's end. A crash before the
//! files are moved leaves the store as before the load; after, the moved files are part of the log and replay
//! derives them if their run wasn't in place yet. An `install` marker in `load/` lets opening tell which.
//!
//! Records committed meanwhile must not share a partition with the load's (the load derived its partitions'
//! entries from the state before it): installing checks, and refuses the load if any does.
//!
//! The library's numberings (each scope's entities numbered densely for random pages) are shared across
//! partitions, and can't
//! be built again later. So characters and groups load only into a store with none, with nothing committed or
//! derived meanwhile (else the load is refused): every scope is numbered from its name order, read from the
//! workers' spills, and the numberings join the load's run.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs::{self, File};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Mutex, Weak};
use std::thread::JoinHandle;
use std::time::Instant;

use super::derive::{Layer, Loc, Out, Staged, StagedRecords, View, deriver};
use super::{Inner, Loading, Store, StoreError, StoreResult};
use crate::keyspace::cache::Cache;
use crate::keyspace::run::{Merge, ReadCounts, Run, RunIter, RunWriter, Source};
use crate::keyspace::val::Val;
use crate::log::format::{FieldRef, Record, Value};
use crate::log::{self, Cursor, Layout, TailFile};

/// A load's memory budget where the memory available can't be read (`load_budget`).
const LOAD_BUFFER_BYTES: usize = 1 << 30;
/// The least budget share a worker gets, so that what it spills comes in large runs.
const WORKER_BYTES: usize = 256 << 20;
/// Sinks the numberings and the tags' carriers fill at once: the numbers and their hosts' ranks, and the
/// carriers' entries beside their asks or the slots those hold.
const NUMBERING_SINKS: usize = 4;

/// The memory a load may take: half the memory available when it starts, the other half left to the page cache
/// and whatever else runs; `LOAD_BUFFER_BYTES` where that can't be read.
fn load_budget() -> usize {
    #[cfg(not(target_family = "wasm"))]
    {
        let mut s = sysinfo::System::new();
        s.refresh_memory();
        let available = s.available_memory();
        if available > 0 {
            return usize::try_from(available / 2).unwrap_or(usize::MAX);
        }
    }
    LOAD_BUFFER_BYTES
}

/// Workers deriving in parallel: every core but two, left to whatever else runs, and no more than give each
/// `WORKER_BYTES` of `budget`.
fn load_workers(budget: usize) -> usize {
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get().saturating_sub(2));
    cores.min(budget / WORKER_BYTES).max(1)
}

/// Growth of a sink between two measures of what the allocations hold (`memory::committed`).
const STEP: usize = 4 << 20;
/// An encoding's buffer past the sink's bytes: its index blocks and footer.
const ENCODE_SLACK: usize = 64 << 10;

/// What spilling a sink of `bytes` in `len` entries allocates besides the sink: the encoding's buffer, and the
/// larger of the entries sorted out of the sink (while encoding) and the run's copy at its exact size (after).
fn spill_memory(bytes: usize, len: usize) -> usize {
    let sorted = len.saturating_mul(std::mem::size_of::<(Vec<u8>, Val)>());
    bytes
        .saturating_add(ENCODE_SLACK)
        .saturating_add(sorted.max(bytes))
}

/// Targets resident growth from the load's start, falling back to allocator bytes where RSS is unavailable.
/// Reservations cover run encoding and each sink's next measurement step. Pressure evicts held runs first,
/// then cuts sinks to disk. This is not a hard process limit: the host's heap, in-flight records and the current
/// partition can grow outside the sinks. A pressured sink still accumulates one `STEP` before cutting again.
struct Budget {
    limit: usize,
    /// The memory measured when the load started, and how it is measured: the process's resident memory, or
    /// (None) the crate's allocations.
    base: usize,
    resident: Option<Mutex<crate::memory::Resident>>,
    /// Sinks growing at once: the workers', then the numberings'.
    sinks: AtomicUsize,
    /// Bytes spills under way have reserved (`Budget::reserve`).
    reserved: AtomicUsize,
    /// Runs made in memory, oldest first; held while a measure and the reservation it allows are made, so two
    /// threads can't both take the same room.
    held: Mutex<VecDeque<Weak<Run>>>,
    /// The most the allocations have been measured to hold past `base`.
    peak: AtomicUsize,
    /// Runs made in memory; runs written to files, as they were made or later; their bytes.
    kept: AtomicU64,
    files: AtomicU64,
    file_bytes: AtomicU64,
}

/// Bytes reserved under a budget's cap, given back when dropped.
struct Reserved<'a> {
    budget: &'a Budget,
    bytes: usize,
}

impl Drop for Reserved<'_> {
    fn drop(&mut self) {
        self.budget.reserved.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

impl Budget {
    fn new(limit: usize, sinks: usize) -> Budget {
        let mut resident = crate::memory::Resident::new();
        let (base, resident) = match resident.read() {
            Some(rss) => (rss, Some(Mutex::new(resident))),
            None => (crate::memory::committed(), None),
        };
        Budget {
            limit,
            base,
            resident,
            sinks: AtomicUsize::new(sinks),
            reserved: AtomicUsize::new(0),
            held: Mutex::new(VecDeque::new()),
            peak: AtomicUsize::new(0),
            kept: AtomicU64::new(0),
            files: AtomicU64::new(0),
            file_bytes: AtomicU64::new(0),
        }
    }

    fn measure(&self) -> usize {
        let c = self
            .resident
            .as_ref()
            .and_then(|r| r.lock().unwrap().read())
            .unwrap_or_else(crate::memory::committed);
        self.peak
            .fetch_max(c.saturating_sub(self.base), Ordering::Relaxed);
        c
    }

    /// Reserves `more` bytes under the cap, first writing the oldest runs held in memory to their files until
    /// what the allocations hold, the reservations under way, `more` and room for every sink's next step fit.
    /// None where they don't with every run written out.
    fn reserve(&self, more: usize) -> StoreResult<Option<Reserved<'_>>> {
        let cap = self.base.saturating_add(self.limit);
        let mut held = self.held.lock().unwrap();
        loop {
            let room = STEP * self.sinks.load(Ordering::Relaxed);
            let taken = self
                .measure()
                .max(self.base)
                .saturating_add(self.reserved.load(Ordering::Acquire));
            if taken.saturating_add(more).saturating_add(room) <= cap {
                self.reserved.fetch_add(more, Ordering::AcqRel);
                return Ok(Some(Reserved {
                    budget: self,
                    bytes: more,
                }));
            }
            let Some(oldest) = held.pop_front() else {
                return Ok(None);
            };
            if let Some(run) = oldest.upgrade() {
                let n = run.write_out()?;
                if n > 0 {
                    self.files.fetch_add(1, Ordering::Relaxed);
                    self.file_bytes.fetch_add(n, Ordering::Relaxed);
                }
            }
        }
    }

    /// Whether the allocations are, or once runs are written out can be, under the cap (`reserve`).
    fn hold(&self) -> StoreResult<bool> {
        Ok(self.reserve(0)?.is_some())
    }

    /// A sink at `bytes` in `len` entries, measured at `next`: whether it is to be cut, at its `share` with what its
    /// spill allocates (`spill_memory`), or where the allocations can't otherwise be held under the cap.
    fn grown(&self, bytes: usize, len: usize, next: &mut usize, share: usize) -> StoreResult<bool> {
        let mut cut = bytes.saturating_add(spill_memory(bytes, len)) >= share;
        // A caller's heap or a retained allocator page may keep RSS over the target even after every held
        // run is written out. Do not cut again until this sink has accumulated a measurement step: resetting
        // `next` to zero after a spill otherwise writes one tiny run per partition without relieving pressure.
        if bytes >= (*next).max(STEP) {
            *next = bytes.saturating_add(STEP);
            cut |= !self.hold()?;
        }
        Ok(cut)
    }
}

#[cfg(test)]
#[test]
fn external_memory_pressure_does_not_cut_each_small_partition() {
    let budget = Budget::new(64 << 20, 1);
    // Reservations exhaust the target even if unrelated allocations are freed during the test.
    budget.reserved.store(usize::MAX / 2, Ordering::Relaxed);
    for _ in 0..3 {
        let mut next = 0;
        assert!(!budget.grown(1024, 1, &mut next, budget.limit).unwrap());
        assert!(budget.grown(STEP, 100, &mut next, budget.limit).unwrap());
    }
}

/// Partitions go to workers in units of `1 << UNIT_BITS` consecutive ids: a posting block's (`BLOCK_BITS`), so the
/// cards a worker holds between spills share their terms' posting maps instead of each adding its own.
const UNIT_BITS: u32 = crate::search::BLOCK_BITS;
/// Encoded bytes of staged records a worker keeps in hand (`StagedRecords`).
const RECORDS_HELD: u64 = 16 << 20;
/// A sink entry's memory besides its key and value.
const ENTRY_OVERHEAD: usize = 128;

/// Where a load's time went, and what it wrote.
#[derive(Debug, Default, Clone, Copy)]
pub struct LoadStats {
    pub records: u64,
    pub log_bytes: u64,
    /// Laying records out and writing and syncing the staged log files (the caller's thread).
    pub layout_micros: u64,
    /// Waiting for the workers after the last record.
    pub derive_wait_micros: u64,
    /// The workers' time deriving, and writing their spills, summed over workers.
    pub derive_micros: u64,
    pub spill_micros: u64,
    /// The memory it may take (`load_budget`), and the most it was measured to take (`Budget`).
    pub budget_bytes: u64,
    pub peak_bytes: u64,
    /// Runs of the workers' and the numberings' sinks that went to files, as they were made or later, and
    /// their bytes; and the runs made in memory.
    pub spills: u64,
    pub spill_bytes: u64,
    pub kept_runs: u64,
    /// Merging the spills into the load's run.
    pub merge_micros: u64,
    pub run_bytes: u64,
    pub run_entries: u64,
    /// Numbering the library's scopes for random pages, and the entries.
    pub numbers_micros: u64,
    pub number_entries: u64,
    /// Holding commits: waiting for them, flushing the buffer, moving files, putting the run in place.
    pub install_micros: u64,
    pub total_micros: u64,
}

/// A record laid out, with where, and its partition.
type Laid = (Record, Loc, u64);

struct Worker {
    tx: Option<SyncSender<Vec<Laid>>>,
    handle: Option<JoinHandle<StoreResult<Spilled>>>,
}

/// What a worker leaves: its spilled runs (with their spill numbers) and its time.
#[derive(Default)]
struct Spilled {
    runs: Vec<(u64, Arc<Run>)>,
    derive_micros: u64,
    spill_micros: u64,
}

/// A bulk load in progress (`Store::loader`). Dropped without `finish`, it is abandoned and leaves the store as
/// it was.
pub struct Loader {
    inner: Arc<Inner>,
    dir: PathBuf,
    first_file: u64,
    layout: Layout,
    batch: Vec<Laid>,
    workers: Vec<Worker>,
    /// Where the log goes on after the last file written.
    end: Option<Cursor>,
    stats: LoadStats,
    started: Instant,
    failed: Option<String>,
    finished: bool,
    /// Installing failed after the install marker was written: the staging stays for opening to resolve.
    keep_staging: bool,
    /// The store had no characters or groups when the load started: a load of some numbers them.
    library_empty: bool,
    /// The memory its sinks and the runs it keeps in memory take.
    budget: Arc<Budget>,
    /// Each message this load appends, and its owner (`message_partition`).
    owners: HashMap<u64, u64>,
    /// Tests stop the install as a crash would: 1 after the marker, 2 after the files moved.
    #[cfg(test)]
    fail_at: u8,
}

impl Store {
    /// Starts a bulk load. Only one runs at a time; commits go on meanwhile.
    pub fn loader(&self) -> StoreResult<Loader> {
        self.loader_in(None)
    }

    /// `loader`, its memory budget `budget` bytes in place of `load_budget`'s.
    pub fn loader_in(&self, budget: Option<usize>) -> StoreResult<Loader> {
        let inner = &self.inner;
        inner.wait_ready()?;
        let dir = inner.dir.join(LOAD_DIR);
        let first_file = {
            let mut p = inner.pipe.lock().unwrap();
            if inner.jobs.lock().unwrap().closed {
                return Err(StoreError::Closed);
            }
            if p.loading.is_some() {
                return Err(StoreError::Refused("a bulk load is already running".into()));
            }
            p.loading = Some(Loading::default());
            // The open group's file, or the cursor's: commits stay in it while the load runs.
            p.open.layout.as_ref().map_or(p.cursor.file, |l| l.file) + 1
        };
        let start = || -> StoreResult<()> {
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir)?;
            Ok(())
        };
        if let Err(e) = start() {
            inner.pipe.lock().unwrap().loading = None;
            return Err(e);
        }
        let library_empty = match no_library(&inner.ks) {
            Ok(x) => x,
            Err(e) => {
                inner.pipe.lock().unwrap().loading = None;
                return Err(e);
            }
        };
        let seq = Arc::new(AtomicU64::new(0));
        let limit = budget.unwrap_or_else(load_budget);
        let count = load_workers(limit);
        let budget = Arc::new(Budget::new(limit, count));
        eprintln!(
            "st-engine: a bulk load's memory budget is {} MiB, over {count} workers",
            budget.limit >> 20
        );
        let workers = (0..count)
            .map(|w| {
                let (tx, rx) = sync_channel::<Vec<Laid>>(4);
                let inner = inner.clone();
                let dir = dir.clone();
                let seq = seq.clone();
                let budget = budget.clone();
                let staged_from = log::position(first_file, 0);
                let handle = std::thread::Builder::new()
                    .name(format!("st-engine-load-{w}"))
                    .spawn(move || work(&inner, w, rx, &dir, staged_from, &budget, count, &seq))
                    .expect("a load worker thread");
                Worker {
                    tx: Some(tx),
                    handle: Some(handle),
                }
            })
            .collect();
        Ok(Loader {
            inner: inner.clone(),
            dir,
            first_file,
            layout: Layout::start(&inner.cfg.log, Cursor::file_start(first_file), false),
            batch: Vec::new(),
            workers,
            end: None,
            started: Instant::now(),
            failed: None,
            finished: false,
            keep_staging: false,
            library_empty,
            stats: LoadStats {
                budget_bytes: budget.limit as u64,
                ..LoadStats::default()
            },
            budget,
            owners: HashMap::new(),
            #[cfg(test)]
            fail_at: 0,
        })
    }
}

/// Whether no scope counts a character or group, no tag is placed and none was ever assigned.
fn no_library(ks: &crate::keyspace::Keyspace) -> StoreResult<bool> {
    use super::kinds::key;
    for structure in [key::COUNT, key::TAG_PART_COUNT] {
        let counts = key::of(structure);
        for (_, v) in ks.scan(&counts, &key::prefix_end(&counts), usize::MAX)? {
            if crate::keyspace::val::counter_value(&v).unwrap_or(0) > 0 {
                return Ok(false);
            }
        }
    }
    // And no assignment: a load numbers and maps its tags as new ones.
    let carried = key::of(key::MEMBER_COUNT);
    Ok(ks.scan(&carried, &key::prefix_end(&carried), 1)?.is_empty())
}

pub(super) const LOAD_DIR: &str = "load";

const MARKER: &str = "install";

impl Loader {
    #[cfg(test)]
    pub(super) fn fail_at(&mut self, point: u8) {
        self.fail_at = point;
    }

    /// Adds records to the load. A refusal (an engine-only kind, or a kind whose commit changes the record)
    /// fails the whole load.
    pub fn add(&mut self, records: impl IntoIterator<Item = Record>) -> StoreResult<()> {
        if let Some(why) = &self.failed {
            return Err(StoreError::Failed(why.clone()));
        }
        let t = Instant::now();
        let r = self.add_inner(records);
        self.stats.layout_micros += t.elapsed().as_micros() as u64;
        if let Err(e) = &r {
            self.failed = Some(e.to_string());
        }
        r
    }

    fn add_inner(&mut self, records: impl IntoIterator<Item = Record>) -> StoreResult<()> {
        let target = self.inner.cfg.log.file_target;
        for rec in records {
            let d = deriver(rec.kind);
            if rec.kind.internal || d.prepares() {
                return Err(StoreError::Refused(format!(
                    "{} records can't be bulk loaded",
                    rec.kind.name
                )));
            }
            let partition = match self.message_partition(&rec) {
                Some(owner) => owner,
                None => d.partition(&rec),
            };
            let (pos, len) = self.layout.record(&rec);
            self.batch.push((rec, Loc { pos, len }, partition));
            self.stats.records += 1;
            if self.layout.offset() >= target {
                self.close_file()?;
                self.layout = Layout::start(
                    &self.inner.cfg.log,
                    Cursor::file_start(self.layout.file + 1),
                    false,
                );
            }
        }
        Ok(())
    }

    /// The partition of a record about a message this load appends: its owner's, where the append and everything
    /// else of the message (its values, times, key, itemization, state changes) and of its tree is derived in order.
    /// A record about a tree's root (a state change there) is the tree's. None: the kind's own partition.
    fn message_partition(&mut self, rec: &Record) -> Option<u64> {
        use crate::log::format::{Space, Ty};
        if rec.kind.name == "messageAppend" {
            let (m, owner) = (
                super::kinds::id(rec, super::chat::APPEND_ID),
                super::kinds::id(rec, super::chat::APPEND_OWNER),
            );
            self.owners.insert(m, owner);
            return Some(owner);
        }
        for (slot, v) in rec.kind.slots.iter().zip(&rec.values) {
            let message = match (slot.ty, v) {
                (Ty::Id(Space::Message), Value::Id(m)) => *m,
                (Ty::Sel(spaces), Value::Sel(i, id)) => match spaces.get(*i as usize) {
                    Some((Space::Message, _)) => *id,
                    Some((Space::Entity, _)) if rec.kind.name == "stateChange" => return Some(*id),
                    _ => continue,
                },
                _ => continue,
            };
            return self.owners.get(&message).copied();
        }
        None
    }

    /// Ends the open file's group, writes and syncs it in the staging directory, and hands its records to the
    /// workers.
    fn close_file(&mut self) -> StoreResult<()> {
        self.end = Some(self.layout.close());
        let log = &self.inner.log;
        self.stats.log_bytes += log.write_staged(&self.dir, self.layout.file, &self.layout.runs)?;
        let mut per: Vec<Vec<Laid>> = (0..self.workers.len()).map(|_| Vec::new()).collect();
        for laid in self.batch.drain(..) {
            let w = (laid.2 >> UNIT_BITS) as usize % per.len();
            per[w].push(laid);
        }
        for (w, recs) in per.into_iter().enumerate() {
            if recs.is_empty() {
                continue;
            }
            let sent = self.workers[w]
                .tx
                .as_ref()
                .is_some_and(|tx| tx.send(recs).is_ok());
            if !sent {
                // A closed receiver means this worker has returned. Preserve its actual
                // error: callers commonly abandon after add fails instead of calling finish.
                let worker = &mut self.workers[w];
                drop(worker.tx.take());
                return Err(match worker.handle.take().map(|h| h.join()) {
                    Some(Ok(Err(error))) => error,
                    Some(Err(_)) => StoreError::Failed("a load worker panicked".into()),
                    _ => StoreError::Failed("a load worker stopped".into()),
                });
            }
        }
        Ok(())
    }

    /// Derives what is left, merges, and installs the load. Returns where its time went.
    pub fn finish(mut self) -> StoreResult<LoadStats> {
        self.finished = true;
        let r = self.finish_inner();
        if r.is_err() {
            self.abandon();
        }
        r
    }

    fn finish_inner(&mut self) -> StoreResult<LoadStats> {
        if let Some(why) = &self.failed {
            return Err(StoreError::Failed(why.clone()));
        }
        let t = Instant::now();
        if !self.layout.is_empty() {
            self.close_file()?;
        }
        self.stats.layout_micros += t.elapsed().as_micros() as u64;
        let t = Instant::now();
        let mut runs: Vec<(u64, Arc<Run>)> = Vec::new();
        let mut first_error = None;
        for w in &mut self.workers {
            drop(w.tx.take());
            match w.handle.take().map(|h| h.join()) {
                Some(Ok(Ok(s))) => {
                    self.stats.derive_micros += s.derive_micros;
                    self.stats.spill_micros += s.spill_micros;
                    runs.extend(s.runs);
                }
                Some(Ok(Err(e))) => first_error = first_error.or(Some(e)),
                Some(Err(_)) => {
                    first_error =
                        first_error.or(Some(StoreError::Failed("a load worker panicked".into())))
                }
                None => {}
            }
        }
        if let Some(e) = first_error {
            return Err(e);
        }
        self.stats.derive_wait_micros = t.elapsed().as_micros() as u64;
        let Some(end) = self.end else {
            // Nothing was loaded.
            self.abandon();
            self.stats.total_micros = self.started.elapsed().as_micros() as u64;
            return Ok(self.stats);
        };

        runs.sort_by_key(|(seq, _)| std::cmp::Reverse(*seq));
        let staged = Staged {
            runs: runs.into_iter().map(|(_, r)| r).collect(),
            cache: Cache::new(0),
            counts: ReadCounts::default(),
            staged_dir: self.dir.clone(),
            staged_from: log::position(self.first_file, 0),
            records: Arc::new(StagedRecords::default()),
        };

        // ---- numberings ----
        // Derivation leaves them out (a numbering is shared across partitions): a load of characters or groups
        // numbers every scope from its orders, which it can do only over a library that had none. They go into
        // the load's run, so they are installed with it, all at once: installed alone, they would have replay
        // derive the load over them and count the tags' parts twice.
        let t = Instant::now();
        let numbers = if staged_holds(&staged, super::kinds::key::COUNT)?
            || staged_holds(&staged, super::kinds::key::TAG_PLACE)?
            || staged_holds(&staged, super::kinds::key::MEMBER_COUNT)?
        {
            if !self.library_empty {
                return Err(StoreError::Refused(
                    "characters, groups, tags and their assignments are bulk loaded only into a store with none; nothing was loaded"
                        .into(),
                ));
            }
            let (numbers, entries) = self.build_numbers(&staged)?;
            self.stats.number_entries = entries;
            Some(numbers)
        } else {
            None
        };
        self.stats.numbers_micros = t.elapsed().as_micros() as u64;
        let numbered = numbers.is_some();

        // ---- one run of everything the workers and the numberings spilled, newest spill first; the
        // numberings' keys are none of the workers' but the host entries (`library::rank_host`) they write their
        // numbers into, so the numberings are newer ----
        let t = Instant::now();
        let mut runs: Vec<Arc<Run>> = numbers.into_iter().flatten().collect();
        runs.extend(staged.runs);
        let path = self.dir.join("load.run");
        let block_size = self.inner.ks.config().block_size;
        let (entries, bytes) = merge_runs(&runs, &self.dir, &path, block_size, self.workers.len())?;
        for r in &runs {
            r.obsolete.store(true, Ordering::Release);
        }
        drop(runs);
        self.stats.run_entries = entries;
        self.stats.run_bytes = bytes;
        self.stats.merge_micros = t.elapsed().as_micros() as u64;
        let b = &self.budget;
        self.stats.spills = b.files.load(Ordering::Relaxed);
        self.stats.spill_bytes = b.file_bytes.load(Ordering::Relaxed);
        self.stats.kept_runs = b.kept.load(Ordering::Relaxed);
        self.stats.peak_bytes = b.peak.load(Ordering::Relaxed) as u64;

        // ---- install ----
        let t = Instant::now();
        self.install(&path, numbered, end)?;
        self.stats.install_micros = t.elapsed().as_micros() as u64;
        self.stats.total_micros = self.started.elapsed().as_micros() as u64;
        Ok(self.stats)
    }

    /// Nothing was committed or derived since the load started.
    fn alone(&self) -> bool {
        let p = self.inner.pipe.lock().unwrap();
        p.loading
            .as_ref()
            .is_none_or(|l| l.touched.is_empty() && !l.derived)
    }

    /// Numbers each (scope, type, fav) densely from 0, in its name order, into spilled runs (sorted, so any size
    /// fits the load's memory) that join the load's merge. Returns them, newest first, and the entries spilled.
    /// Each number also goes into the entry standing for its (scope, entity) (`library::rank_host`), beside the
    /// record place the workers wrote there: the numbers are spilled by that entry's key first, then joined with
    /// the workers' entries in key order, and the joined entries are newer than the workers' in the load's merge.
    /// The library had no characters or groups before the load, and the install refuses it if anything changed
    /// meanwhile, so the workers' spills hold every count and order: they are read alone, merged in key order.
    fn build_numbers(&self, staged: &Staged) -> StoreResult<(Vec<Arc<Run>>, u64)> {
        use super::kinds::key;
        use super::library::{
            BY_NAME, Scope, host_bytes, order_prefix, parse_host, parse_uvarint, rand_key,
            rank_host, split_order_key, uvarint,
        };
        let bad = || StoreError::Entry("a count key doesn't decode".into());
        let counts = key::of(key::COUNT);
        let mut parts = Vec::new();
        let mut it = staged_merge(staged, &counts)?;
        let end = key::prefix_end(&counts);
        while let Some((k, v)) = it.next_entry()?.filter(|(k, _)| *k < end) {
            if let Some(v) = v.settled(&k) {
                let n = crate::keyspace::val::counter_value(&v.into_bytes(&k)).ok_or_else(bad)?;
                let mut at = counts.len();
                let scope = Scope::get(&k, &mut at).ok_or_else(bad)?;
                let kind = crate::keyspace::val::get_u64(&k, &mut at).ok_or_else(bad)?;
                let fav = crate::keyspace::val::get_u64(&k, &mut at).ok_or_else(bad)? == 1;
                parts.push((scope, kind, fav, n));
            }
        }
        let dir = self.dir.join("numbers");
        fs::create_dir_all(&dir)?;
        let seq = AtomicU64::new(0);
        let spill_into = || Staged {
            runs: Vec::new(),
            cache: Cache::new(0),
            counts: ReadCounts::default(),
            staged_dir: dir.clone(),
            staged_from: 0,
            records: Arc::new(StagedRecords::default()),
        };
        let inner = &self.inner;
        let budget = &*self.budget;
        let share = budget.limit / NUMBERING_SINKS;
        budget.sinks.store(NUMBERING_SINKS, Ordering::Relaxed);
        // The numberings and the tags' carriers by name term write structures of their own, each into its own
        // spills: they run side by side.
        let numbering = || -> StoreResult<(Spilled, u64)> {
            let mut spilled = Spilled::default();
            let mut spill_staged = spill_into();
            let mut sink: HashMap<Vec<u8>, Val> = HashMap::new();
            let mut sink_bytes = 0;
            let mut sink_next = 0;
            let mut entries = 0u64;
            // Each number by its host entry's key, spilled apart: read back in key order below, never installed.
            let mut ranked = Spilled::default();
            let mut ranked_staged = spill_into();
            let mut ranks: HashMap<Vec<u8>, Val> = HashMap::new();
            let mut ranks_bytes = 0;
            let mut ranks_next = 0;
            // The parts are in key order, and so are their name orders: one merge skips ahead to each.
            let mut it = staged_merge(staged, &key::of(key::ORDER))?;
            for (scope, kind, fav, n) in parts {
                let p = order_prefix(&scope, BY_NAME, kind, fav);
                let end = key::prefix_end(&p);
                it.seek(&p)?;
                let mut i = 0i64;
                while it.peek().is_some_and(|k| k < end.as_slice()) {
                    let Some((k, v)) = it.next_entry()? else {
                        break;
                    };
                    if v.settled(&k).is_some() {
                        let (_, e) = split_order_key(&k[p.len()..], BY_NAME).ok_or_else(|| {
                            StoreError::Entry("an order key doesn't decode".into())
                        })?;
                        let (rk, hk) =
                            (rand_key(&scope, kind, fav, i as u64), rank_host(&scope, e));
                        sink_bytes += rk.len() + ENTRY_OVERHEAD;
                        sink.insert(rk, Val::Put(uvarint(e)));
                        ranks_bytes += hk.len() + ENTRY_OVERHEAD;
                        ranks.insert(hk, Val::Put(uvarint(i as u64)));
                        i += 1;
                        if budget.grown(sink_bytes, sink.len(), &mut sink_next, share)? {
                            entries += sink.len() as u64;
                            spill(
                                &mut sink,
                                &mut spilled,
                                &dir,
                                &seq,
                                &mut spill_staged,
                                budget,
                                sink_bytes,
                            )?;
                            sink_bytes = 0;
                            sink_next = 0;
                        }
                        if budget.grown(ranks_bytes, ranks.len(), &mut ranks_next, share)? {
                            spill(
                                &mut ranks,
                                &mut ranked,
                                &dir,
                                &seq,
                                &mut ranked_staged,
                                budget,
                                ranks_bytes,
                            )?;
                            ranks_bytes = 0;
                            ranks_next = 0;
                        }
                    }
                }
                if i != n {
                    return Err(StoreError::Entry(format!(
                        "a scope's name order holds {i} entities and its count {n}"
                    )));
                }
            }
            // The numbers joined with their host entries, both in key order: one pass over each.
            if !ranks.is_empty() {
                spill(
                    &mut ranks,
                    &mut ranked,
                    &dir,
                    &seq,
                    &mut ranked_staged,
                    budget,
                    ranks_bytes,
                )?;
            }
            {
                let mut rank_it = staged_merge(&ranked_staged, &[])?;
                let mut host_it = staged_merge(staged, &[])?;
                let unhosted =
                    || StoreError::Entry("a numbered entity has no entry for its scope".into());
                while let Some((hk, v)) = rank_it.next_entry()? {
                    let n = parse_uvarint(&v.into_bytes(&hk))?;
                    host_it.seek(&hk)?;
                    if host_it.peek() != Some(hk.as_slice()) {
                        return Err(unhosted());
                    }
                    let (k, hv) = host_it.next_entry()?.ok_or_else(unhosted)?;
                    let hv = hv.settled(&k).ok_or_else(unhosted)?.into_bytes(&k);
                    let (l, _) = parse_host(&hv)?;
                    sink_bytes += hk.len() + ENTRY_OVERHEAD;
                    sink.insert(hk, Val::Put(host_bytes(l, Some(n))));
                    if budget.grown(sink_bytes, sink.len(), &mut sink_next, share)? {
                        entries += sink.len() as u64;
                        spill(
                            &mut sink,
                            &mut spilled,
                            &dir,
                            &seq,
                            &mut spill_staged,
                            budget,
                            sink_bytes,
                        )?;
                        sink_bytes = 0;
                        sink_next = 0;
                    }
                }
            }
            for (_, r) in &ranked.runs {
                r.obsolete.store(true, Ordering::Release);
            }
            drop(ranked);
            drop(ranked_staged);
            // The tags' orders follow their carriers, counted across partitions: every tag is placed here.
            let places = key::of(key::TAG_PLACE);
            let mut it = staged_merge(staged, &places)?;
            let tag_bad = || StoreError::Entry("a tag place key doesn't decode".into());
            let end = key::prefix_end(&places);
            // Carrier counts, read alongside: both are in tag order.
            let members = key::of(key::MEMBER_COUNT);
            let members_end = key::prefix_end(&members);
            let mut member_it = staged_merge(staged, &members)?;
            let mut member = member_it.next_entry()?.filter(|(k, _)| *k < members_end);
            while let Some((k, v)) = it.next_entry()?.filter(|(k, _)| *k < end) {
                if let Some(v) = v.settled(&k) {
                    let mut at = places.len();
                    let tag = crate::keyspace::val::get_u64(&k, &mut at).ok_or_else(tag_bad)?;
                    let place = super::tags::Place::parse(&v.into_bytes(&k))?;
                    let want = key::id(key::MEMBER_COUNT, tag);
                    while member.as_ref().is_some_and(|(k, _)| *k < want) {
                        member = member_it.next_entry()?.filter(|(k, _)| *k < members_end);
                    }
                    let count = match &member {
                        Some((k, v)) if *k == want => v
                            .clone()
                            .settled(k)
                            .and_then(|v| crate::keyspace::val::counter_value(&v.into_bytes(k)))
                            .unwrap_or(0),
                        _ => 0,
                    };
                    let mut out = super::derive::Out::default();
                    super::tags::reposition(&mut out, tag, None, Some((&place, count)));
                    for (ek, ev) in out.entries {
                        sink_bytes += ek.len() + ENTRY_OVERHEAD;
                        match sink.remove(&ek) {
                            Some(old) => {
                                let v = ev.over_owned(&ek, old);
                                sink.insert(ek, v)
                            }
                            None => sink.insert(ek, ev),
                        };
                    }
                    if budget.grown(sink_bytes, sink.len(), &mut sink_next, share)? {
                        entries += sink.len() as u64;
                        spill(
                            &mut sink,
                            &mut spilled,
                            &dir,
                            &seq,
                            &mut spill_staged,
                            budget,
                            sink_bytes,
                        )?;
                        sink_bytes = 0;
                        sink_next = 0;
                    }
                }
            }
            if !sink.is_empty() {
                entries += sink.len() as u64;
                spill(
                    &mut sink,
                    &mut spilled,
                    &dir,
                    &seq,
                    &mut spill_staged,
                    budget,
                    sink_bytes,
                )?;
            }
            Ok((spilled, entries))
        };
        // ---- the tags' carriers by name term (`carriers`), every tag new ----
        let carriers = || -> StoreResult<(Spilled, u64)> {
            let mut spilled = Spilled::default();
            let mut spill_staged = spill_into();
            let mut sink: HashMap<Vec<u8>, Val> = HashMap::new();
            let mut sink_bytes = 0;
            let mut sink_next = 0;
            let mut entries = 0u64;
            let places = key::of(key::TAG_PLACE);
            let members = key::of(key::MEMBER_COUNT);
            let members_end = key::prefix_end(&members);
            let tag_bad = || StoreError::Entry("a tag place key doesn't decode".into());
            let count_of = |k: &[u8], v: Val| -> StoreResult<i64> {
                v.settled(k)
                    .map(|v| crate::keyspace::val::counter_value(&v.into_bytes(k)))
                    .unwrap_or(Some(0))
                    .ok_or_else(|| StoreError::Entry("a carrier count doesn't decode".into()))
            };
            let mut pairs = 0i64;
            let mut it = staged_merge(staged, &members)?;
            while let Some((k, v)) = it.next_entry()?.filter(|(k, _)| *k < members_end) {
                pairs += count_of(&k, v)?;
            }
            if pairs > 0 {
                use super::carriers::{Reside, TagMap, j_of, name_terms};
                let r = Reside {
                    j: j_of(pairs as u64),
                    m_set: pairs as u64,
                    scan: None,
                };
                let k = r.k();
                sink_put(
                    &mut sink,
                    &mut sink_bytes,
                    key::of(key::CARRIER_PAIRS),
                    Val::Add(pairs),
                );
                sink_put(
                    &mut sink,
                    &mut sink_bytes,
                    key::of(key::RESIDE),
                    Val::Put(r.bytes()),
                );
                // A view for the tags' names: their heads' records and any edits' reads, through blocks kept.
                let named = Staged {
                    runs: staged.runs.clone(),
                    cache: Cache::new(64 << 20),
                    counts: ReadCounts::default(),
                    staged_dir: staged.staged_dir.clone(),
                    staged_from: staged.staged_from,
                    records: Arc::new(StagedRecords::new(16 << 20)),
                };
                let view = View {
                    layers: Vec::new(),
                    pending: Vec::new(),
                    staged: Some(&named),
                    bulk: false,
                    ks: &inner.ks,
                    snap: None,
                    log: &inner.log,
                };
                // A tag's carriers ask, per name term and reading, for their posting blocks: keyed by the
                // block, one `ask_slot` each. The asks are read back in key order below, joined with the
                // staged postings and then the lengths, never looked up one by one.
                use crate::search::{BLOCK_BITS, FIELD_BITS, LENGTH_BITS, posting_block};
                const LIBRARY: crate::search::Scope = crate::search::Scope::LIBRARY;
                let carrier = |block: u64, s: u32| (block << key::MEMBER_BITS) | u64::from(s);
                let ask_slot = |doc: u64, as_prefix: bool| {
                    ((doc & ((1 << BLOCK_BITS) - 1)) as u32) << 1 | u32::from(as_prefix)
                };
                let mut asked: HashMap<Vec<u8>, Val> = HashMap::new();
                let mut asked_bytes = 0usize;
                let mut asked_next = 0;
                let mut asks_spilled = Spilled::default();
                let mut asks_staged = spill_into();
                let blocks = key::of(key::MEMBER_BLOCK);
                let mut block_it = staged_merge(staged, &blocks)?;
                let mut place_it = staged_merge(staged, &places)?;
                let mut text_it = staged_merge(staged, &key::of(key::TEXT))?;
                let mut it = staged_merge(staged, &members)?;
                while let Some((mk, v)) = it.next_entry()?.filter(|(k, _)| *k < members_end) {
                    let c = count_of(&mk, v)?;
                    let mut at = members.len();
                    let tag = crate::keyspace::val::get_u64(&mk, &mut at).ok_or_else(tag_bad)?;
                    if c <= 0 {
                        continue;
                    }
                    // A tag's name is indexed while it has its marker, so while it is placed.
                    place_it.seek(&key::id(key::TAG_PLACE, tag))?;
                    let placed = match place_it.peek() {
                        Some(k) if k == key::id(key::TAG_PLACE, tag).as_slice() => {
                            let (k, v) = place_it.next_entry()?.unwrap();
                            v.settled(&k).is_some()
                        }
                        _ => false,
                    };
                    let name_field = FieldRef::Code(super::library::NAME);
                    let mut name = Vec::new();
                    if placed {
                        let hk = super::kinds::Holder::Entity(tag).text_key(&name_field);
                        text_it.seek(&hk)?;
                        if text_it.peek() == Some(hk.as_slice())
                            && let Some((k, v)) = text_it.next_entry()?
                            && let Some(v) = v.settled(&k)
                        {
                            name = super::kinds::text_of_head(
                                &view,
                                tag,
                                &name_field,
                                &v.into_bytes(&k),
                            )?;
                        }
                    }
                    let terms = name_terms(&name);
                    if terms.is_empty() {
                        continue;
                    }
                    for (kind, term) in &terms {
                        sink_put(
                            &mut sink,
                            &mut sink_bytes,
                            key::term_carriers(*kind, term),
                            Val::Add(c),
                        );
                    }
                    let heavy = u128::try_from(c).unwrap_or(0) > 2 * u128::from(k);
                    if heavy {
                        let map = TagMap {
                            heavy: true,
                            flight: None,
                        };
                        sink_put(
                            &mut sink,
                            &mut sink_bytes,
                            key::id(key::TAG_MAP, tag),
                            Val::Put(map.bytes()),
                        );
                        for (kind, term) in &terms {
                            sink_put(
                                &mut sink,
                                &mut sink_bytes,
                                key::term_heavy(*kind, term, tag),
                                Val::Put(Vec::new()),
                            );
                        }
                    }
                    // Per member block: a light tag's carriers counted in each term's map, and every tag's
                    // carriers' block maxima raised for each term.
                    let bp = key::id(key::MEMBER_BLOCK, tag);
                    let bend = key::prefix_end(&bp);
                    block_it.seek(&bp)?;
                    while block_it.peek().is_some_and(|k| k < bend.as_slice()) {
                        let Some((bk, bv)) = block_it.next_entry()? else {
                            break;
                        };
                        let Some(bv) = bv.settled(&bk) else {
                            continue;
                        };
                        let mut a = bp.len();
                        let block =
                            crate::keyspace::val::get_u64(&bk, &mut a).ok_or_else(tag_bad)?;
                        let slots: Vec<(u32, i64)> =
                            crate::keyspace::val::map_pairs(&bv.into_bytes(&bk))
                                .ok_or_else(|| {
                                    StoreError::Entry("a member block doesn't decode".into())
                                })?
                                .into_iter()
                                .filter(|(_, n)| *n != 0)
                                .map(|(s, _)| (s, 1))
                                .collect();
                        if slots.is_empty() {
                            continue;
                        }
                        if !heavy {
                            for (kind, term) in &terms {
                                let ak = key::tag_carriers(*kind, term, block).into_raw();
                                sink_bytes = sink_bytes.saturating_add_signed(sink_add(
                                    &mut sink,
                                    ak,
                                    Val::AddMap(slots.clone()),
                                ));
                            }
                        }
                        for (kind, term) in &terms {
                            let as_prefix = *kind == crate::search::TermKind::Gram;
                            if !crate::search::readings(term).contains(&as_prefix) {
                                continue;
                            }
                            for run in slots.chunk_by(|a, b| {
                                carrier(block, a.0) >> BLOCK_BITS
                                    == carrier(block, b.0) >> BLOCK_BITS
                            }) {
                                let pblock = carrier(block, run[0].0) >> BLOCK_BITS;
                                let asks: Vec<(u32, u32)> = run
                                    .iter()
                                    .map(|&(s, _)| (ask_slot(carrier(block, s), as_prefix), 1))
                                    .collect();
                                asked_bytes = asked_bytes.saturating_add_signed(sink_add(
                                    &mut asked,
                                    posting_block(LIBRARY, term, pblock),
                                    Val::MaxMap(asks),
                                ));
                            }
                        }
                        if budget.grown(asked_bytes, asked.len(), &mut asked_next, share)? {
                            spill(
                                &mut asked,
                                &mut asks_spilled,
                                &dir,
                                &seq,
                                &mut asks_staged,
                                budget,
                                asked_bytes,
                            )?;
                            asked_bytes = 0;
                            asked_next = 0;
                        }
                    }
                    if budget.grown(sink_bytes, sink.len(), &mut sink_next, share)? {
                        entries += sink.len() as u64;
                        spill(
                            &mut sink,
                            &mut spilled,
                            &dir,
                            &seq,
                            &mut spill_staged,
                            budget,
                            sink_bytes,
                        )?;
                        sink_bytes = 0;
                        sink_next = 0;
                    }
                }
                // Each asked posting block joined with the staged one, both in key order: the slots each asked
                // carrier holds there, by its length block's key.
                if !asked.is_empty() {
                    spill(
                        &mut asked,
                        &mut asks_spilled,
                        &dir,
                        &seq,
                        &mut asks_staged,
                        budget,
                        asked_bytes,
                    )?;
                }
                // Terms are met in order here, so each takes the next id: the held carriers and the raises are
                // keyed by it, and the terms, written in id order, give the raises their keys at the end.
                let mut held: HashMap<Vec<u8>, Val> = HashMap::new();
                let mut held_bytes = 0;
                let mut held_next = 0;
                let mut held_spilled = Spilled::default();
                let mut held_staged = spill_into();
                let mut terms: HashMap<Vec<u8>, Val> = HashMap::new();
                let mut terms_bytes = 0;
                let mut terms_next = 0;
                let mut terms_spilled = Spilled::default();
                let mut terms_staged = spill_into();
                {
                    let mut ask_it = staged_merge(&asks_staged, &[])?;
                    let mut post_it = staged_merge(staged, &[])?;
                    let mut term_at: Option<(String, u32)> = None;
                    while let Some((pk, v)) = ask_it.next_entry()? {
                        let Some(asks) = v.settled(&pk).and_then(|v| v.into_pairs(&pk)) else {
                            continue;
                        };
                        post_it.seek(&pk)?;
                        if post_it.peek() != Some(pk.as_slice()) {
                            continue;
                        }
                        let Some((k, pv)) = post_it.next_entry()? else {
                            continue;
                        };
                        let Some(pv) = pv.settled(&k) else {
                            continue;
                        };
                        let posting = crate::keyspace::val::map_pairs(&pv.into_bytes(&k))
                            .ok_or_else(|| {
                                StoreError::Entry("a search block doesn't decode".into())
                            })?;
                        let (term, pblock) = crate::search::parse_posting_block(LIBRARY, &pk)
                            .ok_or_else(|| {
                                StoreError::Entry("a posting key doesn't decode".into())
                            })?;
                        if term_at.as_ref().is_none_or(|(t, _)| *t != term) {
                            let id = match &term_at {
                                None => 0,
                                Some((_, id)) => id.checked_add(1).ok_or_else(|| {
                                    StoreError::Failed("over 2^32 tag name terms".into())
                                })?,
                            };
                            terms_bytes += term.len();
                            sink_put(
                                &mut terms,
                                &mut terms_bytes,
                                id.to_be_bytes().to_vec(),
                                Val::Put(term.as_bytes().to_vec()),
                            );
                            if budget.grown(terms_bytes, terms.len(), &mut terms_next, share)? {
                                spill(
                                    &mut terms,
                                    &mut terms_spilled,
                                    &dir,
                                    &seq,
                                    &mut terms_staged,
                                    budget,
                                    terms_bytes,
                                )?;
                                terms_bytes = 0;
                                terms_next = 0;
                            }
                            term_at = Some((term, id));
                        }
                        let id = term_at.as_ref().unwrap().1;
                        for (a, _) in asks {
                            let doc = (pblock << BLOCK_BITS) | u64::from(a >> 1);
                            let slots = crate::search::index::doc_postings(&posting, doc);
                            if slots.is_empty() {
                                continue;
                            }
                            let hk = held_key(doc, a & 1 == 1, id);
                            // Per slot its field and its count: the document gives the rest.
                            let hv: Vec<u8> = slots
                                .iter()
                                .flat_map(|&(s, n)| {
                                    std::iter::once((s & ((1 << FIELD_BITS) - 1)) as u8)
                                        .chain(n.to_le_bytes())
                                })
                                .collect();
                            held_bytes += hv.len();
                            sink_put(&mut held, &mut held_bytes, hk, Val::Put(hv));
                            if budget.grown(held_bytes, held.len(), &mut held_next, share)? {
                                spill(
                                    &mut held,
                                    &mut held_spilled,
                                    &dir,
                                    &seq,
                                    &mut held_staged,
                                    budget,
                                    held_bytes,
                                )?;
                                held_bytes = 0;
                                held_next = 0;
                            }
                        }
                    }
                }
                if !terms.is_empty() {
                    spill(
                        &mut terms,
                        &mut terms_spilled,
                        &dir,
                        &seq,
                        &mut terms_staged,
                        budget,
                        terms_bytes,
                    )?;
                }
                for (_, r) in &asks_spilled.runs {
                    r.obsolete.store(true, Ordering::Release);
                }
                drop(asks_spilled);
                drop(asks_staged);
                // Each held carrier joined with its staged length block, both in key order: its score with the
                // tag part, the highest per posting block, term and reading, raises the term's maxima over the
                // block, keyed by the term's id.
                if !held.is_empty() {
                    spill(
                        &mut held,
                        &mut held_spilled,
                        &dir,
                        &seq,
                        &mut held_staged,
                        budget,
                        held_bytes,
                    )?;
                }
                let mut raised: HashMap<Vec<u8>, Val> = HashMap::new();
                let mut raised_bytes = 0usize;
                let mut raised_next = 0;
                let mut raised_spilled = Spilled::default();
                let mut raised_staged = spill_into();
                {
                    let lengths_at = crate::search::lengths(LIBRARY).len();
                    let bad = || StoreError::Entry("a held carrier's key doesn't decode".into());
                    let mut held_it = staged_merge(&held_staged, &[])?;
                    let mut len_it = staged_merge(staged, &[])?;
                    let mut lens_at: Option<(Vec<u8>, Vec<(u32, u32)>)> = None;
                    // The highest score per term and reading over the current posting block's carriers: the held
                    // carriers come in document order, so a block's are together, and only its highest is raised.
                    let mut best: HashMap<(u32, bool), f64> = HashMap::new();
                    let mut best_block: Option<u64> = None;
                    while let Some((hk, hv)) = held_it.next_entry()? {
                        let Some(hv) = hv.settled(&hk) else {
                            continue;
                        };
                        let hv = hv.into_bytes(&hk);
                        let mut at = lengths_at;
                        let lblock = crate::keyspace::val::get_u64(&hk, &mut at).ok_or_else(bad)?;
                        let (lk, rest) = hk.split_at(at);
                        let &[low, prefix, a, b, c, d] = rest else {
                            return Err(bad());
                        };
                        let id = u32::from_be_bytes([a, b, c, d]);
                        if lens_at.as_ref().is_none_or(|(k, _)| k.as_slice() != lk) {
                            len_it.seek(lk)?;
                            let mut lens = Vec::new();
                            if len_it.peek() == Some(lk)
                                && let Some((k, v)) = len_it.next_entry()?
                                && let Some(v) = v.settled(&k)
                            {
                                lens = crate::keyspace::val::map_pairs(&v.into_bytes(&k))
                                    .ok_or_else(|| {
                                        StoreError::Entry("a search block doesn't decode".into())
                                    })?;
                            }
                            lens_at = Some((lk.to_vec(), lens));
                        }
                        let doc = (lblock << LENGTH_BITS) | u64::from(low);
                        let as_prefix = prefix == 1;
                        let slots: Vec<(u32, u32)> = hv
                            .chunks_exact(5)
                            .map(|c| {
                                (
                                    crate::search::slot(doc, u32::from(c[0])),
                                    u32::from_le_bytes(c[1..].try_into().unwrap()),
                                )
                            })
                            .collect();
                        let lens = &lens_at.as_ref().unwrap().1;
                        if best_block != Some(doc >> BLOCK_BITS) {
                            if let Some(block) = best_block {
                                raise_highest(&mut best, block, &mut raised, &mut raised_bytes);
                            }
                            best_block = Some(doc >> BLOCK_BITS);
                            if budget.grown(raised_bytes, raised.len(), &mut raised_next, share)? {
                                spill(
                                    &mut raised,
                                    &mut raised_spilled,
                                    &dir,
                                    &seq,
                                    &mut raised_staged,
                                    budget,
                                    raised_bytes,
                                )?;
                                raised_bytes = 0;
                                raised_next = 0;
                            }
                        }
                        if let Some(v) = crate::search::index::tagged_score(
                            LIBRARY, doc, &slots, lens, as_prefix,
                        ) {
                            let at = best.entry((id, as_prefix)).or_insert(v);
                            *at = at.max(v);
                        }
                    }
                    if let Some(block) = best_block {
                        raise_highest(&mut best, block, &mut raised, &mut raised_bytes);
                    }
                }
                for (_, r) in &held_spilled.runs {
                    r.obsolete.store(true, Ordering::Release);
                }
                drop(held_spilled);
                drop(held_staged);
                // The raises joined with the terms, both in id order: each takes its term's maxima key.
                if !raised.is_empty() {
                    spill(
                        &mut raised,
                        &mut raised_spilled,
                        &dir,
                        &seq,
                        &mut raised_staged,
                        budget,
                        raised_bytes,
                    )?;
                }
                {
                    let bad = || StoreError::Entry("a raise's key doesn't decode".into());
                    let mut raised_it = staged_merge(&raised_staged, &[])?;
                    let mut term_it = staged_merge(&terms_staged, &[])?;
                    let mut term_at: Option<(u32, String)> = None;
                    while let Some((rk, rv)) = raised_it.next_entry()? {
                        let Some(id) = rk
                            .get(..4)
                            .map(|b| u32::from_be_bytes(b.try_into().unwrap()))
                        else {
                            return Err(bad());
                        };
                        let mut at = 4;
                        let level = crate::keyspace::val::get_u64(&rk, &mut at).ok_or_else(bad)?;
                        let group = crate::keyspace::val::get_u64(&rk, &mut at).ok_or_else(bad)?;
                        if term_at.as_ref().is_none_or(|(t, _)| *t != id) {
                            term_it.seek(&id.to_be_bytes())?;
                            let no_term = || StoreError::Entry("a raise's term has no id".into());
                            if term_it.peek() != Some(id.to_be_bytes().as_slice()) {
                                return Err(no_term());
                            }
                            let (k, v) = term_it.next_entry()?.ok_or_else(no_term)?;
                            let term = match v.settled(&k) {
                                Some(Val::Put(b)) => String::from_utf8(b).map_err(|_| bad())?,
                                _ => return Err(bad()),
                            };
                            term_at = Some((id, term));
                        }
                        let term = &term_at.as_ref().unwrap().1;
                        let mk = crate::search::block_maxima(LIBRARY, term, level, group);
                        sink_bytes = sink_bytes.saturating_add_signed(sink_add(&mut sink, mk, rv));
                        if budget.grown(sink_bytes, sink.len(), &mut sink_next, share)? {
                            entries += sink.len() as u64;
                            spill(
                                &mut sink,
                                &mut spilled,
                                &dir,
                                &seq,
                                &mut spill_staged,
                                budget,
                                sink_bytes,
                            )?;
                            sink_bytes = 0;
                            sink_next = 0;
                        }
                    }
                }
                for (_, r) in &raised_spilled.runs {
                    r.obsolete.store(true, Ordering::Release);
                }
                for (_, r) in &terms_spilled.runs {
                    r.obsolete.store(true, Ordering::Release);
                }
            }
            if !sink.is_empty() {
                entries += sink.len() as u64;
                spill(
                    &mut sink,
                    &mut spilled,
                    &dir,
                    &seq,
                    &mut spill_staged,
                    budget,
                    sink_bytes,
                )?;
            }
            Ok((spilled, entries))
        };
        let (numbered, carried) = std::thread::scope(|sc| {
            let carried = sc.spawn(carriers);
            let numbered = numbering();
            let carried = carried.join().unwrap_or_else(|_| {
                Err(StoreError::Failed(
                    "the tags' carriers by name term panicked".into(),
                ))
            });
            (numbered, carried)
        });
        let (mut spilled, mut entries) = numbered?;
        let (more, more_entries) = carried?;
        spilled.runs.extend(more.runs);
        entries += more_entries;
        spilled.runs.sort_by_key(|(n, _)| std::cmp::Reverse(*n));
        Ok((spilled.runs.into_iter().map(|(_, r)| r).collect(), entries))
    }

    fn install(&mut self, run: &Path, numbered: bool, end: Cursor) -> StoreResult<()> {
        let inner = self.inner.clone();
        let last_file = end.file;
        // Hold commits, and let the ones prepared be written and published.
        inner
            .pipe
            .lock()
            .unwrap()
            .loading
            .as_mut()
            .unwrap()
            .installing = true;
        loop {
            inner.sync_act.kick();
            inner.sync_act.wait_idle();
            let p = inner.pipe.lock().unwrap();
            if p.open.dones.is_empty() && p.syncing.is_none() {
                break;
            }
            drop(p);
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        let mut marked = false;
        let mut held = || -> StoreResult<()> {
            if let Some(why) = &inner.pipe.lock().unwrap().failed {
                return Err(StoreError::Failed(why.clone()));
            }
            self.check_partitions()?;
            if numbered && !self.alone() {
                return Err(StoreError::Refused(
                    "the library changed during a bulk load of characters or groups; nothing was loaded".into(),
                ));
            }
            // The log's files run on without a gap into the load's.
            let before = inner.dir.join(inner.log.file_name(self.first_file - 1));
            if self.first_file > 0 && !before.exists() {
                File::create(&before)?.sync_all()?;
            }
            // The runs cover every commit before the load.
            let durable = inner.log.durable_end();
            inner.ks.freeze_at(durable);
            inner.ks.wait_flushed()?;
            // The log files, last first: the first one makes them all part of the log.
            let mut marker = File::create(self.dir.join(MARKER))?;
            marker.write_all(format!("{} {last_file}", self.first_file).as_bytes())?;
            marker.sync_all()?;
            sync_dir(&self.dir)?;
            marked = true;
            #[cfg(test)]
            if self.fail_at == 1 {
                return Err(StoreError::Failed(
                    "failpoint: before moving the files".into(),
                ));
            }
            for f in (self.first_file..=last_file).rev() {
                let name = inner.log.file_name(f);
                fs::rename(self.dir.join(&name), inner.dir.join(&name))?;
            }
            sync_dir(&inner.dir)?;
            #[cfg(test)]
            if self.fail_at == 2 {
                return Err(StoreError::Failed("failpoint: before the run".into()));
            }
            inner
                .ks
                .install_run(run, log::position(end.file, end.offset))?;
            // Only now does the log end past the load: a failure before leaves a flush covering no more than
            // the runs did, so reopening derives what no run holds.
            {
                let mut p = inner.pipe.lock().unwrap();
                p.cursor = end;
                inner.log.set_durable(end);
                *inner.tail.lock().unwrap() = TailFile::existing(last_file);
            }
            let _ = fs::remove_dir_all(&self.dir);
            Ok(())
        };
        let r = held();
        {
            let mut p = inner.pipe.lock().unwrap();
            match &r {
                Ok(()) => p.loading = None,
                // Past the marker the log may hold the load's files or some of them: nothing more is written
                // until opening resolves it.
                Err(e) if marked => {
                    p.failed = Some(format!("installing a bulk load failed: {e}"));
                    self.keep_staging = true;
                }
                Err(_) => {}
            }
            if let Some(l) = p.loading.as_mut() {
                l.installing = false;
            }
        }
        inner.prepare_act.kick();
        inner.clean_act.kick();
        r
    }

    /// Refuses the load if a record committed meanwhile shares a partition with it.
    fn check_partitions(&self) -> StoreResult<()> {
        let touched = {
            let p = self.inner.pipe.lock().unwrap();
            p.loading
                .as_ref()
                .map(|l| l.touched.clone())
                .unwrap_or_default()
        };
        if touched.is_empty() {
            return Ok(());
        }
        let mut shared = Vec::new();
        for w in 0..self.workers.len() {
            let f = match File::open(self.dir.join(format!("parts-{w}"))) {
                Ok(f) => f,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            };
            let mut f = std::io::BufReader::new(f);
            let mut c = [0u8; 8];
            while f.read_exact(&mut c).is_ok() {
                let p = u64::from_le_bytes(c);
                if touched.contains(&p) && !shared.contains(&p) {
                    shared.push(p);
                }
            }
        }
        if shared.is_empty() {
            return Ok(());
        }
        shared.sort_unstable();
        Err(StoreError::Refused(format!(
            "records committed during the bulk load share partitions with it: {shared:?}; nothing was loaded"
        )))
    }

    /// Stops the workers and removes what the load staged; the store is as before it.
    fn abandon(&mut self) {
        for w in &mut self.workers {
            drop(w.tx.take());
            if let Some(h) = w.handle.take() {
                let _ = h.join();
            }
        }
        let inner = &self.inner;
        let mut p = inner.pipe.lock().unwrap();
        if p.loading.is_some() {
            p.loading = None;
            drop(p);
            if !self.keep_staging {
                let _ = fs::remove_dir_all(&self.dir);
            }
            inner.prepare_act.kick();
            inner.clean_act.kick();
        }
    }
}

impl Drop for Loader {
    fn drop(&mut self) {
        if !self.finished {
            self.abandon();
        }
    }
}

/// A worker: derives its partitions' records in order. The current partition's entries are kept apart, where
/// its next record reads them; a finished partition's join the sink, where each key's values from all partitions
/// are combined (their maps' slots and counters are each partition's own share), sorted and spilled to a run once
/// `budget` is over and the sink holds its share of it (one of `workers`). A partition met again after others
/// (input not in partition order) is read through the spilled runs, the sink spilled first.
fn work(
    inner: &Inner,
    w: usize,
    rx: Receiver<Vec<Laid>>,
    dir: &Path,
    staged_from: u64,
    budget: &Budget,
    workers: usize,
    seq: &AtomicU64,
) -> StoreResult<Spilled> {
    let mut out = Spilled::default();
    // The partition's entries: sorted, so a derivation's scans read a range of them, not all; the search index's
    // many entries (postings, maxima, frequencies; read by key) in a hash map, cheaper to add to.
    let mut cur: BTreeMap<Vec<u8>, Val> = BTreeMap::new();
    let mut cur_search: HashMap<Vec<u8>, Val> = HashMap::new();
    let mut cur_partition: Option<u64> = None;
    let mut cur_again = false;
    let mut highest: Option<u64> = None;
    let mut sink: HashMap<Vec<u8>, Val> = HashMap::new();
    let mut sink_bytes = 0usize;
    let mut sink_next = 0;
    let share = budget.limit / workers;
    let records = Arc::new(StagedRecords::new(RECORDS_HELD));
    let mut staged = Staged {
        runs: Vec::new(),
        cache: Cache::new(16 << 20),
        counts: ReadCounts::default(),
        staged_dir: dir.to_path_buf(),
        staged_from,
        records: records.clone(),
    };
    let records_only = Staged {
        runs: Vec::new(),
        cache: Cache::new(0),
        counts: ReadCounts::default(),
        staged_dir: dir.to_path_buf(),
        staged_from,
        records: records.clone(),
    };
    let mut parts = BufWriter::new(File::create(dir.join(format!("parts-{w}")))?);
    for batch in rx {
        let (t, spilling) = (Instant::now(), out.spill_micros);
        for (rec, at, partition) in batch {
            if cur_partition != Some(partition) {
                for (k, v) in std::mem::take(&mut cur)
                    .into_iter()
                    .chain(cur_search.drain())
                {
                    sink_bytes = sink_bytes.saturating_add_signed(sink_add(&mut sink, k, v));
                }
                let again = highest.is_some_and(|h| partition <= h);
                if budget.grown(sink_bytes, sink.len(), &mut sink_next, share)?
                    || (again && !sink.is_empty())
                {
                    spill(
                        &mut sink,
                        &mut out,
                        dir,
                        seq,
                        &mut staged,
                        budget,
                        sink_bytes,
                    )?;
                    sink_bytes = 0;
                    sink_next = 0;
                }
                parts.write_all(&partition.to_le_bytes())?;
                cur_partition = Some(partition);
                cur_again = again;
                highest = Some(highest.map_or(partition, |h| h.max(partition)));
            }
            let view = View {
                layers: vec![
                    Layer::Sorted(&cur),
                    Layer::Hashed(&cur_search, SEARCH_STRUCTURES),
                ],
                pending: Vec::new(),
                staged: Some(if cur_again { &staged } else { &records_only }),
                bulk: true,
                ks: &inner.ks,
                snap: None,
                log: &inner.log,
            };
            let mut o = Out::default();
            deriver(rec.kind)
                .derive(&rec, at, &view, &mut o)
                .map_err(|e| {
                    StoreError::Failed(format!("the {} record at {}: {e}", rec.kind.name, at.pos))
                })?;
            drop(view);
            records.put(at.pos, &rec, at.len);
            let mut kept = Out::default();
            for (k, v) in o.entries {
                if summed_entry(&k) {
                    sink_bytes = sink_bytes.saturating_add_signed(sink_add(&mut sink, k, v));
                } else {
                    kept.entries.push((k, v));
                }
            }
            kept.apply_split(&mut cur, &mut cur_search, search_entry);
        }
        out.derive_micros += t.elapsed().as_micros() as u64 - (out.spill_micros - spilling);
    }
    for (k, v) in std::mem::take(&mut cur)
        .into_iter()
        .chain(cur_search.drain())
    {
        sink_add(&mut sink, k, v);
    }
    if !sink.is_empty() {
        spill(
            &mut sink,
            &mut out,
            dir,
            seq,
            &mut staged,
            budget,
            sink_bytes,
        )?;
    }
    parts.flush()?;
    Ok(out)
}

/// The search index's structures a load worker keeps in a hash map, apart from `SUMMED_STRUCTURES`.
const SEARCH_STRUCTURES: &[u64] = {
    use super::kinds::key;
    &[
        key::SEARCH_POSTING,
        key::SEARCH_LENGTH,
        key::SEARCH_DOCS,
        key::SEARCH_MAX_DOC,
        key::SEARCH_SHORTEST,
    ]
};

/// Search structures a bulk derivation only adds to or raises and never reads: a worker adds their entries to
/// its sink as they come, not through the partition's entries.
const SUMMED_STRUCTURES: &[u64] = {
    use super::kinds::key;
    &[key::SEARCH_BLOCK_MAX, key::SEARCH_TERM_COUNTS.id()]
};

/// Whether a key is of a `SUMMED_STRUCTURES` structure.
fn summed_entry(k: &[u8]) -> bool {
    let mut at = 0;
    crate::keyspace::val::get_u64(k, &mut at).is_some_and(|s| SUMMED_STRUCTURES.contains(&s))
}

/// Whether a key is a search index entry (`SEARCH_STRUCTURES`).
fn search_entry(k: &[u8]) -> bool {
    let mut at = 0;
    crate::keyspace::val::get_u64(k, &mut at).is_some_and(|s| SEARCH_STRUCTURES.contains(&s))
}

/// Merges `runs` (newest first) into one run at `path`: key ranges merged in parallel, each into a part, the
/// parts' blocks then joined in order. Returns its entries and bytes.
fn merge_runs(
    runs: &[Arc<Run>],
    dir: &Path,
    path: &Path,
    block_size: usize,
    threads: usize,
) -> StoreResult<(u64, u64)> {
    // Range bounds from the runs' data blocks' last keys, evenly by blocks.
    let mut keys: Vec<Vec<u8>> = Vec::new();
    for r in runs {
        keys.extend(r.data_blocks()?.into_iter().map(|(k, _)| k));
    }
    keys.sort_unstable();
    let mut bounds: Vec<Vec<u8>> = (1..threads)
        .filter_map(|i| keys.get(i * keys.len() / threads).cloned())
        .collect();
    bounds.dedup();
    drop(keys);
    let ranges: Vec<(Vec<u8>, Option<Vec<u8>>)> = (0..=bounds.len())
        .map(|i| {
            let from = if i == 0 {
                Vec::new()
            } else {
                bounds[i - 1].clone()
            };
            (from, bounds.get(i).cloned())
        })
        .collect();
    let parts: Vec<StoreResult<PathBuf>> = std::thread::scope(|sc| {
        let handles: Vec<_> = ranges
            .iter()
            .enumerate()
            .map(|(i, (from, to))| {
                sc.spawn(move || -> StoreResult<PathBuf> {
                    let part = dir.join(format!("part-{i:04}.run"));
                    let sources: Vec<Box<dyn Source>> = runs
                        .iter()
                        .map(|r| -> StoreResult<Box<dyn Source>> {
                            Ok(Box::new(RunIter::new(r.clone(), from, None, None)?))
                        })
                        .collect::<StoreResult<_>>()?;
                    let mut merge = Merge::new(sources);
                    let mut w = RunWriter::create(&part, block_size)?;
                    while let Some((k, v)) = merge.next_entry()? {
                        if to.as_ref().is_some_and(|t| k >= *t) {
                            break;
                        }
                        w.add(&k, &v)?;
                    }
                    w.finish(0, 0, 0)?;
                    Ok(part)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| {
                h.join().unwrap_or_else(|_| {
                    Err(StoreError::Failed("a load merge thread panicked".into()))
                })
            })
            .collect()
    });
    let mut w = RunWriter::create(path, block_size)?;
    for part in parts {
        let part = part?;
        let r = Run::open(&part, 0, 0)?;
        w.append_run(&r)?;
        drop(r);
        fs::remove_file(&part)?;
    }
    let entries = w.entries();
    let bytes = w.finish(0, 0, 0)?;
    Ok((entries, bytes))
}

/// Adds a finished partition's value to the sink; returns the memory it took (less where it freed some). A
/// map's slots are appended and sorted when spilled; a maxima map's and an added map's are also combined
/// (`combine_max`, `combine_added`) whenever they would outgrow their memory, which is then set to twice what
/// they hold: a key's slots take at most twice its distinct slots and the latest value's, and each slot is
/// sorted O(log n) times, amortized.
fn sink_add(sink: &mut HashMap<Vec<u8>, Val>, k: Vec<u8>, v: Val) -> isize {
    use std::collections::hash_map::Entry;
    match sink.entry(k) {
        Entry::Vacant(e) => {
            let n = e.key().len() + v.payload_len() + ENTRY_OVERHEAD;
            e.insert(v);
            n as isize
        }
        Entry::Occupied(mut e) => {
            let old = e.get_mut();
            match (old, v) {
                (Val::Map(a), Val::Map(b)) => {
                    let n = b.len() * 8;
                    a.extend(b);
                    n as isize
                }
                (Val::MaxMap(a), Val::MaxMap(b)) => absorb(a, b, combine_max),
                (Val::AddMap(a), Val::AddMap(b)) => absorb(a, b, combine_added),
                (Val::Add(a), Val::Add(b)) => {
                    *a += b;
                    0
                }
                (Val::Max(a), Val::Max(b)) => {
                    *a = (*a).max(b);
                    0
                }
                (old, v) => {
                    let n = v.payload_len();
                    let older = std::mem::replace(old, Val::Del);
                    let merged = v.over_owned(e.key(), older);
                    *e.get_mut() = merged;
                    n as isize
                }
            }
        }
    }
}

/// Appends `b` to `a`; where that would outgrow `a`'s memory, `a` is combined first and its memory set to twice
/// what it then holds with `b`. Returns the bytes its memory grew by (negative where it shrank).
fn absorb<T>(a: &mut Vec<T>, b: Vec<T>, combine: fn(&mut Vec<T>)) -> isize {
    let before = a.capacity();
    if a.len() + b.len() > before {
        combine(a);
        let want = 2 * (a.len() + b.len());
        if a.capacity() > want {
            a.shrink_to(want);
        } else {
            a.reserve_exact(want - a.len());
        }
    }
    a.extend(b);
    (a.capacity() as isize - before as isize) * std::mem::size_of::<T>() as isize
}

/// A maxima map's pairs sorted, each slot once, at its highest.
fn combine_max(p: &mut Vec<(u32, u32)>) {
    p.sort_unstable();
    p.dedup_by(|later, earlier| {
        let same = later.0 == earlier.0;
        if same {
            earlier.1 = earlier.1.max(later.1);
        }
        same
    });
}

/// An added map's pairs sorted, each slot once, at its deltas' sum; none at 0.
fn combine_added(p: &mut Vec<(u32, i64)>) {
    p.sort_by_key(|x| x.0);
    p.dedup_by(|later, earlier| {
        let same = later.0 == earlier.0;
        if same {
            earlier.1 = earlier.1.wrapping_add(later.1);
        }
        same
    });
    p.retain(|x| x.1 != 0);
}

/// Raises each term's maximum over posting block `block`, in each reading, to its highest score with a tag part
/// over the block's carriers (`best`, by term id, emptied), into `raised`: keyed by the term's id, then the level
/// and group of the term's maxima key (`search::block_maxima`).
fn raise_highest(
    best: &mut HashMap<(u32, bool), f64>,
    block: u64,
    raised: &mut HashMap<Vec<u8>, Val>,
    raised_bytes: &mut usize,
) {
    use crate::keyspace::val::put_u64;
    for ((id, as_prefix), v) in best.drain() {
        for (level, group, sl, bits) in crate::search::index::tag_part_slots(block, as_prefix, v) {
            let mut k = id.to_be_bytes().to_vec();
            put_u64(&mut k, level);
            put_u64(&mut k, group);
            *raised_bytes = raised_bytes.saturating_add_signed(sink_add(
                raised,
                k,
                Val::MaxMap(vec![(sl, bits)]),
            ));
        }
    }
}

/// A held carrier's key: its length block's key (`search::length_block`), its place in that block, the reading,
/// and the term's id, so that held carriers come in document order.
fn held_key(doc: u64, as_prefix: bool, id: u32) -> Vec<u8> {
    use crate::search::LENGTH_BITS;
    let mut k = crate::search::length_block(crate::search::Scope::LIBRARY, doc >> LENGTH_BITS);
    k.push((doc & ((1 << LENGTH_BITS) - 1)) as u8);
    k.push(u8::from(as_prefix));
    k.extend_from_slice(&id.to_be_bytes());
    k
}

/// Sorts the sink (and each map's slots), makes it a run numbered in spill order across the load's sinks, and
/// empties it. What making the run in memory allocates (`spill_memory`, from the sink's `bytes`) is reserved
/// before it starts; where the cap can't take it, the run is written straight to a file, with only the sink's
/// entries sorted beside it. A run made in memory stays there while the allocations are under the cap
/// (`Budget::hold`).
#[allow(clippy::too_many_arguments)]
fn spill(
    sink: &mut HashMap<Vec<u8>, Val>,
    out: &mut Spilled,
    dir: &Path,
    seq: &AtomicU64,
    staged: &mut Staged,
    budget: &Budget,
    bytes: usize,
) -> StoreResult<()> {
    let t = Instant::now();
    let n = seq.fetch_add(1, Ordering::Relaxed);
    let path = dir.join(format!("spill-{n:08}.run"));
    let reserved = budget.reserve(spill_memory(bytes, sink.len()))?;
    let in_memory = reserved.is_some();
    let mut w = if in_memory {
        // An encoding past the sink's bytes and the slack only grows the buffer.
        RunWriter::in_memory(16 << 10, bytes + ENCODE_SLACK)
    } else {
        RunWriter::create(&path, 16 << 10)?
    };
    let mut entries: Vec<(Vec<u8>, Val)> = sink.drain().collect();
    entries.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    for (k, mut v) in entries {
        match &mut v {
            Val::Map(p) => p.sort_unstable_by_key(|x| x.0),
            Val::MaxMap(p) => combine_max(p),
            Val::AddMap(p) => combine_added(p),
            _ => {}
        }
        w.add(&k, &v)?;
    }
    let run = if in_memory {
        let mut b = w.finish_in_memory(0, n, n)?;
        b.shrink_to_fit();
        let run = Arc::new(Run::in_memory(&path, b, n, n)?);
        drop(reserved);
        budget.kept.fetch_add(1, Ordering::Relaxed);
        budget.held.lock().unwrap().push_back(Arc::downgrade(&run));
        budget.hold()?;
        run
    } else {
        let len = w.finish(0, n, n)?;
        budget.files.fetch_add(1, Ordering::Relaxed);
        budget.file_bytes.fetch_add(len, Ordering::Relaxed);
        Arc::new(Run::open(&path, n, n)?)
    };
    // Newest first.
    staged.runs.insert(0, run.clone());
    out.runs.push((n, run));
    out.spill_micros += t.elapsed().as_micros() as u64;
    Ok(())
}

fn sync_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(not(windows))]
    File::open(dir)?.sync_all()?;
    #[cfg(windows)]
    let _ = dir;
    Ok(())
}

/// Before opening a store: finishes or undoes a load that a crash interrupted. With the install marker and the
/// load's first log file in the store's directory, every file was moved: the load is part of the log. Without
/// it, nothing of the load is: the files moved so far go, with the staging directory.
pub(super) fn recover(dir: &Path, cfg: &log::Config) -> StoreResult<()> {
    let staging = dir.join(LOAD_DIR);
    if !staging.exists() {
        return Ok(());
    }
    if let Ok(m) = fs::read_to_string(staging.join(MARKER)) {
        let mut it = m.split(' ').map(str::parse::<u64>);
        let (Some(Ok(first)), Some(Ok(last))) = (it.next(), it.next()) else {
            return Err(StoreError::Entry(format!(
                "a bulk load's install marker in {} doesn't read",
                staging.display()
            )));
        };
        if !dir.join(log::file_name(cfg, first)).exists() {
            for f in first..=last {
                match fs::remove_file(dir.join(log::file_name(cfg, f))) {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
                    _ => {}
                }
            }
            sync_dir(dir)?;
        }
    }
    fs::remove_dir_all(&staging)?;
    Ok(())
}

/// The staged runs' entries from `from` on, each key's values folded as their merge will.
/// Writes `v` over the sink's value at `k`.
fn sink_put(sink: &mut HashMap<Vec<u8>, Val>, bytes: &mut usize, k: Vec<u8>, v: Val) {
    *bytes += k.len() + ENTRY_OVERHEAD;
    let v = match sink.remove(&k) {
        Some(old) => v.over_owned(&k, old),
        None => v,
    };
    sink.insert(k, v);
}

fn staged_merge<'a>(staged: &'a Staged, from: &[u8]) -> StoreResult<Merge<'a>> {
    let sources = staged
        .runs
        .iter()
        .map(|r| -> StoreResult<Box<dyn Source>> {
            Ok(Box::new(RunIter::new(r.clone(), from, None, None)?))
        })
        .collect::<StoreResult<_>>()?;
    Ok(Merge::new(sources))
}

/// Whether a staged run holds an entry of `structure`.
fn staged_holds(staged: &Staged, structure: u64) -> StoreResult<bool> {
    use super::kinds::key;
    let start = key::of(structure);
    Ok(staged_merge(staged, &start)?
        .next_entry()?
        .is_some_and(|(k, _)| k < key::prefix_end(&start)))
}

#[cfg(test)]
mod sink_tests {
    use super::*;
    use crate::keyspace::val::map_bytes;

    /// A worker's sink takes added maps in any order, a slot several times, and adds them; spilled, each slot is
    /// once at its sum, none at 0, and an added map over a whole one is the whole sum.
    #[test]
    fn a_sink_adds_added_maps_and_spills_each_slot_once() {
        let dir = std::env::temp_dir().join(format!("st-engine-sink-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let (a, b) = (
            super::super::kinds::key::test_add_map(1).into_raw(),
            super::super::kinds::key::test_add_map(2).into_raw(),
        );
        let mut sink = HashMap::new();
        sink_add(&mut sink, a.clone(), Val::AddMap(vec![(2, 3), (9, 1)]));
        sink_add(&mut sink, a.clone(), Val::AddMap(vec![(2, -3), (5, 1)]));
        sink_add(&mut sink, a.clone(), Val::AddMap(vec![(9, 2)]));
        sink_add(&mut sink, b.clone(), Val::Put(map_bytes(&[(1, 1), (4, 2)])));
        sink_add(&mut sink, b.clone(), Val::AddMap(vec![(4, -2), (6, 1)]));
        let mut spilled = Spilled::default();
        let mut staged = Staged {
            runs: Vec::new(),
            cache: Cache::new(0),
            counts: ReadCounts::default(),
            staged_dir: dir.clone(),
            staged_from: 0,
            records: Arc::new(StagedRecords::default()),
        };
        spill(
            &mut sink,
            &mut spilled,
            &dir,
            &AtomicU64::new(0),
            &mut staged,
            &Budget::new(LOAD_BUFFER_BYTES, 1),
            0,
        )
        .unwrap();
        assert!(sink.is_empty());
        let run = &staged.runs[0];
        assert_eq!(
            run.get(&a, &staged.cache, &staged.counts).unwrap(),
            Some(Val::AddMap(vec![(5, 1), (9, 3)]))
        );
        assert_eq!(
            run.get(&b, &staged.cache, &staged.counts).unwrap(),
            Some(Val::Put(map_bytes(&[(1, 1), (6, 1)])))
        );
        drop(staged);
        drop(spilled);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A count summed past 2^32 from partitions' deltas, each under 2^32, comes back exact from the sink's run,
    /// merged with further added maps, settled and stored.
    #[test]
    fn a_sink_keeps_a_count_past_32_bits() {
        use crate::keyspace::val::{count_bytes, map_counts};
        let dir = std::env::temp_dir().join(format!("st-engine-sink-wide-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let a = super::super::kinds::key::test_add_map(1).into_raw();
        let part = (3i64 << 30) + 7;
        let mut sink = HashMap::new();
        for _ in 0..3 {
            sink_add(&mut sink, a.clone(), Val::AddMap(vec![(2, part), (9, 1)]));
        }
        let mut spilled = Spilled::default();
        let mut staged = Staged {
            runs: Vec::new(),
            cache: Cache::new(0),
            counts: ReadCounts::default(),
            staged_dir: dir.clone(),
            staged_from: 0,
            records: Arc::new(StagedRecords::default()),
        };
        spill(
            &mut sink,
            &mut spilled,
            &dir,
            &AtomicU64::new(0),
            &mut staged,
            &Budget::new(LOAD_BUFFER_BYTES, 1),
            0,
        )
        .unwrap();
        let summed = 3 * part;
        assert!(summed > 1 << 32);
        let got = staged.runs[0]
            .get(&a, &staged.cache, &staged.counts)
            .unwrap();
        assert_eq!(got, Some(Val::AddMap(vec![(2, summed), (9, 3)])));
        let merged = Val::AddMap(vec![(2, -7), (9, -3)]).over_owned(&a, got.unwrap());
        let want = vec![(2, (summed - 7) as u64)];
        assert_eq!(merged.clone().settled(&a), Some(Val::Counts(want.clone())));
        let stored = merged.over(&a, &Val::Del);
        assert_eq!(stored, Val::Put(count_bytes(&want)));
        let Val::Put(b) = stored else { unreachable!() };
        assert_eq!(map_counts(&b), Some(want));
        drop(staged);
        drop(spilled);
        let _ = fs::remove_dir_all(&dir);
    }
}
