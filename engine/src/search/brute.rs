//! The reference the index is checked against: the same query answered by reading every document's text, in two
//! passes over the documents (statistics, then matches), so a library too large to hold can be streamed.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use super::query::{Clause, Filter, Query};
use super::text::{GRAM_MAX, GRAM_MIN, char_len, first_chars, tokens};
use super::{Scope, idf, tf_norm};

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
    /// Restricted to the card tags field: the tags whose names it matches, carried.
    carried: Option<BTreeSet<u64>>,
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
        }
    }

    fn allowed(&self, f: usize) -> bool {
        self.fields
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
            .filter(|&f| self.allowed(f))
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
            let len = quantized(doc.fields[*f].iter().map(Vec::len).sum::<usize>());
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
    /// Carriers per tag, counted in the first pass.
    pub carriers: HashMap<u64, u64>,
    best: Vec<(u64, f64)>,
    keep: usize,
    total: u64,
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
                if let (Some(t), Some(fs)) = (tags_field, &c.fields)
                    && !fs.is_empty()
                    && fs.iter().all(|&f| f == t)
                {
                    s.carried = Some(
                        tags.iter()
                            .filter(|(_, name)| occurs(&tokens(name), &s.toks, s.prefix))
                            .map(|(&t, _)| t)
                            .collect(),
                    );
                }
                shapes.push(s);
            }
        }
        let mut keys: Vec<Key> = shapes
            .iter()
            .filter(|s| s.carried.is_none())
            .flat_map(|s| s.keys(scope))
            .collect();
        keys.sort();
        keys.dedup();
        Checker {
            q: q.clone(),
            stats: Stats::new(scope.fields().len(), &keys),
            shapes,
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
        for s in &self.shapes {
            if let Some(carried) = &s.carried {
                if carried.iter().any(|t| tags.contains(t)) == s.negate {
                    return;
                }
                positive |= !s.negate;
                continue;
            }
            let parts = s.parts(scope, doc);
            let hit = !parts.is_empty();
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
            score += self.stats.score(scope, &parts, doc);
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
    let mut ids: BTreeSet<u64> = docs.keys().copied().collect();
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

/// The tags whose names match a library query (`query::Found::tags`), best first: by reading every name.
pub fn tag_matches(
    q: &Query,
    names: &BTreeMap<u64, Vec<u8>>,
    carriers: &HashMap<u64, u64>,
) -> Vec<u64> {
    let tags_field = Scope::LIBRARY
        .fields()
        .iter()
        .position(|d| d.name == "tags")
        .unwrap() as u32;
    let mut clauses = Vec::new();
    for c in &q.clauses {
        if tokens(&c.text).is_empty() {
            continue;
        }
        if c.fields
            .as_ref()
            .is_some_and(|fs| !fs.contains(&tags_field))
        {
            return Vec::new();
        }
        clauses.push(c.clone());
    }
    if !clauses.iter().any(|c| !c.negate) {
        return Vec::new();
    }
    let last = clauses.len() - 1;
    let words: Vec<Vec<String>> = clauses
        .iter()
        .filter(|c| !c.negate)
        .map(|c| tokens(&c.text))
        .collect();
    let all: Vec<String> = words.iter().flatten().cloned().collect();
    let mut found = Vec::new();
    for (&tag, name) in names {
        let toks = tokens(name);
        let holds = |c: &Clause, i: usize| {
            let t = tokens(&c.text);
            occurs(
                &toks,
                &t,
                i == last && !c.quoted && char_len(t.last().unwrap()) >= GRAM_MIN,
            )
        };
        if !clauses
            .iter()
            .enumerate()
            .all(|(i, c)| holds(c, i) != c.negate)
        {
            continue;
        }
        let quality = if toks == all {
            0
        } else if words.iter().all(|w| occurs(&toks, w, false)) {
            1
        } else {
            2
        };
        found.push((
            quality,
            std::cmp::Reverse(carriers.get(&tag).copied().unwrap_or(0)),
            tag,
        ));
    }
    found.sort();
    found.into_iter().take(5).map(|x| x.2).collect()
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
