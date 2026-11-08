use std::collections::BTreeMap;

use super::StoreError;
use super::books::{BOOK, ENTRY, EntryKey, OWNED, parse_entry_key};
use super::derive::{Out, View};
use super::kinds::key;
use super::library::{counter, entity_info};
use crate::log::format::{FieldRef, get_uvarint, put_uvarint};

pub const STAT_FIELD: u64 = 219;
pub const STAT_ENTRY: u64 = 220;
pub const STAT_BOOK: u64 = 221;

const BYTES: u64 = 0;
const HASH: u64 = 1;
const ENTRIES: u64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Stat {
    pub bytes: i64,
    pub hash: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BookStat {
    pub bytes: i64,
    pub hash: i64,
    pub entries: i64,
}

pub fn field_hash(f: &FieldRef, json: bool, v: &[u8]) -> i64 {
    let mut b = Vec::with_capacity(v.len() + 16);
    match f {
        FieldRef::Code(c) => {
            b.push(1);
            b.extend_from_slice(&c.to_le_bytes());
        }
        FieldRef::Key(k) => {
            b.push(2);
            put_uvarint(&mut b, k.len() as u64);
            b.extend_from_slice(k);
        }
    }
    b.push(if json { 4 } else { 3 });
    b.extend_from_slice(v);
    let hi = crc32c::crc32c_append(0x9e37_79b9, &b);
    let lo = crc32c::crc32c_append(0x85eb_ca6b, &b);
    (u64::from(hi) << 32 | u64::from(lo)) as i64
}

#[derive(Clone)]
enum Owner {
    Entry { book: u64, own_key: EntryKey },
    Book,
}

fn owner(view: &View, e: u64) -> Result<Option<Owner>, StoreError> {
    let Some((kind, k, _)) = entity_info(view, e)? else {
        return Ok(None);
    };
    owner_of(view, kind, &k)
}

fn counted_book(view: &View, book: u64) -> Result<bool, StoreError> {
    Ok(match entity_info(view, book)? {
        Some((BOOK, _, _)) => true,
        Some((OWNED, bk, _)) => bk.ends_with(b":c"),
        _ => false,
    })
}

fn owner_of(view: &View, kind: u64, k: &[u8]) -> Result<Option<Owner>, StoreError> {
    Ok(match kind {
        ENTRY => {
            let (book, own_key) = parse_entry_key(k)?;
            counted_book(view, book)?.then_some(Owner::Entry { book, own_key })
        }
        BOOK => Some(Owner::Book),
        OWNED if k.ends_with(b":c") => Some(Owner::Book),
        _ => None,
    })
}

fn slot_key(e: u64, f: &FieldRef, json: bool) -> Vec<u8> {
    let mut k = key::field(STAT_FIELD, e, f);
    k.push(u8::from(json));
    k
}

fn field_stat(view: &View, e: u64, f: &FieldRef, json: bool) -> Result<Stat, StoreError> {
    let Some(b) = view.get(&slot_key(e, f, json))? else {
        return Ok(Stat::default());
    };
    let mut at = 0;
    let bad = || StoreError::Entry("a field stat doesn't decode".into());
    let bytes = get_uvarint(&b, &mut at).map_err(|_| bad())?;
    let hash = get_uvarint(&b, &mut at).map_err(|_| bad())?;
    Ok(Stat {
        bytes: bytes as i64,
        hash: hash as i64,
    })
}

fn add(out: &mut Out, structure: u64, id: u64, d: Stat) {
    if d.bytes != 0 {
        out.add(key::ids(structure, id, BYTES), d.bytes);
    }
    if d.hash != 0 {
        out.add(key::ids(structure, id, HASH), d.hash);
    }
}

pub fn entry_key_of_counted_book(
    view: &View,
    k: &[u8],
) -> Result<Option<(u64, EntryKey)>, StoreError> {
    Ok(match owner_of(view, ENTRY, k)? {
        Some(Owner::Entry { book, own_key }) => Some((book, own_key)),
        _ => None,
    })
}

pub fn entry_of_counted_book(view: &View, e: u64) -> Result<Option<(u64, EntryKey)>, StoreError> {
    Ok(match owner(view, e)? {
        Some(Owner::Entry { book, own_key }) => Some((book, own_key)),
        _ => None,
    })
}

pub fn tracked(view: &View, e: u64) -> Result<bool, StoreError> {
    Ok(owner(view, e)?.is_some())
}

pub fn value_changed(
    view: &View,
    out: &mut Out,
    e: u64,
    f: &FieldRef,
    json: bool,
    new: Option<&[u8]>,
) -> Result<(), StoreError> {
    let Some(o) = owner(view, e)? else {
        return Ok(());
    };
    owned_value_changed(view, out, &o, e, f, json, new)
}

fn owned_value_changed(
    view: &View,
    out: &mut Out,
    o: &Owner,
    e: u64,
    f: &FieldRef,
    json: bool,
    new: Option<&[u8]>,
) -> Result<(), StoreError> {
    if let Owner::Entry { book, own_key } = o {
        if !json {
            super::references::key_written(view, out, *book, e, f, new)?;
        } else if super::relations::is_relations_field(f) {
            super::relations::relations_field_written(view, out, *book, e, own_key, new)?;
        }
    } else if let Some(kind) = super::relations::kind_of_relation_kind_field(f) {
        out.put(
            super::commit_checks::relation_kind_check_key(e, kind),
            Vec::new(),
        );
        let mut writes = super::world_order_tree::LayeredWrites::new(view);
        super::relations::refresh_kind_merge_state(&mut writes, e, kind, Some(new.is_some() && !json), None)?;
        writes.finish(out);
    } else if let Some(kind) = super::relations::kind_of_relation_kind_merge_field(f) {
        let into = new.and_then(super::relations::merge_target_of_text).filter(|_| !json);
        out.put(
            super::commit_checks::relation_kind_check_key(e, kind),
            Vec::new(),
        );
        if let Some(into) = into {
            out.put(
                super::commit_checks::relation_kind_check_key(e, into),
                Vec::new(),
            );
        }
        let mut writes = super::world_order_tree::LayeredWrites::new(view);
        super::relations::refresh_kind_merge_state(&mut writes, e, kind, None, Some(into))?;
        writes.finish(out);
    }
    let old = field_stat(view, e, f, json)?;
    let now = match new {
        Some(v) => Stat {
            bytes: v.len() as i64,
            hash: field_hash(f, json, v),
        },
        None => Stat::default(),
    };
    if old == now {
        return Ok(());
    }
    let k = slot_key(e, f, json);
    match new {
        Some(_) => {
            let mut b = Vec::new();
            put_uvarint(&mut b, now.bytes as u64);
            put_uvarint(&mut b, now.hash as u64);
            out.put(k, b);
        }
        None => out.del(k),
    }
    let d = Stat {
        bytes: now.bytes - old.bytes,
        hash: now.hash.wrapping_sub(old.hash),
    };
    match o {
        Owner::Entry { book, .. } => {
            add(out, STAT_ENTRY, e, d);
            add(out, STAT_BOOK, *book, d);
        }
        Owner::Book => add(out, STAT_BOOK, e, d),
    }
    Ok(())
}

pub fn created(view: &View, out: &mut Out, e: u64, kind: u64, k: &[u8]) -> Result<(), StoreError> {
    let Some(o) = owner_of(view, kind, k)? else {
        return Ok(());
    };
    let mut local = BTreeMap::new();
    if let Owner::Entry { book, own_key } = &o {
        out.add(key::ids(STAT_BOOK, *book, ENTRIES), 1);
        let mut placed = Out::default();
        super::relations::entry_created(view, &mut placed, *book, e, own_key)?;
        out.entries.extend(placed.entries.iter().cloned());
        placed.apply(&mut local);
    }
    let view = &view.with_layer(&local);
    let p = key::id(key::HEAD, e);
    for (hk, _) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        let f = super::library::field_after(&hk, key::HEAD)?;
        if let Some(t) = super::kinds::text_value(view, e, &f)? {
            owned_value_changed(view, out, &o, e, &f, false, Some(&t))?;
        }
        if let Some(j) = super::history::json_value(view, e, &f)? {
            owned_value_changed(view, out, &o, e, &f, true, Some(&j))?;
        }
    }
    Ok(())
}

fn drop_fields(view: &View, out: &mut Out, e: u64) -> Result<(), StoreError> {
    let p = key::id(STAT_FIELD, e);
    for (k, _) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        out.del(k);
    }
    Ok(())
}

pub fn gone(
    view: &View,
    out: &mut Out,
    e: u64,
    kind: u64,
    k: &[u8],
    erased: bool,
) -> Result<(), StoreError> {
    if kind == ENTRY {
        if let Some(Owner::Entry { book, own_key }) = owner_of(view, kind, k)? {
            super::relations::entry_deleted(view, out, book, e, &own_key, erased)?;
            let s = entry_stat(view, e)?;
            add(
                out,
                STAT_BOOK,
                book,
                Stat {
                    bytes: -s.bytes,
                    hash: s.hash.wrapping_neg(),
                },
            );
            out.add(key::ids(STAT_BOOK, book, ENTRIES), -1);
        }
        let (book, _) = parse_entry_key(k)?;
        super::references::entry_gone(view, out, book, e)?;
        out.del(key::ids(STAT_ENTRY, e, BYTES));
        out.del(key::ids(STAT_ENTRY, e, HASH));
        return drop_fields(view, out, e);
    }
    match owner_of(view, kind, k)? {
        Some(Owner::Entry { .. }) => Ok(()),
        Some(Owner::Book) => {
            for part in [BYTES, HASH, ENTRIES] {
                out.del(key::ids(STAT_BOOK, e, part));
            }
            drop_fields(view, out, e)
        }
        None => Ok(()),
    }
}

pub fn entry_stat(view: &View, e: u64) -> Result<Stat, StoreError> {
    Ok(Stat {
        bytes: counter(view, &key::ids(STAT_ENTRY, e, BYTES))?,
        hash: counter(view, &key::ids(STAT_ENTRY, e, HASH))?,
    })
}

pub fn book_stat(view: &View, book: u64) -> Result<BookStat, StoreError> {
    Ok(BookStat {
        bytes: counter(view, &key::ids(STAT_BOOK, book, BYTES))?,
        hash: counter(view, &key::ids(STAT_BOOK, book, HASH))?,
        entries: counter(view, &key::ids(STAT_BOOK, book, ENTRIES))?,
    })
}
