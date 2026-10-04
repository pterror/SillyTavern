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

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::thread::JoinHandle;
use std::time::Instant;

use super::derive::{Layer, Loc, Out, Staged, View, deriver};
use super::{Inner, Loading, Store, StoreError, StoreResult};
use crate::keyspace::cache::Cache;
use crate::keyspace::run::{Merge, ReadCounts, Run, RunIter, RunWriter, Source};
use crate::keyspace::val::Val;
use crate::log::format::Record;
use crate::log::{self, Cursor, Layout, TailFile};

/// Memory the workers' buffers take together before spilling.
pub const LOAD_BUFFER_BYTES: usize = 1 << 30;
/// Workers deriving in parallel: every core but two, left to whatever else runs.
pub fn load_workers() -> usize {
    std::thread::available_parallelism().map_or(1, |n| n.get().saturating_sub(2).max(1))
}
/// Partitions go to workers in units of `1 << UNIT_BITS` consecutive ids.
const UNIT_BITS: u32 = 6;
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
    pub spills: u64,
    pub spill_bytes: u64,
    /// Merging the spills into the load's run.
    pub merge_micros: u64,
    pub run_bytes: u64,
    pub run_entries: u64,
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
    spill_bytes: u64,
}

/// A bulk load in progress (`Store::loader`). Dropped without `finish`, it is abandoned and leaves the store as
/// it was.
pub struct Loader<'s> {
    store: &'s Store,
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
}

impl Store {
    /// Starts a bulk load. Only one runs at a time; commits go on meanwhile.
    pub fn loader(&self) -> StoreResult<Loader<'_>> {
        let inner = &self.inner;
        inner.wait_ready()?;
        let dir = inner.dir.join(LOAD_DIR);
        let first_file = {
            let mut p = inner.pipe.lock().unwrap();
            if p.closed {
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
        let seq = Arc::new(AtomicU64::new(0));
        let budget = LOAD_BUFFER_BYTES / load_workers();
        let workers = (0..load_workers())
            .map(|w| {
                let (tx, rx) = sync_channel::<Vec<Laid>>(4);
                let inner = inner.clone();
                let dir = dir.clone();
                let seq = seq.clone();
                let staged_from = log::position(first_file, 0);
                let handle = std::thread::Builder::new()
                    .name(format!("st-engine-load-{w}"))
                    .spawn(move || work(&inner, w, rx, &dir, staged_from, budget, &seq))
                    .expect("a load worker thread");
                Worker {
                    tx: Some(tx),
                    handle: Some(handle),
                }
            })
            .collect();
        Ok(Loader {
            store: self,
            dir,
            first_file,
            layout: Layout::start(&inner.cfg.log, Cursor::file_start(first_file), false),
            batch: Vec::new(),
            workers,
            end: None,
            stats: LoadStats::default(),
            started: Instant::now(),
            failed: None,
            finished: false,
            keep_staging: false,
        })
    }
}

pub(super) const LOAD_DIR: &str = "load";

/// Tests stop an install as a crash would: 1 after the marker, 2 after the files moved.
#[cfg(test)]
pub(super) static FAIL_AT: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);
const MARKER: &str = "install";

impl Loader<'_> {
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
        let target = self.store.inner.cfg.log.file_target;
        for rec in records {
            let d = deriver(rec.kind);
            if rec.kind.internal || d.prepares() {
                return Err(StoreError::Refused(format!(
                    "{} records can't be bulk loaded",
                    rec.kind.name
                )));
            }
            let partition = d.partition(&rec);
            let (pos, len) = self.layout.record(&rec);
            self.batch.push((rec, Loc { pos, len }, partition));
            self.stats.records += 1;
            if self.layout.offset() >= target {
                self.close_file()?;
                self.layout = Layout::start(
                    &self.store.inner.cfg.log,
                    Cursor::file_start(self.layout.file + 1),
                    false,
                );
            }
        }
        Ok(())
    }

    /// Ends the open file's group, writes and syncs it in the staging directory, and hands its records to the
    /// workers.
    fn close_file(&mut self) -> StoreResult<()> {
        self.end = Some(self.layout.close());
        let log = &self.store.inner.log;
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
                // The worker stopped on an error; `finish` reports it.
                return Err(StoreError::Failed("a load worker stopped".into()));
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
                    self.stats.spill_bytes += s.spill_bytes;
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
        self.stats.spills = runs.len() as u64;
        let Some(end) = self.end else {
            // Nothing was loaded.
            self.abandon();
            self.stats.total_micros = self.started.elapsed().as_micros() as u64;
            return Ok(self.stats);
        };

        // ---- one run of everything the workers spilled, newest spill first ----
        let t = Instant::now();
        runs.sort_by_key(|(seq, _)| std::cmp::Reverse(*seq));
        let runs: Vec<Arc<Run>> = runs.into_iter().map(|(_, r)| r).collect();
        let path = self.dir.join("load.run");
        let block_size = self.store.inner.ks.config().block_size;
        let (entries, bytes) = merge_runs(&runs, &self.dir, &path, block_size, self.workers.len())?;
        for r in &runs {
            r.obsolete.store(true, Ordering::Release);
        }
        drop(runs);
        self.stats.run_entries = entries;
        self.stats.run_bytes = bytes;
        self.stats.merge_micros = t.elapsed().as_micros() as u64;

        // ---- install ----
        let t = Instant::now();
        self.install(&path, end)?;
        self.stats.install_micros = t.elapsed().as_micros() as u64;
        self.stats.total_micros = self.started.elapsed().as_micros() as u64;
        Ok(self.stats)
    }

    fn install(&mut self, run: &Path, end: Cursor) -> StoreResult<()> {
        let inner = self.store.inner.clone();
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
            if FAIL_AT.load(Ordering::Relaxed) == 1 {
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
            if FAIL_AT.load(Ordering::Relaxed) == 2 {
                return Err(StoreError::Failed("failpoint: before the run".into()));
            }
            {
                let mut p = inner.pipe.lock().unwrap();
                p.cursor = end;
                inner.log.set_durable(end);
                *inner.tail.lock().unwrap() = TailFile::existing(last_file);
            }
            inner
                .ks
                .install_run(run, log::position(end.file, end.offset))?;
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
            let p = self.store.inner.pipe.lock().unwrap();
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
        let inner = &self.store.inner;
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

impl Drop for Loader<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.abandon();
        }
    }
}

/// A worker: derives its partitions' records in order. The current partition's entries are kept apart, where
/// its next record reads them; a finished partition's join the sink, where each key's values from all partitions
/// are combined (their maps' slots and counters are each partition's own share), sorted and spilled to a run once
/// it passes `budget`. A partition met again after others (input not in partition order) is read through the
/// spilled runs, the sink spilled first.
fn work(
    inner: &Inner,
    w: usize,
    rx: Receiver<Vec<Laid>>,
    dir: &Path,
    staged_from: u64,
    budget: usize,
    seq: &AtomicU64,
) -> StoreResult<Spilled> {
    let mut out = Spilled::default();
    let mut cur: HashMap<Vec<u8>, Val> = HashMap::new();
    let mut cur_partition: Option<u64> = None;
    let mut cur_again = false;
    let mut highest: Option<u64> = None;
    let mut sink: HashMap<Vec<u8>, Val> = HashMap::new();
    let mut sink_bytes = 0usize;
    let mut staged = Staged {
        runs: Vec::new(),
        cache: Cache::new(16 << 20),
        counts: ReadCounts::default(),
        staged_dir: dir.to_path_buf(),
        staged_from,
    };
    let records_only = Staged {
        runs: Vec::new(),
        cache: Cache::new(0),
        counts: ReadCounts::default(),
        staged_dir: dir.to_path_buf(),
        staged_from,
    };
    let mut parts = BufWriter::new(File::create(dir.join(format!("parts-{w}")))?);
    for batch in rx {
        let (t, spilling) = (Instant::now(), out.spill_micros);
        for (rec, at, partition) in batch {
            if cur_partition != Some(partition) {
                for (k, v) in cur.drain() {
                    sink_bytes += sink_add(&mut sink, k, v);
                }
                let again = highest.is_some_and(|h| partition <= h);
                if sink_bytes >= budget || (again && !sink.is_empty()) {
                    spill(&mut sink, &mut out, dir, seq, &mut staged)?;
                    sink_bytes = 0;
                }
                parts.write_all(&partition.to_le_bytes())?;
                cur_partition = Some(partition);
                cur_again = again;
                highest = Some(highest.map_or(partition, |h| h.max(partition)));
            }
            let view = View {
                layers: vec![Layer::Hashed(&cur)],
                pending: Vec::new(),
                staged: Some(if cur_again { &staged } else { &records_only }),
                bulk: true,
                ks: &inner.ks,
                log: &inner.log,
            };
            let mut o = Out::default();
            deriver(rec.kind)
                .derive(&rec, at, &view, &mut o)
                .map_err(|e| {
                    StoreError::Failed(format!("the {} record at {}: {e}", rec.kind.name, at.pos))
                })?;
            drop(view);
            o.apply_hashed(&mut cur);
        }
        out.derive_micros += t.elapsed().as_micros() as u64 - (out.spill_micros - spilling);
    }
    for (k, v) in cur.drain() {
        sink_add(&mut sink, k, v);
    }
    if !sink.is_empty() {
        spill(&mut sink, &mut out, dir, seq, &mut staged)?;
    }
    parts.flush()?;
    Ok(out)
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

/// Adds a finished partition's value to the sink; returns the memory it took. A map's slots are appended and
/// sorted when spilled (a maxima map's then kept once each, at the highest).
fn sink_add(sink: &mut HashMap<Vec<u8>, Val>, k: Vec<u8>, v: Val) -> usize {
    use std::collections::hash_map::Entry;
    match sink.entry(k) {
        Entry::Vacant(e) => {
            let n = e.key().len() + v.payload_len() + ENTRY_OVERHEAD;
            e.insert(v);
            n
        }
        Entry::Occupied(mut e) => {
            let old = e.get_mut();
            match (old, v) {
                (Val::Map(a), Val::Map(b)) | (Val::MaxMap(a), Val::MaxMap(b)) => {
                    let n = b.len() * 8;
                    a.extend(b);
                    n
                }
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
                    *old = v.over_owned(older);
                    n
                }
            }
        }
    }
}

/// Sorts the sink (and each map's slots), writes it as a run numbered in spill order across workers, and empties
/// it.
fn spill(
    sink: &mut HashMap<Vec<u8>, Val>,
    out: &mut Spilled,
    dir: &Path,
    seq: &AtomicU64,
    staged: &mut Staged,
) -> StoreResult<()> {
    let t = Instant::now();
    let n = seq.fetch_add(1, Ordering::Relaxed);
    let path = dir.join(format!("spill-{n:08}.run"));
    let mut w = RunWriter::create(&path, 16 << 10)?;
    let mut entries: Vec<(Vec<u8>, Val)> = sink.drain().collect();
    entries.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    for (k, mut v) in entries {
        match &mut v {
            Val::Map(p) => p.sort_unstable_by_key(|x| x.0),
            Val::MaxMap(p) => {
                p.sort_unstable();
                // Each slot once, at its highest.
                p.dedup_by(|later, earlier| {
                    let same = later.0 == earlier.0;
                    if same {
                        earlier.1 = earlier.1.max(later.1);
                    }
                    same
                });
            }
            _ => {}
        }
        w.add(&k, &v)?;
    }
    out.spill_bytes += w.finish(0, n, n)?;
    let run = Arc::new(Run::open(&path, n, n)?);
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
