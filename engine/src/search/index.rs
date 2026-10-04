//! Writing the index: a field's entries follow from its text before and after a change. A term's posting holds
//! every field of the document, so rewriting it reads the document's posting (through the term's directory) for
//! the terms whose counts changed, or for all of the field's terms when its length code changed. A document
//! not yet published has nothing to read but this commit's own entries.

use std::collections::HashMap;

use super::text::{grams, tokens};
use super::{
    BLOCK_BITS, FIELD_BITS, FieldHit, IMPACT_BITS, LENGTH_BITS, Scope, TermKind, directory_block,
    doc_count, doc_freq, field_tokens, in_block, length_block, length_code, max_doc, pack,
    posting_block, rank_of, slot, slot_in, term_docs, unpack, unslot,
};
use crate::keyspace::val::map_pairs;
use crate::store::StoreError;
use crate::store::derive::{Out, View};

/// A term's count in a field as a whole token and as a prefix term.
type Counts = (u64, u64);

/// A field's terms with their counts (as whole tokens, and as prefix terms), and its length in tokens.
#[derive(Default)]
struct Terms {
    tf: HashMap<String, Counts>,
    len: u64,
}

impl Terms {
    /// `items` are the field's values (one, or each item of a list). In a prefix field a token also counts
    /// toward each of its prefix terms; elsewhere a term's prefix count is its whole-token count.
    fn of(items: &[&[u8]], prefix: bool) -> Terms {
        let mut t = Terms::default();
        for item in items {
            for tok in tokens(item) {
                t.len += 1;
                if prefix {
                    for g in grams(&tok) {
                        t.tf.entry(g.to_string()).or_default().1 += 1;
                    }
                    t.tf.entry(tok).or_default().0 += 1;
                } else {
                    let e = t.tf.entry(tok).or_default();
                    e.0 += 1;
                    e.1 += 1;
                }
            }
        }
        t
    }
}

fn pairs(b: Option<Vec<u8>>) -> Result<Vec<(u32, u32)>, StoreError> {
    match b {
        Some(b) => {
            map_pairs(&b).ok_or_else(|| StoreError::Entry("a search block doesn't decode".into()))
        }
        None => Ok(Vec::new()),
    }
}

/// The entries for field `field` of document `doc` changing from `old` to `new` (its values; empty when it
/// has none).
pub fn update(
    view: &View,
    out: &mut Out,
    scope: Scope,
    doc: u64,
    field: u32,
    old: &[&[u8]],
    new: &[&[u8]],
) -> Result<(), StoreError> {
    let defs = scope.fields();
    let prefix = defs[field as usize].prefix;
    let (before, after) = (Terms::of(old, prefix), Terms::of(new, prefix));
    let (lo, ln) = (before.len, after.len);
    let (code_old, code_new) = (length_code(lo), length_code(ln));
    let block = doc >> BLOCK_BITS;
    let lblock = doc >> LENGTH_BITS;
    let doc_slot = slot_in(LENGTH_BITS, doc, 0) >> FIELD_BITS;
    let published = pairs(view.get_published(&length_block(scope, lblock))?)?
        .iter()
        .any(|&(s, _)| s >> FIELD_BITS == doc_slot);
    let rewrite: Vec<(&String, Counts, Counts)> = after
        .tf
        .iter()
        .map(|(t, &n)| (t, before.tf.get(t).copied().unwrap_or_default(), n))
        .chain(
            before
                .tf
                .iter()
                .filter(|(t, _)| !after.tf.contains_key(*t))
                .map(|(t, &o)| (t, o, (0, 0))),
        )
        .filter(|(_, o, n)| o != n || code_old != code_new)
        .collect();
    let at = in_block(doc);
    for (term, o, n) in rewrite {
        for (kind, was, is) in [(TermKind::Exact, o.0, n.0), (TermKind::Gram, o.1, n.1)] {
            // Outside the prefix fields a prefix count is the whole-token count: one frequency.
            if (kind == TermKind::Exact || prefix) && (was == 0) != (is == 0) {
                out.add(
                    doc_freq(scope, kind, term, field),
                    if is == 0 { -1 } else { 1 },
                );
            }
        }
        let dkey = directory_block(scope, term, block);
        let rank_old = view
            .map_range(&dkey, at, at + 1, published)?
            .first()
            .map(|&(_, c)| c - 1);
        let mut data: Vec<(u32, FieldHit)> = match rank_old {
            Some(c) => {
                let first = slot(doc, 0);
                view.map_range(
                    &posting_block(scope, term, c, doc),
                    first,
                    first + (1 << FIELD_BITS),
                    published,
                )?
                .into_iter()
                .map(|(s, v)| {
                    let (_, f) = unslot(doc >> IMPACT_BITS, s);
                    (f, unpack(defs[f as usize].prefix, v))
                })
                .collect()
            }
            None => Vec::new(),
        };
        let fields_old: Vec<u32> = data.iter().map(|x| x.0).collect();
        data.retain(|x| x.0 != field);
        let hit = FieldHit {
            exact: n.0,
            gram: n.1,
            code: code_new,
        };
        let present = n != (0, 0);
        if present {
            data.push((field, hit));
            data.sort_unstable_by_key(|x| x.0);
        }
        let rank_new = (!data.is_empty()).then(|| rank_of(scope, &data));
        if let (Some(a), Some(b)) = (rank_old, rank_new)
            && a == b
        {
            let v = if present { pack(prefix, hit) } else { 0 };
            out.map(
                posting_block(scope, term, a, doc),
                vec![(slot(doc, field), v)],
            );
            continue;
        }
        if let Some(a) = rank_old {
            out.map(
                posting_block(scope, term, a, doc),
                fields_old.iter().map(|&f| (slot(doc, f), 0)).collect(),
            );
        }
        if let Some(b) = rank_new {
            out.map(
                posting_block(scope, term, b, doc),
                data.iter()
                    .map(|&(f, h)| (slot(doc, f), pack(defs[f as usize].prefix, h)))
                    .collect(),
            );
        }
        out.map(dkey, vec![(at, rank_new.map_or(0, |c| c + 1))]);
        match (rank_old, rank_new) {
            (None, Some(_)) => out.add(term_docs(scope, term), 1),
            (Some(_), None) => out.add(term_docs(scope, term), -1),
            _ => {}
        }
    }
    if lo == ln {
        return Ok(());
    }
    out.add(field_tokens(scope, field), ln as i64 - lo as i64);
    let lslot = slot_in(LENGTH_BITS, doc, field);
    out.map(length_block(scope, lblock), vec![(lslot, ln as u32)]);
    if lo == 0 {
        out.max(max_doc(scope), doc);
    }
    if lo == 0 || ln == 0 {
        // The document counts once whatever number of its fields have text.
        let others = pairs(view.get(&length_block(scope, lblock))?)?
            .into_iter()
            .any(|(s, len)| s >> FIELD_BITS == doc_slot && s != lslot && len > 0);
        if !others {
            out.add(doc_count(scope), if ln == 0 { -1 } else { 1 });
        }
    }
    Ok(())
}
