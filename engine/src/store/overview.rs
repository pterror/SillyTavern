use super::StoreError;
use super::books::{ENTRY, EntryKey, entry_key, parse_entry_key};
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
    own_key: EntryKey,
    occurrence: String,
    member_count: u64,
    already_open_above: bool,
    cells: Vec<RegionCell>,
}

enum RegionCell {
    Member(DrawnEntry),
    MoreTile { occurrence: String, more: u64 },
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
    let own_key = uid_in(view, grouping.book, entity)?
        .ok_or_else(|| StoreError::Entry(format!("member {entity} isn't an entry")))?;
    let occurrence = occurrence_key(path);
    let already_open_above = path[..path.len() - 1].contains(&entity);
    let mut drawn = DrawnEntry {
        entity,
        occurrence,
        member_count: 0,
        already_open_above,
        cells: Vec::new(),
        own_key,
    };
    let Some(kind) = grouping.kind else {
        return Ok(drawn);
    };
    let target_key = drawn.own_key.text();
    drawn.member_count = relations::member_count(view, grouping.book, kind, &target_key)?;
    let level = path.len() - 1;
    let Some(region) = layout.get(level) else {
        return Ok(drawn);
    };
    if already_open_above || drawn.member_count == 0 {
        return Ok(drawn);
    }
    let cells = region.columns.saturating_mul(region.rows);
    if cells == 0 {
        return Ok(drawn);
    }
    let shown = if drawn.member_count <= cells {
        drawn.member_count
    } else {
        cells - 1
    };
    let prefix = relations::group_members_prefix(grouping.book, kind, &target_key);
    for (stored_key, _) in view.scan(&prefix, &key::prefix_end(&prefix), shown as usize)? {
        path.push(relations::member_of_group_key(&prefix, &stored_key)?.1);
        let member = draw_entry(view, grouping, layout, path);
        path.pop();
        drawn.cells.push(RegionCell::Member(member?));
    }
    if drawn.member_count > shown {
        drawn.cells.push(RegionCell::MoreTile {
            occurrence: format!("{}/+", drawn.occurrence),
            more: drawn.member_count - shown,
        });
    }
    Ok(drawn)
}

fn reading_order(drawn: &DrawnEntry, out: &mut Vec<String>) {
    out.push(drawn.occurrence.clone());
    for cell in &drawn.cells {
        match cell {
            RegionCell::Member(member) => reading_order(member, out),
            RegionCell::MoreTile { occurrence, .. } => out.push(occurrence.clone()),
        }
    }
}

fn find_occurrence<'d>(drawn: &'d DrawnEntry, occurrence_wanted: &str) -> Option<&'d DrawnEntry> {
    if drawn.occurrence == occurrence_wanted {
        return Some(drawn);
    }
    drawn.cells.iter().find_map(|cell| match cell {
        RegionCell::Member(member)
            if occurrence_wanted.starts_with(&format!("{}/", member.occurrence))
                || member.occurrence == occurrence_wanted =>
        {
            find_occurrence(member, occurrence_wanted)
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
        return Ok(None);
    };
    if let Some(kind) = grouping.kind
        && relations::strong_kinds(&relations::relations_of_entry(view, entity)?).contains(&kind)
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
                    RegionCell::Member(member) => member.occurrence.clone(),
                    RegionCell::MoreTile { occurrence, .. } => occurrence.clone(),
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
    for ((kind, target_key), relation) in relations::relations_of_entry(view, drawn.entity)? {
        let target = library::entity_by_key(
            view,
            ENTRY,
            &entry_key(grouping.book, &EntryKey::parse(&target_key)),
        )?;
        relations_line.push(Js::Obj(vec![
            ("kind", Js::Text(kind.to_string().into_bytes())),
            (
                "kindName",
                relations::relation_kind_name(view, grouping.book, kind)?
                    .map_or(Js::Null, Js::Text),
            ),
            ("targetKey", Js::Text(target_key)),
            (
                "target",
                target.map_or(Js::Null, |entity| Js::Text(entity.to_string().into_bytes())),
            ),
            (
                "targetTitle",
                match target {
                    Some(entity) => text_or_null(view, entity, COMMENT)?,
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
        ("entryKey", Js::Text(drawn.own_key.text())),
        ("title", text_or_null(view, drawn.entity, COMMENT)?),
        ("text", Js::Text(text)),
        ("textCut", Js::Bool(text_cut)),
        ("keys", Js::Arr(keys)),
        ("relations", Js::Arr(relations_line)),
        ("memberCount", Js::Num(drawn.member_count as f64)),
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
            RegionCell::Member(member) => drawn_js(view, grouping, layout, keys_list, member)?,
            RegionCell::MoreTile { occurrence, more } => Js::Obj(vec![
                ("cell", Js::Text(b"more".to_vec())),
                ("occurrence", Js::Text(occurrence.clone().into_bytes())),
                ("moreCount", Js::Num(*more as f64)),
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
