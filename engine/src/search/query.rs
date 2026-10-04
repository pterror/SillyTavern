//! Reading the index: a query is clauses (words or phrases, each over some fields, maybe negated) and filters,
//! answered as a page in relevance (BM25) or sort-key order, with a total.
//!
//! Matching: every positive clause and filter must match, no negated one. A clause of one token is a word; one
//! of several tokens (quoted, or split by the tokenizer, as `foo-bar`) is a phrase: its tokens adjacent and in
//! order within one value of one field. The query's last token is a prefix (from 2 characters): for a word in
//! the prefix fields only, an exact token elsewhere; for a phrase in every field. A phrase is found through its
//! exact tokens' directories, then checked on the candidates' text. The joined field (the library's tag names)
//! matches through the tags whose names match, each adding its own score to its members.
//!
//! One word in relevance order reads its postings best first and stops once no later class can beat the page:
//! a page costs about its own postings. Anything else walks the clauses' directories in id order, skipping
//! blocks whose bounds can't beat the page, reading a posting only for a document that can. In sort-key order
//! a word with few documents is read whole and sorted by key; otherwise the order is walked and each document
//! checked, whichever the counts say is cheaper.
//!
//! Work is counted in entries read (a scan's start counts `SEEK` entries, a decoded pair 1 / `PAIRS`, a text
//! read `TEXT` plus its bytes / 32), each about 0.16 µs at 10^6 documents. Past a limit the page is marked
//! inexact; totals are exact where the counts give them or the walk finished, estimates otherwise.

use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use super::text::{GRAM_MAX, GRAM_MIN, char_len, first_chars, phrase_in, tokens};
use super::{
    BLOCK_BITS, CLASSES, FieldHit, GROUPS, LENGTH_BITS, Scope, TermKind, class_bound, code_length,
    directory, directory_block, doc_count, doc_freqs, field_tokens, idf, in_block, lengths,
    max_doc, parse_varint, posting_block, postings, postings_group, term_docs, tf_norm, unpack,
    unslot,
};
use crate::keyspace::val::{counter_value, get_u64, map_pairs, put_u64};
use crate::store::derive::View;
use crate::store::kinds::{key, search_texts};
use crate::store::{StoreError, StoreResult};

/// Carriers of the matching tags up to which a word's query lists them all.
const MEMBERS_LISTED: u64 = 65536;

/// Work a scan's start costs, in entries.
pub const SEEK: u64 = 96;
/// Pairs decoded per entry of work.
pub const PAIRS: u64 = 8;
/// Work a text read costs besides its bytes / 32.
pub const TEXT: u64 = 128;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Walking directories in id order (and counting).
    pub enumerate: u64,
    /// Reading one word's postings best first.
    pub ranked: u64,
    /// Walking a sort order checking documents.
    pub walked: u64,
    /// Reading the tags the clauses match through the joined field, and their members, all together.
    pub joined: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            enumerate: 250_000,
            ranked: 100_000,
            walked: 100_000,
            joined: 60_000,
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
    pub quoted: bool,
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
    pub limits: Limits,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub doc: u64,
    /// 0 in sort-key order.
    pub score: f64,
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
    /// Time reading statistics and joins before matching.
    pub plan_micros: u64,
}

/// Scopes' statistics, by scope, with the published version they were read at.
#[derive(Default)]
pub struct StatsCache(std::sync::Mutex<HashMap<Scope, (u64, Arc<Stats>)>>);

pub fn run(view: &View, q: &Query, cache: &StatsCache) -> StoreResult<Found> {
    let mut ctx = Ctx {
        view,
        cache,
        work: 0,
        scans: 0,
        entries: 0,
        pairs: 0,
        gets: 0,
        texts: 0,
        maps: HashMap::new(),
    };
    let started = std::time::Instant::now();
    let mut plan = Plan::new(&mut ctx, q)?;
    let plan_micros = started.elapsed().as_micros() as u64;
    let mut found = match &q.order {
        Order::Relevance => plan.by_relevance(&mut ctx, q)?,
        Order::Key(k) => plan.by_key(&mut ctx, q, k.as_ref())?,
    };
    found.work = ctx.work;
    found.scans = ctx.scans;
    found.entries = ctx.entries;
    found.pairs = ctx.pairs;
    found.gets = ctx.gets;
    found.texts = ctx.texts;
    found.plan_micros = plan_micros;
    Ok(found)
}

// ---- reading ----

pub(crate) struct Ctx<'a> {
    view: &'a View<'a>,
    cache: &'a StatsCache,
    work: u64,
    scans: u64,
    entries: u64,
    pairs: u64,
    gets: u64,
    texts: u64,
    /// Block maps read by point reads in this query.
    maps: HashMap<Vec<u8>, Arc<Vec<(u32, u32)>>>,
}

impl Ctx<'_> {
    fn scan(
        &mut self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> StoreResult<Vec<(Vec<u8>, Vec<u8>)>> {
        let page = self.view.scan(start, end, limit)?;
        self.work += SEEK + page.len() as u64;
        self.scans += 1;
        self.entries += page.len() as u64;
        Ok(page)
    }

    fn get(&mut self, k: &[u8]) -> StoreResult<Option<Vec<u8>>> {
        self.work += SEEK;
        self.gets += 1;
        self.view.get(k)
    }

    /// A counter (0 when it has none).
    fn counter(&mut self, k: &[u8]) -> StoreResult<u64> {
        Ok(self
            .get(k)?
            .and_then(|b| counter_value(&b))
            .unwrap_or(0)
            .max(0) as u64)
    }

    /// The counters under `prefix`, by the key's next component.
    fn counters_under(&mut self, prefix: &[u8]) -> StoreResult<HashMap<u64, u64>> {
        let mut out = HashMap::new();
        for (k, v) in self.scan(prefix, &key::prefix_end(prefix), 64)? {
            let mut at = prefix.len();
            out.insert(
                u64_at(&k, &mut at)?,
                counter_value(&v).unwrap_or(0).max(0) as u64,
            );
        }
        Ok(out)
    }

    /// A block map's pairs.
    fn pairs(&mut self, b: &[u8]) -> StoreResult<Vec<(u32, u32)>> {
        let p = map_pairs(b)
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
        let m = Arc::new(match self.get(&k)? {
            Some(b) => self.pairs(&b)?,
            None => Vec::new(),
        });
        if self.maps.len() > 4096 {
            self.maps.clear();
        }
        self.maps.insert(k, m.clone());
        Ok(m)
    }

    fn texts(&mut self, scope: Scope, doc: u64, field: u32) -> StoreResult<Vec<Vec<u8>>> {
        let t = search_texts(self.view, scope, doc, field)?;
        self.texts += 1;
        self.work += TEXT + t.iter().map(|x| x.len() as u64).sum::<u64>() / 32;
        Ok(t)
    }
}

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
    page: Vec<(Vec<u8>, Vec<u8>)>,
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

    fn get(&self) -> Option<&(Vec<u8>, Vec<u8>)> {
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

/// Block maps under a prefix, each entry block → `slot` → value, read a document at a time: a term's
/// directory (`bits` = `BLOCK_BITS`, slot = place, value = class + 1) or the field lengths (`LENGTH_BITS`, slot
/// = place and field).
struct BlockDocs {
    prefix: Vec<u8>,
    bits: u32,
    /// Fields per slot (`FIELD_BITS`, or 0 for a directory).
    field_bits: u32,
    cur: Cursor,
    block: Option<u64>,
    pairs: Vec<(u32, u32)>,
    /// The current block's highest value.
    /// Per group: the current block's highest class + 1 (0 when none).
    block_max: [u32; GROUPS as usize],
    at: usize,
    doc: Option<u64>,
    /// The current document's value (its first slot's).
    value: u32,
}

impl BlockDocs {
    fn new(prefix: Vec<u8>, bits: u32, field_bits: u32) -> BlockDocs {
        BlockDocs {
            cur: Cursor::new(&prefix),
            prefix,
            bits,
            field_bits,
            block: None,
            pairs: Vec::new(),
            block_max: [0; GROUPS as usize],
            at: 0,
            doc: None,
            value: 0,
        }
    }

    fn directory(scope: Scope, term: &str) -> BlockDocs {
        BlockDocs::new(directory(scope, term), BLOCK_BITS, 0)
    }

    fn doc_of(&self, block: u64, slot: u32) -> u64 {
        block << self.bits | u64::from(slot >> self.field_bits)
    }

    fn read_block(&mut self, ctx: &mut Ctx) -> StoreResult<()> {
        let Some((k, v)) = self.cur.get() else {
            self.block = None;
            self.pairs.clear();
            self.doc = None;
            return Ok(());
        };
        let mut at = self.prefix.len();
        self.block = Some(u64_at(k, &mut at)?);
        self.pairs = ctx.pairs(v)?;
        self.block_max = [0; GROUPS as usize];
        for &(_, v) in &self.pairs {
            if v > 0 {
                let rank = v - 1;
                let g = (rank / CLASSES) as usize;
                if g < self.block_max.len() {
                    self.block_max[g] = self.block_max[g].max(rank % CLASSES + 1);
                }
            }
        }
        self.at = 0;
        Ok(())
    }

    /// From pair `at` on: the first document.
    fn load(&mut self, ctx: &mut Ctx) -> StoreResult<()> {
        loop {
            let Some(block) = self.block else {
                self.doc = None;
                return Ok(());
            };
            if let Some(&(s, v)) = self.pairs.get(self.at) {
                self.doc = Some(self.doc_of(block, s));
                self.value = v;
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
        let block = d >> self.bits;
        if self.block != Some(block) {
            let mut k = self.prefix.clone();
            put_u64(&mut k, block);
            self.cur.seek(ctx, &k)?;
            self.read_block(ctx)?;
        }
        self.at = 0;
        if self.block == Some(block) {
            let first = ((d & ((1 << self.bits) - 1)) as u32) << self.field_bits;
            self.at = self.pairs.partition_point(|&(s, _)| s < first);
        }
        self.load(ctx)
    }
}

/// The distinct document ids under a prefix (each the key's next component).
struct Ids {
    prefix: Vec<u8>,
    cur: Cursor,
    doc: Option<u64>,
}

impl Ids {
    fn new(prefix: Vec<u8>) -> Ids {
        Ids {
            cur: Cursor::new(&prefix),
            prefix,
            doc: None,
        }
    }
}

impl Docs for Ids {
    fn doc(&self) -> Option<u64> {
        self.doc
    }

    fn seek(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<()> {
        if self.doc == Some(d) {
            return Ok(());
        }
        let mut k = self.prefix.clone();
        put_u64(&mut k, d);
        self.cur.seek(ctx, &k)?;
        self.doc = match self.cur.get() {
            Some((k, _)) => {
                let mut at = self.prefix.len();
                Some(u64_at(k, &mut at)?)
            }
            None => None,
        };
        Ok(())
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
struct AnyOf(Vec<Ids>);

impl Docs for AnyOf {
    fn doc(&self) -> Option<u64> {
        self.0.iter().filter_map(Ids::doc).min()
    }

    fn seek(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<()> {
        for m in &mut self.0 {
            m.seek(ctx, d)?;
        }
        Ok(())
    }
}

fn members(tag: u64) -> Ids {
    Ids::new(key::id(key::MEMBER, tag))
}

/// Whether `doc` carries `tag`.
fn carries(ctx: &mut Ctx, doc: u64, tag: u64) -> StoreResult<bool> {
    // The member block is read once per query for every candidate in its range.
    let m = ctx.map(key::member_block(tag, doc))?;
    Ok(m.binary_search_by_key(&key::member_slot(doc), |p| p.0)
        .is_ok())
}

/// A document's posting for a term, by field.
type Posting = Vec<(u32, FieldHit)>;

/// A document's posting for a term, in the class its directory gives.
fn posting(ctx: &mut Ctx, scope: Scope, term: &str, class: u32, doc: u64) -> StoreResult<Posting> {
    let block = doc >> super::IMPACT_BITS;
    let m = ctx.map(posting_block(scope, term, class, doc))?;
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

/// (field, tf, length code) by field.
type Tfs = Vec<(u32, u64, u8)>;

/// A document's posting for a term (looked up through the term's directory), as (field, tf) in the fields of
/// `mask`, counting the term as a prefix when `as_prefix`.
fn tfs_of(
    ctx: &mut Ctx,
    scope: Scope,
    term: &str,
    doc: u64,
    mask: u64,
    as_prefix: bool,
) -> StoreResult<Tfs> {
    Ok(match class_in(ctx, scope, term, doc)? {
        Some(rank) => posting(ctx, scope, term, rank, doc)?
            .into_iter()
            .filter(|(f, h)| mask >> f & 1 == 1 && h.tf(as_prefix) > 0)
            .map(|(f, h)| (f, h.tf(as_prefix), h.code))
            .collect(),
        None => Vec::new(),
    })
}

/// A document's class in a term's directory, if it has the term.
fn class_in(ctx: &mut Ctx, scope: Scope, term: &str, doc: u64) -> StoreResult<Option<u32>> {
    let m = ctx.map(directory_block(scope, term, doc >> BLOCK_BITS))?;
    let at = in_block(doc);
    Ok(m.binary_search_by_key(&at, |p| p.0)
        .ok()
        .map(|i| m[i].1 - 1))
}

// ---- statistics ----

pub struct Stats {
    n: f64,
    avg: Vec<f64>,
}

fn scope_stats(ctx: &mut Ctx, scope: Scope) -> StoreResult<Arc<Stats>> {
    let version = ctx.view.published_version();
    if let Some((v, s)) = ctx.cache.0.lock().unwrap().get(&scope)
        && *v == version
    {
        return Ok(s.clone());
    }
    let s = Arc::new(read_stats(ctx, scope)?);
    ctx.cache
        .0
        .lock()
        .unwrap()
        .insert(scope, (version, s.clone()));
    Ok(s)
}

fn read_stats(ctx: &mut Ctx, scope: Scope) -> StoreResult<Stats> {
    let n = ctx.counter(&doc_count(scope))? as f64;
    let mut prefix = field_tokens(scope, 0);
    prefix.truncate(prefix.len() - 1);
    let tokens = ctx.counters_under(&prefix)?;
    let avg = (0..scope.fields().len() as u64)
        .map(|f| {
            let t = tokens.get(&f).copied().unwrap_or(0) as f64;
            if n > 0.0 { t / n } else { 0.0 }
        })
        .collect();
    Ok(Stats { n, avg })
}

// ---- clauses ----

/// What a clause matched in a document: (field, part, tf, length code) in field then part order, and the joined
/// tags' score.
#[derive(Default, Clone)]
struct Matched {
    parts: Vec<(u32, usize, u64, u8)>,
    join: f64,
}

/// A term in one field: its weight times idf.
#[derive(Clone)]
struct Part {
    weight_idf: f64,
}

/// A list a clause reads: a term's postings, in the fields `mask`, standing for token `token`; counted as a
/// prefix term in the prefix fields when `as_prefix`.
struct List {
    term: String,
    mask: u64,
    token: usize,
    as_prefix: bool,
    dir: BlockDocs,
}

/// The tags whose names match a clause, each with the score it adds to its members.
struct Joined {
    tags: Vec<(u64, f64)>,
    /// The most a document gets from them: every matching tag's score.
    most: f64,
    /// Carriers of the matching tags, counted when listed.
    carriers: u64,
    /// Members with their summed score, when listed (for walking in id order).
    listed: Option<Listed<f64>>,
    complete: bool,
}

impl Joined {
    /// What `doc` gets from the matching tags it carries.
    fn score(&mut self, ctx: &mut Ctx, doc: u64) -> StoreResult<f64> {
        if let Some(l) = &mut self.listed {
            l.seek(ctx, doc)?;
            return Ok(match l.items.get(l.pos) {
                Some(&(d, s)) if d == doc => s,
                _ => 0.0,
            });
        }
        let mut s = 0.0;
        for i in 0..self.tags.len() {
            let (tag, j) = self.tags[i];
            if carries(ctx, doc, tag)? {
                s += j;
            }
        }
        Ok(s)
    }

    /// Lists every member (within the budget); returns whether that finished.
    fn list(&mut self, ctx: &mut Ctx, until: u64) -> StoreResult<bool> {
        if self.listed.is_some() {
            return Ok(self.complete);
        }
        // Each tag's carriers from its member blocks, in id order; summed across tags.
        let mut items: Vec<(u64, f64)> = Vec::new();
        for &(tag, j) in &self.tags {
            let prefix = key::id(key::MEMBER_BLOCK, tag);
            let mut cur = Cursor::new(&prefix);
            cur.seek(ctx, &prefix)?;
            while let Some((k, v)) = cur.get() {
                if ctx.work > until {
                    self.complete = false;
                    break;
                }
                let mut at = prefix.len();
                let block = u64_at(k, &mut at)?;
                for (slot, _) in ctx.pairs(v)? {
                    items.push((block << key::MEMBER_BITS | u64::from(slot), j));
                }
                cur.advance(ctx)?;
            }
        }
        items.sort_unstable_by_key(|x| x.0);
        let mut merged: Vec<(u64, f64)> = Vec::with_capacity(items.len());
        for (d, j) in items {
            match merged.last_mut() {
                Some(last) if last.0 == d => last.1 += j,
                _ => merged.push((d, j)),
            }
        }
        self.listed = Some(Listed::new(merged));
        Ok(self.complete)
    }
}

fn fields_of(scope: Scope, m: u64) -> impl Iterator<Item = u32> {
    (0..scope.fields().len() as u32).filter(move |f| m >> f & 1 == 1)
}

/// One clause over one scope.
struct Matcher {
    scope: Scope,
    tokens: Vec<String>,
    /// The last token is a prefix.
    prefix: bool,
    phrase: bool,
    /// Fields it may match in (not the joined one).
    mask: u64,
    /// One list per token for a phrase's exact tokens; one (exact or prefix terms) or two (a prefix longer than
    /// the prefix terms) for a word.
    lists: Vec<List>,
    /// Parts by (token, field).
    parts: HashMap<(usize, u32), usize>,
    part: Vec<Part>,
    /// The highest ratio of a part's idf to its field's reference idf, times how far any field's real average
    /// length is above its reference: what a class's bound is scaled by.
    factors: [f64; GROUPS as usize],
    joined: Option<Joined>,
    doc: Option<u64>,
}

impl Matcher {
    /// None when the clause has no tokens.
    #[allow(clippy::too_many_arguments)]
    fn new(
        ctx: &mut Ctx,
        scope: Scope,
        stats: &Stats,
        toks: Vec<String>,
        fields: Option<&[u32]>,
        last: bool,
        join_until: u64,
        lib: Option<&Stats>,
    ) -> StoreResult<Option<Matcher>> {
        if toks.is_empty() {
            return Ok(None);
        }
        let defs = scope.fields();
        let all = match fields {
            Some(fs) => fs
                .iter()
                .filter(|&&f| (f as usize) < defs.len())
                .fold(0u64, |m, &f| m | 1 << f),
            None => (1u64 << defs.len()) - 1,
        };
        let joined_field =
            (0..defs.len() as u32).find(|&f| defs[f as usize].joined && all >> f & 1 == 1);
        let joined_mask = defs
            .iter()
            .enumerate()
            .filter(|(_, d)| d.joined)
            .fold(0, |m, (i, _)| m | 1 << i);
        let prefix_mask: u64 = (0..defs.len())
            .filter(|&i| defs[i].prefix)
            .fold(0, |m, i| m | 1 << i);
        let mask = all & !joined_mask;
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
            factors: [0.0; GROUPS as usize],
            joined: None,
            doc: None,
        };
        // Per field, the highest ratio of a token's idf there to the field's reference idf.
        let mut ratio = vec![0.0f64; defs.len()];
        for (i, tok) in toks.iter().enumerate() {
            let is_prefix = prefix && i == last_i;
            let long = is_prefix && char_len(tok) > GRAM_MAX;
            // Per field, the kind whose document frequency scores it.
            let gram_df = |f: u32| is_prefix && prefix_mask >> f & 1 == 1;
            let exact_dfs = ctx.counters_under(&doc_freqs(scope, TermKind::Exact, tok))?;
            let gram_term = first_chars(tok, GRAM_MAX).to_string();
            let gram_dfs = if is_prefix {
                ctx.counters_under(&doc_freqs(scope, TermKind::Gram, &gram_term))?
            } else {
                HashMap::new()
            };
            for f in fields_of(scope, mask) {
                let df = if gram_df(f) {
                    gram_dfs.get(&u64::from(f))
                } else {
                    exact_dfs.get(&u64::from(f))
                }
                .copied()
                .unwrap_or(0) as f64;
                let w = defs[f as usize].weight * idf(df, stats.n);
                ratio[f as usize] = ratio[f as usize].max(idf(df, stats.n) / defs[f as usize].idf);
                m.parts.insert((i, f), m.part.len());
                m.part.push(Part { weight_idf: w });
            }
            if phrase && is_prefix {
                // Checked on the text.
                continue;
            }
            let list = |term: &str, mask, as_prefix| List {
                term: term.to_string(),
                mask,
                token: i,
                as_prefix,
                dir: BlockDocs::directory(scope, term),
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
        // A group's bounds scale by the most any of its fields' idf and average length exceed the references:
        // a posting with a prefix field may hold any field, one without holds none.
        let scale = |f: u32| {
            let r = defs[f as usize].avg;
            let a = if r > 0.0 {
                (stats.avg[f as usize] / r).max(1.0)
            } else {
                1.0
            };
            ratio[f as usize] * a
        };
        m.factors[0] = fields_of(scope, mask).map(scale).fold(0.0, f64::max);
        m.factors[1] = fields_of(scope, mask & !prefix_mask)
            .map(scale)
            .fold(0.0, f64::max);
        if let (Some(jf), Some(lib)) = (joined_field, lib) {
            m.joined = Some(join(ctx, lib, &toks, last, jf, join_until)?);
        }
        Ok(Some(m))
    }

    /// Whether the clause is one list read best first (a word).
    fn single(&self) -> Option<usize> {
        (!self.phrase && self.lists.len() == 1).then_some(0)
    }

    /// The most a posting of `rank` scores for this clause.
    fn bound(&self, rank: u32) -> f64 {
        self.factors[(rank / CLASSES) as usize] * class_bound(rank % CLASSES)
    }

    /// To the first document at or after `d` the clause may match: in any of a word's lists, in all of a
    /// phrase's, or as a member of a matching tag (when listed).
    fn align(&mut self, ctx: &mut Ctx, start: u64) -> StoreResult<()> {
        let mut d = start;
        let from_lists = if self.phrase {
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
        };
        let joined = match &mut self.joined {
            Some(Joined {
                listed: Some(l), ..
            }) => {
                l.seek(ctx, start)?;
                l.doc()
            }
            _ => None,
        };
        self.doc = match (from_lists, joined) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        Ok(())
    }

    /// The most the current document can score, from its directory classes and the joined tags.
    fn ceiling(&self) -> f64 {
        let Some(doc) = self.doc else { return 0.0 };
        let mut s: f64 = self
            .lists
            .iter()
            .filter(|l| l.dir.doc() == Some(doc))
            .map(|l| self.bound(l.dir.value - 1))
            .sum();
        if self.phrase && self.prefix {
            s += self.part.iter().map(|p| p.weight_idf).fold(0.0, f64::max) * (super::K1 + 1.0);
        }
        s + self.joined.as_ref().map_or(0.0, |j| j.most)
    }

    /// The most any document in the current blocks of the lists can score (with the joined tags).
    fn block_ceiling(&self) -> f64 {
        let mut s: f64 = self
            .lists
            .iter()
            .filter(|l| l.dir.block.is_some())
            .map(|l| {
                (0..GROUPS)
                    .filter(|&g| l.dir.block_max[g as usize] > 0)
                    .map(|g| self.bound(g * CLASSES + l.dir.block_max[g as usize] - 1))
                    .fold(0.0, f64::max)
            })
            .sum();
        if self.phrase && self.prefix {
            s += self.part.iter().map(|p| p.weight_idf).fold(0.0, f64::max) * (super::K1 + 1.0);
        }
        s + self.joined.as_ref().map_or(0.0, |j| j.most)
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

    /// What the clause matched at `doc` (reading postings, and text where it must), or None.
    fn check(&mut self, ctx: &mut Ctx, doc: u64) -> StoreResult<Option<Matched>> {
        let scope = self.scope;
        let mut out = Matched::default();
        let mut hit = false;
        // Each list's posting for the document, from its directory class (looked up when not at it).
        let mut data: Vec<(usize, usize, Tfs)> = Vec::new();
        for li in 0..self.lists.len() {
            let class = if self.lists[li].dir.doc() == Some(doc) {
                Some(self.lists[li].dir.value - 1)
            } else {
                let l = &self.lists[li];
                class_in(ctx, scope, &l.term.clone(), doc)?
            };
            let Some(class) = class else {
                if self.phrase {
                    data.clear();
                    break;
                }
                continue;
            };
            let l = &self.lists[li];
            let (term, mask, token, as_prefix) = (l.term.clone(), l.mask, l.token, l.as_prefix);
            let p: Tfs = posting(ctx, scope, &term, class, doc)?
                .into_iter()
                .filter(|(f, h)| mask >> f & 1 == 1 && h.tf(as_prefix) > 0)
                .map(|(f, h)| (f, h.tf(as_prefix), h.code))
                .collect();
            if !p.is_empty() {
                data.push((token, li, p));
            }
        }
        let last = self.tokens.len() - 1;
        let long = !self.phrase && self.prefix && char_len(&self.tokens[last]) > GRAM_MAX;
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
            for f in fields_of(scope, common & self.mask) {
                let prefix_field = scope.fields()[f as usize].prefix;
                let mut last_tf = 0;
                let mut found = false;
                for t in ctx.texts(scope, doc, f)? {
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
        if let Some(j) = &mut self.joined {
            let s = j.score(ctx, doc)?;
            if s > 0.0
                || j.listed
                    .as_ref()
                    .is_some_and(|l| l.items.get(l.pos).is_some_and(|x| x.0 == doc))
            {
                hit = true;
                out.join = s;
            }
        }
        Ok(hit.then_some(out))
    }

    fn score(&self, m: &Matched, stats: &Stats) -> f64 {
        let mut s = 0.0;
        for &(f, p, tf, code) in &m.parts {
            s += self.part[p].weight_idf
                * tf_norm(tf as f64, code_length(code), stats.avg[f as usize]);
        }
        s + m.join
    }
}

/// The tags whose names match the clause, each scoring its members: the tag's own name parts at the joined
/// field's weight, with an idf over the matching tags' carriers together.
fn join(
    ctx: &mut Ctx,
    lib: &Stats,
    toks: &[String],
    last: bool,
    field: u32,
    until: u64,
) -> StoreResult<Joined> {
    let scope = Scope::TAGS;
    let stats = scope_stats(ctx, scope)?;
    let mut complete = true;
    // Per matching tag, its name's (tf, length code).
    let mut hits: Vec<(u64, Vec<(u64, u8)>)> = Vec::new();
    let word = toks.len() == 1 && !(last && char_len(&toks[0]) > GRAM_MAX);
    if word {
        // A word: every posting of its term in the tag names.
        let as_prefix = last && char_len(&toks[0]) >= GRAM_MIN;
        let prefix = postings(scope, &toks[0]);
        let mut cur = Cursor::new(&prefix);
        cur.seek(ctx, &prefix)?;
        while let Some((k, v)) = cur.get() {
            if ctx.work > until {
                complete = false;
                break;
            }
            let mut at = prefix.len();
            u64_at(k, &mut at)?;
            u64_at(k, &mut at)?;
            let block = u64_at(k, &mut at)?;
            for (sl, v) in ctx.pairs(v)? {
                let (tag, _) = unslot(block, sl);
                let h = unpack(true, v);
                if h.tf(as_prefix) > 0 {
                    hits.push((tag, vec![(h.tf(as_prefix), h.code)]));
                }
            }
            cur.advance(ctx)?;
        }
    } else if let Some(mut m) =
        Matcher::new(ctx, scope, &stats, toks.to_vec(), None, last, until, None)?
    {
        let mut d = 0;
        loop {
            if ctx.work > until {
                complete = false;
                break;
            }
            m.align(ctx, d)?;
            let Some(tag) = m.doc else { break };
            if let Some(hit) = m.check(ctx, tag)? {
                hits.push((tag, hit.parts.iter().map(|p| (p.2, p.3)).collect()));
            }
            d = tag + 1;
        }
    }
    // Carriers per tag, counted by membership.
    let mut carriers = 0u64;
    let mut counts = Vec::new();
    for (tag, _) in &hits {
        let c = ctx.counter(&key::id(key::MEMBER_COUNT, *tag))?;
        carriers += c;
        counts.push(c);
    }
    let weight = Scope::LIBRARY.fields()[field as usize].weight;
    let idf_j = idf((carriers as f64).min(lib.n), lib.n);
    let mut tags = Vec::new();
    let mut most = 0.0;
    for (tag, parts) in hits {
        let mut s = 0.0;
        for &(tf, code) in &parts {
            s += weight * idf_j * tf_norm(tf as f64, code_length(code), stats.avg[0]);
        }
        most += s;
        tags.push((tag, s));
    }
    Ok(Joined {
        tags,
        most,
        carriers,
        listed: None,
        complete,
    })
}

// ---- the query ----

enum Filtered {
    Tags(Ids),
    Any(AnyOf),
    Ids(Listed<()>),
}

impl Filtered {
    fn docs(&mut self) -> &mut dyn Docs {
        match self {
            Filtered::Tags(x) => x,
            Filtered::Any(x) => x,
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

struct Plan {
    scope: Scope,
    stats: Arc<Stats>,
    pos: Vec<Matcher>,
    neg: Vec<Matcher>,
    include: Vec<Filtered>,
    exclude: Vec<Filtered>,
    /// Every document with text, when nothing else leads.
    all: Option<BlockDocs>,
    complete_joins: bool,
}

/// What a walk in id order passed over: documents or blocks that couldn't beat the page, and how many
/// candidates it checked.
#[derive(Default)]
struct Walk {
    skipped: bool,
    checked: u64,
}

enum Step {
    Match(u64, Vec<Matched>),
    End,
    Stopped(u64),
}

impl Plan {
    fn new(ctx: &mut Ctx, q: &Query) -> StoreResult<Plan> {
        let stats = scope_stats(ctx, q.scope)?;
        let last = q.clauses.iter().rposition(|c| !tokens(&c.text).is_empty());
        let (mut pos, mut neg) = (Vec::new(), Vec::new());
        let join_until = ctx.work.saturating_add(q.limits.joined);
        let mut complete_joins = true;
        for (i, c) in q.clauses.iter().enumerate() {
            let toks = tokens(&c.text);
            if let Some(m) = Matcher::new(
                ctx,
                q.scope,
                &stats,
                toks,
                c.fields.as_deref(),
                Some(i) == last,
                join_until,
                Some(&stats),
            )? {
                complete_joins &= m.joined.as_ref().is_none_or(|j| j.complete);
                if c.negate {
                    neg.push(m);
                } else {
                    pos.push(m);
                }
            }
        }
        let (mut include, mut exclude) = (Vec::new(), Vec::new());
        for f in &q.filters {
            match f {
                Filter::AllTags(tags) => {
                    include.extend(tags.iter().map(|&t| Filtered::Tags(members(t))))
                }
                Filter::AnyTag(tags) => include.push(Filtered::Any(AnyOf(
                    tags.iter().map(|&t| members(t)).collect(),
                ))),
                Filter::NoTag(tags) => exclude.push(Filtered::Any(AnyOf(
                    tags.iter().map(|&t| members(t)).collect(),
                ))),
                Filter::Ids(ids) => include.push(Filtered::Ids(Listed::new(
                    ids.iter().map(|&d| (d, ())).collect(),
                ))),
                Filter::NotIds(ids) => exclude.push(Filtered::Ids(Listed::new(
                    ids.iter().map(|&d| (d, ())).collect(),
                ))),
            }
        }
        let all = (pos.is_empty() && include.is_empty())
            .then(|| BlockDocs::new(lengths(q.scope), LENGTH_BITS, super::FIELD_BITS));
        Ok(Plan {
            scope: q.scope,
            stats,
            pos,
            neg,
            include,
            exclude,
            all,
            complete_joins,
        })
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
            .map(|(m, x)| m.score(x, &self.stats))
            .sum()
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
        loop {
            if d >= end {
                return Ok(Step::End);
            }
            if ctx.work > budget {
                return Ok(Step::Stopped(d));
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
            if let Some(f) = floor
                && !self.pos.is_empty()
            {
                let blocks: f64 = self.pos.iter().map(Matcher::block_ceiling).sum();
                if Ranked(blocks, 0) > *f {
                    walk.skipped = true;
                    d = self
                        .pos
                        .iter()
                        .map(Matcher::block_end)
                        .min()
                        .unwrap_or(u64::MAX)
                        .max(d + 1);
                    continue;
                }
                let here: f64 = self.pos.iter().map(Matcher::ceiling).sum();
                if Ranked(here, d) > *f {
                    walk.skipped = true;
                    d += 1;
                    continue;
                }
            }
            walk.checked += 1;
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
            if !all || !self.passes(ctx, d)? {
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

    /// An estimate of the total from `counted` matches among `checked` candidates: the rarest word's documents
    /// at that rate; with no word, by the share of the ids passed when the walk stopped at `stopped`.
    fn estimate_total(
        &mut self,
        ctx: &mut Ctx,
        counted: u64,
        checked: u64,
        stopped: Option<u64>,
    ) -> StoreResult<u64> {
        let mut lead: Option<u64> = None;
        for i in 0..self.pos.len() {
            if self.pos[i].single().is_some() {
                let term = self.pos[i].lists[0].term.clone();
                let n = ctx.counter(&term_docs(self.scope, &term))?;
                lead = Some(lead.map_or(n, |m: u64| m.min(n)));
            }
        }
        if let Some(n) = lead
            && checked > 0
        {
            return Ok(((n as f64 * counted as f64 / checked as f64).round() as u64).max(counted));
        }
        match stopped {
            Some(at) => self.estimate(ctx, counted, at),
            None => Ok(counted),
        }
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

    fn by_relevance(&mut self, ctx: &mut Ctx, q: &Query) -> StoreResult<Found> {
        if self.pos.len() == 1 && self.pos[0].single().is_some() {
            return self.best_first(ctx, q);
        }
        let after = match &q.after {
            Some(After::Score(s, d)) => Some(Ranked(*s, *d)),
            _ => None,
        };
        let mut best = Best {
            cap: q.limit + 1,
            set: BTreeSet::new(),
        };
        for m in &mut self.pos {
            if let Some(j) = &mut m.joined {
                let until = ctx.work.saturating_add(q.limits.joined);
                let done = j.list(ctx, until)?;
                self.complete_joins &= done;
            }
        }
        let budget = ctx.work.saturating_add(q.limits.enumerate);
        let (mut total, mut d, mut stopped) = (0u64, 0u64, None);
        let mut walk = Walk::default();
        loop {
            let floor = best.worst().map(|r| Ranked(r.0, r.1));
            match self.next_match(ctx, d, u64::MAX, budget, floor.as_ref(), &mut walk)? {
                Step::Match(doc, matched) => {
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
        let page_exact = stopped.is_none() && self.complete_joins;
        let total_exact = page_exact && !walk.skipped;
        if !total_exact {
            total = self.estimate_total(ctx, total, walk.checked, stopped)?;
        }
        Ok(page_of(best, q.limit, total, total_exact, page_exact))
    }

    /// One word, best first: its postings in class order until no later class can beat the page.
    fn best_first(&mut self, ctx: &mut Ctx, q: &Query) -> StoreResult<Found> {
        let after = match &q.after {
            Some(After::Score(s, d)) => Some(Ranked(*s, *d)),
            _ => None,
        };
        let mut best = Best {
            cap: q.limit + 1,
            set: BTreeSet::new(),
        };
        let scope = self.scope;
        let (term, mask, as_prefix) = {
            let l = &self.pos[0].lists[0];
            (l.term.clone(), l.mask, l.as_prefix)
        };
        let defs = scope.fields();
        // One stream per group that can hold the clause's fields, read in the order of their heads' bounds.
        let mut streams: Vec<(u32, Vec<u8>, Cursor)> = Vec::new();
        for g in 0..GROUPS {
            if self.pos[0].factors[g as usize] > 0.0 {
                let prefix = postings_group(scope, &term, g);
                let mut cur = Cursor::new(&prefix);
                cur.seek(ctx, &prefix)?;
                streams.push((g, prefix, cur));
            }
        }
        // Members of the matching tags are listed when few enough that reading them beats looking each candidate
        // up; then the stream runs on while an unseen member could still beat the page.
        if let Some(j) = &mut self.pos[0].joined
            && !j.tags.is_empty()
            && j.carriers <= MEMBERS_LISTED
        {
            let until = ctx.work.saturating_add(q.limits.joined);
            let done = j.list(ctx, until)?;
            self.complete_joins &= done;
        }
        let most_joined = self.pos[0].joined.as_ref().map_or(0.0, |j| j.most);
        // Listed members by what the tags give them, highest first: the first one not yet seen bounds what an
        // unseen document gets from the tags.
        let mut by_join: Vec<(f64, u64)> = self.pos[0]
            .joined
            .as_ref()
            .and_then(|j| j.listed.as_ref())
            .map(|l| l.items.iter().map(|&(d, s)| (s, d)).collect())
            .unwrap_or_default();
        if self.pos[0]
            .joined
            .as_ref()
            .is_some_and(|j| j.tags.len() > 1)
        {
            by_join.sort_by(|a, b| b.0.total_cmp(&a.0));
        }
        let listed = self.pos[0]
            .joined
            .as_ref()
            .is_some_and(|j| j.listed.is_some());
        let mut next_member = 0;
        let budget = ctx.work.saturating_add(q.limits.ranked);
        let mut seen: BTreeSet<u64> = BTreeSet::new();
        let (mut exhausted, mut stopped, mut counted) = (false, false, 0u64);
        let mut term_count: Option<u64> = None;
        loop {
            // The stream whose next entry may score highest.
            let mut head: Option<(usize, u32, u64, f64)> = None;
            for (i, (g, prefix, cur)) in streams.iter().enumerate() {
                if let Some((k, _)) = cur.get() {
                    let mut at = prefix.len();
                    let rank = g * CLASSES + CLASSES - 1 - u64_at(k, &mut at)? as u32;
                    let block = u64_at(k, &mut at)?;
                    let b = self.pos[0].bound(rank);
                    if head.is_none_or(|h| b > h.3) {
                        head = Some((i, rank, block, b));
                    }
                }
            }
            let Some((si, _, block, head_bound)) = head else {
                exhausted = true;
                break;
            };
            while next_member < by_join.len() && seen.contains(&by_join[next_member].1) {
                next_member += 1;
            }
            let joined = if listed {
                by_join.get(next_member).map_or(0.0, |m| m.0)
            } else {
                most_joined
            };
            if let Some(w) = best.worst().map(|r| Ranked(r.0, r.1))
                && Ranked(head_bound, 0) > w
                && listed
            {
                if Ranked(head_bound + joined, 0) > w {
                    break;
                }
                // Only members could still beat the page: look up the ones that could, when that is cheaper than
                // reading on (a lookup costs about as much as decoding a few dozen postings).
                let need: Vec<u64> = by_join[next_member..]
                    .iter()
                    .take_while(|m| Ranked(m.0 + head_bound, 0) <= w)
                    .filter(|m| !seen.contains(&m.1))
                    .map(|m| m.1)
                    .collect();
                if term_count.is_none() {
                    term_count = Some(ctx.counter(&term_docs(scope, &term))?);
                }
                let left = term_count.unwrap_or(0).saturating_sub(seen.len() as u64);
                if (need.len() as u64) * 32 < left {
                    for doc in need {
                        seen.insert(doc);
                        let parts: Vec<(u32, usize, u64, u8)> =
                            tfs_of(ctx, scope, &term, doc, mask, as_prefix)?
                                .into_iter()
                                .map(|(f, tf, code)| (f, self.pos[0].parts[&(0, f)], tf, code))
                                .collect();
                        if !self.passes(ctx, doc)? {
                            continue;
                        }
                        let join = match &mut self.pos[0].joined {
                            Some(j) => j.score(ctx, doc)?,
                            None => 0.0,
                        };
                        let m = Matched { parts, join };
                        let r = Ranked(self.score(std::slice::from_ref(&m)), doc);
                        if after.as_ref().is_none_or(|a| r > *a) {
                            best.push(r);
                        }
                    }
                    continue;
                }
            } else if let Some(w) = best.worst()
                && Ranked(head_bound + joined, 0) > *w
            {
                break;
            }
            if ctx.work > budget {
                stopped = true;
                break;
            }
            let v = streams[si].2.get().unwrap().1.clone();
            let pairs = ctx.pairs(&v)?;
            let mut i = 0;
            while i < pairs.len() {
                let (doc, _) = unslot(block, pairs[i].0);
                let mut parts = Vec::new();
                while let Some(&(s, v)) = pairs.get(i) {
                    let (d, f) = unslot(block, s);
                    if d != doc {
                        break;
                    }
                    let h = unpack(defs[f as usize].prefix, v);
                    if mask >> f & 1 == 1 && h.tf(as_prefix) > 0 {
                        parts.push((f, self.pos[0].parts[&(0, f)], h.tf(as_prefix), h.code));
                    }
                    i += 1;
                }
                // A member looked up already holds its score.
                if parts.is_empty() || !seen.insert(doc) {
                    continue;
                }
                if !self.passes(ctx, doc)? {
                    continue;
                }
                counted += 1;
                let join = match &mut self.pos[0].joined {
                    Some(j) => j.score(ctx, doc)?,
                    None => 0.0,
                };
                let m = Matched { parts, join };
                let r = Ranked(self.score(std::slice::from_ref(&m)), doc);
                if after.as_ref().is_none_or(|a| r > *a) {
                    best.push(r);
                }
            }
            streams[si].2.advance(ctx)?;
        }
        let mut page_exact = !stopped && self.complete_joins;
        let mut total_exact;
        let mut total;
        let has_join = self.pos[0]
            .joined
            .as_ref()
            .is_some_and(|j| !j.tags.is_empty());
        if exhausted {
            // Every document with a field match was seen; members of matching tags without one score their
            // tags' only.
            total = counted;
            total_exact = self.complete_joins;
            if has_join {
                let until = ctx.work.saturating_add(q.limits.joined);
                let j = self.pos[0].joined.as_mut().unwrap();
                let done = j.list(ctx, until)?;
                page_exact &= done;
                total_exact &= done;
                let items: Vec<(u64, f64)> = j.listed.as_ref().unwrap().items.clone();
                for (doc, s) in items {
                    if seen.contains(&doc) || !self.passes(ctx, doc)? {
                        continue;
                    }
                    total += 1;
                    let r = Ranked(s, doc);
                    if after.as_ref().is_none_or(|a| r > *a) {
                        best.push(r);
                    }
                }
            }
        } else {
            // The word's documents, from its counter; restricted fields, filters and tags make it an estimate, and
            // so does a whole word that is also a prefix of tokens in the prefix fields (counted with them).
            total = ctx.counter(&term_docs(scope, &term))?;
            let all_fields =
                mask == self.pos[0].mask_all() && (as_prefix || !gram_shared(scope, &term));
            let filtered =
                !self.include.is_empty() || !self.exclude.is_empty() || !self.neg.is_empty();
            if filtered && !seen.is_empty() {
                total = (total as f64 * counted as f64 / seen.len() as f64).round() as u64;
            }
            if has_join {
                total += self.pos[0].joined.as_ref().map_or(0, |j| j.carriers);
            }
            total_exact = all_fields && !filtered && !has_join && self.complete_joins;
        }
        Ok(page_of(best, q.limit, total, total_exact, page_exact))
    }

    fn by_key(&mut self, ctx: &mut Ctx, q: &Query, order: &dyn SortKey) -> StoreResult<Found> {
        let after = match &q.after {
            Some(After::Key(k, d)) => Some((k.clone(), *d)),
            _ => None,
        };
        for m in &mut self.pos {
            if let Some(j) = &mut m.joined {
                let until = ctx.work.saturating_add(q.limits.joined);
                let done = j.list(ctx, until)?;
                self.complete_joins &= done;
            }
        }
        // Sorting the matches costs a key read each; walking the order costs about one check per
        // documents / matches entries walked per hit. A single word's count says which is cheaper up front.
        let n = self.stats.n.max(1.0);
        let page = q.limit.max(1) as f64;
        let estimate = match self.pos.as_slice() {
            [m] if m.single().is_some() => {
                Some(ctx.counter(&term_docs(self.scope, &m.lists[0].term))? as f64)
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
        let mut total_exact = !walk_first && stopped.is_none() && self.complete_joins;
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
            let has_join = m.joined.as_ref().is_some_and(|j| !j.tags.is_empty());
            total_exact = !filtered && all_fields && !has_join && self.complete_joins;
            if has_join {
                total += m.joined.as_ref().map_or(0, |j| j.carriers);
            }
        }
        let mut hits: Vec<(Vec<u8>, u64)> = Vec::new();
        let mut page_exact = self.complete_joins;
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
    /// Every field the clause could match in, unrestricted (not the joined one).
    fn mask_all(&self) -> u64 {
        let defs = self.scope.fields();
        (0..defs.len())
            .filter(|&i| !defs[i].joined)
            .fold(0, |m, i| m | 1 << i)
    }
}

/// Whether a term's list can hold documents that have it only as a prefix term (in a prefix field).
fn gram_shared(scope: Scope, term: &str) -> bool {
    char_len(term) >= GRAM_MIN && scope.fields().iter().any(|d| d.prefix)
}

fn page_of(best: Best, limit: usize, total: u64, total_exact: bool, page_exact: bool) -> Found {
    let mut hits: Vec<Hit> = best
        .set
        .into_iter()
        .map(|Ranked(score, doc)| Hit {
            doc,
            score,
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
