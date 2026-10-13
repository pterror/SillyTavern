//! Reading the index: a query is clauses (words or phrases, each over some fields, maybe negated) and filters,
//! answered as a page in relevance (BM25) or sort-key order, with a total.
//!
//! Matching: every positive clause and filter must match, no negated one. A clause of one token is a word; one
//! of several tokens (quoted, or split by the tokenizer, as `foo-bar`) is a phrase: its tokens adjacent and in
//! order within one value of one field. The query's last token is a prefix (from 2 characters), unless its
//! clause is `quoted` (a closed-quote phrase): for a word in the prefix fields only, an exact token elsewhere; for
//! a phrase in every field. A phrase is found through its
//! exact tokens' postings, then checked on the candidates' text.
//!
//! Scoring: a clause scores its tokens' idfs (one per token, from the documents holding its term) times the
//! document's own text score (`super::local`, `super::clause_score`), each field's count weighed against the
//! field's reference length.
//!
//! In relevance order the clauses' postings are walked in id order, passing over blocks whose bound (the most a
//! document there scores for each term, its block maxima) can't beat the page; from such a block, on past each
//! node of blocks above it that can't either, by the nodes' maxima. One word with more documents than are read
//! whole is read best first instead (`Plan::descend`): from its maxima's top, the node or block bounded highest
//! next, until none can beat the page. In sort-key order a word with few documents is read whole and sorted by
//! key; otherwise the order is walked and each document checked, whichever the counts say is cheaper.
//!
//! In the library, a clause over every field also matches the carriers of the tags whose names it matches
//! (`super::TAG_WEIGHT`): their members are one more list of the clause, each scoring the same. A word's are read
//! by its term from the carrier maps (`crate::store::carriers`); a prefix past the prefix terms' length, or a
//! phrase, finds its tags by name and reads each one's members. Documents every positive clause matches by a
//! tag name alone all score alike (`Found::tied`): in relevance order they are read apart (`Take`), after the
//! matches scoring above them, in id order here and in the list's order in the library list.
//!
//! Work is counted in entries read (a scan's start counts `SEEK` entries, a decoded pair 1 / `PAIRS`, a text
//! read `TEXT` plus its bytes / 32), each about 0.16 µs at 10^6 documents. Past a limit the page is marked
//! inexact; totals are exact where the counts give them or the walk finished, estimates otherwise.

use std::cmp::Ordering;
use std::cmp::Reverse;
use std::collections::{BTreeSet, BinaryHeap, HashMap};
use std::sync::Arc;

use super::text::{GRAM_MAX, GRAM_MIN, char_len, first_chars, phrase_in, tokens};
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

/// Pairs of the block maps a query keeps read (about 8 bytes each).
const MAPS_HELD: usize = 1 << 22;

/// Carriers of a clause's tags under which the tied documents are counted one by one; above, estimated.
const TIED_COUNTED: u64 = 128;
/// Work counting the tied documents one by one does at most; past it they are estimated.
const TIED_COUNT_WORK: u64 = 16_384;

/// Work a scan's start costs, in entries.
pub const SEEK: u64 = 96;
/// Pairs decoded per entry of work.
pub const PAIRS: u64 = 8;
/// Work a text read costs besides its bytes / 32.
pub const TEXT: u64 = 128;
/// Work a tag's member block decoded costs besides its entry, and per place in it, in thousandths of an entry:
/// measured at 10^5 synthetic cards over every tag's blocks, grouped by places per block and fitted, as
/// 1.694 entries per block and 0.131 per place (one entry read ~93 ns).
pub const MEMBER_BLOCK_MILLI: u64 = 694;
pub const MEMBER_PLACE_MILLI: u64 = 131;
/// The same for a term's map block (`key::TAG_CARRIERS`): measured at 10^5 synthetic cards over every term's
/// blocks the same way, as 1.522 entries per block and 0.1435 per place (the median of 9 rounds).
pub const TERM_MAP_BLOCK_MILLI: u64 = 522;
pub const TERM_MAP_PLACE_MILLI: u64 = 144;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Walking directories in id order (and counting).
    pub enumerate: u64,
    /// Reading one word's postings best first.
    pub ranked: u64,
    /// Walking a sort order checking documents.
    pub walked: u64,
    /// Finding the tags whose names a clause matches.
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
    /// WTF-8.
    pub text: Vec<u8>,
    /// The fields it matches in (indexes into the scope's fields); all of them when None.
    pub fields: Option<Vec<u32>>,
    pub negate: bool,
    /// A closed-quote phrase: its last word is whole even when it ends the query.
    pub quoted: bool,
}

/// A check of each document a filter adds, begun once per query on the query's view.
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
    /// Entities carrying every one of these tags.
    AllTags(Vec<u64>),
    /// Entities carrying any of these tags.
    AnyTag(Vec<u64>),
    /// Entities carrying none of these tags.
    NoTag(Vec<u64>),
    Ids(Vec<u64>),
    NotIds(Vec<u64>),
    /// Documents the check passes (about two point reads each).
    Check(Arc<dyn DocCheck>),
}

/// An order of documents by a key, kept by the structure that owns the key.
pub trait SortKey: Send + Sync {
    /// The document's key (empty if it has none).
    fn key_of(&self, view: &View, doc: u64) -> StoreResult<Vec<u8>>;
    /// Up to `limit` (key, document) in order, after `after`.
    fn walk(
        &self,
        view: &View,
        after: Option<&(Vec<u8>, u64)>,
        limit: usize,
    ) -> StoreResult<Vec<(Vec<u8>, u64)>>;
}

#[derive(Clone)]
pub enum Order {
    /// Score, highest first; then document id.
    Relevance,
    /// Key, then document id.
    Key(Arc<dyn SortKey>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum After {
    /// A hit's `rank`, and its document.
    Score(f64, u64),
    Key(Vec<u8>, u64),
}

#[derive(Clone)]
pub struct Query {
    pub scope: Scope,
    pub clauses: Vec<Clause>,
    pub filters: Vec<Filter>,
    pub order: Order,
    pub limit: usize,
    /// The last hit of the page before.
    pub after: Option<After>,
    /// The idfs the query ranks by, as the first page's `Found::weights` gave them, so every page ranks alike
    /// whatever changed in the scope since; None reads them.
    pub weights: Option<Vec<f64>>,
    pub limits: Limits,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub doc: u64,
    /// 0 in sort-key order.
    pub score: f64,
    /// Where the hit ranks, as a later page's `After::Score` takes it: with one positive word, its score before
    /// the idf, which documents added or removed elsewhere in the scope don't move; else its score.
    pub rank: f64,
    /// The sort key in sort-key order.
    pub key: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Default)]
pub struct Found {
    pub hits: Vec<Hit>,
    /// Every match, the pages before this one included.
    pub total: u64,
    pub total_exact: bool,
    /// The page holds exactly the best matches after `after`.
    pub page_exact: bool,
    /// Matches follow the page (or may, when the page isn't exact).
    pub more: bool,
    pub work: u64,
    /// Scans started, entries they read, pairs decoded from them, point reads and texts read.
    pub scans: u64,
    pub entries: u64,
    pub pairs: u64,
    pub gets: u64,
    pub texts: u64,
    /// Documents whose lengths were read.
    pub length_reads: u64,
    /// Steps of the walk in id order, and documents it checked.
    pub steps: u64,
    pub checked: u64,
    /// Posting blocks decoded, maxima maps read (point reads and the scans that find a list's next block), and
    /// lookups of a list's next block.
    pub posting_blocks: u64,
    pub max_reads: u64,
    pub next_blocks: u64,
    /// Blocks (level 0) and nodes (levels above) the walk passed over by their maxima, by level.
    pub nodes_passed: [u64; LEVELS],
    /// Time reading statistics before matching.
    pub plan_micros: u64,
    /// When every positive clause matches tag names: the rank (`Hit::rank`) of the documents they match by tag names
    /// alone, and their score.
    pub tied: Option<f64>,
    pub tied_score: Option<f64>,
    /// The idfs the page ranked by, for later pages' `Query::weights`: one per token of each positive clause that
    /// scores, in clause and token order; None for one word (`Hit::rank`) or none.
    pub weights: Option<Vec<f64>>,
    /// Blocks the query opened whose maxima are above what every document there can score, for the commit
    /// queue to lower (`super::index::tighten`).
    pub tighten: Vec<Tighten>,
}

/// A term's block whose maxima a query found too high (`Found::tighten`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Tighten {
    pub scope: Scope,
    pub term: String,
    pub block: u64,
}

/// Which matches a walk takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Take {
    All,
    /// All but the tied ones (`Found::tied`).
    Untied,
    /// The tied ones only.
    Tied,
}

/// Where the carriers of the tags whose names each clause of a request's query matches are read from, and their
/// carriers summed: found by the request's first plan and reused by its later passes over the same clauses.
#[derive(Default)]
pub struct TagNames(std::cell::OnceCell<Vec<Option<Named>>>);

/// Where a clause's tag carriers are read from (`named`), whether every tag was found, and their carriers summed
/// (a clause over every field only).
#[derive(Clone)]
struct Named {
    source: Source,
    done: bool,
    count: u64,
}

/// Scopes' statistics, by scope, with the published version they were read at.
#[derive(Default)]
pub struct StatsCache(std::sync::Mutex<HashMap<Scope, (u64, Arc<Stats>)>>);

pub fn run(view: &View, q: &Query, cache: &StatsCache, names: &TagNames) -> StoreResult<Found> {
    match &q.order {
        Order::Relevance => ranked(view, q, cache, names),
        Order::Key(_) => run_taking(view, q, cache, Take::All, names),
    }
}

/// One walk of the query, taking `take`'s matches.
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
        Order::Relevance => plan.by_relevance(&mut ctx, q, Read::Chosen)?,
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

/// Tests: a relevance page of the matches that aren't tied, read by the walk in id order counting every match
/// (`Walk::counting`).
#[cfg(test)]
pub(super) fn run_counting(view: &View, q: &Query, cache: &StatsCache) -> StoreResult<Found> {
    run_read(view, q, cache, Read::Counting)
}

/// Tests: a relevance page of the matches that aren't tied, a single word read best first however much that
/// costs (under `Limits::ranked`).
#[cfg(test)]
pub(super) fn run_ranked(view: &View, q: &Query, cache: &StatsCache) -> StoreResult<Found> {
    run_read(view, q, cache, Read::Ranked)
}

/// Tests: a relevance page of the matches that aren't tied, read as `run` reads it.
#[cfg(test)]
pub(super) fn run_chosen(view: &View, q: &Query, cache: &StatsCache) -> StoreResult<Found> {
    run_read(view, q, cache, Read::Chosen)
}

#[cfg(test)]
fn run_read(view: &View, q: &Query, cache: &StatsCache, read: Read) -> StoreResult<Found> {
    let mut ctx = Ctx::new(view, Some(cache));
    let mut plan = Plan::new(&mut ctx, q, Take::Untied, &TagNames::default())?;
    let found = plan.by_relevance(&mut ctx, q, read)?;
    Ok(Found {
        work: ctx.work,
        gets: ctx.gets,
        steps: ctx.steps,
        checked: ctx.checked,
        ..found
    })
}

/// Relevance order, the tied documents in id order after every match scoring at least theirs. A page's `after`
/// at their score is a tied document.
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

/// Up to `most` tied documents (`Found::tied`) from `from` on, in id order, and whether that is every one.
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

/// The tied documents (`Found::tied`), and whether that is exact: counted when their clauses' tags have few
/// carriers or filters narrow them (an estimate past `TIED_COUNT_WORK`), else estimated from the counts.
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

/// Up to `most` documents matching the query (those `take` takes), in id order, unscored; None when more match or
/// the work limit cut the walk short.
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

/// Every document matching `q`, in id order, until the walk's work passes `budget`: the documents, whether the
/// walk finished, and the work it did.
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

/// Whether documents match a query's clauses and filters (those `take` takes), one document at a time in any
/// order: for walking another structure's order and checking each document.
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

    /// Every tag a tag-restricted clause or a clause's tag names match was found (else its matches are some of
    /// them).
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

    /// Work done so far, in `Ctx` units.
    pub fn work(&self) -> u64 {
        self.ctx.work
    }
}

// ---- reading ----

pub(crate) struct Ctx<'a> {
    view: &'a View<'a>,
    /// Statistics kept between queries; none for a slice of a pass.
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
    /// Fields' shortest lengths per block, as read.
    shortest: HashMap<(Scope, u32, u64), Option<u64>>,
    /// Scopes' highest documents, as read.
    max_docs: HashMap<Scope, u64>,
    /// Block maps read by point reads in this query, and their pairs together.
    maps: HashMap<Vec<u8>, Arc<Vec<(u32, u32)>>>,
    map_pairs: usize,
    /// Terms' counts (`term_counts`) read in this query.
    term_counts: HashMap<Vec<u8>, Vec<(u32, u64)>>,
    /// The last document's length codes read.
    codes: Option<(Scope, u64, [u8; 1 << FIELD_BITS])>,
    /// The query's `Filter::Check`s, begun.
    checks: Vec<CheckFn<'a>>,
    /// Pair postings are on and built (read at first need).
    pairs_built: Option<bool>,
    /// Work under one entry not yet counted in `work`, in thousandths.
    milli: u64,
    /// Blocks found with maxima too high (`Found::tighten`).
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

    /// `scan` from the last key down.
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

    /// The last block map under `prefix`: its block and pairs.
    fn last_map(&mut self, prefix: &[u8]) -> StoreResult<Option<BlockMap>> {
        let Some((k, v)) = self.scan_rev(prefix, &key::prefix_end(prefix), 1)?.pop() else {
            return Ok(None);
        };
        let mut at = prefix.len();
        let block = u64_at(&k, &mut at)?;
        Ok(Some((block, self.pairs(&k, v)?)))
    }

    /// Counts `m` thousandths of an entry of work.
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

    /// A counter (0 when it has none; a value that doesn't decode is an error).
    fn counter(&mut self, k: &[u8]) -> StoreResult<u64> {
        match self.get(k)? {
            Some(b) => Ok(counter_value(&b)
                .ok_or_else(|| StoreError::Entry("a search counter doesn't decode".into()))?
                .max(0) as u64),
            None => Ok(0),
        }
    }

    /// A term's counts (`term_counts`), read once per query.
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

    /// One of a term's counts (0 when it has none).
    fn term_count(&mut self, scope: Scope, term: &str, slot: u32) -> StoreResult<u64> {
        Ok(count_at(self.term_counts(scope, term)?, slot))
    }

    /// Documents holding the term in any field.
    fn term_docs(&mut self, scope: Scope, term: &str) -> StoreResult<u64> {
        self.term_count(scope, term, DOCS_SLOT)
    }

    /// A block map's pairs, from its settled value (decoded unless the read kept them).
    fn pairs(&mut self, key: &[u8], v: Val) -> StoreResult<Vec<(u32, u32)>> {
        let p = v
            .into_pairs(key)
            .ok_or_else(|| StoreError::Entry("a search block doesn't decode".into()))?;
        self.pairs += p.len() as u64;
        self.work += p.len() as u64 / PAIRS;
        Ok(p)
    }

    /// The block map at `k` (empty when it has none), read once per query.
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

    /// `map` for a maxima map, counted in `max_reads` when read.
    fn max_map(&mut self, k: Vec<u8>) -> StoreResult<Arc<Vec<(u32, u32)>>> {
        if !self.maps.contains_key(&k) {
            self.max_reads += 1;
        }
        self.map(k)
    }

    /// Keeps a block map read for the rest of the query.
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

/// A block map's block and pairs.
type BlockMap = (u64, Vec<(u32, u32)>);

fn successor(k: &[u8]) -> Vec<u8> {
    let mut s = k.to_vec();
    s.push(0);
    s
}

/// The entries of a key range in pages, positioned at one entry; a seek inside the page read last costs nothing.
struct Cursor {
    end: Vec<u8>,
    /// Where the page read last starts from.
    from: Vec<u8>,
    page: Vec<(Vec<u8>, Val)>,
    pos: usize,
    /// The page reaches the range's end.
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

    /// To the first entry at or after `k`.
    fn seek(&mut self, ctx: &mut Ctx, k: &[u8]) -> StoreResult<()> {
        if self.covers(k) {
            self.pos = self.page.partition_point(|(e, _)| e.as_slice() < k);
            return Ok(());
        }
        // Onward from a page read mostly through, as a merge in id order goes: read more at a time; onward past
        // most of it, as sparse lookups go: less.
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

    /// Whether the page read last holds `k`'s place.
    fn covers(&self, k: &[u8]) -> bool {
        !self.from.is_empty()
            && self.from.as_slice() <= k
            && (self.last || self.page.last().is_some_and(|(l, _)| k <= l.as_slice()))
    }

    /// The value at the current entry, taken out of the page: for readers that read each entry once.
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

/// Documents, in order.
trait Docs {
    fn doc(&self) -> Option<u64>;
    /// To the first document at or after `d`.
    fn seek(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<()>;
}

/// Block maps under a prefix, each entry block → `slot` → value, read a document at a time: a term's postings
/// (`bits` = `BLOCK_BITS`) or the field lengths (`LENGTH_BITS`), slots being place and field.
struct BlockDocs {
    prefix: Vec<u8>,
    bits: u32,
    cur: Cursor,
    block: Option<u64>,
    pairs: Vec<(u32, u32)>,
    at: usize,
    doc: Option<u64>,
    /// The last document sought: every document from it on is `doc` or after it.
    sought: Option<u64>,
}

impl BlockDocs {
    fn new(prefix: Vec<u8>, bits: u32) -> BlockDocs {
        BlockDocs {
            cur: Cursor::new(&prefix),
            prefix,
            bits,
            block: None,
            pairs: Vec::new(),
            at: 0,
            doc: None,
            sought: None,
        }
    }

    /// Whether `d` is in the list, moving to it when that is forward.
    fn has(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<Option<bool>> {
        if self.doc == Some(d) {
            return Ok(Some(true));
        }
        match self.sought {
            Some(s) if s > d => return Ok(None),
            // Every document from `s` on is `doc` or after it.
            Some(_) if self.doc.is_none_or(|x| x > d) => return Ok(Some(false)),
            _ => {}
        }
        self.seek(ctx, d)?;
        Ok(Some(self.doc == Some(d)))
    }

    fn postings(scope: Scope, term: &str) -> BlockDocs {
        BlockDocs::new(postings(scope, term), BLOCK_BITS)
    }

    /// The list's first and last documents, read afresh (None when it has none): its first from the start, and the
    /// highest live posting of its last block, or that block's last id when none there is live.
    fn ends(&self, ctx: &mut Ctx) -> StoreResult<Option<(u64, u64)>> {
        let mut b = BlockDocs::new(self.prefix.clone(), self.bits);
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

    /// Stands past every document, so `has` looks each one up in its block (for reading out of id order).
    fn park(&mut self) {
        self.block = None;
        self.pairs.clear();
        self.doc = None;
        self.sought = Some(u64::MAX);
    }

    fn doc_of(&self, block: u64, slot: u32) -> u64 {
        block << self.bits | u64::from(slot >> FIELD_BITS)
    }

    /// The current document's (field, value) pairs.
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
        // Each entry's value is taken out of the page when read; a seek back reads it again.
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
        }
        Ok(())
    }

    /// From pair `at` on: the first document.
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

/// A tag's carriers in id order, read a member block (`key::MEMBER_BLOCK`) at a time from the blocks it has
/// carriers in; or a term's map (`key::TAG_CARRIERS`, the same encoding), each carrier with its count.
struct Members {
    prefix: Vec<u8>,
    cur: Cursor,
    /// Work a block decoded costs besides its entry, and per place in it, in thousandths of an entry.
    milli: (u64, u64),
    block: Option<u64>,
    /// The carriers' places in `block`, ascending, and their counts.
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

    /// The carriers of the tags whose light-mapped names hold a term (`store::carriers`), with how many of them
    /// each carries.
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
        // Read in place: a seek back to the block reads it from the page again.
        let decoded;
        let pairs: &[(u32, u32)] = match self.cur.get().map(|e| &e.1) {
            Some(Val::Map(p)) => p,
            Some(Val::Put(b)) => {
                decoded = crate::keyspace::val::map_pairs(b)
                    .ok_or_else(|| StoreError::Entry("a member block doesn't decode".into()))?;
                &decoded
            }
            // A term map's count is how many of the carrier's tags hold the term: past 32 bits it's a fault.
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

    /// From place `at` on: the first carrier.
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

    /// To the next carrier.
    fn step(&mut self, ctx: &mut Ctx) -> StoreResult<()> {
        self.at += 1;
        self.load(ctx)
    }

    /// The list's first and last carriers, read afresh (None when it has none): its first from the start, and the
    /// last carrier of its last block, or that block's last id when none is left there.
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

    /// The current carrier's count (1 for a tag's).
    fn count(&self) -> u32 {
        self.doc.map_or(0, |_| self.places[self.at].1)
    }
}

/// A member block's or a term map's carriers: places holding 0 (a carrier removed) left out.
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

/// Sorted ids held in memory, with a value each.
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

/// Members of any of several tags.
struct AnyOf(Vec<Members>);

impl AnyOf {
    /// Marks in `bits` the members in `[first, end)` (`first` the start of a run of `bits`' length), and leaves
    /// each tag at its first member at or after `end`.
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

/// A moving tag as a term's carriers read it (`store::carriers::Flight`).
#[derive(Clone)]
struct Mover {
    tag: u64,
    cursor: u64,
    /// The term's map counts the tag at its carriers below `cursor`; at or above it.
    below: bool,
    above: bool,
    /// The tag's indexed name holds the term.
    named: bool,
    /// Its target and mapped names hold the term: its carriers below the cursor, and at or above it, have their
    /// block maxima raised for the term.
    target_has: bool,
    mapped_has: bool,
}

impl Mover {
    /// Whether the term's map counts the tag at its carrier `d`.
    fn counted(&self, d: u64) -> bool {
        if d < self.cursor {
            self.below
        } else {
            self.above
        }
    }
}

/// The tags a term's carriers are read from besides its map: its settled heavy tags and its moving ones, each in
/// order.
#[derive(Clone)]
struct TermTags {
    kind: TermKind,
    term: String,
    heavy: Vec<u64>,
    moving: Vec<Mover>,
}

impl TermTags {
    /// Whether document `d`, which the term's map counts `counted` of its tags at and which carries `tags`, is
    /// a carrier of the term.
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

/// Where a clause's tag carriers are read from.
#[derive(Clone)]
enum Source {
    /// The carriers of these tags, in order.
    Tags(Vec<u64>),
    /// The carriers of the tags whose indexed names hold a term (`store::carriers`).
    Term(TermTags),
}

impl Source {
    /// The cursors a walk over the carriers reads.
    fn cursors(&self) -> usize {
        match self {
            Source::Tags(t) => t.len(),
            Source::Term(t) => 1 + t.heavy.len() + t.moving.len(),
        }
    }
}

/// A term's carriers in id order: a document carries the term when the term's map counts more of its tags than
/// the moving tags counted there, or it carries a heavy tag, or a moving tag whose indexed name holds the term.
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

    /// Whether `d`, where every cursor stands at or past it, is a carrier.
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
    /// `Carriers::mark`: each cursor walked through the range once, the map's counts less the moving tags
    /// counted there summed per place.
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
        // The map's places in the range, and their counts less the moving tags counted there.
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
        // Every cursor stands at or past `end`: the first carrier from there on.
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

/// A clause's tag carriers, as its source gives them.
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

    /// Marks in `bits` the carriers in `[first, end)` (`first` the start of a run of `bits`' length), and leaves
    /// the cursors at or after `end`.
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

/// Marks in `held` the documents of a postings block holding the term in a field of `mask`.
fn mark_held(mask: u64, pairs: &[(u32, u32)], held: &mut BlockBits) {
    for &(sl, _) in pairs {
        if mask >> (sl & ((1 << FIELD_BITS) - 1)) & 1 == 1 {
            let place = (sl >> FIELD_BITS) as usize;
            held[place >> 6] |= 1 << (place & 63);
        }
    }
}

/// A document's posting for a term, by field (looked up in its block).
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

/// A document's length codes, by field.
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

/// (field, tf, length code) by field.
type Tfs = Vec<(u32, u64, u8)>;

/// A bit per document of a postings block.
type BlockBits = [u64; 1 << (BLOCK_BITS - 6)];

/// A document's counts for a term in the fields of `mask` (as a prefix when `as_prefix`), with their length codes.
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

/// A field's shortest length in a block, if any document there has text in it.
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

/// The block of the scope's highest document, read once per query.
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

/// The shortest length in block `block` of each field of `mask`, as scoring takes it (0 where none has text).
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

/// The first block from `block` on where the term has a block maximum in its reading (`as_prefix`): the first
/// where a document holds it in that reading. None past the scope's highest document.
fn list_next_block(
    ctx: &mut Ctx,
    scope: Scope,
    term: &str,
    as_prefix: bool,
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
        // The group's map, or the next group's the term has.
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
            field.is_none() && prefix == as_prefix
        }) {
            return Ok(Some(unmax_slot(g, sl).0));
        }
        b = (g + 1) << GROUP_BITS;
    }
    Ok(None)
}

// ---- statistics ----

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

// ---- clauses ----

/// What a clause matched in a document: (field, part, tf, length code) in field then part order.
#[derive(Default, Clone)]
struct Matched {
    parts: Vec<(u32, usize, u64, u8)>,
}

/// A token in one field, or (`token` = `TAG_PART`) the clause's tag names.
#[derive(Clone)]
struct Part {
    token: usize,
}

const TAG_PART: usize = usize::MAX;

/// Per token, per field, a part of a clause's text score (`field_score`), or a bound on it.
type Texts = Vec<[f64; 1 << FIELD_BITS]>;

/// Adds a list's block bound, over every field, to its token's bounds. A word's two lists (a prefix longer than
/// the prefix terms) score in different fields, so the token's bound is their sum.
fn add_bound(texts: &mut Texts, token: usize, b: f64) {
    texts[token][0] += b;
}

/// A list a clause reads: a term's postings, in the fields `mask`, standing for token `token`; counted as a
/// prefix term in the prefix fields when `as_prefix`. A phrase's pair list (`pair`: two adjacent whole tokens'
/// pair postings) only says where the phrase may be: it has no block maxima and scores nothing.
struct List {
    term: String,
    pair: bool,
    mask: u64,
    token: usize,
    as_prefix: bool,
    dir: BlockDocs,
    /// The last node's bound (`Matcher::node_bound`): level, node, bound.
    bound: Option<(u64, u64, f64)>,
    /// The last block's shortest length per field, as scoring takes it (`Matcher::doc_ceiling`).
    shortest: Option<(u64, [f64; 1 << FIELD_BITS])>,
    /// The last `list_next_block` asked and answered: every block from the one asked to the answer has it.
    next: Option<(u64, Option<u64>)>,
}

fn fields_of(scope: Scope, m: u64) -> impl Iterator<Item = u32> {
    (0..scope.fields().len() as u32).filter(move |f| m >> f & 1 == 1)
}

/// Where a walk finds a tagged clause's documents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lead {
    /// In its text and among its tags' carriers.
    Both,
    Text,
    Carriers,
}

/// The carriers of a moving tag whose indexed name a clause matches that its move hasn't raised the clause's
/// block maxima for yet: below its cursor when its target name lacks the clause, at or above it when its mapped
/// name does (`store::carriers::move_step` raises a carrier for the target name as its cursor passes it).
struct Unraised {
    cursor: u64,
    below: bool,
    above: bool,
    members: Members,
}

impl Unraised {
    /// Whether one of these carriers is in `[lo, hi)`.
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

/// A library clause's tag names: the carriers of the tags whose names it matches, each scoring `boost` once (its
/// part `part`).
struct Tagged {
    boost: f64,
    part: usize,
    /// The block maxima of the clause's lists cover its tag part at the carriers with text (`super::local_r`),
    /// except at those in `unraised`. Not for a prefix past the prefix terms, whose carriers may hold it only in a
    /// field its prefix-term list doesn't count, nor for a phrase ending in a prefix, whose tag part may take the
    /// idf of that prefix, which has no list.
    covered: bool,
    unraised: Vec<Unraised>,
    source: Source,
    carriers: Carriers,
    /// The tags' carriers summed.
    count: u64,
    lead: Lead,
    /// A term's map block read last by `carries` when not walking: its member block and its carriers.
    map_block: Option<(u64, Vec<(u32, u32)>)>,
}

/// Cursors over a clause's carriers past which a walk that only scores carriers (`Lead::Text`) tells one by the
/// document's own tags, and takes every block to hold some, rather than walking them.
pub(crate) const TAGS_WALKED: usize = 8;

impl Tagged {
    /// Whether the walk reads the carriers in id order.
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
                // Only a moving tag can take back what the map counts.
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

    /// The first carrier at or after `d`.
    fn next(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<Option<u64>> {
        self.carriers.seek(ctx, d)?;
        Ok(self.carriers.doc())
    }

    /// Whether a carrier may be in `[lo, hi)`.
    fn any_in(&mut self, ctx: &mut Ctx, lo: u64, hi: u64) -> StoreResult<bool> {
        if !self.walks() {
            return Ok(true);
        }
        Ok(self.next(ctx, lo)?.is_some_and(|d| d < hi))
    }

    /// Whether a carrier whose block maxima lack the clause's tag part may be in `[lo, hi)`.
    fn unraised_in(&mut self, ctx: &mut Ctx, lo: u64, hi: u64) -> StoreResult<bool> {
        for u in &mut self.unraised {
            if u.any_in(ctx, lo, hi)? {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

/// Whether document `d` carries a tag `f` takes, reading its tags (`key::MEMBER_OF`) until one is.
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

/// One clause over one scope.
struct Matcher {
    scope: Scope,
    tokens: Vec<String>,
    /// The last token is a prefix.
    prefix: bool,
    phrase: bool,
    /// Fields it may match in.
    mask: u64,
    /// One list per token for a phrase's exact tokens; one (exact or prefix terms) or two (a prefix longer than
    /// the prefix terms) for a word.
    lists: Vec<List>,
    /// Parts by (token, field).
    parts: HashMap<(usize, u32), usize>,
    part: Vec<Part>,
    /// Per token, its idf.
    idf: Vec<f64>,
    doc: Option<u64>,
    /// Where the text lists stand together after `align` (None: past the end, or not aligned).
    text_doc: Option<u64>,
    tagged: Option<Tagged>,
}

impl Matcher {
    /// None when the clause has no tokens. `idfs`: its tokens' idfs, else read from their counts.
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
            doc: None,
            text_doc: None,
            tagged: None,
        };
        for (i, tok) in toks.iter().enumerate() {
            let is_prefix = prefix && i == last_i;
            let long = is_prefix && char_len(tok) > GRAM_MAX;
            let gram_term = first_chars(tok, GRAM_MAX).to_string();
            match idfs {
                Some(w) => m.idf.push(w[i]),
                None => {
                    // A prefix is counted by the term its prefix fields are read through.
                    let df = ctx.term_docs(scope, if is_prefix { &gram_term } else { tok })?;
                    m.idf.push(idf(df as f64, stats.n));
                }
            }
            for f in fields_of(scope, mask) {
                m.parts.insert((i, f), m.part.len());
                m.part.push(Part { token: i });
            }
            if phrase && is_prefix {
                // Checked on the text.
                continue;
            }
            let list = |term: &str, mask, as_prefix| List {
                term: term.to_string(),
                pair: false,
                mask,
                token: i,
                as_prefix,
                dir: BlockDocs::postings(scope, term),
                bound: None,
                shortest: None,
                next: None,
            };
            if !is_prefix {
                m.lists.push(list(tok, mask, false));
            } else if !long {
                // Prefix terms in the prefix fields, whole tokens elsewhere: one list.
                m.lists.push(list(tok, mask, true));
            } else {
                if mask & prefix_mask != 0 {
                    m.lists.push(list(&gram_term, mask & prefix_mask, true));
                }
                if mask & !prefix_mask != 0 {
                    m.lists.push(list(tok, mask & !prefix_mask, false));
                }
            }
        }
        // With pair postings, a phrase's candidates are where every pair of its adjacent whole tokens is: the
        // pairs' lists are walked with the words', so the walk goes from one document holding them all to the next.
        let whole = if prefix { last_i } else { last_i + 1 };
        if phrase && whole >= 2 && ctx.pairs_on()? {
            for i in 0..whole - 1 {
                let term = super::pairs::term(&toks[i], &toks[i + 1]);
                m.lists.push(List {
                    dir: BlockDocs::postings(scope, &term),
                    term,
                    pair: true,
                    mask,
                    token: usize::MAX,
                    as_prefix: false,
                    bound: None,
                    shortest: None,
                    next: None,
                });
            }
        }
        Ok(Some(m))
    }

    /// Whether the clause is one list (a word) and its documents are those with the word.
    fn single(&self) -> Option<usize> {
        (self.word() && self.tagged.as_ref().is_none_or(|t| t.lead == Lead::Text)).then_some(0)
    }

    /// Whether the clause is a word whose prefix is longer than the prefix terms (`super::word_text`).
    fn long_prefix(&self) -> bool {
        super::long_prefix(
            self.phrase,
            self.prefix,
            &self.tokens[self.tokens.len() - 1],
        )
    }

    /// Whether the clause's text is one list (a word).
    fn word(&self) -> bool {
        !self.phrase && self.lists.len() == 1
    }

    fn lead(&self) -> Lead {
        self.tagged.as_ref().map_or(Lead::Text, |t| t.lead)
    }

    /// Makes the clause match the tag carriers `source` gives too, `count` of them summed.
    fn tag(&mut self, ctx: &mut Ctx, source: Source, count: u64) -> StoreResult<()> {
        let part = self.part.len();
        self.part.push(Part { token: TAG_PART });
        if let Some(f) = super::tag_field(self.scope) {
            self.parts.insert((0, f), part);
        }
        let covered = !self.long_prefix() && !(self.phrase && self.prefix);
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
                // A phrase's tags, found by their indexed names: a moving one's carriers are raised where the name
                // its move holds them by holds every token whole.
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

    /// Scores from here on before the idf, a word's score being its idf times that: returns the idf.
    fn local_units(&mut self) -> f64 {
        let idf = std::mem::replace(&mut self.idf, vec![1.0]);
        let boost = self.combine(&self.no_text(), true);
        if let Some(t) = &mut self.tagged {
            t.boost = boost;
        }
        idf[0]
    }

    /// No text in any field.
    fn no_text(&self) -> Texts {
        vec![[0.0; 1 << FIELD_BITS]; self.tokens.len()]
    }

    /// The clause's score from its text's parts (`Texts`): each token's summed in field order, as `local` sums
    /// them; `tagged` when the document carries a tag whose name holds the clause. Higher parts give a score at
    /// least as high, so it bounds as it scores.
    fn combine(&self, texts: &Texts, tagged: bool) -> f64 {
        let long = self.long_prefix();
        let sums: Vec<f64> = texts
            .iter()
            .map(|fs| super::sum_parts(self.scope, (0..).zip(fs.iter().copied()), long))
            .collect();
        super::clause_score(&self.idf, &sums, tagged)
    }

    /// A phrase's last token, a prefix, has no list: in each field it scores below its weight times `K1 + 1`.
    fn prefix_bound(&self, texts: &mut Texts) {
        if self.phrase && self.prefix {
            let last = self.tokens.len() - 1;
            for f in fields_of(self.scope, self.mask) {
                texts[last][f as usize] =
                    self.scope.fields()[f as usize].weight * (super::K1 + 1.0);
            }
        }
    }

    /// The most a document in list `li`'s block `block` scores for its term in the list's reading, before the
    /// idf: the reading's block maximum (0 when there is none); for a clause in some fields, its maxima in the
    /// list's fields, summed as `sum_parts` sums them, and for several fields at most the maximum over every field.
    fn block_bound(&mut self, ctx: &mut Ctx, li: usize, block: u64) -> StoreResult<f64> {
        self.node_bound(ctx, li, 0, block)
    }

    /// `block_bound` for every block under node `node` of level `level`: the node's maximum in the list's
    /// reading. Not for node 0 of a level above 0, which holds no maximum.
    fn node_bound(&mut self, ctx: &mut Ctx, li: usize, level: u64, node: u64) -> StoreResult<f64> {
        debug_assert!(level == 0 || node != 0);
        if self.lists[li].pair {
            return Ok(0.0);
        }
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
            // Several fields' maxima may be different documents': the maximum over every field bounds their
            // sum too, as a sum over fewer non-negative parts in the same order is no higher.
            if self.mask.count_ones() > 1 {
                summed.min(at(sl))
            } else {
                summed
            }
        };
        self.lists[li].bound = Some((level, node, s));
        Ok(s)
    }

    /// The most a document in block `block` can score for the clause, without reading postings; None when no
    /// document there can match it (where the walk looks for it).
    fn bound_at(&mut self, ctx: &mut Ctx, block: u64) -> StoreResult<Option<f64>> {
        self.node_bound_at(ctx, 0, block, block)
    }

    /// `bound_at` for the blocks from `from` to the end of node `node` of level `level`, from the node's maxima.
    /// Not for node 0 of a level above 0.
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

    /// A covered clause's bound where its carriers may be (`Tagged::covered`): `text`, its text's bound, which holds
    /// the tag part already, or for a clause matching carriers without text (`Lead::Both`, `Lead::Carriers`) at least
    /// the tag part alone.
    fn covered_bound(&self, lead: Lead, text: Option<f64>) -> Option<f64> {
        let alone = (lead != Lead::Text).then(|| self.combine(&self.no_text(), true));
        match (text, alone) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        }
    }

    /// `node_bound_at` for the clause's text alone, per token and field: None when a word's terms, or one of a
    /// phrase's, have never been under the node.
    fn text_bound_at(
        &mut self,
        ctx: &mut Ctx,
        level: u64,
        node: u64,
    ) -> StoreResult<Option<Texts>> {
        let mut texts = self.no_text();
        let mut any = false;
        for li in 0..self.lists.len() {
            // A pair has no maxima; `next_block` found it in the block.
            if self.lists[li].pair {
                continue;
            }
            let b = self.node_bound(ctx, li, level, node)?;
            if b > 0.0 {
                any = true;
            } else if self.phrase {
                return Ok(None);
            }
            add_bound(&mut texts, self.lists[li].token, b);
        }
        if self.phrase && self.prefix {
            self.prefix_bound(&mut texts);
            any |= self.lists.is_empty();
        }
        Ok(any.then_some(texts))
    }

    /// The first block from `block` on where the walk may find the clause's documents; None past the last.
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

    /// The first block from `block` on where the clause's terms have been (a word's in any of its lists, a
    /// phrase's in all), from the terms' block maxima; None past the last.
    fn text_next_block(&mut self, ctx: &mut Ctx, block: u64) -> StoreResult<Option<u64>> {
        let mut b = block;
        loop {
            let mut found: Option<u64> = None;
            let mut agreed = true;
            for li in 0..self.lists.len() {
                let x = match self.lists[li].next {
                    Some((asked, answer)) if asked <= b && answer.is_none_or(|a| b <= a) => answer,
                    _ => {
                        let l = &mut self.lists[li];
                        // A pair's blocks are its postings' (it has no maxima).
                        let x = if l.pair {
                            l.dir.seek(ctx, b << BLOCK_BITS)?;
                            l.dir.block
                        } else {
                            list_next_block(ctx, self.scope, &l.term, l.as_prefix, b)?
                        };
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

    /// To the first document at or after `d` the clause may match where the walk looks for it.
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

    /// The first document at or after `d` the clause's text may match: in any of a word's lists, in all of a
    /// phrase's.
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

    /// The most any document from `d` to `block_end` can score.
    fn block_ceiling(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<f64> {
        let end = self.block_end();
        let mut carried = false;
        if let Some(t) = &mut self.tagged {
            carried = t.any_in(ctx, d, end)?;
        }
        let mut texts = self.no_text();
        for li in 0..self.lists.len() {
            if let Some(b) = self.lists[li].dir.block
                && !self.lists[li].pair
            {
                let b = self.block_bound(ctx, li, b)?;
                add_bound(&mut texts, self.lists[li].token, b);
            }
        }
        self.prefix_bound(&mut texts);
        if carried && let Some(t) = self.tagged.as_mut().filter(|t| t.covered) {
            let unraised = t.unraised_in(ctx, d, end)?;
            let text = self.combine(&texts, unraised);
            return Ok(self.covered_bound(self.lead(), Some(text)).unwrap_or(text));
        }
        Ok(self.combine(&texts, carried))
    }

    /// The most document `d` can score, from the counts of the lists standing at it, at their blocks' shortest
    /// lengths.
    fn doc_ceiling(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<f64> {
        let mut carried = false;
        if let Some(t) = &mut self.tagged {
            carried = t.carries(ctx, d)?;
        }
        let defs = self.scope.fields();
        let block = d >> BLOCK_BITS;
        let mut texts = self.no_text();
        for li in 0..self.lists.len() {
            if self.lists[li].dir.doc() != Some(d) || self.lists[li].pair {
                continue;
            }
            if self.lists[li].shortest.is_none_or(|(b, _)| b != block) {
                let lens = shortest_lens(ctx, self.scope, self.lists[li].mask, block)?;
                self.lists[li].shortest = Some((block, lens));
            }
            let l = &self.lists[li];
            let lens = l.shortest.unwrap().1;
            for (f, v) in l.dir.doc_pairs() {
                if l.mask >> f & 1 == 1 {
                    let tf = unpack(defs[f as usize].prefix, v).most();
                    let x = field_score(self.scope, f, tf as f64, lens[f as usize]);
                    let t = &mut texts[l.token][f as usize];
                    *t = t.max(x);
                }
            }
        }
        self.prefix_bound(&mut texts);
        Ok(self.combine(&texts, carried))
    }

    /// For a word: the documents of block `block` that hold it, and its tags' carriers there, as bits; its lists
    /// stand at the block.
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

    /// The clause's tags' carriers in block `block`, as bits (every document when it tells them by their own tags).
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

    /// For a word, after `block_held`: adds to `total` the most each document in `only` can score for it at
    /// the block's shortest lengths, with its tags to those in `carried`.
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

    /// `block_bounds` from each list's (mask, postings block, shortest lengths).
    fn bounds_of(
        &self,
        lists: &[(u64, &[(u32, u32)], [f64; 1 << FIELD_BITS])],
        only: &[u64],
        carried: &BlockBits,
        total: &mut [f64],
    ) {
        const TABLE: usize = 16;
        let defs = self.scope.fields();
        // Each field's part per document, by its slot: in field order per document, as `local` sums them.
        let mut parts: Vec<(u32, f64)> = Vec::new();
        for &(mask, pairs, lens) in lists {
            // Each field's score for the small counts, at the block's shortest length.
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
        // Each document's parts summed as `super::sum_parts` sums them.
        let long = self.long_prefix();
        let mut texts = [0.0f64; 1 << BLOCK_BITS];
        let mut prefixed = [0.0f64; 1 << BLOCK_BITS];
        for (sl, x) in parts {
            let i = (sl >> FIELD_BITS) as usize;
            if long && defs[(sl & ((1 << FIELD_BITS) - 1)) as usize].prefix {
                prefixed[i] += x;
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
                total[i] += super::clause_score(&self.idf, &[texts[i]], carries);
            }
        }
    }

    /// Reports list `li`'s block `block` (`Found::tighten`) when a maximum there that the list read is above
    /// every document's value: its postings there (`pairs`, every document holding its term), with its clause's
    /// tag carriers there (`carried`) for its maximum over every field. A document's value is its exact score when
    /// `scored` holds its length codes (the query scored it), else its bound at the block's shortest lengths
    /// (`shortest`), which stay as short as a gone document left them. That maximum covers every field, so only a
    /// list over every field checks it.
    /// Compared as stored (`max_bits`): a maximum the job set from a document's own lengths isn't reported again.
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
        if l.pair {
            return Ok(());
        }
        let (scope, r) = (self.scope, l.as_prefix);
        let defs = scope.fields();
        let all = l.mask == self.mask_all();
        let first = block << BLOCK_BITS;
        let holds = |&&(sl, v): &&(u32, u32)| {
            let f = sl & ((1 << FIELD_BITS) - 1);
            v != 0 && l.mask >> f & 1 == 1 && unpack(defs[f as usize].prefix, v).tf(r) > 0
        };
        // Per document, its value over every field (in field order, as `super::local` sums), and per field the
        // highest part.
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
        // Only from a map the query read already.
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

    /// The first id past the current blocks of the lists.
    fn block_end(&self) -> u64 {
        self.lists
            .iter()
            .filter_map(|l| l.dir.block)
            .map(|b| (b + 1) << BLOCK_BITS)
            .min()
            .unwrap_or(u64::MAX)
    }

    /// Whether the clause matches `doc`, and whether by text (else by tag names alone), as `check` decides: a word
    /// from its list's counts where the list stands at `doc`, no lengths read; anything else by `check`.
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

    /// What the clause matched at `doc` (reading postings, and text where it must), or None.
    fn check(&mut self, ctx: &mut Ctx, doc: u64) -> StoreResult<Option<Matched>> {
        let scope = self.scope;
        let mut out = Matched::default();
        let mut hit = false;
        // Each list's counts for the document, from where it stands (looked up when not at it).
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
                // Behind the list: looked up.
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
        let last = self.tokens.len() - 1;
        let long = self.long_prefix();
        if !self.phrase {
            for (_, li, p) in &data {
                let is_gram_long = long && self.lists[*li].as_prefix;
                for &(f, tf, code) in p.iter() {
                    let mut tf = tf;
                    if is_gram_long {
                        // The prefix terms hold its first characters: count the whole prefix on the text.
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
            // Fields holding every exact token.
            let common = data
                .iter()
                .map(|(_, _, p)| p.iter().fold(0u64, |m, x| m | 1 << x.0))
                .fold(u64::MAX, |a, b| a & b);
            // Each exact token's (field, tf, length code).
            let mut tok: HashMap<usize, Tfs> = HashMap::new();
            for (t, _, p) in &data {
                tok.insert(*t, p.clone());
            }
            // With pair postings, `common` holds only fields holding every pair of whole tokens (their lists are
            // among the clause's); two whole tokens are decided by their pair.
            let whole = if self.prefix { last } else { last + 1 };
            let paired = self.lists.iter().any(|l| l.pair);
            for f in fields_of(scope, common & self.mask) {
                let prefix_field = scope.fields()[f as usize].prefix;
                let mut last_tf = 0;
                let mut found = paired && whole == self.tokens.len() && whole == 2;
                for t in if found {
                    Vec::new()
                } else {
                    ctx.texts(scope, doc, f)?
                } {
                    // The prefix token scores as a prefix term in a prefix field, as a whole token elsewhere.
                    let (here, n) = phrase_in(&t, &self.tokens, self.prefix, prefix_field);
                    found |= here;
                    last_tf += n;
                }
                if !found {
                    continue;
                }
                hit = true;
                let code = tok
                    .values()
                    .flat_map(|p| p.iter())
                    .find(|x| x.0 == f)
                    .map_or(0, |x| x.2);
                for i in 0..=last {
                    let Some(&p) = self.parts.get(&(i, f)) else {
                        continue;
                    };
                    let tf = if i == last && self.prefix {
                        last_tf
                    } else {
                        tok.get(&i)
                            .and_then(|p| p.iter().find(|x| x.0 == f))
                            .map_or(0, |x| x.1)
                    };
                    if tf > 0 {
                        out.parts.push((f, p, tf, code));
                    }
                }
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
        let texts: Vec<f64> = (0..self.tokens.len())
            .map(|i| {
                let fields = m
                    .parts
                    .iter()
                    .filter(|x| self.part[x.1].token == i)
                    .map(|&(f, _, tf, code)| (f, tf, code_length(code)));
                super::word_text(self.scope, fields, self.long_prefix())
            })
            .collect();
        let tagged = m.parts.iter().any(|x| self.part[x.1].token == TAG_PART);
        super::clause_score(&self.idf, &texts, tagged)
    }
}

// ---- the query ----

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
    /// Better first: higher score, then lower id.
    fn cmp(&self, o: &Self) -> Ordering {
        o.0.total_cmp(&self.0).then(self.1.cmp(&o.1))
    }
}

/// The best `cap` hits seen.
struct Best {
    cap: usize,
    set: BTreeSet<Ranked>,
}

impl Best {
    /// The hit a new one has to beat once the set is full.
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

/// (clause, list, its postings in the block, the block's shortest lengths in the list's fields).
type OpenedList = (usize, usize, Vec<(u32, u32)>, [f64; 1 << FIELD_BITS]);

/// A block the walk opened (`Plan::next_match`): each positive word's lists there (clause, list, postings, the
/// block's shortest lengths in the list's fields), each clause's tag carriers there, and the length codes of the
/// documents it scored there.
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
    /// Each of `pos`'s clause index.
    pos_at: Vec<usize>,
    neg: Vec<Matcher>,
    include: Vec<Filtered>,
    /// Each of `include`'s place in the query (its clause's index, or past the clauses its filter's), and the
    /// counters its count sums (none for ids, which are counted as listed).
    include_of: Vec<(usize, Vec<Vec<u8>>)>,
    /// Each include's count, once read (`Plan::include_counts`).
    counts: Option<Vec<u64>>,
    exclude: Vec<Filtered>,
    /// Every document with text, when nothing else leads.
    all: Option<BlockDocs>,
    /// The last block the walk bounded before reading its postings, and its bound (None: no match there).
    shallow: Option<(u64, Option<f64>)>,
    /// The last block's documents that could beat the page (`next_match`), and those every clause holds that
    /// couldn't.
    cands: Option<(u64, Vec<u64>, Vec<u64>)>,
    /// The block those are of, until the walk moves on (`Plan::report_opened`).
    opened: Option<Opened>,
    /// Every tag a tag-restricted clause, or a clause's tag names, match was found (else the work limit cut that
    /// short).
    complete: bool,
    take: Take,
    /// Every positive clause matches tag names: some documents may be tied.
    ties: bool,
    /// A score over its rank (`Hit::rank`): one positive word's idf, as it ranks by its score before it; else 1.
    scale: f64,
}

/// What a walk in id order passed over: documents or blocks that couldn't beat the page, and how many
/// candidates it checked.
#[derive(Default)]
struct Walk {
    skipped: bool,
    checked: u64,
    /// Id ranges `[from, to)` passed over only because nothing in them could beat the page, in order.
    floored: Vec<(u64, u64)>,
    /// Documents every clause holds that a block's bounds passed over, outside `floored`, in order. The includes
    /// were not sought at them.
    dropped: Vec<u64>,
    /// Documents every clause and include stands at that their ceiling passed over.
    passed: u64,
    /// Every match is counted, however low it scores: the page's floor passes over no block or document, and only
    /// spares the scoring of a match that can't beat it, which `counted` counts.
    counting: bool,
    counted: u64,
}

/// How `Plan::by_relevance` reads a page.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Read {
    /// A single word with an include is read best first until that costs about what the walk led by the rarer of
    /// them would, then by the counting walk; anything else as `Ranked` reads it.
    Chosen,
    /// Tests: a single word best first, under `Limits::ranked`; anything else by the walk in id order.
    #[cfg(test)]
    Ranked,
    /// By the counting walk (`Walk::counting`).
    Counting,
}

/// The input a walk's total is estimated by (`Plan::estimate_walked`): a positive single word, by its index in
/// `pos`, or an include, by its index in `include`.
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
        // The last word is a prefix unless its clause is a closed-quote phrase.
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
        // The tokens of each positive clause that scores; one word ranks without idfs (`Hit::rank`).
        let scored: Vec<usize> = q
            .clauses
            .iter()
            .filter(|c| !c.negate && !tags_only(tags_field, c))
            .map(|c| tokens(&c.text).len())
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
            // A clause restricted to the tags field: the cards carrying a tag whose name it matches.
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
                    // As `named` counts them.
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
                    let (these, rest) = w.split_at(toks.len());
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
                // A clause over every field matches tag names too.
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

    /// The idfs the plan ranks by (`Found::weights`).
    fn weights(&self) -> Option<Vec<f64>> {
        match self.pos.as_slice() {
            [] => None,
            [m] if m.tokens.len() == 1 => None,
            pos => Some(pos.iter().flat_map(|m| m.idf.iter().copied()).collect()),
        }
    }

    /// The score of the tied documents, when there may be some.
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

    /// Whether the walk takes a match of these clauses.
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

    /// Whether the walk takes only matches with text in some clause, and some clause matches tag names.
    fn needs_text(&self) -> bool {
        self.take == Take::Untied && self.ties
    }

    /// An estimate of the tied documents from the counts, when nothing but the clauses narrows them and each
    /// clause's tags have more than `TIED_COUNTED` carriers: the fewest carriers, less the share of documents
    /// each word's text holds.
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

    /// Whether `d`, where the walk's clauses and includes stand, is a match it takes, read without scoring it
    /// (`Walk::counting`).
    fn counts(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<bool> {
        // Whether every clause matches only by tag names.
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

    /// Whether `d` passes the filters and negated clauses.
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
        // An empty sum is -0.0, which orders below the 0.0 a page's `after` comes back as.
        self.pos
            .iter()
            .zip(matched)
            .map(|(m, x)| m.score(x))
            .sum::<f64>()
            + 0.0
    }

    /// Reports the lists of the block the walk opened last (`Matcher::report_loose`), once it moves on.
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

    /// The last block the walk may pass over from block `block`, which can't beat the page: the last of the highest
    /// node over it from which no block can beat `floor` either, by the nodes' maxima; `block` with no floor.
    /// Each node passed by its bound rather than for holding no match is added to `walk.floored`.
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
            // Node 0 holds no maximum, nor does any above it.
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
            // The counting walk passes only nodes where no clause can match.
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

    /// In id order: the first match at or after `d` (and before `end`). With `floor`, documents and blocks that
    /// can't beat it are passed over without reading postings; `skipped` says whether any was.
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
            // A block where some clause can't match, or none can beat the page, is passed over before its
            // postings are read.
            if !self.pos.is_empty()
                && self.all.is_none()
                && self.shallow.is_none_or(|(b, _)| b != d >> BLOCK_BITS)
            {
                // The first block from `d`'s where every clause's terms have been.
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
                        // Some clause's text is in the block.
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
                // With a page to beat and only words, the block's documents that every word holds and whose
                // counts at the block's shortest lengths could beat it; the rest are passed over.
                if let Some(f) = floor
                    && !walk.counting
                    && self.pos.iter().all(|m| !m.phrase)
                {
                    if self.cands.as_ref().is_none_or(|c| c.0 != block) {
                        // The documents every clause may match, then their bounds.
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
                                for (li, l) in m.lists.iter().enumerate().filter(|x| !x.1.pair) {
                                    match l.shortest {
                                        Some((b, lens)) if l.dir.block == Some(block) && b == block => {
                                            opened.lists.push((ci, li, l.dir.pairs.clone(), lens))
                                        }
                                        // No document holds the term there.
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
                // To the first document from `d` where some clause's text may be.
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
            // Align every positive source on one document.
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

    /// Whether `d` matches, from any position.
    fn matches(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<bool> {
        Ok(matches!(
            self.next_match(ctx, d, d + 1, u64::MAX, None, &mut Walk::default())?,
            Step::Match(..)
        ))
    }

    /// An estimate of the descent's total from `counted` matches among the word's `checked` documents: its
    /// documents at that rate.
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

    /// Each include's count: ids as listed, carriers by their stored counts, read once per query.
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

    /// The input with the fewest entries by its stored count, and that count: a positive single word or an
    /// include. On a tie ids lead, as their count is exact, then the first in the query.
    fn leading(&mut self, ctx: &mut Ctx) -> StoreResult<Option<(Leading, u64)>> {
        // (count, not ids, place in the query)
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

    /// A leading tag or word list's lowest and highest ids (None when it has none): over every cursor of a lead
    /// read from several lists.
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

    /// An estimate of a walk's total from the `counted` matches it found, ending or stopping at `stopped`: the
    /// leading input's count (`leading`) at the rate its candidates the walk checked matched. A candidate is checked
    /// when the walk counted it or ruled it out; one passed over only for not beating the page (`Walk`) is not.
    /// Ids are counted where the walk stood; a tag's or word's candidates up to there are taken as an even share of
    /// the ids its list spans, and so are those among the documents `Walk::dropped` holds for a tag. With neither a
    /// single word nor an include, by the share of the ids passed.
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
        // Every match counted was checked.
        let checked = checked.max(counted as f64);
        let e = (c as f64 * counted as f64 / checked).round() as u64;
        Ok(e.min(c).max(counted))
    }

    /// An estimate of the total from the matches counted up to `from`, by the share of the ids they cover.
    fn estimate(&mut self, ctx: &mut Ctx, counted: u64, from: u64) -> StoreResult<u64> {
        let top = ctx
            .get(&max_doc(self.scope))?
            .and_then(|b| parse_varint(&b))
            .unwrap_or(0)
            .max(from);
        let share = (from as f64 + 1.0) / (top as f64 + 1.0);
        Ok(((counted as f64 / share).round() as u64).max(counted))
    }

    /// One word, best first (`Matcher::single`): from the top of its block maxima, the node or block whose bound
    /// ranks best is taken next, a node giving way to its children and a block read, until none can beat the
    /// page. A node's bound ranks as its first document's would: every document under it ranks at most so.
    /// Returns the matches counted and whether it finished before `budget`; `walk` says whether it passed over
    /// any document by a bound and how many it checked.
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
        // (level, node) by bound, then first document.
        let mut heap: BinaryHeap<Reverse<(Ranked, u64, u64)>> = BinaryHeap::new();
        // The nodes of a maxima map in the word's reading whose bound can beat the page, onto the heap.
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
                // Node 0 above level 0 is held by the group-0 maps below it.
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
            // A block: each document's bound at the block's shortest lengths, then the exact score of those that
            // can beat the page.
            let block = node;
            ctx.posting_blocks += 1;
            let pairs = ctx.map(posting_block(scope, &term, block))?;
            let mut held = [0u64; 1 << (BLOCK_BITS - 6)];
            mark_held(mask, &pairs, &mut held);
            let lens = shortest_lens(ctx, scope, mask, block)?;
            let carried = self.pos[0].carried_in(ctx, block)?;
            // The length codes of the documents scored here.
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

    /// A prefix word over every field with at most this many documents has each of them checked, whatever the
    /// filters, so its total is exact. 128 is the size of the per-word lists this replaced, so totals stay exact
    /// for the same words.
    const CHECKED_WHOLE: u64 = 128;

    fn by_relevance(&mut self, ctx: &mut Ctx, q: &Query, read: Read) -> StoreResult<Found> {
        let after = match &q.after {
            Some(After::Score(s, d)) => Some(Ranked(*s, *d)),
            _ => None,
        };
        let mut best = Best {
            cap: q.limit + 1,
            set: BTreeSet::new(),
        };
        // A prefix word over every field: its documents are those its count counts. With few of them, every
        // one is checked, so the total is exact whatever the filters; with more, the count is the total when
        // nothing filters.
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
        let (mut total, mut d, mut stopped) = (0u64, 0u64, None);
        let mut counting = read == Read::Counting;
        if !counting && !whole && self.pos.len() == 1 && self.pos[0].single().is_some() {
            // With an include, the descent gets about the work of the walk led by the rarer of it and the word;
            // past that, the counting walk reads the page instead.
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
                    // Out of id order: no share of the ids passed to estimate by.
                    total = self.estimate_descended(ctx, total, walk.checked)?;
                }
                return Ok(page_of(best, q.limit, total, total_exact, done, self.scale));
            }
            best.set.clear();
            counting = true;
        }
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
        let page_exact = stopped.is_none();
        let mut total_exact = page_exact && !walk.skipped;
        if let Some(n) = docs
            && !filtered
        {
            (total, total_exact) = (n, true);
        }
        if !total_exact {
            total = self.estimate_walked(ctx, total, &walk, stopped)?;
        }
        Ok(page_of(best, q.limit, total, total_exact, page_exact, self.scale))
    }

    fn by_key(&mut self, ctx: &mut Ctx, q: &Query, order: &dyn SortKey) -> StoreResult<Found> {
        let after = match &q.after {
            Some(After::Key(k, d)) => Some((k.clone(), *d)),
            _ => None,
        };
        // Sorting the matches costs a key read each; walking the order costs about one check per
        // documents / matches entries walked per hit. A single word's count says which is cheaper up front.
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
    /// Every field the clause could match in, unrestricted.
    fn mask_all(&self) -> u64 {
        (1 << self.scope.fields().len()) - 1
    }
}

/// The count at `slot` of a map's counts (sorted by slot; 0 when it has none).
pub fn count_at(counts: &[(u32, u64)], slot: u32) -> u64 {
    counts
        .binary_search_by_key(&slot, |x| x.0)
        .map_or(0, |i| counts[i].1)
}

/// The library field holding a card's own tags, which a clause restricts itself to for tag membership.
/// Whether a clause is restricted to the tags field (`tags_field`), with a word: it matches the cards carrying a tag
/// whose name it matches, and doesn't score.
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

/// Where the carriers of the tags whose names match a clause's tokens are read from (`last`: the query's last
/// clause, its last token a prefix), and whether every tag was found before the work passed `until`; with
/// `counted`, their carriers summed (else 0).
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

/// The term the carrier maps (`store::carriers`) hold a clause's tags by: its one token, as a prefix term when
/// it is the query's last word and has `GRAM_MIN` to `GRAM_MAX` characters, whole when it isn't a prefix. None
/// for a longer prefix or a phrase, whose tags are found by their names (`named_tags`).
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

/// A term's heavy and moving tags (`store::carriers`), and whether every one was read before the work passed
/// `until`.
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
            // Until the indexed name or the band changes, the move's target name is the indexed name.
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

/// Each tag keyed under `prefix` in order, until the work passes `until` (then `done` is cleared).
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

/// The tags whose names match a clause's tokens (`last`: the query's last clause, its last token a prefix),
/// and whether every one was found before the work passed `until`.
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

/// Whether a term's list can hold documents that have it only as a prefix term (in a prefix field).
fn gram_shared(scope: Scope, term: &str) -> bool {
    char_len(term) >= GRAM_MIN && scope.fields().iter().any(|d| d.prefix)
}

/// `scale`: a hit's score over its rank (`Plan::scale`).
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
