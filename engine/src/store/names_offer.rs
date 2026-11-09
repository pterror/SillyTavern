use std::collections::BTreeSet;

use super::StoreError;
use super::chat_read::Js;
use super::derive::{Deriver, Loc, Out, View};
use super::entry_label::{self, COMMENT};
use super::kinds::{bytes, dead, id, key, loc_bytes, text_value};
use super::library::counter;
use super::references::{is_key_item, key_items_of, key_list};
use crate::log::format::{FieldRef, Record, get_uvarint};

// (e) → NAMED | OFFERED; no key when neither.
pub const NAMES_STATE_OF_ENTRY: u64 = 242;
// (b, e) → (): the book's offered entries.
pub const OFFERED_ENTRIES: u64 = 243;
// (b, e) → the mark record's place, then the names it marked (a JSON list).
pub const OFFER_MARKS: u64 = 244;
// (b, part) → count (Add): named entries, offered entries, marks.
pub const NAMES_OFFER_COUNTS: u64 = 245;
// (b) → MARKING or UNDOING, while the book's offer field says so: the running job's marker.
pub const NAMES_OFFER_RUNNING: u64 = 246;

pub const OFFER_FIELD: &[u8] = b"\x01namesOffer";

const NAMED: u8 = 1;
const OFFERED: u8 = 2;

const NAMED_COUNT: u64 = 0;
const OFFERED_COUNT: u64 = 1;
const MARKS_COUNT: u64 = 2;

const MARKING: u8 = 1;
const UNDOING: u8 = 2;

pub fn offer_field() -> FieldRef {
    FieldRef::Key(OFFER_FIELD.to_vec())
}

pub fn is_offer_field(f: &FieldRef) -> bool {
    matches!(f, FieldRef::Key(k) if k == OFFER_FIELD)
}

fn corrupt(what: &str) -> StoreError {
    StoreError::Entry(format!("{what} doesn't decode"))
}

fn state_key(e: u64) -> Vec<u8> {
    key::id(NAMES_STATE_OF_ENTRY, e)
}

fn offered_key(book: u64, e: u64) -> Vec<u8> {
    key::ids(OFFERED_ENTRIES, book, e)
}

fn mark_key(book: u64, e: u64) -> Vec<u8> {
    key::ids(OFFER_MARKS, book, e)
}

fn count_key(book: u64, part: u64) -> Vec<u8> {
    key::ids(NAMES_OFFER_COUNTS, book, part)
}

fn running_key(book: u64) -> Vec<u8> {
    key::id(NAMES_OFFER_RUNNING, book)
}

pub fn trimmed(text: &[u8]) -> &[u8] {
    match std::str::from_utf8(text) {
        Ok(words) => words.trim().as_bytes(),
        Err(_) => text.trim_ascii(),
    }
}

enum Written<'a> {
    Nothing,
    Title(Option<&'a [u8]>),
    Names(Option<&'a [u8]>),
    Key(u64, Option<&'a [u8]>),
}

struct Fields {
    title: Option<Vec<u8>>,
    names: Option<Vec<u8>>,
    keys: Vec<(u64, Vec<u8>)>,
}

fn fields(view: &View, book: u64, e: u64, written: &Written) -> Result<Fields, StoreError> {
    let title = match written {
        Written::Title(title) => title.map(<[u8]>::to_vec),
        _ => text_value(view, e, &FieldRef::Code(COMMENT))?,
    };
    let names = match written {
        Written::Names(names) => names.map(<[u8]>::to_vec),
        _ => super::history::json_value(view, e, &entry_label::names_field())?,
    };
    let mut keys = key_items_of(view, book, e)?;
    if let Written::Key(code, text) = written {
        keys.retain(|(item, _)| item != code);
        if let Some(text) = text {
            keys.push((*code, text.to_vec()));
        }
    }
    Ok(Fields { title, names, keys })
}

fn marked_strings(names: Option<&[u8]>) -> Option<BTreeSet<Vec<u8>>> {
    match names {
        None => Some(BTreeSet::new()),
        Some(json) => super::relations::json_strings_of_list(json).map(|list| list.into_iter().collect()),
    }
}

fn title_keys_not_names<'a>(
    title: Option<&[u8]>,
    marked: &BTreeSet<Vec<u8>>,
    keys: impl Iterator<Item = &'a Vec<u8>>,
) -> Vec<Vec<u8>> {
    let Some(title) = title.map(trimmed).filter(|title| !title.is_empty()) else {
        return Vec::new();
    };
    let mut found: Vec<Vec<u8>> = Vec::new();
    for key_text in keys {
        if trimmed(key_text) == title && !marked.contains(key_text) && !found.contains(key_text) {
            found.push(key_text.clone());
        }
    }
    found
}

fn state_of(fields: &Fields) -> u8 {
    let Some(marked) = marked_strings(fields.names.as_deref()) else {
        return 0;
    };
    let mut state = 0;
    if fields.keys.iter().any(|(_, key_text)| marked.contains(key_text)) {
        state |= NAMED;
    }
    if !title_keys_not_names(fields.title.as_deref(), &marked, fields.keys.iter().map(|(_, k)| k)).is_empty() {
        state |= OFFERED;
    }
    state
}

fn stored_state(view: &View, e: u64) -> Result<u8, StoreError> {
    Ok(view.get(&state_key(e))?.and_then(|b| b.first().copied()).unwrap_or(0))
}

fn set_state(out: &mut Out, book: u64, e: u64, old: u8, new: u8) {
    if old == new {
        return;
    }
    if new == 0 {
        out.del(state_key(e));
    } else {
        out.put(state_key(e), vec![new]);
    }
    if (old ^ new) & NAMED != 0 {
        out.add(count_key(book, NAMED_COUNT), if new & NAMED != 0 { 1 } else { -1 });
    }
    if (old ^ new) & OFFERED != 0 {
        if new & OFFERED != 0 {
            out.put(offered_key(book, e), Vec::new());
            out.add(count_key(book, OFFERED_COUNT), 1);
        } else {
            out.del(offered_key(book, e));
            out.add(count_key(book, OFFERED_COUNT), -1);
        }
    }
}

fn refresh(view: &View, out: &mut Out, book: u64, e: u64, written: &Written) -> Result<(), StoreError> {
    let new = state_of(&fields(view, book, e, written)?);
    set_state(out, book, e, stored_state(view, e)?, new);
    Ok(())
}

struct Mark {
    at: Loc,
    names: Vec<u8>,
}

fn mark_of(view: &View, book: u64, e: u64) -> Result<Option<Mark>, StoreError> {
    let Some(b) = view.get(&mark_key(book, e))? else {
        return Ok(None);
    };
    let mut read_at = 0;
    let pos = get_uvarint(&b, &mut read_at).map_err(|_| corrupt("a names offer's mark"))?;
    let len = get_uvarint(&b, &mut read_at).map_err(|_| corrupt("a names offer's mark"))?;
    Ok(Some(Mark {
        at: Loc { pos, len },
        names: b[read_at..].to_vec(),
    }))
}

fn drop_mark(view: &View, out: &mut Out, book: u64, e: u64) -> Result<(), StoreError> {
    if let Some(mark) = mark_of(view, book, e)? {
        dead(out, mark.at);
        out.del(mark_key(book, e));
        out.add(count_key(book, MARKS_COUNT), -1);
    }
    Ok(())
}

// `new` isn't in the view yet.
#[allow(clippy::too_many_arguments)]
pub fn entry_value_written(
    view: &View,
    out: &mut Out,
    book: u64,
    e: u64,
    f: &FieldRef,
    json: bool,
    new: Option<&[u8]>,
    entry_is_new: bool,
) -> Result<(), StoreError> {
    if entry_is_new {
        return Ok(());
    }
    let written = match (f, json) {
        (FieldRef::Code(COMMENT), false) => Written::Title(new),
        (FieldRef::Code(code), false)
            if *code >= super::library::ITEM_BASE && is_key_item(*code, key_list(view, book)?) =>
        {
            Written::Key(*code, new)
        }
        (FieldRef::Key(k), true) if k == entry_label::NAMES_FIELD => Written::Names(new),
        _ => return Ok(()),
    };
    if matches!(written, Written::Names(_)) {
        drop_mark(view, out, book, e)?;
    }
    refresh(view, out, book, e, &written)
}

pub fn entry_came(view: &View, out: &mut Out, book: u64, e: u64) -> Result<(), StoreError> {
    refresh(view, out, book, e, &Written::Nothing)
}

pub fn entry_gone(view: &View, out: &mut Out, book: u64, e: u64) -> Result<(), StoreError> {
    set_state(out, book, e, stored_state(view, e)?, 0);
    drop_mark(view, out, book, e)
}

pub fn offer_field_written(out: &mut Out, book: u64, json: bool, new: Option<&[u8]>) {
    let running = match new.filter(|_| !json) {
        Some(b"marking") => Some(MARKING),
        Some(b"undoing") => Some(UNDOING),
        _ => None,
    };
    match running {
        Some(job) => out.put(running_key(book), vec![job]),
        None => out.del(running_key(book)),
    }
}

pub fn book_gone(out: &mut Out, book: u64) {
    out.del(running_key(book));
    for part in [NAMED_COUNT, OFFERED_COUNT, MARKS_COUNT] {
        out.del(count_key(book, part));
    }
}

// A commit writes it after the entry's names, whose write drops any mark. `[]` takes the mark away.
pub struct NamesOfferMark;

impl Deriver for NamesOfferMark {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (e, names) = (id(rec, 0), bytes(rec, 1));
        let Some((book, _)) = super::book_stats::entry_of_counted_book(view, e)? else {
            dead(out, at);
            return Ok(());
        };
        let had = mark_of(view, book, e)?;
        if let Some(mark) = &had {
            dead(out, mark.at);
        }
        if super::relations::json_strings_of_list(names).is_none_or(|list| list.is_empty()) {
            dead(out, at);
            if had.is_some() {
                out.del(mark_key(book, e));
                out.add(count_key(book, MARKS_COUNT), -1);
            }
            return Ok(());
        }
        let mut value = loc_bytes(at);
        value.extend_from_slice(names);
        out.put(mark_key(book, e), value);
        if had.is_none() {
            out.add(count_key(book, MARKS_COUNT), 1);
        }
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        let e = id(rec, 0);
        let Some((book, _)) = super::book_stats::entry_of_counted_book(view, e)? else {
            return Ok(false);
        };
        Ok(mark_of(view, book, e)?.is_some_and(|mark| mark.at.pos == pos))
    }

    fn repoint(&self, rec: &Record, from: u64, to: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let e = id(rec, 0);
        let Some((book, _)) = super::book_stats::entry_of_counted_book(view, e)? else {
            return Ok(());
        };
        if let Some(mark) = mark_of(view, book, e)?
            && mark.at.pos == from
        {
            let mut value = loc_bytes(to);
            value.extend_from_slice(&mark.names);
            out.put(mark_key(book, e), value);
        }
        Ok(())
    }
}


fn running(view: &View, book: u64) -> Result<Option<u8>, StoreError> {
    Ok(view.get(&running_key(book))?.and_then(|b| b.first().copied()))
}

fn first_of(view: &View, structure: u64, book: u64, limit: usize) -> Result<Vec<u64>, StoreError> {
    let prefix = key::id(structure, book);
    let mut found = Vec::new();
    for (stored_key, _) in view.scan(&prefix, &key::prefix_end(&prefix), limit)? {
        let mut read_at = prefix.len();
        found.push(
            crate::keyspace::val::get_u64(&stored_key, &mut read_at)
                .ok_or_else(|| corrupt("a names offer's key"))?,
        );
    }
    Ok(found)
}

fn texts(list: impl IntoIterator<Item = Vec<u8>>) -> Js {
    Js::Arr(list.into_iter().map(Js::Text).collect())
}

pub fn read_offer(view: &View, book: u64) -> Result<Js, StoreError> {
    let state = text_value(view, book, &offer_field())?;
    let example = match first_of(view, OFFERED_ENTRIES, book, 1)?.first() {
        Some(&e) => entry_label::named(view, key_list(view, book)?, e)?.js(),
        None => Js::Null,
    };
    Ok(Js::Obj(vec![
        ("state", state.map_or(Js::Null, Js::Text)),
        ("namedEntries", Js::Num(counter(view, &count_key(book, NAMED_COUNT))? as f64)),
        ("offeredEntries", Js::Num(counter(view, &count_key(book, OFFERED_COUNT))? as f64)),
        ("marks", Js::Num(counter(view, &count_key(book, MARKS_COUNT))? as f64)),
        ("example", example),
    ]))
}

pub fn job_chunk(view: &View, book: u64, limit: usize) -> Result<Js, StoreError> {
    let job = running(view, book)?;
    let list = key_list(view, book)?;
    let mut entries = Vec::new();
    let structure = match job {
        Some(MARKING) => OFFERED_ENTRIES,
        Some(UNDOING) => OFFER_MARKS,
        _ => {
            return Ok(Js::Obj(vec![("job", Js::Null), ("entries", Js::Arr(entries))]));
        }
    };
    for e in first_of(view, structure, book, limit)? {
        let keys = entry_label::keys_of(view, list, e)?;
        let before = super::history::json_value(view, e, &entry_label::names_field())?;
        let names_now: BTreeSet<Vec<u8>> = entry_label::names_among(view, e, &keys)?.into_iter().collect();
        let (names, marked) = if job == Some(MARKING) {
            let title = text_value(view, e, &FieldRef::Code(COMMENT))?;
            let stored = marked_strings(before.as_deref()).unwrap_or_default();
            let marked = title_keys_not_names(title.as_deref(), &stored, keys.iter());
            let mut kept = names_now;
            kept.extend(marked.iter().cloned());
            (kept, marked)
        } else {
            let mark = mark_of(view, book, e)?.ok_or_else(|| corrupt("a names offer's mark"))?;
            let taken: BTreeSet<Vec<u8>> = super::relations::json_strings_of_list(&mark.names)
                .unwrap_or_default()
                .into_iter()
                .collect();
            let kept = names_now.into_iter().filter(|name| !taken.contains(name)).collect();
            (kept, Vec::new())
        };
        let mut seen = BTreeSet::new();
        let ordered = keys.into_iter().filter(|k| names.contains(k) && seen.insert(k.clone()));
        entries.push(Js::Obj(vec![
            ("entity", Js::Big(e)),
            ("before", before.map_or(Js::Null, Js::Text)),
            ("names", texts(ordered)),
            ("marked", texts(marked)),
        ]));
    }
    Ok(Js::Obj(vec![
        ("job", Js::Text(if job == Some(MARKING) { b"marking".to_vec() } else { b"undoing".to_vec() })),
        ("entries", Js::Arr(entries)),
    ]))
}

pub fn running_jobs(view: &View) -> Result<Js, StoreError> {
    let prefix = key::of(NAMES_OFFER_RUNNING);
    let mut jobs = Vec::new();
    for (stored_key, value) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
        let mut read_at = prefix.len();
        let book = crate::keyspace::val::get_u64(&stored_key, &mut read_at)
            .ok_or_else(|| corrupt("a names offer's job marker"))?;
        let job: &[u8] = if value.first() == Some(&MARKING) { b"marking" } else { b"undoing" };
        jobs.push(Js::Obj(vec![("book", Js::Big(book)), ("job", Js::Text(job.to_vec()))]));
    }
    Ok(Js::Arr(jobs))
}
