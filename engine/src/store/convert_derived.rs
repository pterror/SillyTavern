//! One-off (src/migrations/convert-derived.js), deleted with the script once it has run: derived entries in their
//! new form.
//!
//! - Value heads: before, an entity field's value had one of three heads: `key::HEAD` (then named TEXT, structure
//!   18) for a text, VALUE (62) for a JSON value written whole, JSON_HEAD (211) for one written with its history.
//!   VALUE and JSON_HEAD entries move to `key::HEAD` (`Cur::Whole`, `Cur::Json`).
//! - Free entry keys: before, FREE_BY_START (197) kept a book's free intervals by their start; they move to
//!   `books::FREE`, by their end.
//!
//! A step takes the next entities (books, for free keys) holding an old entry and moves all of each one's entries,
//! in the commit queue, so no commit sees one half moved. Each moved entity's values (book's free intervals) are
//! read the old way before the step and the new way after it (`digest`, `free_digest`), for the script to compare.
//! `meta_names` lists `metaValue` names by prefix, for the script to delete the markers no read needs.

use super::StoreError;
use super::books;
use super::derive::{Loc, Out, View};
use super::history;
use super::kinds::{Cur, Head, key, parse_loc, parse_varints};
use super::library;
use super::library_read::{self, Stored};
use crate::keyspace::val::{get_bytes, get_u64};
use crate::log::format::{FieldRef, get_uvarint, put_uvarint};

const VALUE: u64 = 62;
const JSON_HEAD: u64 = 211;
const FREE_BY_START: u64 = 197;

/// A step's outcome: the entities moved, each with its values' digest read the old way; the books whose free keys
/// moved, each with its intervals' digest read the old way; the entries moved; fields left as they were because
/// they already had a `key::HEAD` entry; where the next step starts (None: done).
#[derive(Debug, Default)]
pub struct Step {
    pub moved: Vec<(u64, u64)>,
    pub books: Vec<(u64, u64)>,
    pub entries: u64,
    pub conflicts: Vec<String>,
    pub next: Option<(u64, u64)>,
}

fn id_of(k: &[u8], structure: u64) -> Result<u64, StoreError> {
    get_u64(k, &mut key::of(structure).len())
        .ok_or_else(|| StoreError::Entry("an old entry's key doesn't decode".into()))
}

fn old_json_head(b: &[u8]) -> Result<Cur, StoreError> {
    let [pos, len, size, edits, edit_bytes] = parse_varints(b)?;
    Ok(Cur::Json(Head::with_edits(
        Loc { pos, len },
        size,
        edits,
        edit_bytes,
    )))
}

fn fnv(h: &mut u64, b: &[u8]) {
    for &x in b {
        *h ^= u64::from(x);
        *h = h.wrapping_mul(0x100_0000_01b3);
    }
    *h ^= 0xff;
    *h = h.wrapping_mul(0x100_0000_01b3);
}

/// A digest of an entity's values, by field.
fn digest_of(values: Vec<(FieldRef, bool, Vec<u8>)>) -> u64 {
    let mut values: Vec<(Vec<u8>, bool, Vec<u8>)> = values
        .into_iter()
        .map(|(f, json, v)| {
            let name = match f {
                FieldRef::Code(c) => [&[0u8][..], &c.to_be_bytes()].concat(),
                FieldRef::Key(k) => [&[1u8][..], &k].concat(),
            };
            (name, json, v)
        })
        .collect();
    values.sort();
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for (name, json, v) in values {
        fnv(&mut h, &name);
        fnv(&mut h, &[u8::from(json)]);
        fnv(&mut h, &v);
    }
    h
}

/// Entity `e`'s values read the old way: its text heads, VALUE and JSON_HEAD.
fn digest_before(view: &View, e: u64) -> Result<u64, StoreError> {
    let mut values = Vec::new();
    for (s, kind) in [(key::HEAD, 0), (VALUE, 1), (JSON_HEAD, 2)] {
        let p = key::id(s, e);
        for (k, v) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
            let f = library::field_after(&k, s)?;
            let cur = match kind {
                0 => Cur::parse(&v)?,
                1 => Cur::Whole(parse_loc(&v)?),
                _ => old_json_head(&v)?,
            };
            let (json, value) = history::value_of(view, e, &f, &cur)?;
            values.push((f, json, value));
        }
    }
    Ok(digest_of(values))
}

/// Entity `e`'s values as reads find them now: an entity read, or (an entity whose entry is gone) its heads.
pub fn digest(view: &View, e: u64) -> Result<u64, StoreError> {
    if let Some(ent) = library_read::entity(view, e)? {
        return Ok(digest_of(
            ent.values
                .into_iter()
                .map(|(f, v)| match v {
                    Stored::Text(t) => (f, false, t),
                    Stored::Json(j) => (f, true, j),
                })
                .collect(),
        ));
    }
    let p = key::id(key::HEAD, e);
    let mut values = Vec::new();
    for (k, v) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        let f = library::field_after(&k, key::HEAD)?;
        let (json, value) = history::value_of(view, e, &f, &Cur::parse(&v)?)?;
        values.push((f, json, value));
    }
    Ok(digest_of(values))
}

fn uvarint_of(v: &[u8]) -> Result<u64, StoreError> {
    get_uvarint(v, &mut 0).map_err(|_| StoreError::Entry("a free interval doesn't decode".into()))
}

/// A book's free intervals in `structure` (old: by start; new: by end), as (start, end).
fn intervals(view: &View, structure: u64, book: u64) -> Result<Vec<(u64, u64)>, StoreError> {
    let p = key::id(structure, book);
    let mut out = Vec::new();
    for (k, v) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        let at = get_u64(&k, &mut p.len())
            .ok_or_else(|| StoreError::Entry("a free key doesn't decode".into()))?;
        let other = uvarint_of(&v)?;
        out.push(if structure == FREE_BY_START {
            (at, other)
        } else {
            (other, at)
        });
    }
    out.sort_unstable();
    Ok(out)
}

fn digest_intervals(iv: &[(u64, u64)]) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for (s, e) in iv {
        fnv(&mut h, &s.to_be_bytes());
        fnv(&mut h, &e.to_be_bytes());
    }
    h
}

/// Book `book`'s free intervals as reads find them now.
pub fn free_digest(view: &View, book: u64) -> Result<u64, StoreError> {
    Ok(digest_intervals(&intervals(view, books::FREE, book)?))
}

/// Moves the old entries of up to `limit` entities or books from `from` (structure VALUE, FREE_BY_START, then
/// JSON_HEAD; id) on.
pub fn step(
    view: &View,
    out: &mut Out,
    from: (u64, u64),
    limit: usize,
) -> Result<Step, StoreError> {
    let mut st = Step::default();
    let (mut s, mut e) = from;
    // In structure order, which `from` goes by.
    for structure in [VALUE, FREE_BY_START, JSON_HEAD] {
        if structure < s {
            continue;
        }
        if structure > s {
            (s, e) = (structure, 0);
        }
        let end = key::prefix_end(&key::of(structure));
        while st.moved.len() + st.books.len() < limit {
            let Some((k, _)) = view
                .scan(&key::id(structure, e), &end, 1)?
                .into_iter()
                .next()
            else {
                break;
            };
            let id = id_of(&k, structure)?;
            if structure == FREE_BY_START {
                let iv = intervals(view, FREE_BY_START, id)?;
                if !intervals(view, books::FREE, id)?.is_empty() {
                    st.conflicts
                        .push(format!("book {id}: free keys in both forms"));
                } else {
                    let p = key::id(FREE_BY_START, id);
                    for (k, _) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
                        out.del(k);
                    }
                    for &(start, end) in &iv {
                        let mut v = Vec::new();
                        put_uvarint(&mut v, start);
                        out.put(key::ids(books::FREE, id, end), v);
                        st.entries += 1;
                    }
                    st.books.push((id, digest_intervals(&iv)));
                }
                e = id + 1;
                continue;
            }
            // An entity moves whole or not at all: a field with a head and an old entry too has two current values,
            // which this doesn't choose between.
            let mut moves = Vec::new();
            let mut conflicts = Vec::new();
            for old in [VALUE, JSON_HEAD] {
                let p = key::id(old, id);
                for (k, v) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
                    let f = library::field_after(&k, old)?;
                    let hk = key::field(key::HEAD, id, &f);
                    if view.get(&hk)?.is_some() || moves.iter().any(|(h, _, _)| *h == hk) {
                        conflicts.push(format!(
                            "entity {id} field {f:?}: a head and an old {} entry",
                            if old == VALUE { "VALUE" } else { "JSON_HEAD" }
                        ));
                        continue;
                    }
                    let cur = if old == VALUE {
                        Cur::Whole(parse_loc(&v)?)
                    } else {
                        old_json_head(&v)?
                    };
                    moves.push((hk, k, cur));
                }
            }
            if conflicts.is_empty() {
                let before = digest_before(view, id)?;
                for (hk, k, cur) in moves {
                    out.put(hk, cur.bytes());
                    out.del(k);
                    st.entries += 1;
                }
                st.moved.push((id, before));
            } else {
                st.conflicts.extend(conflicts);
            }
            e = id + 1;
        }
        if st.moved.len() + st.books.len() >= limit {
            st.next = Some((structure, e));
            return Ok(st);
        }
    }
    Ok(st)
}

/// Whether any entry is still in an old form: the server refuses to serve such a store until the script has run.
pub fn pending(view: &View) -> Result<bool, StoreError> {
    for s in [VALUE, JSON_HEAD, FREE_BY_START] {
        let p = key::of(s);
        if !view.scan(&p, &key::prefix_end(&p), 1)?.is_empty() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Up to `limit` `metaValue` names starting with `prefix`, after `after` (exclusive) if given.
pub fn meta_names(
    view: &View,
    prefix: &[u8],
    after: Option<&[u8]>,
    limit: usize,
) -> Result<Vec<Vec<u8>>, StoreError> {
    let base = key::of(key::META);
    // A name's bytes go into its key as they are (`put_bytes` escapes only zeros), so the names starting with a
    // prefix without zeros are one range of keys.
    if prefix.contains(&0) {
        return Err(StoreError::Refused(
            "a meta prefix holds no zero byte".into(),
        ));
    }
    let mut start = base.clone();
    start.extend_from_slice(prefix);
    let end = key::prefix_end(&start);
    let from = match after {
        Some(a) => {
            let mut k = super::kinds::meta_key(a);
            k.push(0);
            k
        }
        None => start,
    };
    view.scan(&from, &end, limit)?
        .into_iter()
        .map(|(k, _)| {
            get_bytes(&k, &mut base.len())
                .ok_or_else(|| StoreError::Entry("a meta key doesn't decode".into()))
        })
        .collect()
}
