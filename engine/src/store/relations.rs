use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use super::StoreError;
use super::books::{self, ENTRY, EntryKey, entry_key};
use super::chat_read::Js;
use super::commit_checks;
use super::derive::{Out, View};
use super::kinds::{key, text_value};
use super::library::{entity_by_key, entity_info};
use super::world_order_tree::{self as tree, LayeredWrites, OrderKey, ReadDerived};
use crate::keyspace::val::{counter_value, get_bytes, get_u64, put_bytes, put_u64};
use crate::log::format::FieldRef;

pub const RELATIONS_OF_ENTRY: u64 = 228;
pub const MEMBERS_BY_TARGET: u64 = 229;
pub const MEMBER_COUNT: u64 = 230;

pub const RELATIONS_FIELD: &[u8] = b"\x01relations";
pub const RELATION_KIND_FIELD_PREFIX: &[u8] = b"\x01relationKind:";

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
    value.extend_from_slice(&relation.position);
    value
}

fn relation_of_value(stored: &[u8]) -> Result<Relation, StoreError> {
    match stored.split_first() {
        Some((&weak_byte, position)) if weak_byte <= 1 => Ok(Relation {
            position: position.to_vec(),
            weak: weak_byte == 1,
        }),
        _ => Err(corrupt("a relation's value doesn't decode")),
    }
}

pub fn pointing_at_prefix(book: u64, target_key: &[u8]) -> Vec<u8> {
    let mut stored_key = key::id(MEMBERS_BY_TARGET, book);
    put_bytes(&mut stored_key, target_key);
    stored_key
}

pub fn group_members_prefix(book: u64, kind: u64, target_key: &[u8]) -> Vec<u8> {
    let mut stored_key = pointing_at_prefix(book, target_key);
    put_u64(&mut stored_key, kind);
    stored_key
}

fn member_key(book: u64, kind: u64, target_key: &[u8], position: &[u8], entity: u64) -> Vec<u8> {
    let mut stored_key = group_members_prefix(book, kind, target_key);
    put_bytes(&mut stored_key, position);
    put_u64(&mut stored_key, entity);
    stored_key
}

pub fn member_of_group_key(prefix: &[u8], stored_key: &[u8]) -> Result<(Vec<u8>, u64), StoreError> {
    let mut read_at = prefix.len();
    let bad = || corrupt("a member key doesn't decode");
    let position = get_bytes(stored_key, &mut read_at).ok_or_else(bad)?;
    let entity = get_u64(stored_key, &mut read_at).ok_or_else(bad)?;
    Ok((position, entity))
}

fn member_of_pointing_key(prefix: &[u8], stored_key: &[u8]) -> Result<u64, StoreError> {
    let mut read_at = prefix.len();
    let bad = || corrupt("a member key doesn't decode");
    get_u64(stored_key, &mut read_at).ok_or_else(bad)?;
    get_bytes(stored_key, &mut read_at).ok_or_else(bad)?;
    get_u64(stored_key, &mut read_at).ok_or_else(bad)
}

fn kind_prefix_of_counts(book: u64, kind: u64) -> Vec<u8> {
    let mut stored_key = key::id(MEMBER_COUNT, book);
    put_u64(&mut stored_key, kind);
    stored_key
}

pub fn member_count_key(book: u64, kind: u64, target_key: &[u8]) -> Vec<u8> {
    let mut stored_key = kind_prefix_of_counts(book, kind);
    put_bytes(&mut stored_key, target_key);
    stored_key
}

pub fn member_count(
    reader: &impl ReadDerived,
    book: u64,
    kind: u64,
    target_key: &[u8],
) -> Result<u64, StoreError> {
    match reader.read(&member_count_key(book, kind, target_key))? {
        Some(stored) => counter_value(&stored)
            .and_then(|count| u64::try_from(count).ok())
            .ok_or_else(|| corrupt("a member count doesn't decode")),
        None => Ok(0),
    }
}

fn any_under(view: &View, prefix: &[u8]) -> Result<bool, StoreError> {
    Ok(!view.scan(prefix, &key::prefix_end(prefix), 1)?.is_empty())
}

pub fn anything_points_at(view: &View, book: u64, target_key: &[u8]) -> Result<bool, StoreError> {
    any_under(view, &pointing_at_prefix(book, target_key))
}

pub fn relation_kind_in_use(view: &View, book: u64, kind: u64) -> Result<bool, StoreError> {
    any_under(view, &kind_prefix_of_counts(book, kind))
}

fn count_by(
    writes: &mut LayeredWrites,
    book: u64,
    kind: u64,
    target_key: &[u8],
    change: i64,
) -> Result<(), StoreError> {
    let count_key = member_count_key(book, kind, target_key);
    if member_count(writes, book, kind, target_key)? as i64 + change == 0 {
        writes.del(count_key);
    } else {
        writes.add(count_key, change);
    }
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
        let pair = (*kind, target_key.clone());
        match now.get(&pair) {
            Some(now_relation) if now_relation.position == relation.position => continue,
            Some(_) => writes.del(member_key(
                book,
                *kind,
                target_key,
                &relation.position,
                entity,
            )),
            None => {
                writes.del(member_key(
                    book,
                    *kind,
                    target_key,
                    &relation.position,
                    entity,
                ));
                count_by(&mut writes, book, *kind, target_key, -1)?;
                writes.del(relation_of_entry_key(entity, *kind, target_key));
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
                member_key(book, *kind, target_key, &relation.position, entity),
                Vec::new(),
            );
        }
        writes.put(
            relation_of_entry_key(entity, *kind, target_key),
            relation_value(relation),
        );
        if before.is_none() {
            count_by(&mut writes, book, *kind, target_key, 1)?;
            commit_checks::require_target(&mut writes, book, target_key);
            commit_checks::require_relation_kind(&mut writes, book, *kind);
        }
    }
    let (old_held, new_held) = (strong_kinds(&was), strong_kinds(&now));
    let book_tree = order_tree_space(book);
    let order_key = order_key_of_entry(view, entity, own_key)?;
    for kind_id in old_held
        .iter()
        .filter(|kind_id| !new_held.contains(kind_id))
    {
        tree::add_held(&mut writes, &book_tree, &order_key, *kind_id, -1)?;
    }
    for kind_id in new_held
        .iter()
        .filter(|kind_id| !old_held.contains(kind_id))
    {
        tree::add_held(&mut writes, &book_tree, &order_key, *kind_id, 1)?;
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
    let mut writes = LayeredWrites::new(view);
    tree::insert_entry(
        &mut writes,
        &order_tree_space(book),
        &order_key_of_entry(view, entity, own_key)?,
        &[],
    )?;
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
    let mut writes = LayeredWrites::new(view);
    tree::remove_entry(
        &mut writes,
        &order_tree_space(book),
        &order_key_of_entry(view, entity, own_key)?,
        &strong_kinds(&was),
    )?;
    for ((kind, target_key), relation) in &was {
        writes.del(member_key(
            book,
            *kind,
            target_key,
            &relation.position,
            entity,
        ));
        count_by(&mut writes, book, *kind, target_key, -1)?;
        writes.del(relation_of_entry_key(entity, *kind, target_key));
    }
    commit_checks::require_target(&mut writes, book, &own_key.text());
    writes.finish(out);
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
    let held = strong_kinds(&relations_of_entry(view, entity)?);
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
            items.push(item_of(item_value, start..parser.offset)?);
            if parser.eat(b']').is_some() {
                break;
            }
            parser.eat(b',')?;
        }
    }
    parser.space();
    (parser.offset == json.len()).then_some(items)
}

fn item_of(value: Json, span: Range<usize>) -> Option<Item> {
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
            field_name @ EntryKey::Int(_) => field_name.text(),
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
        relation: Relation { position, weak },
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

pub fn relations_without(view: &View, book: u64, keys: &[Vec<u8>]) -> Result<Js, StoreError> {
    let gone: BTreeSet<Vec<u8>> = keys
        .iter()
        .map(|stored_key| EntryKey::parse(stored_key).text())
        .collect();
    let mut pointers = BTreeSet::new();
    for target_key in &gone {
        let prefix = pointing_at_prefix(book, target_key);
        for (stored_key, _) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
            pointers.insert(member_of_pointing_key(&prefix, &stored_key)?);
        }
    }
    let mut out = Vec::new();
    for pointer in pointers {
        let Some(before) = written_field(view, pointer)? else {
            return Err(corrupt("a member has no relations field"));
        };
        let items = items_of(&before).ok_or_else(|| corrupt("a member's relations don't parse"))?;
        let json = rewritten(
            &before,
            &items,
            |item| (!gone.contains(&item.target)).then_some(None),
            &[],
        );
        out.push(Js::Obj(vec![
            ("entity", Js::Big(pointer)),
            ("before", Js::Text(before)),
            ("json", Js::Text(json)),
        ]));
    }
    Ok(Js::Arr(out))
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
                let (position, member) = member_of_group_key(prefix, &stored_key)?;
                if member != moving {
                    return Ok(Some(position));
                }
            }
            Ok(None)
        };
    let key_of = |member: u64, position: &[u8]| {
        let mut stored_key = prefix.to_vec();
        put_bytes(&mut stored_key, position);
        put_u64(&mut stored_key, member);
        stored_key
    };
    let read_at = |member: u64| -> Result<Result<Vec<u8>, String>, StoreError> {
        if member == moving {
            return Ok(Err("An entry can't be placed next to itself.".into()));
        }
        Ok(position_of(member)?.ok_or_else(|| format!("Entry {member} isn't in that group.")))
    };
    Ok(Ok(match (after, before) {
        (None, None) => (others(prefix.to_vec(), end, true)?, None),
        (Some(after_member), None) => {
            let after_position = match read_at(after_member)? {
                Ok(position) => position,
                Err(why) => return Ok(Err(why)),
            };
            let mut from = key_of(after_member, &after_position);
            from.push(0);
            (Some(after_position), others(from, end, false)?)
        }
        (None, Some(before_member)) => {
            let before_position = match read_at(before_member)? {
                Ok(position) => position,
                Err(why) => return Ok(Err(why)),
            };
            (
                others(
                    prefix.to_vec(),
                    key_of(before_member, &before_position),
                    true,
                )?,
                Some(before_position),
            )
        }
        (Some(after_member), Some(before_member)) => {
            let (after_position, before_position) =
                match (read_at(after_member)?, read_at(before_member)?) {
                    (Ok(after_position), Ok(before_position)) => (after_position, before_position),
                    (Err(why), _) | (_, Err(why)) => return Ok(Err(why)),
                };
            if key_of(after_member, &after_position) >= key_of(before_member, &before_position) {
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
        let prefix = group_members_prefix(book, edit.kind, target_key);
        let target_key = target_key.to_vec();
        let found = neighbour_positions(
            view,
            &prefix,
            edit.entry,
            edit.after,
            edit.before,
            |member| {
                Ok(
                    relation_of_entry_stored(view, member, edit.kind, &target_key)?
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
            let Some(relation) = current else {
                return Ok(refusal("The entry has no such relation."));
            };
            let replacement = item_json(
                edit.kind,
                &target,
                &Relation {
                    weak: *weak,
                    ..relation
                },
            );
            rewritten(
                &base,
                &items,
                |item| Some(same(item).then(|| replacement.clone())),
                &[],
            )
        }
        RelationChange::Move { new_target } => {
            let Some(relation) = current else {
                return Ok(refusal("The entry has no such relation."));
            };
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
            let replacement = item_json(
                edit.kind,
                &new_target_key,
                &Relation {
                    position,
                    weak: relation.weak,
                },
            );
            rewritten(
                &base,
                &items,
                |item| Some(same(item).then(|| replacement.clone())),
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

pub fn unreached_from(
    view: &View,
    book: u64,
    entity: u64,
    kind: u64,
    limit: usize,
) -> Result<Option<Vec<u64>>, StoreError> {
    let mut seen = BTreeSet::from([entity]);
    let mut found = vec![entity];
    let mut next = 0;
    while next < found.len() {
        let visiting = found[next];
        next += 1;
        let held_by = strong_relations_of_kind(view, visiting, kind)?;
        if held_by.is_empty() {
            return Ok(None);
        }
        for target_key in held_by {
            let Some(target) =
                entity_by_key(view, ENTRY, &entry_key(book, &EntryKey::parse(&target_key)))?
            else {
                continue;
            };
            if seen.insert(target) {
                if seen.len() > limit {
                    return Ok(None);
                }
                found.push(target);
            }
        }
    }
    Ok(Some(found))
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
