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

pub const K1: f64 = 1.2;
pub const B: f64 = 0.75;

pub const BLOCK_BITS: u32 = 10;
pub const LENGTH_BITS: u32 = 4;
pub const CHUNK_BITS: u32 = 16;

pub const LIBRARY: u64 = 1;
pub const TAGS: u64 = 2;
pub const CHAT: u64 = 3;
pub const SESSIONS: u64 = 4;
pub const BOOK: u64 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Scope {
    pub kind: u64,
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
    pub prefix: bool,
    pub ref_len: f64,
    pub pairs: bool,
}

const fn field(name: &'static str, weight: f64, prefix: bool, ref_len: f64) -> FieldDef {
    FieldDef {
        name,
        weight,
        prefix,
        ref_len,
        pairs: false,
    }
}

const fn short(name: &'static str, weight: f64, prefix: bool, ref_len: f64) -> FieldDef {
    FieldDef {
        name,
        weight,
        prefix,
        ref_len,
        pairs: true,
    }
}

pub fn pair_fields(scope: Scope) -> u64 {
    scope
        .fields()
        .iter()
        .enumerate()
        .filter(|(_, d)| d.pairs)
        .fold(0, |m, (i, _)| m | 1 << i)
}

pub const REF_NAME: f64 = 1.70;
pub const REF_DESCRIPTION: f64 = 626.97;
pub const REF_MES_EXAMPLE: f64 = 261.99;
pub const REF_SCENARIO: f64 = 99.20;
pub const REF_PERSONALITY: f64 = 62.90;
pub const REF_FIRST_MES: f64 = 220.71;
pub const REF_CREATOR_NOTES: f64 = 154.96;
pub const REF_CREATOR: f64 = 1.40;
pub const REF_CARD_TAGS: f64 = 15.25;
pub const REF_ALTERNATE_GREETINGS: f64 = 1041.44;
pub const REF_TAG_NAME: f64 = 2.09;
pub const REF_MEMBERS: f64 = 6.60;
pub const REF_ID: f64 = 1.00;
pub const REF_CHAT_TEXT: f64 = 127.20;
pub const REF_SESSION_NAME: f64 = 6.0;
pub const REF_BOOK_KEY: f64 = 4.91;
pub const REF_BOOK_GROUP: f64 = 1.26;
pub const REF_BOOK_COMMENT: f64 = 2.35;
pub const REF_BOOK_KEYSECONDARY: f64 = 5.38;
pub const REF_BOOK_CONTENT: f64 = 121.82;
pub const REF_BOOK_UID: f64 = 1.00;
pub const REF_BOOK_AUTOMATION_ID: f64 = 25.73;

pub static LIBRARY_FIELDS: &[FieldDef] = &[
    short("name", 20.0, true, REF_NAME),
    field("description", 3.0, false, REF_DESCRIPTION),
    field("mes_example", 3.0, false, REF_MES_EXAMPLE),
    field("scenario", 2.0, false, REF_SCENARIO),
    field("personality", 2.0, false, REF_PERSONALITY),
    field("first_mes", 2.0, false, REF_FIRST_MES),
    field("creator_notes", 2.0, false, REF_CREATOR_NOTES),
    short("creator", 1.0, true, REF_CREATOR),
    short("tags", 1.0, true, REF_CARD_TAGS),
    field("alternate_greetings", 1.0, false, REF_ALTERNATE_GREETINGS),
    field("members", 15.0, false, REF_MEMBERS),
    field("id", 1.0, false, REF_ID),
];

pub const TAG_WEIGHT: f64 = 10.0;

pub const TAG_FIELD: u32 = 12;

pub fn tag_field(scope: Scope) -> Option<u32> {
    (scope == Scope::LIBRARY).then_some(TAG_FIELD)
}

pub static TAG_FIELDS: &[FieldDef] = &[short("name", 1.0, true, REF_TAG_NAME)];

pub static CHAT_FIELDS: &[FieldDef] = &[field("text", 1.0, false, REF_CHAT_TEXT)];

pub static SESSION_FIELDS: &[FieldDef] = &[short("name", 1.0, true, REF_SESSION_NAME)];

pub static BOOK_FIELDS: &[FieldDef] = &[
    short("key", 20.0, true, REF_BOOK_KEY),
    short("group", 15.0, false, REF_BOOK_GROUP),
    short("comment", 10.0, true, REF_BOOK_COMMENT),
    short("keysecondary", 10.0, false, REF_BOOK_KEYSECONDARY),
    field("content", 3.0, false, REF_BOOK_CONTENT),
    field("uid", 1.0, false, REF_BOOK_UID),
    field("automationId", 1.0, false, REF_BOOK_AUTOMATION_ID),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum TermKind {
    Exact = 0,
    Gram = 1,
}

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

pub fn postings(s: Scope, term: &str) -> Vec<u8> {
    termed(key::SEARCH_POSTING, s, term)
}

pub fn posting_block(s: Scope, term: &str, block: u64) -> Vec<u8> {
    let mut k = postings(s, term);
    put_u64(&mut k, block);
    k
}

pub fn parse_posting_block(s: Scope, k: &[u8]) -> Option<(String, u64)> {
    let mut at = scoped(key::SEARCH_POSTING, s).len();
    let term = String::from_utf8(crate::keyspace::val::get_bytes(k, &mut at)?).ok()?;
    let block = crate::keyspace::val::get_u64(k, &mut at)?;
    (at == k.len()).then_some((term, block))
}

pub fn block_maxima(s: Scope, term: &str, level: u64, group: u64) -> Vec<u8> {
    let mut k = block_maxima_at(s, term, level);
    put_u64(&mut k, group);
    k
}

pub fn block_maxima_at(s: Scope, term: &str, level: u64) -> Vec<u8> {
    let mut k = block_maxima_of(s, term);
    put_u64(&mut k, level);
    k
}

pub fn block_maxima_of(s: Scope, term: &str) -> Vec<u8> {
    termed(key::SEARCH_BLOCK_MAX, s, term)
}

pub const GROUP_BITS: u32 = 10;

pub const NODE_SLOT_BITS: u32 = FIELD_BITS + 2;

pub fn max_slot(node: u64, as_prefix: bool) -> (u64, u32) {
    node_slot(node, u32::from(as_prefix))
}

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

pub const fn node_of(block: u64, level: u64) -> u64 {
    match block.checked_shr(GROUP_BITS * level as u32) {
        Some(n) => n,
        None => 0,
    }
}

pub const fn top_level(block: u64) -> u64 {
    let mut l = 0;
    while node_of(block, l) >> GROUP_BITS != 0 {
        l += 1;
    }
    l
}

pub const LEVELS: usize = top_level(MAX_ID >> BLOCK_BITS) as usize + 1;

pub fn unmax_slot(group: u64, slot: u32) -> (u64, Option<u32>, bool) {
    let sub = slot & ((1 << NODE_SLOT_BITS) - 1);
    (
        group << GROUP_BITS | u64::from(slot >> NODE_SLOT_BITS),
        (sub >> 1).checked_sub(1),
        sub & 1 == 1,
    )
}

pub fn readings(term: &str) -> &'static [bool] {
    if !pairs::is_pair(term) && (text::GRAM_MIN..=text::GRAM_MAX).contains(&text::char_len(term)) {
        &[false, true]
    } else {
        &[false]
    }
}

pub fn max_bits(v: f64) -> u32 {
    let f = v as f32;
    if f64::from(f) > v {
        f.to_bits()
    } else {
        f.to_bits() + 1
    }
}

pub fn max_value(bits: u32) -> f64 {
    f64::from(f32::from_bits(bits))
}

pub fn shortest(s: Scope, field: u32, chunk: u64) -> Vec<u8> {
    let mut k = scoped(key::SEARCH_SHORTEST, s);
    put_u64(&mut k, u64::from(field));
    put_u64(&mut k, chunk);
    k
}

pub const SHORTEST_BASE: u64 = u32::MAX as u64;

pub fn bound_slot(block: u64, field: u32) -> (u64, u32) {
    (
        block >> CHUNK_BITS,
        ((block & ((1 << CHUNK_BITS) - 1)) as u32) << FIELD_BITS | field,
    )
}

pub fn term_counts(s: Scope, term: &str) -> crate::store::derive::AddMapKey {
    key::SEARCH_TERM_COUNTS.key(|k| {
        put_u64(k, s.kind);
        put_u64(k, s.owner);
        put_bytes(k, term.as_bytes());
    })
}

pub fn term_counts_of(s: Scope, term: &str) -> Vec<u8> {
    let mut k = key::SEARCH_TERM_COUNTS.prefix();
    put_u64(&mut k, s.kind);
    put_u64(&mut k, s.owner);
    put_bytes(&mut k, term.as_bytes());
    k
}

pub const DOCS_SLOT: u32 = 2 << FIELD_BITS;

pub fn lengths(s: Scope) -> Vec<u8> {
    scoped(key::SEARCH_LENGTH, s)
}

pub fn length_block(s: Scope, block: u64) -> Vec<u8> {
    let mut k = lengths(s);
    put_u64(&mut k, block);
    k
}

pub const FIELD_BITS: u32 = 4;

pub fn slot_in(bits: u32, doc: u64, field: u32) -> u32 {
    debug_assert!(field < 1 << FIELD_BITS);
    ((doc & ((1 << bits) - 1)) as u32) << FIELD_BITS | field
}

pub fn unslot_in(bits: u32, block: u64, slot: u32) -> (u64, u32) {
    (
        block << bits | u64::from(slot >> FIELD_BITS),
        slot & ((1 << FIELD_BITS) - 1),
    )
}

pub fn slot(doc: u64, field: u32) -> u32 {
    slot_in(BLOCK_BITS, doc, field)
}

pub fn unslot(block: u64, slot: u32) -> (u64, u32) {
    unslot_in(BLOCK_BITS, block, slot)
}

pub fn doc_count(s: Scope) -> Vec<u8> {
    scoped(key::SEARCH_DOCS, s)
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FieldHit {
    pub exact: u64,
    pub gram: u64,
}

impl FieldHit {
    pub fn tf(&self, as_prefix: bool) -> u64 {
        if as_prefix { self.gram } else { self.exact }
    }

    pub fn most(&self) -> u64 {
        self.exact.max(self.gram)
    }
}

const PREFIX_TF_MAX: u64 = (1 << 16) - 1;

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

pub fn code_length(code: u8) -> f64 {
    f64::from(length_edges()[code as usize])
}

pub fn idf(df: f64, n: f64) -> f64 {
    (1.0 + (n - df + 0.5) / (df + 0.5)).ln()
}

pub fn tf_norm(tf: f64, len: f64, ref_len: f64) -> f64 {
    let rel = if ref_len > 0.0 { len / ref_len } else { 1.0 };
    tf * (K1 + 1.0) / (tf + K1 * (1.0 - B + B * rel))
}

pub fn field_score(scope: Scope, field: u32, tf: f64, len: f64) -> f64 {
    let d = &scope.fields()[field as usize];
    d.weight * tf_norm(tf, len, d.ref_len)
}

pub fn local(scope: Scope, fields: impl IntoIterator<Item = (u32, u64, f64)>, tagged: bool) -> f64 {
    with_tag(word_text(scope, fields, false), tagged)
}

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

pub fn long_prefix(phrase: bool, as_prefix: bool, token: &str) -> bool {
    !phrase && as_prefix && text::char_len(token) > text::GRAM_MAX
}

pub fn local_text(scope: Scope, hits: &[(u32, FieldHit)], lens: &[u64], as_prefix: bool) -> f64 {
    local_r(scope, hits, lens, as_prefix, false)
}

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
