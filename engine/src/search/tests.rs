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
            Value::Id(e),
            Value::Field(FieldRef::Code(code)),
            Value::Text(wtf8(s)),
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
            .or_insert_with(|| vec![Vec::new(); 11]);
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
        for f in [0usize, 2, 3, 4, 8, 9] {
            let n = if f == 0 || f == 8 {
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
        lib.set(doc, 10, &items);
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
        vec![clause("dra", Some(vec![2]), false, false)],
        vec![clause("dra", Some(vec![1, 9]), false, false)],
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
    assert!(first.total_exact && first.page_exact, "{q:?}");
    assert_eq!(first.total, total, "total of {:?}", describe(q));
    assert_eq!(got, want, "hits of {:?}", describe(q));
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
    let dir = temp_dir("scan");
    let lib = build(&dir, 1, 160);
    for clauses in queries() {
        check(&lib, &query(clauses, 7));
    }
}

#[test]
fn filters_and_negations_restrict_matches() {
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

#[test]
fn edits_flushes_merges_and_reopening_keep_results_equal() {
    let dir = temp_dir("edits");
    let mut lib = build(&dir, 3, 100);
    let mut r = Rng(33);
    let docs: Vec<u64> = lib.world.library.docs.keys().copied().collect();
    for i in 0..300 {
        let doc = docs[r.below(docs.len() as u64) as usize];
        match i % 5 {
            0 => {
                // A text edit: replace a span at character boundaries.
                let old = String::from_utf8(
                    lib.world.library.docs[&doc][2]
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
                    lib.set(doc, 2, &[ins]);
                    continue;
                }
                lib.store
                    .commit_wait(vec![rec(
                        "textEdit",
                        vec![
                            Value::Id(doc),
                            Value::Field(FieldRef::Code(test_codes::LIBRARY + 2)),
                            Value::UInt(a as u64),
                            Value::UInt((b - a) as u64),
                            Value::Text(wtf8(&ins)),
                        ],
                    )])
                    .unwrap();
                let new = format!("{}{}{}", &old[..a], ins, &old[b..]);
                lib.world.library.docs.get_mut(&doc).unwrap()[2] = vec![new.into_bytes()];
            }
            1 => {
                let n = r.below(4);
                lib.set(doc, 0, &[sentence(&mut r, n)]);
            }
            2 => {
                let tag = 1 + r.below(12);
                let on = r.below(2) == 0;
                lib.assign(doc, tag, on);
            }
            3 => {
                let tag = 1 + r.below(12);
                let n = 1 + r.below(2);
                let name = sentence(&mut r, n);
                lib.tag(tag, &name);
            }
            _ => {
                let items: Vec<String> = (0..r.below(3)).map(|_| sentence(&mut r, 2)).collect();
                lib.set(doc, 10, &items);
            }
        }
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
fn past_the_work_limit_totals_are_marked_and_pages_complete_from_the_bounds() {
    let dir = temp_dir("limit");
    let lib = build(&dir, 4, 200);
    let c = |t: &str| clause(t, None, false, false);
    for clauses in [
        vec![c("the")],
        vec![c("dr")],
        vec![c("knight"), c("the")],
        vec![clause("dark knight", None, false, true)],
    ] {
        let mut q = query(clauses, 5);
        q.limits = Limits {
            enumerate: 400,
            ranked: u64::MAX,
            walked: u64::MAX,
            joined: u64::MAX,
        };
        let (want, _) = brute::search(&lib.world, &q);
        let f = lib.store.search(&q).unwrap();
        assert!(!f.total_exact, "{q:?}");
        assert!(f.page_exact, "{q:?}");
        let got: Vec<(u64, f64)> = f.hits.iter().map(|h| (h.doc, h.score)).collect();
        assert_eq!(got, want[..want.len().min(5)], "{q:?}");
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
        assert!(first.total_exact && first.page_exact);
        assert_eq!(first.total, total);
        assert_eq!(
            got.iter().map(|(d, _)| *d).collect::<Vec<_>>(),
            want,
            "{q:?}"
        );
    }
}

#[test]
fn a_field_edit_writes_only_its_changed_terms_and_other_kinds_write_no_postings() {
    let dir = temp_dir("writes");
    let s = open(&dir);
    let code = test_codes::LIBRARY + 2;
    s.commit_wait(vec![text_value(7, code, "alpha gamma delta")])
        .unwrap();
    let inserted = |s: &Store| s.stats().ks.inserted;
    let before = inserted(&s);
    // "alpha" → "betas": one term gone, one new (each its block's posting and its document frequency); same length.
    s.commit_wait(vec![rec(
        "textEdit",
        vec![
            Value::Id(7),
            Value::Field(FieldRef::Code(code)),
            Value::UInt(0),
            Value::UInt(5),
            Value::Text(wtf8("betas")),
        ],
    )])
    .unwrap();
    // Plus the text's head, its edit and the entity's version.
    assert_eq!(inserted(&s) - before, 4 + 3);
    let before = inserted(&s);
    s.commit_wait(vec![assign(7, 1, true)]).unwrap();
    s.commit_wait(vec![rec("fav", vec![Value::Id(7), Value::Bit(true)])])
        .unwrap();
    // Membership both ways and a count; the fav and the version.
    assert_eq!(inserted(&s) - before, 3 + 2);
    for e in 100..150 {
        s.commit_wait(vec![assign(e, 1, true)]).unwrap();
    }
    s.commit_wait(vec![text_value(1, test_codes::TAG_NAME, "red")])
        .unwrap();
    let before = inserted(&s);
    s.commit_wait(vec![text_value(1, test_codes::TAG_NAME, "blue")])
        .unwrap();
    // A rename writes the tag's own name terms, whatever number of entities carry it: "red" and its prefix
    // terms "re", "red" go, "blue", "bl", "blu", "blue" come (posting and frequency each); plus the text's head,
    // version, and the old value's dead bytes.
    assert_eq!(inserted(&s) - before, 3 * 2 + 4 * 2 + 3);
}
