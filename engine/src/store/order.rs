//! Ordered lists: a counted skip list per list in the keyspace (`docs/design/ordered-lists.md`).
//!
//! A node's height is a function of its id, so it never changes: nothing is rebalanced or renumbered. Places are
//! 1-based; the head is place 0. Costs are expected: O(1) to append, O(log n) to insert elsewhere, remove, rank or
//! select.

use std::collections::BTreeMap;

use super::StoreError;
use super::derive::{Out, View, apply};
use super::kinds::{key, parse_varints, varints};
use crate::keyspace::val::{Val, get_u64, put_u64};

pub const LIST_LINK: u64 = 300;
pub const LIST_HEAD: u64 = 301;
pub const LIST_TAIL: u64 = 302;
pub const LIST_COUNT: u64 = 303;
pub const LIST_GROUPS: u64 = 304;

pub const LEVELS: usize = 32;

/// A list's identity: a space, an id and a group, each fixed width. A tree's openings are one list per group (its
/// greeting's id + 1, or 0 for none); a message's replies are one list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct List {
    space: u64,
    id: u64,
    group: u64,
}

pub const CHILDREN: u64 = 0;
pub const ROOTS: u64 = 1;

impl List {
    pub fn children(parent: u64) -> List {
        List {
            space: CHILDREN,
            id: parent,
            group: 0,
        }
    }

    pub fn roots(tree: u64, group: u64) -> List {
        List {
            space: ROOTS,
            id: tree,
            group,
        }
    }

    pub fn group(self) -> u64 {
        self.group
    }

    fn key(self, structure: u64) -> Vec<u8> {
        let mut k = key::of(structure);
        put_u64(&mut k, self.space);
        put_u64(&mut k, self.id);
        put_u64(&mut k, self.group);
        k
    }

    fn groups_key(self) -> Option<Vec<u8>> {
        (self.space == ROOTS).then(|| self.key(LIST_GROUPS))
    }

    fn link_key(self, x: u64, level: usize) -> Vec<u8> {
        let mut k = self.key(LIST_LINK);
        put_u64(&mut k, x);
        k.push(level as u8);
        k
    }

    fn head_key(self, level: usize) -> Vec<u8> {
        let mut k = self.key(LIST_HEAD);
        k.push(level as u8);
        k
    }

    fn tail_key(self, level: usize) -> Vec<u8> {
        let mut k = self.key(LIST_TAIL);
        k.push(level as u8);
        k
    }

    fn count_key(self) -> Vec<u8> {
        self.key(LIST_COUNT)
    }

    /// The link keys of a node, every level: `[from, to)`.
    pub fn link_range(self, x: u64) -> (Vec<u8>, Vec<u8>) {
        let mut k = self.key(LIST_LINK);
        put_u64(&mut k, x);
        let end = key::prefix_end(&k);
        (k, end)
    }

    /// Every key of the list's own (head, tail, count), for deleting a list whose nodes are all gone.
    pub fn parts_keys(self) -> Vec<Vec<u8>> {
        let mut out = vec![self.count_key()];
        for i in 0..LEVELS {
            out.push(self.head_key(i));
            out.push(self.tail_key(i));
        }
        out
    }
}

fn bad(what: &str) -> StoreError {
    StoreError::Entry(format!("an ordered list's {what} doesn't decode"))
}

fn mix(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// A node has a level above `i` with probability `4^-i`.
pub fn height(x: u64) -> usize {
    (1 + mix(x).trailing_zeros() as usize / 2).min(LEVELS)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum At {
    Head,
    Node(u64),
}

impl At {
    fn height(self) -> usize {
        match self {
            At::Head => LEVELS,
            At::Node(x) => height(x),
        }
    }
}

fn opt(v: u64) -> Option<u64> {
    v.checked_sub(1)
}

fn enc(v: Option<u64>) -> u64 {
    v.map_or(0, |x| x + 1)
}

#[derive(Debug, Clone, Copy)]
struct Link {
    prev: At,
    next: Option<u64>,
    span: u64,
}

/// Reads through what this operation has written so far, and keeps its writes in commit order.
pub struct Writes<'v, 'w> {
    view: &'v View<'w>,
    layer: BTreeMap<Vec<u8>, Val>,
    out: Out,
    #[cfg(test)]
    pub reads: std::cell::Cell<u64>,
}

impl<'v, 'w> Writes<'v, 'w> {
    pub fn new(view: &'v View<'w>) -> Self {
        Writes {
            view,
            layer: BTreeMap::new(),
            out: Out::default(),
            #[cfg(test)]
            reads: std::cell::Cell::new(0),
        }
    }

    fn get(&self, k: &[u8]) -> Result<Option<Vec<u8>>, StoreError> {
        #[cfg(test)]
        self.reads.set(self.reads.get() + 1);
        self.view.with_layer(&self.layer).get(k)
    }

    #[cfg(test)]
    pub fn writes(&self) -> usize {
        self.out.entries.len()
    }

    fn put(&mut self, k: Vec<u8>, v: Vec<u8>) {
        apply(&mut self.layer, k.clone(), Val::Put(v.clone()));
        self.out.put(k, v);
    }

    fn del(&mut self, k: Vec<u8>) {
        apply(&mut self.layer, k.clone(), Val::Del);
        self.out.del(k);
    }

    pub fn finish(self, out: &mut Out) {
        out.entries.extend(self.out.entries);
    }
}

pub trait Read {
    fn read(&self, k: &[u8]) -> Result<Option<Vec<u8>>, StoreError>;
}

impl Read for View<'_> {
    fn read(&self, k: &[u8]) -> Result<Option<Vec<u8>>, StoreError> {
        self.get(k)
    }
}

impl Read for Writes<'_, '_> {
    fn read(&self, k: &[u8]) -> Result<Option<Vec<u8>>, StoreError> {
        self.get(k)
    }
}

fn link(r: &impl Read, list: List, at: At, level: usize) -> Result<Option<Link>, StoreError> {
    match at {
        At::Head => Ok(r
            .read(&list.head_key(level))?
            .map(|b| -> Result<Link, StoreError> {
                let [next, span] = parse_varints::<2>(&b).map_err(|_| bad("head"))?;
                Ok(Link {
                    prev: At::Head,
                    next: opt(next),
                    span,
                })
            })
            .transpose()?),
        At::Node(x) => Ok(r
            .read(&list.link_key(x, level))?
            .map(|b| -> Result<Link, StoreError> {
                let [prev, next, span] = parse_varints::<3>(&b).map_err(|_| bad("link"))?;
                Ok(Link {
                    prev: opt(prev).map_or(At::Head, At::Node),
                    next: opt(next),
                    span,
                })
            })
            .transpose()?),
    }
}

fn put_link(w: &mut Writes, list: List, at: At, level: usize, l: Link) {
    match at {
        At::Head => w.put(list.head_key(level), varints(&[enc(l.next), l.span])),
        At::Node(x) => {
            let prev = match l.prev {
                At::Head => 0,
                At::Node(p) => p + 1,
            };
            w.put(
                list.link_key(x, level),
                varints(&[prev, enc(l.next), l.span]),
            );
        }
    }
}

fn tail(r: &impl Read, list: List, level: usize) -> Result<Option<(u64, u64)>, StoreError> {
    r.read(&list.tail_key(level))?
        .map(|b| {
            parse_varints::<2>(&b)
                .map(|[x, place]| (x, place))
                .map_err(|_| bad("tail"))
        })
        .transpose()
}

pub fn count(r: &impl Read, list: List) -> Result<u64, StoreError> {
    Ok(match r.read(&list.count_key())? {
        Some(b) => parse_varints::<1>(&b).map_err(|_| bad("count"))?[0],
        None => 0,
    })
}

pub fn contains(r: &impl Read, list: List, x: u64) -> Result<bool, StoreError> {
    Ok(r.read(&list.link_key(x, 0))?.is_some())
}

pub fn first(r: &impl Read, list: List) -> Result<Option<u64>, StoreError> {
    Ok(link(r, list, At::Head, 0)?.and_then(|l| l.next))
}

pub fn last(r: &impl Read, list: List) -> Result<Option<u64>, StoreError> {
    Ok(tail(r, list, 0)?.map(|(x, _)| x))
}

pub fn next(r: &impl Read, list: List, x: u64) -> Result<Option<u64>, StoreError> {
    Ok(link(r, list, At::Node(x), 0)?
        .ok_or_else(|| bad("member"))?
        .next)
}

pub fn prev(r: &impl Read, list: List, x: u64) -> Result<Option<u64>, StoreError> {
    Ok(
        match link(r, list, At::Node(x), 0)?
            .ok_or_else(|| bad("member"))?
            .prev
        {
            At::Head => None,
            At::Node(p) => Some(p),
        },
    )
}

/// The distance from the head to `at`, climbing through each node's top level.
fn place_of(r: &impl Read, list: List, mut at: At) -> Result<u64, StoreError> {
    let mut place = 0;
    while let At::Node(x) = at {
        let top = height(x) - 1;
        let l = link(r, list, at, top)?.ok_or_else(|| bad("member"))?;
        let span = link(r, list, l.prev, top)?.ok_or_else(|| bad("link"))?.span;
        place += span;
        at = l.prev;
    }
    Ok(place)
}

/// `x`'s 1-based place in its list.
pub fn place(r: &impl Read, list: List, x: u64) -> Result<u64, StoreError> {
    place_of(r, list, At::Node(x))
}

/// The node at a 1-based place.
pub fn at_place(r: &impl Read, list: List, place: u64) -> Result<Option<u64>, StoreError> {
    if place == 0 {
        return Ok(None);
    }
    let mut at = At::Head;
    let mut pos = 0;
    for level in (0..LEVELS).rev() {
        while let Some(l) = link(r, list, at, level)? {
            match l.next {
                Some(n) if pos + l.span <= place => {
                    pos += l.span;
                    at = At::Node(n);
                }
                _ => break,
            }
        }
        if pos == place {
            return Ok(match at {
                At::Head => None,
                At::Node(x) => Some(x),
            });
        }
    }
    Ok(None)
}

/// Up to `limit` nodes in order, starting with `from`.
pub fn page_from(
    r: &impl Read,
    list: List,
    from: u64,
    limit: usize,
) -> Result<Vec<u64>, StoreError> {
    let mut out = Vec::new();
    let mut cur = Some(from);
    while let Some(x) = cur {
        if out.len() == limit {
            break;
        }
        out.push(x);
        cur = next(r, list, x)?;
    }
    Ok(out)
}

/// For each level, the nearest node at or before `from` that has that level, and its distance to the place just
/// after `from`.
fn predecessors(
    r: &impl Read,
    list: List,
    from: At,
) -> Result<([At; LEVELS], [u64; LEVELS]), StoreError> {
    let mut p = [At::Head; LEVELS];
    let mut d = [0u64; LEVELS];
    let mut cur = from;
    let mut dist = 1;
    for level in 0..LEVELS {
        while cur.height() <= level {
            let top = cur.height() - 1;
            let l = link(r, list, cur, top)?.ok_or_else(|| bad("member"))?;
            dist += link(r, list, l.prev, top)?.ok_or_else(|| bad("link"))?.span;
            cur = l.prev;
        }
        p[level] = cur;
        d[level] = dist;
    }
    Ok((p, d))
}

fn place_after(
    r: &impl Read,
    list: List,
    p: &[At; LEVELS],
    d: &[u64; LEVELS],
) -> Result<u64, StoreError> {
    let top = LEVELS - 1;
    Ok(d[top] + place_of(r, list, p[top])?)
}

/// Where a node goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Where {
    First,
    After(u64),
    Last,
}

fn shift_tails(
    w: &mut Writes,
    list: List,
    from_place: u64,
    by: i64,
    skip: &[bool; LEVELS],
) -> Result<(), StoreError> {
    for (level, &skipped) in skip.iter().enumerate() {
        if skipped {
            continue;
        }
        if let Some((x, place)) = tail(w, list, level)?
            && place >= from_place
        {
            w.put(
                list.tail_key(level),
                varints(&[x, place.saturating_add_signed(by)]),
            );
        }
    }
    Ok(())
}

/// Puts `x`, not yet in the list, where `to` says.
pub fn insert(w: &mut Writes, list: List, x: u64, to: Where) -> Result<(), StoreError> {
    if contains(w, list, x)? {
        return Err(StoreError::Refused(format!("{x} is already in the list")));
    }
    let n = count(w, list)?;
    let h = height(x);
    match to {
        Where::Last => {
            let place = n + 1;
            for level in 0..h {
                let (p, p_place) = match tail(w, list, level)? {
                    Some((t, tp)) => (At::Node(t), tp),
                    None => (At::Head, 0),
                };
                let mut pl = link(w, list, p, level)?.unwrap_or(Link {
                    prev: At::Head,
                    next: None,
                    span: 0,
                });
                pl.next = Some(x);
                pl.span = place - p_place;
                put_link(w, list, p, level, pl);
                put_link(
                    w,
                    list,
                    At::Node(x),
                    level,
                    Link {
                        prev: p,
                        next: None,
                        span: 0,
                    },
                );
                w.put(list.tail_key(level), varints(&[x, place]));
            }
        }
        Where::First | Where::After(_) => {
            let from = match to {
                Where::After(a) => {
                    if !contains(w, list, a)? {
                        return Err(StoreError::Refused(format!("{a} is in another list")));
                    }
                    At::Node(a)
                }
                _ => At::Head,
            };
            let (p, d) = predecessors(w, list, from)?;
            let place = place_after(w, list, &p, &d)?;
            shift_tails(w, list, place, 1, &[false; LEVELS])?;
            for level in 0..LEVELS {
                let pl = link(w, list, p[level], level)?;
                if level < h {
                    let mut pl = pl.unwrap_or(Link {
                        prev: At::Head,
                        next: None,
                        span: 0,
                    });
                    let mine = match pl.next {
                        Some(nx) => {
                            let mut nl =
                                link(w, list, At::Node(nx), level)?.ok_or_else(|| bad("link"))?;
                            nl.prev = At::Node(x);
                            put_link(w, list, At::Node(nx), level, nl);
                            Link {
                                prev: p[level],
                                next: Some(nx),
                                span: pl.span + 1 - d[level],
                            }
                        }
                        None => {
                            w.put(list.tail_key(level), varints(&[x, place]));
                            Link {
                                prev: p[level],
                                next: None,
                                span: 0,
                            }
                        }
                    };
                    pl.next = Some(x);
                    pl.span = d[level];
                    put_link(w, list, p[level], level, pl);
                    put_link(w, list, At::Node(x), level, mine);
                } else if let Some(mut pl) = pl
                    && pl.next.is_some()
                {
                    pl.span += 1;
                    put_link(w, list, p[level], level, pl);
                }
            }
        }
    }
    w.put(list.count_key(), varints(&[n + 1]));
    if n == 0
        && let Some(k) = list.groups_key()
    {
        w.put(k, Vec::new());
    }
    Ok(())
}

/// Takes `x` out of the list.
pub fn remove(w: &mut Writes, list: List, x: u64) -> Result<(), StoreError> {
    let Some(l0) = link(w, list, At::Node(x), 0)? else {
        return Err(StoreError::Refused(format!("{x} isn't in the list")));
    };
    let (p, d) = predecessors(w, list, l0.prev)?;
    let place = place_after(w, list, &p, &d)?;
    let h = height(x);
    let mut tail_set = [false; LEVELS];
    for level in 0..LEVELS {
        let pl = link(w, list, p[level], level)?;
        if level < h {
            let mine = link(w, list, At::Node(x), level)?.ok_or_else(|| bad("link"))?;
            let mut pl = pl.ok_or_else(|| bad("link"))?;
            match mine.next {
                Some(nx) => {
                    let mut nl = link(w, list, At::Node(nx), level)?.ok_or_else(|| bad("link"))?;
                    nl.prev = p[level];
                    put_link(w, list, At::Node(nx), level, nl);
                    pl.next = Some(nx);
                    pl.span = d[level] + mine.span - 1;
                    put_link(w, list, p[level], level, pl);
                }
                None => {
                    match p[level] {
                        At::Head => {
                            w.del(list.head_key(level));
                            w.del(list.tail_key(level));
                        }
                        at => {
                            pl.next = None;
                            pl.span = 0;
                            put_link(w, list, at, level, pl);
                            w.put(
                                list.tail_key(level),
                                varints(&[
                                    match at {
                                        At::Node(t) => t,
                                        At::Head => unreachable!(),
                                    },
                                    place - d[level],
                                ]),
                            );
                        }
                    }
                    tail_set[level] = true;
                }
            }
            w.del(list.link_key(x, level));
        } else if let Some(mut pl) = pl
            && pl.next.is_some()
        {
            pl.span -= 1;
            put_link(w, list, p[level], level, pl);
        }
    }
    shift_tails(w, list, place + 1, -1, &tail_set)?;
    let n = count(w, list)?;
    if n <= 1 {
        w.del(list.count_key());
        if let Some(k) = list.groups_key() {
            w.del(k);
        }
    } else {
        w.put(list.count_key(), varints(&[n - 1]));
    }
    Ok(())
}

/// Every node of a list, in order. For conversions and tests only: it reads the whole list.
pub fn all(r: &impl Read, list: List) -> Result<Vec<u64>, StoreError> {
    match first(r, list)? {
        Some(f) => page_from(r, list, f, usize::MAX),
        None => Ok(Vec::new()),
    }
}

/// The groups a tree's openings are in, ascending.
pub fn root_groups(view: &View, tree: u64) -> Result<Vec<u64>, StoreError> {
    let p = groups_prefix(tree);
    view.scan(&p, &key::prefix_end(&p), usize::MAX)?
        .into_iter()
        .map(|(k, _)| {
            let mut at = p.len();
            get_u64(&k, &mut at).ok_or_else(|| bad("group key"))
        })
        .collect()
}

/// The highest groups a tree's openings are in, descending, at most `limit`.
pub fn last_root_groups(view: &View, tree: u64, limit: usize) -> Result<Vec<u64>, StoreError> {
    let p = groups_prefix(tree);
    view.scan_vals_rev(&p, &key::prefix_end(&p), limit)?
        .into_iter()
        .map(|(k, _)| {
            let mut at = p.len();
            get_u64(&k, &mut at).ok_or_else(|| bad("group key"))
        })
        .collect()
}

fn groups_prefix(tree: u64) -> Vec<u8> {
    let mut k = key::of(LIST_GROUPS);
    put_u64(&mut k, ROOTS);
    put_u64(&mut k, tree);
    k
}

/// A page of the trees with openings in group 0, which the cutover fills: the trees found, and where the next page
/// starts (none at the end).
pub fn trees_with_ungrouped_roots(
    view: &View,
    after: Option<u64>,
    limit: usize,
) -> Result<(Vec<u64>, Option<u64>), StoreError> {
    let mut start = key::of(LIST_GROUPS);
    put_u64(&mut start, ROOTS);
    let end = key::prefix_end(&start);
    if let Some(a) = after {
        put_u64(&mut start, a + 1);
    }
    let found = view.scan(&start, &end, limit + 1)?;
    let next = (found.len() > limit).then_some(());
    let mut trees = Vec::new();
    let mut last = None;
    for (k, _) in found.into_iter().take(limit) {
        let mut at = key::of(LIST_GROUPS).len();
        get_u64(&k, &mut at).ok_or_else(|| bad("group key"))?;
        let tree = get_u64(&k, &mut at).ok_or_else(|| bad("group key"))?;
        let group = get_u64(&k, &mut at).ok_or_else(|| bad("group key"))?;
        if group == 0 {
            trees.push(tree);
        }
        last = Some(tree);
    }
    Ok((trees, next.and(last)))
}

const OLD_CHILD: u64 = 93;
const OLD_ROOT: u64 = 94;

/// One step of the cutover from the keys that ordered a message's children by append time
/// (`OLD_CHILD (parent, time, m)`, `OLD_ROOT (tree, time, m)`), and from the reply count in a message's shape. Each
/// child goes last in its list, so every list keeps the order it had. Answers whether old keys remain.
pub fn conversion_step(view: &View, out: &mut Out, batch: usize) -> Result<bool, StoreError> {
    let start = key::of(OLD_CHILD);
    let end = key::prefix_end(&key::of(OLD_ROOT));
    let found = view.scan(&start, &end, batch + 1)?;
    let more = found.len() > batch;
    let mut w = Writes::new(view);
    let mut shapes = Out::default();
    for (k, _) in found.into_iter().take(batch) {
        let mut at = 0;
        let structure = get_u64(&k, &mut at).ok_or_else(|| bad("old child key"))?;
        let owner = get_u64(&k, &mut at).ok_or_else(|| bad("old child key"))?;
        get_u64(&k, &mut at).ok_or_else(|| bad("old child key"))?;
        let m = get_u64(&k, &mut at).ok_or_else(|| bad("old child key"))?;
        let list = if structure == OLD_CHILD {
            super::chat::shape_add(&mut shapes, owner, -1);
            List::children(owner)
        } else {
            List::roots(owner, 0)
        };
        if !contains(&w, list, m)? {
            insert(&mut w, list, m, Where::Last)?;
        }
        w.del(k);
    }
    w.finish(out);
    out.entries.extend(shapes.entries);
    Ok(more)
}
