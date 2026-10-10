//! The token-count cache (build path 5b; design Q-C6): results of tokenizing a text, keyed by the tokenizer's
//! identity and the text's hash, in tables (counts, token ids). Derived entries written without a record: a crash
//! may lose the ones not yet flushed, which only costs tokenizing those texts again. Each table is kept at a cap of
//! entries by evicting the least recently used, a bounded slice at a time.

use std::collections::BTreeMap;

use super::StoreError;
use super::derive::{Out, View};
use super::kinds::key;
use super::library::counter;
use crate::keyspace::val::{get_bytes, get_u64, put_bytes, put_u64};

/// Per (table, identity, hash): `[last used (ms), value bytes]`.
pub const TOKEN_VAL: u64 = 180;
/// Per (table, last used, identity, hash): the order eviction reads, least recently used first.
pub const TOKEN_LRU: u64 = 181;
/// Per table: how many entries it holds.
pub const TOKEN_N: u64 = 182;

/// One result to keep.
pub struct Put {
    pub table: u64,
    pub identity: Vec<u8>,
    pub hash: Vec<u8>,
    pub value: Vec<u8>,
    /// Written over a stored value; otherwise a stored value stays and is only marked used.
    pub replace: bool,
}

fn val_key(table: u64, identity: &[u8], hash: &[u8]) -> Vec<u8> {
    let mut k = key::id(TOKEN_VAL, table);
    put_bytes(&mut k, identity);
    put_bytes(&mut k, hash);
    k
}

fn lru_key(table: u64, used: u64, identity: &[u8], hash: &[u8]) -> Vec<u8> {
    let mut k = key::ids(TOKEN_LRU, table, used);
    put_bytes(&mut k, identity);
    put_bytes(&mut k, hash);
    k
}

fn decode(b: &[u8]) -> Result<(u64, Vec<u8>), StoreError> {
    let mut at = 0;
    let used = get_u64(b, &mut at)
        .ok_or_else(|| StoreError::Entry("a token cache entry doesn't decode".into()))?;
    Ok((used, b[at..].to_vec()))
}

fn encode(used: u64, value: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(value.len() + 9);
    put_u64(&mut v, used);
    v.extend_from_slice(value);
    v
}

/// A stored result: when it was last used, and its value.
pub fn get(
    view: &View,
    table: u64,
    identity: &[u8],
    hash: &[u8],
) -> Result<Option<(u64, Vec<u8>)>, StoreError> {
    view.get(&val_key(table, identity, hash))?
        .map(|b| decode(&b))
        .transpose()
}

/// How many entries a table holds.
pub fn count(view: &View, table: u64) -> Result<u64, StoreError> {
    Ok(counter(view, &key::id(TOKEN_N, table))?.max(0) as u64)
}

/// Keeps results at `now`: a new key is stored; a stored one keeps its value unless `replace`, and is marked used
/// only once it is `granularity` ms or more behind `now`.
pub fn put(
    view: &View,
    out: &mut Out,
    puts: &[Put],
    now: u64,
    granularity: u64,
) -> Result<(), StoreError> {
    // Later puts of a key in the same batch see the earlier ones.
    let mut seen: BTreeMap<Vec<u8>, (u64, Vec<u8>)> = BTreeMap::new();
    for p in puts {
        let k = val_key(p.table, &p.identity, &p.hash);
        let stored = match seen.get(&k) {
            Some(s) => Some(s.clone()),
            None => view.get(&k)?.map(|b| decode(&b)).transpose()?,
        };
        let next = match &stored {
            None => {
                out.add(key::id(TOKEN_N, p.table), 1);
                Some((now, p.value.clone()))
            }
            Some((used, value)) => {
                let fresh = now.saturating_sub(*used) >= granularity;
                match (p.replace && *value != p.value, fresh) {
                    (true, _) => Some((now, p.value.clone())),
                    (false, true) => Some((now, value.clone())),
                    (false, false) => None,
                }
            }
        };
        let Some((used, value)) = next else { continue };
        if let Some((old, _)) = &stored {
            out.del(lru_key(p.table, *old, &p.identity, &p.hash));
        }
        out.put(lru_key(p.table, used, &p.identity, &p.hash), Vec::new());
        out.put(k.clone(), encode(used, &value));
        seen.insert(k, (used, value));
    }
    Ok(())
}

/// Evicts up to `batch` of a table's least recently used entries while it holds more than `cap`; answers whether
/// it still does.
pub fn evict_step(
    view: &View,
    out: &mut Out,
    table: u64,
    cap: u64,
    batch: usize,
) -> Result<bool, StoreError> {
    let n = count(view, table)?;
    if n <= cap {
        return Ok(false);
    }
    let take = ((n - cap) as usize).min(batch);
    let p = key::id(TOKEN_LRU, table);
    let found = view.scan(&p, &key::prefix_end(&p), take)?;
    for (k, _) in &found {
        let mut at = p.len();
        let bad = || StoreError::Entry("a token cache order key doesn't decode".into());
        get_u64(k, &mut at).ok_or_else(bad)?;
        let identity = get_bytes(k, &mut at).ok_or_else(bad)?;
        let hash = get_bytes(k, &mut at).ok_or_else(bad)?;
        out.del(k.clone());
        out.del(val_key(table, &identity, &hash));
    }
    out.add(key::id(TOKEN_N, table), -(found.len() as i64));
    Ok(n - found.len() as u64 > cap)
}
