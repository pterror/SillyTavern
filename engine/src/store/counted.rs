use std::collections::BTreeMap;

use super::StoreError;
use super::derive::{AddMapKind, Out, View, apply};
use super::kinds::key;
use crate::keyspace::Entries;
use crate::keyspace::val::{Val, get_bytes, map_counts, put_bytes};

pub const TREE_EDGE: u64 = 225;
pub const TREE_COUNT: AddMapKind = AddMapKind::new(226);
pub const TREE_KINDS: AddMapKind = AddMapKind::new(227);

pub const WIDTH: usize = 16;
pub type Elem = [u8; WIDTH];

fn corrupt(why: &str) -> StoreError {
    StoreError::Entry(format!("counted tree: {why}"))
}

pub fn elem(order: u64, e: u64) -> Elem {
    let mut x = [0; WIDTH];
    x[..8].copy_from_slice(&order.to_be_bytes());
    x[8..].copy_from_slice(&e.to_be_bytes());
    x
}

pub fn entity_of(x: &Elem) -> u64 {
    u64::from_be_bytes(x[8..].try_into().expect("8 bytes"))
}

pub trait Read {
    fn read(&self, k: &[u8]) -> Result<Option<Vec<u8>>, StoreError>;
    fn read_under(&self, prefix: &[u8]) -> Result<Entries, StoreError>;
}

impl Read for View<'_> {
    fn read(&self, k: &[u8]) -> Result<Option<Vec<u8>>, StoreError> {
        self.get(k)
    }

    fn read_under(&self, prefix: &[u8]) -> Result<Entries, StoreError> {
        self.scan(prefix, &key::prefix_end(prefix), usize::MAX)
    }
}

pub struct Work<'v, 'w> {
    view: &'v View<'w>,
    local: BTreeMap<Vec<u8>, Val>,
    out: Out,
}

impl<'v, 'w> Work<'v, 'w> {
    pub fn new(view: &'v View<'w>) -> Self {
        Work {
            view,
            local: BTreeMap::new(),
            out: Out::default(),
        }
    }

    fn emit(&mut self, k: Vec<u8>, v: Val) {
        apply(&mut self.local, k.clone(), v.clone());
        self.out.push(k, v);
    }

    pub fn put(&mut self, k: Vec<u8>, v: Vec<u8>) {
        self.emit(k, Val::Put(v));
    }

    pub fn del(&mut self, k: Vec<u8>) {
        self.emit(k, Val::Del);
    }

    pub fn add(&mut self, k: Vec<u8>, n: i64) {
        self.emit(k, Val::Add(n));
    }

    fn add_slot(&mut self, k: Vec<u8>, slot: u8, n: i64) {
        if n != 0 {
            self.emit(k, Val::AddMap(vec![(u32::from(slot), n)]));
        }
    }

    pub fn finish(self, out: &mut Out) {
        out.entries.extend(self.out.entries);
    }
}

impl Read for Work<'_, '_> {
    fn read(&self, k: &[u8]) -> Result<Option<Vec<u8>>, StoreError> {
        self.view.with_layer(&self.local).get(k)
    }

    fn read_under(&self, prefix: &[u8]) -> Result<Entries, StoreError> {
        let v = self.view.with_layer(&self.local);
        v.scan(prefix, &key::prefix_end(prefix), usize::MAX)
    }
}

fn node(space: &[u8], p: &[u8]) -> Vec<u8> {
    let mut k = space.to_vec();
    k.push(p.len() as u8);
    k.extend_from_slice(p);
    k
}

fn count_key(space: &[u8], p: &[u8]) -> Vec<u8> {
    let mut k = TREE_COUNT.prefix();
    k.extend_from_slice(&node(space, p));
    k
}

fn kinds_prefix(space: &[u8], p: &[u8]) -> Vec<u8> {
    let mut k = TREE_KINDS.prefix();
    k.extend_from_slice(&node(space, p));
    k
}

fn kinds_key(space: &[u8], p: &[u8], kind: &[u8]) -> Vec<u8> {
    let mut k = kinds_prefix(space, p);
    put_bytes(&mut k, kind);
    k
}

fn edge_key(space: &[u8], p: &[u8], d: u8) -> Vec<u8> {
    let mut k = key::of(TREE_EDGE);
    k.extend_from_slice(&node(space, p));
    k.push(d);
    k
}

fn counts(g: &impl Read, k: &[u8]) -> Result<Vec<(u8, u64)>, StoreError> {
    let Some(b) = g.read(k)? else {
        return Ok(Vec::new());
    };
    map_counts(&b)
        .ok_or_else(|| corrupt("a count map doesn't decode"))?
        .into_iter()
        .map(|(s, n)| {
            u8::try_from(s)
                .map(|d| (d, n))
                .map_err(|_| corrupt("a digit past 255"))
        })
        .collect()
}

fn slot(c: &[(u8, u64)], d: u8) -> u64 {
    c.iter().find(|(s, _)| *s == d).map_or(0, |(_, n)| *n)
}

fn edge(g: &impl Read, space: &[u8], p: &[u8], d: u8) -> Result<Option<Vec<u8>>, StoreError> {
    let Some(q) = g.read(&edge_key(space, p, d))? else {
        return Ok(None);
    };
    if q.len() <= p.len() || q.len() > WIDTH || q[..p.len()] != *p || q[p.len()] != d {
        return Err(corrupt("an edge doesn't extend its node"));
    }
    Ok(Some(q))
}

fn common(a: &[u8], b: &[u8]) -> usize {
    a.iter().zip(b).take_while(|(x, y)| x == y).count()
}

fn bump(w: &mut Work, space: &[u8], p: &[u8], d: u8, kinds: &[Vec<u8>], n: i64) {
    w.add_slot(count_key(space, p), d, n);
    for kind in kinds {
        w.add_slot(kinds_key(space, p, kind), d, n);
    }
}

fn kinds_at(
    g: &impl Read,
    space: &[u8],
    p: &[u8],
    d: u8,
) -> Result<Vec<(Vec<u8>, u64)>, StoreError> {
    let prefix = kinds_prefix(space, p);
    let mut out = Vec::new();
    for (k, v) in g.read_under(&prefix)? {
        let mut at = prefix.len();
        let kind = get_bytes(&k, &mut at).ok_or_else(|| corrupt("a kind key doesn't decode"))?;
        let c: Vec<(u8, u64)> = map_counts(&v)
            .ok_or_else(|| corrupt("a kind map doesn't decode"))?
            .into_iter()
            .filter_map(|(s, n)| u8::try_from(s).ok().map(|s| (s, n)))
            .collect();
        let n = slot(&c, d);
        if n > 0 {
            out.push((kind, n));
        }
    }
    Ok(out)
}

pub fn insert(w: &mut Work, space: &[u8], x: &Elem, kinds: &[Vec<u8>]) -> Result<(), StoreError> {
    let mut p: Vec<u8> = Vec::new();
    loop {
        let d = x[p.len()];
        let Some(q) = edge(w, space, &p, d)? else {
            w.put(edge_key(space, &p, d), x.to_vec());
            bump(w, space, &p, d, kinds, 1);
            return Ok(());
        };
        let c = common(&q, x);
        if c == q.len() {
            if c == WIDTH {
                return Err(corrupt("an element inserted twice"));
            }
            bump(w, space, &p, d, kinds, 1);
            p = q;
            continue;
        }
        let under = slot(&counts(w, &count_key(space, &p))?, d);
        let under_kinds = kinds_at(w, space, &p, d)?;
        let mid = x[..c].to_vec();
        w.put(edge_key(space, &p, d), mid.clone());
        bump(w, space, &p, d, kinds, 1);
        w.put(edge_key(space, &mid, q[c]), q.clone());
        w.add_slot(count_key(space, &mid), q[c], under as i64);
        for (kind, n) in under_kinds {
            w.add_slot(kinds_key(space, &mid, &kind), q[c], n as i64);
        }
        w.put(edge_key(space, &mid, x[c]), x.to_vec());
        bump(w, space, &mid, x[c], kinds, 1);
        return Ok(());
    }
}

type Path = Vec<(Vec<u8>, u8)>;

fn path_to(g: &impl Read, space: &[u8], x: &Elem) -> Result<Option<Path>, StoreError> {
    let mut path = Vec::new();
    let mut p: Vec<u8> = Vec::new();
    loop {
        let d = x[p.len()];
        let Some(q) = edge(g, space, &p, d)? else {
            return Ok(None);
        };
        path.push((p, d));
        if q.as_slice() == x {
            return Ok(Some(path));
        }
        if common(&q, x) < q.len() {
            return Ok(None);
        }
        p = q;
    }
}

pub fn contains(g: &impl Read, space: &[u8], x: &Elem) -> Result<bool, StoreError> {
    Ok(path_to(g, space, x)?.is_some())
}

pub fn remove(w: &mut Work, space: &[u8], x: &Elem, kinds: &[Vec<u8>]) -> Result<(), StoreError> {
    let path =
        path_to(w, space, x)?.ok_or_else(|| corrupt("an element removed that isn't held"))?;
    for (p, d) in &path {
        bump(w, space, p, *d, kinds, -1);
    }
    let (last, d) = path.last().expect("a path has its leaf's edge");
    w.del(edge_key(space, last, *d));
    if last.is_empty() {
        return Ok(());
    }
    let left = counts(w, &count_key(space, last))?;
    let [(only, _)] = left[..] else {
        return Ok(());
    };
    let rest = edge(w, space, last, only)?.ok_or_else(|| corrupt("a counted digit has no edge"))?;
    let (up, ud) = &path[path.len() - 2];
    w.put(edge_key(space, up, *ud), rest);
    w.del(edge_key(space, last, only));
    w.del(count_key(space, last));
    for (k, _) in w.read_under(&kinds_prefix(space, last))? {
        w.del(k);
    }
    Ok(())
}

pub fn add_kind(
    w: &mut Work,
    space: &[u8],
    x: &Elem,
    kind: &[u8],
    n: i64,
) -> Result<(), StoreError> {
    let path =
        path_to(w, space, x)?.ok_or_else(|| corrupt("a kind on an element that isn't held"))?;
    for (p, d) in path {
        w.add_slot(kinds_key(space, &p, kind), d, n);
    }
    Ok(())
}

fn under(
    g: &impl Read,
    space: &[u8],
    p: &[u8],
    kind: Option<&[u8]>,
) -> Result<Vec<(u8, u64)>, StoreError> {
    let mut c = counts(g, &count_key(space, p))?;
    if let Some(kind) = kind {
        let has = counts(g, &kinds_key(space, p, kind))?;
        for (d, n) in &mut c {
            *n = n
                .checked_sub(slot(&has, *d))
                .ok_or_else(|| corrupt("more of a kind than elements"))?;
        }
        c.retain(|(_, n)| *n > 0);
    }
    Ok(c)
}

pub fn size(g: &impl Read, space: &[u8], kind: Option<&[u8]>) -> Result<u64, StoreError> {
    Ok(under(g, space, &[], kind)?.iter().map(|(_, n)| n).sum())
}

pub fn rank(g: &impl Read, space: &[u8], x: &Elem, kind: Option<&[u8]>) -> Result<u64, StoreError> {
    let mut below = 0;
    let mut p: Vec<u8> = Vec::new();
    loop {
        let here = under(g, space, &p, kind)?;
        let d = x[p.len()];
        below += here
            .iter()
            .filter(|(s, _)| *s < d)
            .map(|(_, n)| n)
            .sum::<u64>();
        let Some(q) = edge(g, space, &p, d)? else {
            return Ok(below);
        };
        let c = common(&q, x);
        if c == q.len() {
            if c == WIDTH {
                return Ok(below);
            }
            p = q;
            continue;
        }
        if q[c] < x[c] {
            below += slot(&here, d);
        }
        return Ok(below);
    }
}

pub fn take(
    g: &impl Read,
    space: &[u8],
    kind: Option<&[u8]>,
    skip: u64,
    n: usize,
) -> Result<Vec<Elem>, StoreError> {
    let mut out = Vec::new();
    let mut skip = skip;
    if n > 0 {
        walk(g, space, kind, &[], &mut skip, n, &mut out)?;
    }
    Ok(out)
}

fn walk(
    g: &impl Read,
    space: &[u8],
    kind: Option<&[u8]>,
    p: &[u8],
    skip: &mut u64,
    n: usize,
    out: &mut Vec<Elem>,
) -> Result<(), StoreError> {
    for (d, c) in under(g, space, p, kind)? {
        if out.len() >= n {
            return Ok(());
        }
        if *skip >= c {
            *skip -= c;
            continue;
        }
        let q = edge(g, space, p, d)?.ok_or_else(|| corrupt("a counted digit has no edge"))?;
        if q.len() == WIDTH {
            out.push(q.try_into().expect("an element is its width"));
        } else {
            walk(g, space, kind, &q, skip, n, out)?;
        }
    }
    Ok(())
}
