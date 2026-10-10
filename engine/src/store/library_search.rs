//! The library list searched (build path 5d): a page of the characters and groups matching a search's clauses
//! under the list's filter, in relevance order or any of the list's orders, with the tags whose names match.
//!
//! In relevance order the search reads its postings, the list's filter checked per document. In a list order,
//! a search with at most √(page · library / READ_WHOLE) matches is read whole and its matches placed in the order
//! (as listed ids); otherwise the order is walked, each entity checked against the search, under the list's work
//! cap. The total is the search's (the listed ids' count when read whole).

use super::StoreError;
use super::derive::View;
use super::library::{CHARACTER, GROUP, Scope as LibScope, count_key, counter};
use super::library_read::{self, LibraryCheck, Query};
use crate::search::Scope;
use crate::search::query::{
    self, After, Clause, Filter, Found, Limits, Matching, Order, Refill, StatsCache, TagMatch,
};

/// What reading one match whole costs (its type, fav, filter and sort key read, then sorted) in walk steps (an
/// entity of the order examined and checked against the search): measured 10-11 at 10^5 synthetic cards, ~150 µs
/// against ~0.2 µs, rounded down. Matches are read whole when M · READ_WHOLE < P · N / M.
const READ_WHOLE: u64 = 512;

/// How a searched page is ordered.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Ordered {
    /// Best match first; `after` is the last hit of the page before.
    Relevance { after: Option<(f64, u64)> },
    /// The list's own `Query::sort`.
    List,
}

#[derive(Debug, Default)]
pub struct Searched {
    pub ids: Vec<u64>,
    /// Relevance order: each hit's score.
    pub scores: Vec<f64>,
    pub total: u64,
    pub total_exact: bool,
    pub more: bool,
    /// List order: the list's cursor.
    pub cursor: Option<Vec<u8>>,
    pub tags: Vec<TagMatch>,
    pub tags_exact: bool,
    pub refill: Option<Refill>,
}

/// The search filters standing for the list's filter: its ids lead the search, and the rest is checked per
/// document as a list page checks it (tags through their merges, which a leading tag filter wouldn't follow).
fn filters(q: &Query) -> Vec<Filter> {
    let f = &q.filter;
    let mut out = Vec::new();
    if let Some(ids) = &f.ids {
        out.push(Filter::Ids(ids.clone()));
    }
    if LibraryCheck::needed(f) {
        out.push(Filter::Check(std::sync::Arc::new(LibraryCheck(f.clone()))));
    }
    out
}

fn search_query(q: &Query, clauses: &[Clause], limit: usize, after: Option<After>) -> query::Query {
    query::Query {
        scope: Scope::LIBRARY,
        clauses: clauses.to_vec(),
        filters: filters(q),
        order: Order::Relevance,
        limit,
        after,
        limits: Limits::default(),
    }
}

/// Characters and groups of the kinds the filter lists.
fn library_size(view: &View, q: &Query) -> Result<u64, StoreError> {
    let mut n = 0i64;
    for (kind, on) in [(CHARACTER, q.filter.characters), (GROUP, q.filter.groups)] {
        if on {
            for fav in [false, true] {
                n += counter(view, &count_key(&LibScope::All, kind, fav))?;
            }
        }
    }
    Ok(n.max(0) as u64)
}

pub fn page(
    view: &View,
    q: &Query,
    clauses: &[Clause],
    ordered: Ordered,
    cache: &StatsCache,
) -> Result<Searched, StoreError> {
    match ordered {
        Ordered::Relevance { after } => by_relevance(view, q, clauses, after, cache),
        Ordered::List => by_list(view, q, clauses, cache),
    }
}

fn found_into(f: Found, out: &mut Searched) {
    out.total = f.total;
    out.total_exact = f.total_exact;
    out.tags = f.tags;
    out.tags_exact = f.tags_exact;
    out.refill = f.refill;
}

fn by_relevance(
    view: &View,
    q: &Query,
    clauses: &[Clause],
    after: Option<(f64, u64)>,
    cache: &StatsCache,
) -> Result<Searched, StoreError> {
    // Without a cursor, the page starts `offset` hits in.
    let skip = if after.is_some() {
        0
    } else {
        q.offset as usize
    };
    let sq = search_query(
        q,
        clauses,
        skip.saturating_add(q.limit),
        after.map(|(s, d)| After::Score(s, d)),
    );
    let f = query::run(view, &sq, cache)?;
    let mut out = Searched {
        more: f.more,
        ..Searched::default()
    };
    for h in f.hits.iter().skip(skip) {
        out.ids.push(h.doc);
        out.scores.push(h.score);
    }
    found_into(f, &mut out);
    Ok(out)
}

fn by_list(
    view: &View,
    q: &Query,
    clauses: &[Clause],
    cache: &StatsCache,
) -> Result<Searched, StoreError> {
    let page = (q.limit as u64).saturating_add(q.offset).max(1);
    let few = q
        .cap
        .min((page.saturating_mul(library_size(view, q)?) / READ_WHOLE).isqrt());
    // A count first (a word's is its counter); unless it is exact and over `few`, the matches read in id order,
    // all of them when at most `few`.
    let counted = query::run(view, &search_query(q, clauses, 1, None), cache)?;
    let over = counted.total_exact && counted.total > few;
    let all = if over {
        None
    } else {
        query::matches_whole(
            view,
            &search_query(q, clauses, 0, None),
            cache,
            few as usize,
        )?
    };
    let mut out = Searched::default();
    found_into(counted, &mut out);
    if let Some(ids) = all {
        let mut listed = q.clone();
        listed.filter.ids = Some(ids);
        let p = library_read::page(view, &listed)?;
        out.ids = p.ids;
        out.more = p.more;
        out.cursor = p.cursor;
        out.total = p.total.unwrap_or(out.total);
        out.total_exact = true;
        return Ok(out);
    }
    // The page checks the list's filter itself.
    let mut clauses_only = search_query(q, clauses, 0, None);
    clauses_only.filters.clear();
    let mut m = Matching::new(view, &clauses_only, cache)?;
    let complete = m.complete();
    let p = library_read::page_with(view, q, Some(Box::new(move |e| m.matches(e))))?;
    out.ids = p.ids;
    out.more = p.more || !complete;
    out.cursor = p.cursor;
    out.total_exact &= complete;
    Ok(out)
}
