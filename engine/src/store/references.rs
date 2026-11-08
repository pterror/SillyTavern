use std::collections::BTreeSet;

use super::StoreError;
use super::book_stats::{book_stat, entry_stat};
use super::chat_read::Js;
use super::books::{BOOK, OWNED};
use super::derive::{Out, View};
use super::kinds::{key, text_value};
use super::library::{ITEM_BASE, LISTS, entity_info};
use crate::keyspace::val::get_u64;
use crate::log::format::FieldRef;
use crate::search::query::docs_with_terms;
use crate::search::text::{GRAM_MAX, tokens};
use crate::search::Scope;

pub const KEY_FIELD: u32 = 0;
pub const CONTENT_FIELD: u32 = 4;
pub const UNINDEXED: u64 = 222;

const WORLD_KEYS: u64 = 0;
const OWNED_KEYS: u64 = 3;

pub fn unindexable(text: &[u8]) -> bool {
    let regex_shape = text.len() > 2
        && text[0] == b'/'
        && text[1..].iter().rposition(|&c| c == b'/').is_some_and(|i| {
            i > 0 && text[2 + i..].iter().all(|c| b"gimsuy".contains(c))
        });
    regex_shape || tokens(text).is_empty() || text.windows(2).any(|w| w == b"{{")
}

pub fn key_list(view: &View, book: u64) -> Result<Option<u64>, StoreError> {
    Ok(match entity_info(view, book)? {
        Some((BOOK, _, _)) => Some(WORLD_KEYS),
        Some((OWNED, bk, _)) if bk.ends_with(b":c") => Some(OWNED_KEYS),
        _ => None,
    })
}

fn unindexed_key(book: u64, entry: u64, code: u64) -> Vec<u8> {
    let mut k = key::ids(UNINDEXED, book, entry);
    crate::keyspace::val::put_u64(&mut k, code);
    k
}

pub fn key_written(
    view: &View,
    out: &mut Out,
    book: u64,
    entry: u64,
    f: &FieldRef,
    new: Option<&[u8]>,
) -> Result<(), StoreError> {
    let FieldRef::Code(c) = f else {
        return Ok(());
    };
    if *c < ITEM_BASE || Some((c - ITEM_BASE) % LISTS) != key_list(view, book)? {
        return Ok(());
    }
    let k = unindexed_key(book, entry, *c);
    match new {
        Some(t) if unindexable(t) => out.put(k, Vec::new()),
        _ => out.del(k),
    }
    Ok(())
}

pub fn entry_gone(view: &View, out: &mut Out, book: u64, entry: u64) -> Result<(), StoreError> {
    let p = key::ids(UNINDEXED, book, entry);
    for (k, _) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        out.del(k);
    }
    Ok(())
}

pub fn unindexed_page(
    view: &View,
    book: u64,
    after: Option<u64>,
    limit: usize,
) -> Result<Js, StoreError> {
    let p = key::id(UNINDEXED, book);
    let start = match after {
        Some(a) => key::ids(UNINDEXED, book, a + 1),
        None => p.clone(),
    };
    let mut names: Vec<Js> = Vec::new();
    let mut last: Option<u64> = None;
    let mut more = false;
    for (k, _) in view.scan(&start, &key::prefix_end(&p), usize::MAX)? {
        let mut at = p.len();
        let bad = || StoreError::Entry("an unindexed name key doesn't decode".into());
        let entry = get_u64(&k, &mut at).ok_or_else(bad)?;
        let code = get_u64(&k, &mut at).ok_or_else(bad)?;
        if last != Some(entry) && names.len() >= limit {
            more = true;
            break;
        }
        last = Some(entry);
        let text = text_value(view, entry, &FieldRef::Code(code))?.unwrap_or_default();
        names.push(Js::Obj(vec![("entry", Js::Big(entry)), ("name", Js::Text(text))]));
    }
    Ok(Js::Obj(vec![("names", Js::Arr(names)), ("more", Js::Bool(more))]))
}

fn sigma_variants(term: String, out: &mut BTreeSet<(String, bool)>, as_prefix: bool) {
    if let Some(stem) = term.strip_suffix('σ') {
        out.insert((format!("{stem}ς"), as_prefix));
    } else if let Some(stem) = term.strip_suffix('ς') {
        out.insert((format!("{stem}σ"), as_prefix));
    }
    out.insert((term, as_prefix));
}

pub fn name_terms(text: &[u8]) -> Vec<(String, bool)> {
    let mut terms = BTreeSet::new();
    let distinct: BTreeSet<String> = tokens(text).into_iter().collect();
    for tok in distinct {
        let chars: Vec<char> = tok.chars().collect();
        for i in 0..chars.len() {
            let rest = chars.len() - i;
            for len in 1..=rest.min(GRAM_MAX) {
                sigma_variants(chars[i..i + len].iter().collect(), &mut terms, false);
            }
            if rest > GRAM_MAX {
                sigma_variants(chars[i..i + GRAM_MAX].iter().collect(), &mut terms, true);
            }
        }
    }
    terms.into_iter().collect()
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

fn page(docs: (Vec<u64>, bool)) -> Js {
    let (docs, more) = docs;
    Js::Obj(vec![
        ("entries", Js::Arr(docs.into_iter().map(Js::Big).collect())),
        ("more", Js::Bool(more)),
    ])
}

pub fn name_candidates(
    view: &View,
    book: u64,
    text: &[u8],
    after: Option<u64>,
    limit: usize,
) -> Result<Js, StoreError> {
    let terms = name_terms(text);
    let mask = 1u64 << KEY_FIELD;
    Ok(page(docs_with_terms(view, Scope::book(book), &terms, mask, after, limit)?))
}

pub fn mention_candidates(
    view: &View,
    book: u64,
    name: &[u8],
    after: Option<u64>,
    limit: usize,
) -> Result<Js, StoreError> {
    let Some(terms) = mention_terms(name) else {
        return Ok(Js::Null);
    };
    let mask = 1u64 << CONTENT_FIELD;
    Ok(page(docs_with_terms(view, Scope::book(book), &terms, mask, after, limit)?))
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
