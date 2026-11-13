use super::StoreError;
use super::books::{ENTRY, EntryKey, parse_entry_key};
use super::chat_read::Js;
use super::derive::View;
use super::entry_label::{self, COMMENT, CONTENT};
use super::kinds::{key, text_value};
use super::library::entity_info;
use super::relations;
use super::world_order_tree as tree;
use crate::log::format::FieldRef;

#[derive(Clone, Copy)]
pub enum Grouping {
    World { book: u64, kind: Option<u64> },
    PointingAt { book: u64, kind: u64, entry: u64 },
}

impl Grouping {
    pub fn book(self) -> u64 {
        match self {
            Grouping::World { book, .. } | Grouping::PointingAt { book, .. } => book,
        }
    }

    pub fn kind(self) -> Option<u64> {
        match self {
            Grouping::World { kind, .. } => kind,
            Grouping::PointingAt { kind, .. } => Some(kind),
        }
    }

    fn root(self) -> Option<u64> {
        match self {
            Grouping::World { .. } => None,
            Grouping::PointingAt { entry, .. } => Some(entry),
        }
    }

    fn path_from(self, top: u64) -> Vec<u64> {
        self.root().into_iter().chain([top]).collect()
    }

    fn list_prefix(self) -> Option<String> {
        match self {
            Grouping::World { .. } => None,
            Grouping::PointingAt { kind, entry, .. } => Some(format!("{kind}@{entry}")),
        }
    }

    fn occurrence_of(self, parts: &[&str]) -> String {
        let joined = parts.join("/");
        match self.list_prefix() {
            Some(prefix) => format!("{prefix}/{joined}"),
            None => joined,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegionLayout {
    pub columns: u64,
    pub rows: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct OverviewLayout<'a> {
    pub regions_by_nesting_level: &'a [RegionLayout],
    pub card_text_characters: usize,
}

#[derive(Debug, Clone, Copy)]
pub enum OverviewStep {
    InReadingOrder(i64),
    ToParent,
    ToFirstChild,
}

struct DrawnEntry {
    entity: u64,
    own_key: Option<EntryKey>,
    occurrence: String,
    grouping_kind_relations_targeting_this: u64,
    place_of_deleted_entry: bool,
    already_open_above: bool,
    cells: Vec<RegionCell>,
}

enum RegionCell {
    RelatedEntry(DrawnEntry),
    NotShownTile { occurrence: String, not_shown: u64 },
}

fn refused(why: String) -> StoreError {
    StoreError::Refused(format!("overview: {why}"))
}

pub fn uid_in(view: &View, book: u64, entity: u64) -> Result<Option<EntryKey>, StoreError> {
    Ok(match entity_info(view, entity)? {
        Some((ENTRY, stored_key, _)) => match parse_entry_key(&stored_key)? {
            (entry_book, own_key) if entry_book == book => Some(own_key),
            _ => None,
        },
        _ => None,
    })
}

fn occurrence_key(grouping: Grouping, path: &[u64]) -> String {
    let below_root = &path[usize::from(grouping.root().is_some())..];
    let parts: Vec<String> = below_root.iter().map(u64::to_string).collect();
    grouping.occurrence_of(&parts.iter().map(String::as_str).collect::<Vec<_>>())
}

fn draw_entry(
    view: &View,
    grouping: Grouping,
    layout: &[RegionLayout],
    path: &mut Vec<u64>,
) -> Result<DrawnEntry, StoreError> {
    let entity = *path.last().expect("a drawn entry is on its path");
    let book = grouping.book();
    let (own_key, place_of_deleted_entry) = match uid_in(view, book, entity)? {
        Some(own_key) => (Some(own_key), false),
        None => match relations::deletion_in_progress(view, entity)? {
            Some(deleting) if deleting.book == book => (None, true),
            _ => return Err(StoreError::Entry(format!("{entity} isn't an entry of this world"))),
        },
    };
    let occurrence = occurrence_key(grouping, path);
    let already_open_above = path[..path.len() - 1].contains(&entity);
    let mut drawn = DrawnEntry {
        entity,
        occurrence,
        grouping_kind_relations_targeting_this: 0,
        place_of_deleted_entry,
        already_open_above,
        cells: Vec::new(),
        own_key,
    };
    let Some(kind) = grouping.kind() else {
        return Ok(drawn);
    };
    drawn.grouping_kind_relations_targeting_this =
        relations::count_of_relations_of_kind_targeting(view, book, kind, entity)?;
    let level = path.len() - 1 - usize::from(grouping.root().is_some());
    let Some(region) = layout.get(level) else {
        return Ok(drawn);
    };
    if already_open_above || drawn.grouping_kind_relations_targeting_this == 0 {
        return Ok(drawn);
    }
    let cells = region.columns.saturating_mul(region.rows);
    if cells == 0 {
        return Ok(drawn);
    }
    let shown = if drawn.grouping_kind_relations_targeting_this <= cells {
        drawn.grouping_kind_relations_targeting_this
    } else {
        cells - 1
    };
    let prefix = relations::relations_of_kind_targeting_prefix(book, kind, entity);
    for (stored_key, _) in view.scan(&prefix, &key::prefix_end(&prefix), shown as usize)? {
        let (_, source) =
            relations::position_and_source_of_relation_of_kind_targeting(&prefix, &stored_key)?;
        path.push(source);
        let related = draw_entry(view, grouping, layout, path);
        path.pop();
        drawn.cells.push(RegionCell::RelatedEntry(related?));
    }
    if drawn.grouping_kind_relations_targeting_this > shown {
        drawn.cells.push(RegionCell::NotShownTile {
            occurrence: format!("{}/+", drawn.occurrence),
            not_shown: drawn.grouping_kind_relations_targeting_this - shown,
        });
    }
    Ok(drawn)
}

fn reading_order(drawn: &DrawnEntry, out: &mut Vec<String>) {
    out.push(drawn.occurrence.clone());
    for cell in &drawn.cells {
        match cell {
            RegionCell::RelatedEntry(related) => reading_order(related, out),
            RegionCell::NotShownTile { occurrence, .. } => out.push(occurrence.clone()),
        }
    }
}

fn find_occurrence<'d>(drawn: &'d DrawnEntry, occurrence_wanted: &str) -> Option<&'d DrawnEntry> {
    if drawn.occurrence == occurrence_wanted {
        return Some(drawn);
    }
    drawn.cells.iter().find_map(|cell| match cell {
        RegionCell::RelatedEntry(related)
            if occurrence_wanted.starts_with(&format!("{}/", related.occurrence))
                || related.occurrence == occurrence_wanted =>
        {
            find_occurrence(related, occurrence_wanted)
        }
        _ => None,
    })
}

pub fn top_level_count(view: &View, grouping: Grouping) -> Result<u64, StoreError> {
    match grouping {
        Grouping::World { book, kind } => {
            tree::top_level_count(view, &relations::order_tree_space(book), kind)
        }
        Grouping::PointingAt { book, kind, entry } => {
            relations::count_of_relations_of_kind_targeting(view, book, kind, entry)
        }
    }
}

fn top_level_from_rank(
    view: &View,
    grouping: Grouping,
    rank: u64,
    amount: usize,
) -> Result<Vec<u64>, StoreError> {
    match grouping {
        Grouping::World { book, kind } => Ok(tree::top_level_from_rank(
            view,
            &relations::order_tree_space(book),
            kind,
            rank,
            amount,
        )?
        .iter()
        .map(tree::entity_of_order_key)
        .collect()),
        Grouping::PointingAt { book, kind, entry } => tree::from_rank(
            view,
            &relations::sources_tree(book, kind, entry),
            tree::Counted::Every,
            rank,
            amount,
        )?
        .iter()
        .map(|leaf| relations::source_of_leaf(leaf))
        .collect(),
    }
}

fn top_level_entry_at(
    view: &View,
    grouping: Grouping,
    layout: &[RegionLayout],
    rank: u64,
) -> Result<Option<DrawnEntry>, StoreError> {
    let Some(top) = top_level_from_rank(view, grouping, rank, 1)?.pop() else {
        return Ok(None);
    };
    draw_entry(view, grouping, layout, &mut grouping.path_from(top)).map(Some)
}

fn top_level_rank_of(
    view: &View,
    grouping: Grouping,
    entity: u64,
) -> Result<Option<u64>, StoreError> {
    let (book, kind) = match grouping {
        Grouping::World { book, kind } => (book, kind),
        Grouping::PointingAt { book, kind, entry } => {
            let Some(position) = relations::position_in_use(view, entity, kind, entry)? else {
                return Ok(None);
            };
            let leaf = relations::source_leaf(&position, entity);
            let sources = relations::sources_tree(book, kind, entry);
            return tree::rank(view, &sources, &leaf, tree::Counted::Every).map(Some);
        }
    };
    let Some(own_key) = uid_in(view, book, entity)? else {
        let (Some(kind), Some(deleting)) = (kind, relations::deletion_in_progress(view, entity)?)
        else {
            return Ok(None);
        };
        if deleting.book != book
            || relations::count_of_relations_of_kind_targeting(view, deleting.book, kind, entity)? == 0
        {
            return Ok(None);
        }
        let order_key = tree::order_key(deleting.order_value, entity);
        let book_tree = relations::order_tree_space(deleting.book);
        return tree::top_level_rank(view, &book_tree, &order_key, Some(kind)).map(Some);
    };
    if let Some(kind) = kind
        && relations::strong_kinds_in_use_of_entry(view, entity)?.contains(&kind)
    {
        return Ok(None);
    }
    let order_key = relations::order_key_of_entry(view, entity, &own_key)?;
    let book_tree = relations::order_tree_space(book);
    if !tree::holds_entry(view, &book_tree, &order_key)? {
        return Ok(None);
    }
    tree::top_level_rank(view, &book_tree, &order_key, kind).map(Some)
}

fn is_entity_part(part: &str) -> bool {
    !part.is_empty()
        && part.len() <= 20
        && part.bytes().all(|character| character.is_ascii_digit())
        && (part.len() == 1 || !part.starts_with('0'))
}

enum ParsedOccurrence<'a> {
    InThisList(Vec<&'a str>),
    InAnotherList,
}

fn parse_occurrence_key(grouping: Grouping, occurrence: &str) -> Option<ParsedOccurrence<'_>> {
    let mut parts: Vec<&str> = occurrence.split('/').collect();
    let names_a_list = parts[0].split_once('@').is_some_and(|(kind, entry)| {
        is_entity_part(kind) && is_entity_part(entry)
    });
    let in_this_list = match (grouping.list_prefix(), names_a_list) {
        (Some(prefix), true) => prefix == parts.remove(0),
        (None, false) => true,
        (Some(_), false) | (None, true) => return None,
    };
    let ok = !parts.is_empty()
        && parts.iter().enumerate().all(|(index, part)| {
            (*part == "+" && index == parts.len() - 1 && index > 0) || is_entity_part(part)
        });
    if !ok {
        return None;
    }
    Some(if in_this_list {
        ParsedOccurrence::InThisList(parts)
    } else {
        ParsedOccurrence::InAnotherList
    })
}

fn parent_of(grouping: Grouping, occurrence: &str) -> String {
    let below = match grouping.list_prefix() {
        Some(prefix) => occurrence
            .strip_prefix(&format!("{prefix}/"))
            .unwrap_or(occurrence),
        None => occurrence,
    };
    match below.rsplit_once('/') {
        Some((up, _)) => grouping.occurrence_of(&up.split('/').collect::<Vec<_>>()),
        None => occurrence.to_string(),
    }
}

fn locate_occurrence(
    view: &View,
    grouping: Grouping,
    layout: &[RegionLayout],
    occurrence_wanted: &str,
) -> Result<Option<(DrawnEntry, String, u64)>, StoreError> {
    let parts = match parse_occurrence_key(grouping, occurrence_wanted) {
        Some(ParsedOccurrence::InThisList(parts)) => parts,
        Some(ParsedOccurrence::InAnotherList) => return Ok(None),
        None => {
            return Err(refused(format!(
                "{occurrence_wanted:?} isn't an occurrence's key"
            )));
        }
    };
    let Ok(top) = parts[0].parse::<u64>() else {
        return Ok(None);
    };
    let Some(rank) = top_level_rank_of(view, grouping, top)? else {
        return Ok(None);
    };
    let drawn = draw_entry(view, grouping, layout, &mut grouping.path_from(top))?;
    let mut order = Vec::new();
    reading_order(&drawn, &mut order);
    let found = (1..=parts.len())
        .rev()
        .map(|length| grouping.occurrence_of(&parts[..length]))
        .find(|occurrence_wanted| order.contains(occurrence_wanted))
        .unwrap_or_else(|| drawn.occurrence.clone());
    Ok(Some((drawn, found, rank)))
}

fn reading_order_at_rank(
    view: &View,
    grouping: Grouping,
    layout: &[RegionLayout],
    rank: u64,
) -> Result<Vec<String>, StoreError> {
    let mut order = Vec::new();
    if let Some(drawn) = top_level_entry_at(view, grouping, layout, rank)? {
        reading_order(&drawn, &mut order);
    }
    Ok(order)
}

fn step_landing(occurrence: String, rank: u64) -> Js {
    Js::Obj(vec![
        ("occurrence", Js::Text(occurrence.into_bytes())),
        ("topLevelRank", Js::Num(rank as f64)),
    ])
}

pub fn step_in_reading_order(
    view: &View,
    grouping: Grouping,
    layout: &[RegionLayout],
    from: Option<&str>,
    step: OverviewStep,
) -> Result<Js, StoreError> {
    let total = top_level_count(view, grouping)?;
    if total == 0 {
        return Ok(Js::Null);
    }
    let (drawn, occurrence, rank) = match from {
        Some(occurrence_wanted) => {
            match locate_occurrence(view, grouping, layout, occurrence_wanted)? {
                Some(found) => found,
                None => return Ok(Js::Null),
            }
        }
        None => {
            let (rank, steps, last) = match step {
                OverviewStep::InReadingOrder(steps) if steps > 0 => (0, steps - 1, false),
                OverviewStep::InReadingOrder(steps) if steps < 0 => (total - 1, steps + 1, true),
                _ => return Ok(Js::Null),
            };
            let order = reading_order_at_rank(view, grouping, layout, rank)?;
            let start = if last { order.len() - 1 } else { 0 };
            return step_across_top_level(view, grouping, layout, total, order, start, rank, steps);
        }
    };
    match step {
        OverviewStep::ToParent => Ok(step_landing(parent_of(grouping, &occurrence), rank)),
        OverviewStep::ToFirstChild => {
            let first = find_occurrence(&drawn, &occurrence)
                .and_then(|drawn| drawn.cells.first())
                .map(|cell| match cell {
                    RegionCell::RelatedEntry(related) => related.occurrence.clone(),
                    RegionCell::NotShownTile { occurrence, .. } => occurrence.clone(),
                });
            Ok(step_landing(first.unwrap_or(occurrence), rank))
        }
        OverviewStep::InReadingOrder(steps) => {
            let mut order = Vec::new();
            reading_order(&drawn, &mut order);
            let at = order
                .iter()
                .position(|occurrence_wanted| *occurrence_wanted == occurrence)
                .expect("located in its own drawing");
            step_across_top_level(view, grouping, layout, total, order, at, rank, steps)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn step_across_top_level(
    view: &View,
    grouping: Grouping,
    layout: &[RegionLayout],
    total: u64,
    mut order: Vec<String>,
    at: usize,
    mut rank: u64,
    steps: i64,
) -> Result<Js, StoreError> {
    let mut target = at as i64 + steps;
    loop {
        if target < 0 {
            if rank == 0 {
                return Ok(step_landing(order[0].clone(), rank));
            }
            rank -= 1;
            order = reading_order_at_rank(view, grouping, layout, rank)?;
            target += order.len() as i64;
        } else if target as usize >= order.len() {
            if rank + 1 >= total {
                return Ok(step_landing(order[order.len() - 1].clone(), rank));
            }
            target -= order.len() as i64;
            rank += 1;
            order = reading_order_at_rank(view, grouping, layout, rank)?;
        } else {
            return Ok(step_landing(order[target as usize].clone(), rank));
        }
    }
}

fn cut_text(text: &[u8], characters: usize) -> (Vec<u8>, bool) {
    let mut seen = 0;
    for (index, byte) in text.iter().enumerate() {
        if byte & 0xc0 != 0x80 {
            if seen == characters {
                return (text[..index].to_vec(), true);
            }
            seen += 1;
        }
    }
    (text.to_vec(), false)
}

pub fn relations_line(
    view: &View,
    book: u64,
    keys_list: Option<u64>,
    entity: u64,
) -> Result<Vec<Js>, StoreError> {
    let mut line = Vec::new();
    for ((kind, target), stored) in relations::stored_relations_of_entry(view, entity)? {
        let target_key = uid_in(view, book, target)?;
        line.push(Js::Obj(vec![
            ("kind", Js::Text(kind.to_string().into_bytes())),
            (
                "kindName",
                relations::relation_kind_name(view, book, kind)?.map_or(Js::Null, Js::Text),
            ),
            ("targetDeleted", Js::Bool(target_key.is_none())),
            (
                "inUse",
                Js::Bool(stored.state == relations::RelationState::InUse),
            ),
            (
                "targetKey",
                target_key.as_ref().map_or(Js::Null, |own_key| Js::Text(own_key.text())),
            ),
            ("targetEntry", Js::Text(target.to_string().into_bytes())),
            (
                "target",
                match target_key {
                    Some(_) => entry_label::named(view, keys_list, target)?.js(),
                    None => Js::Null,
                },
            ),
            ("weak", Js::Bool(stored.relation.weak)),
        ]));
    }
    Ok(line)
}

fn card(
    view: &View,
    grouping: Grouping,
    layout: &OverviewLayout,
    keys_list: Option<u64>,
    drawn: &DrawnEntry,
) -> Result<Vec<(&'static str, Js)>, StoreError> {
    if drawn.place_of_deleted_entry {
        return Ok(vec![
            ("cell", Js::Text(b"placeOfDeletedEntry".to_vec())),
            ("occurrence", Js::Text(drawn.occurrence.clone().into_bytes())),
            ("entryKey", drawn.own_key.as_ref().map_or(Js::Null, |own_key| Js::Text(own_key.text()))),
            (
                "groupingKindRelationsTargetingThis",
                Js::Num(drawn.grouping_kind_relations_targeting_this as f64),
            ),
            ("alreadyOpenAbove", Js::Bool(drawn.already_open_above)),
        ]);
    }
    let content = text_value(view, drawn.entity, &FieldRef::Code(CONTENT))?.unwrap_or_default();
    let (text, text_cut) = cut_text(&content, layout.card_text_characters);
    let keys = entry_label::keys_of(view, keys_list, drawn.entity)?;
    let names = entry_label::names_among(view, drawn.entity, &keys)?;
    let title = text_value(view, drawn.entity, &FieldRef::Code(COMMENT))?;
    let label = entry_label::label(drawn.entity, title.as_deref(), &names, || Ok(content.clone()))?;
    Ok(vec![
        ("cell", Js::Text(b"entry".to_vec())),
        (
            "occurrence",
            Js::Text(drawn.occurrence.clone().into_bytes()),
        ),
        ("entry", Js::Text(drawn.entity.to_string().into_bytes())),
        ("entryKey", drawn.own_key.as_ref().map_or(Js::Null, |own_key| Js::Text(own_key.text()))),
        ("label", label.js()),
        ("picture", entry_label::picture(view, drawn.entity)?),
        ("title", title.map_or(Js::Null, Js::Text)),
        ("text", Js::Text(text)),
        ("textCut", Js::Bool(text_cut)),
        ("keys", Js::Arr(keys.into_iter().map(Js::Text).collect())),
        ("names", Js::Arr(names.into_iter().map(Js::Text).collect())),
        ("relations", Js::Arr(relations_line(view, grouping.book(), keys_list, drawn.entity)?)),
        ("groupingKindRelationsTargetingThis", Js::Num(drawn.grouping_kind_relations_targeting_this as f64)),
        ("alreadyOpenAbove", Js::Bool(drawn.already_open_above)),
    ])
}

fn drawn_js(
    view: &View,
    grouping: Grouping,
    layout: &OverviewLayout,
    keys_list: Option<u64>,
    drawn: &DrawnEntry,
) -> Result<Js, StoreError> {
    let mut fields = card(view, grouping, layout, keys_list, drawn)?;
    let mut cells = Vec::new();
    for cell in &drawn.cells {
        cells.push(match cell {
            RegionCell::RelatedEntry(related) => drawn_js(view, grouping, layout, keys_list, related)?,
            RegionCell::NotShownTile {
                occurrence,
                not_shown,
            } => Js::Obj(vec![
                ("cell", Js::Text(b"notShownTile".to_vec())),
                ("occurrence", Js::Text(occurrence.clone().into_bytes())),
                ("groupingKindRelationsTargetingRegionEntryNotShown", Js::Num(*not_shown as f64)),
            ]),
        });
    }
    fields.push(("region", Js::Arr(cells)));
    Ok(Js::Obj(fields))
}

pub fn lone_card(
    view: &View,
    book: u64,
    grouping_kind: Option<u64>,
    card_text_characters: usize,
    keys_list: Option<u64>,
    entity: u64,
    occurrence: String,
) -> Result<Js, StoreError> {
    let grouping = Grouping::World {
        book,
        kind: grouping_kind,
    };
    let layout = OverviewLayout {
        regions_by_nesting_level: &[],
        card_text_characters,
    };
    let mut drawn = draw_entry(view, grouping, &[], &mut vec![entity])?;
    drawn.occurrence = occurrence;
    drawn_js(view, grouping, &layout, keys_list, &drawn)
}

pub fn read_overview(
    view: &View,
    grouping: Grouping,
    layout: &OverviewLayout,
    first_rank: u64,
    end_rank: u64,
    step_landed_on: Option<&str>,
) -> Result<Js, StoreError> {
    let total = top_level_count(view, grouping)?;
    let first_rank = first_rank.min(total);
    let end_rank = end_rank.clamp(first_rank, total);
    let keys_list = super::references::key_list(view, grouping.book())?;
    let mut entries = Vec::new();
    let levels = layout.regions_by_nesting_level;
    let found = top_level_from_rank(view, grouping, first_rank, (end_rank - first_rank) as usize)?;
    for (index, top) in found.into_iter().enumerate() {
        let drawn = draw_entry(view, grouping, levels, &mut grouping.path_from(top))?;
        let Js::Obj(mut fields) = drawn_js(view, grouping, layout, keys_list, &drawn)? else {
            unreachable!("a card is an object")
        };
        fields.push(("topLevelRank", Js::Num((first_rank + index as u64) as f64)));
        entries.push(Js::Obj(fields));
    }
    let landed = match step_landed_on {
        Some(stored_key) => match locate_occurrence(view, grouping, levels, stored_key)? {
            Some((_, occurrence, rank)) => step_landing(occurrence, rank),
            None => Js::Null,
        },
        None => Js::Null,
    };
    Ok(Js::Obj(vec![
        ("topLevelCount", Js::Num(total as f64)),
        ("firstRank", Js::Num(first_rank as f64)),
        ("entries", Js::Arr(entries)),
        ("stepLanding", landed),
    ]))
}

pub struct HeldRange {
    pub kind: u64,
    pub first_rank: u64,
    pub end_rank: u64,
    pub step_landed_on: Option<String>,
}

pub fn cards_per_top_level_entry(regions: &[RegionLayout]) -> u64 {
    let (mut cards, mut at_level) = (1u64, 1u64);
    for region in regions {
        at_level = at_level.saturating_mul(region.columns.saturating_mul(region.rows));
        cards = cards.saturating_add(at_level);
    }
    cards
}

// `held` comes most recently asked first; a range is cut, in that order and then the unasked sections' in kind
// order, so the whole read draws at most `max_cards` cards.
pub fn read_pointing_at(
    view: &View,
    book: u64,
    entry: u64,
    layout: &OverviewLayout,
    held: &[HeldRange],
    first_shown: u64,
    max_cards: u64,
) -> Result<Js, StoreError> {
    if uid_in(view, book, entry)?.is_none() {
        return Ok(Js::Null);
    }
    let kinds = relations::kinds_of_relations_in_use_targeting(view, book, entry)?;
    let per_source = cards_per_top_level_entry(layout.regions_by_nesting_level).max(1);
    let mut cards_left = max_cards;
    let mut ranges = std::collections::BTreeMap::new();
    let asked = held.iter().filter(|range| kinds.contains(&range.kind));
    let unasked = kinds
        .iter()
        .filter(|kind| !held.iter().any(|range| range.kind == **kind))
        .map(|kind| (*kind, 0, first_shown, None));
    let in_turn = asked
        .map(|range| (range.kind, range.first_rank, range.end_rank, range.step_landed_on.as_deref()))
        .chain(unasked);
    for (kind, first_rank, end_rank, step_landed_on) in in_turn {
        let grouping = Grouping::PointingAt { book, kind, entry };
        let count = top_level_count(view, grouping)?;
        let first_rank = first_rank.min(count);
        let fits = cards_left / per_source;
        let end_rank = end_rank.clamp(first_rank, count).min(first_rank.saturating_add(fits));
        cards_left -= (end_rank - first_rank) * per_source;
        ranges.insert(kind, (first_rank, end_rank, step_landed_on));
    }
    let mut sections = Vec::new();
    for (kind, (first_rank, end_rank, step_landed_on)) in ranges {
        let grouping = Grouping::PointingAt { book, kind, entry };
        let Js::Obj(read) = read_overview(view, grouping, layout, first_rank, end_rank, step_landed_on)? else {
            unreachable!("an overview's read is an object")
        };
        let mut section = vec![
            ("kind", Js::Text(kind.to_string().into_bytes())),
            (
                "kindName",
                relations::relation_kind_name(view, book, kind)?.map_or(Js::Null, Js::Text),
            ),
        ];
        for (name, value) in read {
            section.push((if name == "topLevelCount" { "count" } else { name }, value));
        }
        sections.push(Js::Obj(section));
    }
    Ok(Js::Obj(vec![("sections", Js::Arr(sections))]))
}
