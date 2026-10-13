//! The library list searched (build path 5d): a page of the characters and groups matching a search's clauses
//! under the list's filter, in relevance order or any of the list's orders.
//!
//! In relevance order the search reads its postings, the list's filter checked per document. The documents every
//! positive clause matches by a tag name alone score alike (`query::Found::tied`): they follow every match scoring
//! at least theirs, in the list's own order (as upstream's search kept the list's order among equal scores), read
//! as a list order is. In a list order, a search with at most √(page · library / READ_WHOLE) matches is read
//! whole and its matches placed in the order (as listed ids); otherwise the order is walked, each entity checked
//! against the search, under the list's work cap. The total is the search's (the listed ids' count when read
//! whole).

use super::StoreError;
use super::derive::View;
use super::library::{CHARACTER, GROUP, Scope as LibScope, count_key, counter};
use super::library_read::{self, LibraryCheck, Query};
use crate::search::Scope;
use crate::search::query::{
    self, After, Clause, Filter, Limits, Matching, Order, StatsCache, TagNames, Take,
};

/// What reading one match whole costs (its type, fav, filter and sort key read, then sorted) in walk steps (an
/// entity of the order examined and checked against the search): measured 10-11 at 10^5 synthetic cards, ~150 µs
/// against ~0.2 µs, rounded down. Matches are read whole when M · READ_WHOLE < P · N / M.
const READ_WHOLE: u64 = 512;

/// How a searched page is ordered.
#[derive(Debug, Clone, PartialEq)]
pub enum Ordered {
    /// Best match first; `after` where the page before ended, and `weights` the idfs it ranked by
    /// (`Searched::weights`). The list's `Query::sort` orders the tied matches.
    Relevance {
        after: Option<Resume>,
        weights: Option<Vec<f64>>,
    },
    /// The list's own `Query::sort`.
    List,
}

/// Where a relevance page ended, by ranks (`query::Hit::rank`).
#[derive(Debug, Clone, PartialEq)]
pub enum Resume {
    /// At a hit (rank, entity) that isn't tied.
    Score(f64, u64),
    /// Among the tied matches of this rank, at the list's cursor.
    Tied(f64, Vec<u8>),
    /// After the tied matches of this rank.
    Below(f64),
}

#[derive(Debug, Default)]
pub struct Searched {
    pub ids: Vec<u64>,
    /// Relevance order: each hit's score, and its rank (`query::Hit::rank`).
    pub scores: Vec<f64>,
    pub ranks: Vec<f64>,
    pub total: u64,
    pub total_exact: bool,
    pub more: bool,
    /// List order: the list's cursor.
    pub cursor: Option<Vec<u8>>,
    /// Relevance order, with `more`: where the next page starts, and the idfs it ranks by
    /// (`query::Found::weights`).
    pub next: Option<Resume>,
    pub weights: Option<Vec<f64>>,
    /// The searches' reports of blocks with maxima too high (`query::Found::tighten`).
    pub tighten: Vec<query::Tighten>,
}

/// The search filters standing for the list's filter: its ids and the tags it requires may lead the search (each
/// required tag, and the tags of which one is required, as the carriers of their merge sources), and the rest is
/// checked per document as a list page checks it.
pub(super) fn filters(view: &View, q: &Query) -> Result<Vec<Filter>, StoreError> {
    let f = &q.filter;
    let mut out = Vec::new();
    if let Some(ids) = &f.ids {
        out.push(Filter::Ids(ids.clone()));
    }
    let (all, any) = library_read::carried_sources(view, f)?;
    out.extend(all.into_iter().map(Filter::AnyTag));
    if !any.is_empty() {
        out.push(Filter::AnyTag(any));
    }
    if LibraryCheck::needed(f) {
        out.push(Filter::Check(std::sync::Arc::new(LibraryCheck(f.clone()))));
    }
    Ok(out)
}

fn search_query(
    filters: &[Filter],
    clauses: &[Clause],
    limit: usize,
    after: Option<After>,
    weights: Option<Vec<f64>>,
) -> query::Query {
    query::Query {
        scope: Scope::LIBRARY,
        clauses: clauses.to_vec(),
        filters: filters.to_vec(),
        order: Order::Relevance,
        limit,
        after,
        weights,
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
    // Every pass of the request plans the same clauses: the tags their names match are found once.
    let names = TagNames::default();
    let filters = filters(view, q)?;
    match ordered {
        Ordered::Relevance { after, weights } => {
            by_relevance(view, q, &filters, clauses, after, weights, cache, &names)
        }
        Ordered::List => by_list(view, q, &filters, clauses, cache, Take::All, &names),
    }
}

/// `filters` is `filters(view, q)`, read once per request.
fn by_relevance(
    view: &View,
    q: &Query,
    filters: &[Filter],
    clauses: &[Clause],
    after: Option<Resume>,
    weights: Option<Vec<f64>>,
    cache: &StatsCache,
    names: &TagNames,
) -> Result<Searched, StoreError> {
    // Without a cursor, the page starts `offset` hits in.
    let skip = if after.is_some() {
        0
    } else {
        q.offset as usize
    };
    let want = skip.saturating_add(q.limit);
    // Matches that aren't tied, from where the page starts among them.
    let from = match &after {
        Some(Resume::Score(s, d)) => Some(After::Score(*s, *d)),
        Some(Resume::Tied(t, _) | Resume::Below(t)) => Some(After::Score(*t, u64::MAX)),
        None => None,
    };
    let f = query::run_taking(
        view,
        &search_query(filters, clauses, want, from, weights),
        cache,
        Take::Untied,
        names,
    )?;
    let mut out = Searched {
        total: f.total,
        total_exact: f.total_exact,
        tighten: f.tighten.clone(),
        weights: f.weights.clone(),
        ..Searched::default()
    };
    let Some(tie) = f.tied else {
        for h in f.hits.iter().skip(skip) {
            out.ids.push(h.doc);
            out.scores.push(h.score);
            out.ranks.push(h.rank);
        }
        out.more = f.more;
        out.next = resume_at(&out, out.more);
        return Ok(out);
    };
    let (tied_total, tied_exact) =
        query::tied_count(view, &search_query(filters, clauses, 0, None, None), cache, names)?;
    out.total += tied_total;
    out.total_exact &= tied_exact;
    // Which of the tied, and of the matches below them, the page may start in.
    let (tied_from, below_only) = match &after {
        Some(Resume::Score(s, _)) if *s < tie => (None, true),
        Some(Resume::Tied(_, c)) => (Some(Some(c.clone())), false),
        Some(Resume::Below(_)) => (None, true),
        _ => (Some(None), false),
    };
    let (above, below): (Vec<_>, Vec<_>) = if below_only || matches!(after, Some(Resume::Tied(..)))
    {
        (
            Vec::new(),
            f.hits.into_iter().filter(|h| h.rank < tie).collect(),
        )
    } else {
        f.hits.into_iter().partition(|h| h.rank >= tie)
    };
    let below_more = f.more;
    let take = |out: &mut Searched, hits: &[query::Hit], skip: usize| {
        for h in hits.iter().skip(skip).take(q.limit - out.ids.len()) {
            out.ids.push(h.doc);
            out.scores.push(h.score);
            out.ranks.push(h.rank);
        }
    };
    take(&mut out, &above, skip);
    let mut below_skip = skip.saturating_sub(above.len());
    if let Some(cursor) = tied_from {
        if out.ids.len() == q.limit {
            out.more =
                below_more || !below.is_empty() || tied_total > 0 || above.len() > skip + q.limit;
            out.next = resume_at(&out, out.more);
            return Ok(out);
        }
        let mut tq = q.clone();
        tq.offset = below_skip as u64;
        tq.limit = q.limit - out.ids.len();
        tq.cursor = cursor;
        let tied = by_list(view, &tq, filters, clauses, cache, Take::Tied, names)?;
        out.tighten.extend(tied.tighten);
        out.ids.extend(&tied.ids);
        out.scores.extend(std::iter::repeat_n(
            f.tied_score.unwrap_or(tie),
            tied.ids.len(),
        ));
        out.ranks.extend(std::iter::repeat_n(tie, tied.ids.len()));
        // A list page's cursor says more follow (its `more`, that the work cap cut it short).
        out.total_exact &= !tied.more;
        if let Some(c) = tied.cursor {
            out.more = true;
            out.next = Some(Resume::Tied(tie, c));
            return Ok(out);
        }
        below_skip = below_skip.saturating_sub(tied_total as usize);
        if out.ids.len() == q.limit {
            out.more = below_more || !below.is_empty();
            out.next = out.more.then_some(Resume::Below(tie));
            return Ok(out);
        }
    }
    let before = out.ids.len();
    take(&mut out, &below, below_skip);
    out.more = below_more || below.len() > below_skip + (out.ids.len() - before);
    out.next = resume_at(&out, out.more);
    Ok(out)
}

/// Where the next page starts after the page's last hit, when more follow.
fn resume_at(out: &Searched, more: bool) -> Option<Resume> {
    let (&doc, &rank) = (out.ids.last()?, out.ranks.last()?);
    more.then_some(Resume::Score(rank, doc))
}

/// `filters` is `filters(view, q)`, read once per request.
fn by_list(
    view: &View,
    q: &Query,
    filters: &[Filter],
    clauses: &[Clause],
    cache: &StatsCache,
    take: Take,
    names: &TagNames,
) -> Result<Searched, StoreError> {
    let page = (q.limit as u64).saturating_add(q.offset).max(1);
    let few = q
        .cap
        .min((page.saturating_mul(library_size(view, q)?) / READ_WHOLE).isqrt());
    let mut out = Searched::default();
    // A count first (a word's is its counter); unless it is exact and over `few`, the matches read in id order,
    // all of them when at most `few`.
    match take {
        Take::Tied => {
            (out.total, out.total_exact) =
                query::tied_count(view, &search_query(filters, clauses, 0, None, None), cache, names)?;
        }
        _ => {
            let counted = query::run(view, &search_query(filters, clauses, 1, None, None), cache, names)?;
            out.total = counted.total;
            out.total_exact = counted.total_exact;
            out.tighten = counted.tighten;
        }
    }
    let over = out.total_exact && out.total > few;
    let all = if over {
        None
    } else {
        query::matches_whole(
            view,
            &search_query(filters, clauses, 0, None, None),
            cache,
            few as usize,
            take,
            names,
        )?
    };
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
    let mut clauses_only = search_query(filters, clauses, 0, None, None);
    clauses_only.filters.clear();
    let mut m = Matching::new(view, &clauses_only, cache, take, names)?;
    let complete = m.complete();
    let p = library_read::page_with(view, q, Some(Box::new(move |e| m.matches(e))))?;
    out.ids = p.ids;
    out.more = p.more || !complete;
    out.cursor = p.cursor;
    out.total_exact &= complete;
    Ok(out)
}
