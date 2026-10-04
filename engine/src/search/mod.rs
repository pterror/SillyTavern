//! P3, search (design `.plans/2026-10-03-storage-from-needs.md` 7): postings per (document, field) with term
//! frequencies, prefix terms in the prefix fields, BM25 statistics and per-block score bounds, all entries in
//! the derived keyspace, written at commit from the text before and after a change (`index`), read by
//! `query`. No positions: a phrase is checked on the candidates' text.
//!
//! A scope is one searchable set of documents: the library (documents are entities), the tag names (documents
//! are tags), one owner's chat messages (documents are messages).

#[cfg(any(test, feature = "measure"))]
pub mod brute;
pub mod index;
pub mod query;
#[cfg(test)]
mod tests;
pub mod text;

use crate::keyspace::val::{put_bytes, put_u64};
use crate::log::format::{get_uvarint, put_uvarint};
use crate::store::kinds::key;

/// BM25's constants, as tantivy's.
pub const K1: f64 = 1.2;
pub const B: f64 = 0.75;

/// A term's postings are kept per block of `1 << BLOCK_BITS` consecutive ids, one entry each, compressed
/// (`Val::Map`); score bounds are per block too.
pub const BLOCK_BITS: u32 = 10;
/// A document's lengths in every field (what says whether it has any text) are kept per block of
/// `1 << LENGTH_BITS` ids.
pub const LENGTH_BITS: u32 = 6;

pub const LIBRARY: u64 = 1;
pub const TAGS: u64 = 2;
pub const CHAT: u64 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Scope {
    pub kind: u64,
    /// The chat's owner for `CHAT`; 0 otherwise.
    pub owner: u64,
}

impl Scope {
    pub const LIBRARY: Scope = Scope {
        kind: LIBRARY,
        owner: 0,
    };
    pub const TAGS: Scope = Scope {
        kind: TAGS,
        owner: 0,
    };

    pub fn chat(owner: u64) -> Scope {
        Scope { kind: CHAT, owner }
    }

    pub fn fields(&self) -> &'static [FieldDef] {
        match self.kind {
            LIBRARY => LIBRARY_FIELDS,
            TAGS => TAG_FIELDS,
            _ => CHAT_FIELDS,
        }
    }
}

pub struct FieldDef {
    pub name: &'static str,
    pub weight: f64,
    /// The query's last word matches as a prefix here.
    pub prefix: bool,
    /// Not indexed in this scope: the names of the document's tags, read through tag membership.
    pub joined: bool,
}

const fn field(name: &'static str, weight: f64, prefix: bool) -> FieldDef {
    FieldDef {
        name,
        weight,
        prefix,
        joined: false,
    }
}

/// Upstream's Fuse key weights (`fuzzySearchCharacters`); prefix on name, creator and tags (design 7.1, Q-F1).
pub static LIBRARY_FIELDS: &[FieldDef] = &[
    field("name", 20.0, true),
    FieldDef {
        name: "resolved_tags",
        weight: 10.0,
        prefix: true,
        joined: true,
    },
    field("description", 3.0, false),
    field("mes_example", 3.0, false),
    field("scenario", 2.0, false),
    field("personality", 2.0, false),
    field("first_mes", 2.0, false),
    field("creator_notes", 2.0, false),
    field("creator", 1.0, true),
    field("tags", 1.0, true),
    field("alternate_greetings", 1.0, false),
];

pub static TAG_FIELDS: &[FieldDef] = &[field("name", 1.0, true)];

pub static CHAT_FIELDS: &[FieldDef] = &[field("text", 1.0, false)];

/// Whether a term is a whole token or a token's prefix term.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum TermKind {
    Exact = 0,
    Gram = 1,
}

// ---- keys ----

fn scoped(structure: u64, s: Scope) -> Vec<u8> {
    let mut k = key::of(structure);
    put_u64(&mut k, s.kind);
    put_u64(&mut k, s.owner);
    k
}

/// The postings of a term: then a block → a map (`Val::Map`) of `slot(doc, field)` → term frequency.
pub fn postings(s: Scope, kind: TermKind, term: &str) -> Vec<u8> {
    let mut k = scoped(key::SEARCH_POSTING, s);
    k.push(kind as u8);
    put_bytes(&mut k, term.as_bytes());
    k
}

pub fn posting_block(s: Scope, kind: TermKind, term: &str, block: u64) -> Vec<u8> {
    let mut k = postings(s, kind, term);
    put_u64(&mut k, block);
    k
}

/// Documents whose field holds the term (a counter).
pub fn doc_freq(s: Scope, kind: TermKind, term: &str, field: u32) -> Vec<u8> {
    let mut k = scoped(key::SEARCH_DOC_FREQ, s);
    k.push(kind as u8);
    put_bytes(&mut k, term.as_bytes());
    put_u64(&mut k, u64::from(field));
    k
}

/// Every document's field lengths: then a length block → a map of `slot_in(LENGTH_BITS, doc, field)` → tokens.
pub fn lengths(s: Scope) -> Vec<u8> {
    scoped(key::SEARCH_LENGTH, s)
}

pub fn length_block(s: Scope, block: u64) -> Vec<u8> {
    let mut k = lengths(s);
    put_u64(&mut k, block);
    k
}

/// One field's lengths: then a postings block → a map of the document's place in the block → tokens. What
/// scoring reads: only the fields a match is in.
pub fn field_lengths(s: Scope, field: u32) -> Vec<u8> {
    let mut k = scoped(key::SEARCH_FIELD_LENGTH, s);
    put_u64(&mut k, u64::from(field));
    k
}

pub fn field_length_block(s: Scope, field: u32, block: u64) -> Vec<u8> {
    let mut k = field_lengths(s, field);
    put_u64(&mut k, block);
    k
}

/// A document's place in its postings block.
pub fn in_block(doc: u64) -> u32 {
    (doc & ((1 << BLOCK_BITS) - 1)) as u32
}

/// Fields per scope are at most `1 << FIELD_BITS`.
pub const FIELD_BITS: u32 = 4;

/// A document's field within its block's map, for blocks of `1 << bits` ids.
pub fn slot_in(bits: u32, doc: u64, field: u32) -> u32 {
    debug_assert!(field < 1 << FIELD_BITS);
    ((doc & ((1 << bits) - 1)) as u32) << FIELD_BITS | field
}

/// The document and field of a slot in block `block` of `1 << bits` ids.
pub fn unslot_in(bits: u32, block: u64, slot: u32) -> (u64, u32) {
    (
        block << bits | u64::from(slot >> FIELD_BITS),
        slot & ((1 << FIELD_BITS) - 1),
    )
}

/// `slot_in` for postings blocks.
pub fn slot(doc: u64, field: u32) -> u32 {
    slot_in(BLOCK_BITS, doc, field)
}

/// `unslot_in` for postings blocks.
pub fn unslot(block: u64, slot: u32) -> (u64, u32) {
    unslot_in(BLOCK_BITS, block, slot)
}

/// A field's per-block shortest length, as a maximum of `LENGTH_MAX - length`: then block → that.
pub fn shortest_all(s: Scope, field: u32) -> Vec<u8> {
    let mut k = scoped(key::SEARCH_SHORTEST, s);
    put_u64(&mut k, u64::from(field));
    k
}

pub fn shortest(s: Scope, field: u32, block: u64) -> Vec<u8> {
    let mut k = shortest_all(s, field);
    put_u64(&mut k, block);
    k
}

pub const LENGTH_MAX: u64 = u32::MAX as u64;

/// A field's tokens over every document (a counter).
pub fn field_tokens(s: Scope, field: u32) -> Vec<u8> {
    let mut k = scoped(key::SEARCH_FIELD_TOKENS, s);
    put_u64(&mut k, u64::from(field));
    k
}

/// Documents with any indexed text (a counter).
pub fn doc_count(s: Scope) -> Vec<u8> {
    scoped(key::SEARCH_DOCS, s)
}

/// The highest document id that has had text (a maximum).
pub fn max_doc(s: Scope) -> Vec<u8> {
    scoped(key::SEARCH_MAX_DOC, s)
}

pub fn varint(n: u64) -> Vec<u8> {
    let mut out = Vec::new();
    put_uvarint(&mut out, n);
    out
}

pub fn parse_varint(b: &[u8]) -> Option<u64> {
    let mut at = 0;
    let v = get_uvarint(b, &mut at).ok()?;
    (at == b.len()).then_some(v)
}

// ---- scoring ----

pub fn idf(df: f64, n: f64) -> f64 {
    (1.0 + (n - df + 0.5) / (df + 0.5)).ln()
}

pub fn tf_norm(tf: f64, len: f64, avg_len: f64) -> f64 {
    let rel = if avg_len > 0.0 { len / avg_len } else { 1.0 };
    tf * (K1 + 1.0) / (tf + K1 * (1.0 - B + B * rel))
}

/// One term's weighted BM25 score in one field.
pub fn score(weight: f64, idf: f64, tf: f64, len: f64, avg_len: f64) -> f64 {
    weight * idf * tf_norm(tf, len, avg_len)
}
