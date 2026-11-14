use std::collections::{BTreeMap, BTreeSet};

use super::StoreError;
use super::book_stats::{book_stat, entry_stat};
use super::chat_read::Js;
use super::books::{BOOK, OWNED};
use super::derive::{Out, View};
use super::kinds::{key, text_value};
use super::library::{ITEM_BASE, LISTS, counter, entity_info};
use crate::keyspace::val::{counter_value, get_bytes, get_u64, put_bytes};
use crate::log::format::FieldRef;
use crate::search::query::docs_with_terms;
use crate::search::text::tokens;
use crate::search::Scope;

pub const KEY_FIELD: u32 = 0;
pub const CONTENT_FIELD: u32 = 4;
// (b, e, item) → (): what names the search index couldn't look up were, before the names index; only the lorebook
// conversion's first step reads it, to delete it.
pub const UNINDEXED_BEFORE_NAMES_INDEX: u64 = 222;
pub const KEY_ITEMS_BY_TEXT: u64 = 239;
// (b, key text, e) → count (Add): the entry's key items with exactly that text.
pub const KEY_ENTRIES_BY_TEXT: u64 = 248;
// (b, folded name, e) → the entry's names with that fold (each `put_bytes`): names the index finds in a text.
pub const NAMES_BY_FOLD: u64 = 249;
// (b, e, name) → (): names that are checked one by one, never looked up (patterns and names with a macro).
pub const NAMES_CHECKED_ONE_BY_ONE: u64 = 250;

const WORLD_KEYS: u64 = 0;
const OWNED_KEYS: u64 = 3;

// An entry's `caseSensitive` and `matchWholeWords`: a world's own fields, a card book's extensions.
const WORLD_CASE_SENSITIVE: u64 = 131;
const WORLD_MATCH_WHOLE_WORDS: u64 = 132;
const CARD_CASE_SENSITIVE: u64 = 174;
const CARD_MATCH_WHOLE_WORDS: u64 = 175;

pub fn key_list(view: &View, book: u64) -> Result<Option<u64>, StoreError> {
    Ok(match entity_info(view, book)? {
        Some((BOOK, _, _)) => Some(WORLD_KEYS),
        Some((OWNED, bk, _)) if bk.ends_with(b":c") => Some(OWNED_KEYS),
        _ => None,
    })
}

pub fn is_key_item(code: u64, list: Option<u64>) -> bool {
    code >= ITEM_BASE && Some((code - ITEM_BASE) % LISTS) == list
}

pub fn key_items_by_text_key(book: u64, key_text: &[u8]) -> Vec<u8> {
    let mut stored_key = key::id(KEY_ITEMS_BY_TEXT, book);
    put_bytes(&mut stored_key, key_text);
    stored_key
}

pub fn key_items_with_text(view: &View, book: u64, key_text: &[u8]) -> Result<u64, StoreError> {
    Ok(counter(view, &key_items_by_text_key(book, key_text))?.max(0) as u64)
}

fn key_entries_by_text_key(book: u64, key_text: &[u8], entry: u64) -> Vec<u8> {
    let mut stored_key = key::id(KEY_ENTRIES_BY_TEXT, book);
    put_bytes(&mut stored_key, key_text);
    crate::keyspace::val::put_u64(&mut stored_key, entry);
    stored_key
}

fn add_to_count(view: &View, out: &mut Out, stored_key: Vec<u8>, change: i64) -> Result<(), StoreError> {
    if counter(view, &stored_key)? + change == 0 {
        out.del(stored_key);
    } else {
        out.add(stored_key, change);
    }
    Ok(())
}

// The world's count of key items per text and the entry's own, which list the entries with a key.
fn change_key_items(
    view: &View,
    out: &mut Out,
    book: u64,
    entry: u64,
    changes: BTreeMap<Vec<u8>, i64>,
) -> Result<(), StoreError> {
    for (key_text, change) in changes {
        if change == 0 {
            continue;
        }
        add_to_count(view, out, key_items_by_text_key(book, &key_text), change)?;
        add_to_count(view, out, key_entries_by_text_key(book, &key_text, entry), change)?;
    }
    Ok(())
}

pub fn key_items_of(view: &View, book: u64, entry: u64) -> Result<Vec<(u64, Vec<u8>)>, StoreError> {
    let list = key_list(view, book)?;
    let prefix = key::id(key::HEAD, entry);
    let mut items = Vec::new();
    for (head_key, _) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
        let field = super::library::field_after(&head_key, key::HEAD)?;
        let FieldRef::Code(code) = field else {
            continue;
        };
        if is_key_item(code, list)
            && let Some(key_text) = text_value(view, entry, &field)?
        {
            items.push((code, key_text));
        }
    }
    Ok(items)
}

fn key_texts_of(view: &View, book: u64, entry: u64) -> Result<Vec<Vec<u8>>, StoreError> {
    Ok(key_items_of(view, book, entry)?.into_iter().map(|(_, key_text)| key_text).collect())
}

fn counted(texts: Vec<Vec<u8>>, change: i64) -> BTreeMap<Vec<u8>, i64> {
    let mut changes = BTreeMap::new();
    for key_text in texts {
        *changes.entry(key_text).or_insert(0) += change;
    }
    changes
}

pub fn entry_keys_came(view: &View, out: &mut Out, book: u64, entry: u64) -> Result<(), StoreError> {
    let texts = key_texts_of(view, book, entry)?;
    change_key_items(view, out, book, entry, counted(texts, 1))
}

pub fn key_written(
    view: &View,
    out: &mut Out,
    book: u64,
    entry: u64,
    f: &FieldRef,
    new: Option<&[u8]>,
    entry_is_new: bool,
) -> Result<(), StoreError> {
    let FieldRef::Code(c) = f else {
        return Ok(());
    };
    if entry_is_new || !is_key_item(*c, key_list(view, book)?) {
        return Ok(());
    }
    let mut changes = BTreeMap::new();
    if let Some(old) = text_value(view, entry, f)? {
        *changes.entry(old).or_insert(0) -= 1;
    }
    if let Some(new) = new {
        *changes.entry(new.to_vec()).or_insert(0) += 1;
    }
    change_key_items(view, out, book, entry, changes)
}

pub fn entry_gone(view: &View, out: &mut Out, book: u64, entry: u64) -> Result<(), StoreError> {
    let texts = key_texts_of(view, book, entry)?;
    change_key_items(view, out, book, entry, counted(texts, -1))
}

// The lorebook conversion's first step: every count and index of keys and names goes, for the steps to build again.
pub fn key_items_cleared(view: &View, out: &mut Out) -> Result<(), StoreError> {
    for structure in [
        KEY_ITEMS_BY_TEXT,
        KEY_ENTRIES_BY_TEXT,
        NAMES_BY_FOLD,
        NAMES_CHECKED_ONE_BY_ONE,
        UNINDEXED_BEFORE_NAMES_INDEX,
    ] {
        let prefix = key::of(structure);
        for (stored_key, _) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
            out.del(stored_key);
        }
    }
    Ok(())
}

/// The other entries of the world with a key of exactly `key_text`, by id: the first `limit` labels.
pub fn key_sharers(
    view: &View,
    book: u64,
    entry: u64,
    key_text: &[u8],
    limit: usize,
) -> Result<Js, StoreError> {
    let Some(list) = key_list(view, book)? else {
        return Ok(Js::Null);
    };
    let mut prefix = key::id(KEY_ENTRIES_BY_TEXT, book);
    put_bytes(&mut prefix, key_text);
    let mut entries = Vec::new();
    let mut more = false;
    for (stored_key, _) in view.scan(&prefix, &key::prefix_end(&prefix), limit + 2)? {
        let other = get_u64(&stored_key, &mut prefix.len())
            .ok_or_else(|| StoreError::Entry("a key's entry doesn't decode".into()))?;
        if other == entry {
            continue;
        }
        if entries.len() == limit {
            more = true;
            break;
        }
        entries.push(super::entry_label::named(view, Some(list), other)?.js());
    }
    Ok(Js::Obj(vec![("entries", Js::Arr(entries)), ("more", Js::Bool(more))]))
}

/// The texts of the world's keys that start with `typed`, in byte order, each with the number of keys of the world with
/// that text: the first `limit` of them. A text is stored by `put_bytes`, whose escaping of each byte is its own, so
/// the escaped `typed` without the terminator is a prefix of every text that starts with it.
pub fn key_suggestions(view: &View, book: u64, typed: &[u8], limit: usize) -> Result<Js, StoreError> {
    if key_list(view, book)?.is_none() {
        return Ok(Js::Null);
    }
    let head = key::id(KEY_ITEMS_BY_TEXT, book);
    let mut prefix = head.clone();
    put_bytes(&mut prefix, typed);
    prefix.truncate(prefix.len() - 2);
    let mut suggestions = Vec::new();
    for (stored_key, value) in view.scan(&prefix, &key::prefix_end(&prefix), limit)? {
        let count = counter_value(&value).ok_or_else(|| StoreError::Entry("a counter doesn't decode".into()))?;
        let mut at = head.len();
        let text = get_bytes(&stored_key, &mut at).ok_or_else(|| StoreError::Entry("a key's text doesn't decode".into()))?;
        suggestions.push(Js::Obj(vec![("text", Js::Text(text)), ("keys", Js::Num(count as f64))]));
    }
    Ok(Js::Arr(suggestions))
}

/// JavaScript's `String.prototype.trim` white space.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{b}'
            | '\u{c}'
            | '\r'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// Each character lowercased on its own and every sigma made `σ`. Lowercasing a text maps each character on its own
/// but for a capital sigma, which becomes `σ` or `ς` by what is around it, so where a text holds a name, with its case
/// or lowercased as the matcher compares them, its fold holds the name's fold.
pub fn names_fold(text: &str) -> String {
    let mut folded = String::with_capacity(text.len());
    for c in text.chars() {
        for lower in c.to_lowercase() {
            folded.push(if lower == 'ς' { 'σ' } else { lower });
        }
    }
    folded
}

/// What the matcher reads as a regular expression is of this shape (more of this shape fail to parse and are read as
/// text).
fn pattern_shaped(name: &str) -> bool {
    let text = name.as_bytes();
    text.len() > 2
        && text[0] == b'/'
        && text[1..].iter().rposition(|&c| c == b'/').is_some_and(|i| {
            i > 0 && text[2 + i..].iter().all(|c| b"gimsuy".contains(c))
        })
}

enum NameLookup {
    Folded(Vec<u8>),
    OneByOne,
    Never,
}

/// How a name is found in a text: the matcher reads the name trimmed, never one that is empty so, and a name with a
/// macro or a pattern can't be looked up.
fn name_lookup(name: &[u8]) -> NameLookup {
    if name.windows(2).any(|w| w == b"{{") {
        return NameLookup::OneByOne;
    }
    let Ok(text) = std::str::from_utf8(name) else {
        return NameLookup::OneByOne;
    };
    let trimmed = text.trim_matches(js_space);
    if trimmed.is_empty() {
        NameLookup::Never
    } else if pattern_shaped(trimmed) {
        NameLookup::OneByOne
    } else {
        NameLookup::Folded(names_fold(trimmed).into_bytes())
    }
}

type NamesIndexed = (BTreeMap<Vec<u8>, BTreeSet<Vec<u8>>>, BTreeSet<Vec<u8>>);

fn names_indexed(names: &BTreeSet<Vec<u8>>) -> NamesIndexed {
    let (mut folded, mut one_by_one) = (BTreeMap::new(), BTreeSet::new());
    for name in names {
        match name_lookup(name) {
            NameLookup::Folded(fold) => {
                folded.entry(fold).or_insert_with(BTreeSet::new).insert(name.clone());
            }
            NameLookup::OneByOne => {
                one_by_one.insert(name.clone());
            }
            NameLookup::Never => {}
        }
    }
    (folded, one_by_one)
}

fn names_by_fold_key(book: u64, fold: &[u8], entry: u64) -> Vec<u8> {
    let mut stored_key = key::id(NAMES_BY_FOLD, book);
    put_bytes(&mut stored_key, fold);
    crate::keyspace::val::put_u64(&mut stored_key, entry);
    stored_key
}

fn one_by_one_key(book: u64, entry: u64, name: &[u8]) -> Vec<u8> {
    let mut stored_key = key::ids(NAMES_CHECKED_ONE_BY_ONE, book, entry);
    put_bytes(&mut stored_key, name);
    stored_key
}

/// Every change of an entry's names passes here (`names_offer`): its names before and after.
pub fn names_written(out: &mut Out, book: u64, entry: u64, old: &BTreeSet<Vec<u8>>, new: &BTreeSet<Vec<u8>>) {
    if old == new {
        return;
    }
    let ((old_folded, old_one), (new_folded, new_one)) = (names_indexed(old), names_indexed(new));
    for fold in old_folded.keys().chain(new_folded.keys()).collect::<BTreeSet<_>>() {
        match (old_folded.get(fold), new_folded.get(fold)) {
            (was, Some(now)) if was != Some(now) => {
                let mut value = Vec::new();
                for name in now {
                    put_bytes(&mut value, name);
                }
                out.put(names_by_fold_key(book, fold, entry), value);
            }
            (Some(_), None) => out.del(names_by_fold_key(book, fold, entry)),
            _ => {}
        }
    }
    for name in old_one.difference(&new_one) {
        out.del(one_by_one_key(book, entry, name));
    }
    for name in new_one.difference(&old_one) {
        out.put(one_by_one_key(book, entry, name), Vec::new());
    }
}

fn corrupt_names(what: &str) -> StoreError {
    StoreError::Entry(format!("{what} doesn't decode"))
}

fn flag_of(view: &View, entry: u64, code: u64) -> Result<Js, StoreError> {
    Ok(match super::history::json_value(view, entry, &FieldRef::Code(code))?.as_deref() {
        Some(b"true") => Js::Bool(true),
        Some(b"false") => Js::Bool(false),
        _ => Js::Null,
    })
}

struct Candidate {
    names: BTreeSet<Vec<u8>>,
    case_sensitive: Js,
    match_whole_words: Js,
}

struct LinkLookup<'a, 'b> {
    view: &'a View<'b>,
    book: u64,
    entry: u64,
    flags: (u64, u64),
    reads: usize,
    reads_at_most: usize,
    candidates: BTreeMap<u64, Candidate>,
}

impl LinkLookup<'_, '_> {
    fn spend(&mut self, reads: usize) -> bool {
        if self.reads + reads > self.reads_at_most {
            return false;
        }
        self.reads += reads;
        true
    }

    fn candidate(&mut self, other: u64, names: impl IntoIterator<Item = Vec<u8>>) -> Result<bool, StoreError> {
        if other == self.entry {
            return Ok(true);
        }
        if !self.candidates.contains_key(&other) {
            if !self.spend(2) {
                return Ok(false);
            }
            let found = Candidate {
                names: BTreeSet::new(),
                case_sensitive: flag_of(self.view, other, self.flags.0)?,
                match_whole_words: flag_of(self.view, other, self.flags.1)?,
            };
            self.candidates.insert(other, found);
        }
        if let Some(found) = self.candidates.get_mut(&other) {
            found.names.extend(names);
        }
        Ok(true)
    }

    /// Whether any name of the book is in the index: a world with none (an imported book, before its offer) costs a
    /// text one read instead of one per character.
    fn has_names_by_fold(&self) -> Result<bool, StoreError> {
        let book_prefix = key::id(NAMES_BY_FOLD, self.book);
        Ok(!self.view.scan(&book_prefix, &key::prefix_end(&book_prefix), 1)?.is_empty())
    }

    /// The greatest name ≤ `q` with any entry after it, as its fold.
    fn name_at_most(&self, q: &[u8]) -> Result<Option<Vec<u8>>, StoreError> {
        let book_prefix = key::id(NAMES_BY_FOLD, self.book);
        let mut end = book_prefix.clone();
        put_bytes(&mut end, q);
        let end = key::prefix_end(&end);
        let found = self.view.scan_vals_rev(&book_prefix, &end, 1)?;
        let Some((stored_key, _)) = found.first() else {
            return Ok(None);
        };
        let mut at = book_prefix.len();
        Ok(Some(get_bytes(stored_key, &mut at).ok_or_else(|| corrupt_names("a name's fold"))?))
    }

    /// Every entry with a name of this fold; false when the bound came first.
    fn entries_named(&mut self, fold: &[u8]) -> Result<bool, StoreError> {
        let mut prefix = key::id(NAMES_BY_FOLD, self.book);
        put_bytes(&mut prefix, fold);
        let mut after = prefix.clone();
        loop {
            let page = self.view.scan(&after, &key::prefix_end(&prefix), 64)?;
            for (stored_key, value) in &page {
                if !self.spend(1) {
                    return Ok(false);
                }
                let other = get_u64(stored_key, &mut prefix.len()).ok_or_else(|| corrupt_names("a name's entry"))?;
                let mut names = Vec::new();
                let mut at = 0;
                while at < value.len() {
                    names.push(get_bytes(value, &mut at).ok_or_else(|| corrupt_names("a name"))?);
                }
                if !self.candidate(other, names)? {
                    return Ok(false);
                }
            }
            let Some((last, _)) = page.last().filter(|_| page.len() == 64) else {
                return Ok(true);
            };
            after = last.clone();
            after.push(0);
        }
    }

    /// Every name whose fold starts `q`, longest first: each seek finds the greatest name at most `q[..k]`; one that is
    /// a prefix of `q` is found and the next seek is below it, else no name is between it and `q[..k]` that agrees with
    /// `q` further than it does, so the next seek is at what they share.
    fn names_starting(&mut self, q: &[u8], listed: &mut BTreeSet<Vec<u8>>) -> Result<bool, StoreError> {
        let mut k = q.len();
        while k > 0 {
            if !self.spend(1) {
                return Ok(false);
            }
            let Some(fold) = self.name_at_most(&q[..k])? else {
                return Ok(true);
            };
            let shared = fold.iter().zip(&q[..k]).take_while(|(a, b)| a == b).count();
            if shared < fold.len() {
                k = shared;
                continue;
            }
            if listed.insert(fold.clone()) && !self.entries_named(&fold)? {
                return Ok(false);
            }
            k = fold.len() - 1;
        }
        Ok(true)
    }

    fn checked_one_by_one(&mut self) -> Result<bool, StoreError> {
        let prefix = key::id(NAMES_CHECKED_ONE_BY_ONE, self.book);
        let mut after = prefix.clone();
        loop {
            let page = self.view.scan(&after, &key::prefix_end(&prefix), 64)?;
            for (stored_key, _) in &page {
                if !self.spend(1) {
                    return Ok(false);
                }
                let mut at = prefix.len();
                let other = get_u64(stored_key, &mut at).ok_or_else(|| corrupt_names("a name's entry"))?;
                let name = get_bytes(stored_key, &mut at).ok_or_else(|| corrupt_names("a name"))?;
                if !self.candidate(other, [name])? {
                    return Ok(false);
                }
            }
            let Some((last, _)) = page.last().filter(|_| page.len() == 64) else {
                return Ok(true);
            };
            after = last.clone();
            after.push(0);
        }
    }
}

/// The entries whose names `text` may write, each with those names and its matching flags, for the matcher to check:
/// every name the index finds in the text's fold, then every name checked one by one, in at most `reads_at_most`
/// reads. `complete` is false when the bound came first; what was found until then is kept.
pub fn link_candidates(
    view: &View,
    book: u64,
    entry: u64,
    text: &str,
    reads_at_most: usize,
) -> Result<Js, StoreError> {
    let flags = match entity_info(view, book)? {
        Some((BOOK, _, _)) => (WORLD_CASE_SENSITIVE, WORLD_MATCH_WHOLE_WORDS),
        Some((OWNED, bk, _)) if bk.ends_with(b":c") => (CARD_CASE_SENSITIVE, CARD_MATCH_WHOLE_WORDS),
        _ => return Ok(Js::Null),
    };
    let mut lookup = LinkLookup {
        view,
        book,
        entry,
        flags,
        reads: 0,
        reads_at_most,
        candidates: BTreeMap::new(),
    };
    let folded = names_fold(text);
    let mut listed = BTreeSet::new();
    let mut complete = lookup.spend(1);
    if complete && lookup.has_names_by_fold()? {
        for (at, c) in folded.char_indices() {
            if !js_space(c) && !lookup.names_starting(&folded.as_bytes()[at..], &mut listed)? {
                complete = false;
                break;
            }
        }
    }
    complete = complete && lookup.checked_one_by_one()?;
    let candidates = lookup
        .candidates
        .into_iter()
        .map(|(other, found)| {
            Js::Obj(vec![
                ("entry", Js::Big(other)),
                ("names", Js::Arr(found.names.into_iter().map(Js::Text).collect())),
                ("caseSensitive", found.case_sensitive),
                ("matchWholeWords", found.match_whole_words),
            ])
        })
        .collect();
    Ok(Js::Obj(vec![
        ("candidates", Js::Arr(candidates)),
        ("complete", Js::Bool(complete)),
        ("reads", Js::Num(lookup.reads as f64)),
    ]))
}

fn sigma_variants(term: String, out: &mut BTreeSet<(String, bool)>, as_prefix: bool) {
    if let Some(stem) = term.strip_suffix('σ') {
        out.insert((format!("{stem}ς"), as_prefix));
    } else if let Some(stem) = term.strip_suffix('ς') {
        out.insert((format!("{stem}σ"), as_prefix));
    }
    out.insert((term, as_prefix));
}

pub fn mention_terms(name: &[u8]) -> Option<Vec<(String, bool)>> {
    let toks = tokens(name);
    if toks.len() < 3 {
        return None;
    }
    let mut terms = BTreeSet::new();
    sigma_variants(toks[1].clone(), &mut terms, false);
    Some(terms.into_iter().collect())
}

fn skip_class(chars: &[char], mut at: usize) -> Option<usize> {
    at += 1;
    while at < chars.len() {
        match chars[at] {
            '\\' => at += 2,
            ']' => return Some(at + 1),
            _ => at += 1,
        }
    }
    None
}

fn skip_group(chars: &[char], mut at: usize) -> Option<usize> {
    let mut depth = 0usize;
    while at < chars.len() {
        match chars[at] {
            '\\' => at += 2,
            '[' => at = skip_class(chars, at)?,
            '(' => {
                depth += 1;
                at += 1;
            }
            ')' => {
                depth -= 1;
                at += 1;
                if depth == 0 {
                    return Some(at);
                }
            }
            _ => at += 1,
        }
    }
    None
}

fn skip_to(chars: &[char], at: usize, close: char) -> Option<usize> {
    chars[at..].iter().position(|&c| c == close).map(|i| at + i + 1)
}

fn counted_quantifier(chars: &[char], at: usize) -> Option<usize> {
    let mut i = at + 1;
    let digits = |i: &mut usize| {
        let start = *i;
        while chars.get(*i).is_some_and(char::is_ascii_digit) {
            *i += 1;
        }
        *i > start
    };
    if !digits(&mut i) {
        return None;
    }
    if chars.get(i) == Some(&',') {
        i += 1;
        digits(&mut i);
    }
    (chars.get(i) == Some(&'}')).then_some(i + 1)
}

/// Text every match of the JavaScript regular expression `source` holds verbatim; None with an alternation outside a
/// group.
pub fn regex_runs(source: &str) -> Option<Vec<Vec<char>>> {
    let chars: Vec<char> = source.chars().collect();
    let mut runs: Vec<Vec<char>> = Vec::new();
    let mut run: Vec<char> = Vec::new();
    let mut literal_last = false;
    let mut at = 0;
    let mut end = |run: &mut Vec<char>| {
        if !run.is_empty() {
            runs.push(std::mem::take(run));
        }
    };
    while at < chars.len() {
        let c = chars[at];
        let quantified = match c {
            '|' | ')' => return None,
            '(' => {
                at = skip_group(&chars, at)?;
                end(&mut run);
                false
            }
            '[' => {
                at = skip_class(&chars, at)?;
                end(&mut run);
                false
            }
            '*' | '?' => {
                if literal_last {
                    run.pop();
                }
                at += 1;
                end(&mut run);
                true
            }
            '+' => {
                at += 1;
                end(&mut run);
                true
            }
            '{' => match counted_quantifier(&chars, at) {
                Some(next) => {
                    if literal_last {
                        run.pop();
                    }
                    at = next;
                    end(&mut run);
                    true
                }
                None => {
                    at += 1;
                    end(&mut run);
                    false
                }
            },
            '.' | '^' | '$' => {
                at += 1;
                end(&mut run);
                false
            }
            '\\' => {
                let escaped = *chars.get(at + 1)?;
                at += 2;
                if escaped.is_ascii_alphanumeric() {
                    end(&mut run);
                    match chars.get(at) {
                        Some('{') => at = skip_to(&chars, at, '}')?,
                        Some('<') if escaped == 'k' => at = skip_to(&chars, at, '>')?,
                        _ => {}
                    }
                    literal_last = false;
                    continue;
                }
                run.push(escaped);
                literal_last = true;
                continue;
            }
            _ => {
                run.push(c);
                at += 1;
                literal_last = true;
                continue;
            }
        };
        literal_last = false;
        if quantified && chars.get(at) == Some(&'?') {
            at += 1;
        }
    }
    end(&mut run);
    Some(runs)
}

/// Under `i` a match can hold another case of the run, so only ASCII words between ASCII separators count, and under
/// `u` none with an `s`, which U+017F folds to.
fn bounded_words(run: &[char], ignore_case: bool, unicode: bool) -> Vec<String> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < run.len() {
        if !run[at].is_alphanumeric() {
            at += 1;
            continue;
        }
        let start = at;
        while at < run.len() && run[at].is_alphanumeric() {
            at += 1;
        }
        if start == 0 || at == run.len() {
            continue;
        }
        let word: String = run[start..at].iter().collect();
        if ignore_case
            && (!word.is_ascii()
                || !run[start - 1].is_ascii()
                || !run[at].is_ascii()
                || (unicode && word.to_ascii_lowercase().contains('s')))
        {
            continue;
        }
        out.extend(tokens(word.as_bytes()));
    }
    out
}

pub fn regex_mention_terms(source: &[u8], flags: &str) -> Option<Vec<(String, bool)>> {
    let source = std::str::from_utf8(source).ok()?;
    let (ignore_case, unicode) = (flags.contains('i'), flags.contains('u') || flags.contains('v'));
    let word = regex_runs(source)?
        .iter()
        .flat_map(|run| bounded_words(run, ignore_case, unicode))
        .max_by_key(|w| w.chars().count())?;
    let mut terms = BTreeSet::new();
    sigma_variants(word, &mut terms, false);
    Some(terms.into_iter().collect())
}

fn page(docs: (Vec<u64>, bool)) -> Js {
    let (docs, more) = docs;
    Js::Obj(vec![
        ("entries", Js::Arr(docs.into_iter().map(Js::Big).collect())),
        ("more", Js::Bool(more)),
    ])
}

pub struct MentionName {
    pub text: Vec<u8>,
    pub regex_flags: Option<String>,
}

pub fn mention_candidates(
    view: &View,
    book: u64,
    names: &[MentionName],
    after: Option<u64>,
    limit: usize,
) -> Result<Js, StoreError> {
    let mut terms = BTreeSet::new();
    for name in names {
        let found = match &name.regex_flags {
            Some(flags) => regex_mention_terms(&name.text, flags),
            None => mention_terms(&name.text),
        };
        let Some(found) = found else {
            return Ok(Js::Null);
        };
        terms.extend(found);
    }
    let terms: Vec<(String, bool)> = terms.into_iter().collect();
    let mask = 1u64 << CONTENT_FIELD;
    Ok(page(docs_with_terms(view, Scope::book(book), &terms, mask, after, limit)?))
}

pub fn entry_texts(view: &View, book: u64, entries: &[u64]) -> Result<Js, StoreError> {
    let mut out = Vec::with_capacity(entries.len());
    for &entry in entries {
        out.push(match super::overview::uid_in(view, book, entry)? {
            Some(_) => {
                let content = FieldRef::Code(super::entry_label::CONTENT);
                Js::Text(text_value(view, entry, &content)?.unwrap_or_default())
            }
            None => Js::Null,
        });
    }
    Ok(Js::Arr(out))
}

pub fn stats(view: &View, book: u64, entries: &[u64]) -> Result<Js, StoreError> {
    let b = book_stat(view, book)?;
    let mut list = Vec::with_capacity(entries.len());
    for &e in entries {
        let s = entry_stat(view, e)?;
        list.push(Js::Obj(vec![
            ("entry", Js::Big(e)),
            ("bytes", Js::Num(s.bytes as f64)),
            ("hash", Js::Big(s.hash as u64)),
        ]));
    }
    Ok(Js::Obj(vec![
        ("bytes", Js::Num(b.bytes as f64)),
        ("hash", Js::Big(b.hash as u64)),
        ("entries", Js::Num(b.entries as f64)),
        ("of", Js::Arr(list)),
    ]))
}
