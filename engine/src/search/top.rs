//! A term's best documents, for a term with more documents than a list holds: those whose score at the list's own
//! field weights and averages (`Head::params`, the idfs and averages when it was built) ranks above the list's
//! floor, best first; every document not listed ranks at or below the floor (higher scores first, then lower
//! ids). Each listed document is its own entry, keyed by its score and id, so a write that moves one document
//! writes that document's entry, and a page is a scan from the top.
//!
//! A list is built by a pass over the term's postings in id order (`query::refill`), in bounded slices run in
//! the commit queue; until it ends, the list holds the best documents of the blocks passed (`Head::passing`),
//! and writes follow only documents there. A write follows a document into or out of the list when its score
//! changes; past `MAX + SLACK` entries the lowest go and the floor rises to them. A list with fewer than `MIN`
//! entries, built at idfs and averages that have drifted too far, or older than its term's generation (a bulk
//! load changed the term), is built again.

use super::{code_length, tf_norm};
use crate::keyspace::val::{get_u64, put_u64};
use crate::log::format::{get_uvarint, put_uvarint};

/// A term with more documents than this keeps a list; a list keeps this many entries after a pass or a trim.
pub const MAX: usize = 128;
/// Entries past `MAX` a list takes from writes before they are trimmed.
pub const SLACK: usize = 32;
/// Under this many entries a list is built again.
pub const MIN: usize = 64;

/// (field, count, length code), by field.
pub type Fields = Vec<(u32, u64, u8)>;

#[derive(Debug, Clone, PartialEq)]
pub struct Head {
    /// The term's generation (`super::top_generation`) the list was built at.
    pub generation: u64,
    /// While the pass runs: the first block of ids it hasn't read.
    pub passing: Option<u64>,
    /// Every document not listed (in the blocks passed) ranks at or below this (score, document).
    pub floor: f64,
    pub floor_doc: u64,
    /// Per field: the weight times idf, and the average length, scores are taken at.
    pub params: Vec<(f64, f64)>,
}

/// Whether (score, doc) `a` ranks above `b`: a higher score, or the same and a lower id.
pub fn above(a: (f64, u64), b: (f64, u64)) -> bool {
    a.0 > b.0 || (a.0 == b.0 && a.1 < b.1)
}

impl Head {
    pub fn new(generation: u64, params: Vec<(f64, f64)>) -> Head {
        Head {
            generation,
            passing: Some(0),
            floor: 0.0,
            floor_doc: u64::MAX,
            params,
        }
    }

    /// Lowers what the floor admits to `(score, doc)` if that ranks above it.
    pub fn raise_floor(&mut self, score: f64, doc: u64) {
        if above((score, doc), (self.floor, self.floor_doc)) {
            (self.floor, self.floor_doc) = (score, doc);
        }
    }

    /// A document's score for the term at the list's parameters.
    pub fn score(&self, fields: &[(u32, u64, u8)]) -> f64 {
        score_at(&self.params, fields)
    }

    /// Whether a document with this score is listed: the pass has read its block and it ranks above the floor.
    pub fn holds(&self, score: f64, doc: u64, block: u64) -> bool {
        self.passing.is_none_or(|b| block < b) && above((score, doc), (self.floor, self.floor_doc))
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        put_uvarint(&mut out, self.generation);
        put_uvarint(&mut out, self.passing.map_or(0, |b| b + 1));
        out.extend_from_slice(&self.floor.to_le_bytes());
        put_u64(&mut out, self.floor_doc);
        put_uvarint(&mut out, self.params.len() as u64);
        for (w, avg) in &self.params {
            out.extend_from_slice(&w.to_le_bytes());
            out.extend_from_slice(&avg.to_le_bytes());
        }
        out
    }

    pub fn decode(b: &[u8]) -> Option<Head> {
        let mut at = 0;
        let generation = get_uvarint(b, &mut at).ok()?;
        let passing = get_uvarint(b, &mut at).ok()?.checked_sub(1);
        let floor = f64_at(b, &mut at)?;
        let floor_doc = get_u64(b, &mut at)?;
        let k = get_uvarint(b, &mut at).ok()?;
        let mut params = Vec::with_capacity((k as usize).min(16));
        for _ in 0..k {
            params.push((f64_at(b, &mut at)?, f64_at(b, &mut at)?));
        }
        (at == b.len()).then_some(Head {
            generation,
            passing,
            floor,
            floor_doc,
            params,
        })
    }
}

fn f64_at(b: &[u8], at: &mut usize) -> Option<f64> {
    let v = f64::from_le_bytes(b.get(*at..*at + 8)?.try_into().ok()?);
    *at += 8;
    Some(v)
}

pub fn score_at(params: &[(f64, f64)], fields: &[(u32, u64, u8)]) -> f64 {
    fields
        .iter()
        .map(|&(f, tf, code)| {
            let (w, avg) = params.get(f as usize).copied().unwrap_or((0.0, 0.0));
            w * tf_norm(tf as f64, code_length(code), avg)
        })
        .sum()
}

/// A score as an entry key's component, best first: scores are never negative, so their bits sort as they do.
pub fn put_rank(out: &mut Vec<u8>, score: f64) {
    out.extend_from_slice(&(u64::MAX - score.max(0.0).to_bits()).to_be_bytes());
}

/// An entry key's score and document, after the list's prefix.
pub fn parse_rank(k: &[u8]) -> Option<(f64, u64)> {
    let r = u64::from_be_bytes(k.get(..8)?.try_into().ok()?);
    let mut at = 8;
    let doc = get_u64(k, &mut at)?;
    (at == k.len()).then_some((f64::from_bits(u64::MAX - r), doc))
}

pub fn encode_fields(fields: &[(u32, u64, u8)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(fields.len() * 3);
    for &(f, tf, code) in fields {
        out.push(f as u8);
        out.push(code);
        put_uvarint(&mut out, tf);
    }
    out
}

pub fn decode_fields(b: &[u8]) -> Option<Fields> {
    let mut at = 0;
    let mut out = Vec::new();
    while at < b.len() {
        let f = u32::from(*b.get(at)?);
        let code = *b.get(at + 1)?;
        at += 2;
        out.push((f, get_uvarint(b, &mut at).ok()?, code));
    }
    Some(out)
}
