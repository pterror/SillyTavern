//! A term's best documents: those whose score at the list's own field weights and averages (the idfs and
//! averages when it was built) ranks above the list's floor, best first, at most `MAX` of them; every document
//! not in it ranks at or below the floor (higher scores first, then lower ids). A write follows a document into or out of the list when its score for the
//! term changes; a query refills a list that has fallen under `MIN`. Each entry keeps what scores it (its
//! fields' counts and length codes), so a query scores it at the real idfs and averages without reading the
//! document.

use super::{code_length, tf_norm};
use crate::keyspace::val::{get_u64, put_u64};
use crate::log::format::{get_uvarint, put_uvarint};

/// Entries a list keeps at most, and under which a query refills it: more than a page, so documents dropping
/// out are refilled for in batches.
pub const MAX: usize = 128;
pub const MIN: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub doc: u64,
    pub score: f64,
    /// (field, count, length code), by field.
    pub fields: Vec<(u32, u64, u8)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct List {
    /// The scope's top generation the list was built at.
    pub generation: u64,
    /// Every document not listed ranks at or below this (score, document).
    pub floor: f64,
    pub floor_doc: u64,
    /// Per field: the weight times idf, and the average length, scores are taken at.
    pub params: Vec<(f64, f64)>,
    /// Best first.
    pub entries: Vec<Entry>,
}

/// Whether (score, doc) `a` ranks above `b`: a higher score, or the same and a lower id.
pub fn above(a: (f64, u64), b: (f64, u64)) -> bool {
    a.0 > b.0 || (a.0 == b.0 && a.1 < b.1)
}

impl Default for List {
    fn default() -> Self {
        List {
            generation: 0,
            floor: 0.0,
            floor_doc: u64::MAX,
            params: Vec::new(),
            entries: Vec::new(),
        }
    }
}

impl List {
    /// Lowers what the floor admits to `(score, doc)` if that ranks above it.
    pub fn raise_floor(&mut self, score: f64, doc: u64) {
        if above((score, doc), (self.floor, self.floor_doc)) {
            (self.floor, self.floor_doc) = (score, doc);
        }
    }

    /// A document's score for the term: `fields` are (field, count, length code).
    pub fn score(&self, fields: &[(u32, u64, u8)]) -> f64 {
        fields
            .iter()
            .map(|&(f, tf, code)| {
                let (w, avg) = self.params.get(f as usize).copied().unwrap_or((0.0, 0.0));
                w * tf_norm(tf as f64, code_length(code), avg)
            })
            .sum()
    }

    /// Puts `doc` in or out of the list for its score `entry` (None: it no longer has the term). Returns whether
    /// the list changed.
    pub fn follow(&mut self, doc: u64, entry: Option<Entry>) -> bool {
        let was = self.entries.iter().position(|e| e.doc == doc);
        let removed = was.map(|i| self.entries.remove(i));
        let Some(e) = entry.filter(|e| above((e.score, e.doc), (self.floor, self.floor_doc)))
        else {
            return removed.is_some();
        };
        if removed.as_ref() == Some(&e) {
            self.entries.insert(was.unwrap(), e);
            return false;
        }
        let at = self
            .entries
            .partition_point(|x| x.score > e.score || (x.score == e.score && x.doc < e.doc));
        self.entries.insert(at, e);
        while self.entries.len() > MAX {
            let out = self.entries.pop().unwrap();
            self.raise_floor(out.score, out.doc);
        }
        true
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        put_uvarint(&mut out, self.generation);
        out.extend_from_slice(&self.floor.to_le_bytes());
        put_u64(&mut out, self.floor_doc);
        put_uvarint(&mut out, self.params.len() as u64);
        for (w, avg) in &self.params {
            out.extend_from_slice(&w.to_le_bytes());
            out.extend_from_slice(&avg.to_le_bytes());
        }
        put_uvarint(&mut out, self.entries.len() as u64);
        for e in &self.entries {
            put_u64(&mut out, e.doc);
            out.extend_from_slice(&e.score.to_le_bytes());
            put_uvarint(&mut out, e.fields.len() as u64);
            for &(f, tf, code) in &e.fields {
                out.push(f as u8);
                out.push(code);
                put_uvarint(&mut out, tf);
            }
        }
        out
    }

    pub fn decode(b: &[u8]) -> Option<List> {
        let mut at = 0;
        let generation = get_uvarint(b, &mut at).ok()?;
        let f64_at = |at: &mut usize| -> Option<f64> {
            let v = f64::from_le_bytes(b.get(*at..*at + 8)?.try_into().ok()?);
            *at += 8;
            Some(v)
        };
        let floor = f64_at(&mut at)?;
        let floor_doc = get_u64(b, &mut at)?;
        let k = get_uvarint(b, &mut at).ok()?;
        let mut params = Vec::with_capacity((k as usize).min(16));
        for _ in 0..k {
            params.push((f64_at(&mut at)?, f64_at(&mut at)?));
        }
        let n = get_uvarint(b, &mut at).ok()?;
        let mut entries = Vec::with_capacity((n as usize).min(MAX * 2));
        for _ in 0..n {
            let doc = get_u64(b, &mut at)?;
            let score = f64_at(&mut at)?;
            let k = get_uvarint(b, &mut at).ok()?;
            let mut fields = Vec::with_capacity((k as usize).min(16));
            for _ in 0..k {
                let f = u32::from(*b.get(at)?);
                let code = *b.get(at + 1)?;
                at += 2;
                fields.push((f, get_uvarint(b, &mut at).ok()?, code));
            }
            entries.push(Entry { doc, score, fields });
        }
        (at == b.len()).then_some(List {
            generation,
            floor,
            floor_doc,
            params,
            entries,
        })
    }
}
