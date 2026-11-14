// A world's entries in each of the sorts a list can be read in, one counted tree per (book, sort), kept by every write
// of a field a sort reads. A leaf is the sort's key, then the ties' (order descending, then uid ascending), then the
// entity: read forward it is the ascending sort, backward the descending one (whose ties then run the other way).
use super::StoreError;
use super::books::EntryKey;
use std::collections::BTreeMap;

use super::derive::{AddMapKind, Out, View, apply};
use super::entry_label::COMMENT;
use super::kinds::{key, text_value};
use super::relations::sortable_bits;
use super::world_order_tree::{self as tree, Counted, LayeredWrites, ReadDerived, Tree, TreeKind};
use crate::keyspace::val::{Val, get_bytes, get_u64, put_bytes, put_u64};
use crate::log::format::FieldRef;

pub const SORTED_EDGE: u64 = 251;
pub const SORTED_COUNT: AddMapKind = AddMapKind::new(252);
// entity → the fields its leaves were placed by.
pub const SORTED_LEAF: u64 = 253;

pub static SORTED: TreeKind = TreeKind::new(SORTED_EDGE, SORTED_COUNT, is_sorted_leaf);

// Upstream's entry field codes (`ENTRY_KEYS` in src/world-info-engine.js, from 100); a character's own book stores
// `insertion_order` and `enabled` in place of `order` and `disable`.
const CONSTANT: u64 = 105;
const ORDER: u64 = 110;
const DISABLE: u64 = 112;
const PROBABILITY: u64 = 123;
const DEPTH: u64 = 125;
const INSERTION_ORDER: u64 = 148;
const ENABLED: u64 = 149;
const READ: [u64; 8] = [COMMENT, CONSTANT, ORDER, DISABLE, PROBABILITY, DEPTH, INSERTION_ORDER, ENABLED];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sort {
    Title = 1,
    Depth = 3,
    Order = 4,
    Uid = 5,
    Probability = 6,
    Priority = 7,
}

pub const SORTS: [Sort; 6] = [
    Sort::Title,
    Sort::Depth,
    Sort::Order,
    Sort::Uid,
    Sort::Probability,
    Sort::Priority,
];

impl Sort {
    pub fn named(name: &str) -> Option<Sort> {
        Some(match name {
            "title" => Sort::Title,
            "depth" => Sort::Depth,
            "order" => Sort::Order,
            "uid" => Sort::Uid,
            "probability" => Sort::Probability,
            "priority" => Sort::Priority,
            _ => return None,
        })
    }
}

fn is_sorted_leaf(prefix: &[u8]) -> bool {
    let mut at = 0;
    get_bytes(prefix, &mut at).is_some()
        && get_bytes(prefix, &mut at).is_some()
        && get_u64(prefix, &mut at).is_some()
        && at == prefix.len()
}

pub fn sorted_tree(book: u64, sort: Sort) -> Tree {
    let mut space = Vec::new();
    put_u64(&mut space, book);
    space.push(sort as u8);
    Tree::new(&SORTED, space)
}

pub fn entity_of_leaf(leaf: &[u8]) -> Result<u64, StoreError> {
    let mut at = 0;
    get_bytes(leaf, &mut at)
        .and_then(|_| get_bytes(leaf, &mut at))
        .and_then(|_| get_u64(leaf, &mut at))
        .ok_or_else(|| StoreError::Entry("a sorted leaf doesn't decode".into()))
}

#[derive(Clone, Default, PartialEq)]
struct Facts {
    values: Vec<(u64, bool, Vec<u8>)>,
}

impl Facts {
    fn get(&self, code: u64, json: bool) -> Option<&[u8]> {
        self.values
            .iter()
            .find(|(c, j, _)| *c == code && *j == json)
            .map(|(_, _, v)| v.as_slice())
    }

    fn number(&self, code: u64) -> Option<f64> {
        let text = std::str::from_utf8(self.get(code, true)?).ok()?;
        text.trim().parse::<f64>().ok().filter(|n| n.is_finite())
    }

    fn flag(&self, code: u64) -> Option<bool> {
        match self.get(code, true)? {
            b"true" => Some(true),
            b"false" => Some(false),
            _ => None,
        }
    }

    fn with(mut self, code: u64, json: bool, value: Option<&[u8]>) -> Facts {
        match value {
            Some(v) => {
                self.values.retain(|(c, _, _)| *c != code);
                self.values.push((code, json, v.to_vec()));
            }
            None => self.values.retain(|(c, j, _)| !(*c == code && *j == json)),
        }
        self
    }

    fn order(&self) -> Option<f64> {
        self.number(ORDER).or_else(|| self.number(INSERTION_ORDER))
    }

    fn disabled(&self) -> bool {
        self.flag(DISABLE)
            .or_else(|| self.flag(ENABLED).map(|enabled| !enabled))
            .unwrap_or(false)
    }
}

fn stored_facts(view: &View, entity: u64) -> Result<Facts, StoreError> {
    let mut values = Vec::new();
    for code in READ {
        let f = FieldRef::Code(code);
        if let Some(t) = text_value(view, entity, &f)? {
            values.push((code, false, t));
        }
        if let Some(j) = super::history::json_value(view, entity, &f)? {
            values.push((code, true, j));
        }
    }
    Ok(Facts { values })
}

fn number_part(value: Option<f64>) -> Vec<u8> {
    match value {
        None => vec![0],
        Some(n) => {
            let mut out = vec![1];
            out.extend_from_slice(&sortable_bits(n).to_be_bytes());
            out
        }
    }
}

fn uid_of(own_key: &EntryKey) -> u64 {
    match own_key {
        EntryKey::Int(n) => *n,
        EntryKey::Text(_) => u64::MAX,
    }
}

// Titles sort as upstream's `localeCompare` roughly does: case folded, then as written.
fn title_part(facts: &Facts) -> Vec<u8> {
    let title = facts.get(COMMENT, false).unwrap_or_default();
    let text = String::from_utf8_lossy(title);
    let mut out = text.to_lowercase().into_bytes();
    out.push(0);
    out.extend_from_slice(title);
    out
}

fn leaf(sort: Sort, facts: &Facts, own_key: &EntryKey, entity: u64) -> Vec<u8> {
    let uid = uid_of(own_key);
    let primary = match sort {
        Sort::Title => title_part(facts),
        Sort::Depth => number_part(facts.number(DEPTH)),
        Sort::Order => number_part(facts.order()),
        Sort::Uid => uid.to_be_bytes().to_vec(),
        Sort::Probability => number_part(facts.number(PROBABILITY)),
        Sort::Priority => {
            let rank: u8 = if facts.disabled() {
                2
            } else if facts.flag(CONSTANT).unwrap_or(false) {
                0
            } else {
                1
            };
            vec![rank]
        }
    };
    let mut ties: Vec<u8> = number_part(facts.order()).iter().map(|byte| !byte).collect();
    ties.extend_from_slice(&uid.to_be_bytes());
    let mut out = Vec::new();
    put_bytes(&mut out, &primary);
    put_bytes(&mut out, &ties);
    put_u64(&mut out, entity);
    out
}

fn facts_key(entity: u64) -> Vec<u8> {
    key::id(SORTED_LEAF, entity)
}

fn encoded(facts: &Facts) -> Vec<u8> {
    let mut out = Vec::new();
    for (code, json, value) in &facts.values {
        put_u64(&mut out, *code);
        out.push(u8::from(*json));
        put_bytes(&mut out, value);
    }
    out
}

fn decoded(bytes: &[u8]) -> Result<Facts, StoreError> {
    let bad = || StoreError::Entry("an entry's sorted facts don't decode".into());
    let (mut at, mut values) = (0, Vec::new());
    while at < bytes.len() {
        let code = get_u64(bytes, &mut at).ok_or_else(bad)?;
        let json = *bytes.get(at).ok_or_else(bad)? == 1;
        at += 1;
        values.push((code, json, get_bytes(bytes, &mut at).ok_or_else(bad)?));
    }
    Ok(Facts { values })
}

// The facts the entity's leaves were placed by, as this record's earlier hooks left them: a record's hooks all read
// the view from before it, and a field changing form is announced as the old form's removal and the new write.
fn placed_facts(writes: &LayeredWrites, entity: u64) -> Result<Option<Facts>, StoreError> {
    writes.read(&facts_key(entity))?.map(|bytes| decoded(&bytes)).transpose()
}

// Moves the entity's leaves from the facts they were placed by to `facts` (none: out of every sort).
fn place(
    writes: &mut LayeredWrites,
    book: u64,
    entity: u64,
    own_key: &EntryKey,
    facts: Option<&Facts>,
) -> Result<(), StoreError> {
    let placed = placed_facts(writes, entity)?;
    for sort in SORTS {
        let sorted = sorted_tree(book, sort);
        let was = placed.as_ref().map(|facts| leaf(sort, facts, own_key, entity));
        let now = facts.map(|facts| leaf(sort, facts, own_key, entity));
        if was == now {
            continue;
        }
        if let Some(was) = was {
            tree::remove_entry(writes, &sorted, &was, &[])?;
        }
        if let Some(now) = now {
            tree::insert_entry(writes, &sorted, &now, &[])?;
        }
    }
    match facts {
        Some(facts) => writes.put(facts_key(entity), encoded(facts)),
        None => writes.del(facts_key(entity)),
    }
    Ok(())
}

// The view with what this record's derive has written so far.
fn written_so_far(out: &Out) -> BTreeMap<Vec<u8>, Val> {
    let mut layer = BTreeMap::new();
    for (stored_key, value) in &out.entries {
        apply(&mut layer, stored_key.clone(), value.clone());
    }
    layer
}

pub fn reads_field(f: &FieldRef) -> bool {
    matches!(f, FieldRef::Code(code) if READ.contains(code))
}

#[allow(clippy::too_many_arguments)]
pub fn entry_value_written(
    view: &View,
    out: &mut Out,
    book: u64,
    entity: u64,
    own_key: &EntryKey,
    f: &FieldRef,
    json: bool,
    new: Option<&[u8]>,
) -> Result<(), StoreError> {
    if !reads_field(f) {
        return Ok(());
    }
    let FieldRef::Code(code) = f else {
        return Ok(());
    };
    let layer = written_so_far(out);
    let layered = view.with_layer(&layer);
    let mut writes = LayeredWrites::new(&layered);
    let Some(placed) = placed_facts(&writes, entity)? else {
        return Ok(());
    };
    let now = placed.with(*code, json, new);
    place(&mut writes, book, entity, own_key, Some(&now))?;
    writes.finish(out);
    Ok(())
}

pub fn entry_came(
    view: &View,
    out: &mut Out,
    book: u64,
    entity: u64,
    own_key: &EntryKey,
) -> Result<(), StoreError> {
    let facts = stored_facts(view, entity)?;
    let layer = written_so_far(out);
    let layered = view.with_layer(&layer);
    let mut writes = LayeredWrites::new(&layered);
    place(&mut writes, book, entity, own_key, Some(&facts))?;
    writes.finish(out);
    Ok(())
}

pub fn entry_gone(
    view: &View,
    out: &mut Out,
    book: u64,
    entity: u64,
    own_key: &EntryKey,
) -> Result<(), StoreError> {
    let layer = written_so_far(out);
    let layered = view.with_layer(&layer);
    let mut writes = LayeredWrites::new(&layered);
    place(&mut writes, book, entity, own_key, None)?;
    writes.finish(out);
    Ok(())
}

// The recount's first step: every sorted tree goes, for the steps to build again.
pub fn cleared(view: &View, out: &mut Out) -> Result<(), StoreError> {
    for structure in [SORTED_EDGE, SORTED_COUNT.id(), SORTED_LEAF] {
        let prefix = key::of(structure);
        for (stored_key, _) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
            out.del(stored_key);
        }
    }
    Ok(())
}

pub fn count(view: &View, book: u64, sort: Sort) -> Result<u64, StoreError> {
    tree::count(view, &sorted_tree(book, sort), Counted::Every)
}

// The entities at ranks `skip..skip + amount` of the sort, read backward when `descending`.
pub fn from_rank(
    view: &View,
    book: u64,
    sort: Sort,
    descending: bool,
    skip: u64,
    amount: usize,
) -> Result<Vec<u64>, StoreError> {
    let sorted = sorted_tree(book, sort);
    let (start, amount) = if descending {
        let total = tree::count(view, &sorted, Counted::Every)?;
        let end = total.saturating_sub(skip);
        let start = end.saturating_sub(amount as u64);
        (start, (end - start) as usize)
    } else {
        (skip, amount)
    };
    let mut found = tree::from_rank(view, &sorted, Counted::Every, start, amount)?
        .iter()
        .map(|leaf| entity_of_leaf(leaf))
        .collect::<Result<Vec<_>, _>>()?;
    if descending {
        found.reverse();
    }
    Ok(found)
}
