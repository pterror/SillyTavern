//! P2, the derived keyspace (design `.plans/2026-10-03-storage-from-needs.md` 4.2–4.4): one shared in-memory
//! buffer of entries sorted by key, flushed as one immutable run per `buffer_bytes` of entries or `log_bytes` of
//! log, runs merged in tiers of `fan_in` on the keyspace's own threads, reads merging the buffer and every run.
//!
//! Runs live in `<dir>/run-<first flush>-<last flush>.run` (16 hex digits each). A run is written as `.tmp`,
//! synced, renamed and its directory synced, so a `.run` is always whole. A merge's output holds every flush its
//! inputs held, and the inputs are removed only after it is in place: a run whose flushes another run also holds
//! is left over from a crash during that removal.

pub mod block;
pub mod cache;
pub mod run;
pub mod val;

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io;
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, RwLock};
use std::thread::JoinHandle;

use cache::Cache;
use run::{
    Merge, ReadCounts, Run, RunIter, RunWriter, Source, VecSource, parse_run_name, run_name,
};
use val::Val;

#[derive(Debug)]
pub enum KsError {
    Io(io::Error),
    Corrupt { file: String, why: String },
}

impl std::fmt::Display for KsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KsError::Io(e) => write!(f, "derived keyspace I/O error: {e}"),
            KsError::Corrupt { file, why } => write!(
                f,
                "derived keyspace file {file} is damaged: {why}. Nothing was changed; the store won't open \
                 until it is repaired."
            ),
        }
    }
}

impl std::error::Error for KsError {}

impl From<io::Error> for KsError {
    fn from(e: io::Error) -> Self {
        KsError::Io(e)
    }
}

pub type KsResult<T> = Result<T, KsError>;

/// Keys and values, in key order.
pub type Entries = Vec<(Vec<u8>, Vec<u8>)>;

#[derive(Debug, Clone, Copy)]
pub struct KsConfig {
    /// B: the buffer is flushed once its entries take this many bytes of memory.
    pub buffer_bytes: usize,
    /// L: the buffer is flushed once this many bytes of log have been written since the last flush, so replay
    /// after a crash reads less than this.
    pub log_bytes: u64,
    /// δ: runs of one tier are merged this many at a time.
    pub fan_in: usize,
    /// C: the block cache's size.
    pub cache_bytes: usize,
    /// A run block's target size.
    pub block_size: usize,
    pub merge_threads: usize,
    /// Buffers waiting for their flush; commits wait while this many are.
    pub max_frozen: usize,
}

/// Memory per buffered entry besides its key and value: the map's node share and the allocations' headers.
/// Measured: 136 bytes per entry of 12 bytes of key and value (`examples/measure.rs calibrate`).
const ENTRY_OVERHEAD: usize = 128;

/// The shared in-memory buffer.
#[derive(Default)]
pub struct Mem {
    map: BTreeMap<Vec<u8>, Val>,
    bytes: usize,
    /// The log position its entries cover, once frozen.
    covered: u64,
}

impl Mem {
    fn insert(&mut self, key: Vec<u8>, val: Val) {
        match self.map.get_mut(&key) {
            Some(old) => {
                let older = std::mem::replace(old, Val::Del);
                *old = val.over(&older);
                self.bytes = self.bytes - older.payload_len() + old.payload_len();
            }
            None => {
                self.bytes += key.len() + val.payload_len() + ENTRY_OVERHEAD;
                self.map.insert(key, val);
            }
        }
    }

    pub fn get(&self, key: &[u8]) -> Option<&Val> {
        self.map.get(key)
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn iter(&self) -> impl Iterator<Item = (&Vec<u8>, &Val)> {
        self.map.iter()
    }

    /// Entries in `[start, end)`, in order.
    pub fn range<'a>(
        &'a self,
        start: &[u8],
        end: &[u8],
    ) -> impl Iterator<Item = (&'a Vec<u8>, &'a Val)> {
        self.map
            .range::<[u8], _>((Bound::Included(start), Bound::Excluded(end)))
    }

    /// Entries in `[start, end)` in order, until `live` of them aren't deletions.
    fn page(&self, start: &[u8], end: &[u8], live: usize) -> Vec<(Vec<u8>, Val)> {
        let mut out = Vec::new();
        let mut n = 0;
        for (k, v) in self.range(start, end) {
            if n == live {
                break;
            }
            if *v != Val::Del {
                n += 1;
            }
            out.push((k.clone(), v.clone()));
        }
        out
    }
}

/// What a read sees: buffers and runs, newest first. `mems[0]` is the buffer taking inserts.
pub struct Version {
    pub mems: Vec<Arc<RwLock<Mem>>>,
    pub runs: Vec<Arc<Run>>,
}

/// Work the store does around flushes.
pub trait Hooks: Send + Sync {
    /// Entries to write into the run flushed from `mem`, sorted; `older` are the runs before it.
    fn flush_extra(
        &self,
        ks: &Keyspace,
        mem: &Mem,
        older: &[Arc<Run>],
    ) -> KsResult<Vec<(Vec<u8>, Val)>>;
    /// After a flushed run is in place.
    fn flushed(&self, ks: &Keyspace);
}

/// Counts kept for measurement.
#[derive(Debug, Default, Clone, Copy)]
pub struct KsStats {
    pub flushes: u64,
    /// Bytes of run files written by flushes and by merges.
    pub flush_bytes: u64,
    pub merges: u64,
    pub merge_bytes: u64,
    /// Entries inserted into the buffer.
    pub inserted: u64,
    pub runs: u64,
    pub run_bytes: u64,
    pub lookups: u64,
    /// Index and data blocks fetched by lookups and page reads, and how many of them came from files.
    pub blocks: u64,
    pub file_reads: u64,
    pub buffer_bytes: u64,
    pub cache_bytes: u64,
    /// Bytes of resident top blocks.
    pub top_bytes: u64,
}

#[derive(Default)]
struct Counters {
    flushes: AtomicU64,
    flush_bytes: AtomicU64,
    merges: AtomicU64,
    merge_bytes: AtomicU64,
    inserted: AtomicU64,
    lookups: AtomicU64,
}

struct WriteState {
    log_bytes: u64,
}

struct Jobs {
    busy: HashSet<u64>,
    next_flush: u64,
    stop: bool,
    /// A flushed run is being written.
    flushing: bool,
    /// Merges being written.
    merging: usize,
    /// Flushes that failed (each is retried).
    flush_failures: u64,
}

pub struct Keyspace {
    cfg: KsConfig,
    dir: PathBuf,
    version: Mutex<Arc<Version>>,
    write: Mutex<WriteState>,
    /// Signalled when a frozen buffer has been flushed.
    flushed_cv: Condvar,
    jobs: Mutex<Jobs>,
    jobs_cv: Condvar,
    pub cache: Cache,
    pub counts: ReadCounts,
    counters: Counters,
    hooks: OnceLock<Box<dyn Hooks>>,
    threads: Mutex<Vec<JoinHandle<()>>>,
}

fn sync_dir(dir: &Path) -> io::Result<()> {
    #[cfg(not(windows))]
    fs::File::open(dir)?.sync_all()?;
    #[cfg(windows)]
    let _ = dir;
    Ok(())
}

impl Keyspace {
    /// Opens the runs in `dir` (created if missing): only each run's footer and top block are read.
    pub fn open(dir: &Path, cfg: KsConfig) -> KsResult<Arc<Keyspace>> {
        if !dir.exists() {
            fs::create_dir_all(dir)?;
            if let Some(parent) = dir.parent() {
                sync_dir(parent)?;
            }
        }
        let mut found = Vec::new();
        for entry in fs::read_dir(dir)? {
            let name = entry?.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with("run-") && name.ends_with(".tmp") {
                // A run whose writing didn't finish: nothing counted on it.
                fs::remove_file(dir.join(name))?;
            } else if let Some(range) = parse_run_name(name) {
                found.push(range);
            }
        }
        // Widest first, so a run held by another is seen after it.
        found.sort_by_key(|&(lo, hi)| (lo, std::cmp::Reverse(hi)));
        let mut runs: Vec<Arc<Run>> = Vec::new();
        let mut next = 0;
        for (lo, hi) in found {
            if hi < next {
                fs::remove_file(dir.join(run_name(lo, hi)))?;
                continue;
            }
            if lo != next {
                return Err(KsError::Corrupt {
                    file: dir.join(run_name(lo, hi)).display().to_string(),
                    why: if lo > next {
                        format!("flushes {next} to {} are in no run", lo - 1)
                    } else {
                        "holds some of another run's flushes but not all".into()
                    },
                });
            }
            runs.push(Arc::new(Run::open(&dir.join(run_name(lo, hi)), lo, hi)?));
            next = hi + 1;
        }
        runs.reverse();
        for w in runs.windows(2) {
            if w[0].covered < w[1].covered {
                return Err(KsError::Corrupt {
                    file: w[0].path.display().to_string(),
                    why: "covers less of the log than the run before it".into(),
                });
            }
        }
        Ok(Arc::new(Keyspace {
            cfg,
            dir: dir.to_path_buf(),
            version: Mutex::new(Arc::new(Version {
                mems: vec![Arc::new(RwLock::new(Mem::default()))],
                runs,
            })),
            write: Mutex::new(WriteState { log_bytes: 0 }),
            flushed_cv: Condvar::new(),
            jobs: Mutex::new(Jobs {
                busy: HashSet::new(),
                next_flush: next,
                stop: false,
                flushing: false,
                merging: 0,
                flush_failures: 0,
            }),
            jobs_cv: Condvar::new(),
            cache: Cache::new(cfg.cache_bytes),
            counts: ReadCounts::default(),
            counters: Counters::default(),
            hooks: OnceLock::new(),
            threads: Mutex::new(Vec::new()),
        }))
    }

    pub fn config(&self) -> &KsConfig {
        &self.cfg
    }

    /// Starts the flush and merge threads.
    pub fn start(self: &Arc<Self>, hooks: Box<dyn Hooks>) -> io::Result<()> {
        let _ = self.hooks.set(hooks);
        let mut threads = self.threads.lock().unwrap();
        let ks = self.clone();
        threads.push(
            std::thread::Builder::new()
                .name("st-engine-flush".into())
                .spawn(move || ks.flush_loop())?,
        );
        for i in 0..self.cfg.merge_threads {
            let ks = self.clone();
            threads.push(
                std::thread::Builder::new()
                    .name(format!("st-engine-merge-{i}"))
                    .spawn(move || ks.merge_loop())?,
            );
        }
        // Runs left unmerged by an earlier close.
        self.jobs_cv.notify_all();
        Ok(())
    }

    pub fn version(&self) -> Arc<Version> {
        self.version.lock().unwrap().clone()
    }

    /// The log position the newest run covers (0 with no runs).
    pub fn covered(&self) -> u64 {
        self.version().runs.first().map_or(0, |r| r.covered)
    }

    pub fn has_runs(&self) -> bool {
        !self.version().runs.is_empty()
    }

    // ---- reads ----

    /// Every value `key` has, newest first, down to the first that hides the older ones.
    pub fn values(&self, key: &[u8]) -> KsResult<Vec<Val>> {
        self.counters.lookups.fetch_add(1, Ordering::Relaxed);
        let v = self.version();
        let mut out = Vec::new();
        for m in &v.mems {
            if let Some(val) = m.read().unwrap().get(key) {
                let done = !matches!(val, Val::Add(_));
                out.push(val.clone());
                if done {
                    return Ok(out);
                }
            }
        }
        for r in &v.runs {
            if let Some(val) = r.get(key, &self.cache, &self.counts)? {
                let done = !matches!(val, Val::Add(_));
                out.push(val);
                if done {
                    return Ok(out);
                }
            }
        }
        Ok(out)
    }

    /// The value of `key`.
    pub fn get(&self, key: &[u8]) -> KsResult<Option<Vec<u8>>> {
        Ok(val::fold(self.values(key)?).and_then(Val::resolved))
    }

    /// Up to `limit` keys in `[start, end)` that have values, in order, with their values.
    pub fn scan(&self, start: &[u8], end: &[u8], limit: usize) -> KsResult<Entries> {
        let v = self.version();
        let mut sources: Vec<Box<dyn Source>> = Vec::new();
        // A buffer's first `limit` live entries bound where the page can end, so nothing past them is needed.
        for m in &v.mems {
            sources.push(Box::new(VecSource::new(
                m.read().unwrap().page(start, end, limit),
            )));
        }
        for r in &v.runs {
            if start <= r.max_key.as_slice() {
                sources.push(Box::new(RunIter::new(
                    r.clone(),
                    start,
                    Some(&self.cache),
                    Some(&self.counts),
                )?));
            }
        }
        let mut merge = Merge::new(sources);
        let mut out = Vec::new();
        while out.len() < limit {
            let Some((k, val)) = merge.next_entry()? else {
                break;
            };
            if k.as_slice() >= end {
                break;
            }
            if let Some(b) = val.resolved() {
                out.push((k, b));
            }
        }
        Ok(out)
    }

    // ---- writes ----

    /// Inserts entries into the buffer. `log` is the log end these entries bring the buffer up to and the
    /// bytes of log since the previous insert that carried one; when the buffer reaches B or the log L since
    /// the last flush, the buffer is frozen there and flushed. Waits while `max_frozen` buffers wait for
    /// their flush.
    pub fn insert<I: IntoIterator<Item = (Vec<u8>, Val)>>(
        &self,
        entries: I,
        log: Option<(u64, u64)>,
    ) {
        let mut w = self.write.lock().unwrap();
        {
            let v = self.version();
            let mut m = v.mems[0].write().unwrap();
            let mut n = 0;
            for (k, val) in entries {
                m.insert(k, val);
                n += 1;
            }
            self.counters.inserted.fetch_add(n, Ordering::Relaxed);
        }
        if let Some((end, bytes)) = log {
            w.log_bytes += bytes;
            let full = self.version().mems[0].read().unwrap().bytes >= self.cfg.buffer_bytes;
            if full || w.log_bytes >= self.cfg.log_bytes {
                drop(self.freeze(w, end));
            }
        }
    }

    /// Freezes the buffer as covering the log up to `end`, if it holds anything or `end` is past what the
    /// runs cover. Returns once it is queued for its flush.
    pub fn freeze_at(&self, end: u64) {
        let w = self.write.lock().unwrap();
        let v = self.version();
        let newest = v.mems.get(1).map(|m| m.read().unwrap().covered);
        let covered = newest.unwrap_or_else(|| v.runs.first().map_or(0, |r| r.covered));
        if v.mems[0].read().unwrap().bytes > 0 || end > covered {
            drop(self.freeze(w, end));
        }
    }

    fn freeze<'a>(
        &'a self,
        mut w: MutexGuard<'a, WriteState>,
        end: u64,
    ) -> MutexGuard<'a, WriteState> {
        while self.version().mems.len() > self.cfg.max_frozen {
            w = self.flushed_cv.wait(w).unwrap();
        }
        let mut version = self.version.lock().unwrap();
        let mut mems = version.mems.clone();
        mems[0].write().unwrap().covered = end;
        mems.insert(0, Arc::new(RwLock::new(Mem::default())));
        *version = Arc::new(Version {
            mems,
            runs: version.runs.clone(),
        });
        drop(version);
        w.log_bytes = 0;
        // Taken so the flusher can't miss the wakeup between checking for work and waiting.
        drop(self.jobs.lock().unwrap());
        self.jobs_cv.notify_all();
        w
    }

    /// Waits until every frozen buffer has been flushed, or a flush fails.
    pub fn wait_flushed(&self) -> KsResult<()> {
        let failures = self.jobs.lock().unwrap().flush_failures;
        let mut w = self.write.lock().unwrap();
        while self.version().mems.len() > 1 {
            if self.jobs.lock().unwrap().flush_failures > failures {
                return Err(KsError::Io(io::Error::other("a flush failed")));
            }
            w = self.flushed_cv.wait(w).unwrap();
        }
        Ok(())
    }

    // ---- flushes ----

    fn flush_loop(&self) {
        loop {
            let mem = {
                let mut jobs = self.jobs.lock().unwrap();
                loop {
                    let v = self.version();
                    if v.mems.len() > 1 {
                        jobs.flushing = true;
                        break v.mems.last().unwrap().clone();
                    }
                    if jobs.stop {
                        return;
                    }
                    jobs = self.jobs_cv.wait(jobs).unwrap();
                }
            };
            let result = self.flush(&mem);
            self.jobs.lock().unwrap().flushing = false;
            match result {
                Ok(()) => {
                    {
                        let _w = self.write.lock().unwrap();
                        self.flushed_cv.notify_all();
                    }
                    self.jobs_cv.notify_all();
                    if let Some(h) = self.hooks.get() {
                        h.flushed(self);
                    }
                }
                Err(e) => {
                    // The buffer stays frozen, so nothing is lost: its entries are still read from memory, and
                    // after a restart replay derives them again. Commits wait once `max_frozen` pile up.
                    eprintln!("st-engine: flushing the derived keyspace failed: {e}");
                    let stop = {
                        let mut jobs = self.jobs.lock().unwrap();
                        jobs.flush_failures += 1;
                        jobs.stop
                    };
                    // `write` is never taken while holding `jobs`.
                    {
                        let _w = self.write.lock().unwrap();
                        self.flushed_cv.notify_all();
                    }
                    if stop {
                        return;
                    }
                    let jobs = self.jobs.lock().unwrap();
                    if !jobs.stop {
                        drop(
                            self.jobs_cv
                                .wait_timeout(jobs, std::time::Duration::from_secs(1))
                                .unwrap(),
                        );
                    }
                }
            }
        }
    }

    fn flush(&self, mem: &Arc<RwLock<Mem>>) -> KsResult<()> {
        let seq = self.jobs.lock().unwrap().next_flush;
        let older = self.version().runs.clone();
        let m = mem.read().unwrap();
        let extra = match self.hooks.get() {
            Some(h) => h.flush_extra(self, &m, &older)?,
            None => Vec::new(),
        };
        let name = run_name(seq, seq);
        let tmp = self.dir.join(name.replace(".run", ".tmp"));
        // Left by a flush that failed part way.
        let _ = fs::remove_file(&tmp);
        let mut w = RunWriter::create(&tmp, self.cfg.block_size)?;
        // The buffer's own entries win over the extra ones for the same key.
        let mut extra = extra.into_iter().peekable();
        for (k, v) in m.iter() {
            while let Some((ek, ev)) = extra.next_if(|(ek, _)| ek < k) {
                w.add(&ek, &ev)?;
            }
            extra.next_if(|(ek, _)| ek == k);
            w.add(k, v)?;
        }
        for (ek, ev) in extra {
            w.add(&ek, &ev)?;
        }
        let covered = m.covered;
        drop(m);
        let bytes = w.finish(covered, seq, seq)?;
        let path = self.dir.join(&name);
        fs::rename(&tmp, &path)?;
        sync_dir(&self.dir)?;
        let run = Arc::new(Run::open(&path, seq, seq)?);
        {
            let mut version = self.version.lock().unwrap();
            let mut mems = version.mems.clone();
            mems.retain(|x| !Arc::ptr_eq(x, mem));
            let mut runs = version.runs.clone();
            runs.insert(0, run);
            *version = Arc::new(Version { mems, runs });
        }
        self.jobs.lock().unwrap().next_flush = seq + 1;
        self.counters.flushes.fetch_add(1, Ordering::Relaxed);
        self.counters
            .flush_bytes
            .fetch_add(bytes, Ordering::Relaxed);
        Ok(())
    }

    // ---- merges ----

    /// A run's tier: runs within a factor δ of each other in size share one. The unit is the size a flush of
    /// a full buffer comes out at on disk, or below (entries take several times their encoded size in memory).
    fn tier(&self, bytes: u64) -> u32 {
        let unit = (self.cfg.buffer_bytes as u64 / 8).max(1);
        let delta = self.cfg.fan_in as u64;
        let mut t = 0;
        let mut size = unit * delta;
        while bytes >= size {
            t += 1;
            size = size.saturating_mul(delta);
        }
        t
    }

    /// Picks adjacent runs to merge: `fan_in` of one tier, the lowest tier first; or, past a run count no
    /// tiering leaves, the adjacent `fan_in` with the fewest bytes. Returns them oldest first.
    fn pick(&self, jobs: &Jobs) -> Option<Vec<Arc<Run>>> {
        let delta = self.cfg.fan_in;
        let v = self.version();
        let runs: Vec<&Arc<Run>> = v.runs.iter().rev().collect();
        let free = |r: &&Arc<Run>| !jobs.busy.contains(&r.uid);
        let mut best: Option<(u32, usize)> = None;
        let mut i = 0;
        while i < runs.len() {
            let t = self.tier(runs[i].bytes);
            let mut j = i;
            while j < runs.len() && free(&runs[j]) && self.tier(runs[j].bytes) == t {
                j += 1;
            }
            if j - i >= delta && best.is_none_or(|(bt, _)| t < bt) {
                best = Some((t, i));
            }
            i = j.max(i + 1);
        }
        if let Some((_, i)) = best {
            return Some(runs[i..i + delta].iter().map(|r| (*r).clone()).collect());
        }
        if runs.len() > delta * 16 {
            return runs
                .windows(delta)
                .filter(|w| w.iter().all(free))
                .min_by_key(|w| w.iter().map(|r| r.bytes).sum::<u64>())
                .map(|w| w.iter().map(|r| (*r).clone()).collect());
        }
        None
    }

    fn merge_loop(&self) {
        loop {
            let inputs = {
                let mut jobs = self.jobs.lock().unwrap();
                loop {
                    if jobs.stop {
                        return;
                    }
                    if let Some(inputs) = self.pick(&jobs) {
                        for r in &inputs {
                            jobs.busy.insert(r.uid);
                        }
                        jobs.merging += 1;
                        break inputs;
                    }
                    jobs = self.jobs_cv.wait(jobs).unwrap();
                }
            };
            let result = self.merge(&inputs);
            {
                let mut jobs = self.jobs.lock().unwrap();
                for r in &inputs {
                    jobs.busy.remove(&r.uid);
                }
                jobs.merging -= 1;
            }
            self.jobs_cv.notify_all();
            match result {
                Ok(_) => {}
                Err(e) => {
                    eprintln!("st-engine: merging runs failed: {e}");
                    std::thread::sleep(std::time::Duration::from_secs(1));
                }
            }
        }
    }

    /// Merges `inputs` (adjacent, oldest first) into one run. Returns false if stopped before the end.
    fn merge(&self, inputs: &[Arc<Run>]) -> KsResult<bool> {
        let (lo, hi) = (inputs[0].lo, inputs.last().unwrap().hi);
        let covered = inputs.last().unwrap().covered;
        // With the oldest run among the inputs, nothing older exists for a deletion to hide.
        let bottom = self.version().runs.last().map(|r| r.uid) == Some(inputs[0].uid);
        let name = run_name(lo, hi);
        let tmp = self.dir.join(name.replace(".run", ".tmp"));
        let mut sources: Vec<Box<dyn Source>> = Vec::new();
        for r in inputs.iter().rev() {
            sources.push(Box::new(RunIter::new(r.clone(), &[], None, None)?));
        }
        let mut merge = Merge::new(sources);
        // Left by a merge that failed part way.
        let _ = fs::remove_file(&tmp);
        let mut w = RunWriter::create(&tmp, self.cfg.block_size)?;
        let mut n = 0u64;
        while let Some((k, v)) = merge.next_entry()? {
            let v = if bottom {
                match v.bottom() {
                    Some(v) => v,
                    None => continue,
                }
            } else {
                v
            };
            w.add(&k, &v)?;
            n += 1;
            if n.is_multiple_of(4096) && self.jobs.lock().unwrap().stop {
                drop(w);
                fs::remove_file(&tmp)?;
                return Ok(false);
            }
        }
        let bytes = w.finish(covered, lo, hi)?;
        let path = self.dir.join(&name);
        fs::rename(&tmp, &path)?;
        sync_dir(&self.dir)?;
        let run = Arc::new(Run::open(&path, lo, hi)?);
        {
            let mut version = self.version.lock().unwrap();
            let mut runs = Vec::with_capacity(version.runs.len());
            for r in &version.runs {
                if inputs.iter().any(|i| i.uid == r.uid) {
                    if r.uid == inputs.last().unwrap().uid {
                        runs.push(run.clone());
                    }
                } else {
                    runs.push(r.clone());
                }
            }
            *version = Arc::new(Version {
                mems: version.mems.clone(),
                runs,
            });
        }
        for r in inputs {
            r.obsolete.store(true, Ordering::Release);
        }
        self.counters.merges.fetch_add(1, Ordering::Relaxed);
        self.counters
            .merge_bytes
            .fetch_add(bytes, Ordering::Relaxed);
        Ok(true)
    }

    /// Waits until no merge is due or running.
    pub fn wait_merged(&self) {
        let mut jobs = self.jobs.lock().unwrap();
        while jobs.merging > 0 || jobs.flushing || self.pick(&jobs).is_some() {
            jobs = self.jobs_cv.wait(jobs).unwrap();
        }
    }

    /// Stops the flush and merge threads; a merge in progress is abandoned. Frozen buffers not yet flushed
    /// are not written (their records are replayed on the next open).
    pub fn stop(&self) {
        self.jobs.lock().unwrap().stop = true;
        self.jobs_cv.notify_all();
        for t in self.threads.lock().unwrap().drain(..) {
            let _ = t.join();
        }
    }

    pub fn stats(&self) -> KsStats {
        let v = self.version();
        let c = &self.counters;
        KsStats {
            flushes: c.flushes.load(Ordering::Relaxed),
            flush_bytes: c.flush_bytes.load(Ordering::Relaxed),
            merges: c.merges.load(Ordering::Relaxed),
            merge_bytes: c.merge_bytes.load(Ordering::Relaxed),
            inserted: c.inserted.load(Ordering::Relaxed),
            runs: v.runs.len() as u64,
            run_bytes: v.runs.iter().map(|r| r.bytes).sum(),
            lookups: c.lookups.load(Ordering::Relaxed),
            blocks: self.counts.blocks.load(Ordering::Relaxed),
            file_reads: self.counts.file_reads.load(Ordering::Relaxed),
            buffer_bytes: v.mems.iter().map(|m| m.read().unwrap().bytes as u64).sum(),
            cache_bytes: self.cache.bytes() as u64,
            top_bytes: v.runs.iter().map(|r| r.top_size() as u64).sum(),
        }
    }
}

impl Drop for Keyspace {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests;
