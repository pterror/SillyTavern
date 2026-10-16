//! Writing the index: a field's entries follow from its text before and after a change. A term whose counts in
//! the field changed gets its slot in the posting block; the document's own slots in that block (read) say
//! whether it still holds the term in any field, and so whether the term's document count changes, and what it
//! scored for the term before and after. A score that rose raises the maxima over the block, at every level up
//! to its top one; one that fell leaves them loose. A changed length writes the length and the block's shortest length; a field grown shorter raises its
//! other terms' scores too.

use std::collections::{BTreeSet, HashMap};

use super::text::{grams, tokens};
use super::{
    BLOCK_BITS, DOCS_SLOT, FIELD_BITS, FieldHit, LENGTH_BITS, NODE_SLOT_BITS, SHORTEST_BASE, Scope,
    TermKind, block_maxima, bound_slot, doc_count, field_max_slot, field_texts, length_block,
    length_code, local_r, local_text, max_bits, max_doc, max_slot, node_of, pack, posting_block,
    readings, shortest, slot, slot_in, term_counts, top_level, unpack, unslot,
};
use crate::keyspace::val::{map_bytes, map_pairs};
use crate::store::StoreError;
use crate::store::carriers::Term;
use crate::store::derive::{Out, View};

/// The kind of name term a tag's name holds a term by in a reading (`as_prefix`).
fn term_kind(as_prefix: bool) -> TermKind {
    if as_prefix {
        TermKind::Gram
    } else {
        TermKind::Exact
    }
}

/// The name terms of the tags library document `doc` carries, when its maxima carry a tag part: a library
/// document's outside a bulk load (whose tags raise their carriers' maxima themselves).
fn tag_terms(view: &View, scope: Scope, doc: u64) -> Result<Option<BTreeSet<Term>>, StoreError> {
    if super::tag_field(scope).is_none() || view.is_bulk() {
        return Ok(None);
    }
    crate::store::carriers::carried_terms(view, doc).map(Some)
}

/// Raises the term's maximum over every field in reading `as_prefix` over the blocks of `docs` (in order) to what
/// each of them holding the term in that reading scores with a tag whose name holds it. Per block, the term's
/// postings and each such document's lengths are read, and the highest is raised up to the block's top level.
pub fn raise_tagged(
    view: &View,
    out: &mut Out,
    scope: Scope,
    term: &str,
    as_prefix: bool,
    docs: &[u64],
) -> Result<(), StoreError> {
    if !readings(term).contains(&as_prefix) {
        return Ok(());
    }
    let mut lens_at: Option<(u64, Vec<(u32, u32)>)> = None;
    let mut i = 0;
    while i < docs.len() {
        let block = docs[i] >> BLOCK_BITS;
        let j = i + docs[i..].partition_point(|d| d >> BLOCK_BITS == block);
        let posting = pairs(view.get(&posting_block(scope, term, block))?)?;
        let mut best: Option<f64> = None;
        for &d in &docs[i..j] {
            let held = doc_postings(&posting, d);
            if held.is_empty() {
                continue;
            }
            let lblock = d >> LENGTH_BITS;
            if lens_at.as_ref().is_none_or(|x| x.0 != lblock) {
                lens_at = Some((lblock, pairs(view.get(&length_block(scope, lblock))?)?));
            }
            if let Some(v) = tagged_score(scope, d, held, &lens_at.as_ref().unwrap().1, as_prefix) {
                best = Some(best.map_or(v, |b| b.max(v)));
            }
        }
        if let Some(v) = best {
            raise_tag_part(out, scope, term, block, as_prefix, v);
        }
        i = j;
    }
    Ok(())
}

/// Document `doc`'s slots in its posting block's pairs `posting` (sorted by slot).
pub fn doc_postings(posting: &[(u32, u32)], doc: u64) -> &[(u32, u32)] {
    let first = slot(doc, 0);
    let from = posting.partition_point(|p| p.0 < first);
    let to = from + posting[from..].partition_point(|p| p.0 >> FIELD_BITS == first >> FIELD_BITS);
    &posting[from..to]
}

/// What document `doc`, with its slots `held` in a term's posting block (`doc_postings`) and its length block's
/// pairs `lens_block`, scores for the term in reading `as_prefix` with a tag whose name holds it; None where it
/// doesn't hold the term in that reading.
pub fn tagged_score(
    scope: Scope,
    doc: u64,
    held: &[(u32, u32)],
    lens_block: &[(u32, u32)],
    as_prefix: bool,
) -> Option<f64> {
    let defs = scope.fields();
    let block = doc >> BLOCK_BITS;
    let hits: Slots = held
        .iter()
        .filter(|p| p.1 != 0)
        .map(|&(s, v)| {
            let f = unslot(block, s).1;
            (f, unpack(defs[f as usize].prefix, v))
        })
        .collect();
    if hits.is_empty() {
        return None;
    }
    let lens = doc_lens(lens_block, doc);
    (local_text(scope, &hits, &lens, as_prefix) > 0.0)
        .then(|| local_r(scope, &hits, &lens, as_prefix, true))
}

/// Raises the term's maximum over every field in reading `as_prefix` over posting block `block` to `v`, at every
/// level up to the block's top one.
pub fn raise_tag_part(
    out: &mut Out,
    scope: Scope,
    term: &str,
    block: u64,
    as_prefix: bool,
    v: f64,
) {
    for (level, group, sl, bits) in tag_part_slots(block, as_prefix, v) {
        out.max_map(block_maxima(scope, term, level, group), vec![(sl, bits)]);
    }
}

/// What `raise_tag_part` raises, per level up to the block's top one: the level, the group of its maxima key, the
/// slot, and the bits it is raised to.
pub fn tag_part_slots(
    block: u64,
    as_prefix: bool,
    v: f64,
) -> impl Iterator<Item = (u64, u64, u32, u32)> {
    let bits = max_bits(v);
    (0..=top_level(block)).map(move |level| {
        let (group, sl) = max_slot(node_of(block, level), as_prefix);
        (level, group, sl, bits)
    })
}

/// Document `doc`'s length per field, from its length block's pairs.
fn doc_lens(block: &[(u32, u32)], doc: u64) -> Lens {
    let mut lens: Lens = [0; 1 << FIELD_BITS];
    let doc_slot = slot_in(LENGTH_BITS, doc, 0) >> FIELD_BITS;
    for &(s, len) in block {
        if s >> FIELD_BITS == doc_slot {
            lens[(s & ((1 << FIELD_BITS) - 1)) as usize] = u64::from(len);
        }
    }
    lens
}

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

/// A document's length in tokens per field.
type Lens = [u64; 1 << FIELD_BITS];

/// Raises the term's maxima over the document's block, at levels 0 to the block's `top_level`, in each reading
/// and in each field where its score rose from the one its slots and lengths `old` give to the one `new` give.
/// Over every field it scores `TAG_WEIGHT` more in a reading whose term `tags` (the name terms of the tags it
/// carries) holds.
fn raise(
    out: &mut Out,
    scope: Scope,
    term: &str,
    doc: u64,
    old: (&[(u32, FieldHit)], &Lens),
    new: (&[(u32, FieldHit)], &Lens),
    tags: Option<&BTreeSet<Term>>,
) {
    let block = doc >> BLOCK_BITS;
    // (field, None for every field; reading; value)
    let mut raised: Vec<(Option<u32>, bool, u32)> = Vec::new();
    for &r in readings(term) {
        let tagged = tags.is_some_and(|t| t.contains(&(term_kind(r), term.to_string())));
        let after = local_r(scope, new.0, new.1, r, tagged);
        // A document without the term in this reading has no maximum for it, tag or none.
        let had = if local_text(scope, old.0, old.1, r) > 0.0 {
            local_r(scope, old.0, old.1, r, tagged)
        } else {
            0.0
        };
        if local_text(scope, new.0, new.1, r) > 0.0 && after > had {
            raised.push((None, r, max_bits(after)));
        }
        let before: Vec<(u32, f64)> = field_texts(scope, old.0, old.1, r).collect();
        for (f, after) in field_texts(scope, new.0, new.1, r) {
            let was = before.iter().find(|x| x.0 == f).map_or(0.0, |x| x.1);
            if after > was {
                raised.push((Some(f), r, max_bits(after)));
            }
        }
    }
    if raised.is_empty() {
        return;
    }
    for level in 0..=top_level(block) {
        let node = node_of(block, level);
        let mut slots: Vec<(u32, u32)> = raised
            .iter()
            .map(|&(f, r, v)| {
                let sl = match f {
                    Some(f) => field_max_slot(node, f, r).1,
                    None => max_slot(node, r).1,
                };
                (sl, v)
            })
            .collect();
        slots.sort_unstable_by_key(|x| x.0);
        out.max_map(
            block_maxima(scope, term, level, max_slot(node, false).0),
            slots,
        );
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
/// block; whether the view held no length of the document, so no posting of it either, and whether its published
/// entries hold one.
#[derive(Default)]
struct Seen {
    slots: HashMap<String, Slots>,
    lengths: Option<Vec<(u32, u32)>>,
    fresh: bool,
    published: bool,
    /// The name terms of its tags (`tag_terms`), once a raise needed them.
    tags: Option<Option<BTreeSet<Term>>>,
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
        None => {
            let l = pairs(view.get(&length_block(scope, lblock))?)?;
            seen.fresh = !l
                .iter()
                .any(|&(s, len)| s >> FIELD_BITS == doc_slot && len > 0);
            l
        }
    };
    let published = pairs(view.get_published(&length_block(scope, lblock))?)?
        .iter()
        .any(|&(s, _)| s >> FIELD_BITS == doc_slot);
    seen.published = published;
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
    let raises = !changed.is_empty() || (ln > 0 && length_code(ln) < length_code(lo));
    if raises && seen.tags.is_none() {
        seen.tags = Some(tag_terms(view, scope, doc)?);
    }
    let fresh = seen.fresh;
    let mut old_lens: Lens = [0; 1 << FIELD_BITS];
    for &(s, len) in &lengths {
        if s >> FIELD_BITS == doc_slot {
            old_lens[(s & ((1 << FIELD_BITS) - 1)) as usize] = u64::from(len);
        }
    }
    let mut new_lens = old_lens;
    new_lens[field as usize] = ln;
    for &(term, _, n) in &changed {
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
        let had = match seen.slots.get(term.as_str()) {
            Some(s) => s.clone(),
            None => own_slots(view, scope, doc, term, fresh, published)?,
        };
        let mut slots = had.clone();
        slots.retain(|x| x.0 != field);
        if present {
            slots.push((field, hit));
            slots.sort_unstable_by_key(|x| x.0);
        }
        if had.is_empty() != slots.is_empty() {
            out.add_map(
                term_counts(scope, term),
                vec![(DOCS_SLOT, if slots.is_empty() { -1 } else { 1 })],
            );
        }
        raise(
            out,
            scope,
            term,
            doc,
            (&had, &old_lens),
            (&slots, &new_lens),
            seen.tags.as_ref().unwrap().as_ref(),
        );
        seen.slots.insert(term.clone(), slots);
    }
    if ln > 0 && length_code(ln) < length_code(lo) {
        // The field's other terms score higher in it now.
        for term in after.tf.keys() {
            if before.tf.get(term) != after.tf.get(term) {
                continue;
            }
            let held = match seen.slots.get(term.as_str()) {
                Some(s) => s.clone(),
                None => own_slots(view, scope, doc, term, fresh, published)?,
            };
            raise(
                out,
                scope,
                term,
                doc,
                (&held, &old_lens),
                (&held, &new_lens),
                seen.tags.as_ref().unwrap().as_ref(),
            );
            seen.slots.insert(term.clone(), held);
        }
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
    if scope == Scope::TAGS {
        crate::store::carriers::renamed(
            view,
            out,
            doc,
            &crate::store::carriers::one_name(old)?,
            &crate::store::carriers::one_name(new)?,
        )?;
    }
    Ok(())
}

/// The document's slots in the term's posting block, as the view holds them (none when `fresh`).
fn own_slots(
    view: &View,
    scope: Scope,
    doc: u64,
    term: &str,
    fresh: bool,
    published: bool,
) -> Result<Slots, StoreError> {
    if fresh {
        return Ok(Vec::new());
    }
    let block = doc >> BLOCK_BITS;
    let first = slot(doc, 0);
    let defs = scope.fields();
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
}

/// The term's maxima over block `block` lowered to what its documents score now (`super::query::Tighten`): each
/// slot of the block's node higher than the most a document there scores (in that reading, over every field or
/// in one) takes that, or goes when none scores; then each node above, up to the block's top level, from its
/// children's map, until a level where nothing falls. Each changed map is put whole. A raise ordered after it
/// folds over the put; one ordered before is in what it reads, so none is lost.
///
/// Over every field, a document scores `TAG_WEIGHT` more when it may carry a tag whose name holds the term in that
/// reading (`carried`), so a move's carriers not yet counted by the term's map stay covered. A slot below that is
/// left as it is.
pub fn tighten(
    view: &View,
    out: &mut Out,
    scope: Scope,
    term: &str,
    block: u64,
) -> Result<(), StoreError> {
    let mut want = block_want(view, scope, term, block)?;
    for level in 0..=top_level(block) {
        let node = node_of(block, level);
        let (group, first) = max_slot(node, false);
        let k = block_maxima(scope, term, level, group);
        let mut m = pairs(view.get(&k)?)?;
        let mut fell = false;
        for p in m
            .iter_mut()
            .filter(|p| p.0 >> NODE_SLOT_BITS == first >> NODE_SLOT_BITS)
        {
            let w = want.get(&(p.0 - first)).copied().unwrap_or(0);
            if w < p.1 {
                p.1 = w;
                fell = true;
            }
        }
        if !fell {
            break;
        }
        m.retain(|p| p.1 != 0);
        if m.is_empty() {
            out.del(k);
        } else {
            out.put(k, map_bytes(&m));
        }
        // The node above holds the most of this map's slots, per sub.
        want.clear();
        for &(sl, v) in &m {
            let w = want.entry(sl & ((1 << NODE_SLOT_BITS) - 1)).or_insert(v);
            *w = (*w).max(v);
        }
    }
    Ok(())
}

/// The most each slot of block `block`'s node may hold for the term, by sub (`max_slot(0, ..)`,
/// `field_max_slot(0, ..)`) → `max_bits`: what its documents score now, over every field (with `TAG_WEIGHT` where
/// a document may carry a tag whose name holds the term, `carried`) and in each field. A sub no document scores in
/// is absent.
pub fn block_want(
    view: &View,
    scope: Scope,
    term: &str,
    block: u64,
) -> Result<HashMap<u32, u32>, StoreError> {
    let defs = scope.fields();
    // Each document's fields holding the term, in field order.
    let mut docs: Vec<(u64, Slots)> = Vec::new();
    for (sl, v) in pairs(view.get(&posting_block(scope, term, block))?)? {
        if v == 0 {
            continue;
        }
        let (d, f) = unslot(block, sl);
        let hit = (f, unpack(defs[f as usize].prefix, v));
        match docs.last_mut() {
            Some((x, s)) if *x == d => s.push(hit),
            _ => docs.push((d, vec![hit])),
        }
    }
    let tagged: Vec<(bool, Vec<u64>)> = match super::tag_field(scope) {
        Some(_) => readings(term)
            .iter()
            .map(|&r| Ok((r, carried(view, term, r, block)?)))
            .collect::<Result<_, StoreError>>()?,
        None => Vec::new(),
    };
    // The most each slot of the node may hold: (sub, `max_bits`).
    let mut want: HashMap<u32, u32> = HashMap::new();
    let mut lens_at: Option<(u64, Vec<(u32, u32)>)> = None;
    for (d, hits) in &docs {
        let lblock = d >> LENGTH_BITS;
        if lens_at.as_ref().is_none_or(|x| x.0 != lblock) {
            lens_at = Some((lblock, pairs(view.get(&length_block(scope, lblock))?)?));
        }
        let mut lens: Lens = [0; 1 << FIELD_BITS];
        let doc_slot = slot_in(LENGTH_BITS, *d, 0) >> FIELD_BITS;
        for &(s, len) in &lens_at.as_ref().unwrap().1 {
            if s >> FIELD_BITS == doc_slot {
                lens[(s & ((1 << FIELD_BITS) - 1)) as usize] = u64::from(len);
            }
        }
        let mut most = |sub: u32, v: f64| {
            let b = max_bits(v);
            let w = want.entry(sub).or_insert(b);
            *w = (*w).max(b);
        };
        for &r in readings(term) {
            if local_text(scope, hits, &lens, r) > 0.0 {
                let carries = tagged
                    .iter()
                    .any(|(x, c)| *x == r && c.binary_search(d).is_ok());
                most(max_slot(0, r).1, local_r(scope, hits, &lens, r, carries));
            }
            for (f, x) in field_texts(scope, hits, &lens, r) {
                most(field_max_slot(0, f, r).1, x);
            }
        }
    }
    Ok(want)
}

/// The documents of block `block` that may carry a tag whose name holds `term` in reading `as_prefix`, in order:
/// those the term's map counts a tag at, and the carriers of its heavy tags and of its moving ones (by their
/// mapped, target or indexed names).
fn carried(view: &View, term: &str, as_prefix: bool, block: u64) -> Result<Vec<u64>, StoreError> {
    use crate::store::kinds::key;
    let kind = if as_prefix {
        super::TermKind::Gram
    } else {
        super::TermKind::Exact
    };
    let (first, end) = (block << BLOCK_BITS, (block + 1) << BLOCK_BITS);
    let member = first >> key::MEMBER_BITS;
    let mut out = Vec::new();
    let places = |k: &[u8], out: &mut Vec<u64>| -> Result<(), StoreError> {
        let Some(v) = view.get_val(k)? else {
            return Ok(());
        };
        let p = v
            .into_pairs(k)
            .ok_or_else(|| StoreError::Entry("a carrier block doesn't decode".into()))?;
        for (slot, n) in p {
            let d = member << key::MEMBER_BITS | u64::from(slot);
            if n != 0 && (first..end).contains(&d) {
                out.push(d);
            }
        }
        Ok(())
    };
    let mut k = key::tag_carriers_of(kind, term);
    crate::keyspace::val::put_u64(&mut k, member);
    places(&k, &mut out)?;
    for structure in [key::TERM_HEAVY, key::TERM_MOVING] {
        let prefix = key::term_key(structure, kind, term);
        let end_key = key::prefix_end(&prefix);
        let mut from = prefix.clone();
        loop {
            let page = view.scan(&from, &end_key, 64)?;
            for (tk, _) in &page {
                let tag = crate::keyspace::val::get_u64(tk, &mut { prefix.len() })
                    .ok_or_else(|| StoreError::Entry("a term's tag key doesn't decode".into()))?;
                places(&key::member_block(tag, first), &mut out)?;
            }
            match page.last() {
                Some((tk, _)) if page.len() == 64 => {
                    from = tk.clone();
                    from.push(0);
                }
                _ => break,
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

/// A field's values, for `whole`.
pub type FieldValues<'a> = (u32, &'a [&'a [u8]]);

/// The entries for every field of document `doc` coming (`on`) with these values, or going with them: a create
/// meets a document with no entries, and a delete meets the entries these values made, so nothing of the document
/// is read but, on a library create, the tags it carries (`tag_terms`). Each term's posting and block maximum is one write over all its fields; a delete leaves the bounds
/// that are only ever raised (block maxima, shortest lengths, the highest document) loose, never wrong.
pub fn whole(
    view: &View,
    out: &mut Out,
    scope: Scope,
    doc: u64,
    fields: &[FieldValues],
    on: bool,
) -> Result<(), StoreError> {
    let defs = scope.fields();
    let block = doc >> BLOCK_BITS;
    let sign = if on { 1 } else { -1 };
    let mut fields: Vec<(u32, &[&[u8]], Terms)> = fields
        .iter()
        .map(|&(f, v)| (f, v, Terms::of(v, defs[f as usize].prefix)))
        .collect();
    fields.sort_by_key(|x| x.0);
    // Each term's fields with its counts there, by field.
    let mut slots: HashMap<&str, Slots> = HashMap::new();
    for (f, _, t) in &fields {
        for (term, &(exact, gram)) in &t.tf {
            slots
                .entry(term.as_str())
                .or_default()
                .push((*f, FieldHit { exact, gram }));
        }
    }
    let lengths: Vec<(u32, u64)> = fields
        .iter()
        .filter(|x| x.2.len > 0)
        .map(|x| (x.0, x.2.len))
        .collect();
    let mut lens: Lens = [0; 1 << FIELD_BITS];
    for &(f, len) in &lengths {
        lens[f as usize] = len;
    }
    #[cfg(debug_assertions)]
    {
        let doc_slot = slot_in(LENGTH_BITS, doc, 0) >> FIELD_BITS;
        let held: Vec<(u32, u32)> = pairs(view.get(&length_block(scope, doc >> LENGTH_BITS))?)?
            .into_iter()
            .filter(|&(s, len)| s >> FIELD_BITS == doc_slot && len > 0)
            .collect();
        let want: Vec<(u32, u32)> = if on {
            Vec::new()
        } else {
            lengths
                .iter()
                .map(|&(f, len)| (slot_in(LENGTH_BITS, doc, f), len as u32))
                .collect()
        };
        debug_assert_eq!(held, want, "document {doc}'s lengths before a whole change");
    }
    let tags = if on && !slots.is_empty() {
        tag_terms(view, scope, doc)?
    } else {
        None
    };
    for (&term, hits) in &slots {
        out.map(
            posting_block(scope, term, block),
            hits.iter()
                .map(|&(f, h)| {
                    let v = if on {
                        pack(defs[f as usize].prefix, h)
                    } else {
                        0
                    };
                    (slot(doc, f), v)
                })
                .collect(),
        );
        if on {
            raise(
                out,
                scope,
                term,
                doc,
                (&[], &lens),
                (hits, &lens),
                tags.as_ref(),
            );
        }
        out.add_map(term_counts(scope, term), vec![(DOCS_SLOT, sign)]);
    }
    if !lengths.is_empty() {
        out.map(
            length_block(scope, doc >> LENGTH_BITS),
            lengths
                .iter()
                .map(|&(f, len)| {
                    (
                        slot_in(LENGTH_BITS, doc, f),
                        if on { len as u32 } else { 0 },
                    )
                })
                .collect(),
        );
        for &(f, len) in &lengths {
            if on {
                let (schunk, sslot) = bound_slot(block, 0);
                out.max_map(
                    shortest(scope, f, schunk),
                    vec![(sslot, (SHORTEST_BASE - len.min(SHORTEST_BASE - 1)) as u32)],
                );
            }
        }
        out.add(doc_count(scope), sign);
        if on {
            out.max(max_doc(scope), doc);
        }
    }
    if super::pairs::kept(view, scope, doc)? {
        for &(f, v, _) in &fields {
            let (old, new) = if on { (&[][..], v) } else { (v, &[][..]) };
            super::pairs::update(
                out,
                scope,
                doc,
                f,
                &super::pairs::of(old),
                &super::pairs::of(new),
            );
        }
    }
    if scope == Scope::TAGS
        && let Some(&(_, v, _)) = fields.iter().find(|x| x.0 == 0)
    {
        let (old, new) = if on { (&[][..], v) } else { (v, &[][..]) };
        crate::store::carriers::renamed(
            view,
            out,
            doc,
            &crate::store::carriers::one_name(old)?,
            &crate::store::carriers::one_name(new)?,
        )?;
    }
    Ok(())
}
