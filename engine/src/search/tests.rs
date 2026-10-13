use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use super::Scope;
use super::brute::{self, World, clause};
use super::query::{After, Clause, Filter, Found, Limits, Order, Query, SortKey};
use super::text::tokens;
use crate::keyspace::KsConfig;
use crate::keyspace::pool::Pool;
use crate::keyspace::val::get_u64;
use crate::log;
use crate::log::format::{FieldRef, Record, Value, kind_by_name, wtf8_from_utf16};
use crate::store::derive::View;
use crate::store::kinds::test_codes::ITEM_SEPARATOR;
use crate::store::kinds::{key, parse_loc, test_codes};
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
    build_ids(dir, seed, docs, |d| d)
}

/// `build` with the documents' ids `id` gives.
fn build_ids(dir: &Path, seed: u64, docs: u64, id: fn(u64) -> u64) -> Lib {
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
        let doc = id(1 + r.below(1500));
        random_fields(&mut lib, &mut r, doc);
        for _ in 0..r.below(3) {
            lib.assign(doc, 1 + r.below(12), true);
        }
    }
    lib
}

/// A library with no tags whose documents `id(1)` to `id(docs)` are each written once.
fn build_fresh(dir: &Path, seed: u64, docs: u64, id: fn(u64) -> u64) -> Lib {
    let mut r = Rng(seed);
    let mut lib = Lib {
        store: open(dir),
        world: World::default(),
    };
    for d in 1..=docs {
        random_fields(&mut lib, &mut r, id(d));
    }
    lib
}

/// `build_fresh`, with tags 1 to 12 named first and each document assigned up to two of them once its text is set.
fn build_fresh_tagged(dir: &Path, seed: u64, docs: u64, id: fn(u64) -> u64) -> Lib {
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
    for d in 1..=docs {
        random_fields(&mut lib, &mut r, id(d));
        for _ in 0..r.below(3) {
            lib.assign(id(d), 1 + r.below(12), true);
        }
    }
    lib
}

/// Random text in a document's name, description, example messages, scenario, creator, tags and greetings.
fn random_fields(lib: &mut Lib, r: &mut Rng, doc: u64) {
    for f in [0usize, 1, 2, 3, 7, 8] {
        let n = if f == 0 || f == 7 {
            1 + r.below(3)
        } else {
            r.below(12)
        };
        lib.set(doc, f, &[sentence(r, n)]);
    }
    let items: Vec<String> = (0..r.below(3))
        .map(|_| {
            let n = 1 + r.below(5);
            sentence(r, n)
        })
        .collect();
    lib.set(doc, 9, &items);
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
        weights: None,
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
            Order::Relevance => After::Score(last.rank, last.doc),
            Order::Key(_) => After::Key(last.key.clone().unwrap(), last.doc),
        });
        q.weights = f.weights.clone();
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
}

type Hook = Box<dyn FnOnce()>;

thread_local! {
    /// Run once by a query of this thread when it reaches the named point of its read: "walk" at a walk's first
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

/// Ids in runs of 50, each run `1 << 27` ids after the last: the runs are under different level-1 nodes of the
/// block maxima, and under level-2 nodes 0 to 3 (`super::node_of`).
fn spread_id(d: u64) -> u64 {
    d % 50 + (d / 50 << 27)
}

/// With ids spread over the maxima's nodes above level 0, results equal a scan, and the walk passes over nodes
/// at levels 1 and 2 by their maxima.
#[test]
fn results_over_sparse_ids_equal_a_scan_of_every_document() {
    let _turn = turn();
    let dir = temp_dir("sparse");
    let lib = build_ids(&dir, 1, 400, spread_id);
    let mut passed = [0u64; super::LEVELS];
    for clauses in queries() {
        for limit in [1, 3, 7] {
            let q = query(clauses.clone(), limit);
            check(&lib, &q);
            let f = lib.store.search(&q).unwrap();
            for (p, n) in passed.iter_mut().zip(f.nodes_passed) {
                *p += n;
            }
        }
    }
    assert!(passed[1] > 0 && passed[2] > 0, "{passed:?}");
}

/// Pages 1 to `n` of a query equal the reference's first matches, each page exact; whether every page was read
/// best first by the word's maxima (no step of the walk in id order).
fn check_pages(lib: &Lib, q: &Query, n: usize) -> bool {
    check_pages_walked(lib, q, n, false)
}

/// `check_pages`; with `walk_exact`, every page the walk in id order read has an exact total.
fn check_pages_walked(lib: &Lib, q: &Query, n: usize, walk_exact: bool) -> bool {
    let (want, total) = brute::search(&lib.world, q);
    let mut q = q.clone();
    let mut got = Vec::new();
    let mut descended = true;
    for page in 0..n {
        let f = lib.store.search(&q).unwrap();
        assert!(f.page_exact, "{q:?}");
        if page == 0 && f.total_exact {
            assert_eq!(f.total, total, "total of {q:?}");
        }
        if walk_exact && f.steps > 0 {
            assert!(f.total_exact, "{q:?} page {page}: the walk counts every match");
            assert_eq!(f.total, total, "total of {q:?} page {page}");
        }
        descended &= f.steps == 0;
        got.extend(f.hits.iter().map(|h| (h.doc, h.score)));
        let Some(last) = f.hits.last().filter(|_| f.more) else {
            break;
        };
        q.after = Some(After::Score(last.rank, last.doc));
        q.weights = f.weights.clone();
    }
    let want = &want[..want.len().min(n * q.limit)];
    assert_eq!(got, want, "{q:?} limit {}", q.limit);
    descended
}

/// One-word clauses read best first: whole words (quoted), and prefixes in some fields (a long one in prefix
/// fields only, read through its first `GRAM_MAX` characters and counted on the text).
fn descending_words() -> Vec<Clause> {
    let mut out: Vec<Clause> = WORDS
        .iter()
        .filter(|w| tokens(w.as_bytes()).len() == 1)
        .map(|w| clause(w, None, false, true))
        .collect();
    for (w, fields) in [
        ("dra", vec![0]),
        ("dr", vec![1]),
        ("dra", vec![0, 7]),
        ("kni", vec![1, 3]),
        ("supercalifragilisticex", vec![0, 7]),
        ("supercalifragilisticex", vec![1, 2]),
    ] {
        out.push(clause(w, Some(fields), false, false));
    }
    out
}

/// One word's pages 1 to 3, read best first, equal a scan: over dense and spread ids, with filters and a negated
/// clause, at several page sizes.
#[test]
fn a_words_pages_read_best_first_equal_a_scan() {
    let _turn = turn();
    for (name, id) in [
        ("best-dense", (|d| d) as fn(u64) -> u64),
        ("best-sparse", spread_id),
    ] {
        let dir = temp_dir(name);
        let lib = build_ids(&dir, 11, 400, id);
        let ids: Vec<u64> = lib.world.library.docs.keys().copied().collect();
        let half: Vec<u64> = ids.iter().copied().step_by(2).collect();
        let filters: Vec<(Vec<Filter>, Option<Clause>)> = vec![
            (vec![], None),
            (vec![Filter::AllTags(vec![1, 2])], None),
            (vec![Filter::AnyTag(vec![3, 4, 5])], None),
            (vec![Filter::NoTag(vec![1])], None),
            (vec![Filter::Ids(half.clone())], None),
            (vec![Filter::NotIds(half.clone())], None),
            (vec![], Some(clause("vampire", None, true, false))),
        ];
        let mut words = descending_words();
        // Prefixes over every field: read best first above `CHECKED_WHOLE` documents.
        for w in ["the", "dr", "d", "kn"] {
            words.push(clause(w, None, false, false));
        }
        let mut prefixes = 0;
        for w in &words {
            for (fs, neg) in &filters {
                for limit in [1, 3, 7] {
                    let mut clauses: Vec<Clause> = neg.iter().cloned().collect();
                    clauses.push(w.clone());
                    let mut q = query(clauses, limit);
                    q.filters = fs.clone();
                    // A single word with an include is read best first only until that costs about what the walk
                    // led by the rarer of them would; then the counting walk reads it, its total exact.
                    let included = fs.iter().any(|f| {
                        matches!(f, Filter::AllTags(_) | Filter::AnyTag(_) | Filter::Ids(_))
                    });
                    let best_first = check_pages_walked(&lib, &q, 3, included);
                    if (w.quoted || w.fields.is_some()) && !included {
                        assert!(best_first, "{q:?}");
                    } else if !(w.quoted || w.fields.is_some()) {
                        prefixes += usize::from(best_first);
                    }
                }
            }
        }
        assert!(prefixes > 0);
        drop(lib);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Cards whose one word scores alike across many blocks: pages cut inside a tie come back in id order.
#[test]
fn a_words_ties_at_the_page_edge_come_back_in_id_order() {
    let _turn = turn();
    for (name, id) in [
        ("ties-dense", (|i| 1 + i * 97) as fn(u64) -> u64),
        ("ties-sparse", |i| spread_id(i * 13)),
    ] {
        let dir = temp_dir(name);
        let mut lib = Lib {
            store: open(&dir),
            world: World::default(),
        };
        let mut ids = Vec::new();
        for i in 0..48u64 {
            // Three scores, each held by 16 cards spread over the blocks.
            let filler = "knight ".repeat((i % 3) as usize);
            lib.set(id(i), 0, &[format!("{filler}omega")]);
            ids.push(id(i));
        }
        let some: Vec<u64> = ids.iter().copied().filter(|d| d % 5 != 0).collect();
        for w in [
            clause("omega", None, false, true),
            clause("ome", Some(vec![0]), false, false),
        ] {
            for filters in [vec![], vec![Filter::Ids(some.clone())]] {
                for limit in 1..=8 {
                    let mut q = query(vec![w.clone()], limit);
                    q.filters = filters.clone();
                    // Under ids the descent may hand the page to the counting walk (as a single word with an
                    // include is read), whose total is exact; with no filter it is read best first.
                    let best_first = check_pages_walked(&lib, &q, 3, true);
                    if filters.is_empty() {
                        assert!(best_first, "{q:?}");
                    }
                }
            }
        }
        drop(lib);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// A document's parts of its score for `tok` before the idf, from its text, in the fields of `fields` (None:
/// every field): (field, `field_score`), in prefix fields as a prefix when `prefix`.
fn parts_of(
    lib: &Lib,
    doc: u64,
    tok: &str,
    prefix: bool,
    fields: Option<&[u32]>,
) -> Vec<(u32, f64)> {
    let scope = Scope::LIBRARY;
    let f = brute::tokenize_fields(scope, &lib.world.library.docs[&doc]);
    let d = brute::Doc::new(&f, scope);
    (0..scope.fields().len())
        .filter(|&i| fields.is_none_or(|fs| fs.contains(&(i as u32))))
        .filter_map(|i| {
            let tf = d.count(i, tok, prefix && scope.fields()[i].prefix);
            let len = f[i].iter().map(Vec::len).sum::<usize>() as u64;
            let len = super::code_length(super::length_code(len));
            (tf > 0).then(|| {
                (
                    i as u32,
                    super::field_score(scope, i as u32, tf as f64, len),
                )
            })
        })
        .collect()
}

/// The level-0 maxima maps of `term` in the library, by group.
fn maxima_maps(s: &Store, term: &str) -> Vec<(u64, Vec<(u32, u32)>)> {
    let start = super::block_maxima_at(Scope::LIBRARY, term, 0);
    s.scan(&start, &key::prefix_end(&start), usize::MAX)
        .unwrap()
        .into_iter()
        .map(|(k, v)| {
            let group = crate::keyspace::val::get_u64(&k, &mut { start.len() }).unwrap();
            (group, crate::keyspace::val::map_pairs(&v).unwrap())
        })
        .collect()
}

/// On a library with no tags, a word read best first, over every field or in one field, opens on its first page
/// at most `k + 1` posting blocks (`k` the hits a page keeps: its size and one more), plus the blocks whose stored
/// maximum (over every field, or in the one field) equals the k-th hit's score there as stored (rounded up); and
/// reads at most `(L + 1) + (k + 1 + those)·L` maxima maps, `L` the top level of the highest document's block. Any
/// exact descent opens those tied blocks: a maximum is stored rounded up, so a block whose best card ties the k-th
/// can't be told apart from one whose best card ranks just above it. Exact maxima would double their space for
/// this edge.
///
/// A clause in several fields is bounded by its fields' maxima summed, which may be different cards', so it is
/// only checked against the scan.
#[test]
fn an_untagged_words_first_page_opens_at_most_k_plus_one_blocks_and_its_ties() {
    let _turn = turn();
    for (name, id) in [
        ("open-dense", (|d| d * 37) as fn(u64) -> u64),
        ("open-sparse", spread_id),
    ] {
        let dir = temp_dir(name);
        let lib = build_fresh(&dir, 12, 400, id);
        let top = *lib.world.library.docs.keys().max().unwrap();
        let l = super::top_level(top >> super::BLOCK_BITS);
        let mut words = descending_words();
        for w in ["the", "dr", "d", "kn"] {
            words.push(clause(w, None, false, false));
        }
        let (mut opened, mut in_one_field) = (0, 0);
        for w in &words {
            for limit in [1, 3, 7] {
                let q = query(vec![w.clone()], limit);
                if !check_pages(&lib, &q, 1) {
                    continue;
                }
                // None: every field.
                let field = match w.fields.as_deref() {
                    None => None,
                    Some(&[f]) => Some(f),
                    Some(_) => continue,
                };
                let f = lib.store.search(&q).unwrap();
                let k = limit as u64 + 1;
                let tok = tokens(&w.text).remove(0);
                let prefix = !w.quoted && super::text::char_len(&tok) >= super::text::GRAM_MIN;
                // The list the word is read by: a long prefix in a prefix field is read through its first
                // `GRAM_MAX` characters, in another field as a whole token.
                let (term, reading) = match field {
                    Some(f) if prefix && super::text::char_len(&tok) > super::text::GRAM_MAX => {
                        if Scope::LIBRARY.fields()[f as usize].prefix {
                            (
                                super::text::first_chars(&tok, super::text::GRAM_MAX).to_string(),
                                true,
                            )
                        } else {
                            (tok.clone(), false)
                        }
                    }
                    _ => (tok.clone(), prefix),
                };
                let (all, _) = brute::search(&lib.world, &query(vec![w.clone()], 100_000));
                let tied = match all.get(k as usize - 1) {
                    Some(&(doc, _)) => {
                        let parts = parts_of(&lib, doc, &tok, prefix, w.fields.as_deref());
                        let kth = super::max_bits(super::sum_parts(Scope::LIBRARY, parts, false));
                        maxima_maps(&lib.store, &term)
                            .iter()
                            .flat_map(|(g, m)| m.iter().map(move |&(sl, v)| (*g, sl, v)))
                            .filter(|&(g, sl, bits)| {
                                let (_, f, r) = super::unmax_slot(g, sl);
                                f == field && r == reading && bits == kth
                            })
                            .count() as u64
                    }
                    None => 0,
                };
                in_one_field += u64::from(field.is_some());
                assert!(
                    f.posting_blocks <= k + 1 + tied,
                    "{q:?} limit {limit}: {} with {tied} tied",
                    f.posting_blocks
                );
                assert!(
                    f.max_reads <= (l + 1) + (k + 1 + tied) * l,
                    "{q:?} limit {limit}: {} at L = {l} with {tied} tied",
                    f.max_reads
                );
                opened += f.posting_blocks;
            }
        }
        assert!(opened > 0 && in_one_field > 0);
        drop(lib);
        let _ = std::fs::remove_dir_all(&dir);
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
fn walks_the_limit_cuts_short_say_so() {
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
    // "alpha" → "betas": one term gone, one new: per term its posting slot and its counts (`term_counts`), and
    // the new one's block maximum; same length.
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
    // Plus the text's head, its edit and the entity's version, and its entry in the entity change feed moving.
    assert_eq!(inserted(&s) - before, 2 * 2 + 1 + 3 + 2);
    let before = inserted(&s);
    s.commit_wait(vec![assign(7, 1, true)]).unwrap();
    s.commit_wait(vec![rec("fav", vec![Value::Id(7), Value::Bit(true)])])
        .unwrap();
    // Membership both ways, its block map and a count; every tag's carriers summed (`key::CARRIER_PAIRS`; the
    // tag has no name, so no term's carriers); the entity's place in the assignment change feed and the pointer
    // to it; the fav and the version, and the entity change feed's entry moving.
    assert_eq!(inserted(&s) - before, 4 + 1 + 2 + 2 + 2);
    for e in 100..150 {
        s.commit_wait(vec![assign(e, 1, true)]).unwrap();
    }
    s.commit_wait(vec![text_value(1, test_codes::TAG_NAME, "red")])
        .unwrap();
    // Wait for the tag to move to the heavy side, and hold the move the rename starts.
    settle_moves(&s);
    s.hold_carriers(true);
    let before = inserted(&s);
    s.commit_wait(vec![text_value(1, test_codes::TAG_NAME, "blue")])
        .unwrap();
    // A rename writes the tag's own name terms, whatever number of entities carry it: "re" and "red" go,
    // "bl", "blu" and "blue" come (posting slot and counts each, a block maximum for the new ones); plus the
    // text's head, version, and the old value's dead bytes, and the entity change feed's entry moving. The tag is heavy (51
    // carriers, K = 8), so its carriers move from the old name's 3 terms to the new one's 4
    // (`key::TERM_CARRIERS`), 7 counters; and it starts a move, which raises its carriers' maxima for the new
    // terms: listed under the 7 terms of either name (`key::TERM_MOVING`), queued (`key::MOVING`) and its flight
    // (`key::TAG_MAP`) (`store::carriers::renamed`).
    assert_eq!(inserted(&s) - before, 5 * 2 + 3 + 3 + 2 + 7 + 7 + 1 + 1);
    s.hold_carriers(false);
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

/// A library of tag names and texts where names score above tags and tags above the body: "girl" in a name,
/// as a carried tag's name (tags 1 and 3, carried by documents 20..=60 and 61..=80), and in descriptions.
fn tagged_lib(name: &str) -> Lib {
    let mut lib = Lib {
        store: open(&temp_dir(name)),
        world: World::default(),
    };
    for (t, n) in [(1, "girl"), (2, "dragon"), (3, "monster girl")] {
        lib.tag(t, n);
    }
    // More tags matching "gi" than a walk reads members of.
    for t in 4..=15u64 {
        lib.tag(t, &format!("giant {t}"));
    }
    for e in 1..=200u64 {
        let name = if e % 50 == 0 {
            "girl next door".to_string()
        } else {
            format!("card {e}")
        };
        lib.set(e, 0, &[name]);
        let body = if e % 3 == 0 {
            "a girl walks the city"
        } else {
            "a knight walks the city"
        };
        lib.set(e, 1, &[body.to_string()]);
        if (20..=60).contains(&e) {
            lib.assign(e, 1, true);
        }
        if (61..=80).contains(&e) {
            lib.assign(e, 3, true);
        }
        if e % 7 == 0 {
            lib.assign(e, 2, true);
        }
        if e % 11 == 0 {
            lib.assign(e, 4 + e % 12, true);
        }
    }
    // Carriers without text.
    for e in 1001..=1005 {
        lib.assign(e, 1, true);
    }
    lib
}

#[test]
fn tag_names_rank_carriers_between_names_and_the_body() {
    let _turn = turn();
    let lib = tagged_lib("tagrank");
    let c = |t: &str| clause(t, None, false, false);
    for limit in [1, 7, 500] {
        for clauses in [
            vec![c("girl")],
            vec![c("gi")],
            vec![c("gia")],
            vec![c("gi"), c("city")],
            vec![c("monster")],
            vec![c("girl"), c("city")],
            vec![c("city"), c("girl")],
            vec![c("girl"), c("dragon")],
            vec![clause("monster girl", None, false, true)],
            vec![c("city"), clause("girl", None, true, false)],
            vec![clause("girl", Some(vec![0]), false, false)],
            vec![c("knight"), clause("dragon", None, true, false)],
        ] {
            check(&lib, &query(clauses, limit));
        }
    }
    // Name matches, then carriers (those with text first), then the body; carriers of either tag alike.
    let (hits, _) = pages(&lib.store, &query(vec![c("girl")], 500));
    let rank = |d: u64| hits.iter().position(|h| h.0 == d).unwrap();
    let names = [50u64, 100, 150, 200];
    let carriers_with_text = [21u64, 24, 63, 66];
    let carriers_only = [20u64, 22, 61, 62, 1001];
    let body = [3u64, 6, 9];
    let last_name = names.iter().map(|&d| rank(d)).max().unwrap();
    let carrier_ranks = carriers_with_text
        .iter()
        .chain(&carriers_only)
        .map(|&d| rank(d));
    assert!(carrier_ranks.clone().all(|r| r > last_name));
    let last_carrier = carrier_ranks.max().unwrap();
    assert!(body.iter().all(|&d| rank(d) > last_carrier));
    // Carriers only tags match tie, in id order here.
    let tie = hits[rank(20)].1;
    let tied: Vec<u64> = hits.iter().filter(|h| h.1 == tie).map(|h| h.0).collect();
    let mut sorted = tied.clone();
    sorted.sort_unstable();
    assert_eq!(tied, sorted);
    assert!(tied.contains(&61) && tied.contains(&1001) && !tied.contains(&21));
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

fn pairs_step(s: &Store) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    s.pairs_step(Box::new(move |r| tx.send(r).unwrap()));
    rx.recv().unwrap().unwrap()
}

fn pairs_on(s: &Store, on: bool) {
    s.commit_wait(vec![rec("searchPairs", vec![Value::Bit(on)])])
        .unwrap();
}

/// Every pair posting slot: (scope, term, document, field) → count.
fn pair_slots(s: &Store) -> std::collections::BTreeMap<(u64, String, u64, u32), u64> {
    let mut out = std::collections::BTreeMap::new();
    for scope in [Scope::LIBRARY, Scope::TAGS] {
        let mut p = key::of(key::SEARCH_POSTING);
        crate::keyspace::val::put_u64(&mut p, scope.kind);
        crate::keyspace::val::put_u64(&mut p, scope.owner);
        for (k, v) in s.scan(&p, &key::prefix_end(&p), usize::MAX).unwrap() {
            let mut at = p.len();
            let term = crate::keyspace::val::get_bytes(&k, &mut at).unwrap();
            let block = get_u64(&k, &mut at).unwrap();
            let term = String::from_utf8(term).unwrap();
            if !term.contains(super::pairs::SEPARATOR) {
                continue;
            }
            for (slot, n) in crate::keyspace::val::map_pairs(&v).unwrap() {
                if n != 0 {
                    let (doc, field) = super::unslot(block, slot);
                    let hit = super::unpack(scope.fields()[field as usize].prefix, n);
                    out.insert((scope.kind, term.clone(), doc, field), hit.exact);
                }
            }
        }
    }
    out
}

/// The pair slots the documents' values call for.
fn pair_slots_of(w: &World) -> std::collections::BTreeMap<(u64, String, u64, u32), u64> {
    let mut out = std::collections::BTreeMap::new();
    for (scope, corpus) in [(Scope::LIBRARY, &w.library), (Scope::TAGS, &w.tags)] {
        for (doc, fields) in &corpus.docs {
            for (f, values) in fields.iter().enumerate() {
                let items: Vec<&[u8]> = values.iter().map(Vec::as_slice).collect();
                for (t, n) in super::pairs::of(&items) {
                    out.insert((scope.kind, t, *doc, f as u32), n);
                }
            }
        }
    }
    out
}

#[test]
fn pair_postings_are_built_kept_and_deleted_while_writes_go_on() {
    let _turn = turn();
    let dir = temp_dir("pairs");
    let mut lib = build(&dir, 9, 300);
    let docs: Vec<u64> = lib.world.library.docs.keys().copied().collect();
    let mut r = Rng(5);
    assert!(pair_slots(&lib.store).is_empty());
    pairs_on(&lib.store, true);
    // Writes between the build's slices, before and after where it has reached.
    let (mut i, mut slices) = (0, 0);
    let swap = temp_dir("pairs-swap");
    while pairs_step(&lib.store) {
        slices += 1;
        if slices == 5 {
            // Stopped and opened again: the pass resumes from what was kept.
            drop(std::mem::replace(&mut lib.store, open(&swap)));
            lib.store = open(&dir);
        }
        for _ in 0..3 {
            random_edit(&mut lib, &mut r, &docs, i);
            i += 1;
        }
    }
    assert!(slices > 10, "{slices}");
    assert_eq!(lib.store.pairs_mode().unwrap(), super::pairs::ON);
    assert_eq!(pair_slots(&lib.store), pair_slots_of(&lib.world));
    for _ in 0..40 {
        random_edit(&mut lib, &mut r, &docs, i);
        i += 1;
    }
    assert_eq!(pair_slots(&lib.store), pair_slots_of(&lib.world));
    // Phrases answer as a scan; two whole words are decided by their pair, with no text read.
    let c = |t: &str| clause(t, None, false, false);
    for clauses in [
        vec![clause("dark knight", None, false, true)],
        vec![clause("the dark knight", None, false, true), c("love")],
        vec![c("foo-bar"), c("x9")],
        vec![clause("knight the", None, false, true), c("dragon")],
    ] {
        check(&lib, &query(clauses, 6));
    }
    let f = lib
        .store
        .search(&query(vec![clause("dark knight", None, false, true)], 1000))
        .unwrap();
    assert!(!f.hits.is_empty());
    assert_eq!(f.texts, 0);
    // The phrase's candidates are the documents holding its pair, not every document holding both words.
    let pair = super::pairs::term("dark", "knight");
    let holding: std::collections::BTreeSet<u64> = pair_slots(&lib.store)
        .keys()
        .filter(|(k, t, _, _)| *k == Scope::LIBRARY.kind && *t == pair)
        .map(|&(_, _, d, _)| d)
        .collect();
    assert!(
        f.checked <= holding.len() as u64,
        "{} > {}",
        f.checked,
        holding.len()
    );
    // Off: deleted while writes go on.
    pairs_on(&lib.store, false);
    while pairs_step(&lib.store) {
        random_edit(&mut lib, &mut r, &docs, i);
        i += 1;
    }
    assert_eq!(lib.store.pairs_mode().unwrap(), 0);
    assert!(pair_slots(&lib.store).is_empty());
    check(
        &lib,
        &query(vec![clause("dark knight", None, false, true)], 6),
    );
    drop(lib);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&swap);
}

/// A varint whose continuation bit is set with nothing after it: no reader decodes it.
const TRUNCATED: u8 = 0x80;

/// A query over a built store whose value at `k` is overwritten with a value that doesn't decode.
fn query_with_corrupt(name: &str, k: Vec<u8>) -> StoreResult<Found> {
    let _turn = turn();
    let dir = temp_dir(name);
    let lib = build(&dir, 7, 40);
    lib.store
        .keyspace()
        .insert([(k, crate::keyspace::val::Val::Put(vec![TRUNCATED]))], None);
    let r = lib
        .store
        .search(&query(vec![clause("dragon", None, false, false)], 3));
    drop(lib);
    let _ = std::fs::remove_dir_all(&dir);
    r
}

#[test]
fn a_document_count_that_doesnt_decode_fails_the_query() {
    let r = query_with_corrupt("corrupt-docs", super::doc_count(Scope::LIBRARY));
    assert!(r.is_err(), "scored with a corrupt document count");
}

#[test]
fn a_term_count_map_that_doesnt_decode_fails_the_query() {
    let r = query_with_corrupt(
        "corrupt-term",
        super::term_counts_of(Scope::LIBRARY, "dragon"),
    );
    assert!(r.is_err(), "scored with a corrupt term count map");
}

/// BM25's term frequency part, written out: `K1` = 1.2, `B` = 0.75.
fn tfn(tf: f64, len: f64, ref_len: f64) -> f64 {
    tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * len / ref_len))
}

fn library_doc(fields: &[(usize, &str)]) -> Vec<Vec<Vec<u8>>> {
    let mut d = vec![Vec::new(); Scope::LIBRARY.fields().len()];
    for &(f, text) in fields {
        d[f] = vec![text.as_bytes().to_vec()];
    }
    d
}

fn close(got: f64, want: f64) -> bool {
    (got - want).abs() <= 1e-12 * want.abs().max(1.0)
}

#[test]
fn the_reference_scores_cases_computed_by_hand() {
    // Fields: 0 name (20, prefix, 2.32 tokens), 1 description (3, 353.09 tokens).
    let mut w = World::default();
    w.library.docs.insert(1, library_doc(&[(0, "elf")]));
    w.library.docs.insert(2, library_doc(&[(1, "elf ranger")]));
    w.library.docs.insert(3, library_doc(&[(0, "ranger")]));
    w.library.docs.insert(4, library_doc(&[(1, "ranger")]));
    w.tags.docs.insert(1, vec![vec![b"elf".to_vec()]]);
    w.tags.docs.insert(2, vec![vec![b"elf ranger".to_vec()]]);
    w.members.insert(3, [1].into());
    w.members.insert(2, [2].into());
    // n = 4; "elf" is in 2 documents' text, "ranger" in 3 (carried tags don't count).
    let idf_elf = (1.0f64 + 2.5 / 2.5).ln();
    let idf_ranger = (1.0f64 + 1.5 / 3.5).ln();
    let name1 = 20.0 * tfn(1.0, 1.0, 2.32);
    let desc2 = 3.0 * tfn(1.0, 2.0, 353.09);
    let name1_ranger = 20.0 * tfn(1.0, 1.0, 2.32);
    let desc1 = 3.0 * tfn(1.0, 1.0, 353.09);

    // A whole word: idf times the card's text, plus `TAG_WEIGHT` once for a carrier of a tag named by it.
    let q = query(vec![clause("elf", None, false, true)], 10);
    let (got, total) = brute::search(&w, &q);
    let want = [
        (1, idf_elf * name1),
        (2, idf_elf * (desc2 + 10.0)),
        (3, idf_elf * 10.0),
    ];
    assert_eq!(total, 3);
    assert_eq!(got.len(), 3);
    for ((d, s), (wd, ws)) in got.iter().zip(want) {
        assert!(*d == wd && close(*s, ws), "{got:?} against {want:?}");
    }

    // A word in its fields only: no tag part.
    let q = query(vec![clause("ranger", Some(vec![0, 1]), false, true)], 10);
    let (got, _) = brute::search(&w, &q);
    let want = [
        (3, idf_ranger * name1_ranger),
        (4, idf_ranger * desc1),
        (2, idf_ranger * desc2),
    ];
    assert_eq!(got.len(), 3);
    for ((d, s), (wd, ws)) in got.iter().zip(want) {
        assert!(*d == wd && close(*s, ws), "{got:?} against {want:?}");
    }

    // A phrase: each token's idf times its text, and the tag part at its rarest token's idf.
    let q = query(vec![clause("elf ranger", None, false, true)], 10);
    let (got, total) = brute::search(&w, &q);
    assert_eq!(total, 1);
    let want = idf_elf * desc2 + idf_ranger * desc2 + idf_elf.max(idf_ranger) * 10.0;
    assert!(
        got[0].0 == 2 && close(got[0].1, want),
        "{got:?} against {want}"
    );

    // A prefix (the query's last word, unquoted): prefix terms in prefix fields, whole tokens elsewhere; its
    // count is of the documents holding it either way.
    let q = query(vec![clause("el", None, false, false)], 10);
    let (got, total) = brute::search(&w, &q);
    let idf_el = (1.0f64 + 3.5 / 1.5).ln();
    assert_eq!(total, 3);
    let want = [(1, idf_el * name1), (2, idf_el * 10.0), (3, idf_el * 10.0)];
    for ((d, s), (wd, ws)) in got.iter().zip(want) {
        assert!(*d == wd && close(*s, ws), "{got:?} against {want:?}");
    }
}

/// Every card's score from the reference equals its idf times its text score (`word_text`) and tag, computed here
/// from the card's text.
#[test]
fn the_reference_scores_every_card_at_idf_times_local() {
    let mut r = Rng(31);
    let mut w = World::default();
    for t in 1..=12 {
        let n = 1 + r.below(2);
        let name = sentence(&mut r, n);
        w.tags.docs.insert(t, vec![vec![name.into_bytes()]]);
    }
    for _ in 0..400 {
        let doc = 1 + r.below(1500);
        let mut d = vec![Vec::new(); Scope::LIBRARY.fields().len()];
        for f in [0usize, 1, 2, 3, 7, 8, 9] {
            let n = if f == 0 || f == 7 {
                1 + r.below(3)
            } else {
                r.below(12)
            };
            if n > 0 {
                d[f] = vec![sentence(&mut r, n).into_bytes()];
            }
        }
        w.library.docs.insert(doc, d);
        for _ in 0..r.below(3) {
            w.members.entry(doc).or_default().insert(1 + r.below(12));
        }
    }
    let scope = Scope::LIBRARY;
    let docs: std::collections::BTreeMap<u64, brute::Fields> = w
        .library
        .docs
        .iter()
        .map(|(&d, v)| (d, brute::tokenize_fields(scope, v)))
        .collect();
    let n = docs
        .values()
        .filter(|f| f.iter().flatten().any(|v| !v.is_empty()))
        .count() as f64;
    let mut checked = 0;
    // Words of one token.
    for &word in WORDS.iter().filter(|w| tokens(w.as_bytes()).len() == 1) {
        for prefix in [false, true] {
            let q = query(vec![clause(word, None, false, !prefix)], 10_000);
            let (got, total) = brute::search(&w, &q);
            let tok = tokens(word.as_bytes()).remove(0);
            let prefix = prefix && super::text::char_len(&tok) >= super::text::GRAM_MIN;
            let term = super::text::first_chars(&tok, super::text::GRAM_MAX).to_string();
            let term = if prefix { term } else { tok.clone() };
            let df = docs
                .values()
                .filter(|f| brute::Doc::new(f, scope).holds(&term))
                .count() as f64;
            let idf = super::idf(df, n);
            let named = |t: &u64| {
                let name = &w.tags.docs[t][0][0];
                tokens(name).iter().any(|x| {
                    if prefix {
                        x.starts_with(tok.as_str())
                    } else {
                        *x == tok
                    }
                })
            };
            let mut want = Vec::new();
            let none = std::collections::BTreeSet::new();
            let ids: std::collections::BTreeSet<u64> =
                docs.keys().chain(w.members.keys()).copied().collect();
            let empty: brute::Fields = vec![Vec::new(); scope.fields().len()];
            for d in ids {
                let f = docs.get(&d).unwrap_or(&empty);
                let doc = brute::Doc::new(f, scope);
                let fields: Vec<(u32, u64, f64)> = (0..scope.fields().len())
                    .filter_map(|i| {
                        let tf = doc.count(i, &tok, prefix && scope.fields()[i].prefix);
                        let len = f[i].iter().map(Vec::len).sum::<usize>() as u64;
                        (tf > 0)
                            .then(|| (i as u32, tf, super::code_length(super::length_code(len))))
                    })
                    .collect();
                let tagged = w.members.get(&d).unwrap_or(&none).iter().any(named);
                if fields.is_empty() && !tagged {
                    continue;
                }
                let long = super::long_prefix(false, prefix, &tok);
                want.push((
                    d,
                    super::clause_score(&[idf], &[super::word_text(scope, fields, long)], tagged),
                ));
            }
            want.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
            assert_eq!(total, want.len() as u64, "{word} {prefix}");
            assert_eq!(got, want, "{word} {prefix}");
            checked += want.len();
        }
    }
    assert!(checked > 1000, "{checked}");
}

/// Passes every document.
struct PassAll;

impl super::query::DocCheck for PassAll {
    fn begin<'v>(&self, _view: &'v View<'v>) -> StoreResult<super::query::CheckFn<'v>> {
        Ok(Box::new(|_| Ok(true)))
    }
}

/// Documents `1..=n`, each holding `word` once in its name, after a varying number of other words, and carrying
/// tag 1 when odd.
fn word_lib(dir: &Path, word: &str, n: u64) -> Lib {
    let mut lib = Lib {
        store: open(dir),
        world: World::default(),
    };
    lib.tag(1, "odd");
    for d in 1..=n {
        let filler = "knight ".repeat((d % 9) as usize);
        lib.set(d, 0, &[format!("{filler}{word}")]);
        if d % 2 == 1 {
            lib.assign(d, 1, true);
        }
    }
    lib
}

#[test]
fn a_page_filtered_only_by_document_checks_reports_an_estimated_total() {
    let _turn = turn();
    let dir = temp_dir("checks-only");
    let lib = word_lib(&dir, "omega", 200);
    let q = query(vec![clause("omega", None, false, false)], 3);
    let (want, total) = brute::search(&lib.world, &q);
    let f = lib.store.search(&q).unwrap();
    assert!(f.total_exact);
    assert_eq!(f.total, total);
    let mut checked = q.clone();
    checked.filters = vec![Filter::Check(Arc::new(PassAll))];
    let (got, first) = pages(&lib.store, &checked);
    assert!(first.page_exact);
    assert!(!first.total_exact, "a check can exclude documents");
    assert_eq!(got, want);
    drop(lib);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Documents `1..=n`, each holding "omega psi" in its name after `filler(d)` other words, carrying tag 1 when
/// `carrier(d)`.
fn two_word_lib(dir: &Path, n: u64, filler: fn(u64) -> u64, carrier: fn(u64) -> bool) -> Lib {
    let mut lib = Lib {
        store: open(dir),
        world: World::default(),
    };
    lib.tag(1, "carried");
    for d in 1..=n {
        let filler = "knight ".repeat(filler(d) as usize);
        lib.set(d, 0, &[format!("{filler}omega psi")]);
        if carrier(d) {
            lib.assign(d, 1, true);
        }
    }
    lib
}

/// A walk filtered to 50 ids that passes cards over for not beating the page estimates its total from the ids
/// it checked, not from the words' counts: at most the 50.
#[test]
fn a_floored_walk_led_by_ids_estimates_at_most_their_count() {
    let _turn = turn();
    let dir = temp_dir("ids-lead");
    let lib = two_word_lib(&dir, 2000, |d| d % 9, |_| false);
    let c = |t: &str| clause(t, None, false, false);
    let mut q = query(vec![c("omega"), c("psi")], 3);
    q.filters = vec![Filter::Ids((1..=50).map(|i| i * 40).collect())];
    let (want, _) = brute::search(&lib.world, &q);
    let (got, first) = pages(&lib.store, &q);
    assert!(first.page_exact);
    assert!(
        !first.total_exact,
        "the walk passed cards over by the page's floor"
    );
    assert!(first.total <= 50, "{}", first.total);
    assert_eq!(got, want);
    drop(lib);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A walk led by a tag whose carriers sit at even spacing, every one holding the words, and stopped by its work
/// limit: the ids it covered are that share of the carriers, so the estimate is off from their count only by
/// where the stop falls between two of them.
#[test]
fn a_stopped_walk_led_by_an_evenly_spread_tag_estimates_its_carriers() {
    let _turn = turn();
    let dir = temp_dir("tag-lead");
    let lib = two_word_lib(&dir, 1200, |d| d % 9, |d| d % 12 == 0);
    let carriers = 100u64;
    let c = |t: &str| clause(t, None, false, false);
    // Room for every carrier: no page to beat, so nothing is passed over.
    let mut q = query(vec![c("omega"), c("psi")], 1000);
    q.filters = vec![Filter::AllTags(vec![1])];
    let (_, total) = brute::search(&lib.world, &q);
    assert_eq!(total, carriers);
    let mut stopped = 0;
    for enumerate in [500, 1_000, 2_000, 4_000, 8_000, 16_000] {
        q.limits = Limits {
            enumerate,
            ..Limits::default()
        };
        let f = lib.store.search(&q).unwrap();
        let counted = f.hits.len() as u64;
        if f.page_exact || counted == 0 {
            continue;
        }
        stopped += 1;
        assert!(!f.total_exact);
        let off = (f.total as f64 - carriers as f64).abs();
        let within = (carriers as f64 / counted as f64).max(1.0);
        assert!(
            off <= within,
            "limit {enumerate}: {} from {counted} counted, off by {off} past {within}",
            f.total
        );
    }
    assert!(stopped > 0, "some limit stops the walk after a carrier");
    drop(lib);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Passes even documents.
struct EvenOnly;

impl super::query::DocCheck for EvenOnly {
    fn begin<'v>(&self, _view: &'v View<'v>) -> StoreResult<super::query::CheckFn<'v>> {
        Ok(Box::new(|d| Ok(d % 2 == 0)))
    }
}

/// Every page of a query read by the counting walk (`super::query::run_counting`), following `more`; and the first.
fn counting_pages(s: &Store, q: &Query) -> (Vec<(u64, f64)>, Found) {
    let cache = super::query::StatsCache::default();
    let run = |q: &Query| {
        s.derived_read(|v| super::query::run_counting(v, q, &cache))
            .unwrap()
    };
    let mut q = q.clone();
    let first = run(&q);
    let mut f = first.clone();
    let mut all = Vec::new();
    loop {
        all.extend(f.hits.iter().map(|h| (h.doc, h.score)));
        if !f.more || f.hits.is_empty() {
            break;
        }
        let last = f.hits.last().unwrap();
        q.after = Some(After::Score(last.rank, last.doc));
        q.weights = f.weights.clone();
        f = run(&q);
    }
    (all, first)
}

/// The counting walk's total is exact for a filtered single word past `CHECKED_WHOLE` documents, whose descent
/// can only estimate it: every match is counted however low it scores, and its pages equal the reference's.
#[test]
fn the_counting_walk_counts_a_filtered_words_every_match() {
    let _turn = turn();
    let dir = temp_dir("counting");
    let word = "supercalifragilisticexpialidocious";
    let lib = word_lib(&dir, word, 400);
    let c = |t: &str| clause(t, None, false, false);
    let evens: Vec<u64> = (1..=400).filter(|d| d % 2 == 0).collect();
    // Each filter, and the reference's for it.
    let filters: Vec<(Vec<Filter>, Vec<Filter>)> = vec![
        (
            vec![Filter::Ids((1..=300).collect())],
            vec![Filter::Ids((1..=300).collect())],
        ),
        (
            vec![Filter::AllTags(vec![1])],
            vec![Filter::AllTags(vec![1])],
        ),
        (
            vec![Filter::Check(Arc::new(EvenOnly))],
            vec![Filter::Ids(evens.clone())],
        ),
        (
            vec![
                Filter::NotIds((1..=50).collect()),
                Filter::Check(Arc::new(EvenOnly)),
            ],
            vec![Filter::NotIds((1..=50).collect()), Filter::Ids(evens)],
        ),
    ];
    // A prefix past the prefix terms, a prefix term, the whole word, and the word in the name alone.
    let clauses = [
        c("supercalifragilisticexp"),
        c("supercal"),
        clause(word, None, false, true),
        clause(word, Some(vec![0]), false, false),
    ];
    for (fs, reference) in &filters {
        for cl in &clauses {
            let mut q = query(vec![cl.clone()], 3);
            q.filters = fs.clone();
            let mut r = q.clone();
            r.filters = reference.clone();
            let (want, total) = brute::search(&lib.world, &r);
            assert!(total > 128, "{fs:?} {cl:?}: {total}");
            let at = format!("{fs:?} {:?}", describe(&q));
            assert!(
                !lib.store.search(&q).unwrap().total_exact,
                "{at}: the descent estimates"
            );
            let (got, first) = counting_pages(&lib.store, &q);
            assert!(first.page_exact, "{at}");
            assert!(first.total_exact, "{at}");
            assert_eq!(first.total, total, "{at}");
            assert_eq!(got, want, "{at}");
        }
    }
    drop(lib);
    let _ = std::fs::remove_dir_all(&dir);
}

/// The counting walk passes a node above level 0 only where its clause can't match. Cards 1 and 2 score best and
/// fill a one-card page and the one after it; card `1 << 30` holds the word outside the name, so its block can't
/// match a name-only clause and the walk climbs from it; card `1 << 30 | 1 << 21`, in the same level-2 node, holds
/// it in a long name and can't beat them, so a walk passing nodes by the page's floor would pass it over. Both the
/// counting walk and a search the descent hands to it count it, and their totals are exact.
#[test]
fn the_counting_walk_passes_no_node_for_not_beating_the_page() {
    let _turn = turn();
    let dir = temp_dir("counting-nodes");
    let mut lib = Lib {
        store: open(&dir),
        world: World::default(),
    };
    let (outside, low) = (1u64 << 30, 1u64 << 30 | 1 << 21);
    lib.set(1, 0, &["omega".into()]);
    lib.set(2, 0, &["omega".into()]);
    lib.set(outside, 0, &["knight".into()]);
    lib.set(outside, 1, &["omega".into()]);
    lib.set(low, 0, &[format!("{}omega", "knight ".repeat(20))]);
    let mut q = query(vec![clause("omega", Some(vec![0]), false, false)], 1);
    q.filters = vec![Filter::Ids(vec![1, 2, outside, low])];
    q.limits.ranked = 0;
    let (want, total) = brute::search(&lib.world, &q);
    assert_eq!(total, 3);
    let (got, first) = counting_pages(&lib.store, &q);
    assert!(first.total_exact);
    assert_eq!(first.total, total);
    assert_eq!(got, want);
    let (got, first) = pages(&lib.store, &q);
    assert!(first.steps > 0, "the walk read the page");
    assert!(first.total_exact);
    assert_eq!(first.total, total);
    assert_eq!(got, want);
    drop(lib);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Pages 1 to 3 of single words under includes equal the reference's, read as a search reads them: by the descent
/// where it finishes within its budget, else by the counting walk, whose total is then exact. A `ranked` limit of 0
/// sends every page to the walk.
#[test]
fn a_filtered_words_pages_equal_a_scan_whichever_side_reads_them() {
    let _turn = turn();
    let c = |t: &str| clause(t, None, false, false);
    let (mut walked, mut descended) = (0, 0);
    for (name, id) in [("r4-dense", (|d| d) as fn(u64) -> u64), ("r4-sparse", spread_id)] {
        let dir = temp_dir(name);
        let lib = build_ids(&dir, 4, 300, id);
        let ids: Vec<u64> = lib.world.library.docs.keys().copied().step_by(3).collect();
        for cl in [
            c("the"),
            c("dra"),
            c("d"),
            c("knight"),
            clause("the", None, false, true),
            clause("dra", Some(vec![0]), false, false),
        ] {
            for filters in [
                vec![Filter::AllTags(vec![1])],
                vec![Filter::AnyTag(vec![2, 3, 4])],
                vec![Filter::Ids(ids.clone())],
                vec![Filter::AllTags(vec![5]), Filter::NoTag(vec![6])],
            ] {
                for ranked in [0, Limits::default().ranked] {
                    for limit in [1, 4] {
                        let mut q = query(vec![cl.clone()], limit);
                        q.filters = filters.clone();
                        q.limits.ranked = ranked;
                        let (want, total) = brute::search(&lib.world, &q);
                        let at = format!("{name} {:?} {filters:?} ranked {ranked} limit {limit}", describe(&q));
                        let mut p = q.clone();
                        let mut got = Vec::new();
                        for page in 0..3 {
                            let f = lib.store.search(&p).unwrap();
                            assert!(f.page_exact, "{at} page {page}");
                            if f.steps > 0 {
                                walked += 1;
                                assert!(f.total_exact, "{at} page {page}: the walk counts every match");
                            } else {
                                descended += 1;
                            }
                            if f.total_exact {
                                assert_eq!(f.total, total, "{at} page {page}");
                            }
                            got.extend(f.hits.iter().map(|h| (h.doc, h.score)));
                            let Some(last) = f.hits.last().filter(|_| f.more) else {
                                break;
                            };
                            p.after = Some(After::Score(last.rank, last.doc));
                        }
                        assert_eq!(got, want[..want.len().min(3 * limit)], "{at}");
                    }
                }
            }
        }
        drop(lib);
        let _ = std::fs::remove_dir_all(&dir);
    }
    assert!(walked > 0 && descended > 0, "walked {walked}, descended {descended}");
}

/// Documents `1..=n`, each holding "omega" in its name; those `carrier` picks carry tag 1, after `filler` other
/// words, the rest after `1 + d % 9`.
fn rare_tag_lib(dir: &Path, n: u64, carrier: fn(u64) -> bool, filler: u64) -> Lib {
    let mut lib = Lib {
        store: open(dir),
        world: World::default(),
    };
    lib.tag(1, "carried");
    for d in 1..=n {
        let filler = if carrier(d) { filler } else { 1 + d % 9 };
        lib.set(d, 0, &[format!("{}omega", "knight ".repeat(filler as usize))]);
        if carrier(d) {
            lib.assign(d, 1, true);
        }
    }
    lib
}

/// `q`'s first page read as a search reads it, best first however much that costs, and by the counting walk; each
/// with the statistics read afresh.
fn three_reads(lib: &Lib, q: &Query) -> (Found, Found, Found) {
    let read = |f: fn(&View, &Query, &super::query::StatsCache) -> StoreResult<Found>| {
        let cache = super::query::StatsCache::default();
        lib.store.derived_read(|v| f(v, q, &cache)).unwrap()
    };
    (
        read(super::query::run_chosen),
        read(super::query::run_ranked),
        read(super::query::run_counting),
    )
}

/// A word every card holds under a tag 10 of them carry, those scoring lowest: the descent would read the word's
/// every card before reaching them, so it stops at its budget and the counting walk led by the tag reads the
/// page, its total exact. Its work is at most the budget and the walk's alone, and well under the descent's alone.
#[test]
fn a_rare_tag_under_a_common_word_is_read_by_the_walk() {
    let _turn = turn();
    let dir = temp_dir("r4-rare");
    let (n, carriers) = (3000u64, 10u64);
    let lib = rare_tag_lib(&dir, n, |d| d % 300 == 0, 30);
    let mut q = query(vec![clause("omega", None, false, false)], 3);
    q.filters = vec![Filter::AllTags(vec![1])];
    let (want, total) = brute::search(&lib.world, &q);
    assert_eq!(total, carriers);
    let (chosen, ranked, counting) = three_reads(&lib, &q);
    let budget = 2 * carriers * super::query::SEEK;
    eprintln!(
        "rare tag: chosen work {} steps {} gets {}; descent alone work {} checked {}; walk alone work {} steps {}; budget {budget}",
        chosen.work, chosen.steps, chosen.gets, ranked.work, ranked.checked, counting.work, counting.steps
    );
    assert!(chosen.steps > 0, "the walk read the page");
    assert!(chosen.total_exact);
    assert_eq!(chosen.total, total);
    assert!(chosen.page_exact);
    assert_eq!(
        chosen.hits.iter().map(|h| (h.doc, h.score)).collect::<Vec<_>>(),
        want[..3]
    );
    assert!(chosen.steps <= 2 * carriers + 4, "{} steps", chosen.steps);
    assert!(
        chosen.work <= budget + counting.work,
        "{} past the budget {budget} and the walk's {}",
        chosen.work,
        counting.work
    );
    assert!(chosen.work * 4 < ranked.work, "{} against the descent's {}", chosen.work, ranked.work);
    check_pages(&lib, &q, 3);
    drop(lib);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A word every card holds under a tag half of them carry, those scoring highest: the descent finds the page within
/// its budget and reads it as it does with no budget, its one extra read the tag's count (the word's count is read
/// already for a prefix over every field).
#[test]
fn a_common_tag_under_a_word_is_read_best_first_as_before() {
    let _turn = turn();
    let dir = temp_dir("r4-common");
    let lib = rare_tag_lib(&dir, 3000, |d| d % 2 == 0, 0);
    let mut q = query(vec![clause("omega", None, false, false)], 3);
    q.filters = vec![Filter::AllTags(vec![1])];
    let (chosen, ranked, counting) = three_reads(&lib, &q);
    eprintln!(
        "common tag: chosen work {} gets {} checked {}; descent alone work {} gets {} checked {}; walk alone work {}",
        chosen.work, chosen.gets, chosen.checked, ranked.work, ranked.gets, ranked.checked, counting.work
    );
    assert_eq!(chosen.steps, 0, "the descent read the page");
    assert_eq!(chosen.hits, ranked.hits);
    assert_eq!(chosen.checked, ranked.checked);
    assert_eq!(chosen.gets, ranked.gets + 1, "the tag's count");
    assert_eq!(chosen.work, ranked.work + super::query::SEEK);
    check_pages(&lib, &q, 3);
    drop(lib);
    let _ = std::fs::remove_dir_all(&dir);
}

/// One word's next page goes on from the page before by its rank (its score before the idf), which documents
/// created in between (changing the scope's count and the word's, so the idf and every score) don't move: page 2
/// is the new view's order after page 1's last hit, none repeated or skipped. Read best first, by the walk (under
/// ids, with `ranked` 0), and with tag names (tied documents).
#[test]
fn a_words_next_page_goes_on_where_it_was_after_documents_are_created() {
    let _turn = turn();
    let dir = temp_dir("rank-stays");
    let mut lib = build_ids(&dir, 5, 300, |d| d);
    let mut r = Rng(77);
    let ids: Vec<u64> = lib.world.library.docs.keys().copied().collect();
    let mut next_doc = 2000;
    let mut cases = 0;
    for cl in [
        clause("dra", None, false, false),
        clause("the", None, false, false),
        clause("knight", None, false, true),
        clause("dra", Some(vec![0]), false, false),
    ] {
        for (filters, ranked) in [
            (vec![], Limits::default().ranked),
            (vec![Filter::Ids(ids.clone())], 0),
        ] {
            for limit in [3, 7] {
                let mut q = query(vec![cl.clone()], limit);
                q.filters = filters.clone();
                q.limits.ranked = ranked;
                let first = lib.store.search(&q).unwrap();
                let Some(last) = first.hits.last().filter(|_| first.more) else {
                    continue;
                };
                for _ in 0..20 {
                    random_fields(&mut lib, &mut r, next_doc);
                    next_doc += 1;
                }
                let (order, _) = brute::search(&lib.world, &q);
                let at = order.iter().position(|x| x.0 == last.doc).unwrap();
                let want: Vec<(u64, f64)> = order[at + 1..].iter().copied().take(limit).collect();
                let mut p = q.clone();
                p.after = Some(After::Score(last.rank, last.doc));
                let second = lib.store.search(&p).unwrap();
                assert!(second.page_exact, "{q:?}");
                assert_eq!(hits(&second), want, "{q:?} {filters:?} limit {limit}");
                cases += 1;
            }
        }
    }
    assert!(cases >= 8, "{cases}");
    drop(lib);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Several words' later pages rank by the idfs page 1 ranked by (`Found::weights`, sent back as `Query::weights`):
/// documents created between pages 1 and 2 change the words' counts, and page 2 is the reference's order on the
/// new view under page 1's idfs after page 1's last hit, none repeated or skipped. Words, a phrase, a word in a
/// field, words matching tag names (tied documents), and one word beside a negated one (no weights).
#[test]
fn several_words_next_page_ranks_by_the_first_pages_idfs() {
    let _turn = turn();
    let dir = temp_dir("weights-stay");
    let mut lib = build_ids(&dir, 6, 300, |d| d);
    let mut r = Rng(91);
    let mut next_doc = 2000;
    let c = |t: &str| clause(t, None, false, false);
    let (mut weighted, mut moved) = (0, 0);
    for clauses in [
        vec![c("the"), c("knight")],
        vec![clause("dark knight", None, false, true)],
        vec![c("cafe"), c("dra")],
        vec![clause("dragon", Some(vec![0]), false, false), c("the")],
        vec![c("love"), clause("la", None, true, false)],
        vec![c("the"), c("dr")],
    ] {
        for limit in [3, 7] {
            let q = query(clauses.clone(), limit);
            let first = lib.store.search(&q).unwrap();
            let Some(last) = first.hits.last().filter(|_| first.more) else {
                continue;
            };
            // Field 8 is the tags field: a clause there only filters.
            let words: usize = clauses
                .iter()
                .filter(|c| !c.negate && c.fields != Some(vec![8]))
                .map(|c| tokens(&c.text).len())
                .sum();
            match &first.weights {
                Some(w) => {
                    assert_eq!(w.len(), words, "{q:?}");
                    weighted += 1;
                }
                None => assert_eq!(words, 1, "{q:?}: only one word has no weights"),
            }
            for _ in 0..30 {
                random_fields(&mut lib, &mut r, next_doc);
                next_doc += 1;
            }
            let mut fixed = q.clone();
            fixed.weights = first.weights.clone();
            let (order, _) = brute::search(&lib.world, &fixed);
            let at = order.iter().position(|x| x.0 == last.doc).unwrap();
            let want: Vec<(u64, f64)> = order[at + 1..].iter().copied().take(limit).collect();
            let mut p = fixed.clone();
            p.after = Some(After::Score(last.rank, last.doc));
            let second = lib.store.search(&p).unwrap();
            assert!(second.page_exact, "{q:?}");
            assert_eq!(hits(&second), want, "{q:?} limit {limit}");
            assert_eq!(second.weights, first.weights, "{q:?}");
            // What page 2 would have been on the new view's own idfs.
            let (fresh, _) = brute::search(&lib.world, &q);
            moved += usize::from(fresh != order);
        }
    }
    assert!(weighted >= 6, "{weighted}");
    assert!(moved > 0, "the created documents changed some ranking");
    drop(lib);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A query's `weights` must give one idf per token of each positive clause that scores (a clause in the tags field
/// only filters), none for one word: any other count is refused as an invalid cursor.
#[test]
fn weights_that_dont_fit_the_query_are_an_invalid_cursor() {
    let _turn = turn();
    let dir = temp_dir("weights-fit");
    let lib = build(&dir, 7, 60);
    let c = |t: &str| clause(t, None, false, false);
    for (clauses, n) in [
        (vec![c("the"), c("knight")], 1),
        (vec![c("the"), c("knight")], 3),
        (vec![clause("dark knight", None, false, true)], 1),
        (vec![c("the")], 1),
        (vec![c("love"), clause("la", None, true, false)], 2),
        (vec![clause("dragon", Some(vec![8]), false, false), c("the")], 2),
    ] {
        let mut q = query(clauses, 3);
        q.weights = Some(vec![1.5; n]);
        let err = lib.store.search(&q).unwrap_err().to_string();
        assert!(err.contains("invalid cursor"), "{q:?} {n}: {err}");
    }
    // The fitting counts are taken.
    for (clauses, n) in [
        (vec![c("the"), c("knight")], 2),
        (vec![clause("dark knight", None, false, true)], 2),
        (vec![c("the")], 0),
        (vec![c("love"), clause("la", None, true, false)], 0),
        (vec![clause("dragon", Some(vec![8]), false, false), c("the")], 0),
        (vec![clause("dragon", Some(vec![0]), false, false), c("the")], 2),
    ] {
        let mut q = query(clauses, 3);
        q.weights = Some(vec![1.5; n]);
        lib.store.search(&q).unwrap();
    }
    drop(lib);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A filtered prefix word's total: with at most 128 documents every one is checked, so it is exact; above, it is
/// exact only when the walk saw every match, and an estimate otherwise.
#[test]
fn a_filtered_prefix_words_total_is_exact_up_to_128_documents_and_estimated_above_unless_all_were_seen()
 {
    let _turn = turn();
    let c = |t: &str| clause(t, None, false, false);
    // Each filter, and whether above 128 documents its walk can't see every match (so the total is estimated).
    let filters: Vec<(Vec<Filter>, Vec<Clause>, bool)> = vec![
        (vec![Filter::AllTags(vec![1])], vec![], false),
        (vec![Filter::AnyTag(vec![1])], vec![], false),
        (vec![Filter::NoTag(vec![1])], vec![], false),
        (vec![Filter::Ids((1..=100).collect())], vec![], false),
        (vec![Filter::NotIds((1..=100).collect())], vec![], false),
        (vec![Filter::NotIds((1..=10).collect())], vec![], true),
        (vec![], vec![clause("knight", None, true, false)], false),
        (vec![Filter::Check(Arc::new(PassAll))], vec![], false),
    ];
    for n in [128, 129] {
        let dir = temp_dir(&format!("filtered-{n}"));
        let lib = word_lib(&dir, "omega", n);
        for (fs, negated, estimated) in &filters {
            let mut clauses = negated.clone();
            clauses.push(c("omega"));
            let mut q = query(clauses, 3);
            q.filters = fs.clone();
            // The reference has no document checks; one that passes everything changes nothing.
            let mut reference = q.clone();
            reference.filters.retain(|f| !matches!(f, Filter::Check(_)));
            let (want, total) = brute::search(&lib.world, &reference);
            let (got, first) = pages(&lib.store, &q);
            let at = format!("{n} {fs:?} {negated:?}");
            assert!(first.page_exact, "{at}");
            if n <= 128 {
                assert!(first.total_exact, "{at}");
            } else if *estimated {
                assert!(!first.total_exact, "{at}");
            }
            if first.total_exact {
                assert_eq!(first.total, total, "{at}");
            }
            assert_eq!(got, want, "{at}");
        }
        drop(lib);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// The level-0 block maxima of `term` in the library: (slot, value) over every group.
fn maxima_slots(s: &Store, term: &str) -> Vec<(u32, u32)> {
    let start = super::block_maxima_at(Scope::LIBRARY, term, 0);
    s.scan(&start, &key::prefix_end(&start), usize::MAX)
        .unwrap()
        .into_iter()
        .flat_map(|(_, v)| crate::keyspace::val::map_pairs(&v).unwrap())
        .collect()
}

/// A term has a prefix maximum only when a query reads it as a prefix: not of one character, nor over
/// `GRAM_MAX` characters (such a prefix is read through its first `GRAM_MAX`).
#[test]
fn only_terms_read_as_prefixes_have_a_prefix_maximum() {
    let _turn = turn();
    let dir = temp_dir("prefix-slots");
    let s = open(&dir);
    let long = "abcdefghijklmnopqrstuv";
    s.commit_wait(vec![text_value(
        7,
        test_codes::LIBRARY,
        &format!("{long} w"),
    )])
    .unwrap();
    for (term, prefix) in [
        (long, false),
        ("abcdefghijklmnopqrst", true),
        ("ab", true),
        ("w", false),
    ] {
        let slots = maxima_slots(&s, term);
        assert!(!slots.is_empty(), "{term}");
        assert_eq!(
            slots.iter().any(|&(sl, _)| super::unmax_slot(0, sl).2),
            prefix,
            "{term}: {slots:?}"
        );
    }
    s.close();
    let _ = std::fs::remove_dir_all(&dir);
}

/// A card read by a long prefix (over `GRAM_MAX` characters: its first `GRAM_MAX` in the prefix fields, the whole
/// token in the others) whose text score sits just under an `f32`, so its two block maxima are as tight as they
/// get, comes back first among cards in earlier blocks scoring a little less.
#[test]
fn a_long_prefix_card_scoring_just_under_an_f32_comes_back() {
    let _turn = turn();
    let dir = temp_dir("just-under");
    let mut lib = Lib {
        store: open(&dir),
        world: World::default(),
    };
    let prefix = "abcdefghijklmnopqrstu";
    let longer = "abcdefghijklmnopqrstuv";
    // `hits` of `word` among `len` tokens.
    let field = |hits: usize, len: usize, word: &str| {
        let mut t = vec![word; hits];
        t.resize(len, "w");
        t.join(" ")
    };
    // (field, hits, tokens): name and creator hold the longer token, description and scenario the prefix itself.
    let shape = |scenario: usize| {
        [
            (0, 2, 7, longer),
            (1, 1, 11, prefix),
            (3, 1, scenario, prefix),
            (7, 1, 6, longer),
        ]
    };
    let len = |n: usize| super::code_length(super::length_code(n as u64));
    let text = super::word_text(
        Scope::LIBRARY,
        shape(59).map(|(f, hits, n, _)| (f, hits as u64, len(n))),
        true,
    );
    let above = super::max_value(super::max_bits(text));
    assert!(above - text <= 4.0 * text * f64::EPSILON, "{text} {above}");
    let card = 2000;
    // Longer scenarios (of a higher length code) score less.
    for (doc, scenario) in [(3, 65), (500, 72), (900, 65), (card, 59)] {
        for (f, hits, n, word) in shape(scenario) {
            lib.set(doc, f as usize, &[field(hits, n, word)]);
        }
    }
    let q = query(vec![clause(prefix, None, false, false)], 1);
    let f = lib.store.search(&q).unwrap();
    assert_eq!(f.hits.iter().map(|h| h.doc).collect::<Vec<_>>(), [card]);
    check(&lib, &q);
    lib.store.close();
    let _ = std::fs::remove_dir_all(&dir);
}

impl Lib {
    /// Every field of `doc` emptied: it holds no term.
    fn clear(&mut self, doc: u64) {
        for f in 0..10 {
            if self.world.library.docs[&doc][f].iter().any(|v| !v.is_empty()) {
                self.set(doc, f, &[]);
            }
        }
    }
}

/// The blocks a word's first page opens, on a fresh library; after its best cards are emptied, which leaves their
/// blocks' maxima (and shortest lengths) above every card left there; and over rounds of the same query, each
/// followed by the jobs its reports queued. The rounds settle (the last reports nothing) at no more blocks than the
/// first opened, back to `k + 1` plus the blocks tied at the k-th hit's stored score, the answers equal to the
/// reference. The numbers are printed.
#[test]
fn a_words_blocks_opened_settle_at_k_plus_one_once_jobs_lower_what_its_best_cards_left() {
    let _turn = turn();
    for (name, id) in [
        ("regain-dense", (|d| d * 37) as fn(u64) -> u64),
        ("regain-sparse", spread_id),
    ] {
        let dir = temp_dir(name);
        let mut lib = build_fresh(&dir, 12, 400, id);
        for w in [
            clause("dragon", None, false, true),
            clause("the", None, false, true),
            clause("dra", Some(vec![0]), false, false),
            clause("knight", Some(vec![1]), false, true),
        ] {
            let limit = 3;
            let k = limit as u64 + 1;
            let q = query(vec![w.clone()], limit);
            assert!(check_pages(&lib, &q, 1), "{q:?}");
            let fresh = lib.store.search(&q).unwrap().posting_blocks;
            lib.store.jobs_wait();
            // The best cards, more than a page of them, emptied.
            let (all, _) = brute::search(&lib.world, &query(vec![w.clone()], 100_000));
            for &(doc, _) in all.iter().take(3 * k as usize) {
                lib.clear(doc);
            }
            let mut rounds = Vec::new();
            for _ in 0..6 {
                let f = lib.store.search(&q).unwrap();
                rounds.push((f.posting_blocks, f.tighten.len()));
                lib.store.jobs_wait();
            }
            assert!(check_pages(&lib, &q, 2), "{q:?}");
            eprintln!("{name} {q:?} limit {limit}: fresh {fresh}, then (opened, reported) {rounds:?}");
            let (first, last) = (rounds[0].0, rounds[rounds.len() - 1]);
            assert!(last.1 == 0 && last.0 <= first, "{q:?}: {rounds:?}");
            // The blocks whose stored maximum ties the k-th hit's (as in
            // `an_untagged_words_first_page_opens_at_most_k_plus_one_blocks_and_its_ties`).
            let tok = tokens(&w.text).remove(0);
            let prefix = !w.quoted && super::text::char_len(&tok) >= super::text::GRAM_MIN;
            let field = w.fields.as_ref().map(|f| f[0]);
            let (all, _) = brute::search(&lib.world, &query(vec![w.clone()], 100_000));
            let tied = all.get(k as usize - 1).map_or(0, |&(doc, _)| {
                let parts = parts_of(&lib, doc, &tok, prefix, w.fields.as_deref());
                let kth = super::max_bits(super::sum_parts(Scope::LIBRARY, parts, false));
                maxima_maps(&lib.store, &tok)
                    .iter()
                    .flat_map(|(g, m)| m.iter().map(move |&(sl, v)| (*g, sl, v)))
                    .filter(|&(g, sl, bits)| {
                        let (_, f, r) = super::unmax_slot(g, sl);
                        f == field && r == prefix && bits == kth
                    })
                    .count() as u64
            });
            assert!(
                last.0 <= k + 1 + tied,
                "{name} {q:?}: {} opened with {tied} tied, {rounds:?}",
                last.0
            );
        }
        drop(lib);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// The slots of `term`'s level-0 node over block `block`, by sub (`super::unmax_slot`'s field and reading).
fn node_slots(s: &Store, term: &str, block: u64) -> std::collections::BTreeMap<u32, u32> {
    let k = super::block_maxima(Scope::LIBRARY, term, 0, block >> super::GROUP_BITS);
    let node = (block & ((1 << super::GROUP_BITS) - 1)) as u32;
    s.get(&k)
        .unwrap()
        .map_or_else(Vec::new, |b| crate::keyspace::val::map_pairs(&b).unwrap())
        .into_iter()
        .filter(|p| p.0 >> super::NODE_SLOT_BITS == node)
        .map(|(sl, v)| (sl & ((1 << super::NODE_SLOT_BITS) - 1), v))
        .collect()
}

/// The most each slot of `term`'s node over block `block` covers (`max_bits`), by sub, from the documents there as
/// `w` holds them: over every field with `TAG_WEIGHT` where a document carries a tag whose name holds the term in
/// that reading, and without it; and in each field.
fn true_maxima(
    w: &World,
    term: &str,
    block: u64,
) -> (
    std::collections::HashMap<u32, u32>,
    std::collections::HashMap<u32, u32>,
) {
    use std::collections::HashMap;
    let scope = Scope::LIBRARY;
    let defs = scope.fields();
    let (mut tagged, mut text): (HashMap<u32, u32>, HashMap<u32, u32>) = Default::default();
    let most = |m: &mut HashMap<u32, u32>, sub: u32, v: f64| {
        let b = super::max_bits(v);
        let e = m.entry(sub).or_insert(b);
        *e = (*e).max(b);
    };
    let (first, end) = (block << super::BLOCK_BITS, (block + 1) << super::BLOCK_BITS);
    for (&d, values) in w.library.docs.range(first..end) {
        let f = brute::tokenize_fields(scope, values);
        let doc = brute::Doc::new(&f, scope);
        for &r in super::readings(term) {
            let parts: Vec<(u32, u64, f64)> = (0..defs.len())
                .filter_map(|i| {
                    let tf = doc.count(i, term, r && defs[i].prefix);
                    let len = f[i].iter().map(Vec::len).sum::<usize>() as u64;
                    (tf > 0).then(|| (i as u32, tf, super::code_length(super::length_code(len))))
                })
                .collect();
            if parts.is_empty() {
                continue;
            }
            let kind = if r {
                super::TermKind::Gram
            } else {
                super::TermKind::Exact
            };
            let want = (kind, term.to_string());
            let carries = w.members.get(&d).is_some_and(|ts| {
                ts.iter().any(|t| {
                    w.tags.docs.get(t).is_some_and(|n| {
                        n.iter()
                            .flatten()
                            .any(|name| crate::store::carriers::name_terms(name).contains(&want))
                    })
                })
            });
            let sub = u32::from(r);
            most(&mut tagged, sub, super::local(scope, parts.iter().copied(), carries));
            most(&mut text, sub, super::local(scope, parts.iter().copied(), false));
            for &(i, tf, len) in &parts {
                let x = super::field_score(scope, i, tf as f64, len);
                let sub = (i + 1) << 1 | u32::from(r);
                most(&mut tagged, sub, x);
                most(&mut text, sub, x);
            }
        }
    }
    (tagged, text)
}

/// Waits until no tag's carriers are moving and no re-siding scan is under way.
fn settle_moves(s: &Store) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        s.jobs_wait();
        let moving = key::of(key::MOVING);
        let idle = s
            .scan(&moving, &key::prefix_end(&moving), 1)
            .unwrap()
            .is_empty()
            && s.get(&key::of(key::RESIDE)).unwrap().is_none_or(|b| {
                crate::store::carriers::Reside::parse(&b)
                    .unwrap()
                    .scan
                    .is_none()
            });
        if idle {
            return;
        }
        assert!(std::time::Instant::now() < deadline, "moves never ended");
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

/// After deletes and edits, with no carriers moving: each block a query reports has every slot at least the most
/// a document there scores (over every field with its tag part where it carries a matching tag), and once its job
/// ran, exactly that; and answers equal the reference before and after the jobs.
#[test]
fn tightening_jobs_lower_reported_blocks_to_what_their_documents_score() {
    let _turn = turn();
    for (name, id) in [
        ("tight-dense", (|d| d) as fn(u64) -> u64),
        ("tight-sparse", spread_id),
    ] {
        let dir = temp_dir(name);
        let mut lib = build_ids(&dir, 21, 300, id);
        let docs: Vec<u64> = lib.world.library.docs.keys().copied().collect();
        for &d in docs.iter().step_by(4) {
            lib.clear(d);
        }
        let mut r = Rng(77);
        for i in 0..150 {
            random_edit(&mut lib, &mut r, &docs, i);
        }
        settle_moves(&lib.store);
        let mut qs: Vec<Query> = Vec::new();
        let mut words: Vec<Vec<Clause>> = descending_words().into_iter().map(|w| vec![w]).collect();
        for w in ["the", "dr", "d", "kn"] {
            words.push(vec![clause(w, None, false, false)]);
        }
        words.extend(queries());
        for clauses in words {
            for limit in [1, 3] {
                qs.push(query(clauses.clone(), limit));
            }
        }
        // Each reported block with its node's slots, before any job.
        let mut reported: std::collections::BTreeMap<(String, u64), _> = Default::default();
        let mut reports = Vec::new();
        for q in &qs {
            for t in lib.store.search_unqueued(q).unwrap().tighten {
                reported
                    .entry((t.term.clone(), t.block))
                    .or_insert_with(|| node_slots(&lib.store, &t.term, t.block));
                reports.push(t);
            }
        }
        assert!(!reported.is_empty(), "{name}");
        lib.store.tighten_queue(&reports);
        lib.store.jobs_wait();
        let mut lowered = 0;
        for ((term, block), before) in &reported {
            let after = node_slots(&lib.store, term, *block);
            let (tagged, text) = true_maxima(&lib.world, term, *block);
            assert!(
                after.keys().all(|k| before.contains_key(k)),
                "{name} {term:?} block {block}: {before:?} -> {after:?}"
            );
            for (sub, &b) in before {
                let want = tagged.get(sub).copied().unwrap_or(0);
                assert!(
                    b >= want,
                    "{name} {term:?} block {block} sub {sub}: {b} below {want}"
                );
                let got = after.get(sub).copied().unwrap_or(0);
                assert_eq!(got, want, "{name} {term:?} block {block} sub {sub}");
                assert!(got >= text.get(sub).copied().unwrap_or(0));
                lowered += usize::from(got < b);
            }
        }
        assert!(lowered > 0, "{name}");
        for q in &qs {
            check(&lib, q);
        }
        drop(lib);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Whether document `d` carries a tag whose name holds `term` as a whole token, or (`prefix`) as a prefix term.
fn carries(w: &World, d: u64, term: &str, prefix: bool) -> bool {
    let kind = if prefix {
        super::TermKind::Gram
    } else {
        super::TermKind::Exact
    };
    let want = (kind, term.to_string());
    w.members.get(&d).is_some_and(|ts| {
        ts.iter().any(|t| {
            w.tags.docs.get(t).is_some_and(|n| {
                n.iter()
                    .flatten()
                    .any(|name| crate::store::carriers::name_terms(name).contains(&want))
            })
        })
    })
}

/// On a library whose cards carry tags, a word read best first, over every field or in one field, opens on its
/// first page at most `k + 1` posting blocks plus the blocks whose stored maximum ties the k-th hit's score there
/// as stored (over every field with its tag part where the k-th card carries a tag holding the word), and reads
/// at most `(L + 1) + (k + 1 + those)·L` maxima maps, as on an untagged one
/// (`an_untagged_words_first_page_opens_at_most_k_plus_one_blocks_and_its_ties`). No move is in flight.
#[test]
fn a_tagged_words_first_page_opens_at_most_k_plus_one_blocks_and_its_ties() {
    let _turn = turn();
    for (name, id) in [
        ("open-tagged-dense", (|d| d * 37) as fn(u64) -> u64),
        ("open-tagged-sparse", spread_id),
    ] {
        let dir = temp_dir(name);
        let lib = build_fresh_tagged(&dir, 12, 400, id);
        settle_moves(&lib.store);
        let top = *lib.world.library.docs.keys().max().unwrap();
        let l = super::top_level(top >> super::BLOCK_BITS);
        let mut words = descending_words();
        for w in ["the", "dr", "d", "kn"] {
            words.push(clause(w, None, false, false));
        }
        let (mut opened, mut kth_tagged) = (0, 0);
        for w in &words {
            for limit in [1, 3, 7] {
                let q = query(vec![w.clone()], limit);
                if !check_pages(&lib, &q, 1) {
                    continue;
                }
                let field = match w.fields.as_deref() {
                    None => None,
                    Some(&[f]) => Some(f),
                    Some(_) => continue,
                };
                let f = lib.store.search(&q).unwrap();
                let k = limit as u64 + 1;
                let tok = tokens(&w.text).remove(0);
                let prefix = !w.quoted && super::text::char_len(&tok) >= super::text::GRAM_MIN;
                let (term, reading) = match field {
                    Some(f) if prefix && super::text::char_len(&tok) > super::text::GRAM_MAX => {
                        if Scope::LIBRARY.fields()[f as usize].prefix {
                            (
                                super::text::first_chars(&tok, super::text::GRAM_MAX).to_string(),
                                true,
                            )
                        } else {
                            (tok.clone(), false)
                        }
                    }
                    _ => (tok.clone(), prefix),
                };
                let (all, _) = brute::search(&lib.world, &query(vec![w.clone()], 100_000));
                let tied = match all.get(k as usize - 1) {
                    Some(&(doc, _)) => {
                        let parts = parts_of(&lib, doc, &tok, prefix, w.fields.as_deref());
                        let mut text = super::sum_parts(Scope::LIBRARY, parts, false);
                        if field.is_none() && carries(&lib.world, doc, &tok, prefix) {
                            text += super::TAG_WEIGHT;
                            kth_tagged += 1;
                        }
                        let kth = super::max_bits(text);
                        maxima_maps(&lib.store, &term)
                            .iter()
                            .flat_map(|(g, m)| m.iter().map(move |&(sl, v)| (*g, sl, v)))
                            .filter(|&(g, sl, bits)| {
                                let (_, f, r) = super::unmax_slot(g, sl);
                                f == field && r == reading && bits == kth
                            })
                            .count() as u64
                    }
                    None => 0,
                };
                assert!(
                    f.posting_blocks <= k + 1 + tied,
                    "{q:?} limit {limit}: {} with {tied} tied",
                    f.posting_blocks
                );
                assert!(
                    f.max_reads <= (l + 1) + (k + 1 + tied) * l,
                    "{q:?} limit {limit}: {} at L = {l} with {tied} tied",
                    f.max_reads
                );
                opened += f.posting_blocks;
            }
        }
        assert!(
            opened > 0 && kth_tagged > 0,
            "{opened} opened, {kth_tagged} k-th hits tagged"
        );
        drop(lib);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Every page of a query as a read of view `v` gives it, following `more`, and its first page.
fn pages_in(v: &View, q: &Query) -> StoreResult<(Vec<(u64, f64)>, Found)> {
    use super::query::{StatsCache, TagNames, run};
    let mut q = q.clone();
    let mut all = Vec::new();
    let first = run(v, &q, &StatsCache::default(), &TagNames::default())?;
    let mut f = first.clone();
    loop {
        all.extend(f.hits.iter().map(|h| (h.doc, h.score)));
        if !f.more || f.hits.is_empty() {
            break;
        }
        let last = f.hits.last().unwrap();
        q.after = Some(After::Score(last.rank, last.doc));
        q.weights = f.weights.clone();
        f = run(v, &q, &StatsCache::default(), &TagNames::default())?;
    }
    Ok((all, first))
}

/// What the states checked had in flight: a move with its cursor among its carriers, a heavy tag's move and a
/// light one's.
#[derive(Default, Debug)]
struct Flown {
    split: bool,
    heavy: bool,
    light: bool,
}

/// Every query of `queries` answers in view `v` as the reference does over `w`, each page exact.
fn equal_in(v: &View, w: &World, at: &str, flown: &mut Flown) -> StoreResult<()> {
    let p = key::of(key::TAG_MAP);
    for (_, b) in v.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        let m = crate::store::carriers::TagMap::parse(&b)?;
        if let Some(f) = m.flight {
            flown.split |= f.cursor > 0;
            flown.heavy |= m.heavy || f.target_heavy;
            flown.light |= !m.heavy && !f.target_heavy;
        }
    }
    for clauses in queries() {
        let q = query(clauses, 7);
        let (want, total) = brute::search(w, &q);
        let (got, first) = pages_in(v, &q)?;
        assert!(first.page_exact, "{at}: {q:?}");
        if first.total_exact {
            assert_eq!(first.total, total, "{at}: total of {q:?}");
        }
        assert_eq!(got, want, "{at}: {q:?}");
    }
    Ok(())
}

/// With carrier moves held: the answers in the store's state, and in each state stepping its moves leads to
/// until none is left (the first ten, then ever sparser, and the last), equal the reference's.
fn equal_through_steps(lib: &Lib, at: &str, flown: &mut Flown) {
    lib.store
        .derived_read(|v| {
            equal_in(v, &lib.world, &format!("{at}, held"), flown)?;
            let mut layer = std::collections::BTreeMap::new();
            let (mut steps, mut next) = (0, 1);
            loop {
                let mut out = crate::store::derive::Out::default();
                let lv = v.with_layer(&layer);
                let stepped = crate::store::carriers::move_step(&lv, &mut out)?
                    || crate::store::carriers::reside_step(&lv, &mut out)?;
                if stepped {
                    out.apply(&mut layer);
                    steps += 1;
                }
                if steps > 0 && (steps == next || !stepped) {
                    next = steps + 1 + steps / 10;
                    let lv = v.with_layer(&layer);
                    equal_in(&lv, &lib.world, &format!("{at}, {steps} steps"), flown)?;
                }
                if !stepped {
                    return Ok(());
                }
            }
        })
        .unwrap();
}

/// Tagged queries equal the reference while carrier moves are held and through every step they take, dense and
/// spread: light and heavy tags renamed to gain many terms (moves of several steps each), to lose some (a heavy
/// tag's loss alone taken at once), to none; with assigns, unassigns, edits and cards emptied meanwhile; and once
/// the moves ran.
#[test]
fn tagged_results_equal_a_scan_while_carriers_move() {
    let _turn = turn();
    // Every word's name terms: a rename to it gains many, so a move's budget takes few carriers a step.
    let long: String = WORDS.join(" ");
    for (name, id) in [
        ("moving-dense", (|d| d) as fn(u64) -> u64),
        ("moving-sparse", spread_id),
    ] {
        let dir = temp_dir(name);
        let mut lib = build_ids(&dir, 31, 300, id);
        let docs: Vec<u64> = lib.world.library.docs.keys().copied().collect();
        // Tag 1 heavy, with more carriers than a step of a rename to `long` takes.
        for (i, &d) in docs.iter().enumerate() {
            if i % 2 == 0 {
                lib.assign(d, 1, true);
            }
            if i % 5 == 0 {
                lib.assign(d, 2, true);
            }
        }
        settle_moves(&lib.store);
        let maps = |s: &Store| {
            let p = key::of(key::TAG_MAP);
            s.scan(&p, &key::prefix_end(&p), usize::MAX)
                .unwrap()
                .into_iter()
                .map(|(k, b)| {
                    (
                        get_u64(&k, &mut { p.len() }).unwrap(),
                        crate::store::carriers::TagMap::parse(&b).unwrap().heavy,
                    )
                })
                .collect::<std::collections::BTreeMap<u64, bool>>()
        };
        let sides = maps(&lib.store);
        assert!(sides.get(&1) == Some(&true), "{name}: {sides:?}");
        let mut flown = Flown::default();
        let mut r = Rng(5);
        let rounds: [&[(u64, &str)]; 3] = [
            &[(1, &long), (2, &long), (3, "")],
            &[(1, "dark"), (2, "dragon knight"), (4, "vampire girl dark")],
            &[(1, &long), (5, "the dr")],
        ];
        for (i, names) in rounds.into_iter().enumerate() {
            lib.store.hold_carriers(true);
            for &(t, n) in names {
                lib.tag(t, n);
            }
            for j in 0..12 {
                // Assigns, unassigns, edits; no renames past the round's.
                let e = [0, 1, 2, 4][(j % 4) as usize];
                random_edit(&mut lib, &mut r, &docs, e);
            }
            lib.clear(docs[(7 * i + 3) % docs.len()]);
            equal_through_steps(&lib, &format!("{name} round {i}"), &mut flown);
            lib.store.hold_carriers(false);
            settle_moves(&lib.store);
            for clauses in queries() {
                check(&lib, &query(clauses, 7));
            }
        }
        assert!(
            flown.split && flown.heavy && flown.light,
            "{name}: {flown:?}"
        );
        drop(lib);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
