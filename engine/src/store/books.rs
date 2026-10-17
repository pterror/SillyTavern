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
//! whose last is the book's highest) and the integer keys no entry has (`FREE`, as intervals); each book's linkers
//! (`LINKED`) and the characters with more than one link (`MULTI_LINK`); forwards from an unresolved book to the book
//! it resolves as (`FORWARD`, `FORWARDED`).
//!
//! A character's lorebook links are its list `LINKS`: one ordered list of equal links, each a placed item whose text
//! is a book's id in decimal, no book twice. The first is the card's `extensions.world`. A character is in the
//! lorebook scope (`library::Scope::World`) of each book it links, numbered there in its `LINKED` entry.

use super::StoreError;
use super::derive::{Deriver, Loc, Out, View};
use super::kinds::{dead, id, key, loc_bytes, parse_loc, text_value, version};
use super::library::{self, entity_info, uvarint};
use super::library_read;
use crate::keyspace::val::{get_u64, put_bytes, put_u64};
use crate::log::format::{FieldRef, Record, Value, get_uvarint, put_uvarint};

/// Entity types.
pub const BOOK: u64 = 3;
pub const OWNED: u64 = 4;
pub const ENTRY: u64 = 5;

/// A book's list of its entries (item = the entry's id).
pub const ENTRIES: u64 = 0;
/// A character's list of its lorebook links (item text = the book's id in decimal).
pub const LINKS: u64 = 4;

/// A world book's definition marker (empty JSON): without it, the book is an unresolved name.
pub const DEFINED: u64 = 41;

/// Structures.
/// Per defined world book's key: the book.
pub const BOOKS: u64 = 190;
/// Per (book, index, entry): the entry's `displayIndex` as JavaScript's `Number()` reads it.
pub const ENTRY_INDEX: u64 = 191;
/// Per entry: its `entryIndex` record.
pub const ENTRY_INDEX_AT: u64 = 192;
/// Per (book, character): the character links the book. The link's item, then the character's number in the book's
/// numbering (`library::rank_host`).
pub const LINKED: u64 = 194;
/// Per unresolved book: the book it resolves as, and its `bookForward` record.
pub const FORWARD: u64 = 195;
/// Per (book, unresolved book): the unresolved book resolves as the book.
pub const FORWARDED: u64 = 196;
/// Per character with 2 or more placed links: nothing.
pub const MULTI_LINK: u64 = 209;
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

/// A record at `at` changed entity `e`: when it is an entry or an owned book, the book holding it, and that book's
/// owner, changed too (their versions follow, so a page's copy of a book or card is known stale); when it is a saved
/// view's condition or range, its view.
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
        library::CONDITION | library::RANGE => {
            let view_key = k.split(|c| *c == b':').next().unwrap_or_default();
            match view.get(&library::entity_key_key(library::VIEW, view_key))? {
                Some(b) => library::parse_uvarint(&b)?,
                None => return Ok(()),
            }
        }
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
    let (s, e) = parse_free(&k, &v.into_bytes(&k), book)?;
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

/// The item of list `LINKS` whose text is field `f`.
pub fn link_item(f: &FieldRef) -> Option<u64> {
    match f {
        FieldRef::Code(c)
            if *c >= library::ITEM_BASE && (c - library::ITEM_BASE) % library::LISTS == LINKS =>
        {
            Some((c - library::ITEM_BASE) / library::LISTS)
        }
        _ => None,
    }
}

/// The book a link's text names: a book's id in canonical decimal.
fn link_book(text: &[u8]) -> Result<u64, StoreError> {
    let bad = || StoreError::Refused("a lorebook link's text is a book's id in decimal".into());
    if text.is_empty()
        || !text.iter().all(u8::is_ascii_digit)
        || (text.len() > 1 && text[0] == b'0')
    {
        return Err(bad());
    }
    std::str::from_utf8(text)
        .ok()
        .and_then(|d| d.parse::<u64>().ok())
        .ok_or_else(bad)
}

/// A `LINKED` entry for the link of item `item`, numbered `n` in its book's numbering.
pub fn linked_bytes(item: u64, n: Option<u64>) -> Vec<u8> {
    let mut b = uvarint(item);
    if let Some(n) = n {
        put_uvarint(&mut b, n);
    }
    b
}

/// A `LINKED` entry's item and number.
pub fn parse_linked(b: &[u8]) -> Result<(u64, Option<u64>), StoreError> {
    let bad = || err("a linked entry doesn't decode");
    let mut at = 0;
    let item = get_uvarint(b, &mut at).map_err(|_| bad())?;
    let n = if at < b.len() {
        Some(get_uvarint(b, &mut at).map_err(|_| bad())?)
    } else {
        None
    };
    if at != b.len() {
        return Err(bad());
    }
    Ok((item, n))
}

fn is_character(view: &View, e: u64) -> Result<bool, StoreError> {
    Ok(matches!(
        entity_info(view, e)?,
        Some((library::CHARACTER, _, _))
    ))
}

fn link_placed_now(view: &View, e: u64, item: u64) -> Result<bool, StoreError> {
    let mut k = key::ids(key::ITEM_AT, e, LINKS);
    put_u64(&mut k, item);
    Ok(view.get(&k)?.is_some())
}

fn link_text(view: &View, e: u64, item: u64) -> Result<Option<u64>, StoreError> {
    text_value(view, e, &library::item_field(LINKS, item))?
        .map(|t| link_book(&t))
        .transpose()
}

/// Each of character `e`'s links in list order: its item and the book it names. A placed item without its text
/// yet is no link.
pub fn links_of(view: &View, e: u64) -> Result<Vec<(u64, u64)>, StoreError> {
    let prefix = key::ids(key::ITEM, e, LINKS);
    let mut out = Vec::new();
    for (_, v) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
        let item = library::parse_uvarint(&v)?;
        if let Some(b) = link_text(view, e, item)? {
            out.push((item, b));
        }
    }
    Ok(out)
}

/// The book character `e`'s first link names.
pub fn first_link(view: &View, e: u64) -> Result<Option<u64>, StoreError> {
    let prefix = key::ids(key::ITEM, e, LINKS);
    let end = key::prefix_end(&prefix);
    let mut from = prefix;
    loop {
        let Some((k, v)) = view.scan(&from, &end, 1)?.into_iter().next() else {
            return Ok(None);
        };
        if let Some(b) = link_text(view, e, library::parse_uvarint(&v)?)? {
            return Ok(Some(b));
        }
        from = k;
        from.push(0);
    }
}

/// The scopes of the books character `e` links.
pub fn worlds(view: &View, e: u64) -> Result<Vec<Vec<u8>>, StoreError> {
    let mut w: Vec<Vec<u8>> = links_of(view, e)?
        .into_iter()
        .map(|(_, b)| scope_bytes(b))
        .collect();
    w.sort();
    w.dedup();
    Ok(w)
}

/// Whether character `e` links one of the books of these scopes (`library::Scope::World`'s bytes).
pub fn links_any(view: &View, e: u64, scopes: &[Vec<u8>]) -> Result<bool, StoreError> {
    for s in scopes {
        if view
            .get(&key::ids(LINKED, library::parse_uvarint(s)?, e))?
            .is_some()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Character `e`'s number in book `b`'s numbering, in its `LINKED` entry.
pub fn world_rank(view: &View, b: u64, e: u64) -> Result<Option<u64>, StoreError> {
    Ok(match view.get(&key::ids(LINKED, b, e))? {
        Some(v) => parse_linked(&v)?.1,
        None => None,
    })
}

/// Sets character `e`'s number in book `b`'s numbering (None: takes it out). A number for a pair with no link is an
/// error; taking it out of a gone one does nothing.
pub fn set_world_rank(
    view: &View,
    out: &mut Out,
    b: u64,
    e: u64,
    n: Option<u64>,
) -> Result<(), StoreError> {
    let lk = key::ids(LINKED, b, e);
    match library::current(view, out, &lk)? {
        Some(v) => {
            let (item, old) = parse_linked(&v)?;
            if old != n {
                out.put(lk, linked_bytes(item, n));
            }
            Ok(())
        }
        None if n.is_none() => Ok(()),
        None => Err(StoreError::Entry(
            "a numbered entity has no entry for its scope".into(),
        )),
    }
}

/// Character `e`'s link of item `item` goes from naming `old` to naming `new` (None: no link): its `LINKED` entry,
/// and its place in the books' scopes. A book it links already is refused.
fn link_changed(
    view: &View,
    out: &mut Out,
    e: u64,
    item: u64,
    old: Option<u64>,
    new: Option<u64>,
) -> Result<(), StoreError> {
    if old == new {
        return Ok(());
    }
    let Some(before) = library::state(view, e)? else {
        return Ok(());
    };
    let mut after = before.clone();
    if let Some(b) = old {
        after.worlds.retain(|w| *w != scope_bytes(b));
    }
    if let Some(b) = new {
        // A bulk load derives the book in another partition, so it can't be read here.
        if !view.is_bulk() && !matches!(entity_info(view, b)?, Some((BOOK, _, _))) {
            return Err(StoreError::Refused(format!("no book {b}")));
        }
        let lk = key::ids(LINKED, b, e);
        if view.get(&lk)?.is_some() {
            return Err(StoreError::Refused(format!(
                "character {e} links book {b} already"
            )));
        }
        out.put(lk, linked_bytes(item, None));
        after.worlds.push(scope_bytes(b));
    }
    after.worlds.sort();
    after.worlds.dedup();
    library::reposition(view, out, e, Some(&before), Some(&after))?;
    if let Some(b) = old {
        out.del(key::ids(LINKED, b, e));
    }
    Ok(())
}

/// The text of item `item` of entity `e`'s list `LINKS` becomes `new` (None: goes). A character's placed item's
/// link follows; any other item's text is no link (yet).
pub fn link_text_changed(
    view: &View,
    out: &mut Out,
    e: u64,
    item: u64,
    new: Option<&[u8]>,
) -> Result<(), StoreError> {
    if !is_character(view, e)? || !link_placed_now(view, e, item)? {
        return Ok(());
    }
    let old = link_text(view, e, item)?;
    let new = new.map(link_book).transpose()?;
    link_changed(view, out, e, item, old, new)
}

/// Keeps `MULTI_LINK` as character `e`'s placed links go from as many as `view` holds to `d` more.
fn multi_link(view: &View, out: &mut Out, e: u64, d: i64) -> Result<(), StoreError> {
    let prefix = key::ids(key::ITEM, e, LINKS);
    let n = view.scan(&prefix, &key::prefix_end(&prefix), 3)?.len() as i64;
    match (n >= 2, n + d >= 2) {
        (false, true) => out.put(key::id(MULTI_LINK, e), Vec::new()),
        (true, false) => out.del(key::id(MULTI_LINK, e)),
        _ => {}
    }
    Ok(())
}

/// Item `item` of entity `e`'s list `LINKS` is placed (`was`: it had a place already). A character's newly placed
/// item with a text is a link from now on.
pub fn link_placed(
    view: &View,
    out: &mut Out,
    e: u64,
    item: u64,
    was: bool,
) -> Result<(), StoreError> {
    if was || !is_character(view, e)? {
        return Ok(());
    }
    if let Some(b) = link_text(view, e, item)? {
        link_changed(view, out, e, item, None, Some(b))?;
    }
    multi_link(view, out, e, 1)
}

/// Item `item` of entity `e`'s list `LINKS` goes: a character's link goes with it.
pub fn link_deleted(view: &View, out: &mut Out, e: u64, item: u64) -> Result<(), StoreError> {
    if !is_character(view, e)? || !link_placed_now(view, e, item)? {
        return Ok(());
    }
    if let Some(b) = link_text(view, e, item)? {
        link_changed(view, out, e, item, Some(b), None)?;
    }
    multi_link(view, out, e, -1)
}

/// A character comes to be with its links placed already (values committed before its create, in the same
/// commit): their `LINKED` entries, before it is placed in their scopes.
pub fn linker_created(view: &View, out: &mut Out, e: u64) -> Result<(), StoreError> {
    let links = links_of(view, e)?;
    for (i, (item, b)) in links.iter().enumerate() {
        if links[..i].iter().any(|(_, x)| x == b) {
            return Err(StoreError::Refused(format!(
                "character {e} links book {b} twice"
            )));
        }
        if !view.is_bulk() && !matches!(entity_info(view, *b)?, Some((BOOK, _, _))) {
            return Err(StoreError::Refused(format!("no book {b}")));
        }
        out.put(key::ids(LINKED, *b, e), linked_bytes(*item, None));
    }
    let prefix = key::ids(key::ITEM, e, LINKS);
    if view.scan(&prefix, &key::prefix_end(&prefix), 2)?.len() >= 2 {
        out.put(key::id(MULTI_LINK, e), Vec::new());
    }
    Ok(())
}

/// A character goes: its links go.
pub fn linker_gone(view: &View, out: &mut Out, e: u64) -> Result<(), StoreError> {
    for (_, b) in links_of(view, e)? {
        out.del(key::ids(LINKED, b, e));
    }
    out.del(key::id(MULTI_LINK, e));
    Ok(())
}

/// `bookLink`, a reserved kind: a character's one lorebook link from before a character's links were its list
/// `LINKS`. The log's format keeps an old kind decodable, so cleaning can read its records and drop them: every one
/// is dead, and a new one is refused.
pub struct BookLink;

impl Deriver for BookLink {
    fn derive(&self, _: &Record, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Err(StoreError::Refused(
            "bookLink is a reserved kind: a character's links are its list 4".into(),
        ))
    }

    fn is_live(&self, _: &Record, _: u64, _: &View) -> Result<bool, StoreError> {
        Ok(false)
    }

    fn repoint(&self, _: &Record, _: u64, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Ok(())
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

/// Up to `limit` of a book's entries in their places, after the place `after`, or before the place `before`
/// (nearest first): `{ entries: [{ id, position }], more }`.
pub fn entries_page(
    view: &View,
    book: u64,
    after: Option<u64>,
    before: Option<u64>,
    limit: usize,
) -> Result<Js, StoreError> {
    let prefix = key::ids(key::ITEM, book, ENTRIES);
    let found: Vec<(Vec<u8>, Vec<u8>)> = match (after, before) {
        (Some(_), Some(_)) => {
            return Err(StoreError::Refused(
                "entries: `after` and `before` together".into(),
            ));
        }
        (_, Some(b)) => {
            let mut end = prefix.clone();
            put_u64(&mut end, b);
            view.scan_vals_rev(&prefix, &end, limit + 1)?
                .into_iter()
                .map(|(k, v)| {
                    let v = v.into_bytes(&k);
                    (k, v)
                })
                .collect()
        }
        (a, None) => {
            let mut start = prefix.clone();
            if let Some(a) = a {
                put_u64(&mut start, a + 1);
            }
            view.scan(&start, &key::prefix_end(&prefix), limit + 1)?
        }
    };
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

/// Each item's place in `entity`'s list `list`, or null where the item isn't in it.
pub fn item_places(view: &View, entity: u64, list: u64, items: &[u64]) -> Result<Js, StoreError> {
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let mut k = key::ids(key::ITEM_AT, entity, list);
        put_u64(&mut k, *item);
        out.push(match view.get(&k)? {
            Some(b) => {
                let mut at = 0;
                let p =
                    get_uvarint(&b, &mut at).map_err(|_| err("an item's place doesn't decode"))?;
                Js::Num(p as f64)
            }
            None => Js::Null,
        });
    }
    Ok(Js::Arr(out))
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

/// Up to `limit` characters with 2 or more links (`MULTI_LINK`) after the id `after`, in id order: `{ ids, more }`.
pub fn multi_links_page(view: &View, after: Option<u64>, limit: usize) -> Result<Js, StoreError> {
    let prefix = key::of(MULTI_LINK);
    let start = match after {
        Some(a) => key::id(MULTI_LINK, a + 1),
        None => prefix.clone(),
    };
    let found = view.scan(&start, &key::prefix_end(&prefix), limit + 1)?;
    let more = found.len() > limit;
    let mut ids = Vec::new();
    for (k, _) in found.into_iter().take(limit) {
        let mut at = prefix.len();
        ids.push(Js::Big(
            get_u64(&k, &mut at).ok_or_else(|| err("a multi-link key doesn't decode"))?,
        ));
    }
    Ok(Js::Obj(vec![
        ("ids", Js::Arr(ids)),
        ("more", Js::Bool(more)),
    ]))
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

/// A book as one read finds it (`world_book`): its entity, its entries in their places, and (a world book's) the
/// book it owns as its `originalData`.
pub struct BookRead {
    pub id: u64,
    pub entity: Option<library_read::Entity>,
    /// Each entry with its place, in place order.
    pub entries: Vec<(library_read::Entity, u64)>,
    pub original: Option<Box<BookRead>>,
}

/// Entries read per scan of a book's places.
const PLACES_PAGE: usize = 1000;

/// The book `book` whole, from one view; with `world`, the book it owns as its `originalData` too.
fn book_read(view: &View, book: u64, world: bool) -> Result<BookRead, StoreError> {
    let prefix = key::ids(key::ITEM, book, ENTRIES);
    let end = key::prefix_end(&prefix);
    let mut start = prefix.clone();
    let mut entries = Vec::new();
    loop {
        let found = view.scan(&start, &end, PLACES_PAGE)?;
        let full = found.len() == PLACES_PAGE;
        let mut last = None;
        for (k, v) in found {
            let mut at = prefix.len();
            let position =
                get_u64(&k, &mut at).ok_or_else(|| err("an entry place doesn't decode"))?;
            last = Some(position);
            if let Some(e) = library_read::entity(view, library::parse_uvarint(&v)?)? {
                entries.push((e, position));
            }
        }
        match last {
            Some(p) if full => {
                start = prefix.clone();
                put_u64(&mut start, p + 1);
            }
            _ => break,
        }
    }
    let original = if world {
        match library::entity_by_key(view, OWNED, format!("{book}:o").as_bytes())? {
            Some(o) => Some(Box::new(book_read(view, o, false)?)),
            None => None,
        }
    } else {
        None
    };
    Ok(BookRead {
        id: book,
        entity: library_read::entity(view, book)?,
        entries,
        original,
    })
}

/// The defined world book keyed `k`, whole, from one view (what a book read by name finds), or None when no world
/// book has the key.
/// Whether a defined world book is keyed `k` (what `world_book` would find), reading only its entity.
pub fn world_book_exists(view: &View, k: &[u8]) -> Result<bool, StoreError> {
    let Some(id) = library::entity_by_key(view, BOOK, k)? else {
        return Ok(false);
    };
    Ok(resolve(view, id)? == id && is_defined(view, id)?)
}

pub fn world_book(view: &View, k: &[u8]) -> Result<Option<BookRead>, StoreError> {
    let Some(id) = library::entity_by_key(view, BOOK, k)? else {
        return Ok(None);
    };
    if resolve(view, id)? != id || !is_defined(view, id)? {
        return Ok(None);
    }
    book_read(view, id, true).map(Some)
}
