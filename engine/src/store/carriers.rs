//! Tags' carriers by the terms of their names: for each term, the carriers summed (`TERM_CARRIERS`), and the
//! carriers themselves split by the tag's side. A light tag's carriers are counted per carrier in the term's map
//! (`TAG_CARRIERS`); a heavy tag is listed under the term (`TERM_HEAVY`) and its own member blocks stand for its
//! carriers. A tag is heavy once it carries more than 2K pairs and light again under K/2, where K = 2^j and j is
//! set from the pairs of every tag (`CARRIER_PAIRS`) with hysteresis (`Reside`).
//!
//! A tag whose side or indexed name changes while it has carriers is moved: its map entries follow a carrier
//! at a time, in steps of at most `MOVE_BUDGET` entries (`move_step`), below a cursor in the new state and at or above it in the
//! old. A change of j re-sides every tag outside the new band, a slice of tags at a time (`reside_step`).

use std::collections::{BTreeMap, BTreeSet};

use super::StoreError;
use super::derive::{Out, View};
use super::kinds::{key, search_texts};
use super::library::{FOLD_SLICE, counter};
use crate::keyspace::val::{get_bytes, get_u64, map_pairs, put_bytes};
use crate::log::format::{get_uvarint, put_uvarint};
use crate::search::index::raise_tagged;
use crate::search::text::{grams, tokens};
use crate::search::{Scope, TermKind};

/// A name term: a token whole (`Exact`) or one of its prefix terms (`Gram`).
pub type Term = (TermKind, String);

fn entry_err(why: &str) -> StoreError {
    StoreError::Entry(why.into())
}

/// The terms of a name.
pub fn name_terms(name: &[u8]) -> BTreeSet<Term> {
    let mut out = BTreeSet::new();
    for tok in tokens(name) {
        for g in grams(&tok) {
            out.insert((TermKind::Gram, g.to_string()));
        }
        out.insert((TermKind::Exact, tok));
    }
    out
}

/// A tag's name as one text: a tag's name field holds at most one.
pub fn one_name(texts: &[&[u8]]) -> Result<Vec<u8>, StoreError> {
    match texts {
        [] => Ok(Vec::new()),
        [t] => Ok(t.to_vec()),
        _ => Err(entry_err("a tag's name holds more than one text")),
    }
}

/// The tag's name as the search index holds it (empty: none).
pub fn indexed_name(view: &View, tag: u64) -> Result<Vec<u8>, StoreError> {
    let texts = search_texts(view, Scope::TAGS, tag, 0)?;
    one_name(&texts.iter().map(Vec::as_slice).collect::<Vec<_>>())
}

/// The least j with 4^j ≥ m.
pub fn j_of(m: u64) -> u32 {
    let mut j = 0;
    while 4u128.pow(j) < u128::from(m) {
        j += 1;
    }
    j
}

/// The side a tag with `c` carriers takes, from side `heavy`, at scale `k`.
pub fn want(c: i64, heavy: bool, k: u64) -> bool {
    let c = c.max(0) as u128;
    let k = u128::from(k);
    if c > 2 * k {
        true
    } else if 2 * c < k {
        false
    } else {
        heavy
    }
}

// ---- stored values ----

/// A move under way: carriers below `cursor` are in the target state, the rest in the mapped one.
#[derive(Debug, Clone, PartialEq)]
pub struct Flight {
    pub mapped_name: Vec<u8>,
    pub target_heavy: bool,
    pub target_name: Vec<u8>,
    pub cursor: u64,
    /// The indexed name or the band changed since the move began.
    pub pending: bool,
}

/// A heavy or moving tag's `TAG_MAP`; a tag without one is light, mapped by its indexed name, and not moving.
#[derive(Debug, Clone, PartialEq)]
pub struct TagMap {
    /// The settled side (while moving, the side the move leaves).
    pub heavy: bool,
    pub flight: Option<Flight>,
}

impl TagMap {
    pub fn bytes(&self) -> Vec<u8> {
        let mut b = Vec::new();
        put_uvarint(&mut b, u64::from(self.heavy));
        if let Some(f) = &self.flight {
            put_bytes(&mut b, &f.mapped_name);
            put_uvarint(&mut b, u64::from(f.target_heavy));
            put_bytes(&mut b, &f.target_name);
            put_uvarint(&mut b, f.cursor);
            put_uvarint(&mut b, u64::from(f.pending));
        }
        b
    }

    pub fn parse(b: &[u8]) -> Result<TagMap, StoreError> {
        let bad = || entry_err("a tag's carrier map doesn't decode");
        let mut at = 0;
        let flag = |at: &mut usize| -> Result<bool, StoreError> {
            match get_uvarint(b, at).map_err(|_| bad())? {
                0 => Ok(false),
                1 => Ok(true),
                _ => Err(bad()),
            }
        };
        let heavy = flag(&mut at)?;
        if at == b.len() {
            return Ok(TagMap {
                heavy,
                flight: None,
            });
        }
        let mapped_name = get_bytes(b, &mut at).ok_or_else(bad)?;
        let target_heavy = flag(&mut at)?;
        let target_name = get_bytes(b, &mut at).ok_or_else(bad)?;
        let cursor = get_uvarint(b, &mut at).map_err(|_| bad())?;
        let pending = flag(&mut at)?;
        if at != b.len() {
            return Err(bad());
        }
        Ok(TagMap {
            heavy,
            flight: Some(Flight {
                mapped_name,
                target_heavy,
                target_name,
                cursor,
                pending,
            }),
        })
    }
}

pub fn tag_map(view: &View, tag: u64) -> Result<Option<TagMap>, StoreError> {
    view.get(&key::id(key::TAG_MAP, tag))?
        .map(|b| TagMap::parse(&b))
        .transpose()
}

/// The scale the sides were last made for, and a re-siding scan under way.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Reside {
    pub j: u32,
    /// The pairs when j was last set: j is considered again once the pairs reach 4× or fall to ¼ of it.
    pub m_set: u64,
    /// The scan's phase (0: promotions, 1: demotions) and the last key it read.
    pub scan: Option<(u64, Option<Vec<u8>>)>,
}

impl Reside {
    pub fn k(&self) -> u64 {
        1u64 << self.j
    }

    pub fn bytes(&self) -> Vec<u8> {
        let mut b = Vec::new();
        put_uvarint(&mut b, u64::from(self.j));
        put_uvarint(&mut b, self.m_set);
        if let Some((phase, cursor)) = &self.scan {
            put_uvarint(&mut b, *phase);
            if let Some(c) = cursor {
                put_bytes(&mut b, c);
            }
        }
        b
    }

    pub fn parse(b: &[u8]) -> Result<Reside, StoreError> {
        let bad = || entry_err("the re-siding state doesn't decode");
        let mut at = 0;
        let j = get_uvarint(b, &mut at).map_err(|_| bad())?;
        let m_set = get_uvarint(b, &mut at).map_err(|_| bad())?;
        let scan = if at == b.len() {
            None
        } else {
            let phase = get_uvarint(b, &mut at).map_err(|_| bad())?;
            let cursor = if at == b.len() {
                None
            } else {
                Some(get_bytes(b, &mut at).ok_or_else(bad)?)
            };
            Some((phase, cursor))
        };
        if at != b.len() || phase_bad(&scan) || j > 32 {
            return Err(bad());
        }
        Ok(Reside {
            j: j as u32,
            m_set,
            scan,
        })
    }
}

fn phase_bad(scan: &Option<(u64, Option<Vec<u8>>)>) -> bool {
    scan.as_ref().is_some_and(|(p, _)| *p > 1)
}

pub fn reside(view: &View) -> Result<Reside, StoreError> {
    Ok(match view.get(&key::of(key::RESIDE))? {
        Some(b) => Reside::parse(&b)?,
        None => Reside::default(),
    })
}

// ---- the mapped state ----

/// The (side, name) the map holds `tag`'s carrier `entity` by.
fn mapped_at<'a>(m: &'a Option<TagMap>, indexed: &'a [u8], entity: u64) -> (bool, &'a [u8]) {
    match m {
        None => (false, indexed),
        Some(TagMap {
            heavy,
            flight: None,
        }) => (*heavy, indexed),
        Some(TagMap {
            heavy,
            flight: Some(f),
        }) => {
            if entity < f.cursor {
                (f.target_heavy, &f.target_name)
            } else {
                (*heavy, &f.mapped_name)
            }
        }
    }
}

/// The terms a moving tag is listed under (`TERM_MOVING`): its mapped, target and indexed names'.
fn moving_terms(f: &Flight, indexed: &[u8]) -> BTreeSet<Term> {
    let mut t = name_terms(&f.mapped_name);
    t.extend(name_terms(&f.target_name));
    t.extend(name_terms(indexed));
    t
}

/// Entries one step of a carrier move writes at most, a carrier counting the terms written for it and at least 1.
pub const MOVE_BUDGET: usize = 16_384;

/// The terms a move writes map entries for at each carrier: a light side's name terms, those both sides map by
/// cancelling.
fn mapped_writes(
    heavy: bool,
    mapped_name: &[u8],
    target_heavy: bool,
    target: &[u8],
) -> BTreeSet<Term> {
    let side = |h: bool, name: &[u8]| if h { BTreeSet::new() } else { name_terms(name) };
    side(heavy, mapped_name)
        .symmetric_difference(&side(target_heavy, target))
        .cloned()
        .collect()
}

/// The terms a move raises its carriers' block maxima for: the target name's that the mapped name lacks.
fn gained(mapped_name: &[u8], target: &[u8]) -> BTreeSet<Term> {
    name_terms(target)
        .difference(&name_terms(mapped_name))
        .cloned()
        .collect()
}

/// Whether a move from (`heavy`, `mapped_name`) to (`target_heavy`, `target`) writes or raises nothing at its
/// carriers, so it is taken at once, without walking them.
fn idle(heavy: bool, mapped_name: &[u8], target_heavy: bool, target: &[u8]) -> bool {
    mapped_writes(heavy, mapped_name, target_heavy, target).is_empty()
        && gained(mapped_name, target).is_empty()
}

/// The `TERM_HEAVY` entries of a tag going from listed by `was` (None: light) to listed by `is`.
fn relist(out: &mut Out, tag: u64, was: Option<&[u8]>, is: Option<&[u8]>) {
    let terms = |n: Option<&[u8]>| n.map_or_else(BTreeSet::new, name_terms);
    let (was, is) = (terms(was), terms(is));
    for (kind, term) in was.difference(&is) {
        out.del(key::term_heavy(*kind, term, tag));
    }
    for (kind, term) in is.difference(&was) {
        out.put(key::term_heavy(*kind, term, tag), Vec::new());
    }
}

/// A settled tag (side `heavy`, its carriers mapped by `mapped_name`) starts moving to (`target_heavy`, `indexed`);
/// a move that writes and raises nothing at its carriers (`idle`) is taken at once.
fn start_move(
    out: &mut Out,
    tag: u64,
    heavy: bool,
    mapped_name: &[u8],
    target_heavy: bool,
    indexed: &[u8],
) {
    if idle(heavy, mapped_name, target_heavy, indexed) {
        relist(
            out,
            tag,
            heavy.then_some(mapped_name),
            target_heavy.then_some(indexed),
        );
        if heavy != target_heavy {
            if target_heavy {
                out.put(
                    key::id(key::TAG_MAP, tag),
                    TagMap {
                        heavy: true,
                        flight: None,
                    }
                    .bytes(),
                );
            } else {
                out.del(key::id(key::TAG_MAP, tag));
            }
        }
        return;
    }
    let f = Flight {
        mapped_name: mapped_name.to_vec(),
        target_heavy,
        target_name: indexed.to_vec(),
        cursor: 0,
        pending: false,
    };
    for (kind, term) in moving_terms(&f, indexed) {
        out.put(key::term_moving(kind, &term, tag), Vec::new());
    }
    out.put(key::id(key::MOVING, tag), Vec::new());
    out.put(
        key::id(key::TAG_MAP, tag),
        TagMap {
            heavy,
            flight: Some(f),
        }
        .bytes(),
    );
}

// ---- upkeep ----

/// Entity `entity` starts (`delta` 1) or stops (-1) carrying `tag`. Call before the change's own `MEMBER_COUNT`
/// write shows in `view`; a record making several calls shows each one's output to the next.
pub fn changed(
    view: &View,
    out: &mut Out,
    tag: u64,
    entity: u64,
    delta: i64,
) -> Result<(), StoreError> {
    if view.is_bulk() || delta == 0 {
        return Ok(());
    }
    let m = tag_map(view, tag)?;
    let m0 = counter(view, &key::of(key::CARRIER_PAIRS))?;
    let c0 = counter(view, &key::id(key::MEMBER_COUNT, tag))?;
    let name = indexed_name(view, tag)?;
    for (kind, term) in name_terms(&name) {
        out.add(key::term_carriers(kind, &term), delta);
    }
    out.add(key::of(key::CARRIER_PAIRS), delta);
    let (heavy, mapped) = mapped_at(&m, &name, entity);
    if !heavy {
        let block = entity >> key::MEMBER_BITS;
        let slot = key::member_slot(entity);
        for (kind, term) in name_terms(mapped) {
            out.add_map(key::tag_carriers(kind, &term, block), vec![(slot, delta)]);
        }
    }
    // The scale, with hysteresis.
    let mut r = reside(view)?;
    let m1 = (m0 + delta).max(0) as u64;
    if u128::from(m1) >= 4 * u128::from(r.m_set) || 4 * u128::from(m1) <= u128::from(r.m_set) {
        let j1 = j_of(m1);
        if j1 != r.j {
            r = Reside {
                j: j1,
                m_set: m1,
                scan: Some((0, None)),
            };
            out.put(key::of(key::RESIDE), r.bytes());
        }
    }
    // The band.
    let c1 = c0 + delta;
    let k = r.k();
    match m {
        None => {
            if want(c1, false, k) {
                start_move(out, tag, false, &name, true, &name);
            }
        }
        Some(TagMap {
            heavy,
            flight: None,
        }) => {
            let to = want(c1, heavy, k);
            if to != heavy {
                start_move(out, tag, heavy, &name, to, &name);
            }
        }
        Some(TagMap {
            heavy,
            flight: Some(mut f),
        }) => {
            if want(c1, f.target_heavy, k) != f.target_heavy && !f.pending {
                f.pending = true;
                out.put(
                    key::id(key::TAG_MAP, tag),
                    TagMap {
                        heavy,
                        flight: Some(f),
                    }
                    .bytes(),
                );
            }
        }
    }
    if delta > 0 {
        let raised = raised_terms(view, entity, tag)?;
        for (kind, term) in name_terms(&name) {
            if !raised.contains(&(kind, term.clone())) {
                raise_tagged(
                    view,
                    out,
                    Scope::LIBRARY,
                    &term,
                    kind == TermKind::Gram,
                    &[entity],
                )?;
            }
        }
    }
    Ok(())
}

/// The tags `entity` carries, in order.
fn tags_of(view: &View, entity: u64) -> Result<Vec<u64>, StoreError> {
    let prefix = key::id(key::MEMBER_OF, entity);
    let end = key::prefix_end(&prefix);
    let mut from = prefix.clone();
    let mut out = Vec::new();
    loop {
        let page = view.scan(&from, &end, 64)?;
        for (k, _) in &page {
            out.push(
                get_u64(k, &mut { prefix.len() })
                    .ok_or_else(|| entry_err("a membership key doesn't decode"))?,
            );
        }
        match page.last() {
            Some((k, _)) if page.len() == 64 => {
                from = k.clone();
                from.push(0);
            }
            _ => return Ok(out),
        }
    }
}

/// The name terms of the tags `entity` carries, by their indexed names: the tag part a create or an edit raises
/// its maxima with.
pub fn carried_terms(view: &View, entity: u64) -> Result<BTreeSet<Term>, StoreError> {
    let mut out = BTreeSet::new();
    for tag in tags_of(view, entity)? {
        out.extend(name_terms(&indexed_name(view, tag)?));
    }
    Ok(out)
}

/// The name terms `entity`'s tags other than `except` have its block's maxima raised for: a tag's indexed name's
/// that the name its map holds `entity` by (`mapped_at`) holds too. A move raises a carrier for its target name's
/// terms as its cursor passes it, so before the cursor the mapped name's are the raised ones; a query bounds
/// the rest (`search::query::Unraised`). Counting a tag by its indexed name alone could leave a carrier two moving
/// tags both gain a term at raised by neither.
fn raised_terms(view: &View, entity: u64, except: u64) -> Result<BTreeSet<Term>, StoreError> {
    let mut out = BTreeSet::new();
    for tag in tags_of(view, entity)? {
        if tag == except {
            continue;
        }
        let m = tag_map(view, tag)?;
        let indexed = indexed_name(view, tag)?;
        let by = name_terms(mapped_at(&m, &indexed, entity).1);
        out.extend(name_terms(&indexed).intersection(&by).cloned());
    }
    Ok(out)
}

/// A term's tags other than one, as `covered` reads their carriers.
struct Others {
    kind: TermKind,
    term: String,
    heavy: Vec<u64>,
    movers: Vec<OtherMover>,
}

/// A moving tag of a term: whether the term's map counts its carriers below and at or above its cursor, and
/// whether they are raised for the term there (its indexed name holds the term, and so does the name its map
/// holds them by).
struct OtherMover {
    tag: u64,
    cursor: u64,
    counted: (bool, bool),
    raised: (bool, bool),
}

impl Others {
    /// The term's heavy and moving tags but `except`.
    fn read(view: &View, kind: TermKind, term: &str, except: u64) -> Result<Others, StoreError> {
        let want = (kind, term.to_string());
        let holds = |name: &[u8]| name_terms(name).contains(&want);
        let mut o = Others {
            kind,
            term: term.to_string(),
            heavy: Vec::new(),
            movers: Vec::new(),
        };
        for tag in tags_under(view, key::term_key(key::TERM_MOVING, kind, term))? {
            if tag == except {
                continue;
            }
            let Some(TagMap {
                heavy,
                flight: Some(f),
            }) = tag_map(view, tag)?
            else {
                return Err(entry_err("a moving tag has no move"));
            };
            // Until the indexed name or the band changes, the move's target name is the indexed name.
            let named = if f.pending {
                holds(&indexed_name(view, tag)?)
            } else {
                holds(&f.target_name)
            };
            let (target, mapped) = (holds(&f.target_name), holds(&f.mapped_name));
            o.movers.push(OtherMover {
                tag,
                cursor: f.cursor,
                counted: (!f.target_heavy && target, !heavy && mapped),
                raised: (named && target, named && mapped),
            });
        }
        for tag in tags_under(view, key::term_key(key::TERM_HEAVY, kind, term))? {
            if tag != except && o.movers.iter().all(|m| m.tag != tag) {
                o.heavy.push(tag);
            }
        }
        Ok(o)
    }

    /// The carriers in member block `block` some of these tags, or a settled light one the term's map counts,
    /// has raised the term's maxima for.
    fn covered(&self, view: &View, block: u64) -> Result<BTreeSet<u64>, StoreError> {
        let first = block << key::MEMBER_BITS;
        let mut k = key::tag_carriers_of(self.kind, &self.term);
        crate::keyspace::val::put_u64(&mut k, block);
        let mut counts: BTreeMap<u64, i64> = places(view, &k, block)?
            .into_iter()
            .map(|(e, n)| (e, i64::from(n)))
            .collect();
        let mut out = BTreeSet::new();
        for &h in &self.heavy {
            out.extend(
                places(view, &key::member_block(h, first), block)?
                    .into_iter()
                    .map(|x| x.0),
            );
        }
        for m in &self.movers {
            for (e, _) in places(view, &key::member_block(m.tag, first), block)? {
                let below = e < m.cursor;
                let (counted, raised) = if below {
                    (m.counted.0, m.raised.0)
                } else {
                    (m.counted.1, m.raised.1)
                };
                if counted && let Some(n) = counts.get_mut(&e) {
                    *n -= 1;
                }
                if raised {
                    out.insert(e);
                }
            }
        }
        out.extend(counts.into_iter().filter(|x| x.1 > 0).map(|x| x.0));
        Ok(out)
    }
}

/// The tags keyed under `prefix`, in order.
fn tags_under(view: &View, prefix: Vec<u8>) -> Result<Vec<u64>, StoreError> {
    let end = key::prefix_end(&prefix);
    let mut from = prefix.clone();
    let mut out = Vec::new();
    loop {
        let page = view.scan(&from, &end, 64)?;
        for (k, _) in &page {
            out.push(
                get_u64(k, &mut { prefix.len() })
                    .ok_or_else(|| entry_err("a term's tag key doesn't decode"))?,
            );
        }
        match page.last() {
            Some((k, _)) if page.len() == 64 => {
                from = k.clone();
                from.push(0);
            }
            _ => return Ok(out),
        }
    }
}

/// A member block's or a term map block's carriers (in member block `block`) with their counts.
fn places(view: &View, k: &[u8], block: u64) -> Result<Vec<(u64, u32)>, StoreError> {
    let Some(v) = view.get_val(k)? else {
        return Ok(Vec::new());
    };
    Ok(v.into_pairs(k)
        .ok_or_else(|| entry_err("a carrier block doesn't decode"))?
        .into_iter()
        .filter(|&(s, n)| n != 0 && s < 1 << key::MEMBER_BITS)
        .map(|(s, n)| ((block << key::MEMBER_BITS) | u64::from(s), n))
        .collect())
}

/// Raises the block maxima of the carriers `taken` (in order) of `tag` for each term of `terms`, but at the carriers
/// another tag already has them raised for (`Others::covered`).
fn raise_gained(
    view: &View,
    out: &mut Out,
    tag: u64,
    terms: &BTreeSet<Term>,
    taken: &[u64],
) -> Result<(), StoreError> {
    for (kind, term) in terms {
        let others = Others::read(view, *kind, term, tag)?;
        let mut docs = Vec::new();
        let mut i = 0;
        while i < taken.len() {
            let block = taken[i] >> key::MEMBER_BITS;
            let j = i + taken[i..].partition_point(|e| e >> key::MEMBER_BITS == block);
            let covered = others.covered(view, block)?;
            docs.extend(taken[i..j].iter().filter(|e| !covered.contains(e)));
            i = j;
        }
        raise_tagged(
            view,
            out,
            Scope::LIBRARY,
            term,
            *kind == TermKind::Gram,
            &docs,
        )?;
    }
    Ok(())
}

/// `tag`'s indexed name changes from `old` to `new` (empty: none), its carriers as `view` holds them.
pub fn renamed(
    view: &View,
    out: &mut Out,
    tag: u64,
    old: &[u8],
    new: &[u8],
) -> Result<(), StoreError> {
    if view.is_bulk() {
        return Ok(());
    }
    let (to, tn) = (name_terms(old), name_terms(new));
    if to == tn {
        return Ok(());
    }
    let c = counter(view, &key::id(key::MEMBER_COUNT, tag))?;
    if c != 0 {
        for (kind, term) in to.difference(&tn) {
            out.add(key::term_carriers(*kind, term), -c);
        }
        for (kind, term) in tn.difference(&to) {
            out.add(key::term_carriers(*kind, term), c);
        }
    }
    match tag_map(view, tag)? {
        // Its carriers' maxima are raised for the terms it gains as a move passes them.
        Some(TagMap {
            heavy: true,
            flight: None,
        }) => start_move(out, tag, true, old, true, new),
        None | Some(TagMap { flight: None, .. }) => {
            if c != 0 {
                let k = reside(view)?.k();
                start_move(out, tag, false, old, want(c, false, k), new);
            }
        }
        Some(TagMap {
            heavy,
            flight: Some(mut f),
        }) => {
            let was = moving_terms(&f, old);
            let is = moving_terms(&f, new);
            for (kind, term) in is.difference(&was) {
                out.put(key::term_moving(*kind, term, tag), Vec::new());
            }
            for (kind, term) in was.difference(&is) {
                out.del(key::term_moving(*kind, term, tag));
            }
            if !f.pending {
                f.pending = true;
                out.put(
                    key::id(key::TAG_MAP, tag),
                    TagMap {
                        heavy,
                        flight: Some(f),
                    }
                    .bytes(),
                );
            }
        }
    }
    Ok(())
}

/// `tag` is merged away while it has carriers: its fold is its move to no name. It is put in flight with the
/// fold's progress as its cursor: the fold takes its carriers in id order and each one it moves stops being a
/// carrier, so a flight cursor of 0 splits them as the fold does, and the fold's `changed` removes each one's
/// entries by its mapped state. A move under way stops where it is, its cursor still splitting the map. Queries
/// leave out the carriers not yet moved (`TERM_MOVING`, with the name gone from the index); `folded` ends the
/// flight. Call before the name leaves the index, which then sees the tag in flight.
pub fn merging(view: &View, out: &mut Out, tag: u64) -> Result<(), StoreError> {
    if view.is_bulk() || counter(view, &key::id(key::MEMBER_COUNT, tag))? == 0 {
        return Ok(());
    }
    let name = indexed_name(view, tag)?;
    let gone = |target_heavy: bool| Flight {
        mapped_name: name.clone(),
        target_heavy,
        target_name: Vec::new(),
        cursor: 0,
        pending: true,
    };
    let (heavy, f) = match tag_map(view, tag)? {
        None => (false, gone(false)),
        Some(TagMap {
            heavy,
            flight: None,
        }) => (heavy, gone(heavy)),
        Some(TagMap {
            heavy,
            flight: Some(mut f),
        }) => {
            out.del(key::id(key::MOVING, tag));
            if f.pending {
                return Ok(());
            }
            f.pending = true;
            out.put(
                key::id(key::TAG_MAP, tag),
                TagMap {
                    heavy,
                    flight: Some(f),
                }
                .bytes(),
            );
            return Ok(());
        }
    };
    for (kind, term) in name_terms(&name) {
        out.put(key::term_moving(kind, &term, tag), Vec::new());
    }
    out.put(
        key::id(key::TAG_MAP, tag),
        TagMap {
            heavy,
            flight: Some(f),
        }
        .bytes(),
    );
    Ok(())
}

/// A merged tag's fold has moved its last carrier: its flight (`merging`) ends, and with it its listings.
pub fn folded(view: &View, out: &mut Out, tag: u64) -> Result<(), StoreError> {
    let Some(TagMap {
        heavy,
        flight: Some(f),
    }) = tag_map(view, tag)?
    else {
        return Ok(());
    };
    for (kind, term) in moving_terms(&f, &indexed_name(view, tag)?) {
        out.del(key::term_moving(kind, &term, tag));
    }
    relist(out, tag, heavy.then_some(&f.mapped_name[..]), None);
    out.del(key::id(key::TAG_MAP, tag));
    Ok(())
}

/// One step of the first queued move: as many of its carriers as `MOVE_BUDGET` allows move to the target state,
/// their block maxima raised for the terms the target name gains; once none is left, the move ends, or the next
/// one starts. Returns whether a move was queued.
pub fn move_step(view: &View, out: &mut Out) -> Result<bool, StoreError> {
    let qp = key::of(key::MOVING);
    let Some((qk, _)) = view.scan(&qp, &key::prefix_end(&qp), 1)?.into_iter().next() else {
        return Ok(false);
    };
    let mut at = qp.len();
    let tag = get_u64(&qk, &mut at).ok_or_else(|| entry_err("a move key doesn't decode"))?;
    let Some(TagMap {
        heavy,
        flight: Some(mut f),
    }) = tag_map(view, tag)?
    else {
        return Err(entry_err("a queued move has no flight"));
    };
    let name = indexed_name(view, tag)?;
    let (mapped_terms, target_terms) = (name_terms(&f.mapped_name), name_terms(&f.target_name));
    let writes = mapped_writes(heavy, &f.mapped_name, f.target_heavy, &f.target_name);
    let raised = gained(&f.mapped_name, &f.target_name);
    let cap = (MOVE_BUDGET / (writes.len() + raised.len()).max(1)).max(1);

    // ---- the carriers at or above the cursor, up to the budget ----
    let bp = key::id(key::MEMBER_BLOCK, tag);
    let bend = key::prefix_end(&bp);
    let mut from = key::member_block(tag, f.cursor);
    let mut taken: Vec<u64> = Vec::new();
    'blocks: while !(writes.is_empty() && raised.is_empty()) {
        let page = view.scan(&from, &bend, 16)?;
        for (bk, v) in &page {
            let mut a = bp.len();
            let block = get_u64(bk, &mut a)
                .ok_or_else(|| entry_err("a member block key doesn't decode"))?;
            let pairs = map_pairs(v).ok_or_else(|| entry_err("a member block doesn't decode"))?;
            for (slot, n) in pairs {
                let e = (block << key::MEMBER_BITS) | u64::from(slot);
                if n != 0 && e >= f.cursor {
                    taken.push(e);
                    if taken.len() == cap {
                        break 'blocks;
                    }
                }
            }
        }
        match page.last() {
            Some((k, _)) if page.len() == 16 => {
                from = k.clone();
                from.push(0);
            }
            _ => break,
        }
    }

    // ---- their map entries ----
    let mut adds: BTreeMap<(Term, u64), BTreeMap<u32, i32>> = BTreeMap::new();
    for &e in &taken {
        let (block, slot) = (e >> key::MEMBER_BITS, key::member_slot(e));
        let mut bump = |terms: &BTreeSet<Term>, d: i32| {
            for t in terms {
                *adds
                    .entry((t.clone(), block))
                    .or_default()
                    .entry(slot)
                    .or_default() += d;
            }
        };
        if !f.target_heavy {
            bump(&target_terms, 1);
        }
        if !heavy {
            bump(&mapped_terms, -1);
        }
    }
    for (((kind, term), block), slots) in adds {
        let pairs: Vec<(u32, i64)> = slots
            .into_iter()
            .filter(|(_, d)| *d != 0)
            .map(|(s, d)| (s, i64::from(d)))
            .collect();
        if !pairs.is_empty() {
            out.add_map(key::tag_carriers(kind, &term, block), pairs);
        }
    }

    raise_gained(view, out, tag, &raised, &taken)?;

    if taken.len() == cap {
        f.cursor = taken[taken.len() - 1] + 1;
        out.put(
            key::id(key::TAG_MAP, tag),
            TagMap {
                heavy,
                flight: Some(f),
            }
            .bytes(),
        );
        return Ok(true);
    }

    // ---- the end ----
    let c = counter(view, &key::id(key::MEMBER_COUNT, tag))?;
    let next = want(c, f.target_heavy, reside(view)?.k());
    let was = moving_terms(&f, &name);
    let again = next != f.target_heavy || name_terms(&name) != target_terms;
    if again && idle(f.target_heavy, &f.target_name, next, &name) {
        // The next move is taken at once.
        relist(
            out,
            tag,
            heavy.then_some(&f.mapped_name[..]),
            next.then_some(&name[..]),
        );
        for (kind, term) in &was {
            out.del(key::term_moving(*kind, term, tag));
        }
        out.del(qk);
        if next {
            out.put(
                key::id(key::TAG_MAP, tag),
                TagMap {
                    heavy: true,
                    flight: None,
                }
                .bytes(),
            );
        } else {
            out.del(key::id(key::TAG_MAP, tag));
        }
        return Ok(true);
    }
    relist(
        out,
        tag,
        heavy.then_some(&f.mapped_name[..]),
        f.target_heavy.then_some(&f.target_name[..]),
    );
    if again {
        let n = Flight {
            mapped_name: f.target_name.clone(),
            target_heavy: next,
            target_name: name.clone(),
            cursor: 0,
            pending: false,
        };
        let is = moving_terms(&n, &name);
        for (kind, term) in was.difference(&is) {
            out.del(key::term_moving(*kind, term, tag));
        }
        out.put(
            key::id(key::TAG_MAP, tag),
            TagMap {
                heavy: f.target_heavy,
                flight: Some(n),
            }
            .bytes(),
        );
    } else {
        for (kind, term) in &was {
            out.del(key::term_moving(*kind, term, tag));
        }
        out.del(qk);
        if f.target_heavy {
            out.put(
                key::id(key::TAG_MAP, tag),
                TagMap {
                    heavy: true,
                    flight: None,
                }
                .bytes(),
            );
        } else {
            out.del(key::id(key::TAG_MAP, tag));
        }
    }
    Ok(true)
}

/// One step of a re-siding scan: up to `FOLD_SLICE` tags read, those outside the band starting their moves.
/// Phase 0 reads the tags by carriers from the most down while they have more than 2K (settled light ones are
/// promoted); phase 1 reads every heavy or moving tag (settled heavy ones under K/2 are demoted). Returns whether
/// a scan was under way.
pub fn reside_step(view: &View, out: &mut Out) -> Result<bool, StoreError> {
    let mut r = reside(view)?;
    let Some((phase, cursor)) = r.scan.clone() else {
        return Ok(false);
    };
    let k = r.k();
    let after = |c: &Option<Vec<u8>>, start: Vec<u8>| -> Vec<u8> {
        match c {
            Some(c) if c.as_slice() > start.as_slice() => {
                let mut f = c.clone();
                f.push(0);
                f
            }
            _ => start,
        }
    };
    if phase == 0 {
        use super::tags::{ENTRIES, part_prefix, suffix_tag};
        let (unfoldered, foldered) = (
            part_prefix(ENTRIES, false, true),
            part_prefix(ENTRIES, true, true),
        );
        let folder = cursor.as_ref().is_some_and(|c| c.starts_with(&foldered));
        let part = if folder { &foldered } else { &unfoldered };
        let end = key::prefix_end(part);
        let page = view.scan(&after(&cursor, part.clone()), &end, FOLD_SLICE)?;
        let mut past = page.len() < FOLD_SLICE;
        for (ek, _) in &page {
            let s = &ek[part.len()..];
            let count = s
                .get(..8)
                .map(|b| u64::MAX - u64::from_be_bytes(b.try_into().unwrap()))
                .ok_or_else(|| entry_err("an order key doesn't decode"))?;
            if u128::from(count) <= 2 * u128::from(k) {
                past = true;
                break;
            }
            let tag =
                suffix_tag(ENTRIES, s).ok_or_else(|| entry_err("an order key doesn't decode"))?;
            if tag_map(view, tag)?.is_none() {
                let name = indexed_name(view, tag)?;
                start_move(out, tag, false, &name, true, &name);
            }
        }
        r.scan = Some(match (past, folder) {
            (false, _) => (0, page.last().map(|(k, _)| k.clone())),
            (true, false) => (0, Some(foldered.clone())),
            (true, true) => (1, None),
        });
    } else {
        let p = key::of(key::TAG_MAP);
        let page = view.scan(&after(&cursor, p.clone()), &key::prefix_end(&p), FOLD_SLICE)?;
        for (mk, v) in &page {
            let mut a = p.len();
            let tag =
                get_u64(mk, &mut a).ok_or_else(|| entry_err("a tag map key doesn't decode"))?;
            if let TagMap {
                heavy: true,
                flight: None,
            } = TagMap::parse(v)?
            {
                let c = counter(view, &key::id(key::MEMBER_COUNT, tag))?;
                if !want(c, true, k) {
                    let name = indexed_name(view, tag)?;
                    start_move(out, tag, true, &name, false, &name);
                }
            }
        }
        r.scan = if page.len() < FOLD_SLICE {
            None
        } else {
            Some((1, page.last().map(|(k, _)| k.clone())))
        };
    }
    out.put(key::of(key::RESIDE), r.bytes());
    Ok(true)
}

/// Whether the entries write the move queue (`MOVING`) or the re-siding state (`RESIDE`): (moves, re-siding).
pub fn wakes<'a>(keys: impl IntoIterator<Item = &'a Vec<u8>>) -> (bool, bool) {
    let (mp, rp) = (key::of(key::MOVING), key::of(key::RESIDE));
    let mut w = (false, false);
    for k in keys {
        w.0 |= k.starts_with(&mp);
        w.1 |= k.starts_with(&rp);
    }
    w
}
