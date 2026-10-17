//! The derivers: current values for `fav`, `textValue` and `textEdit` (with the entity's version), search
//! entries for the text fields that are searched, tag membership for `tagAssign`, a message's record and its
//! the cleaner's `moved` marker, and the test kind `testSet`. Each store stage adds its kinds' derivers here or in
//! its own module (`library`, `tags`, `chat`).

use super::StoreError;
use super::derive::{Deriver, Loc, Out, View};
use super::library;
use super::tags::{self, Written};
use crate::log::FILE_SHIFT;
use crate::log::format::{
    Ctx, FieldRef, Record, Value, encode, get_uvarint, kind_by_name, put_uvarint, wtf8_to_utf16,
};
use crate::search::{self, Scope};

/// Entry keys: a structure's id, then its key's components (`keyspace::val::put_u64` / `put_bytes`).
pub mod key {
    use crate::keyspace::val::{put_bytes, put_u64};
    use crate::log::format::FieldRef;

    /// Per log file: bytes of its records that nothing points at any more (a counter).
    pub const DEAD: u64 = 1;
    /// Per log file: its live fraction has fallen under u; the cleaner's queue.
    pub const CLEAN: u64 = 2;
    /// Per log file: cleaned; removed once the runs cover the log up to the position held.
    pub const GONE: u64 = 3;
    /// Per entity: the position of its latest record.
    pub const VERSION: u64 = 16;
    /// Per (position, entity): the entity last changed at that position (its `VERSION`); a deleted entity's entry
    /// holds its kind and key.
    pub const ENTITY_CHANGE: u64 = 84;
    /// Per entity: the record holding its fav bit.
    pub const FAV: u64 = 17;
    /// Per (entity, field): the text's last full value, size, and the edits since.
    pub const TEXT: u64 = 18;
    /// Per (entity, field, n): the n-th edit since the last full value.
    pub const TEXT_EDIT: u64 = 19;
    /// Search (`crate::search`).
    pub const SEARCH_POSTING: u64 = 32;
    pub const SEARCH_LENGTH: u64 = 35;
    /// Per (scope, term): its document counts (`crate::search::term_counts`).
    pub const SEARCH_TERM_COUNTS: crate::store::derive::AddMapKind =
        crate::store::derive::AddMapKind::new(208);
    pub const SEARCH_DOCS: u64 = 38;
    pub const SEARCH_MAX_DOC: u64 = 39;
    pub const SEARCH_BLOCK_MAX: u64 = 34;
    pub const SEARCH_SHORTEST: u64 = 44;
    /// Per (tag, entity): the `tagAssign` record assigning it, then the entity's number in the tag's numbering (a
    /// character or group).
    pub const MEMBER: u64 = 40;
    /// Per (entity, tag): assigned.
    pub const MEMBER_OF: u64 = 41;
    /// Per tag: its entities (a counter).
    pub const MEMBER_COUNT: u64 = 42;
    /// Per (tag, block of `1 << MEMBER_BITS` entity ids): a map of the entity's place → 1 for each carrier.
    pub const MEMBER_BLOCK: u64 = 45;
    pub const MEMBER_BITS: u32 = 14;

    pub fn member_block(tag: u64, entity: u64) -> Vec<u8> {
        ids(MEMBER_BLOCK, tag, entity >> MEMBER_BITS)
    }

    /// An entity's place in its member block.
    pub fn member_slot(entity: u64) -> u32 {
        (entity & ((1 << MEMBER_BITS) - 1)) as u32
    }
    /// Per message: its `messageAppend` record and its parent now (`chat::message_entry`).
    pub const MESSAGE: u64 = 43;
    /// Chats (`store::chat`). Per (message, field): its text's head; the n-th edit; its JSON value's record.
    pub const MSG_TEXT: u64 = 90;
    pub const MSG_TEXT_EDIT: u64 = 91;
    pub const MSG_VALUE: u64 = 92;
    /// Per (parent, time, message): a reply. Per (owner, time, message): a message opening the owner's tree.
    pub const CHILD: u64 = 93;
    pub const ROOT: u64 = 94;
    /// Per (message, field): its `messageTime` record.
    pub const MSG_TIME: u64 = 95;
    /// Per (space, key): the id an outside key names. Per (space, id): the `keyMap` record.
    pub const KEY_MAP: u64 = 96;
    pub const KEY_OF: u64 = 97;
    /// Per position: its `positionCreate`, `positionName`, `positionMode` record.
    pub const POSITION: u64 = 98;
    pub const POSITION_NAME: u64 = 99;
    pub const POSITION_MODE: u64 = 100;
    /// One more than the highest message, position, user id ever given (maxima).
    pub const NEXT_MESSAGE: u64 = 101;
    pub const NEXT_POSITION: u64 = 102;
    pub const NEXT_USER: u64 = 103;
    /// Per message moved off its first parent: its `messageParent` record.
    pub const MESSAGE_PARENT: u64 = 104;
    /// Per (owner, send key): the message stored for it.
    pub const SEND_KEY: u64 = 105;
    /// Per bookmark: the message it is at. Per (message, bookmark): a bookmark at it. Per (owner, bookmark): a
    /// bookmark in that owner's tree.
    pub const BOOKMARK_AT: u64 = 106;
    pub const BOOKMARKS_AT: u64 = 107;
    pub const TREE_BOOKMARK: u64 = 108;
    /// Per bookmark at a tree's root: the tree. Per (tree, bookmark): a bookmark at its root.
    pub const BOOKMARK_ROOT: u64 = 109;
    pub const ROOT_BOOKMARKS: u64 = 110;
    /// Per bookmark: the time key it has in its tree's order. Per (tree, time key, bookmark): a bookmark of the tree by
    /// the receive time of the message it is at (one at the root: when it was made), the compat chat list's
    /// newest-first order.
    pub const BOOKMARK_TIME: u64 = 156;
    pub const TREE_BOOKMARK_TIME: u64 = 157;
    /// Per bookmark: its latest `positionMove` record.
    pub const POSITION_MOVE: u64 = 158;
    /// The library (`store::library`).
    /// Per entity: its `entityCreate` record, then its number in the whole library's numbering (a character or
    /// group).
    pub const ENTITY: u64 = 50;
    /// Per (type, key): the entity.
    pub const ENTITY_KEY: u64 = 51;
    /// Per (scope, sort, type, fav, sort key, entity): nothing (the entity breaks ties).
    pub const ORDER: u64 = 52;
    /// Per (scope, type, fav, number): the entity at that number of the dense numbering.
    pub const RAND: u64 = 53;
    /// Per (scope, type, fav): its entities (a counter).
    pub const COUNT: u64 = 55;
    /// Per entity: its `dataSize`, `createDate` record.
    pub const DATA_SIZE: u64 = 56;
    pub const CREATE_DATE: u64 = 57;
    /// Per (entity, which): its `cardHash` record.
    pub const HASH: u64 = 58;
    /// Per (which, hash, entity): present.
    pub const HASH_INDEX: u64 = 59;
    /// Per (entity, list, position): the item.
    pub const ITEM: u64 = 60;
    /// Per (entity, list, item): its position and `itemPlace` record.
    pub const ITEM_AT: u64 = 61;
    /// Per (entity, field): its `jsonValue` record.
    pub const VALUE: u64 = 62;
    /// Per tag: its `tagMerge` record.
    pub const MERGE: u64 = 63;
    /// Per (target, tag): the tag merges into the target and its carriers aren't the target's yet.
    pub const MERGED_INTO: u64 = 64;
    /// Per tag: merged, and its carriers not yet moved.
    pub const FOLD: u64 = 65;
    /// One more than the highest entity id ever created (a maximum).
    pub const NEXT_ENTITY: u64 = 66;
    /// Tags (`store::tags`). Per (sort, folder bit, used bit, sort key, tag): the tag's place.
    pub const TAG_ORDER: u64 = 67;
    /// Per (folder bit, used bit): the live tags in that part (a counter).
    pub const TAG_PART_COUNT: u64 = 68;
    /// Per live tag: its place (folded name, folder type, manual order).
    pub const TAG_PLACE: u64 = 69;
    /// Per tag: its `tagOrder` record.
    pub const TAG_ORDER_REC: u64 = 70;
    /// Per (position, tag): the tag's definition last changed at that position.
    pub const TAG_CHANGE: u64 = 71;
    /// Per tag: the position of its `TAG_CHANGE` entry.
    pub const TAG_CHANGED: u64 = 72;
    /// Per (position, entity): the tags the entity carries last changed at that position.
    pub const ENTITY_TAG_CHANGE: u64 = 73;
    /// Per entity: the position of its `ENTITY_TAG_CHANGE` entry.
    pub const ENTITY_TAGS_CHANGED: u64 = 74;
    /// Per deleted tag's key: the tag.
    pub const TAG_GONE_KEY: u64 = 75;
    /// Per deleted tag: its key.
    pub const TAG_GONE_ID: u64 = 76;
    /// Per folded name a deleted tag had: the last tag deleted with it.
    pub const TAG_GONE_NAME: u64 = 159;
    /// Per queued move (by its record's position): its `tagQueue` record.
    pub const TAG_QUEUE: u64 = 77;
    /// The `tagPass` record.
    pub const TAG_PASS: u64 = 78;
    /// Per tag: the reorder pass that last wrote its order.
    pub const TAG_STAMP: u64 = 79;
    /// Per reorder pass: the live tags it has written (a counter).
    pub const TAG_STAMPED: u64 = 80;
    /// Per name: its `metaValue` record.
    pub const META: u64 = 81;
    /// The pair postings' option and pass (`search::pairs`); per state: its `searchPairs` record.
    pub const SEARCH_PAIRS: u64 = 82;
    pub const SEARCH_PAIRS_REC: u64 = 83;

    // ---- tag carriers by name term (`store::carriers`); a term is (`TermKind`, its text) ----
    /// Per (term, member block): per carrier's place, how many of its light-mapped tags' names hold the term.
    pub const TAG_CARRIERS: crate::store::derive::AddMapKind =
        crate::store::derive::AddMapKind::new(200);
    /// Per term: the carriers summed over the tags whose indexed name holds it (a counter).
    pub const TERM_CARRIERS: u64 = 201;
    /// Per (term, tag): the tag is heavy, settled with the term in its name, or moving from heavy with it in its
    /// mapped name.
    pub const TERM_HEAVY: u64 = 202;
    /// Per (term, tag): the tag is moving, the term in its mapped, target or indexed name.
    pub const TERM_MOVING: u64 = 203;
    /// Per tag that is heavy or moving: its side, and its move (`carriers::TagMap`).
    pub const TAG_MAP: u64 = 204;
    /// Per moving tag: nothing (the move queue).
    pub const MOVING: u64 = 205;
    /// Every tag's carriers, summed (a counter).
    pub const CARRIER_PAIRS: u64 = 206;
    /// The sides' scale and a re-siding scan (`carriers::Reside`).
    pub const RESIDE: u64 = 207;

    /// The prefix of a term's keys in a structure keyed by term first.
    pub fn term_key(structure: u64, kind: crate::search::TermKind, term: &str) -> Vec<u8> {
        let mut k = of(structure);
        put_u64(&mut k, kind as u64);
        put_bytes(&mut k, term.as_bytes());
        k
    }

    pub fn tag_carriers(
        kind: crate::search::TermKind,
        term: &str,
        block: u64,
    ) -> crate::store::derive::AddMapKey {
        TAG_CARRIERS.key(|k| {
            put_u64(k, kind as u64);
            put_bytes(k, term.as_bytes());
            put_u64(k, block);
        })
    }

    /// The prefix of a term's `TAG_CARRIERS` entries, for reading them; each is followed by its block.
    pub fn tag_carriers_of(kind: crate::search::TermKind, term: &str) -> Vec<u8> {
        let mut k = TAG_CARRIERS.prefix();
        put_u64(&mut k, kind as u64);
        put_bytes(&mut k, term.as_bytes());
        k
    }

    pub fn term_carriers(kind: crate::search::TermKind, term: &str) -> Vec<u8> {
        term_key(TERM_CARRIERS, kind, term)
    }

    pub fn term_heavy(kind: crate::search::TermKind, term: &str, tag: u64) -> Vec<u8> {
        let mut k = term_key(TERM_HEAVY, kind, term);
        put_u64(&mut k, tag);
        k
    }

    pub fn term_moving(kind: crate::search::TermKind, term: &str, tag: u64) -> Vec<u8> {
        let mut k = term_key(TERM_MOVING, kind, term);
        put_u64(&mut k, tag);
        k
    }

    #[cfg(any(test, feature = "measure"))]
    pub const TEST_SET: u64 = 4096;
    #[cfg(any(test, feature = "measure"))]
    pub const TEST_ORDER: u64 = 4097;
    #[cfg(any(test, feature = "measure"))]
    pub const TEST_COUNT: u64 = 4098;
    /// Per id: a map of added counts.
    #[cfg(test)]
    pub const TEST_ADD_MAP: crate::store::derive::AddMapKind =
        crate::store::derive::AddMapKind::new(4099);

    #[cfg(test)]
    pub fn test_add_map(id: u64) -> crate::store::derive::AddMapKey {
        TEST_ADD_MAP.key(|k| put_u64(k, id))
    }

    /// Whether `k` is in a structure whose keys are each put at most once (a change feed's, keyed by the position
    /// that put it): a delete of one put in the same unpublished layer can drop both (`derive::apply`).
    pub fn written_once(k: &[u8]) -> bool {
        matches!(
            crate::keyspace::val::get_u64(k, &mut 0),
            Some(ENTITY_CHANGE | TAG_CHANGE | ENTITY_TAG_CHANGE)
        )
    }

    pub fn of(structure: u64) -> Vec<u8> {
        let mut k = Vec::new();
        put_u64(&mut k, structure);
        k
    }

    pub fn id(structure: u64, id: u64) -> Vec<u8> {
        let mut k = of(structure);
        put_u64(&mut k, id);
        k
    }

    pub fn ids(structure: u64, a: u64, b: u64) -> Vec<u8> {
        let mut k = id(structure, a);
        put_u64(&mut k, b);
        k
    }

    pub fn field(structure: u64, entity: u64, f: &FieldRef) -> Vec<u8> {
        let mut k = id(structure, entity);
        match f {
            FieldRef::Code(c) => {
                k.push(1);
                put_u64(&mut k, *c);
            }
            FieldRef::Key(b) => {
                k.push(2);
                put_bytes(&mut k, b);
            }
        }
        k
    }

    pub fn edit(entity: u64, f: &FieldRef, n: u64) -> Vec<u8> {
        let mut k = field(TEXT_EDIT, entity, f);
        put_u64(&mut k, n);
        k
    }

    /// The first key after every key starting with `prefix`.
    pub fn prefix_end(prefix: &[u8]) -> Vec<u8> {
        let mut end = prefix.to_vec();
        while let Some(last) = end.pop() {
            if last < 0xff {
                end.push(last + 1);
                return end;
            }
        }
        vec![0xff; 9]
    }
}

pub fn file_of(pos: u64) -> u64 {
    pos >> FILE_SHIFT
}

pub(super) fn varints(vals: &[u64]) -> Vec<u8> {
    let mut out = Vec::new();
    for v in vals {
        put_uvarint(&mut out, *v);
    }
    out
}

pub(super) fn parse_varints<const N: usize>(b: &[u8]) -> Result<[u64; N], StoreError> {
    let mut out = [0; N];
    let mut at = 0;
    for v in &mut out {
        *v = get_uvarint(b, &mut at)
            .map_err(|_| StoreError::Entry("an entry doesn't decode".into()))?;
    }
    if at != b.len() {
        return Err(StoreError::Entry("an entry has bytes left over".into()));
    }
    Ok(out)
}

pub fn loc_bytes(l: Loc) -> Vec<u8> {
    varints(&[l.pos, l.len])
}

pub fn parse_loc(b: &[u8]) -> Result<Loc, StoreError> {
    let [pos, len] = parse_varints(b)?;
    Ok(Loc { pos, len })
}

pub(super) fn dead(out: &mut Out, l: Loc) {
    out.add(key::id(key::DEAD, file_of(l.pos)), l.len as i64);
}

/// `entity` changed at `at`: its version, and its place at the end of the entity change feed (one entry per entity).
pub(super) fn version(view: &View, out: &mut Out, entity: u64, at: Loc) -> Result<(), StoreError> {
    let vk = key::id(key::VERSION, entity);
    if let Some(b) = view.get(&vk)? {
        let old = parse_pos(&b)?;
        if old == at.pos {
            return Ok(());
        }
        out.del(key::ids(key::ENTITY_CHANGE, old, entity));
    }
    out.put(key::ids(key::ENTITY_CHANGE, at.pos, entity), Vec::new());
    out.put(vk, pos_bytes(at.pos));
    Ok(())
}

/// `entity` (of `kind`, keyed `k`) is deleted at `at`: its feed entry moves to the end, holding its kind and key, and
/// its version goes.
pub(super) fn version_gone(
    view: &View,
    out: &mut Out,
    entity: u64,
    kind: u64,
    k: &[u8],
    at: Loc,
) -> Result<(), StoreError> {
    let vk = key::id(key::VERSION, entity);
    if let Some(b) = view.get(&vk)? {
        out.del(key::ids(key::ENTITY_CHANGE, parse_pos(&b)?, entity));
    }
    let mut gone = Vec::new();
    put_uvarint(&mut gone, kind);
    gone.extend_from_slice(k);
    out.put(key::ids(key::ENTITY_CHANGE, at.pos, entity), gone);
    out.del(vk);
    Ok(())
}

pub fn pos_bytes(pos: u64) -> Vec<u8> {
    varints(&[pos])
}

pub fn parse_pos(b: &[u8]) -> Result<u64, StoreError> {
    let [pos] = parse_varints(b)?;
    Ok(pos)
}

pub(super) fn id(rec: &Record, i: usize) -> u64 {
    match rec.values[i] {
        Value::Id(v) | Value::UInt(v) | Value::Sel(_, v) => v,
        _ => unreachable!("checked by Record::new"),
    }
}

pub(super) fn field(rec: &Record, i: usize) -> &FieldRef {
    match &rec.values[i] {
        Value::Field(f) => f,
        _ => unreachable!("checked by Record::new"),
    }
}

pub(super) fn bytes(rec: &Record, i: usize) -> &[u8] {
    match &rec.values[i] {
        Value::Text(b) | Value::Bytes(b) => b,
        _ => unreachable!("checked by Record::new"),
    }
}

/// A kind whose record is the current value of one key: the entry at `key` points at it.
trait Pointer {
    fn key(&self, rec: &Record) -> Vec<u8>;

    /// Entries besides the pointer, given the record it replaces.
    fn others(
        &self,
        rec: &Record,
        at: Loc,
        old: Option<Loc>,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError>;
}

impl<P: Pointer + Sync> Deriver for P {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let k = self.key(rec);
        let old = view.get(&k)?.map(|b| parse_loc(&b)).transpose()?;
        self.others(rec, at, old, view, out)?;
        if let Some(old) = old {
            dead(out, old);
        }
        out.put(k, loc_bytes(at));
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        let cur = view.get(&self.key(rec))?;
        Ok(cur
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
            out.put(self.key(rec), loc_bytes(to));
        }
        Ok(())
    }
}

/// `searchPairs`: the latest is the option's record.
struct SearchPairs;

impl Pointer for SearchPairs {
    fn key(&self, _: &Record) -> Vec<u8> {
        key::of(key::SEARCH_PAIRS_REC)
    }

    fn others(
        &self,
        rec: &Record,
        _: Loc,
        _: Option<Loc>,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        search::pairs::turned(view, out, rec.values[0] == Value::Bit(true))
    }
}

struct Fav;

impl Pointer for Fav {
    fn key(&self, rec: &Record) -> Vec<u8> {
        key::id(key::FAV, id(rec, 0))
    }

    fn others(
        &self,
        rec: &Record,
        at: Loc,
        _: Option<Loc>,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        let fav = rec.values[1] == Value::Bit(true);
        library::change(view, out, id(rec, 0), |st| st.fav = fav)?;
        version(view, out, id(rec, 0), at)?;
        Ok(())
    }
}

// ---- text ----

/// What holds a value: a character, group or tag, or a message. Each has its own structures, so their ids never
/// meet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Holder {
    Entity(u64),
    Message(u64),
}

impl Holder {
    /// The holder named by the record's `Sel(HOLDER)` value at `i`.
    pub fn of(rec: &Record, i: usize) -> Holder {
        match rec.values[i] {
            Value::Sel(1, m) => Holder::Message(m),
            Value::Sel(_, e) | Value::Id(e) => Holder::Entity(e),
            _ => unreachable!("checked by Record::new"),
        }
    }

    pub fn id(self) -> u64 {
        match self {
            Holder::Entity(i) | Holder::Message(i) => i,
        }
    }

    /// The record value naming it.
    pub fn value(self) -> Value {
        match self {
            Holder::Entity(e) => Value::Sel(0, e),
            Holder::Message(m) => Value::Sel(1, m),
        }
    }

    pub fn text_key(self, f: &FieldRef) -> Vec<u8> {
        match self {
            Holder::Entity(e) => key::field(key::TEXT, e, f),
            Holder::Message(m) => key::field(key::MSG_TEXT, m, f),
        }
    }

    pub fn edit_key(self, f: &FieldRef, n: u64) -> Vec<u8> {
        let mut k = self.edits_prefix(f);
        crate::keyspace::val::put_u64(&mut k, n);
        k
    }

    fn edits_prefix(self, f: &FieldRef) -> Vec<u8> {
        match self {
            Holder::Entity(e) => key::field(key::TEXT_EDIT, e, f),
            Holder::Message(m) => key::field(key::MSG_TEXT_EDIT, m, f),
        }
    }

    pub fn value_key(self, f: &FieldRef) -> Vec<u8> {
        match self {
            Holder::Entity(e) => key::field(key::VALUE, e, f),
            Holder::Message(m) => key::field(key::MSG_VALUE, m, f),
        }
    }
}

/// A text value: its last full value, its size in bytes, and the edits since (count and encoded bytes).
#[derive(Debug, Clone, Copy)]
pub(super) struct Head {
    pub(super) full: Loc,
    size: u64,
    edits: u64,
    edit_bytes: u64,
}

impl Head {
    pub(super) fn new(full: Loc, size: u64) -> Head {
        Head {
            full,
            size,
            edits: 0,
            edit_bytes: 0,
        }
    }

    pub(super) fn with_edits(full: Loc, size: u64, edits: u64, edit_bytes: u64) -> Head {
        Head {
            full,
            size,
            edits,
            edit_bytes,
        }
    }

    pub(super) fn size(&self) -> u64 {
        self.size
    }

    pub(super) fn edits(&self) -> u64 {
        self.edits
    }

    pub(super) fn edit_bytes(&self) -> u64 {
        self.edit_bytes
    }

    pub(super) fn bytes(&self) -> Vec<u8> {
        varints(&[
            self.full.pos,
            self.full.len,
            self.size,
            self.edits,
            self.edit_bytes,
        ])
    }

    pub(super) fn get(view: &View, h: Holder, f: &FieldRef) -> Result<Option<Head>, StoreError> {
        view.get(&h.text_key(f))?
            .map(|b| Head::parse(&b))
            .transpose()
    }

    pub(super) fn parse(b: &[u8]) -> Result<Head, StoreError> {
        let [pos, len, size, edits, edit_bytes] = parse_varints(b)?;
        Ok(Head {
            full: Loc { pos, len },
            size,
            edits,
            edit_bytes,
        })
    }
}

/// The edits since the head's full value, in order.
fn edits(
    view: &View,
    h: Holder,
    f: &FieldRef,
    head: &Head,
) -> Result<Vec<(Vec<u8>, Loc)>, StoreError> {
    if head.edits == 0 {
        return Ok(Vec::new());
    }
    let start = h.edits_prefix(f);
    let end = key::prefix_end(&start);
    let found = view.scan(&start, &end, head.edits as usize)?;
    if found.len() as u64 != head.edits {
        return Err(StoreError::Entry(format!(
            "{h:?}'s text has {} edit entries, its head says {}",
            found.len(),
            head.edits
        )));
    }
    found
        .into_iter()
        .map(|(k, v)| Ok((k, parse_loc(&v)?)))
        .collect()
}

pub(super) fn apply_edit(
    text: &[u8],
    offset: u64,
    removed: u64,
    inserted: &[u8],
) -> Option<Vec<u8>> {
    let start = usize::try_from(offset).ok()?;
    let end = start.checked_add(usize::try_from(removed).ok()?)?;
    let kept_after = text.get(end..)?;
    let mut out = Vec::with_capacity(start + inserted.len() + kept_after.len());
    out.extend_from_slice(text.get(..start)?);
    out.extend_from_slice(inserted);
    out.extend_from_slice(kept_after);
    Some(out)
}

/// The full text a head's record holds: a `textValue`'s, or a message's own text in its `messageAppend`.
pub(super) fn full_text(rec: &Record) -> &[u8] {
    match rec.kind.name {
        "messageAppend" => bytes(rec, super::chat::APPEND_TEXT),
        _ => bytes(rec, 2),
    }
}

/// The text's current value: its full value with the edits since applied.
fn materialize(view: &View, h: Holder, f: &FieldRef, head: &Head) -> Result<Vec<u8>, StoreError> {
    let (full, _) = view.record(head.full.pos)?;
    let mut text = full_text(&full).to_vec();
    for (_, l) in edits(view, h, f, head)? {
        let (e, _) = view.record(l.pos)?;
        text = apply_edit(&text, id(&e, 2), id(&e, 3), bytes(&e, 4))
            .ok_or_else(|| StoreError::Entry(format!("an edit of {h:?}'s text is out of range")))?;
    }
    Ok(text)
}

/// The text a head entry (`Holder::text_key`) of entity `entity`'s field `f` stands for.
pub(super) fn text_of_head(
    view: &View,
    entity: u64,
    f: &FieldRef,
    head: &[u8],
) -> Result<Vec<u8>, StoreError> {
    materialize(view, Holder::Entity(entity), f, &Head::parse(head)?)
}

pub(super) fn text_value(
    view: &View,
    entity: u64,
    f: &FieldRef,
) -> Result<Option<Vec<u8>>, StoreError> {
    text_value_of(view, Holder::Entity(entity), f)
}

pub(super) fn text_value_of(
    view: &View,
    h: Holder,
    f: &FieldRef,
) -> Result<Option<Vec<u8>>, StoreError> {
    match Head::get(view, h, f)? {
        Some(head) => materialize(view, h, f, &head).map(Some),
        None => Ok(None),
    }
}

/// Whether the head's full value is a record other than the one holding the message itself, so it dies with
/// the value (a message's own text lives in its `messageAppend`, which lives on).
fn owns_full(view: &View, h: Holder, head: &Head) -> Result<bool, StoreError> {
    Ok(match h {
        Holder::Entity(_) => true,
        Holder::Message(m) => {
            super::chat::message_loc(view, m)?.is_none_or(|l| l.pos != head.full.pos)
        }
    })
}

/// Keeps a message's shape (`chat::SHAPE`) as its text head for `f` goes from the one the view holds to `after`
/// (the full value's position and the edits since; None: no head).
fn text_shape(
    view: &View,
    out: &mut Out,
    h: Holder,
    f: &FieldRef,
    after: Option<(u64, u64)>,
) -> Result<(), StoreError> {
    let Holder::Message(m) = h else {
        return Ok(());
    };
    let before = Head::get(view, h, f)?.map(|hd| (hd.full.pos, hd.edits));
    let d = if *f == FieldRef::Code(super::chat::MES) {
        let (l, rec) = super::chat::require_message(view, m)?;
        i64::from(super::chat::own_text_plain(l, &rec, before))
            - i64::from(super::chat::own_text_plain(l, &rec, after))
    } else {
        i64::from(after.is_some()) - i64::from(before.is_some())
    };
    super::chat::shape_add(out, m, d * super::chat::SHAPE_EXTRA);
    Ok(())
}

/// Removes the text value of (h, f), if it has one, with its search entries; its records die. Returns it.
pub(super) fn drop_text(
    view: &View,
    out: &mut Out,
    entity: u64,
    f: &FieldRef,
) -> Result<Option<Vec<u8>>, StoreError> {
    drop_text_of(view, out, Holder::Entity(entity), f)
}

/// `drop_text` for an entity whose searched fields `searched::gone` has removed already.
pub(super) fn drop_text_unsearched(
    view: &View,
    out: &mut Out,
    entity: u64,
    f: &FieldRef,
) -> Result<Option<Vec<u8>>, StoreError> {
    drop_text_with(view, out, Holder::Entity(entity), f, false)
}

pub(super) fn drop_text_of(
    view: &View,
    out: &mut Out,
    h: Holder,
    f: &FieldRef,
) -> Result<Option<Vec<u8>>, StoreError> {
    drop_text_with(view, out, h, f, true)
}

fn drop_text_with(
    view: &View,
    out: &mut Out,
    h: Holder,
    f: &FieldRef,
    search: bool,
) -> Result<Option<Vec<u8>>, StoreError> {
    let Some(head) = Head::get(view, h, f)? else {
        return Ok(None);
    };
    text_shape(view, out, h, f, None)?;
    let old = materialize(view, h, f, &head)?;
    match h {
        Holder::Entity(entity) => {
            if search {
                super::searched::text_written(view, out, entity, f, Some(&old), None)?;
            }
        }
        Holder::Message(m) => super::chat::text_changed(view, out, m, f, Some(&old), None)?,
    }
    if owns_full(view, h, &head)? {
        dead(out, head.full);
    }
    for (k, l) in edits(view, h, f, &head)? {
        dead(out, l);
        out.del(k);
    }
    out.del(h.text_key(f));
    Ok(Some(old))
}

/// Points the text's head or edit entry at `to` if it points at `from`; returns whether one did.
pub(super) fn repoint_text_of(
    h: Holder,
    f: &FieldRef,
    from: u64,
    to: Option<Loc>,
    view: &View,
    out: &mut Out,
) -> Result<bool, StoreError> {
    let Some(mut head) = Head::get(view, h, f)? else {
        return Ok(false);
    };
    if head.full.pos == from {
        if let Some(to) = to {
            head.full = to;
            out.put(h.text_key(f), head.bytes());
        }
        return Ok(true);
    }
    for (k, l) in edits(view, h, f, &head)? {
        if l.pos == from {
            if let Some(to) = to {
                // An edit's length counts toward the full-value rule, so the head follows the copy's.
                head.edit_bytes = head.edit_bytes - l.len + to.len;
                out.put(h.text_key(f), head.bytes());
                out.put(k, loc_bytes(to));
            }
            return Ok(true);
        }
    }
    Ok(false)
}

fn repoint_text(
    rec: &Record,
    from: u64,
    to: Option<Loc>,
    view: &View,
    out: &mut Out,
) -> Result<bool, StoreError> {
    repoint_text_of(Holder::of(rec, 0), field(rec, 1), from, to, view, out)
}

struct TextValue;

impl Deriver for TextValue {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (h, f) = (Holder::of(rec, 0), field(rec, 1));
        match h {
            Holder::Entity(entity) => {
                if super::searched::wants(view, entity, f)? {
                    let old = text_value(view, entity, f)?;
                    super::searched::text_written(
                        view,
                        out,
                        entity,
                        f,
                        old.as_deref(),
                        Some(bytes(rec, 2)),
                    )?;
                }
                library::drop_json(view, out, entity, f)?;
                library::text_changed(view, out, entity, f, Some(bytes(rec, 2)))?;
                tags::field_written(view, out, entity, at, f, Written::Text(bytes(rec, 2)))?;
            }
            Holder::Message(m) => {
                super::chat::edit_activity(
                    view,
                    out,
                    m,
                    super::chat::opt_id(rec, 3),
                    super::chat::opt_id(rec, 4),
                    at,
                )?;
                let old = text_value_of(view, h, f)?;
                super::chat::text_changed(view, out, m, f, old.as_deref(), Some(bytes(rec, 2)))?;
                library::drop_json_of(view, out, h, f)?;
            }
        }
        text_shape(view, out, h, f, Some((at.pos, 0)))?;
        if let Some(old) = Head::get(view, h, f)? {
            if owns_full(view, h, &old)? {
                dead(out, old.full);
            }
            for (k, l) in edits(view, h, f, &old)? {
                dead(out, l);
                out.del(k);
            }
        }
        out.put(
            h.text_key(f),
            Head::new(at, bytes(rec, 2).len() as u64).bytes(),
        );
        if let Holder::Entity(entity) = h {
            version(view, out, entity, at)?;
            super::books::touched(view, out, entity, at)?;
        }
        Ok(())
    }

    fn partition(&self, rec: &Record) -> u64 {
        Holder::of(rec, 0).id()
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        repoint_text(rec, pos, None, view, &mut Out::default())
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_text(rec, from, Some(to), view, out).map(drop)
    }
}

struct TextEdit;

impl Deriver for TextEdit {
    fn prepares(&self) -> bool {
        true
    }

    /// Applies the edit to the current value to check it; writes the new full value instead once the edits
    /// since the last one would reach the value's size (design 4.1), so a read stays within about twice it.
    fn prepare(&self, rec: Record, view: &View) -> Result<Record, StoreError> {
        let (h, f) = (Holder::of(&rec, 0), field(&rec, 1).clone());
        if let Holder::Message(m) = h {
            super::chat::require_message(view, m)?;
        }
        let head = Head::get(view, h, &f)?;
        let current = match &head {
            Some(hd) => materialize(view, h, &f, hd)?,
            None => Vec::new(),
        };
        let (offset, removed) = (id(&rec, 2), id(&rec, 3));
        let new = apply_edit(&current, offset, removed, bytes(&rec, 4)).ok_or_else(|| {
            StoreError::Refused(format!(
                "textEdit of {h:?}: bytes {offset}..{} are outside its {} bytes",
                offset.saturating_add(removed),
                current.len()
            ))
        })?;
        if wtf8_to_utf16(&new).is_err() {
            return Err(StoreError::Refused(format!(
                "textEdit of {h:?}: an offset falls inside a character"
            )));
        }
        let mut encoded = Vec::new();
        encode(&rec, &mut Ctx::default(), &mut encoded);
        if head.is_none_or(|hd| hd.edit_bytes + encoded.len() as u64 >= new.len() as u64) {
            return Ok(Record::new(
                kind_by_name("textValue").unwrap(),
                vec![
                    h.value(),
                    Value::Field(f),
                    Value::Text(new),
                    rec.values[5].clone(),
                    rec.values[6].clone(),
                ],
            )
            .expect("a textValue of a textEdit's values"));
        }
        Ok(rec)
    }

    fn partition(&self, rec: &Record) -> u64 {
        Holder::of(rec, 0).id()
    }

    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (h, f) = (Holder::of(rec, 0), field(rec, 1));
        if let Holder::Message(m) = h {
            super::chat::edit_activity(
                view,
                out,
                m,
                super::chat::opt_id(rec, 5),
                super::chat::opt_id(rec, 6),
                at,
            )?;
        }
        let mut head = Head::get(view, h, f)?
            .ok_or_else(|| StoreError::Entry(format!("a textEdit of {h:?} with no value")))?;
        let wants_old = match h {
            Holder::Entity(entity) => {
                super::searched::wants(view, entity, f)? || library::places(f) || tags::tag_field(f)
            }
            Holder::Message(_) => super::chat::text_watched(f),
        };
        if wants_old {
            let old = materialize(view, h, f, &head)?;
            let new = apply_edit(&old, id(rec, 2), id(rec, 3), bytes(rec, 4)).ok_or_else(|| {
                StoreError::Entry(format!("an edit of {h:?}'s text is out of range"))
            })?;
            match h {
                Holder::Entity(entity) => {
                    super::searched::text_written(view, out, entity, f, Some(&old), Some(&new))?;
                    library::text_changed(view, out, entity, f, Some(&new))?;
                    tags::field_written(view, out, entity, at, f, Written::Text(&new))?;
                }
                Holder::Message(m) => {
                    super::chat::text_changed(view, out, m, f, Some(&old), Some(&new))?
                }
            }
        }
        head.size = head.size.checked_sub(id(rec, 3)).ok_or_else(|| {
            StoreError::Entry(format!("a textEdit of {h:?} removes more than it has"))
        })? + bytes(rec, 4).len() as u64;
        text_shape(view, out, h, f, Some((head.full.pos, head.edits + 1)))?;
        head.edits += 1;
        head.edit_bytes += at.len;
        out.put(h.edit_key(f, head.edits), loc_bytes(at));
        out.put(h.text_key(f), head.bytes());
        if let Holder::Entity(entity) = h {
            version(view, out, entity, at)?;
            super::books::touched(view, out, entity, at)?;
        }
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        repoint_text(rec, pos, None, view, &mut Out::default())
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_text(rec, from, Some(to), view, out).map(drop)
    }
}

// ---- search ----

/// A searched field's values, for checking a phrase on them.
pub fn search_texts(
    view: &View,
    scope: Scope,
    doc: u64,
    field: u32,
) -> Result<Vec<Vec<u8>>, StoreError> {
    if scope.kind != search::CHAT {
        return super::searched::texts(view, scope, doc, field);
    }
    let Some(l) = super::chat::message_loc(view, doc)? else {
        return Ok(Vec::new());
    };
    let (rec, _) = view.record(l.pos)?;
    if id(&rec, super::chat::APPEND_OWNER) != scope.owner {
        return Ok(Vec::new());
    }
    let mes = FieldRef::Code(super::chat::MES);
    Ok(text_value_of(view, Holder::Message(doc), &mes)?
        .into_iter()
        .collect())
}

/// Test and measurement builds search fields of documents that aren't entities: library field i is code
/// `LIBRARY + i`, a tag's name `TAG_NAME`, a list field's items separated by `ITEM_SEPARATOR` in one text.
#[cfg(any(test, feature = "measure"))]
pub mod test_codes {
    use crate::log::format::FieldRef;
    use crate::search::Scope;

    pub const LIBRARY: u64 = 1000;
    pub const TAG_NAME: u64 = 1100;
    /// The list fields: card tags and alternate greetings.
    pub const CARD_TAGS: u32 = 8;
    pub const ALTERNATE_GREETINGS: u32 = 9;
    pub const ITEM_SEPARATOR: u8 = 0x1e;

    /// A searched text field: where, and whether its value is a list of items.
    #[derive(Debug, Clone, Copy)]
    pub struct SearchField {
        pub scope: Scope,
        pub field: u32,
        pub list: bool,
    }

    pub fn field(f: &FieldRef) -> Option<SearchField> {
        let FieldRef::Code(c) = *f else {
            return None;
        };
        if c == TAG_NAME {
            return Some(SearchField {
                scope: Scope::TAGS,
                field: 0,
                list: false,
            });
        }
        let i = u32::try_from(c.checked_sub(LIBRARY)?).ok()?;
        Scope::LIBRARY.fields().get(i as usize)?;
        Some(SearchField {
            scope: Scope::LIBRARY,
            field: i,
            list: i == CARD_TAGS || i == ALTERNATE_GREETINGS,
        })
    }

    pub fn code(scope: Scope, field: u32) -> Option<(FieldRef, bool)> {
        let c = match scope.kind {
            crate::search::TAGS => TAG_NAME,
            crate::search::LIBRARY => LIBRARY + u64::from(field),
            _ => return None,
        };
        let sf = self::field(&FieldRef::Code(c))?;
        (sf.scope == scope && sf.field == field).then_some((FieldRef::Code(c), sf.list))
    }

    pub fn items(text: &[u8], list: bool) -> Vec<&[u8]> {
        if text.is_empty() {
            Vec::new()
        } else if list {
            text.split(|b| *b == ITEM_SEPARATOR).collect()
        } else {
            vec![text]
        }
    }
}

#[cfg(any(test, feature = "measure"))]
pub(super) fn index_test_text(
    view: &View,
    out: &mut Out,
    sf: test_codes::SearchField,
    doc: u64,
    old: &[u8],
    new: &[u8],
) -> Result<(), StoreError> {
    search::index::update(
        view,
        out,
        sf.scope,
        doc,
        sf.field,
        &test_codes::items(old, sf.list),
        &test_codes::items(new, sf.list),
    )
}

#[cfg(any(test, feature = "measure"))]
pub(super) fn test_texts(
    view: &View,
    scope: Scope,
    doc: u64,
    field: u32,
) -> Result<Vec<Vec<u8>>, StoreError> {
    let Some((f, list)) = test_codes::code(scope, field) else {
        return Ok(Vec::new());
    };
    let text = text_value(view, doc, &f)?.unwrap_or_default();
    Ok(test_codes::items(&text, list)
        .into_iter()
        .map(<[u8]>::to_vec)
        .collect())
}

// ---- tag membership ----

/// `tagAssign`: the record assigning a tag to an entity is the (tag, entity) membership entry's value; an
/// unassignment removes the entry and points at nothing.
struct TagAssign;

/// Takes `entity` out of `tag`'s carriers, its record dead.
pub(super) fn unassign(
    view: &View,
    out: &mut Out,
    entity: u64,
    tag: u64,
) -> Result<bool, StoreError> {
    let k = key::ids(key::MEMBER, tag, entity);
    let Some(b) = view.get(&k)? else {
        return Ok(false);
    };
    dead(out, library::parse_host(&b)?.0);
    out.del(key::ids(key::MEMBER_OF, entity, tag));
    out.add(key::id(key::MEMBER_COUNT, tag), -1);
    out.map(
        key::member_block(tag, entity),
        vec![(key::member_slot(entity), 0)],
    );
    out.del(k);
    Ok(true)
}

/// Makes `entity` one of `tag`'s carriers, by the record at `at`; `n` is its number in the tag's numbering, kept
/// in the membership entry (`library::rank_host`).
pub(super) fn assign(out: &mut Out, entity: u64, tag: u64, at: Loc, existed: bool, n: Option<u64>) {
    if !existed {
        out.put(key::ids(key::MEMBER_OF, entity, tag), Vec::new());
        out.add(key::id(key::MEMBER_COUNT, tag), 1);
        out.map(
            key::member_block(tag, entity),
            vec![(key::member_slot(entity), 1)],
        );
    }
    out.put(
        key::ids(key::MEMBER, tag, entity),
        library::host_bytes(at, n),
    );
}

impl Deriver for TagAssign {
    /// A tag merged away is assigned as the tag it merged into (none: nothing is assigned).
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (entity, raw) = (id(rec, 0), id(rec, 1));
        let tag = library::resolve_tag(view, raw)?;
        if rec.values[2] == Value::Bit(true) {
            let Some(tag) = tag else {
                dead(out, at);
                return Ok(());
            };
            let k = key::ids(key::MEMBER, tag, entity);
            let old = view.get(&k)?.map(|b| library::parse_host(&b)).transpose()?;
            if let Some((old, n)) = old {
                dead(out, old);
                assign(out, entity, tag, at, true, n);
            } else {
                // The membership first: the tag's numbering keeps the entity's number in it.
                assign(out, entity, tag, at, false, None);
                library::change(view, out, entity, |st| {
                    st.tags.push(tag);
                    st.tags.sort_unstable();
                })?;
                tags::carriers_changed(view, out, tag, 1)?;
                super::carriers::changed(view, out, tag, entity, 1)?;
                tags::entity_touched(view, out, entity, at)?;
            }
        } else {
            dead(out, at);
            // A merged tag's own membership goes, never its target's: an entity that also carries the target
            // keeps it.
            if unassign(view, out, entity, raw)? {
                tags::carriers_changed(view, out, raw, -1)?;
                super::carriers::changed(view, out, raw, entity, -1)?;
                library::change(view, out, entity, |st| st.tags.retain(|t| *t != raw))?;
                tags::entity_touched(view, out, entity, at)?;
            }
        }
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        Ok(self.live_key(rec, pos, view)?.is_some())
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        if let Some(k) = self.live_key(rec, from, view)? {
            library::repoint_host(view, out, &k, from, to)?;
        }
        Ok(())
    }
}

impl TagAssign {
    /// The membership entry pointing at the record at `pos`: under its own tag, or, once merged away, the
    /// tag it leads to.
    fn live_key(&self, rec: &Record, pos: u64, view: &View) -> Result<Option<Vec<u8>>, StoreError> {
        let raw = id(rec, 1);
        let mut tags = vec![raw];
        if let Some(t) = library::resolve_tag(view, raw)?
            && t != raw
        {
            tags.push(t);
        }
        for t in tags {
            let k = key::ids(key::MEMBER, t, id(rec, 0));
            if library::live_host(view, &k, pos)? {
                return Ok(Some(k));
            }
        }
        Ok(None)
    }
}

/// `metaValue`: the value of a name the app keeps for itself.
struct MetaValue;

/// The entry holding a name's `metaValue` record.
pub fn meta_key(name: &[u8]) -> Vec<u8> {
    let mut k = key::of(key::META);
    crate::keyspace::val::put_bytes(&mut k, name);
    k
}

impl Deriver for MetaValue {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let k = meta_key(bytes(rec, 0));
        if let Some(b) = view.get(&k)? {
            dead(out, parse_loc(&b)?);
        }
        if rec.values[1] == Value::Absent {
            out.del(k);
            dead(out, at);
        } else {
            out.put(k, loc_bytes(at));
        }
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        Ok(view
            .get(&meta_key(bytes(rec, 0)))?
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
            out.put(meta_key(bytes(rec, 0)), loc_bytes(to));
        }
        Ok(())
    }
}

/// Each name's `metaValue` JSON, or None.
pub fn meta(view: &View, names: &[Vec<u8>]) -> Result<Vec<Option<Vec<u8>>>, StoreError> {
    names
        .iter()
        .map(|n| match view.get(&meta_key(n))? {
            Some(b) => {
                let (r, _) = view.record(parse_loc(&b)?.pos)?;
                Ok(match &r.values[1] {
                    Value::Text(t) => Some(t.clone()),
                    _ => None,
                })
            }
            None => Ok(None),
        })
        .collect()
}

/// `moved`: points nowhere; replay pairs it with the copy after it.
struct Moved;

impl Deriver for Moved {
    fn derive(&self, _: &Record, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Ok(())
    }

    fn is_live(&self, _: &Record, _: u64, _: &View) -> Result<bool, StoreError> {
        Ok(false)
    }

    fn repoint(&self, _: &Record, _: u64, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Ok(())
    }
}

#[cfg(any(test, feature = "measure"))]
struct TestSet;

#[cfg(any(test, feature = "measure"))]
impl Pointer for TestSet {
    fn key(&self, rec: &Record) -> Vec<u8> {
        key::id(key::TEST_SET, id(rec, 0))
    }

    fn others(
        &self,
        rec: &Record,
        _: Loc,
        old: Option<Loc>,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        let i = id(rec, 0);
        match old {
            Some(old) => {
                let (old, _) = view.record(old.pos)?;
                out.del(key::ids(key::TEST_ORDER, id(&old, 1), i));
            }
            None => out.add(key::of(key::TEST_COUNT), 1),
        }
        out.put(key::ids(key::TEST_ORDER, id(rec, 1), i), Vec::new());
        Ok(())
    }
}

static COUNTED_TEXT_VALUE: super::stats::Counted = super::stats::Counted(&TextValue);
static COUNTED_TEXT_EDIT: super::stats::Counted = super::stats::Counted(&TextEdit);
static COUNTED_JSON: super::stats::Counted = super::stats::Counted(&library::JsonValue);
static COUNTED_DELETE: super::stats::Counted = super::stats::Counted(&library::ValueDelete);
static COUNTED_APPEND: super::stats::Counted = super::stats::Counted(&super::chat::MessageAppend);
static COUNTED_MESSAGE_DELETE: super::stats::Counted =
    super::stats::Counted(&super::chat::MessageDelete);
static COUNTED_PARENT: super::stats::Counted = super::stats::Counted(&super::chat::MessageParent);
static COUNTED_TIME: super::stats::Counted = super::stats::Counted(&super::chat::MessageTime);

pub fn deriver(kind: &str) -> Option<&'static dyn Deriver> {
    Some(match kind {
        "fav" => &Fav,
        "textValue" => &COUNTED_TEXT_VALUE,
        "textEdit" => &COUNTED_TEXT_EDIT,
        "jsonValue" => &COUNTED_JSON,
        "valueDelete" => &COUNTED_DELETE,
        "messageAppend" => &COUNTED_APPEND,
        "messageDelete" => &COUNTED_MESSAGE_DELETE,
        "messageParent" => &COUNTED_PARENT,
        "messageTime" => &COUNTED_TIME,
        "tagAssign" => &TagAssign,
        "moved" => &Moved,
        "tagOrder" => &tags::TagOrder,
        "tagPassOrder" => &tags::TagOrder,
        "tagQueue" => &tags::TagQueue,
        "tagQueuePop" => &tags::TagQueuePop,
        "tagPass" => &tags::TagPass,
        "metaValue" => &MetaValue,
        "searchPairs" => &SearchPairs,
        "localImportMtime" => &super::local_import::MTIME_VALUE,
        "localImportSkip" => &super::local_import::SKIP_VALUE,
        #[cfg(any(test, feature = "measure"))]
        "testSet" => &TestSet,
        other => {
            return library::deriver(other)
                .or_else(|| super::books::deriver(other))
                .or_else(|| super::chat::deriver(other))
                .or_else(|| super::state::deriver(other))
                .or_else(|| super::history::deriver(other));
        }
    })
}
