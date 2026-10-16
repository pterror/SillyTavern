//! The one-off `Store::one_off_recompute_search_maxima` (deleted with it): a store built with the reference lengths
//! before `d8b53563f`, recomputed with this build's, holds every maxima map a store built from nothing with them
//! holds, and its searches equal a scan of every document. A test binary of its own: the lengths are switched for
//! the whole process (`REF_LEN_OVERRIDE`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use st_engine::keyspace::val::map_pairs;
use st_engine::log::format::{FieldRef, Record, Value, kind_by_name, wtf8_from_utf16};
use st_engine::search::brute::{self, World, clause};
use st_engine::search::one_off_recompute::Counts;
use st_engine::search::query::{After, Clause, Limits, Order, Query};
use st_engine::search::{LIBRARY, REF_LEN_OVERRIDE, RefLen, Scope, TAGS};
use st_engine::store::kinds::key;
use st_engine::store::kinds::test_codes::{self, ITEM_SEPARATOR};
use st_engine::store::{Store, StoreConfig};

/// The reference lengths before `d8b53563f`.
fn old_ref_len(scope: Scope, field: u32) -> f64 {
    let library = [
        2.32, 353.09, 176.75, 68.34, 47.98, 190.37, 95.44, 1.92, 20.83, 298.26, 4.0, 1.0,
    ];
    match scope.kind {
        LIBRARY => library[field as usize],
        TAGS => 2.54,
        _ => unreachable!("only the library and tags are built here"),
    }
}

fn set_lengths(old: bool) {
    *REF_LEN_OVERRIDE.write().unwrap() = old.then_some(old_ref_len as RefLen);
}

fn temp_dir(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("st-engine-recompute-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
}

fn text_value(e: u64, code: u64, s: &str) -> Record {
    rec(
        "textValue",
        vec![
            Value::Sel(0, e),
            Value::Field(FieldRef::Code(code)),
            Value::Text(wtf8_from_utf16(&s.encode_utf16().collect::<Vec<_>>())),
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
    "café",
    "love",
    "lovely",
    "dr",
    "a",
    "i",
    "x9",
    "naïve",
    "supercalifragilisticexpialidocious",
    "supercalifragilisticexpialidocia",
];

fn sentence(r: &mut Rng, n: u64) -> String {
    (0..n)
        .map(|_| WORDS[r.below(WORDS.len() as u64) as usize])
        .collect::<Vec<_>>()
        .join(" ")
}

/// Ids in runs of 50, each run `1 << 27` ids after the last: under level-1 and level-2 nodes past node 0.
fn spread_id(d: u64) -> u64 {
    d % 50 + ((d / 50) << 27)
}

/// A store and the same documents in memory.
struct Lib {
    store: Store,
    world: World,
}

impl Lib {
    fn open(dir: &Path) -> Lib {
        Lib {
            store: Store::open(dir, StoreConfig::default()).unwrap(),
            world: World::default(),
        }
    }

    fn set(&mut self, doc: u64, field: usize, values: &[String]) {
        let joined = values.join(std::str::from_utf8(&[ITEM_SEPARATOR]).unwrap());
        self.store
            .commit_wait(vec![text_value(
                doc,
                test_codes::LIBRARY + field as u64,
                &joined,
            )])
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

    /// Every maxima map, its slots holding nothing dropped.
    fn maxima(&self) -> BTreeMap<Vec<u8>, Vec<(u32, u32)>> {
        let start = key::of(key::SEARCH_BLOCK_MAX);
        let end = key::prefix_end(&start);
        let mut from = start;
        let mut out = BTreeMap::new();
        loop {
            let page = self.store.scan(&from, &end, 256).unwrap();
            for (k, v) in &page {
                let p: Vec<(u32, u32)> = map_pairs(v)
                    .unwrap()
                    .into_iter()
                    .filter(|p| p.1 != 0)
                    .collect();
                if !p.is_empty() {
                    out.insert(k.clone(), p);
                }
            }
            let Some((k, _)) = page.last() else {
                return out;
            };
            from = k.clone();
            from.push(0);
        }
    }

    fn recompute(&self, dry: bool) -> Counts {
        let (tx, rx) = std::sync::mpsc::channel();
        self.store.one_off_recompute_search_maxima(
            dry,
            BATCH,
            Box::new(move |r| {
                let _ = tx.send(r);
            }),
        );
        rx.recv().unwrap().unwrap()
    }
}

/// Text in a document's name, description, example messages, scenario, creator, tags and greetings.
fn fields(r: &mut Rng) -> Vec<(usize, Vec<String>)> {
    let mut out = Vec::new();
    for f in [0usize, 1, 2, 3, 7, 8] {
        let n = if f == 0 || f == 7 {
            1 + r.below(3)
        } else {
            r.below(40)
        };
        out.push((f, vec![sentence(r, n)]));
    }
    let items = (0..r.below(3))
        .map(|_| {
            let n = 1 + r.below(30);
            sentence(r, n)
        })
        .collect();
    out.push((9, items));
    out
}

const DOCS: u64 = 300;
/// Bytes per write: small, so every changed map is written on its own.
const BATCH: usize = 7;
const TAG_COUNT: u64 = 12;

/// Built with the old lengths, with edits that leave maxima loose and terms without postings: each document written,
/// tagged, then a third of them rewritten, cleared of a field, or untagged.
fn build_edited(dir: &Path) -> Lib {
    let mut r = Rng(7);
    let mut lib = Lib::open(dir);
    for t in 1..=TAG_COUNT {
        let n = 1 + r.below(2);
        lib.tag(t, &sentence(&mut r, n));
    }
    for d in 1..=DOCS {
        let doc = spread_id(d);
        for (f, v) in fields(&mut r) {
            lib.set(doc, f, &v);
        }
        lib.set(doc, 3, &[format!("{} gone{d}", sentence(&mut r, 3))]);
        for _ in 0..r.below(3) {
            lib.assign(doc, 1 + r.below(TAG_COUNT), true);
        }
    }
    for d in (1..=DOCS).filter(|d| d % 3 == 0) {
        let doc = spread_id(d);
        match r.below(3) {
            0 => {
                let n = r.below(60);
                lib.set(doc, 1, &[sentence(&mut r, n)]);
            }
            1 => lib.set(doc, 3, &[]),
            _ => {
                let tags: Vec<u64> = lib
                    .world
                    .members
                    .get(&doc)
                    .into_iter()
                    .flatten()
                    .copied()
                    .collect();
                for t in tags {
                    lib.assign(doc, t, false);
                }
            }
        }
    }
    lib
}

/// Built from nothing with `world`'s documents: each field written once, then its tags.
fn build_fresh(dir: &Path, world: &World) -> Lib {
    let mut lib = Lib::open(dir);
    for (&t, v) in &world.tags.docs {
        lib.tag(t, std::str::from_utf8(&v[0][0]).unwrap());
    }
    for (&doc, fs) in &world.library.docs {
        for (f, v) in fs.iter().enumerate() {
            if !v.is_empty() {
                let v: Vec<String> = v
                    .iter()
                    .map(|x| String::from_utf8(x.clone()).unwrap())
                    .collect();
                lib.set(doc, f, &v);
            }
        }
        for &t in world.members.get(&doc).into_iter().flatten() {
            lib.assign(doc, t, true);
        }
    }
    lib
}

fn queries() -> Vec<Vec<Clause>> {
    let c = |t: &str| clause(t, None, false, false);
    vec![
        vec![c("dr")],
        vec![c("dra")],
        vec![c("the")],
        vec![c("dragon")],
        vec![c("the"), c("knight")],
        vec![c("love"), c("dra")],
        vec![clause("dark knight", None, false, true)],
        vec![c("supercalifragilisticexpialidoci")],
        vec![clause("dra", Some(vec![0]), false, false)],
        vec![clause("dra", Some(vec![8]), false, false)],
        vec![c("the"), clause("vampire", None, true, false)],
        vec![c("vampires")],
        vec![c("gone3")],
    ]
}

/// Every page of a query, following `more`, equals the scan's matches.
fn check(lib: &Lib, clauses: Vec<Clause>, limit: usize) {
    let mut q = Query {
        scope: Scope::LIBRARY,
        clauses,
        filters: Vec::new(),
        order: Order::Relevance,
        limit,
        after: None,
        weights: None,
        limits: Limits::default(),
    };
    let (want, _) = brute::search(&lib.world, &q);
    let mut got = Vec::new();
    loop {
        let f = lib.store.search(&q).unwrap();
        got.extend(f.hits.iter().map(|h| (h.doc, h.score)));
        if !f.more || f.hits.is_empty() {
            break;
        }
        let last = f.hits.last().unwrap();
        q.after = Some(After::Score(last.rank, last.doc));
        q.weights = f.weights.clone();
    }
    assert_eq!(
        got,
        want,
        "{:?}",
        q.clauses
            .iter()
            .map(|c| String::from_utf8_lossy(&c.text))
            .collect::<Vec<_>>()
    );
}

#[test]
fn recomputed_maxima_equal_a_fresh_builds_and_searches_equal_a_scan() {
    let (old_dir, fresh_dir) = (temp_dir("old"), temp_dir("fresh"));
    set_lengths(true);
    let lib = build_edited(&old_dir);
    let built = lib.maxima();
    set_lengths(false);
    let fresh = build_fresh(&fresh_dir, &lib.world);
    let want = fresh.maxima();
    drop(fresh);
    assert_ne!(built, want, "the old lengths give other maxima");

    let dry = lib.recompute(true);
    assert_eq!(lib.maxima(), built, "a dry run writes nothing");
    assert!(
        dry.entries > 0 && dry.raised > 0 && dry.lowered > 0,
        "{dry:?}"
    );
    assert!(
        dry.posting_blocks > 350,
        "many posting blocks: {dry:?}"
    );
    let applied = lib.recompute(false);
    assert_eq!(applied, dry, "the dry run counts what the run writes");
    let got = lib.maxima();
    let differ: Vec<_> = got
        .keys()
        .chain(want.keys())
        .filter(|k| got.get(*k) != want.get(*k))
        .take(3)
        .map(|k| (k, got.get(k), want.get(k)))
        .collect();
    assert!(
        differ.is_empty(),
        "maps differ from a fresh build's ({} got, {} wanted), e.g. (key, got, wanted) {differ:?}",
        got.len(),
        want.len()
    );
    let again = lib.recompute(true);
    assert_eq!(again.entries, 0, "{again:?}");

    let Lib { store, world } = lib;
    drop(store);
    let lib = Lib {
        store: Store::open(&old_dir, StoreConfig::default()).unwrap(),
        world,
    };
    assert_eq!(lib.maxima(), want, "kept across a reopen");
    for clauses in queries() {
        for limit in [1, 3, 10] {
            check(&lib, clauses.clone(), limit);
        }
    }
    drop(lib);
    let _ = std::fs::remove_dir_all(&old_dir);
    let _ = std::fs::remove_dir_all(&fresh_dir);
}
