use super::StoreError;
use super::derive::View;
use super::library::{CHARACTER, GROUP, Scope as LibScope, count_key, counter};
use super::library_read::{self, LibraryCheck, Query};
use crate::search::Scope;
use crate::search::query::{
    self, After, Clause, Filter, Limits, Matching, Order, StatsCache, TagNames, Take,
};

const READ_WHOLE: u64 = 512;

#[derive(Debug, Clone, PartialEq)]
pub enum Ordered {
    Relevance {
        after: Option<Resume>,
        weights: Option<Vec<f64>>,
    },
    List,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Resume {
    Score(f64, u64),
    Tied(f64, Vec<u8>),
    Below(f64),
}

#[derive(Debug, Default)]
pub struct Searched {
    pub ids: Vec<u64>,
    pub scores: Vec<f64>,
    pub ranks: Vec<f64>,
    pub total: u64,
    pub total_exact: bool,
    pub more: bool,
    pub cursor: Option<Vec<u8>>,
    pub next: Option<Resume>,
    pub weights: Option<Vec<f64>>,
    pub tighten: Vec<query::Tighten>,
    pub partial: Option<query::Partial>,
}

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

#[cfg(test)]
thread_local! {
    pub(super) static TEST_LIMITS: std::cell::Cell<Option<Limits>> = const { std::cell::Cell::new(None) };
}

fn limits() -> Limits {
    #[cfg(test)]
    if let Some(l) = TEST_LIMITS.with(std::cell::Cell::get) {
        return l;
    }
    Limits::default()
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
        limits: limits(),
    }
}

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
    page_continued(view, q, clauses, ordered, cache, None)
}

pub fn page_continued(
    view: &View,
    q: &Query,
    clauses: &[Clause],
    ordered: Ordered,
    cache: &StatsCache,
    partial: Option<query::Partial>,
) -> Result<Searched, StoreError> {
    let names = TagNames::default();
    let filters = filters(view, q)?;
    match ordered {
        Ordered::Relevance { after, weights } => {
            by_relevance(view, q, &filters, clauses, after, weights, partial, cache, &names)
        }
        Ordered::List => by_list(view, q, &filters, clauses, cache, Take::All, &names),
    }
}

fn by_relevance(
    view: &View,
    q: &Query,
    filters: &[Filter],
    clauses: &[Clause],
    after: Option<Resume>,
    weights: Option<Vec<f64>>,
    partial: Option<query::Partial>,
    cache: &StatsCache,
    names: &TagNames,
) -> Result<Searched, StoreError> {
    let skip = if after.is_some() {
        0
    } else {
        q.offset as usize
    };
    let want = skip.saturating_add(q.limit);
    let from = match (&after, partial) {
        (_, Some(p)) => Some(After::Partial(Box::new(p))),
        (Some(Resume::Score(s, d)), None) => Some(After::Score(*s, *d)),
        (Some(Resume::Tied(t, _) | Resume::Below(t)), None) => Some(After::Score(*t, u64::MAX)),
        (None, None) => None,
    };
    let f = query::run_taking(
        view,
        &search_query(filters, clauses, want, from, weights),
        cache,
        Take::Untied,
        names,
    )?;
    if f.partial.is_some() {
        return Ok(Searched {
            tighten: f.tighten,
            weights: f.weights,
            partial: f.partial,
            ..Searched::default()
        });
    }
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
        out.total_exact &= !tied.more;
        if let Some(c) = tied.cursor {
            out.more = true;
            out.next = Some(Resume::Tied(tie, c));
            return Ok(out);
        }
        if below_skip > 0 {
            let tied_exact_total = if tied_exact {
                tied_total
            } else {
                query::tied_count_exact(view, &search_query(filters, clauses, 0, None, None), cache, names)?
            };
            below_skip = below_skip.saturating_sub(tied_exact_total as usize);
        }
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

fn resume_at(out: &Searched, more: bool) -> Option<Resume> {
    let (&doc, &rank) = (out.ids.last()?, out.ranks.last()?);
    more.then_some(Resume::Score(rank, doc))
}

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
