//! Word pairs as index terms (build path 5d): each pair of adjacent tokens within one value of a short,
//! title-like field (`FieldDef::pairs`: names, labels, keywords; never body text) is a term (`term(a, b)`),
//! written with the words' (`index`): its postings hold the document's count of the pair per field, with its
//! document count and block maxima as a word's. A phrase in those fields is read through its pairs (`query`): two
//! whole words are one pair; more are their pairs, checked on the text only where a document can enter the page.
//!
//! A store indexes pairs from its start. One made before them builds them over its existing text, a slice at a
//! time (`step`), in the order of the documents' length entries; meanwhile a write keeps the pairs of the documents
//! the pass has reached, and reads use pairs only once every document has them (`on`), so a query answers the same
//! during the pass. A slice lost in a crash is done again from the cursor the last flush kept. The `searchPairs`
//! record starts it (the server writes one when a store's pairs aren't indexed).
//!
//! Before pairs were index terms they were an option (`LEGACY_*`): pair postings with no counts or maxima. A store
//! that had them deletes them first (with the option's own pass), then indexes them.

use std::collections::HashMap;

use super::{FIELD_BITS, FieldHit, LENGTH_BITS, Scope, length_block, pack, posting_block, slot};
use crate::keyspace::val::{get_u64, map_pairs};
use crate::log::format::{get_uvarint, put_uvarint};
use crate::store::StoreError;
use crate::store::derive::{Out, View};
use crate::store::kinds::{key, search_texts};

/// The state: `[mode]` then the pass's cursor (a length entry's key; the pass resumes after it, from the start
/// when empty). No state: pairs not indexed, and no pass under way.
pub const LEGACY_BUILDING: u64 = 1;
pub const LEGACY_ON: u64 = 2;
pub const LEGACY_DELETING: u64 = 3;
/// The pass indexing pairs over the existing text.
pub const INDEXING: u64 = 4;
/// Every document's pairs are indexed.
pub const INDEXED: u64 = 5;

/// Joins a pair's tokens; the tokenizer never yields it inside a token.
pub const SEPARATOR: char = '\u{1}';

/// Length entries a slice reads at most (16 documents each); tests take many slices.
pub const SLICE_BLOCKS: usize = if cfg!(test) { 4 } else { 256 };

pub fn term(a: &str, b: &str) -> String {
    format!("{a}{SEPARATOR}{b}")
}

/// Whether an index term is a pair.
pub fn is_pair(term: &str) -> bool {
    term.contains(SEPARATOR)
}

/// The mode (0: none) and the pass's cursor.
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

/// Whether some document has search text.
fn any_text(view: &View) -> Result<bool, StoreError> {
    let start = key::of(key::SEARCH_LENGTH);
    Ok(!view.scan(&start, &key::prefix_end(&start), 1)?.is_empty())
}

/// The mode a store whose pairs aren't indexed goes to: indexed at once with no text, else the pass.
fn index_mode(view: &View) -> Result<u64, StoreError> {
    Ok(if any_text(view)? { INDEXING } else { INDEXED })
}

/// A `searchPairs` record: pairs indexed (its value, the old option's on or off, no longer matters). A store with
/// the old option's pairs deletes them first.
pub fn turned(view: &View, out: &mut Out, _on: bool) -> Result<(), StoreError> {
    let (mode, _) = state(view)?;
    match mode {
        INDEXING | INDEXED | LEGACY_DELETING => {}
        LEGACY_BUILDING | LEGACY_ON => put_state(out, LEGACY_DELETING, &[]),
        _ => put_state(out, index_mode(view)?, &[]),
    }
    Ok(())
}

/// What a write to a document keeps of its pairs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kept {
    /// Nothing: not indexed yet.
    None,
    /// The old option's pair postings (`legacy`).
    Legacy,
    /// Pairs as index terms (`index::Terms`).
    Terms,
}

/// What a write to `doc` in `scope` keeps.
pub fn kept(view: &View, scope: Scope, doc: u64) -> Result<Kept, StoreError> {
    let (mode, cursor) = state(view)?;
    Ok(match mode {
        INDEXED => Kept::Terms,
        INDEXING if reached(scope, doc, &cursor) => Kept::Terms,
        LEGACY_ON => Kept::Legacy,
        LEGACY_BUILDING if reached(scope, doc, &cursor) => Kept::Legacy,
        LEGACY_DELETING if !reached(scope, doc, &cursor) => Kept::Legacy,
        _ => Kept::None,
    })
}

/// Whether the pass has done `doc`'s length entry.
fn reached(scope: Scope, doc: u64, cursor: &[u8]) -> bool {
    !cursor.is_empty() && length_block(scope, doc >> LENGTH_BITS).as_slice() <= cursor
}

/// Whether reads may use pairs: every document's are indexed.
pub fn on(view: &View) -> Result<bool, StoreError> {
    Ok(state(view)?.0 == INDEXED)
}

/// A field's values' pairs with their counts.
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

/// The old option's entries for a field's pairs going from `old` to `new`: postings alone.
pub fn legacy(
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
    if mode != INDEXING && mode != LEGACY_DELETING {
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
        // Each document's fields with text, in order: every field to delete the old option's pairs, the short
        // ones to index pairs.
        let mut docs: Vec<(u64, Vec<u32>)> = Vec::new();
        for (s, len) in lengths {
            let field = s & ((1 << FIELD_BITS) - 1);
            if len == 0 || field as usize >= scope.fields().len() {
                continue;
            }
            if mode == INDEXING && !scope.fields()[field as usize].pairs {
                continue;
            }
            let doc = block << LENGTH_BITS | u64::from(s >> FIELD_BITS);
            match docs.last_mut() {
                Some((d, fs)) if *d == doc => fs.push(field),
                _ => docs.push((doc, vec![field])),
            }
        }
        for (doc, fields) in docs {
            let texts: Vec<(u32, Vec<Vec<u8>>)> = fields
                .iter()
                .map(|&f| Ok((f, search_texts(view, scope, doc, f)?)))
                .collect::<Result<_, StoreError>>()?;
            if mode == INDEXING {
                let values: Vec<(u32, Vec<&[u8]>)> = texts
                    .iter()
                    .map(|(f, t)| (*f, t.iter().map(Vec::as_slice).collect()))
                    .collect();
                let fields: Vec<(u32, &[&[u8]])> =
                    values.iter().map(|(f, v)| (*f, v.as_slice())).collect();
                super::index::pairs_whole(view, out, scope, doc, &fields)?;
            } else {
                let none = HashMap::new();
                for (f, t) in &texts {
                    let now = of(&t.iter().map(Vec::as_slice).collect::<Vec<_>>());
                    legacy(out, scope, doc, *f, &now, &none);
                }
            }
        }
    }
    match page.last() {
        Some((k, _)) if page.len() == SLICE_BLOCKS => {
            put_state(out, mode, k);
            Ok(true)
        }
        _ if mode == LEGACY_DELETING => {
            // The old option's pairs are gone: now the pairs are indexed.
            put_state(out, index_mode(view)?, &[]);
            Ok(true)
        }
        _ => {
            put_state(out, INDEXED, &[]);
            Ok(false)
        }
    }
}
