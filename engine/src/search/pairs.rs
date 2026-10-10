//! Pair postings (build path 5d, an option off by default): each pair of adjacent tokens within one value of a
//! field is a term (`term(a, b)`), its postings holding the document's count of the pair per field. A phrase's
//! candidate field must hold each of its whole-token pairs before its text is read, and a two-word phrase whose
//! words are both whole is decided by its pair alone.
//!
//! Turning the option on (`searchPairs` with `on`) starts a build over every searched document's text, a slice at a
//! time (`step`) in the order of the documents' length entries; turning it off starts a delete the same way. While
//! one is under way, a write keeps the pairs of documents the pass has reached (building) or not yet reached
//! (deleting), so the pass and the writes leave every document as the option says. Reads use pairs only once the
//! option is on and built. A slice lost in a crash is done again from the cursor the last flush kept.

use std::collections::HashMap;

use super::{FIELD_BITS, FieldHit, LENGTH_BITS, Scope, length_block, pack, posting_block, slot};
use crate::keyspace::val::{get_u64, map_pairs};
use crate::log::format::{get_uvarint, put_uvarint};
use crate::store::StoreError;
use crate::store::derive::{Out, View};
use crate::store::kinds::{key, search_texts};

/// The pass and the option: `[mode]` then the cursor (a length entry's key; the pass resumes after it, from the
/// start when empty).
pub const BUILDING: u64 = 1;
pub const ON: u64 = 2;
pub const DELETING: u64 = 3;

/// Joins a pair's tokens; the tokenizer never yields it inside a token.
pub const SEPARATOR: char = '\u{1}';

/// Length entries a slice reads at most (16 documents each); tests take many slices.
pub const SLICE_BLOCKS: usize = if cfg!(test) { 4 } else { 256 };

pub fn term(a: &str, b: &str) -> String {
    format!("{a}{SEPARATOR}{b}")
}

/// The option's mode (0: off) and the pass's cursor.
pub fn state(view: &View) -> Result<(u64, Vec<u8>), StoreError> {
    let Some(b) = view.get(&key::of(key::SEARCH_PAIRS))? else {
        return Ok((0, Vec::new()));
    };
    let mut at = 0;
    let mode = get_uvarint(&b, &mut at)
        .map_err(|_| StoreError::Entry("the pairs state doesn't decode".into()))?;
    Ok((mode, b[at..].to_vec()))
}

fn put_state(out: &mut Out, mode: u64, cursor: &[u8]) {
    if mode == 0 {
        out.del(key::of(key::SEARCH_PAIRS));
        return;
    }
    let mut v = Vec::new();
    put_uvarint(&mut v, mode);
    v.extend_from_slice(cursor);
    out.put(key::of(key::SEARCH_PAIRS), v);
}

/// The option turned on or off: a pass starts unless it is already so or going there.
pub fn turned(view: &View, out: &mut Out, on: bool) -> Result<(), StoreError> {
    let (mode, _) = state(view)?;
    match (on, mode) {
        (true, BUILDING | ON) | (false, 0 | DELETING) => {}
        (true, _) => put_state(out, BUILDING, &[]),
        (false, _) => put_state(out, DELETING, &[]),
    }
    Ok(())
}

/// Whether a write to `doc` in `scope` keeps its pairs.
pub fn kept(view: &View, scope: Scope, doc: u64) -> Result<bool, StoreError> {
    let (mode, cursor) = state(view)?;
    Ok(match mode {
        ON => true,
        BUILDING => reached(scope, doc, &cursor),
        DELETING => !reached(scope, doc, &cursor),
        _ => false,
    })
}

/// Whether the pass has done `doc`'s length entry.
fn reached(scope: Scope, doc: u64, cursor: &[u8]) -> bool {
    !cursor.is_empty() && length_block(scope, doc >> LENGTH_BITS).as_slice() <= cursor
}

/// Whether reads may use pairs.
pub fn on(view: &View) -> Result<bool, StoreError> {
    Ok(state(view)?.0 == ON)
}

/// A field's pairs with their counts, over its values.
pub fn of(items: &[&[u8]]) -> HashMap<String, u64> {
    let mut out = HashMap::new();
    for item in items {
        let toks = super::text::tokens(item);
        for w in toks.windows(2) {
            *out.entry(term(&w[0], &w[1])).or_default() += 1;
        }
    }
    out
}

/// The entries for a field's pairs going from `old` to `new`.
pub fn update(
    out: &mut Out,
    scope: Scope,
    doc: u64,
    field: u32,
    old: &HashMap<String, u64>,
    new: &HashMap<String, u64>,
) {
    let prefix = scope.fields()[field as usize].prefix;
    let block = doc >> super::BLOCK_BITS;
    for (t, &n) in new {
        if old.get(t) != Some(&n) {
            let v = pack(prefix, FieldHit { exact: n, gram: 0 }).max(1);
            out.map(posting_block(scope, t, block), vec![(slot(doc, field), v)]);
        }
    }
    for t in old.keys().filter(|t| !new.contains_key(*t)) {
        out.map(posting_block(scope, t, block), vec![(slot(doc, field), 0)]);
    }
}

/// The scope and block of a length entry's key.
fn parse_length_key(k: &[u8]) -> Option<(Scope, u64)> {
    let mut at = key::of(key::SEARCH_LENGTH).len();
    let kind = get_u64(k, &mut at)?;
    let owner = get_u64(k, &mut at)?;
    let block = get_u64(k, &mut at)?;
    (at == k.len()).then_some((Scope { kind, owner }, block))
}

/// One slice of the pass under way; whether more follow.
pub fn step(view: &View, out: &mut Out) -> Result<bool, StoreError> {
    let (mode, cursor) = state(view)?;
    if mode != BUILDING && mode != DELETING {
        return Ok(false);
    }
    let start = key::of(key::SEARCH_LENGTH);
    let end = key::prefix_end(&start);
    let from = if cursor.is_empty() {
        start.clone()
    } else {
        let mut c = cursor.clone();
        c.push(0);
        c
    };
    let page = view.scan(&from, &end, SLICE_BLOCKS)?;
    for (k, v) in &page {
        let Some((scope, block)) = parse_length_key(k) else {
            continue;
        };
        let lengths = map_pairs(v)
            .ok_or_else(|| StoreError::Entry("a length block doesn't decode".into()))?;
        for (s, len) in lengths {
            if len == 0 {
                continue;
            }
            let doc = block << LENGTH_BITS | u64::from(s >> FIELD_BITS);
            let field = s & ((1 << FIELD_BITS) - 1);
            if field as usize >= scope.fields().len() {
                continue;
            }
            let texts = search_texts(view, scope, doc, field)?;
            let now = of(&texts.iter().map(Vec::as_slice).collect::<Vec<_>>());
            let none = HashMap::new();
            if mode == BUILDING {
                update(out, scope, doc, field, &none, &now);
            } else {
                update(out, scope, doc, field, &now, &none);
            }
        }
    }
    match page.last() {
        Some((k, _)) if page.len() == SLICE_BLOCKS => {
            put_state(out, mode, k);
            Ok(true)
        }
        _ => {
            put_state(out, if mode == BUILDING { ON } else { 0 }, &[]);
            Ok(false)
        }
    }
}
