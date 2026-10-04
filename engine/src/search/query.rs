//! Reading the index: a query is clauses (words or phrases, each over some fields, maybe negated) and filters,
//! answered as a page in relevance (BM25) or sort-key order, with the total.
//!
//! Matching: every positive clause and filter must match, no negated one. A clause of one token is a word; one
//! of several tokens (quoted, or split by the tokenizer, as `foo-bar`) is a phrase: its tokens adjacent and in
//! order within one value of one field. The query's last token is a prefix (from 2 characters): for a word in
//! the prefix fields only, an exact token elsewhere; for a phrase in every field. A phrase is found through its
//! exact tokens' postings, then checked on the candidates' text. The joined field (the library's tag names)
//! matches through the tags whose names match.
//!
//! Work is counted in entries read (a scan's start counts `SEEK` entries, a text read `TEXT` plus its bytes /
//! 32), each about 0.16 µs at 10^6 documents. Matches are enumerated in document order up to `Limits::enumerate`:
//! finishing under it, the total and the page are exact. Past it the total is an estimate; in relevance order
//! the page is then completed from the per-block score bounds (blocks in order of their bound until no block
//! can beat the page), exact if that finishes within `Limits::ranked`. The clauses' tags (through the joined
//! field) and their members are read up to `Limits::joined`; past it nothing is exact. In sort-key order, the
//! matches are sorted by their keys when there are at most about √(page · documents) of them, else the order is
//! walked checking each document, up to `Limits::walked`.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use super::text::{GRAM_MAX, GRAM_MIN, char_len, first_chars, tokens};
use super::{
    BLOCK_BITS, LENGTH_MAX, Scope, TermKind, bounds, doc_count, doc_freq, doc_lengths,
    field_tokens, idf, lengths, max_doc, parse_varint, postings, shortest, shortest_all, tf_norm,
};
use crate::keyspace::val::{counter_value, get_u64, put_u64};
use crate::store::derive::View;
use crate::store::kinds::{key, search_texts};
use crate::store::{StoreError, StoreResult};

/// Work a scan's start costs, in entries.
pub const SEEK: u64 = 96;
/// Work a text read costs besides its bytes / 32.
pub const TEXT: u64 = 128;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub enumerate: u64,
    pub ranked: u64,
    pub walked: u64,
    /// For reading the tags the clauses match through the joined field, and their members, all together.
    pub joined: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            enumerate: 120_000,
            ranked: 120_000,
            walked: 120_000,
            joined: 80_000,
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
    /// Scans started, entries they read, point reads and texts read.
    pub scans: u64,
    pub entries: u64,
    pub gets: u64,
    pub texts: u64,
}

pub fn run(view: &View, q: &Query) -> StoreResult<Found> {
    let mut ctx = Ctx {
        view,
        work: 0,
        scans: 0,
        entries: 0,
        gets: 0,
        texts: 0,
        stats: HashMap::new(),
    };
    let mut plan = Plan::new(&mut ctx, q)?;
    let mut found = match &q.order {
        Order::Relevance => plan.by_relevance(&mut ctx, q)?,
        Order::Key(k) => plan.by_key(&mut ctx, q, k.as_ref())?,
    };
    found.work = ctx.work;
    found.scans = ctx.scans;
    found.entries = ctx.entries;
    found.gets = ctx.gets;
    found.texts = ctx.texts;
    Ok(found)
}

// ---- reading ----

pub(crate) struct Ctx<'a> {
    view: &'a View<'a>,
    work: u64,
    scans: u64,
    entries: u64,
    gets: u64,
    texts: u64,
    stats: HashMap<Vec<u8>, u64>,
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

    /// A counter or varint entry (0 when it has none), read once per query.
    fn number(&mut self, k: Vec<u8>, counter: bool) -> StoreResult<u64> {
        if let Some(v) = self.stats.get(&k) {
            return Ok(*v);
        }
        self.work += SEEK;
        self.gets += 1;
        let v = match self.view.get(&k)? {
            Some(b) if counter => counter_value(&b).unwrap_or(0).max(0) as u64,
            Some(b) => parse_varint(&b).unwrap_or(0),
            None => 0,
        };
        self.stats.insert(k, v);
        Ok(v)
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

const PAGE_MIN: usize = 32;
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
        let inside = self.from.as_slice() <= k
            && !(self.from.is_empty() && self.page.is_empty() && !self.last)
            && (self.last || self.page.last().is_some_and(|(l, _)| k <= l.as_slice()));
        if inside {
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

/// The (document, field) → term frequency entries under a prefix, a document at a time, keeping the allowed fields.
struct Postings {
    prefix: Vec<u8>,
    cur: Cursor,
    mask: u64,
    doc: Option<u64>,
    hits: Vec<(u32, u64)>,
}

impl Postings {
    fn new(prefix: Vec<u8>, mask: u64) -> Postings {
        Postings {
            cur: Cursor::new(&prefix),
            prefix,
            mask,
            doc: None,
            hits: Vec::new(),
        }
    }

    fn load(&mut self, ctx: &mut Ctx) -> StoreResult<()> {
        self.hits.clear();
        loop {
            let Some((k, _)) = self.cur.get() else {
                self.doc = None;
                return Ok(());
            };
            let mut at = self.prefix.len();
            let doc = u64_at(k, &mut at)?;
            while let Some((k, v)) = self.cur.get() {
                let mut at = self.prefix.len();
                if u64_at(k, &mut at)? != doc {
                    break;
                }
                let f = u64_at(k, &mut at)? as u32;
                if self.mask >> f & 1 == 1 {
                    self.hits.push((f, parse_varint(v).unwrap_or(0)));
                }
                self.cur.advance(ctx)?;
            }
            if !self.hits.is_empty() {
                self.doc = Some(doc);
                return Ok(());
            }
        }
    }
}

impl Docs for Postings {
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

    fn load(&mut self) -> StoreResult<()> {
        let Some((k, _)) = self.cur.get() else {
            self.doc = None;
            return Ok(());
        };
        let mut at = self.prefix.len();
        self.doc = Some(u64_at(k, &mut at)?);
        Ok(())
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
        self.load()
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

    fn value(&self) -> Option<&T> {
        self.items.get(self.pos).map(|(_, v)| v)
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

// ---- statistics ----

#[derive(Clone, Copy)]
struct FieldStats {
    weight: f64,
    avg_len: f64,
}

/// A term in one field, with its weight times idf.
#[derive(Clone)]
struct Part {
    kind: TermKind,
    term: String,
    field: u32,
    weight_idf: f64,
}

// ---- clauses ----

/// What a clause matched in a document.
#[derive(Default, Clone)]
struct Matched {
    /// (field, part index, tf), in field then part order.
    parts: Vec<(u32, usize, u64)>,
    join: f64,
}

/// The tags whose names match, with their score contribution, and their members' scores.
struct Joined {
    docs: Listed<f64>,
    complete: bool,
}

/// One clause over one scope.
struct Matcher {
    scope: Scope,
    /// Exact tokens' postings (for a word: its one term, exact or prefix).
    lists: Vec<(Postings, Vec<usize>)>,
    tokens: Vec<String>,
    /// The last token is a prefix.
    prefix: bool,
    phrase: bool,
    parts: Vec<Part>,
    /// Part index per (token, field), for scoring text-checked tokens.
    part_of: HashMap<(usize, u32), usize>,
    joined: Option<Joined>,
    doc: Option<u64>,
    /// Fields of the current document where the clause may hold, before the text check.
    candidates: u64,
    checked: Option<Matched>,
}

/// A token's lookups: (term kind, term, fields). A prefix longer than the prefix terms is looked up by its first
/// `GRAM_MAX` characters, and checked on the text.
fn word_lookups(scope: Scope, tok: &str, prefix: bool, mask: u64) -> Vec<(TermKind, String, u64)> {
    let defs = scope.fields();
    let prefix_mask: u64 = (0..defs.len())
        .filter(|&i| defs[i].prefix)
        .fold(0, |m, i| m | 1 << i);
    let n = char_len(tok);
    if !prefix || n < GRAM_MIN {
        return vec![(TermKind::Exact, tok.to_string(), mask)];
    }
    let mut out = Vec::new();
    if mask & !prefix_mask != 0 {
        out.push((TermKind::Exact, tok.to_string(), mask & !prefix_mask));
    }
    if mask & prefix_mask != 0 {
        out.push((
            TermKind::Gram,
            first_chars(tok, GRAM_MAX).to_string(),
            mask & prefix_mask,
        ));
    }
    out
}

fn fields_of(scope: Scope, m: u64) -> impl Iterator<Item = u32> {
    (0..scope.fields().len() as u32).filter(move |f| m >> f & 1 == 1)
}

/// Whether `phrase` occurs in a value's tokens: adjacent and in order, the last a prefix if `prefix`.
fn occurs(toks: &[String], phrase: &[String], prefix: bool) -> bool {
    if phrase.is_empty() || toks.len() < phrase.len() {
        return false;
    }
    let last = phrase.len() - 1;
    toks.windows(phrase.len()).any(|w| {
        w.iter().zip(phrase).enumerate().all(|(i, (t, p))| {
            if i == last && prefix {
                t.starts_with(p.as_str())
            } else {
                t == p
            }
        })
    })
}

struct Stats {
    n: f64,
    fields: Vec<FieldStats>,
}

fn scope_stats(ctx: &mut Ctx, scope: Scope) -> StoreResult<Stats> {
    let n = ctx.number(doc_count(scope), true)? as f64;
    let mut fields = Vec::new();
    for (i, d) in scope.fields().iter().enumerate() {
        let tokens = ctx.number(field_tokens(scope, i as u32), true)? as f64;
        fields.push(FieldStats {
            weight: d.weight,
            avg_len: if n > 0.0 { tokens / n } else { 0.0 },
        });
    }
    Ok(Stats { n, fields })
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
        join_until: u64,
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
        let mask = all
            & !defs
                .iter()
                .enumerate()
                .filter(|(_, d)| d.joined)
                .fold(0, |m, (i, _)| m | 1 << i);
        let phrase = toks.len() > 1;
        let prefix = last && char_len(toks.last().unwrap()) >= GRAM_MIN;
        let mut m = Matcher {
            scope,
            lists: Vec::new(),
            tokens: toks.clone(),
            prefix,
            phrase,
            parts: Vec::new(),
            part_of: HashMap::new(),
            joined: None,
            doc: None,
            candidates: 0,
            checked: None,
        };
        let last_i = toks.len() - 1;
        for (i, tok) in toks.iter().enumerate() {
            let is_prefix = prefix && i == last_i;
            let lookups = word_lookups(scope, tok, is_prefix, mask);
            let mut part_ids = Vec::new();
            for (kind, term, fm) in &lookups {
                for f in fields_of(scope, *fm) {
                    let df = ctx.number(doc_freq(scope, *kind, term, f), true)? as f64;
                    let fs = stats.fields[f as usize];
                    m.part_of.insert((i, f), m.parts.len());
                    part_ids.push(m.parts.len());
                    m.parts.push(Part {
                        kind: *kind,
                        term: term.clone(),
                        field: f,
                        weight_idf: fs.weight * idf(df, stats.n),
                    });
                }
            }
            // A phrase finds its candidates through its exact tokens; a prefix token is checked on the text.
            if phrase && is_prefix {
                continue;
            }
            for (kind, term, fm) in lookups {
                if fm == 0 {
                    continue;
                }
                let ids = part_ids
                    .iter()
                    .copied()
                    .filter(|&p| m.parts[p].kind == kind)
                    .collect();
                m.lists
                    .push((Postings::new(postings(scope, kind, &term), fm), ids));
            }
        }
        if let Some(jf) = joined_field {
            m.joined = Some(join(ctx, stats, &toks, last, jf, join_until)?);
        }
        Ok(Some(m))
    }

    /// To the first document at or after `d` the clause may match: in any of a word's lists, in all of a
    /// phrase's, or as a member of a matching tag.
    fn align(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<()> {
        self.checked = None;
        if let Some(j) = &mut self.joined {
            j.docs.seek(ctx, d)?;
        }
        let from_lists = if self.phrase {
            self.align_all(ctx, d)?
        } else {
            for (l, _) in &mut self.lists {
                l.seek(ctx, d)?;
            }
            let doc = self.lists.iter().filter_map(|(l, _)| l.doc()).min();
            if let Some(doc) = doc {
                self.candidates = self
                    .lists
                    .iter()
                    .filter(|(l, _)| l.doc() == Some(doc))
                    .flat_map(|(l, _)| l.hits.iter().map(|(f, _)| *f))
                    .fold(0, |m, f| m | 1 << f);
            }
            doc
        };
        let joined = self.joined.as_ref().and_then(|j| j.docs.doc());
        self.doc = match (from_lists, joined) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        if from_lists != self.doc {
            self.candidates = 0;
        }
        Ok(())
    }

    /// The first document at or after `d` where every token list has the same field.
    fn align_all(&mut self, ctx: &mut Ctx, mut d: u64) -> StoreResult<Option<u64>> {
        if self.lists.is_empty() {
            return Ok(None);
        }
        loop {
            let mut agreed = true;
            for (l, _) in &mut self.lists {
                l.seek(ctx, d)?;
                match l.doc() {
                    None => return Ok(None),
                    Some(x) if x != d => {
                        d = x;
                        agreed = false;
                    }
                    _ => {}
                }
            }
            if !agreed {
                continue;
            }
            let common = self
                .lists
                .iter()
                .map(|(l, _)| l.hits.iter().fold(0u64, |m, (f, _)| m | 1 << f))
                .fold(u64::MAX, |a, b| a & b);
            if common != 0 {
                self.candidates = common;
                return Ok(Some(d));
            }
            d += 1;
        }
    }

    /// What the clause matched at the current document (checking text where it must), or None.
    fn check(&mut self, ctx: &mut Ctx) -> StoreResult<Option<Matched>> {
        if let Some(m) = &self.checked {
            return Ok(Some(m.clone()));
        }
        let Some(doc) = self.doc else { return Ok(None) };
        let mut out = Matched::default();
        let mut hit = false;
        if self.candidates != 0 {
            let last = self.tokens.len() - 1;
            let long_prefix =
                !self.phrase && self.prefix && char_len(&self.tokens[last]) > GRAM_MAX;
            // tf per (field, part) from the postings.
            let mut tfs: BTreeMap<(u32, usize), u64> = BTreeMap::new();
            for (l, ids) in &self.lists {
                if l.doc() != Some(doc) {
                    continue;
                }
                for &(f, tf) in &l.hits {
                    if let Some(&p) = ids.iter().find(|&&p| self.parts[p].field == f) {
                        tfs.insert((f, p), tf);
                    }
                }
            }
            for f in fields_of(self.scope, self.candidates) {
                let prefix_field = self.scope.fields()[f as usize].prefix;
                if !self.phrase && !(long_prefix && prefix_field) {
                    hit = true;
                    out.parts.extend(
                        tfs.range((f, 0)..(f + 1, 0))
                            .map(|(&(f, p), &tf)| (f, p, tf)),
                    );
                    continue;
                }
                let mut last_tf = 0;
                let mut found = false;
                for t in ctx.texts(self.scope, doc, f)? {
                    let toks = tokens(&t);
                    found |= occurs(&toks, &self.tokens, self.prefix);
                    if self.prefix {
                        // The prefix token scores as a prefix term in a prefix field, as a whole token elsewhere.
                        let p = self.tokens[last].as_str();
                        last_tf += toks
                            .iter()
                            .filter(|x| {
                                if prefix_field {
                                    x.starts_with(p)
                                } else {
                                    x.as_str() == p
                                }
                            })
                            .count() as u64;
                    }
                }
                if !found {
                    continue;
                }
                hit = true;
                for i in 0..=last {
                    let Some(&p) = self.part_of.get(&(i, f)) else {
                        continue;
                    };
                    let tf = if i == last && self.prefix {
                        last_tf
                    } else {
                        tfs.get(&(f, p)).copied().unwrap_or(0)
                    };
                    if tf > 0 {
                        out.parts.push((f, p, tf));
                    }
                }
            }
        }
        if let Some(j) = &self.joined
            && j.docs.doc() == Some(doc)
        {
            hit = true;
            out.join = *j.docs.value().unwrap();
        }
        if !hit {
            return Ok(None);
        }
        self.checked = Some(out.clone());
        Ok(Some(out))
    }

    fn score(&self, m: &Matched, lens: &dyn Fn(u32) -> f64, stats: &Stats) -> f64 {
        let mut s = 0.0;
        for &(f, p, tf) in &m.parts {
            let part = &self.parts[p];
            s += part.weight_idf * tf_norm(tf as f64, lens(f), stats.fields[f as usize].avg_len);
        }
        s + m.join
    }

    /// The highest score the current document can have, before any text is checked: every candidate part at its
    /// frequency (a token found on the text at any frequency), whatever the lengths.
    fn ceiling_unchecked(&self) -> f64 {
        let Some(doc) = self.doc else { return 0.0 };
        let mut s = 0.0;
        let mut listed = vec![false; self.parts.len()];
        for (l, ids) in &self.lists {
            if l.doc() != Some(doc) {
                continue;
            }
            for &(f, tf) in &l.hits {
                if let Some(&p) = ids.iter().find(|&&p| self.parts[p].field == f) {
                    listed[p] = true;
                    s += self.parts[p].weight_idf * tf_norm(tf as f64, 0.0, 1.0);
                }
            }
        }
        if self.candidates != 0 {
            for (p, part) in self.parts.iter().enumerate() {
                if !listed[p] && self.candidates >> part.field & 1 == 1 {
                    s += part.weight_idf * (super::K1 + 1.0);
                }
            }
        }
        if let Some(j) = &self.joined
            && j.docs.doc() == Some(doc)
        {
            s += j.docs.value().unwrap();
        }
        s
    }

    /// The highest score a match with these parts can have, whatever its lengths.
    fn ceiling(&self, m: &Matched, stats: &Stats) -> f64 {
        self.score(m, &|_| 0.0, stats)
    }
}

/// The tags whose names match the clause, and their members, each with the sum of the matching tags' scores.
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
    let mut tags = Vec::new();
    let mut complete = true;
    let budget = until;
    if let Some(mut m) = Matcher::new(ctx, scope, &stats, toks.to_vec(), None, last, until)? {
        let mut d = 0;
        loop {
            if ctx.work > budget {
                complete = false;
                break;
            }
            m.align(ctx, d)?;
            let Some(doc) = m.doc else { break };
            if let Some(hit) = m.check(ctx)? {
                tags.push((doc, hit));
            }
            d = doc + 1;
        }
        let weight = lib.fields[field as usize].weight;
        let mut members_of = Vec::new();
        let mut df = 0u64;
        for (tag, hit) in &tags {
            let mut ids = members(*tag);
            ids.seek(ctx, 0)?;
            let mut list = Vec::new();
            while let Some(e) = ids.doc() {
                if ctx.work > budget {
                    complete = false;
                    break;
                }
                list.push(e);
                ids.seek(ctx, e + 1)?;
            }
            df += list.len() as u64;
            members_of.push((*tag, hit.clone(), list));
        }
        let idf_j = idf((df as f64).min(lib.n), lib.n);
        let mut by_doc: BTreeMap<u64, f64> = BTreeMap::new();
        for (tag, hit, list) in members_of {
            let len = ctx.number(super::length(scope, tag, 0), false)? as f64;
            let mut s = 0.0;
            for &(_, _, tf) in &hit.parts {
                s += weight * idf_j * tf_norm(tf as f64, len, stats.fields[0].avg_len);
            }
            for e in list {
                *by_doc.entry(e).or_default() += s;
            }
        }
        return Ok(Joined {
            docs: Listed::new(by_doc.into_iter().collect()),
            complete,
        });
    }
    Ok(Joined {
        docs: Listed::new(Vec::new()),
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

struct Plan {
    scope: Scope,
    stats: Stats,
    pos: Vec<Matcher>,
    neg: Vec<Matcher>,
    include: Vec<Filtered>,
    exclude: Vec<Filtered>,
    /// Every document with text, when nothing else leads.
    all: Option<Ids>,
    complete_joins: bool,
    lens: Cursor,
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
    set: std::collections::BTreeSet<Ranked>,
}

impl Best {
    fn threshold(&self) -> Option<f64> {
        self.worst().map(|r| r.0)
    }

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

impl Plan {
    fn new(ctx: &mut Ctx, q: &Query) -> StoreResult<Plan> {
        let stats = scope_stats(ctx, q.scope)?;
        let last = q.clauses.iter().rposition(|c| !tokens(&c.text).is_empty());
        let (mut pos, mut neg) = (Vec::new(), Vec::new());
        let mut complete_joins = true;
        let join_until = ctx.work.saturating_add(q.limits.joined);
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
        let all = (pos.is_empty() && include.is_empty()).then(|| Ids::new(lengths(q.scope)));
        Ok(Plan {
            scope: q.scope,
            stats,
            pos,
            neg,
            include,
            exclude,
            all,
            complete_joins,
            lens: Cursor::new(&lengths(q.scope)),
        })
    }

    /// The first match at or after `d` (and before `end`), with what each positive clause matched.
    /// With `floor`, documents that can't score above it are passed over before any text is read.
    fn next_match(
        &mut self,
        ctx: &mut Ctx,
        mut d: u64,
        end: u64,
        budget: u64,
        floor: Option<&Ranked>,
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
                && Ranked(self.pos.iter().map(Matcher::ceiling_unchecked).sum(), d) > *f
            {
                d += 1;
                continue;
            }
            if self.excluded(ctx, d)? {
                d += 1;
                continue;
            }
            let mut matched = Vec::with_capacity(self.pos.len());
            for m in &mut self.pos {
                match m.check(ctx)? {
                    Some(x) => matched.push(x),
                    None => break,
                }
            }
            if matched.len() < self.pos.len() {
                d += 1;
                continue;
            }
            return Ok(Step::Match(d, matched));
        }
    }

    fn excluded(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<bool> {
        for f in &mut self.exclude {
            let docs = f.docs();
            docs.seek(ctx, d)?;
            if docs.doc() == Some(d) {
                return Ok(true);
            }
        }
        for m in &mut self.neg {
            m.align(ctx, d)?;
            if m.doc == Some(d) && m.check(ctx)?.is_some() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Whether `d` matches, from any position.
    fn matches(&mut self, ctx: &mut Ctx, d: u64) -> StoreResult<bool> {
        Ok(matches!(
            self.next_match(ctx, d, d + 1, u64::MAX, None)?,
            Step::Match(..)
        ))
    }

    fn lengths_of(&mut self, ctx: &mut Ctx, doc: u64) -> StoreResult<Vec<f64>> {
        let n = self.scope.fields().len();
        let mut out = vec![0.0; n];
        let start = doc_lengths(self.scope, doc);
        self.lens.seek(ctx, &start)?;
        while let Some((k, v)) = self.lens.get() {
            if !k.starts_with(&start) {
                break;
            }
            let mut at = start.len();
            let f = u64_at(k, &mut at)? as usize;
            if f < n {
                out[f] = parse_varint(v).unwrap_or(0) as f64;
            }
            self.lens.advance(ctx)?;
        }
        Ok(out)
    }

    fn ceiling(&self, matched: &[Matched]) -> f64 {
        self.pos
            .iter()
            .zip(matched)
            .map(|(m, x)| m.ceiling(x, &self.stats))
            .sum()
    }

    fn score(&mut self, ctx: &mut Ctx, doc: u64, matched: &[Matched]) -> StoreResult<f64> {
        if self.pos.is_empty() {
            return Ok(0.0);
        }
        let lens = self.lengths_of(ctx, doc)?;
        let f = |field: u32| lens[field as usize];
        Ok(self
            .pos
            .iter()
            .zip(matched)
            .map(|(m, x)| m.score(x, &f, &self.stats))
            .sum())
    }

    fn by_relevance(&mut self, ctx: &mut Ctx, q: &Query) -> StoreResult<Found> {
        let after = match &q.after {
            Some(After::Score(s, d)) => Some(Ranked(*s, *d)),
            _ => None,
        };
        let mut best = Best {
            cap: q.limit + 1,
            set: Default::default(),
        };
        let mut total = 0;
        let mut d = 0;
        let mut stopped = None;
        let budget = ctx.work.saturating_add(q.limits.enumerate);
        let offer = |plan: &mut Plan,
                     ctx: &mut Ctx,
                     best: &mut Best,
                     doc: u64,
                     matched: &[Matched]|
         -> StoreResult<()> {
            if let Some(w) = best.worst()
                && Ranked(plan.ceiling(matched), doc) > *w
            {
                return Ok(());
            }
            let s = plan.score(ctx, doc, matched)?;
            let r = Ranked(s, doc);
            if after.as_ref().is_none_or(|a| r > *a) {
                best.push(r);
            }
            Ok(())
        };
        loop {
            match self.next_match(ctx, d, u64::MAX, budget, None)? {
                Step::Match(doc, matched) => {
                    total += 1;
                    offer(self, ctx, &mut best, doc, &matched)?;
                    d = doc + 1;
                }
                Step::End => break,
                Step::Stopped(at) => {
                    stopped = Some(at);
                    break;
                }
            }
        }
        let mut page_exact = stopped.is_none() && self.complete_joins;
        if let Some(from) = stopped {
            page_exact = self.ranked_rest(ctx, q, from, &mut best, &offer)? && self.complete_joins;
            total = self.estimate(ctx, total, from)?;
        }
        let mut hits: Vec<Hit> = best
            .set
            .into_iter()
            .map(|Ranked(score, doc)| Hit {
                doc,
                score,
                key: None,
            })
            .collect();
        let more = hits.len() > q.limit || !page_exact;
        hits.truncate(q.limit);
        Ok(Found {
            hits,
            total,
            total_exact: stopped.is_none() && self.complete_joins,
            page_exact,
            more,
            ..Default::default()
        })
    }

    /// Matches past `from` without counting them: blocks in order of their score bound while one can beat the
    /// page. Returns whether that finished within the limit.
    fn ranked_rest(
        &mut self,
        ctx: &mut Ctx,
        q: &Query,
        from: u64,
        best: &mut Best,
        offer: &Offer,
    ) -> StoreResult<bool> {
        if self.pos.is_empty() {
            // Every match scores 0, so the page is the first matches in id order, and enumeration found them.
            return Ok(best.threshold().is_some());
        }
        let budget = ctx.work.saturating_add(q.limits.ranked);
        let first = from >> BLOCK_BITS;
        // Each positive clause's bound per block; a block counts only where every clause has one.
        let mut total: Option<BTreeMap<u64, f64>> = None;
        for i in 0..self.pos.len() {
            let b = self.clause_bounds(ctx, i, first, budget)?;
            let Some(b) = b else { return Ok(false) };
            total = Some(match total {
                None => b,
                Some(t) => t
                    .into_iter()
                    .filter_map(|(blk, x)| b.get(&blk).map(|y| (blk, x + y)))
                    .collect(),
            });
        }
        let mut blocks: Vec<(u64, f64)> = total.unwrap_or_default().into_iter().collect();
        blocks.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        for (blk, bound) in blocks {
            if let Some(t) = best.threshold()
                && bound < t
            {
                return Ok(true);
            }
            let lo = (blk << BLOCK_BITS).max(from);
            let hi = (blk + 1) << BLOCK_BITS;
            let mut d = lo;
            loop {
                match self.next_match(ctx, d, hi, budget, best.worst())? {
                    Step::Match(doc, matched) => {
                        offer(self, ctx, best, doc, &matched)?;
                        d = doc + 1;
                    }
                    Step::End => break,
                    Step::Stopped(_) => return Ok(false),
                }
            }
        }
        Ok(true)
    }

    /// Per block from `first` on: the most clause `i` can score there. None past the budget.
    fn clause_bounds(
        &mut self,
        ctx: &mut Ctx,
        i: usize,
        first: u64,
        budget: u64,
    ) -> StoreResult<Option<BTreeMap<u64, f64>>> {
        let scope = self.scope;
        let m = &self.pos[i];
        // A phrase can only match where all its exact tokens are; a word wherever any of its terms is.
        let mut tok_of_part = vec![usize::MAX; m.parts.len()];
        for (&(t, _), &p) in &m.part_of {
            tok_of_part[p] = t;
        }
        let ntok = m.tokens.len();
        let mut by_tok: Vec<BTreeMap<u64, f64>> = vec![BTreeMap::new(); ntok];
        let mut shortest_cache = Shortest::default();
        let parts = m.parts.clone();
        for (p, part) in parts.iter().enumerate() {
            let start = bounds(scope, part.kind, &part.term, part.field);
            let mut from = start.clone();
            put_u64(&mut from, first);
            let mut cur = Cursor::new(&start);
            cur.seek(ctx, &from)?;
            while let Some((k, v)) = cur.get() {
                if ctx.work > budget {
                    return Ok(None);
                }
                let mut at = start.len();
                let blk = u64_at(k, &mut at)?;
                let max_tf = parse_varint(v).unwrap_or(0) as f64;
                let short = shortest_len(ctx, scope, part.field, blk, &mut shortest_cache)?;
                let x = part.weight_idf
                    * tf_norm(
                        max_tf,
                        short,
                        self.stats.fields[part.field as usize].avg_len,
                    );
                *by_tok[tok_of_part[p]].entry(blk).or_default() += x;
                cur.advance(ctx)?;
            }
        }
        let m = &self.pos[i];
        let last = ntok - 1;
        let mut out: BTreeMap<u64, f64> = BTreeMap::new();
        if m.phrase {
            // Where every exact token is; the prefix token adds its bound where it has one.
            let exact: Vec<usize> = (0..ntok).filter(|&t| !(m.prefix && t == last)).collect();
            if let Some(&t0) = exact.first() {
                for (&blk, &x) in &by_tok[t0] {
                    let mut s = x;
                    let mut all = true;
                    for &t in &exact[1..] {
                        match by_tok[t].get(&blk) {
                            Some(y) => s += y,
                            None => all = false,
                        }
                    }
                    if all {
                        if m.prefix {
                            s += by_tok[last].get(&blk).copied().unwrap_or(0.0);
                        }
                        out.insert(blk, s);
                    }
                }
            }
        } else {
            out = std::mem::take(&mut by_tok[0]);
        }
        if let Some(j) = &m.joined {
            let mut most: BTreeMap<u64, f64> = BTreeMap::new();
            for &(d, x) in &j.docs.items {
                if d >> BLOCK_BITS >= first {
                    let e = most.entry(d >> BLOCK_BITS).or_default();
                    *e = e.max(x);
                }
            }
            for (blk, x) in most {
                *out.entry(blk).or_default() += x;
            }
        }
        Ok(Some(out))
    }

    /// An estimate of the total from the matches counted up to `from`, by the share of the ids they cover.
    fn estimate(&mut self, ctx: &mut Ctx, counted: u64, from: u64) -> StoreResult<u64> {
        let top = ctx.number(max_doc(self.scope), false)?.max(from);
        let share = (from as f64 + 1.0) / (top as f64 + 1.0);
        Ok(((counted as f64 / share).round() as u64).max(counted))
    }

    fn by_key(&mut self, ctx: &mut Ctx, q: &Query, order: &dyn SortKey) -> StoreResult<Found> {
        let after = match &q.after {
            Some(After::Key(k, d)) => Some((k.clone(), *d)),
            _ => None,
        };
        // Sorting the matches costs a key read each; walking the order costs about page · docs / matches checks.
        let n = self.stats.n.max(1.0);
        let collect = ((q.limit.max(1) as f64 * n).sqrt() as usize).max(q.limit + 1);
        let mut docs = Vec::new();
        let mut total = 0u64;
        let mut d = 0;
        let mut stopped = None;
        let budget = ctx.work.saturating_add(q.limits.enumerate);
        loop {
            match self.next_match(ctx, d, u64::MAX, budget, None)? {
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
        let total_exact = stopped.is_none() && self.complete_joins;
        if let Some(at) = stopped {
            total = self.estimate(ctx, total, at)?;
        }
        let mut page: Vec<(Vec<u8>, u64)>;
        let mut page_exact = self.complete_joins;
        if total_exact && docs.len() <= collect {
            page = Vec::new();
            for doc in docs {
                ctx.work += SEEK;
                let k = order.key_of(ctx.view, doc)?;
                let e = (k, doc);
                if after.as_ref().is_none_or(|a| &e > a) {
                    page.push(e);
                }
            }
            page.sort();
            page.truncate(q.limit + 1);
        } else {
            page = Vec::new();
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
                        page.push(e.clone());
                        if page.len() > q.limit {
                            break 'walk;
                        }
                    }
                    from = Some(e);
                }
            }
        }
        let more = page.len() > q.limit || !page_exact;
        page.truncate(q.limit);
        Ok(Found {
            hits: page
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

/// Fields' shortest lengths per block, as read so far: the entries, and the block ranges read in full.
#[derive(Default)]
struct Shortest {
    known: HashMap<(u32, u64), u64>,
    read: Vec<(u32, u64, u64)>,
}

/// A field's shortest length in a block (0 when it has none), read with the blocks after it in one scan.
fn shortest_len(
    ctx: &mut Ctx,
    scope: Scope,
    field: u32,
    blk: u64,
    s: &mut Shortest,
) -> StoreResult<f64> {
    if !s
        .read
        .iter()
        .any(|&(f, lo, hi)| f == field && lo <= blk && blk < hi)
    {
        let prefix = shortest_all(scope, field);
        let page = ctx.scan(&shortest(scope, field, blk), &key::prefix_end(&prefix), 256)?;
        let mut hi = u64::MAX;
        for (k, v) in &page {
            let mut at = prefix.len();
            let b = u64_at(k, &mut at)?;
            s.known.insert((field, b), parse_varint(v).unwrap_or(0));
            hi = b;
        }
        // A full page reaches only as far as its last entry.
        if page.len() < 256 {
            hi = u64::MAX;
        }
        s.read.push((field, blk, hi.max(blk + 1)));
    }
    Ok(match s.known.get(&(field, blk)) {
        Some(&stored) if stored > 0 => (LENGTH_MAX - stored) as f64,
        _ => 0.0,
    })
}

/// Scores a match and keeps it if it is among the best.
type Offer<'a> = dyn Fn(&mut Plan, &mut Ctx, &mut Best, u64, &[Matched]) -> StoreResult<()> + 'a;

enum Step {
    Match(u64, Vec<Matched>),
    End,
    Stopped(u64),
}
