//! Writing the index: a field's entries follow from its text before and after a change, so a change writes only
//! the terms whose frequency changed, the field's length, and counters, and reads nothing per term.

use std::collections::HashMap;

use super::text::{grams, tokens};
use super::{
    BLOCK_BITS, LENGTH_MAX, Scope, TermKind, bound, doc_count, doc_freq, doc_lengths, field_tokens,
    length, max_doc, posting, shortest, varint,
};
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
    for ((kind, term), o, n) in changed {
        let k = posting(scope, *kind, term, doc, field);
        if n == 0 {
            out.del(k);
            out.add(doc_freq(scope, *kind, term, field), -1);
            continue;
        }
        out.put(k, varint(n));
        if o == 0 {
            out.add(doc_freq(scope, *kind, term, field), 1);
        }
        if n > o {
            out.max(bound(scope, *kind, term, field, block), n);
        }
    }
    let (o, n) = (before.len, after.len);
    if o == n {
        return Ok(());
    }
    out.add(field_tokens(scope, field), n as i64 - o as i64);
    if n == 0 {
        out.del(length(scope, doc, field));
    } else {
        out.put(length(scope, doc, field), varint(n));
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
        let start = doc_lengths(scope, doc);
        let others = view
            .scan(&start, &crate::store::kinds::key::prefix_end(&start), 2)?
            .into_iter()
            .any(|(k, _)| k != length(scope, doc, field));
        if !others {
            out.add(doc_count(scope), if n == 0 { -1 } else { 1 });
        }
    }
    Ok(())
}
