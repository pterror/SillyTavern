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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Loc {
    pub pos: u64,
    pub len: u64,
}

pub type Pending = HashMap<u64, (Record, u64)>;

pub struct Staged {
    pub runs: Vec<Arc<Run>>,
    pub cache: Cache,
    pub counts: ReadCounts,
    pub staged_dir: PathBuf,
    pub staged_from: u64,
    pub records: Arc<StagedRecords>,
}

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

#[derive(Clone, Copy)]
pub enum Layer<'a> {
    Sorted(&'a BTreeMap<Vec<u8>, Val>),
    Hashed(&'a HashMap<Vec<u8>, Val>, &'a [u64]),
}

#[cfg(test)]
thread_local! {
    pub(super) static LAYER_READS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn layer_read() {
    #[cfg(test)]
    LAYER_READS.with(|c| c.set(c.get() + 1));
}

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

    fn range(&self, start: &[u8], end: &[u8]) -> Vec<(&'a Vec<u8>, &'a Val)> {
        let found = self.entries_in(start, end);
        found.iter().for_each(|_| layer_read());
        found
    }

    fn entries_in(&self, start: &[u8], end: &[u8]) -> Vec<(&'a Vec<u8>, &'a Val)> {
        match self {
            Layer::Sorted(m) => m
                .range::<[u8], _>((
                    std::ops::Bound::Included(start),
                    std::ops::Bound::Excluded(end),
                ))
                .collect(),
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

pub struct View<'a> {
    pub(super) layers: Vec<Layer<'a>>,
    pub(super) pending: Vec<&'a Pending>,
    pub(super) staged: Option<&'a Staged>,
    pub(super) bulk: bool,
    pub(super) ks: &'a Keyspace,
    pub(super) snap: Option<&'a Snapshot<'a>>,
    pub(super) log: &'a Log,
    pub(super) memo: Option<&'a Memo>,
}

type RevPages = HashMap<(Vec<u8>, Vec<u8>), (usize, Vec<(Vec<u8>, Val)>)>;

#[derive(Default)]
pub struct Memo {
    vals: Mutex<HashMap<Vec<u8>, Option<Val>>>,
    rev: Mutex<RevPages>,
    records: Mutex<HashMap<u64, (Record, u64)>>,
}

impl View<'_> {
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

    pub fn map_range(
        &self,
        key: &[u8],
        lo: u32,
        hi: u32,
        published: bool,
    ) -> Result<Vec<(u32, u32)>, StoreError> {
        let mut acc: Vec<(u32, u32)> = Vec::new();
        let mut adds: Vec<(u32, i64)> = Vec::new();
        let mut maxes: Vec<(u32, u32)> = Vec::new();
        let mut base: Option<Option<Vec<u8>>> = None;
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

    pub fn is_bulk(&self) -> bool {
        self.bulk
    }

    pub fn published_version(&self) -> u64 {
        self.ks.inserted()
    }

    pub fn get_published(&self, key: &[u8]) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(self.ks.get(key)?)
    }

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

    pub fn scan_vals(
        &self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Val)>, StoreError> {
        self.merged(start, end, limit, false)
    }

    #[allow(clippy::type_complexity)]
    fn unpublished_sources<'s>(
        &'s self,
        start: &'s [u8],
        end: &'s [u8],
        rev: bool,
    ) -> Result<Vec<std::iter::Peekable<Box<dyn Iterator<Item = (Vec<u8>, Val)> + 's>>>, StoreError>
    {
        let mut out: Vec<Box<dyn Iterator<Item = (Vec<u8>, Val)> + 's>> = Vec::new();
        for layer in &self.layers {
            out.push(match layer {
                Layer::Sorted(m) => {
                    let r = m
                        .range::<[u8], _>((
                            std::ops::Bound::Included(start),
                            std::ops::Bound::Excluded(end),
                        ))
                        .map(|(k, v)| {
                            layer_read();
                            (k.clone(), v.clone())
                        });
                    if rev { Box::new(r.rev()) } else { Box::new(r) }
                }
                Layer::Hashed(..) => {
                    let mut v: Vec<_> = layer
                        .range(start, end)
                        .into_iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    if rev {
                        v.reverse();
                    }
                    Box::new(v.into_iter())
                }
            });
        }
        if let Some(st) = self.staged {
            for r in &st.runs {
                let mut v = Vec::new();
                let mut it = RunIter::new(r.clone(), start, Some(&st.cache), Some(&st.counts))?;
                while let Some(k) = it.key() {
                    if k >= end {
                        break;
                    }
                    v.push((k.to_vec(), it.val()?));
                    it.advance()?;
                }
                if rev {
                    v.reverse();
                }
                out.push(Box::new(v.into_iter()));
            }
        }
        Ok(out.into_iter().map(Iterator::peekable).collect())
    }

    fn merged(
        &self,
        start: &[u8],
        end: &[u8],
        limit: usize,
        rev: bool,
    ) -> Result<Vec<(Vec<u8>, Val)>, StoreError> {
        let mut sources = self.unpublished_sources(start, end, rev)?;
        let (mut from, mut to) = (start.to_vec(), end.to_vec());
        let mut published: std::collections::VecDeque<(Vec<u8>, Val)> = Default::default();
        let mut published_done = false;
        let page = limit.max(1);
        let ahead = |a: &[u8], b: &[u8]| if rev { a > b } else { a < b };
        let mut out = Vec::new();
        while out.len() < limit {
            if published.is_empty() && !published_done {
                let got = if rev {
                    self.published_rev(&from, &to, page)?
                } else {
                    match self.snap {
                        Some(s) => s.scan_vals(&from, &to, page)?,
                        None => self.ks.scan_vals(&from, &to, page)?,
                    }
                };
                published_done = got.len() < page;
                if let Some((k, _)) = got.last() {
                    if rev {
                        to.clone_from(k);
                    } else {
                        from = k.clone();
                        from.push(0);
                    }
                }
                published.extend(got);
            }
            let mut next: Option<Vec<u8>> = None;
            for s in sources.iter_mut() {
                if let Some((k, _)) = s.peek()
                    && next.as_ref().is_none_or(|n| ahead(k, n))
                {
                    next = Some(k.clone());
                }
            }
            let taken = match (published.front(), next) {
                (None, None) => break,
                (Some(_), None) => published.pop_front().map(|(k, v)| (k, Some(v))),
                (Some((pk, _)), Some(uk)) if ahead(pk, &uk) => {
                    published.pop_front().map(|(k, v)| (k, Some(v)))
                }
                (_, Some(k)) => {
                    let mut vals = Vec::new();
                    for s in sources.iter_mut() {
                        if let Some((_, v)) = s.next_if(|(sk, _)| *sk == k) {
                            vals.push(v);
                        }
                    }
                    let mut vals = vals.into_iter().rev();
                    let mut v = vals.next().expect("the key came from a source");
                    for newer in vals {
                        v = newer.over(&k, &v);
                    }
                    let base = match published.front() {
                        Some((pk, _)) if *pk == k => published.pop_front().map(|(_, b)| b),
                        _ => None,
                    };
                    let v = match base {
                        Some(b) => v.over_settled(&k, &b),
                        None => v,
                    };
                    let v = v.settled(&k);
                    Some((k, v))
                }
            };
            if let Some((k, Some(v))) = taken {
                out.push((k, v));
            }
        }
        Ok(out)
    }

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

    pub fn scan_vals_rev(
        &self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Val)>, StoreError> {
        self.merged(start, end, limit, true)
    }

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

#[derive(Clone, Copy)]
pub struct AddMapKind(u64);

impl AddMapKind {
    pub const fn new(structure: u64) -> AddMapKind {
        AddMapKind(structure)
    }

    pub const fn id(self) -> u64 {
        self.0
    }

    pub fn prefix(self) -> Vec<u8> {
        super::kinds::key::of(self.0)
    }

    pub fn key(self, parts: impl FnOnce(&mut Vec<u8>)) -> AddMapKey {
        let mut k = super::kinds::key::of(self.0);
        parts(&mut k);
        AddMapKey(k)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AddMapKey(Vec<u8>);

#[cfg(test)]
impl AddMapKey {
    pub fn bytes(&self) -> &[u8] {
        &self.0
    }
}

impl AddMapKey {
    pub(super) fn into_raw(self) -> Vec<u8> {
        self.0
    }
}

mod sealed {
    pub trait Key {
        fn into_key(self) -> Vec<u8>;
    }
}

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

#[derive(Default)]
pub struct Out {
    pub entries: Vec<(Vec<u8>, Val)>,
}

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

    pub fn max_map(&mut self, key: Vec<u8>, pairs: Vec<(u32, u32)>) {
        self.push(key, Val::MaxMap(pairs));
    }

    pub fn map(&mut self, key: Vec<u8>, pairs: Vec<(u32, u32)>) {
        self.push(key, Val::Map(pairs));
    }

    pub fn add_map(&mut self, key: AddMapKey, pairs: Vec<(u32, i64)>) {
        self.push(key.0, Val::AddMap(pairs));
    }

    pub fn apply(self, layer: &mut BTreeMap<Vec<u8>, Val>) {
        for (k, v) in self.entries {
            apply(layer, k, v);
        }
    }

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
        Some(Val::Put(_)) if matches!(v, Val::Del) && super::kinds::key::written_once(&k) => {
            layer.remove(&k);
        }
        Some(old) => {
            let older = std::mem::replace(old, Val::Del);
            *old = v.over_owned(&k, older);
        }
        None => {
            layer.insert(k, v);
        }
    }
}

pub trait Deriver: Sync {
    fn prepare(&self, rec: Record, _view: &View) -> Result<Record, StoreError> {
        Ok(rec)
    }

    fn expand(&self, rec: Record, view: &View) -> Result<Vec<Record>, StoreError> {
        Ok(vec![self.prepare(rec, view)?])
    }

    fn prepares(&self) -> bool {
        false
    }

    fn partition(&self, rec: &Record) -> u64 {
        match rec.values.first() {
            Some(Value::Id(v) | Value::UInt(v)) => *v,
            _ => 0,
        }
    }

    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError>;

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError>;

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError>;
}

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
