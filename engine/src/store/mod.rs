pub mod book_stats;
pub mod books;
pub mod bulk;
pub mod carriers;
pub mod chat;
pub mod chat_read;
pub mod chat_search;
pub mod derive;
pub mod history;
pub mod kinds;
pub mod library;
pub mod library_read;
pub mod library_search;
pub mod local_import;
pub mod prune;
pub mod references;
pub mod searched;
pub mod sessions;
pub mod state;
pub mod stats;
pub mod tags;
pub mod token_cache;

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock, Weak};

use derive::{Layer, Loc, Memo, Out, Pending, View, apply, deriver};
use kinds::{file_of, key};

use crate::keyspace::exec::Activity;
use crate::keyspace::pool::Pool;
use crate::keyspace::run::Run;
use crate::keyspace::val::{Val, counter_value, fold};
use crate::keyspace::{Hooks, Keyspace, KsConfig, KsError, Mem};
use crate::log::format::{FieldRef, Record, Value, kind_by_name};
use crate::log::{self, Cursor, Layout, Log, LogError, Opened, Start, TailFile, max_commit};

pub type EntityKey = (u64, Vec<u8>);

pub type AssignmentsPage = (Vec<(u64, Vec<u64>)>, Option<u64>);

pub type KeyedStatus = (Vec<u8>, TagStatus);

#[derive(Debug, Clone)]
pub struct TagStatus {
    pub id: u64,
    pub state: TagState,
    pub into: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagState {
    Live,
    Undefined,
    Gone,
}

fn tag_status(v: &View, k: &[u8]) -> StoreResult<Option<TagStatus>> {
    if let Some(id) = library::entity_by_key(v, library::TAG, k)? {
        let state = if tags::place(v, id)?.is_some() {
            TagState::Live
        } else {
            TagState::Undefined
        };
        return Ok(Some(TagStatus {
            id,
            state,
            into: None,
        }));
    }
    let Some(id) = tags::gone_by_key(v, k)? else {
        return Ok(None);
    };
    let into = match library::resolve_tag(v, id)? {
        Some(t) if tags::place(v, t)?.is_some() => tags::key_of(v, t)?,
        _ => None,
    };
    Ok(Some(TagStatus {
        id,
        state: TagState::Gone,
        into,
    }))
}

#[derive(Debug)]
pub enum StoreError {
    Refused(String),
    Log(LogError),
    Ks(KsError),
    Entry(String),
    Replay(String),
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
    pub live_fraction: f64,
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

pub const BUFFER_BYTES: usize = 64 << 20;
pub const LOG_BYTES: u64 = 64 << 20;
pub const FAN_IN: usize = 4;
pub const CACHE_BYTES: usize = 64 << 20;
pub const RUN_BLOCK_SIZE: usize = 16 << 10;
pub const LIVE_FRACTION: f64 = 0.5;

pub const THREADS: usize = 10;
pub const FRONT_THREADS: usize = 2;
pub const FLUSH_SLOTS: usize = 2;
pub const MERGE_SLOTS: usize = 2;

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

type Derive = Box<dyn FnOnce(&View, &mut Out) -> StoreResult<()> + Send>;

enum Job {
    Commit(Vec<Record>, CommitDone),
    Relocate(Vec<(u64, Record)>, JobDone),
    Derive(Derive, JobDone),
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

#[derive(Default)]
struct Group {
    layout: Option<Layout>,
    dones: Vec<Done>,
    entries: BTreeMap<Vec<u8>, Val>,
    records: Pending,
}

struct Jobs {
    queue: VecDeque<Job>,
    closed: bool,
}

struct Pipe {
    cursor: Cursor,
    open: Group,
    syncing: Option<Group>,
    failed: Option<String>,
    loading: Option<Loading>,
}

#[derive(Default)]
struct Loading {
    touched: HashSet<u64>,
    installing: bool,
    derived: bool,
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
    pub removed_bytes: u64,
}

struct Inner {
    me: Weak<Inner>,
    dir: std::path::PathBuf,
    cfg: StoreConfig,
    log: Log,
    ks: Arc<Keyspace>,
    pipe: Mutex<Pipe>,
    jobs: Mutex<Jobs>,
    tail: Mutex<TailFile>,
    prepare_act: Arc<Activity>,
    sync_act: Arc<Activity>,
    clean_act: Arc<Activity>,
    replay_from: u64,
    replayed: AtomicBool,
    ready: Mutex<Replay>,
    ready_cv: Condvar,
    gate: RwLock<()>,
    clean: Mutex<CleanState>,
    clean_cv: Condvar,
    counters: Counters,
    search_stats: crate::search::query::StatsCache,
    tightening: Mutex<HashSet<crate::search::query::Tighten>>,
    #[cfg(test)]
    tightened: AtomicU64,
    folding: Mutex<(bool, bool)>,
    depthing: Mutex<(bool, bool)>,
    pruning: Mutex<(bool, bool)>,
    moving: Mutex<(bool, bool)>,
    residing: Mutex<(bool, bool)>,
    #[cfg(test)]
    carriers_held: AtomicBool,
    #[cfg(test)]
    folds_held: AtomicBool,
}

#[derive(Default)]
struct CleanState {
    stop: bool,
    file: Option<(u64, u64)>,
    relocating: bool,
}

pub struct Store {
    inner: Arc<Inner>,
    closed: AtomicBool,
}

impl Store {
    pub fn open(dir: &Path, cfg: StoreConfig) -> StoreResult<Store> {
        Store::open_in(dir, cfg, global_pool())
    }

    pub fn open_in(dir: &Path, cfg: StoreConfig, pool: Arc<Pool>) -> StoreResult<Store> {
        bulk::recover(dir, &cfg.log)?;
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
                dir: dir.to_path_buf(),
                cfg,
                log,
                ks: ks.clone(),
                pipe: Mutex::new(Pipe {
                    cursor,
                    open: Group::default(),
                    syncing: None,
                    failed: None,
                    loading: None,
                }),
                jobs: Mutex::new(Jobs {
                    queue: VecDeque::new(),
                    closed: false,
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
                search_stats: Default::default(),
                tightening: Default::default(),
                #[cfg(test)]
                tightened: AtomicU64::new(0),
                folding: Default::default(),
                depthing: Default::default(),
                pruning: Default::default(),
                moving: Default::default(),
                residing: Default::default(),
                #[cfg(test)]
                carriers_held: AtomicBool::new(false),
                #[cfg(test)]
                folds_held: AtomicBool::new(false),
            }
        });
        ks.start(Box::new(StoreHooks(Arc::downgrade(&inner))))?;
        inner.prepare_act.kick();
        Ok(Store {
            inner,
            closed: AtomicBool::new(false),
        })
    }

    pub fn commit(&self, records: Vec<Record>, done: CommitDone) {
        if let Some(r) = records.iter().find(|r| r.kind.internal) {
            return done(Err(StoreError::Refused(format!(
                "{} records are written by the engine only",
                r.kind.name
            ))));
        }
        let merges = records.iter().any(|r| r.kind.name == "tagMerge");
        let moves = records.iter().any(|r| r.kind.name == "messageParent");
        let prunes = records
            .iter()
            .any(|r| matches!(r.kind.name, "subtreeDelete" | "rootStateClear" | "histForget"));
        if merges || moves || prunes {
            let me = Arc::downgrade(&self.inner);
            let done: CommitDone = Box::new(move |r| {
                let ok = r.is_ok();
                done(r);
                if ok && let Some(i) = me.upgrade() {
                    if merges {
                        i.kick_folds();
                    }
                    if moves {
                        i.kick_depths();
                    }
                    if prunes {
                        i.kick_prunes();
                    }
                }
            });
            return self.inner.submit(Job::Commit(records, done));
        }
        self.inner.submit(Job::Commit(records, done));
    }

    pub fn commit_wait(&self, records: Vec<Record>) -> StoreResult<Vec<u64>> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.commit(records, Box::new(move |r| drop(tx.send(r))));
        self.inner.ks.pool().exec.recv(&rx).unwrap_or(Err(StoreError::Closed))
    }

    pub fn after_replay(&self, f: Box<dyn FnOnce() + Send>) -> Option<Box<dyn FnOnce() + Send>> {
        match &mut *self.inner.ready.lock().unwrap() {
            Replay::Running(waiting) => {
                waiting.push(f);
                None
            }
            _ => Some(f),
        }
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub fn is_ready(&self) -> StoreResult<bool> {
        match &*self.inner.ready.lock().unwrap() {
            Replay::Running(_) => Ok(false),
            Replay::Done => Ok(true),
            Replay::Failed(why) => Err(StoreError::Replay(why.clone())),
        }
    }

    pub fn wait_ready(&self) -> StoreResult<()> {
        self.inner.wait_ready()
    }

    pub fn keyspace(&self) -> &Keyspace {
        &self.inner.ks
    }

    pub fn log(&self) -> &Log {
        &self.inner.log
    }

    pub(crate) fn derived<T>(&self, f: impl FnOnce(&View) -> StoreResult<T>) -> StoreResult<T> {
        self.inner.wait_ready()?;
        let _g = self.inner.gate.read().unwrap();
        let snap = self.inner.ks.snapshot();
        let view = View {
            layers: Vec::new(),
            pending: Vec::new(),
            staged: None,
            bulk: false,
            ks: &self.inner.ks,
            snap: Some(&snap),
            log: &self.inner.log,
            memo: None,
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

    pub fn text(&self, entity: u64, field: &FieldRef) -> StoreResult<Option<Vec<u8>>> {
        self.derived(|v| kinds::text_value(v, entity, field))
    }

    pub fn version(&self, entity: u64) -> StoreResult<Option<u64>> {
        self.derived(|v| {
            v.get(&key::id(key::VERSION, entity))?
                .map(|b| kinds::parse_pos(&b))
                .transpose()
        })
    }

    pub fn library_page(&self, q: &library_read::Query) -> StoreResult<library_read::Page> {
        self.derived(|v| library_read::page(v, q))
    }

    pub fn chat_search_messages(
        &self,
        tree: u64,
        clauses: &[crate::search::query::Clause],
        start: chat_search::Start,
        limit: usize,
        scan_bytes: u64,
    ) -> StoreResult<chat_search::Messages> {
        let found = self.derived(|v| {
            chat_search::messages(
                v,
                tree,
                clauses,
                start,
                limit,
                scan_bytes,
                &self.inner.search_stats,
            )
        })?;
        self.inner.tighten(&found.tighten);
        Ok(found)
    }

    pub fn chat_search_list(
        &self,
        tree: u64,
        clauses: &[crate::search::query::Clause],
        session: Option<u64>,
        start: chat_search::ListStart,
        limit: usize,
        scan: Option<chat_search::ListScan>,
    ) -> StoreResult<chat_search::ListPage> {
        self.derived(|v| {
            chat_search::chat_list(
                v,
                tree,
                clauses,
                session,
                start,
                limit,
                scan,
                &self.inner.search_stats,
            )
        })
    }

    pub fn library_search(
        &self,
        q: &library_read::Query,
        clauses: &[crate::search::query::Clause],
        ordered: library_search::Ordered,
    ) -> StoreResult<library_search::Searched> {
        let mut ordered = ordered;
        let mut partial = None;
        loop {
            let found = self.derived(|v| {
                library_search::page_continued(
                    v,
                    q,
                    clauses,
                    ordered.clone(),
                    &self.inner.search_stats,
                    partial.take(),
                )
            })?;
            self.inner.tighten(&found.tighten);
            let Some(p) = found.partial else {
                return Ok(found);
            };
            if let library_search::Ordered::Relevance { weights, .. } = &mut ordered
                && weights.is_none()
            {
                *weights = found.weights;
            }
            partial = Some(p);
        }
    }

    pub fn library_entities(&self, ids: &[u64]) -> StoreResult<Vec<Option<library_read::Entity>>> {
        self.library_entities_with(ids, None)
    }

    pub fn library_entities_with(
        &self,
        ids: &[u64],
        only: Option<&library_read::Only>,
    ) -> StoreResult<Vec<Option<library_read::Entity>>> {
        self.derived(|v| match only {
            Some(only) => library_read::entities_only(v, ids, only),
            None => ids.iter().map(|e| library_read::entity(v, *e)).collect(),
        })
    }

    pub fn world_book(&self, k: &[u8]) -> StoreResult<Option<books::BookRead>> {
        self.derived(|v| books::world_book(v, k))
    }

    pub fn world_book_exists(&self, k: &[u8]) -> StoreResult<bool> {
        self.derived(|v| books::world_book_exists(v, k))
    }

    pub fn library_ids(&self, keys: &[(u64, Vec<u8>)]) -> StoreResult<Vec<Option<u64>>> {
        self.derived(|v| {
            keys.iter()
                .map(|(t, k)| library::entity_by_key(v, *t, k))
                .collect()
        })
    }

    pub fn library_of_type(
        &self,
        kind: u64,
        after: Option<Vec<u8>>,
        limit: usize,
    ) -> StoreResult<(Vec<(Vec<u8>, u64)>, bool)> {
        self.derived(|v| library::entities_of_type(v, kind, after.as_deref(), limit))
    }

    pub fn library_next_id(&self) -> StoreResult<u64> {
        self.derived(|v| {
            Ok(v.get(&key::of(key::NEXT_ENTITY))?
                .and_then(|b| crate::keyspace::val::max_value(&b))
                .unwrap_or(1))
        })
    }

    pub fn library_by_hash(&self, which: u64, hash: &[u8], limit: usize) -> StoreResult<Vec<u64>> {
        self.derived(|v| library_read::by_hash(v, which, hash, limit))
    }

    pub fn library_by_hashes(
        &self,
        a: (u64, &[u8]),
        b: (u64, &[u8]),
        limit: usize,
    ) -> StoreResult<Vec<u64>> {
        self.derived(|v| library_read::by_hashes(v, a, b, limit))
    }

    pub fn tag_page(&self, q: &tags::Query) -> StoreResult<tags::Page> {
        self.derived(|v| tags::page(v, q))
    }

    pub fn tag_counts(&self, ids: &[u64]) -> StoreResult<Vec<(i64, bool)>> {
        self.derived(|v| tags::counts(v, ids))
    }

    pub fn tag_unused(&self, limit: usize) -> StoreResult<(u64, Vec<u64>)> {
        self.derived(|v| Ok((tags::unused_count(v)?, tags::unused_page(v, limit)?)))
    }

    pub fn tag_by_names(&self, names: &[Vec<u8>]) -> StoreResult<Vec<Option<u64>>> {
        self.derived(|v| names.iter().map(|n| tags::by_name(v, n)).collect())
    }

    pub fn tag_gone_by_names(&self, names: &[Vec<u8>]) -> StoreResult<Vec<Option<u64>>> {
        self.derived(|v| names.iter().map(|n| tags::gone_by_name(v, n)).collect())
    }

    pub fn tag_positions(
        &self,
        sort: u64,
        items: &[(u64, Option<Option<f64>>)],
    ) -> StoreResult<Vec<Option<Vec<u8>>>> {
        self.derived(|v| tags::positions(v, sort, items))
    }

    pub fn tag_queue(&self, after: u64, limit: usize) -> StoreResult<(Vec<tags::Queued>, bool)> {
        self.derived(|v| tags::queue(v, after, limit))
    }

    pub fn meta(&self, names: &[Vec<u8>]) -> StoreResult<Vec<Option<Vec<u8>>>> {
        self.derived(|v| kinds::meta(v, names))
    }

    pub fn chat_read<T>(&self, f: impl FnOnce(&View) -> StoreResult<T>) -> StoreResult<T> {
        self.derived(f)
    }

    pub fn token_cache_put(
        &self,
        puts: Vec<token_cache::Put>,
        now: u64,
        granularity: u64,
        done: Box<dyn FnOnce(StoreResult<()>) + Send>,
    ) {
        self.inner.submit(Job::Derive(
            Box::new(move |view, out| token_cache::put(view, out, &puts, now, granularity)),
            done,
        ));
    }

    pub fn token_cache_evict(
        &self,
        table: u64,
        cap: u64,
        batch: usize,
        done: Box<dyn FnOnce(StoreResult<bool>) + Send>,
    ) {
        let more = Arc::new(AtomicBool::new(false));
        let found = more.clone();
        self.inner.submit(Job::Derive(
            Box::new(move |view, out| {
                found.store(
                    token_cache::evict_step(view, out, table, cap, batch)?,
                    Ordering::Relaxed,
                );
                Ok(())
            }),
            Box::new(move |r| done(r.map(|()| more.load(Ordering::Relaxed)))),
        ));
    }

    pub fn pairs_step(&self, done: Box<dyn FnOnce(StoreResult<bool>) + Send>) {
        let more = Arc::new(AtomicBool::new(false));
        let found = more.clone();
        self.inner.submit(Job::Derive(
            Box::new(move |view, out| {
                found.store(crate::search::pairs::step(view, out)?, Ordering::Relaxed);
                Ok(())
            }),
            Box::new(move |r| done(r.map(|()| more.load(Ordering::Relaxed)))),
        ));
    }

    pub fn pairs_mode(&self) -> StoreResult<u64> {
        self.derived(|v| Ok(crate::search::pairs::state(v)?.0))
    }

    pub fn tag_pass(&self) -> StoreResult<tags::PassStatus> {
        self.derived(tags::pass_status)
    }

    pub fn tag_max_order(&self) -> StoreResult<Option<f64>> {
        self.derived(tags::max_order)
    }

    pub fn library_keys(&self, ids: &[u64]) -> StoreResult<Vec<Option<EntityKey>>> {
        self.derived(|v| library_read::keys_many(v, ids))
    }

    pub fn library_tag_ids(&self, ids: &[u64]) -> StoreResult<Vec<Vec<u64>>> {
        self.derived(|v| ids.iter().map(|e| library_read::tags_now(v, *e)).collect())
    }

    pub fn tag_assignments(&self, from: u64, limit: usize) -> StoreResult<AssignmentsPage> {
        self.derived(|v| {
            let p = key::of(key::MEMBER_OF);
            let mut at = key::id(key::MEMBER_OF, from);
            let mut out: Vec<(u64, Vec<u64>)> = Vec::new();
            loop {
                let found = v.scan(&at, &key::prefix_end(&p), 1)?;
                let Some((k, _)) = found.into_iter().next() else {
                    return Ok((out, None));
                };
                let mut i = p.len();
                let e = crate::keyspace::val::get_u64(&k, &mut i)
                    .ok_or_else(|| StoreError::Entry("a membership key doesn't decode".into()))?;
                if out.len() == limit {
                    return Ok((out, Some(e)));
                }
                out.push((e, library_read::tags_now(v, e)?));
                at = key::prefix_end(&key::id(key::MEMBER_OF, e));
            }
        })
    }

    pub fn tag_keys(&self, ids: &[u64]) -> StoreResult<Vec<Option<KeyedStatus>>> {
        self.derived(|v| {
            ids.iter()
                .map(|&t| match tags::key_of(v, t)? {
                    Some(k) => Ok(tag_status(v, &k)?.filter(|st| st.id == t).map(|st| (k, st))),
                    None => Ok(None),
                })
                .collect()
        })
    }

    pub fn tag_status(&self, keys: &[Vec<u8>]) -> StoreResult<Vec<Option<TagStatus>>> {
        self.derived(|v| keys.iter().map(|k| tag_status(v, k)).collect())
    }

    pub fn tag_feed(
        &self,
        structure: u64,
        after: u64,
        limit: usize,
    ) -> StoreResult<tags::FeedPage> {
        self.derived(|v| {
            let (entries, more) = tags::feed(v, structure, after, limit)?;
            Ok((entries, more, tags::feed_end(v, structure)?))
        })
    }

    pub fn search(
        &self,
        q: &crate::search::query::Query,
    ) -> StoreResult<crate::search::query::Found> {
        let found = self.derived(|v| {
            crate::search::query::run(v, q, &self.inner.search_stats, &Default::default())
        })?;
        self.inner.tighten(&found.tighten);
        Ok(found)
    }

    #[cfg(test)]
    pub(crate) fn search_unqueued(
        &self,
        q: &crate::search::query::Query,
    ) -> StoreResult<crate::search::query::Found> {
        self.derived(|v| {
            crate::search::query::run(v, q, &self.inner.search_stats, &Default::default())
        })
    }

    #[cfg(test)]
    pub(crate) fn derived_read<T>(
        &self,
        f: impl FnOnce(&View) -> StoreResult<T>,
    ) -> StoreResult<T> {
        self.derived(f)
    }

    #[cfg(test)]
    pub(crate) fn tighten_queue(&self, reports: &[crate::search::query::Tighten]) {
        self.inner.tighten(reports);
    }

    #[cfg(test)]
    pub(crate) fn tightened(&self) -> u64 {
        self.inner.tightened.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) fn jobs_wait(&self) {
        let (tx, rx) = std::sync::mpsc::channel();
        self.inner.submit(Job::Derive(
            Box::new(|_, _| Ok(())),
            Box::new(move |r| {
                let _ = tx.send(r);
            }),
        ));
        self.inner.ks.pool().exec.recv(&rx).unwrap().unwrap();
    }

    #[cfg(test)]
    pub(crate) fn hold_carriers(&self, held: bool) {
        self.inner.carriers_held.store(held, Ordering::SeqCst);
        if !held {
            self.inner.kick_carriers(true);
            self.inner.kick_carriers(false);
        }
    }

    #[cfg(test)]
    pub(crate) fn hold_folds(&self, held: bool) {
        self.inner.folds_held.store(held, Ordering::SeqCst);
        if !held {
            self.inner.kick_folds();
        }
    }

    pub fn get(&self, key: &[u8]) -> StoreResult<Option<Vec<u8>>> {
        self.derived(|v| v.get(key))
    }

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

    pub fn feed(&self, from: u64, limit: usize) -> StoreResult<(Vec<(u64, Record)>, u64)> {
        let mut out = Vec::new();
        let mut next = from;
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

    pub fn wake_cleaner(&self) {
        self.inner.clean_act.kick();
    }

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
            c = self
                .inner
                .ks
                .pool()
                .exec
                .wait(&self.inner.clean, &self.inner.clean_cv, c);
        }
    }

    fn shut(&self, flush: bool) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let i = &self.inner;
        i.clean.lock().unwrap().stop = true;
        {
            let _p = i.pipe.lock().unwrap();
            i.jobs.lock().unwrap().closed = true;
        }
        loop {
            i.prepare_act.kick();
            i.sync_act.kick();
            i.prepare_act.wait_idle();
            i.sync_act.wait_idle();
            let p = i.pipe.lock().unwrap();
            if i.jobs.lock().unwrap().queue.is_empty()
                && p.open.dones.is_empty()
                && p.syncing.is_none()
            {
                break;
            }
            drop(p);
            i.ks.pool().exec.pause(std::time::Duration::from_millis(1));
        }
        i.clean_act.wait_idle();
        if flush && i.is_ready() {
            i.ks.freeze_at(i.log.durable_end());
            let _ = i.ks.wait_flushed();
        }
        i.ks.stop();
    }

    pub fn close(&self) {
        self.shut(true);
    }

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
        let mut j = self.jobs.lock().unwrap();
        if j.closed {
            drop(j);
            return fail_job(job, StoreError::Closed);
        }
        j.queue.push_back(job);
        drop(j);
        self.prepare_act.kick();
    }

    fn is_ready(&self) -> bool {
        matches!(*self.ready.lock().unwrap(), Replay::Done)
    }

    fn wait_ready(&self) -> StoreResult<()> {
        let mut r = self.ready.lock().unwrap();
        loop {
            match &*r {
                Replay::Running(_) => r = self.ks.pool().exec.wait(&self.ready, &self.ready_cv, r),
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
        memo: Option<&'a Memo>,
    ) -> View<'a> {
        View {
            layers: layers.into_iter().map(Layer::Sorted).collect(),
            pending,
            staged: None,
            bulk: false,
            ks: &self.ks,
            snap: None,
            log: &self.log,
            memo,
        }
    }

    fn tighten(&self, reports: &[crate::search::query::Tighten]) {
        for r in reports {
            if !self.tightening.lock().unwrap().insert(r.clone()) {
                continue;
            }
            let me = self.me.clone();
            #[cfg(test)]
            let wrote = self.me.clone();
            let (job, done) = (r.clone(), r.clone());
            self.submit(Job::Derive(
                Box::new(move |view, out| {
                    #[cfg(test)]
                    let before = out.entries.len();
                    crate::search::index::tighten(view, out, job.scope, &job.term, job.block)?;
                    #[cfg(test)]
                    if out.entries.len() > before
                        && let Some(i) = wrote.upgrade()
                    {
                        i.tightened.fetch_add(1, Ordering::SeqCst);
                    }
                    Ok(())
                }),
                Box::new(move |_| {
                    if let Some(i) = me.upgrade() {
                        i.tightening.lock().unwrap().remove(&done);
                    }
                }),
            ));
        }
    }

    pub(crate) fn kick_folds(&self) {
        #[cfg(test)]
        if self.folds_held.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut f = self.folding.lock().unwrap();
            if f.0 {
                f.1 = true;
                return;
            }
            *f = (true, false);
        }
        self.queue_fold();
    }

    fn queue_fold(&self) {
        let more = Arc::new(AtomicBool::new(false));
        let found = more.clone();
        let me = self.me.clone();
        self.submit(Job::Derive(
            Box::new(move |view, out| {
                found.store(library::fold_step(view, out)?, Ordering::Relaxed);
                Ok(())
            }),
            Box::new(move |r| {
                let Some(i) = me.upgrade() else { return };
                let again = {
                    let mut f = i.folding.lock().unwrap();
                    #[cfg(test)]
                    let held = i.folds_held.load(Ordering::SeqCst);
                    #[cfg(not(test))]
                    let held = false;
                    let again = r.is_ok() && !held && (more.load(Ordering::Relaxed) || f.1);
                    *f = (again, false);
                    again
                };
                if again {
                    i.queue_fold();
                }
            }),
        ));
    }

    pub(crate) fn kick_depths(&self) {
        {
            let mut f = self.depthing.lock().unwrap();
            if f.0 {
                f.1 = true;
                return;
            }
            *f = (true, false);
        }
        self.queue_depth();
    }

    pub(crate) fn kick_prunes(&self) {
        {
            let mut f = self.pruning.lock().unwrap();
            if f.0 {
                f.1 = true;
                return;
            }
            *f = (true, false);
        }
        self.queue_prune();
    }

    fn queue_prune(&self) {
        let more = Arc::new(AtomicBool::new(false));
        let found = more.clone();
        let me = self.me.clone();
        self.submit(Job::Derive(
            Box::new(move |view, out| {
                let found_one = prune::step(view, out)?
                    || state::clear_step(view, out)?
                    || history::forget_step(view, out)?;
                found.store(found_one, Ordering::Relaxed);
                Ok(())
            }),
            Box::new(move |r| {
                let Some(i) = me.upgrade() else { return };
                let again = {
                    let mut f = i.pruning.lock().unwrap();
                    let again = r.is_ok() && (more.load(Ordering::Relaxed) || f.1);
                    *f = (again, false);
                    again
                };
                if again {
                    i.queue_prune();
                }
            }),
        ));
    }

    fn queue_depth(&self) {
        let more = Arc::new(AtomicBool::new(false));
        let found = more.clone();
        let me = self.me.clone();
        self.submit(Job::Derive(
            Box::new(move |view, out| {
                found.store(sessions::depth_step(view, out)?, Ordering::Relaxed);
                Ok(())
            }),
            Box::new(move |r| {
                let Some(i) = me.upgrade() else { return };
                let again = {
                    let mut f = i.depthing.lock().unwrap();
                    let again = r.is_ok() && (more.load(Ordering::Relaxed) || f.1);
                    *f = (again, false);
                    again
                };
                if again {
                    i.queue_depth();
                }
            }),
        ));
    }

    fn kick_carriers(&self, moves: bool) {
        #[cfg(test)]
        if self.carriers_held.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut f = self.carrier_queue(moves).lock().unwrap();
            if f.0 {
                f.1 = true;
                return;
            }
            *f = (true, false);
        }
        self.queue_carriers(moves);
    }

    fn carrier_queue(&self, moves: bool) -> &Mutex<(bool, bool)> {
        if moves { &self.moving } else { &self.residing }
    }

    fn queue_carriers(&self, moves: bool) {
        let more = Arc::new(AtomicBool::new(false));
        let found = more.clone();
        let me = self.me.clone();
        self.submit(Job::Derive(
            Box::new(move |view, out| {
                let step = if moves {
                    carriers::move_step
                } else {
                    carriers::reside_step
                };
                found.store(step(view, out)?, Ordering::Relaxed);
                Ok(())
            }),
            Box::new(move |r| {
                let Some(i) = me.upgrade() else { return };
                let again = {
                    let mut f = i.carrier_queue(moves).lock().unwrap();
                    #[cfg(test)]
                    let held = i.carriers_held.load(Ordering::SeqCst);
                    #[cfg(not(test))]
                    let held = false;
                    let again = r.is_ok() && !held && (more.load(Ordering::Relaxed) || f.1);
                    *f = (again, false);
                    again
                };
                if again {
                    i.queue_carriers(moves);
                }
            }),
        ));
    }

    fn carrier_wake(&self, (moves, resides): (bool, bool)) -> Option<Done> {
        if !moves && !resides {
            return None;
        }
        let me = self.me.clone();
        Some(Done::Job(Box::new(move |r| {
            if r.is_ok()
                && let Some(i) = me.upgrade()
            {
                if moves {
                    i.kick_carriers(true);
                }
                if resides {
                    i.kick_carriers(false);
                }
            }
        })))
    }

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
                let view = self.view(vec![&entries], Vec::new(), None);
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

    fn prepare_step(&self) -> bool {
        if !self.replayed.load(Ordering::Acquire) {
            let replayed = self.replay(self.replay_from).map_err(|e| e.to_string());
            if let Err(why) = &replayed {
                self.pipe.lock().unwrap().failed = Some(why.clone());
            }
            self.replayed.store(true, Ordering::Release);
            self.set_ready(replayed);
            self.clean_act.kick();
            let fold = key::of(key::FOLD);
            if !matches!(self.ks.scan(&fold, &key::prefix_end(&fold), 1), Ok(f) if f.is_empty()) {
                self.kick_folds();
            }
            let moving = key::of(key::MOVING);
            if !matches!(self.ks.scan(&moving, &key::prefix_end(&moving), 1), Ok(f) if f.is_empty())
            {
                self.kick_carriers(true);
            }
            let scanning = self
                .ks
                .get(&key::of(key::RESIDE))
                .map_err(StoreError::from)
                .and_then(|b| b.map(|b| carriers::Reside::parse(&b)).transpose());
            if !matches!(&scanning, Ok(r) if r.as_ref().is_none_or(|r| r.scan.is_none())) {
                self.kick_carriers(false);
            }
            let pending = key::of(sessions::DEPTH_PENDING);
            if !matches!(self.ks.scan(&pending, &key::prefix_end(&pending), 1), Ok(f) if f.is_empty())
            {
                self.kick_depths();
            }
            let pending = key::of(prune::PRUNE);
            let clears = key::of(state::ROOT_CLEAR);
            let forgets = key::of(history::FORGET);
            let waiting = |p: &[u8]| {
                !matches!(self.ks.scan(p, &key::prefix_end(p), 1), Ok(f) if f.is_empty())
            };
            if waiting(&pending) || waiting(&clears) || waiting(&forgets) {
                self.kick_prunes();
            }
            return true;
        }
        let mut p = self.pipe.lock().unwrap();
        let full = p.loading.is_none()
            && p.open
                .layout
                .as_ref()
                .is_some_and(|l| l.offset() >= self.cfg.log.file_target);
        let installing = p.loading.as_ref().is_some_and(|l| l.installing);
        let empty = self.jobs.lock().unwrap().queue.is_empty();
        if full || installing || empty || !self.ks.pool().room_or_wait(&self.prepare_act) {
            return false;
        }
        let Some(job) = self.jobs.lock().unwrap().queue.pop_front() else {
            return false;
        };
        if let Some(why) = &p.failed {
            let e = StoreError::Failed(why.clone());
            drop(p);
            fail_job(job, e);
            return true;
        }
        self.prepare(&mut p, job);
        let more = !self.jobs.lock().unwrap().queue.is_empty();
        drop(p);
        self.sync_act.kick();
        more
    }

    fn prepare(&self, p: &mut Pipe, job: Job) {
        let Pipe {
            cursor,
            open,
            syncing,
            loading,
            ..
        } = p;
        if let Some(l) = loading {
            let recs: Vec<&Record> = match &job {
                Job::Commit(recs, _) => recs.iter().collect(),
                Job::Relocate(recs, _) => recs.iter().map(|(_, r)| r).collect(),
                Job::Derive(..) => Vec::new(),
            };
            for r in recs {
                l.touched.insert(deriver(r.kind).partition(r));
            }
            l.derived |= matches!(job, Job::Derive(..));
        }
        let job = match job {
            Job::Derive(f, done) => {
                let mut layers: Vec<&BTreeMap<Vec<u8>, Val>> = vec![&open.entries];
                let mut pending: Vec<&Pending> = vec![&open.records];
                if let Some(s) = syncing.as_ref() {
                    layers.push(&s.entries);
                    pending.push(&s.records);
                }
                let view = self.view(layers, pending, None);
                let mut out = Out::default();
                let r = f(&view, &mut out);
                drop(view);
                match r {
                    Ok(()) => {
                        let wake =
                            self.carrier_wake(carriers::wakes(out.entries.iter().map(|(k, _)| k)));
                        out.apply(&mut open.entries);
                        open.dones.push(Done::Job(done));
                        open.dones.extend(wake);
                    }
                    Err(e) => done(Err(e)),
                }
                return;
            }
            job => job,
        };
        let stay = loading.is_some();
        let layout = open
            .layout
            .get_or_insert_with(|| Layout::start(&self.cfg.log, *cursor, stay));
        let mark = layout.mark();
        let mut entries = BTreeMap::new();
        let mut records = Pending::new();
        let mut layers_below: Vec<&BTreeMap<Vec<u8>, Val>> = vec![&open.entries];
        let mut pending_below: Vec<&Pending> = vec![&open.records];
        if let Some(s) = syncing.as_ref() {
            layers_below.push(&s.entries);
            pending_below.push(&s.records);
        }
        let memo = Memo::default();
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
                let view = self.view(layers, pending, Some(&memo));
                let recs = match moved_from {
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
                        vec![rec]
                    }
                    None => {
                        let recs = d.expand(rec, &view)?;
                        drop(view);
                        recs
                    }
                };
                let mut last = None;
                for rec in recs {
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
                        let view = self.view(layers, pending, Some(&memo));
                        match moved_from {
                            Some(from) => d.repoint(&rec, from, at, &view, &mut out)?,
                            None => d.derive(&rec, at, &view, &mut out)?,
                        }
                    }
                    records.insert(pos, (rec, len));
                    out.apply(entries);
                    last = Some(pos);
                }
                Ok(last)
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
                Job::Derive(..) => unreachable!("derived before"),
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
                let wake = self.carrier_wake(carriers::wakes(entries.keys()));
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
                    Job::Derive(..) => unreachable!("derived before"),
                });
                open.dones.extend(wake);
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

    fn sync_step(&self) -> bool {
        let mut p = self.pipe.lock().unwrap();
        if p.open.dones.is_empty() || !self.ks.pool().room_or_wait(&self.sync_act) {
            return false;
        }
        let mut group = std::mem::take(&mut p.open);
        let dones = std::mem::take(&mut group.dones);
        let Some(layout) = group.layout.as_mut() else {
            if !group.entries.is_empty() {
                self.ks.insert(std::mem::take(&mut group.entries), None);
            }
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
                let why = e.to_string();
                p.failed = Some(why.clone());
                let open = std::mem::take(&mut p.open);
                let queued: Vec<Job> = self.jobs.lock().unwrap().queue.drain(..).collect();
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

    fn clean_step(&self) -> bool {
        if !self.is_ready() || {
            let p = self.pipe.lock().unwrap();
            p.loading.is_some() || p.failed.is_some()
        } {
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
        Job::Relocate(_, d) | Job::Derive(_, d) => d(Err(e)),
    }
}

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
            let total = fold(k, vals)
                .and_then(|v| v.resolved(k))
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
mod bench_tests;
#[cfg(test)]
mod books_tests;
#[cfg(test)]
mod carriers_tests;
#[cfg(test)]
mod chat_tests;
#[cfg(test)]
mod fault_tests;
#[cfg(test)]
mod history_tests;
#[cfg(test)]
mod library_search_tests;
#[cfg(test)]
mod library_search_diff_tests;
#[cfg(test)]
mod library_tests;
#[cfg(test)]
mod references_tests;
#[cfg(test)]
mod searched_tests;
#[cfg(test)]
mod state_tests;
#[cfg(test)]
mod tags_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod token_cache_tests;
