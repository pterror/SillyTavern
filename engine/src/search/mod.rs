//! P3, search (design `.plans/2026-10-03-storage-from-needs.md` 7). Every entry is in the derived keyspace,
//! written at commit from a field's text before and after a change (`index`), read by `query`.
//!
//! A term's postings are one per (term, document), holding every field's frequency and quantized length, filed
//! best first: by score class (a weighted BM25 of the posting at reference field lengths), then by block of ids.
//! So a word's best documents are its first entries. A directory per term (id order: document → class) finds a
//! document's posting and serves intersections. No positions: a phrase is checked on the candidates' text.
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

/// A term's directory is one entry (a compressed `Val::Map`) per block of `1 << BLOCK_BITS` consecutive ids.
pub const BLOCK_BITS: u32 = 10;
/// A term's postings of one class are one entry per block of `1 << IMPACT_BITS` ids: wider, since a class holds
/// a fraction of the term's documents.
pub const IMPACT_BITS: u32 = 14;
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
    /// The length (in tokens) score classes take as the field's average; the query scales its bounds by how far
    /// the real average is above it.
    pub avg: f64,
    /// The idf score classes take for the field; the query scales its bounds by the highest ratio of a field's
    /// real idf to it. Words are rarer in short fields, so their idf runs higher there.
    pub idf: f64,
}

const fn field(name: &'static str, weight: f64, prefix: bool, avg: f64, idf: f64) -> FieldDef {
    FieldDef {
        name,
        weight,
        prefix,
        joined: false,
        avg,
        idf,
    }
}

/// Weights: upstream's Fuse keys for `fuzzySearchCharacters` (name 20, tags 10, description and example 3,
/// scenario, personality, first message and notes 2, creator, card tags and alternate greetings 1), which the old
/// index used as BM25 field boosts too; with them a match in the name outranks body matches. Prefix on name,
/// creator and tags (design 7.1, Q-F1). Reference averages and idfs: the synthetic library's, roughly.
pub static LIBRARY_FIELDS: &[FieldDef] = &[
    field("name", 20.0, true, 3.0, 6.0),
    FieldDef {
        name: "resolved_tags",
        weight: 10.0,
        prefix: true,
        joined: true,
        avg: 0.0,
        idf: 0.0,
    },
    field("description", 3.0, false, 450.0, 2.0),
    field("mes_example", 3.0, false, 220.0, 2.0),
    field("scenario", 2.0, false, 85.0, 2.0),
    field("personality", 2.0, false, 60.0, 2.0),
    field("first_mes", 2.0, false, 240.0, 2.0),
    field("creator_notes", 2.0, false, 120.0, 2.0),
    field("creator", 1.0, true, 2.0, 5.0),
    field("tags", 1.0, true, 15.0, 4.0),
    field("alternate_greetings", 1.0, false, 380.0, 2.0),
];

pub static TAG_FIELDS: &[FieldDef] = &[field("name", 1.0, true, 2.0, 4.0)];

pub static CHAT_FIELDS: &[FieldDef] = &[field("text", 1.0, false, 40.0, 3.0)];

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

/// A term's postings, best first within each group: then the group, the score class (descending, as
/// `CLASSES - 1 - class`) and a block of `1 << IMPACT_BITS` ids → a map (`Val::Map`) of
/// `slot_in(IMPACT_BITS, doc, field)` → `pack(tf, length code)`. A posting's rank is `group * CLASSES + class`.
pub fn postings(s: Scope, kind: TermKind, term: &str) -> Vec<u8> {
    let mut k = scoped(key::SEARCH_POSTING, s);
    k.push(kind as u8);
    put_bytes(&mut k, term.as_bytes());
    k
}

/// A term's postings of one group.
pub fn postings_group(s: Scope, kind: TermKind, term: &str, group: u32) -> Vec<u8> {
    let mut k = postings(s, kind, term);
    put_u64(&mut k, u64::from(group));
    k
}

/// The entry holding `doc`'s posting of `rank`.
pub fn posting_block(s: Scope, kind: TermKind, term: &str, rank: u32, doc: u64) -> Vec<u8> {
    let mut k = postings_group(s, kind, term, rank / CLASSES);
    put_u64(&mut k, u64::from(CLASSES - 1 - rank % CLASSES));
    put_u64(&mut k, doc >> IMPACT_BITS);
    k
}

/// A term's documents in id order: then a block → a map of `in_block(doc)` → its posting's rank + 1.
pub fn directory(s: Scope, kind: TermKind, term: &str) -> Vec<u8> {
    let mut k = scoped(key::SEARCH_DIRECTORY, s);
    k.push(kind as u8);
    put_bytes(&mut k, term.as_bytes());
    k
}

pub fn directory_block(s: Scope, kind: TermKind, term: &str, block: u64) -> Vec<u8> {
    let mut k = directory(s, kind, term);
    put_u64(&mut k, block);
    k
}

/// Documents holding the term in any field (a counter).
pub fn term_docs(s: Scope, kind: TermKind, term: &str) -> Vec<u8> {
    let mut k = scoped(key::SEARCH_TERM_DOCS, s);
    k.push(kind as u8);
    put_bytes(&mut k, term.as_bytes());
    k
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

/// `slot_in` for postings entries.
pub fn slot(doc: u64, field: u32) -> u32 {
    slot_in(IMPACT_BITS, doc, field)
}

/// `unslot_in` for postings entries.
pub fn unslot(block: u64, slot: u32) -> (u64, u32) {
    unslot_in(IMPACT_BITS, block, slot)
}

/// A document's place in its directory block.
pub fn in_block(doc: u64) -> u32 {
    (doc & ((1 << BLOCK_BITS) - 1)) as u32
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

// ---- scoring ----

/// Score classes per term, a factor `CLASS_STEP` apart from `CLASS_FLOOR` up (class 0 holds everything below).
pub const CLASSES: u32 = 64;
const CLASS_STEP: f64 = 1.12;
const CLASS_FLOOR: f64 = 0.25;

/// A posting's value: its term frequency and its field's length code.
pub fn pack(tf: u64, code: u8) -> u32 {
    (tf.min((1 << 24) - 1) as u32) << 8 | u32::from(code)
}

pub fn unpack(v: u32) -> (u64, u8) {
    (u64::from(v >> 8), v as u8)
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

/// Groups of postings: those with a term in a prefix field (the short fields, where its idf runs highest), and
/// the rest. Each group's bounds scale by its own fields' idfs.
pub const GROUPS: u32 = 2;

/// A posting's rank: its group, and its class: its BM25 with each field at its weight, reference idf and
/// reference average length.
pub fn rank_of(s: Scope, fields: &[(u32, u64, u8)]) -> u32 {
    let defs = s.fields();
    let group = u32::from(!fields.iter().any(|f| defs[f.0 as usize].prefix));
    group * CLASSES + class_of(s, fields)
}

fn class_of(s: Scope, fields: &[(u32, u64, u8)]) -> u32 {
    let defs = s.fields();
    let c: f64 = fields
        .iter()
        .map(|&(f, tf, code)| {
            let d = &defs[f as usize];
            d.weight * d.idf * tf_norm(tf as f64, code_length(code), d.avg)
        })
        .sum();
    if c <= CLASS_FLOOR {
        return 0;
    }
    (((c / CLASS_FLOOR).ln() / CLASS_STEP.ln()) as u32).min(CLASSES - 1)
}

/// The most a posting of `class` scores, at the reference idfs and lengths (the top class unbounded).
pub fn class_bound(class: u32) -> f64 {
    if class == CLASSES - 1 {
        return f64::INFINITY;
    }
    CLASS_FLOOR * CLASS_STEP.powi(class as i32 + 1)
}

pub fn idf(df: f64, n: f64) -> f64 {
    (1.0 + (n - df + 0.5) / (df + 0.5)).ln()
}

pub fn tf_norm(tf: f64, len: f64, avg_len: f64) -> f64 {
    let rel = if avg_len > 0.0 { len / avg_len } else { 1.0 };
    tf * (K1 + 1.0) / (tf + K1 * (1.0 - B + B * rel))
}
