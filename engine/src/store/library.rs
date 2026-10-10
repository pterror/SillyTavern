//! The library: characters, groups and tags as entities, their values, and what the list is read from.
//!
//! Every character and group is in the orders of each scope it belongs to: the whole library, each tag it
//! carries, and (a character) the lorebook its card names. Within a scope, each order is split by the entity's
//! type and fav bit, so a filter on either, or sorting favourites first, reads at most four orders and merges
//! them. An order's key is the sort key, then the tie upstream breaks it with (a character's avatar, a group's
//! `<id>.json`); characters sort before groups on equal keys, which the reader does when merging.
//!
//! Each (scope, type, fav) also numbers its entities densely from 0 (a removal moves the last number into the
//! hole), so a random order is a permutation of the numbers and needs no per-seed data.
//!
//! A tag merged into another stays in the orders until its carriers are moved: readers of the target take the
//! merged tags' orders too (`MERGED_INTO`), and `FOLD` lists the tags whose carriers wait to move.

use super::StoreError;
use super::derive::{Deriver, Loc, Out, View};
use super::kinds::{
    bytes, dead, drop_text, field, id, key, loc_bytes, parse_loc, text_value, version,
};
use crate::keyspace::val::{counter_value, get_bytes, get_u64, put_bytes, put_u64};
use crate::log::format::{FieldRef, Record, Value, get_uvarint, put_uvarint};
use unicode_normalization::UnicodeNormalization;

/// Entity types.
pub const CHARACTER: u64 = 0;
pub const GROUP: u64 = 1;
pub const TAG: u64 = 2;

/// Field codes the derivers read: an entity's name, a character's lorebook, a tag's folder type.
pub const NAME: u64 = 1;
pub const WORLD: u64 = 4;
pub const FOLDER_TYPE: u64 = 40;

/// A list item's text is the text value of field `ITEM_BASE + item * LISTS + list`.
pub const ITEM_BASE: u64 = 1024;
pub const LISTS: u64 = 8;

pub fn item_field(list: u64, item: u64) -> FieldRef {
    FieldRef::Code(ITEM_BASE + item * LISTS + list)
}

/// Sort keys, in `State::nums` from `CREATED` on.
pub const BY_NAME: u64 = 0;
pub const CREATED: u64 = 1;
pub const ADDED: u64 = 2;
pub const LAST_CHAT: u64 = 3;
pub const CHAT_SIZE: u64 = 4;
pub const DATA: u64 = 5;
pub const SORTS: u64 = 6;

/// `cardHash` kinds.
pub const HASH_IDENTITY: u64 = 0;
pub const HASH_CONTENT: u64 = 1;
pub const HASH_AVATAR: u64 = 2;
pub const HASH_AVATAR_IDENTITY: u64 = 3;

/// A set of entities with its own orders.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Scope {
    All,
    Tag(u64),
    World(Vec<u8>),
}

impl Scope {
    pub fn put(&self, k: &mut Vec<u8>) {
        match self {
            Scope::All => put_u64(k, 0),
            Scope::Tag(t) => {
                put_u64(k, 1);
                put_u64(k, *t);
            }
            Scope::World(w) => {
                put_u64(k, 2);
                put_bytes(k, w);
            }
        }
    }
}

/// What places a character or group in the orders.
#[derive(Debug, Clone, PartialEq)]
pub struct State {
    pub kind: u64,
    pub tie: Vec<u8>,
    pub fav: bool,
    /// The folded name.
    pub name: Vec<u8>,
    /// Sort keys `CREATED..SORTS`; None sorts below every number.
    pub nums: [Option<f64>; 5],
    pub tags: Vec<u64>,
    pub world: Option<Vec<u8>>,
}

impl State {
    pub fn scopes(&self) -> Vec<Scope> {
        let mut s = vec![Scope::All];
        s.extend(self.tags.iter().map(|t| Scope::Tag(*t)));
        if let Some(w) = &self.world {
            s.push(Scope::World(w.clone()));
        }
        s
    }

    pub fn sort_key(&self, sort: u64) -> Vec<u8> {
        let mut k = Vec::new();
        if sort == BY_NAME {
            put_bytes(&mut k, &self.name);
        } else {
            num_key(&mut k, self.nums[(sort - 1) as usize]);
        }
        k
    }
}

/// A number as bytes that sort as it does, None first; -0 as 0.
pub fn num_key(k: &mut Vec<u8>, v: Option<f64>) {
    match v {
        None => k.push(0),
        Some(v) => {
            k.push(1);
            let v = if v == 0.0 { 0.0 } else { v };
            let b = v.to_bits();
            let b = if b >> 63 == 1 { !b } else { b | 1 << 63 };
            k.extend_from_slice(&b.to_be_bytes());
        }
    }
}

/// The name as the list sorts it: lower case, compatibility-decomposed, U+0300–U+036F dropped.
pub fn fold_name(name: &[u8]) -> Vec<u8> {
    let s = String::from_utf8_lossy(name);
    s.to_lowercase()
        .nfkd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect::<String>()
        .into_bytes()
}

pub fn order_prefix(scope: &Scope, sort: u64, kind: u64, fav: bool) -> Vec<u8> {
    let mut k = key::of(key::ORDER);
    scope.put(&mut k);
    put_u64(&mut k, sort);
    put_u64(&mut k, kind);
    put_u64(&mut k, u64::from(fav));
    k
}

fn order_key(scope: &Scope, sort: u64, st: &State) -> Vec<u8> {
    let mut k = order_prefix(scope, sort, st.kind, st.fav);
    k.extend_from_slice(&st.sort_key(sort));
    put_bytes(&mut k, &st.tie);
    k
}

/// An order key's sort key and tie, after its prefix.
pub fn split_order_key(rest: &[u8], sort: u64) -> Option<(Vec<u8>, Vec<u8>)> {
    let mut at = 0;
    if sort == BY_NAME {
        get_bytes(rest, &mut at)?;
    } else {
        at = match rest.first()? {
            0 => 1,
            _ => 9,
        };
    }
    let sk = rest.get(..at)?.to_vec();
    let tie = get_bytes(rest, &mut at)?;
    (at == rest.len()).then_some((sk, tie))
}

pub fn rand_prefix(scope: &Scope, kind: u64, fav: bool) -> Vec<u8> {
    let mut k = key::of(key::RAND);
    scope.put(&mut k);
    put_u64(&mut k, kind);
    put_u64(&mut k, u64::from(fav));
    k
}

pub fn rand_key(scope: &Scope, kind: u64, fav: bool, n: u64) -> Vec<u8> {
    let mut k = rand_prefix(scope, kind, fav);
    put_u64(&mut k, n);
    k
}

fn rand_at_key(scope: &Scope, e: u64) -> Vec<u8> {
    let mut k = key::of(key::RAND_AT);
    scope.put(&mut k);
    put_u64(&mut k, e);
    k
}

pub fn count_key(scope: &Scope, kind: u64, fav: bool) -> Vec<u8> {
    let mut k = key::of(key::COUNT);
    scope.put(&mut k);
    put_u64(&mut k, kind);
    put_u64(&mut k, u64::from(fav));
    k
}

pub fn entity_key_key(kind: u64, k: &[u8]) -> Vec<u8> {
    let mut out = key::id(key::ENTITY_KEY, kind);
    put_bytes(&mut out, k);
    out
}

pub fn hash_index_prefix(which: u64, hash: &[u8]) -> Vec<u8> {
    let mut k = key::id(key::HASH_INDEX, which);
    put_bytes(&mut k, hash);
    k
}

pub fn uvarint(v: u64) -> Vec<u8> {
    let mut out = Vec::new();
    put_uvarint(&mut out, v);
    out
}

pub fn parse_uvarint(b: &[u8]) -> Result<u64, StoreError> {
    let mut at = 0;
    let v = get_uvarint(b, &mut at).map_err(|_| entry_err("a number entry doesn't decode"))?;
    if at != b.len() {
        return Err(entry_err("a number entry has bytes left over"));
    }
    Ok(v)
}

fn entry_err(why: &str) -> StoreError {
    StoreError::Entry(why.into())
}

pub fn counter(view: &View, k: &[u8]) -> Result<i64, StoreError> {
    match view.get(k)? {
        Some(b) => counter_value(&b).ok_or_else(|| entry_err("a counter doesn't decode")),
        None => Ok(0),
    }
}

/// The record a pointer entry points at.
fn pointed(view: &View, k: &[u8]) -> Result<Option<(Loc, Record)>, StoreError> {
    let Some(b) = view.get(k)? else {
        return Ok(None);
    };
    let l = parse_loc(&b)?;
    let (rec, _) = view.record(l.pos)?;
    Ok(Some((l, rec)))
}

/// An entity's type, key and date added.
pub fn entity_info(view: &View, e: u64) -> Result<Option<(u64, Vec<u8>, i64)>, StoreError> {
    Ok(pointed(view, &key::id(key::ENTITY, e))?.map(|(_, rec)| {
        let added = match rec.values[3] {
            Value::Time(t) => t,
            _ => unreachable!("checked by Record::new"),
        };
        (id(&rec, 1), bytes(&rec, 2).to_vec(), added)
    }))
}

pub fn entity_by_key(view: &View, kind: u64, k: &[u8]) -> Result<Option<u64>, StoreError> {
    view.get(&entity_key_key(kind, k))?
        .map(|b| parse_uvarint(&b))
        .transpose()
}

/// The tags an entity carries as stored (merged tags not resolved), in id order.
pub fn tags_of(view: &View, e: u64) -> Result<Vec<u64>, StoreError> {
    let start = key::id(key::MEMBER_OF, e);
    let end = key::prefix_end(&start);
    view.scan(&start, &end, usize::MAX)?
        .into_iter()
        .map(|(k, _)| {
            let mut at = start.len();
            get_u64(&k, &mut at).ok_or_else(|| entry_err("a membership key doesn't decode"))
        })
        .collect()
}

pub fn fav_of(view: &View, e: u64) -> Result<bool, StoreError> {
    Ok(pointed(view, &key::id(key::FAV, e))?.is_some_and(|(_, r)| r.values[1] == Value::Bit(true)))
}

/// The state a character or group is placed by, as it is in `view`; None for anything else.
pub fn state(view: &View, e: u64) -> Result<Option<State>, StoreError> {
    let Some((kind, k, added)) = entity_info(view, e)? else {
        return Ok(None);
    };
    state_of(view, e, kind, k, added)
}

fn state_of(
    view: &View,
    e: u64,
    kind: u64,
    k: Vec<u8>,
    added: i64,
) -> Result<Option<State>, StoreError> {
    if kind != CHARACTER && kind != GROUP {
        return Ok(None);
    }
    let world = if kind == CHARACTER {
        text_value(view, e, &FieldRef::Code(WORLD))?.filter(|w| !w.is_empty())
    } else {
        None
    };
    let mut nums = [None; 5];
    for (sort, n) in (CREATED..SORTS).zip(nums.iter_mut()) {
        *n = sort_num(view, e, kind, Some(added), sort)?;
    }
    Ok(Some(State {
        kind,
        tie: tie(kind, k),
        fav: fav_of(view, e)?,
        name: folded_name(view, e)?,
        nums,
        tags: tags_of(view, e)?,
        world,
    }))
}

/// What breaks ties in a character's or group's orders: a character's avatar, a group's `<id>.json`.
fn tie(kind: u64, mut k: Vec<u8>) -> Vec<u8> {
    if kind == GROUP {
        k.extend_from_slice(b".json");
    }
    k
}

fn folded_name(view: &View, e: u64) -> Result<Vec<u8>, StoreError> {
    Ok(text_value(view, e, &FieldRef::Code(NAME))?
        .map(|n| fold_name(&n))
        .unwrap_or_default())
}

/// A character's or group's value of a numeric sort key (`CREATED..SORTS`); None sorts below every number.
/// `added` is its date added, read here when the key needs it and it isn't given.
pub fn sort_num(
    view: &View,
    e: u64,
    kind: u64,
    added: Option<i64>,
    sort: u64,
) -> Result<Option<f64>, StoreError> {
    let added = || -> Result<Option<f64>, StoreError> {
        Ok(match added {
            Some(a) => Some(a as f64),
            None => entity_info(view, e)?.map(|(_, _, a)| a as f64),
        })
    };
    Ok(match sort {
        CREATED | ADDED if kind == GROUP => added()?,
        ADDED => added()?,
        CREATED => match pointed(view, &key::id(key::CREATE_DATE, e))? {
            Some((_, r)) => match r.values[1] {
                Value::F64(v) => Some(v),
                _ => None,
            },
            None => None,
        },
        DATA if kind == GROUP => None,
        DATA => Some(match pointed(view, &key::id(key::DATA_SIZE, e))? {
            Some((_, r)) => id(&r, 1) as f64,
            None => 0.0,
        }),
        _ => Some(0.0),
    })
}

/// A character's or group's type, sort key and tie.
pub type Placement = (u64, Vec<u8>, Vec<u8>);

/// Where a character or group sits in the orders of `sort`: its type, sort key and tie, reading only what that
/// order needs. None for anything else.
pub fn sort_place(view: &View, e: u64, sort: u64) -> Result<Option<Placement>, StoreError> {
    let Some((kind, k, added)) = entity_info(view, e)? else {
        return Ok(None);
    };
    if kind != CHARACTER && kind != GROUP {
        return Ok(None);
    }
    let mut sk = Vec::new();
    if sort == BY_NAME {
        put_bytes(&mut sk, &folded_name(view, e)?);
    } else {
        num_key(&mut sk, sort_num(view, e, kind, Some(added), sort)?);
    }
    Ok(Some((kind, sk, tie(kind, k))))
}

/// Moves the entity's entries in every order, numbering and count from `old` to `new`.
pub fn reposition(
    view: &View,
    out: &mut Out,
    e: u64,
    old: Option<&State>,
    new: Option<&State>,
) -> Result<(), StoreError> {
    let mut scopes: Vec<Scope> = Vec::new();
    for st in [old, new].into_iter().flatten() {
        for s in st.scopes() {
            if !scopes.contains(&s) {
                scopes.push(s);
            }
        }
    }
    let ev = uvarint(e);
    for s in &scopes {
        let o = old.filter(|st| st.scopes().contains(s));
        let n = new.filter(|st| st.scopes().contains(s));
        for sort in 0..SORTS {
            let ok = o.map(|st| order_key(s, sort, st));
            let nk = n.map(|st| order_key(s, sort, st));
            if ok == nk {
                continue;
            }
            if let Some(ok) = ok {
                out.del(ok);
            }
            if let Some(nk) = nk {
                out.put(nk, ev.clone());
            }
        }
        let op = o.map(|st| (st.kind, st.fav));
        let np = n.map(|st| (st.kind, st.fav));
        if op == np {
            continue;
        }
        if let Some((kind, fav)) = op {
            out.add(count_key(s, kind, fav), -1);
            if !view.is_bulk() {
                unnumber(view, out, s, kind, fav, e)?;
            }
        }
        if let Some((kind, fav)) = np {
            let ck = count_key(s, kind, fav);
            if !view.is_bulk() {
                let n = counter(view, &ck)?;
                out.put(rand_key(s, kind, fav, n as u64), ev.clone());
                out.put(rand_at_key(s, e), uvarint(n as u64));
            }
            out.add(ck, 1);
        }
    }
    Ok(())
}

/// Takes `e` out of the numbering of (s, kind, fav): the last number moves into its place.
fn unnumber(
    view: &View,
    out: &mut Out,
    s: &Scope,
    kind: u64,
    fav: bool,
    e: u64,
) -> Result<(), StoreError> {
    let at = rand_at_key(s, e);
    let n = parse_uvarint(
        &view
            .get(&at)?
            .ok_or_else(|| entry_err("an ordered entity has no number"))?,
    )?;
    let size = counter(view, &count_key(s, kind, fav))?;
    let last = u64::try_from(size - 1).map_err(|_| entry_err("a numbering is empty"))?;
    if n != last {
        let lk = rand_key(s, kind, fav, last);
        let moved = parse_uvarint(
            &view
                .get(&lk)?
                .ok_or_else(|| entry_err("a numbering has a hole"))?,
        )?;
        out.put(rand_key(s, kind, fav, n), uvarint(moved));
        out.put(rand_at_key(s, moved), uvarint(n));
    }
    out.del(rand_key(s, kind, fav, last));
    out.del(at);
    Ok(())
}

/// Repositions `e` (if it is a character or group) for a change `f` makes to its state.
pub fn change(
    view: &View,
    out: &mut Out,
    e: u64,
    f: impl FnOnce(&mut State),
) -> Result<(), StoreError> {
    let Some(old) = state(view, e)? else {
        return Ok(());
    };
    let mut new = old.clone();
    f(&mut new);
    if new != old {
        reposition(view, out, e, Some(&old), Some(&new))?;
    }
    Ok(())
}

/// Whether a text field's value places the entity in the orders.
pub fn places(f: &FieldRef) -> bool {
    matches!(f, FieldRef::Code(NAME | WORLD))
}

/// A change to a text field's value: the name and lorebook place the entity.
pub fn text_changed(
    view: &View,
    out: &mut Out,
    e: u64,
    f: &FieldRef,
    new: Option<&[u8]>,
) -> Result<(), StoreError> {
    match f {
        FieldRef::Code(NAME) => change(view, out, e, |st| {
            st.name = new.map(fold_name).unwrap_or_default();
        }),
        FieldRef::Code(WORLD) => change(view, out, e, |st| {
            if st.kind == CHARACTER {
                st.world = new.filter(|w| !w.is_empty()).map(<[u8]>::to_vec);
            }
        }),
        _ => Ok(()),
    }
}

/// The tag a tag's carriers belong to: itself, or where its merges lead (None: nowhere).
pub fn resolve_tag(view: &View, tag: u64) -> Result<Option<u64>, StoreError> {
    let mut t = tag;
    for _ in 0..1024 {
        let Some((_, rec)) = pointed(view, &key::id(key::MERGE, t))? else {
            return Ok(Some(t));
        };
        match rec.values[1] {
            Value::Id(into) => t = into,
            _ => return Ok(None),
        }
    }
    Err(entry_err("tag merges form a cycle"))
}

/// The tags whose orders a read of `tag`'s takes: itself and every tag merged into it whose carriers haven't
/// moved yet. Empty when `tag` itself is merged away.
pub fn tag_sources(view: &View, tag: u64) -> Result<Vec<u64>, StoreError> {
    if view.get(&key::id(key::MERGE, tag))?.is_some() {
        return Ok(Vec::new());
    }
    let mut out = vec![tag];
    let mut i = 0;
    while i < out.len() {
        let start = key::id(key::MERGED_INTO, out[i]);
        let end = key::prefix_end(&start);
        for (k, _) in view.scan(&start, &end, usize::MAX)? {
            let mut at = start.len();
            let t = get_u64(&k, &mut at).ok_or_else(|| entry_err("a merge key doesn't decode"))?;
            if !out.contains(&t) {
                out.push(t);
            }
        }
        i += 1;
    }
    Ok(out)
}

// ---- derivers ----

/// Values committed for the entity before its create (in the same commit) place it in the orders once, with
/// them; a create first places it with none, then moves it.
pub struct EntityCreate;

impl Deriver for EntityCreate {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (e, kind, k) = (id(rec, 0), id(rec, 1), bytes(rec, 2));
        let added = match rec.values[3] {
            Value::Time(t) => t,
            _ => unreachable!("checked by Record::new"),
        };
        if kind > TAG {
            return Err(StoreError::Refused(format!("no entity type {kind}")));
        }
        if view.get(&key::id(key::ENTITY, e))?.is_some() {
            return Err(StoreError::Refused(format!("entity {e} exists")));
        }
        let kk = entity_key_key(kind, k);
        if view.get(&kk)?.is_some() {
            return Err(StoreError::Refused(format!(
                "an entity of type {kind} has that key already"
            )));
        }
        if let Some(st) = state_of(view, e, kind, k.to_vec(), added)? {
            reposition(view, out, e, None, Some(&st))?;
        }
        out.put(key::id(key::ENTITY, e), loc_bytes(at));
        out.put(kk, uvarint(e));
        out.max(key::of(key::NEXT_ENTITY), e + 1);
        version(out, e, at);
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        live_at(view, &key::id(key::ENTITY, id(rec, 0)), pos)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_at(view, out, &key::id(key::ENTITY, id(rec, 0)), from, to)
    }
}

/// The `entityCreate` or latest `entityUpdate` record is the entity's: `entity_info` reads its type, key and date
/// added from it.
pub struct EntityUpdate;

impl Deriver for EntityUpdate {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (e, kind, k) = (id(rec, 0), id(rec, 1), bytes(rec, 2));
        let added = match rec.values[3] {
            Value::Time(t) => t,
            _ => unreachable!("checked by Record::new"),
        };
        let Some((old_kind, old_k, old_added)) = entity_info(view, e)? else {
            return Err(StoreError::Refused(format!("no entity {e}")));
        };
        if kind != old_kind {
            return Err(StoreError::Refused(format!(
                "entity {e} is of type {old_kind}, not {kind}"
            )));
        }
        if k != old_k.as_slice() {
            let kk = entity_key_key(kind, k);
            if view.get(&kk)?.is_some() {
                return Err(StoreError::Refused(format!(
                    "an entity of type {kind} has that key already"
                )));
            }
            out.del(entity_key_key(kind, &old_k));
            out.put(kk, uvarint(e));
        }
        let old = state_of(view, e, kind, old_k, old_added)?;
        let new = state_of(view, e, kind, k.to_vec(), added)?;
        if old != new {
            reposition(view, out, e, old.as_ref(), new.as_ref())?;
        }
        let ek = key::id(key::ENTITY, e);
        if let Some(b) = view.get(&ek)? {
            dead(out, parse_loc(&b)?);
        }
        out.put(ek, loc_bytes(at));
        version(out, e, at);
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        live_at(view, &key::id(key::ENTITY, id(rec, 0)), pos)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_at(view, out, &key::id(key::ENTITY, id(rec, 0)), from, to)
    }
}

fn live_at(view: &View, k: &[u8], pos: u64) -> Result<bool, StoreError> {
    Ok(view
        .get(k)?
        .map(|b| parse_loc(&b))
        .transpose()?
        .is_some_and(|l| l.pos == pos))
}

fn repoint_at(view: &View, out: &mut Out, k: &[u8], from: u64, to: Loc) -> Result<(), StoreError> {
    if live_at(view, k, from)? {
        out.put(k.to_vec(), loc_bytes(to));
    }
    Ok(())
}

/// Every pointer entry under `prefix` dies with its record.
fn drop_pointers(
    view: &View,
    out: &mut Out,
    prefix: &[u8],
) -> Result<Vec<(Vec<u8>, Loc)>, StoreError> {
    let end = key::prefix_end(prefix);
    let mut found = Vec::new();
    for (k, v) in view.scan(prefix, &end, usize::MAX)? {
        let l = parse_loc(&v)?;
        dead(out, l);
        out.del(k.clone());
        found.push((k, l));
    }
    Ok(found)
}

pub struct EntityDelete;

impl Deriver for EntityDelete {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let e = id(rec, 0);
        let Some((kind, k, _)) = entity_info(view, e)? else {
            return Err(StoreError::Refused(format!("no entity {e}")));
        };
        if kind == TAG && view.get(&key::id(key::MERGE, e))?.is_none() {
            return Err(StoreError::Refused(format!(
                "tag {e} goes with a tagMerge first"
            )));
        }
        dead(out, at);
        if let Some(st) = state(view, e)? {
            reposition(view, out, e, Some(&st), None)?;
            for tag in &st.tags {
                let mk = key::ids(key::MEMBER, *tag, e);
                if let Some(b) = view.get(&mk)? {
                    dead(out, parse_loc(&b)?);
                }
                out.del(mk);
                out.del(key::ids(key::MEMBER_OF, e, *tag));
                out.add(key::id(key::MEMBER_COUNT, *tag), -1);
                out.map(key::member_block(*tag, e), vec![(key::member_slot(e), 0)]);
            }
        }
        // Text values (list items' included), then the rest of what the entity holds.
        let start = key::id(key::TEXT, e);
        let end = key::prefix_end(&start);
        for (tk, _) in view.scan(&start, &end, usize::MAX)? {
            let f = field_after(&tk, key::TEXT)?;
            drop_text(view, out, e, &f)?;
        }
        for s in [
            key::VALUE,
            key::ITEM_AT,
            key::DATA_SIZE,
            key::CREATE_DATE,
            key::FAV,
        ] {
            if s == key::ITEM_AT {
                let p = key::id(s, e);
                let pend = key::prefix_end(&p);
                for (ik, v) in view.scan(&p, &pend, usize::MAX)? {
                    let (_, l) = parse_place(&v)?;
                    dead(out, l);
                    out.del(ik);
                }
                continue;
            }
            drop_pointers(view, out, &key::id(s, e))?;
        }
        let ip = key::id(key::ITEM, e);
        for (ik, _) in view.scan(&ip, &key::prefix_end(&ip), usize::MAX)? {
            out.del(ik);
        }
        let hp = key::id(key::HASH, e);
        for (hk, v) in view.scan(&hp, &key::prefix_end(&hp), usize::MAX)? {
            let l = parse_loc(&v)?;
            let (r, _) = view.record(l.pos)?;
            if let Value::Bytes(h) = &r.values[2] {
                let mut ik = hash_index_prefix(id(&r, 1), h);
                put_u64(&mut ik, e);
                out.del(ik);
            }
            dead(out, l);
            out.del(hk);
        }
        drop_pointers(view, out, &key::id(key::ENTITY, e))?;
        out.del(entity_key_key(kind, &k));
        out.del(key::id(key::VERSION, e));
        Ok(())
    }

    fn is_live(&self, _: &Record, _: u64, _: &View) -> Result<bool, StoreError> {
        Ok(false)
    }

    fn repoint(&self, _: &Record, _: u64, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Ok(())
    }
}

/// The field of a `key::field` key, after its entity.
fn field_of_key(k: &[u8], entity_end: usize) -> Result<FieldRef, StoreError> {
    let mut at = entity_end;
    let bad = || entry_err("a field key doesn't decode");
    get_u64(k, &mut at).ok_or_else(bad)?;
    match k.get(at) {
        Some(1) => {
            at += 1;
            Ok(FieldRef::Code(get_u64(k, &mut at).ok_or_else(bad)?))
        }
        Some(2) => {
            at += 1;
            Ok(FieldRef::Key(get_bytes(k, &mut at).ok_or_else(bad)?))
        }
        _ => Err(bad()),
    }
}

/// The field of a `key::field` key whose structure prefix is `structure`.
pub fn field_after(k: &[u8], structure: u64) -> Result<FieldRef, StoreError> {
    field_of_key(k, key::of(structure).len())
}

pub struct JsonValue;

impl Deriver for JsonValue {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (e, f) = (id(rec, 0), field(rec, 1));
        if drop_text(view, out, e, f)?.is_some() {
            text_changed(view, out, e, f, None)?;
        }
        let k = key::field(key::VALUE, e, f);
        if let Some(b) = view.get(&k)? {
            dead(out, parse_loc(&b)?);
        }
        out.put(k, loc_bytes(at));
        version(out, e, at);
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        live_at(
            view,
            &key::field(key::VALUE, id(rec, 0), field(rec, 1)),
            pos,
        )
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_at(
            view,
            out,
            &key::field(key::VALUE, id(rec, 0), field(rec, 1)),
            from,
            to,
        )
    }
}

/// Clears a value of `json` kind from (e, f) before a text value takes its place.
pub fn drop_json(view: &View, out: &mut Out, e: u64, f: &FieldRef) -> Result<(), StoreError> {
    let k = key::field(key::VALUE, e, f);
    if let Some(b) = view.get(&k)? {
        dead(out, parse_loc(&b)?);
        out.del(k);
    }
    Ok(())
}

pub struct ValueDelete;

impl Deriver for ValueDelete {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (e, f) = (id(rec, 0), field(rec, 1));
        dead(out, at);
        if drop_text(view, out, e, f)?.is_some() {
            text_changed(view, out, e, f, None)?;
        }
        drop_json(view, out, e, f)?;
        version(out, e, at);
        Ok(())
    }

    fn is_live(&self, _: &Record, _: u64, _: &View) -> Result<bool, StoreError> {
        Ok(false)
    }

    fn repoint(&self, _: &Record, _: u64, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Ok(())
    }
}

fn item_key(e: u64, list: u64, position: u64) -> Vec<u8> {
    let mut k = key::ids(key::ITEM, e, list);
    put_u64(&mut k, position);
    k
}

fn item_at_key(e: u64, list: u64, item: u64) -> Vec<u8> {
    let mut k = key::ids(key::ITEM_AT, e, list);
    put_u64(&mut k, item);
    k
}

fn place_bytes(position: u64, l: Loc) -> Vec<u8> {
    let mut b = uvarint(position);
    b.extend_from_slice(&loc_bytes(l));
    b
}

fn parse_place(b: &[u8]) -> Result<(u64, Loc), StoreError> {
    let mut at = 0;
    let bad = || entry_err("an item place doesn't decode");
    let p = get_uvarint(b, &mut at).map_err(|_| bad())?;
    Ok((p, parse_loc(b.get(at..).ok_or_else(bad)?)?))
}

pub struct ItemPlace;

impl Deriver for ItemPlace {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (e, list, item, position) = (id(rec, 0), id(rec, 1), id(rec, 2), id(rec, 3));
        if list >= LISTS {
            return Err(StoreError::Refused(format!("no list {list}")));
        }
        let ik = item_key(e, list, position);
        if let Some(b) = view.get(&ik)?
            && parse_uvarint(&b)? != item
        {
            return Err(StoreError::Refused(format!(
                "position {position} of list {list} holds another item"
            )));
        }
        let ak = item_at_key(e, list, item);
        if let Some(b) = view.get(&ak)? {
            let (p, l) = parse_place(&b)?;
            dead(out, l);
            out.del(item_key(e, list, p));
        }
        out.put(ik, uvarint(item));
        out.put(ak, place_bytes(position, at));
        version(out, e, at);
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        let ak = item_at_key(id(rec, 0), id(rec, 1), id(rec, 2));
        Ok(match view.get(&ak)? {
            Some(b) => parse_place(&b)?.1.pos == pos,
            None => false,
        })
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        let ak = item_at_key(id(rec, 0), id(rec, 1), id(rec, 2));
        if let Some(b) = view.get(&ak)? {
            let (p, l) = parse_place(&b)?;
            if l.pos == from {
                out.put(ak, place_bytes(p, to));
            }
        }
        Ok(())
    }
}

pub struct ItemDelete;

impl Deriver for ItemDelete {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (e, list, item) = (id(rec, 0), id(rec, 1), id(rec, 2));
        dead(out, at);
        let ak = item_at_key(e, list, item);
        if let Some(b) = view.get(&ak)? {
            let (p, l) = parse_place(&b)?;
            dead(out, l);
            out.del(item_key(e, list, p));
            out.del(ak);
        }
        drop_text(view, out, e, &item_field(list, item))?;
        version(out, e, at);
        Ok(())
    }

    fn is_live(&self, _: &Record, _: u64, _: &View) -> Result<bool, StoreError> {
        Ok(false)
    }

    fn repoint(&self, _: &Record, _: u64, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Ok(())
    }
}

/// `dataSize`, `createDate`: the record is the entity's sort key.
pub struct SortValue(pub u64);

impl SortValue {
    fn key(&self, e: u64) -> Vec<u8> {
        key::id(
            if self.0 == DATA {
                key::DATA_SIZE
            } else {
                key::CREATE_DATE
            },
            e,
        )
    }
}

impl Deriver for SortValue {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let e = id(rec, 0);
        let v = match rec.values[1] {
            Value::UInt(n) => Some(n as f64),
            Value::F64(x) => Some(x),
            _ => None,
        };
        let sort = self.0;
        change(view, out, e, |st| {
            if st.kind == CHARACTER {
                st.nums[(sort - 1) as usize] = v;
            }
        })?;
        let k = self.key(e);
        if let Some(b) = view.get(&k)? {
            dead(out, parse_loc(&b)?);
        }
        out.put(k, loc_bytes(at));
        version(out, e, at);
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        live_at(view, &self.key(id(rec, 0)), pos)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_at(view, out, &self.key(id(rec, 0)), from, to)
    }
}

pub struct CardHash;

fn hash_of(rec: &Record) -> Option<&[u8]> {
    match &rec.values[2] {
        Value::Bytes(h) => Some(h),
        _ => None,
    }
}

impl Deriver for CardHash {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (e, which) = (id(rec, 0), id(rec, 1));
        let k = key::ids(key::HASH, e, which);
        if let Some((l, old)) = pointed(view, &k)? {
            dead(out, l);
            if let Some(h) = hash_of(&old) {
                let mut ik = hash_index_prefix(which, h);
                put_u64(&mut ik, e);
                out.del(ik);
            }
        }
        if let Some(h) = hash_of(rec) {
            let mut ik = hash_index_prefix(which, h);
            put_u64(&mut ik, e);
            out.put(ik, Vec::new());
        }
        out.put(k, loc_bytes(at));
        version(out, e, at);
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        live_at(view, &key::ids(key::HASH, id(rec, 0), id(rec, 1)), pos)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_at(
            view,
            out,
            &key::ids(key::HASH, id(rec, 0), id(rec, 1)),
            from,
            to,
        )
    }
}

pub struct TagMerge;

impl Deriver for TagMerge {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let tag = id(rec, 0);
        let mk = key::id(key::MERGE, tag);
        if view.get(&mk)?.is_some() {
            return Err(StoreError::Refused(format!("tag {tag} is merged already")));
        }
        let target = match rec.values[1] {
            Value::Id(into) => resolve_tag(view, into)?,
            _ => None,
        };
        if target == Some(tag) {
            return Err(StoreError::Refused(format!(
                "tag {tag} can't merge into itself"
            )));
        }
        out.put(mk, loc_bytes(at));
        if counter(view, &key::id(key::MEMBER_COUNT, tag))? > 0 {
            out.put(key::id(key::FOLD, tag), Vec::new());
            if let Some(t) = target {
                out.put(key::ids(key::MERGED_INTO, t, tag), Vec::new());
            }
        }
        // Tags merged into this one whose carriers haven't moved now lead to the target.
        let start = key::id(key::MERGED_INTO, tag);
        for (k, _) in view.scan(&start, &key::prefix_end(&start), usize::MAX)? {
            let mut a = start.len();
            let from =
                get_u64(&k, &mut a).ok_or_else(|| entry_err("a merge key doesn't decode"))?;
            out.del(k);
            if let Some(t) = target {
                out.put(key::ids(key::MERGED_INTO, t, from), Vec::new());
            }
        }
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        live_at(view, &key::id(key::MERGE, id(rec, 0)), pos)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_at(view, out, &key::id(key::MERGE, id(rec, 0)), from, to)
    }
}

/// Carriers moved per step of a fold.
pub const FOLD_SLICE: usize = 256;

/// Moves up to `FOLD_SLICE` carriers of the first tag waiting for its fold to the tag it merged into (or drops
/// them, when it merged into none); once the tag has none left, readers stop taking its orders. Returns whether
/// any fold is left.
pub fn fold_step(view: &View, out: &mut Out) -> Result<bool, StoreError> {
    let fp = key::of(key::FOLD);
    let Some((fk, _)) = view.scan(&fp, &key::prefix_end(&fp), 1)?.into_iter().next() else {
        return Ok(false);
    };
    let mut at = fp.len();
    let tag = get_u64(&fk, &mut at).ok_or_else(|| entry_err("a fold key doesn't decode"))?;
    let target = resolve_tag(view, tag)?;
    let start = key::id(key::MEMBER, tag);
    let carriers = view.scan(&start, &key::prefix_end(&start), FOLD_SLICE)?;
    let mut local = std::collections::BTreeMap::new();
    for (mk, v) in &carriers {
        let mut at = start.len();
        let e = get_u64(mk, &mut at).ok_or_else(|| entry_err("a membership key doesn't decode"))?;
        let l = parse_loc(v)?;
        let mut layers = vec![super::derive::Layer::Sorted(&local)];
        layers.extend(view.layers.iter().copied());
        let lv = View {
            layers,
            pending: view.pending.clone(),
            staged: view.staged,
            bulk: view.bulk,
            ks: view.ks,
            snap: view.snap,
            log: view.log,
        };
        let mut o = Out::default();
        let old = state(&lv, e)?;
        o.del(mk.clone());
        o.del(key::ids(key::MEMBER_OF, e, tag));
        o.add(key::id(key::MEMBER_COUNT, tag), -1);
        o.map(key::member_block(tag, e), vec![(key::member_slot(e), 0)]);
        let mut added = None;
        match target {
            Some(t) if lv.get(&key::ids(key::MEMBER, t, e))?.is_none() => {
                super::kinds::assign(&mut o, e, t, l, false);
                added = Some(t);
            }
            _ => dead(&mut o, l),
        }
        if let Some(old) = old {
            let mut new = old.clone();
            new.tags.retain(|t| *t != tag);
            if let Some(t) = added {
                new.tags.push(t);
                new.tags.sort_unstable();
            }
            reposition(&lv, &mut o, e, Some(&old), Some(&new))?;
        }
        drop(lv);
        o.apply(&mut local);
    }
    if carriers.len() < FOLD_SLICE {
        local.insert(fk, crate::keyspace::val::Val::Del);
        if let Some(t) = target {
            local.insert(
                key::ids(key::MERGED_INTO, t, tag),
                crate::keyspace::val::Val::Del,
            );
        }
    }
    out.entries.extend(local);
    Ok(true)
}

pub fn deriver(kind: &str) -> Option<&'static dyn Deriver> {
    Some(match kind {
        "entityCreate" => &EntityCreate,
        "entityDelete" => &EntityDelete,
        "jsonValue" => &JsonValue,
        "valueDelete" => &ValueDelete,
        "itemPlace" => &ItemPlace,
        "itemDelete" => &ItemDelete,
        "dataSize" => &SortValue(DATA),
        "createDate" => &SortValue(CREATED),
        "cardHash" => &CardHash,
        "tagMerge" => &TagMerge,
        "entityUpdate" => &EntityUpdate,
        _ => return None,
    })
}
