use super::StoreError;
use super::books::{ENTRY, EntryKey, parse_entry_key};
use super::chat_read::Js;
use super::derive::View;
use super::kinds::{key, text_value};
use super::library::{self, entity_info, item_field};
use super::relations;
use super::world_order_tree as tree;
use crate::log::format::FieldRef;

const COMMENT: u64 = 103;
const CONTENT: u64 = 104;

#[derive(Clone, Copy)]
pub struct Grouping {
    pub book: u64,
    pub kind: Option<u64>,
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

fn uid_in(view: &View, book: u64, entity: u64) -> Result<Option<EntryKey>, StoreError> {
    Ok(match entity_info(view, entity)? {
        Some((ENTRY, stored_key, _)) => match parse_entry_key(&stored_key)? {
            (entry_book, own_key) if entry_book == book => Some(own_key),
            _ => None,
        },
        _ => None,
    })
}

fn occurrence_key(path: &[u64]) -> String {
    path.iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join("/")
}

fn draw_entry(
    view: &View,
    grouping: Grouping,
    layout: &[RegionLayout],
    path: &mut Vec<u64>,
) -> Result<DrawnEntry, StoreError> {
    let entity = *path.last().expect("a drawn entry is on its path");
    let (own_key, place_of_deleted_entry) = match uid_in(view, grouping.book, entity)? {
        Some(own_key) => (Some(own_key), false),
        None => match relations::deletion_in_progress(view, entity)? {
            Some(deleting) if deleting.book == grouping.book => (None, true),
            _ => return Err(StoreError::Entry(format!("{entity} isn't an entry of this world"))),
        },
    };
    let occurrence = occurrence_key(path);
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
    let Some(kind) = grouping.kind else {
        return Ok(drawn);
    };
    drawn.grouping_kind_relations_targeting_this =
        relations::count_of_relations_of_kind_targeting(view, grouping.book, kind, entity)?;
    let level = path.len() - 1;
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
    let prefix = relations::relations_of_kind_targeting_prefix(grouping.book, kind, entity);
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
    tree::top_level_count(
        view,
        &relations::order_tree_space(grouping.book),
        grouping.kind,
    )
}

fn top_level_entry_at(
    view: &View,
    grouping: Grouping,
    layout: &[RegionLayout],
    rank: u64,
) -> Result<Option<DrawnEntry>, StoreError> {
    let book_tree = relations::order_tree_space(grouping.book);
    let Some(order_key) =
        tree::top_level_from_rank(view, &book_tree, grouping.kind, rank, 1)?.pop()
    else {
        return Ok(None);
    };
    draw_entry(
        view,
        grouping,
        layout,
        &mut vec![tree::entity_of_order_key(&order_key)],
    )
    .map(Some)
}

fn top_level_rank_of(
    view: &View,
    grouping: Grouping,
    entity: u64,
) -> Result<Option<u64>, StoreError> {
    let Some(own_key) = uid_in(view, grouping.book, entity)? else {
        let (Some(kind), Some(deleting)) =
            (grouping.kind, relations::deletion_in_progress(view, entity)?)
        else {
            return Ok(None);
        };
        if deleting.book != grouping.book
            || relations::count_of_relations_of_kind_targeting(view, deleting.book, kind, entity)? == 0
        {
            return Ok(None);
        }
        let order_key = tree::order_key(deleting.order_value, entity);
        let book_tree = relations::order_tree_space(deleting.book);
        return tree::top_level_rank(view, &book_tree, &order_key, grouping.kind).map(Some);
    };
    if let Some(kind) = grouping.kind
        && relations::strong_kinds_in_use_of_entry(view, entity)?.contains(&kind)
    {
        return Ok(None);
    }
    let order_key = relations::order_key_of_entry(view, entity, &own_key)?;
    let book_tree = relations::order_tree_space(grouping.book);
    if !tree::holds_entry(view, &book_tree, &order_key)? {
        return Ok(None);
    }
    tree::top_level_rank(view, &book_tree, &order_key, grouping.kind).map(Some)
}

fn parse_occurrence_key(occurrence: &str) -> Option<Vec<&str>> {
    let parts: Vec<&str> = occurrence.split('/').collect();
    let ok = parts.iter().enumerate().all(|(index, part)| {
        (*part == "+" && index == parts.len() - 1 && index > 0)
            || (!part.is_empty()
                && part.len() <= 20
                && part.bytes().all(|character| character.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0')))
    });
    ok.then_some(parts)
}

fn locate_occurrence(
    view: &View,
    grouping: Grouping,
    layout: &[RegionLayout],
    occurrence_wanted: &str,
) -> Result<Option<(DrawnEntry, String, u64)>, StoreError> {
    let Some(parts) = parse_occurrence_key(occurrence_wanted) else {
        return Err(refused(format!(
            "{occurrence_wanted:?} isn't an occurrence's key"
        )));
    };
    let Ok(top) = parts[0].parse::<u64>() else {
        return Ok(None);
    };
    let Some(rank) = top_level_rank_of(view, grouping, top)? else {
        return Ok(None);
    };
    let drawn = draw_entry(view, grouping, layout, &mut vec![top])?;
    let mut order = Vec::new();
    reading_order(&drawn, &mut order);
    let found = (1..=parts.len())
        .rev()
        .map(|length| parts[..length].join("/"))
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
        OverviewStep::ToParent => {
            let up = match occurrence.rsplit_once('/') {
                Some((up, _)) => up.to_string(),
                None => occurrence,
            };
            Ok(step_landing(up, rank))
        }
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

fn text_or_null(view: &View, entity: u64, code: u64) -> Result<Js, StoreError> {
    Ok(text_value(view, entity, &FieldRef::Code(code))?.map_or(Js::Null, Js::Text))
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
    let mut keys = Vec::new();
    if let Some(list) = keys_list {
        let prefix = key::ids(key::ITEM, drawn.entity, list);
        for (_, value) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
            let item = library::parse_uvarint(&value)?;
            if let Some(key_text) = text_value(view, drawn.entity, &item_field(list, item))? {
                keys.push(Js::Text(key_text));
            }
        }
    }
    let mut relations_line = Vec::new();
    for ((kind, target), stored) in relations::stored_relations_of_entry(view, drawn.entity)? {
        let relation = stored.relation;
        let target_key = uid_in(view, grouping.book, target)?;
        relations_line.push(Js::Obj(vec![
            ("kind", Js::Text(kind.to_string().into_bytes())),
            (
                "kindName",
                relations::relation_kind_name(view, grouping.book, kind)?
                    .map_or(Js::Null, Js::Text),
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
            ("target", Js::Text(target.to_string().into_bytes())),
            (
                "targetTitle",
                match target_key {
                    Some(_) => text_or_null(view, target, COMMENT)?,
                    None => Js::Null,
                },
            ),
            ("weak", Js::Bool(relation.weak)),
        ]));
    }
    Ok(vec![
        ("cell", Js::Text(b"entry".to_vec())),
        (
            "occurrence",
            Js::Text(drawn.occurrence.clone().into_bytes()),
        ),
        ("entry", Js::Text(drawn.entity.to_string().into_bytes())),
        ("entryKey", drawn.own_key.as_ref().map_or(Js::Null, |own_key| Js::Text(own_key.text()))),
        ("title", text_or_null(view, drawn.entity, COMMENT)?),
        ("text", Js::Text(text)),
        ("textCut", Js::Bool(text_cut)),
        ("keys", Js::Arr(keys)),
        ("relations", Js::Arr(relations_line)),
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
    let keys_list = super::references::key_list(view, grouping.book)?;
    let mut entries = Vec::new();
    let book_tree = relations::order_tree_space(grouping.book);
    let levels = layout.regions_by_nesting_level;
    let found = tree::top_level_from_rank(
        view,
        &book_tree,
        grouping.kind,
        first_rank,
        (end_rank - first_rank) as usize,
    )?;
    for (index, order_key) in found.iter().enumerate() {
        let drawn = draw_entry(
            view,
            grouping,
            levels,
            &mut vec![tree::entity_of_order_key(order_key)],
        )?;
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
