use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use super::StoreError;
use super::books::{self, ENTRY, EntryKey, entry_key};
use super::chat_read::Js;
use super::commit_checks;
use super::derive::{Out, View};
use super::kinds::{key, text_value};
use super::library::{entity_by_key, entity_info};
use super::world_order_tree::{self as tree, CountedSlot, LayeredWrites, OrderKey, ReadDerived};
use crate::keyspace::val::{counter_value, get_bytes, get_u64, put_bytes, put_u64};
use crate::log::format::FieldRef;

pub const RELATIONS_OF_ENTRY: u64 = 228;
pub const RELATIONS_BY_TARGET: u64 = 229;
pub const RELATION_COUNT_BY_KIND_AND_TARGET: u64 = 230;
pub const DELETION_IN_PROGRESS_BY_KEY: u64 = 232;
pub const DELETION_IN_PROGRESS_BY_ENTITY: u64 = 233;
pub const RELATIONS_REMOVED_BY_DELETION: u64 = 234;
pub const KINDS_BEING_MERGED: u64 = 235;

pub const RELATIONS_FIELD: &[u8] = b"\x01relations";
pub const RELATION_KIND_FIELD_PREFIX: &[u8] = b"\x01relationKind:";
pub const RELATION_KIND_MERGE_FIELD_PREFIX: &[u8] = b"\x01relationKindMergingInto:";

pub fn is_relations_field(field: &FieldRef) -> bool {
    matches!(field, FieldRef::Key(stored_key) if stored_key.as_slice() == RELATIONS_FIELD)
}

pub fn relations_field() -> FieldRef {
    FieldRef::Key(RELATIONS_FIELD.to_vec())
}

pub fn relation_kind_field(kind: u64) -> FieldRef {
    let mut stored_key = RELATION_KIND_FIELD_PREFIX.to_vec();
    stored_key.extend_from_slice(kind.to_string().as_bytes());
    FieldRef::Key(stored_key)
}

pub fn relation_kind_merge_field(kind: u64) -> FieldRef {
    let mut stored_key = RELATION_KIND_MERGE_FIELD_PREFIX.to_vec();
    stored_key.extend_from_slice(kind.to_string().as_bytes());
    FieldRef::Key(stored_key)
}

pub fn kind_of_relation_kind_merge_field(field: &FieldRef) -> Option<u64> {
    let FieldRef::Key(field_name) = field else {
        return None;
    };
    whole_id(field_name.strip_prefix(RELATION_KIND_MERGE_FIELD_PREFIX)?)
}

pub fn merge_target_of_text(text: &[u8]) -> Option<u64> {
    whole_id(text)
}

pub fn kind_of_relation_kind_field(field: &FieldRef) -> Option<u64> {
    let FieldRef::Key(field_name) = field else {
        return None;
    };
    let digits = field_name.strip_prefix(RELATION_KIND_FIELD_PREFIX)?;
    whole_id(digits)
}

fn whole_id(digits: &[u8]) -> Option<u64> {
    let canonical = !digits.is_empty()
        && digits.len() <= 16
        && digits.iter().all(u8::is_ascii_digit)
        && digits[0] != b'0';
    canonical
        .then(|| std::str::from_utf8(digits).ok()?.parse::<u64>().ok())
        .flatten()
        .filter(|count| *count <= MAX_SAFE)
}

const MAX_SAFE: u64 = (1 << 53) - 1;

pub fn relation_kind_name(
    view: &View,
    book: u64,
    kind: u64,
) -> Result<Option<Vec<u8>>, StoreError> {
    text_value(view, book, &relation_kind_field(kind))
}

fn corrupt(why: &str) -> StoreError {
    StoreError::Entry(format!("relations: {why}"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relation {
    pub position: Vec<u8>,
    pub weak: bool,
    pub item: Vec<u8>,
}

pub type RelationSet = BTreeMap<(u64, Vec<u8>), Relation>;

pub fn order_tree_space(book: u64) -> Vec<u8> {
    let mut stored_key = Vec::new();
    put_u64(&mut stored_key, book);
    stored_key
}

pub fn sortable_bits(number: f64) -> u64 {
    let number = if number.is_nan() {
        f64::NAN
    } else if number == 0.0 {
        0.0
    } else {
        number
    };
    let bits = number.to_bits();
    if bits >> 63 == 1 {
        !bits
    } else {
        bits | 1 << 63
    }
}

pub fn world_order_value(index: Option<f64>, own_key: &EntryKey) -> u64 {
    match (index, own_key) {
        (Some(index_value), _) => sortable_bits(index_value),
        (None, EntryKey::Int(number)) => sortable_bits(*number as f64),
        (None, EntryKey::Text(_)) => u64::MAX,
    }
}

pub fn order_key_of_entry(
    view: &View,
    entity: u64,
    own_key: &EntryKey,
) -> Result<OrderKey, StoreError> {
    Ok(tree::order_key(
        world_order_value(books::entry_index(view, entity)?, own_key),
        entity,
    ))
}

fn relation_of_entry_key(entity: u64, kind: u64, target_key: &[u8]) -> Vec<u8> {
    let mut stored_key = key::id(RELATIONS_OF_ENTRY, entity);
    put_u64(&mut stored_key, kind);
    put_bytes(&mut stored_key, target_key);
    stored_key
}

fn relation_value(relation: &Relation) -> Vec<u8> {
    let mut value = vec![u8::from(relation.weak)];
    put_bytes(&mut value, &relation.position);
    value.extend_from_slice(&relation.item);
    value
}

fn relation_of_value(stored: &[u8]) -> Result<Relation, StoreError> {
    let bad = || corrupt("a relation's value doesn't decode");
    let (&weak_byte, rest) = stored.split_first().ok_or_else(bad)?;
    if weak_byte > 1 {
        return Err(bad());
    }
    let mut read_at = 0;
    let position = get_bytes(rest, &mut read_at).ok_or_else(bad)?;
    Ok(Relation {
        position,
        weak: weak_byte == 1,
        item: rest[read_at..].to_vec(),
    })
}

pub fn relations_targeting_prefix(book: u64, target_key: &[u8]) -> Vec<u8> {
    let mut stored_key = key::id(RELATIONS_BY_TARGET, book);
    put_bytes(&mut stored_key, target_key);
    stored_key
}

pub fn relations_of_kind_targeting_prefix(book: u64, kind: u64, target_key: &[u8]) -> Vec<u8> {
    let mut stored_key = relations_targeting_prefix(book, target_key);
    put_u64(&mut stored_key, kind);
    stored_key
}

fn relation_by_target_key(
    book: u64,
    kind: u64,
    target_key: &[u8],
    position: &[u8],
    source: u64,
) -> Vec<u8> {
    let mut stored_key = relations_of_kind_targeting_prefix(book, kind, target_key);
    put_bytes(&mut stored_key, position);
    put_u64(&mut stored_key, source);
    stored_key
}

pub fn position_and_source_of_relation_of_kind_targeting(
    prefix: &[u8],
    stored_key: &[u8],
) -> Result<(Vec<u8>, u64), StoreError> {
    let mut read_at = prefix.len();
    let bad = || corrupt("a relation-by-target key doesn't decode");
    let position = get_bytes(stored_key, &mut read_at).ok_or_else(bad)?;
    let source = get_u64(stored_key, &mut read_at).ok_or_else(bad)?;
    Ok((position, source))
}

pub fn kind_and_source_of_relation_targeting(
    prefix: &[u8],
    stored_key: &[u8],
) -> Result<(u64, u64), StoreError> {
    let mut read_at = prefix.len();
    let bad = || corrupt("a relation-by-target key doesn't decode");
    let kind = get_u64(stored_key, &mut read_at).ok_or_else(bad)?;
    get_bytes(stored_key, &mut read_at).ok_or_else(bad)?;
    let source = get_u64(stored_key, &mut read_at).ok_or_else(bad)?;
    Ok((kind, source))
}

pub fn relation_counts_of_kind_prefix(book: u64, kind: u64) -> Vec<u8> {
    let mut stored_key = key::id(RELATION_COUNT_BY_KIND_AND_TARGET, book);
    put_u64(&mut stored_key, kind);
    stored_key
}

pub fn relation_count_key(book: u64, kind: u64, target_key: &[u8]) -> Vec<u8> {
    let mut stored_key = relation_counts_of_kind_prefix(book, kind);
    put_bytes(&mut stored_key, target_key);
    stored_key
}

pub fn count_of_relations_of_kind_targeting(
    reader: &impl ReadDerived,
    book: u64,
    kind: u64,
    target_key: &[u8],
) -> Result<u64, StoreError> {
    match reader.read(&relation_count_key(book, kind, target_key))? {
        Some(stored) => counter_value(&stored)
            .and_then(|count| u64::try_from(count).ok())
            .ok_or_else(|| corrupt("a relation count doesn't decode")),
        None => Ok(0),
    }
}

fn first_under(reader: &impl ReadDerived, prefix: &[u8]) -> Result<Option<Vec<u8>>, StoreError> {
    Ok(reader.read_first_under(prefix)?.map(|(stored_key, _)| stored_key))
}

pub fn any_relation_targets(
    reader: &impl ReadDerived,
    book: u64,
    target_key: &[u8],
) -> Result<bool, StoreError> {
    Ok(first_under(reader, &relations_targeting_prefix(book, target_key))?.is_some())
}

pub fn relation_kind_in_use(view: &View, book: u64, kind: u64) -> Result<bool, StoreError> {
    Ok(first_under(view, &relation_counts_of_kind_prefix(book, kind))?.is_some())
}

pub fn kinds_of_relations_targeting(
    reader: &impl ReadDerived,
    book: u64,
    target_key: &[u8],
) -> Result<Vec<u64>, StoreError> {
    let prefix = relations_targeting_prefix(book, target_key);
    let mut kinds = Vec::new();
    let mut from = prefix.clone();
    while let Some((stored_key, _)) = reader.read_first_in(&from, &key::prefix_end(&prefix))? {
        let (kind, _) = kind_and_source_of_relation_targeting(&prefix, &stored_key)?;
        kinds.push(kind);
        from = key::prefix_end(&relations_of_kind_targeting_prefix(book, kind, target_key));
    }
    Ok(kinds)
}

fn deletion_in_progress_key(book: u64, target_key: &[u8]) -> Vec<u8> {
    let mut stored_key = key::id(DELETION_IN_PROGRESS_BY_KEY, book);
    put_bytes(&mut stored_key, target_key);
    stored_key
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeletionInProgress {
    pub entity: u64,
    pub order_value: u64,
}

pub fn deletion_in_progress(
    reader: &impl ReadDerived,
    book: u64,
    target_key: &[u8],
) -> Result<Option<DeletionInProgress>, StoreError> {
    let Some(stored) = reader.read(&deletion_in_progress_key(book, target_key))? else {
        return Ok(None);
    };
    let mut read_at = 0;
    let bad = || corrupt("a deletion in progress doesn't decode");
    let entity = get_u64(&stored, &mut read_at).ok_or_else(bad)?;
    let order_value = get_u64(&stored, &mut read_at).ok_or_else(bad)?;
    Ok(Some(DeletionInProgress {
        entity,
        order_value,
    }))
}

fn deletion_in_progress_of_entity_key(entity: u64) -> Vec<u8> {
    key::id(DELETION_IN_PROGRESS_BY_ENTITY, entity)
}

pub fn deleted_entry_key_in_progress(
    reader: &impl ReadDerived,
    entity: u64,
) -> Result<Option<(u64, Vec<u8>)>, StoreError> {
    let Some(stored) = reader.read(&deletion_in_progress_of_entity_key(entity))? else {
        return Ok(None);
    };
    let mut read_at = 0;
    let bad = || corrupt("a deletion in progress doesn't decode");
    let book = get_u64(&stored, &mut read_at).ok_or_else(bad)?;
    let target_key = get_bytes(&stored, &mut read_at).ok_or_else(bad)?;
    Ok(Some((book, target_key)))
}

pub fn removed_by_deletion_prefix(book: u64, deleted: u64) -> Vec<u8> {
    let mut stored_key = key::id(RELATIONS_REMOVED_BY_DELETION, book);
    put_u64(&mut stored_key, deleted);
    stored_key
}

fn removed_by_deletion_key(book: u64, deleted: u64, source: u64, kind: u64) -> Vec<u8> {
    let mut stored_key = removed_by_deletion_prefix(book, deleted);
    put_u64(&mut stored_key, source);
    put_u64(&mut stored_key, kind);
    stored_key
}

pub fn source_and_kind_of_removed_by_deletion(
    prefix: &[u8],
    stored_key: &[u8],
) -> Result<(u64, u64), StoreError> {
    let mut read_at = prefix.len();
    let bad = || corrupt("a relation removed by a deletion doesn't decode");
    let source = get_u64(stored_key, &mut read_at).ok_or_else(bad)?;
    let kind = get_u64(stored_key, &mut read_at).ok_or_else(bad)?;
    Ok((source, kind))
}

fn change_relation_count(
    writes: &mut LayeredWrites,
    book: u64,
    kind: u64,
    target_key: &[u8],
    change: i64,
) -> Result<(), StoreError> {
    let count_key = relation_count_key(book, kind, target_key);
    let after = count_of_relations_of_kind_targeting(writes, book, kind, target_key)? as i64 + change;
    if after == 0 {
        writes.del(count_key);
    } else {
        writes.add(count_key, change);
    }
    if after == 0
        && let Some(deleting) = deletion_in_progress(writes, book, target_key)?
    {
        let order_key = tree::order_key(deleting.order_value, deleting.entity);
        let book_tree = order_tree_space(book);
        tree::add_held(
            writes,
            &book_tree,
            &order_key,
            CountedSlot::DeletedEntryPlaceForKind(kind),
            -1,
        )?;
        if !any_relation_targets(writes, book, target_key)? {
            finish_deletion(writes, book, target_key, deleting)?;
        }
    }
    Ok(())
}

fn finish_deletion(
    writes: &mut LayeredWrites,
    book: u64,
    target_key: &[u8],
    deleting: DeletionInProgress,
) -> Result<(), StoreError> {
    tree::remove_entry(
        writes,
        &order_tree_space(book),
        &tree::order_key(deleting.order_value, deleting.entity),
        &[CountedSlot::DeletedWhileRelationsTargetIt],
    )?;
    writes.del(deletion_in_progress_key(book, target_key));
    writes.del(deletion_in_progress_of_entity_key(deleting.entity));
    Ok(())
}

pub fn relations_of_entry(
    reader: &impl ReadDerived,
    entity: u64,
) -> Result<RelationSet, StoreError> {
    let prefix = key::id(RELATIONS_OF_ENTRY, entity);
    let mut out = RelationSet::new();
    for (stored_key, value) in reader.read_under(&prefix)? {
        let mut read_at = prefix.len();
        let bad = || corrupt("a relation key doesn't decode");
        let kind = get_u64(&stored_key, &mut read_at).ok_or_else(bad)?;
        let target_key = get_bytes(&stored_key, &mut read_at).ok_or_else(bad)?;
        out.insert((kind, target_key), relation_of_value(&value)?);
    }
    Ok(out)
}

fn strong_relations_of_kind(
    view: &View,
    entity: u64,
    kind: u64,
) -> Result<Vec<Vec<u8>>, StoreError> {
    let mut prefix = key::id(RELATIONS_OF_ENTRY, entity);
    put_u64(&mut prefix, kind);
    let mut out = Vec::new();
    for (stored_key, value) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
        let mut read_at = prefix.len();
        let target_key = get_bytes(&stored_key, &mut read_at)
            .ok_or_else(|| corrupt("a relation key doesn't decode"))?;
        if !relation_of_value(&value)?.weak {
            out.push(target_key);
        }
    }
    Ok(out)
}

pub fn strong_kinds(set: &RelationSet) -> Vec<u64> {
    let kinds_held: BTreeSet<u64> = set
        .iter()
        .filter(|(_, relation)| !relation.weak)
        .map(|((kind, _), _)| *kind)
        .collect();
    kinds_held.into_iter().collect()
}

fn held_slots(set: &RelationSet) -> Vec<CountedSlot> {
    strong_kinds(set)
        .into_iter()
        .map(CountedSlot::HeldByKind)
        .collect()
}

fn remove_relation(
    writes: &mut LayeredWrites,
    book: u64,
    source: u64,
    kind: u64,
    target_key: &[u8],
    relation: &Relation,
) -> Result<(), StoreError> {
    writes.del(relation_by_target_key(
        book,
        kind,
        target_key,
        &relation.position,
        source,
    ));
    writes.del(relation_of_entry_key(source, kind, target_key));
    change_relation_count(writes, book, kind, target_key, -1)
}

pub fn relations_field_written(
    view: &View,
    out: &mut Out,
    book: u64,
    entity: u64,
    own_key: &EntryKey,
    new: Option<&[u8]>,
) -> Result<(), StoreError> {
    let now = new.map(parse_relations_field).unwrap_or_default();
    let was = relations_of_entry(view, entity)?;
    if now == was {
        return Ok(());
    }
    let mut writes = LayeredWrites::new(view);
    for ((kind, target_key), relation) in &was {
        match now.get(&(*kind, target_key.clone())) {
            Some(now_relation) if now_relation.position == relation.position => {}
            Some(_) => writes.del(relation_by_target_key(
                book,
                *kind,
                target_key,
                &relation.position,
                entity,
            )),
            None => {
                if let Some(deleting) = deletion_in_progress(&writes, book, target_key)? {
                    writes.put(
                        removed_by_deletion_key(book, deleting.entity, entity, *kind),
                        relation.item.clone(),
                    );
                }
                remove_relation(&mut writes, book, entity, *kind, target_key, relation)?;
            }
        }
    }
    for ((kind, target_key), relation) in &now {
        let before = was.get(&(*kind, target_key.clone()));
        if before == Some(relation) {
            continue;
        }
        if before.is_none_or(|before_relation| before_relation.position != relation.position) {
            writes.put(
                relation_by_target_key(book, *kind, target_key, &relation.position, entity),
                Vec::new(),
            );
        }
        writes.put(
            relation_of_entry_key(entity, *kind, target_key),
            relation_value(relation),
        );
        if before.is_none() {
            change_relation_count(&mut writes, book, *kind, target_key, 1)?;
            commit_checks::require_target(&mut writes, book, target_key);
            commit_checks::require_relation_kind(&mut writes, book, *kind);
            if let Some(target) =
                entity_by_key(view, ENTRY, &entry_key(book, &EntryKey::parse(target_key)))?
            {
                writes.del(removed_by_deletion_key(book, target, entity, *kind));
            }
        }
    }
    let (old_held, new_held) = (strong_kinds(&was), strong_kinds(&now));
    let book_tree = order_tree_space(book);
    let order_key = order_key_of_entry(view, entity, own_key)?;
    for kind_id in old_held.iter().filter(|kind_id| !new_held.contains(kind_id)) {
        tree::add_held(
            &mut writes,
            &book_tree,
            &order_key,
            CountedSlot::HeldByKind(*kind_id),
            -1,
        )?;
    }
    for kind_id in new_held.iter().filter(|kind_id| !old_held.contains(kind_id)) {
        tree::add_held(
            &mut writes,
            &book_tree,
            &order_key,
            CountedSlot::HeldByKind(*kind_id),
            1,
        )?;
    }
    writes.finish(out);
    Ok(())
}

pub fn entry_created(
    view: &View,
    out: &mut Out,
    book: u64,
    entity: u64,
    own_key: &EntryKey,
) -> Result<(), StoreError> {
    let target_key = own_key.text();
    let mut writes = LayeredWrites::new(view);
    match deletion_in_progress(view, book, &target_key)? {
        Some(deleting) if deleting.entity == entity => {
            let order_key = tree::order_key(deleting.order_value, entity);
            let book_tree = order_tree_space(book);
            tree::add_held(
                &mut writes,
                &book_tree,
                &order_key,
                CountedSlot::DeletedWhileRelationsTargetIt,
                -1,
            )?;
            for kind in kinds_of_relations_targeting(view, book, &target_key)? {
                tree::add_held(
                    &mut writes,
                    &book_tree,
                    &order_key,
                    CountedSlot::DeletedEntryPlaceForKind(kind),
                    -1,
                )?;
            }
            writes.del(deletion_in_progress_key(book, &target_key));
            writes.del(deletion_in_progress_of_entity_key(entity));
            if order_key != order_key_of_entry(view, entity, own_key)? {
                tree::remove_entry(&mut writes, &book_tree, &order_key, &[])?;
                tree::insert_entry(
                    &mut writes,
                    &book_tree,
                    &order_key_of_entry(view, entity, own_key)?,
                    &[],
                )?;
            }
        }
        Some(_) => {
            return Err(StoreError::Refused(format!(
                "entry {} of book {book} is still being deleted: its key can't be taken yet",
                String::from_utf8_lossy(&target_key)
            )));
        }
        None => tree::insert_entry(
            &mut writes,
            &order_tree_space(book),
            &order_key_of_entry(view, entity, own_key)?,
            &[],
        )?,
    }
    writes.finish(out);
    Ok(())
}

pub fn entry_deleted(
    view: &View,
    out: &mut Out,
    book: u64,
    entity: u64,
    own_key: &EntryKey,
) -> Result<(), StoreError> {
    let was = relations_of_entry(view, entity)?;
    let target_key = own_key.text();
    let book_tree = order_tree_space(book);
    let order_key = order_key_of_entry(view, entity, own_key)?;
    let mut writes = LayeredWrites::new(view);
    for ((kind, own_target_key), relation) in &was {
        remove_relation(&mut writes, book, entity, *kind, own_target_key, relation)?;
    }
    let targeting_kinds = kinds_of_relations_targeting(&writes, book, &target_key)?;
    if targeting_kinds.is_empty() {
        tree::remove_entry(&mut writes, &book_tree, &order_key, &held_slots(&was))?;
    } else {
        for slot in held_slots(&was) {
            tree::add_held(&mut writes, &book_tree, &order_key, slot, -1)?;
        }
        tree::add_held(
            &mut writes,
            &book_tree,
            &order_key,
            CountedSlot::DeletedWhileRelationsTargetIt,
            1,
        )?;
        for kind in targeting_kinds {
            tree::add_held(
                &mut writes,
                &book_tree,
                &order_key,
                CountedSlot::DeletedEntryPlaceForKind(kind),
                1,
            )?;
        }
        let mut in_progress = Vec::new();
        put_u64(&mut in_progress, entity);
        put_u64(&mut in_progress, u64::from_be_bytes(order_key[..8].try_into().expect("8 bytes")));
        writes.put(deletion_in_progress_key(book, &target_key), in_progress);
        let mut of_entity = Vec::new();
        put_u64(&mut of_entity, book);
        put_bytes(&mut of_entity, &target_key);
        writes.put(deletion_in_progress_of_entity_key(entity), of_entity);
    }
    commit_checks::require_target(&mut writes, book, &target_key);
    writes.finish(out);
    Ok(())
}

pub fn deleted_entry_erased(
    view: &View,
    out: &mut Out,
    entity: u64,
) -> Result<(), StoreError> {
    let mut writes = LayeredWrites::new(view);
    if let Some((book, target_key)) = deleted_entry_key_in_progress(view, entity)?
        && let Some(deleting) = deletion_in_progress(view, book, &target_key)?
    {
        let order_key = tree::order_key(deleting.order_value, entity);
        let book_tree = order_tree_space(book);
        let mut slots = vec![CountedSlot::DeletedWhileRelationsTargetIt];
        for kind in kinds_of_relations_targeting(view, book, &target_key)? {
            slots.push(CountedSlot::DeletedEntryPlaceForKind(kind));
        }
        tree::remove_entry(&mut writes, &book_tree, &order_key, &slots)?;
        writes.del(deletion_in_progress_key(book, &target_key));
        writes.del(deletion_in_progress_of_entity_key(entity));
        commit_checks::require_target(&mut writes, book, &target_key);
    }
    writes.finish(out);
    Ok(())
}

pub fn removed_by_deletion_of_erased(
    view: &View,
    out: &mut Out,
    book: u64,
    entity: u64,
) -> Result<(), StoreError> {
    let prefix = removed_by_deletion_prefix(book, entity);
    for (stored_key, _) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
        out.del(stored_key);
    }
    Ok(())
}

pub fn display_index_changed(
    view: &View,
    out: &mut Out,
    book: u64,
    entity: u64,
    own_key: &EntryKey,
    old: Option<f64>,
    new: Option<f64>,
) -> Result<(), StoreError> {
    let (old_order, new_order) = (
        world_order_value(old, own_key),
        world_order_value(new, own_key),
    );
    if old_order == new_order {
        return Ok(());
    }
    let held = held_slots(&relations_of_entry(view, entity)?);
    let book_tree = order_tree_space(book);
    let mut writes = LayeredWrites::new(view);
    tree::remove_entry(
        &mut writes,
        &book_tree,
        &tree::order_key(old_order, entity),
        &held,
    )?;
    tree::insert_entry(
        &mut writes,
        &book_tree,
        &tree::order_key(new_order, entity),
        &held,
    )?;
    writes.finish(out);
    Ok(())
}

pub fn world_order_conversion_step(
    view: &View,
    out: &mut Out,
    after: Option<&[u8]>,
    batch: usize,
) -> Result<Option<Vec<u8>>, StoreError> {
    let prefix = super::library::entity_key_key(ENTRY, b"");
    let prefix = &prefix[..prefix.len() - 2];
    let start = match after {
        Some(after_key) => {
            let mut stored_key = after_key.to_vec();
            stored_key.push(0);
            stored_key
        }
        None => prefix.to_vec(),
    };
    let found = view.scan(&start, &key::prefix_end(prefix), batch)?;
    let mut local = BTreeMap::new();
    for (stored_key, value) in &found {
        let layered_view = view.with_layer(&local);
        let mut read_at = prefix.len();
        let entry_key_bytes = get_bytes(stored_key, &mut read_at)
            .ok_or_else(|| corrupt("an entry key doesn't decode"))?;
        let Some((book, own_key)) =
            super::book_stats::entry_key_of_counted_book(&layered_view, &entry_key_bytes)?
        else {
            continue;
        };
        let entity = super::library::parse_uvarint(value)?;
        let mut derived = Out::default();
        if !tree::holds_entry(
            &layered_view,
            &order_tree_space(book),
            &order_key_of_entry(&layered_view, entity, &own_key)?,
        )? {
            entry_created(&layered_view, &mut derived, book, entity, &own_key)?;
        }
        out.entries.extend(derived.entries.iter().cloned());
        derived.apply(&mut local);
        let layered_view = view.with_layer(&local);
        let json = super::history::json_value(&layered_view, entity, &relations_field())?;
        let mut derived = Out::default();
        relations_field_written(
            &layered_view,
            &mut derived,
            book,
            entity,
            &own_key,
            json.as_deref(),
        )?;
        out.entries.extend(derived.entries.iter().cloned());
        derived.apply(&mut local);
    }
    commit_checks::strip(out);
    Ok((found.len() == batch)
        .then(|| found.last().map(|(stored_key, _)| stored_key.clone()))
        .flatten())
}

struct Item {
    kind: u64,
    target: Vec<u8>,
    relation: Relation,
    span: Range<usize>,
}

fn items_of(json: &[u8]) -> Option<Vec<Item>> {
    let mut parser = Parser {
        bytes: json,
        offset: 0,
    };
    parser.space();
    parser.eat(b'[')?;
    let mut items = Vec::new();
    if parser.eat(b']').is_none() {
        loop {
            parser.space();
            let start = parser.offset;
            let item_value = parser.value(1)?;
            items.push(item_of(item_value, start..parser.offset, &json[start..parser.offset])?);
            if parser.eat(b']').is_some() {
                break;
            }
            parser.eat(b',')?;
        }
    }
    parser.space();
    (parser.offset == json.len()).then_some(items)
}

fn item_of(value: Json, span: Range<usize>, raw: &[u8]) -> Option<Item> {
    let Json::Obj(fields) = value else {
        return None;
    };
    let get = |name: &str| {
        fields
            .iter()
            .find(|(field_name, _)| field_name == name.as_bytes())
            .map(|(_, value)| value)
    };
    let kind = match get("kind") {
        Some(Json::Num(number)) => whole_id(number)?,
        _ => return None,
    };
    let target = match get("target") {
        Some(Json::Str(text)) if !text.is_empty() => EntryKey::parse(text).text(),
        Some(Json::Num(number)) => match EntryKey::parse(number) {
            parsed_key @ EntryKey::Int(_) => parsed_key.text(),
            EntryKey::Text(_) => return None,
        },
        _ => return None,
    };
    let position = match get("position") {
        Some(Json::Str(text)) => text.clone(),
        _ => return None,
    };
    let weak = match get("weak") {
        None => false,
        Some(Json::Bool(flag)) => *flag,
        Some(_) => return None,
    };
    Some(Item {
        kind,
        target,
        relation: Relation {
            position,
            weak,
            item: raw.to_vec(),
        },
        span,
    })
}

pub fn parse_relations_field(json: &[u8]) -> RelationSet {
    let mut set = RelationSet::new();
    for item in items_of(json).unwrap_or_default() {
        set.entry((item.kind, item.target)).or_insert(item.relation);
    }
    set
}

fn json_string(out: &mut Vec<u8>, text: &[u8]) {
    out.push(b'"');
    for &byte in text {
        match byte {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            0..0x20 => out.extend_from_slice(format!("\\u{byte:04x}").as_bytes()),
            _ => out.push(byte),
        }
    }
    out.push(b'"');
}

fn item_json(kind: u64, target: &[u8], relation: &Relation) -> Vec<u8> {
    let mut json = format!("{{\"kind\":{kind},\"target\":").into_bytes();
    match EntryKey::parse(target) {
        EntryKey::Int(number) => json.extend_from_slice(number.to_string().as_bytes()),
        EntryKey::Text(text_key) => json_string(&mut json, &text_key),
    }
    json.extend_from_slice(b",\"position\":");
    json_string(&mut json, &relation.position);
    if relation.weak {
        json.extend_from_slice(b",\"weak\":true");
    }
    json.push(b'}');
    json
}

#[derive(Default)]
struct ItemChange {
    kind: Option<u64>,
    target: Option<Vec<u8>>,
    position: Option<Vec<u8>>,
    weak: Option<bool>,
    added_fields: Vec<Vec<u8>>,
}

fn target_json(target: &[u8]) -> Vec<u8> {
    let mut json = Vec::new();
    match EntryKey::parse(target) {
        EntryKey::Int(number) => json.extend_from_slice(number.to_string().as_bytes()),
        EntryKey::Text(text_key) => json_string(&mut json, &text_key),
    }
    json
}

fn object_fields(object: &[u8]) -> Vec<(Vec<u8>, Range<usize>)> {
    let mut parser = Parser {
        bytes: object,
        offset: 0,
    };
    parser
        .object_fields()
        .expect("a relation that parsed is an object")
}

fn object_rewritten(object: &[u8], change: &ItemChange) -> Vec<u8> {
    let mut parts: Vec<Vec<u8>> = Vec::new();
    let mut weak_written = false;
    let field = |name: &[u8], value: Vec<u8>| {
        let mut out = Vec::new();
        json_string(&mut out, name);
        out.push(b':');
        out.extend_from_slice(&value);
        out
    };
    for (name, span) in object_fields(object) {
        match name.as_slice() {
            b"kind" if change.kind.is_some() => {
                parts.push(field(&name, change.kind.expect("some").to_string().into_bytes()));
            }
            b"target" if change.target.is_some() => {
                parts.push(field(&name, target_json(change.target.as_deref().expect("some"))));
            }
            b"position" if change.position.is_some() => {
                let mut value = Vec::new();
                json_string(&mut value, change.position.as_deref().expect("some"));
                parts.push(field(&name, value));
            }
            b"weak" if change.weak == Some(false) => {}
            b"weak" if change.weak == Some(true) => {
                weak_written = true;
                parts.push(field(&name, b"true".to_vec()));
            }
            _ => parts.push(object[span].to_vec()),
        }
    }
    if change.weak == Some(true) && !weak_written {
        parts.push(br#""weak":true"#.to_vec());
    }
    parts.extend(change.added_fields.iter().cloned());
    let mut out = b"{".to_vec();
    out.extend_from_slice(&parts.join(&b","[..]));
    out.push(b'}');
    out
}

fn item_rewritten(field_json: &[u8], item: &Item, change: &ItemChange) -> Vec<u8> {
    object_rewritten(&field_json[item.span.clone()], change)
}

fn rewritten(
    json: &[u8],
    items: &[Item],
    keep: impl Fn(&Item) -> Option<Option<Vec<u8>>>,
    added: &[Vec<u8>],
) -> Vec<u8> {
    let mut parts: Vec<Vec<u8>> = Vec::new();
    for item in items {
        match keep(item) {
            None => {}
            Some(None) => parts.push(json[item.span.clone()].to_vec()),
            Some(Some(replacement)) => parts.push(replacement),
        }
    }
    parts.extend(added.iter().cloned());
    let mut out = b"[".to_vec();
    out.extend_from_slice(&parts.join(&b","[..]));
    out.push(b']');
    out
}

fn written_field(view: &View, entity: u64) -> Result<Option<Vec<u8>>, StoreError> {
    super::history::json_value(view, entity, &relations_field())
}

fn text_js(text: Option<Vec<u8>>) -> Js {
    text.map_or(Js::Null, Js::Text)
}

fn rewrite_js(source: u64, before: Option<Vec<u8>>, json: Vec<u8>) -> Js {
    Js::Obj(vec![
        ("entity", Js::Big(source)),
        ("before", text_js(before)),
        ("json", Js::Text(json)),
    ])
}

fn chunk_js(rewrites: Vec<Js>, more: bool) -> Js {
    Js::Obj(vec![("rewrites", Js::Arr(rewrites)), ("more", Js::Bool(more))])
}

fn live_entry_field(view: &View, book: u64, entity: u64) -> Result<Option<Vec<u8>>, StoreError> {
    if entry_key_in(view, book, entity)?.is_none() {
        return Ok(None);
    }
    written_field(view, entity)
}

pub fn rewrites_removing_relations_targeting(
    view: &View,
    book: u64,
    keys: &[Vec<u8>],
    limit: usize,
) -> Result<Js, StoreError> {
    let removed: BTreeSet<Vec<u8>> = keys
        .iter()
        .map(|stored_key| EntryKey::parse(stored_key).text())
        .collect();
    let mut sources = BTreeSet::new();
    let mut more = false;
    'targets: for target_key in &removed {
        let prefix = relations_targeting_prefix(book, target_key);
        let mut from = prefix.clone();
        loop {
            let page = view.scan(&from, &key::prefix_end(&prefix), 256)?;
            for (stored_key, _) in &page {
                let (_, source) = kind_and_source_of_relation_targeting(&prefix, stored_key)?;
                if !sources.contains(&source) && sources.len() == limit {
                    more = true;
                    break 'targets;
                }
                sources.insert(source);
            }
            match page.last() {
                Some((last, _)) if page.len() == 256 => {
                    from = last.clone();
                    from.push(0);
                }
                _ => break,
            }
        }
    }
    let mut rewrites = Vec::new();
    for source in sources {
        let Some(before) = written_field(view, source)? else {
            return Err(corrupt("an entry with relations has no relations field"));
        };
        let items = items_of(&before)
            .ok_or_else(|| corrupt("an entry's indexed relations don't parse"))?;
        let json = rewritten(
            &before,
            &items,
            |item| (!removed.contains(&item.target)).then_some(None),
            &[],
        );
        rewrites.push(rewrite_js(source, Some(before), json));
    }
    Ok(chunk_js(rewrites, more))
}

pub fn rewrites_restoring_relations_removed_by_deletion(
    view: &View,
    book: u64,
    restored: u64,
    limit: usize,
) -> Result<Js, StoreError> {
    let Some(restored_key) = entry_key_in(view, book, restored)? else {
        return Ok(chunk_js(Vec::new(), false));
    };
    let restored_key = restored_key.text();
    let prefix = removed_by_deletion_prefix(book, restored);
    let mut by_source: BTreeMap<u64, Vec<(u64, Vec<u8>)>> = BTreeMap::new();
    let mut more = false;
    for (stored_key, item) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
        let (source, kind) = source_and_kind_of_removed_by_deletion(&prefix, &stored_key)?;
        if relation_kind_name(view, book, kind)?.is_none()
            || view
                .get(&relation_of_entry_key(source, kind, &restored_key))?
                .is_some()
            || entry_key_in(view, book, source)?.is_none()
        {
            continue;
        }
        if !by_source.contains_key(&source) && by_source.len() == limit {
            more = true;
            break;
        }
        by_source.entry(source).or_default().push((kind, item));
    }
    let mut rewrites = Vec::new();
    for (source, removed_items) in by_source {
        let before = live_entry_field(view, book, source)?;
        let base = before.clone().unwrap_or_else(|| b"[]".to_vec());
        let Some(items) = items_of(&base) else {
            continue;
        };
        let added: Vec<Vec<u8>> = removed_items
            .iter()
            .map(|(_, item)| {
                object_rewritten(
                    item,
                    &ItemChange {
                        target: Some(restored_key.clone()),
                        ..ItemChange::default()
                    },
                )
            })
            .collect();
        let json = rewritten(&base, &items, |_| Some(None), &added);
        rewrites.push(rewrite_js(source, before, json));
    }
    Ok(chunk_js(rewrites, more))
}

pub fn relation_kind_being_merged_into(
    view: &View,
    book: u64,
    kind: u64,
) -> Result<Option<u64>, StoreError> {
    Ok(text_value(view, book, &relation_kind_merge_field(kind))?
        .and_then(|digits| whole_id(&digits)))
}

pub fn rewrites_merging_relation_kind(
    view: &View,
    book: u64,
    merged: u64,
    into: u64,
    limit: usize,
) -> Result<Js, StoreError> {
    let counts = relation_counts_of_kind_prefix(book, merged);
    let mut sources = BTreeSet::new();
    let mut more = false;
    'targets: for (count_key, _) in view.scan(&counts, &key::prefix_end(&counts), usize::MAX)? {
        let mut read_at = counts.len();
        let target_key = get_bytes(&count_key, &mut read_at)
            .ok_or_else(|| corrupt("a relation count key doesn't decode"))?;
        let prefix = relations_of_kind_targeting_prefix(book, merged, &target_key);
        for (stored_key, _) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
            let (_, source) = position_and_source_of_relation_of_kind_targeting(&prefix, &stored_key)?;
            if !sources.contains(&source) && sources.len() == limit {
                more = true;
                break 'targets;
            }
            sources.insert(source);
        }
    }
    let mut rewrites = Vec::new();
    for source in sources {
        let Some(before) = written_field(view, source)? else {
            return Err(corrupt("an entry with relations has no relations field"));
        };
        let items = items_of(&before)
            .ok_or_else(|| corrupt("an entry's indexed relations don't parse"))?;
        let mut merged_into: BTreeMap<usize, (bool, Vec<Vec<u8>>)> = BTreeMap::new();
        for item in items.iter().filter(|item| item.kind == merged) {
            if let Some(kept) = items
                .iter()
                .find(|kept| kept.kind == into && kept.target == item.target)
            {
                let kept_names: BTreeSet<Vec<u8>> = object_fields(&before[kept.span.clone()])
                    .into_iter()
                    .map(|(name, _)| name)
                    .collect();
                let item_bytes = &before[item.span.clone()];
                let added: Vec<Vec<u8>> = object_fields(item_bytes)
                    .into_iter()
                    .filter(|(name, _)| !kept_names.contains(name))
                    .map(|(_, span)| item_bytes[span].to_vec())
                    .collect();
                let entry = merged_into
                    .entry(kept.span.start)
                    .or_insert((kept.relation.weak, Vec::new()));
                entry.0 = entry.0 && item.relation.weak;
                entry.1.extend(added);
            }
        }
        let json = rewritten(
            &before,
            &items,
            |item| {
                if item.kind == merged {
                    let has_twin = items
                        .iter()
                        .any(|kept| kept.kind == into && kept.target == item.target);
                    return (!has_twin).then(|| {
                        Some(item_rewritten(
                            &before,
                            item,
                            &ItemChange {
                                kind: Some(into),
                                ..ItemChange::default()
                            },
                        ))
                    });
                }
                match merged_into.get(&item.span.start) {
                    Some((weak, added_fields)) => Some(Some(item_rewritten(
                        &before,
                        item,
                        &ItemChange {
                            weak: Some(*weak),
                            added_fields: added_fields.clone(),
                            ..ItemChange::default()
                        },
                    ))),
                    None => Some(None),
                }
            },
            &[],
        );
        rewrites.push(rewrite_js(source, Some(before), json));
    }
    Ok(chunk_js(rewrites, more))
}

pub fn pending_worldbuilding_jobs(view: &View) -> Result<Js, StoreError> {
    let mut deletions = Vec::new();
    let prefix = key::of(DELETION_IN_PROGRESS_BY_ENTITY);
    for (stored_key, value) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
        let mut read_at = prefix.len();
        let entity = get_u64(&stored_key, &mut read_at)
            .ok_or_else(|| corrupt("a deletion in progress doesn't decode"))?;
        let mut read_at = 0;
        let book = get_u64(&value, &mut read_at)
            .ok_or_else(|| corrupt("a deletion in progress doesn't decode"))?;
        let target_key = get_bytes(&value, &mut read_at)
            .ok_or_else(|| corrupt("a deletion in progress doesn't decode"))?;
        deletions.push(Js::Obj(vec![
            ("book", Js::Big(book)),
            ("entity", Js::Big(entity)),
            ("key", Js::Text(target_key)),
        ]));
    }
    let mut restorations = Vec::new();
    let prefix = key::of(RELATIONS_REMOVED_BY_DELETION);
    let mut from = prefix.clone();
    while let Some((stored_key, _)) = view.scan(&from, &key::prefix_end(&prefix), 1)?.pop() {
        let mut read_at = prefix.len();
        let bad = || corrupt("a relation removed by a deletion doesn't decode");
        let book = get_u64(&stored_key, &mut read_at).ok_or_else(bad)?;
        let deleted = get_u64(&stored_key, &mut read_at).ok_or_else(bad)?;
        if entry_key_in(view, book, deleted)?.is_some() {
            restorations.push(Js::Obj(vec![
                ("book", Js::Big(book)),
                ("entity", Js::Big(deleted)),
            ]));
        }
        from = key::prefix_end(&removed_by_deletion_prefix(book, deleted));
    }
    let mut merges = Vec::new();
    let prefix = key::of(KINDS_BEING_MERGED);
    for (stored_key, value) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
        let mut read_at = prefix.len();
        let bad = || corrupt("a kind being merged doesn't decode");
        let book = get_u64(&stored_key, &mut read_at).ok_or_else(bad)?;
        let merged = get_u64(&stored_key, &mut read_at).ok_or_else(bad)?;
        let into = get_u64(&value, &mut 0).ok_or_else(bad)?;
        merges.push(Js::Obj(vec![
            ("book", Js::Big(book)),
            ("kind", Js::Num(merged as f64)),
            ("into", Js::Num(into as f64)),
        ]));
    }
    Ok(Js::Obj(vec![
        ("deletions", Js::Arr(deletions)),
        ("restorations", Js::Arr(restorations)),
        ("merges", Js::Arr(merges)),
    ]))
}

pub fn some_kind_is_being_merged_into(view: &View, book: u64, into: u64) -> Result<bool, StoreError> {
    let prefix = key::id(KINDS_BEING_MERGED, book);
    for (_, value) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
        if get_u64(&value, &mut 0) == Some(into) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn kind_being_merged_key(book: u64, kind: u64) -> Vec<u8> {
    let mut stored_key = key::id(KINDS_BEING_MERGED, book);
    put_u64(&mut stored_key, kind);
    stored_key
}

pub fn kind_being_merged_value(into: u64) -> Vec<u8> {
    let mut value = Vec::new();
    put_u64(&mut value, into);
    value
}

pub fn relations_kept(view: &View, book: u64, entity: u64) -> Result<Js, StoreError> {
    let Some(before) = written_field(view, entity)? else {
        return Ok(Js::Null);
    };
    let Some(items) = items_of(&before) else {
        return Ok(Js::Null);
    };
    let mut drop = Vec::new();
    for item in &items {
        let target = entity_by_key(
            view,
            ENTRY,
            &entry_key(book, &EntryKey::parse(&item.target)),
        )?;
        drop.push(target.is_none() || relation_kind_name(view, book, item.kind)?.is_none());
    }
    if !drop.iter().any(|dropped| *dropped) {
        return Ok(Js::Null);
    }
    let kept: BTreeSet<usize> = items
        .iter()
        .zip(&drop)
        .filter(|(_, dropped)| !**dropped)
        .map(|(item, _)| item.span.start)
        .collect();
    let json = rewritten(
        &before,
        &items,
        |item| kept.contains(&item.span.start).then_some(None),
        &[],
    );
    Ok(Js::Obj(vec![
        ("before", Js::Text(before)),
        ("json", Js::Text(json)),
    ]))
}

#[derive(Debug, Clone)]
pub enum RelationChange {
    Add { weak: bool },
    Move { new_target: u64 },
    Remove,
    SetWeak(bool),
}

#[derive(Debug, Clone)]
pub struct RelationEdit {
    pub entry: u64,
    pub kind: u64,
    pub target: u64,
    pub change: RelationChange,
    pub after: Option<u64>,
    pub before: Option<u64>,
}

fn refusal(why: impl Into<String>) -> Js {
    Js::Obj(vec![("refused", Js::Text(why.into().into_bytes()))])
}

fn entry_key_in(view: &View, book: u64, entity: u64) -> Result<Option<EntryKey>, StoreError> {
    Ok(match entity_info(view, entity)? {
        Some((ENTRY, stored_key, _)) => match books::parse_entry_key(&stored_key)? {
            (entry_book, own_key) if entry_book == book => Some(own_key),
            _ => None,
        },
        _ => None,
    })
}

const POSITION_DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

pub fn position_between(low: Option<&[u8]>, high: Option<&[u8]>) -> Option<Vec<u8>> {
    if let (Some(low_byte), Some(high_byte)) = (low, high)
        && low_byte >= high_byte
    {
        return None;
    }
    let low = low.unwrap_or(b"");
    let mut out = Vec::new();
    let (mut lo_bound, mut hi_bound) = (true, high.is_some());
    for index in 0.. {
        let low_byte = if lo_bound {
            low.get(index).copied()
        } else {
            None
        };
        let high_byte: u16 = if hi_bound {
            u16::from(*high.expect("bound").get(index)?)
        } else {
            0x100
        };
        let boundary = |byte_value: Option<u8>| {
            byte_value.is_none_or(|byte_value| !(0x80..0xc0).contains(&byte_value))
        };
        let at_boundary =
            (!lo_bound || boundary(low_byte)) && (!hi_bound || boundary(Some(high_byte as u8)));
        let fits: Vec<u8> = POSITION_DIGITS
            .iter()
            .copied()
            .filter(|candidate| {
                low_byte.is_none_or(|low_byte| *candidate > low_byte)
                    && u16::from(*candidate) < high_byte
            })
            .collect();
        if at_boundary && !fits.is_empty() {
            out.push(fits[fits.len() / 2]);
            return Some(out);
        }
        let below = (u16::from(low_byte.unwrap_or(0)) + 1..high_byte.min(0x80))
            .map(|candidate| candidate as u8)
            .next_back();
        if at_boundary && let Some(candidate) = below {
            out.push(candidate);
            return Some(out);
        }
        match low_byte {
            Some(low_byte) => {
                out.push(low_byte);
                hi_bound = hi_bound && u16::from(low_byte) == high_byte;
            }
            None if at_boundary && high_byte == 1 => {
                out.push(0);
                (lo_bound, hi_bound) = (false, false);
            }
            None => return None,
        }
    }
    unreachable!("the loop returns")
}

fn neighbour_positions(
    view: &View,
    prefix: &[u8],
    moving: u64,
    after: Option<u64>,
    before: Option<u64>,
    position_of: impl Fn(u64) -> Result<Option<Vec<u8>>, StoreError>,
) -> Result<Result<(Option<Vec<u8>>, Option<Vec<u8>>), String>, StoreError> {
    let end = key::prefix_end(prefix);
    let others =
        |start: Vec<u8>, stop: Vec<u8>, reverse: bool| -> Result<Option<Vec<u8>>, StoreError> {
            let found = if reverse {
                view.scan_vals_rev(&start, &stop, 2)?
            } else {
                view.scan_vals(&start, &stop, 2)?
            };
            for (stored_key, _) in found {
                let (position, source) = position_and_source_of_relation_of_kind_targeting(prefix, &stored_key)?;
                if source != moving {
                    return Ok(Some(position));
                }
            }
            Ok(None)
        };
    let key_of = |neighbour: u64, position: &[u8]| {
        let mut stored_key = prefix.to_vec();
        put_bytes(&mut stored_key, position);
        put_u64(&mut stored_key, neighbour);
        stored_key
    };
    let read_at = |neighbour: u64| -> Result<Result<Vec<u8>, String>, StoreError> {
        if neighbour == moving {
            return Ok(Err("An entry can't be placed next to itself.".into()));
        }
        Ok(position_of(neighbour)?.ok_or_else(|| format!("Entry {neighbour} has no relation of this kind to this target.")))
    };
    Ok(Ok(match (after, before) {
        (None, None) => (others(prefix.to_vec(), end, true)?, None),
        (Some(after_neighbour), None) => {
            let after_position = match read_at(after_neighbour)? {
                Ok(position) => position,
                Err(why) => return Ok(Err(why)),
            };
            let mut from = key_of(after_neighbour, &after_position);
            from.push(0);
            (Some(after_position), others(from, end, false)?)
        }
        (None, Some(before_neighbour)) => {
            let before_position = match read_at(before_neighbour)? {
                Ok(position) => position,
                Err(why) => return Ok(Err(why)),
            };
            (
                others(
                    prefix.to_vec(),
                    key_of(before_neighbour, &before_position),
                    true,
                )?,
                Some(before_position),
            )
        }
        (Some(after_neighbour), Some(before_neighbour)) => {
            let (after_position, before_position) =
                match (read_at(after_neighbour)?, read_at(before_neighbour)?) {
                    (Ok(after_position), Ok(before_position)) => (after_position, before_position),
                    (Err(why), _) | (_, Err(why)) => return Ok(Err(why)),
                };
            if key_of(after_neighbour, &after_position) >= key_of(before_neighbour, &before_position) {
                return Ok(Err(
                    "The entry to go after comes after the one to go before.".into(),
                ));
            }
            (Some(after_position), Some(before_position))
        }
    }))
}

pub fn relation_edit(view: &View, book: u64, edit: &RelationEdit) -> Result<Js, StoreError> {
    let Some(_) = entry_key_in(view, book, edit.entry)? else {
        return Ok(refusal("That entry isn't in this world."));
    };
    if relation_kind_name(view, book, edit.kind)?.is_none() {
        return Ok(refusal("This world has no such relation kind."));
    }
    if matches!(edit.change, RelationChange::Add { .. })
        && relation_kind_being_merged_into(view, book, edit.kind)?.is_some()
    {
        return Ok(refusal(
            "This relation kind is being merged into another; pick that one.",
        ));
    }
    let Some(target) = entry_key_in(view, book, edit.target)? else {
        return Ok(refusal("The target isn't an entry of this world."));
    };
    let target = target.text();
    let before = written_field(view, edit.entry)?;
    if before.is_none() && text_value(view, edit.entry, &relations_field())?.is_some() {
        return Ok(refusal(
            "This entry's relations field holds something else; it isn't changed.",
        ));
    }
    let items = match &before {
        None => Vec::new(),
        Some(written) => match items_of(written) {
            Some(item) => item,
            None => {
                return Ok(refusal(
                    "This entry's relations field holds something else; it isn't changed.",
                ));
            }
        },
    };
    let pos_of = |kind: u64, target_key: &[u8]| {
        items
            .iter()
            .find(|item| item.kind == kind && item.target == target_key)
            .map(|item| item.relation.clone())
    };
    let current = pos_of(edit.kind, &target);
    let placed = |target_key: &[u8]| -> Result<Result<Vec<u8>, String>, StoreError> {
        let prefix = relations_of_kind_targeting_prefix(book, edit.kind, target_key);
        let target_key = target_key.to_vec();
        let found = neighbour_positions(
            view,
            &prefix,
            edit.entry,
            edit.after,
            edit.before,
            |neighbour| {
                Ok(
                    relation_of_entry_stored(view, neighbour, edit.kind, &target_key)?
                        .map(|relation| relation.position),
                )
            },
        )?;
        Ok(found.map(|(low, high)| {
            position_between(low.as_deref(), high.as_deref())
                .or(low.clone())
                .or(high.clone())
                .unwrap_or_default()
        }))
    };
    let base = before.clone().unwrap_or_else(|| b"[]".to_vec());
    let same = |item: &Item| item.kind == edit.kind && item.target == target;
    let json = match &edit.change {
        RelationChange::Add { weak } => {
            if current.is_some() {
                return Ok(refusal("The entry already has that relation."));
            }
            let position = match placed(&target)? {
                Ok(position) => position,
                Err(why) => return Ok(refusal(why)),
            };
            let replacement = item_json(
                edit.kind,
                &target,
                &Relation {
                    position,
                    weak: *weak,
                    item: Vec::new(),
                },
            );
            rewritten(&base, &items, |_| Some(None), &[replacement])
        }
        RelationChange::Remove => {
            if current.is_none() {
                return Ok(refusal("The entry has no such relation."));
            }
            rewritten(&base, &items, |item| (!same(item)).then_some(None), &[])
        }
        RelationChange::SetWeak(weak) => {
            if current.is_none() {
                return Ok(refusal("The entry has no such relation."));
            }
            let change = ItemChange {
                weak: Some(*weak),
                ..ItemChange::default()
            };
            rewritten(
                &base,
                &items,
                |item| Some(same(item).then(|| item_rewritten(&base, item, &change))),
                &[],
            )
        }
        RelationChange::Move { new_target } => {
            if current.is_none() {
                return Ok(refusal("The entry has no such relation."));
            }
            let Some(new_target_key) = entry_key_in(view, book, *new_target)? else {
                return Ok(refusal("The new target isn't an entry of this world."));
            };
            let new_target_key = new_target_key.text();
            if new_target_key != target && pos_of(edit.kind, &new_target_key).is_some() {
                return Ok(refusal("The entry already has that relation."));
            }
            let position = match placed(&new_target_key)? {
                Ok(position) => position,
                Err(why) => return Ok(refusal(why)),
            };
            let change = ItemChange {
                target: Some(new_target_key),
                position: Some(position),
                ..ItemChange::default()
            };
            rewritten(
                &base,
                &items,
                |item| Some(same(item).then(|| item_rewritten(&base, item, &change))),
                &[],
            )
        }
    };
    Ok(Js::Obj(vec![
        ("before", text_js(before)),
        ("json", Js::Text(json)),
    ]))
}

fn relation_of_entry_stored(
    view: &View,
    entity: u64,
    kind: u64,
    target_key: &[u8],
) -> Result<Option<Relation>, StoreError> {
    view.get(&relation_of_entry_key(entity, kind, target_key))?
        .map(|stored| relation_of_value(&stored))
        .transpose()
}

pub struct UnreachedLoop {
    pub entry: u64,
    pub kind: u64,
    pub entries: Vec<u64>,
}

pub fn unreached_among(
    view: &View,
    book: u64,
    changed: &[u64],
    limit: usize,
) -> Result<Vec<UnreachedLoop>, StoreError> {
    let mut known_reached: BTreeSet<(u64, u64)> = BTreeSet::new();
    let mut known_unreached: BTreeSet<(u64, u64)> = BTreeSet::new();
    let mut visits = 0;
    let mut found_loops = Vec::new();
    for &entry in changed {
        if entry_key_in(view, book, entry)?.is_none() {
            continue;
        }
        for kind in strong_kinds(&relations_of_entry(view, entry)?) {
            if known_reached.contains(&(kind, entry)) || known_unreached.contains(&(kind, entry)) {
                continue;
            }
            let mut seen = BTreeSet::from([entry]);
            let mut walked = vec![entry];
            let mut next = 0;
            let mut reached = false;
            while next < walked.len() && !reached {
                let visiting = walked[next];
                next += 1;
                visits += 1;
                if visits > limit {
                    return Ok(found_loops);
                }
                if visiting != entry && known_unreached.contains(&(kind, visiting)) {
                    continue;
                }
                let held_by = strong_relations_of_kind(view, visiting, kind)?;
                if held_by.is_empty() || known_reached.contains(&(kind, visiting)) {
                    reached = true;
                    break;
                }
                for target_key in held_by {
                    let Some(target) = entity_by_key(
                        view,
                        ENTRY,
                        &entry_key(book, &EntryKey::parse(&target_key)),
                    )?
                    else {
                        if deletion_in_progress(view, book, &target_key)?.is_some() {
                            reached = true;
                        }
                        continue;
                    };
                    if seen.insert(target) {
                        walked.push(target);
                    }
                }
            }
            if reached {
                known_reached.insert((kind, entry));
            } else {
                known_unreached.extend(walked.iter().map(|walked_entry| (kind, *walked_entry)));
                found_loops.push(UnreachedLoop {
                    entry,
                    kind,
                    entries: walked,
                });
            }
        }
    }
    Ok(found_loops)
}

#[derive(Debug, Clone, PartialEq)]
enum Json {
    Null,
    Bool(bool),
    Num(Vec<u8>),
    Str(Vec<u8>),
    Arr(Vec<Json>),
    Obj(Vec<(Vec<u8>, Json)>),
}

const MAX_DEPTH: usize = 64;

struct Parser<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl Parser<'_> {
    fn space(&mut self) {
        while matches!(
            self.bytes.get(self.offset),
            Some(b' ' | b'\t' | b'\n' | b'\r')
        ) {
            self.offset += 1;
        }
    }

    fn eat(&mut self, expected: u8) -> Option<()> {
        self.space();
        (self.bytes.get(self.offset) == Some(&expected)).then(|| self.offset += 1)
    }

    fn word(&mut self, word_bytes: &[u8]) -> Option<()> {
        self.bytes[self.offset..]
            .starts_with(word_bytes)
            .then(|| self.offset += word_bytes.len())
    }

    fn object_fields(&mut self) -> Option<Vec<(Vec<u8>, Range<usize>)>> {
        self.eat(b'{')?;
        let mut fields = Vec::new();
        if self.eat(b'}').is_some() {
            return Some(fields);
        }
        loop {
            self.space();
            let start = self.offset;
            let name = self.string()?;
            self.eat(b':')?;
            self.value(1)?;
            fields.push((name, start..self.offset));
            if self.eat(b'}').is_some() {
                return Some(fields);
            }
            self.eat(b',')?;
        }
    }

    fn value(&mut self, depth: usize) -> Option<Json> {
        if depth > MAX_DEPTH {
            return None;
        }
        self.space();
        match *self.bytes.get(self.offset)? {
            b'n' => self.word(b"null").map(|()| Json::Null),
            b't' => self.word(b"true").map(|()| Json::Bool(true)),
            b'f' => self.word(b"false").map(|()| Json::Bool(false)),
            b'"' => self.string().map(Json::Str),
            b'[' => {
                self.offset += 1;
                let mut items = Vec::new();
                if self.eat(b']').is_some() {
                    return Some(Json::Arr(items));
                }
                loop {
                    items.push(self.value(depth + 1)?);
                    if self.eat(b']').is_some() {
                        return Some(Json::Arr(items));
                    }
                    self.eat(b',')?;
                }
            }
            b'{' => {
                self.offset += 1;
                let mut fields = Vec::new();
                if self.eat(b'}').is_some() {
                    return Some(Json::Obj(fields));
                }
                loop {
                    self.space();
                    let field_name = self.string()?;
                    self.eat(b':')?;
                    fields.push((field_name, self.value(depth + 1)?));
                    if self.eat(b'}').is_some() {
                        return Some(Json::Obj(fields));
                    }
                    self.eat(b',')?;
                }
            }
            _ => self.number().map(Json::Num),
        }
    }

    fn number(&mut self) -> Option<Vec<u8>> {
        let start = self.offset;
        if self.bytes.get(self.offset) == Some(&b'-') {
            self.offset += 1;
        }
        let digits = |parser: &mut Self| {
            let digits_start = parser.offset;
            while parser
                .bytes
                .get(parser.offset)
                .is_some_and(u8::is_ascii_digit)
            {
                parser.offset += 1;
            }
            parser.offset > digits_start
        };
        if self.bytes.get(self.offset) == Some(&b'0') {
            self.offset += 1;
        } else if !digits(self) {
            return None;
        }
        if self.bytes.get(self.offset) == Some(&b'.') {
            self.offset += 1;
            if !digits(self) {
                return None;
            }
        }
        if matches!(self.bytes.get(self.offset), Some(b'e' | b'E')) {
            self.offset += 1;
            if matches!(self.bytes.get(self.offset), Some(b'+' | b'-')) {
                self.offset += 1;
            }
            if !digits(self) {
                return None;
            }
        }
        Some(self.bytes[start..self.offset].to_vec())
    }

    fn hex4(&mut self) -> Option<u32> {
        let hex = self.bytes.get(self.offset..self.offset + 4)?;
        self.offset += 4;
        u32::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()
    }

    fn string(&mut self) -> Option<Vec<u8>> {
        if self.bytes.get(self.offset) != Some(&b'"') {
            return None;
        }
        self.offset += 1;
        let mut out = Vec::new();
        loop {
            let expected = *self.bytes.get(self.offset)?;
            self.offset += 1;
            match expected {
                b'"' => return std::str::from_utf8(&out).is_ok().then_some(out),
                b'\\' => {
                    let escaped = *self.bytes.get(self.offset)?;
                    self.offset += 1;
                    let character = match escaped {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let high_surrogate = self.hex4()?;
                            let code_point = if (0xd800..0xdc00).contains(&high_surrogate) {
                                self.word(b"\\u")?;
                                let low_surrogate = self.hex4()?;
                                if !(0xdc00..0xe000).contains(&low_surrogate) {
                                    return None;
                                }
                                0x10000
                                    + ((high_surrogate - 0xd800) << 10)
                                    + (low_surrogate - 0xdc00)
                            } else {
                                high_surrogate
                            };
                            char::from_u32(code_point)?
                        }
                        _ => return None,
                    };
                    let mut utf8_buffer = [0; 4];
                    out.extend_from_slice(character.encode_utf8(&mut utf8_buffer).as_bytes());
                }
                0..0x20 => return None,
                _ => out.push(expected),
            }
        }
    }
}
