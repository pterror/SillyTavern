//! Writing the index: a field's entries follow from its text before and after a change. A term whose counts in
//! the field changed gets its slot in the posting block, its frequency counters and its block maximum; the
//! document's own slots in that block (read) say whether it still holds the term in any field. A changed
//! length writes the length, its counters and the block's shortest length. Top lists that hold or could hold
//! the document follow its new scores: the changed terms', and when the field's length code changed, every
//! term of the field's. A bulk load leaves top lists alone and marks them stale instead.

use std::collections::HashMap;

use super::text::{grams, tokens};
use super::top::{Entry, List};
use super::{
    BLOCK_BITS, FIELD_BITS, FieldHit, LENGTH_BITS, SHORTEST_BASE, Scope, TermKind, block_maxima,
    bound_slot, doc_count, doc_freq, field_tokens, length_block, length_code, max_doc, pack,
    posting_block, shortest, slot, slot_in, term_docs, top, top_generation, unpack, unslot,
};
use crate::keyspace::val::{counter_value, map_pairs};
use crate::store::StoreError;
use crate::store::derive::{Out, View};

/// A term's count in a field as a whole token and as a prefix term.
type Counts = (u64, u64);

/// A field's terms with their counts, and its length in tokens.
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
    let block = doc >> BLOCK_BITS;
    let lblock = doc >> LENGTH_BITS;
    let doc_slot = slot_in(LENGTH_BITS, doc, 0) >> FIELD_BITS;
    let lengths = pairs(view.get(&length_block(scope, lblock))?)?;
    let published = pairs(view.get_published(&length_block(scope, lblock))?)?
        .iter()
        .any(|&(s, _)| s >> FIELD_BITS == doc_slot);
    let changed: Vec<(&String, Counts, Counts)> = after
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
        .filter(|(_, o, n)| o != n)
        .collect();
    let first = slot(doc, 0);
    let own_slots = |term: &str| -> Result<Vec<(u32, FieldHit)>, StoreError> {
        Ok(view
            .map_range(
                &posting_block(scope, term, block),
                first,
                first + (1 << FIELD_BITS),
                published,
            )?
            .into_iter()
            .map(|(s, v)| {
                let (_, f) = unslot(block, s);
                (f, unpack(defs[f as usize].prefix, v))
            })
            .collect())
    };
    let (bchunk, bslot) = bound_slot(block, field);
    // The document's slots for each changed term, after the change.
    let mut after_slots: HashMap<&str, Vec<(u32, FieldHit)>> = HashMap::new();
    for &(term, o, n) in &changed {
        for (kind, was, is) in [(TermKind::Exact, o.0, n.0), (TermKind::Gram, o.1, n.1)] {
            // Outside the prefix fields a prefix count is the whole-token count: one frequency.
            if (kind == TermKind::Exact || prefix) && (was == 0) != (is == 0) {
                out.add(
                    doc_freq(scope, kind, term, field),
                    if is == 0 { -1 } else { 1 },
                );
            }
        }
        let hit = FieldHit {
            exact: n.0,
            gram: n.1,
        };
        let present = n != (0, 0);
        out.map(
            posting_block(scope, term, block),
            vec![(
                slot(doc, field),
                if present { pack(prefix, hit) } else { 0 },
            )],
        );
        if present {
            out.max_map(
                block_maxima(scope, term, bchunk),
                vec![(bslot, hit.most().min(u64::from(u32::MAX)) as u32)],
            );
        }
        let mut slots = own_slots(term)?;
        let had = !slots.is_empty();
        slots.retain(|x| x.0 != field);
        if present {
            slots.push((field, hit));
            slots.sort_unstable_by_key(|x| x.0);
        }
        let has = !slots.is_empty();
        if had != has {
            out.add(term_docs(scope, term), if has { 1 } else { -1 });
        }
        after_slots.insert(term, slots);
    }
    if lo != ln {
        out.add(field_tokens(scope, field), ln as i64 - lo as i64);
        let lslot = slot_in(LENGTH_BITS, doc, field);
        out.map(length_block(scope, lblock), vec![(lslot, ln as u32)]);
        if ln > 0 {
            let (schunk, sslot) = bound_slot(block, 0);
            out.max_map(
                shortest(scope, field, schunk),
                vec![(sslot, (SHORTEST_BASE - ln.min(SHORTEST_BASE - 1)) as u32)],
            );
        }
        if lo == 0 {
            out.max(max_doc(scope), doc);
        }
        if lo == 0 || ln == 0 {
            // The document counts once whatever number of its fields have text.
            let others = lengths
                .iter()
                .any(|&(s, len)| s >> FIELD_BITS == doc_slot && s != lslot && len > 0);
            if !others {
                out.add(doc_count(scope), if ln == 0 { -1 } else { 1 });
            }
        }
    }
    if view.is_bulk() {
        if !changed.is_empty() || lo != ln {
            out.add(top_generation(scope), 1);
        }
        return Ok(());
    }

    // ---- top lists ----
    let generation = view
        .get(&top_generation(scope))?
        .and_then(|b| counter_value(&b))
        .unwrap_or(0) as u64;
    // The document's length codes, the field's new.
    let mut codes = [0u8; 1 << FIELD_BITS];
    for &(s, len) in &lengths {
        if s >> FIELD_BITS == doc_slot {
            codes[(s & ((1 << FIELD_BITS) - 1)) as usize] = length_code(u64::from(len));
        }
    }
    codes[field as usize] = length_code(ln);
    let mut affected: Vec<&String> = changed.iter().map(|c| c.0).collect();
    if length_code(lo) != length_code(ln) {
        affected.extend(
            after
                .tf
                .keys()
                .filter(|t| !after_slots.contains_key(t.as_str())),
        );
    }
    for term in affected {
        let key = top(scope, term);
        let Some(mut list) = view.get(&key)?.and_then(|b| List::decode(&b)) else {
            continue;
        };
        if list.generation != generation {
            continue;
        }
        let slots = match after_slots.get(term.as_str()) {
            Some(s) => s.clone(),
            None => own_slots(term)?,
        };
        let fields: Vec<(u32, u64, u8)> = slots
            .iter()
            .filter(|(_, h)| h.tf(true) > 0)
            .map(|&(f, h)| (f, h.tf(true), codes[f as usize]))
            .collect();
        let entry = (!fields.is_empty()).then(|| Entry {
            doc,
            score: list.score(&fields),
            fields,
        });
        if list.follow(doc, entry) {
            out.put(key, list.encode());
        }
    }
    Ok(())
}
