use std::cmp::Ordering;
use std::cmp::Reverse;
use std::collections::{BTreeSet, BinaryHeap, HashMap};
use std::sync::Arc;

use super::text::{GRAM_MAX, GRAM_MIN, char_len, first_chars, phrase_count, phrase_in, tokens};
use super::{
    BLOCK_BITS, DOCS_SLOT, FIELD_BITS, FieldHit, GROUP_BITS, LENGTH_BITS, LEVELS, SHORTEST_BASE,
    Scope, TermKind, block_maxima, block_maxima_at, bound_slot, code_length, doc_count,
    field_max_slot, field_score, idf, length_block, length_code, lengths, max_doc, max_slot,
    max_value, node_of, parse_varint, posting_block, postings, shortest, slot_in, term_counts_of,
    top_level, unmax_slot, unpack, unslot,
};
use crate::keyspace::val::{Val, counter_value, get_u64, put_u64};
use crate::store::carriers::{self, TagMap};
use crate::store::derive::View;
use crate::store::kinds::{key, search_texts};
use crate::store::{StoreError, StoreResult};

const MAPS_HELD: usize = 1 << 22;

const TIED_COUNTED: u64 = 128;
const TIED_COUNT_WORK: u64 = 16_384;

pub const SEEK: u64 = 96;
pub const PAIRS: u64 = 8;
pub const TEXT: u64 = 128;
pub const MEMBER_BLOCK_MILLI: u64 = 694;
pub const MEMBER_PLACE_MILLI: u64 = 131;
pub const TERM_MAP_BLOCK_MILLI: u64 = 522;
pub const TERM_MAP_PLACE_MILLI: u64 = 144;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub enumerate: u64,
    pub ranked: u64,
    pub walked: u64,
    pub tags: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            enumerate: 250_000,
            ranked: 100_000,
            walked: 100_000,
            tags: 60_000,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Clause {
    pub text: Vec<u8>,
    pub fields: Option<Vec<u32>>,
    pub negate: bool,
    pub quoted: bool,
}

pub trait DocCheck: Send + Sync {
    fn begin<'v>(&self, view: &'v View<'v>) -> StoreResult<CheckFn<'v>>;
}

pub type CheckFn<'v> = Box<dyn FnMut(u64) -> StoreResult<bool> + 'v>;

impl std::fmt::Debug for dyn DocCheck {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DocCheck")
    }
}

#[derive(Debug, Clone)]
pub enum Filter {
    AllTags(Vec<u64>),
    AnyTag(Vec<u64>),
    NoTag(Vec<u64>),
    Ids(Vec<u64>),
    NotIds(Vec<u64>),
    Check(Arc<dyn DocCheck>),
}

pub trait SortKey: Send + Sync {
    fn key_of(&self, view: &View, doc: u64) -> StoreResult<Vec<u8>>;
    fn walk(
        &self,
        view: &View,
        after: Option<&(Vec<u8>, u64)>,
        limit: usize,
    ) -> StoreResult<Vec<(Vec<u8>, u64)>>;
}

#[derive(Clone)]
pub enum Order {
    Relevance,
    Key(Arc<dyn SortKey>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum After {
    Score(f64, u64),
    Key(Vec<u8>, u64),
    Partial(Box<Partial>),
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Partial {
    pub after: Option<(f64, u64)>,
    pub from: u64,
    pub best: Vec<(f64, u64)>,
    pub total: u64,
    pub skipped: bool,
}

#[derive(Clone)]
pub struct Query {
    pub scope: Scope,
    pub clauses: Vec<Clause>,
    pub filters: Vec<Filter>,
    pub order: Order,
    pub limit: usize,
    pub after: Option<After>,
    pub weights: Option<Vec<f64>>,
    pub limits: Limits,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub doc: u64,
    pub score: f64,
    pub rank: f64,
    pub key: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Default)]
pub struct Found {
    pub hits: Vec<Hit>,
    pub total: u64,
    pub total_exact: bool,
    pub page_exact: bool,
    pub more: bool,
    pub work: u64,
    pub scans: u64,
    pub entries: u64,
    pub pairs: u64,
    pub gets: u64,
    pub texts: u64,
    pub length_reads: u64,
    pub steps: u64,
    pub checked: u64,
    pub posting_blocks: u64,
    pub max_reads: u64,
    pub next_blocks: u64,
    pub nodes_passed: [u64; LEVELS],
    pub plan_micros: u64,
    pub tied: Option<f64>,
    pub tied_score: Option<f64>,
    pub weights: Option<Vec<f64>>,
    pub partial: Option<Partial>,
    pub tighten: Vec<Tighten>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Tighten {
    pub scope: Scope,
    pub term: String,
    pub block: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Take {
    All,
    Untied,
    Tied,
}

#[derive(Default)]
pub struct TagNames(std::cell::OnceCell<Vec<Option<Named>>>);

#[derive(Clone)]
struct Named {
    source: Source,
    done: bool,
    count: u64,
}

#[derive(Default)]
pub struct StatsCache(std::sync::Mutex<HashMap<Scope, (u64, Arc<Stats>)>>);

pub fn run(view: &View, q: &Query, cache: &StatsCache, names: &TagNames) -> StoreResult<Found> {
    match &q.order {
        Order::Relevance => ranked(view, q, cache, names),
        Order::Key(_) => run_taking(view, q, cache, Take::All, names),
    }
}

pub fn run_taking(
    view: &View,
    q: &Query,
    cache: &StatsCache,
    take: Take,
    names: &TagNames,
) -> StoreResult<Found> {
    let mut ctx = Ctx::new(view, Some(cache));
    let started = std::time::Instant::now();
    let mut plan = Plan::new(&mut ctx, q, take, names)?;
    let plan_micros = started.elapsed().as_micros() as u64;
    let mut found = match &q.order {
        Order::Relevance => plan.by_relevance(&mut ctx, q, Read::Chosen, names)?,
        Order::Key(k) => plan.by_key(&mut ctx, q, k.as_ref())?,
    };
    if !plan.complete {
        found.page_exact = false;
        found.total_exact = false;
        found.more = true;
    }
    found.tied = plan.tied();
    found.tied_score = plan.tied().map(|t| t * plan.scale);
    found.weights = plan.weights();
    found.work = ctx.work;
    found.scans = ctx.scans;
    found.entries = ctx.entries;
    found.pairs = ctx.pairs;
    found.gets = ctx.gets;
    found.texts = ctx.texts;
    found.length_reads = ctx.length_reads;
    found.steps = ctx.steps;
    found.checked = ctx.checked;
    found.posting_blocks = ctx.posting_blocks;
    found.max_reads = ctx.max_reads;
    found.next_blocks = ctx.next_blocks;
    found.nodes_passed = ctx.nodes_passed;
    found.plan_micros = plan_micros;
    found.tighten = ctx.tighten;
    Ok(found)
}

#[cfg(test)]
pub(super) fn run_counting(view: &View, q: &Query, cache: &StatsCache) -> StoreResult<Found> {
    run_read(view, q, cache, Read::Counting)
}

#[cfg(test)]
pub(super) fn run_ranked(view: &View, q: &Query, cache: &StatsCache) -> StoreResult<Found> {
    run_read(view, q, cache, Read::Ranked)
}

#[cfg(test)]
pub(super) fn run_chosen(view: &View, q: &Query, cache: &StatsCache) -> StoreResult<Found> {
    run_read(view, q, cache, Read::Chosen)
}

#[cfg(test)]
fn run_read(view: &View, q: &Query, cache: &StatsCache, read: Read) -> StoreResult<Found> {
    let mut ctx = Ctx::new(view, Some(cache));
    let names = TagNames::default();
    let mut plan = Plan::new(&mut ctx, q, Take::Untied, &names)?;
    let found = plan.by_relevance(&mut ctx, q, read, &names)?;
    Ok(Found {
        work: ctx.work,
        gets: ctx.gets,
        steps: ctx.steps,
        checked: ctx.checked,
        ..found
    })
}

fn ranked(view: &View, q: &Query, cache: &StatsCache, names: &TagNames) -> StoreResult<Found> {
    let mut f = run_taking(view, q, cache, Take::Untied, names)?;
    let Some(tie) = f.tied else {
        return Ok(f);
    };
    let (tied_total, tied_exact) = tied_count(view, q, cache, names)?;
    f.total += tied_total;
    f.total_exact &= tied_exact;
    let from = match &q.after {
        Some(After::Score(s, _)) if *s < tie => return Ok(f),
        Some(After::Score(s, d)) if *s == tie => Some(d.saturating_add(1)),
        _ => None,
    };
    let hits = std::mem::take(&mut f.hits);
    let (above, below): (Vec<Hit>, Vec<Hit>) = match from {
        Some(_) => (
            Vec::new(),
            hits.into_iter().filter(|h| h.rank < tie).collect(),
        ),
        None => hits.into_iter().partition(|h| h.rank >= tie),
    };
    let more_below = f.more;
    f.hits = above;
    if f.hits.len() >= q.limit {
        f.more = more_below || !below.is_empty() || tied_total > 0;
        return Ok(f);
    }
    let room = q.limit - f.hits.len();
    let (tied, done) = tied_ids(view, q, cache, from.unwrap_or(0), room + 1, names)?;
    f.page_exact &= done || tied.len() > room;
    let tied_more = tied.len() > room;
    let score = f.tied_score.unwrap_or(tie);
    f.hits.extend(tied.into_iter().take(room).map(|doc| Hit {
        doc,
        score,
        rank: tie,
        key: None,
    }));
    if tied_more || !done {
        f.more = true;
        return Ok(f);
    }
    let room = q.limit - f.hits.len();
    f.more = more_below || below.len() > room;
    f.hits.extend(below.into_iter().take(room));
    Ok(f)
}

pub fn tied_ids(
    view: &View,
    q: &Query,
    cache: &StatsCache,
    from: u64,
    most: usize,
    names: &TagNames,
) -> StoreResult<(Vec<u64>, bool)> {
    let mut ctx = Ctx::new(view, Some(cache));
    let mut plan = Plan::new(&mut ctx, q, Take::Tied, names)?;
    let budget = ctx.work.saturating_add(q.limits.enumerate);
    let mut out = Vec::new();
    let mut d = from;
    loop {
        match plan.next_match(&mut ctx, d, u64::MAX, budget, None, &mut Walk::default())? {
            Step::Match(doc, _) => {
                if out.len() == most {
                    return Ok((out, plan.complete));
                }
                out.push(doc);
                d = doc + 1;
            }
            Step::End => return Ok((out, plan.complete)),
            Step::Stopped(_) => return Ok((out, false)),
        }
    }
}

pub fn tied_count(
    view: &View,
    q: &Query,
    cache: &StatsCache,
    names: &TagNames,
) -> StoreResult<(u64, bool)> {
    let mut ctx = Ctx::new(view, Some(cache));
    let mut plan = Plan::new(&mut ctx, q, Take::Tied, names)?;
    if plan.tied().is_none() {
        return Ok((0, true));
    }
    if let Some(n) = plan.tied_estimate(&mut ctx)? {
        return Ok((n, false));
    }
    let budget = ctx
        .work
        .saturating_add(TIED_COUNT_WORK.min(q.limits.enumerate));
    let mut n = 0;
    let mut d = 0;
    loop {
        match plan.next_match(&mut ctx, d, u64::MAX, budget, None, &mut Walk::default())? {
            Step::Match(doc, _) => {
                n += 1;
                d = doc + 1;
            }
            Step::End => return Ok((n, plan.complete)),
            Step::Stopped(at) => return Ok((plan.estimate(&mut ctx, n, at)?, false)),
        }
    }
}

pub fn tied_count_exact(
    view: &View,
    q: &Query,
    cache: &StatsCache,
    names: &TagNames,
) -> StoreResult<u64> {
    let mut ctx = Ctx::new(view, Some(cache));
    let mut plan = Plan::new(&mut ctx, q, Take::Tied, names)?;
    if plan.tied().is_none() {
        return Ok(0);
    }
    let mut n = 0;
    let mut d = 0;
    loop {
        match plan.next_match(&mut ctx, d, u64::MAX, u64::MAX, None, &mut Walk::default())? {
            Step::Match(doc, _) => {
                n += 1;
                d = doc + 1;
            }
            Step::End | Step::Stopped(_) => return Ok(n),
        }
    }
}

pub fn matches_whole(
    view: &View,
    q: &Query,
    cache: &StatsCache,
    most: usize,
    take: Take,
    names: &TagNames,
) -> StoreResult<Option<Vec<u64>>> {
    let mut ctx = Ctx::new(view, Some(cache));
    let mut plan = Plan::new(&mut ctx, q, take, names)?;
    if !plan.complete {
        return Ok(None);
    }
    let budget = ctx.work.saturating_add(q.limits.enumerate);
    let mut out = Vec::new();
    let mut d = 0;
    loop {
        match plan.next_match(&mut ctx, d, u64::MAX, budget, None, &mut Walk::default())? {
            Step::Match(doc, _) => {
                if out.len() == most {
                    return Ok(None);
                }
                out.push(doc);
                d = doc + 1;
            }
            Step::End => return Ok(Some(out)),
            Step::Stopped(_) => return Ok(None),
        }
    }
}

pub fn docs_with_terms(
    view: &View,
    scope: Scope,
    terms: &[(String, bool)],
    mask: u64,
    after: Option<u64>,
    limit: usize,
) -> StoreResult<(Vec<u64>, bool)> {
    let defs = scope.fields();
    let mut ctx = Ctx::new(view, None);
    let mut lists: Vec<(BlockDocs, bool)> = Vec::with_capacity(terms.len());
    let start = after.map_or(0, |a| a + 1);
    for (term, as_prefix) in terms {
        let mut b = BlockDocs::postings(scope, term, mask);
        b.seek(&mut ctx, start)?;
        lists.push((b, *as_prefix));
    }
    let mut out = Vec::new();
    loop {
        let Some(d) = lists.iter().filter_map(|(b, _)| b.doc()).min() else {
            return Ok((out, false));
        };
        let mut hit = false;
        for (b, as_prefix) in &lists {
            if b.doc() != Some(d) {
                continue;
            }
            hit = hit
                || b.doc_pairs().any(|(f, v)| {
                    defs.get(f as usize)
                        .is_some_and(|def| super::unpack(def.prefix, v).tf(*as_prefix) > 0)
                });
        }
        if hit {
            if out.len() == limit {
                return Ok((out, true));
            }
            out.push(d);
        }
        for (b, _) in &mut lists {
            if b.doc() == Some(d) {
                b.seek(&mut ctx, d + 1)?;
            }
        }
    }
}

pub fn matches_upto(
    view: &View,
    q: &Query,
    cache: &StatsCache,
    budget: u64,
) -> StoreResult<(Vec<u64>, bool, u64)> {
    let mut ctx = Ctx::new(view, Some(cache));
    let mut plan = Plan::new(&mut ctx, q, Take::All, &TagNames::default())?;
    let complete = plan.complete;
    let mut out = Vec::new();
    let mut d = 0;
    loop {
        match plan.next_match(&mut ctx, d, u64::MAX, budget, None, &mut Walk::default())? {
            Step::Match(doc, _) => {
                out.push(doc);
                d = doc + 1;
            }
            Step::End => return Ok((out, complete, ctx.work)),
            Step::Stopped(_) => return Ok((out, false, ctx.work)),
        }
    }
}

pub struct Matching<'a> {
    ctx: Ctx<'a>,
    plan: Plan,
}

impl<'a> Matching<'a> {
    pub fn new(
        view: &'a View<'a>,
        q: &Query,
        cache: &'a StatsCache,
        take: Take,
        names: &TagNames,
    ) -> StoreResult<Matching<'a>> {
        let mut ctx = Ctx::new(view, Some(cache));
        let plan = Plan::new(&mut ctx, q, take, names)?;
        Ok(Matching { ctx, plan })
    }

    pub fn complete(&self) -> bool {
        self.plan.complete
    }

    pub fn matches(&mut self, d: u64) -> StoreResult<bool> {
        let mut matched = Vec::with_capacity(self.plan.pos.len());
        for m in &mut self.plan.pos {
            match m.check(&mut self.ctx, d)? {
                Some(x) => matched.push(x),
                None => return Ok(false),
            }
        }
        Ok(self.plan.takes(&matched) && self.plan.passes(&mut self.ctx, d)?)
    }

    pub fn work(&self) -> u64 {
        self.ctx.work
    }
}

pub(crate) struct Ctx<'a> {
    view: &'a View<'a>,
    cache: Option<&'a StatsCache>,
    work: u64,
    scans: u64,
    entries: u64,
    pairs: u64,
    gets: u64,
    texts: u64,
    length_reads: u64,
    steps: u64,
    checked: u64,
    posting_blocks: u64,
    max_reads: u64,
    next_blocks: u64,
    nodes_passed: [u64; LEVELS],
    shortest: HashMap<(Scope, u32, u64), Option<u64>>,
    max_docs: HashMap<Scope, u64>,
    maps: HashMap<Vec<u8>, Arc<Vec<(u32, u32)>>>,
    map_pairs: usize,
    term_counts: HashMap<Vec<u8>, Vec<(u32, u64)>>,
    codes: Option<(Scope, u64, [u8; 1 << FIELD_BITS])>,
    checks: Vec<CheckFn<'a>>,
    pairs_built: Option<bool>,
    milli: u64,
    tighten: Vec<Tighten>,
}

impl<'a> Ctx<'a> {
    fn new(view: &'a View<'a>, cache: Option<&'a StatsCache>) -> Ctx<'a> {
        Ctx {
            view,
            cache,
            work: 0,
            scans: 0,
            entries: 0,
            pairs: 0,
            gets: 0,
            texts: 0,
            length_reads: 0,
            steps: 0,
            posting_blocks: 0,
            max_reads: 0,
            next_blocks: 0,
            nodes_passed: [0; LEVELS],
            checked: 0,
            shortest: HashMap::new(),
            max_docs: HashMap::new(),
            maps: HashMap::new(),
            term_counts: HashMap::new(),
            map_pairs: 0,
            codes: None,
            checks: Vec::new(),
            pairs_built: None,
            milli: 0,
            tighten: Vec::new(),
        }
    }

    fn scan(&mut self, start: &[u8], end: &[u8], limit: usize) -> StoreResult<Vec<(Vec<u8>, Val)>> {
        let page = self.view.scan_vals(start, end, limit)?;
        self.work += SEEK + page.len() as u64;
        self.scans += 1;
        self.entries += page.len() as u64;
        Ok(page)
    }

    fn scan_rev(
        &mut self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> StoreResult<Vec<(Vec<u8>, Val)>> {
        let page = self.view.scan_vals_rev(start, end, limit)?;
        self.work += SEEK + page.len() as u64;
        self.scans += 1;
        self.entries += page.len() as u64;
        Ok(page)
    }

    fn last_map(&mut self, prefix: &[u8]) -> StoreResult<Option<BlockMap>> {
        let Some((k, v)) = self.scan_rev(prefix, &key::prefix_end(prefix), 1)?.pop() else {
            return Ok(None);
        };
        let mut at = prefix.len();
        let block = u64_at(&k, &mut at)?;
        Ok(Some((block, self.pairs(&k, v)?)))
    }

    fn charge_milli(&mut self, m: u64) {
        self.milli += m;
        self.work += self.milli / 1000;
        self.milli %= 1000;
    }

    fn get(&mut self, k: &[u8]) -> StoreResult<Option<Vec<u8>>> {
        self.work += SEEK;
        self.gets += 1;
        self.view.get(k)
    }

    fn counter(&mut self, k: &[u8]) -> StoreResult<u64> {
        match self.get(k)? {
            Some(b) => Ok(counter_value(&b)
                .ok_or_else(|| StoreError::Entry("a search counter doesn't decode".into()))?
                .max(0) as u64),
            None => Ok(0),
        }
    }

    fn term_counts(&mut self, scope: Scope, term: &str) -> StoreResult<&[(u32, u64)]> {
        let k = term_counts_of(scope, term);
        if !self.term_counts.contains_key(&k) {
            self.work += SEEK;
            self.gets += 1;
            let counts = match self.view.get_val(&k)? {
                Some(v) => v
                    .into_counts(&k)
                    .ok_or_else(|| StoreError::Entry("a search block doesn't decode".into()))?,
                None => Vec::new(),
            };
            self.term_counts.insert(k.clone(), counts);
        }
        Ok(&self.term_counts[&k])
    }

    fn term_count(&mut self, scope: Scope, term: &str, slot: u32) -> StoreResult<u64> {
        Ok(count_at(self.term_counts(scope, term)?, slot))
    }

    fn term_docs(&mut self, scope: Scope, term: &str) -> StoreResult<u64> {
        self.term_count(scope, term, DOCS_SLOT)
    }

    fn pairs(&mut self, key: &[u8], v: Val) -> StoreResult<Vec<(u32, u32)>> {
        let p = v
            .into_pairs(key)
            .ok_or_else(|| StoreError::Entry("a search block doesn't decode".into()))?;
        self.pairs += p.len() as u64;
        self.work += p.len() as u64 / PAIRS;
        Ok(p)
    }

    fn map(&mut self, k: Vec<u8>) -> StoreResult<Arc<Vec<(u32, u32)>>> {
        if let Some(m) = self.maps.get(&k) {
            return Ok(m.clone());
        }
        self.work += SEEK;
        self.gets += 1;
        let m = match self.view.get_val(&k)? {
            Some(v) => self.pairs(&k, v)?,
            None => Vec::new(),
        };
        Ok(self.keep(k, m))
    }

    fn max_map(&mut self, k: Vec<u8>) -> StoreResult<Arc<Vec<(u32, u32)>>> {
        if !self.maps.contains_key(&k) {
            self.max_reads += 1;
        }
        self.map(k)
    }

    fn keep(&mut self, k: Vec<u8>, m: Vec<(u32, u32)>) -> Arc<Vec<(u32, u32)>> {
        let m = Arc::new(m);
        self.map_pairs += m.len();
        if self.map_pairs > MAPS_HELD {
            self.maps.clear();
            self.map_pairs = m.len();
        }
        self.maps.insert(k, m.clone());
        m
    }

    fn pairs_on(&mut self) -> StoreResult<bool> {
        if self.pairs_built.is_none() {
            self.work += SEEK;
            self.pairs_built = Some(super::pairs::on(self.view)?);
        }
        Ok(self.pairs_built == Some(true))
    }

    fn texts(&mut self, scope: Scope, doc: u64, field: u32) -> StoreResult<Vec<Vec<u8>>> {
        let t = search_texts(self.view, scope, doc, field)?;
        self.texts += 1;
        self.work += TEXT + t.iter().map(|x| x.len() as u64).sum::<u64>() / 32;
        Ok(t)
    }
}

type BlockMap = (u64, Vec<(u32, u32)>);

fn successor(k: &[u8]) -> Vec<u8> {
    let mut s = k.to_vec();
    s.push(0);
    s
}

struct Cursor {
    end: Vec<u8>,
    from: Vec<u8>,
    page: Vec<(Vec<u8>, Val)>,
    pos: usize,
    last: bool,
    size: usize,
}

const PAGE_MIN: usize = 8;
const PAGE_MAX: usize = 4096;

impl Cursor {
    fn new(prefix: &[u8]) -> Cursor {
        Cursor {
            end: key::prefix_end(prefix),
            from: Vec::new(),
            page: Vec::new(),
            pos: 0,
            last: false,
            size: PAGE_MIN,
        }
    }

    fn fill(&mut self, ctx: &mut Ctx, from: &[u8], size: usize) -> StoreResult<()> {
        self.size = size;
        self.from = from.to_vec();
        self.page = ctx.scan(from, &self.end, size)?;
        self.last = self.page.len() < size;
        self.pos = 0;
        Ok(())
    }

    fn seek(&mut self, ctx: &mut Ctx, k: &[u8]) -> StoreResult<()> {
        if self.covers(k) {
            self.pos = self.page.partition_point(|(e, _)| e.as_slice() < k);
            return Ok(());
        }
        let onward = self.page.last().is_some_and(|(l, _)| l.as_slice() < k);
        let size = if !onward {
            PAGE_MIN
        } else if self.pos * 2 >= self.page.len() {
            (self.size * 2).min(PAGE_MAX)
        } else {
            (self.size / 2).max(PAGE_MIN)
        };
        self.fill(ctx, k, size)
    }

    fn covers(&self, k: &[u8]) -> bool {
        !self.from.is_empty()
            && self.from.as_slice() <= k
            && (self.last || self.page.last().is_some_and(|(l, _)| k <= l.as_slice()))
    }

    fn take(&mut self) -> Val {
        self.page
            .get_mut(self.pos)
            .map_or(Val::Del, |e| std::mem::replace(&mut e.1, Val::Del))
    }

    fn get(&self) -> Option<&(Vec<u8>, Val)> {
        self.page.get(self.pos)
    }

    fn advance(&mut self, ctx: &mut Ctx) -> StoreResult<()> {
        self.pos += 1;
        if self.pos >= self.page.len() && !self.last {
            let from = successor(&self.page.last().unwrap().0);
            let size = (self.size * 2).min(PAGE_MAX);
            self.fill(ctx, &from, size)?;
        }
        Ok(())
    }
}

fn u64_at(k: &[u8], at: &mut usize) -> StoreResult<u64> {
    get_u64(k, at).ok_or_else(|| StoreError::Entry("a search key doesn't decode".into()))
}

trait Docs {
    fn doc(&self) -> Option<u64>;
    fn seek(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<()>;
}

struct BlockDocs {
    prefix: Vec<u8>,
    bits: u32,
    mask: u64,
    cur: Cursor,
    block: Option<u64>,
    pairs: Vec<(u32, u32)>,
    at: usize,
    doc: Option<u64>,
    sought: Option<u64>,
}

impl BlockDocs {
    fn new(prefix: Vec<u8>, bits: u32) -> BlockDocs {
        BlockDocs {
            cur: Cursor::new(&prefix),
            prefix,
            bits,
            mask: u64::MAX,
            block: None,
            pairs: Vec::new(),
            at: 0,
            doc: None,
            sought: None,
        }
    }

    fn has(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<Option<bool>> {
        if self.doc == Some(d) {
            return Ok(Some(true));
        }
        match self.sought {
            Some(s) if s > d => return Ok(None),
            Some(_) if self.doc.is_none_or(|x| x > d) => return Ok(Some(false)),
            _ => {}
        }
        self.seek(ctx, d)?;
        Ok(Some(self.doc == Some(d)))
    }

    fn postings(scope: Scope, term: &str, mask: u64) -> BlockDocs {
        let mut b = BlockDocs::new(postings(scope, term), BLOCK_BITS);
        b.mask = mask;
        b
    }

    fn ends(&self, ctx: &mut Ctx) -> StoreResult<Option<(u64, u64)>> {
        let mut b = BlockDocs::new(self.prefix.clone(), self.bits);
        b.mask = self.mask;
        b.seek(ctx, 0)?;
        let Some(first) = b.doc else {
            return Ok(None);
        };
        let Some((block, pairs)) = ctx.last_map(&self.prefix)? else {
            return Ok(None);
        };
        let last = pairs
            .iter()
            .filter(|p| p.1 != 0)
            .map(|&(s, _)| self.doc_of(block, s))
            .max()
            .unwrap_or(((block + 1) << self.bits) - 1);
        Ok(Some((first, last.max(first))))
    }

    fn park(&mut self) {
        self.block = None;
        self.pairs.clear();
        self.doc = None;
        self.sought = Some(u64::MAX);
    }

    fn doc_of(&self, block: u64, slot: u32) -> u64 {
        block << self.bits | u64::from(slot >> FIELD_BITS)
    }

    fn doc_pairs(&self) -> impl Iterator<Item = (u32, u32)> + '_ {
        let block = self.block.unwrap_or(0);
        let doc = self.doc;
        self.pairs[self.at.min(self.pairs.len())..]
            .iter()
            .map(move |&(s, v)| (self.doc_of(block, s), s & ((1 << FIELD_BITS) - 1), v))
            .take_while(move |&(d, _, _)| Some(d) == doc)
            .map(|(_, f, v)| (f, v))
    }

    fn read_block(&mut self, ctx: &mut Ctx) -> StoreResult<()> {
        let Some((k, v)) = self.cur.get() else {
            self.block = None;
            self.pairs.clear();
            self.doc = None;
            return Ok(());
        };
        let mut at = self.prefix.len();
        let block = u64_at(k, &mut at)?;
        let key = k.clone();
        let _ = v;
        self.at = 0;
        if self.block != Some(block) {
            self.block = Some(block);
            if self.bits == BLOCK_BITS {
                ctx.posting_blocks += 1;
            }
            let v = match self.cur.take() {
                Val::Del => {
                    ctx.work += SEEK;
                    ctx.gets += 1;
                    ctx.view.get_val(&key)?.unwrap_or(Val::Map(Vec::new()))
                }
                v => v,
            };
            self.pairs = ctx.pairs(&key, v)?;
            if self.mask != u64::MAX {
                let mask = self.mask;
                self.pairs.retain(|p| mask >> (p.0 & ((1 << FIELD_BITS) - 1)) & 1 == 1);
            }
        }
        Ok(())
    }

    fn load(&mut self, ctx: &mut Ctx) -> StoreResult<()> {
        loop {
            let Some(block) = self.block else {
                self.doc = None;
                return Ok(());
            };
            if let Some(&(s, _)) = self.pairs.get(self.at) {
                self.doc = Some(self.doc_of(block, s));
                return Ok(());
            }
            self.cur.advance(ctx)?;
            self.read_block(ctx)?;
        }
    }
}

impl Docs for BlockDocs {
    fn doc(&self) -> Option<u64> {
        self.doc
    }

    fn seek(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<()> {
        if self.doc == Some(d) {
            return Ok(());
        }
        self.sought = Some(d);
        let block = d >> self.bits;
        if self.block != Some(block) {
            let mut k = self.prefix.clone();
            put_u64(&mut k, block);
            self.cur.seek(ctx, &k)?;
            self.read_block(ctx)?;
        }
        self.at = 0;
        if self.block == Some(block) {
            let first = ((d & ((1 << self.bits) - 1)) as u32) << FIELD_BITS;
            self.at = self.pairs.partition_point(|&(s, _)| s < first);
        }
        self.load(ctx)
    }
}

struct Members {
    prefix: Vec<u8>,
    cur: Cursor,
    milli: (u64, u64),
    block: Option<u64>,
    places: Vec<(u32, u32)>,
    at: usize,
    doc: Option<u64>,
}

impl Members {
    fn new(tag: u64) -> Members {
        Members::under(
            key::id(key::MEMBER_BLOCK, tag),
            (MEMBER_BLOCK_MILLI, MEMBER_PLACE_MILLI),
        )
    }

    fn term_map(kind: TermKind, term: &str) -> Members {
        Members::under(
            key::tag_carriers_of(kind, term),
            (TERM_MAP_BLOCK_MILLI, TERM_MAP_PLACE_MILLI),
        )
    }

    fn under(prefix: Vec<u8>, milli: (u64, u64)) -> Members {
        Members {
            cur: Cursor::new(&prefix),
            prefix,
            milli,
            block: None,
            places: Vec::new(),
            at: 0,
            doc: None,
        }
    }

    fn read_block(&mut self, ctx: &mut Ctx) -> StoreResult<()> {
        let Some((k, _)) = self.cur.get() else {
            self.block = None;
            self.places.clear();
            return Ok(());
        };
        let mut at = self.prefix.len();
        let block = u64_at(k, &mut at)?;
        if self.block == Some(block) {
            return Ok(());
        }
        self.block = Some(block);
        let decoded;
        let pairs: &[(u32, u32)] = match self.cur.get().map(|e| &e.1) {
            Some(Val::Map(p)) => p,
            Some(Val::Put(b)) => {
                decoded = crate::keyspace::val::map_pairs(b)
                    .ok_or_else(|| StoreError::Entry("a member block doesn't decode".into()))?;
                &decoded
            }
            Some(Val::Counts(p)) => {
                decoded = p
                    .iter()
                    .map(|&(s, n)| u32::try_from(n).map(|n| (s, n)))
                    .collect::<Result<_, _>>()
                    .map_err(|_| StoreError::Entry("a member block doesn't decode".into()))?;
                &decoded
            }
            _ => return Err(StoreError::Entry("a member block doesn't decode".into())),
        };
        self.places = block_places(pairs);
        ctx.pairs += pairs.len() as u64;
        ctx.charge_milli(self.milli.0 + pairs.len() as u64 * self.milli.1);
        Ok(())
    }

    fn load(&mut self, ctx: &mut Ctx) -> StoreResult<()> {
        loop {
            let Some(block) = self.block else {
                self.doc = None;
                return Ok(());
            };
            if let Some(&(p, _)) = self.places.get(self.at) {
                self.doc = Some(block << key::MEMBER_BITS | u64::from(p));
                return Ok(());
            }
            self.cur.advance(ctx)?;
            self.read_block(ctx)?;
            self.at = 0;
        }
    }

    fn step(&mut self, ctx: &mut Ctx) -> StoreResult<()> {
        self.at += 1;
        self.load(ctx)
    }

    fn ends(&self, ctx: &mut Ctx) -> StoreResult<Option<(u64, u64)>> {
        let mut m = Members::under(self.prefix.clone(), self.milli);
        m.seek(ctx, 0)?;
        let Some(first) = m.doc else {
            return Ok(None);
        };
        let Some((block, pairs)) = ctx.last_map(&self.prefix)? else {
            return Ok(None);
        };
        ctx.charge_milli(self.milli.0 + pairs.len() as u64 * self.milli.1);
        let last = block_places(&pairs)
            .last()
            .map_or(((block + 1) << key::MEMBER_BITS) - 1, |&(p, _)| {
                block << key::MEMBER_BITS | u64::from(p)
            });
        Ok(Some((first, last.max(first))))
    }

    fn count(&self) -> u32 {
        self.doc.map_or(0, |_| self.places[self.at].1)
    }
}

fn block_places(pairs: &[(u32, u32)]) -> Vec<(u32, u32)> {
    pairs
        .iter()
        .filter(|&&(p, v)| v != 0 && p < 1 << key::MEMBER_BITS)
        .copied()
        .collect()
}

impl Docs for Members {
    fn doc(&self) -> Option<u64> {
        self.doc
    }

    fn seek(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<()> {
        if self.doc == Some(d) {
            return Ok(());
        }
        let block = d >> key::MEMBER_BITS;
        if self.block != Some(block) {
            let mut k = self.prefix.clone();
            put_u64(&mut k, block);
            self.cur.seek(ctx, &k)?;
            self.read_block(ctx)?;
        }
        self.at = 0;
        if self.block == Some(block) {
            let place = key::member_slot(d);
            self.at = self.places.partition_point(|&(p, _)| p < place);
        }
        self.load(ctx)
    }
}

struct Listed<T> {
    items: Vec<(u64, T)>,
    pos: usize,
}

impl<T> Listed<T> {
    fn new(mut items: Vec<(u64, T)>) -> Listed<T> {
        items.sort_by_key(|(d, _)| *d);
        Listed { items, pos: 0 }
    }
}

impl<T> Docs for Listed<T> {
    fn doc(&self) -> Option<u64> {
        self.items.get(self.pos).map(|(d, _)| *d)
    }

    fn seek(&mut self, _: &mut Ctx, d: u64) -> StoreResult<()> {
        self.pos = self.items.partition_point(|(x, _)| *x < d);
        Ok(())
    }
}

struct AnyOf(Vec<Members>);

impl AnyOf {
    fn mark(&mut self, ctx: &mut Ctx, first: u64, end: u64, bits: &mut [u64]) -> StoreResult<()> {
        for m in &mut self.0 {
            m.seek(ctx, first)?;
            while let Some(c) = m.doc().filter(|&c| c < end) {
                let place = (c - first) as usize;
                bits[place >> 6] |= 1 << (place & 63);
                m.step(ctx)?;
            }
        }
        Ok(())
    }
}

impl Docs for AnyOf {
    fn doc(&self) -> Option<u64> {
        self.0.iter().filter_map(Members::doc).min()
    }

    fn seek(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<()> {
        for m in &mut self.0 {
            m.seek(ctx, d)?;
        }
        Ok(())
    }
}

#[derive(Clone)]
struct Mover {
    tag: u64,
    cursor: u64,
    below: bool,
    above: bool,
    named: bool,
    target_has: bool,
    mapped_has: bool,
}

impl Mover {
    fn counted(&self, d: u64) -> bool {
        if d < self.cursor {
            self.below
        } else {
            self.above
        }
    }
}

#[derive(Clone)]
struct TermTags {
    kind: TermKind,
    term: String,
    heavy: Vec<u64>,
    moving: Vec<Mover>,
}

impl TermTags {
    fn carried(&self, d: u64, counted: u32, tags: &[u64]) -> bool {
        let mut n = i64::from(counted);
        for t in tags {
            if self.heavy.binary_search(t).is_ok() {
                return true;
            }
            if let Ok(i) = self.moving.binary_search_by_key(t, |m| m.tag) {
                let m = &self.moving[i];
                if m.named {
                    return true;
                }
                n -= i64::from(m.counted(d));
            }
        }
        n > 0
    }
}

#[derive(Clone)]
enum Source {
    Tags(Vec<u64>),
    Term(TermTags),
}

impl Source {
    fn cursors(&self) -> usize {
        match self {
            Source::Tags(t) => t.len(),
            Source::Term(t) => 1 + t.heavy.len() + t.moving.len(),
        }
    }
}

struct TermCarriers {
    map: Members,
    heavy: Vec<Members>,
    moving: Vec<(Mover, Members)>,
    doc: Option<u64>,
}

impl TermCarriers {
    fn new(t: &TermTags) -> TermCarriers {
        TermCarriers {
            map: Members::term_map(t.kind, &t.term),
            heavy: t.heavy.iter().map(|&h| members(h)).collect(),
            moving: t
                .moving
                .iter()
                .map(|m| (m.clone(), members(m.tag)))
                .collect(),
            doc: None,
        }
    }

    fn holds(&self, d: u64) -> bool {
        if self.heavy.iter().any(|m| m.doc == Some(d)) {
            return true;
        }
        let mut n = if self.map.doc == Some(d) {
            i64::from(self.map.count())
        } else {
            0
        };
        for (mv, m) in &self.moving {
            if m.doc == Some(d) {
                if mv.named {
                    return true;
                }
                n -= i64::from(mv.counted(d));
            }
        }
        n > 0
    }
}

impl TermCarriers {
    fn mark(&mut self, ctx: &mut Ctx, first: u64, end: u64, bits: &mut [u64]) -> StoreResult<()> {
        let mut set = |c: u64| {
            let place = (c - first) as usize;
            bits[place >> 6] |= 1 << (place & 63);
        };
        for m in &mut self.heavy {
            m.seek(ctx, first)?;
            while let Some(c) = m.doc.filter(|&c| c < end) {
                set(c);
                m.step(ctx)?;
            }
        }
        let mut counted: Vec<(u64, i64)> = Vec::new();
        self.map.seek(ctx, first)?;
        while let Some(c) = self.map.doc.filter(|&c| c < end) {
            counted.push((c, i64::from(self.map.count())));
            self.map.step(ctx)?;
        }
        for (mv, m) in &mut self.moving {
            m.seek(ctx, first)?;
            while let Some(c) = m.doc.filter(|&c| c < end) {
                if mv.named {
                    set(c);
                } else if mv.counted(c)
                    && let Ok(i) = counted.binary_search_by_key(&c, |x| x.0)
                {
                    counted[i].1 -= 1;
                }
                m.step(ctx)?;
            }
        }
        for (c, n) in counted {
            if n > 0 {
                set(c);
            }
        }
        self.doc = None;
        self.seek(ctx, end)
    }
}

impl Docs for TermCarriers {
    fn doc(&self) -> Option<u64> {
        self.doc
    }

    fn seek(&mut self, ctx: &mut Ctx, mut d: u64) -> StoreResult<()> {
        if self.doc == Some(d) {
            return Ok(());
        }
        loop {
            self.map.seek(ctx, d)?;
            for m in &mut self.heavy {
                m.seek(ctx, d)?;
            }
            for (_, m) in &mut self.moving {
                m.seek(ctx, d)?;
            }
            let next = std::iter::once(self.map.doc)
                .chain(self.heavy.iter().map(|m| m.doc))
                .chain(self.moving.iter().map(|(_, m)| m.doc))
                .flatten()
                .min();
            match next {
                Some(c) if !self.holds(c) => d = c + 1,
                _ => {
                    self.doc = next;
                    return Ok(());
                }
            }
        }
    }
}

enum Carriers {
    Tags(AnyOf),
    Term(TermCarriers),
}

impl Carriers {
    fn of(source: &Source) -> Carriers {
        match source {
            Source::Tags(tags) => Carriers::Tags(AnyOf(tags.iter().map(|&t| members(t)).collect())),
            Source::Term(t) => Carriers::Term(TermCarriers::new(t)),
        }
    }

    fn mark(&mut self, ctx: &mut Ctx, first: u64, end: u64, bits: &mut [u64]) -> StoreResult<()> {
        match self {
            Carriers::Tags(a) => a.mark(ctx, first, end, bits),
            Carriers::Term(t) => t.mark(ctx, first, end, bits),
        }
    }
}

impl Docs for Carriers {
    fn doc(&self) -> Option<u64> {
        match self {
            Carriers::Tags(a) => a.doc(),
            Carriers::Term(t) => t.doc(),
        }
    }

    fn seek(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<()> {
        match self {
            Carriers::Tags(a) => a.seek(ctx, d),
            Carriers::Term(t) => t.seek(ctx, d),
        }
    }
}

fn members(tag: u64) -> Members {
    Members::new(tag)
}

fn mark_held(mask: u64, pairs: &[(u32, u32)], held: &mut BlockBits) {
    for &(sl, _) in pairs {
        if mask >> (sl & ((1 << FIELD_BITS) - 1)) & 1 == 1 {
            let place = (sl >> FIELD_BITS) as usize;
            held[place >> 6] |= 1 << (place & 63);
        }
    }
}

fn doc_hits(
    ctx: &mut Ctx,
    scope: Scope,
    term: &str,
    doc: u64,
) -> StoreResult<Vec<(u32, FieldHit)>> {
    let block = doc >> BLOCK_BITS;
    let m = ctx.map(posting_block(scope, term, block))?;
    let first = super::slot(doc, 0);
    let defs = scope.fields();
    let mut out = Vec::new();
    for &(s, v) in &m[m.partition_point(|p| p.0 < first)..] {
        let (d, f) = unslot(block, s);
        if d != doc {
            break;
        }
        out.push((f, unpack(defs[f as usize].prefix, v)));
    }
    Ok(out)
}

fn doc_codes(ctx: &mut Ctx, scope: Scope, doc: u64) -> StoreResult<[u8; 1 << FIELD_BITS]> {
    if let Some((s, d, c)) = ctx.codes
        && s == scope
        && d == doc
    {
        return Ok(c);
    }
    ctx.length_reads += 1;
    let m = ctx.map(length_block(scope, doc >> LENGTH_BITS))?;
    let first = slot_in(LENGTH_BITS, doc, 0);
    let mut codes = [0u8; 1 << FIELD_BITS];
    for &(s, len) in &m[m.partition_point(|p| p.0 < first)..] {
        if s >> FIELD_BITS != first >> FIELD_BITS {
            break;
        }
        codes[(s & ((1 << FIELD_BITS) - 1)) as usize] = length_code(u64::from(len));
    }
    ctx.codes = Some((scope, doc, codes));
    Ok(codes)
}

type Tfs = Vec<(u32, u64, u8)>;

type BlockBits = [u64; 1 << (BLOCK_BITS - 6)];

fn tfs_of(
    ctx: &mut Ctx,
    scope: Scope,
    hits: impl IntoIterator<Item = (u32, FieldHit)>,
    doc: u64,
    mask: u64,
    as_prefix: bool,
) -> StoreResult<Tfs> {
    let hits: Vec<(u32, u64)> = hits
        .into_iter()
        .filter(|(f, h)| mask >> f & 1 == 1 && h.tf(as_prefix) > 0)
        .map(|(f, h)| (f, h.tf(as_prefix)))
        .collect();
    if hits.is_empty() {
        return Ok(Vec::new());
    }
    let codes = doc_codes(ctx, scope, doc)?;
    Ok(hits
        .into_iter()
        .map(|(f, tf)| (f, tf, codes[f as usize]))
        .collect())
}

fn shortest_in(ctx: &mut Ctx, scope: Scope, field: u32, block: u64) -> StoreResult<Option<u64>> {
    if let Some(&x) = ctx.shortest.get(&(scope, field, block)) {
        return Ok(x);
    }
    let (chunk, sl) = bound_slot(block, 0);
    let m = ctx.map(shortest(scope, field, chunk))?;
    let x = m
        .binary_search_by_key(&sl, |p| p.0)
        .ok()
        .map(|i| SHORTEST_BASE - u64::from(m[i].1));
    if ctx.shortest.len() >= 1 << 16 {
        ctx.shortest.clear();
    }
    ctx.shortest.insert((scope, field, block), x);
    Ok(x)
}

fn last_block(ctx: &mut Ctx, scope: Scope) -> StoreResult<u64> {
    let m = match ctx.max_docs.get(&scope) {
        Some(&m) => m,
        None => {
            let m = ctx
                .get(&max_doc(scope))?
                .and_then(|b| parse_varint(&b))
                .unwrap_or(0);
            ctx.max_docs.insert(scope, m);
            m
        }
    };
    Ok(m >> BLOCK_BITS)
}

fn shortest_lens(
    ctx: &mut Ctx,
    scope: Scope,
    mask: u64,
    block: u64,
) -> StoreResult<[f64; 1 << FIELD_BITS]> {
    let mut lens = [0.0; 1 << FIELD_BITS];
    for f in fields_of(scope, mask) {
        let len = shortest_in(ctx, scope, f, block)?.unwrap_or(0);
        lens[f as usize] = code_length(length_code(len));
    }
    Ok(lens)
}

fn list_next_block(
    ctx: &mut Ctx,
    scope: Scope,
    term: &str,
    as_prefix: bool,
    fields: Option<u64>,
    block: u64,
) -> StoreResult<Option<u64>> {
    let last = last_block(ctx, scope)?;
    ctx.next_blocks += 1;
    let level = block_maxima_at(scope, term, 0);
    let end = key::prefix_end(&level);
    let mut b = block;
    while b <= last {
        let (group, first) = max_slot(b, as_prefix);
        let k = block_maxima(scope, term, 0, group);
        let (g, m) = match ctx.maps.get(&k) {
            Some(m) => (group, m.clone()),
            None => {
                ctx.max_reads += 1;
                let Some((found, v)) = ctx.scan(&k, &end, 1)?.into_iter().next() else {
                    return Ok(None);
                };
                let g = get_u64(&found, &mut { level.len() })
                    .ok_or_else(|| StoreError::Entry("a block maxima key doesn't decode".into()))?;
                let m = ctx.pairs(&found, v)?;
                (g, ctx.keep(found, m))
            }
        };
        let from = if g == group { first } else { 0 };
        let at = m.partition_point(|p| p.0 < from);
        if let Some(&(sl, _)) = m[at..].iter().find(|p| {
            let (_, field, prefix) = unmax_slot(g, p.0);
            prefix == as_prefix
                && match (fields, field) {
                    (None, None) => true,
                    (Some(mask), Some(f)) => mask >> f & 1 == 1,
                    _ => false,
                }
        }) {
            return Ok(Some(unmax_slot(g, sl).0));
        }
        b = (g + 1) << GROUP_BITS;
    }
    Ok(None)
}

pub struct Stats {
    n: f64,
}

fn scope_stats(ctx: &mut Ctx, scope: Scope) -> StoreResult<Arc<Stats>> {
    let Some(cache) = ctx.cache else {
        return Ok(Arc::new(read_stats(ctx, scope)?));
    };
    let version = ctx.view.published_version();
    if let Some((v, s)) = cache.0.lock().unwrap().get(&scope)
        && *v == version
    {
        return Ok(s.clone());
    }
    let s = Arc::new(read_stats(ctx, scope)?);
    cache.0.lock().unwrap().insert(scope, (version, s.clone()));
    Ok(s)
}

fn read_stats(ctx: &mut Ctx, scope: Scope) -> StoreResult<Stats> {
    let n = ctx.counter(&doc_count(scope))? as f64;
    Ok(Stats { n })
}

#[derive(Default, Clone)]
struct Matched {
    parts: Vec<(u32, usize, u64, u8)>,
}

#[derive(Clone)]
struct Part {
    token: usize,
}

const TAG_PART: usize = usize::MAX;

type Texts = Vec<[f64; 1 << FIELD_BITS]>;

fn add_bound(texts: &mut Texts, token: usize, b: f64) {
    texts[token][0] += b;
}

struct List {
    term: String,
    mask: u64,
    token: usize,
    as_prefix: bool,
    dir: BlockDocs,
    bound: Option<(u64, u64, f64)>,
    shortest: Option<(u64, [f64; 1 << FIELD_BITS])>,
    next: Option<(u64, Option<u64>)>,
}

fn fields_of(scope: Scope, m: u64) -> impl Iterator<Item = u32> {
    (0..scope.fields().len() as u32).filter(move |f| m >> f & 1 == 1)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lead {
    Both,
    Text,
    Carriers,
}

struct Unraised {
    cursor: u64,
    below: bool,
    above: bool,
    members: Members,
}

impl Unraised {
    fn any_in(&mut self, ctx: &mut Ctx, lo: u64, hi: u64) -> StoreResult<bool> {
        for (on, a, b) in [
            (self.below, lo, hi.min(self.cursor)),
            (self.above, lo.max(self.cursor), hi),
        ] {
            if on && a < b {
                self.members.seek(ctx, a)?;
                if self.members.doc().is_some_and(|d| d < b) {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
}

struct Tagged {
    boost: f64,
    part: usize,
    covered: bool,
    unraised: Vec<Unraised>,
    source: Source,
    carriers: Carriers,
    count: u64,
    lead: Lead,
    map_block: Option<(u64, Vec<(u32, u32)>)>,
}

pub(crate) const TAGS_WALKED: usize = 8;

impl Tagged {
    fn walks(&self) -> bool {
        self.lead != Lead::Text || self.source.cursors() <= TAGS_WALKED
    }

    fn carries(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<bool> {
        if self.walks() {
            self.carriers.seek(ctx, d)?;
            return Ok(self.carriers.doc() == Some(d));
        }
        let Tagged {
            source, map_block, ..
        } = self;
        match source {
            Source::Tags(tags) => own_tag(ctx, d, |t| tags.binary_search(&t).is_ok()),
            Source::Term(t) => {
                let block = d >> key::MEMBER_BITS;
                if map_block.as_ref().is_none_or(|(b, _)| *b != block) {
                    let mut k = key::tag_carriers_of(t.kind, &t.term);
                    put_u64(&mut k, block);
                    ctx.work += SEEK;
                    ctx.gets += 1;
                    let pairs = match ctx.view.get_val(&k)? {
                        Some(v) => v.into_pairs(&k).ok_or_else(|| {
                            StoreError::Entry("a term's carrier map doesn't decode".into())
                        })?,
                        None => Vec::new(),
                    };
                    ctx.pairs += pairs.len() as u64;
                    ctx.charge_milli(
                        TERM_MAP_BLOCK_MILLI + pairs.len() as u64 * TERM_MAP_PLACE_MILLI,
                    );
                    *map_block = Some((block, block_places(&pairs)));
                }
                let places = &map_block.as_ref().unwrap().1;
                let slot = key::member_slot(d);
                let counted = places
                    .binary_search_by_key(&slot, |p| p.0)
                    .map_or(0, |i| places[i].1);
                if counted > 0 && t.moving.is_empty() {
                    return Ok(true);
                }
                if t.heavy.is_empty() && t.moving.is_empty() {
                    return Ok(false);
                }
                let mut tags = Vec::new();
                own_tag(ctx, d, |x| {
                    if t.heavy.binary_search(&x).is_ok()
                        || t.moving.binary_search_by_key(&x, |m| m.tag).is_ok()
                    {
                        tags.push(x);
                    }
                    false
                })?;
                Ok(t.carried(d, counted, &tags))
            }
        }
    }

    fn next(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<Option<u64>> {
        self.carriers.seek(ctx, d)?;
        Ok(self.carriers.doc())
    }

    fn any_in(&mut self, ctx: &mut Ctx, lo: u64, hi: u64) -> StoreResult<bool> {
        if !self.walks() {
            return Ok(true);
        }
        Ok(self.next(ctx, lo)?.is_some_and(|d| d < hi))
    }

    fn unraised_in(&mut self, ctx: &mut Ctx, lo: u64, hi: u64) -> StoreResult<bool> {
        for u in &mut self.unraised {
            if u.any_in(ctx, lo, hi)? {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

fn own_tag(ctx: &mut Ctx, d: u64, mut f: impl FnMut(u64) -> bool) -> StoreResult<bool> {
    let prefix = key::id(key::MEMBER_OF, d);
    let end = key::prefix_end(&prefix);
    let mut from = prefix.clone();
    loop {
        let page = ctx.scan(&from, &end, 64)?;
        for (k, _) in &page {
            let mut at = prefix.len();
            if f(u64_at(k, &mut at)?) {
                return Ok(true);
            }
        }
        match page.last() {
            Some((k, _)) if page.len() == 64 => from = successor(k),
            _ => return Ok(false),
        }
    }
}

struct Matcher {
    scope: Scope,
    tokens: Vec<String>,
    prefix: bool,
    phrase: bool,
    mask: u64,
    lists: Vec<List>,
    parts: HashMap<(usize, u32), usize>,
    part: Vec<Part>,
    idf: Vec<f64>,
    unit_idf: f64,
    short_idf: Option<f64>,
    paired: bool,
    doc: Option<u64>,
    text_doc: Option<u64>,
    tagged: Option<Tagged>,
}

impl Matcher {
    fn new(
        ctx: &mut Ctx,
        scope: Scope,
        stats: &Stats,
        toks: Vec<String>,
        fields: Option<&[u32]>,
        last: bool,
        idfs: Option<&[f64]>,
    ) -> StoreResult<Option<Matcher>> {
        if toks.is_empty() {
            return Ok(None);
        }
        let defs = scope.fields();
        let mask = match fields {
            Some(fs) => fs
                .iter()
                .filter(|&&f| (f as usize) < defs.len())
                .fold(0u64, |m, &f| m | 1 << f),
            None => (1u64 << defs.len()) - 1,
        };
        let prefix_mask: u64 = (0..defs.len())
            .filter(|&i| defs[i].prefix)
            .fold(0, |m, i| m | 1 << i);
        let all = (1u64 << defs.len()) - 1;
        let phrase = toks.len() > 1;
        let last_i = toks.len() - 1;
        let prefix = last && char_len(&toks[last_i]) >= GRAM_MIN;
        let mut m = Matcher {
            scope,
            tokens: toks.clone(),
            prefix,
            phrase,
            mask,
            lists: Vec::new(),
            parts: HashMap::new(),
            part: Vec::new(),
            idf: Vec::new(),
            unit_idf: 0.0,
            short_idf: None,
            paired: false,
            doc: None,
            text_doc: None,
            tagged: None,
        };
        for (i, tok) in toks.iter().enumerate() {
            let is_prefix = prefix && i == last_i;
            let gram_term = first_chars(tok, GRAM_MAX).to_string();
            match idfs {
                Some(w) => m.idf.push(w[i]),
                None => {
                    let df = ctx.term_docs(scope, if is_prefix { &gram_term } else { tok })?;
                    m.idf.push(idf(df as f64, stats.n));
                }
            }
        }
        m.unit_idf = m.idf.iter().sum();
        let whole = if prefix { last_i } else { last_i + 1 };
        if phrase {
            m.short_idf = match idfs {
                Some(w) => Some(w[toks.len()]).filter(|&x| x >= 0.0),
                None if whole >= 2 && mask & super::pair_fields(scope) != 0 && ctx.pairs_on()? => {
                    let mut least = u64::MAX;
                    for i in 0..whole - 1 {
                        least = least.min(ctx.term_docs(scope, &super::pairs::term(&toks[i], &toks[i + 1]))?);
                    }
                    Some(idf(least as f64, stats.n))
                }
                None => None,
            };
        }
        let list = |term: &str, mask, as_prefix| List {
            term: term.to_string(),
            mask,
            token: 0,
            as_prefix,
            dir: BlockDocs::postings(scope, term, if mask == all { u64::MAX } else { mask }),
            bound: None,
            shortest: None,
            next: None,
        };
        for f in fields_of(scope, mask) {
            m.parts.insert((0, f), m.part.len());
            m.part.push(Part { token: 0 });
        }
        if phrase {
            if whole >= 2 && mask & !super::pair_fields(scope) == 0 && ctx.pairs_on()? {
                m.paired = true;
                for i in 0..whole - 1 {
                    m.lists
                        .push(list(&super::pairs::term(&toks[i], &toks[i + 1]), mask, false));
                }
            } else {
                for tok in &toks[..whole] {
                    m.lists.push(list(tok, mask, false));
                }
            }
            return Ok(Some(m));
        }
        let tok = &toks[0];
        if !prefix {
            m.lists.push(list(tok, mask, false));
        } else if char_len(tok) <= GRAM_MAX {
            m.lists.push(list(tok, mask, true));
        } else {
            if mask & prefix_mask != 0 {
                m.lists
                    .push(list(first_chars(tok, GRAM_MAX), mask & prefix_mask, true));
            }
            if mask & !prefix_mask != 0 {
                m.lists.push(list(tok, mask & !prefix_mask, false));
            }
        }
        Ok(Some(m))
    }

    fn single(&self) -> Option<usize> {
        let one = self.word() || (self.phrase && self.lists.len() == 1);
        (one && self.tagged.as_ref().is_none_or(|t| t.lead == Lead::Text)).then_some(0)
    }

    fn long_prefix(&self) -> bool {
        super::long_prefix(
            self.phrase,
            self.prefix,
            &self.tokens[self.tokens.len() - 1],
        )
    }

    fn word(&self) -> bool {
        !self.phrase && self.lists.len() == 1
    }

    fn lead(&self) -> Lead {
        self.tagged.as_ref().map_or(Lead::Text, |t| t.lead)
    }

    fn tag(&mut self, ctx: &mut Ctx, source: Source, count: u64) -> StoreResult<()> {
        let part = self.part.len();
        self.part.push(Part { token: TAG_PART });
        if let Some(f) = super::tag_field(self.scope) {
            self.parts.insert((0, f), part);
        }
        let covered = !self.long_prefix() && !self.phrase;
        let mut unraised = Vec::new();
        if covered {
            let unraised_of = |m: &Mover| Unraised {
                cursor: m.cursor,
                below: !m.target_has,
                above: !m.mapped_has,
                members: members(m.tag),
            };
            match &source {
                Source::Term(t) => {
                    for m in t.moving.iter().filter(|m| m.named) {
                        if !m.target_has || !m.mapped_has {
                            unraised.push(unraised_of(m));
                        }
                    }
                }
                Source::Tags(tags) => {
                    let want: Vec<(TermKind, String)> = self
                        .tokens
                        .iter()
                        .map(|t| (TermKind::Exact, t.clone()))
                        .collect();
                    for &tag in tags {
                        let Some(TagMap {
                            flight: Some(f), ..
                        }) = ctx
                            .get(&key::id(key::TAG_MAP, tag))?
                            .map(|b| TagMap::parse(&b))
                            .transpose()?
                        else {
                            continue;
                        };
                        let holds = |name: &[u8]| {
                            let n = carriers::name_terms(name);
                            want.iter().all(|w| n.contains(w))
                        };
                        let m = Mover {
                            tag,
                            cursor: f.cursor,
                            below: false,
                            above: false,
                            named: true,
                            target_has: holds(&f.target_name),
                            mapped_has: holds(&f.mapped_name),
                        };
                        if !m.target_has || !m.mapped_has {
                            unraised.push(unraised_of(&m));
                        }
                    }
                }
            }
        }
        self.tagged = Some(Tagged {
            boost: self.combine(&self.no_text(), true),
            part,
            covered,
            unraised,
            carriers: Carriers::of(&source),
            source,
            count,
            lead: Lead::Both,
            map_block: None,
        });
        Ok(())
    }

    fn local_units(&mut self) -> f64 {
        let idf = std::mem::replace(&mut self.idf, vec![1.0]);
        let boost = self.combine(&self.no_text(), true);
        if let Some(t) = &mut self.tagged {
            t.boost = boost;
        }
        idf[0]
    }

    fn no_text(&self) -> Texts {
        vec![[0.0; 1 << FIELD_BITS]; if self.phrase { 1 } else { self.tokens.len() }]
    }

    fn combine(&self, texts: &Texts, tagged: bool) -> f64 {
        if self.phrase {
            let short = self.short_fields();
            let (mut body, mut shorts) = (0.0, 0.0);
            for (f, &x) in texts[0].iter().enumerate() {
                if short >> f & 1 == 1 {
                    shorts += x;
                } else {
                    body += x;
                }
            }
            return self.phrase_score(body, shorts, tagged);
        }
        let long = self.long_prefix();
        let sums: Vec<f64> = texts
            .iter()
            .map(|fs| super::sum_parts(self.scope, (0..).zip(fs.iter().copied()), long))
            .collect();
        self.clause_score(&sums, tagged)
    }

    fn clause_score(&self, sums: &[f64], tagged: bool) -> f64 {
        if self.phrase {
            super::clause_score(&[self.unit_idf], sums, tagged)
        } else {
            super::clause_score(&self.idf, sums, tagged)
        }
    }

    fn phrase_score(&self, body: f64, short: f64, tagged: bool) -> f64 {
        let s = super::clause_score(&[self.unit_idf], &[body], tagged);
        match self.short_idf {
            Some(idf) => s + idf * short,
            None => s + self.unit_idf * short,
        }
    }

    fn short_fields(&self) -> u64 {
        match self.short_idf {
            Some(_) => super::pair_fields(self.scope),
            None => 0,
        }
    }

    fn least(&self, texts: &mut Texts, first: bool, b: f64) {
        let short = self.short_fields();
        let at = if self.short_idf.is_some_and(|s| s >= self.unit_idf) {
            short.trailing_zeros()
        } else {
            (!short).trailing_zeros()
        } as usize;
        let t = &mut texts[0][at];
        *t = if first { b } else { t.min(b) };
    }

    fn block_bound(&mut self, ctx: &mut Ctx, li: usize, block: u64) -> StoreResult<f64> {
        self.node_bound(ctx, li, 0, block)
    }

    fn node_bound(&mut self, ctx: &mut Ctx, li: usize, level: u64, node: u64) -> StoreResult<f64> {
        debug_assert!(level == 0 || node != 0);
        if let Some((l, n, s)) = self.lists[li].bound
            && (l, n) == (level, node)
        {
            return Ok(s);
        }
        let l = &self.lists[li];
        let (group, sl) = max_slot(node, l.as_prefix);
        let m = ctx.max_map(block_maxima(self.scope, &l.term, level, group))?;
        let at = |sl: u32| {
            m.binary_search_by_key(&sl, |p| p.0)
                .ok()
                .map_or(0.0, |i| max_value(m[i].1))
        };
        let s = if self.mask == self.mask_all() {
            at(sl)
        } else {
            let summed = super::sum_parts(
                self.scope,
                fields_of(self.scope, l.mask)
                    .map(|f| (f, at(field_max_slot(node, f, l.as_prefix).1))),
                false,
            );
            if self.mask.count_ones() > 1 {
                summed.min(at(sl))
            } else {
                summed
            }
        };
        self.lists[li].bound = Some((level, node, s));
        Ok(s)
    }

    fn bound_at(&mut self, ctx: &mut Ctx, block: u64) -> StoreResult<Option<f64>> {
        self.node_bound_at(ctx, 0, block, block)
    }

    fn node_bound_at(
        &mut self,
        ctx: &mut Ctx,
        level: u64,
        node: u64,
        from: u64,
    ) -> StoreResult<Option<f64>> {
        let lead = self.lead();
        let text = if lead == Lead::Carriers {
            None
        } else {
            self.text_bound_at(ctx, level, node)?
        };
        let end = (node + 1) << (GROUP_BITS * level as u32);
        let carried = match &mut self.tagged {
            Some(t) => t.any_in(ctx, from << BLOCK_BITS, end << BLOCK_BITS)?,
            None => false,
        };
        if !carried {
            return Ok(text.map(|x| self.combine(&x, false)));
        }
        if self.tagged.as_ref().is_some_and(|t| t.covered) {
            let unraised = self.tagged.as_mut().unwrap().unraised_in(
                ctx,
                from << BLOCK_BITS,
                end << BLOCK_BITS,
            )?;
            return Ok(self.covered_bound(lead, text.map(|x| self.combine(&x, unraised))));
        }
        Ok(match (lead, text) {
            (Lead::Text, None) => None,
            (_, text) => Some(self.combine(&text.unwrap_or_else(|| self.no_text()), true)),
        })
    }

    fn covered_bound(&self, lead: Lead, text: Option<f64>) -> Option<f64> {
        let alone = (lead != Lead::Text).then(|| self.combine(&self.no_text(), true));
        match (text, alone) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        }
    }

    fn text_bound_at(
        &mut self,
        ctx: &mut Ctx,
        level: u64,
        node: u64,
    ) -> StoreResult<Option<Texts>> {
        let mut texts = self.no_text();
        let mut any = false;
        for li in 0..self.lists.len() {
            let b = self.node_bound(ctx, li, level, node)?;
            if b > 0.0 {
                any = true;
            } else if self.phrase {
                return Ok(None);
            }
            if self.phrase {
                self.least(&mut texts, li == 0, b);
            } else {
                add_bound(&mut texts, self.lists[li].token, b);
            }
        }
        Ok(any.then_some(texts))
    }

    fn next_block(&mut self, ctx: &mut Ctx, block: u64) -> StoreResult<Option<u64>> {
        let lead = self.lead();
        let text = if lead == Lead::Carriers {
            None
        } else {
            self.text_next_block(ctx, block)?
        };
        let Some(t) = &mut self.tagged else {
            return Ok(text);
        };
        if lead == Lead::Text {
            return Ok(text);
        }
        let c = t.next(ctx, block << BLOCK_BITS)?.map(|d| d >> BLOCK_BITS);
        Ok(match (text, c) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        })
    }

    fn text_next_block(&mut self, ctx: &mut Ctx, block: u64) -> StoreResult<Option<u64>> {
        let mut b = block;
        loop {
            let mut found: Option<u64> = None;
            let mut agreed = true;
            for li in 0..self.lists.len() {
                let x = match self.lists[li].next {
                    Some((asked, answer)) if asked <= b && answer.is_none_or(|a| b <= a) => answer,
                    _ => {
                        let l = &self.lists[li];
                        let fields = (l.mask != self.mask_all()).then_some(l.mask);
                        let x = list_next_block(ctx, self.scope, &l.term, l.as_prefix, fields, b)?;
                        self.lists[li].next = Some((b, x));
                        x
                    }
                };
                if self.phrase {
                    let Some(x) = x else { return Ok(None) };
                    agreed &= x == b;
                    found = Some(found.map_or(x, |f| f.max(x)));
                } else if let Some(x) = x {
                    found = Some(found.map_or(x, |f| f.min(x)));
                }
            }
            if self.lists.is_empty() {
                return Ok(Some(b));
            }
            let Some(f) = found else { return Ok(None) };
            if !self.phrase || agreed {
                return Ok(Some(f));
            }
            b = f;
        }
    }

    fn align(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<()> {
        let lead = self.lead();
        self.text_doc = if lead == Lead::Carriers {
            None
        } else {
            self.text_align(ctx, d)?
        };
        self.doc = match &mut self.tagged {
            None => self.text_doc,
            Some(t) => match lead {
                Lead::Text => self.text_doc,
                Lead::Carriers => t.next(ctx, d)?,
                Lead::Both => match (self.text_doc, t.next(ctx, d)?) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a, b) => a.or(b),
                },
            },
        };
        Ok(())
    }

    fn text_align(&mut self, ctx: &mut Ctx, start: u64) -> StoreResult<Option<u64>> {
        let mut d = start;
        Ok(if self.phrase {
            loop {
                if self.lists.is_empty() {
                    break None;
                }
                let mut agreed = true;
                let mut end = false;
                for l in &mut self.lists {
                    l.dir.seek(ctx, d)?;
                    match l.dir.doc() {
                        None => end = true,
                        Some(x) if x != d => {
                            d = d.max(x);
                            agreed = false;
                        }
                        _ => {}
                    }
                }
                if end {
                    break None;
                }
                if agreed {
                    break Some(d);
                }
            }
        } else {
            for l in &mut self.lists {
                l.dir.seek(ctx, d)?;
            }
            self.lists.iter().filter_map(|l| l.dir.doc()).min()
        })
    }

    fn block_ceiling(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<f64> {
        let end = self.block_end();
        let mut carried = false;
        if let Some(t) = &mut self.tagged {
            carried = t.any_in(ctx, d, end)?;
        }
        let mut texts = self.no_text();
        let mut first = true;
        for li in 0..self.lists.len() {
            if let Some(b) = self.lists[li].dir.block {
                let b = self.block_bound(ctx, li, b)?;
                if self.phrase {
                    self.least(&mut texts, first, b);
                    first = false;
                } else {
                    add_bound(&mut texts, self.lists[li].token, b);
                }
            }
        }
        if carried && let Some(t) = self.tagged.as_mut().filter(|t| t.covered) {
            let unraised = t.unraised_in(ctx, d, end)?;
            let text = self.combine(&texts, unraised);
            return Ok(self.covered_bound(self.lead(), Some(text)).unwrap_or(text));
        }
        Ok(self.combine(&texts, carried))
    }

    fn doc_ceiling(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<f64> {
        let mut carried = false;
        if let Some(t) = &mut self.tagged {
            carried = t.carries(ctx, d)?;
        }
        let defs = self.scope.fields();
        let block = d >> BLOCK_BITS;
        let mut texts = self.no_text();
        let mut least: Option<[f64; 1 << FIELD_BITS]> = None;
        for li in 0..self.lists.len() {
            if self.lists[li].dir.doc() != Some(d) {
                continue;
            }
            if self.lists[li].shortest.is_none_or(|(b, _)| b != block) {
                let lens = shortest_lens(ctx, self.scope, self.lists[li].mask, block)?;
                self.lists[li].shortest = Some((block, lens));
            }
            let l = &self.lists[li];
            let lens = l.shortest.unwrap().1;
            let mut here = [0.0f64; 1 << FIELD_BITS];
            for (f, v) in l.dir.doc_pairs() {
                if l.mask >> f & 1 == 1 {
                    let tf = unpack(defs[f as usize].prefix, v).most();
                    here[f as usize] = field_score(self.scope, f, tf as f64, lens[f as usize]);
                }
            }
            if self.phrase {
                least = Some(match least {
                    None => here,
                    Some(mut x) => {
                        for (a, b) in x.iter_mut().zip(here) {
                            *a = a.min(b);
                        }
                        x
                    }
                });
            } else {
                for (t, x) in texts[l.token].iter_mut().zip(here) {
                    *t = t.max(x);
                }
            }
        }
        if let Some(x) = least {
            texts[0] = x;
        }
        Ok(self.combine(&texts, carried))
    }

    fn block_held(&mut self, ctx: &mut Ctx, block: u64) -> StoreResult<(BlockBits, BlockBits)> {
        let carried = self.carried_in(ctx, block)?;
        if self.lead() == Lead::Carriers {
            return Ok(([0; 1 << (BLOCK_BITS - 6)], carried));
        }
        let mut held = [0u64; 1 << (BLOCK_BITS - 6)];
        for li in 0..self.lists.len() {
            self.lists[li].dir.seek(ctx, block << BLOCK_BITS)?;
            if self.lists[li].dir.block != Some(block) {
                continue;
            }
            if self.lists[li].shortest.is_none_or(|(b, _)| b != block) {
                let lens = shortest_lens(ctx, self.scope, self.lists[li].mask, block)?;
                self.lists[li].shortest = Some((block, lens));
            }
            let l = &self.lists[li];
            mark_held(l.mask, &l.dir.pairs, &mut held);
        }
        Ok((held, carried))
    }

    fn carried_in(&mut self, ctx: &mut Ctx, block: u64) -> StoreResult<BlockBits> {
        let mut carried = [0u64; 1 << (BLOCK_BITS - 6)];
        if let Some(t) = &self.tagged
            && !t.walks()
        {
            carried = [u64::MAX; 1 << (BLOCK_BITS - 6)];
        } else if let Some(t) = &mut self.tagged {
            let (first, end) = (block << BLOCK_BITS, (block + 1) << BLOCK_BITS);
            t.carriers.mark(ctx, first, end, &mut carried)?;
        }
        Ok(carried)
    }

    fn block_bounds(&self, only: &[u64], carried: &BlockBits, total: &mut [f64]) {
        let lists: Vec<(u64, &[(u32, u32)], [f64; 1 << FIELD_BITS])> =
            if self.lead() == Lead::Carriers {
                Vec::new()
            } else {
                self.lists
                    .iter()
                    .filter(|l| l.dir.block.is_some())
                    .filter_map(|l| {
                        l.shortest
                            .map(|(_, lens)| (l.mask, l.dir.pairs.as_slice(), lens))
                    })
                    .collect()
            };
        self.bounds_of(&lists, only, carried, total);
    }

    fn bounds_of(
        &self,
        lists: &[(u64, &[(u32, u32)], [f64; 1 << FIELD_BITS])],
        only: &[u64],
        carried: &BlockBits,
        total: &mut [f64],
    ) {
        const TABLE: usize = 16;
        debug_assert!(!self.phrase || lists.len() <= 1);
        let defs = self.scope.fields();
        let mut parts: Vec<(u32, f64)> = Vec::new();
        for &(mask, pairs, lens) in lists {
            let mut table = [[0.0f64; TABLE]; 1 << FIELD_BITS];
            for f in fields_of(self.scope, mask) {
                for (tf, x) in table[f as usize].iter_mut().enumerate() {
                    *x = field_score(self.scope, f, tf as f64, lens[f as usize]);
                }
            }
            for &(sl, v) in pairs {
                let place = (sl >> FIELD_BITS) as usize;
                let f = sl & ((1 << FIELD_BITS) - 1);
                if only[place >> 6] >> (place & 63) & 1 == 0 || mask >> f & 1 == 0 {
                    continue;
                }
                let tf = unpack(defs[f as usize].prefix, v).most() as usize;
                let x = match table[f as usize].get(tf) {
                    Some(&x) => x,
                    None => field_score(self.scope, f, tf as f64, lens[f as usize]),
                };
                parts.push((sl, x));
            }
        }
        if lists.len() > 1 {
            parts.sort_unstable_by_key(|p| p.0);
        }
        let long = self.long_prefix();
        let short = self.short_fields();
        let mut texts = [0.0f64; 1 << BLOCK_BITS];
        let mut prefixed = [0.0f64; 1 << BLOCK_BITS];
        let mut shorts = [0.0f64; 1 << BLOCK_BITS];
        for (sl, x) in parts {
            let i = (sl >> FIELD_BITS) as usize;
            let f = sl & ((1 << FIELD_BITS) - 1);
            if long && defs[f as usize].prefix {
                prefixed[i] += x;
            } else if short >> f & 1 == 1 {
                shorts[i] += x;
            } else {
                texts[i] += x;
            }
        }
        if long {
            for (t, p) in texts.iter_mut().zip(prefixed) {
                *t += p;
            }
        }
        let tagged = self.tagged.is_some();
        for (w, (&o, &c)) in only.iter().zip(carried).enumerate() {
            let mut b = o;
            while b != 0 {
                let place = b.trailing_zeros() as usize;
                b &= b - 1;
                let i = w * 64 + place;
                let carries = tagged && c >> place & 1 == 1;
                total[i] += if self.phrase {
                    self.phrase_score(texts[i], shorts[i], carries)
                } else {
                    self.clause_score(&[texts[i]], carries)
                };
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn report_loose(
        &self,
        ctx: &mut Ctx,
        li: usize,
        block: u64,
        pairs: &[(u32, u32)],
        shortest: &[f64; 1 << FIELD_BITS],
        scored: Option<&HashMap<u64, [u8; 1 << FIELD_BITS]>>,
        carried: &BlockBits,
    ) -> StoreResult<()> {
        let l = &self.lists[li];
        let (scope, r) = (self.scope, l.as_prefix);
        let defs = scope.fields();
        let all = l.mask == self.mask_all();
        let first = block << BLOCK_BITS;
        let holds = |&&(sl, v): &&(u32, u32)| {
            let f = sl & ((1 << FIELD_BITS) - 1);
            v != 0 && l.mask >> f & 1 == 1 && unpack(defs[f as usize].prefix, v).tf(r) > 0
        };
        let mut highest: Option<f64> = None;
        let mut fields = [None::<f64>; 1 << FIELD_BITS];
        let mut doc: Option<(u32, f64)> = None;
        let tagged = self.tagged.is_some();
        let close = |doc: Option<(u32, f64)>, highest: &mut Option<f64>| {
            if let Some((place, text)) = doc {
                let p = place as usize;
                let carries = tagged && carried[p >> 6] >> (p & 63) & 1 == 1;
                let v = if carries { text + super::TAG_WEIGHT } else { text };
                *highest = Some(highest.map_or(v, |h| h.max(v)));
            }
        };
        for &(sl, v) in pairs {
            let (place, f) = (sl >> FIELD_BITS, sl & ((1 << FIELD_BITS) - 1));
            if !holds(&&(sl, v)) {
                continue;
            }
            let tf = unpack(defs[f as usize].prefix, v).tf(r);
            let len = match scored.and_then(|m| m.get(&(first | u64::from(place)))) {
                Some(codes) => code_length(codes[f as usize]),
                None => shortest[f as usize],
            };
            let x = field_score(scope, f, tf as f64, len);
            let one = &mut fields[f as usize];
            *one = Some(one.map_or(x, |o| o.max(x)));
            match &mut doc {
                Some((p, text)) if *p == place => *text += x,
                _ => {
                    close(doc, &mut highest);
                    doc = Some((place, x));
                }
            }
        }
        close(doc, &mut highest);
        let Some(m) = ctx
            .maps
            .get(&block_maxima(scope, &l.term, 0, max_slot(block, r).0))
            .cloned()
        else {
            return Ok(());
        };
        let stored = |sl: u32| {
            m.binary_search_by_key(&sl, |p| p.0)
                .ok()
                .map(|i| m[i].1)
        };
        let above = |sl: u32, bound: Option<f64>| {
            stored(sl).is_some_and(|s| bound.is_none_or(|b| super::max_bits(b) < s))
        };
        let loose = (all && above(max_slot(block, r).1, highest))
            || fields_of(scope, l.mask).any(|f| above(field_max_slot(block, f, r).1, fields[f as usize]));
        if loose {
            let t = Tighten {
                scope,
                term: l.term.clone(),
                block,
            };
            if !ctx.tighten.contains(&t) {
                ctx.tighten.push(t);
            }
        }
        Ok(())
    }

    fn block_end(&self) -> u64 {
        self.lists
            .iter()
            .filter_map(|l| l.dir.block)
            .map(|b| (b + 1) << BLOCK_BITS)
            .min()
            .unwrap_or(u64::MAX)
    }

    fn present(&mut self, ctx: &mut Ctx, doc: u64) -> StoreResult<Option<bool>> {
        if !self.word() || self.long_prefix() {
            return Ok(self
                .check(ctx, doc)?
                .map(|x| x.parts.iter().any(|p| p.0 != super::TAG_FIELD)));
        }
        let defs = self.scope.fields();
        let l = &mut self.lists[0];
        let text = match l.dir.has(ctx, doc)? {
            Some(true) => l.dir.doc_pairs().any(|(f, v)| {
                l.mask >> f & 1 == 1 && unpack(defs[f as usize].prefix, v).tf(l.as_prefix) > 0
            }),
            Some(false) => false,
            None => {
                return Ok(self
                    .check(ctx, doc)?
                    .map(|x| x.parts.iter().any(|p| p.0 != super::TAG_FIELD)));
            }
        };
        if text {
            return Ok(Some(true));
        }
        let carried = match &mut self.tagged {
            Some(t) => t.carries(ctx, doc)?,
            None => false,
        };
        Ok(carried.then_some(false))
    }

    fn check(&mut self, ctx: &mut Ctx, doc: u64) -> StoreResult<Option<Matched>> {
        let scope = self.scope;
        let mut out = Matched::default();
        let mut hit = false;
        let mut data: Vec<(usize, usize, Tfs)> = Vec::new();
        for li in 0..self.lists.len() {
            let l = &mut self.lists[li];
            let (term, mask, token, as_prefix) = (l.term.clone(), l.mask, l.token, l.as_prefix);
            let defs = scope.fields();
            let hits: Vec<(u32, FieldHit)> = match l.dir.has(ctx, doc)? {
                Some(true) => l
                    .dir
                    .doc_pairs()
                    .map(|(f, v)| (f, unpack(defs[f as usize].prefix, v)))
                    .collect(),
                Some(false) => Vec::new(),
                None => doc_hits(ctx, scope, &term, doc)?,
            };
            let p = tfs_of(ctx, scope, hits, doc, mask, as_prefix)?;
            if p.is_empty() {
                if self.phrase {
                    data.clear();
                    break;
                }
                continue;
            }
            data.push((token, li, p));
        }
        let long = self.long_prefix();
        if !self.phrase {
            for (_, li, p) in &data {
                let is_gram_long = long && self.lists[*li].as_prefix;
                for &(f, tf, code) in p.iter() {
                    let mut tf = tf;
                    if is_gram_long {
                        tf = ctx
                            .texts(scope, doc, f)?
                            .iter()
                            .map(|t| phrase_in(t, &self.tokens, true, true).1)
                            .sum();
                        if tf == 0 {
                            continue;
                        }
                    }
                    hit = true;
                    out.parts.push((f, self.parts[&(0, f)], tf, code));
                }
            }
            out.parts.sort_unstable_by_key(|x| (x.0, x.1));
        } else if !data.is_empty() {
            let common = data
                .iter()
                .map(|(_, _, p)| p.iter().fold(0u64, |m, x| m | 1 << x.0))
                .fold(u64::MAX, |a, b| a & b);
            let decided = self.paired && self.lists.len() == 1 && !self.prefix;
            for f in fields_of(scope, common & self.mask) {
                let (tf, code) = data[0]
                    .2
                    .iter()
                    .find(|x| x.0 == f)
                    .map_or((0, 0), |x| (x.1, x.2));
                let tf = if decided {
                    tf
                } else {
                    ctx.texts(scope, doc, f)?
                        .iter()
                        .map(|t| phrase_count(t, &self.tokens, self.prefix))
                        .sum()
                };
                if tf == 0 {
                    continue;
                }
                hit = true;
                out.parts.push((f, self.parts[&(0, f)], tf, code));
            }
        }
        if let Some(t) = &mut self.tagged
            && t.carries(ctx, doc)?
        {
            hit = true;
            out.parts.push((super::TAG_FIELD, t.part, 1, 0));
        }
        Ok(hit.then_some(out))
    }

    fn score(&self, m: &Matched) -> f64 {
        let tagged = m.parts.iter().any(|x| self.part[x.1].token == TAG_PART);
        if self.phrase {
            let short = self.short_fields();
            let text = |at_short: bool| {
                let fields = m
                    .parts
                    .iter()
                    .filter(|x| self.part[x.1].token == 0 && (short >> x.0 & 1 == 1) == at_short)
                    .map(|&(f, _, tf, code)| (f, tf, code_length(code)));
                super::word_text(self.scope, fields, false)
            };
            return self.phrase_score(text(false), text(true), tagged);
        }
        let units = self.tokens.len();
        let texts: Vec<f64> = (0..units)
            .map(|i| {
                let fields = m
                    .parts
                    .iter()
                    .filter(|x| self.part[x.1].token == i)
                    .map(|&(f, _, tf, code)| (f, tf, code_length(code)));
                super::word_text(self.scope, fields, self.long_prefix())
            })
            .collect();
        self.clause_score(&texts, tagged)
    }
}

pub(crate) fn weights_of(n: usize) -> usize {
    if n > 1 { n + 1 } else { n }
}

enum Filtered {
    Tags(Members),
    Any(AnyOf),
    Carriers(Carriers),
    Ids(Listed<()>),
}

impl Filtered {
    fn docs(&mut self) -> &mut dyn Docs {
        match self {
            Filtered::Tags(x) => x,
            Filtered::Any(x) => x,
            Filtered::Carriers(x) => x,
            Filtered::Ids(x) => x,
        }
    }
}

#[derive(PartialEq)]
struct Ranked(f64, u64);

impl Eq for Ranked {}

impl PartialOrd for Ranked {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

impl Ord for Ranked {
    fn cmp(&self, o: &Self) -> Ordering {
        o.0.total_cmp(&self.0).then(self.1.cmp(&o.1))
    }
}

struct Best {
    cap: usize,
    set: BTreeSet<Ranked>,
}

impl Best {
    fn worst(&self) -> Option<&Ranked> {
        (self.set.len() >= self.cap).then(|| self.set.last().unwrap())
    }

    fn push(&mut self, r: Ranked) {
        self.set.insert(r);
        if self.set.len() > self.cap {
            self.set.pop_last();
        }
    }
}

type OpenedList = (usize, usize, Vec<(u32, u32)>, [f64; 1 << FIELD_BITS]);

struct Opened {
    block: u64,
    lists: Vec<OpenedList>,
    carried: Vec<BlockBits>,
    scored: HashMap<u64, [u8; 1 << FIELD_BITS]>,
}

struct Plan {
    scope: Scope,
    stats: Arc<Stats>,
    pos: Vec<Matcher>,
    pos_at: Vec<usize>,
    neg: Vec<Matcher>,
    include: Vec<Filtered>,
    include_of: Vec<(usize, Vec<Vec<u8>>)>,
    counts: Option<Vec<u64>>,
    exclude: Vec<Filtered>,
    all: Option<BlockDocs>,
    shallow: Option<(u64, Option<f64>)>,
    cands: Option<(u64, Vec<u64>, Vec<u64>)>,
    opened: Option<Opened>,
    complete: bool,
    take: Take,
    ties: bool,
    scale: f64,
}

#[derive(Default)]
struct Walk {
    skipped: bool,
    checked: u64,
    floored: Vec<(u64, u64)>,
    dropped: Vec<u64>,
    passed: u64,
    counting: bool,
    counted: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Read {
    Chosen,
    #[cfg(test)]
    Ranked,
    Counting,
}

enum Leading {
    Word(usize),
    Include(usize),
}

enum Step {
    Match(u64, Vec<Matched>),
    End,
    Stopped(u64),
}

impl Plan {
    fn new(ctx: &mut Ctx, q: &Query, take: Take, names: &TagNames) -> StoreResult<Plan> {
        let stats = scope_stats(ctx, q.scope)?;
        let known = names.0.get();
        let mut found: Vec<Option<Named>> = vec![None; q.clauses.len()];
        let last = q
            .clauses
            .iter()
            .rposition(|c| !tokens(&c.text).is_empty())
            .filter(|&i| !q.clauses[i].quoted);
        let (mut pos, mut pos_at, mut neg) = (Vec::new(), Vec::new(), Vec::new());
        let (mut include, mut include_of, mut exclude) = (Vec::new(), Vec::new(), Vec::new());
        let member_count = |t: u64| key::id(key::MEMBER_COUNT, t);
        let mut complete = true;
        let tags_field = tags_field(q.scope);
        let scored: Vec<usize> = q
            .clauses
            .iter()
            .filter(|c| !c.negate && !tags_only(tags_field, c))
            .map(|c| weights_of(tokens(&c.text).len()))
            .filter(|&n| n > 0)
            .collect();
        let one_word = scored == [1];
        let mut weights = match &q.weights {
            Some(w) if w.len() != if one_word { 0 } else { scored.iter().sum() } => {
                return Err(StoreError::Refused(
                    "invalid cursor: its weights don't match the query's words".into(),
                ));
            }
            Some(w) if !one_word => Some(w.as_slice()),
            _ => None,
        };
        for (i, c) in q.clauses.iter().enumerate() {
            let toks = tokens(&c.text);
            if tags_only(tags_field, c) {
                let n = match known.and_then(|k| k.get(i).cloned().flatten()) {
                    Some(n) => n,
                    None => {
                        let until = ctx.work.saturating_add(q.limits.tags);
                        named(ctx, toks, Some(i) == last, until, false)?
                    }
                };
                complete &= n.done;
                let carriers = Filtered::Carriers(Carriers::of(&n.source));
                if c.negate {
                    exclude.push(carriers);
                } else {
                    let counters = match &n.source {
                        Source::Tags(tags) => tags.iter().map(|&t| member_count(t)).collect(),
                        Source::Term(t) => vec![key::term_carriers(t.kind, &t.term)],
                    };
                    include.push(carriers);
                    include_of.push((i, counters));
                }
                found[i] = Some(n);
                continue;
            }
            let idfs = match &mut weights {
                Some(w) if !c.negate => {
                    let (these, rest) = w.split_at(weights_of(toks.len()));
                    *w = rest;
                    Some(these)
                }
                _ => None,
            };
            if let Some(mut m) = Matcher::new(
                ctx,
                q.scope,
                &stats,
                toks.clone(),
                c.fields.as_deref(),
                Some(i) == last,
                idfs,
            )? {
                if q.scope == Scope::LIBRARY && c.fields.is_none() {
                    let n = match known.and_then(|k| k.get(i).cloned().flatten()) {
                        Some(n) => n,
                        None => {
                            let until = ctx.work.saturating_add(q.limits.tags);
                            named(ctx, toks, Some(i) == last, until, true)?
                        }
                    };
                    complete &= n.done;
                    if n.count > 0 {
                        m.tag(ctx, n.source.clone(), n.count)?;
                    }
                    found[i] = Some(n);
                }
                if c.negate {
                    neg.push(m);
                } else {
                    pos.push(m);
                    pos_at.push(i);
                }
            }
        }
        for (fi, f) in q.filters.iter().enumerate() {
            let at = q.clauses.len() + fi;
            match f {
                Filter::AllTags(tags) => {
                    for &t in tags {
                        include.push(Filtered::Tags(members(t)));
                        include_of.push((at, vec![member_count(t)]));
                    }
                }
                Filter::AnyTag(tags) => {
                    include.push(Filtered::Any(AnyOf(
                        tags.iter().map(|&t| members(t)).collect(),
                    )));
                    include_of.push((at, tags.iter().map(|&t| member_count(t)).collect()));
                }
                Filter::NoTag(tags) => exclude.push(Filtered::Any(AnyOf(
                    tags.iter().map(|&t| members(t)).collect(),
                ))),
                Filter::Ids(ids) => {
                    include.push(Filtered::Ids(Listed::new(
                        ids.iter().map(|&d| (d, ())).collect(),
                    )));
                    include_of.push((at, Vec::new()));
                }
                Filter::NotIds(ids) => exclude.push(Filtered::Ids(Listed::new(
                    ids.iter().map(|&d| (d, ())).collect(),
                ))),
                Filter::Check(c) => {
                    let f = c.begin(ctx.view)?;
                    ctx.checks.push(f);
                }
            }
        }
        if known.is_none() {
            let _ = names.0.set(found);
        }
        let all = (pos.is_empty() && include.is_empty())
            .then(|| BlockDocs::new(lengths(q.scope), LENGTH_BITS));
        let ties = !pos.is_empty() && pos.iter().all(|m: &Matcher| m.tagged.is_some());
        let scale = match pos.as_mut_slice() {
            [m] if m.tokens.len() == 1 => m.local_units(),
            _ => 1.0,
        };
        let single = pos.len() == 1;
        for m in &mut pos {
            if let Some(t) = &mut m.tagged {
                t.lead = match take {
                    Take::All => Lead::Both,
                    Take::Untied if single => Lead::Text,
                    Take::Untied => Lead::Both,
                    Take::Tied => Lead::Carriers,
                };
            }
        }
        Ok(Plan {
            scope: q.scope,
            stats,
            pos,
            pos_at,
            neg,
            include,
            include_of,
            counts: None,
            exclude,
            all,
            shallow: None,
            cands: None,
            opened: None,
            complete,
            take,
            ties,
            scale,
        })
    }

    fn weights(&self) -> Option<Vec<f64>> {
        match self.pos.as_slice() {
            [] => None,
            [m] if m.tokens.len() == 1 => None,
            pos => Some(
                pos.iter()
                    .flat_map(|m| {
                        let short = m.phrase.then(|| m.short_idf.unwrap_or(-1.0));
                        m.idf.iter().copied().chain(short)
                    })
                    .collect(),
            ),
        }
    }

    fn tied(&self) -> Option<f64> {
        self.ties.then(|| {
            self.pos
                .iter()
                .map(|m| {
                    let mut s = 0.0;
                    if let Some(t) = &m.tagged {
                        s += t.boost;
                    }
                    s
                })
                .sum::<f64>()
                + 0.0
        })
    }

    fn takes(&self, matched: &[Matched]) -> bool {
        let tied = || {
            !matched.is_empty()
                && matched
                    .iter()
                    .all(|m| m.parts.iter().all(|p| p.0 == super::TAG_FIELD))
        };
        match self.take {
            Take::All => true,
            Take::Untied => !self.ties || !tied(),
            Take::Tied => self.ties && tied(),
        }
    }

    fn needs_text(&self) -> bool {
        self.take == Take::Untied && self.ties
    }

    fn tied_estimate(&mut self, ctx: &mut Ctx) -> StoreResult<Option<u64>> {
        if !self.include.is_empty()
            || !self.exclude.is_empty()
            || !self.neg.is_empty()
            || !ctx.checks.is_empty()
        {
            return Ok(None);
        }
        let n = self.stats.n.max(1.0);
        let mut least = f64::INFINITY;
        let mut share = 1.0;
        for i in 0..self.pos.len() {
            let Some(t) = &self.pos[i].tagged else {
                return Ok(Some(0));
            };
            if t.count <= TIED_COUNTED {
                return Ok(None);
            }
            least = least.min((t.count as f64).min(n));
            if self.pos[i].word() {
                let term = self.pos[i].lists[0].term.clone();
                let docs = ctx.term_docs(self.scope, &term)? as f64;
                share *= (1.0 - docs / n).max(0.0);
            }
        }
        Ok(Some((least * share).round() as u64))
    }

    fn counts(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<bool> {
        let mut tied = true;
        for m in &mut self.pos {
            match m.present(ctx, d)? {
                None => return Ok(false),
                Some(text) => tied &= !text,
            }
        }
        let takes = match self.take {
            Take::All => true,
            Take::Untied => !self.ties || !tied,
            Take::Tied => self.ties && tied,
        };
        Ok(takes && self.passes(ctx, d)?)
    }

    fn passes(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<bool> {
        for f in &mut self.include {
            let docs = f.docs();
            docs.seek(ctx, d)?;
            if docs.doc() != Some(d) {
                return Ok(false);
            }
        }
        for f in &mut self.exclude {
            let docs = f.docs();
            docs.seek(ctx, d)?;
            if docs.doc() == Some(d) {
                return Ok(false);
            }
        }
        for i in 0..ctx.checks.len() {
            ctx.work += 2 * SEEK;
            if !(ctx.checks[i])(d)? {
                return Ok(false);
            }
        }
        for m in &mut self.neg {
            if m.check(ctx, d)?.is_some() {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn score(&self, matched: &[Matched]) -> f64 {
        self.pos
            .iter()
            .zip(matched)
            .map(|(m, x)| m.score(x))
            .sum::<f64>()
            + 0.0
    }

    fn report_opened(&mut self, ctx: &mut Ctx) -> StoreResult<()> {
        let Some(o) = self.opened.take() else {
            return Ok(());
        };
        for (ci, li, pairs, lens) in &o.lists {
            self.pos[*ci].report_loose(
                ctx,
                *li,
                o.block,
                pairs,
                lens,
                Some(&o.scored),
                &o.carried[*ci],
            )?;
        }
        Ok(())
    }

    fn beaten_up(
        &mut self,
        ctx: &mut Ctx,
        block: u64,
        floor: Option<&Ranked>,
        walk: &mut Walk,
    ) -> StoreResult<u64> {
        ctx.nodes_passed[0] += 1;
        let Some(f) = floor else {
            return Ok(block);
        };
        let mut last = block;
        for level in 1.. {
            let node = node_of(block, level);
            if node == 0 {
                break;
            }
            let mut bound = Some(0.0);
            for m in &mut self.pos {
                bound = match (bound, m.node_bound_at(ctx, level, node, block)?) {
                    (Some(a), Some(b)) => Some(a + b),
                    _ => None,
                };
                if bound.is_none() {
                    break;
                }
            }
            if bound.is_some_and(|b| walk.counting || Ranked(b, 0) <= *f) {
                break;
            }
            ctx.nodes_passed[level as usize] += 1;
            let to = ((node + 1) << (GROUP_BITS * level as u32)) - 1;
            if bound.is_some() {
                walk.skipped = true;
                walk.floored
                    .push(((last + 1) << BLOCK_BITS, (to + 1) << BLOCK_BITS));
            }
            last = to;
        }
        Ok(last)
    }

    fn next_match(
        &mut self,
        ctx: &mut Ctx,
        mut d: u64,
        end: u64,
        budget: u64,
        floor: Option<&Ranked>,
        walk: &mut Walk,
    ) -> StoreResult<Step> {
        if self.take == Take::Tied && !self.ties {
            return Ok(Step::End);
        }
        let needs_text = self.needs_text();
        loop {
            if d >= end {
                return Ok(Step::End);
            }
            if ctx.work > budget {
                return Ok(Step::Stopped(d));
            }
            ctx.steps += 1;
            if !self.pos.is_empty()
                && self.all.is_none()
                && self.shallow.is_none_or(|(b, _)| b != d >> BLOCK_BITS)
            {
                let mut block = d >> BLOCK_BITS;
                loop {
                    let mut next = block;
                    for m in &mut self.pos {
                        match m.next_block(ctx, block)? {
                            Some(b) => next = next.max(b),
                            None => return Ok(Step::End),
                        }
                    }
                    if needs_text {
                        let mut text: Option<u64> = None;
                        for m in &mut self.pos {
                            if let Some(b) = m.text_next_block(ctx, next)? {
                                text = Some(text.map_or(b, |t| t.min(b)));
                            }
                        }
                        match text {
                            Some(b) => next = next.max(b),
                            None => return Ok(Step::End),
                        }
                    }
                    if next == block {
                        break;
                    }
                    block = next;
                }
                if block > d >> BLOCK_BITS {
                    d = block << BLOCK_BITS;
                    if d >= end {
                        return Ok(Step::End);
                    }
                }
                let mut bound = Some(0.0);
                for m in &mut self.pos {
                    bound = match (bound, m.bound_at(ctx, block)?) {
                        (Some(a), Some(b)) => Some(a + b),
                        _ => None,
                    };
                    if bound.is_none() {
                        break;
                    }
                }
                self.shallow = Some((block, bound));
            }
            if let Some((block, bound)) = self.shallow
                && block == d >> BLOCK_BITS
            {
                let beaten = match (bound, floor) {
                    (None, _) => true,
                    (Some(b), Some(f)) if !walk.counting => {
                        let beaten = Ranked(b, 0) > *f;
                        if beaten {
                            walk.skipped = true;
                            walk.floored.push((d, (block + 1) << BLOCK_BITS));
                        }
                        beaten
                    }
                    _ => false,
                };
                if beaten {
                    d = (self.beaten_up(ctx, block, floor, walk)? + 1) << BLOCK_BITS;
                    continue;
                }
                if let Some(f) = floor
                    && !walk.counting
                    && self.pos.iter().all(|m| !m.phrase)
                {
                    if self.cands.as_ref().is_none_or(|c| c.0 != block) {
                        let mut all = [u64::MAX; 1 << (BLOCK_BITS - 6)];
                        let mut texts = [0u64; 1 << (BLOCK_BITS - 6)];
                        let mut carried = Vec::with_capacity(self.pos.len());
                        self.report_opened(ctx)?;
                        let mut opened = Opened {
                            block,
                            lists: Vec::new(),
                            carried: Vec::new(),
                            scored: HashMap::new(),
                        };
                        for (ci, m) in self.pos.iter_mut().enumerate() {
                            let (text, carriers) = m.block_held(ctx, block)?;
                            let lead = m.lead();
                            if lead != Lead::Carriers {
                                for (li, l) in m.lists.iter().enumerate() {
                                    match l.shortest {
                                        Some((b, lens)) if l.dir.block == Some(block) && b == block => {
                                            opened.lists.push((ci, li, l.dir.pairs.clone(), lens))
                                        }
                                        _ if l.dir.block != Some(block) => opened.lists.push((
                                            ci,
                                            li,
                                            Vec::new(),
                                            [0.0; 1 << FIELD_BITS],
                                        )),
                                        _ => {}
                                    }
                                }
                            }
                            opened.carried.push(carriers);
                            for i in 0..all.len() {
                                all[i] &= match lead {
                                    Lead::Text => text[i],
                                    Lead::Carriers => carriers[i],
                                    Lead::Both => text[i] | carriers[i],
                                };
                                texts[i] |= text[i];
                            }
                            carried.push(carriers);
                        }
                        if needs_text {
                            for (a, t) in all.iter_mut().zip(texts) {
                                *a &= t;
                            }
                        }
                        let mut total = [0.0f64; 1 << BLOCK_BITS];
                        for (m, c) in self.pos.iter().zip(&carried) {
                            m.block_bounds(&all, c, &mut total);
                        }
                        let first = block << BLOCK_BITS;
                        let (mut docs, mut beaten) = (Vec::new(), Vec::new());
                        for (w, &bits) in all.iter().enumerate() {
                            let mut b = bits;
                            while b != 0 {
                                let i = w * 64 + b.trailing_zeros() as usize;
                                b &= b - 1;
                                let doc = first + i as u64;
                                if Ranked(total[i], doc) < *f {
                                    docs.push(doc);
                                } else {
                                    beaten.push(doc);
                                }
                            }
                        }
                        walk.skipped |= !beaten.is_empty();
                        self.cands = Some((block, docs, beaten));
                        self.opened = Some(opened);
                    }
                    let (_, docs, beaten) = self.cands.as_ref().unwrap();
                    let next = docs.get(docs.partition_point(|&x| x < d)).copied();
                    let to = next.unwrap_or((block + 1) << BLOCK_BITS);
                    let from = beaten.partition_point(|&x| x < d);
                    let past = beaten.partition_point(|&x| x < to);
                    walk.dropped.extend_from_slice(&beaten[from..past]);
                    d = to;
                    if next.is_none() {
                        continue;
                    }
                }
            }
            if needs_text {
                let mut text: Option<u64> = None;
                for m in &mut self.pos {
                    if let Some(x) = m.text_align(ctx, d)? {
                        text = Some(text.map_or(x, |t| t.min(x)));
                    }
                }
                match text {
                    Some(x) => d = d.max(x),
                    None => return Ok(Step::End),
                }
            }
            let mut agreed = true;
            if let Some(a) = &mut self.all {
                a.seek(ctx, d)?;
                match a.doc() {
                    None => return Ok(Step::End),
                    Some(x) if x != d => {
                        d = x;
                        agreed = false;
                    }
                    _ => {}
                }
            }
            for m in &mut self.pos {
                m.align(ctx, d)?;
                match m.doc {
                    None => return Ok(Step::End),
                    Some(x) if x != d => {
                        d = x;
                        agreed = false;
                    }
                    _ => {}
                }
            }
            for f in &mut self.include {
                let docs = f.docs();
                docs.seek(ctx, d)?;
                match docs.doc() {
                    None => return Ok(Step::End),
                    Some(x) if x != d => {
                        d = x;
                        agreed = false;
                    }
                    _ => {}
                }
            }
            if !agreed || d >= end {
                continue;
            }
            if needs_text && !self.pos.iter().any(|m| m.text_doc == Some(d)) {
                d += 1;
                continue;
            }
            if let Some(f) = floor
                && !walk.counting
                && !self.pos.is_empty()
            {
                let mut blocks = 0.0;
                for m in &mut self.pos {
                    blocks += m.block_ceiling(ctx, d)?;
                }
                if Ranked(blocks, 0) > *f {
                    walk.skipped = true;
                    let to = self
                        .pos
                        .iter()
                        .map(Matcher::block_end)
                        .min()
                        .unwrap_or(u64::MAX)
                        .max(d + 1);
                    walk.floored.push((d, to));
                    d = to;
                    continue;
                }
            }
            if let Some(f) = floor
                && !self.pos.is_empty()
            {
                let mut here = 0.0;
                for m in &mut self.pos {
                    here += m.doc_ceiling(ctx, d)?;
                }
                if Ranked(here, d) > *f {
                    if walk.counting {
                        walk.checked += 1;
                        ctx.checked += 1;
                        if self.counts(ctx, d)? {
                            walk.counted += 1;
                        }
                    } else {
                        walk.skipped = true;
                        walk.passed += 1;
                    }
                    d += 1;
                    continue;
                }
            }
            walk.checked += 1;
            ctx.checked += 1;
            let mut matched = Vec::with_capacity(self.pos.len());
            let mut all = true;
            for m in &mut self.pos {
                match m.check(ctx, d)? {
                    Some(x) => matched.push(x),
                    None => {
                        all = false;
                        break;
                    }
                }
            }
            if let Some(o) = &mut self.opened
                && o.block == d >> BLOCK_BITS
                && let Some((sc, cd, codes)) = ctx.codes
                && (sc, cd) == (self.scope, d)
            {
                o.scored.insert(d, codes);
            }
            if !all || !self.takes(&matched) || !self.passes(ctx, d)? {
                d += 1;
                continue;
            }
            return Ok(Step::Match(d, matched));
        }
    }

    fn matches(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<bool> {
        Ok(matches!(
            self.next_match(ctx, d, d + 1, u64::MAX, None, &mut Walk::default())?,
            Step::Match(..)
        ))
    }

    fn estimate_descended(
        &mut self,
        ctx: &mut Ctx,
        counted: u64,
        checked: u64,
    ) -> StoreResult<u64> {
        let term = self.pos[0].lists[0].term.clone();
        let n = ctx.term_docs(self.scope, &term)?;
        if checked == 0 {
            return Ok(counted);
        }
        Ok(((n as f64 * counted as f64 / checked as f64).round() as u64).max(counted))
    }

    fn include_counts(&mut self, ctx: &mut Ctx) -> StoreResult<&[u64]> {
        if self.counts.is_none() {
            let mut out = Vec::with_capacity(self.include.len());
            for (f, (_, counters)) in self.include.iter().zip(&self.include_of) {
                out.push(match f {
                    Filtered::Ids(l) => l.items.len() as u64,
                    _ => {
                        let mut c = 0;
                        for k in counters {
                            c += ctx.counter(k)?;
                        }
                        c
                    }
                });
            }
            self.counts = Some(out);
        }
        Ok(self.counts.as_deref().unwrap_or_default())
    }

    fn leading(&mut self, ctx: &mut Ctx) -> StoreResult<Option<(Leading, u64)>> {
        let mut best: Option<((u64, bool, usize), Leading)> = None;
        for i in 0..self.pos.len() {
            if self.pos[i].single().is_none() {
                continue;
            }
            let term = self.pos[i].lists[0].term.clone();
            let rank = (ctx.term_docs(self.scope, &term)?, true, self.pos_at[i]);
            if best.as_ref().is_none_or(|b| rank < b.0) {
                best = Some((rank, Leading::Word(i)));
            }
        }
        let counts = self.include_counts(ctx)?.to_vec();
        for (j, &c) in counts.iter().enumerate() {
            let at = self.include_of[j].0;
            let rank = (c, !matches!(self.include[j], Filtered::Ids(_)), at);
            if best.as_ref().is_none_or(|b| rank < b.0) {
                best = Some((rank, Leading::Include(j)));
            }
        }
        Ok(best.map(|(r, l)| (l, r.0)))
    }

    fn lead_ends(&self, ctx: &mut Ctx, lead: &Leading) -> StoreResult<Option<(u64, u64)>> {
        let lists: Vec<&Members> = match lead {
            Leading::Word(i) => return self.pos[*i].lists[0].dir.ends(ctx),
            Leading::Include(j) => match &self.include[*j] {
                Filtered::Tags(m) => vec![m],
                Filtered::Any(a) | Filtered::Carriers(Carriers::Tags(a)) => a.0.iter().collect(),
                Filtered::Carriers(Carriers::Term(t)) => std::iter::once(&t.map)
                    .chain(&t.heavy)
                    .chain(t.moving.iter().map(|(_, m)| m))
                    .collect(),
                Filtered::Ids(_) => return Ok(None),
            },
        };
        let mut out: Option<(u64, u64)> = None;
        for m in lists {
            if let Some((a, b)) = m.ends(ctx)? {
                out = Some(out.map_or((a, b), |(x, y)| (x.min(a), y.max(b))));
            }
        }
        Ok(out)
    }

    fn estimate_walked(
        &mut self,
        ctx: &mut Ctx,
        counted: u64,
        walk: &Walk,
        stopped: Option<u64>,
    ) -> StoreResult<u64> {
        let Some((lead, c)) = self.leading(ctx)? else {
            return match stopped {
                Some(at) => self.estimate(ctx, counted, at),
                None => Ok(counted),
            };
        };
        if counted == 0 {
            return Ok(0);
        }
        let passed = walk.passed as f64;
        let ids = match &lead {
            Leading::Include(j) => match &self.include[*j] {
                Filtered::Ids(l) => Some(l),
                _ => None,
            },
            Leading::Word(_) => None,
        };
        let checked = if let Some(l) = ids {
            let end = stopped.unwrap_or(u64::MAX);
            let below = |d: u64| l.items.partition_point(|x| x.0 < d) as f64;
            let floored: f64 = walk
                .floored
                .iter()
                .map(|&(a, b)| (below(b.min(end)) - below(a)).max(0.0))
                .sum();
            let dropped = walk
                .dropped
                .iter()
                .filter(|&&d| d < end && l.items.binary_search_by_key(&d, |x| x.0).is_ok())
                .count() as f64;
            below(end) - floored - dropped - passed
        } else {
            let Some((first, last)) = self.lead_ends(ctx, &lead)? else {
                return Ok(counted);
            };
            let span = (last - first + 1) as f64;
            let end = stopped.map_or(last + 1, |s| s.min(last + 1));
            let mut covered = end.saturating_sub(first) as f64;
            for &(a, b) in &walk.floored {
                let (a, b) = (a.max(first), b.min(end));
                if a < b {
                    covered -= (b - a) as f64;
                }
            }
            let dropped = walk
                .dropped
                .iter()
                .filter(|&&d| first <= d && d < end)
                .count() as f64;
            let dropped = match lead {
                Leading::Word(_) => dropped,
                Leading::Include(_) => dropped * c as f64 / span,
            };
            c as f64 * covered / span - dropped - passed
        };
        let checked = checked.max(counted as f64);
        let e = (c as f64 * counted as f64 / checked).round() as u64;
        Ok(e.min(c).max(counted))
    }

    fn estimate(&mut self, ctx: &mut Ctx, counted: u64, from: u64) -> StoreResult<u64> {
        let top = ctx
            .get(&max_doc(self.scope))?
            .and_then(|b| parse_varint(&b))
            .unwrap_or(0)
            .max(from);
        let share = (from as f64 + 1.0) / (top as f64 + 1.0);
        Ok(((counted as f64 / share).round() as u64).max(counted))
    }

    fn descend(
        &mut self,
        ctx: &mut Ctx,
        after: Option<&Ranked>,
        best: &mut Best,
        budget: u64,
        walk: &mut Walk,
    ) -> StoreResult<(u64, bool)> {
        let scope = self.scope;
        let (term, mask, as_prefix) = {
            let l = &self.pos[0].lists[0];
            (l.term.clone(), l.mask, l.as_prefix)
        };
        self.pos[0].lists[0].dir.park();
        let mut heap: BinaryHeap<Reverse<(Ranked, u64, u64)>> = BinaryHeap::new();
        let push_group = |plan: &mut Plan,
                          ctx: &mut Ctx,
                          best: &Best,
                          heap: &mut BinaryHeap<Reverse<(Ranked, u64, u64)>>,
                          walk: &mut Walk,
                          level: u64,
                          group: u64|
         -> StoreResult<()> {
            let map = ctx.max_map(block_maxima(scope, &term, level, group))?;
            for &(sl, _) in map.iter() {
                let (node, field, prefix) = unmax_slot(group, sl);
                if field.is_some() || prefix != as_prefix || (level > 0 && node == 0) {
                    continue;
                }
                let first = node << (GROUP_BITS * level as u32);
                let Some(bound) = plan.pos[0].node_bound_at(ctx, level, node, first)? else {
                    continue;
                };
                let r = Ranked(bound, first << BLOCK_BITS);
                if best.worst().is_some_and(|f| r >= *f) {
                    walk.skipped = true;
                    continue;
                }
                heap.push(Reverse((r, level, node)));
            }
            Ok(())
        };
        let top = top_level(last_block(ctx, scope)?);
        for level in 0..=top {
            push_group(self, ctx, best, &mut heap, walk, level, 0)?;
        }
        let mut counted = 0;
        while let Some(Reverse((r, level, node))) = heap.pop() {
            if ctx.work > budget {
                return Ok((counted, false));
            }
            if best.worst().is_some_and(|f| r >= *f) {
                walk.skipped = true;
                break;
            }
            if level > 0 {
                push_group(self, ctx, best, &mut heap, walk, level - 1, node)?;
                continue;
            }
            let block = node;
            ctx.posting_blocks += 1;
            let pairs = ctx.map(posting_block(scope, &term, block))?;
            let mut held = [0u64; 1 << (BLOCK_BITS - 6)];
            mark_held(mask, &pairs, &mut held);
            let lens = shortest_lens(ctx, scope, mask, block)?;
            let carried = self.pos[0].carried_in(ctx, block)?;
            let mut scored: HashMap<u64, [u8; 1 << FIELD_BITS]> = HashMap::new();
            let mut bounds = [0.0f64; 1 << BLOCK_BITS];
            self.pos[0].bounds_of(&[(mask, &pairs, lens)], &held, &carried, &mut bounds);
            let first = block << BLOCK_BITS;
            for (w, &bits) in held.iter().enumerate() {
                let mut b = bits;
                while b != 0 {
                    let i = w * 64 + b.trailing_zeros() as usize;
                    b &= b - 1;
                    let doc = first + i as u64;
                    if ctx.work > budget {
                        return Ok((counted, false));
                    }
                    if best.worst().is_some_and(|f| Ranked(bounds[i], doc) >= *f) {
                        walk.skipped = true;
                        continue;
                    }
                    walk.checked += 1;
                    ctx.checked += 1;
                    let matched = self.pos[0].check(ctx, doc)?;
                    if let Some((sc, cd, codes)) = ctx.codes
                        && (sc, cd) == (scope, doc)
                    {
                        scored.insert(doc, codes);
                    }
                    let Some(matched) = matched else {
                        continue;
                    };
                    let matched = [matched];
                    if !self.takes(&matched) || !self.passes(ctx, doc)? {
                        continue;
                    }
                    counted += 1;
                    let r = Ranked(self.score(&matched), doc);
                    if after.is_none_or(|a| r > *a) {
                        best.push(r);
                    }
                }
            }
            self.pos[0].report_loose(ctx, 0, block, &pairs, &lens, Some(&scored), &carried)?;
        }
        Ok((counted, true))
    }

    const CHECKED_WHOLE: u64 = 128;

    fn by_relevance(
        &mut self,
        ctx: &mut Ctx,
        q: &Query,
        read: Read,
        names: &TagNames,
    ) -> StoreResult<Found> {
        let (after, resumed) = match &q.after {
            Some(After::Score(s, d)) => (Some(Ranked(*s, *d)), None),
            Some(After::Partial(p)) => (p.after.map(|(s, d)| Ranked(s, d)), Some(p.as_ref())),
            _ => (None, None),
        };
        let mut best = Best {
            cap: q.limit + 1,
            set: BTreeSet::new(),
        };
        let partial = |after: &Option<Ranked>, from: u64, best: &Best, total: u64, skipped: bool| Partial {
            after: after.as_ref().map(|r| (r.0, r.1)),
            from,
            best: best.set.iter().map(|r| (r.0, r.1)).collect(),
            total,
            skipped,
        };
        if let Some(p) = resumed {
            return self.walk_relevance(ctx, q, read, after, best, p.from, p.total, p.skipped, partial);
        }
        let mut docs = None;
        if self.pos.len() == 1
            && self.pos[0].single().is_some()
            && self.pos[0].lists[0].as_prefix
            && self.pos[0].lists[0].mask == self.pos[0].mask_all()
        {
            let term = self.pos[0].lists[0].term.clone();
            docs = Some(ctx.term_docs(self.scope, &term)?);
        }
        let whole = docs.is_some_and(|n| n <= Self::CHECKED_WHOLE);
        let filtered = !self.include.is_empty()
            || !self.exclude.is_empty()
            || !self.neg.is_empty()
            || !ctx.checks.is_empty();
        let mut counting = read == Read::Counting;
        if !counting && !whole && self.pos.len() == 1 && self.pos[0].single().is_some() {
            let led = read == Read::Chosen && !self.include.is_empty();
            let mut limit = q.limits.ranked;
            if led {
                let term = self.pos[0].lists[0].term.clone();
                let df = ctx.term_docs(self.scope, &term)?;
                let c = self.include_counts(ctx)?.iter().copied().min().unwrap_or(0);
                limit = limit.min(c.min(df).saturating_mul(2 * SEEK));
            }
            let budget = ctx.work.saturating_add(limit);
            let mut walk = Walk::default();
            let (counted, done) =
                self.descend(ctx, after.as_ref(), &mut best, budget, &mut walk)?;
            if !led || done {
                let mut total_exact = done && !walk.skipped;
                let mut total = counted;
                if let Some(n) = docs
                    && !filtered
                {
                    (total, total_exact) = (n, true);
                }
                if !total_exact {
                    total = self.estimate_descended(ctx, total, walk.checked)?;
                }
                let mut found = page_of(best, q.limit, total, total_exact, done, self.scale);
                if !done {
                    let empty = Best {
                        cap: q.limit + 1,
                        set: BTreeSet::new(),
                    };
                    found.partial = Some(partial(&after, 0, &empty, 0, false));
                }
                return Ok(found);
            }
            best.set.clear();
            counting = true;
        }
        if !counting && after.is_none() {
            self.seed_short(ctx, q, names, &mut best)?;
        }
        self.walk_relevance_from(ctx, q, after, best, 0, 0, false, counting, docs, partial)
    }

    fn seed_short(
        &mut self,
        ctx: &mut Ctx,
        q: &Query,
        names: &TagNames,
        best: &mut Best,
    ) -> StoreResult<()> {
        let [m] = self.pos.as_slice() else {
            return Ok(());
        };
        let short = super::pair_fields(self.scope) & m.mask;
        if !m.phrase || m.paired || short == 0 || !ctx.pairs_on()? {
            return Ok(());
        }
        let mut sq = q.clone();
        sq.clauses[self.pos_at[0]].fields = Some(fields_of(self.scope, short).collect());
        let none = TagNames::default();
        let mut sub = Plan::new(ctx, &sq, Take::All, &none)?;
        let found = sub.by_relevance(ctx, &sq, Read::Chosen, &none)?;
        if found.hits.is_empty() {
            return Ok(());
        }
        let mut full = Plan::new(ctx, q, self.take, names)?;
        for h in found.hits {
            let mut matched = Vec::with_capacity(full.pos.len());
            for m in &mut full.pos {
                match m.check(ctx, h.doc)? {
                    Some(x) => matched.push(x),
                    None => break,
                }
            }
            if matched.len() == full.pos.len() && full.takes(&matched) && full.passes(ctx, h.doc)? {
                best.push(Ranked(full.score(&matched), h.doc));
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn walk_relevance(
        &mut self,
        ctx: &mut Ctx,
        q: &Query,
        read: Read,
        after: Option<Ranked>,
        mut best: Best,
        from: u64,
        total: u64,
        skipped: bool,
        partial: impl Fn(&Option<Ranked>, u64, &Best, u64, bool) -> Partial,
    ) -> StoreResult<Found> {
        let resumed = q.after.as_ref().and_then(|a| match a {
            After::Partial(p) => Some(p),
            _ => None,
        });
        for &(s, d) in resumed.map_or(&[][..], |p| p.best.as_slice()) {
            best.push(Ranked(s, d));
        }
        self.walk_relevance_from(ctx, q, after, best, from, total, skipped, read == Read::Counting, None, partial)
    }

    #[allow(clippy::too_many_arguments)]
    fn walk_relevance_from(
        &mut self,
        ctx: &mut Ctx,
        q: &Query,
        after: Option<Ranked>,
        mut best: Best,
        mut d: u64,
        mut total: u64,
        skipped_before: bool,
        counting: bool,
        docs: Option<u64>,
        partial: impl Fn(&Option<Ranked>, u64, &Best, u64, bool) -> Partial,
    ) -> StoreResult<Found> {
        let whole = docs.is_some_and(|n| n <= Self::CHECKED_WHOLE);
        let filtered = !self.include.is_empty()
            || !self.exclude.is_empty()
            || !self.neg.is_empty()
            || !ctx.checks.is_empty();
        let mut stopped = None;
        let mut walk = Walk {
            counting,
            ..Walk::default()
        };
        let budget = if whole {
            u64::MAX
        } else {
            ctx.work.saturating_add(q.limits.enumerate)
        };
        loop {
            let floor = best.worst().filter(|_| !whole).map(|r| Ranked(r.0, r.1));
            match self.next_match(ctx, d, u64::MAX, budget, floor.as_ref(), &mut walk)? {
                Step::Match(doc, matched) => {
                    #[cfg(test)]
                    super::tests::hook("walk");
                    total += 1;
                    let r = Ranked(self.score(&matched), doc);
                    if after.as_ref().is_none_or(|a| r > *a) {
                        best.push(r);
                    }
                    d = doc + 1;
                }
                Step::End => break,
                Step::Stopped(at) => {
                    stopped = Some(at);
                    break;
                }
            }
        }
        self.report_opened(ctx)?;
        total += walk.counted;
        let skipped = skipped_before || walk.skipped;
        let next = stopped.map(|at| partial(&after, at, &best, total, skipped));
        let page_exact = stopped.is_none();
        let mut total_exact = page_exact && !skipped;
        if let Some(n) = docs
            && !filtered
        {
            (total, total_exact) = (n, true);
        }
        if !total_exact {
            total = self.estimate_walked(ctx, total, &walk, stopped)?;
        }
        let mut found = page_of(best, q.limit, total, total_exact, page_exact, self.scale);
        found.partial = next;
        Ok(found)
    }

    fn by_key(&mut self, ctx: &mut Ctx, q: &Query, order: &dyn SortKey) -> StoreResult<Found> {
        let after = match &q.after {
            Some(After::Key(k, d)) => Some((k.clone(), *d)),
            _ => None,
        };
        let n = self.stats.n.max(1.0);
        let page = q.limit.max(1) as f64;
        let estimate = match self.pos.as_slice() {
            [m] if m.single().is_some() => {
                Some(ctx.term_docs(self.scope, &m.lists[0].term)? as f64)
            }
            _ => None,
        };
        let walk_first = estimate.is_some_and(|e| e > (page * n).sqrt());
        let collect = ((page * n).sqrt() as usize).max(q.limit + 1);
        let mut docs = Vec::new();
        let mut total = 0u64;
        let mut stopped = None;
        let mut walk = Walk::default();
        if !walk_first {
            let budget = ctx.work.saturating_add(q.limits.enumerate);
            let mut d = 0;
            loop {
                match self.next_match(ctx, d, u64::MAX, budget, None, &mut walk)? {
                    Step::Match(doc, _) => {
                        total += 1;
                        if docs.len() <= collect {
                            docs.push(doc);
                        }
                        d = doc + 1;
                    }
                    Step::End => break,
                    Step::Stopped(at) => {
                        stopped = Some(at);
                        break;
                    }
                }
            }
        }
        let mut total_exact = !walk_first && stopped.is_none();
        if let Some(at) = stopped {
            total = self.estimate(ctx, total, at)?;
        }
        if walk_first {
            total = estimate.unwrap_or(0.0) as u64;
            let filtered =
                !self.include.is_empty() || !self.exclude.is_empty() || !self.neg.is_empty();
            let m = &self.pos[0];
            let l = &m.lists[0];
            let all_fields =
                l.mask == m.mask_all() && (l.as_prefix || !gram_shared(self.scope, &l.term));
            total_exact = !filtered && all_fields;
        }
        let mut hits: Vec<(Vec<u8>, u64)> = Vec::new();
        let mut page_exact = true;
        if !walk_first && total_exact && docs.len() <= collect {
            for doc in docs {
                ctx.work += SEEK;
                let e = (order.key_of(ctx.view, doc)?, doc);
                if after.as_ref().is_none_or(|a| &e > a) {
                    hits.push(e);
                }
            }
            hits.sort();
            hits.truncate(q.limit + 1);
        } else {
            let budget = ctx.work.saturating_add(q.limits.walked);
            let mut from = after.clone();
            'walk: loop {
                let batch = order.walk(ctx.view, from.as_ref(), 256)?;
                ctx.work += SEEK + batch.len() as u64;
                if batch.is_empty() {
                    break;
                }
                for e in batch {
                    if ctx.work > budget {
                        page_exact = false;
                        break 'walk;
                    }
                    if self.matches(ctx, e.1)? {
                        hits.push(e.clone());
                        if hits.len() > q.limit {
                            break 'walk;
                        }
                    }
                    from = Some(e);
                }
            }
        }
        let more = hits.len() > q.limit || !page_exact;
        hits.truncate(q.limit);
        Ok(Found {
            hits: hits
                .into_iter()
                .map(|(k, doc)| Hit {
                    doc,
                    score: 0.0,
                    rank: 0.0,
                    key: Some(k),
                })
                .collect(),
            total,
            total_exact,
            page_exact,
            more,
            ..Default::default()
        })
    }
}

impl Matcher {
    fn mask_all(&self) -> u64 {
        (1 << self.scope.fields().len()) - 1
    }
}

pub fn count_at(counts: &[(u32, u64)], slot: u32) -> u64 {
    counts
        .binary_search_by_key(&slot, |x| x.0)
        .map_or(0, |i| counts[i].1)
}

fn tags_only(tags_field: Option<u32>, c: &Clause) -> bool {
    matches!((tags_field, &c.fields), (Some(t), Some(fs))
        if !fs.is_empty() && fs.iter().all(|&f| f == t) && !tokens(&c.text).is_empty())
}

fn tags_field(scope: Scope) -> Option<u32> {
    (scope == Scope::LIBRARY)
        .then(|| scope.fields().iter().position(|d| d.name == "tags"))
        .flatten()
        .map(|f| f as u32)
}

fn named(
    ctx: &mut Ctx,
    toks: Vec<String>,
    last: bool,
    until: u64,
    counted: bool,
) -> StoreResult<Named> {
    if let Some((kind, term)) = mapped_term(&toks, last) {
        let count = match counted {
            true => ctx.counter(&key::term_carriers(kind, &term))?,
            false => 0,
        };
        let (t, done) = term_tags(ctx, kind, term, until)?;
        return Ok(Named {
            source: Source::Term(t),
            done,
            count,
        });
    }
    let (tags, done) = named_tags(ctx, toks, last, until)?;
    let mut count = 0;
    if counted {
        for &t in &tags {
            count += ctx.counter(&key::id(key::MEMBER_COUNT, t))?;
        }
    }
    Ok(Named {
        source: Source::Tags(tags),
        done,
        count,
    })
}

fn mapped_term(toks: &[String], last: bool) -> Option<(TermKind, String)> {
    let [tok] = toks else {
        return None;
    };
    let n = char_len(tok);
    if !(last && n >= GRAM_MIN) {
        Some((TermKind::Exact, tok.clone()))
    } else if n <= GRAM_MAX {
        Some((TermKind::Gram, tok.clone()))
    } else {
        None
    }
}

fn term_tags(
    ctx: &mut Ctx,
    kind: TermKind,
    term: String,
    until: u64,
) -> StoreResult<(TermTags, bool)> {
    let want = (kind, term.clone());
    let holds = |name: &[u8]| carriers::name_terms(name).contains(&want);
    let mut t = TermTags {
        kind,
        term: term.clone(),
        heavy: Vec::new(),
        moving: Vec::new(),
    };
    let mut done = true;
    tags_under(
        ctx,
        key::term_key(key::TERM_MOVING, kind, &term),
        until,
        &mut done,
        |ctx, tag| {
            let Some(TagMap {
                heavy,
                flight: Some(f),
            }) = ctx
                .get(&key::id(key::TAG_MAP, tag))?
                .map(|b| TagMap::parse(&b))
                .transpose()?
            else {
                return Err(StoreError::Entry("a moving tag has no move".into()));
            };
            let named = if f.pending {
                let texts = ctx.texts(Scope::TAGS, tag, 0)?;
                holds(&carriers::one_name(
                    &texts.iter().map(Vec::as_slice).collect::<Vec<_>>(),
                )?)
            } else {
                holds(&f.target_name)
            };
            t.moving.push(Mover {
                tag,
                cursor: f.cursor,
                below: !f.target_heavy && holds(&f.target_name),
                above: !heavy && holds(&f.mapped_name),
                named,
                target_has: holds(&f.target_name),
                mapped_has: holds(&f.mapped_name),
            });
            Ok(())
        },
    )?;
    if done {
        tags_under(
            ctx,
            key::term_key(key::TERM_HEAVY, kind, &term),
            until,
            &mut done,
            |_, tag| {
                if t.moving.binary_search_by_key(&tag, |m| m.tag).is_err() {
                    t.heavy.push(tag);
                }
                Ok(())
            },
        )?;
    }
    Ok((t, done))
}

fn tags_under(
    ctx: &mut Ctx,
    prefix: Vec<u8>,
    until: u64,
    done: &mut bool,
    mut each: impl FnMut(&mut Ctx, u64) -> StoreResult<()>,
) -> StoreResult<()> {
    let end = key::prefix_end(&prefix);
    let mut from = prefix.clone();
    loop {
        if ctx.work > until {
            *done = false;
            return Ok(());
        }
        let page = ctx.scan(&from, &end, 64)?;
        for (k, _) in &page {
            if ctx.work > until {
                *done = false;
                return Ok(());
            }
            let mut at = prefix.len();
            each(ctx, u64_at(k, &mut at)?)?;
        }
        match page.last() {
            Some((k, _)) if page.len() == 64 => from = successor(k),
            _ => return Ok(()),
        }
    }
}

fn named_tags(
    ctx: &mut Ctx,
    toks: Vec<String>,
    last: bool,
    until: u64,
) -> StoreResult<(Vec<u64>, bool)> {
    let stats = scope_stats(ctx, Scope::TAGS)?;
    let Some(mut m) = Matcher::new(ctx, Scope::TAGS, &stats, toks, None, last, None)? else {
        return Ok((Vec::new(), true));
    };
    let mut out = Vec::new();
    let mut d = 0;
    loop {
        if ctx.work > until {
            return Ok((out, false));
        }
        m.align(ctx, d)?;
        let Some(tag) = m.doc else {
            return Ok((out, true));
        };
        if m.check(ctx, tag)?.is_some() {
            out.push(tag);
        }
        d = tag + 1;
    }
}

fn gram_shared(scope: Scope, term: &str) -> bool {
    char_len(term) >= GRAM_MIN && scope.fields().iter().any(|d| d.prefix)
}

fn page_of(
    best: Best,
    limit: usize,
    total: u64,
    total_exact: bool,
    page_exact: bool,
    scale: f64,
) -> Found {
    let mut hits: Vec<Hit> = best
        .set
        .into_iter()
        .map(|Ranked(rank, doc)| Hit {
            doc,
            score: rank * scale,
            rank,
            key: None,
        })
        .collect();
    let more = hits.len() > limit || !page_exact;
    hits.truncate(limit);
    Found {
        hits,
        total,
        total_exact,
        page_exact,
        more,
        ..Default::default()
    }
}
