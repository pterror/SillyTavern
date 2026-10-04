//! The reference the index is checked against: the same query answered by reading every document's text, in two
//! passes over the documents (statistics, then matches), so a library too large to hold can be streamed.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use super::query::{Clause, Filter, Query};
use super::text::{GRAM_MAX, GRAM_MIN, char_len, first_chars, tokens};
use super::{Scope, idf, tf_norm};

/// A document: per field, its values' tokens.
pub type Fields = Vec<Vec<Vec<String>>>;

pub fn tokenize_fields(values: &[Vec<Vec<u8>>]) -> Fields {
    values
        .iter()
        .map(|vals| vals.iter().map(|v| tokens(v)).collect())
        .collect()
}

/// One scope's documents: per document, per field, its values.
#[derive(Default, Clone)]
pub struct Corpus {
    pub docs: BTreeMap<u64, Vec<Vec<Vec<u8>>>>,
}

/// The library, the tag names, and which tags each entity carries.
#[derive(Default, Clone)]
pub struct World {
    pub library: Corpus,
    pub tags: Corpus,
    pub members: BTreeMap<u64, BTreeSet<u64>>,
}

/// A document's tokens counted, per field: whole tokens, and their first 2–20 characters.
pub struct Doc<'a> {
    pub fields: &'a Fields,
    exact: Vec<HashMap<&'a str, u64>>,
    grams: Vec<HashMap<&'a str, u64>>,
}

impl<'a> Doc<'a> {
    /// Prefix terms are counted in the scope's prefix fields only.
    pub fn new(fields: &'a Fields, scope: Scope) -> Doc<'a> {
        let mut exact = Vec::with_capacity(fields.len());
        let mut grams = Vec::with_capacity(fields.len());
        for (f, vals) in fields.iter().enumerate() {
            let prefix = scope.fields().get(f).is_some_and(|d| d.prefix);
            let mut e: HashMap<&str, u64> = HashMap::new();
            let mut g: HashMap<&str, u64> = HashMap::new();
            for t in vals.iter().flatten() {
                *e.entry(t.as_str()).or_default() += 1;
                if prefix {
                    for p in super::text::grams(t) {
                        *g.entry(p).or_default() += 1;
                    }
                }
            }
            exact.push(e);
            grams.push(g);
        }
        Doc {
            fields,
            exact,
            grams,
        }
    }

    /// A term's matches in field `f`: whole tokens, or (`prefix`) tokens starting with it.
    fn count(&self, f: usize, term: &str, prefix: bool) -> u64 {
        if !prefix {
            return self.exact[f].get(term).copied().unwrap_or(0);
        }
        if char_len(term) <= GRAM_MAX {
            return self.grams[f].get(term).copied().unwrap_or(0);
        }
        self.fields[f]
            .iter()
            .flatten()
            .filter(|t| t.starts_with(term))
            .count() as u64
    }
}

fn occurs(toks: &[String], phrase: &[String], prefix: bool) -> bool {
    let last = phrase.len() - 1;
    toks.len() >= phrase.len()
        && toks.windows(phrase.len()).any(|w| {
            (0..phrase.len()).all(|i| {
                if i == last && prefix {
                    w[i].starts_with(phrase[i].as_str())
                } else {
                    w[i] == phrase[i]
                }
            })
        })
}

/// A statistics key: (field, term, whether a prefix term).
type Key = (usize, String, bool);

/// Per field where a clause holds: the field and its terms' (key, frequency), in token order.
type Parts = Vec<(usize, Vec<(Key, u64)>)>;

/// A clause's tokens and how it matches.
struct Shape {
    toks: Vec<String>,
    fields: Option<Vec<u32>>,
    prefix: bool,
    phrase: bool,
    negate: bool,
    /// Matches through the joined field too.
    joined: Option<u32>,
}

impl Shape {
    fn new(
        scope: Scope,
        toks: Vec<String>,
        fields: Option<Vec<u32>>,
        last: bool,
        negate: bool,
    ) -> Shape {
        let defs = scope.fields();
        let joined = (0..defs.len() as u32)
            .find(|&f| defs[f as usize].joined && fields.as_ref().is_none_or(|fs| fs.contains(&f)));
        Shape {
            prefix: last && char_len(toks.last().unwrap()) >= GRAM_MIN,
            phrase: toks.len() > 1,
            toks,
            fields,
            negate,
            joined,
        }
    }

    fn allowed(&self, scope: Scope, f: usize) -> bool {
        !scope.fields()[f].joined
            && self
                .fields
                .as_ref()
                .is_none_or(|fs| fs.contains(&(f as u32)))
    }

    /// The term token `i` is looked up as in field `f`, and whether as a prefix term.
    fn term(&self, scope: Scope, i: usize, f: usize) -> Key {
        if i == self.toks.len() - 1 && self.prefix && scope.fields()[f].prefix {
            (f, first_chars(&self.toks[i], GRAM_MAX).to_string(), true)
        } else {
            (f, self.toks[i].clone(), false)
        }
    }

    fn parts(&self, scope: Scope, doc: &Doc) -> Parts {
        let mut out = Vec::new();
        for f in (0..scope.fields().len()).filter(|&f| self.allowed(scope, f)) {
            let vals = &doc.fields[f];
            if self.phrase
                && (self.toks[..self.toks.len() - 1]
                    .iter()
                    .any(|t| doc.count(f, t, false) == 0)
                    || !vals.iter().any(|v| occurs(v, &self.toks, self.prefix)))
            {
                continue;
            }
            let mut ps = Vec::new();
            for (i, tok) in self.toks.iter().enumerate() {
                let k = self.term(scope, i, f);
                // A prefix longer than the prefix terms is counted on the whole prefix.
                let tf = doc.count(f, tok, k.2);
                if tf > 0 {
                    ps.push((k, tf));
                }
            }
            if self.phrase || !ps.is_empty() {
                out.push((f, ps));
            }
        }
        out
    }

    fn keys(&self, scope: Scope) -> Vec<Key> {
        (0..scope.fields().len())
            .filter(|&f| self.allowed(scope, f))
            .flat_map(|f| (0..self.toks.len()).map(move |i| self.term(scope, i, f)))
            .collect()
    }
}

struct Stats {
    n: f64,
    tokens: Vec<u64>,
    df: HashMap<Key, u64>,
}

impl Stats {
    fn new(fields: usize, keys: &[Key]) -> Stats {
        Stats {
            n: 0.0,
            tokens: vec![0; fields],
            df: keys.iter().map(|k| (k.clone(), 0)).collect(),
        }
    }

    fn add(&mut self, doc: &Doc) {
        let mut any = false;
        for (f, vals) in doc.fields.iter().enumerate() {
            let n: usize = vals.iter().map(Vec::len).sum();
            self.tokens[f] += n as u64;
            any |= n > 0;
        }
        self.n += f64::from(u8::from(any));
        for (k, df) in &mut self.df {
            if doc.count(k.0, &k.1, k.2) > 0 {
                *df += 1;
            }
        }
    }

    fn avg(&self, f: usize) -> f64 {
        if self.n > 0.0 {
            self.tokens[f] as f64 / self.n
        } else {
            0.0
        }
    }

    fn score(&self, scope: Scope, parts: &Parts, doc: &Doc) -> f64 {
        let mut s = 0.0;
        for (f, ps) in parts {
            let len = doc.fields[*f].iter().map(Vec::len).sum::<usize>() as f64;
            for (k, tf) in ps {
                s += scope.fields()[*f].weight
                    * idf(self.df[k] as f64, self.n)
                    * tf_norm(*tf as f64, len, self.avg(*f));
            }
        }
        s
    }
}

/// One query checked over streamed documents: `stats` with every document, then `matches` with every one again.
pub struct Checker {
    q: Query,
    shapes: Vec<Shape>,
    stats: Stats,
    /// Per clause matching through the joined field: the tags whose names match, with their parts.
    tag_hits: Vec<Option<BTreeMap<u64, Parts>>>,
    tag_stats: Stats,
    tag_lens: BTreeMap<u64, f64>,
    /// Carriers per tag, counted in the first pass.
    carriers: HashMap<u64, u64>,
    best: Vec<(u64, f64)>,
    keep: usize,
    total: u64,
}

impl Checker {
    /// `tags`: every tag's name. Keeps the best `keep` matches.
    pub fn new(q: &Query, tags: &BTreeMap<u64, Vec<u8>>, keep: usize) -> Checker {
        let scope = q.scope;
        let last = q.clauses.iter().rposition(|c| !tokens(&c.text).is_empty());
        let mut shapes = Vec::new();
        for (i, c) in q.clauses.iter().enumerate() {
            let toks = tokens(&c.text);
            if !toks.is_empty() {
                shapes.push(Shape::new(
                    scope,
                    toks,
                    c.fields.clone(),
                    Some(i) == last,
                    c.negate,
                ));
            }
        }
        let mut keys: Vec<Key> = shapes.iter().flat_map(|s| s.keys(scope)).collect();
        keys.sort();
        keys.dedup();
        let tag_docs: BTreeMap<u64, Fields> = tags
            .iter()
            .map(|(&t, name)| (t, vec![vec![tokens(name)]]))
            .collect();
        let tag_shapes: Vec<Option<Shape>> = shapes
            .iter()
            .map(|s| {
                s.joined
                    .map(|_| Shape::new(Scope::TAGS, s.toks.clone(), None, s.prefix, false))
            })
            .collect();
        let mut tag_keys: Vec<Key> = tag_shapes
            .iter()
            .flatten()
            .flat_map(|s| s.keys(Scope::TAGS))
            .collect();
        tag_keys.sort();
        tag_keys.dedup();
        let mut tag_stats = Stats::new(1, &tag_keys);
        let mut tag_hits: Vec<Option<BTreeMap<u64, Parts>>> = tag_shapes
            .iter()
            .map(|ts| ts.as_ref().map(|_| BTreeMap::new()))
            .collect();
        if !tag_keys.is_empty() {
            for (&t, d) in &tag_docs {
                let d = Doc::new(d, Scope::TAGS);
                tag_stats.add(&d);
                for (ts, hits) in tag_shapes.iter().zip(&mut tag_hits) {
                    if let (Some(ts), Some(hits)) = (ts, hits) {
                        let p = ts.parts(Scope::TAGS, &d);
                        if !p.is_empty() {
                            hits.insert(t, p);
                        }
                    }
                }
            }
        }
        let tag_lens = tag_docs
            .iter()
            .map(|(&t, d)| (t, d[0].iter().map(Vec::len).sum::<usize>() as f64))
            .collect();
        Checker {
            q: q.clone(),
            stats: Stats::new(scope.fields().len(), &keys),
            shapes,
            tag_hits,
            tag_stats,
            tag_lens,
            carriers: HashMap::new(),
            best: Vec::new(),
            keep,
            total: 0,
        }
    }

    /// First pass: one document with its tags.
    pub fn stats(&mut self, doc: &Doc, tags: &BTreeSet<u64>) {
        self.stats.add(doc);
        for t in tags {
            *self.carriers.entry(*t).or_default() += 1;
        }
    }

    /// Second pass: document `id` with its tags.
    pub fn matches(&mut self, id: u64, doc: &Doc, tags: &BTreeSet<u64>) {
        let scope = self.q.scope;
        let mut score = 0.0;
        let mut positive = false;
        for (i, s) in self.shapes.iter().enumerate() {
            let parts = s.parts(scope, doc);
            let mut hit = !parts.is_empty();
            let mut x = self.stats.score(scope, &parts, doc);
            if let (Some(jf), Some(th)) = (s.joined, &self.tag_hits[i]) {
                let dfj: u64 = th
                    .keys()
                    .map(|t| self.carriers.get(t).copied().unwrap_or(0))
                    .sum();
                let idf_j = idf((dfj as f64).min(self.stats.n), self.stats.n);
                let w = scope.fields()[jf as usize].weight;
                let mut joined = 0.0;
                for (t, tp) in th.iter().filter(|(t, _)| tags.contains(t)) {
                    hit = true;
                    let len = self.tag_lens[t];
                    let mut st = 0.0;
                    for (_, ps) in tp {
                        for (_, tf) in ps {
                            st += w * idf_j * tf_norm(*tf as f64, len, self.tag_stats.avg(0));
                        }
                    }
                    joined += st;
                }
                x += joined;
            }
            if s.negate {
                if hit {
                    return;
                }
                continue;
            }
            if !hit {
                return;
            }
            positive = true;
            score += x;
        }
        let mut included = false;
        for f in &self.q.filters {
            let ok = match f {
                Filter::AllTags(ts) => {
                    included |= !ts.is_empty();
                    ts.iter().all(|t| tags.contains(t))
                }
                Filter::AnyTag(ts) => {
                    included = true;
                    ts.iter().any(|t| tags.contains(t))
                }
                Filter::NoTag(ts) => !ts.iter().any(|t| tags.contains(t)),
                Filter::Ids(ids) => {
                    included = true;
                    ids.contains(&id)
                }
                Filter::NotIds(ids) => !ids.contains(&id),
            };
            if !ok {
                return;
            }
        }
        // With nothing else to match, every document with text does.
        if !positive && !included && !doc.fields.iter().flatten().any(|v| !v.is_empty()) {
            return;
        }
        self.total += 1;
        self.best.push((id, score));
        if self.best.len() >= self.keep.saturating_mul(2).max(1024) {
            self.trim();
        }
    }

    fn trim(&mut self) {
        self.best
            .sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        self.best.truncate(self.keep);
    }

    /// The best matches, best first, and the number of matches.
    pub fn result(mut self) -> (Vec<(u64, f64)>, u64) {
        self.trim();
        (self.best, self.total)
    }
}

/// An in-memory world's answer: every match, best first, and their number.
pub fn search(w: &World, q: &Query) -> (Vec<(u64, f64)>, u64) {
    let tag_names: BTreeMap<u64, Vec<u8>> = w
        .tags
        .docs
        .iter()
        .map(|(&t, f)| {
            (
                t,
                f.first()
                    .and_then(|v| v.first())
                    .cloned()
                    .unwrap_or_default(),
            )
        })
        .collect();
    let corpus = if q.scope == Scope::TAGS {
        &w.tags
    } else {
        &w.library
    };
    let docs: BTreeMap<u64, Fields> = corpus
        .docs
        .iter()
        .map(|(&d, f)| (d, tokenize_fields(f)))
        .collect();
    let mut ids: BTreeSet<u64> = docs.keys().copied().collect();
    for f in &q.filters {
        if let Filter::Ids(x) = f {
            ids.extend(x);
        }
    }
    let empty: Fields = vec![Vec::new(); q.scope.fields().len()];
    let none = BTreeSet::new();
    let mut c = Checker::new(q, &tag_names, usize::MAX);
    for d in &ids {
        c.stats(
            &Doc::new(docs.get(d).unwrap_or(&empty), q.scope),
            w.members.get(d).unwrap_or(&none),
        );
    }
    for d in &ids {
        c.matches(
            *d,
            &Doc::new(docs.get(d).unwrap_or(&empty), q.scope),
            w.members.get(d).unwrap_or(&none),
        );
    }
    c.result()
}

/// A clause from text.
pub fn clause(text: &str, fields: Option<Vec<u32>>, negate: bool, quoted: bool) -> Clause {
    Clause {
        text: text.as_bytes().to_vec(),
        fields,
        negate,
        quoted,
    }
}
