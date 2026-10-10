//! Pages of the library list: a sorted or random page of characters and groups under a filter, its total, and
//! a cursor to carry on from.
//!
//! The page is read from the orders of one scope (the whole library, a tag, a lorebook), the smallest that holds
//! every match, merging its (type, fav) parts. Whatever that scope doesn't decide is checked per entity under a
//! work cap: past it the page is short and says `more`, with a cursor at the last entity examined.

use std::collections::{BTreeMap, HashMap};

use super::StoreError;
use super::derive::View;
use super::kinds::{key, text_value};
use super::library::{
    self, CHARACTER, CREATED, FOLDER_TYPE, GROUP, Scope, State, count_key, counter, order_prefix,
    parse_uvarint, rand_key, rand_prefix, split_order_key,
};
use crate::keyspace::val::{get_bytes, get_u64, put_bytes, put_u64};
use crate::log::format::FieldRef;

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

/// Entries a stream reads at once.
const WINDOW: usize = 64;

/// The filter resolved against merges: the tags to require, any of, and exclude, as their targets.
struct Resolved {
    all: Vec<u64>,
    any: Vec<u64>,
    none: Vec<u64>,
    /// A required tag leads nowhere, or every `any` tag does: nothing matches.
    empty: bool,
}

fn resolve(view: &View, f: &Filter) -> Result<Resolved, StoreError> {
    let mut r = Resolved {
        all: Vec::new(),
        any: Vec::new(),
        none: Vec::new(),
        empty: false,
    };
    for t in &f.all_tags {
        match library::resolve_tag(view, *t)? {
            Some(t) if !r.all.contains(&t) => r.all.push(t),
            Some(_) => {}
            None => r.empty = true,
        }
    }
    for t in &f.any_tags {
        if let Some(t) = library::resolve_tag(view, *t)?
            && !r.any.contains(&t)
        {
            r.any.push(t);
        }
    }
    if !f.any_tags.is_empty() && r.any.is_empty() {
        r.empty = true;
    }
    for t in &f.no_tags {
        if let Some(t) = library::resolve_tag(view, *t)?
            && !r.none.contains(&t)
        {
            r.none.push(t);
        }
    }
    Ok(r)
}

/// What decides whether an entity passes, read as needed and kept for the request.
struct Checker<'a> {
    view: &'a View<'a>,
    f: &'a Filter,
    r: Resolved,
    folders: HashMap<u64, bool>,
    resolved: HashMap<u64, Option<u64>>,
}

impl Checker<'_> {
    fn resolve(&mut self, t: u64) -> Result<Option<u64>, StoreError> {
        if let Some(r) = self.resolved.get(&t) {
            return Ok(*r);
        }
        let r = library::resolve_tag(self.view, t)?;
        self.resolved.insert(t, r);
        Ok(r)
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

    /// Whether the entity, in state `st`, passes everything but the scope it was read from.
    fn passes(&mut self, e: u64, st: &State) -> Result<bool, StoreError> {
        let f = self.f;
        if self.r.empty || f.not_ids.contains(&e) {
            return Ok(false);
        }
        if let Some(ids) = &f.ids
            && !ids.contains(&e)
        {
            return Ok(false);
        }
        if !(if st.kind == CHARACTER {
            f.characters
        } else {
            f.groups
        }) {
            return Ok(false);
        }
        if f.fav.is_some_and(|v| v != st.fav) {
            return Ok(false);
        }
        if st.kind == CHARACTER
            && let Some(w) = &f.world
            && st.world.as_ref() != Some(w)
        {
            return Ok(false);
        }
        let needs_tags =
            !self.r.all.is_empty() || !self.r.any.is_empty() || !self.r.none.is_empty();
        if needs_tags {
            let mut carried = Vec::with_capacity(st.tags.len());
            for t in &st.tags {
                if let Some(t) = self.resolve(*t)? {
                    carried.push(t);
                }
            }
            if !self.r.all.iter().all(|t| carried.contains(t))
                || (!self.r.any.is_empty() && !self.r.any.iter().any(|t| carried.contains(t)))
                || self.r.none.iter().any(|t| carried.contains(t))
            {
                return Ok(false);
            }
        }
        for (field, min, max) in &f.ranges {
            let v = match field {
                RangeField::Created => st.nums[(CREATED - 1) as usize],
                RangeField::LastChat => st.nums[2],
                RangeField::ChatSize => st.nums[3],
                RangeField::Data => st.nums[4],
                RangeField::ClosedFolders => {
                    let mut n = 0;
                    for t in st.tags.clone() {
                        if self.closed(t)? {
                            n += 1;
                        }
                    }
                    Some(f64::from(n))
                }
                RangeField::Tag(t) => Some(if st.tags.contains(t) { 1.0 } else { 0.0 }),
            };
            let Some(v) = v else { return Ok(false) };
            if min.is_some_and(|m| v < m) || max.is_some_and(|m| v > m) {
                return Ok(false);
            }
        }
        Ok(true)
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

/// The scope a read is driven by: the one of the scopes every match is in with the fewest entities, and the
/// tags whose orders it takes (more than one while merges into it wait for their folds).
struct Driver {
    scope: Scope,
    sources: Vec<Scope>,
    /// Matches are exactly the driver's entities of the filter's types and fav: no check needed.
    whole: bool,
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

fn tag_sources(view: &View, t: u64) -> Result<Vec<Scope>, StoreError> {
    Ok(library::tag_sources(view, t)?
        .into_iter()
        .map(Scope::Tag)
        .collect())
}

fn driver(view: &View, f: &Filter, r: &Resolved) -> Result<Driver, StoreError> {
    let mut best = Driver {
        scope: Scope::All,
        sources: vec![Scope::All],
        whole: false,
    };
    let mut best_n = scope_size(view, &best.sources, f)?;
    let mut candidates: Vec<Scope> = r.all.iter().map(|t| Scope::Tag(*t)).collect();
    if r.any.len() == 1 {
        candidates.push(Scope::Tag(r.any[0]));
    }
    if let Some(w) = &f.world
        && !f.groups
    {
        candidates.push(Scope::World(w.clone()));
    }
    for c in candidates {
        let sources = match &c {
            Scope::Tag(t) => tag_sources(view, *t)?,
            s => vec![s.clone()],
        };
        let n = scope_size(view, &sources, f)?;
        if n < best_n {
            best_n = n;
            best = Driver {
                scope: c,
                sources,
                whole: false,
            };
        }
    }
    let tags_left =
        r.all.len() + r.any.len() + r.none.len() - usize::from(matches!(best.scope, Scope::Tag(_)));
    let world_left = f.world.is_some() && !matches!(best.scope, Scope::World(_));
    best.whole = !r.empty
        && tags_left == 0
        && !world_left
        && f.ranges.is_empty()
        && f.ids.is_none()
        && f.not_ids.is_empty();
    Ok(best)
}

// ---- sorted pages ----

/// One (source, type, fav) part of an order, read in the page's direction.
struct Stream {
    prefix: Vec<u8>,
    kind: u64,
    /// The fav group this part is in for a fav sort (0 first), else 0.
    group: u8,
    desc: bool,
    /// Where the next read starts (ascending) or ends (descending).
    bound: Vec<u8>,
    buf: std::collections::VecDeque<(Vec<u8>, Vec<u8>, u64)>,
    done: bool,
}

impl Stream {
    fn fill(&mut self, view: &View, sort: u64) -> Result<(), StoreError> {
        if !self.buf.is_empty() || self.done {
            return Ok(());
        }
        let found = if self.desc {
            view.scan_vals_rev(&self.prefix, &self.bound, WINDOW)?
        } else {
            view.scan_vals(&self.bound, &key::prefix_end(&self.prefix), WINDOW)?
        };
        if found.len() < WINDOW {
            self.done = true;
        }
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

fn sorted_page(
    view: &View,
    q: &Query,
    d: &Driver,
    chk: &mut Checker,
) -> Result<Walked, StoreError> {
    let (sort, desc, fav_sort) = match q.sort {
        Sort::Key { sort, desc } => (sort, desc, None),
        Sort::Fav { desc } => (library::BY_NAME, false, Some(desc)),
        Sort::Random { .. } => unreachable!(),
    };
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
                let mut s = Stream {
                    bound: if desc {
                        key::prefix_end(&prefix)
                    } else {
                        prefix.clone()
                    },
                    prefix,
                    kind,
                    group,
                    desc,
                    buf: Default::default(),
                    done: false,
                };
                if let Some((p, _)) = &at {
                    match bound_after(&s, p) {
                        Some(b) => s.bound = b,
                        None => s.done = true,
                    }
                }
                streams.push(s);
            }
        }
    }
    let mut skip = at.as_ref().map_or(q.offset, |(_, s)| *s);
    let budget = q.cap + skip + q.limit as u64;
    let mut ids = Vec::new();
    let mut examined = 0u64;
    let mut last: Option<Place> = at.map(|(p, _)| p);
    let mut last_entity = None;
    let check_all = !d.whole;
    loop {
        if ids.len() >= q.limit {
            break;
        }
        if examined >= budget {
            let cursor = last.as_ref().map(|p| encode_place(p, skip, 0));
            return Ok((ids, true, cursor));
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
        let Some(b) = best else { break };
        let (sk, tie, e) = streams[b].buf.pop_front().unwrap();
        let place = (streams[b].group, sk, streams[b].kind, tie);
        examined += 1;
        last = Some(place);
        // The same entity from two tags' orders (a merge waiting for its fold) comes twice in a row.
        if last_entity == Some(e) {
            continue;
        }
        last_entity = Some(e);
        if check_all {
            let Some(st) = library::state(view, e)? else {
                continue;
            };
            if !chk.passes(e, &st)? {
                continue;
            }
        }
        if skip > 0 {
            skip -= 1;
            continue;
        }
        ids.push(e);
    }
    let cursor = (ids.len() == q.limit && !ids.is_empty())
        .then(|| last.as_ref().map(|p| encode_place(p, 0, 0)))
        .flatten();
    Ok((ids, false, cursor))
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
    /// List items in order: (list, item).
    pub items: Vec<(u64, u64)>,
    pub data_size: Option<u64>,
    pub create_ms: Option<f64>,
    pub hashes: Vec<(u64, Vec<u8>)>,
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
    for t in library::tags_of(view, e)? {
        if let Some(t) = library::resolve_tag(view, t)?
            && !out.tags.contains(&t)
        {
            out.tags.push(t);
        }
    }
    out.tags.sort_unstable();
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
    for (ik, v) in view.scan(&ip, &key::prefix_end(&ip), usize::MAX)? {
        let mut at = ip.len();
        let list = get_u64(&ik, &mut at)
            .ok_or_else(|| StoreError::Entry("an item key doesn't decode".into()))?;
        out.items.push((list, parse_uvarint(&v)?));
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

    fn at(&self, view: &View, mut r: u64) -> Result<Option<u64>, StoreError> {
        for (k, fav, size) in &self.parts {
            if r < *size {
                return view
                    .get(&rand_key(&self.scope, *k, *fav, r))?
                    .map(|b| parse_uvarint(&b))
                    .transpose();
            }
            r -= size;
        }
        Ok(None)
    }

    /// The entities numbered `from..from + len` of the whole numbering, in order.
    fn range(&self, view: &View, from: u64, len: u64) -> Result<Vec<u64>, StoreError> {
        let mut out = Vec::new();
        let (mut r, mut left) = (from, len);
        for (k, fav, size) in &self.parts {
            if left == 0 {
                break;
            }
            if r >= *size {
                r -= size;
                continue;
            }
            let take = left.min(size - r);
            let p = rand_prefix(&self.scope, *k, *fav);
            for (_, v) in view.scan(
                &rand_key(&self.scope, *k, *fav, r),
                &key::prefix_end(&p),
                take as usize,
            )? {
                out.push(parse_uvarint(&v)?);
            }
            left -= take;
            r = 0;
        }
        Ok(out)
    }

    fn rank_of(&self, view: &View, e: u64, st: &State) -> Result<Option<u64>, StoreError> {
        let mut off = 0;
        for (k, fav, size) in &self.parts {
            if *k == st.kind && *fav == st.fav {
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

fn random_page(
    view: &View,
    q: &Query,
    d: &Driver,
    chk: &mut Checker,
    seed: u64,
    desc: bool,
) -> Result<Walked, StoreError> {
    // A tag whose merges wait for their folds has no one numbering: its target's whole library is walked.
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
    if let Some(ids) = &q.filter.ids {
        let mut placed = Vec::new();
        for e in ids {
            let Some(st) = library::state(view, *e)? else {
                continue;
            };
            if !chk.passes(*e, &st)? {
                continue;
            }
            let pos = match num.rank_of(view, *e, &st)? {
                Some(r) => unpermute(r, n, k),
                None => continue,
            };
            placed.push((if desc { n - 1 - pos } else { pos }, *e));
        }
        placed.sort_unstable();
        let start = at.map_or(q.offset, |(p, _)| p) as usize;
        let end = placed.len().min(start + q.limit);
        let page: Vec<u64> = placed
            .get(start..end)
            .unwrap_or(&[])
            .iter()
            .map(|x| x.1)
            .collect();
        let cursor = (end - start.min(end) == q.limit && end < placed.len())
            .then(|| encode_position(end as u64, 0));
        return Ok((page, false, cursor));
    }
    if whole {
        let start = at.map_or(q.offset, |(p, _)| p);
        let end = n.min(start + q.limit as u64);
        let mut ids = Vec::new();
        for j in start..end {
            if let Some(e) = num.at(view, rank(j))? {
                ids.push(e);
            }
        }
        let cursor = (end - start.min(end) == q.limit as u64).then(|| encode_position(end, 0));
        return Ok((ids, false, cursor));
    }
    let (mut j, mut skip) = at.unwrap_or((0, q.offset));
    let mut examined = 0;
    let mut ids = Vec::new();
    while ids.len() < q.limit && j < n && examined < q.cap + q.limit as u64 {
        let e = num.at(view, rank(j))?;
        j += 1;
        examined += 1;
        let Some(e) = e else { continue };
        let Some(st) = library::state(view, e)? else {
            continue;
        };
        if !chk.passes(e, &st)? {
            continue;
        }
        if skip > 0 {
            skip -= 1;
            continue;
        }
        ids.push(e);
    }
    let more = ids.len() < q.limit && j < n;
    let full = ids.len() == q.limit && j < n;
    Ok((ids, more, (more || full).then(|| encode_position(j, skip))))
}

// ---- totals ----

fn total(view: &View, q: &Query, d: &Driver, chk: &mut Checker) -> Result<(u64, bool), StoreError> {
    if chk.r.empty {
        return Ok((0, true));
    }
    if let Some(ids) = &q.filter.ids {
        let mut n = 0;
        let mut seen = Vec::new();
        for e in ids {
            if seen.contains(e) {
                continue;
            }
            seen.push(*e);
            if let Some(st) = library::state(view, *e)?
                && chk.passes(*e, &st)?
            {
                n += 1;
            }
        }
        return Ok((n, true));
    }
    if d.whole {
        let n = scope_size(view, &d.sources, &q.filter)?.max(0) as u64;
        return Ok((n, d.sources.len() == 1));
    }
    // Only listed ids are left out beyond the scope: the scope's count less each of them that would match.
    let mut rest = q.filter.clone();
    rest.not_ids.clear();
    let rest_r = resolve(view, &rest)?;
    if d.sources.len() == 1 && driver(view, &rest, &rest_r)?.whole {
        let mut n = scope_size(view, &d.sources, &rest)?.max(0);
        let mut c = Checker {
            view,
            f: &rest,
            r: rest_r,
            folders: HashMap::new(),
            resolved: HashMap::new(),
        };
        let mut seen = Vec::new();
        for e in &q.filter.not_ids {
            if seen.contains(e) {
                continue;
            }
            seen.push(*e);
            if let Some(st) = library::state(view, *e)?
                && c.passes(*e, &st)?
            {
                n -= 1;
            }
        }
        return Ok((n.max(0) as u64, true));
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
    for e in sample {
        if let Some(st) = library::state(view, e)?
            && chk.passes(e, &st)?
        {
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
    let r = resolve(view, &q.filter)?;
    let empty = r.empty || q.filter.ids.as_ref().is_some_and(|i| i.is_empty());
    let d = driver(view, &q.filter, &r)?;
    let mut chk = Checker {
        view,
        f: &q.filter,
        r,
        folders: HashMap::new(),
        resolved: HashMap::new(),
    };
    if empty {
        return Ok(Page {
            total: q.count.then_some(0),
            total_exact: true,
            ..Page::default()
        });
    }
    let (ids, more, cursor) = match q.sort {
        Sort::Random { seed, desc } => random_page(view, q, &d, &mut chk, seed, desc)?,
        _ if q.filter.ids.is_some() => ids_page(view, q, &mut chk)?,
        _ => sorted_page(view, q, &d, &mut chk)?,
    };
    let (total, total_exact) = if q.count {
        let (t, x) = total(view, q, &d, &mut chk)?;
        (Some(t), x)
    } else {
        (None, true)
    };
    Ok(Page {
        ids,
        total,
        total_exact,
        more,
        cursor,
    })
}

/// A sorted page of a listed set of ids: each looked up, sorted in memory (the list bounds the work).
fn ids_page(view: &View, q: &Query, chk: &mut Checker) -> Result<Walked, StoreError> {
    let (sort, desc, fav_first) = match q.sort {
        Sort::Key { sort, desc } => (sort, desc, None),
        Sort::Fav { desc } => (library::BY_NAME, false, Some(desc)),
        Sort::Random { .. } => unreachable!(),
    };
    let mut rows: Vec<(Place, u64)> = Vec::new();
    let mut seen = Vec::new();
    for e in q.filter.ids.as_ref().unwrap() {
        if seen.contains(e) {
            continue;
        }
        seen.push(*e);
        let Some(st) = library::state(view, *e)? else {
            continue;
        };
        if !chk.passes(*e, &st)? {
            continue;
        }
        let group = fav_first.map_or(0, |f| u8::from(st.fav != f));
        rows.push(((group, st.sort_key(sort), st.kind, st.tie.clone()), *e));
    }
    rows.sort_by(|a, b| {
        if a.0.0 != b.0.0 {
            return a.0.0.cmp(&b.0.0);
        }
        if desc { b.0.cmp(&a.0) } else { a.0.cmp(&b.0) }
    });
    let start = q
        .cursor
        .as_deref()
        .and_then(decode_position)
        .map_or(q.offset, |(p, _)| p) as usize;
    let end = rows.len().min(start + q.limit);
    let ids = rows
        .get(start.min(end)..end)
        .unwrap_or(&[])
        .iter()
        .map(|r| r.1)
        .collect();
    let cursor = (end - start.min(end) == q.limit && end < rows.len())
        .then(|| encode_position(end as u64, 0));
    Ok((ids, false, cursor))
}
