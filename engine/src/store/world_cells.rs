//! The cells of a board or a grid: each cell is the entries that pass all its filters (the view's own and one per
//! axis), read from the index of one of them and checked against the rest, so a cell's cost follows its results.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use super::StoreError;
use super::chat_read::Js;
use super::derive::View;
use super::kinds::key;
use super::overview;
use super::references::key_list;
use super::relations;
use super::world_order_tree::{self as tree, Counted};
use super::world_search::{self, Chip, Depth, Reach, SCANNED_AT_ONCE, reaches};
use crate::search::Scope;
use crate::search::query::{CheckFn, Clause, DocCheck, Filter, StatsCache, Tighten};

// Region heads drawn above an entry in a cell: its grouping relation's targets, and theirs. A cell draws at most this
// many heads per entry in it, `CELL_HEADS_ABOVE` in packages/areas/worldbuilding/protocol.ts.
const HEADS_ABOVE: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Is {
    Target(u64, Depth),
    // Has a strong relation of the kind in use.
    Any,
    // Has no strong relation of the kind in use.
    No,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AxisFilter {
    pub kind: u64,
    pub is: Is,
}

impl From<Chip> for AxisFilter {
    fn from(chip: Chip) -> AxisFilter {
        AxisFilter {
            kind: chip.kind,
            is: Is::Target(chip.target, chip.depth),
        }
    }
}

pub struct CellAsk {
    pub filters: Vec<AxisFilter>,
    // Entries drawn; 0 counts only.
    pub limit: usize,
}

pub struct CellsRead {
    pub book: u64,
    pub grouping_kind: Option<u64>,
    pub card_text_characters: usize,
    pub clauses: Vec<Clause>,
    pub chips: Vec<Chip>,
    pub cells: Vec<CellAsk>,
    // A cell's count stops here: past it the count is shown as "N+".
    pub count_up_to: usize,
    // The index keys one cell's walk reads at most; a walk that reaches it ends with its count capped.
    pub walk_steps: usize,
}

struct Checks {
    filters: Vec<AxisFilter>,
    memos: Vec<Reach>,
}

impl Checks {
    fn new(filters: Vec<AxisFilter>) -> Checks {
        let memos = filters.iter().map(|_| Reach::default()).collect();
        Checks { filters, memos }
    }

    fn pass(&mut self, view: &View, entity: u64) -> Result<bool, StoreError> {
        let mut strong = None;
        for (filter, memo) in self.filters.iter().zip(&mut self.memos) {
            let inside = match filter.is {
                Is::Target(target, Depth::Directly) => {
                    entity != target && relations::position_in_use(view, entity, filter.kind, target)?.is_some()
                }
                Is::Target(target, Depth::AnyDepth) => reaches(view, filter.kind, target, entity, memo)?,
                Is::Any | Is::No => {
                    if strong.is_none() {
                        strong = Some(relations::strong_kinds_in_use_of_entry(view, entity)?);
                    }
                    let has = strong.as_ref().is_some_and(|kinds| kinds.contains(&filter.kind));
                    has == (filter.is == Is::Any)
                }
            };
            if !inside {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

struct FilterCheck(Vec<AxisFilter>);

impl DocCheck for FilterCheck {
    fn begin<'v>(&self, view: &'v View<'v>) -> Result<CheckFn<'v>, StoreError> {
        let mut checks = Checks::new(self.0.clone());
        Ok(Box::new(move |entity| checks.pass(view, entity)))
    }
}

struct Matched {
    entries: Vec<u64>,
    count: usize,
    capped: bool,
}

struct Walk<'a> {
    view: &'a View<'a>,
    book: u64,
    checks: Checks,
    limit: usize,
    up_to: usize,
    steps_left: usize,
    seen: HashSet<u64>,
    matched: Matched,
}

enum Went {
    On,
    Done,
}

impl Walk<'_> {
    // Takes one entry the leading index read: counted when it passes, and the walk says whether to go on.
    fn take(&mut self, entity: u64) -> Result<Went, StoreError> {
        if self.steps_left == 0 {
            self.matched.capped = true;
            return Ok(Went::Done);
        }
        self.steps_left -= 1;
        if !self.seen.insert(entity) || !self.checks.pass(self.view, entity)? {
            return Ok(Went::On);
        }
        if self.matched.count == self.up_to {
            self.matched.capped = true;
            return Ok(Went::Done);
        }
        self.matched.count += 1;
        if self.matched.entries.len() < self.limit {
            self.matched.entries.push(entity);
        }
        Ok(Went::On)
    }

    fn sources(&mut self, kind: u64, target: u64) -> Result<(), StoreError> {
        let prefix = relations::relations_of_kind_targeting_prefix(self.book, kind, target);
        let end = key::prefix_end(&prefix);
        let mut start = prefix.clone();
        loop {
            let found = self.view.scan(&start, &end, SCANNED_AT_ONCE)?;
            if found.is_empty() {
                return Ok(());
            }
            for (stored_key, _) in found {
                let (_, source) = relations::position_and_source_of_relation_of_kind_targeting(&prefix, &stored_key)?;
                if source != target
                    && let Went::Done = self.take(source)?
                {
                    return Ok(());
                }
                start = stored_key;
                start.push(0);
            }
        }
    }

    // Walks down from `target` through the sources of `kind` in drawing order (each source, then what is under it,
    // then the next), each entry once.
    fn region(&mut self, kind: u64, target: u64) -> Result<(), StoreError> {
        let mut frames: Vec<(u64, Option<Vec<u8>>)> = vec![(target, None)];
        let mut visited = HashSet::from([target]);
        while let Some((node, after)) = frames.last_mut() {
            let prefix = relations::relations_of_kind_targeting_prefix(self.book, kind, *node);
            let mut start = prefix.clone();
            if let Some(after) = after.as_ref() {
                start = after.clone();
                start.push(0);
            }
            let Some((stored_key, _)) = self.view.scan(&start, &key::prefix_end(&prefix), 1)?.pop() else {
                frames.pop();
                continue;
            };
            let (_, source) = relations::position_and_source_of_relation_of_kind_targeting(&prefix, &stored_key)?;
            *after = Some(stored_key);
            if !visited.insert(source) {
                continue;
            }
            if let Went::Done = self.take(source)? {
                return Ok(());
            }
            frames.push((source, None));
        }
        Ok(())
    }

    fn in_world_order(&mut self, counted: Counted) -> Result<(), StoreError> {
        let order = relations::order_tree_space(self.book);
        let mut skip = 0;
        loop {
            let leaves = tree::from_rank(self.view, &order, counted, skip, SCANNED_AT_ONCE)?;
            if leaves.is_empty() {
                return Ok(());
            }
            skip += leaves.len() as u64;
            for leaf in leaves {
                let leaf: tree::OrderKey = leaf
                    .as_slice()
                    .try_into()
                    .map_err(|_| StoreError::Entry("a world order leaf isn't 16 bytes".into()))?;
                let entity = tree::entity_of_order_key(&leaf);
                if !relations::is_entry_of(self.view, self.book, entity)? {
                    continue;
                }
                if let Went::Done = self.take(entity)? {
                    return Ok(());
                }
            }
        }
    }
}

// The filter whose index leads the walk: a direct target's sources, a target's region, then the world order's entries
// with or without a relation of the kind.
fn leading(filters: &[AxisFilter]) -> Option<usize> {
    let rank = |filter: &AxisFilter| match filter.is {
        Is::Target(_, Depth::Directly) => 0,
        Is::Target(_, Depth::AnyDepth) => 1,
        Is::Any => 2,
        Is::No => 3,
    };
    filters
        .iter()
        .enumerate()
        .min_by_key(|(_, filter)| rank(filter))
        .map(|(at, _)| at)
}

fn matched(
    view: &View,
    cache: &StatsCache,
    read: &CellsRead,
    filters: Vec<AxisFilter>,
    limit: usize,
    tighten: &mut Vec<Tighten>,
) -> Result<Matched, StoreError> {
    if !read.clauses.is_empty() {
        let filters = if filters.is_empty() {
            Vec::new()
        } else {
            vec![Filter::Check(Arc::new(FilterCheck(filters)))]
        };
        let page = world_search::relevance_page(
            view,
            cache,
            Scope::book(read.book),
            &read.clauses,
            filters,
            None,
            read.count_up_to,
            tighten,
        )?;
        let count = page.entries.len();
        return Ok(Matched {
            entries: page.entries.into_iter().take(limit).map(|(entity, _)| entity).collect(),
            count,
            capped: page.next.is_some(),
        });
    }
    let Some(lead_at) = leading(&filters) else {
        return Ok(Matched {
            entries: Vec::new(),
            count: 0,
            capped: false,
        });
    };
    let lead = filters[lead_at];
    let others = filters
        .iter()
        .enumerate()
        .filter(|(at, _)| *at != lead_at)
        .map(|(_, filter)| *filter)
        .collect();
    let mut walk = Walk {
        view,
        book: read.book,
        checks: Checks::new(others),
        limit,
        up_to: read.count_up_to,
        steps_left: read.walk_steps,
        seen: HashSet::new(),
        matched: Matched {
            entries: Vec::new(),
            count: 0,
            capped: false,
        },
    };
    match lead.is {
        Is::Target(target, Depth::Directly) => walk.sources(lead.kind, target)?,
        Is::Target(target, Depth::AnyDepth) => walk.region(lead.kind, target)?,
        Is::Any => walk.in_world_order(Counted::Held(lead.kind))?,
        Is::No => walk.in_world_order(Counted::TopLevel(Some(lead.kind)))?,
    }
    Ok(walk.matched)
}

struct Node {
    in_cell: bool,
    members: Vec<u64>,
}

// The cell's entries under the region heads of the grouping kind: an entry with a relation of that kind is drawn in
// its target's region, and that target in its own target's, up to HEADS_ABOVE heads; a head that isn't in the cell is
// drawn for where its members are.
fn grouped(view: &View, read: &CellsRead, keys_list: Option<u64>, hits: &[u64]) -> Result<Vec<Js>, StoreError> {
    let mut nodes: HashMap<u64, Node> = HashMap::new();
    let mut roots: Vec<u64> = Vec::new();
    let mut placed: HashSet<u64> = HashSet::new();
    let cap = hits.len() * (1 + HEADS_ABOVE);
    // `path`: the entries being placed below this one, so a loop of the grouping kind ends at the entry it came back to.
    #[allow(clippy::too_many_arguments)]
    fn place(
        view: &View,
        kind: Option<u64>,
        entity: u64,
        cap: usize,
        path: &mut Vec<u64>,
        nodes: &mut HashMap<u64, Node>,
        roots: &mut Vec<u64>,
        placed: &mut HashSet<u64>,
    ) -> Result<(), StoreError> {
        nodes.entry(entity).or_insert(Node {
            in_cell: false,
            members: Vec::new(),
        });
        if !placed.insert(entity) {
            return Ok(());
        }
        let heads = match kind {
            Some(kind) if path.len() < HEADS_ABOVE => relations::strong_targets_in_use_of_kind(view, entity, kind)?,
            _ => Vec::new(),
        };
        path.push(entity);
        let heads: Vec<u64> = heads
            .into_iter()
            .filter(|head| !path.contains(head) && (nodes.contains_key(head) || nodes.len() < cap))
            .collect();
        if heads.is_empty() {
            roots.push(entity);
        }
        for head in heads {
            place(view, kind, head, cap, path, nodes, roots, placed)?;
            let node = nodes.get_mut(&head).expect("a placed head has a node");
            if !node.members.contains(&entity) {
                node.members.push(entity);
            }
        }
        path.pop();
        Ok(())
    }
    for &hit in hits {
        place(view, read.grouping_kind, hit, cap, &mut Vec::new(), &mut nodes, &mut roots, &mut placed)?;
        if let Some(node) = nodes.get_mut(&hit) {
            node.in_cell = true;
        }
    }
    fn draw(
        view: &View,
        read: &CellsRead,
        keys_list: Option<u64>,
        nodes: &HashMap<u64, Node>,
        entity: u64,
        path: &mut Vec<u64>,
    ) -> Result<Js, StoreError> {
        path.push(entity);
        let occurrence = path.iter().map(u64::to_string).collect::<Vec<_>>().join("/");
        let card = overview::lone_card(
            view,
            read.book,
            read.grouping_kind,
            read.card_text_characters,
            keys_list,
            entity,
            occurrence,
        )?;
        let node = &nodes[&entity];
        let mut members = Vec::new();
        for &member in &node.members {
            if !path.contains(&member) {
                members.push(draw(view, read, keys_list, nodes, member, path)?);
            }
        }
        path.pop();
        let Js::Obj(mut fields) = card else {
            return Err(StoreError::Entry("a card isn't an object".into()));
        };
        fields.retain(|(name, _)| *name != "region");
        fields.push(("region", Js::Arr(members)));
        fields.push(("inCell", Js::Bool(node.in_cell)));
        Ok(Js::Obj(fields))
    }
    let mut drawn = Vec::with_capacity(roots.len());
    for root in roots {
        drawn.push(draw(view, read, keys_list, &nodes, root, &mut Vec::new())?);
    }
    Ok(drawn)
}

pub fn read_cells(view: &View, cache: &StatsCache, read: &CellsRead) -> Result<(Js, Vec<Tighten>), StoreError> {
    let keys_list = key_list(view, read.book)?;
    let mut tighten = Vec::new();
    let mut cells = Vec::with_capacity(read.cells.len());
    for ask in &read.cells {
        let filters: Vec<AxisFilter> = read
            .chips
            .iter()
            .map(|chip| AxisFilter::from(*chip))
            .chain(ask.filters.iter().copied())
            .collect();
        let found = matched(view, cache, read, filters, ask.limit, &mut tighten)?;
        let entries = if found.entries.is_empty() {
            Vec::new()
        } else {
            grouped(view, read, keys_list, &found.entries)?
        };
        cells.push(Js::Obj(vec![
            ("entries", Js::Arr(entries)),
            ("count", Js::Num(found.count as f64)),
            ("capped", Js::Bool(found.capped)),
            ("more", Js::Bool(found.count > found.entries.len() || found.capped)),
        ]));
    }
    Ok((Js::Arr(cells), tighten))
}
