//! P2, the derived keyspace (design `.plans/2026-10-03-storage-from-needs.md` 4.2–4.4): one shared in-memory
//! buffer of entries sorted by key, flushed as one immutable run when the process's stores together buffer B
//! (`Pool`; the largest buffer goes first) or this keyspace's log has passed `log_bytes` since its last flush;
//! runs merged in tiers of `fan_in` on the process's engine threads (`exec`); reads merging the buffer and every run.
//!
//! Runs live in `<dir>/run-<first flush>-<last flush>.run` (16 hex digits each). A run is written as `.tmp`,
//! synced, renamed and its directory synced, so a `.run` is always whole. A merge's output holds every flush its
//! inputs held, and the inputs are removed only after it is in place: a run whose flushes another run also holds
//! is left over from a crash during that removal.

pub mod block;
pub mod cache;
pub mod exec;
pub mod mem;
pub mod pool;
pub mod run;
pub mod val;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, RwLock};

use cache::Cache;
use exec::Activity;
pub use mem::Mem;
use pool::Pool;
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
    /// L: the buffer is flushed once this many bytes of log have been written since the last flush, so replay
    /// after a crash reads less than this.
    pub log_bytes: u64,
    /// δ: runs of one tier are merged this many at a time.
    pub fan_in: usize,
    /// A run block's target size.
    pub block_size: usize,
    /// Buffers waiting for their flush; commits wait while this many are.
    pub max_frozen: usize,
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
    /// Entries inserted into the buffer, and their keys' and values' bytes (each value with a tag byte).
    pub inserted: u64,
    pub inserted_bytes: u64,
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
    inserted_bytes: AtomicU64,
    lookups: AtomicU64,
}

struct WriteState {
    log_bytes: u64,
    /// The log end the last insert that carried one brought the buffer to.
    end: u64,
}

struct Jobs {
    next_flush: u64,
    stop: bool,
    /// Flushes that failed (each is retried).
    flush_failures: u64,
}

pub struct Keyspace {
    cfg: KsConfig,
    dir: PathBuf,
    version: Mutex<Arc<Version>>,
    write: Mutex<WriteState>,
    /// Signalled, under `write`, when a frozen buffer has been flushed or a flush failed.
    flushed_cv: Condvar,
    jobs: Mutex<Jobs>,
    pool: Arc<Pool>,
    flush_act: Arc<Activity>,
    merge_act: Arc<Activity>,
    /// The pool wants this keyspace's buffer frozen; its flush activity does it.
    freeze_requested: AtomicBool,
    pub counts: ReadCounts,
    counters: Counters,
    hooks: OnceLock<Box<dyn Hooks>>,
    /// Bytes of the last run flushed from a full buffer: the size of tier 0.
    flush_unit: AtomicU64,
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
    pub fn open(dir: &Path, cfg: KsConfig, pool: Arc<Pool>) -> KsResult<Arc<Keyspace>> {
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
        let end = runs.first().map_or(0, |r| r.covered);
        let unit = (pool.buffer_bytes as u64 / 6).max(1);
        let ks = Arc::new_cyclic(|me: &std::sync::Weak<Keyspace>| {
            let activity = |step: fn(&Keyspace) -> bool| {
                let a = Activity::new(&pool.exec);
                let me = me.clone();
                a.set_step(Box::new(move || me.upgrade().is_some_and(|ks| step(&ks))));
                a
            };
            Keyspace {
                cfg,
                dir: dir.to_path_buf(),
                version: Mutex::new(Arc::new(Version {
                    mems: vec![Arc::new(RwLock::new(Mem::default()))],
                    runs,
                })),
                write: Mutex::new(WriteState { log_bytes: 0, end }),
                flushed_cv: Condvar::new(),
                jobs: Mutex::new(Jobs {
                    next_flush: next,
                    stop: false,
                    flush_failures: 0,
                }),
                pool: pool.clone(),
                flush_act: activity(Keyspace::flush_step),
                merge_act: activity(Keyspace::merge_step),
                freeze_requested: AtomicBool::new(false),
                counts: ReadCounts::default(),
                counters: Counters::default(),
                hooks: OnceLock::new(),
                // Until a full buffer has been flushed: entries take about 6 times their run bytes in memory.
                flush_unit: AtomicU64::new(unit),
            }
        });
        pool.register(&ks);
        Ok(ks)
    }

    pub fn cache(&self) -> &Cache {
        &self.pool.cache
    }

    pub fn pool(&self) -> &Arc<Pool> {
        &self.pool
    }

    pub(crate) fn freeze_requested(&self) -> bool {
        self.freeze_requested.load(Ordering::Relaxed)
    }

    pub(crate) fn active_bytes(&self) -> usize {
        self.version().mems[0].read().unwrap().bytes()
    }

    pub(crate) fn request_freeze(&self) {
        self.freeze_requested.store(true, Ordering::Relaxed);
        self.flush_act.kick();
    }

    pub fn config(&self) -> &KsConfig {
        &self.cfg
    }

    /// Starts flushing and merging (runs an earlier close left unmerged are merged now).
    pub fn start(self: &Arc<Self>, hooks: Box<dyn Hooks>) -> io::Result<()> {
        let _ = self.hooks.set(hooks);
        self.merge_act.kick();
        self.flush_act.kick();
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
                let done = !val.is_partial();
                out.push(val);
                if done {
                    return Ok(out);
                }
            }
        }
        for r in &v.runs {
            if let Some(val) = r.get(key, &self.pool.cache, &self.counts)? {
                let done = !val.is_partial();
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
                    Some(&self.pool.cache),
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
    /// bytes of log since the previous insert that carried one; when the log has passed L since the last
    /// flush, the buffer is frozen there and flushed. Waits while `max_frozen` buffers wait for their flush,
    /// and while the pool's buffers hold 2B (see `Pool::after_insert`).
    pub fn insert<I: IntoIterator<Item = (Vec<u8>, Val)>>(
        &self,
        entries: I,
        log: Option<(u64, u64)>,
    ) {
        let mut w = self.write.lock().unwrap();
        {
            let v = self.version();
            let mut m = v.mems[0].write().unwrap();
            let (mut n, mut bytes, mut grew) = (0, 0, 0);
            for (k, val) in entries {
                bytes += (k.len() + val.payload_len() + 1) as u64;
                grew += m.insert(&k, val);
                n += 1;
            }
            self.pool.add_active(grew);
            self.counters.inserted.fetch_add(n, Ordering::Relaxed);
            self.counters
                .inserted_bytes
                .fetch_add(bytes, Ordering::Relaxed);
        }
        if let Some((end, bytes)) = log {
            w.end = end;
            w.log_bytes += bytes;
            // With a buffer still waiting for its flush, this one is frozen at a later insert.
            if w.log_bytes >= self.cfg.log_bytes && self.version().mems.len() <= self.cfg.max_frozen
            {
                self.freeze(&mut w, end, false);
            }
        }
        drop(w);
        self.pool.after_insert();
    }

    /// Freezes the buffer as covering the log up to `end`, if it holds anything or `end` is past what the
    /// runs cover. Waits for room among the frozen buffers first (not from an engine thread).
    pub fn freeze_at(&self, end: u64) {
        let mut w = self.write.lock().unwrap();
        while self.version().mems.len() > self.cfg.max_frozen {
            self.flush_act.kick();
            w = self.flushed_cv.wait(w).unwrap();
        }
        let v = self.version();
        let newest = v.mems.get(1).map(|m| m.read().unwrap().covered);
        let covered = newest.unwrap_or_else(|| v.runs.first().map_or(0, |r| r.covered));
        if v.mems[0].read().unwrap().bytes() > 0 || end > covered {
            self.freeze(&mut w, end, false);
        }
    }

    /// Freezes the buffer taking inserts and queues its flush. The caller holds `write` and has checked there is
    /// room among the frozen buffers.
    fn freeze(&self, w: &mut WriteState, end: u64, full: bool) {
        let mut version = self.version.lock().unwrap();
        let mut mems = version.mems.clone();
        {
            let mut m = mems[0].write().unwrap();
            (m.covered, m.full) = (end, full);
            self.pool.froze(m.bytes() as i64);
        }
        self.freeze_requested.store(false, Ordering::Relaxed);
        mems.insert(0, Arc::new(RwLock::new(Mem::default())));
        *version = Arc::new(Version {
            mems,
            runs: version.runs.clone(),
        });
        drop(version);
        w.log_bytes = 0;
        self.flush_act.kick();
    }

    /// Waits until every frozen buffer has been flushed, or a flush fails.
    pub fn wait_flushed(&self) -> KsResult<()> {
        let failures = self.jobs.lock().unwrap().flush_failures;
        let mut w = self.write.lock().unwrap();
        while self.version().mems.len() > 1 {
            if self.jobs.lock().unwrap().flush_failures > failures {
                return Err(KsError::Io(io::Error::other("a flush failed")));
            }
            self.flush_act.kick();
            w = self.flushed_cv.wait(w).unwrap();
        }
        Ok(())
    }

    // ---- flushes ----

    /// One step of the flush activity: flushes the oldest frozen buffer, or freezes the buffer taking inserts
    /// when the pool asked.
    fn flush_step(&self) -> bool {
        if self.jobs.lock().unwrap().stop {
            return false;
        }
        let v = self.version();
        if v.mems.len() == 1 {
            if !self.freeze_requested() {
                return false;
            }
            let mut w = self.write.lock().unwrap();
            if self.version().mems.len() == 1 && v.mems[0].read().unwrap().bytes() > 0 {
                let end = w.end;
                self.freeze(&mut w, end, true);
            } else {
                self.freeze_requested.store(false, Ordering::Relaxed);
            }
            return true;
        }
        let Some(slot) = self.pool.flush_slot(&self.flush_act) else {
            return false;
        };
        let mem = v.mems.last().unwrap().clone();
        drop(v);
        let bytes = mem.read().unwrap().bytes() as i64;
        let result = self.flush(&mem);
        drop(slot);
        match result {
            Ok(()) => {
                // The buffer's chunks are freed whole once readers holding an older version let go of it.
                drop(mem);
                self.pool.released(bytes, 0);
                {
                    let _w = self.write.lock().unwrap();
                    self.flushed_cv.notify_all();
                }
                if let Some(h) = self.hooks.get() {
                    h.flushed(self);
                }
                self.merge_act.kick();
                true
            }
            Err(e) => {
                // The buffer stays frozen, so nothing is lost: its entries are still read from memory, and after a
                // restart replay derives them again. Inserts wait for room meanwhile.
                eprintln!("st-engine: flushing the derived keyspace failed: {e}");
                self.jobs.lock().unwrap().flush_failures += 1;
                {
                    let _w = self.write.lock().unwrap();
                    self.flushed_cv.notify_all();
                }
                // Retried after a pause; a failing disk holds one engine thread for it.
                std::thread::sleep(std::time::Duration::from_secs(1));
                true
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
            while let Some((ek, ev)) = extra.next_if(|(ek, _)| ek.as_slice() < k) {
                w.add(&ek, &ev)?;
            }
            extra.next_if(|(ek, _)| ek.as_slice() == k);
            w.add(k, &v)?;
        }
        for (ek, ev) in extra {
            w.add(&ek, &ev)?;
        }
        let (covered, full) = (m.covered, m.full);
        drop(m);
        let bytes = w.finish(covered, seq, seq)?;
        if full {
            self.flush_unit.store(bytes, Ordering::Relaxed);
        }
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

    /// A run's tier: about log_δ of its size in full flushes, rounded to the nearest, so a flush is tier 0, δ
    /// of them merged tier 1 even when the merge dropped some entries, and so on.
    fn tier(&self, bytes: u64) -> u32 {
        let unit = self.flush_unit.load(Ordering::Relaxed).max(1) as f64;
        let t = (bytes.max(1) as f64 / unit).ln() / (self.cfg.fan_in as f64).ln();
        (t + 0.5).floor().max(0.0) as u32
    }

    /// Picks adjacent runs to merge: `fan_in` of one tier, the lowest tier first; or, past a run count no
    /// tiering leaves, the adjacent `fan_in` with the fewest bytes. Returns them oldest first.
    fn pick(&self) -> Option<Vec<Arc<Run>>> {
        let delta = self.cfg.fan_in;
        let v = self.version();
        let runs: Vec<&Arc<Run>> = v.runs.iter().rev().collect();
        let mut best: Option<(u32, usize)> = None;
        let mut i = 0;
        while i < runs.len() {
            let t = self.tier(runs[i].bytes);
            let mut j = i;
            while j < runs.len() && self.tier(runs[j].bytes) == t {
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
                .min_by_key(|w| w.iter().map(|r| r.bytes).sum::<u64>())
                .map(|w| w.iter().map(|r| (*r).clone()).collect());
        }
        None
    }

    /// One step of the merge activity: one merge, if one is due and a slot is free.
    fn merge_step(&self) -> bool {
        if self.jobs.lock().unwrap().stop || self.pick().is_none() {
            return false;
        }
        let Some(slot) = self.pool.merge_slot(&self.merge_act) else {
            return false;
        };
        let Some(inputs) = self.pick() else {
            return false;
        };
        let result = self.merge(&inputs);
        drop(slot);
        match result {
            Ok(done) => done,
            Err(e) => {
                // Retried at the next flush.
                eprintln!("st-engine: merging runs failed: {e}");
                false
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

    /// Waits until no flush or merge is due or running (not from an engine thread).
    pub fn wait_merged(&self) {
        loop {
            self.flush_act.wait_idle();
            self.merge_act.wait_idle();
            if self.version().mems.len() == 1 && self.pick().is_none() {
                return;
            }
            self.flush_act.kick();
            self.merge_act.kick();
            // A step waiting for a slot isn't running: look again shortly.
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    /// Stops flushing and merging; a merge in progress is abandoned. Frozen buffers not yet flushed are not
    /// written (their records are replayed on the next open). Waits for a running step (not from an engine
    /// thread).
    pub fn stop(&self) {
        self.jobs.lock().unwrap().stop = true;
        self.flush_act.wait_idle();
        self.merge_act.wait_idle();
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
            inserted_bytes: c.inserted_bytes.load(Ordering::Relaxed),
            runs: v.runs.len() as u64,
            run_bytes: v.runs.iter().map(|r| r.bytes).sum(),
            lookups: c.lookups.load(Ordering::Relaxed),
            blocks: self.counts.blocks.load(Ordering::Relaxed),
            file_reads: self.counts.file_reads.load(Ordering::Relaxed),
            buffer_bytes: v
                .mems
                .iter()
                .map(|m| m.read().unwrap().bytes() as u64)
                .sum(),
            cache_bytes: self.pool.cache.bytes() as u64,
            top_bytes: v.runs.iter().map(|r| r.top_size() as u64).sum(),
        }
    }
}

impl Drop for Keyspace {
    fn drop(&mut self) {
        // No waiting: the last reference may be dropped by the keyspace's own step.
        self.jobs.lock().unwrap().stop = true;
        let v = self.version();
        let bytes: Vec<i64> = v
            .mems
            .iter()
            .map(|m| m.read().unwrap().bytes() as i64)
            .collect();
        self.pool.released(bytes[1..].iter().sum(), bytes[0]);
    }
}

#[cfg(test)]
mod tests;
