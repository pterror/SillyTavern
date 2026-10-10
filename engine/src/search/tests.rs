use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use super::Scope;
use super::brute::{self, World, clause};
use super::query::{After, Clause, Filter, Found, Limits, Order, Query, SortKey};
use crate::keyspace::KsConfig;
use crate::keyspace::pool::Pool;
use crate::keyspace::val::get_u64;
use crate::log;
use crate::log::format::{FieldRef, Record, Value, kind_by_name, wtf8_from_utf16};
use crate::store::derive::View;
use crate::store::kinds::{ITEM_SEPARATOR, key, parse_loc, test_codes};
use crate::store::{Store, StoreConfig, StoreResult};

/// The phrase structures are a process-wide switch: tests here take turns.
fn turn() -> std::sync::MutexGuard<'static, ()> {
    static TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());
    TURN.lock().unwrap_or_else(|e| e.into_inner())
}

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-search-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

const SMALL: StoreConfig = StoreConfig {
    log: log::Config {
        block_size: 256,
        file_target: 8192,
    },
    ks: KsConfig {
        log_bytes: 16 << 10,
        fan_in: 3,
        block_size: 512,
        max_frozen: 1,
    },
    live_fraction: 0.5,
    relocate_bytes: 1024,
};

fn open(dir: &Path) -> Store {
    Store::open_in(dir, SMALL, Pool::new(32 << 10, 64 << 10, 4, 1, 2, 2)).unwrap()
}

fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
}

fn wtf8(s: &str) -> Vec<u8> {
    wtf8_from_utf16(&s.encode_utf16().collect::<Vec<_>>())
}

fn text_value(e: u64, code: u64, s: &str) -> Record {
    rec(
        "textValue",
        vec![
            Value::Sel(0, e),
            Value::Field(FieldRef::Code(code)),
            Value::Text(wtf8(s)),
            Value::Absent,
            Value::Absent,
        ],
    )
}

fn assign(e: u64, tag: u64, on: bool) -> Record {
    rec(
        "tagAssign",
        vec![Value::Id(e), Value::Id(tag), Value::Bit(on)],
    )
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    fn pick<'a>(&mut self, xs: &'a [&'a str]) -> &'a str {
        xs[self.below(xs.len() as u64) as usize]
    }
}

const WORDS: &[&str] = &[
    "the",
    "dragon",
    "Drake",
    "drama",
    "dark",
    "knight",
    "Knights",
    "girl",
    "vampire",
    "vampires",
    "Élodie",
    "elodie",
    "café",
    "CAFE",
    "foo-bar",
    "o'neil",
    "{{char}}",
    "a",
    "i",
    "x9",
    "supercalifragilisticexpialidocious",
    "supercalifragilisticexpialidocia",
    "love",
    "lovely",
    "東京タワー",
    "naïve",
    "Straße",
    "the.",
    "knight,",
    "dr",
];

fn sentence(r: &mut Rng, n: u64) -> String {
    (0..n).map(|_| r.pick(WORDS)).collect::<Vec<_>>().join(" ")
}

/// A store and the same documents in memory.
struct Lib {
    store: Store,
    world: World,
}

impl Lib {
    fn set(&mut self, doc: u64, field: usize, values: &[String]) {
        let code = test_codes::LIBRARY + field as u64;
        let joined = values.join(std::str::from_utf8(&[ITEM_SEPARATOR]).unwrap());
        self.store
            .commit_wait(vec![text_value(doc, code, &joined)])
            .unwrap();
        let d = self
            .world
            .library
            .docs
            .entry(doc)
            .or_insert_with(|| vec![Vec::new(); 10]);
        d[field] = if joined.is_empty() {
            Vec::new()
        } else {
            values.iter().map(|v| v.as_bytes().to_vec()).collect()
        };
    }

    fn tag(&mut self, tag: u64, name: &str) {
        self.store
            .commit_wait(vec![text_value(tag, test_codes::TAG_NAME, name)])
            .unwrap();
        self.world
            .tags
            .docs
            .insert(tag, vec![vec![name.as_bytes().to_vec()]]);
    }

    fn assign(&mut self, e: u64, tag: u64, on: bool) {
        self.store.commit_wait(vec![assign(e, tag, on)]).unwrap();
        let s = self.world.members.entry(e).or_default();
        if on {
            s.insert(tag);
        } else {
            s.remove(&tag);
        }
    }
}

fn build(dir: &Path, seed: u64, docs: u64) -> Lib {
    let mut r = Rng(seed);
    let mut lib = Lib {
        store: open(dir),
        world: World::default(),
    };
    for t in 1..=12 {
        let n = 1 + r.below(2);
        let name = sentence(&mut r, n);
        lib.tag(t, &name);
    }
    for _ in 0..docs {
        // Spread over several score blocks.
        let doc = 1 + r.below(1500);
        for f in [0usize, 1, 2, 3, 7, 8] {
            let n = if f == 0 || f == 7 {
                1 + r.below(3)
            } else {
                r.below(12)
            };
            lib.set(doc, f, &[sentence(&mut r, n)]);
        }
        let items: Vec<String> = (0..r.below(3))
            .map(|_| {
                let n = 1 + r.below(5);
                sentence(&mut r, n)
            })
            .collect();
        lib.set(doc, 9, &items);
        for _ in 0..r.below(3) {
            lib.assign(doc, 1 + r.below(12), true);
        }
    }
    lib
}

fn queries() -> Vec<Vec<Clause>> {
    let c = |t: &str| clause(t, None, false, false);
    vec![
        vec![c("dr")],
        vec![c("dra")],
        vec![c("d")],
        vec![c("the")],
        vec![c("Dragon")],
        vec![c("the"), c("knight")],
        vec![c("knight"), c("the")],
        vec![c("elodie")],
        vec![c("cafe"), c("dra")],
        vec![c("foo-bar")],
        vec![c("o'neil")],
        vec![c("{{char}}")],
        vec![clause("dark knight", None, false, true)],
        vec![clause("dark kni", None, false, true)],
        vec![clause("the dr", None, false, true), c("love")],
        vec![c("love"), clause("the dr", None, false, true)],
        vec![c("supercalifragilisticexpialidocious")],
        vec![c("supercalifragilisticexpialidoci")],
        vec![c("supercalifragilisticex")],
        vec![clause("dra", Some(vec![0]), false, false)],
        vec![clause("dra", Some(vec![1]), false, false)],
        vec![clause("dra", Some(vec![8]), false, false)],
        vec![clause("dragon", Some(vec![8]), false, false), c("the")],
        vec![c("the"), clause("dark", Some(vec![8]), true, false)],
        vec![clause("dark knight", Some(vec![8]), false, true)],
        vec![c("the"), clause("vampire", None, true, false)],
        vec![clause("dragon", None, true, false)],
        vec![c("strasse")],
        vec![c("straße")],
        vec![c("naive"), c("東京タワー")],
        vec![c("love"), clause("la", None, true, false)],
        vec![clause("dragon", None, false, true)],
        vec![c("x9"), c("i")],
        vec![c("lovely"), clause("knight the", None, false, true)],
    ]
}

fn query(clauses: Vec<Clause>, limit: usize) -> Query {
    Query {
        scope: Scope::LIBRARY,
        clauses,
        filters: Vec::new(),
        order: Order::Relevance,
        limit,
        after: None,
        limits: Limits::default(),
    }
}

/// Every page of a query, following `more`.
fn pages(s: &Store, q: &Query) -> (Vec<(u64, f64)>, Found) {
    let mut q = q.clone();
    let mut all = Vec::new();
    let first = s.search(&q).unwrap();
    let mut f = first.clone();
    loop {
        all.extend(f.hits.iter().map(|h| (h.doc, h.score)));
        if !f.more || f.hits.is_empty() {
            break;
        }
        let last = f.hits.last().unwrap();
        q.after = Some(match &q.order {
            Order::Relevance => After::Score(last.score, last.doc),
            Order::Key(_) => After::Key(last.key.clone().unwrap(), last.doc),
        });
        f = s.search(&q).unwrap();
    }
    (all, first)
}

fn check(lib: &Lib, q: &Query) {
    let (want, total) = brute::search(&lib.world, q);
    let (got, first) = pages(&lib.store, q);
    assert!(first.page_exact, "{q:?}");
    if first.total_exact {
        assert_eq!(first.total, total, "total of {:?}", describe(q));
    }
    if got != want {
        let i = got
            .iter()
            .zip(&want)
            .position(|(a, b)| a != b)
            .unwrap_or(got.len().min(want.len()));
        panic!(
            "hits of {:?} differ at {i} of {} / {}: got {:?}, want {:?}",
            describe(q),
            got.len(),
            want.len(),
            &got[i.saturating_sub(2)..(i + 3).min(got.len())],
            &want[i.saturating_sub(2)..(i + 3).min(want.len())],
        );
    }
    let names = lib
        .world
        .tags
        .docs
        .iter()
        .map(|(&t, f)| (t, f[0][0].clone()))
        .collect();
    let mut carriers = std::collections::HashMap::new();
    for tags in lib.world.members.values() {
        for t in tags {
            *carriers.entry(*t).or_default() += 1;
        }
    }
    let want_tags = if q.scope == Scope::LIBRARY {
        brute::tag_matches(q, &names, &carriers)
    } else {
        Vec::new()
    };
    assert!(first.tags_exact, "{q:?}");
    let got_tags: Vec<u64> = first.tags.iter().map(|t| t.tag).collect();
    assert_eq!(got_tags, want_tags, "tags of {:?}", describe(q));
    for t in &first.tags {
        assert_eq!(t.name, names[&t.tag]);
        assert_eq!(t.carriers, carriers.get(&t.tag).copied().unwrap_or(0));
    }
}

/// Every top list of `terms` that is built holds exactly the documents whose score at its parameters ranks above
/// its floor, with their counts and length codes.
fn check_lists(lib: &Lib, terms: &[&str]) {
    use super::top::{Head, decode_fields, parse_rank, score_at};
    use super::{length_code, top, top_entries};
    for &term in terms {
        let Some(head) = lib
            .store
            .get(&top(Scope::LIBRARY, term))
            .unwrap()
            .and_then(|b| Head::decode(&b))
        else {
            continue;
        };
        let generation = lib
            .store
            .get(&super::top_generation(Scope::LIBRARY, term))
            .unwrap()
            .and_then(|b| crate::keyspace::val::counter_value(&b))
            .unwrap_or(0) as u64;
        if head.generation != generation {
            continue;
        }
        let prefix = top_entries(Scope::LIBRARY, term);
        let mut got: Vec<(u64, super::top::Fields)> = lib
            .store
            .scan(&prefix, &key::prefix_end(&prefix), usize::MAX)
            .unwrap()
            .into_iter()
            .map(|(k, v)| {
                let (_, d) = parse_rank(&k[prefix.len()..]).unwrap();
                (d, decode_fields(&v).unwrap())
            })
            .collect();
        got.sort_by_key(|x| x.0);
        let mut want = Vec::new();
        for (&doc, values) in &lib.world.library.docs {
            if head.passing.is_some_and(|b| doc >> super::BLOCK_BITS >= b) {
                continue;
            }
            let f = brute::tokenize_fields(values);
            let d = brute::Doc::new(&f, Scope::LIBRARY);
            let mut fields = Vec::new();
            for (i, def) in Scope::LIBRARY.fields().iter().enumerate() {
                let tf = d.count(i, term, def.prefix);
                if tf > 0 {
                    let len: usize = f[i].iter().map(Vec::len).sum();
                    fields.push((i as u32, tf, length_code(len as u64)));
                }
            }
            if fields.is_empty() {
                continue;
            }
            let sc = score_at(&head.params, &fields);
            if super::top::above((sc, doc), (head.floor, head.floor_doc)) {
                want.push((doc, fields));
            }
        }
        assert_eq!(got, want, "the list of {term}: {head:?}");
    }
}

type Hook = Box<dyn FnOnce()>;

thread_local! {
    /// Run once by a query of this thread when it reaches the named point of its read: "list" between a top
    /// list's head and its entries, "word" after a word's first document read whole, "walk" at a walk's first
    /// match.
    static HOOKS: std::cell::RefCell<Vec<(&'static str, Hook)>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

pub(super) fn hook(at: &str) {
    let f = HOOKS.with(|h| {
        let mut h = h.borrow_mut();
        let i = h.iter().position(|x| x.0 == at)?;
        Some(h.remove(i).1)
    });
    if let Some(f) = f {
        f();
    }
}

fn on(at: &'static str, f: impl FnOnce() + 'static) {
    HOOKS.with(|h| h.borrow_mut().push((at, Box::new(f))));
}

/// Waits for every slice of a top list's pass queued so far.
fn settle(s: &Store) {
    s.commit_wait(Vec::new()).unwrap();
}

fn describe(q: &Query) -> Vec<String> {
    q.clauses
        .iter()
        .map(|c| {
            format!(
                "{}{}{:?}",
                if c.negate { "-" } else { "" },
                String::from_utf8_lossy(&c.text),
                c.fields
            )
        })
        .collect()
}

impl std::fmt::Debug for Query {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", describe(self))
    }
}

#[test]
fn results_equal_a_scan_of_every_document() {
    let _turn = turn();
    let dir = temp_dir("scan");
    let lib = build(&dir, 1, 160);
    for clauses in queries() {
        check(&lib, &query(clauses, 7));
    }
}

#[test]
fn filters_and_negations_restrict_matches() {
    let _turn = turn();
    let dir = temp_dir("filters");
    let lib = build(&dir, 2, 120);
    let c = |t: &str| clause(t, None, false, false);
    for filters in [
        vec![Filter::AllTags(vec![1, 2])],
        vec![Filter::AnyTag(vec![3, 4, 5])],
        vec![Filter::NoTag(vec![1])],
        vec![Filter::Ids((1..700).collect())],
        vec![
            Filter::NotIds((1..700).collect()),
            Filter::AnyTag(vec![2, 6]),
        ],
    ] {
        for clauses in [
            vec![],
            vec![c("the")],
            vec![c("dra")],
            vec![clause("the", None, true, false)],
        ] {
            let mut q = query(clauses, 5);
            q.filters = filters.clone();
            check(&lib, &q);
        }
    }
}

/// One random edit: a text edit, a name, a tag assignment, a tag rename or a list field.
fn random_edit(lib: &mut Lib, r: &mut Rng, docs: &[u64], i: u64) {
    let doc = docs[r.below(docs.len() as u64) as usize];
    match i % 5 {
        0 => {
            // A text edit: replace a span at character boundaries.
            let old = String::from_utf8(
                lib.world.library.docs[&doc][1]
                    .first()
                    .cloned()
                    .unwrap_or_default(),
            )
            .unwrap();
            let bounds: Vec<usize> = old
                .char_indices()
                .map(|(i, _)| i)
                .chain([old.len()])
                .collect();
            let a = bounds[r.below(bounds.len() as u64) as usize];
            let b = bounds[r.below(bounds.len() as u64) as usize].max(a);
            let ins = format!(" {} ", r.pick(WORDS));
            if old.is_empty() {
                lib.set(doc, 1, &[ins]);
                return;
            }
            lib.store
                .commit_wait(vec![rec(
                    "textEdit",
                    vec![
                        Value::Sel(0, doc),
                        Value::Field(FieldRef::Code(test_codes::LIBRARY + 1)),
                        Value::UInt(a as u64),
                        Value::UInt((b - a) as u64),
                        Value::Text(wtf8(&ins)),
                        Value::Absent,
                        Value::Absent,
                    ],
                )])
                .unwrap();
            let new = format!("{}{}{}", &old[..a], ins, &old[b..]);
            lib.world.library.docs.get_mut(&doc).unwrap()[1] = vec![new.into_bytes()];
        }
        1 => {
            let n = r.below(4);
            lib.set(doc, 0, &[sentence(r, n)]);
        }
        2 => {
            let tag = 1 + r.below(12);
            let on = r.below(2) == 0;
            lib.assign(doc, tag, on);
        }
        3 => {
            let tag = 1 + r.below(12);
            let n = 1 + r.below(2);
            let name = sentence(r, n);
            lib.tag(tag, &name);
        }
        _ => {
            let items: Vec<String> = (0..r.below(3)).map(|_| sentence(r, 2)).collect();
            lib.set(doc, 9, &items);
        }
    }
}

#[test]
fn edits_flushes_merges_and_reopening_keep_results_equal() {
    let _turn = turn();
    let dir = temp_dir("edits");
    let mut lib = build(&dir, 3, 100);
    let mut r = Rng(33);
    let docs: Vec<u64> = lib.world.library.docs.keys().copied().collect();
    for i in 0..300 {
        random_edit(&mut lib, &mut r, &docs, i);
    }
    for clauses in queries() {
        check(&lib, &query(clauses, 6));
    }
    lib.store.close();
    drop(lib.store);
    let store = open(&dir);
    let lib = Lib {
        store,
        world: lib.world,
    };
    for clauses in queries() {
        check(&lib, &query(clauses, 6));
    }
}

#[test]
fn one_word_reads_its_best_postings_first_and_other_queries_mark_what_the_limit_cut() {
    let _turn = turn();
    let dir = temp_dir("limit");
    let lib = build(&dir, 4, 200);
    let c = |t: &str| clause(t, None, false, false);
    let limits = Limits {
        enumerate: 400,
        ranked: u64::MAX,
        walked: u64::MAX,
        tags: u64::MAX,
    };
    // A word's page comes from its top list, once its pass has run, whatever the walking limit.
    for clauses in [vec![c("the")], vec![c("dr")], vec![c("vampire")]] {
        let mut q = query(clauses, 5);
        q.limits = limits;
        for _ in 0..100 {
            if lib.store.search(&q).unwrap().refill.is_none() {
                break;
            }
            settle(&lib.store);
        }
        let (want, _) = brute::search(&lib.world, &q);
        let f = lib.store.search(&q).unwrap();
        assert!(f.page_exact, "{q:?}");
        let got: Vec<(u64, f64)> = f.hits.iter().map(|h| (h.doc, h.score)).collect();
        assert_eq!(got, want[..want.len().min(5)], "{q:?}");
    }
    // Walks cut short say so.
    for clauses in [
        vec![c("knight"), c("the")],
        vec![clause("dark knight", None, false, true)],
    ] {
        let mut q = query(clauses, 5);
        q.limits = Limits {
            enumerate: 1,
            ..limits
        };
        let f = lib.store.search(&q).unwrap();
        assert!(!f.total_exact && !f.page_exact && f.more, "{q:?}");
    }
}

#[test]
fn a_words_total_is_its_counter_when_nothing_restricts_it() {
    let _turn = turn();
    let dir = temp_dir("counter");
    let lib = build(&dir, 6, 150);
    let c = |t: &str| clause(t, None, false, false);
    for w in [
        "the",
        "a",
        "knight",
        "naive",
        "x9",
        "supercalifragilisticexpialidocious",
    ] {
        let q = query(vec![c("lovely"), c(w)], 3);
        let (_, total) = brute::search(&lib.world, &q);
        let f = lib.store.search(&q).unwrap();
        if f.total_exact {
            assert_eq!(f.total, total, "{q:?}");
        }
        // Not the query's last word: whole tokens, all fields, no tag join.
        let mut one = query(vec![c(w), c("")], 3);
        one.clauses.pop();
        let (_, total) = brute::search(&lib.world, &one);
        let f = lib.store.search(&one).unwrap();
        assert!(f.page_exact);
        if f.total_exact {
            assert_eq!(f.total, total, "{one:?}");
        }
    }
}

/// The test kind's order: `testSet` keys.
struct TestOrder;

impl SortKey for TestOrder {
    fn key_of(&self, view: &View, doc: u64) -> StoreResult<Vec<u8>> {
        let Some(b) = view.get(&key::id(key::TEST_SET, doc))? else {
            return Ok(Vec::new());
        };
        let (rec, _) = view.record(parse_loc(&b)?.pos)?;
        let Value::UInt(k) = rec.values[1] else {
            unreachable!()
        };
        Ok(k.to_be_bytes().to_vec())
    }

    fn walk(
        &self,
        view: &View,
        after: Option<&(Vec<u8>, u64)>,
        limit: usize,
    ) -> StoreResult<Vec<(Vec<u8>, u64)>> {
        let start = key::of(key::TEST_ORDER);
        let from = match after {
            Some((k, d)) => {
                let mut s = key::ids(
                    key::TEST_ORDER,
                    u64::from_be_bytes(k[..8].try_into().unwrap()),
                    *d,
                );
                s.push(0);
                s
            }
            None => start.clone(),
        };
        Ok(view
            .scan(&from, &key::prefix_end(&start), limit)?
            .into_iter()
            .map(|(k, _)| {
                let mut at = start.len();
                let key = get_u64(&k, &mut at).unwrap();
                let doc = get_u64(&k, &mut at).unwrap();
                (key.to_be_bytes().to_vec(), doc)
            })
            .collect())
    }
}

#[test]
fn a_sort_key_orders_matches_by_sorting_or_by_walking() {
    let _turn = turn();
    let dir = temp_dir("sort");
    let lib = build(&dir, 5, 150);
    let mut r = Rng(55);
    let mut keys = std::collections::BTreeMap::new();
    for &doc in lib.world.library.docs.keys() {
        let k = r.below(50);
        keys.insert(doc, k);
        lib.store
            .commit_wait(vec![rec(
                "testSet",
                vec![Value::Id(doc), Value::UInt(k), Value::Bytes(Vec::new())],
            )])
            .unwrap();
    }
    let c = |t: &str| clause(t, None, false, false);
    for clauses in [
        vec![c("the")],
        vec![c("supercalifragilisticexpialidocious")],
        vec![],
        vec![c("dr"), clause("vampire", None, true, false)],
    ] {
        let mut q = query(clauses, 4);
        q.order = Order::Key(Arc::new(TestOrder));
        let (want, total) = brute::search(&lib.world, &q);
        let mut want: Vec<u64> = want.into_iter().map(|(d, _)| d).collect();
        want.sort_by_key(|d| (keys[d], *d));
        let (got, first) = pages(&lib.store, &q);
        assert!(first.page_exact);
        if first.total_exact {
            assert_eq!(first.total, total);
        }
        assert_eq!(
            got.iter().map(|(d, _)| *d).collect::<Vec<_>>(),
            want,
            "{q:?}"
        );
    }
}

#[test]
fn a_field_edit_writes_only_its_changed_terms_and_other_kinds_write_no_postings() {
    let _turn = turn();
    let dir = temp_dir("writes");
    let s = open(&dir);
    let code = test_codes::LIBRARY + 1;
    s.commit_wait(vec![text_value(7, code, "alpha gamma delta")])
        .unwrap();
    let inserted = |s: &Store| s.stats().ks.inserted;
    let before = inserted(&s);
    // "alpha" → "betas": one term gone, one new: per term its posting slot, document counter and document
    // frequency in the field, and the new one's block maximum; same length.
    s.commit_wait(vec![rec(
        "textEdit",
        vec![
            Value::Sel(0, 7),
            Value::Field(FieldRef::Code(code)),
            Value::UInt(0),
            Value::UInt(5),
            Value::Text(wtf8("betas")),
            Value::Absent,
            Value::Absent,
        ],
    )])
    .unwrap();
    // Plus the text's head, its edit and the entity's version.
    assert_eq!(inserted(&s) - before, 2 * 3 + 1 + 3);
    let before = inserted(&s);
    s.commit_wait(vec![assign(7, 1, true)]).unwrap();
    s.commit_wait(vec![rec("fav", vec![Value::Id(7), Value::Bit(true)])])
        .unwrap();
    // Membership both ways, its block map and a count; the entity's place in the assignment change feed and
    // the pointer to it; the fav and the version.
    assert_eq!(inserted(&s) - before, 4 + 2 + 2);
    for e in 100..150 {
        s.commit_wait(vec![assign(e, 1, true)]).unwrap();
    }
    s.commit_wait(vec![text_value(1, test_codes::TAG_NAME, "red")])
        .unwrap();
    let before = inserted(&s);
    s.commit_wait(vec![text_value(1, test_codes::TAG_NAME, "blue")])
        .unwrap();
    // A rename writes the tag's own name terms, whatever number of entities carry it: "re" and "red" go,
    // "bl", "blu" and "blue" come (posting slot, document counter and prefix frequency each, a block maximum
    // for the new ones, and a whole-token frequency for "red" and "blue"); plus the text's head, version, and
    // the old value's dead bytes.
    assert_eq!(inserted(&s) - before, 5 * 3 + 3 + 2 + 3);
}

#[test]
fn phrases_equal_a_scan() {
    let _turn = turn();
    let dir = temp_dir("phrases");
    let lib = build(&dir, 7, 160);
    let c = |t: &str| clause(t, None, false, false);
    let phrases = [
        vec![clause("dark knight", None, false, true), c("the")],
        vec![clause("dark knight", None, false, true)],
        vec![clause("the dark knight", None, false, true), c("love")],
        vec![c("foo-bar"), c("x9")],
        vec![c("o'neil"), c("the")],
        vec![clause("knight the", None, false, true), c("dragon")],
    ];
    for clauses in &phrases {
        check(&lib, &query(clauses.clone(), 6));
    }
}

#[test]
fn top_lists_follow_edits_and_bulk_loads() {
    let _turn = turn();
    let dir = temp_dir("top");
    let mut lib = build(&dir, 5, 500);
    let c = |t: &str| clause(t, None, false, false);
    let words = [
        "the", "dr", "dark", "love", "vampire", "knight", "cafe", "elodie",
    ];
    let mut listed = 0;
    let mut check_words = |lib: &Lib| {
        for w in words {
            let q = query(vec![c(w)], 6);
            check(lib, &q);
            settle(&lib.store);
            listed += usize::from(lib.store.search(&q).unwrap().listed);
        }
    };
    check_words(&lib);
    let mut r = Rng(77);
    let docs: Vec<u64> = lib.world.library.docs.keys().copied().collect();
    for i in 0..400 {
        random_edit(&mut lib, &mut r, &docs, i);
        check_lists(&lib, &words);
        if i % 50 == 49 {
            check_words(&lib);
        }
    }
    // A bulk load into a store with documents leaves the lists it changed stale: they are built again.
    let mut l = lib.store.loader().unwrap();
    let mut recs = Vec::new();
    for doc in 2000..2200u64 {
        let text = format!("the dark knight {} love", "the ".repeat((doc % 7) as usize));
        recs.push(text_value(doc, test_codes::LIBRARY, &text));
        lib.world
            .library
            .docs
            .entry(doc)
            .or_insert_with(|| vec![Vec::new(); 10])[0] = vec![text.into_bytes()];
    }
    l.add(recs).unwrap();
    l.finish().unwrap();
    let q = query(vec![c("the")], 6);
    assert!(!lib.store.search(&q).unwrap().listed);
    check_words(&lib);
    lib.store.close();
    drop(lib.store);
    let lib = Lib {
        store: open(&dir),
        world: lib.world,
    };
    check_words(&lib);
    assert!(listed > 0);
}

#[test]
fn a_bulk_load_into_an_empty_store_builds_the_top_lists() {
    let _turn = turn();
    let dir = temp_dir("bulk-lists");
    let mut lib = Lib {
        store: open(&dir),
        world: World::default(),
    };
    let mut r = Rng(9);
    let mut l = lib.store.loader().unwrap();
    let mut recs = Vec::new();
    for doc in 1..=700u64 {
        for f in [0usize, 1] {
            let n = 1 + r.below(10);
            let text = sentence(&mut r, n);
            recs.push(text_value(doc, test_codes::LIBRARY + f as u64, &text));
            lib.world
                .library
                .docs
                .entry(doc)
                .or_insert_with(|| vec![Vec::new(); 10])[f] = vec![text.into_bytes()];
        }
    }
    l.add(recs).unwrap();
    let st = l.finish().unwrap();
    assert!(st.list_entries > 0);
    let c = |t: &str| clause(t, None, false, false);
    for w in ["the", "dr", "dark", "love", "knight"] {
        let q = query(vec![c(w)], 6);
        let f = lib.store.search(&q).unwrap();
        assert!(f.listed && f.refill.is_none(), "{q:?}");
        check(&lib, &q);
    }
    // Writes follow the lists; past `top::MAX + top::SLACK` entries they are trimmed.
    let docs: Vec<u64> = lib.world.library.docs.keys().copied().collect();
    for i in 0..300 {
        let doc = docs[(i * 7) % docs.len()];
        lib.set(doc, 0, &[format!("the {}", r.pick(WORDS))]);
    }
    for w in ["the", "dr", "dark", "love", "knight"] {
        check(&lib, &query(vec![c(w)], 6));
    }
}

#[test]
fn tags_whose_names_match_are_answered_beside_the_page() {
    let _turn = turn();
    let dir = temp_dir("tags");
    let mut lib = Lib {
        store: open(&dir),
        world: World::default(),
    };
    for (t, name) in [
        (1, "dragon"),
        (2, "dragon rider"),
        (3, "dragons"),
        (4, "red dragon"),
        (5, "drama"),
        (6, "dark"),
        (7, "Dragon"),
    ] {
        lib.tag(t, name);
    }
    for e in 1..=20 {
        lib.set(e, 0, &[format!("card {e}")]);
        lib.assign(e, 1 + e % 4, true);
    }
    lib.assign(1, 7, true);
    let c = |t: &str, fields: Option<Vec<u32>>, negate: bool| clause(t, fields, negate, false);
    let ids = |q: Query| -> Vec<u64> {
        lib.store
            .search(&q)
            .unwrap()
            .tags
            .iter()
            .map(|t| t.tag)
            .collect()
    };
    // Exact names first (by carriers), then word matches, then prefixes; at most five.
    assert_eq!(
        ids(query(vec![c("dragon", None, false)], 5)),
        vec![1, 7, 2, 4, 3]
    );
    assert_eq!(
        ids(query(vec![c("dra", None, false)], 5)),
        vec![1, 2, 3, 4, 7]
    );
    assert_eq!(
        ids(query(
            vec![c("dragon", None, false), c("red", None, true)],
            5
        )),
        vec![1, 7, 2]
    );
    assert_eq!(
        ids(query(vec![c("dragon", Some(vec![8]), false)], 5)),
        vec![1, 7, 2, 4, 3]
    );
    assert!(ids(query(vec![c("dragon", Some(vec![0]), false)], 5)).is_empty());
    assert!(
        ids(query(
            vec![c("dragon", None, false), c("x", Some(vec![1]), true)],
            5
        ))
        .is_empty()
    );
    for clauses in [
        vec![c("dragon", None, false)],
        vec![c("red", None, false), c("dr", None, false)],
        vec![c("dar", None, false)],
    ] {
        check(&lib, &query(clauses, 5));
    }
}

/// A query whose read is interrupted at `at` by `write` (run to completion, on another thread so a write that
/// waited for the read would show as a timeout rather than a hang): its page and total are those of the state
/// before the write, and the write didn't wait.
fn read_across_a_write(
    store: &Arc<Store>,
    q: &Query,
    at: &'static str,
    write: impl FnOnce(&Store) + Send + 'static,
) -> Found {
    let s = store.clone();
    let wrote = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let w = wrote.clone();
    on(at, move || {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            write(&s);
            let _ = tx.send(());
        });
        rx.recv_timeout(std::time::Duration::from_secs(20))
            .expect("a write waited for a read");
        w.store(true, Ordering::SeqCst);
    });
    let f = store.search(q).unwrap();
    assert!(wrote.load(Ordering::SeqCst), "the read reached {at}");
    f
}

fn hits(f: &Found) -> Vec<(u64, f64)> {
    f.hits.iter().map(|h| (h.doc, h.score)).collect()
}

fn snapshot_lib(name: &str) -> (Arc<Store>, World) {
    let Lib { store, world } = build(&temp_dir(name), 5, 500);
    (Arc::new(store), world)
}

#[test]
fn a_list_read_sees_one_state_while_a_slice_and_an_edit_publish() {
    let _turn = turn();
    let (store, world) = snapshot_lib("snapshot-list");
    let c = |t: &str| clause(t, None, false, false);

    // A top list: between its head and its entries, a slice starts it again at other parameters.
    let q = query(vec![c("the")], 6);
    for _ in 0..100 {
        if store.search(&q).unwrap().refill.is_none() {
            break;
        }
        settle(&store);
    }
    let head_of = |s: &Store| {
        s.get(&super::top(Scope::LIBRARY, "the"))
            .unwrap()
            .and_then(|b| super::top::Head::decode(&b))
            .unwrap()
    };
    let head = head_of(&store);
    assert!(head.passing.is_none());
    let (want, total) = brute::search(&world, &q);
    // ... and the best card loses the word.
    let doubled: Vec<(f64, f64)> = head.params.iter().map(|&(w, a)| (w * 2.0, a)).collect();
    let params = doubled.clone();
    let best = want[0].0;
    let f = read_across_a_write(&store, &q, "list", move |s| {
        s.queue_refill(super::query::Refill {
            scope: Scope::LIBRARY,
            term: "the".into(),
            params,
        });
        settle(s);
        let recs = (0..10)
            .map(|f| text_value(best, test_codes::LIBRARY + f, ""))
            .collect();
        s.commit_wait(recs).unwrap();
    });
    assert_eq!(
        head_of(&store).params,
        doubled,
        "the slice published during the read"
    );
    assert!(f.listed && f.page_exact && f.total_exact);
    assert_eq!((hits(&f), f.total), (want[..6].to_vec(), total));
}

#[test]
fn a_word_read_whole_sees_one_state_while_an_edit_publishes() {
    let _turn = turn();
    let (store, mut world) = snapshot_lib("snapshot-word");
    let c = |t: &str| clause(t, None, false, false);
    // A word read whole: after its first document, a card gets the word many times and another loses it.
    for d in 3000..3010u64 {
        let text = format!("zephyr {}", "wind ".repeat((d % 4) as usize));
        store
            .commit_wait(vec![text_value(d, test_codes::LIBRARY, &text)])
            .unwrap();
        world
            .library
            .docs
            .entry(d)
            .or_insert_with(|| vec![Vec::new(); 10])[0] = vec![text.into_bytes()];
    }
    let q = query(vec![c("zephyr")], 50);
    let (want, total) = brute::search(&world, &q);
    assert_eq!(total, 10);
    // Read in id order: one not read yet gains it, the last loses it.
    let (gains, loses) = (3020u64, 3009u64);
    let f = read_across_a_write(&store, &q, "word", move |s| {
        s.commit_wait(vec![
            text_value(gains, test_codes::LIBRARY, "zephyr zephyr zephyr zephyr"),
            text_value(loses, test_codes::LIBRARY, "plain"),
            text_value(loses, test_codes::LIBRARY + 1, "plain"),
        ])
        .unwrap();
    });
    assert!(f.page_exact && f.total_exact);
    assert_eq!((hits(&f), f.total), (want.clone(), total));
}

#[test]
fn a_walk_sees_one_state_while_an_edit_publishes() {
    let _turn = turn();
    let (store, world) = snapshot_lib("snapshot-walk");
    let c = |t: &str| clause(t, None, false, false);
    // A walk: at its first match, the best matches lose a word.
    let q = query(vec![c("dark"), c("knight")], 5);
    let (want, total) = brute::search(&world, &q);
    let gone: Vec<u64> = want.iter().take(5).map(|x| x.0).collect();
    let f = read_across_a_write(&store, &q, "walk", move |s| {
        let recs = gone
            .iter()
            .flat_map(|&d| (0..10).map(move |f| text_value(d, test_codes::LIBRARY + f, "")))
            .collect();
        s.commit_wait(recs).unwrap();
    });
    assert!(f.page_exact);
    assert_eq!(hits(&f), want[..5]);
    if f.total_exact {
        assert_eq!(f.total, total);
    }
}

#[test]
fn a_long_read_does_not_delay_writes() {
    let _turn = turn();
    let dir = temp_dir("long-read");
    let Lib { store, .. } = build(&dir, 6, 200);
    let store = Arc::new(store);
    let q = query(
        vec![
            clause("dark", None, false, false),
            clause("knight", None, false, false),
        ],
        5,
    );
    // The read stays open across a hundred commits, each acknowledged while it is open.
    let started = std::time::Instant::now();
    read_across_a_write(&store, &q, "walk", |s| {
        for i in 0..100u64 {
            s.commit_wait(vec![text_value(5000 + i, test_codes::LIBRARY, "written")])
                .unwrap();
        }
    });
    assert!(started.elapsed() < std::time::Duration::from_secs(20));
}
