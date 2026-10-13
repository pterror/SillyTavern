//! P3, search (design `.plans/2026-10-03-storage-from-needs.md` 7). Every entry is in the derived keyspace,
//! written at commit from a field's text before and after a change (`index`), read by `query`.
//!
//! A term's postings are in id order, compressed per block of ids: each document's fields with the term's count
//! there. A string is one term both as a whole token and as a prefix term (a token's first 2–20 characters in the
//! prefix fields): a prefix field's slot holds both counts, so the query's last word reads the same list. Per
//! block the most a document there scores for the term, whole and as a prefix (its block maxima), bounds the
//! block's scores (block-max WAND); per block and field the shortest length bounds each document's. No positions:
//! a phrase is checked on the candidates' text.
//!
//! A scope is one searchable set of documents: the library (documents are characters and groups), the tag names
//! (documents are tags), one owner's chat messages (documents are messages), the session names (documents are
//! sessions), one world-info book's entries (documents are entries).

#[cfg(any(test, feature = "measure"))]
pub mod brute;
pub mod index;
pub mod pairs;
pub mod query;
#[cfg(test)]
mod tests;
pub mod text;

use crate::keyspace::val::{put_bytes, put_u64};
use crate::log::format::{MAX_ID, get_uvarint, put_uvarint};
use crate::store::kinds::key;

/// BM25's constants, as tantivy's.
pub const K1: f64 = 1.2;
pub const B: f64 = 0.75;

/// A term's postings are one entry (a compressed `Val::Map`) per block of `1 << BLOCK_BITS` consecutive ids;
/// score bounds are per block too.
pub const BLOCK_BITS: u32 = 10;
/// A document's lengths in every field are kept per block of `1 << LENGTH_BITS` ids.
pub const LENGTH_BITS: u32 = 4;
/// A field's shortest lengths per block are one entry per `1 << CHUNK_BITS` blocks.
pub const CHUNK_BITS: u32 = 16;

pub const LIBRARY: u64 = 1;
pub const TAGS: u64 = 2;
pub const CHAT: u64 = 3;
pub const SESSIONS: u64 = 4;
pub const BOOK: u64 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Scope {
    pub kind: u64,
    /// The chat's owner for `CHAT`, the book for `BOOK`; 0 otherwise.
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

    pub const SESSIONS: Scope = Scope {
        kind: SESSIONS,
        owner: 0,
    };

    pub fn chat(owner: u64) -> Scope {
        Scope { kind: CHAT, owner }
    }

    pub fn book(book: u64) -> Scope {
        Scope {
            kind: BOOK,
            owner: book,
        }
    }

    pub fn fields(&self) -> &'static [FieldDef] {
        match self.kind {
            LIBRARY => LIBRARY_FIELDS,
            TAGS => TAG_FIELDS,
            SESSIONS => SESSION_FIELDS,
            BOOK => BOOK_FIELDS,
            _ => CHAT_FIELDS,
        }
    }
}

pub struct FieldDef {
    pub name: &'static str,
    pub weight: f64,
    /// The query's last word matches as a prefix here.
    pub prefix: bool,
    /// The field's reference length in tokens: a field this long weighs its counts as BM25 weighs a field of
    /// average length.
    pub ref_len: f64,
}

const fn field(name: &'static str, weight: f64, prefix: bool, ref_len: f64) -> FieldDef {
    FieldDef {
        name,
        weight,
        prefix,
        ref_len,
    }
}

// Reference lengths, in tokens. These values are meant to be tuned.
//
// Measured: the average token count of each field in `examples/search.rs`'s `synth` cards (their character
// lengths are from live card samples, over a 30,000-word Zipf vocabulary).
pub const REF_NAME: f64 = 2.32;
pub const REF_DESCRIPTION: f64 = 353.09;
pub const REF_MES_EXAMPLE: f64 = 176.75;
pub const REF_SCENARIO: f64 = 68.34;
pub const REF_PERSONALITY: f64 = 47.98;
pub const REF_FIRST_MES: f64 = 190.37;
pub const REF_CREATOR_NOTES: f64 = 95.44;
pub const REF_CREATOR: f64 = 1.92;
/// A card's own tags list.
pub const REF_CARD_TAGS: f64 = 20.83;
/// Every alternate greeting together.
pub const REF_ALTERNATE_GREETINGS: f64 = 298.26;
/// One tag's name.
pub const REF_TAG_NAME: f64 = 2.54;
// Placeholders: nothing synthetic gives these fields a length like real data's. The one-off conversion of the
// user's data measures them and replaces these.
pub const REF_MEMBERS: f64 = 4.0;
pub const REF_ID: f64 = 1.0;
pub const REF_CHAT_TEXT: f64 = 150.0;
pub const REF_SESSION_NAME: f64 = 6.0;
pub const REF_BOOK_KEY: f64 = 3.0;
pub const REF_BOOK_GROUP: f64 = 2.0;
pub const REF_BOOK_COMMENT: f64 = 6.0;
pub const REF_BOOK_KEYSECONDARY: f64 = 3.0;
pub const REF_BOOK_CONTENT: f64 = 150.0;
pub const REF_BOOK_UID: f64 = 1.0;
pub const REF_BOOK_AUTOMATION_ID: f64 = 1.0;

/// Weights: upstream's Fuse keys for `fuzzySearchCharacters` (name 20, description and example 3, scenario,
/// personality, first message and notes 2, creator, card tags and alternate greetings 1), which the old index used
/// as BM25 field boosts too; with them a match in the name outranks body matches. Prefix on name, creator and
/// tags (design 7.1, Q-F1). Groups are documents of the same scope: their name is the name field, and upstream's
/// `fuzzySearchGroups` keys `members` (the members' avatar keys) 15 and `id` 1 are their own fields. The names of the
/// tags an entity carries (upstream's `#tags`, 10) are not indexed per entity: they are read through tag
/// membership (`tagged`) and score at `TAG_WEIGHT`.
pub static LIBRARY_FIELDS: &[FieldDef] = &[
    field("name", 20.0, true, REF_NAME),
    field("description", 3.0, false, REF_DESCRIPTION),
    field("mes_example", 3.0, false, REF_MES_EXAMPLE),
    field("scenario", 2.0, false, REF_SCENARIO),
    field("personality", 2.0, false, REF_PERSONALITY),
    field("first_mes", 2.0, false, REF_FIRST_MES),
    field("creator_notes", 2.0, false, REF_CREATOR_NOTES),
    field("creator", 1.0, true, REF_CREATOR),
    field("tags", 1.0, true, REF_CARD_TAGS),
    field("alternate_greetings", 1.0, false, REF_ALTERNATE_GREETINGS),
    field("members", 15.0, false, REF_MEMBERS),
    field("id", 1.0, false, REF_ID),
];

/// The weight of the names of the tags a library document carries (upstream's `#tags` key). A clause over every
/// field matches the carriers of the tags whose names it matches (the query's last word as a prefix); a carrier
/// adds `TAG_WEIGHT` once to the clause's text, before the idf (`local`, `clause_score`).
pub const TAG_WEIGHT: f64 = 10.0;

/// The field a library match by tag names is at: past the scope's own fields.
pub const TAG_FIELD: u32 = 12;

/// The tag names' field in `scope`, if it has one.
pub fn tag_field(scope: Scope) -> Option<u32> {
    (scope == Scope::LIBRARY).then_some(TAG_FIELD)
}

pub static TAG_FIELDS: &[FieldDef] = &[field("name", 1.0, true, REF_TAG_NAME)];

pub static CHAT_FIELDS: &[FieldDef] = &[field("text", 1.0, false, REF_CHAT_TEXT)];

pub static SESSION_FIELDS: &[FieldDef] = &[field("name", 1.0, true, REF_SESSION_NAME)];

/// Upstream's `fuzzySearchWorldInfo` keys and weights; `uid` and `automationId` match whole tokens only.
pub static BOOK_FIELDS: &[FieldDef] = &[
    field("key", 20.0, true, REF_BOOK_KEY),
    field("group", 15.0, false, REF_BOOK_GROUP),
    field("comment", 10.0, true, REF_BOOK_COMMENT),
    field("keysecondary", 10.0, false, REF_BOOK_KEYSECONDARY),
    field("content", 3.0, false, REF_BOOK_CONTENT),
    field("uid", 1.0, false, REF_BOOK_UID),
    field("automationId", 1.0, false, REF_BOOK_AUTOMATION_ID),
];

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

/// The term and block of `posting_block(s, ..)`'s key `k`.
pub fn parse_posting_block(s: Scope, k: &[u8]) -> Option<(String, u64)> {
    let mut at = scoped(key::SEARCH_POSTING, s).len();
    let term = String::from_utf8(crate::keyspace::val::get_bytes(k, &mut at)?).ok()?;
    let block = crate::keyspace::val::get_u64(k, &mut at)?;
    (at == k.len()).then_some((term, block))
}

/// A term's block maxima at level `level`, then a group of nodes → a maxima map (`Val::MaxMap`) of `max_slot`'s
/// slot → `max_bits` of the most a document under the node scores for the term in that reading (`local_text`),
/// and of `field_max_slot`'s → the most it scores in that one field (`field_texts`), for the fields some
/// document under the node holds it in. A level-0 node is a block; a level-ℓ node is `1 << GROUP_BITS` level-(ℓ−1) nodes (`node_of`). Only raised, so
/// it may be above that.
///
/// A document writes levels 0 to its block's `top_level` only, so a level-ℓ ≥ 1 map of group 0 never has node 0:
/// the blocks under it are held by the group-0 maps below it.
pub fn block_maxima(s: Scope, term: &str, level: u64, group: u64) -> Vec<u8> {
    let mut k = block_maxima_at(s, term, level);
    put_u64(&mut k, group);
    k
}

/// The prefix of a term's block maxima at level `level`.
pub fn block_maxima_at(s: Scope, term: &str, level: u64) -> Vec<u8> {
    let mut k = termed(key::SEARCH_BLOCK_MAX, s, term);
    put_u64(&mut k, level);
    k
}

/// Nodes per group of a maxima map, and per node of the level above.
pub const GROUP_BITS: u32 = 10;

/// Slots per node in a maxima map: a node's slots are `node << NODE_SLOT_BITS | sub`, sub 0 and 1 its maxima over
/// every field (exact, prefix), and `(field + 1) << 1 | reading` its maxima in one field, for every field count
/// `FIELD_BITS` allows.
pub const NODE_SLOT_BITS: u32 = FIELD_BITS + 2;

/// A node's group and its slot there for a reading (`as_prefix`: the prefix reading) over every field, at the
/// node's level: at level 0 the node is the block.
pub fn max_slot(node: u64, as_prefix: bool) -> (u64, u32) {
    node_slot(node, u32::from(as_prefix))
}

/// `max_slot` for a reading in field `field` alone.
pub fn field_max_slot(node: u64, field: u32, as_prefix: bool) -> (u64, u32) {
    debug_assert!(field < 1 << FIELD_BITS);
    node_slot(node, (field + 1) << 1 | u32::from(as_prefix))
}

fn node_slot(node: u64, sub: u32) -> (u64, u32) {
    (
        node >> GROUP_BITS,
        ((node & ((1 << GROUP_BITS) - 1)) as u32) << NODE_SLOT_BITS | sub,
    )
}

/// The level-`level` node over block `block`.
pub const fn node_of(block: u64, level: u64) -> u64 {
    match block.checked_shr(GROUP_BITS * level as u32) {
        Some(n) => n,
        None => 0,
    }
}

/// The highest level a document in block `block` writes its maxima at: the least ℓ whose node over the block is
/// in group 0 at level ℓ.
pub const fn top_level(block: u64) -> u64 {
    let mut l = 0;
    while node_of(block, l) >> GROUP_BITS != 0 {
        l += 1;
    }
    l
}

/// Levels of maxima any id's block has.
pub const LEVELS: usize = top_level(MAX_ID >> BLOCK_BITS) as usize + 1;

/// The node of a slot in group `group`, at the group's level; its field (None: every field); and whether it is
/// the prefix reading's.
pub fn unmax_slot(group: u64, slot: u32) -> (u64, Option<u32>, bool) {
    let sub = slot & ((1 << NODE_SLOT_BITS) - 1);
    (
        group << GROUP_BITS | u64::from(slot >> NODE_SLOT_BITS),
        (sub >> 1).checked_sub(1),
        sub & 1 == 1,
    )
}

/// The readings a term has a maximum for: whole, and as a prefix when a query reads it as one: of `GRAM_MIN` to
/// `GRAM_MAX` characters (a longer prefix is read through its first `GRAM_MAX`).
pub fn readings(term: &str) -> &'static [bool] {
    if (text::GRAM_MIN..=text::GRAM_MAX).contains(&text::char_len(term)) {
        &[false, true]
    } else {
        &[false]
    }
}

/// A maximum as stored: the bits of the least `f32` strictly greater than `v` (positive `f32` bits sort as their
/// values).
pub fn max_bits(v: f64) -> u32 {
    let f = v as f32;
    if f64::from(f) > v {
        f.to_bits()
    } else {
        f.to_bits() + 1
    }
}

/// The value of a stored maximum.
pub fn max_value(bits: u32) -> f64 {
    f64::from(f32::from_bits(bits))
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

/// A term's document count, an added map (`Val::AddMap`) whose one slot, `DOCS_SLOT`, counts the documents
/// holding the term in any field, as a whole token or a prefix term.
pub fn term_counts(s: Scope, term: &str) -> crate::store::derive::AddMapKey {
    key::SEARCH_TERM_COUNTS.key(|k| {
        put_u64(k, s.kind);
        put_u64(k, s.owner);
        put_bytes(k, term.as_bytes());
    })
}

/// `term_counts`'s key, for reading it.
pub fn term_counts_of(s: Scope, term: &str) -> Vec<u8> {
    let mut k = key::SEARCH_TERM_COUNTS.prefix();
    put_u64(&mut k, s.kind);
    put_u64(&mut k, s.owner);
    put_bytes(&mut k, term.as_bytes());
    k
}

/// The slot in `term_counts` of the documents holding the term.
pub const DOCS_SLOT: u32 = 2 << FIELD_BITS;

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

pub fn tf_norm(tf: f64, len: f64, ref_len: f64) -> f64 {
    let rel = if ref_len > 0.0 { len / ref_len } else { 1.0 };
    tf * (K1 + 1.0) / (tf + K1 * (1.0 - B + B * rel))
}

/// Field `field`'s part of a document's score for a term matched `tf` times there, in a field of `len` tokens
/// (as its length code stands for), before the idf.
pub fn field_score(scope: Scope, field: u32, tf: f64, len: f64) -> f64 {
    let d = &scope.fields()[field as usize];
    d.weight * tf_norm(tf, len, d.ref_len)
}

/// A document's score for one term in one reading (whole token, or prefix), before the term's idf: its
/// `field_score`s, `fields` giving (field, tf, length) for each field it is in, plus `TAG_WEIGHT` when `tagged`
/// (it carries a tag whose name holds the term). Depending on the document alone, it orders a word's documents.
pub fn local(scope: Scope, fields: impl IntoIterator<Item = (u32, u64, f64)>, tagged: bool) -> f64 {
    with_tag(word_text(scope, fields, false), tagged)
}

/// A token's text score before the idf, `fields` giving (field, tf, length) in field order. A long prefix (a
/// word's prefix longer than `GRAM_MAX`, `long_prefix`) is read by two lists, its first `GRAM_MAX` characters in
/// the prefix fields and the whole token in the others, and sums each list's fields apart before adding them: the
/// shape of its bound, the sum of the two lists' block maxima.
pub fn word_text(
    scope: Scope,
    fields: impl IntoIterator<Item = (u32, u64, f64)>,
    long_prefix: bool,
) -> f64 {
    sum_parts(
        scope,
        fields
            .into_iter()
            .map(|(f, tf, len)| (f, field_score(scope, f, tf as f64, len))),
        long_prefix,
    )
}

/// The sum of a token's parts (field, `field_score` or a bound on it) in field order, a long prefix's grouped as
/// `word_text` groups them.
pub fn sum_parts(
    scope: Scope,
    parts: impl IntoIterator<Item = (u32, f64)>,
    long_prefix: bool,
) -> f64 {
    let defs = scope.fields();
    let (mut prefixed, mut rest) = (0.0, 0.0);
    for (f, x) in parts {
        if long_prefix && defs.get(f as usize).is_some_and(|d| d.prefix) {
            prefixed += x;
        } else {
            rest += x;
        }
    }
    if long_prefix { prefixed + rest } else { rest }
}

/// Whether a clause's token is a long prefix (`word_text`): the prefix of a word, not of a phrase, longer than
/// `GRAM_MAX` characters.
pub fn long_prefix(phrase: bool, as_prefix: bool, token: &str) -> bool {
    !phrase && as_prefix && text::char_len(token) > text::GRAM_MAX
}

/// `local` without the tag for a document's term in one reading (`as_prefix`), from its fields holding the term
/// (`hits`, in field order) and its fields' lengths in tokens (`lens`, by field): what its block's maximum covers.
pub fn local_text(scope: Scope, hits: &[(u32, FieldHit)], lens: &[u64], as_prefix: bool) -> f64 {
    local_r(scope, hits, lens, as_prefix, false)
}

/// `local_text`, with `TAG_WEIGHT` when `tagged`.
pub fn local_r(
    scope: Scope,
    hits: &[(u32, FieldHit)],
    lens: &[u64],
    as_prefix: bool,
    tagged: bool,
) -> f64 {
    debug_assert!(hits.windows(2).all(|w| w[0].0 < w[1].0));
    local(
        scope,
        hits.iter()
            .filter(|(_, h)| h.tf(as_prefix) > 0)
            .map(|&(f, h)| {
                (
                    f,
                    h.tf(as_prefix),
                    code_length(length_code(lens[f as usize])),
                )
            }),
        tagged,
    )
}

/// `local_text`'s part in each field holding the term in that reading: what its block's maxima in one field cover.
pub fn field_texts(
    scope: Scope,
    hits: &[(u32, FieldHit)],
    lens: &[u64],
    as_prefix: bool,
) -> impl Iterator<Item = (u32, f64)> {
    hits.iter()
        .filter(move |(_, h)| h.tf(as_prefix) > 0)
        .map(move |&(f, h)| {
            let len = code_length(length_code(lens[f as usize]));
            (f, field_score(scope, f, h.tf(as_prefix) as f64, len))
        })
}

fn with_tag(text: f64, tagged: bool) -> f64 {
    if tagged { text + TAG_WEIGHT } else { text }
}

/// A clause's score from its tokens' idfs and their `local` scores without the tag (`texts`, in token order),
/// `tagged` when the document carries a tag whose name holds the clause. A word scores its idf times its `local`;
/// a phrase each token's idf times its text, and its tag part at its rarest token's idf.
pub fn clause_score(idfs: &[f64], texts: &[f64], tagged: bool) -> f64 {
    if let ([idf], [text]) = (idfs, texts) {
        return idf * with_tag(*text, tagged);
    }
    let mut s = 0.0;
    for (idf, text) in idfs.iter().zip(texts) {
        s += idf * text;
    }
    if tagged {
        s += idfs.iter().copied().fold(0.0, f64::max) * TAG_WEIGHT;
    }
    s
}
