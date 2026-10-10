//! Pages of the library list: a sorted or random page of characters and groups under a filter, its total, and
//! a cursor to carry on from.
//!
//! A page is read from the orders of one scope (the whole library, a tag, the tags of which a match carries
//! one, a lorebook), the one holding every match with the fewest entities, merging its (type, fav) parts. A
//! range on the page's own sort key narrows those orders to the range's keys; a range on another key whose
//! entities in the scope are few enough is read whole and sorted instead. Whatever is left is checked per
//! entity under a work cap: past it the page is short and says `more`, with a cursor at the last entity
//! examined.

use std::collections::{BTreeMap, HashMap, HashSet};

use super::StoreError;
use super::books;
use super::derive::View;
use super::kinds::{key, text_value};
use super::library::{
    self, CHARACTER, CHAT_SIZE, CREATED, DATA, FOLDER_TYPE, GROUP, LAST_CHAT, Scope, count_key,
    counter, num_key, order_prefix, parse_uvarint, rand_key, rand_prefix, split_order_key,
};
use crate::keyspace::val::{Val, get_bytes, get_u64, max_value, put_bytes, put_u64};
use crate::log::format::FieldRef;
use crate::search::query::{CheckFn, DocCheck};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Sort {
    /// One of `library::BY_NAME..SORTS`.
    Key {
        sort: u64,
        desc: bool,
    },
    /// Favourites first (desc) or last, then by name.
    Fav {
        desc: bool,
    },
    Random {
        seed: u64,
        desc: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RangeField {
    Created,
    LastChat,
    ChatSize,
    Data,
    /// How many closed folder tags the entity carries.
    ClosedFolders,
    /// Whether the entity carries the tag (0 or 1).
    Tag(u64),
}

#[derive(Debug, Clone, Default)]
pub struct Filter {
    pub characters: bool,
    pub groups: bool,
    pub fav: Option<bool>,
    /// Tags every match carries (a tag merged into one counts as it).
    pub all_tags: Vec<u64>,
    /// Tags of which a match carries one.
    pub any_tags: Vec<u64>,
    pub no_tags: Vec<u64>,
    /// Characters with this lorebook; groups aren't narrowed by it.
    pub world: Option<Vec<u8>>,
    pub ranges: Vec<(RangeField, Option<f64>, Option<f64>)>,
    pub ids: Option<Vec<u64>>,
    pub not_ids: Vec<u64>,
}

#[derive(Debug, Clone)]
pub struct Query {
    pub filter: Filter,
    pub sort: Sort,
    pub offset: u64,
    pub limit: usize,
    pub cursor: Option<Vec<u8>>,
    pub count: bool,
    /// Entities examined at most past the page's own.
    pub cap: u64,
}

#[derive(Debug, Default)]
pub struct Page {
    pub ids: Vec<u64>,
    pub total: Option<u64>,
    pub total_exact: bool,
    pub more: bool,
    pub cursor: Option<Vec<u8>>,
}

/// Count estimates read at most this many entities, in runs of `SAMPLE_RUN`.
pub const SAMPLE_BUDGET: u64 = 10_000;
const SAMPLE_RUN: u64 = 500;
/// A page's ids, whether it stopped at the work cap, and where the next page starts.
type Walked = (Vec<u64>, bool, Option<Vec<u8>>);

/// Entries a stream reads at first, and at most: each read takes twice the one before, so a page reads few
/// past its end and a long walk seeks the runs a few times, not once per window.
const WINDOW: usize = 64;
const WINDOW_MAX: usize = 4096;

/// Member blocks a check holds at most (2 KiB each). Checks read a tag's member block instead of each entity's
/// membership entry while every block of the id space fits, so each block is read once.
const BLOCKS_KEPT: usize = 4096;

/// A filter's bounds on one numeric sort key: a match's value of it lies in [lo, hi].
#[derive(Debug, Clone, Copy, PartialEq)]
struct KeyRange {
    sort: u64,
    lo: Option<f64>,
    hi: Option<f64>,
}

impl KeyRange {
    fn holds(&self, v: Option<f64>) -> bool {
        v.is_some_and(|v| self.lo.is_none_or(|m| v >= m) && self.hi.is_none_or(|m| v <= m))
    }

    /// The keys `[start, end)` of the order part with prefix `p` whose sort keys are in the range (an entity
    /// with no value sorts first, below every number, and is left out).
    fn span(&self, p: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut start = p.to_vec();
        match self.lo {
            Some(lo) => num_key(&mut start, Some(lo)),
            None => start.push(1),
        }
        let end = match self.hi {
            Some(hi) => {
                let mut e = p.to_vec();
                num_key(&mut e, Some(hi));
                key::prefix_end(&e)
            }
            None => key::prefix_end(p),
        };
        (start, end)
    }
}

/// The filter resolved against merges, its ranges as tags and key ranges.
struct Resolved {
    /// Tags to require, fewest carriers first.
    all: Vec<u64>,
    /// Tags of which one is required, most carriers first.
    any: Vec<u64>,
    /// Tags to exclude, most carriers first.
    none: Vec<u64>,
    keys: Vec<KeyRange>,
    /// Bounds on the number of closed folder tags carried.
    folders: Vec<(Option<f64>, Option<f64>)>,
    /// Each tag's sources (itself and the tags merged into it whose carriers haven't moved).
    sources: HashMap<u64, Vec<u64>>,
    /// The lorebook's scopes: the book and the unresolved books resolving as it.
    worlds: Vec<Scope>,
    /// Nothing matches.
    empty: bool,
}

fn push_new(list: &mut Vec<u64>, t: u64) {
    if !list.contains(&t) {
        list.push(t);
    }
}

fn resolve(view: &View, f: &Filter) -> Result<Resolved, StoreError> {
    let mut r = Resolved {
        all: Vec::new(),
        any: Vec::new(),
        none: Vec::new(),
        keys: Vec::new(),
        folders: Vec::new(),
        sources: HashMap::new(),
        worlds: Vec::new(),
        empty: false,
    };
    if let Some(w) = &f.world {
        match library::entity_by_key(view, books::BOOK, w)? {
            Some(b) => {
                for x in books::resolving_as(view, b)? {
                    r.worlds.push(Scope::World(books::scope_bytes(x)));
                }
            }
            None => r.empty = true,
        }
    }
    for t in &f.all_tags {
        match library::resolve_tag(view, *t)? {
            Some(t) => push_new(&mut r.all, t),
            None => r.empty = true,
        }
    }
    for t in &f.any_tags {
        if let Some(t) = library::resolve_tag(view, *t)? {
            push_new(&mut r.any, t);
        }
    }
    if !f.any_tags.is_empty() && r.any.is_empty() {
        r.empty = true;
    }
    for t in &f.no_tags {
        if let Some(t) = library::resolve_tag(view, *t)? {
            push_new(&mut r.none, t);
        }
    }
    for (field, lo, hi) in &f.ranges {
        let (lo, hi) = (lo.filter(|v| !v.is_nan()), hi.filter(|v| !v.is_nan()));
        let sort = match field {
            RangeField::Created => CREATED,
            RangeField::LastChat => LAST_CHAT,
            RangeField::ChatSize => CHAT_SIZE,
            RangeField::Data => DATA,
            RangeField::ClosedFolders => {
                r.folders.push((lo, hi));
                continue;
            }
            RangeField::Tag(t) => {
                // Carrying the tag counts 1, not carrying it 0.
                let held = |v: f64| lo.is_none_or(|m| v >= m) && hi.is_none_or(|m| v <= m);
                match (held(0.0), held(1.0), library::resolve_tag(view, *t)?) {
                    (true, true, _) | (true, false, None) => {}
                    (false, true, Some(t)) => push_new(&mut r.all, t),
                    (true, false, Some(t)) => push_new(&mut r.none, t),
                    (false, _, _) => r.empty = true,
                }
                continue;
            }
        };
        match r.keys.iter_mut().find(|k| k.sort == sort) {
            Some(k) => {
                k.lo = match (k.lo, lo) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    (a, b) => a.or(b),
                };
                k.hi = match (k.hi, hi) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a, b) => a.or(b),
                };
            }
            None => r.keys.push(KeyRange { sort, lo, hi }),
        }
    }
    if r.keys
        .iter()
        .any(|k| matches!((k.lo, k.hi), (Some(a), Some(b)) if a > b))
    {
        r.empty = true;
    }
    let mut sizes = HashMap::new();
    for t in r.all.iter().chain(&r.any).chain(&r.none) {
        if r.sources.contains_key(t) {
            continue;
        }
        let s = library::tag_sources(view, *t)?;
        let mut n = 0;
        for x in &s {
            n += counter(view, &key::id(key::MEMBER_COUNT, *x))?;
        }
        sizes.insert(*t, n);
        r.sources.insert(*t, s);
    }
    r.all.sort_by_key(|t| sizes[t]);
    r.any.sort_by_key(|t| std::cmp::Reverse(sizes[t]));
    r.none.sort_by_key(|t| std::cmp::Reverse(sizes[t]));
    Ok(r)
}

/// What decides whether an entity passes, each fact read only when the filter needs it.
struct Checker<'a> {
    view: &'a View<'a>,
    f: std::sync::Arc<Filter>,
    /// A search's match, checked after everything else.
    search: Option<CheckFn<'a>>,
    r: Resolved,
    folders: HashMap<u64, bool>,
    /// Member blocks read, as bits by place, per (tag, block).
    blocks: HashMap<(u64, u64), Box<[u64; 256]>>,
    use_blocks: bool,
    /// The sort key whose range every entity checked is already in.
    decided: Option<u64>,
}

impl<'a> Checker<'a> {
    fn new(view: &'a View<'a>, f: &Filter) -> Result<Checker<'a>, StoreError> {
        let next = view
            .get(&key::of(key::NEXT_ENTITY))?
            .and_then(|b| max_value(&b))
            .unwrap_or(0);
        Ok(Checker {
            view,
            f: std::sync::Arc::new(f.clone()),
            search: None,
            r: resolve(view, f)?,
            folders: HashMap::new(),
            blocks: HashMap::new(),
            use_blocks: next >> key::MEMBER_BITS < BLOCKS_KEPT as u64,
            decided: None,
        })
    }

    fn closed(&mut self, t: u64) -> Result<bool, StoreError> {
        if let Some(c) = self.folders.get(&t) {
            return Ok(*c);
        }
        let c = self.view.get(&key::id(key::MERGE, t))?.is_none()
            && text_value(self.view, t, &FieldRef::Code(FOLDER_TYPE))?.as_deref()
                == Some(b"CLOSED");
        self.folders.insert(t, c);
        Ok(c)
    }

    /// Whether `e` is one of tag `s`'s own carriers (not through merges).
    fn member(&mut self, s: u64, e: u64) -> Result<bool, StoreError> {
        if self.use_blocks {
            let at = (s, e >> key::MEMBER_BITS);
            if !self.blocks.contains_key(&at) && self.blocks.len() < BLOCKS_KEPT {
                let mut bits = Box::new([0u64; 256]);
                let pairs = self
                    .view
                    .get_val(&key::member_block(s, e))?
                    .and_then(Val::into_pairs)
                    .unwrap_or_default();
                for (p, v) in pairs {
                    if v != 0 && p < 1 << key::MEMBER_BITS {
                        bits[(p / 64) as usize] |= 1 << (p % 64);
                    }
                }
                self.blocks.insert(at, bits);
            }
            if let Some(bits) = self.blocks.get(&at) {
                let p = key::member_slot(e);
                return Ok(bits[(p / 64) as usize] >> (p % 64) & 1 == 1);
            }
        }
        Ok(self.view.get(&key::ids(key::MEMBER, s, e))?.is_some())
    }

    /// Whether `e` carries tag `t` (as resolved: itself, or a tag merged into it whose carriers haven't moved).
    fn carries(&mut self, e: u64, t: u64) -> Result<bool, StoreError> {
        let n = self.r.sources.get(&t).map_or(0, Vec::len);
        for i in 0..n {
            let s = self.r.sources[&t][i];
            if self.member(s, e)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Whether `e`, of type `kind` with fav `fav`, passes everything but the scope it was read from.
    fn passes(&mut self, e: u64, kind: u64, fav: bool) -> Result<bool, StoreError> {
        let f = self.f.clone();
        if self.r.empty || f.not_ids.contains(&e) {
            return Ok(false);
        }
        if let Some(ids) = &f.ids
            && !ids.contains(&e)
        {
            return Ok(false);
        }
        if !(if kind == CHARACTER {
            f.characters
        } else {
            f.groups
        }) || f.fav.is_some_and(|v| v != fav)
        {
            return Ok(false);
        }
        for i in 0..self.r.all.len() {
            if !self.carries(e, self.r.all[i])? {
                return Ok(false);
            }
        }
        if !self.r.any.is_empty() {
            let mut any = false;
            for i in 0..self.r.any.len() {
                if self.carries(e, self.r.any[i])? {
                    any = true;
                    break;
                }
            }
            if !any {
                return Ok(false);
            }
        }
        for i in 0..self.r.none.len() {
            if self.carries(e, self.r.none[i])? {
                return Ok(false);
            }
        }
        if kind == CHARACTER
            && f.world.is_some()
            && !books::link_of(self.view, e)?
                .and_then(|(_, b)| b)
                .is_some_and(|b| self.r.worlds.contains(&Scope::World(books::scope_bytes(b))))
        {
            return Ok(false);
        }
        for i in 0..self.r.keys.len() {
            let k = self.r.keys[i];
            if self.decided == Some(k.sort) {
                continue;
            }
            if !k.holds(library::sort_num(self.view, e, kind, None, k.sort)?) {
                return Ok(false);
            }
        }
        for i in 0..self.r.folders.len() {
            let (lo, hi) = self.r.folders[i];
            let mut n = 0;
            for t in library::tags_of(self.view, e)? {
                if self.closed(t)? {
                    n += 1;
                }
            }
            let n = f64::from(n);
            if lo.is_some_and(|m| n < m) || hi.is_some_and(|m| n > m) {
                return Ok(false);
            }
        }
        match &mut self.search {
            Some(m) => m(e),
            None => Ok(true),
        }
    }

    /// `passes` for an entity whose type and fav aren't known yet.
    fn passes_any(&mut self, e: u64) -> Result<Option<library::State>, StoreError> {
        let Some(st) = library::state(self.view, e)? else {
            return Ok(None);
        };
        Ok(self.passes(e, st.kind, st.fav)?.then_some(st))
    }
}

fn kinds(f: &Filter) -> Vec<u64> {
    let mut k = Vec::new();
    if f.characters {
        k.push(CHARACTER);
    }
    if f.groups {
        k.push(GROUP);
    }
    k
}

fn favs(f: &Filter) -> Vec<bool> {
    match f.fav {
        Some(v) => vec![v],
        None => vec![false, true],
    }
}

/// The scope a read is driven by: of the scopes every match is in, the one with the fewest entities.
struct Driver {
    /// The scope whose numbering a random page or a count sample reads (the whole library when the driver is
    /// several tags' orders).
    scope: Scope,
    /// The scopes whose orders it reads: several for tags of which a match carries one, or a tag whose merges
    /// wait for their folds.
    sources: Vec<Scope>,
    /// Its entities of the filter's types and favs (counted once per source).
    size: i64,
    /// Every tag, lorebook and id condition is decided by the scope: only ranges may be left to check.
    covers: bool,
    /// Matches are exactly the driver's entities of the filter's types and fav: no check needed.
    whole: bool,
    /// What is left to check reads no values: only tags (through member blocks) and listed ids.
    light: bool,
}

fn scope_size(view: &View, sources: &[Scope], f: &Filter) -> Result<i64, StoreError> {
    let mut n = 0;
    for s in sources {
        for k in kinds(f) {
            for fav in favs(f) {
                n += counter(view, &count_key(s, k, fav))?;
            }
        }
    }
    Ok(n)
}

/// The driver; `union` lets several tags' orders drive (not for random pages, which need one numbering).
fn driver(view: &View, f: &Filter, r: &Resolved, union: bool) -> Result<Driver, StoreError> {
    #[derive(PartialEq)]
    enum By {
        All,
        Required,
        AnyOf,
        World,
    }
    let tags = |t: &u64| -> Vec<Scope> { r.sources[t].iter().map(|s| Scope::Tag(*s)).collect() };
    let mut candidates: Vec<(By, Scope, Vec<Scope>)> =
        vec![(By::All, Scope::All, vec![Scope::All])];
    for t in &r.all {
        candidates.push((By::Required, Scope::Tag(*t), tags(t)));
    }
    if r.any.len() == 1 || (union && !r.any.is_empty()) {
        let mut sources = Vec::new();
        for t in &r.any {
            for s in tags(t) {
                if !sources.contains(&s) {
                    sources.push(s);
                }
            }
        }
        let scope = match r.any[..] {
            [t] => Scope::Tag(t),
            _ => Scope::All,
        };
        candidates.push((By::AnyOf, scope, sources));
    }
    if let [w, ..] = &r.worlds[..]
        && !f.groups
        && (r.worlds.len() == 1 || union)
    {
        candidates.push((By::World, w.clone(), r.worlds.clone()));
    }
    let mut best: Option<(By, Scope, Vec<Scope>, i64)> = None;
    for (by, scope, sources) in candidates {
        let n = scope_size(view, &sources, f)?;
        if best.as_ref().is_none_or(|b| n < b.3) {
            best = Some((by, scope, sources, n));
        }
    }
    let (by, scope, sources, size) = best.expect("the whole library is a candidate");
    let world_left = f.world.is_some() && by != By::World;
    let covers = !r.empty
        && r.all.len() == usize::from(by == By::Required)
        && (r.any.is_empty() || by == By::AnyOf)
        && r.none.is_empty()
        && !world_left
        && f.ids.is_none()
        && f.not_ids.is_empty();
    Ok(Driver {
        scope,
        sources,
        size,
        covers,
        whole: covers && r.keys.is_empty() && r.folders.is_empty(),
        light: !world_left && r.keys.is_empty() && r.folders.is_empty(),
    })
}

/// Entities with their types and favs.
type Members = Vec<(u64, u64, bool)>;

/// How a page reads its entities.
enum Read {
    /// The driver's orders, narrowed to a range on the page's sort key when there is one.
    Walk(Option<KeyRange>),
    /// The driver's entities (with types and favs) in a range on another sort key, few enough to read whole;
    /// the range's sort key.
    Set(u64, Members),
}

/// Reads the driver's entities in range `k` with their types and favs, each once; None when more than `most`.
fn range_set(
    view: &View,
    f: &Filter,
    d: &Driver,
    k: &KeyRange,
    most: u64,
) -> Result<Option<Members>, StoreError> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for src in &d.sources {
        for kind in kinds(f) {
            for fav in favs(f) {
                let (mut from, end) = k.span(&order_prefix(src, k.sort, kind, fav));
                loop {
                    let got = view.scan(&from, &end, 256)?;
                    for (_, v) in &got {
                        let e = parse_uvarint(v)?;
                        if seen.insert(e) {
                            out.push((e, kind, fav));
                            if out.len() as u64 > most {
                                return Ok(None);
                            }
                        }
                    }
                    match got.last() {
                        Some((last, _)) if got.len() == 256 => {
                            from = last.clone();
                            from.push(0);
                        }
                        _ => break,
                    }
                }
            }
        }
    }
    Ok(Some(out))
}

/// A range set is read whole when it holds at most √(page · driver) entities (the cheaper of reading and
/// sorting it, and walking the order checking the range), and never more than the work cap. Also the number a
/// lone range's set was found to hold more than (0: not read).
fn plan(view: &View, q: &Query, d: &Driver, r: &Resolved) -> Result<(Read, u64), StoreError> {
    let own = match q.sort {
        Sort::Key { sort, .. } => r.keys.iter().find(|k| k.sort == sort).copied(),
        _ => None,
    };
    if own.is_some() || r.keys.is_empty() {
        return Ok((Read::Walk(own), 0));
    }
    let page = (q.limit as u64).saturating_add(q.offset).max(1);
    let mut most = q.cap.min(page.saturating_mul(d.size.max(0) as u64).isqrt());
    let mut best = None;
    for k in &r.keys {
        if let Some(set) = range_set(view, &q.filter, d, k, most)? {
            most = (set.len() as u64).saturating_sub(1);
            best = Some(Read::Set(k.sort, set));
        }
    }
    let over = if r.keys.len() == 1 { most } else { 0 };
    Ok(match best {
        Some(set) => (set, 0),
        None => (Read::Walk(None), over),
    })
}

// ---- sorted pages ----

/// One (source, type, fav) part of an order, read in the page's direction within `[lo, hi)`.
struct Stream {
    prefix: Vec<u8>,
    lo: Vec<u8>,
    hi: Vec<u8>,
    kind: u64,
    fav: bool,
    /// The fav group this part is in for a fav sort (0 first), else 0.
    group: u8,
    desc: bool,
    /// Where the next read starts (ascending) or ends (descending).
    bound: Vec<u8>,
    buf: std::collections::VecDeque<(Vec<u8>, Vec<u8>, u64)>,
    done: bool,
    window: usize,
}

impl Stream {
    fn fill(&mut self, view: &View, sort: u64) -> Result<(), StoreError> {
        if !self.buf.is_empty() || self.done {
            return Ok(());
        }
        let found = if self.desc {
            view.scan_vals_rev(&self.lo, &self.bound, self.window)?
        } else {
            view.scan_vals(&self.bound, &self.hi, self.window)?
        };
        if found.len() < self.window {
            self.done = true;
        }
        self.window = (self.window * 2).min(WINDOW_MAX);
        if let Some((k, _)) = found.last() {
            self.bound = if self.desc {
                k.clone()
            } else {
                let mut b = k.clone();
                b.push(0);
                b
            };
        }
        for (k, v) in found {
            let (sk, tie) = split_order_key(&k[self.prefix.len()..], sort)
                .ok_or_else(|| StoreError::Entry("an order key doesn't decode".into()))?;
            let e = parse_uvarint(&v.into_bytes())?;
            self.buf.push_back((sk, tie, e));
        }
        Ok(())
    }
}

/// A place in a sorted page's order: fav group, sort key, type, tie.
type Place = (u8, Vec<u8>, u64, Vec<u8>);

/// `a` against `b` in the page's order.
fn place_cmp(a: &Place, b: &Place, desc: bool) -> std::cmp::Ordering {
    a.0.cmp(&b.0).then_with(|| {
        let (x, y) = ((&a.1, a.2, &a.3), (&b.1, b.2, &b.3));
        if desc { y.cmp(&x) } else { x.cmp(&y) }
    })
}

fn encode_place(p: &Place, skip: u64, examined_before: u64) -> Vec<u8> {
    let mut b = vec![0u8];
    b.push(p.0);
    put_u64(&mut b, p.2);
    put_bytes(&mut b, &p.1);
    put_bytes(&mut b, &p.3);
    put_u64(&mut b, skip);
    put_u64(&mut b, examined_before);
    b
}

fn decode_place(b: &[u8]) -> Option<(Place, u64)> {
    if b.first() != Some(&0) {
        return None;
    }
    let g = *b.get(1)?;
    let mut at = 2;
    let kind = get_u64(b, &mut at)?;
    let sk = get_bytes(b, &mut at)?;
    let tie = get_bytes(b, &mut at)?;
    let skip = get_u64(b, &mut at)?;
    get_u64(b, &mut at)?;
    (at == b.len()).then_some(((g, sk, kind, tie), skip))
}

/// Where a part's read starts (ascending) or ends (descending) to take only places after `p` in the page's
/// order.
fn bound_after(s: &Stream, p: &Place) -> Option<Vec<u8>> {
    let (g, sk, kind, tie) = p;
    if s.group != *g {
        // A fav group before the place's is done; one after it is read whole.
        return if s.group < *g {
            None
        } else if s.desc {
            Some(key::prefix_end(&s.prefix))
        } else {
            Some(s.prefix.clone())
        };
    }
    let mut at_key = s.prefix.clone();
    at_key.extend_from_slice(sk);
    // At the place's sort key, an ascending order has finished the types before the place's and not begun the
    // ones after; a descending order the reverse. As a start (ascending) or an end (descending), that is past
    // the key for an earlier type and at it for a later one.
    Some(match (s.kind.cmp(kind), s.desc) {
        (std::cmp::Ordering::Equal, false) => {
            put_bytes(&mut at_key, tie);
            at_key.push(0);
            at_key
        }
        (std::cmp::Ordering::Equal, true) => {
            put_bytes(&mut at_key, tie);
            at_key
        }
        (std::cmp::Ordering::Less, _) => key::prefix_end(&at_key),
        (std::cmp::Ordering::Greater, _) => at_key,
    })
}

/// The page's sort key, direction and, for a fav sort, whether favourites come first.
fn page_sort(q: &Query) -> (u64, bool, Option<bool>) {
    match q.sort {
        Sort::Key { sort, desc } => (sort, desc, None),
        Sort::Fav { desc } => (library::BY_NAME, false, Some(desc)),
        Sort::Random { .. } => unreachable!("a random page has no sort key"),
    }
}

/// A sorted page walked from the driver's orders; with the total when the walk read them to their end from the
/// start.
fn sorted_page(
    view: &View,
    q: &Query,
    d: &Driver,
    chk: &mut Checker,
    range: Option<KeyRange>,
) -> Result<(Walked, Option<u64>), StoreError> {
    let (sort, desc, fav_sort) = page_sort(q);
    let at = q.cursor.as_deref().and_then(decode_place);
    let mut streams = Vec::new();
    for src in &d.sources {
        for kind in kinds(&q.filter) {
            for fav in favs(&q.filter) {
                let group = match fav_sort {
                    Some(fav_first) => u8::from(fav != fav_first),
                    None => 0,
                };
                let prefix = order_prefix(src, sort, kind, fav);
                let (lo, hi) = match &range {
                    Some(k) => k.span(&prefix),
                    None => (prefix.clone(), key::prefix_end(&prefix)),
                };
                let mut s = Stream {
                    bound: if desc { hi.clone() } else { lo.clone() },
                    prefix,
                    lo,
                    hi,
                    kind,
                    fav,
                    group,
                    desc,
                    buf: Default::default(),
                    done: false,
                    window: WINDOW,
                };
                if let Some((p, _)) = &at {
                    match bound_after(&s, p) {
                        Some(b) if desc => s.bound = b.min(s.hi.clone()),
                        Some(b) => s.bound = b.max(s.lo.clone()),
                        None => s.done = true,
                    }
                }
                if (desc && s.bound <= s.lo) || (!desc && s.bound >= s.hi) {
                    s.done = true;
                }
                streams.push(s);
            }
        }
    }
    let mut skip = at.as_ref().map_or(q.offset, |(_, s)| *s);
    let budget = q.cap + skip + q.limit as u64;
    let mut ids = Vec::new();
    let mut examined = 0u64;
    let mut passed = 0u64;
    let mut last: Option<Place> = at.as_ref().map(|(p, _)| p.clone());
    let mut last_entity = None;
    let check_all = !d.whole;
    loop {
        if ids.len() >= q.limit {
            break;
        }
        if examined >= budget {
            let cursor = last.as_ref().map(|p| encode_place(p, skip, 0));
            return Ok(((ids, true, cursor), None));
        }
        let mut best: Option<usize> = None;
        for i in 0..streams.len() {
            streams[i].fill(view, sort)?;
            let Some(head) = streams[i].buf.front() else {
                continue;
            };
            let better = match best {
                None => true,
                Some(b) => {
                    let o = &streams[b];
                    let bh = o.buf.front().unwrap();
                    let mine = (streams[i].group, &head.0, streams[i].kind, &head.1);
                    let theirs = (o.group, &bh.0, o.kind, &bh.1);
                    let c = if mine.0 != theirs.0 {
                        mine.0.cmp(&theirs.0)
                    } else if desc {
                        theirs.cmp(&mine)
                    } else {
                        mine.cmp(&theirs)
                    };
                    c == std::cmp::Ordering::Less
                }
            };
            if better {
                best = Some(i);
            }
        }
        let Some(b) = best else {
            let total = at.is_none().then_some(passed);
            return Ok(((ids, false, None), total));
        };
        let (sk, tie, e) = streams[b].buf.pop_front().unwrap();
        let (kind, fav) = (streams[b].kind, streams[b].fav);
        let place = (streams[b].group, sk, kind, tie);
        examined += 1;
        last = Some(place);
        // The same entity from two tags' orders comes twice in a row.
        if last_entity == Some(e) {
            continue;
        }
        last_entity = Some(e);
        if check_all && !chk.passes(e, kind, fav)? {
            continue;
        }
        passed += 1;
        if skip > 0 {
            skip -= 1;
            continue;
        }
        ids.push(e);
    }
    let cursor = (!ids.is_empty())
        .then(|| last.as_ref().map(|p| encode_place(p, 0, 0)))
        .flatten();
    Ok(((ids, false, cursor), None))
}

/// A sorted page of rows read whole: sorted, then taken after the cursor's place (or the offset).
fn rows_page(q: &Query, mut rows: Vec<(Place, u64)>) -> Walked {
    let (_, desc, _) = page_sort(q);
    rows.sort_by(|a, b| place_cmp(&a.0, &b.0, desc));
    let (after, skip) = match q.cursor.as_deref().and_then(decode_place) {
        Some((p, skip)) => (
            rows.partition_point(|r| place_cmp(&r.0, &p, desc) != std::cmp::Ordering::Greater),
            skip,
        ),
        None => (0, q.offset),
    };
    let start = after.saturating_add(skip as usize).min(rows.len());
    let end = start.saturating_add(q.limit).min(rows.len());
    let cursor = (end - start == q.limit && end > start && end < rows.len())
        .then(|| encode_place(&rows[end - 1].0, 0, 0));
    (
        rows[start..end].iter().map(|r| r.1).collect(),
        false,
        cursor,
    )
}

/// A sorted page of a range set: each entity checked and placed.
fn set_page(
    view: &View,
    q: &Query,
    chk: &mut Checker,
    set: &[(u64, u64, bool)],
) -> Result<(Walked, Option<u64>), StoreError> {
    let (sort, _, fav_first) = page_sort(q);
    let mut rows = Vec::new();
    for &(e, kind, fav) in set {
        if !chk.passes(e, kind, fav)? {
            continue;
        }
        let Some((_, sk, tie)) = library::sort_place(view, e, sort)? else {
            continue;
        };
        let group = fav_first.map_or(0, |f| u8::from(fav != f));
        rows.push(((group, sk, kind, tie), e));
    }
    let total = rows.len() as u64;
    Ok((rows_page(q, rows), Some(total)))
}

/// A sorted page of a listed set of ids: each looked up, sorted in memory (the list bounds the work).
fn ids_page(q: &Query, chk: &mut Checker) -> Result<Walked, StoreError> {
    let (sort, _, fav_first) = page_sort(q);
    let mut rows: Vec<(Place, u64)> = Vec::new();
    let mut seen = HashSet::new();
    for e in q.filter.ids.as_ref().unwrap() {
        if !seen.insert(*e) {
            continue;
        }
        // Only what the filter and the sort read: not the entity's whole state.
        let Some((kind, _, _)) = library::entity_info(chk.view, *e)? else {
            continue;
        };
        if kind != CHARACTER && kind != GROUP {
            continue;
        }
        let fav = library::fav_of(chk.view, *e)?;
        if !chk.passes(*e, kind, fav)? {
            continue;
        }
        let Some((_, sk, tie)) = library::sort_place(chk.view, *e, sort)? else {
            continue;
        };
        let group = fav_first.map_or(0, |f| u8::from(fav != f));
        rows.push(((group, sk, kind, tie), *e));
    }
    Ok(rows_page(q, rows))
}

// ---- one entity ----

/// A stored value: a text, or JSON text (empty: a marker).
#[derive(Debug, Clone, PartialEq)]
pub enum Stored {
    Text(Vec<u8>),
    Json(Vec<u8>),
}

/// Everything an entity holds.
#[derive(Debug, Clone, Default)]
pub struct Entity {
    pub id: u64,
    pub kind: u64,
    pub key: Vec<u8>,
    pub added: i64,
    pub version: u64,
    pub fav: bool,
    /// Tags as they are now (merged tags as their targets; tags merged into none left out), in id order.
    pub tags: Vec<u64>,
    /// Field values; a list item's text under its item field.
    pub values: Vec<(FieldRef, Stored)>,
    /// List items in order: (list, item, position).
    pub items: Vec<(u64, u64, u64)>,
    pub data_size: Option<u64>,
    pub create_ms: Option<f64>,
    pub hashes: Vec<(u64, Vec<u8>)>,
    /// A tag's `tagOrder`: None without one, Some(None) for one holding no order.
    pub tag_order: Option<Option<f64>>,
    /// A character's lorebook link: the book it names, and the key and version of the book that resolves as.
    pub link: Option<(u64, Vec<u8>, u64)>,
    /// An entry's recorded `entryIndex`.
    pub entry_index: Option<f64>,
}

/// The tags an entity carries as they are now (`Entity::tags`).
pub fn tags_now(view: &View, e: u64) -> Result<Vec<u64>, StoreError> {
    let mut out = Vec::new();
    for t in library::tags_of(view, e)? {
        if let Some(t) = library::resolve_tag(view, t)?
            && !out.contains(&t)
        {
            out.push(t);
        }
    }
    out.sort_unstable();
    Ok(out)
}

pub fn entity(view: &View, e: u64) -> Result<Option<Entity>, StoreError> {
    let Some((kind, k, added)) = library::entity_info(view, e)? else {
        return Ok(None);
    };
    let mut out = Entity {
        id: e,
        kind,
        key: k,
        added,
        ..Entity::default()
    };
    out.version = view
        .get(&key::id(key::VERSION, e))?
        .map(|b| super::kinds::parse_pos(&b))
        .transpose()?
        .unwrap_or(0);
    out.fav = library::fav_of(view, e)?;
    if let Some(b) = view.get(&key::id(key::TAG_ORDER_REC, e))? {
        let (r, _) = view.record(super::kinds::parse_loc(&b)?.pos)?;
        out.tag_order = Some(match r.values.get(1) {
            Some(crate::log::format::Value::F64(v)) => Some(*v),
            _ => None,
        });
    }
    out.tags = tags_now(view, e)?;
    if kind == library::CHARACTER
        && let Some((_, Some(b))) = books::link_of(view, e)?
    {
        let r = books::resolve(view, b)?;
        let k = library::entity_info(view, r)?
            .map(|(_, k, _)| k)
            .unwrap_or_default();
        let version = view
            .get(&key::id(key::VERSION, r))?
            .map(|b| super::kinds::parse_pos(&b))
            .transpose()?
            .unwrap_or(0);
        out.link = Some((b, k, version));
    }
    if kind == books::ENTRY {
        out.entry_index = books::entry_index(view, e)?;
    }
    let tp = key::id(key::TEXT, e);
    for (tk, _) in view.scan(&tp, &key::prefix_end(&tp), usize::MAX)? {
        let f = library::field_after(&tk, key::TEXT)?;
        if let Some(t) = text_value(view, e, &f)? {
            out.values.push((f, Stored::Text(t)));
        }
    }
    let vp = key::id(key::VALUE, e);
    for (vk, v) in view.scan(&vp, &key::prefix_end(&vp), usize::MAX)? {
        let f = library::field_after(&vk, key::VALUE)?;
        let (rec, _) = view.record(super::kinds::parse_loc(&v)?.pos)?;
        out.values
            .push((f, Stored::Json(super::kinds::bytes(&rec, 2).to_vec())));
    }
    let ip = key::id(key::ITEM, e);
    // A book's entries are read by place (`books::entries_page`), not with its values.
    let from = if kind == super::books::BOOK || kind == super::books::OWNED {
        key::ids(key::ITEM, e, super::books::ENTRIES + 1)
    } else {
        ip.clone()
    };
    for (ik, v) in view.scan(&from, &key::prefix_end(&ip), usize::MAX)? {
        let mut at = ip.len();
        let bad = || StoreError::Entry("an item key doesn't decode".into());
        let list = get_u64(&ik, &mut at).ok_or_else(bad)?;
        let position = get_u64(&ik, &mut at).ok_or_else(bad)?;
        out.items.push((list, parse_uvarint(&v)?, position));
    }
    for s in [key::DATA_SIZE, key::CREATE_DATE] {
        let Some(b) = view.get(&key::id(s, e))? else {
            continue;
        };
        let (r, _) = view.record(super::kinds::parse_loc(&b)?.pos)?;
        match &r.values[1] {
            crate::log::format::Value::UInt(n) => out.data_size = Some(*n),
            crate::log::format::Value::F64(x) => out.create_ms = Some(*x),
            _ => {}
        }
    }
    let hp = key::id(key::HASH, e);
    for (_, v) in view.scan(&hp, &key::prefix_end(&hp), usize::MAX)? {
        let (r, _) = view.record(super::kinds::parse_loc(&v)?.pos)?;
        if let crate::log::format::Value::Bytes(h) = &r.values[2] {
            out.hashes.push((super::kinds::id(&r, 1), h.clone()));
        }
    }
    Ok(Some(out))
}

/// The entities a hash of kind `which` finds, at most `limit`.
pub fn by_hash(view: &View, which: u64, hash: &[u8], limit: usize) -> Result<Vec<u64>, StoreError> {
    let p = library::hash_index_prefix(which, hash);
    view.scan(&p, &key::prefix_end(&p), limit)?
        .into_iter()
        .map(|(k, _)| {
            let mut at = p.len();
            get_u64(&k, &mut at)
                .ok_or_else(|| StoreError::Entry("a hash key doesn't decode".into()))
        })
        .collect()
}

/// The entities both hashes find, at most `limit`: each list read from the other's last entity on, so the reads
/// follow the shorter one.
pub fn by_hashes(
    view: &View,
    a: (u64, &[u8]),
    b: (u64, &[u8]),
    limit: usize,
) -> Result<Vec<u64>, StoreError> {
    let first_from = |which: u64, hash: &[u8], from: u64| -> Result<Option<u64>, StoreError> {
        let p = library::hash_index_prefix(which, hash);
        let mut start = p.clone();
        put_u64(&mut start, from);
        let Some((k, _)) = view
            .scan(&start, &key::prefix_end(&p), 1)?
            .into_iter()
            .next()
        else {
            return Ok(None);
        };
        let mut at = p.len();
        get_u64(&k, &mut at)
            .map(Some)
            .ok_or_else(|| StoreError::Entry("a hash key doesn't decode".into()))
    };
    let mut out = Vec::new();
    let mut from = 0;
    while out.len() < limit {
        let Some(x) = first_from(a.0, a.1, from)? else {
            break;
        };
        let Some(y) = first_from(b.0, b.1, x)? else {
            break;
        };
        if x == y {
            out.push(x);
            from = x + 1;
        } else {
            from = y;
        }
    }
    Ok(out)
}

// ---- random pages ----

fn mix64(x: u64) -> u64 {
    let mut z = x;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^ (z >> 31)
}

fn hash_text(t: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in t {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// The key of a space's random order under a seed.
pub fn order_key(seed: u64, space: &[u8]) -> u64 {
    mix64(seed ^ mix64(hash_text(space)))
}

const ROUNDS: u32 = 6;

fn domain_bits(n: u64) -> u32 {
    let mut m = 2;
    while (1u64 << m) < n {
        m += 1;
    }
    m
}

fn round_value(key: u64, round: u32, half: u64, bits: u32) -> u64 {
    mix64(key ^ (u64::from(round) << 56) ^ half) & ((1u64 << bits) - 1)
}

fn feistel(x: u64, m: u32, key: u64) -> u64 {
    let (mut a, mut b) = (m.div_ceil(2), m / 2);
    let (mut left, mut right) = (x >> b, x & ((1u64 << b) - 1));
    for round in 0..ROUNDS {
        let next = left ^ round_value(key, round, right, a);
        left = right;
        right = next & ((1u64 << a) - 1);
        std::mem::swap(&mut a, &mut b);
    }
    (left << b) | right
}

fn feistel_inverse(y: u64, m: u32, key: u64) -> u64 {
    let (mut a, mut b) = (m.div_ceil(2), m / 2);
    let (mut left, mut right) = (y >> b, y & ((1u64 << b) - 1));
    for round in (0..ROUNDS).rev() {
        std::mem::swap(&mut a, &mut b);
        let original_right = left;
        let original_left = right ^ round_value(key, round, original_right, a);
        left = original_left & ((1u64 << a) - 1);
        right = original_right;
    }
    (left << b) | right
}

/// The rank shown at position `i` of `n`.
pub fn permute(i: u64, n: u64, key: u64) -> u64 {
    if n <= 1 {
        return 0;
    }
    let m = domain_bits(n);
    let mut x = feistel(i, m, key);
    while x >= n {
        x = feistel(x, m, key);
    }
    x
}

/// The position rank `r` is shown at.
pub fn unpermute(r: u64, n: u64, key: u64) -> u64 {
    if n <= 1 {
        return 0;
    }
    let m = domain_bits(n);
    let mut x = feistel_inverse(r, m, key);
    while x >= n {
        x = feistel_inverse(x, m, key);
    }
    x
}

fn space_name(s: &Scope) -> Vec<u8> {
    match s {
        Scope::All => b"all".to_vec(),
        Scope::Tag(t) => format!("tag:{t}").into_bytes(),
        Scope::World(w) => {
            let mut n = b"world:".to_vec();
            n.extend_from_slice(w);
            n
        }
    }
}

/// An entity of a numbering: the entity, its type and its fav.
type Numbered = (u64, u64, bool);

/// A scope's numbering seen as one: its (type, fav) parts in order, each with its size.
struct Numbering {
    scope: Scope,
    parts: Vec<(u64, bool, u64)>,
    n: u64,
}

impl Numbering {
    fn new(view: &View, scope: &Scope, f: &Filter) -> Result<Numbering, StoreError> {
        let mut parts = Vec::new();
        let mut n = 0;
        for k in kinds(f) {
            for fav in favs(f) {
                let size = counter(view, &count_key(scope, k, fav))?.max(0) as u64;
                parts.push((k, fav, size));
                n += size;
            }
        }
        Ok(Numbering {
            scope: scope.clone(),
            parts,
            n,
        })
    }

    /// The entity numbered at each of `ranks` (none past the end), with its type and fav, read together.
    fn at_many(&self, view: &View, ranks: &[u64]) -> Result<Vec<Option<Numbered>>, StoreError> {
        let mut keys = Vec::with_capacity(ranks.len());
        let mut parts = Vec::with_capacity(ranks.len());
        for &rank in ranks {
            let mut r = rank;
            let mut found = None;
            for (k, fav, size) in &self.parts {
                if r < *size {
                    found = Some((*k, *fav, r));
                    break;
                }
                r -= size;
            }
            match found {
                Some((k, fav, r)) => {
                    keys.push(rand_key(&self.scope, k, fav, r));
                    parts.push(Some((k, fav)));
                }
                None => {
                    keys.push(Vec::new());
                    parts.push(None);
                }
            }
        }
        let vals = view.get_many(&keys)?;
        vals.into_iter()
            .zip(parts)
            .map(|(v, part)| match (v, part) {
                (Some(b), Some((k, fav))) => Ok(Some((parse_uvarint(&b)?, k, fav))),
                _ => Ok(None),
            })
            .collect()
    }

    /// The entities numbered `from..from + len` of the whole numbering, in order: (number, entity, type, fav).
    fn range(
        &self,
        view: &View,
        from: u64,
        len: u64,
    ) -> Result<Vec<(u64, u64, u64, bool)>, StoreError> {
        let mut out = Vec::new();
        let (mut r, mut left, mut off) = (from, len, 0);
        for (k, fav, size) in &self.parts {
            if left == 0 {
                break;
            }
            if r >= *size {
                r -= size;
                off += size;
                continue;
            }
            let take = left.min(size - r);
            let p = rand_prefix(&self.scope, *k, *fav);
            for (rk, v) in view.scan(
                &rand_key(&self.scope, *k, *fav, r),
                &key::prefix_end(&p),
                take as usize,
            )? {
                let mut at = p.len();
                let number = get_u64(&rk, &mut at)
                    .ok_or_else(|| StoreError::Entry("a numbering key doesn't decode".into()))?;
                out.push((off + number, parse_uvarint(&v)?, *k, *fav));
            }
            left -= take;
            r = 0;
            off += size;
        }
        Ok(out)
    }

    fn rank_of(
        &self,
        view: &View,
        e: u64,
        kind: u64,
        fav: bool,
    ) -> Result<Option<u64>, StoreError> {
        let mut off = 0;
        for (k, f, size) in &self.parts {
            if *k == kind && *f == fav {
                let mut ak = key::of(key::RAND_AT);
                self.scope.put(&mut ak);
                put_u64(&mut ak, e);
                return Ok(match view.get(&ak)? {
                    Some(b) => Some(off + parse_uvarint(&b)?),
                    None => None,
                });
            }
            off += size;
        }
        Ok(None)
    }
}

fn encode_position(p: u64, skip: u64) -> Vec<u8> {
    let mut b = vec![1u8];
    put_u64(&mut b, p);
    put_u64(&mut b, skip);
    b
}

fn decode_position(b: &[u8]) -> Option<(u64, u64)> {
    if b.first() != Some(&1) {
        return None;
    }
    let mut at = 1;
    let p = get_u64(b, &mut at)?;
    let s = get_u64(b, &mut at)?;
    (at == b.len()).then_some((p, s))
}

/// A random page; with the total when it read every match.
fn random_page(
    view: &View,
    q: &Query,
    d: &Driver,
    chk: &mut Checker,
    read: &Read,
    seed: u64,
    desc: bool,
) -> Result<(Walked, Option<u64>), StoreError> {
    // Several sources have no one numbering: the whole library's is walked.
    let (scope, whole) = if d.sources.len() == 1 {
        (d.scope.clone(), d.whole)
    } else {
        (Scope::All, false)
    };
    let num = Numbering::new(view, &scope, &q.filter)?;
    let k = order_key(seed, &space_name(&scope));
    let n = num.n;
    let at = q.cursor.as_deref().and_then(decode_position);
    let rank = |j: u64| permute(if desc { n - 1 - j } else { j }, n, k);
    let place = |r: u64| {
        let pos = unpermute(r, n, k);
        if desc { n - 1 - pos } else { pos }
    };
    // A set read whole, each match placed where the permutation shows it: listed ids, a range set, or a numbering
    // no larger than the work cap whose checks read no values (cheaper read in order than a get per place).
    let mut shown = None;
    if let Some(ids) = &q.filter.ids {
        let mut s = Vec::new();
        let mut seen = HashSet::new();
        for e in ids {
            if !seen.insert(*e) {
                continue;
            }
            if let Some(st) = chk.passes_any(*e)?
                && let Some(r) = num.rank_of(view, *e, st.kind, st.fav)?
            {
                s.push((place(r), *e));
            }
        }
        shown = Some(s);
    } else if let Read::Set(_, set) = read {
        let mut s = Vec::new();
        for &(e, kind, fav) in set {
            if chk.passes(e, kind, fav)?
                && let Some(r) = num.rank_of(view, e, kind, fav)?
            {
                s.push((place(r), e));
            }
        }
        shown = Some(s);
    } else if !whole && d.light && n <= q.cap {
        let mut s = Vec::new();
        for (r, e, kind, fav) in num.range(view, 0, n)? {
            if chk.passes(e, kind, fav)? {
                s.push((place(r), e));
            }
        }
        shown = Some(s);
    }
    if let Some(mut shown) = shown {
        shown.sort_unstable();
        let (from, skip) = at.unwrap_or((0, q.offset));
        let start = shown
            .partition_point(|x| x.0 < from)
            .saturating_add(skip as usize)
            .min(shown.len());
        let end = start.saturating_add(q.limit).min(shown.len());
        let cursor = (end - start == q.limit && end > start && end < shown.len())
            .then(|| encode_position(shown[end - 1].0 + 1, 0));
        let ids = shown[start..end].iter().map(|x| x.1).collect();
        return Ok(((ids, false, cursor), Some(shown.len() as u64)));
    }
    if whole {
        let start = at.map_or(q.offset, |(p, _)| p);
        let end = n.min(start + q.limit as u64);
        let ranks: Vec<u64> = (start..end).map(rank).collect();
        let ids = num
            .at_many(view, &ranks)?
            .into_iter()
            .flatten()
            .map(|(e, _, _)| e)
            .collect();
        let cursor = (end - start.min(end) == q.limit as u64).then(|| encode_position(end, 0));
        return Ok(((ids, false, cursor), None));
    }
    let (mut j, mut skip) = at.unwrap_or((0, q.offset));
    let mut examined = 0;
    let mut passed = 0;
    let mut ids = Vec::new();
    // The places are read in windows doubling up to WINDOW_MAX, each read together.
    let mut window = WINDOW as u64;
    let budget = q.cap + q.limit as u64;
    'walk: while ids.len() < q.limit && j < n && examined < budget {
        let w = window.min(n - j).min(budget - examined);
        window = (window * 2).min(WINDOW_MAX as u64);
        let ranks: Vec<u64> = (j..j + w).map(rank).collect();
        for at in num.at_many(view, &ranks)? {
            j += 1;
            examined += 1;
            let Some((e, kind, fav)) = at else { continue };
            if !chk.passes(e, kind, fav)? {
                continue;
            }
            passed += 1;
            if skip > 0 {
                skip -= 1;
                continue;
            }
            ids.push(e);
            if ids.len() == q.limit {
                break 'walk;
            }
        }
    }
    let more = ids.len() < q.limit && j < n;
    let full = ids.len() == q.limit && j < n;
    let total = (j >= n && at.is_none()).then_some(passed);
    Ok((
        (ids, more, (more || full).then(|| encode_position(j, skip))),
        total,
    ))
}

// ---- totals ----

/// The page's total; `range_over`: a number the lone range's set is known to hold more than.
fn total(
    view: &View,
    q: &Query,
    d: &Driver,
    chk: &mut Checker,
    range_over: u64,
) -> Result<(u64, bool), StoreError> {
    if chk.r.empty {
        return Ok((0, true));
    }
    if let Some(ids) = &q.filter.ids {
        let mut n = 0;
        let mut seen = HashSet::new();
        for e in ids {
            if seen.insert(*e) && chk.passes_any(*e)?.is_some() {
                n += 1;
            }
        }
        return Ok((n, true));
    }
    if d.whole {
        let n = scope_size(view, &d.sources, &q.filter)?.max(0) as u64;
        return Ok((n, d.sources.len() == 1));
    }
    let r = &chk.r;
    // One range left: its entries in the driver's orders, when few enough to count.
    if d.covers
        && r.folders.is_empty()
        && range_over < SAMPLE_BUDGET
        && let [k] = r.keys[..]
        && let Some(set) = range_set(view, &q.filter, d, &k, SAMPLE_BUDGET)?
    {
        return Ok((set.len() as u64, true));
    }
    // One tag excluded from the whole library: the library's count less the tag's.
    if d.sources == [Scope::All]
        && r.all.is_empty()
        && r.any.is_empty()
        && r.keys.is_empty()
        && r.folders.is_empty()
        && q.filter.world.is_none()
        && q.filter.not_ids.is_empty()
        && let [x] = r.none[..]
        && let [s] = r.sources[&x][..]
    {
        let n = d.size - scope_size(view, &[Scope::Tag(s)], &q.filter)?;
        return Ok((n.max(0) as u64, true));
    }
    // Only listed ids are left out beyond the scope: the scope's count less each of them that would match.
    let mut rest = q.filter.clone();
    rest.not_ids.clear();
    let rest_d = driver(view, &rest, &resolve(view, &rest)?, true)?;
    if rest_d.whole && rest_d.sources.len() == 1 {
        let mut n = rest_d.size.max(0);
        let mut c = Checker::new(view, &rest)?;
        let mut seen = HashSet::new();
        for e in &q.filter.not_ids {
            if seen.insert(*e) && c.passes_any(*e)?.is_some() {
                n -= 1;
            }
        }
        return Ok((n.max(0) as u64, true));
    }
    // One range left on a sort key, over one scope's orders: its keys there, estimated from the runs' indexes.
    if d.covers
        && r.folders.is_empty()
        && let [k] = r.keys[..]
        && let [src] = &d.sources[..]
    {
        let mut n = 0.0;
        for kind in kinds(&q.filter) {
            for fav in favs(&q.filter) {
                let (lo, hi) = k.span(&order_prefix(src, k.sort, kind, fav));
                n += view.estimate(&lo, &hi)?;
            }
        }
        return Ok((n.round() as u64, false));
    }
    // Estimated from runs of the driving scope's numbering at random places; exact when they cover it.
    let scope = if d.sources.len() == 1 {
        d.scope.clone()
    } else {
        Scope::All
    };
    let num = Numbering::new(view, &scope, &q.filter)?;
    let n = num.n;
    if n == 0 {
        return Ok((0, true));
    }
    let mut sample = Vec::new();
    if n <= SAMPLE_BUDGET {
        sample = num.range(view, 0, n)?;
    } else {
        let mut starts = BTreeMap::new();
        let runs = SAMPLE_BUDGET / SAMPLE_RUN;
        let key = order_key(n, b"count");
        for i in 0..runs {
            starts.insert(mix64(key ^ i) % (n - SAMPLE_RUN + 1), ());
        }
        for s in starts.keys() {
            sample.extend(num.range(view, *s, SAMPLE_RUN)?);
        }
    }
    let read = sample.len() as u64;
    let mut hits = 0u64;
    for (_, e, kind, fav) in sample {
        if chk.passes(e, kind, fav)? {
            hits += 1;
        }
    }
    if read >= n {
        return Ok((hits, true));
    }
    Ok((
        ((hits as f64) * (n as f64) / (read.max(1) as f64)).round() as u64,
        false,
    ))
}

/// A page of the library under `q`.
pub fn page(view: &View, q: &Query) -> Result<Page, StoreError> {
    page_with(view, q, None)
}

/// `page` for the entities `search` also passes: every one is checked, and the page has no total (a search's
/// count is the caller's).
pub fn page_with<'a>(
    view: &'a View<'a>,
    q: &Query,
    search: Option<CheckFn<'a>>,
) -> Result<Page, StoreError> {
    let searched = search.is_some();
    let mut chk = Checker::new(view, &q.filter)?;
    chk.search = search;
    if chk.r.empty || q.filter.ids.as_ref().is_some_and(Vec::is_empty) {
        return Ok(Page {
            total: q.count.then_some(0),
            total_exact: true,
            ..Page::default()
        });
    }
    let random = matches!(q.sort, Sort::Random { .. });
    let mut d = driver(view, &q.filter, &chk.r, !random)?;
    if searched {
        d.covers = false;
        d.whole = false;
        d.light = false;
    }
    let q = &Query {
        count: q.count && !searched,
        ..q.clone()
    };
    let (read, range_over) = if q.filter.ids.is_some() {
        (Read::Walk(None), 0)
    } else {
        plan(view, q, &d, &chk.r)?
    };
    chk.decided = match &read {
        Read::Walk(k) => k.map(|k| k.sort),
        Read::Set(sort, _) => Some(*sort),
    };
    let ((ids, more, cursor), known) = match (q.sort, &read) {
        (Sort::Random { seed, desc }, _) => random_page(view, q, &d, &mut chk, &read, seed, desc)?,
        _ if q.filter.ids.is_some() => (ids_page(q, &mut chk)?, None),
        (_, Read::Walk(range)) => sorted_page(view, q, &d, &mut chk, *range)?,
        (_, Read::Set(_, set)) => set_page(view, q, &mut chk, set)?,
    };
    // A count reads entities from anywhere in the driver, not just the range a walk was narrowed to.
    chk.decided = None;
    let (total, total_exact) = match (q.count, known) {
        (false, _) => (None, true),
        (true, Some(n)) => (Some(n), true),
        (true, None) => {
            let (t, x) = total(view, q, &d, &mut chk, range_over)?;
            (Some(t), x)
        }
    };
    Ok(Page {
        ids,
        total,
        total_exact,
        more,
        cursor,
    })
}

/// The library filter as a search filter: each document checked as a page checks it, reading only what the
/// filter needs (its type always; its fav for a fav filter).
pub struct LibraryCheck(pub Filter);

impl LibraryCheck {
    /// Whether any document of the library scope could fail it.
    pub fn needed(f: &Filter) -> bool {
        !(f.characters && f.groups)
            || f.fav.is_some()
            || f.world.is_some()
            || !f.ranges.is_empty()
            || !f.all_tags.is_empty()
            || !f.any_tags.is_empty()
            || !f.no_tags.is_empty()
            || f.ids.is_some()
            || !f.not_ids.is_empty()
    }
}

impl DocCheck for LibraryCheck {
    fn begin<'v>(&self, view: &'v View<'v>) -> Result<CheckFn<'v>, StoreError> {
        let mut chk = Checker::new(view, &self.0)?;
        let wants_fav = self.0.fav.is_some();
        Ok(Box::new(move |e| {
            let Some((kind, _, _)) = library::entity_info(view, e)? else {
                return Ok(false);
            };
            if kind != CHARACTER && kind != GROUP {
                return Ok(false);
            }
            let fav = wants_fav && library::fav_of(view, e)?;
            chk.passes(e, kind, fav)
        }))
    }
}
