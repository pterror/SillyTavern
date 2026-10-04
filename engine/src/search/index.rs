//! Writing the index: a field's entries follow from its text before and after a change. A term's posting holds
//! every field of the document, so rewriting it reads the document's posting (through the term's directory) for
//! the terms whose frequency changed, or for all of the field's terms when its length code changed. A document
//! not yet published has nothing to read but this commit's own entries.

use std::collections::HashMap;

use super::text::{GRAM_MAX, GRAM_MIN, char_len, grams, tokens};
use super::{
    BLOCK_BITS, FIELD_BITS, IMPACT_BITS, LENGTH_BITS, Scope, TermKind, directory_block, doc_count,
    doc_freq, field_tokens, in_block, length_block, length_code, max_doc, pack, posting_block,
    rank_of, slot, slot_in, term_docs, unpack, unslot,
};
use super::{PAIR_SEPARATOR, phrase_mode};
use crate::keyspace::val::map_pairs;
use crate::store::StoreError;
use crate::store::derive::{Out, View};

/// A field's terms with their frequencies, and its length in tokens.
#[derive(Default)]
struct Terms {
    tf: HashMap<(TermKind, String), u64>,
    len: u64,
}

impl Terms {
    /// `items` are the field's values (one, or each item of a list). A prefix field counts prefix terms; any
    /// other field files its whole tokens of 2–20 characters under the prefix terms too, so a word typed as the
    /// query's last word reads one list.
    fn of(items: &[&[u8]], prefix: bool) -> Terms {
        let mut t = Terms::default();
        for item in items {
            let toks = tokens(item);
            if phrase_mode::write() & phrase_mode::PAIRS != 0 {
                for w in toks.windows(2) {
                    let pair = format!("{}{PAIR_SEPARATOR}{}", w[0], w[1]);
                    *t.tf.entry((TermKind::Pair, pair)).or_default() += 1;
                }
            }
            for tok in toks {
                t.len += 1;
                if prefix {
                    for g in grams(&tok) {
                        *t.tf.entry((TermKind::Gram, g.to_string())).or_default() += 1;
                    }
                } else if (GRAM_MIN..=GRAM_MAX).contains(&char_len(&tok)) {
                    *t.tf.entry((TermKind::Gram, tok.clone())).or_default() += 1;
                }
                *t.tf.entry((TermKind::Exact, tok)).or_default() += 1;
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
    let prefix = scope.fields()[field as usize].prefix;
    let (before, after) = (Terms::of(old, prefix), Terms::of(new, prefix));
    let (lo, ln) = (before.len, after.len);
    let (code_old, code_new) = (length_code(lo), length_code(ln));
    let block = doc >> BLOCK_BITS;
    let lblock = doc >> LENGTH_BITS;
    let doc_slot = slot_in(LENGTH_BITS, doc, 0) >> FIELD_BITS;
    let published = pairs(view.get_published(&length_block(scope, lblock))?)?
        .iter()
        .any(|&(s, _)| s >> FIELD_BITS == doc_slot);
    let rewrite: Vec<(&(TermKind, String), u64, u64)> = after
        .tf
        .iter()
        .map(|(t, &n)| (t, before.tf.get(t).copied().unwrap_or(0), n))
        .chain(
            before
                .tf
                .iter()
                .filter(|(t, _)| !after.tf.contains_key(*t))
                .map(|(t, &o)| (t, o, 0)),
        )
        .filter(|(_, o, n)| o != n || code_old != code_new)
        .collect();
    let at = in_block(doc);
    for ((kind, term), o, n) in rewrite {
        let kind = *kind;
        // A prefix term in a field other than a prefix field mirrors the whole token's frequency there.
        if (kind != TermKind::Gram || prefix) && (o == 0) != (n == 0) {
            out.add(
                doc_freq(scope, kind, term, field),
                if n == 0 { -1 } else { 1 },
            );
        }
        let dkey = directory_block(scope, kind, term, block);
        let rank_old = view
            .map_range(&dkey, at, at + 1, published)?
            .first()
            .map(|&(_, c)| c - 1);
        let mut data: Vec<(u32, u64, u8)> = match rank_old {
            Some(c) => {
                let first = slot(doc, 0);
                view.map_range(
                    &posting_block(scope, kind, term, c, doc),
                    first,
                    first + (1 << FIELD_BITS),
                    published,
                )?
                .into_iter()
                .map(|(s, v)| {
                    let (_, f) = unslot(doc >> IMPACT_BITS, s);
                    let (tf, code) = unpack(v);
                    (f, tf, code)
                })
                .collect()
            }
            None => Vec::new(),
        };
        let fields_old: Vec<u32> = data.iter().map(|x| x.0).collect();
        data.retain(|x| x.0 != field);
        if n > 0 {
            data.push((field, n, code_new));
            data.sort_unstable_by_key(|x| x.0);
        }
        let rank_new = (!data.is_empty()).then(|| rank_of(scope, &data));
        if let (Some(a), Some(b)) = (rank_old, rank_new)
            && a == b
        {
            let v = if n > 0 { pack(n, code_new) } else { 0 };
            out.map(
                posting_block(scope, kind, term, a, doc),
                vec![(slot(doc, field), v)],
            );
            continue;
        }
        if let Some(a) = rank_old {
            out.map(
                posting_block(scope, kind, term, a, doc),
                fields_old.iter().map(|&f| (slot(doc, f), 0)).collect(),
            );
        }
        if let Some(b) = rank_new {
            out.map(
                posting_block(scope, kind, term, b, doc),
                data.iter()
                    .map(|&(f, tf, code)| (slot(doc, f), pack(tf, code)))
                    .collect(),
            );
        }
        out.map(dkey, vec![(at, rank_new.map_or(0, |c| c + 1))]);
        match (rank_old, rank_new) {
            (None, Some(_)) => out.add(term_docs(scope, kind, term), 1),
            (Some(_), None) => out.add(term_docs(scope, kind, term), -1),
            _ => {}
        }
    }
    if phrase_mode::write() & phrase_mode::FINGERPRINTS != 0 && old != new {
        let pairs: Vec<(String, String)> = new
            .iter()
            .flat_map(|v| {
                let t = tokens(v);
                t.windows(2)
                    .map(|w| (w[0].clone(), w[1].clone()))
                    .collect::<Vec<_>>()
            })
            .collect();
        let k = super::fingerprint(scope, doc, field);
        if pairs.is_empty() {
            out.del(k);
        } else {
            out.put(k, super::pair_filter(&pairs));
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
