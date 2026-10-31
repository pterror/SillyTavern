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

pub const MERGE_STEP_BYTES: usize = if cfg!(test) { 4 << 10 } else { 4 << 20 };

pub const SIZE_AMP_PERCENT: u64 = 50;
pub const DEL_PERCENT: u64 = 10;

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

pub type Entries = Vec<(Vec<u8>, Vec<u8>)>;

#[derive(Debug, Clone, Copy)]
pub struct KsConfig {
    pub log_bytes: u64,
    pub fan_in: usize,
    pub block_size: usize,
    pub max_frozen: usize,
}

pub struct Version {
    pub mems: Vec<Arc<RwLock<Mem>>>,
    pub runs: Vec<Arc<Run>>,
}

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

type Pages = Vec<(Vec<(Vec<u8>, Val)>, bool)>;

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

fn pages_bound(pages: &Pages, rev: bool) -> Option<Vec<u8>> {
    let lasts = pages
        .iter()
        .filter(|(_, cut)| *cut)
        .filter_map(|(p, _)| p.last().map(|(k, _)| k.clone()));
    if rev { lasts.max() } else { lasts.min() }
}

impl Snapshot<'_> {
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

    pub fn values_sorted(&self, keys: &[&[u8]]) -> KsResult<Vec<Vec<Val>>> {
        let seq = self.seq;
        self.ks
            .values_sorted_in(&self.version, keys, |m, k| m.get_at(k, seq))
    }

    pub fn estimate(&self, start: &[u8], end: &[u8]) -> KsResult<f64> {
        let mut n = 0.0;
        for m in &self.version.mems {
            n += m.read().unwrap().count(start, end, Some(self.seq)) as f64;
        }
        self.ks.runs_estimate(&self.version.runs, start, end, n)
    }

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

pub trait Hooks: Send + Sync {
    fn flush_extra(
        &self,
        ks: &Keyspace,
        mem: &Mem,
        older: &[Arc<Run>],
    ) -> KsResult<Vec<(Vec<u8>, Val)>>;
    fn flushed(&self, ks: &Keyspace);
}

#[derive(Debug, Default, Clone, Copy)]
pub struct KsStats {
    pub flushes: u64,
    pub flush_bytes: u64,
    pub merges: u64,
    pub merge_bytes: u64,
    pub inserted: u64,
    pub inserted_bytes: u64,
    pub runs: u64,
    pub run_bytes: u64,
    pub lookups: u64,
    pub blocks: u64,
    pub file_reads: u64,
    pub buffer_bytes: u64,
    pub cache_bytes: u64,
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
    end: u64,
}

struct Jobs {
    next_flush: u64,
    stop: bool,
    flush_failures: u64,
}

struct MergeJob {
    inputs: Vec<Arc<Run>>,
    merge: Merge<'static, RunIter<'static>>,
    w: RunWriter,
    tmp: PathBuf,
    bottom: bool,
    _slot: pool::MergeSlot,
}

pub struct Keyspace {
    cfg: KsConfig,
    dir: PathBuf,
    version: Mutex<Arc<Version>>,
    write: Mutex<WriteState>,
    flushed_cv: Condvar,
    jobs: Mutex<Jobs>,
    pool: Arc<Pool>,
    flush_act: Arc<Activity>,
    merge_act: Arc<Activity>,
    merging: Mutex<Vec<MergeJob>>,
    short_of_room: AtomicBool,
    freeze_requested: AtomicBool,
    pub counts: ReadCounts,
    counters: Counters,
    hooks: OnceLock<Box<dyn Hooks>>,
    flush_unit: AtomicU64,
    seqs: Mutex<Seqs>,
}

#[derive(Default)]
struct Seqs {
    published: u64,
    readers: std::collections::BTreeMap<u64, usize>,
}

fn sync_dir(dir: &Path) -> io::Result<()> {
    crate::faults::op(crate::faults::Op::SyncDir, dir)?;
    #[cfg(not(windows))]
    fs::File::open(dir)?.sync_all()?;
    #[cfg(windows)]
    let _ = dir;
    Ok(())
}

fn rename(from: &Path, to: &Path) -> io::Result<()> {
    crate::faults::rename(from, to)?;
    fs::rename(from, to)
}

fn remove(path: impl AsRef<Path>) -> io::Result<()> {
    crate::faults::op(crate::faults::Op::Remove, path.as_ref())?;
    fs::remove_file(path)
}

impl Keyspace {
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
                remove(dir.join(name))?;
            } else if let Some(range) = parse_run_name(name) {
                found.push(range);
            }
        }
        found.sort_by_key(|&(lo, hi)| (lo, std::cmp::Reverse(hi)));
        let mut runs: Vec<Arc<Run>> = Vec::new();
        let mut next = 0;
        for (lo, hi) in found {
            if hi < next {
                remove(dir.join(run_name(lo, hi)))?;
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

    pub fn start(self: &Arc<Self>, hooks: Box<dyn Hooks>) -> io::Result<()> {
        let _ = self.hooks.set(hooks);
        self.merge_act.kick();
        self.flush_act.kick();
        Ok(())
    }

    pub fn version(&self) -> Arc<Version> {
        self.version.lock().unwrap().clone()
    }

    pub fn covered(&self) -> u64 {
        self.version().runs.first().map_or(0, |r| r.covered)
    }

    pub fn has_runs(&self) -> bool {
        !self.version().runs.is_empty()
    }

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

    pub fn values_sorted(&self, keys: &[&[u8]]) -> KsResult<Vec<Vec<Val>>> {
        let v = self.version();
        self.values_sorted_in(&v, keys, |m, k| m.get(k))
    }

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

    pub fn get(&self, key: &[u8]) -> KsResult<Option<Vec<u8>>> {
        Ok(val::fold(key, self.values(key)?).and_then(|v| v.resolved(key)))
    }

    pub fn get_val(&self, key: &[u8]) -> KsResult<Option<Val>> {
        Ok(val::fold(key, self.values(key)?).and_then(|v| v.settled(key)))
    }

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
                if r.max_key.as_slice() < start || !r.may_hold(start, &to) {
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
                if from.as_slice() <= r.max_key.as_slice() && r.may_hold(&from, end) {
                    sources.push(Box::new(RunIter::new(
                        r.clone(),
                        &from,
                        Some(&self.pool.cache),
                        Some(&self.counts),
                    )?));
                }
            }
            let mut merge = Merge::new(sources);
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

    pub fn insert<I: IntoIterator<Item = (Vec<u8>, Val)>>(
        &self,
        entries: I,
        log: Option<(u64, u64)>,
    ) {
        let mut w = self.write.lock().unwrap();
        {
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
            if w.log_bytes >= self.cfg.log_bytes && self.version().mems.len() <= self.cfg.max_frozen
            {
                self.freeze(&mut w, end, false);
            }
        }
        drop(w);
        self.pool.after_insert();
    }

    pub fn freeze_at(&self, end: u64) {
        let mut w = self.write.lock().unwrap();
        while self.version().mems.len() > self.cfg.max_frozen {
            self.flush_act.kick();
            w = self.pool.exec.wait(&self.write, &self.flushed_cv, w);
        }
        let v = self.version();
        let newest = v.mems.get(1).map(|m| m.read().unwrap().covered);
        let covered = newest.unwrap_or_else(|| v.runs.first().map_or(0, |r| r.covered));
        if v.mems[0].read().unwrap().bytes() > 0 || end > covered {
            self.freeze(&mut w, end, false);
        }
    }

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

    pub fn wait_flushed(&self) -> KsResult<()> {
        let failures = self.jobs.lock().unwrap().flush_failures;
        let mut w = self.write.lock().unwrap();
        while self.version().mems.len() > 1 {
            if self.jobs.lock().unwrap().flush_failures > failures {
                return Err(KsError::Io(io::Error::other("a flush failed")));
            }
            self.flush_act.kick();
            w = self.pool.exec.wait(&self.write, &self.flushed_cv, w);
        }
        Ok(())
    }

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
                eprintln!("st-engine: flushing the derived keyspace failed: {e}");
                self.jobs.lock().unwrap().flush_failures += 1;
                {
                    let _w = self.write.lock().unwrap();
                    self.flushed_cv.notify_all();
                }
                if !self.pool.exec.is_simulated() {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                }
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
        let _ = remove(&tmp);
        let mut w = RunWriter::create(&tmp, self.cfg.block_size)?;
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
        rename(&tmp, &path)?;
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

    fn tier(&self, bytes: u64) -> u32 {
        let unit = self.flush_unit.load(Ordering::Relaxed).max(1) as f64;
        let t = (bytes.max(1) as f64 / unit).ln() / (self.cfg.fan_in as f64).ln();
        (t + 0.5).floor().max(0.0) as u32
    }

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
                let _ = remove(&tmp);
            }
        }
        let busy: Vec<u64> = merging
            .iter()
            .flat_map(|j| j.inputs.iter().map(|r| r.uid))
            .collect();
        !merging.is_empty() || self.pick(&busy).is_some()
    }

    fn abandon(merging: &mut Vec<MergeJob>) {
        for MergeJob { w, tmp, .. } in merging.drain(..) {
            drop(w);
            let _ = remove(&tmp);
        }
    }

    fn begin_merge(&self, inputs: Vec<Arc<Run>>, slot: pool::MergeSlot) -> KsResult<MergeJob> {
        let (lo, hi) = (inputs[0].lo, inputs.last().unwrap().hi);
        let bottom = self.version().runs.last().map(|r| r.uid) == Some(inputs[0].uid);
        let tmp = self.dir.join(run_name(lo, hi).replace(".run", ".tmp"));
        let mut sources = Vec::new();
        for r in inputs.iter().rev() {
            sources.push(Box::new(RunIter::new(r.clone(), &[], None, None)?));
        }
        let _ = remove(&tmp);
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

    fn finish_merge(&self, job: MergeJob) -> KsResult<()> {
        let MergeJob { inputs, w, tmp, .. } = job;
        let (lo, hi) = (inputs[0].lo, inputs.last().unwrap().hi);
        let covered = inputs.last().unwrap().covered;
        let bytes = w.finish(covered, lo, hi)?;
        let path = self.dir.join(run_name(lo, hi));
        rename(&tmp, &path)?;
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

    pub fn install_run(&self, path: &Path, covered: u64) -> KsResult<()> {
        let mut w = self.write.lock().unwrap();
        let mut jobs = self.jobs.lock().unwrap();
        let seq = jobs.next_flush;
        run::restamp(path, covered, seq, seq)?;
        let dest = self.dir.join(run_name(seq, seq));
        rename(path, &dest)?;
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
        w.end = w.end.max(covered);
        drop(w);
        self.counters
            .inserted
            .fetch_add(entries.max(1), Ordering::Release);
        self.merge_act.kick();
        Ok(())
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

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
            self.pool.exec.pause(std::time::Duration::from_millis(10));
        }
    }

    pub fn stop(&self) {
        self.jobs.lock().unwrap().stop = true;
        self.flush_act.wait_idle();
        self.merge_act.wait_idle();
        Self::abandon(&mut self.merging.lock().unwrap());
    }

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
