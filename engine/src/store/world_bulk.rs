use std::collections::HashSet;

use super::StoreError;
use super::chat_read::Js;
use super::derive::{Out, View};
use super::kinds::key;
use super::relations::{self, RELATION_CHANGES_PER_STEP};
use super::world_search::{self, Selected};
use crate::keyspace::val::get_u64;
use crate::log::format::FieldRef;
use crate::search::query::StatsCache;

// (b, job) → (): kept while the book's field of that bulk job exists.
pub const BULK_JOBS: u64 = 247;

pub const BULK_JOB_FIELD_PREFIX: &[u8] = b"\x01bulkJob:";

fn job_key(book: u64, job: u64) -> Vec<u8> {
    key::ids(BULK_JOBS, book, job)
}

pub fn job_of_field(field: &FieldRef) -> Option<u64> {
    let FieldRef::Key(name) = field else {
        return None;
    };
    let digits = name.strip_prefix(BULK_JOB_FIELD_PREFIX)?;
    let canonical = !digits.is_empty()
        && digits.len() <= 15
        && digits.iter().all(u8::is_ascii_digit)
        && (digits.len() == 1 || digits[0] != b'0');
    canonical
        .then(|| std::str::from_utf8(digits).ok()?.parse::<u64>().ok())
        .flatten()
}

pub fn job_field_written(out: &mut Out, book: u64, job: u64, json: bool, new: Option<&[u8]>) {
    if new.is_some() && !json {
        out.put(job_key(book, job), Vec::new());
    } else {
        out.del(job_key(book, job));
    }
}

pub fn book_gone(view: &View, out: &mut Out, book: u64) -> Result<(), StoreError> {
    let prefix = key::id(BULK_JOBS, book);
    for (stored_key, _) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
        out.del(stored_key);
    }
    Ok(())
}

pub fn running_jobs(view: &View) -> Result<Js, StoreError> {
    let prefix = key::of(BULK_JOBS);
    let mut jobs = Vec::new();
    for (stored_key, _) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
        let mut read_at = prefix.len();
        let bad = || StoreError::Entry("a bulk job's marker doesn't decode".into());
        let book = get_u64(&stored_key, &mut read_at).ok_or_else(bad)?;
        let job = get_u64(&stored_key, &mut read_at).ok_or_else(bad)?;
        jobs.push(Js::Obj(vec![
            ("book", Js::Big(book)),
            ("job", Js::Num(job as f64)),
        ]));
    }
    Ok(Js::Arr(jobs))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BulkAction {
    Delete,
    Set,
    MoveTo { kind: u64, target: u64 },
    AlsoPutIn { kind: u64, target: u64 },
}

pub struct BulkRead {
    pub book: u64,
    pub selected: Selected,
    pub except: HashSet<u64>,
    pub cursor: Option<String>,
    pub limit: usize,
    pub action: BulkAction,
}

fn chosen(walked: &[u64], except: &HashSet<u64>) -> Vec<u64> {
    let mut seen = HashSet::new();
    walked
        .iter()
        .copied()
        .filter(|entity| !except.contains(entity) && seen.insert(*entity))
        .collect()
}

fn relations_in_use_targeting(view: &View, book: u64, entity: u64) -> Result<u64, StoreError> {
    let mut count = 0;
    for kind in relations::kinds_of_relations_in_use_targeting(view, book, entity)? {
        count += relations::count_of_relations_of_kind_targeting(view, book, kind, entity)?;
        if count >= RELATION_CHANGES_PER_STEP as u64 {
            break;
        }
    }
    Ok(count.min(RELATION_CHANGES_PER_STEP as u64))
}

// Each deletion makes up to RELATION_CHANGES_PER_STEP relations targeting its entry kept in its own commit.
fn deletions_fitting_a_step(
    view: &View,
    read: &BulkRead,
    walked: &[u64],
) -> Result<usize, StoreError> {
    let mut weight = 0u64;
    let mut seen = HashSet::new();
    for (at, &entity) in walked.iter().enumerate() {
        if read.except.contains(&entity) || !seen.insert(entity) {
            continue;
        }
        let this = 1 + relations_in_use_targeting(view, read.book, entity)?;
        if weight > 0 && weight + this > RELATION_CHANGES_PER_STEP as u64 {
            return Ok(at);
        }
        weight += this;
    }
    Ok(walked.len())
}

fn ended(why: &str) -> Js {
    Js::Obj(vec![("ended", Js::Text(why.as_bytes().to_vec()))])
}

pub fn bulk_chunk(view: &View, cache: &StatsCache, read: &BulkRead) -> Result<Js, StoreError> {
    if let BulkAction::MoveTo { kind, target } | BulkAction::AlsoPutIn { kind, target } =
        read.action
    {
        if relations::relation_kind_name(view, read.book, kind)?.is_none() {
            return Ok(ended("This world has no such relation kind."));
        }
        if relations::relation_kind_being_merged_into(view, read.book, kind)?.is_some() {
            return Ok(ended(
                "This relation kind is being merged into another; pick that one.",
            ));
        }
        if !relations::is_entry_of(view, read.book, target)? {
            return Ok(ended("The target isn't an entry of this world."));
        }
    }
    let walk = |limit| {
        world_search::walk_selected(
            view,
            cache,
            read.book,
            &read.selected,
            read.cursor.as_deref(),
            limit,
        )
    };
    let mut walked = walk(read.limit)?;
    if read.action == BulkAction::Delete {
        let fitting = deletions_fitting_a_step(view, read, &walked.entries)?;
        if fitting < walked.entries.len() {
            walked = walk(fitting)?;
        }
    }
    let entities = chosen(&walked.entries, &read.except);
    let rewrites = match read.action {
        BulkAction::MoveTo { kind, target } => {
            relations::bulk_relation_rewrites(view, read.book, kind, target, &entities, true)?
        }
        BulkAction::AlsoPutIn { kind, target } => {
            relations::bulk_relation_rewrites(view, read.book, kind, target, &entities, false)?
        }
        BulkAction::Delete | BulkAction::Set => Js::Arr(Vec::new()),
    };
    Ok(Js::Obj(vec![
        ("ended", Js::Null),
        (
            "entities",
            Js::Arr(entities.into_iter().map(Js::Big).collect()),
        ),
        ("rewrites", rewrites),
        (
            "next",
            walked
                .next
                .map_or(Js::Null, |next| Js::Text(next.into_bytes())),
        ),
    ]))
}

// `capped`: at least `matching` are selected; a walk that spends its budget first stops below `cap`.
pub fn selection_count(
    view: &View,
    cache: &StatsCache,
    book: u64,
    selected: &Selected,
    except: &HashSet<u64>,
    cap: usize,
) -> Result<Js, StoreError> {
    let (matching, capped) = match selected {
        Selected::World => {
            let entries = super::book_stats::book_stat(view, book)?.entries.max(0) as u64;
            let mut excepted = 0;
            for &entity in except {
                if relations::is_entry_of(view, book, entity)? {
                    excepted += 1;
                }
            }
            (entries.saturating_sub(excepted), false)
        }
        _ => {
            let limit = cap + 1 + except.len();
            let walked = world_search::walk_selected(view, cache, book, selected, None, limit)?;
            let found = chosen(&walked.entries, except).len();
            (found.min(cap) as u64, found > cap || walked.next.is_some())
        }
    };
    Ok(Js::Obj(vec![
        ("matching", Js::Num(matching as f64)),
        ("capped", Js::Bool(capped)),
    ]))
}
