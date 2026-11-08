use std::collections::BTreeMap;

use super::StoreError;
use super::derive::{AddMapKind, Out, View, apply};
use super::kinds::key;
use crate::keyspace::Entries;
use crate::keyspace::val::{Val, map_counts, put_u64};

pub const ORDER_TREE_EDGE: u64 = 225;
pub const ORDER_TREE_COUNT: AddMapKind = AddMapKind::new(226);
pub const ORDER_TREE_HELD: AddMapKind = AddMapKind::new(227);

pub const ORDER_KEY_BYTES: usize = 16;
pub type OrderKey = [u8; ORDER_KEY_BYTES];

fn corrupt(why: &str) -> StoreError {
    StoreError::Entry(format!("world order tree: {why}"))
}

pub fn order_key(order: u64, entity: u64) -> OrderKey {
    let mut entry = [0; ORDER_KEY_BYTES];
    entry[..8].copy_from_slice(&order.to_be_bytes());
    entry[8..].copy_from_slice(&entity.to_be_bytes());
    entry
}

pub fn entity_of_order_key(entry: &OrderKey) -> u64 {
    u64::from_be_bytes(entry[8..].try_into().expect("8 bytes"))
}

pub trait ReadDerived {
    fn read(&self, stored_key: &[u8]) -> Result<Option<Vec<u8>>, StoreError>;
    fn read_under(&self, prefix: &[u8]) -> Result<Entries, StoreError>;
    fn read_first_in(&self, start: &[u8], end: &[u8]) -> Result<Option<(Vec<u8>, Vec<u8>)>, StoreError>;

    fn read_first_under(&self, prefix: &[u8]) -> Result<Option<(Vec<u8>, Vec<u8>)>, StoreError> {
        self.read_first_in(prefix, &key::prefix_end(prefix))
    }
}

impl ReadDerived for View<'_> {
    fn read(&self, stored_key: &[u8]) -> Result<Option<Vec<u8>>, StoreError> {
        self.get(stored_key)
    }

    fn read_under(&self, prefix: &[u8]) -> Result<Entries, StoreError> {
        self.scan(prefix, &key::prefix_end(prefix), usize::MAX)
    }

    fn read_first_in(&self, start: &[u8], end: &[u8]) -> Result<Option<(Vec<u8>, Vec<u8>)>, StoreError> {
        Ok(self.scan(start, end, 1)?.pop())
    }
}

pub struct LayeredWrites<'v, 'w> {
    view: &'v View<'w>,
    written_so_far: BTreeMap<Vec<u8>, Val>,
    out: Out,
}

impl<'v, 'w> LayeredWrites<'v, 'w> {
    pub fn new(view: &'v View<'w>) -> Self {
        LayeredWrites {
            view,
            written_so_far: BTreeMap::new(),
            out: Out::default(),
        }
    }

    fn write_through(&mut self, stored_key: Vec<u8>, value: Val) {
        apply(&mut self.written_so_far, stored_key.clone(), value.clone());
        self.out.push(stored_key, value);
    }

    pub fn put(&mut self, stored_key: Vec<u8>, value: Vec<u8>) {
        self.write_through(stored_key, Val::Put(value));
    }

    pub fn del(&mut self, stored_key: Vec<u8>) {
        self.write_through(stored_key, Val::Del);
    }

    pub fn add(&mut self, stored_key: Vec<u8>, amount: i64) {
        self.write_through(stored_key, Val::Add(amount));
    }

    fn add_at_digit(&mut self, stored_key: Vec<u8>, count_at_digit: u8, amount: i64) {
        if amount != 0 {
            self.write_through(
                stored_key,
                Val::AddMap(vec![(u32::from(count_at_digit), amount)]),
            );
        }
    }

    pub fn finish(self, out: &mut Out) {
        out.entries.extend(self.out.entries);
    }
}

impl ReadDerived for LayeredWrites<'_, '_> {
    fn read(&self, stored_key: &[u8]) -> Result<Option<Vec<u8>>, StoreError> {
        self.view.with_layer(&self.written_so_far).get(stored_key)
    }

    fn read_under(&self, prefix: &[u8]) -> Result<Entries, StoreError> {
        let value = self.view.with_layer(&self.written_so_far);
        value.scan(prefix, &key::prefix_end(prefix), usize::MAX)
    }

    fn read_first_in(&self, start: &[u8], end: &[u8]) -> Result<Option<(Vec<u8>, Vec<u8>)>, StoreError> {
        Ok(self.view.with_layer(&self.written_so_far).scan(start, end, 1)?.pop())
    }
}

fn node_key(book_tree: &[u8], node_prefix: &[u8]) -> Vec<u8> {
    let mut stored_key = book_tree.to_vec();
    stored_key.push(node_prefix.len() as u8);
    stored_key.extend_from_slice(node_prefix);
    stored_key
}

fn count_key(book_tree: &[u8], node_prefix: &[u8]) -> Vec<u8> {
    let mut stored_key = ORDER_TREE_COUNT.prefix();
    stored_key.extend_from_slice(&node_key(book_tree, node_prefix));
    stored_key
}

fn held_prefix(book_tree: &[u8], node_prefix: &[u8]) -> Vec<u8> {
    let mut stored_key = ORDER_TREE_HELD.prefix();
    stored_key.extend_from_slice(&node_key(book_tree, node_prefix));
    stored_key
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CountedSlot {
    HeldByKind(u64),
    DeletedWhileRelationsTargetIt,
    DeletedEntryPlaceForKind(u64),
}

impl CountedSlot {
    fn bytes(self) -> Vec<u8> {
        let (tag, kind) = match self {
            CountedSlot::HeldByKind(kind) => (0, kind),
            CountedSlot::DeletedWhileRelationsTargetIt => (1, 0),
            CountedSlot::DeletedEntryPlaceForKind(kind) => (2, kind),
        };
        let mut out = vec![tag];
        put_u64(&mut out, kind);
        out
    }
}

fn held_key(book_tree: &[u8], node_prefix: &[u8], slot: CountedSlot) -> Vec<u8> {
    let mut stored_key = held_prefix(book_tree, node_prefix);
    stored_key.extend_from_slice(&slot.bytes());
    stored_key
}

fn edge_key(book_tree: &[u8], node_prefix: &[u8], digit: u8) -> Vec<u8> {
    let mut stored_key = key::of(ORDER_TREE_EDGE);
    stored_key.extend_from_slice(&node_key(book_tree, node_prefix));
    stored_key.push(digit);
    stored_key
}

fn digit_counts(
    reader: &impl ReadDerived,
    stored_key: &[u8],
) -> Result<Vec<(u8, u64)>, StoreError> {
    let Some(bytes) = reader.read(stored_key)? else {
        return Ok(Vec::new());
    };
    map_counts(&bytes)
        .ok_or_else(|| corrupt("a count map doesn't decode"))?
        .into_iter()
        .map(|(listed_digit, amount)| {
            u8::try_from(listed_digit)
                .map(|digit| (digit, amount))
                .map_err(|_| corrupt("a digit past 255"))
        })
        .collect()
}

fn count_at_digit(counts_by_digit: &[(u8, u64)], digit: u8) -> u64 {
    counts_by_digit
        .iter()
        .find(|(listed_digit, _)| *listed_digit == digit)
        .map_or(0, |(_, amount)| *amount)
}

fn child_edge(
    reader: &impl ReadDerived,
    book_tree: &[u8],
    node_prefix: &[u8],
    digit: u8,
) -> Result<Option<Vec<u8>>, StoreError> {
    let Some(child) = reader.read(&edge_key(book_tree, node_prefix, digit))? else {
        return Ok(None);
    };
    if child.len() <= node_prefix.len()
        || child.len() > ORDER_KEY_BYTES
        || child[..node_prefix.len()] != *node_prefix
        || child[node_prefix.len()] != digit
    {
        return Err(corrupt("an edge doesn't extend its node"));
    }
    Ok(Some(child))
}

fn shared_prefix_length(one: &[u8], other: &[u8]) -> usize {
    one.iter()
        .zip(other)
        .take_while(|(one_byte, other_byte)| one_byte == other_byte)
        .count()
}

fn add_along_edge(
    writes: &mut LayeredWrites,
    book_tree: &[u8],
    node_prefix: &[u8],
    digit: u8,
    held: &[CountedSlot],
    amount: i64,
) {
    writes.add_at_digit(count_key(book_tree, node_prefix), digit, amount);
    for slot in held {
        writes.add_at_digit(held_key(book_tree, node_prefix, *slot), digit, amount);
    }
}

fn held_under_edge(
    reader: &impl ReadDerived,
    book_tree: &[u8],
    node_prefix: &[u8],
    digit: u8,
) -> Result<Vec<(Vec<u8>, u64)>, StoreError> {
    let prefix = held_prefix(book_tree, node_prefix);
    let mut out = Vec::new();
    for (stored_key, value) in reader.read_under(&prefix)? {
        let slot_bytes = stored_key[prefix.len()..].to_vec();
        let held_by_digit: Vec<(u8, u64)> = map_counts(&value)
            .ok_or_else(|| corrupt("a held map doesn't decode"))?
            .into_iter()
            .filter_map(|(listed_digit, amount)| {
                u8::try_from(listed_digit)
                    .ok()
                    .map(|listed_digit| (listed_digit, amount))
            })
            .collect();
        let amount = count_at_digit(&held_by_digit, digit);
        if amount > 0 {
            out.push((slot_bytes, amount));
        }
    }
    Ok(out)
}

pub fn insert_entry(
    writes: &mut LayeredWrites,
    book_tree: &[u8],
    entry: &OrderKey,
    held: &[CountedSlot],
) -> Result<(), StoreError> {
    let mut node_prefix: Vec<u8> = Vec::new();
    loop {
        let digit = entry[node_prefix.len()];
        let Some(child) = child_edge(writes, book_tree, &node_prefix, digit)? else {
            writes.put(edge_key(book_tree, &node_prefix, digit), entry.to_vec());
            add_along_edge(writes, book_tree, &node_prefix, digit, held, 1);
            return Ok(());
        };
        let shared = shared_prefix_length(&child, entry);
        if shared == child.len() {
            if shared == ORDER_KEY_BYTES {
                return Err(corrupt("an entry inserted twice"));
            }
            add_along_edge(writes, book_tree, &node_prefix, digit, held, 1);
            node_prefix = child;
            continue;
        }
        let entries_under_edge = count_at_digit(
            &digit_counts(writes, &count_key(book_tree, &node_prefix))?,
            digit,
        );
        let under_held = held_under_edge(writes, book_tree, &node_prefix, digit)?;
        let split_node = entry[..shared].to_vec();
        writes.put(edge_key(book_tree, &node_prefix, digit), split_node.clone());
        add_along_edge(writes, book_tree, &node_prefix, digit, held, 1);
        writes.put(
            edge_key(book_tree, &split_node, child[shared]),
            child.clone(),
        );
        writes.add_at_digit(
            count_key(book_tree, &split_node),
            child[shared],
            entries_under_edge as i64,
        );
        for (slot_bytes, amount) in under_held {
            let mut split_held_key = held_prefix(book_tree, &split_node);
            split_held_key.extend_from_slice(&slot_bytes);
            writes.add_at_digit(
                split_held_key,
                child[shared],
                amount as i64,
            );
        }
        writes.put(
            edge_key(book_tree, &split_node, entry[shared]),
            entry.to_vec(),
        );
        add_along_edge(writes, book_tree, &split_node, entry[shared], held, 1);
        return Ok(());
    }
}

type PathToEntry = Vec<(Vec<u8>, u8)>;

fn path_to(
    reader: &impl ReadDerived,
    book_tree: &[u8],
    entry: &OrderKey,
) -> Result<Option<PathToEntry>, StoreError> {
    let mut path = Vec::new();
    let mut node_prefix: Vec<u8> = Vec::new();
    loop {
        let digit = entry[node_prefix.len()];
        let Some(child) = child_edge(reader, book_tree, &node_prefix, digit)? else {
            return Ok(None);
        };
        path.push((node_prefix, digit));
        if child.as_slice() == entry {
            return Ok(Some(path));
        }
        if shared_prefix_length(&child, entry) < child.len() {
            return Ok(None);
        }
        node_prefix = child;
    }
}

pub fn holds_entry(
    reader: &impl ReadDerived,
    book_tree: &[u8],
    entry: &OrderKey,
) -> Result<bool, StoreError> {
    Ok(path_to(reader, book_tree, entry)?.is_some())
}

pub fn remove_entry(
    writes: &mut LayeredWrites,
    book_tree: &[u8],
    entry: &OrderKey,
    held: &[CountedSlot],
) -> Result<(), StoreError> {
    let path = path_to(writes, book_tree, entry)?
        .ok_or_else(|| corrupt("an entry removed that isn't in the tree"))?;
    for (node_prefix, digit) in &path {
        add_along_edge(writes, book_tree, node_prefix, *digit, held, -1);
    }
    let (last, digit) = path.last().expect("a path has its leaf's edge");
    writes.del(edge_key(book_tree, last, *digit));
    if last.is_empty() {
        return Ok(());
    }
    let remaining_counts = digit_counts(writes, &count_key(book_tree, last))?;
    let [(only_digit, _)] = remaining_counts[..] else {
        return Ok(());
    };
    let remaining_child = child_edge(writes, book_tree, last, only_digit)?
        .ok_or_else(|| corrupt("a counted digit has no edge"))?;
    let (parent_node, parent_digit) = &path[path.len() - 2];
    writes.put(
        edge_key(book_tree, parent_node, *parent_digit),
        remaining_child,
    );
    writes.del(edge_key(book_tree, last, only_digit));
    writes.del(count_key(book_tree, last));
    for (stored_key, _) in writes.read_under(&held_prefix(book_tree, last))? {
        writes.del(stored_key);
    }
    Ok(())
}

pub fn add_held(
    writes: &mut LayeredWrites,
    book_tree: &[u8],
    entry: &OrderKey,
    slot: CountedSlot,
    amount: i64,
) -> Result<(), StoreError> {
    let path = path_to(writes, book_tree, entry)?
        .ok_or_else(|| corrupt("a counted slot on an entry that isn't in the tree"))?;
    for (node_prefix, digit) in path {
        writes.add_at_digit(held_key(book_tree, &node_prefix, slot), digit, amount);
    }
    Ok(())
}

fn not_held_under(
    reader: &impl ReadDerived,
    book_tree: &[u8],
    node_prefix: &[u8],
    kind: Option<u64>,
) -> Result<Vec<(u8, u64)>, StoreError> {
    let mut not_held = digit_counts(reader, &count_key(book_tree, node_prefix))?;
    let counted = |slot| digit_counts(reader, &held_key(book_tree, node_prefix, slot));
    let deleted = counted(CountedSlot::DeletedWhileRelationsTargetIt)?;
    let (held, places) = match kind {
        Some(kind) => (
            counted(CountedSlot::HeldByKind(kind))?,
            counted(CountedSlot::DeletedEntryPlaceForKind(kind))?,
        ),
        None => (Vec::new(), Vec::new()),
    };
    for (digit, amount) in &mut not_held {
        let shown = (*amount + count_at_digit(&places, *digit))
            .checked_sub(count_at_digit(&held, *digit) + count_at_digit(&deleted, *digit));
        *amount = shown.ok_or_else(|| corrupt("more entries held or deleted than in the tree"))?;
    }
    not_held.retain(|(_, amount)| *amount > 0);
    Ok(not_held)
}

pub fn top_level_count(
    reader: &impl ReadDerived,
    book_tree: &[u8],
    kind: Option<u64>,
) -> Result<u64, StoreError> {
    Ok(not_held_under(reader, book_tree, &[], kind)?
        .iter()
        .map(|(_, amount)| amount)
        .sum())
}

pub fn top_level_rank(
    reader: &impl ReadDerived,
    book_tree: &[u8],
    entry: &OrderKey,
    kind: Option<u64>,
) -> Result<u64, StoreError> {
    let mut below = 0;
    let mut node_prefix: Vec<u8> = Vec::new();
    loop {
        let not_held_here = not_held_under(reader, book_tree, &node_prefix, kind)?;
        let digit = entry[node_prefix.len()];
        below += not_held_here
            .iter()
            .filter(|(listed_digit, _)| *listed_digit < digit)
            .map(|(_, amount)| amount)
            .sum::<u64>();
        let Some(child) = child_edge(reader, book_tree, &node_prefix, digit)? else {
            return Ok(below);
        };
        let shared = shared_prefix_length(&child, entry);
        if shared == child.len() {
            if shared == ORDER_KEY_BYTES {
                return Ok(below);
            }
            node_prefix = child;
            continue;
        }
        if child[shared] < entry[shared] {
            below += count_at_digit(&not_held_here, digit);
        }
        return Ok(below);
    }
}

pub fn top_level_from_rank(
    reader: &impl ReadDerived,
    book_tree: &[u8],
    kind: Option<u64>,
    skip: u64,
    amount: usize,
) -> Result<Vec<OrderKey>, StoreError> {
    let mut out = Vec::new();
    let mut skip = skip;
    if amount > 0 {
        collect_top_level_under(reader, book_tree, kind, &[], &mut skip, amount, &mut out)?;
    }
    Ok(out)
}

fn collect_top_level_under(
    reader: &impl ReadDerived,
    book_tree: &[u8],
    kind: Option<u64>,
    node_prefix: &[u8],
    skip: &mut u64,
    amount: usize,
    out: &mut Vec<OrderKey>,
) -> Result<(), StoreError> {
    for (digit, entries_under) in not_held_under(reader, book_tree, node_prefix, kind)? {
        if out.len() >= amount {
            return Ok(());
        }
        if *skip >= entries_under {
            *skip -= entries_under;
            continue;
        }
        let child = child_edge(reader, book_tree, node_prefix, digit)?
            .ok_or_else(|| corrupt("a counted digit has no edge"))?;
        if child.len() == ORDER_KEY_BYTES {
            out.push(child.try_into().expect("a leaf holds a whole order key"));
        } else {
            collect_top_level_under(reader, book_tree, kind, &child, skip, amount, out)?;
        }
    }
    Ok(())
}
