//! Reading the index: a query is clauses (words or phrases, each over some fields, maybe negated) and filters,
//! answered as a page in relevance (BM25) or sort-key order, with a total.
//!
//! Matching: every positive clause and filter must match, no negated one. A clause of one token is a word; one
//! of several tokens (quoted, or split by the tokenizer, as `foo-bar`) is a phrase: its tokens adjacent and in
//! order within one value of one field. The query's last token is a prefix (from 2 characters): for a word in
//! the prefix fields only, an exact token elsewhere; for a phrase in every field. A phrase is found through its
//! exact tokens' postings, then checked on the candidates' text.
//!
//! One word in relevance order reads its term's top list (`top`) when the term has more documents than a list
//! holds, and all its postings otherwise; the list's page stands when no document outside the list could beat
//! it, and the next pages read on down the list while that holds. A list that is missing, being built or due to
//! be built again asks for the next slice of its pass (`Found::refill`, `refill`). Anything else walks the
//! clauses' postings in id order, passing over blocks whose bound (each field's highest count at the block's
//! shortest length) can't beat the page. In sort-key order a word with few documents is read whole and sorted by
//! key; otherwise the order is walked and each document checked, whichever the counts say is cheaper.
//!
//! In the library, the tags whose names match the query are answered beside the page (`Found::tags`).
//!
//! Work is counted in entries read (a scan's start counts `SEEK` entries, a decoded pair 1 / `PAIRS`, a text
//! read `TEXT` plus its bytes / 32), each about 0.16 µs at 10^6 documents. Past a limit the page is marked
//! inexact; totals are exact where the counts give them or the walk finished, estimates otherwise.

use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use super::text::{GRAM_MAX, GRAM_MIN, char_len, first_chars, phrase_in, tokens};
use super::top::{self, Fields, Head};
use super::{
    BLOCK_BITS, CHUNK_BITS, FIELD_BITS, FieldHit, LENGTH_BITS, SHORTEST_BASE, Scope, TermKind,
    block_maxima, bound_slot, code_length, doc_count, doc_freq, doc_freqs, field_tokens, idf,
    length_block, length_code, lengths, max_doc, parse_varint, posting_block, postings, shortest,
    slot_in, term_docs, tf_norm, top_count, top_entries, top_entry, top_generation, unpack, unslot,
};
use crate::keyspace::val::{Val, counter_bytes, counter_value, get_bytes, get_u64, put_u64};
use crate::store::derive::{Out, View};
use crate::store::kinds::{key, search_texts};
use crate::store::{StoreError, StoreResult};

/// Pairs of the block maps a query keeps read (about 8 bytes each).
const MAPS_HELD: usize = 1 << 22;

/// Tags a query's tag matches hold at most.
pub const TAG_MATCHES: usize = 5;

/// Work a slice of a top list's pass does at most.
pub const SLICE: u64 = 16_384;

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
    /// Finding the tags whose names match.
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
    /// Documents whose lengths were read.
    pub length_reads: u64,
    /// Steps of the walk in id order, and documents it checked.
    pub steps: u64,
    pub checked: u64,
    /// Time reading statistics before matching.
    pub plan_micros: u64,
    /// A top list the query would have read is missing, being built or due to be built again: the next slice of
    /// its pass (`refill`).
    pub refill: Option<Refill>,
    /// The page came from a word's top list.
    pub listed: bool,
    /// In the library: the tags whose names match the query, best first (`TAG_MATCHES` at most).
    pub tags: Vec<TagMatch>,
    /// Every tag was weighed for `tags` (else the work limit cut the search short).
    pub tags_exact: bool,
}

/// A top list's pass to continue: its term and the field parameters to build it at.
#[derive(Debug, Clone, PartialEq)]
pub struct Refill {
    pub scope: Scope,
    pub term: String,
    pub params: Vec<(f64, f64)>,
}

/// A tag whose name matches a query.
#[derive(Debug, Clone, PartialEq)]
pub struct TagMatch {
    pub tag: u64,
    /// WTF-8.
    pub name: Vec<u8>,
    pub carriers: u64,
}

/// Scopes' statistics, by scope, with the published version they were read at.
#[derive(Default)]
pub struct StatsCache(std::sync::Mutex<HashMap<Scope, (u64, Arc<Stats>)>>);

pub fn run(view: &View, q: &Query, cache: &StatsCache) -> StoreResult<Found> {
    let mut ctx = Ctx::new(view, Some(cache));
    let started = std::time::Instant::now();
    let mut plan = Plan::new(&mut ctx, q)?;
    let plan_micros = started.elapsed().as_micros() as u64;
    let mut found = match &q.order {
        Order::Relevance => plan.by_relevance(&mut ctx, q)?,
        Order::Key(k) => plan.by_key(&mut ctx, q, k.as_ref())?,
    };
    if !plan.complete {
        found.page_exact = false;
        found.total_exact = false;
        found.more = true;
    }
    (found.tags, found.tags_exact) = if q.scope == Scope::LIBRARY {
        tag_matches(&mut ctx, q)?
    } else {
        (Vec::new(), true)
    };
    found.work = ctx.work;
    found.scans = ctx.scans;
    found.entries = ctx.entries;
    found.pairs = ctx.pairs;
    found.gets = ctx.gets;
    found.texts = ctx.texts;
    found.length_reads = ctx.length_reads;
    found.steps = ctx.steps;
    found.checked = ctx.checked;
    found.plan_micros = plan_micros;
    found.refill = ctx.refill.take();
    Ok(found)
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
    /// Fields' shortest lengths per block, as read.
    shortest: HashMap<(Scope, u32, u64), Option<u64>>,
    /// Scopes' highest documents, as read.
    max_docs: HashMap<Scope, u64>,
    /// Block maps read by point reads in this query, and their pairs together.
    maps: HashMap<Vec<u8>, Arc<Vec<(u32, u32)>>>,
    map_pairs: usize,
    /// The last document's length codes read.
    codes: Option<(Scope, u64, [u8; 1 << FIELD_BITS])>,
    refill: Option<Refill>,
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
            checked: 0,
            shortest: HashMap::new(),
            max_docs: HashMap::new(),
            maps: HashMap::new(),
            map_pairs: 0,
            codes: None,
            refill: None,
        }
    }

    fn scan(&mut self, start: &[u8], end: &[u8], limit: usize) -> StoreResult<Vec<(Vec<u8>, Val)>> {
        let page = self.view.scan_vals(start, end, limit)?;
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
                counter_value(&v.into_bytes()).unwrap_or(0).max(0) as u64,
            );
        }
        Ok(out)
    }

    /// A block map's pairs, from its settled value (decoded unless the read kept them).
    fn pairs(&mut self, v: Val) -> StoreResult<Vec<(u32, u32)>> {
        let p = v
            .into_pairs()
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
        let m = Arc::new(match self.view.get_val(&k)? {
            Some(v) => self.pairs(v)?,
            None => Vec::new(),
        });
        self.map_pairs += m.len();
        if self.map_pairs > MAPS_HELD {
            self.maps.clear();
            self.map_pairs = m.len();
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
            let v = match self.cur.take() {
                Val::Del => {
                    ctx.work += SEEK;
                    ctx.gets += 1;
                    ctx.view.get_val(&key)?.unwrap_or(Val::Map(Vec::new()))
                }
                v => v,
            };
            self.pairs = ctx.pairs(v)?;
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

/// The first block from `block` on where the term has a block maximum in a field of `mask`; None past the
/// scope's highest document.
fn list_next_block(
    ctx: &mut Ctx,
    scope: Scope,
    term: &str,
    mask: u64,
    block: u64,
) -> StoreResult<Option<u64>> {
    let last = match ctx.max_docs.get(&scope) {
        Some(&m) => m,
        None => {
            let m = ctx
                .get(&max_doc(scope))?
                .and_then(|b| parse_varint(&b))
                .unwrap_or(0);
            ctx.max_docs.insert(scope, m);
            m
        }
    } >> BLOCK_BITS;
    let mut b = block;
    while b <= last {
        let (chunk, first) = bound_slot(b, 0);
        let m = ctx.map(block_maxima(scope, term, chunk))?;
        let at = m.partition_point(|p| p.0 < first);
        if let Some(&(sl, _)) = m[at..]
            .iter()
            .find(|p| mask >> (p.0 & ((1 << FIELD_BITS) - 1)) & 1 == 1)
        {
            return Ok(Some((chunk << CHUNK_BITS) | u64::from(sl >> FIELD_BITS)));
        }
        b = (chunk + 1) << CHUNK_BITS;
    }
    Ok(None)
}

/// A term's highest count in a field in a block.
fn most_in(ctx: &mut Ctx, scope: Scope, term: &str, field: u32, block: u64) -> StoreResult<u64> {
    let (chunk, sl) = bound_slot(block, field);
    let m = ctx.map(block_maxima(scope, term, chunk))?;
    Ok(m.binary_search_by_key(&sl, |p| p.0)
        .ok()
        .map_or(0, |i| u64::from(m[i].1)))
}

// ---- statistics ----

pub struct Stats {
    n: f64,
    avg: Vec<f64>,
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

/// What a clause matched in a document: (field, part, tf, length code) in field then part order.
#[derive(Default, Clone)]
struct Matched {
    parts: Vec<(u32, usize, u64, u8)>,
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
    /// The last block's bound (`Matcher::block_bound`).
    bound: Option<(u64, f64)>,
    /// Per field, the weight times idf its counts score at (0 outside `mask`).
    weights: [f64; 1 << FIELD_BITS],
    /// The last block's shortest length per field, as scoring takes it (`Matcher::doc_ceiling`).
    shortest: Option<(u64, [f64; 1 << FIELD_BITS])>,
    /// The last `list_next_block` asked and answered: every block from the one asked to the answer has it.
    next: Option<(u64, Option<u64>)>,
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
    /// Fields it may match in.
    mask: u64,
    /// One list per token for a phrase's exact tokens; one (exact or prefix terms) or two (a prefix longer than
    /// the prefix terms) for a word.
    lists: Vec<List>,
    /// Parts by (token, field).
    parts: HashMap<(usize, u32), usize>,
    part: Vec<Part>,
    /// The scope's average field lengths.
    avg: Vec<f64>,
    doc: Option<u64>,
}

impl Matcher {
    /// None when the clause has no tokens.
    fn new(
        ctx: &mut Ctx,
        scope: Scope,
        stats: &Stats,
        toks: Vec<String>,
        fields: Option<&[u32]>,
        last: bool,
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
            avg: stats.avg.clone(),
            doc: None,
        };
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
                dir: BlockDocs::postings(scope, term),
                bound: None,
                weights: [0.0; 1 << FIELD_BITS],
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
        for l in &mut m.lists {
            for f in fields_of(scope, l.mask) {
                if let Some(&p) = m.parts.get(&(l.token, f)) {
                    l.weights[f as usize] = m.part[p].weight_idf;
                }
            }
        }
        Ok(Some(m))
    }

    /// Whether the clause is one list (a word).
    fn single(&self) -> Option<usize> {
        (!self.phrase && self.lists.len() == 1).then_some(0)
    }

    /// The most a document in list `li`'s block `block` scores for its term: each field's highest count there at
    /// the block's shortest length.
    fn block_bound(&mut self, ctx: &mut Ctx, li: usize, block: u64) -> StoreResult<f64> {
        if let Some((b, s)) = self.lists[li].bound
            && b == block
        {
            return Ok(s);
        }
        let l = &self.lists[li];
        let mut s = 0.0;
        for f in fields_of(self.scope, l.mask) {
            let most = most_in(ctx, self.scope, &l.term, f, block)?;
            if most == 0 {
                continue;
            }
            let len = shortest_in(ctx, self.scope, f, block)?.unwrap_or(0);
            let Some(&p) = self.parts.get(&(l.token, f)) else {
                continue;
            };
            s += self.part[p].weight_idf
                * tf_norm(
                    most as f64,
                    code_length(length_code(len)),
                    self.avg[f as usize],
                );
        }
        self.lists[li].bound = Some((block, s));
        Ok(s)
    }

    /// The most a document in block `block` can score for the clause, without reading postings; None when no
    /// document there can match it (a word's terms, or one of a phrase's, have never been in the block).
    fn bound_at(&mut self, ctx: &mut Ctx, block: u64) -> StoreResult<Option<f64>> {
        let mut s = 0.0;
        let mut any = false;
        for li in 0..self.lists.len() {
            let b = self.block_bound(ctx, li, block)?;
            if b > 0.0 {
                any = true;
            } else if self.phrase {
                return Ok(None);
            }
            s += b;
        }
        if self.phrase && self.prefix {
            s += self.part.iter().map(|p| p.weight_idf).fold(0.0, f64::max) * (super::K1 + 1.0);
            any |= self.lists.is_empty();
        }
        Ok(any.then_some(s))
    }

    /// The first block from `block` on where the clause's terms have been (a word's in any of its lists, a
    /// phrase's in all), from the terms' block maxima; None past the last.
    fn next_block(&mut self, ctx: &mut Ctx, block: u64) -> StoreResult<Option<u64>> {
        let mut b = block;
        loop {
            let mut found: Option<u64> = None;
            let mut agreed = true;
            for li in 0..self.lists.len() {
                let x = match self.lists[li].next {
                    Some((asked, answer)) if asked <= b && answer.is_none_or(|a| b <= a) => answer,
                    _ => {
                        let l = &self.lists[li];
                        let x = list_next_block(ctx, self.scope, &l.term, l.mask, b)?;
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

    /// To the first document at or after `d` the clause may match: in any of a word's lists, in all of a
    /// phrase's.
    fn align(&mut self, ctx: &mut Ctx, start: u64) -> StoreResult<()> {
        let mut d = start;
        self.doc = if self.phrase {
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
        Ok(())
    }

    /// The most any document in the current blocks of the lists can score.
    fn block_ceiling(&mut self, ctx: &mut Ctx) -> StoreResult<f64> {
        let mut s = 0.0;
        for li in 0..self.lists.len() {
            if let Some(b) = self.lists[li].dir.block {
                s += self.block_bound(ctx, li, b)?;
            }
        }
        if self.phrase && self.prefix {
            s += self.part.iter().map(|p| p.weight_idf).fold(0.0, f64::max) * (super::K1 + 1.0);
        }
        Ok(s)
    }

    /// The most document `d` can score, from the counts of the lists standing at it, at their blocks' shortest
    /// lengths.
    fn doc_ceiling(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<f64> {
        let mut s = 0.0;
        let defs = self.scope.fields();
        let block = d >> BLOCK_BITS;
        for li in 0..self.lists.len() {
            if self.lists[li].dir.doc() != Some(d) {
                continue;
            }
            if self.lists[li].shortest.is_none_or(|(b, _)| b != block) {
                let mut lens = [0.0; 1 << FIELD_BITS];
                for f in fields_of(self.scope, self.lists[li].mask) {
                    let len = shortest_in(ctx, self.scope, f, block)?.unwrap_or(0);
                    lens[f as usize] = code_length(length_code(len));
                }
                self.lists[li].shortest = Some((block, lens));
            }
            let l = &self.lists[li];
            let lens = l.shortest.unwrap().1;
            for (f, v) in l.dir.doc_pairs() {
                let w = l.weights[f as usize];
                if w > 0.0 {
                    let tf = unpack(defs[f as usize].prefix, v).most();
                    s += w * tf_norm(tf as f64, lens[f as usize], self.avg[f as usize]);
                }
            }
        }
        if self.phrase && self.prefix {
            s += self.part.iter().map(|p| p.weight_idf).fold(0.0, f64::max) * (super::K1 + 1.0);
        }
        Ok(s)
    }

    /// For a word: the documents of block `block` that hold it, as bits; its lists stand at the block.
    fn block_held(
        &mut self,
        ctx: &mut Ctx,
        block: u64,
    ) -> StoreResult<[u64; 1 << (BLOCK_BITS - 6)]> {
        let mut held = [0u64; 1 << (BLOCK_BITS - 6)];
        for li in 0..self.lists.len() {
            self.lists[li].dir.seek(ctx, block << BLOCK_BITS)?;
            if self.lists[li].dir.block != Some(block) {
                continue;
            }
            if self.lists[li].shortest.is_none_or(|(b, _)| b != block) {
                let mut lens = [0.0; 1 << FIELD_BITS];
                for f in fields_of(self.scope, self.lists[li].mask) {
                    let len = shortest_in(ctx, self.scope, f, block)?.unwrap_or(0);
                    lens[f as usize] = code_length(length_code(len));
                }
                self.lists[li].shortest = Some((block, lens));
            }
            let l = &self.lists[li];
            for &(sl, _) in &l.dir.pairs {
                if l.mask >> (sl & ((1 << FIELD_BITS) - 1)) & 1 == 1 {
                    let place = (sl >> FIELD_BITS) as usize;
                    held[place >> 6] |= 1 << (place & 63);
                }
            }
        }
        Ok(held)
    }

    /// For a word, after `block_held`: adds to `total` the most each document in `only` can score for it at
    /// the block's shortest lengths.
    fn block_bounds(&self, only: &[u64], total: &mut [f64]) {
        const TABLE: usize = 16;
        let defs = self.scope.fields();
        let mut best = [0.0f64; 1 << BLOCK_BITS];
        for l in &self.lists {
            let Some((_, lens)) = l.shortest.filter(|_| l.dir.block.is_some()) else {
                continue;
            };
            // Each field's score for the small counts, at the block's shortest length.
            let mut table = [[0.0f64; TABLE]; 1 << FIELD_BITS];
            for f in fields_of(self.scope, l.mask) {
                let f = f as usize;
                for (tf, x) in table[f].iter_mut().enumerate() {
                    *x = l.weights[f] * tf_norm(tf as f64, lens[f], self.avg[f]);
                }
            }
            let mut i = 0;
            let mut place = usize::MAX;
            let mut s = 0.0;
            while i <= l.dir.pairs.len() {
                let next = l
                    .dir
                    .pairs
                    .get(i)
                    .map(|&(sl, _)| (sl >> FIELD_BITS) as usize);
                if next != Some(place) {
                    if place != usize::MAX {
                        best[place] = best[place].max(0.0) + s;
                    }
                    s = 0.0;
                    place = next.unwrap_or(usize::MAX);
                }
                let Some(&(sl, v)) = l.dir.pairs.get(i) else {
                    break;
                };
                i += 1;
                if only[place >> 6] >> (place & 63) & 1 == 0 {
                    continue;
                }
                let f = (sl & ((1 << FIELD_BITS) - 1)) as usize;
                if l.mask >> f & 1 == 1 {
                    let tf = unpack(defs[f].prefix, v).most() as usize;
                    s += match table[f].get(tf) {
                        Some(&x) => x,
                        None => l.weights[f] * tf_norm(tf as f64, lens[f], self.avg[f]),
                    };
                }
            }
        }
        for (t, b) in total.iter_mut().zip(best) {
            *t += b;
        }
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
        Ok(hit.then_some(out))
    }

    fn score(&self, m: &Matched, stats: &Stats) -> f64 {
        let mut s = 0.0;
        for &(f, p, tf, code) in &m.parts {
            s += self.part[p].weight_idf
                * tf_norm(tf as f64, code_length(code), stats.avg[f as usize]);
        }
        s
    }
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
    /// The last block the walk bounded before reading its postings, and its bound (None: no match there).
    shallow: Option<(u64, Option<f64>)>,
    /// The last block's documents that could beat the page (`next_match`).
    cands: Option<(u64, Vec<u64>)>,
    /// Every tag a tag-restricted clause matches was found (else the work limit cut that short).
    complete: bool,
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
        let (mut include, mut exclude) = (Vec::new(), Vec::new());
        let mut complete = true;
        let tags_field = tags_field(q.scope);
        for (i, c) in q.clauses.iter().enumerate() {
            let toks = tokens(&c.text);
            // A clause restricted to the tags field: the cards carrying a tag whose name it matches.
            if let (Some(t), Some(fs)) = (tags_field, &c.fields)
                && !fs.is_empty()
                && fs.iter().all(|&f| f == t)
                && !toks.is_empty()
            {
                let until = ctx.work.saturating_add(q.limits.tags);
                let (tags, done) = named_tags(ctx, toks, Some(i) == last, until)?;
                complete &= done;
                let carriers = Filtered::Any(AnyOf(tags.into_iter().map(members).collect()));
                if c.negate {
                    exclude.push(carriers);
                } else {
                    include.push(carriers);
                }
                continue;
            }
            if let Some(m) = Matcher::new(
                ctx,
                q.scope,
                &stats,
                toks,
                c.fields.as_deref(),
                Some(i) == last,
            )? {
                if c.negate {
                    neg.push(m);
                } else {
                    pos.push(m);
                }
            }
        }
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
            .then(|| BlockDocs::new(lengths(q.scope), LENGTH_BITS));
        Ok(Plan {
            scope: q.scope,
            stats,
            pos,
            neg,
            include,
            exclude,
            all,
            shallow: None,
            cands: None,
            complete,
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
                    (Some(b), Some(f)) => {
                        let beaten = Ranked(b, 0) > *f;
                        walk.skipped |= beaten;
                        beaten
                    }
                    _ => false,
                };
                if beaten {
                    d = (block + 1) << BLOCK_BITS;
                    continue;
                }
                // With a page to beat and only words, the block's documents that every word holds and whose
                // counts at the block's shortest lengths could beat it; the rest are passed over.
                if let Some(f) = floor
                    && self.pos.iter().all(|m| !m.phrase)
                {
                    if self.cands.as_ref().is_none_or(|c| c.0 != block) {
                        // The documents every word holds, then their bounds.
                        let mut all = [u64::MAX; 1 << (BLOCK_BITS - 6)];
                        for m in &mut self.pos {
                            let held = m.block_held(ctx, block)?;
                            for (a, h) in all.iter_mut().zip(held) {
                                *a &= h;
                            }
                        }
                        let mut total = [0.0f64; 1 << BLOCK_BITS];
                        for m in &mut self.pos {
                            m.block_bounds(&all, &mut total);
                        }
                        let first = block << BLOCK_BITS;
                        let mut docs = Vec::new();
                        let mut held = 0;
                        for (w, &bits) in all.iter().enumerate() {
                            let mut b = bits;
                            while b != 0 {
                                let i = w * 64 + b.trailing_zeros() as usize;
                                b &= b - 1;
                                held += 1;
                                let doc = first + i as u64;
                                if Ranked(total[i], doc) < *f {
                                    docs.push(doc);
                                }
                            }
                        }
                        walk.skipped |= docs.len() < held;
                        self.cands = Some((block, docs));
                    }
                    let docs = &self.cands.as_ref().unwrap().1;
                    match docs.get(docs.partition_point(|&x| x < d)) {
                        Some(&x) => d = x,
                        None => {
                            d = (block + 1) << BLOCK_BITS;
                            continue;
                        }
                    }
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
            if let Some(f) = floor
                && !self.pos.is_empty()
            {
                let mut blocks = 0.0;
                for m in &mut self.pos {
                    blocks += m.block_ceiling(ctx)?;
                }
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
            }
            if let Some(f) = floor
                && !self.pos.is_empty()
            {
                let mut here = 0.0;
                for m in &mut self.pos {
                    here += m.doc_ceiling(ctx, d)?;
                }
                if Ranked(here, d) > *f {
                    walk.skipped = true;
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
        if self.pos.len() == 1
            && self.pos[0].single().is_some()
            && let Some(found) = self.top_first(ctx, q)?
        {
            return Ok(found);
        }
        let after = match &q.after {
            Some(After::Score(s, d)) => Some(Ranked(*s, *d)),
            _ => None,
        };
        let mut best = Best {
            cap: q.limit + 1,
            set: BTreeSet::new(),
        };
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
        let page_exact = stopped.is_none();
        let total_exact = page_exact && !walk.skipped;
        if !total_exact {
            total = self.estimate_total(ctx, total, walk.checked, stopped)?;
        }
        Ok(page_of(best, q.limit, total, total_exact, page_exact))
    }

    /// One word over every field: its documents when they are few, else its top list, read from the top or
    /// from `after`'s place. None when the list is missing, being built, or its entries can't prove the page: the
    /// walk answers (and a missing or due list asks for the next slice of its pass).
    fn top_first(&mut self, ctx: &mut Ctx, q: &Query) -> StoreResult<Option<Found>> {
        let scope = self.scope;
        let (term, mask, as_prefix) = {
            let l = &self.pos[0].lists[0];
            (l.term.clone(), l.mask, l.as_prefix)
        };
        // Lists rank by the prefix counts over every field.
        if !as_prefix || mask != self.pos[0].mask_all() {
            return Ok(None);
        }
        let after = match &q.after {
            Some(After::Score(s, d)) => Some(Ranked(*s, *d)),
            _ => None,
        };
        let n = ctx.counter(&term_docs(scope, &term))?;
        let filtered = !self.include.is_empty() || !self.exclude.is_empty() || !self.neg.is_empty();
        let mut best = Best {
            cap: q.limit + 1,
            set: BTreeSet::new(),
        };
        let mut counted = 0u64;
        if n <= top::MAX as u64 {
            // Every document of the term.
            let mut docs = BlockDocs::postings(scope, &term);
            docs.seek(ctx, 0)?;
            let defs = scope.fields();
            while let Some(doc) = docs.doc() {
                let hits: Vec<(u32, FieldHit)> = docs
                    .doc_pairs()
                    .map(|(f, v)| (f, unpack(defs[f as usize].prefix, v)))
                    .collect();
                let tfs = tfs_of(ctx, scope, hits, doc, mask, true)?;
                docs.seek(ctx, doc + 1)?;
                if !self.passes(ctx, doc)? {
                    continue;
                }
                counted += 1;
                let r = Ranked(self.score_word(tfs), doc);
                if after.as_ref().is_none_or(|a| r > *a) {
                    best.push(r);
                }
            }
            return Ok(Some(page_of(best, q.limit, counted, true, true)));
        }
        let params: Vec<(f64, f64)> = (0..scope.fields().len() as u32)
            .map(|f| match self.pos[0].parts.get(&(0, f)) {
                Some(&p) => (self.pos[0].part[p].weight_idf, self.pos[0].avg[f as usize]),
                None => (0.0, 0.0),
            })
            .collect();
        self.listed_page(ctx, q, &term, n, filtered, &params)
    }

    /// The page from a word's top list (`top_first`); None when it can't prove the page.
    fn listed_page(
        &mut self,
        ctx: &mut Ctx,
        q: &Query,
        term: &str,
        n: u64,
        filtered: bool,
        params: &[(f64, f64)],
    ) -> StoreResult<Option<Found>> {
        let scope = self.scope;
        let term = term.to_string();
        let params = params.to_vec();
        let after = match &q.after {
            Some(After::Score(s, d)) => Some(Ranked(*s, *d)),
            _ => None,
        };
        // The head and every entry from one state of the keyspace: a page never mixes two versions of a list.
        let (head, entries, read) = ctx.view.with_snapshot(|v| {
            let mut sub = Ctx::new(v, None);
            let generation = sub.counter(&top_generation(scope, &term))?;
            let head = sub
                .get(&super::top(scope, &term))?
                .and_then(|b| Head::decode(&b));
            let count = sub.counter(&top_count(scope, &term))?;
            #[cfg(test)]
            super::tests::after_list_head();
            let head = head.filter(|h| {
                h.generation == generation && h.passing.is_none() && count >= top::MIN as u64
            });
            let entries = match head {
                Some(_) => list_entries(&mut sub, scope, &term)?,
                None => Vec::new(),
            };
            StoreResult::Ok((head, entries, (sub.work, sub.gets, sub.scans, sub.entries)))
        })?;
        ctx.work += read.0;
        ctx.gets += read.1;
        ctx.scans += read.2;
        ctx.entries += read.3;
        if head
            .as_ref()
            .is_none_or(|h| drift(&h.params, &params) > DRIFT)
        {
            ctx.refill = Some(Refill {
                scope,
                term: term.clone(),
                params: params.clone(),
            });
        }
        let Some(head) = head else {
            return Ok(None);
        };
        let mut best = Best {
            cap: q.limit + 1,
            set: BTreeSet::new(),
        };
        let (mut seen, mut counted) = (0u64, 0u64);
        // Scores now are within these factors of the list's.
        let up = drift(&head.params, &params);
        let down = drift(&params, &head.params);
        // A document outside the list scores at most this; one tying it ranks by id only while scores haven't
        // drifted.
        let outside = Ranked(head.floor * up, if up > 1.0 { 0 } else { head.floor_doc });
        // Entries scoring above `after` by more than the drift rank above it now: passed over.
        let from = after.as_ref().map_or(f64::INFINITY, |a| a.0 * down);
        for (listed_score, doc, fields) in entries {
            if listed_score > from {
                continue;
            }
            // Every entry from here on scores at most this now.
            let bound = Ranked(listed_score * up, if up > 1.0 { 0 } else { doc });
            if best.worst().is_some_and(|w| bound >= *w) {
                break;
            }
            seen += 1;
            if !self.passes(ctx, doc)? {
                continue;
            }
            counted += 1;
            let r = Ranked(self.score_word(fields), doc);
            if after.as_ref().is_none_or(|a| r > *a) {
                best.push(r);
            }
        }
        // Nothing outside the list can beat the page's last hit, nor any entry not read.
        if !best.worst().is_some_and(|w| outside > *w) {
            return Ok(None);
        }
        let mut total = n;
        if filtered && seen > 0 {
            total = (total as f64 * counted as f64 / seen as f64).round() as u64;
        }
        let mut found = page_of(best, q.limit, total, !filtered, true);
        found.listed = true;
        Ok(Some(found))
    }

    /// The single word's score from its (field, tf, length code).
    fn score_word(&self, fields: Fields) -> f64 {
        let parts = fields
            .into_iter()
            .map(|(f, tf, code)| (f, self.pos[0].parts[&(0, f)], tf, code))
            .collect();
        self.score(&[Matched { parts }])
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

/// How far scores now can be above a list's: the highest ratio of a field's weight times idf now to the list's,
/// times how far its average length now is above the list's.
fn drift(list: &[(f64, f64)], now: &[(f64, f64)]) -> f64 {
    let mut most: f64 = 0.0;
    for (i, &(w, avg)) in now.iter().enumerate() {
        if w <= 0.0 {
            continue;
        }
        let (lw, lavg) = list.get(i).copied().unwrap_or((0.0, 0.0));
        if lw <= 0.0 {
            return f64::INFINITY;
        }
        let a = if lavg > 0.0 {
            (avg / lavg).max(1.0)
        } else {
            1.0
        };
        most = most.max(w / lw * a);
    }
    most.max(1.0)
}

/// How far a list's scores may drift before a query builds it again.
const DRIFT: f64 = 1.1;

/// A top list being built: its head and entries (score, document, fields), best first.
pub struct Building {
    pub head: Head,
    pub entries: Vec<(f64, u64, Fields)>,
}

/// Continues a list's pass over its term's postings from `head.passing` until it ends or the work passes
/// `until`: each document scored at the list's parameters, kept while among the `top::MAX` best, the floor
/// raised to every document dropped or passed over (a block, or a document, whose bound at its block's
/// shortest lengths can't beat the lowest kept).
fn pass(ctx: &mut Ctx, scope: Scope, term: &str, b: &mut Building, until: u64) -> StoreResult<()> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    #[derive(PartialEq)]
    struct ByScore(f64, u64);
    impl Eq for ByScore {}
    impl PartialOrd for ByScore {
        fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
            Some(self.cmp(o))
        }
    }
    impl Ord for ByScore {
        fn cmp(&self, o: &Self) -> Ordering {
            self.0.total_cmp(&o.0).then(o.1.cmp(&self.1))
        }
    }
    let Some(from) = b.head.passing else {
        return Ok(());
    };
    let defs = scope.fields();
    let mut heap: BinaryHeap<Reverse<ByScore>> = BinaryHeap::new();
    let mut kept: HashMap<u64, Fields> = HashMap::new();
    let push = |heap: &mut BinaryHeap<Reverse<ByScore>>,
                kept: &mut HashMap<u64, Fields>,
                head: &mut Head,
                score: f64,
                doc: u64,
                fields: Fields| {
        heap.push(Reverse(ByScore(score, doc)));
        kept.insert(doc, fields);
        if heap.len() > top::MAX {
            let Reverse(ByScore(s, out)) = heap.pop().unwrap();
            kept.remove(&out);
            head.raise_floor(s, out);
        }
    };
    for (score, doc, fields) in b.entries.drain(..) {
        push(&mut heap, &mut kept, &mut b.head, score, doc, fields);
    }
    let lowest = |heap: &BinaryHeap<Reverse<ByScore>>| {
        (heap.len() >= top::MAX).then(|| heap.peek().map(|r| (r.0.0, r.0.1)).unwrap())
    };
    let prefix = postings(scope, term);
    let mut cur = Cursor::new(&prefix);
    cur.seek(ctx, &posting_block(scope, term, from))?;
    let mut next = None;
    while let Some((k, v)) = cur.get() {
        let mut at = prefix.len();
        let block = u64_at(k, &mut at)?;
        if ctx.work > until {
            next = Some(block);
            break;
        }
        // The block's shortest length per field, as a length code.
        let mut short = [0u8; 1 << FIELD_BITS];
        for f in 0..defs.len() as u32 {
            short[f as usize] = length_code(shortest_in(ctx, scope, f, block)?.unwrap_or(0));
        }
        if let Some(min) = lowest(&heap) {
            let mut bound = 0.0;
            for f in 0..defs.len() as u32 {
                let most = most_in(ctx, scope, term, f, block)?;
                if most > 0 {
                    bound += b.head.score(&[(f, most, short[f as usize])]);
                }
            }
            if !top::above((bound, block << BLOCK_BITS), min) {
                b.head.raise_floor(bound, block << BLOCK_BITS);
                cur.advance(ctx)?;
                continue;
            }
        }
        let _ = v;
        let v = cur.take();
        let pairs = ctx.pairs(v)?;
        let mut i = 0;
        while i < pairs.len() {
            let (doc, _) = unslot(block, pairs[i].0);
            let mut hits = Vec::new();
            while let Some(&(s, v)) = pairs.get(i) {
                let (d, f) = unslot(block, s);
                if d != doc {
                    break;
                }
                hits.push((f, unpack(defs[f as usize].prefix, v)));
                i += 1;
            }
            // Its counts at the block's shortest lengths bound it before its lengths are read.
            if let Some(min) = lowest(&heap) {
                let mut bound = 0.0;
                for &(f, h) in &hits {
                    bound += b.head.score(&[(f, h.tf(true), short[f as usize])]);
                }
                if !top::above((bound, doc), min) {
                    b.head.raise_floor(bound, doc);
                    continue;
                }
            }
            let tfs = tfs_of(ctx, scope, hits, doc, u64::MAX, true)?;
            if tfs.is_empty() {
                continue;
            }
            let score = b.head.score(&tfs);
            if lowest(&heap).is_none_or(|m| top::above((score, doc), m)) {
                push(&mut heap, &mut kept, &mut b.head, score, doc, tfs);
            } else {
                b.head.raise_floor(score, doc);
            }
        }
        cur.advance(ctx)?;
    }
    b.head.passing = next;
    b.entries = heap
        .into_iter()
        .map(|Reverse(ByScore(score, doc))| (score, doc, kept.remove(&doc).unwrap_or_default()))
        .collect();
    b.entries
        .sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    Ok(())
}

/// A top list's entries, best first.
fn list_entries(ctx: &mut Ctx, scope: Scope, term: &str) -> StoreResult<Vec<(f64, u64, Fields)>> {
    let prefix = top_entries(scope, term);
    let end = key::prefix_end(&prefix);
    let mut from = prefix.clone();
    let mut out = Vec::new();
    loop {
        let page = ctx.scan(&from, &end, 1024)?;
        for (k, v) in &page {
            let (score, doc) = top::parse_rank(&k[prefix.len()..])
                .ok_or_else(|| StoreError::Entry("a top list entry doesn't decode".into()))?;
            let fields = top::decode_fields(&v.clone().into_bytes())
                .ok_or_else(|| StoreError::Entry("a top list entry doesn't decode".into()))?;
            out.push((score, doc, fields));
        }
        match page.last() {
            Some((k, _)) if page.len() == 1024 => from = successor(k),
            _ => return Ok(out),
        }
    }
}

/// The next slice of a term's top list's pass, run in the commit queue (so every commit before it is seen and
/// every one after it follows what it writes): a list that is missing, stale, under `top::MIN` entries or
/// built at parameters more than `DRIFT` from `params` starts again at `params`; then the pass goes on for at
/// most `SLICE` work. Writes the entries that came and went, the count and the head.
pub fn refill(
    view: &View,
    out: &mut Out,
    scope: Scope,
    term: &str,
    params: &[(f64, f64)],
) -> StoreResult<()> {
    let mut ctx = Ctx::new(view, None);
    if ctx.counter(&term_docs(scope, term))? <= top::MAX as u64 {
        return Ok(());
    }
    let generation = ctx.counter(&top_generation(scope, term))?;
    let head = ctx
        .get(&super::top(scope, term))?
        .and_then(|b| Head::decode(&b));
    let count = ctx.counter(&top_count(scope, term))?;
    let again = head.as_ref().is_none_or(|h| {
        h.generation != generation
            || (h.passing.is_none()
                && (count < top::MIN as u64 || drift(&h.params, params) > DRIFT))
    });
    let old = list_entries(&mut ctx, scope, term)?;
    let mut b = match head {
        Some(h) if !again => {
            if h.passing.is_none() {
                return Ok(());
            }
            Building {
                head: h,
                entries: old.clone(),
            }
        }
        _ => Building {
            head: Head::new(generation, params.to_vec()),
            entries: Vec::new(),
        },
    };
    let until = ctx.work.saturating_add(SLICE);
    pass(&mut ctx, scope, term, &mut b, until)?;
    write_list(out, scope, term, &old, &b);
    Ok(())
}

/// The entries that changed from `old` to the list `b`, its count and its head.
fn write_list(out: &mut Out, scope: Scope, term: &str, old: &[(f64, u64, Fields)], b: &Building) {
    let was: HashMap<(u64, u64), &Fields> =
        old.iter().map(|(s, d, f)| ((s.to_bits(), *d), f)).collect();
    let is: HashMap<(u64, u64), &Fields> = b
        .entries
        .iter()
        .map(|(s, d, f)| ((s.to_bits(), *d), f))
        .collect();
    for (s, d, _) in old {
        if !is.contains_key(&(s.to_bits(), *d)) {
            out.del(top_entry(scope, term, *s, *d));
        }
    }
    for (s, d, f) in &b.entries {
        if was.get(&(s.to_bits(), *d)) != Some(&f) {
            out.put(top_entry(scope, term, *s, *d), top::encode_fields(f));
        }
    }
    out.put(
        top_count(scope, term),
        counter_bytes(b.entries.len() as i64),
    );
    out.put(super::top(scope, term), b.head.encode());
}

/// The parameters a word's list is built at: per field the weight times idf (of the term as a prefix term in
/// the prefix fields, as a whole token elsewhere, as a query's last word matches), and the average length.
pub fn list_params(view: &View, scope: Scope, term: &str) -> StoreResult<Vec<(f64, f64)>> {
    let mut ctx = Ctx::new(view, None);
    let stats = read_stats(&mut ctx, scope)?;
    let mut params = Vec::new();
    for (f, d) in scope.fields().iter().enumerate() {
        let kind = if d.prefix {
            TermKind::Gram
        } else {
            TermKind::Exact
        };
        let df = ctx.counter(&doc_freq(scope, kind, term, f as u32))? as f64;
        params.push((d.weight * idf(df, stats.n), stats.avg[f]));
    }
    Ok(params)
}

/// A term's whole list, built at once (a bulk load into an empty store).
pub fn build_list(view: &View, scope: Scope, term: &str) -> StoreResult<Building> {
    let mut ctx = Ctx::new(view, None);
    let generation = ctx.counter(&top_generation(scope, term))?;
    let params = list_params(view, scope, term)?;
    let mut b = Building {
        head: Head::new(generation, params),
        entries: Vec::new(),
    };
    pass(&mut ctx, scope, term, &mut b, u64::MAX)?;
    Ok(b)
}

/// A built list's entries: entry keys with their values, the count and the head.
pub fn list_entries_of(scope: Scope, term: &str, b: &Building) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut out = Out::default();
    write_list(&mut out, scope, term, &[], b);
    out.entries
        .into_iter()
        .filter_map(|(k, v)| match v {
            crate::keyspace::val::Val::Put(b) => Some((k, b)),
            _ => None,
        })
        .collect()
}

/// A term's scope and text from its `term_docs` key.
pub fn parse_term_key(k: &[u8]) -> Option<(Scope, String)> {
    let mut at = key::of(key::SEARCH_TERM_DOCS).len();
    let kind = get_u64(k, &mut at)?;
    let owner = get_u64(k, &mut at)?;
    let term = String::from_utf8(get_bytes(k, &mut at)?).ok()?;
    (at == k.len()).then_some((Scope { kind, owner }, term))
}

/// Whether a word of this term reads a top list: a query's last word of 2 to 20 characters.
pub fn has_list(term: &str) -> bool {
    (GRAM_MIN..=GRAM_MAX).contains(&char_len(term))
}

/// The library field holding a card's own tags, which a clause restricts itself to for tag membership.
fn tags_field(scope: Scope) -> Option<u32> {
    (scope == Scope::LIBRARY)
        .then(|| scope.fields().iter().position(|d| d.name == "tags"))
        .flatten()
        .map(|f| f as u32)
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
    let Some(mut m) = Matcher::new(ctx, Scope::TAGS, &stats, toks, None, last)? else {
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

/// The tags whose names match the library query `q`: each positive clause that can apply to tags (any field,
/// or the card tags field among its fields) matches the name, no negated one does; a clause restricted to
/// other fields means none. Best first: the whole name is the query's words, then every word a whole word of
/// the name, then the rest (the last word a prefix); then more carriers, then the lower id. With whether every
/// matching tag was weighed.
fn tag_matches(ctx: &mut Ctx, q: &Query) -> StoreResult<(Vec<TagMatch>, bool)> {
    let tags_field = Scope::LIBRARY
        .fields()
        .iter()
        .position(|d| d.name == "tags")
        .map(|f| f as u32);
    let mut clauses = Vec::new();
    for c in &q.clauses {
        if tokens(&c.text).is_empty() {
            continue;
        }
        if c.fields
            .as_ref()
            .is_some_and(|fs| !tags_field.is_some_and(|t| fs.contains(&t)))
        {
            return Ok((Vec::new(), true));
        }
        clauses.push(Clause {
            fields: None,
            ..c.clone()
        });
    }
    if !clauses.iter().any(|c| !c.negate) {
        return Ok((Vec::new(), true));
    }
    let tq = Query {
        scope: Scope::TAGS,
        clauses,
        filters: Vec::new(),
        order: Order::Relevance,
        limit: TAG_MATCHES,
        after: None,
        limits: q.limits,
    };
    // The query's words, and each positive clause's.
    let words: Vec<Vec<String>> = tq
        .clauses
        .iter()
        .filter(|c| !c.negate)
        .map(|c| tokens(&c.text))
        .collect();
    let all: Vec<String> = words.iter().flatten().cloned().collect();
    let mut plan = Plan::new(ctx, &tq)?;
    let budget = ctx.work.saturating_add(q.limits.tags);
    // (quality, carriers reversed, tag), with the name.
    let mut best: Vec<((u8, u64, u64), Vec<u8>)> = Vec::new();
    let mut d = 0;
    let mut exact = true;
    loop {
        match plan.next_match(ctx, d, u64::MAX, budget, None, &mut Walk::default())? {
            Step::Match(tag, _) => {
                let name = ctx.texts(Scope::TAGS, tag, 0)?.concat();
                let carriers = ctx.counter(&key::id(key::MEMBER_COUNT, tag))?;
                let quality = if tokens(&name) == all {
                    0
                } else if words.iter().all(|w| phrase_in(&name, w, false, true).0) {
                    1
                } else {
                    2
                };
                best.push(((quality, u64::MAX - carriers, tag), name));
                best.sort_by_key(|a| a.0);
                best.truncate(TAG_MATCHES);
                d = tag + 1;
            }
            Step::End => break,
            Step::Stopped(_) => {
                exact = false;
                break;
            }
        }
    }
    Ok((
        best.into_iter()
            .map(|((_, c, tag), name)| TagMatch {
                tag,
                name,
                carriers: u64::MAX - c,
            })
            .collect(),
        exact,
    ))
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
