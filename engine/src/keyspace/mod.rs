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

/// A merge writes at most this many bytes of entries (keys and value payloads) per step, so a merge of any size
/// is many short steps: it holds a thread only for a step, other merges and stores take turns between steps,
/// and a stop is seen within one. Tests take 4 KB steps, so every test's merges run as many steps among its
/// flushes and reads.
pub const MERGE_STEP_BYTES: usize = if cfg!(test) { 4 << 10 } else { 4 << 20 };

/// Every run is merged into the oldest once the newer runs together hold this percentage of its bytes...
pub const SIZE_AMP_PERCENT: u64 = 25;
/// ...or their deletions this percentage of its entries.
pub const DEL_PERCENT: u64 = 10;

/// Free bytes on the file system holding `dir`, where they can be read.
#[cfg(not(target_family = "wasm"))]
fn free_bytes(dir: &Path) -> Option<u64> {
    let dir = fs::canonicalize(dir).ok()?;
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|d| dir.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space())
}

#[cfg(target_family = "wasm")]
fn free_bytes(_dir: &Path) -> Option<u64> {
    None
}

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

/// One state of the keyspace (`Keyspace::snapshot`).
pub struct Snapshot<'a> {
    ks: &'a Keyspace,
    version: Arc<Version>,
    seq: u64,
}

impl Drop for Snapshot<'_> {
    fn drop(&mut self) {
        let mut seqs = self.ks.seqs.lock().unwrap();
        if let std::collections::btree_map::Entry::Occupied(mut e) = seqs.readers.entry(self.seq) {
            *e.get_mut() -= 1;
            if *e.get() == 0 {
                e.remove();
            }
        }
    }
}

/// A scan's pages from the buffers, newest first, and whether each was cut (it holds as many entries that aren't
/// deletions as it was asked for, so more may follow).
type Pages = Vec<(Vec<(Vec<u8>, Val)>, bool)>;

/// The pages of a scan from the buffers, newest first. A buffer's page ends after `limit` entries that aren't
/// deletions, but a newer buffer's entries (deletions too) can hide that many of an older buffer's, so an older
/// page reaches past as many entries as the newer buffers hold in the range.
fn buffer_pages(
    mems: &[Arc<RwLock<Mem>>],
    start: &[u8],
    end: &[u8],
    limit: usize,
    seq: Option<u64>,
    page: impl Fn(&Mem, usize) -> Vec<(Vec<u8>, Val)>,
) -> Pages {
    let mut extra = 0usize;
    let mut pages = Vec::with_capacity(mems.len());
    for (i, m) in mems.iter().enumerate() {
        let m = m.read().unwrap();
        let want = limit.saturating_add(extra);
        let p = page(&m, want);
        let cut = p.iter().filter(|(_, v)| *v != Val::Del).count() == want;
        pages.push((p, cut));
        if i + 1 < mems.len() {
            extra = extra.saturating_add(m.count_all(start, end, seq));
        }
    }
    pages
}

/// How far a scan's pages speak for the buffers: up to the nearest last key of a page that was cut (forward: the
/// least; `rev`: the greatest), or everywhere. An entry that isn't a deletion yet settles to nothing (a map whose
/// every slot is removed) fills a page without giving the scan a result, so a page can be cut before the scan has
/// its `limit` results; past that key the page's buffer is unread, and an older run's value there may be hidden.
fn pages_bound(pages: &Pages, rev: bool) -> Option<Vec<u8>> {
    let lasts = pages
        .iter()
        .filter(|(_, cut)| *cut)
        .filter_map(|(p, _)| p.last().map(|(k, _)| k.clone()));
    if rev { lasts.max() } else { lasts.min() }
}

impl Snapshot<'_> {
    /// `Keyspace::get_val` in this state.
    pub fn get_val(&self, key: &[u8]) -> KsResult<Option<Val>> {
        let mut out = Vec::new();
        for m in &self.version.mems {
            if let Some(val) = m.read().unwrap().get_at(key, self.seq) {
                let done = !val.is_partial();
                out.push(val);
                if done {
                    return Ok(val::fold(key, out).and_then(|v| v.settled(key)));
                }
            }
        }
        let out = self.ks.run_values(&self.version.runs, key, out)?;
        Ok(val::fold(key, out).and_then(|v| v.settled(key)))
    }

    /// `Keyspace::scan_vals` in this state.
    pub fn scan_vals(
        &self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> KsResult<Vec<(Vec<u8>, Val)>> {
        let mems = &self.version.mems;
        self.ks.merge_scan(
            |from, n| {
                buffer_pages(mems, from, end, n, Some(self.seq), |m, n| {
                    m.page_at(from, end, n, self.seq)
                })
            },
            &self.version.runs,
            start,
            end,
            limit,
        )
    }

    /// `Keyspace::values_sorted` in this state.
    pub fn values_sorted(&self, keys: &[&[u8]]) -> KsResult<Vec<Vec<Val>>> {
        let seq = self.seq;
        self.ks
            .values_sorted_in(&self.version, keys, |m, k| m.get_at(k, seq))
    }

    /// `Keyspace::estimate` in this state.
    pub fn estimate(&self, start: &[u8], end: &[u8]) -> KsResult<f64> {
        let mut n = 0.0;
        for m in &self.version.mems {
            n += m.read().unwrap().count(start, end, Some(self.seq)) as f64;
        }
        self.ks.runs_estimate(&self.version.runs, start, end, n)
    }

    /// `Keyspace::scan_vals_rev` in this state.
    pub fn scan_vals_rev(
        &self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> KsResult<Vec<(Vec<u8>, Val)>> {
        let mems = &self.version.mems;
        self.ks.merge_scan_rev(
            |to, n| {
                buffer_pages(mems, start, to, n, Some(self.seq), |m, n| {
                    m.page_rev(start, to, n, Some(self.seq))
                })
            },
            &self.version.runs,
            start,
            end,
            limit,
        )
    }
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

/// A merge under way: its inputs (adjacent, oldest first), where it has got to, and the run it is writing. It
/// holds a merge slot from its first step to its last.
struct MergeJob {
    inputs: Vec<Arc<Run>>,
    merge: Merge<'static, RunIter<'static>>,
    w: RunWriter,
    tmp: PathBuf,
    /// With the oldest run among the inputs, nothing older exists for a deletion to hide.
    bottom: bool,
    _slot: pool::MergeSlot,
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
    /// Merges under way, on disjoint inputs; the merge activity steps them in turn.
    merging: Mutex<Vec<MergeJob>>,
    /// A merge into the oldest run is waiting for disk space (said once).
    short_of_room: AtomicBool,
    /// The pool wants this keyspace's buffer frozen; its flush activity does it.
    freeze_requested: AtomicBool,
    pub counts: ReadCounts,
    counters: Counters,
    hooks: OnceLock<Box<dyn Hooks>>,
    /// Bytes of the last run flushed from a full buffer: the size of tier 0.
    flush_unit: AtomicU64,
    /// Inserts' sequence numbers and the live snapshots'.
    seqs: Mutex<Seqs>,
}

/// The last insert's sequence number, and the live snapshots by sequence (with how many at each).
#[derive(Default)]
struct Seqs {
    published: u64,
    readers: std::collections::BTreeMap<u64, usize>,
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
                merging: Mutex::new(Vec::new()),
                short_of_room: AtomicBool::new(false),
                freeze_requested: AtomicBool::new(false),
                counts: ReadCounts::default(),
                counters: Counters::default(),
                seqs: Mutex::new(Seqs::default()),
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
        let v = self.version();
        let mut out = Vec::new();
        for m in &v.mems {
            if let Some(val) = m.read().unwrap().get(key) {
                let done = !val.is_partial();
                out.push(val);
                if done {
                    self.counters.lookups.fetch_add(1, Ordering::Relaxed);
                    return Ok(out);
                }
            }
        }
        self.run_values(&v.runs, key, out)
    }

    /// `values` for each of `keys` (ascending, distinct), reading each run's blocks once for the keys they hold.
    pub fn values_sorted(&self, keys: &[&[u8]]) -> KsResult<Vec<Vec<Val>>> {
        let v = self.version();
        self.values_sorted_in(&v, keys, |m, k| m.get(k))
    }

    /// `values_sorted` over a version's buffers and runs, reading a buffer's value with `get`.
    fn values_sorted_in(
        &self,
        v: &Version,
        keys: &[&[u8]],
        get: impl Fn(&mem::Mem, &[u8]) -> Option<Val>,
    ) -> KsResult<Vec<Vec<Val>>> {
        let mut out: Vec<Vec<Val>> = vec![Vec::new(); keys.len()];
        let mut done = vec![false; keys.len()];
        for m in &v.mems {
            let m = m.read().unwrap();
            for (i, k) in keys.iter().enumerate() {
                if done[i] {
                    continue;
                }
                if let Some(val) = get(&m, k) {
                    done[i] = !val.is_partial();
                    out[i].push(val);
                }
            }
        }
        for r in &v.runs {
            let open: Vec<usize> = (0..keys.len()).filter(|i| !done[*i]).collect();
            if open.is_empty() {
                break;
            }
            let wanted: Vec<&[u8]> = open.iter().map(|i| keys[*i]).collect();
            for (n, val) in r
                .get_sorted(&wanted, &self.pool.cache, &self.counts)?
                .into_iter()
                .enumerate()
            {
                if let Some(val) = val {
                    let i = open[n];
                    done[i] = !val.is_partial();
                    out[i].push(val);
                }
            }
        }
        self.counters
            .lookups
            .fetch_add(keys.len() as u64, Ordering::Relaxed);
        Ok(out)
    }

    /// `values` past the buffers: `out` holds the buffers' values, all partial.
    fn run_values(&self, runs: &[Arc<Run>], key: &[u8], mut out: Vec<Val>) -> KsResult<Vec<Val>> {
        self.counters.lookups.fetch_add(1, Ordering::Relaxed);
        for r in runs {
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

    /// About how many keys `[start, end)` holds, reading a few blocks per run: the buffers' live entries, and
    /// each run's estimate (`Run::estimate`). Older versions and deletions still in runs count too.
    pub fn estimate(&self, start: &[u8], end: &[u8]) -> KsResult<f64> {
        let v = self.version();
        let mut n = 0.0;
        for m in &v.mems {
            n += m.read().unwrap().count(start, end, None) as f64;
        }
        self.runs_estimate(&v.runs, start, end, n)
    }

    fn runs_estimate(
        &self,
        runs: &[Arc<Run>],
        start: &[u8],
        end: &[u8],
        mut n: f64,
    ) -> KsResult<f64> {
        for r in runs {
            n += r.estimate(start, end, &self.pool.cache, &self.counts)?;
        }
        Ok(n)
    }

    /// The value of `key`.
    pub fn get(&self, key: &[u8]) -> KsResult<Option<Vec<u8>>> {
        Ok(val::fold(key, self.values(key)?).and_then(|v| v.resolved(key)))
    }

    /// The value of `key`, settled (`Val::settled`).
    pub fn get_val(&self, key: &[u8]) -> KsResult<Option<Val>> {
        Ok(val::fold(key, self.values(key)?).and_then(|v| v.settled(key)))
    }

    /// Up to `limit` keys in `[start, end)` that have values, in order, with their values.
    pub fn scan(&self, start: &[u8], end: &[u8], limit: usize) -> KsResult<Entries> {
        Ok(self
            .scan_vals(start, end, limit)?
            .into_iter()
            .map(|(k, v)| {
                let b = v.into_bytes(&k);
                (k, b)
            })
            .collect())
    }

    /// `scan`, the values settled (`Val::settled`).
    pub fn scan_vals(
        &self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> KsResult<Vec<(Vec<u8>, Val)>> {
        let v = self.version();
        self.merge_scan(
            |from, n| buffer_pages(&v.mems, from, end, n, None, |m, n| m.page(from, end, n)),
            &v.runs,
            start,
            end,
            limit,
        )
    }

    /// `scan_vals` last first: up to `limit` keys in `[start, end)` from the last down.
    pub fn scan_vals_rev(
        &self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> KsResult<Vec<(Vec<u8>, Val)>> {
        let v = self.version();
        self.merge_scan_rev(
            |to, n| {
                buffer_pages(&v.mems, start, to, n, None, |m, n| {
                    m.page_rev(start, to, n, None)
                })
            },
            &v.runs,
            start,
            end,
            limit,
        )
    }

    /// A reverse scan's page from the buffers' pages (`pages(to, n)`: their pages of `[start, to)` for `n` results)
    /// and the runs; where a cut page stops speaking for its buffer (`pages_bound`), the pages are read again
    /// below it.
    fn merge_scan_rev(
        &self,
        pages: impl Fn(&[u8], usize) -> Pages,
        runs: &[Arc<Run>],
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> KsResult<Vec<(Vec<u8>, Val)>> {
        let mut out = Vec::new();
        let mut to = end.to_vec();
        while out.len() < limit {
            let p = pages(&to, limit - out.len());
            let bound = pages_bound(&p, true);
            let mut sources: Vec<Box<dyn Source>> = Vec::new();
            for (p, _) in p {
                sources.push(Box::new(VecSource::new(p)));
            }
            for r in runs {
                if r.max_key.as_slice() < start {
                    continue;
                }
                sources.push(Box::new(run::RunRevIter::new(
                    r.clone(),
                    &to,
                    start,
                    Some(&self.pool.cache),
                    Some(&self.counts),
                )?));
            }
            let mut merge = run::MergeRev::new(sources);
            // Whether the merge reached the range's start. Below a cut page's bound its buffer is unread, so the
            // merge has reached the start only at an entry at or above the bound: one below it (a run's below the
            // range's start too) or no entry left at all sends the pages to be read again below the bound.
            let mut ended = false;
            while out.len() < limit {
                let Some((k, val)) = merge.next_entry()? else {
                    ended = bound.is_none();
                    break;
                };
                if bound.as_ref().is_some_and(|b| k < *b) {
                    break;
                }
                if k.as_slice() < start {
                    ended = true;
                    break;
                }
                if let Some(v) = val.settled(&k) {
                    out.push((k, v));
                }
            }
            match bound {
                Some(b) if !ended => to = b,
                _ => break,
            }
        }
        Ok(out)
    }

    /// A scan's page from the buffers' pages (`pages(from, n)`: their pages of `[from, end)` for `n` results) and
    /// the runs; where a cut page stops speaking for its buffer (`pages_bound`), the pages are read again past it.
    fn merge_scan(
        &self,
        pages: impl Fn(&[u8], usize) -> Pages,
        runs: &[Arc<Run>],
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> KsResult<Vec<(Vec<u8>, Val)>> {
        let mut out = Vec::new();
        let mut from = start.to_vec();
        while out.len() < limit {
            let p = pages(&from, limit - out.len());
            let bound = pages_bound(&p, false);
            let mut sources: Vec<Box<dyn Source>> = Vec::new();
            for (p, _) in p {
                sources.push(Box::new(VecSource::new(p)));
            }
            for r in runs {
                if from.as_slice() <= r.max_key.as_slice() {
                    sources.push(Box::new(RunIter::new(
                        r.clone(),
                        &from,
                        Some(&self.pool.cache),
                        Some(&self.counts),
                    )?));
                }
            }
            let mut merge = Merge::new(sources);
            // Whether the merge reached the range's end. Past a cut page's bound its buffer is unread, so the merge
            // has reached the end only at an entry at or before the bound: one past it (a run's past the range's
            // end too) or no entry left at all sends the pages to be read again past the bound.
            let mut ended = false;
            while out.len() < limit {
                let Some((k, val)) = merge.next_entry()? else {
                    ended = bound.is_none();
                    break;
                };
                if bound.as_ref().is_some_and(|b| k > *b) {
                    break;
                }
                if k.as_slice() >= end {
                    ended = true;
                    break;
                }
                if let Some(v) = val.settled(&k) {
                    out.push((k, v));
                }
            }
            match bound {
                Some(mut b) if !ended => {
                    b.push(0);
                    from = b;
                }
                _ => break,
            }
        }
        Ok(out)
    }

    /// A snapshot: reads through it see the keyspace as it was now, whatever is inserted, flushed or merged
    /// meanwhile. It holds the runs and buffers of now, and the buffers keep the values it reads, until it is
    /// dropped; nothing waits for it.
    pub fn snapshot(&self) -> Snapshot<'_> {
        let mut seqs = self.seqs.lock().unwrap();
        let seq = seqs.published;
        *seqs.readers.entry(seq).or_default() += 1;
        let version = self.version();
        drop(seqs);
        Snapshot {
            ks: self,
            version,
            seq,
        }
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
            // Snapshots wait while an insert applies, so each sees all of an insert or none of it.
            let mut seqs = self.seqs.lock().unwrap();
            let seq = seqs.published + 1;
            let readers: Vec<u64> = seqs.readers.keys().copied().collect();
            let v = self.version();
            let mut m = v.mems[0].write().unwrap();
            let (mut n, mut bytes, mut grew) = (0, 0, 0);
            for (k, val) in entries {
                bytes += (k.len() + val.payload_len() + 1) as u64;
                grew += m.insert(&k, val, seq, &mem::Readers(&readers));
                n += 1;
            }
            drop(m);
            seqs.published = seq;
            drop(seqs);
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

    /// Picks adjacent runs to merge. Every run into the oldest, once at least `fan_in` runs exist and the newer
    /// runs hold `SIZE_AMP_PERCENT` of the oldest's bytes or deletions `DEL_PERCENT` of its entries (RocksDB's
    /// universal compaction triggers): a deletion and the versions it or a newer value hides are dropped only
    /// in a merge reaching the oldest run, so this bounds what they take. Else `fan_in` of one tier, the lowest
    /// tier first; or, past a run count no tiering leaves, the adjacent `fan_in` with the fewest bytes. Returns
    /// them oldest first. Runs a merge under way holds (`busy`, by uid) are left out: a pick lies within one
    /// stretch of adjacent runs no merge holds, and the oldest run is merged into only while no merge holds it.
    fn pick(&self, busy: &[u64]) -> Option<Vec<Arc<Run>>> {
        let delta = self.cfg.fan_in;
        let v = self.version();
        let all: Vec<&Arc<Run>> = v.runs.iter().rev().collect();
        let mut stretches: Vec<&[&Arc<Run>]> = Vec::new();
        for s in all.split(|r| busy.contains(&r.uid)) {
            if !s.is_empty() {
                stretches.push(s);
            }
        }
        // The stretch beginning at the oldest run, if no merge holds that run.
        if let Some(runs) = stretches
            .first()
            .filter(|s| all.first().is_some_and(|o| o.uid == s[0].uid))
            && runs.len() >= delta.max(2)
        {
            let bottom = runs[0];
            let newer: u64 = runs[1..].iter().map(|r| r.bytes).sum();
            let dels: u64 = runs[1..].iter().map(|r| r.dels).sum();
            if (newer * 100 >= bottom.bytes * SIZE_AMP_PERCENT
                || dels * 100 >= bottom.entries * DEL_PERCENT)
                && self.room_to_merge(bottom.bytes + newer)
            {
                return Some(runs.iter().map(|r| (*r).clone()).collect());
            }
        }
        let mut best: Option<(u32, &[&Arc<Run>])> = None;
        for runs in &stretches {
            let mut i = 0;
            while i < runs.len() {
                let t = self.tier(runs[i].bytes);
                let mut j = i;
                while j < runs.len() && self.tier(runs[j].bytes) == t {
                    j += 1;
                }
                if j - i >= delta && best.is_none_or(|(bt, _)| t < bt) {
                    best = Some((t, &runs[i..i + delta]));
                }
                i = j.max(i + 1);
            }
        }
        if let Some((_, w)) = best {
            return Some(w.iter().map(|r| (*r).clone()).collect());
        }
        if all.len() > delta * 16 {
            return stretches
                .iter()
                .flat_map(|s| s.windows(delta))
                .min_by_key(|w| w.iter().map(|r| r.bytes).sum::<u64>())
                .map(|w| w.iter().map(|r| (*r).clone()).collect());
        }
        None
    }

    /// Whether the keyspace's file system has room for a merge writing up to `bytes`, with a margin; true where
    /// the free space can't be read. Said once while there isn't.
    fn room_to_merge(&self, bytes: u64) -> bool {
        let Some(free) = free_bytes(&self.dir) else {
            return true;
        };
        let room = free >= bytes + bytes / 8 + (1 << 30);
        if !room && !self.short_of_room.swap(true, Ordering::Relaxed) {
            eprintln!(
                "st-engine: a merge into the oldest run needs about {} MB free beside {}; it waits for room",
                (bytes + bytes / 8 + (1 << 30)) >> 20,
                self.dir.display()
            );
        } else if room {
            self.short_of_room.store(false, Ordering::Relaxed);
        }
        room
    }

    /// One step of the merge activity: starts the merges that are due while slots are free, then takes the
    /// first merge under way `MERGE_STEP_BYTES` further (to the back of the line, so merges take turns); a
    /// finished one is put in place. Returns whether a merge is still under way or due.
    fn merge_step(&self) -> bool {
        let mut merging = self.merging.lock().unwrap();
        if self.jobs.lock().unwrap().stop {
            Self::abandon(&mut merging);
            return false;
        }
        loop {
            let busy: Vec<u64> = merging
                .iter()
                .flat_map(|j| j.inputs.iter().map(|r| r.uid))
                .collect();
            let Some(inputs) = self.pick(&busy) else {
                break;
            };
            let Some(slot) = self.pool.merge_slot(&self.merge_act) else {
                break;
            };
            match self.begin_merge(inputs, slot) {
                Ok(job) => merging.push(job),
                Err(e) => {
                    // Retried at the next flush.
                    eprintln!("st-engine: merging runs failed: {e}");
                    break;
                }
            }
        }
        if merging.is_empty() {
            return false;
        }
        let mut job = merging.remove(0);
        match self.advance_merge(&mut job) {
            Ok(false) => merging.push(job),
            Ok(true) => {
                if let Err(e) = self.finish_merge(job) {
                    eprintln!("st-engine: merging runs failed: {e}");
                }
            }
            Err(e) => {
                eprintln!("st-engine: merging runs failed: {e}");
                let MergeJob { w, tmp, .. } = job;
                drop(w);
                let _ = fs::remove_file(&tmp);
            }
        }
        // A finished merge may have made another due.
        let busy: Vec<u64> = merging
            .iter()
            .flat_map(|j| j.inputs.iter().map(|r| r.uid))
            .collect();
        !merging.is_empty() || self.pick(&busy).is_some()
    }

    /// Drops every merge under way and its partial run.
    fn abandon(merging: &mut Vec<MergeJob>) {
        for MergeJob { w, tmp, .. } in merging.drain(..) {
            drop(w);
            let _ = fs::remove_file(&tmp);
        }
    }

    /// Starts merging `inputs` (adjacent, oldest first) into one run.
    fn begin_merge(&self, inputs: Vec<Arc<Run>>, slot: pool::MergeSlot) -> KsResult<MergeJob> {
        let (lo, hi) = (inputs[0].lo, inputs.last().unwrap().hi);
        let bottom = self.version().runs.last().map(|r| r.uid) == Some(inputs[0].uid);
        let tmp = self.dir.join(run_name(lo, hi).replace(".run", ".tmp"));
        let mut sources = Vec::new();
        for r in inputs.iter().rev() {
            sources.push(Box::new(RunIter::new(r.clone(), &[], None, None)?));
        }
        // Left by a merge that failed part way.
        let _ = fs::remove_file(&tmp);
        let w = RunWriter::create(&tmp, self.cfg.block_size)?;
        Ok(MergeJob {
            inputs,
            merge: Merge::new(sources),
            w,
            tmp,
            bottom,
            _slot: slot,
        })
    }

    /// Writes up to `MERGE_STEP_BYTES` more of a merge's entries. Returns whether its inputs are all written.
    fn advance_merge(&self, job: &mut MergeJob) -> KsResult<bool> {
        let mut bytes = 0;
        while bytes < MERGE_STEP_BYTES {
            let Some((k, v)) = job.merge.next_entry()? else {
                return Ok(true);
            };
            let v = if job.bottom {
                match v.bottom(&k) {
                    Some(v) => v,
                    None => continue,
                }
            } else {
                v
            };
            bytes += k.len() + v.payload_len();
            job.w.add(&k, &v)?;
        }
        Ok(false)
    }

    /// Finishes a merge whose entries are all written and puts its run in place of its inputs.
    fn finish_merge(&self, job: MergeJob) -> KsResult<()> {
        let MergeJob { inputs, w, tmp, .. } = job;
        let (lo, hi) = (inputs[0].lo, inputs.last().unwrap().hi);
        let covered = inputs.last().unwrap().covered;
        let bytes = w.finish(covered, lo, hi)?;
        let path = self.dir.join(run_name(lo, hi));
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
        Ok(())
    }

    /// Puts the run file at `path` (written with `RunWriter`, on the same file system) in place as the newest
    /// run, as the next flush covering the log up to `covered`. The buffer must be empty and nothing being
    /// inserted (a bulk load's install, with commits held).
    pub fn install_run(&self, path: &Path, covered: u64) -> KsResult<()> {
        let mut w = self.write.lock().unwrap();
        let mut jobs = self.jobs.lock().unwrap();
        let seq = jobs.next_flush;
        run::restamp(path, covered, seq, seq)?;
        let dest = self.dir.join(run_name(seq, seq));
        fs::rename(path, &dest)?;
        sync_dir(&self.dir)?;
        let run = Arc::new(Run::open(&dest, seq, seq)?);
        let entries = run.entries;
        {
            let mut version = self.version.lock().unwrap();
            let mut runs = version.runs.clone();
            runs.insert(0, run);
            *version = Arc::new(Version {
                mems: version.mems.clone(),
                runs,
            });
        }
        jobs.next_flush = seq + 1;
        drop(jobs);
        // A later flush covers at least what this run does.
        w.end = w.end.max(covered);
        drop(w);
        // Readers keyed by `inserted` see that the derived data changed.
        self.counters
            .inserted
            .fetch_add(entries.max(1), Ordering::Release);
        self.merge_act.kick();
        Ok(())
    }

    /// The directory holding the runs.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Waits until no flush or merge is due or running (not from an engine thread).
    pub fn wait_merged(&self) {
        loop {
            self.flush_act.wait_idle();
            self.merge_act.wait_idle();
            if self.version().mems.len() == 1 && {
                let merging = self.merging.lock().unwrap();
                merging.is_empty() && self.pick(&[]).is_none()
            } {
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
        Self::abandon(&mut self.merging.lock().unwrap());
    }

    /// Entries inserted so far: changes whenever the derived data may have.
    pub fn inserted(&self) -> u64 {
        self.counters.inserted.load(Ordering::Acquire)
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
#[cfg(test)]
mod model_tests;
#[cfg(test)]
mod fuzz_tests;
