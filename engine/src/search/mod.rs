//! P3, search (design `.plans/2026-10-03-storage-from-needs.md` 7). Every entry is in the derived keyspace,
//! written at commit from a field's text before and after a change (`index`), read by `query`.
//!
//! A term's postings are in id order, compressed per block of ids: each document's fields with the term's count
//! there. A string is one term both as a whole token and as a prefix term (a token's first 2–20 characters in the
//! prefix fields): a prefix field's slot holds both counts, so the query's last word reads the same list. Per
//! block and field the term's highest count, and per block and field the shortest length, bound a block's scores
//! (block-max WAND). A term with more documents than a page or two also keeps its best documents (`top`), so a
//! word's first page reads those. No positions: a phrase is checked on the candidates' text.
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
pub mod top;

use crate::keyspace::val::{put_bytes, put_u64};
use crate::log::format::{get_uvarint, put_uvarint};
use crate::store::kinds::key;

/// BM25's constants, as tantivy's.
pub const K1: f64 = 1.2;
pub const B: f64 = 0.75;

/// A term's postings are one entry (a compressed `Val::Map`) per block of `1 << BLOCK_BITS` consecutive ids;
/// score bounds are per block too.
pub const BLOCK_BITS: u32 = 10;
/// A document's lengths in every field are kept per block of `1 << LENGTH_BITS` ids.
pub const LENGTH_BITS: u32 = 4;
/// Per-block bounds of a term (or a field's lengths) are one entry per `1 << CHUNK_BITS` blocks.
pub const CHUNK_BITS: u32 = 16;

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

/// Weights: upstream's Fuse keys for `fuzzySearchCharacters` (name 20, tags 10, description and example 3,
/// scenario, personality, first message and notes 2, creator, card tags and alternate greetings 1), which the old
/// index used as BM25 field boosts too; with them a match in the name outranks body matches. Prefix on name,
/// creator and tags (design 7.1, Q-F1).
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

/// Which document frequency a term's count is: of the term as a whole token, or as a prefix term (a token's
/// first 2–20 characters) in a prefix field.
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

fn termed(structure: u64, s: Scope, term: &str) -> Vec<u8> {
    let mut k = scoped(structure, s);
    put_bytes(&mut k, term.as_bytes());
    k
}

/// A term's postings: then a block → a map (`Val::Map`) of `slot(doc, field)` → `pack`ed counts.
pub fn postings(s: Scope, term: &str) -> Vec<u8> {
    termed(key::SEARCH_POSTING, s, term)
}

pub fn posting_block(s: Scope, term: &str, block: u64) -> Vec<u8> {
    let mut k = postings(s, term);
    put_u64(&mut k, block);
    k
}

/// A term's highest count per block and field: then a chunk of blocks → a maxima map (`Val::MaxMap`) of
/// `bound_slot(block, field)` → the count (as a prefix term in a prefix field).
pub fn block_maxima(s: Scope, term: &str, chunk: u64) -> Vec<u8> {
    let mut k = termed(key::SEARCH_BLOCK_MAX, s, term);
    put_u64(&mut k, chunk);
    k
}

/// A field's shortest length per block: then a chunk of blocks → a maxima map of `bound_slot(block, 0)` →
/// `SHORTEST_BASE - length` (only ever raised: a block's lengths may since have grown).
pub fn shortest(s: Scope, field: u32, chunk: u64) -> Vec<u8> {
    let mut k = scoped(key::SEARCH_SHORTEST, s);
    put_u64(&mut k, u64::from(field));
    put_u64(&mut k, chunk);
    k
}

pub const SHORTEST_BASE: u64 = u32::MAX as u64;

/// A block's chunk and its slot in the chunk's map, for field `field`.
pub fn bound_slot(block: u64, field: u32) -> (u64, u32) {
    (
        block >> CHUNK_BITS,
        ((block & ((1 << CHUNK_BITS) - 1)) as u32) << FIELD_BITS | field,
    )
}

/// Documents holding the term in any field, as a whole token or a prefix term (a counter).
pub fn term_docs(s: Scope, term: &str) -> Vec<u8> {
    termed(key::SEARCH_TERM_DOCS, s, term)
}

/// A term's best documents (`top::List`), for a term with more documents than the list holds.
pub fn top(s: Scope, term: &str) -> Vec<u8> {
    termed(key::SEARCH_TOP, s, term)
}

/// Changes that no top list followed (a bulk load's): a list built before the last one is stale (a counter).
pub fn top_generation(s: Scope) -> Vec<u8> {
    scoped(key::SEARCH_TOP_GENERATION, s)
}

/// Documents whose field holds the term: then the field (a counter each).
pub fn doc_freqs(s: Scope, kind: TermKind, term: &str) -> Vec<u8> {
    let mut k = scoped(key::SEARCH_DOC_FREQ, s);
    k.push(kind as u8);
    put_bytes(&mut k, term.as_bytes());
    k
}

pub fn doc_freq(s: Scope, kind: TermKind, term: &str, field: u32) -> Vec<u8> {
    let mut k = doc_freqs(s, kind, term);
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

// ---- values ----

/// A term's counts in one field of a document: as a whole token, and as a prefix term (the same outside the
/// prefix fields, where the query's last word matches whole tokens).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FieldHit {
    pub exact: u64,
    pub gram: u64,
}

impl FieldHit {
    /// The count a word matches by: as a prefix or whole.
    pub fn tf(&self, as_prefix: bool) -> u64 {
        if as_prefix { self.gram } else { self.exact }
    }

    /// The higher count: what bounds hold.
    pub fn most(&self) -> u64 {
        self.exact.max(self.gram)
    }
}

/// Counts in a prefix field's slot are kept to 16 bits each; elsewhere to 32.
const PREFIX_TF_MAX: u64 = (1 << 16) - 1;

/// A posting slot's value (never 0: a slot holds a field the term is in).
pub fn pack(prefix_field: bool, h: FieldHit) -> u32 {
    if prefix_field {
        (h.exact.min(PREFIX_TF_MAX) as u32) | (h.gram.min(PREFIX_TF_MAX) as u32) << 16
    } else {
        h.exact.min(u64::from(u32::MAX)) as u32
    }
}

pub fn unpack(prefix_field: bool, v: u32) -> FieldHit {
    if prefix_field {
        FieldHit {
            exact: u64::from(v & 0xffff),
            gram: u64::from(v >> 16),
        }
    } else {
        FieldHit {
            exact: u64::from(v),
            gram: u64::from(v),
        }
    }
}

/// Field lengths quantized to a byte, as tantivy's field norms: exact below 32, then steps of about 10% (each
/// code stands for its lowest length).
fn length_edges() -> &'static [u32; 256] {
    static EDGES: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    EDGES.get_or_init(|| {
        let mut e = [0u32; 256];
        for (i, x) in e.iter_mut().enumerate().take(32) {
            *x = i as u32;
        }
        for i in 32..256 {
            let prev = u64::from(e[i - 1]);
            let next = (prev + 1).max((prev as f64 * 1.1).ceil() as u64);
            e[i] = next.min(u64::from(u32::MAX)) as u32;
        }
        e
    })
}

pub fn length_code(len: u64) -> u8 {
    let e = length_edges();
    let len = len.min(u64::from(u32::MAX)) as u32;
    (e.partition_point(|&x| x <= len) - 1) as u8
}

/// The length a code stands for.
pub fn code_length(code: u8) -> f64 {
    f64::from(length_edges()[code as usize])
}

// ---- scoring ----

pub fn idf(df: f64, n: f64) -> f64 {
    (1.0 + (n - df + 0.5) / (df + 0.5)).ln()
}

pub fn tf_norm(tf: f64, len: f64, avg_len: f64) -> f64 {
    let rel = if avg_len > 0.0 { len / avg_len } else { 1.0 };
    tf * (K1 + 1.0) / (tf + K1 * (1.0 - B + B * rel))
}
