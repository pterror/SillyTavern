//! The reference the index is checked against: the same query answered by reading every document's text, in two
//! passes over the documents (statistics, then matches), so a library too large to hold can be streamed.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use super::query::{Clause, Filter, Query};
use super::text::{GRAM_MAX, GRAM_MIN, char_len, first_chars, tokens};
use super::{Scope, clause_score, idf, long_prefix, word_text};

/// A document: per field, its values' tokens.
pub type Fields = Vec<Vec<Vec<String>>>;

/// A document's values tokenized, with an empty field for each of the scope's fields it doesn't give.
pub fn tokenize_fields(scope: Scope, values: &[Vec<Vec<u8>>]) -> Fields {
    let mut out: Fields = values
        .iter()
        .map(|vals| vals.iter().map(|v| tokens(v)).collect())
        .collect();
    out.resize(out.len().max(scope.fields().len()), Vec::new());
    out
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
    pub fn count(&self, f: usize, term: &str, prefix: bool) -> u64 {
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

    /// Whether some field holds `term` as a whole token, or a prefix field as a prefix term: the documents a
    /// term's document count counts (`DOCS_SLOT`).
    pub fn holds(&self, term: &str) -> bool {
        self.exact
            .iter()
            .chain(&self.grams)
            .any(|m| m.contains_key(term))
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

/// A field length as scoring takes it: its length code's length.
fn quantized(len: usize) -> f64 {
    super::code_length(super::length_code(len as u64))
}

/// Per field where a clause holds: the field and its tokens' (token, frequency), in token order.
type Parts = Vec<(usize, Vec<(usize, u64)>)>;

/// A clause's tokens and how it matches.
struct Shape {
    toks: Vec<String>,
    fields: Option<Vec<u32>>,
    prefix: bool,
    phrase: bool,
    negate: bool,
    /// Restricted to the card tags field: the tags whose names it matches, carried.
    carried: Option<BTreeSet<u64>>,
    /// Over every library field: the tags whose names it matches, whose carriers it matches too.
    tagged: BTreeSet<u64>,
    /// Its tokens' idfs as the query gives them (`Query::weights`); else from the counts.
    weights: Option<Vec<f64>>,
}

impl Shape {
    fn new(
        scope: Scope,
        toks: Vec<String>,
        fields: Option<Vec<u32>>,
        last: bool,
        negate: bool,
    ) -> Shape {
        let _ = scope;
        Shape {
            prefix: last && char_len(toks.last().unwrap()) >= GRAM_MIN,
            phrase: toks.len() > 1,
            toks,
            fields,
            negate,
            carried: None,
            tagged: BTreeSet::new(),
            weights: None,
        }
    }

    fn allowed(&self, f: usize) -> bool {
        self.fields
            .as_ref()
            .is_none_or(|fs| fs.contains(&(f as u32)))
    }

    /// Whether token `i` is read as a prefix.
    fn is_prefix(&self, i: usize) -> bool {
        i == self.toks.len() - 1 && self.prefix
    }

    /// The term whose document count is token `i`'s: a prefix's first `GRAM_MAX` characters.
    fn df_term(&self, i: usize) -> String {
        if self.is_prefix(i) {
            first_chars(&self.toks[i], GRAM_MAX).to_string()
        } else {
            self.toks[i].clone()
        }
    }

    fn parts(&self, scope: Scope, doc: &Doc) -> Parts {
        let mut out = Vec::new();
        for f in (0..scope.fields().len()).filter(|&f| self.allowed(f)) {
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
                // A prefix longer than the prefix terms is counted on the whole prefix.
                let tf = doc.count(f, tok, self.is_prefix(i) && scope.fields()[f].prefix);
                if tf > 0 {
                    ps.push((i, tf));
                }
            }
            if self.phrase || !ps.is_empty() {
                out.push((f, ps));
            }
        }
        out
    }

    /// Each token's idf.
    fn idfs(&self, stats: &Stats) -> Vec<f64> {
        if let Some(w) = &self.weights {
            return w.clone();
        }
        (0..self.toks.len())
            .map(|i| idf(stats.df[&self.df_term(i)] as f64, stats.n))
            .collect()
    }

    /// The clause's score, `tagged` when the document carries a tag whose name holds it.
    fn score(&self, scope: Scope, stats: &Stats, parts: &Parts, doc: &Doc, tagged: bool) -> f64 {
        let texts: Vec<f64> = (0..self.toks.len())
            .map(|i| {
                word_text(
                    scope,
                    parts.iter().filter_map(|(f, ps)| {
                        let &(_, tf) = ps.iter().find(|p| p.0 == i)?;
                        let len = quantized(doc.fields[*f].iter().map(Vec::len).sum::<usize>());
                        Some((*f as u32, tf, len))
                    }),
                    long_prefix(self.phrase, self.is_prefix(i), &self.toks[i]),
                )
            })
            .collect();
        clause_score(&self.idfs(stats), &texts, tagged)
    }
}

/// The documents with text, and each word's document count.
struct Stats {
    n: f64,
    df: HashMap<String, u64>,
}

impl Stats {
    fn new(terms: &[String]) -> Stats {
        Stats {
            n: 0.0,
            df: terms.iter().map(|t| (t.clone(), 0)).collect(),
        }
    }

    fn add(&mut self, doc: &Doc) {
        let any = doc.fields.iter().flatten().any(|v| !v.is_empty());
        self.n += f64::from(u8::from(any));
        for (t, df) in &mut self.df {
            if doc.holds(t) {
                *df += 1;
            }
        }
    }
}

/// One query checked over streamed documents: `stats` with every document, then `matches` with every one again.
pub struct Checker {
    q: Query,
    shapes: Vec<Shape>,
    stats: Stats,
    /// Carriers per tag, counted in the first pass.
    pub carriers: HashMap<u64, u64>,
    best: Vec<(u64, f64)>,
    keep: usize,
    total: u64,
    /// The matches every positive clause matches by a tag name alone.
    pub tied: BTreeSet<u64>,
    /// Their score, when every positive clause matches tag names.
    pub tie: Option<f64>,
}

impl Checker {
    /// `tags`: every tag's name. Keeps the best `keep` matches.
    pub fn new(q: &Query, tags: &BTreeMap<u64, Vec<u8>>, keep: usize) -> Checker {
        let scope = q.scope;
        let last = q
            .clauses
            .iter()
            .rposition(|c| !tokens(&c.text).is_empty())
            .filter(|&i| !q.clauses[i].quoted);
        let tags_field = (scope == Scope::LIBRARY)
            .then(|| scope.fields().iter().position(|d| d.name == "tags"))
            .flatten()
            .map(|f| f as u32);
        let mut shapes = Vec::new();
        for (i, c) in q.clauses.iter().enumerate() {
            let toks = tokens(&c.text);
            if !toks.is_empty() {
                let mut s = Shape::new(scope, toks, c.fields.clone(), Some(i) == last, c.negate);
                let named: BTreeSet<u64> = tags
                    .iter()
                    .filter(|(_, name)| occurs(&tokens(name), &s.toks, s.prefix))
                    .map(|(&t, _)| t)
                    .collect();
                if let (Some(t), Some(fs)) = (tags_field, &c.fields)
                    && !fs.is_empty()
                    && fs.iter().all(|&f| f == t)
                {
                    s.carried = Some(named);
                } else if scope == Scope::LIBRARY && c.fields.is_none() {
                    s.tagged = named;
                }
                shapes.push(s);
            }
        }
        // The query's idfs, to each positive clause that scores in order.
        if let Some(w) = q.weights.as_ref().filter(|w| !w.is_empty()) {
            let mut at = 0;
            for s in shapes.iter_mut().filter(|s| !s.negate && s.carried.is_none()) {
                s.weights = Some(w[at..at + s.toks.len()].to_vec());
                at += s.toks.len();
            }
            assert_eq!(at, w.len(), "a weight per scoring token");
        }
        let mut terms: Vec<String> = shapes
            .iter()
            .filter(|s| s.carried.is_none())
            .flat_map(|s| (0..s.toks.len()).map(|i| s.df_term(i)))
            .collect();
        terms.sort();
        terms.dedup();
        Checker {
            q: q.clone(),
            stats: Stats::new(&terms),
            shapes,
            carriers: HashMap::new(),
            best: Vec::new(),
            keep,
            total: 0,
            tied: BTreeSet::new(),
            tie: None,
        }
    }

    /// First pass: one document with its tags.
    pub fn stats(&mut self, doc: &Doc, tags: &BTreeSet<u64>) {
        self.stats.add(doc);
        for t in tags {
            *self.carriers.entry(*t).or_default() += 1;
        }
    }

    /// What a carrier of a clause's tags scores by them alone (0 when they have none).
    fn boost(&self, s: &Shape) -> f64 {
        if !s
            .tagged
            .iter()
            .any(|t| self.carriers.get(t).is_some_and(|&c| c > 0))
        {
            return 0.0;
        }
        clause_score(&s.idfs(&self.stats), &vec![0.0; s.toks.len()], true)
    }

    /// Second pass: document `id` with its tags.
    pub fn matches(&mut self, id: u64, doc: &Doc, tags: &BTreeSet<u64>) {
        let scope = self.q.scope;
        let mut score = 0.0;
        let mut positive = false;
        // Every positive clause matches tag names, and the document by them alone.
        let positives = self
            .shapes
            .iter()
            .filter(|s| !s.negate && s.carried.is_none());
        let ties = positives.clone().count() > 0 && positives.clone().all(|s| self.boost(s) > 0.0);
        let mut tie = 0.0;
        let mut tied = ties;
        for s in &self.shapes {
            if let Some(carried) = &s.carried {
                if carried.iter().any(|t| tags.contains(t)) == s.negate {
                    return;
                }
                positive |= !s.negate;
                continue;
            }
            let boost = self.boost(s);
            let carrier = boost > 0.0 && s.tagged.iter().any(|t| tags.contains(t));
            let parts = s.parts(scope, doc);
            let hit = !parts.is_empty() || carrier;
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
            tied &= parts.is_empty();
            score += s.score(scope, &self.stats, &parts, doc, carrier);
            tie += boost;
        }
        if ties {
            self.tie = Some(tie);
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
                Filter::Check(_) => unimplemented!("the reference has no document checks"),
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
        if tied {
            self.tied.insert(id);
        }
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
    let corpus = if q.scope == Scope::TAGS {
        &w.tags
    } else {
        &w.library
    };
    let docs: BTreeMap<u64, Fields> = corpus
        .docs
        .iter()
        .map(|(&d, f)| (d, tokenize_fields(q.scope, f)))
        .collect();
    // Documents without text match by the tags they carry.
    let mut ids: BTreeSet<u64> = docs.keys().copied().collect();
    if q.scope == Scope::LIBRARY {
        ids.extend(w.members.keys());
    }
    for f in &q.filters {
        if let Filter::Ids(x) = f {
            ids.extend(x);
        }
    }
    let empty: Fields = vec![Vec::new(); q.scope.fields().len()];
    let none = BTreeSet::new();
    let names: BTreeMap<u64, Vec<u8>> = w
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
    let mut c = Checker::new(q, &names, usize::MAX);
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
