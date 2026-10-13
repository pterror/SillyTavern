//! Tag definitions as the tag manager lists them: each live tag's place (its folded name, folder type and manual
//! sort order), its orders for the manager's three sorts, counts per part, and the change feeds.
//!
//! A tag is an entity of type `TAG`; its name is the text of field `NAME`, its folder type that of
//! `FOLDER_TYPE` (or that field's JSON, for a value that isn't a string), and its manual sort order the number its
//! `tagOrder` record holds: upstream's coercion of the stored `sort_order` (JavaScript's `Number()`), which the
//! writer computes and records whenever it changes, as it does a card's create date.
//!
//! Orders, each split by the folder bit (folder type present and not `NONE`) and the used bit (carried by at
//! least one entity), so the manager's `folders` and `used` filters are parts as fav and type are for
//! characters:
//! - alphabetical: the folded name's bytes, then the id;
//! - by entries: carriers, most first, then the folded name, then the id;
//! - manual: tags with an order by it, then the id; then those without by the folded name, then the id.
//!
//! The id breaks ties: ids are given out in creation order, as the old store's rowids were.
//!
//! A bulk load leaves the orders out (they follow carrier counts shared across partitions) and builds them once
//! its run is merged (`bulk`).

use super::StoreError;
use super::derive::{Loc, Out, View};
use super::kinds::{bytes, dead, id, key, loc_bytes, parse_loc, parse_pos, pos_bytes, text_value};
use super::library::{TAG, counter, entity_info, num_key, parse_uvarint, uvarint};
use crate::keyspace::val::{get_bytes, get_u64, put_bytes, put_u64};
use crate::log::format::{FieldRef, Record, Value};
use unicode_normalization::UnicodeNormalization;

pub const ALPHA: u64 = 0;
pub const ENTRIES: u64 = 1;
pub const MANUAL: u64 = 2;
pub const SORTS: u64 = 3;

fn none_folder() -> Vec<u8> {
    b"NONE".to_vec()
}

/// A tag name as the old store's `tagNameKey()` keys it: decomposed (NFD), U+0300–U+036F dropped, lower-cased,
/// as UTF-8 (a lone surrogate, which UTF-8 can't hold, as U+FFFD).
pub fn name_key(name: &[u8]) -> Vec<u8> {
    let s = wtf8_lossy(name);
    s.nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect::<String>()
        .to_lowercase()
        .into_bytes()
}

/// WTF-8 as a string, each lone surrogate (and any byte that isn't WTF-8) as U+FFFD.
fn wtf8_lossy(b: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(b) {
        return s.to_owned();
    }
    let mut out = String::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        // A surrogate is ED A0..BF xx in WTF-8.
        if b[i] == 0xed && i + 2 < b.len() && (0xa0..=0xbf).contains(&b[i + 1]) {
            out.push('\u{fffd}');
            i += 3;
            continue;
        }
        let len = match b[i] {
            0x00..=0x7f => 1,
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            _ => 4,
        };
        match b.get(i..i + len).and_then(|c| std::str::from_utf8(c).ok()) {
            Some(c) => {
                out.push_str(c);
                i += len;
            }
            None => {
                out.push('\u{fffd}');
                i += 1;
            }
        }
    }
    out
}

/// What places a live tag in its orders, besides its carriers.
#[derive(Debug, Clone, PartialEq)]
pub struct Place {
    pub name_key: Vec<u8>,
    /// The folder type as the old store's column holds it: the string, the JSON of any other value, `NONE` for
    /// none.
    pub folder_type: Vec<u8>,
    pub order: Option<f64>,
}

impl Place {
    pub fn folder(&self) -> bool {
        self.folder_type != b"NONE"
    }

    pub fn bytes(&self) -> Vec<u8> {
        let mut b = Vec::new();
        put_bytes(&mut b, &self.name_key);
        put_bytes(&mut b, &self.folder_type);
        match self.order {
            None => b.push(0),
            Some(v) => {
                b.push(1);
                b.extend_from_slice(&v.to_bits().to_le_bytes());
            }
        }
        b
    }

    pub fn parse(b: &[u8]) -> Result<Place, StoreError> {
        let bad = || StoreError::Entry("a tag's place doesn't decode".into());
        let mut at = 0;
        let name_key = get_bytes(b, &mut at).ok_or_else(bad)?;
        let folder_type = get_bytes(b, &mut at).ok_or_else(bad)?;
        let order = match b.get(at) {
            Some(0) if at + 1 == b.len() => None,
            Some(1) if at + 9 == b.len() => Some(f64::from_bits(u64::from_le_bytes(
                b[at + 1..].try_into().map_err(|_| bad())?,
            ))),
            _ => return Err(bad()),
        };
        Ok(Place {
            name_key,
            folder_type,
            order,
        })
    }
}

/// A live tag's place; None for anything else.
pub fn place(view: &View, tag: u64) -> Result<Option<Place>, StoreError> {
    view.get(&key::id(key::TAG_PLACE, tag))?
        .map(|b| Place::parse(&b))
        .transpose()
}

pub fn carriers(view: &View, tag: u64) -> Result<i64, StoreError> {
    counter(view, &key::id(key::MEMBER_COUNT, tag))
}

/// The prefix of one part of an order.
pub fn part_prefix(sort: u64, folder: bool, used: bool) -> Vec<u8> {
    let mut k = key::of(key::TAG_ORDER);
    put_u64(&mut k, sort);
    k.push(u8::from(folder));
    k.push(u8::from(used));
    k
}

/// Where a tag sits in a part of an order (the key after the part's prefix).
pub fn suffix(sort: u64, p: &Place, count: i64, tag: u64) -> Vec<u8> {
    let mut k = Vec::new();
    match sort {
        ALPHA => put_bytes(&mut k, &p.name_key),
        ENTRIES => {
            k.extend_from_slice(&(u64::MAX - count.max(0) as u64).to_be_bytes());
            put_bytes(&mut k, &p.name_key);
        }
        _ => match p.order {
            Some(v) => {
                k.push(0);
                num_key(&mut k, Some(v));
            }
            None => {
                k.push(1);
                put_bytes(&mut k, &p.name_key);
            }
        },
    }
    put_u64(&mut k, tag);
    k
}

/// The tag a suffix ends in.
pub fn suffix_tag(sort: u64, s: &[u8]) -> Option<u64> {
    let mut at = 0;
    match sort {
        ALPHA => {
            get_bytes(s, &mut at)?;
        }
        ENTRIES => {
            at = 8;
            get_bytes(s, &mut at)?;
        }
        _ => match s.first()? {
            0 => at = 1 + 9,
            1 => {
                at = 1;
                get_bytes(s, &mut at)?;
            }
            _ => return None,
        },
    }
    let t = get_u64(s, &mut at)?;
    (at == s.len()).then_some(t)
}

pub fn part_count_key(folder: bool, used: bool) -> Vec<u8> {
    let mut k = key::of(key::TAG_PART_COUNT);
    k.push(u8::from(folder));
    k.push(u8::from(used));
    k
}

/// Moves the tag's entries in its orders and part counts from `old` (place, carriers) to `new`.
pub fn reposition(out: &mut Out, tag: u64, old: Option<(&Place, i64)>, new: Option<(&Place, i64)>) {
    let at = |(p, c): (&Place, i64), sort: u64| {
        let mut k = part_prefix(sort, p.folder(), c > 0);
        k.extend_from_slice(&suffix(sort, p, c, tag));
        k
    };
    // An entry's value is the place, so a place that changed is written again even where its key didn't.
    let place_changed = old.map(|o| o.0) != new.map(|n| n.0);
    for sort in 0..SORTS {
        let ok = old.map(|o| at(o, sort));
        let nk = new.map(|n| at(n, sort));
        let moved = ok != nk;
        if moved && let Some(ok) = ok {
            out.del(ok);
        }
        if let (Some(nk), Some((p, _))) = (nk, new)
            && (moved || place_changed)
        {
            out.put(nk, p.bytes());
        }
    }
    let part = |(p, c): (&Place, i64)| (p.folder(), c > 0);
    let (op, np) = (old.map(part), new.map(part));
    if op != np {
        if let Some((f, u)) = op {
            out.add(part_count_key(f, u), -1);
        }
        if let Some((f, u)) = np {
            out.add(part_count_key(f, u), 1);
        }
    }
}

/// A live tag's place as its values give it (for a tag being created).
fn place_from_values(view: &View, tag: u64) -> Result<Place, StoreError> {
    let name = FieldRef::Code(super::library::NAME);
    let folder = FieldRef::Code(super::library::FOLDER_TYPE);
    let name_key = match text_value(view, tag, &name)? {
        Some(t) => self::name_key(&t),
        None => Vec::new(),
    };
    let folder_type = match text_value(view, tag, &folder)? {
        Some(t) => t,
        None => match json_value(view, tag, &folder)? {
            Some(j) => j,
            None => none_folder(),
        },
    };
    let order = match view.get(&key::id(key::TAG_ORDER_REC, tag))? {
        Some(b) => {
            let (r, _) = view.record(parse_loc(&b)?.pos)?;
            order_of(&r)
        }
        None => None,
    };
    Ok(Place {
        name_key,
        folder_type,
        order,
    })
}

fn json_value(view: &View, e: u64, f: &FieldRef) -> Result<Option<Vec<u8>>, StoreError> {
    match view.get(&key::field(key::VALUE, e, f))? {
        Some(b) => {
            let (r, _) = view.record(parse_loc(&b)?.pos)?;
            Ok(Some(bytes(&r, 2).to_vec()))
        }
        None => Ok(None),
    }
}

fn order_of(rec: &Record) -> Option<f64> {
    match rec.values.get(1) {
        Some(Value::F64(v)) => Some(*v),
        _ => None,
    }
}

/// The definition of `tag` changed at `at`: it moves to the end of the tag change feed.
pub fn touched(view: &View, out: &mut Out, tag: u64, at: Loc) -> Result<(), StoreError> {
    let ck = key::id(key::TAG_CHANGED, tag);
    if let Some(b) = view.get(&ck)? {
        let old = parse_pos(&b)?;
        if old == at.pos {
            return Ok(());
        }
        out.del(key::ids(key::TAG_CHANGE, old, tag));
    }
    out.put(key::ids(key::TAG_CHANGE, at.pos, tag), Vec::new());
    out.put(ck, pos_bytes(at.pos));
    Ok(())
}

/// The tags `entity` carries changed at `at`: it moves to the end of the assignment change feed.
pub fn entity_touched(view: &View, out: &mut Out, entity: u64, at: Loc) -> Result<(), StoreError> {
    let ck = key::id(key::ENTITY_TAGS_CHANGED, entity);
    if let Some(b) = view.get(&ck)? {
        let old = parse_pos(&b)?;
        if old == at.pos {
            return Ok(());
        }
        out.del(key::ids(key::ENTITY_TAG_CHANGE, old, entity));
    }
    out.put(key::ids(key::ENTITY_TAG_CHANGE, at.pos, entity), Vec::new());
    out.put(ck, pos_bytes(at.pos));
    Ok(())
}

/// `entity` is deleted: it leaves the assignment change feed.
pub fn entity_gone(view: &View, out: &mut Out, entity: u64) -> Result<(), StoreError> {
    let ck = key::id(key::ENTITY_TAGS_CHANGED, entity);
    if let Some(b) = view.get(&ck)? {
        out.del(key::ids(key::ENTITY_TAG_CHANGE, parse_pos(&b)?, entity));
        out.del(ck);
    }
    Ok(())
}

/// A change `f` makes to a live tag's place; returns false when `tag` isn't one.
pub fn change(
    view: &View,
    out: &mut Out,
    tag: u64,
    f: impl FnOnce(&mut Place),
) -> Result<bool, StoreError> {
    let Some(old) = place(view, tag)? else {
        return Ok(false);
    };
    let mut new = old.clone();
    f(&mut new);
    if new != old {
        out.put(key::id(key::TAG_PLACE, tag), new.bytes());
        if !view.is_bulk() {
            let c = carriers(view, tag)?;
            reposition(out, tag, Some((&old, c)), Some((&new, c)));
        }
    }
    Ok(true)
}

/// The tag's carriers change by `delta` (counted before the change in `view`).
pub fn carriers_changed(
    view: &View,
    out: &mut Out,
    tag: u64,
    delta: i64,
) -> Result<(), StoreError> {
    if view.is_bulk() || delta == 0 {
        return Ok(());
    }
    let Some(p) = place(view, tag)? else {
        return Ok(());
    };
    let c = carriers(view, tag)?;
    reposition(out, tag, Some((&p, c)), Some((&p, c + delta)));
    Ok(())
}

/// A field's new value, for `field_written`.
pub enum Written<'a> {
    Text(&'a [u8]),
    Json(&'a [u8]),
    Gone,
}

/// Whether a field may be one of a tag's: its name, its folder type, or a key the tag writer stores (`tag:`).
pub fn tag_field(f: &FieldRef) -> bool {
    match f {
        FieldRef::Code(c) => {
            *c == super::library::NAME || *c == super::library::FOLDER_TYPE || *c == DEFINED
        }
        FieldRef::Key(k) => k.starts_with(b"tag:"),
    }
}

/// A value of entity `e` was written at `at`: when `e` is a live tag, its place follows a new name or folder
/// type, and it moves to the end of the change feed.
pub fn field_written(
    view: &View,
    out: &mut Out,
    e: u64,
    at: Loc,
    f: &FieldRef,
    new: Written,
) -> Result<(), StoreError> {
    if !tag_field(f) {
        return Ok(());
    }
    let live = match f {
        FieldRef::Code(DEFINED) => return defined(view, out, e, at, !matches!(new, Written::Gone)),
        FieldRef::Code(super::library::NAME) => {
            let nk = match new {
                Written::Text(t) => name_key(t),
                _ => Vec::new(),
            };
            change(view, out, e, |p| p.name_key = nk)?
        }
        FieldRef::Code(_) => {
            let ft = match new {
                Written::Text(t) | Written::Json(t) => t.to_vec(),
                Written::Gone => none_folder(),
            };
            change(view, out, e, |p| p.folder_type = ft)?
        }
        FieldRef::Key(_) => place(view, e)?.is_some(),
    };
    if live {
        touched(view, out, e, at)?;
    }
    Ok(())
}

/// A tag entity's definition marker: a tag entity without one is a key only assignments name (as upstream's
/// `tag_map` may name a tag no definition has), in no order and not listed until a definition is written.
pub const DEFINED: u64 = 41;

pub fn has_marker(view: &View, tag: u64) -> Result<bool, StoreError> {
    Ok(view
        .get(&key::field(key::VALUE, tag, &FieldRef::Code(DEFINED)))?
        .is_some())
}

/// A tag entity's definition marker was written (`on`, not yet in `view`) or removed (still in `view`): its
/// name is searched only while it has one.
fn defined(view: &View, out: &mut Out, tag: u64, at: Loc, on: bool) -> Result<(), StoreError> {
    let Some((TAG, k, _)) = entity_info(view, tag)? else {
        return Ok(());
    };
    let old = place(view, tag)?;
    match (old, on) {
        (None, true) => {
            super::searched::created(view, out, tag, TAG, &k, true)?;
            placed(view, out, tag, at)
        }
        (Some(p), false) => {
            super::searched::gone(view, out, tag, TAG, &k)?;
            if !view.is_bulk() {
                let c = carriers(view, tag)?;
                reposition(out, tag, Some((&p, c)), None);
            }
            out.del(key::id(key::TAG_PLACE, tag));
            unstamp(view, out, tag)?;
            touched(view, out, tag, at)
        }
        _ => Ok(()),
    }
}

/// A tag entity comes to be (`entityCreate` of type `TAG`, its values already in `view`), or gets its definition:
/// with its definition marker, it is placed.
pub fn created(view: &View, out: &mut Out, tag: u64, at: Loc) -> Result<(), StoreError> {
    if view
        .get(&key::field(key::VALUE, tag, &FieldRef::Code(DEFINED)))?
        .is_none()
    {
        return Ok(());
    }
    placed(view, out, tag, at)
}

/// A defined tag enters its orders, placed by its values.
fn placed(view: &View, out: &mut Out, tag: u64, at: Loc) -> Result<(), StoreError> {
    let p = place_from_values(view, tag)?;
    if !view.is_bulk() {
        let c = carriers(view, tag)?;
        reposition(out, tag, None, Some((&p, c)));
    }
    out.put(key::id(key::TAG_PLACE, tag), p.bytes());
    touched(view, out, tag, at)
}

/// A tag goes (`entityDelete`, or a prune): it leaves its orders; its key is kept, so a reader holding it learns
/// it is gone, and what it merged into.
pub fn deleted(view: &View, out: &mut Out, tag: u64, k: &[u8], at: Loc) -> Result<(), StoreError> {
    if let Some(p) = place(view, tag)? {
        if !view.is_bulk() {
            let c = carriers(view, tag)?;
            reposition(out, tag, Some((&p, c)), None);
        }
        out.del(key::id(key::TAG_PLACE, tag));
    }
    let ok = key::id(key::TAG_ORDER_REC, tag);
    if let Some(b) = view.get(&ok)? {
        dead(out, parse_loc(&b)?);
        out.del(ok);
    }
    unstamp(view, out, tag)?;
    let mut gk = key::of(key::TAG_GONE_KEY);
    put_bytes(&mut gk, k);
    out.put(gk, uvarint(tag));
    out.put(key::id(key::TAG_GONE_ID, tag), k.to_vec());
    // A defined tag's name goes on standing for it (for the tag its merges lead to), the latest deleted one's.
    if view
        .get(&key::field(key::VALUE, tag, &FieldRef::Code(DEFINED)))?
        .is_some()
        && let Some(name) = text_value(view, tag, &FieldRef::Code(super::library::NAME))?
    {
        let mut nk = key::of(key::TAG_GONE_NAME);
        put_bytes(&mut nk, &name_key(&name));
        out.put(nk, uvarint(tag));
    }
    touched(view, out, tag, at)
}

/// The tag deleted last whose name folds as `name` does, or None.
pub fn gone_by_name(view: &View, name: &[u8]) -> Result<Option<u64>, StoreError> {
    let mut nk = key::of(key::TAG_GONE_NAME);
    put_bytes(&mut nk, &name_key(name));
    view.get(&nk)?.map(|b| parse_uvarint(&b)).transpose()
}

/// The tag a deleted tag's key named, or None.
pub fn gone_by_key(view: &View, k: &[u8]) -> Result<Option<u64>, StoreError> {
    let mut gk = key::of(key::TAG_GONE_KEY);
    put_bytes(&mut gk, k);
    view.get(&gk)?.map(|b| parse_uvarint(&b)).transpose()
}

/// A tag's key, live or deleted.
pub fn key_of(view: &View, tag: u64) -> Result<Option<Vec<u8>>, StoreError> {
    if let Some((t, k, _)) = entity_info(view, tag)? {
        return Ok((t == TAG).then_some(k));
    }
    view.get(&key::id(key::TAG_GONE_ID, tag))
}

/// `tagOrder` and `tagPassOrder`: the tag's manual sort order (absent: it has none), as the writer coerced it.
pub struct TagOrder;

impl super::derive::Deriver for TagOrder {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let tag = id(rec, 0);
        let k = key::id(key::TAG_ORDER_REC, tag);
        if let Some(b) = view.get(&k)? {
            dead(out, parse_loc(&b)?);
        }
        out.put(k, loc_bytes(at));
        let order = order_of(rec);
        if change(view, out, tag, |p| p.order = order)? {
            touched(view, out, tag, at)?;
        }
        if let Some(Value::UInt(pass)) = rec.values.get(2) {
            stamp(view, out, tag, *pass)?;
        }
        super::kinds::version(view, out, tag, at)?;
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        Ok(view
            .get(&key::id(key::TAG_ORDER_REC, id(rec, 0)))?
            .map(|b| parse_loc(&b))
            .transpose()?
            .is_some_and(|l| l.pos == pos))
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        if self.is_live(rec, from, view)? {
            out.put(key::id(key::TAG_ORDER_REC, id(rec, 0)), loc_bytes(to));
        }
        Ok(())
    }
}

/// The reorder pass running now (the `tagPass` record's, when it has a mode), or None.
pub fn running_pass(view: &View) -> Result<Option<u64>, StoreError> {
    Ok(match view.get(&key::of(key::TAG_PASS))? {
        Some(b) => {
            let (r, _) = view.record(parse_loc(&b)?.pos)?;
            match (r.values.first(), r.values.get(1)) {
                (Some(Value::UInt(pass)), Some(Value::UInt(_))) => Some(*pass),
                _ => None,
            }
        }
        None => None,
    })
}

/// `pass` wrote the tag's order: the tag counts among the pass's live tags once.
fn stamp(view: &View, out: &mut Out, tag: u64, pass: u64) -> Result<(), StoreError> {
    let sk = key::id(key::TAG_STAMP, tag);
    let old = view.get(&sk)?.map(|b| parse_uvarint(&b)).transpose()?;
    if old == Some(pass) {
        return Ok(());
    }
    if let Some(old) = old
        && running_pass(view)? == Some(old)
    {
        out.add(key::id(key::TAG_STAMPED, old), -1);
    }
    out.put(sk, uvarint(pass));
    if place(view, tag)?.is_some() && running_pass(view)? == Some(pass) {
        out.add(key::id(key::TAG_STAMPED, pass), 1);
    }
    Ok(())
}

/// The tag stops being live: it leaves its pass's count.
fn unstamp(view: &View, out: &mut Out, tag: u64) -> Result<(), StoreError> {
    let sk = key::id(key::TAG_STAMP, tag);
    let Some(b) = view.get(&sk)? else {
        return Ok(());
    };
    let pass = parse_uvarint(&b)?;
    if running_pass(view)? == Some(pass) {
        out.add(key::id(key::TAG_STAMPED, pass), -1);
    }
    out.del(sk);
    Ok(())
}

/// `tagQueue`: a queued move, kept by its place in the queue until popped.
pub struct TagQueue;

impl super::derive::Deriver for TagQueue {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let k = key::id(key::TAG_QUEUE, id(rec, 0));
        if let Some(b) = view.get(&k)? {
            dead(out, parse_loc(&b)?);
        }
        out.put(k, loc_bytes(at));
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        Ok(view
            .get(&key::id(key::TAG_QUEUE, id(rec, 0)))?
            .map(|b| parse_loc(&b))
            .transpose()?
            .is_some_and(|l| l.pos == pos))
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        if self.is_live(rec, from, view)? {
            out.put(key::id(key::TAG_QUEUE, id(rec, 0)), loc_bytes(to));
        }
        Ok(())
    }
}

/// `tagQueuePop`: the queued move leaves the queue.
pub struct TagQueuePop;

impl super::derive::Deriver for TagQueuePop {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let k = key::id(key::TAG_QUEUE, id(rec, 0));
        if let Some(b) = view.get(&k)? {
            dead(out, parse_loc(&b)?);
            out.del(k);
        }
        dead(out, at);
        Ok(())
    }

    fn is_live(&self, _: &Record, _: u64, _: &View) -> Result<bool, StoreError> {
        Ok(false)
    }

    fn repoint(&self, _: &Record, _: u64, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Ok(())
    }
}

/// `tagPass`: the reorder pass's record. A pass's count of the tags it wrote goes once another replaces it or
/// it ends.
pub struct TagPass;

impl super::derive::Deriver for TagPass {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let k = key::of(key::TAG_PASS);
        let running = running_pass(view)?;
        let new = match (rec.values.first(), rec.values.get(1)) {
            (Some(Value::UInt(pass)), Some(Value::UInt(_))) => Some(*pass),
            _ => None,
        };
        if let Some(old) = running
            && new != Some(old)
        {
            out.del(key::id(key::TAG_STAMPED, old));
        }
        if let Some(b) = view.get(&k)? {
            dead(out, parse_loc(&b)?);
        }
        out.put(k, loc_bytes(at));
        Ok(())
    }

    fn is_live(&self, _: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        pass_at(view, pos)
    }

    fn repoint(
        &self,
        _: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        if pass_at(view, from)? {
            out.put(key::of(key::TAG_PASS), loc_bytes(to));
        }
        Ok(())
    }
}

/// Whether the `tagPass` record is the one at `pos`.
fn pass_at(view: &View, pos: u64) -> Result<bool, StoreError> {
    Ok(view
        .get(&key::of(key::TAG_PASS))?
        .map(|b| parse_loc(&b))
        .transpose()?
        .is_some_and(|l| l.pos == pos))
}

/// Whether a live tag is unused: no carriers, and no tag merged into it whose carriers wait to move.
pub fn unused(view: &View, tag: u64) -> Result<bool, StoreError> {
    if carriers(view, tag)? > 0 {
        return Ok(false);
    }
    let p = key::id(key::MERGED_INTO, tag);
    Ok(view.scan(&p, &key::prefix_end(&p), 1)?.is_empty())
}

// ---- reads ----

/// Tags a page examines at most, every one a walk reads counting.
pub const WORK_CAP: u64 = 20_000;

#[derive(Debug, Clone, Default)]
pub struct Query {
    pub sort: u64,
    pub folders: bool,
    pub used: bool,
    /// Only folders of this type.
    pub folder_type: Option<Vec<u8>>,
    /// A prefix of the folded name (raw, folded here).
    pub search: Option<Vec<u8>>,
    /// The folded name, exactly.
    pub name: Option<Vec<u8>>,
    /// Text the folded name holds.
    pub contains: Option<Vec<u8>>,
    pub ids: Option<Vec<u64>>,
    /// A cursor this read returned for the same sort.
    pub after: Option<Vec<u8>>,
    pub limit: usize,
    pub cap: u64,
    /// The order read last first, from before `after`.
    pub reverse: bool,
    /// Manual only: only the tags with an order (Some(true)) or only those without (Some(false)).
    pub ordered: Option<bool>,
    /// Only tags reorder pass `unstamped` hasn't written.
    pub unstamped: Option<u64>,
}

#[derive(Debug, Default)]
pub struct Page {
    pub ids: Vec<u64>,
    /// Where the next page starts; None once the order is read to its end.
    pub cursor: Option<Vec<u8>>,
    /// The work cap cut the page short.
    pub more: bool,
}

struct Names {
    exact: Option<Vec<u8>>,
    prefix: Option<Vec<u8>>,
    contains: Option<Vec<u8>>,
}

impl Names {
    fn of(q: &Query) -> Names {
        Names {
            exact: q.name.as_deref().map(name_key),
            prefix: q.search.as_deref().map(name_key).filter(|k| !k.is_empty()),
            contains: q
                .contains
                .as_deref()
                .map(name_key)
                .filter(|k| !k.is_empty()),
        }
    }

    fn matches(&self, k: &[u8]) -> bool {
        self.exact.as_ref().is_none_or(|e| e == k)
            && self.prefix.as_ref().is_none_or(|p| k.starts_with(p))
            && self
                .contains
                .as_ref()
                .is_none_or(|c| k.windows(c.len()).any(|w| w == c.as_slice()))
    }

    /// The name range a name-led order narrows to: keys of the escaped name starting with this.
    fn lead(&self) -> Option<Vec<u8>> {
        if let Some(e) = &self.exact {
            let mut b = Vec::new();
            put_bytes(&mut b, e);
            return Some(b);
        }
        self.prefix.as_ref().map(|p| {
            let mut b = Vec::new();
            put_bytes(&mut b, p);
            b.truncate(b.len() - 2);
            b
        })
    }
}

fn check(q: &Query, names: &Names, p: &Place) -> bool {
    names.matches(&p.name_key) && q.folder_type.as_ref().is_none_or(|t| *t == p.folder_type)
}

/// One part of an order, read in key order within its ranges (in reverse: last first, the ranges last first).
struct Stream {
    prefix: Vec<u8>,
    ranges: Vec<(Vec<u8>, Vec<u8>)>,
    at: usize,
    buf: std::collections::VecDeque<(Vec<u8>, Place)>,
    window: usize,
    rev: bool,
}

impl Stream {
    fn new(
        prefix: Vec<u8>,
        mut ranges: Vec<(Vec<u8>, Vec<u8>)>,
        window: usize,
        rev: bool,
    ) -> Stream {
        if rev {
            ranges.reverse();
        }
        Stream {
            prefix,
            ranges,
            at: 0,
            buf: Default::default(),
            window,
            rev,
        }
    }

    fn peek(&mut self, view: &View) -> Result<Option<&(Vec<u8>, Place)>, StoreError> {
        while self.buf.is_empty() && self.at < self.ranges.len() {
            let (lo, hi) = &self.ranges[self.at];
            let window = self.window;
            let found: Vec<(Vec<u8>, Vec<u8>)> = if self.rev {
                view.scan_vals_rev(lo, hi, window)?
                    .into_iter()
                    .map(|(k, v)| {
                        let b = v.into_bytes(&k);
                        (k, b)
                    })
                    .collect()
            } else {
                view.scan(lo, hi, window)?
            };
            self.window = (self.window * 2).min(4096);
            if found.len() < window {
                self.at += 1;
            } else if let Some((k, _)) = found.last() {
                if self.rev {
                    self.ranges[self.at].1 = k.clone();
                } else {
                    let mut next = k.clone();
                    next.push(0);
                    self.ranges[self.at].0 = next;
                }
            }
            for (k, v) in found {
                self.buf
                    .push_back((k[self.prefix.len()..].to_vec(), Place::parse(&v)?));
            }
        }
        Ok(self.buf.front())
    }
}

fn encode_cursor(sort: u64, s: &[u8]) -> Vec<u8> {
    let mut b = vec![sort as u8];
    b.extend_from_slice(s);
    b
}

/// The suffix a cursor for `sort` holds; Err for one that isn't.
pub fn decode_cursor(sort: u64, c: &[u8]) -> Result<Vec<u8>, StoreError> {
    match c.split_first() {
        Some((s, rest)) if u64::from(*s) == sort && suffix_tag(sort, rest).is_some() => {
            Ok(rest.to_vec())
        }
        _ => Err(StoreError::Refused("invalid-cursor".into())),
    }
}

/// A page of tags in `q.sort`'s order under `q`'s filters.
pub fn page(view: &View, q: &Query) -> Result<Page, StoreError> {
    let after = q
        .after
        .as_deref()
        .map(|c| decode_cursor(q.sort, c))
        .transpose()?;
    let names = Names::of(q);
    if let Some(ids) = &q.ids {
        return ids_page(view, q, &names, ids, after.as_deref());
    }
    let lead = names.lead();
    let mut streams = Vec::new();
    for folder in [false, true] {
        if q.folders && !folder {
            continue;
        }
        for used in [false, true] {
            if q.used && !used {
                continue;
            }
            let prefix = part_prefix(q.sort, folder, used);
            let whole = (prefix.clone(), key::prefix_end(&prefix));
            let mut ranges = match (q.sort, &lead) {
                (ALPHA, Some(l)) => {
                    let mut lo = prefix.clone();
                    lo.extend_from_slice(l);
                    let hi = key::prefix_end(&lo);
                    vec![(lo, hi)]
                }
                (MANUAL, _) => {
                    let mut ordered = prefix.clone();
                    ordered.push(0);
                    let mut unordered = prefix.clone();
                    unordered.push(1);
                    if let Some(l) = &lead {
                        unordered.extend_from_slice(l);
                    }
                    let hi = key::prefix_end(&unordered);
                    let mut r = Vec::new();
                    if q.ordered != Some(false) {
                        r.push((ordered.clone(), key::prefix_end(&ordered)));
                    }
                    if q.ordered != Some(true) {
                        r.push((unordered, hi));
                    }
                    r
                }
                _ => vec![whole],
            };
            if let Some(a) = &after {
                let mut start = prefix.clone();
                start.extend_from_slice(a);
                if q.reverse {
                    for r in &mut ranges {
                        if r.1 > start {
                            r.1 = start.clone();
                        }
                    }
                } else {
                    start.push(0);
                    for r in &mut ranges {
                        if r.0 < start {
                            r.0 = start.clone();
                        }
                    }
                }
                ranges.retain(|r| r.0 < r.1);
            }
            streams.push(Stream::new(
                prefix,
                ranges,
                (q.limit + 1).clamp(16, 4096),
                q.reverse,
            ));
        }
    }
    let mut ids = Vec::new();
    let mut examined = 0u64;
    loop {
        let mut best: Option<usize> = None;
        for i in 0..streams.len() {
            let Some((s, _)) = streams[i].peek(view)? else {
                continue;
            };
            let s = s.clone();
            let better = |b: &Vec<u8>| if q.reverse { s > *b } else { s < *b };
            if best.is_none_or(|b| streams[b].buf.front().is_some_and(|(bs, _)| better(bs))) {
                best = Some(i);
            }
        }
        let Some(b) = best else {
            return Ok(Page {
                ids,
                cursor: None,
                more: false,
            });
        };
        let (s, p) = streams[b].buf.pop_front().unwrap();
        examined += 1;
        let t = suffix_tag(q.sort, &s)
            .ok_or_else(|| StoreError::Entry("a tag order key doesn't decode".into()))?;
        if check(q, &names, &p) && !stamped_by(view, t, q.unstamped)? {
            ids.push(t);
            if ids.len() == q.limit {
                return Ok(Page {
                    ids,
                    cursor: Some(encode_cursor(q.sort, &s)),
                    more: false,
                });
            }
        }
        if examined >= q.cap {
            return Ok(Page {
                ids,
                cursor: Some(encode_cursor(q.sort, &s)),
                more: true,
            });
        }
    }
}

/// Whether reorder pass `pass` (None: no pass asked about) has written the tag's order.
fn stamped_by(view: &View, tag: u64, pass: Option<u64>) -> Result<bool, StoreError> {
    let Some(pass) = pass else {
        return Ok(false);
    };
    Ok(view
        .get(&key::id(key::TAG_STAMP, tag))?
        .map(|b| parse_uvarint(&b))
        .transpose()?
        == Some(pass))
}

fn ids_page(
    view: &View,
    q: &Query,
    names: &Names,
    ids: &[u64],
    after: Option<&[u8]>,
) -> Result<Page, StoreError> {
    let mut found = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for &t in ids {
        if !seen.insert(t) {
            continue;
        }
        let Some(p) = place(view, t)? else {
            continue;
        };
        let c = carriers(view, t)?;
        if (q.folders && !p.folder())
            || (q.used && c <= 0)
            || !check(q, names, &p)
            || (q.sort == MANUAL && q.ordered.is_some_and(|o| o != p.order.is_some()))
            || stamped_by(view, t, q.unstamped)?
        {
            continue;
        }
        let s = suffix(q.sort, &p, c, t);
        if after.is_some_and(|a| {
            if q.reverse {
                s.as_slice() >= a
            } else {
                s.as_slice() <= a
            }
        }) {
            continue;
        }
        found.push((s, t));
    }
    found.sort();
    if q.reverse {
        found.reverse();
    }
    let full = found.len() >= q.limit;
    found.truncate(q.limit);
    Ok(Page {
        cursor: if full {
            found.last().map(|(s, _)| encode_cursor(q.sort, s))
        } else {
            None
        },
        ids: found.into_iter().map(|(_, t)| t).collect(),
        more: false,
    })
}

/// Each tag's carriers, counted as the old store's prune judges a tag in use: its own, plus those of every tag
/// merged into it whose carriers haven't moved yet; with whether that sum may count an entity twice (it may carry
/// both).
pub fn counts(view: &View, tags: &[u64]) -> Result<Vec<(i64, bool)>, StoreError> {
    tags.iter()
        .map(|&t| {
            let mut n = carriers(view, t)?;
            let mut approx = false;
            for s in super::library::tag_sources(view, t)?.into_iter().skip(1) {
                let m = carriers(view, s)?;
                if m > 0 {
                    n += m;
                    approx = true;
                }
            }
            Ok((n, approx))
        })
        .collect()
}

/// How many live tags are unused (`unused`).
pub fn unused_count(view: &View) -> Result<u64, StoreError> {
    let mut n = 0i64;
    for folder in [false, true] {
        n += counter(view, &part_count_key(folder, false))?;
    }
    // A tag with no carriers of its own but merged tags' carriers still moving to it is in use.
    let p = key::of(key::MERGED_INTO);
    let mut targets = std::collections::BTreeSet::new();
    for (k, _) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        let mut at = p.len();
        if let Some(t) = get_u64(&k, &mut at) {
            targets.insert(t);
        }
    }
    for t in targets {
        if place(view, t)?.is_some() && carriers(view, t)? == 0 {
            n -= 1;
        }
    }
    Ok(n.max(0) as u64)
}

/// Up to `limit` unused tags, in alphabetical order.
pub fn unused_page(view: &View, limit: usize) -> Result<Vec<u64>, StoreError> {
    let mut out = Vec::new();
    if limit == 0 {
        return Ok(out);
    }
    let mut streams: Vec<Stream> = [false, true]
        .into_iter()
        .map(|folder| {
            let prefix = part_prefix(ALPHA, folder, false);
            Stream::new(
                prefix.clone(),
                vec![(prefix.clone(), key::prefix_end(&prefix))],
                64,
                false,
            )
        })
        .collect();
    loop {
        let mut best: Option<usize> = None;
        for i in 0..streams.len() {
            let Some((s, _)) = streams[i].peek(view)? else {
                continue;
            };
            let s = s.clone();
            if best.is_none_or(|b| streams[b].buf.front().is_some_and(|(bs, _)| s < *bs)) {
                best = Some(i);
            }
        }
        let Some(b) = best else {
            return Ok(out);
        };
        let (s, _) = streams[b].buf.pop_front().unwrap();
        let t = suffix_tag(ALPHA, &s)
            .ok_or_else(|| StoreError::Entry("a tag order key doesn't decode".into()))?;
        if unused(view, t)? {
            out.push(t);
            if out.len() == limit {
                return Ok(out);
            }
        }
    }
}

/// The live tag a name stands for: the first created whose folded name is the name's.
pub fn by_name(view: &View, name: &[u8]) -> Result<Option<u64>, StoreError> {
    let nk = name_key(name);
    let mut best: Option<u64> = None;
    for folder in [false, true] {
        for used in [false, true] {
            let mut p = part_prefix(ALPHA, folder, used);
            put_bytes(&mut p, &nk);
            if let Some((k, _)) = view.scan(&p, &key::prefix_end(&p), 1)?.into_iter().next() {
                let mut at = p.len();
                if let Some(t) = get_u64(&k, &mut at) {
                    best = Some(best.map_or(t, |b| b.min(t)));
                }
            }
        }
    }
    Ok(best)
}

/// The highest manual sort order any live tag has.
pub fn max_order(view: &View) -> Result<Option<f64>, StoreError> {
    let mut best: Option<f64> = None;
    for folder in [false, true] {
        for used in [false, true] {
            let mut p = part_prefix(MANUAL, folder, used);
            p.push(0);
            if let Some((k, _)) = view
                .scan_vals_rev(&p, &key::prefix_end(&p), 1)?
                .into_iter()
                .next()
            {
                // After the [0] of the ordered tags, num_key: 1, then the bits made sortable.
                let b: [u8; 8] = k
                    .get(p.len() + 1..p.len() + 9)
                    .and_then(|b| b.try_into().ok())
                    .ok_or_else(|| StoreError::Entry("a tag order key doesn't decode".into()))?;
                let bits = u64::from_be_bytes(b);
                let bits = if bits >> 63 == 1 {
                    bits & !(1 << 63)
                } else {
                    !bits
                };
                let v = f64::from_bits(bits);
                best = Some(best.map_or(v, |x: f64| x.max(v)));
            }
        }
    }
    Ok(best)
}

/// A change feed's entries (position, id), whether more follow, and the feed's last position.
pub type FeedPage = (Vec<(u64, u64)>, bool, u64);

/// Up to `limit` entries of a change feed (`key::TAG_CHANGE` or `key::ENTITY_TAG_CHANGE`) after position
/// `after`: (position, id) in order, and whether more follow.
pub fn feed(
    view: &View,
    structure: u64,
    after: u64,
    limit: usize,
) -> Result<(Vec<(u64, u64)>, bool), StoreError> {
    let p = key::of(structure);
    let start = key::id(structure, after.saturating_add(1));
    let found = view.scan(&start, &key::prefix_end(&p), limit + 1)?;
    let more = found.len() > limit;
    let bad = || StoreError::Entry("a change feed key doesn't decode".into());
    let entries = found
        .into_iter()
        .take(limit)
        .map(|(k, _)| {
            let mut at = p.len();
            let pos = get_u64(&k, &mut at).ok_or_else(bad)?;
            let e = get_u64(&k, &mut at).ok_or_else(bad)?;
            Ok((pos, e))
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    Ok((entries, more))
}

/// The last position in a change feed, 0 for none.
pub fn feed_end(view: &View, structure: u64) -> Result<u64, StoreError> {
    let p = key::of(structure);
    Ok(
        match view
            .scan_vals_rev(&p, &key::prefix_end(&p), 1)?
            .into_iter()
            .next()
        {
            Some((k, _)) => {
                let mut at = p.len();
                get_u64(&k, &mut at)
                    .ok_or_else(|| StoreError::Entry("a change feed key doesn't decode".into()))?
            }
            None => 0,
        },
    )
}

/// Each tag's cursor in `sort`'s order (None for one that isn't live): where it is, or, with an order given
/// (`Some(order)`, `None` inside for none), where it would be in the manual order with that order.
pub fn positions(
    view: &View,
    sort: u64,
    items: &[(u64, Option<Option<f64>>)],
) -> Result<Vec<Option<Vec<u8>>>, StoreError> {
    items
        .iter()
        .map(|&(t, order)| {
            let Some(mut p) = place(view, t)? else {
                return Ok(None);
            };
            if let Some(o) = order {
                p.order = o;
            }
            let c = carriers(view, t)?;
            Ok(Some(encode_cursor(sort, &suffix(sort, &p, c, t))))
        })
        .collect()
}

/// A queued move.
#[derive(Debug, Clone)]
pub struct Queued {
    pub seq: u64,
    pub tag: u64,
    pub after: bool,
    pub anchor: Option<u64>,
    pub value: Option<Vec<u8>>,
}

/// Up to `limit` queued moves after `after` (a `seq`), in order, and whether more follow.
pub fn queue(view: &View, after: u64, limit: usize) -> Result<(Vec<Queued>, bool), StoreError> {
    let p = key::of(key::TAG_QUEUE);
    let found = view.scan(
        &key::id(key::TAG_QUEUE, after.saturating_add(1)),
        &key::prefix_end(&p),
        limit.saturating_add(1),
    )?;
    let more = found.len() > limit;
    let mut out = Vec::new();
    for (_, b) in found.into_iter().take(limit) {
        let (r, _) = view.record(parse_loc(&b)?.pos)?;
        out.push(Queued {
            seq: id(&r, 0),
            tag: id(&r, 1),
            after: r.values[2] == Value::Bit(true),
            anchor: match r.values[3] {
                Value::Id(a) => Some(a),
                _ => None,
            },
            value: match &r.values[4] {
                Value::Text(v) => Some(v.clone()),
                _ => None,
            },
        });
    }
    Ok((out, more))
}

/// The reorder pass as its record holds it, with the live tags it has written and the live tags there are.
#[derive(Debug, Clone, Default)]
pub struct PassStatus {
    /// The last pass's id, 0 for none.
    pub pass: u64,
    pub mode: Option<u64>,
    pub phase: Option<u64>,
    pub n: Option<u64>,
    pub after: Option<Vec<u8>>,
    pub stamped: i64,
    pub live: i64,
}

pub fn pass_status(view: &View) -> Result<PassStatus, StoreError> {
    let mut st = PassStatus::default();
    if let Some(b) = view.get(&key::of(key::TAG_PASS))? {
        let (r, _) = view.record(parse_loc(&b)?.pos)?;
        let uint = |i: usize| match r.values.get(i) {
            Some(Value::UInt(v)) => Some(*v),
            _ => None,
        };
        st.pass = uint(0).unwrap_or(0);
        st.mode = uint(1);
        st.phase = uint(2);
        st.n = uint(3);
        st.after = match r.values.get(4) {
            Some(Value::Bytes(b)) => Some(b.clone()),
            _ => None,
        };
        if st.mode.is_some() {
            st.stamped = counter(view, &key::id(key::TAG_STAMPED, st.pass))?;
        }
    }
    for folder in [false, true] {
        for used in [false, true] {
            st.live += counter(view, &part_count_key(folder, used))?;
        }
    }
    Ok(st)
}
