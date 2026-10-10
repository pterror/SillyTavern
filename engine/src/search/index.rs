//! Writing the index: a field's entries follow from its text before and after a change. A term whose counts in
//! the field changed gets its slot in the posting block, its frequency counters and its block maximum; the
//! document's own slots in that block (read) say whether it still holds the term in any field. A changed
//! length writes the length, its counters and the block's shortest length. Top lists that hold or could hold
//! the document follow its scores: the changed terms', and when the field's length code changed, every term of
//! the field's; its entry's key is its old score, found again from its counts and length codes before the
//! change. A bulk load leaves those lists alone and marks them stale instead.

use std::collections::HashMap;

use super::text::{grams, tokens};
use super::top::{Fields, Head, encode_fields};
use super::{
    BLOCK_BITS, FIELD_BITS, FieldHit, LENGTH_BITS, SHORTEST_BASE, Scope, TermKind, block_maxima,
    bound_slot, doc_count, doc_freq, field_tokens, length_block, length_code, max_doc, pack,
    posting_block, shortest, slot, slot_in, term_docs, top, top_count, top_entries, top_entry,
    top_generation, unpack, unslot,
};
use crate::keyspace::val::{counter_value, map_pairs};
use crate::store::StoreError;
use crate::store::derive::{Out, View};
use crate::store::kinds::key;

/// A document's fields holding a term, with its counts there.
type Slots = Vec<(u32, FieldHit)>;

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
    update_fields(view, out, scope, doc, &[(field, old, new)])
}

/// A field's change: the field, its values before and after.
pub type FieldChange<'a> = (u32, &'a [&'a [u8]], &'a [&'a [u8]]);

/// `update` for several fields of one document changing together: each sees the document as the ones before it
/// left it, which `view` doesn't hold yet.
pub fn update_fields(
    view: &View,
    out: &mut Out,
    scope: Scope,
    doc: u64,
    changes: &[FieldChange],
) -> Result<(), StoreError> {
    let mut seen = Seen::default();
    let pairs = super::pairs::kept(view, scope, doc)?;
    for &(field, old, new) in changes {
        update_one(view, out, scope, doc, field, old, new, &mut seen)?;
        if pairs {
            super::pairs::update(
                out,
                scope,
                doc,
                field,
                &super::pairs::of(old),
                &super::pairs::of(new),
            );
        }
    }
    Ok(())
}

/// What earlier changes in the same `update_fields` left of the document: its slots per term, and its length
/// block.
#[derive(Default)]
struct Seen {
    slots: HashMap<String, Slots>,
    lengths: Option<Vec<(u32, u32)>>,
}

#[allow(clippy::too_many_arguments)]
fn update_one(
    view: &View,
    out: &mut Out,
    scope: Scope,
    doc: u64,
    field: u32,
    old: &[&[u8]],
    new: &[&[u8]],
    seen: &mut Seen,
) -> Result<(), StoreError> {
    let defs = scope.fields();
    let prefix = defs[field as usize].prefix;
    let (before, after) = (Terms::of(old, prefix), Terms::of(new, prefix));
    let (lo, ln) = (before.len, after.len);
    let block = doc >> BLOCK_BITS;
    let lblock = doc >> LENGTH_BITS;
    let doc_slot = slot_in(LENGTH_BITS, doc, 0) >> FIELD_BITS;
    let lengths = match &seen.lengths {
        Some(l) => l.clone(),
        None => pairs(view.get(&length_block(scope, lblock))?)?,
    };
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
    // The document's slots for each changed term, before and after the change.
    let mut slots_of: HashMap<&str, (Slots, Slots)> = HashMap::new();
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
        let had = match seen.slots.get(term.as_str()) {
            Some(s) => s.clone(),
            None => own_slots(term)?,
        };
        let mut slots = had.clone();
        slots.retain(|x| x.0 != field);
        if present {
            slots.push((field, hit));
            slots.sort_unstable_by_key(|x| x.0);
        }
        if had.is_empty() != slots.is_empty() {
            out.add(
                term_docs(scope, term),
                if slots.is_empty() { -1 } else { 1 },
            );
        }
        slots_of.insert(term, (had, slots));
    }
    let lslot = slot_in(LENGTH_BITS, doc, field);
    if lo != ln {
        let mut now: Vec<(u32, u32)> = lengths.iter().copied().filter(|p| p.0 != lslot).collect();
        if ln > 0 {
            now.push((lslot, ln as u32));
        }
        seen.lengths = Some(now);
    }
    if lo != ln {
        out.add(field_tokens(scope, field), ln as i64 - lo as i64);
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
    // The terms whose scores for the document changed: the changed ones, and every one of the field's when its
    // length code changed.
    let mut affected: Vec<&String> = changed.iter().map(|c| c.0).collect();
    let code_changed = length_code(lo) != length_code(ln);
    if code_changed {
        affected.extend(
            after
                .tf
                .keys()
                .filter(|t| !slots_of.contains_key(t.as_str())),
        );
    }
    if view.is_bulk() {
        // Lists are shared across a load's partitions: the terms' lists are left stale, to be built again.
        for term in affected {
            out.add(top_generation(scope, term), 1);
        }
        remember(seen, slots_of);
        return Ok(());
    }

    // ---- top lists ----
    // The document's length codes before and after.
    let mut old_codes = [0u8; 1 << FIELD_BITS];
    for &(s, len) in &lengths {
        if s >> FIELD_BITS == doc_slot {
            old_codes[(s & ((1 << FIELD_BITS) - 1)) as usize] = length_code(u64::from(len));
        }
    }
    let mut new_codes = old_codes;
    new_codes[field as usize] = length_code(ln);
    let fields_of = |slots: &[(u32, FieldHit)], codes: &[u8; 1 << FIELD_BITS]| -> Fields {
        slots
            .iter()
            .filter(|(_, h)| h.tf(true) > 0)
            .map(|&(f, h)| (f, h.tf(true), codes[f as usize]))
            .collect()
    };
    for term in affected {
        let Some(mut head) = view.get(&top(scope, term))?.and_then(|b| Head::decode(&b)) else {
            continue;
        };
        let generation = view
            .get(&top_generation(scope, term))?
            .and_then(|b| counter_value(&b))
            .unwrap_or(0) as u64;
        if head.generation != generation || head.passing.is_some_and(|b| block >= b) {
            continue;
        }
        let (before, after) = match slots_of.get(term.as_str()) {
            Some((b, a)) => (fields_of(b, &old_codes), fields_of(a, &new_codes)),
            None => {
                let s = match seen.slots.get(term.as_str()) {
                    Some(s) => s.clone(),
                    None => own_slots(term)?,
                };
                (fields_of(&s, &old_codes), fields_of(&s, &new_codes))
            }
        };
        let was = (!before.is_empty())
            .then(|| head.score(&before))
            .filter(|&sc| head.holds(sc, doc, block));
        let is = (!after.is_empty())
            .then(|| head.score(&after))
            .filter(|&sc| head.holds(sc, doc, block));
        if was == is && before == after {
            continue;
        }
        if let Some(sc) = was {
            out.del(top_entry(scope, term, sc, doc));
        }
        if let Some(sc) = is {
            out.put(top_entry(scope, term, sc, doc), encode_fields(&after));
        }
        let delta = i64::from(is.is_some()) - i64::from(was.is_some());
        if delta != 0 {
            out.add(top_count(scope, term), delta);
        }
        if delta > 0 {
            trim(view, out, scope, term, &mut head, (is.unwrap(), doc))?;
        }
    }
    remember(seen, slots_of);
    Ok(())
}

fn remember(seen: &mut Seen, slots_of: HashMap<&str, (Slots, Slots)>) {
    for (term, (_, slots)) in slots_of {
        seen.slots.insert(term.to_string(), slots);
    }
}

/// After `added` joined a list: past `MAX + SLACK` entries, the lowest go down to `MAX` and the floor rises to the
/// best of them.
fn trim(
    view: &View,
    out: &mut Out,
    scope: Scope,
    term: &str,
    head: &mut Head,
    added: (f64, u64),
) -> Result<(), StoreError> {
    // The count before this change, which adds `added`.
    let count = view
        .get(&top_count(scope, term))?
        .and_then(|b| counter_value(&b))
        .unwrap_or(0)
        .max(0) as usize;
    if count < top::MAX + top::SLACK {
        return Ok(());
    }
    // `added` isn't in the view yet; this change took nothing else out of the list.
    let prefix = top_entries(scope, term);
    let mut ranks: Vec<(f64, u64)> = view
        .scan(&prefix, &key::prefix_end(&prefix), count + 1)?
        .iter()
        .filter_map(|(k, _)| top::parse_rank(&k[prefix.len()..]))
        .collect();
    ranks.push(added);
    ranks.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    if ranks.len() <= top::MAX {
        return Ok(());
    }
    for &(sc, d) in &ranks[top::MAX..] {
        out.del(top_entry(scope, term, sc, d));
        head.raise_floor(sc, d);
    }
    out.add(top_count(scope, term), -((ranks.len() - top::MAX) as i64));
    out.put(top(scope, term), head.encode());
    Ok(())
}
