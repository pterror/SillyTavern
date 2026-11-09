use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use super::StoreError;
use super::chat_read::Js;
use super::derive::View;
use super::entry_label;
use super::kinds::key;
use super::overview;
use super::references::key_list;
use super::relations;
use crate::search::Scope;
use crate::search::query::{self, After, CheckFn, Clause, DocCheck, Filter, Limits, Order, StatsCache, TagNames, Tighten};

pub const CHIP_WALK_VISITS: usize = 12_000;
const MEMO_HELD: usize = 1 << 20;

#[cfg(test)]
thread_local! {
    pub(super) static TEST_CHIP_WALK_VISITS: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
}

fn chip_walk_visits() -> usize {
    #[cfg(test)]
    if let Some(visits) = TEST_CHIP_WALK_VISITS.with(std::cell::Cell::get) {
        return visits;
    }
    CHIP_WALK_VISITS
}
const SCANNED_AT_ONCE: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Depth {
    Directly,
    AnyDepth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chip {
    pub kind: u64,
    pub target: u64,
    pub depth: Depth,
}

pub struct ResultsRead {
    pub book: u64,
    pub grouping_kind: Option<u64>,
    pub card_text_characters: usize,
    pub clauses: Vec<Clause>,
    pub chips: Vec<Chip>,
    /// The page at `from` (none: the first), then each page after the one before, until `pages` are read or the
    /// results end.
    pub from: Option<String>,
    pub pages: usize,
    pub limit: usize,
    /// The keys a region's walk reads (the results with no words) in all the run's pages: a page that reaches it ends
    /// there with a cursor that goes on, and the run ends at it.
    pub walk_steps: usize,
}

fn refused(why: &str) -> StoreError {
    StoreError::Refused(format!("world search: {why}"))
}

#[derive(Default)]
struct Reach {
    reached: HashSet<u64>,
    unreached: HashSet<u64>,
}

impl Reach {
    fn note(set: &mut HashSet<u64>, entity: u64) {
        if set.len() < MEMO_HELD {
            set.insert(entity);
        }
    }
}

fn reaches(view: &View, kind: u64, target: u64, from: u64, memo: &mut Reach) -> Result<bool, StoreError> {
    if from == target || memo.unreached.contains(&from) {
        return Ok(false);
    }
    if memo.reached.contains(&from) {
        return Ok(true);
    }
    let mut reached_from: HashMap<u64, u64> = HashMap::new();
    let mut queue = VecDeque::from([from]);
    let mut visits = 0;
    while let Some(node) = queue.pop_front() {
        visits += 1;
        if visits > chip_walk_visits() {
            return Ok(false);
        }
        for up in relations::targets_in_use_of_kind(view, node, kind)? {
            if up == target || memo.reached.contains(&up) {
                let mut at = node;
                Reach::note(&mut memo.reached, at);
                while let Some(&below) = reached_from.get(&at) {
                    Reach::note(&mut memo.reached, below);
                    at = below;
                }
                return Ok(true);
            }
            if up == from || memo.unreached.contains(&up) || reached_from.contains_key(&up) {
                continue;
            }
            reached_from.insert(up, node);
            queue.push_back(up);
        }
    }
    Reach::note(&mut memo.unreached, from);
    for (node, _) in reached_from {
        Reach::note(&mut memo.unreached, node);
    }
    Ok(false)
}

struct Chips {
    chips: Vec<Chip>,
    memos: Vec<Reach>,
}

impl Chips {
    fn new(chips: Vec<Chip>) -> Chips {
        let memos = chips.iter().map(|_| Reach::default()).collect();
        Chips { chips, memos }
    }

    fn pass(&mut self, view: &View, entity: u64) -> Result<bool, StoreError> {
        for (chip, memo) in self.chips.iter().zip(&mut self.memos) {
            let inside = match chip.depth {
                Depth::Directly => {
                    entity != chip.target
                        && relations::position_in_use(view, entity, chip.kind, chip.target)?.is_some()
                }
                Depth::AnyDepth => reaches(view, chip.kind, chip.target, entity, memo)?,
            };
            if !inside {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

struct ChipCheck(Vec<Chip>);

impl DocCheck for ChipCheck {
    fn begin<'v>(&self, view: &'v View<'v>) -> Result<CheckFn<'v>, StoreError> {
        let mut chips = Chips::new(self.0.clone());
        Ok(Box::new(move |entity| chips.pass(view, entity)))
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).ok())
        .collect()
}

fn hex_u64(number: u64) -> String {
    format!("{number:016x}")
}

fn unhex_u64(text: &str) -> Option<u64> {
    (text.len() == 16).then(|| u64::from_str_radix(text, 16).ok()).flatten()
}

struct Resume {
    rank: f64,
    doc: u64,
    weights: Option<Vec<f64>>,
}

fn relevance_cursor(rank: f64, doc: u64, weights: Option<&[f64]>) -> String {
    let mut cursor = format!("r{}{}", hex_u64(rank.to_bits()), hex_u64(doc));
    if let Some(weights) = weights {
        cursor.push('.');
        cursor.extend(weights.iter().map(|weight| hex_u64(weight.to_bits())));
    }
    cursor
}

fn parse_relevance_cursor(cursor: &str) -> Option<Resume> {
    let body = cursor.strip_prefix('r')?;
    let (head, weights) = match body.split_once('.') {
        Some((head, weights)) => (head, Some(weights)),
        None => (body, None),
    };
    if head.len() != 32 {
        return None;
    }
    let rank = f64::from_bits(unhex_u64(&head[..16])?);
    let doc = unhex_u64(&head[16..])?;
    let weights = match weights {
        None => None,
        Some(list) if list.len() % 16 == 0 => Some(
            (0..list.len())
                .step_by(16)
                .map(|at| unhex_u64(&list[at..at + 16]).map(f64::from_bits).filter(|w| w.is_finite()))
                .collect::<Option<Vec<_>>>()?,
        ),
        Some(_) => return None,
    };
    rank.is_finite().then_some(Resume { rank, doc, weights })
}

pub struct Page {
    pub entries: Vec<(u64, String)>,
    pub next: Option<String>,
}

#[allow(clippy::too_many_arguments)]
fn relevance_page(
    view: &View,
    cache: &StatsCache,
    scope: Scope,
    clauses: &[Clause],
    filters: Vec<Filter>,
    cursor: Option<&str>,
    limit: usize,
    tighten: &mut Vec<Tighten>,
) -> Result<Page, StoreError> {
    let resume = match cursor {
        None => None,
        Some(cursor) => Some(parse_relevance_cursor(cursor).ok_or_else(|| refused("that isn't a cursor of this search"))?),
    };
    let mut q = query::Query {
        scope,
        clauses: clauses.to_vec(),
        filters,
        order: Order::Relevance,
        limit,
        after: resume.as_ref().map(|resume| After::Score(resume.rank, resume.doc)),
        weights: resume.and_then(|resume| resume.weights),
        limits: Limits::default(),
    };
    let found = loop {
        let found = query::run(view, &q, cache, &TagNames::default())?;
        tighten.extend(found.tighten.iter().cloned());
        let Some(partial) = found.partial else {
            break found;
        };
        if q.weights.is_none() {
            q.weights = found.weights;
        }
        q.after = Some(After::Partial(Box::new(partial)));
    };
    let next = found
        .hits
        .last()
        .filter(|_| found.more)
        .map(|hit| relevance_cursor(hit.rank, hit.doc, found.weights.as_deref()));
    Ok(Page {
        entries: found.hits.iter().map(|hit| (hit.doc, hit.doc.to_string())).collect(),
        next,
    })
}

fn after_key(prefix: &[u8], after: Option<&[u8]>) -> Vec<u8> {
    let mut start = prefix.to_vec();
    if let Some(after) = after {
        start.extend_from_slice(after);
        start.push(0);
    }
    start
}

fn source_after(
    view: &View,
    prefix: &[u8],
    after: Option<&[u8]>,
) -> Result<Option<(Vec<u8>, u64)>, StoreError> {
    let Some((stored_key, _)) = view.scan(&after_key(prefix, after), &key::prefix_end(prefix), 1)?.pop() else {
        return Ok(None);
    };
    let (_, source) = relations::position_and_source_of_relation_of_kind_targeting(prefix, &stored_key)?;
    Ok(Some((stored_key[prefix.len()..].to_vec(), source)))
}

fn sources_page(
    view: &View,
    book: u64,
    lead: Chip,
    others: &mut Chips,
    cursor: Option<&str>,
    limit: usize,
    steps_left: &mut usize,
) -> Result<Page, StoreError> {
    let mut after = match cursor {
        None => None,
        Some(cursor) => Some(
            cursor
                .strip_prefix('d')
                .and_then(unhex)
                .ok_or_else(|| refused("that isn't a cursor of this search"))?,
        ),
    };
    let prefix = relations::relations_of_kind_targeting_prefix(book, lead.kind, lead.target);
    let end = key::prefix_end(&prefix);
    let mut entries = Vec::new();
    loop {
        let found = view.scan(&after_key(&prefix, after.as_deref()), &end, SCANNED_AT_ONCE)?;
        if found.is_empty() {
            return Ok(Page { entries, next: None });
        }
        for (stored_key, _) in found {
            if entries.len() == limit || *steps_left == 0 {
                return Ok(Page {
                    entries,
                    next: after.map(|after| format!("d{}", hex(&after))),
                });
            }
            *steps_left -= 1;
            let (_, source) = relations::position_and_source_of_relation_of_kind_targeting(&prefix, &stored_key)?;
            if source != lead.target && others.pass(view, source)? {
                entries.push((source, format!("{}/{source}", lead.target)));
            }
            after = Some(stored_key[prefix.len()..].to_vec());
        }
    }
}

struct Frame {
    node: u64,
    after: Option<Vec<u8>>,
}

fn walk_cursor(frames: &[Frame]) -> String {
    let parts: Vec<String> = frames
        .iter()
        .map(|frame| format!("{}{}", hex_u64(frame.node), frame.after.as_deref().map(hex).unwrap_or_default()))
        .collect();
    format!("w{}", parts.join("."))
}

fn parse_walk_cursor(cursor: &str, target: u64) -> Option<Vec<Frame>> {
    let frames = cursor
        .strip_prefix('w')?
        .split('.')
        .map(|part| {
            let node = unhex_u64(part.get(..16)?)?;
            let after = unhex(&part[16..])?;
            Some(Frame {
                node,
                after: (!after.is_empty()).then_some(after),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    (frames.first()?.node == target).then_some(frames)
}

fn region_page(
    view: &View,
    book: u64,
    lead: Chip,
    others: &mut Chips,
    cursor: Option<&str>,
    limit: usize,
    steps_left: &mut usize,
) -> Result<Page, StoreError> {
    let mut frames = match cursor {
        None => vec![Frame {
            node: lead.target,
            after: None,
        }],
        Some(cursor) => {
            parse_walk_cursor(cursor, lead.target).ok_or_else(|| refused("that isn't a cursor of this search"))?
        }
    };
    let mut entries = Vec::new();
    loop {
        let Some(frame) = frames.last() else {
            return Ok(Page { entries, next: None });
        };
        if *steps_left == 0 {
            return Ok(Page {
                entries,
                next: Some(walk_cursor(&frames)),
            });
        }
        *steps_left -= 1;
        let prefix = relations::relations_of_kind_targeting_prefix(book, lead.kind, frame.node);
        let Some((after, source)) = source_after(view, &prefix, frame.after.as_deref())? else {
            frames.pop();
            continue;
        };
        if entries.len() == limit {
            return Ok(Page {
                entries,
                next: Some(walk_cursor(&frames)),
            });
        }
        frames.last_mut().expect("a frame was read").after = Some(after);
        if frames.iter().any(|frame| frame.node == source) {
            continue;
        }
        if others.pass(view, source)? {
            let path: Vec<String> = frames.iter().map(|frame| frame.node.to_string()).collect();
            entries.push((source, format!("{}/{source}", path.join("/"))));
        }
        frames.push(Frame {
            node: source,
            after: None,
        });
    }
}

fn page_of(
    view: &View,
    cache: &StatsCache,
    read: &ResultsRead,
    cursor: Option<&str>,
    tighten: &mut Vec<Tighten>,
    steps_left: &mut usize,
) -> Result<Page, StoreError> {
    let scope = Scope::book(read.book);
    if !read.clauses.is_empty() {
        let filters = if read.chips.is_empty() {
            Vec::new()
        } else {
            vec![Filter::Check(Arc::new(ChipCheck(read.chips.clone())))]
        };
        return relevance_page(view, cache, scope, &read.clauses, filters, cursor, read.limit, tighten);
    }
    chip_led_page(view, read.book, &read.chips, cursor, read.limit, steps_left)
}

fn chip_led_page(
    view: &View,
    book: u64,
    chips: &[Chip],
    cursor: Option<&str>,
    limit: usize,
    steps_left: &mut usize,
) -> Result<Page, StoreError> {
    let lead_at = chips
        .iter()
        .position(|chip| chip.depth == Depth::Directly)
        .unwrap_or(0);
    let Some(&lead) = chips.get(lead_at) else {
        return Ok(Page {
            entries: Vec::new(),
            next: None,
        });
    };
    let mut others = Chips::new(
        chips
            .iter()
            .enumerate()
            .filter(|(at, _)| *at != lead_at)
            .map(|(_, chip)| *chip)
            .collect(),
    );
    match lead.depth {
        Depth::Directly => sources_page(view, book, lead, &mut others, cursor, limit, steps_left),
        Depth::AnyDepth => region_page(view, book, lead, &mut others, cursor, limit, steps_left),
    }
}

pub enum Selected {
    Entries(Vec<u64>),
    World,
    Filter { clauses: Vec<Clause>, chips: Vec<Chip> },
}

pub struct Walked {
    pub entries: Vec<u64>,
    pub next: Option<String>,
}

fn world_entries_prefix(book: u64) -> Vec<u8> {
    let mut prefix = key::id(key::ENTITY_KEY, super::books::ENTRY);
    prefix.extend_from_slice(format!("{book}:").as_bytes());
    prefix
}

fn world_page(view: &View, book: u64, cursor: Option<&str>, limit: usize) -> Result<Walked, StoreError> {
    let prefix = world_entries_prefix(book);
    let after = match cursor {
        None => None,
        Some(cursor) => Some(
            cursor
                .strip_prefix('k')
                .and_then(unhex)
                .ok_or_else(|| refused("that isn't a cursor of this selection"))?,
        ),
    };
    let mut start = prefix.clone();
    if let Some(after) = &after {
        start.extend_from_slice(after);
        start.push(0);
    }
    let end = key::prefix_end(&prefix);
    let mut entries = Vec::new();
    let mut last = after;
    loop {
        let found = view.scan(&start, &end, SCANNED_AT_ONCE)?;
        if found.is_empty() {
            return Ok(Walked { entries, next: None });
        }
        for (stored_key, value) in found {
            if entries.len() == limit {
                return Ok(Walked {
                    entries,
                    next: last.map(|last| format!("k{}", hex(&last))),
                });
            }
            let entity = super::library::parse_uvarint(&value)?;
            if relations::is_entry_of(view, book, entity)? {
                entries.push(entity);
            }
            let suffix = stored_key[prefix.len()..].to_vec();
            start = stored_key;
            start.push(0);
            last = Some(suffix);
        }
    }
}

fn listed_page(view: &View, book: u64, listed: &[u64], cursor: Option<&str>, limit: usize) -> Result<Walked, StoreError> {
    let from = match cursor {
        None => 0,
        Some(cursor) => cursor
            .strip_prefix('i')
            .and_then(|at| at.parse::<usize>().ok())
            .ok_or_else(|| refused("that isn't a cursor of this selection"))?,
    };
    let mut entries = Vec::new();
    for (at, &entity) in listed.iter().enumerate().skip(from) {
        if entries.len() == limit {
            return Ok(Walked {
                entries,
                next: Some(format!("i{at}")),
            });
        }
        if relations::is_entry_of(view, book, entity)? {
            entries.push(entity);
        }
    }
    Ok(Walked { entries, next: None })
}

fn matches_page(
    view: &View,
    cache: &StatsCache,
    book: u64,
    clauses: &[Clause],
    chips: &[Chip],
    cursor: Option<&str>,
    limit: usize,
) -> Result<Walked, StoreError> {
    let from = match cursor {
        None => 0,
        Some(cursor) => cursor
            .strip_prefix('s')
            .and_then(unhex_u64)
            .ok_or_else(|| refused("that isn't a cursor of this selection"))?,
    };
    let filters = if chips.is_empty() {
        Vec::new()
    } else {
        vec![Filter::Check(Arc::new(ChipCheck(chips.to_vec())))]
    };
    let q = query::Query {
        scope: Scope::book(book),
        clauses: clauses.to_vec(),
        filters,
        order: Order::Relevance,
        limit,
        after: None,
        weights: None,
        limits: Limits::default(),
    };
    let (entries, next) = query::matches_from(view, &q, cache, from, limit)?;
    Ok(Walked {
        entries,
        next: next.map(|doc| format!("s{}", hex_u64(doc))),
    })
}

// Only the chips-only walk is in an order writes can change: a reorder in the leading chip's region can move an entry
// across its cursor. That walk reads at most `walk_steps` keys of the region, then ends with a cursor that goes on.
pub fn walk_selected(
    view: &View,
    cache: &StatsCache,
    book: u64,
    selected: &Selected,
    cursor: Option<&str>,
    limit: usize,
    mut walk_steps: usize,
) -> Result<Walked, StoreError> {
    match selected {
        Selected::Entries(listed) => listed_page(view, book, listed, cursor, limit),
        Selected::World => world_page(view, book, cursor, limit),
        Selected::Filter { clauses, chips } if !clauses.is_empty() => {
            matches_page(view, cache, book, clauses, chips, cursor, limit)
        }
        Selected::Filter { chips, .. } => {
            let page = chip_led_page(view, book, chips, cursor, limit, &mut walk_steps)?;
            Ok(Walked {
                entries: page.entries.into_iter().map(|(entity, _)| entity).collect(),
                next: page.next,
            })
        }
    }
}

pub fn read_results(
    view: &View,
    cache: &StatsCache,
    read: &ResultsRead,
) -> Result<(Js, Vec<Tighten>), StoreError> {
    let keys_list = key_list(view, read.book)?;
    let mut tighten = Vec::new();
    let mut chips = Vec::with_capacity(read.chips.len());
    for chip in &read.chips {
        chips.push(Js::Obj(vec![
            (
                "kindName",
                relations::relation_kind_name(view, read.book, chip.kind)?.map_or(Js::Null, Js::Text),
            ),
            (
                "target",
                match overview::uid_in(view, read.book, chip.target)? {
                    Some(_) => entry_label::named(view, keys_list, chip.target)?.js(),
                    None => Js::Null,
                },
            ),
        ]));
    }
    let mut pages = Vec::new();
    let mut cursor = read.from.clone();
    let mut steps_left = read.walk_steps;
    while pages.len() < read.pages {
        let page = match page_of(view, cache, read, cursor.as_deref(), &mut tighten, &mut steps_left) {
            Err(StoreError::Refused(_)) => Page {
                entries: Vec::new(),
                next: None,
            },
            read_page => read_page?,
        };
        let mut cards = Vec::with_capacity(page.entries.len());
        for (entity, occurrence) in page.entries {
            cards.push(overview::lone_card(
                view,
                read.book,
                read.grouping_kind,
                read.card_text_characters,
                keys_list,
                entity,
                occurrence,
            )?);
        }
        pages.push(Js::Obj(vec![
            ("cursor", cursor.map_or(Js::Null, |at| Js::Text(at.into_bytes()))),
            ("entries", Js::Arr(cards)),
            ("next", page.next.clone().map_or(Js::Null, |next| Js::Text(next.into_bytes()))),
        ]));
        match page.next {
            Some(next) if steps_left > 0 => cursor = Some(next),
            _ => break,
        }
    }
    Ok((
        Js::Obj(vec![("chips", Js::Arr(chips)), ("pages", Js::Arr(pages))]),
        tighten,
    ))
}

pub fn find_entries(
    view: &View,
    cache: &StatsCache,
    book: u64,
    clauses: &[Clause],
    limit: usize,
) -> Result<(Js, Vec<Tighten>), StoreError> {
    let mut tighten = Vec::new();
    if clauses.is_empty() {
        return Ok((
            Js::Obj(vec![("entries", Js::Arr(Vec::new())), ("next", Js::Null)]),
            tighten,
        ));
    }
    let page = relevance_page(view, cache, Scope::book(book), clauses, Vec::new(), None, limit, &mut tighten)?;
    let keys_list = key_list(view, book)?;
    let mut entries = Vec::with_capacity(page.entries.len());
    for (entity, _) in page.entries {
        entries.push(entry_label::named(view, keys_list, entity)?.js());
    }
    Ok((
        Js::Obj(vec![
            ("entries", Js::Arr(entries)),
            ("next", page.next.map_or(Js::Null, |next| Js::Text(next.into_bytes()))),
        ]),
        tighten,
    ))
}
