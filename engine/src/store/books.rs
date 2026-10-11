//! World info (build path 5c): books, their entries, and the lorebook links naming them.
//!
//! A book is an entity: a world book of type `BOOK`, keyed by its file stem (what every route's `name` finds), or a
//! book a character or another book owns (`OWNED`: a card's `character_book`, a book's `originalData`), keyed by its
//! owner. A `BOOK` entity without its definition marker (`DEFINED`) is an unresolved book: a name a link holds that
//! no book has (now, or since the book was deleted). An entry is an entity of type `ENTRY`, keyed by its book and its
//! key in the book (`entry_key`). Book and entry values are the entity's values; an entry's place in its book is the
//! item `entry` of the book's list `ENTRIES`.
//!
//! Derived here: the defined world books by key (`BOOKS`); per book, its entries by `displayIndex` (`ENTRY_INDEX`,
//! whose last is the book's highest) and the integer keys no entry has (`FREE`, as intervals); each character's link
//! (`LINK`) and each book's linkers (`LINKED`); forwards from an unresolved book to the book it resolves as
//! (`FORWARD`, `FORWARDED`).

use super::StoreError;
use super::derive::{Deriver, Loc, Out, View};
use super::kinds::{dead, id, key, loc_bytes, parse_loc, version};
use super::library::{self, entity_info, uvarint};
use crate::keyspace::val::{get_u64, put_bytes, put_u64};
use crate::log::format::{FieldRef, Record, Value, get_uvarint};

/// Entity types.
pub const BOOK: u64 = 3;
pub const OWNED: u64 = 4;
pub const ENTRY: u64 = 5;

/// A book's list of its entries (item = the entry's id).
pub const ENTRIES: u64 = 0;

/// A world book's definition marker (empty JSON): without it, the book is an unresolved name.
pub const DEFINED: u64 = 41;

/// Structures.
/// Per defined world book's key: the book.
pub const BOOKS: u64 = 190;
/// Per (book, index, entry): the entry's `displayIndex` as JavaScript's `Number()` reads it.
pub const ENTRY_INDEX: u64 = 191;
/// Per entry: its `entryIndex` record.
pub const ENTRY_INDEX_AT: u64 = 192;
/// Per character: its `bookLink` record.
pub const LINK: u64 = 193;
/// Per (book, character): the character links the book.
pub const LINKED: u64 = 194;
/// Per unresolved book: the book it resolves as, and its `bookForward` record.
pub const FORWARD: u64 = 195;
/// Per (book, unresolved book): the unresolved book resolves as the book.
pub const FORWARDED: u64 = 196;
/// Per (book, start): integer entry keys from `start` up to the value (exclusive; `u64::MAX`: no end) are free. A
/// book with none has every integer key free.
pub const FREE: u64 = 197;

/// The largest integer entry key: JavaScript's safe integers.
pub const MAX_INT_KEY: u64 = (1 << 53) - 1;

fn err(why: &str) -> StoreError {
    StoreError::Entry(format!("books: {why}"))
}

/// An entry's key in its book: an integer (a canonical decimal string up to `MAX_INT_KEY`) or other text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntryKey {
    Int(u64),
    Text(Vec<u8>),
}

impl EntryKey {
    /// The key a book's `entries` object holds the entry under (WTF-8).
    pub fn parse(text: &[u8]) -> EntryKey {
        let canonical = !text.is_empty()
            && text.iter().all(u8::is_ascii_digit)
            && (text.len() == 1 || text[0] != b'0')
            && text.len() <= 16;
        if canonical
            && let Ok(n) = std::str::from_utf8(text).unwrap_or("x").parse::<u64>()
            && n <= MAX_INT_KEY
        {
            return EntryKey::Int(n);
        }
        EntryKey::Text(text.to_vec())
    }

    pub fn text(&self) -> Vec<u8> {
        match self {
            EntryKey::Int(n) => n.to_string().into_bytes(),
            EntryKey::Text(t) => t.clone(),
        }
    }
}

/// An entry entity's key: its book's id in decimal, `:`, then its key in the book.
pub fn entry_key(book: u64, k: &EntryKey) -> Vec<u8> {
    let mut out = format!("{book}:").into_bytes();
    out.extend_from_slice(&k.text());
    out
}

pub fn parse_entry_key(b: &[u8]) -> Result<(u64, EntryKey), StoreError> {
    let bad = || StoreError::Refused("an entry's key is its book's id, `:`, then its key".into());
    let colon = b.iter().position(|c| *c == b':').ok_or_else(bad)?;
    let book = std::str::from_utf8(&b[..colon])
        .ok()
        .filter(|d| !d.is_empty() && d.bytes().all(|c| c.is_ascii_digit()))
        .and_then(|d| d.parse::<u64>().ok())
        .ok_or_else(bad)?;
    Ok((book, EntryKey::parse(&b[colon + 1..])))
}

fn is_defined(view: &View, book: u64) -> Result<bool, StoreError> {
    Ok(view
        .get(&key::field(key::VALUE, book, &FieldRef::Code(DEFINED)))?
        .is_some())
}

fn books_key(k: &[u8]) -> Vec<u8> {
    let mut out = key::of(BOOKS);
    put_bytes(&mut out, k);
    out
}

/// A value of entity `e` was written (`on`) or removed: a world book's marker defines it or makes it unresolved.
pub fn field_written(
    view: &View,
    out: &mut Out,
    e: u64,
    f: &FieldRef,
    on: bool,
) -> Result<(), StoreError> {
    if *f != FieldRef::Code(DEFINED) {
        return Ok(());
    }
    let Some((BOOK, k, _)) = entity_info(view, e)? else {
        return Ok(());
    };
    if on {
        out.put(books_key(&k), uvarint(e));
    } else {
        out.del(books_key(&k));
    }
    Ok(())
}

/// A world book comes to be, its values (the marker among them) already in `view`.
pub fn created(view: &View, out: &mut Out, e: u64, k: &[u8]) -> Result<(), StoreError> {
    if is_defined(view, e)? {
        out.put(books_key(k), uvarint(e));
    }
    Ok(())
}

/// A world book's key changes.
pub fn rekeyed(
    view: &View,
    out: &mut Out,
    e: u64,
    old: &[u8],
    new: &[u8],
) -> Result<(), StoreError> {
    if is_defined(view, e)? {
        out.del(books_key(old));
        out.put(books_key(new), uvarint(e));
    }
    Ok(())
}

/// An entry comes to be: its integer key is no longer free. Refused when its book isn't a book.
pub fn entry_created(view: &View, out: &mut Out, k: &[u8]) -> Result<(), StoreError> {
    let (book, ek) = parse_entry_key(k)?;
    if !matches!(entity_info(view, book)?, Some((BOOK | OWNED, _, _))) {
        return Err(StoreError::Refused(format!("no book {book}")));
    }
    if view.is_bulk() {
        return Err(StoreError::Refused("entries aren't bulk loaded".into()));
    }
    if let EntryKey::Int(n) = ek {
        take_free(view, out, book, n)?;
    }
    Ok(())
}

/// An entry goes: its place in its book, its index and its integer key.
pub fn entry_gone(view: &View, out: &mut Out, e: u64, k: &[u8]) -> Result<(), StoreError> {
    let (book, ek) = parse_entry_key(k)?;
    let ak = item_at_key(book, e);
    if let Some(b) = view.get(&ak)? {
        let mut at = 0;
        let p = get_uvarint(&b, &mut at).map_err(|_| err("an entry's place doesn't decode"))?;
        dead(out, parse_loc(&b[at..])?);
        let mut ik = key::ids(key::ITEM, book, ENTRIES);
        put_u64(&mut ik, p);
        out.del(ik);
        out.del(ak);
    }
    drop_index(view, out, e)?;
    if let EntryKey::Int(n) = ek {
        give_free(view, out, book, n)?;
    }
    Ok(())
}

fn item_at_key(book: u64, entry: u64) -> Vec<u8> {
    let mut k = key::ids(key::ITEM_AT, book, ENTRIES);
    put_u64(&mut k, entry);
    k
}

/// A character goes: its link goes.
pub fn linker_gone(view: &View, out: &mut Out, e: u64) -> Result<(), StoreError> {
    if let Some((l, Some(book))) = link_of(view, e)? {
        dead(out, l);
        out.del(key::ids(LINKED, book, e));
        out.del(key::id(LINK, e));
    }
    Ok(())
}

/// The `bookLink` record of `e` and the book it names.
pub fn link_of(view: &View, e: u64) -> Result<Option<(Loc, Option<u64>)>, StoreError> {
    let Some(b) = view.get(&key::id(LINK, e))? else {
        return Ok(None);
    };
    let l = parse_loc(&b)?;
    let (rec, _) = view.record(l.pos)?;
    Ok(Some((l, opt_id(&rec, 1))))
}

fn opt_id(rec: &Record, i: usize) -> Option<u64> {
    match rec.values[i] {
        Value::Id(v) => Some(v),
        _ => None,
    }
}

/// A record at `at` changed entity `e`: when it is an entry or an owned book, the book holding it, and that book's
/// owner, changed too (their versions follow, so a page's copy of a book or card is known stale).
pub fn touched(view: &View, out: &mut Out, e: u64, at: Loc) -> Result<(), StoreError> {
    match entity_info(view, e)? {
        Some((kind, k, _)) => container_touched(view, out, kind, &k, at),
        None => Ok(()),
    }
}

/// An entity of type `kind` and key `k` changed (or is being created) at `at`: `touched` for what holds it.
pub fn container_touched(
    view: &View,
    out: &mut Out,
    kind: u64,
    k: &[u8],
    at: Loc,
) -> Result<(), StoreError> {
    let up = match kind {
        ENTRY => parse_entry_key(k)?.0,
        OWNED => owner_of(k)?,
        _ => return Ok(()),
    };
    version(view, out, up, at)?;
    touched(view, out, up, at)
}

/// An owned book's owner, from its key `<owner id>:<slot>`.
pub fn owner_of(k: &[u8]) -> Result<u64, StoreError> {
    let colon = k.iter().position(|c| *c == b':');
    colon
        .and_then(|c| std::str::from_utf8(&k[..c]).ok())
        .and_then(|d| d.parse::<u64>().ok())
        .ok_or_else(|| {
            StoreError::Refused("an owned book's key is its owner's id, `:`, then its slot".into())
        })
}

// ---- free integer keys ----

fn free_key(book: u64, start: u64) -> Vec<u8> {
    key::ids(FREE, book, start)
}

fn parse_free(k: &[u8], v: &[u8], book: u64) -> Result<(u64, u64), StoreError> {
    let mut at = key::id(FREE, book).len();
    let start = get_u64(k, &mut at).ok_or_else(|| err("a free key doesn't decode"))?;
    let mut at = 0;
    let end = get_uvarint(v, &mut at).map_err(|_| err("a free end doesn't decode"))?;
    Ok((start, end))
}

/// The free interval holding `n`, if any.
fn free_holding(view: &View, book: u64, n: u64) -> Result<Option<(u64, u64)>, StoreError> {
    let start = key::id(FREE, book);
    let end = free_key(book, n.saturating_add(1));
    let found = view.scan_vals_rev(&start, &end, 1)?;
    let Some((k, v)) = found.into_iter().next() else {
        return Ok(None);
    };
    let (s, e) = parse_free(&k, &v.into_bytes(), book)?;
    Ok((n < e).then_some((s, e)))
}

fn put_free(out: &mut Out, book: u64, s: u64, e: u64) {
    if s < e {
        out.put(free_key(book, s), uvarint(e));
    }
}

fn take_free(view: &View, out: &mut Out, book: u64, n: u64) -> Result<(), StoreError> {
    let any = !view
        .scan(
            &key::id(FREE, book),
            &key::prefix_end(&key::id(FREE, book)),
            1,
        )?
        .is_empty();
    let (s, e) = if any {
        match free_holding(view, book, n)? {
            Some(i) => i,
            None => return Err(StoreError::Refused(format!("book {book} has key {n}"))),
        }
    } else {
        (0, u64::MAX)
    };
    out.del(free_key(book, s));
    put_free(out, book, s, n);
    put_free(out, book, n + 1, e);
    Ok(())
}

fn give_free(view: &View, out: &mut Out, book: u64, n: u64) -> Result<(), StoreError> {
    let (mut s, mut e) = (n, n + 1);
    if n > 0
        && let Some((ps, pe)) = free_holding(view, book, n - 1)?
        && pe == n
    {
        out.del(free_key(book, ps));
        s = ps;
    }
    let nk = free_key(book, n + 1);
    if let Some(v) = view.get(&nk)? {
        let mut at = 0;
        e = get_uvarint(&v, &mut at).map_err(|_| err("a free end doesn't decode"))?;
        out.del(nk);
    }
    put_free(out, book, s, e);
    Ok(())
}

/// The lowest integer key no entry of `book` has.
pub fn lowest_free(view: &View, book: u64) -> Result<u64, StoreError> {
    let start = key::id(FREE, book);
    Ok(
        match view
            .scan(&start, &key::prefix_end(&start), 1)?
            .into_iter()
            .next()
        {
            Some((k, v)) => parse_free(&k, &v, book)?.0,
            None => 0,
        },
    )
}

// ---- display index ----

fn index_key(book: u64, index: f64, entry: u64) -> Vec<u8> {
    let mut k = key::id(ENTRY_INDEX, book);
    library::num_key(&mut k, Some(canonical(index)));
    put_u64(&mut k, entry);
    k
}

/// NaN as one value (positive, so it sorts above every number, as `Math.max` lets it win).
fn canonical(x: f64) -> f64 {
    if x.is_nan() { f64::NAN } else { x }
}

fn drop_index(view: &View, out: &mut Out, entry: u64) -> Result<(), StoreError> {
    let ak = key::id(ENTRY_INDEX_AT, entry);
    if let Some(b) = view.get(&ak)? {
        let l = parse_loc(&b)?;
        let (rec, _) = view.record(l.pos)?;
        if let Value::F64(x) = rec.values[2] {
            out.del(index_key(id(&rec, 1), x, entry));
        }
        dead(out, l);
        out.del(ak);
    }
    Ok(())
}

/// An entry's recorded `displayIndex`.
pub fn entry_index(view: &View, entry: u64) -> Result<Option<f64>, StoreError> {
    let Some(b) = view.get(&key::id(ENTRY_INDEX_AT, entry))? else {
        return Ok(None);
    };
    let (rec, _) = view.record(parse_loc(&b)?.pos)?;
    Ok(match rec.values[2] {
        Value::F64(x) => Some(x),
        _ => None,
    })
}

/// The highest `displayIndex` of `book`'s entries (NaN when one is NaN), or None when none has one.
pub fn max_index(view: &View, book: u64) -> Result<Option<f64>, StoreError> {
    let start = key::id(ENTRY_INDEX, book);
    let found = view.scan_vals_rev(&start, &key::prefix_end(&start), 1)?;
    let Some((k, _)) = found.into_iter().next() else {
        return Ok(None);
    };
    let b = k
        .get(start.len() + 1..start.len() + 9)
        .ok_or_else(|| err("an index key doesn't decode"))?;
    let bits = u64::from_be_bytes(b.try_into().expect("8 bytes"));
    let bits = if bits >> 63 == 1 {
        bits & !(1 << 63)
    } else {
        !bits
    };
    Ok(Some(f64::from_bits(bits)))
}

pub struct EntryIndex;

impl Deriver for EntryIndex {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (entry, book) = (id(rec, 0), id(rec, 1));
        match entity_info(view, entry)? {
            Some((ENTRY, k, _)) if parse_entry_key(&k)?.0 == book => {}
            _ => {
                return Err(StoreError::Refused(format!(
                    "no entry {entry} in book {book}"
                )));
            }
        }
        drop_index(view, out, entry)?;
        if let Value::F64(x) = rec.values[2] {
            out.put(index_key(book, x, entry), Vec::new());
            out.put(key::id(ENTRY_INDEX_AT, entry), loc_bytes(at));
        } else {
            dead(out, at);
        }
        version(view, out, entry, at)?;
        touched(view, out, entry, at)?;
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        live_at(view, &key::id(ENTRY_INDEX_AT, id(rec, 0)), pos)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_at(view, out, &key::id(ENTRY_INDEX_AT, id(rec, 0)), from, to)
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

// ---- links ----

/// The book a link names in a character's scope (`library::Scope::World`).
pub fn scope_bytes(book: u64) -> Vec<u8> {
    uvarint(book)
}

pub struct BookLink;

impl Deriver for BookLink {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (e, book) = (id(rec, 0), opt_id(rec, 1));
        if !matches!(entity_info(view, e)?, Some((library::CHARACTER, _, _))) {
            return Err(StoreError::Refused(format!("no character {e}")));
        }
        // A bulk load derives the book in another partition, so it can't be read here.
        if let Some(b) = book
            && !view.is_bulk()
            && !matches!(entity_info(view, b)?, Some((BOOK, _, _)))
        {
            return Err(StoreError::Refused(format!("no book {b}")));
        }
        let old = link_of(view, e)?;
        if let Some((l, ob)) = old {
            dead(out, l);
            if let Some(ob) = ob {
                out.del(key::ids(LINKED, ob, e));
            }
        }
        match book {
            Some(b) => {
                out.put(key::ids(LINKED, b, e), Vec::new());
                out.put(key::id(LINK, e), loc_bytes(at));
            }
            None => {
                dead(out, at);
                out.del(key::id(LINK, e));
            }
        }
        library::change(view, out, e, |st| st.world = book.map(scope_bytes))?;
        version(view, out, e, at)?;
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        live_at(view, &key::id(LINK, id(rec, 0)), pos)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_at(view, out, &key::id(LINK, id(rec, 0)), from, to)
    }
}

fn forward_bytes(into: u64, l: Loc) -> Vec<u8> {
    let mut b = uvarint(into);
    b.extend_from_slice(&loc_bytes(l));
    b
}

fn parse_forward(b: &[u8]) -> Result<(u64, Loc), StoreError> {
    let mut at = 0;
    let into = get_uvarint(b, &mut at).map_err(|_| err("a forward doesn't decode"))?;
    Ok((into, parse_loc(&b[at..])?))
}

/// The book `book` resolves as: itself, or where its forwards lead.
pub fn resolve(view: &View, mut book: u64) -> Result<u64, StoreError> {
    while let Some(b) = view.get(&key::id(FORWARD, book))? {
        book = parse_forward(&b)?.0;
    }
    Ok(book)
}

/// `book` and every unresolved book resolving as it: the scopes a filter on it reads.
pub fn resolving_as(view: &View, book: u64) -> Result<Vec<u64>, StoreError> {
    let mut out = vec![book];
    let mut i = 0;
    while i < out.len() {
        let start = key::id(FORWARDED, out[i]);
        for (k, _) in view.scan(&start, &key::prefix_end(&start), usize::MAX)? {
            let mut at = start.len();
            let from = get_u64(&k, &mut at).ok_or_else(|| err("a forwarded key doesn't decode"))?;
            if !out.contains(&from) {
                out.push(from);
            }
        }
        i += 1;
    }
    Ok(out)
}

pub struct BookForward;

impl Deriver for BookForward {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (from, into) = (id(rec, 0), id(rec, 1));
        if !matches!(entity_info(view, from)?, Some((BOOK, _, _))) || is_defined(view, from)? {
            return Err(StoreError::Refused(format!("{from} is no unresolved book")));
        }
        if !matches!(entity_info(view, into)?, Some((BOOK, _, _))) {
            return Err(StoreError::Refused(format!("no book {into}")));
        }
        if view.get(&key::id(FORWARD, from))?.is_some() || resolve(view, into)? == from {
            return Err(StoreError::Refused(format!("{from} is forwarded already")));
        }
        out.put(key::id(FORWARD, from), forward_bytes(into, at));
        out.put(key::ids(FORWARDED, into, from), Vec::new());
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        Ok(match view.get(&key::id(FORWARD, id(rec, 0)))? {
            Some(b) => parse_forward(&b)?.1.pos == pos,
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
        let k = key::id(FORWARD, id(rec, 0));
        if let Some(b) = view.get(&k)? {
            let (into, l) = parse_forward(&b)?;
            if l.pos == from {
                out.put(k, forward_bytes(into, to));
            }
        }
        Ok(())
    }
}

/// Whether a book entity may go (`entityDelete`): only an unresolved one forwarded elsewhere, so every link naming
/// it still resolves.
pub fn may_delete(view: &View, e: u64) -> Result<bool, StoreError> {
    Ok(view.get(&key::id(FORWARD, e))?.is_some())
}

pub fn deriver(kind: &str) -> Option<&'static dyn Deriver> {
    Some(match kind {
        "entryIndex" => &EntryIndex,
        "bookLink" => &BookLink,
        "bookForward" => &BookForward,
        _ => return None,
    })
}

// ---- reads (`Store.worldRead`) ----

use super::chat_read::Js;

fn big_or_null(v: Option<u64>) -> Js {
    v.map_or(Js::Null, Js::Big)
}

/// Up to `limit` defined world books after the key `after`, in key order: `{ books: [{ id, key }], more }`.
pub fn books_page(view: &View, after: Option<&[u8]>, limit: usize) -> Result<Js, StoreError> {
    let prefix = key::of(BOOKS);
    let start = match after {
        Some(a) => {
            let mut k = books_key(a);
            k.push(0);
            k
        }
        None => prefix.clone(),
    };
    let found = view.scan(&start, &key::prefix_end(&prefix), limit + 1)?;
    let more = found.len() > limit;
    let mut books = Vec::new();
    for (k, v) in found.into_iter().take(limit) {
        let mut at = prefix.len();
        let name = crate::keyspace::val::get_bytes(&k, &mut at)
            .ok_or_else(|| err("a book key doesn't decode"))?;
        books.push(Js::Obj(vec![
            ("id", Js::Big(library::parse_uvarint(&v)?)),
            ("key", Js::Text(name)),
        ]));
    }
    Ok(Js::Obj(vec![
        ("books", Js::Arr(books)),
        ("more", Js::Bool(more)),
    ]))
}

/// Up to `limit` of a book's entries in their places, after the place `after`: `{ entries: [{ id, position }],
/// more }`.
pub fn entries_page(
    view: &View,
    book: u64,
    after: Option<u64>,
    limit: usize,
) -> Result<Js, StoreError> {
    let prefix = key::ids(key::ITEM, book, ENTRIES);
    let mut start = prefix.clone();
    if let Some(a) = after {
        put_u64(&mut start, a + 1);
    }
    let found = view.scan(&start, &key::prefix_end(&prefix), limit + 1)?;
    let more = found.len() > limit;
    let mut entries = Vec::new();
    for (k, v) in found.into_iter().take(limit) {
        let mut at = prefix.len();
        let position = get_u64(&k, &mut at).ok_or_else(|| err("an entry place doesn't decode"))?;
        entries.push(Js::Obj(vec![
            ("id", Js::Big(library::parse_uvarint(&v)?)),
            ("position", Js::Num(position as f64)),
        ]));
    }
    Ok(Js::Obj(vec![
        ("entries", Js::Arr(entries)),
        ("more", Js::Bool(more)),
    ]))
}

/// Each book as it resolves: `{ id, key, defined }` of the book its forwards lead to (`key` the book's key; null
/// for an owned book), or null for no book.
pub fn resolved(view: &View, ids: &[u64]) -> Result<Js, StoreError> {
    let mut out = Vec::new();
    for b in ids {
        let r = resolve(view, *b)?;
        out.push(match entity_info(view, r)? {
            Some((kind @ (BOOK | OWNED), k, _)) => Js::Obj(vec![
                ("id", Js::Big(r)),
                ("key", if kind == BOOK { Js::Text(k) } else { Js::Null }),
                ("defined", Js::Bool(kind == OWNED || is_defined(view, r)?)),
            ]),
            _ => Js::Null,
        });
    }
    Ok(Js::Arr(out))
}

/// Each entity's lorebook link: the book it names, or null.
pub fn links(view: &View, ids: &[u64]) -> Result<Js, StoreError> {
    Ok(Js::Arr(
        ids.iter()
            .map(|e| Ok(big_or_null(link_of(view, *e)?.and_then(|(_, b)| b))))
            .collect::<Result<_, StoreError>>()?,
    ))
}

/// A book's last entry place (null: none), its lowest free integer entry key and its highest `displayIndex` (null:
/// no entry has one).
pub fn book_numbers(view: &View, book: u64) -> Result<Js, StoreError> {
    let prefix = key::ids(key::ITEM, book, ENTRIES);
    let last = match view
        .scan_vals_rev(&prefix, &key::prefix_end(&prefix), 1)?
        .into_iter()
        .next()
    {
        Some((k, _)) => {
            let mut at = prefix.len();
            Js::Num(
                get_u64(&k, &mut at).ok_or_else(|| err("an entry place doesn't decode"))? as f64,
            )
        }
        None => Js::Null,
    };
    Ok(Js::Obj(vec![
        ("lastPosition", last),
        ("freeKey", Js::Num(lowest_free(view, book)? as f64)),
        ("maxIndex", max_index(view, book)?.map_or(Js::Null, Js::Num)),
    ]))
}

/// Up to `limit` characters linking `book` itself (not through forwards) after the id `after`: `{ ids, more }`.
pub fn linkers_page(
    view: &View,
    book: u64,
    after: Option<u64>,
    limit: usize,
) -> Result<Js, StoreError> {
    let prefix = key::id(LINKED, book);
    let start = match after {
        Some(a) => key::ids(LINKED, book, a + 1),
        None => prefix.clone(),
    };
    let found = view.scan(&start, &key::prefix_end(&prefix), limit + 1)?;
    let more = found.len() > limit;
    let mut ids = Vec::new();
    for (k, _) in found.into_iter().take(limit) {
        let mut at = prefix.len();
        ids.push(Js::Big(
            get_u64(&k, &mut at).ok_or_else(|| err("a linked key doesn't decode"))?,
        ));
    }
    Ok(Js::Obj(vec![
        ("ids", Js::Arr(ids)),
        ("more", Js::Bool(more)),
    ]))
}

/// `book` and every unresolved book resolving as it.
pub fn resolving_page(view: &View, book: u64) -> Result<Js, StoreError> {
    Ok(Js::Arr(
        resolving_as(view, book)?.into_iter().map(Js::Big).collect(),
    ))
}
