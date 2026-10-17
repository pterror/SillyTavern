//! The derivation framework: one deriver per record kind, run at commit and at replay by the same code, so
//! both produce the same entries.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use super::StoreError;
use crate::keyspace::cache::Cache;
use crate::keyspace::run::{ReadCounts, Run, RunIter, Source};
use crate::keyspace::val::{Val, fold};
use crate::keyspace::{Entries, Keyspace, Snapshot};
use crate::log::Log;
use crate::log::format::{Kind, Record, Value};

/// Where a record is in the log, and its encoded length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Loc {
    pub pos: u64,
    pub len: u64,
}

/// Records not yet durable, by position, with their lengths.
pub type Pending = HashMap<u64, (Record, u64)>;

/// A bulk load's unpublished state below a worker's buffer: the runs it spilled (newest first), and the log
/// files it laid out from `staged_from` on, kept in `staged_dir` until the load is installed.
pub struct Staged {
    pub runs: Vec<Arc<Run>>,
    pub cache: Cache,
    pub counts: ReadCounts,
    pub staged_dir: PathBuf,
    pub staged_from: u64,
    /// Staged records already in hand (`StagedRecords`).
    pub records: Arc<StagedRecords>,
}

/// A load worker's staged records by position, with their lengths: the ones it derived and the ones it read. A
/// record's derivation reads the records of its entity before it (a tag assignment its card's name and keys, a
/// create every text it indexes) and the tags it names; a staged read opens its file and decodes its block from the
/// start. Up to `budget` encoded bytes are kept, then all are let go at once.
#[derive(Default)]
pub struct StagedRecords {
    held: std::sync::Mutex<(Pending, u64)>,
    budget: u64,
}

impl StagedRecords {
    pub fn new(budget: u64) -> StagedRecords {
        StagedRecords {
            held: std::sync::Mutex::new((HashMap::new(), 0)),
            budget,
        }
    }

    pub fn get(&self, pos: u64) -> Option<(Record, u64)> {
        self.held.lock().unwrap().0.get(&pos).cloned()
    }

    pub fn put(&self, pos: u64, rec: &Record, len: u64) {
        if len > self.budget {
            return;
        }
        let mut h = self.held.lock().unwrap();
        if h.1 + len > self.budget {
            h.0.clear();
            h.1 = 0;
        }
        if h.0.insert(pos, (rec.clone(), len)).is_none() {
            h.1 += len;
        }
    }
}

/// Unpublished entries, sorted or not. A hashed layer holds keys of the structures listed only, so a scan of
/// other structures passes it by; one of those reads all of it.
#[derive(Clone, Copy)]
pub enum Layer<'a> {
    Sorted(&'a BTreeMap<Vec<u8>, Val>),
    Hashed(&'a HashMap<Vec<u8>, Val>, &'a [u64]),
}

/// The structure a key starts with, or None for a key too short to name one.
fn structure_of(k: &[u8]) -> Option<u64> {
    let mut at = 0;
    crate::keyspace::val::get_u64(k, &mut at)
}

impl<'a> Layer<'a> {
    fn get(&self, key: &[u8]) -> Option<&'a Val> {
        match self {
            Layer::Sorted(m) => m.get(key),
            Layer::Hashed(m, _) => m.get(key),
        }
    }

    /// The entries in `[start, end)`, in order.
    fn range(&self, start: &[u8], end: &[u8]) -> Vec<(&'a Vec<u8>, &'a Val)> {
        match self {
            Layer::Sorted(m) => m
                .range::<[u8], _>((
                    std::ops::Bound::Included(start),
                    std::ops::Bound::Excluded(end),
                ))
                .collect(),
            // `[start, end)` spans the structures from start's to end's (any, where a bound names none).
            Layer::Hashed(_, held)
                if !held.iter().any(|s| {
                    (structure_of(start).unwrap_or(0)..=structure_of(end).unwrap_or(u64::MAX))
                        .contains(s)
                }) =>
            {
                Vec::new()
            }
            Layer::Hashed(m, _) => {
                let mut v: Vec<_> = m
                    .iter()
                    .filter(|(k, _)| k.as_slice() >= start && k.as_slice() < end)
                    .collect();
                v.sort_unstable_by(|a, b| a.0.cmp(b.0));
                v
            }
        }
    }
}

/// What a deriver sees: entries not yet published (newest first: the layers, then a bulk load's spilled runs)
/// over the keyspace, and records not yet durable over the log.
pub struct View<'a> {
    pub(super) layers: Vec<Layer<'a>>,
    pub(super) pending: Vec<&'a Pending>,
    pub(super) staged: Option<&'a Staged>,
    /// A bulk load's: entries shared across partitions that a write would read and rewrite are left alone.
    pub(super) bulk: bool,
    pub(super) ks: &'a Keyspace,
    /// Reads of published entries go through this snapshot, when there is one (`View::with_snapshot`).
    pub(super) snap: Option<&'a Snapshot<'a>>,
    pub(super) log: &'a Log,
    /// A commit's reads of published entries and of the log, kept for the rest of its job (`Memo`).
    pub(super) memo: Option<&'a Memo>,
}

/// Reverse pages by range: the limit read, and what it found (all of the range if fewer).
type RevPages = HashMap<(Vec<u8>, Vec<u8>), (usize, Vec<(Vec<u8>, Val)>)>;

/// What one job's derivers have read of the published entries and the log, so each is read once per job: a
/// record's `prepare` and its `derive`, and every record of an entity, read the same entries (its version, its
/// book, its deletion). The published entries don't change while a job derives (it publishes after its sync) and a
/// record never changes at its position, so nothing held here goes stale within the job; the job's own writes are
/// in the layers, which are read first. Holds what the job read, so it is bounded by the job.
#[derive(Default)]
pub struct Memo {
    /// Published values by key (None: no value).
    vals: Mutex<HashMap<Vec<u8>, Option<Val>>>,
    /// Published reverse pages.
    rev: Mutex<RevPages>,
    /// Log records by position, with their lengths.
    records: Mutex<HashMap<u64, (Record, u64)>>,
}

impl View<'_> {
    /// The unpublished values of `key`, newest first, down to the first that hides the older ones.
    fn unpublished(&self, key: &[u8]) -> Result<Vec<Val>, StoreError> {
        let mut vals = Vec::new();
        for l in &self.layers {
            if let Some(v) = l.get(key) {
                let done = !v.is_partial();
                vals.push(v.clone());
                if done {
                    return Ok(vals);
                }
            }
        }
        if let Some(st) = self.staged {
            for r in &st.runs {
                if let Some(v) = r.get(key, &st.cache, &st.counts)? {
                    let done = !v.is_partial();
                    vals.push(v);
                    if done {
                        return Ok(vals);
                    }
                }
            }
        }
        Ok(vals)
    }

    pub fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(self.get_val(key)?.map(|v| v.into_bytes(key)))
    }

    /// `get`, the value settled (`Val::settled`): a map as its pairs.
    pub fn get_val(&self, key: &[u8]) -> Result<Option<Val>, StoreError> {
        let vals = self.unpublished(key)?;
        let newer = fold(key, vals);
        if newer.as_ref().is_none_or(Val::is_partial) {
            let published = self.published_val(key)?;
            return Ok(match (newer, published) {
                (Some(v), Some(b)) => v.over_settled(key, &b).settled(key),
                (Some(v), None) => v.settled(key),
                (None, b) => b,
            });
        }
        Ok(newer.and_then(|v| v.settled(key)))
    }

    /// The published value of `key`, read once per job.
    fn published_val(&self, key: &[u8]) -> Result<Option<Val>, StoreError> {
        if let Some(m) = self.memo
            && let Some(v) = m.vals.lock().unwrap().get(key)
        {
            return Ok(v.clone());
        }
        let v = match self.snap {
            Some(s) => s.get_val(key)?,
            None => self.ks.get_val(key)?,
        };
        if let Some(m) = self.memo {
            m.vals.lock().unwrap().insert(key.to_vec(), v.clone());
        }
        Ok(v)
    }

    /// The published reverse page of up to `limit` keys in `[start, end)`, read once per job: a page read before
    /// serves a smaller limit, or any limit once it held all of the range.
    fn published_rev(
        &self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Val)>, StoreError> {
        let range = (start.to_vec(), end.to_vec());
        if let Some(m) = self.memo
            && let Some((read, found)) = m.rev.lock().unwrap().get(&range)
            && (limit <= *read || found.len() < *read)
        {
            return Ok(found.iter().take(limit).cloned().collect());
        }
        let found = match self.snap {
            Some(s) => s.scan_vals_rev(start, end, limit)?,
            None => self.ks.scan_vals_rev(start, end, limit)?,
        };
        if let Some(m) = self.memo {
            m.rev.lock().unwrap().insert(range, (limit, found.clone()));
        }
        Ok(found)
    }

    /// The pairs of the map at `key` whose slots are in `[lo, hi)`, removals dropped; with `published` false,
    /// as if nothing were published. Reads only those slots of maps still being built.
    pub fn map_range(
        &self,
        key: &[u8],
        lo: u32,
        hi: u32,
        published: bool,
    ) -> Result<Vec<(u32, u32)>, StoreError> {
        let mut acc: Vec<(u32, u32)> = Vec::new();
        // An added map's deltas, summed.
        let mut adds: Vec<(u32, i64)> = Vec::new();
        // A maxima map's raises, their maximum.
        let mut maxes: Vec<(u32, u32)> = Vec::new();
        let mut base: Option<Option<Vec<u8>>> = None;
        // Folds one value (newest first) into `acc`; true once it hides everything older.
        let mut take = |v: &Val, acc: &mut Vec<(u32, u32)>| -> bool {
            match v {
                Val::Map(p) => {
                    let from = p.partition_point(|x| x.0 < lo);
                    let to = p.partition_point(|x| x.0 < hi);
                    *acc = crate::keyspace::val::map_over(acc, p[from..to].to_vec());
                    false
                }
                Val::AddMap(p) => {
                    let from = p.partition_point(|x| x.0 < lo);
                    let to = p.partition_point(|x| x.0 < hi);
                    adds = crate::keyspace::val::add_pairs(&p[from..to], std::mem::take(&mut adds));
                    false
                }
                Val::MaxMap(p) => {
                    let from = p.partition_point(|x| x.0 < lo);
                    let to = p.partition_point(|x| x.0 < hi);
                    maxes = crate::keyspace::val::map_max(&p[from..to], std::mem::take(&mut maxes));
                    false
                }
                Val::Put(b) => {
                    base = Some(Some(b.clone()));
                    true
                }
                _ => {
                    base = Some(None);
                    true
                }
            }
        };
        let mut done = false;
        for l in &self.layers {
            if let Some(v) = l.get(key)
                && take(v, &mut acc)
            {
                done = true;
                break;
            }
        }
        if !done && let Some(st) = self.staged {
            for r in &st.runs {
                if let Some(v) = r.get(key, &st.cache, &st.counts)?
                    && take(&v, &mut acc)
                {
                    break;
                }
            }
        }
        let base = match base {
            Some(b) => b,
            None if published => self.ks.get(key)?,
            None => None,
        };
        if let Some(b) = base {
            let older: Vec<(u32, u32)> = crate::keyspace::val::map_pairs(&b)
                .ok_or_else(|| StoreError::Entry("a map doesn't decode".into()))?
                .into_iter()
                .filter(|x| x.0 >= lo && x.0 < hi)
                .collect();
            acc = crate::keyspace::val::map_over(&acc, older);
        }
        if !maxes.is_empty() {
            acc = crate::keyspace::val::map_max(&maxes, acc);
        }
        if !adds.is_empty() {
            let wide = acc.into_iter().map(|(s, v)| (s, u64::from(v))).collect();
            acc = crate::keyspace::val::add_onto(key, &adds, wide)
                .into_iter()
                .map(|(s, v)| u32::try_from(v).map(|v| (s, v)))
                .collect::<Result<_, _>>()
                .map_err(|_| StoreError::Entry("a map doesn't decode".into()))?;
        }
        acc.retain(|x| x.1 != 0);
        Ok(acc)
    }

    /// This view with `layer` over its unpublished entries.
    pub fn with_layer<'b>(&'b self, layer: &'b BTreeMap<Vec<u8>, Val>) -> View<'b> {
        let mut layers = vec![Layer::Sorted(layer)];
        layers.extend(self.layers.iter().copied());
        View {
            layers,
            pending: self.pending.clone(),
            staged: self.staged,
            bulk: self.bulk,
            ks: self.ks,
            snap: self.snap,
            log: self.log,
            memo: self.memo,
        }
    }

    /// Whether a bulk load derives through this view (see `bulk`).
    pub fn is_bulk(&self) -> bool {
        self.bulk
    }

    /// A number that changes whenever the published entries may have.
    pub fn published_version(&self) -> u64 {
        self.ks.inserted()
    }

    /// The published value only.
    pub fn get_published(&self, key: &[u8]) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(self.ks.get(key)?)
    }

    /// Up to `limit` keys in `[start, end)` that have values, in order.
    pub fn scan(&self, start: &[u8], end: &[u8], limit: usize) -> Result<Entries, StoreError> {
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
    ) -> Result<Vec<(Vec<u8>, Val)>, StoreError> {
        let mut unpublished: BTreeMap<Vec<u8>, Val> = BTreeMap::new();
        let mut over = |k: &Vec<u8>, v: Val| {
            let v = match unpublished.remove(k) {
                Some(older) => v.over(k, &older),
                None => v,
            };
            unpublished.insert(k.clone(), v);
        };
        // Oldest first.
        if let Some(st) = self.staged {
            for r in st.runs.iter().rev() {
                let mut it = RunIter::new(r.clone(), start, Some(&st.cache), Some(&st.counts))?;
                while let Some(k) = it.key() {
                    if k >= end {
                        break;
                    }
                    let k = k.to_vec();
                    over(&k, it.val()?);
                    it.advance()?;
                }
            }
        }
        for layer in self.layers.iter().rev() {
            for (k, v) in layer.range(start, end) {
                over(k, v.clone());
            }
        }
        // Each unpublished entry can hide at most one published one.
        let limit_published = limit.saturating_add(unpublished.len());
        let published = match self.snap {
            Some(s) => s.scan_vals(start, end, limit_published)?,
            None => self.ks.scan_vals(start, end, limit_published)?,
        };
        let mut out = Vec::new();
        let mut published = published.into_iter().peekable();
        let mut unpublished = unpublished.into_iter().peekable();
        while out.len() < limit {
            let next = match (published.peek(), unpublished.peek()) {
                (None, None) => break,
                (Some(_), None) => published.next().map(|(k, v)| (k, Some(v))),
                (Some((pk, _)), Some((uk, _))) if pk < uk => {
                    published.next().map(|(k, v)| (k, Some(v)))
                }
                _ => {
                    let (k, v) = unpublished.next().unwrap();
                    let base = published.next_if(|(pk, _)| *pk == k).map(|(_, b)| b);
                    let v = match base {
                        Some(b) => v.over_settled(&k, &b),
                        None => v,
                    };
                    let v = v.settled(&k);
                    Some((k, v))
                }
            };
            if let Some((k, Some(v))) = next {
                out.push((k, v));
            }
        }
        Ok(out)
    }

    /// `get` for each of `keys`, reading the published entries' run blocks once for the keys they hold.
    pub fn get_many(&self, keys: &[Vec<u8>]) -> Result<Vec<Option<Vec<u8>>>, StoreError> {
        let mut vals: Vec<Vec<Val>> = Vec::with_capacity(keys.len());
        let mut published: Vec<usize> = Vec::new();
        for (i, k) in keys.iter().enumerate() {
            let v = self.unpublished(k)?;
            if v.iter().all(Val::is_partial) {
                published.push(i);
            }
            vals.push(v);
        }
        published.sort_by(|a, b| keys[*a].cmp(&keys[*b]));
        published.dedup_by(|a, b| keys[*a] == keys[*b]);
        let sorted: Vec<&[u8]> = published.iter().map(|i| keys[*i].as_slice()).collect();
        let found = match self.snap {
            Some(s) => s.values_sorted(&sorted)?,
            None => self.ks.values_sorted(&sorted)?,
        };
        let mut by_key: HashMap<&[u8], Vec<Val>> = HashMap::new();
        for (n, v) in found.into_iter().enumerate() {
            by_key.insert(sorted[n], v);
        }
        Ok(keys
            .iter()
            .zip(vals)
            .map(|(k, mut v)| {
                if v.iter().all(Val::is_partial)
                    && let Some(p) = by_key.get(k.as_slice())
                {
                    v.extend(p.iter().cloned());
                }
                fold(k, v)
                    .and_then(|v| v.settled(k))
                    .map(|v| v.into_bytes(k))
            })
            .collect())
    }

    /// About how many keys `[start, end)` holds (`Keyspace::estimate`), the unpublished entries counted.
    pub fn estimate(&self, start: &[u8], end: &[u8]) -> Result<f64, StoreError> {
        let mut n = 0.0;
        for layer in &self.layers {
            n += layer
                .range(start, end)
                .into_iter()
                .filter(|(_, v)| !matches!(v, Val::Del))
                .count() as f64;
        }
        Ok(n + match self.snap {
            Some(s) => s.estimate(start, end)?,
            None => self.ks.estimate(start, end)?,
        })
    }

    /// `scan_vals` last first: up to `limit` keys in `[start, end)` from the last down.
    pub fn scan_vals_rev(
        &self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Val)>, StoreError> {
        let mut unpublished: BTreeMap<Vec<u8>, Val> = BTreeMap::new();
        let mut over = |k: &Vec<u8>, v: Val| {
            let v = match unpublished.remove(k) {
                Some(older) => v.over(k, &older),
                None => v,
            };
            unpublished.insert(k.clone(), v);
        };
        if let Some(st) = self.staged {
            for r in st.runs.iter().rev() {
                let mut it = RunIter::new(r.clone(), start, Some(&st.cache), Some(&st.counts))?;
                while let Some(k) = it.key() {
                    if k >= end {
                        break;
                    }
                    let k = k.to_vec();
                    over(&k, it.val()?);
                    it.advance()?;
                }
            }
        }
        for layer in self.layers.iter().rev() {
            for (k, v) in layer.range(start, end) {
                over(k, v.clone());
            }
        }
        let limit_published = limit.saturating_add(unpublished.len());
        let published = self.published_rev(start, end, limit_published)?;
        let mut out = Vec::new();
        let mut published = published.into_iter().peekable();
        let mut unpublished = unpublished.into_iter().rev().peekable();
        while out.len() < limit {
            let next = match (published.peek(), unpublished.peek()) {
                (None, None) => break,
                (Some(_), None) => published.next().map(|(k, v)| (k, Some(v))),
                (Some((pk, _)), Some((uk, _))) if pk > uk => {
                    published.next().map(|(k, v)| (k, Some(v)))
                }
                _ => {
                    let (k, v) = unpublished.next().unwrap();
                    let base = published.next_if(|(pk, _)| *pk == k).map(|(_, b)| b);
                    let v = match base {
                        Some(b) => v.over_settled(&k, &b),
                        None => v,
                    };
                    let v = v.settled(&k);
                    Some((k, v))
                }
            };
            if let Some((k, Some(v))) = next {
                out.push((k, v));
            }
        }
        Ok(out)
    }

    /// The records at `positions` (durable or not), in the order given; a log block is decoded once for the ones
    /// it holds.
    pub fn records(&self, positions: &[u64]) -> Result<Vec<Record>, StoreError> {
        let mut out: Vec<Option<Record>> = vec![None; positions.len()];
        let mut from_log = Vec::new();
        for (i, &pos) in positions.iter().enumerate() {
            let pending = self.pending.iter().find_map(|p| p.get(&pos));
            if let Some((r, _)) = pending {
                out[i] = Some(r.clone());
            } else if self.staged.is_some_and(|st| pos >= st.staged_from) {
                out[i] = Some(self.record(pos)?.0);
            } else {
                from_log.push(i);
            }
        }
        let read = self
            .log
            .read_many(&from_log.iter().map(|&i| positions[i]).collect::<Vec<_>>())?;
        for (i, (r, _)) in from_log.into_iter().zip(read) {
            out[i] = Some(r);
        }
        Ok(out
            .into_iter()
            .map(|r| r.expect("every record read"))
            .collect())
    }

    /// The record at `pos`, durable or not.
    pub fn record(&self, pos: u64) -> Result<(Record, u64), StoreError> {
        for p in &self.pending {
            if let Some((r, len)) = p.get(&pos) {
                return Ok((r.clone(), *len));
            }
        }
        if let Some(st) = self.staged
            && pos >= st.staged_from
        {
            if let Some(r) = st.records.get(pos) {
                return Ok(r);
            }
            let (r, len) = self.log.read_staged(&st.staged_dir, pos)?;
            st.records.put(pos, &r, len);
            return Ok((r, len));
        }
        if let Some(m) = self.memo
            && let Some(r) = m.records.lock().unwrap().get(&pos)
        {
            return Ok(r.clone());
        }
        let r = self.log.read_sized(pos)?;
        if let Some(m) = self.memo {
            m.records.lock().unwrap().insert(pos, r.clone());
        }
        Ok(r)
    }
}

/// A structure whose values are only ever `Val::AddMap`s: no other map is written at its keys, which only its
/// `AddMapKey`s name.
#[derive(Clone, Copy)]
pub struct AddMapKind(u64);

impl AddMapKind {
    pub const fn new(structure: u64) -> AddMapKind {
        AddMapKind(structure)
    }

    pub const fn id(self) -> u64 {
        self.0
    }

    /// The prefix of every key of this structure.
    pub fn prefix(self) -> Vec<u8> {
        super::kinds::key::of(self.0)
    }

    /// The key of this structure with `parts` (its components) after the structure's id.
    pub fn key(self, parts: impl FnOnce(&mut Vec<u8>)) -> AddMapKey {
        let mut k = super::kinds::key::of(self.0);
        parts(&mut k);
        AddMapKey(k)
    }
}

/// A key of an `AddMapKind`: `Out::add_map` and `Out::del` take it, the other writers don't.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AddMapKey(Vec<u8>);

#[cfg(test)]
impl AddMapKey {
    pub fn bytes(&self) -> &[u8] {
        &self.0
    }
}

impl AddMapKey {
    /// The key's bytes, for a bulk load's sink, which writes only `Val::AddMap`s at them.
    pub(super) fn into_raw(self) -> Vec<u8> {
        self.0
    }
}

mod sealed {
    pub trait Key {
        fn into_key(self) -> Vec<u8>;
    }
}

/// A key `Out::del` takes: any key, an `AddMapKey` included.
pub trait DelKey: sealed::Key {}

impl sealed::Key for Vec<u8> {
    fn into_key(self) -> Vec<u8> {
        self
    }
}
impl DelKey for Vec<u8> {}

impl sealed::Key for AddMapKey {
    fn into_key(self) -> Vec<u8> {
        self.0
    }
}
impl DelKey for AddMapKey {}

/// The entries a deriver produces, in order.
#[derive(Default)]
pub struct Out {
    pub entries: Vec<(Vec<u8>, Val)>,
}

/// Entries derivers have produced, by the structure their key is in (the key's first `u64`, below 256).
#[cfg(feature = "measure")]
pub static PRODUCED: [std::sync::atomic::AtomicU64; 256] =
    [const { std::sync::atomic::AtomicU64::new(0) }; 256];

impl Out {
    fn push(&mut self, key: Vec<u8>, v: Val) {
        #[cfg(feature = "measure")]
        if let Some(s) = crate::keyspace::val::get_u64(&key, &mut 0)
            && let Some(c) = PRODUCED.get(s as usize)
        {
            c.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        self.entries.push((key, v));
    }

    pub fn put(&mut self, key: Vec<u8>, value: Vec<u8>) {
        self.push(key, Val::Put(value));
    }

    pub fn del(&mut self, key: impl DelKey) {
        self.push(sealed::Key::into_key(key), Val::Del);
    }

    pub fn add(&mut self, key: Vec<u8>, n: i64) {
        self.push(key, Val::Add(n));
    }

    pub fn max(&mut self, key: Vec<u8>, n: u64) {
        self.push(key, Val::Max(n));
    }

    /// Raises slots of the key's map (`Val::MaxMap`).
    pub fn max_map(&mut self, key: Vec<u8>, pairs: Vec<(u32, u32)>) {
        self.push(key, Val::MaxMap(pairs));
    }

    /// Sets slots of the key's map (`Val::Map`).
    pub fn map(&mut self, key: Vec<u8>, pairs: Vec<(u32, u32)>) {
        self.push(key, Val::Map(pairs));
    }

    /// Adds to slots of the key's map (`Val::AddMap`): (slot, delta) pairs sorted by slot, no delta 0.
    pub fn add_map(&mut self, key: AddMapKey, pairs: Vec<(u32, i64)>) {
        self.push(key.0, Val::AddMap(pairs));
    }

    /// Applies the entries over `layer`.
    pub fn apply(self, layer: &mut BTreeMap<Vec<u8>, Val>) {
        for (k, v) in self.entries {
            apply(layer, k, v);
        }
    }

    /// Applies the entries over `sorted`, or over `hashed` for the keys `hashed_key` picks.
    pub fn apply_split(
        self,
        sorted: &mut BTreeMap<Vec<u8>, Val>,
        hashed: &mut HashMap<Vec<u8>, Val>,
        hashed_key: impl Fn(&[u8]) -> bool,
    ) {
        for (k, v) in self.entries {
            if !hashed_key(&k) {
                apply(sorted, k, v);
                continue;
            }
            match hashed.get_mut(&k) {
                Some(old) => {
                    let older = std::mem::replace(old, Val::Del);
                    *old = v.over_owned(&k, older);
                }
                None => {
                    hashed.insert(k, v);
                }
            }
        }
    }
}

pub fn apply(layer: &mut BTreeMap<Vec<u8>, Val>, k: Vec<u8>, v: Val) {
    match layer.get_mut(&k) {
        Some(old) => {
            let older = std::mem::replace(old, Val::Del);
            *old = v.over_owned(&k, older);
        }
        None => {
            layer.insert(k, v);
        }
    }
}

/// What a record kind derives. Every method sees the state as of just before the record (at commit and at
/// replay alike), so it must depend on nothing else.
pub trait Deriver: Sync {
    /// At commit only, before the record is logged: the record to log for it, or a refusal.
    fn prepare(&self, rec: Record, _view: &View) -> Result<Record, StoreError> {
        Ok(rec)
    }

    /// At commit only, in place of `prepare`: the records to log for this one, in order, each derived after the one
    /// before (by default `prepare`'s one).
    fn expand(&self, rec: Record, view: &View) -> Result<Vec<Record>, StoreError> {
        Ok(vec![self.prepare(rec, view)?])
    }

    /// Whether `prepare` (or `expand`) may change the record. A bulk load lays its records out before deriving any,
    /// so it takes only kinds that it can't.
    fn prepares(&self) -> bool {
        false
    }

    /// The record's partition: every entry `derive` reads, and every entry it writes that isn't a counter, a
    /// maximum or a map slot of its own partition's, belongs to records of the same partition. So a bulk load
    /// derives each partition's records in order on one thread, and partitions in parallel.
    fn partition(&self, rec: &Record) -> u64 {
        match rec.values.first() {
            Some(Value::Id(v) | Value::UInt(v)) => *v,
            _ => 0,
        }
    }

    /// The entries for the record at `at`.
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError>;

    /// Whether an entry points at the record at `pos`; a record nothing points at is dropped by cleaning.
    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError>;

    /// The entries that point the record's entries at its copy at `to` instead of at `from`.
    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError>;
}

/// A kind with no deriver yet: it derives nothing and is kept by cleaning.
struct Kept;

impl Deriver for Kept {
    fn derive(&self, _: &Record, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Ok(())
    }

    fn is_live(&self, _: &Record, _: u64, _: &View) -> Result<bool, StoreError> {
        Ok(true)
    }

    fn repoint(&self, _: &Record, _: u64, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Ok(())
    }
}

pub fn deriver(kind: &Kind) -> &'static dyn Deriver {
    super::kinds::deriver(kind.name).unwrap_or(&Kept)
}
