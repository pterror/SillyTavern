//! Writing the index: a field's entries follow from its text before and after a change, so a change writes only
//! the terms whose frequency changed, the field's length, and counters, and reads nothing per term.

use std::collections::HashMap;

use super::text::{grams, tokens};
use super::{
    BLOCK_BITS, FIELD_BITS, LENGTH_BITS, LENGTH_MAX, Scope, TermKind, doc_count, doc_freq,
    field_length_block, field_tokens, in_block, length_block, max_doc, posting_block, shortest,
    slot, slot_in,
};
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
    /// `items` are the field's values (one, or each item of a list); a prefix field also counts prefix terms.
    fn of(items: &[&[u8]], prefix: bool) -> Terms {
        let mut t = Terms::default();
        for item in items {
            for tok in tokens(item) {
                t.len += 1;
                if prefix {
                    for g in grams(&tok) {
                        *t.tf.entry((TermKind::Gram, g.to_string())).or_default() += 1;
                    }
                }
                *t.tf.entry((TermKind::Exact, tok)).or_default() += 1;
            }
        }
        t
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
    let block = doc >> BLOCK_BITS;
    let changed: Vec<(&(TermKind, String), u64, u64)> = after
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
        .filter(|(_, o, n)| o != n)
        .collect();
    let sl = slot(doc, field);
    for ((kind, term), o, n) in changed {
        out.map(
            posting_block(scope, *kind, term, block),
            vec![(sl, n as u32)],
        );
        if o == 0 {
            out.add(doc_freq(scope, *kind, term, field), 1);
        } else if n == 0 {
            out.add(doc_freq(scope, *kind, term, field), -1);
        }
    }
    let (o, n) = (before.len, after.len);
    if o == n {
        return Ok(());
    }
    out.add(field_tokens(scope, field), n as i64 - o as i64);
    let lblock = doc >> LENGTH_BITS;
    let lslot = slot_in(LENGTH_BITS, doc, field);
    out.map(length_block(scope, lblock), vec![(lslot, n as u32)]);
    out.map(
        field_length_block(scope, field, block),
        vec![(in_block(doc), n as u32)],
    );
    if n > 0 {
        if o == 0 {
            out.max(max_doc(scope), doc);
        }
        if o == 0 || n < o {
            out.max(
                shortest(scope, field, block),
                LENGTH_MAX - n.min(LENGTH_MAX),
            );
        }
    }
    if o == 0 || n == 0 {
        // The document counts once whatever number of its fields have text.
        let first = slot_in(LENGTH_BITS, doc, 0);
        let others = match view.get(&length_block(scope, lblock))? {
            Some(b) => map_pairs(&b)
                .ok_or_else(|| StoreError::Entry("a search length block doesn't decode".into()))?
                .into_iter()
                .any(|(s, len)| s >> FIELD_BITS == first >> FIELD_BITS && s != lslot && len > 0),
            None => false,
        };
        if !others {
            out.add(doc_count(scope), if n == 0 { -1 } else { 1 });
        }
    }
    Ok(())
}
