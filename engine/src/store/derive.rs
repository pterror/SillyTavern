//! The derivation framework: one deriver per record kind, run at commit and at replay by the same code, so
//! both produce the same entries.

use std::collections::{BTreeMap, HashMap};

use super::StoreError;
use crate::keyspace::val::{Val, fold};
use crate::keyspace::{Entries, Keyspace};
use crate::log::Log;
use crate::log::format::{Kind, Record};

/// Where a record is in the log, and its encoded length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Loc {
    pub pos: u64,
    pub len: u64,
}

/// Records not yet durable, by position, with their lengths.
pub type Pending = HashMap<u64, (Record, u64)>;

/// What a deriver sees: entries not yet published (newest first) over the keyspace, and records not yet durable
/// over the log.
pub struct View<'a> {
    pub(super) layers: Vec<&'a BTreeMap<Vec<u8>, Val>>,
    pub(super) pending: Vec<&'a Pending>,
    pub(super) ks: &'a Keyspace,
    pub(super) log: &'a Log,
}

impl View<'_> {
    pub fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>, StoreError> {
        let mut vals: Vec<Val> = self
            .layers
            .iter()
            .filter_map(|l| l.get(key).cloned())
            .collect();
        if vals.iter().all(Val::is_partial) {
            match self.ks.get(key)? {
                Some(b) => vals.push(Val::Put(b)),
                None if vals.is_empty() => return Ok(None),
                None => {}
            }
        }
        Ok(fold(vals).and_then(Val::resolved))
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
        let mut base: Option<Option<Vec<u8>>> = None;
        for l in &self.layers {
            match l.get(key) {
                None => continue,
                Some(Val::Map(p)) => {
                    let from = p.partition_point(|x| x.0 < lo);
                    let to = p.partition_point(|x| x.0 < hi);
                    acc = crate::keyspace::val::map_over(&acc, p[from..to].to_vec());
                }
                Some(Val::Put(b)) => {
                    base = Some(Some(b.clone()));
                    break;
                }
                Some(_) => {
                    base = Some(None);
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
        acc.retain(|x| x.1 != 0);
        Ok(acc)
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
        let mut unpublished: BTreeMap<Vec<u8>, Val> = BTreeMap::new();
        for layer in self.layers.iter().rev() {
            for (k, v) in layer.range::<[u8], _>((
                std::ops::Bound::Included(start),
                std::ops::Bound::Excluded(end),
            )) {
                let v = match unpublished.remove(k) {
                    Some(older) => v.clone().over(&older),
                    None => v.clone(),
                };
                unpublished.insert(k.clone(), v);
            }
        }
        // Each unpublished entry can hide at most one published one.
        let published = self
            .ks
            .scan(start, end, limit.saturating_add(unpublished.len()))?;
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
                        Some(b) => v.over(&Val::Put(b)),
                        None => v,
                    };
                    Some((k, v.resolved()))
                }
            };
            if let Some((k, Some(v))) = next {
                out.push((k, v));
            }
        }
        Ok(out)
    }

    /// The record at `pos`, durable or not.
    pub fn record(&self, pos: u64) -> Result<(Record, u64), StoreError> {
        for p in &self.pending {
            if let Some((r, len)) = p.get(&pos) {
                return Ok((r.clone(), *len));
            }
        }
        Ok(self.log.read_sized(pos)?)
    }
}

/// The entries a deriver produces, in order.
#[derive(Default)]
pub struct Out {
    pub entries: Vec<(Vec<u8>, Val)>,
}

impl Out {
    pub fn put(&mut self, key: Vec<u8>, value: Vec<u8>) {
        self.entries.push((key, Val::Put(value)));
    }

    pub fn del(&mut self, key: Vec<u8>) {
        self.entries.push((key, Val::Del));
    }

    pub fn add(&mut self, key: Vec<u8>, n: i64) {
        self.entries.push((key, Val::Add(n)));
    }

    pub fn max(&mut self, key: Vec<u8>, n: u64) {
        self.entries.push((key, Val::Max(n)));
    }

    /// Sets slots of the key's map (`Val::Map`).
    pub fn map(&mut self, key: Vec<u8>, pairs: Vec<(u32, u32)>) {
        self.entries.push((key, Val::Map(pairs)));
    }

    /// Applies the entries over `layer`.
    pub fn apply(self, layer: &mut BTreeMap<Vec<u8>, Val>) {
        for (k, v) in self.entries {
            apply(layer, k, v);
        }
    }
}

pub fn apply(layer: &mut BTreeMap<Vec<u8>, Val>, k: Vec<u8>, v: Val) {
    match layer.get_mut(&k) {
        Some(old) => {
            let older = std::mem::replace(old, Val::Del);
            *old = v.over_owned(older);
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
