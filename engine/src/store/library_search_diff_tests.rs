use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;

use super::library::{BY_NAME, CHARACTER, GROUP, TAG, fold_name, item_field};
use super::library_read::{Filter, Query, Sort};
use super::library_search::{Ordered, Resume, TEST_LIMITS};
use super::*;
use crate::log::format::{Value, kind_by_name};
use crate::search::Scope;
use crate::search::brute::{self, Corpus, World};
use crate::search::query::{self, Clause, Limits, Order};

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-libdiff-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
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

fn pool() -> Arc<Pool> {
    Pool::new(64 << 10, 256 << 10, 4, 1, 2, 2)
}

fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
}

fn text(s: &str) -> Value {
    Value::Text(s.as_bytes().to_vec())
}

fn set(e: u64, f: u64, s: &str) -> Record {
    rec(
        "textValue",
        vec![
            Value::Sel(0, e),
            Value::Field(FieldRef::Code(f)),
            text(s),
            Value::Absent,
            Value::Absent,
        ],
    )
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
    fn chance(&mut self, of: u64) -> bool {
        self.below(of) == 0
    }
    fn pick<'a>(&mut self, xs: &'a [&'a str]) -> &'a str {
        xs[self.below(xs.len() as u64) as usize]
    }
}

const WORDS: &[&str] = &[
    "dark", "knight", "dragon", "drab", "love", "east", "the", "sea", "moon", "red",
];
const TAG_NAMES: [&str; 3] = ["dark knight", "sea", "misc"];
const TAGS: [u64; 3] = [1, 2, 3];

const NAME: (u32, u64) = (0, 1);
const DESCRIPTION: (u32, u64) = (1, 10);
const SCENARIO: (u32, u64) = (3, 12);
const CREATOR: (u32, u64) = (7, 2);
const ALTERNATE: (u32, u64) = (9, 0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pairs {
    No,
    Written,
    Built,
}

fn pairs_step(s: &Store) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    s.pairs_step(Box::new(move |r| tx.send(r).unwrap()));
    rx.recv().unwrap().unwrap()
}

struct Ent {
    kind: u64,
    key: String,
    name: String,
    fav: bool,
    tags: BTreeSet<u64>,
}

struct Lib {
    store: Store,
    ents: BTreeMap<u64, Ent>,
    world: World,
}

fn words(r: &mut Rng, n: u64) -> String {
    (0..n).map(|_| r.pick(WORDS)).collect::<Vec<_>>().join(" ")
}

fn build(dir: &PathBuf, seed: u64, n: u64, pairs: Pairs) -> Lib {
    let s = Store::open_in(dir, SMALL, pool()).unwrap();
    if pairs == Pairs::Written {
        s.commit_wait(vec![rec("searchPairs", vec![Value::Bit(true)])])
            .unwrap();
    }
    let mut world = World {
        pairs: pairs != Pairs::No,
        ..World::default()
    };
    let mut recs = Vec::new();
    for (t, name) in TAGS.iter().zip(TAG_NAMES) {
        recs.push(set(*t, 1, name));
        recs.push(rec(
            "jsonValue",
            vec![
                Value::Sel(0, *t),
                Value::Field(FieldRef::Code(41)),
                text(""),
                Value::Absent,
                Value::Absent,
            ],
        ));
        recs.push(rec(
            "entityCreate",
            vec![
                Value::Id(*t),
                Value::UInt(TAG),
                text(&format!("t{t}")),
                Value::F64(0.0),
            ],
        ));
        world
            .tags
            .docs
            .insert(*t, vec![vec![name.as_bytes().to_vec()]]);
    }
    s.commit_wait(recs).unwrap();
    let mut r = Rng(seed | 1);
    let mut ents = BTreeMap::new();
    let mut library = Corpus::default();
    for e in 10..10 + n {
        let kind = if r.chance(6) { GROUP } else { CHARACTER };
        let key = format!("k{e:04}");
        let len = 1 + r.below(3);
        let name = words(&mut r, len);
        let fav = r.chance(3);
        let tags: BTreeSet<u64> = TAGS.iter().copied().filter(|_| r.chance(3)).collect();
        let mut recs = vec![set(e, NAME.1, &name)];
        let mut fields: Vec<Vec<Vec<u8>>> = vec![Vec::new(); Scope::LIBRARY.fields().len()];
        fields[NAME.0 as usize].push(name.as_bytes().to_vec());
        if kind == CHARACTER {
            for (f, len) in [
                (DESCRIPTION, 8 + r.below(40)),
                (SCENARIO, r.below(6)),
                (CREATOR, r.below(2)),
            ] {
                if len > 0 {
                    let v = words(&mut r, len);
                    recs.push(set(e, f.1, &v));
                    fields[f.0 as usize].push(v.into_bytes());
                }
            }
            for item in 0..r.below(3) {
                let len = 2 + r.below(6);
                let v = words(&mut r, len);
                let FieldRef::Code(code) = item_field(ALTERNATE.1, item) else {
                    unreachable!()
                };
                recs.push(set(e, code, &v));
                recs.push(rec(
                    "itemPlace",
                    vec![
                        Value::Id(e),
                        Value::UInt(ALTERNATE.1),
                        Value::UInt(item),
                        Value::UInt(item),
                    ],
                ));
                fields[ALTERNATE.0 as usize].push(v.into_bytes());
            }
        } else {
            fields[11].push(key.as_bytes().to_vec());
        }
        recs.push(rec("fav", vec![Value::Id(e), Value::Bit(fav)]));
        recs.push(rec(
            "entityCreate",
            vec![Value::Id(e), Value::UInt(kind), text(&key), Value::F64(0.0)],
        ));
        for t in &tags {
            recs.push(rec(
                "tagAssign",
                vec![Value::Id(e), Value::Id(*t), Value::Bit(true)],
            ));
        }
        s.commit_wait(recs).unwrap();
        library.docs.insert(e, fields);
        if !tags.is_empty() {
            world.members.insert(e, tags.clone());
        }
        ents.insert(
            e,
            Ent {
                kind,
                key,
                name,
                fav,
                tags,
            },
        );
    }
    world.library = library;
    if pairs == Pairs::Built {
        s.commit_wait(vec![rec("searchPairs", vec![Value::Bit(true)])])
            .unwrap();
        while pairs_step(&s) {}
    }
    Lib {
        store: s,
        ents,
        world,
    }
}

fn expected(lib: &Lib, clauses: &[Clause], f: &Filter) -> BTreeMap<u64, f64> {
    let q = query::Query {
        scope: Scope::LIBRARY,
        clauses: clauses.to_vec(),
        filters: Vec::new(),
        order: Order::Relevance,
        limit: usize::MAX,
        after: None,
        weights: None,
        limits: Limits::default(),
    };
    let (hits, _) = brute::search(&lib.world, &q);
    hits.into_iter()
        .filter(|(e, _)| {
            let Some(x) = lib.ents.get(e) else {
                return false;
            };
            (if x.kind == CHARACTER {
                f.characters
            } else {
                f.groups
            }) && f.fav.is_none_or(|v| v == x.fav)
                && f.all_tags.iter().all(|t| x.tags.contains(t))
                && (f.any_tags.is_empty() || f.any_tags.iter().any(|t| x.tags.contains(t)))
                && f.no_tags.iter().all(|t| !x.tags.contains(t))
        })
        .collect()
}

fn query(f: Filter, sort: Sort, limit: usize, cap: u64) -> Query {
    Query {
        filter: f,
        sort,
        offset: 0,
        limit,
        cursor: None,
        count: true,
        cap,
    }
}

fn relevance_pages(
    lib: &Lib,
    q: &Query,
    c: &[Clause],
    by_offset: bool,
) -> Result<(Vec<u64>, u64, bool), String> {
    let mut q = q.clone();
    let (mut out, mut after, mut weights): (Vec<u64>, Option<Resume>, Option<Vec<f64>>) =
        (Vec::new(), None, None);
    let mut first = None;
    for _ in 0..10_000 {
        let p = lib
            .store
            .library_search(
                &q,
                c,
                Ordered::Relevance {
                    after: after.clone(),
                    weights: weights.clone(),
                },
            )
            .map_err(|e| format!("{e:?}"))?;
        for w in p.scores.windows(2) {
            if w[0] < w[1] {
                return Err(format!("scores don't descend: {:?}", p.scores));
            }
        }
        first.get_or_insert((p.total, p.total_exact));
        out.extend(&p.ids);
        if !p.more {
            let (t, x) = first.unwrap();
            return Ok((out, t, x));
        }
        if p.ids.is_empty() {
            return Err(format!(
                "an empty page says more follow, after {} ids",
                out.len()
            ));
        }
        if by_offset {
            q.offset += p.ids.len() as u64;
        } else {
            after = p.next.clone();
            weights = p.weights.clone();
            if after.is_none() {
                return Err("a page with more has no next".into());
            }
        }
    }
    Err("pages don't end".into())
}

fn list_pages(lib: &Lib, q: &Query, c: &[Clause]) -> Result<(Vec<u64>, u64, bool), String> {
    let mut q = q.clone();
    let mut out = Vec::new();
    let mut first = None;
    for _ in 0..100_000 {
        let p = lib
            .store
            .library_search(&q, c, Ordered::List)
            .map_err(|e| format!("{e:?}"))?;
        first.get_or_insert((p.total, p.total_exact));
        out.extend(&p.ids);
        q.cursor = p.cursor.clone();
        if q.cursor.is_none() {
            let (t, x) = first.unwrap();
            return Ok((out, t, x));
        }
    }
    Err("pages don't end".into())
}

#[derive(Debug, Clone)]
struct Case {
    clauses: Vec<Clause>,
    filter: Filter,
    limit: usize,
}

fn clause(text: String, fields: Option<Vec<u32>>, negate: bool, quoted: bool) -> Clause {
    Clause {
        text: text.into_bytes(),
        fields,
        negate,
        quoted,
    }
}

fn random_clause(r: &mut Rng) -> Clause {
    let n = 1 + r.below(4);
    let mut t = words(r, n);
    if r.chance(4) {
        let keep = t.len()
            - (t.len() - t.rfind(' ').map_or(0, |i| i + 1))
                .saturating_sub(2)
                .min(2);
        t.truncate(keep.max(2));
    }
    let fields = match r.below(6) {
        0 | 1 => None,
        2 => Some(vec![NAME.0]),
        3 => Some(vec![DESCRIPTION.0]),
        4 => Some(vec![ALTERNATE.0]),
        _ => Some(vec![NAME.0, ALTERNATE.0]),
    };
    clause(t, fields, false, r.chance(2))
}

fn random_case(r: &mut Rng) -> Case {
    let mut clauses = vec![random_clause(r)];
    if r.chance(3) {
        let mut c = random_clause(r);
        c.negate = r.chance(3);
        clauses.push(c);
    }
    let mut filter = Filter {
        characters: true,
        groups: !r.chance(4),
        ..Filter::default()
    };
    if r.chance(4) {
        filter.fav = Some(r.chance(2));
    }
    if r.chance(4) {
        filter.all_tags = vec![TAGS[r.below(3) as usize]];
    }
    if r.chance(5) {
        filter.no_tags = vec![TAGS[r.below(3) as usize]];
    }
    Case {
        clauses,
        filter,
        limit: [3, 7, 50][r.below(3) as usize],
    }
}

fn check(lib: &Lib, case: &Case) -> Option<String> {
    let want = expected(lib, &case.clauses, &case.filter);
    let want_ids: BTreeSet<u64> = want.keys().copied().collect();
    let compare = |what: &str, got: &[u64], total: u64, exact: bool| -> Option<String> {
        let set: BTreeSet<u64> = got.iter().copied().collect();
        if set.len() != got.len() {
            return Some(format!("{what}: an entity on two pages"));
        }
        if set != want_ids {
            let missing: Vec<_> = want_ids.difference(&set).copied().collect();
            let extra: Vec<_> = set.difference(&want_ids).copied().collect();
            return Some(format!(
                "{what}: {} matches, {} reached; missing {missing:?}, extra {extra:?}",
                want_ids.len(),
                set.len()
            ));
        }
        (exact && total != want_ids.len() as u64)
            .then(|| format!("{what}: exact total {total}, {} matches", want_ids.len()))
    };
    let sort = Sort::Key {
        sort: BY_NAME,
        desc: false,
    };
    for by_offset in [false, true] {
        let q = query(case.filter.clone(), sort, case.limit, 20_000);
        match relevance_pages(lib, &q, &case.clauses, by_offset) {
            Ok((got, total, exact)) => {
                if let Some(e) = compare(
                    if by_offset {
                        "relevance by offsets"
                    } else {
                        "relevance"
                    },
                    &got,
                    total,
                    exact,
                ) {
                    return Some(e);
                }
            }
            Err(e) => return Some(format!("relevance (offsets: {by_offset}): {e}")),
        }
    }
    let key = |e: &u64| {
        let x = &lib.ents[e];
        (fold_name(x.name.as_bytes()), x.kind, x.key.clone())
    };
    for (sort, cap) in [
        (
            Sort::Key {
                sort: BY_NAME,
                desc: false,
            },
            20_000,
        ),
        (
            Sort::Key {
                sort: BY_NAME,
                desc: true,
            },
            40,
        ),
        (Sort::Fav { desc: true }, 40),
        (
            Sort::Random {
                seed: 5,
                desc: false,
            },
            40,
        ),
    ] {
        let q = query(case.filter.clone(), sort, case.limit, cap);
        match list_pages(lib, &q, &case.clauses) {
            Ok((got, total, exact)) => {
                if let Some(e) = compare(&format!("{sort:?} cap {cap}"), &got, total, exact) {
                    return Some(e);
                }
                let mut order: Vec<u64> = want_ids.iter().copied().collect();
                match sort {
                    Sort::Key { desc, .. } => {
                        order.sort_by_key(key);
                        if desc {
                            order.reverse();
                        }
                    }
                    Sort::Fav { .. } => order.sort_by_key(|e| (!lib.ents[e].fav, key(e))),
                    Sort::Random { .. } => continue,
                }
                if got != order {
                    return Some(format!("{sort:?}: not in the list's order"));
                }
            }
            Err(e) => return Some(format!("{sort:?}: {e}")),
        }
    }
    None
}

fn minimize(lib: &Lib, mut case: Case) -> Case {
    loop {
        let mut tries = Vec::new();
        for i in 0..case.clauses.len() {
            if case.clauses.len() > 1 {
                let mut c = case.clone();
                c.clauses.remove(i);
                tries.push(c);
            }
            if case.clauses[i].negate {
                let mut c = case.clone();
                c.clauses[i].negate = false;
                tries.push(c);
            }
        }
        let plain = Filter {
            characters: true,
            groups: true,
            ..Filter::default()
        };
        if format!("{:?}", case.filter) != format!("{plain:?}") {
            tries.push(Case {
                filter: plain,
                ..case.clone()
            });
        }
        match tries.into_iter().find(|c| check(lib, c).is_some()) {
            Some(c) => case = c,
            None => return case,
        }
    }
}

fn run(seed: u64, n: u64, cases: usize, limits: Option<Limits>, pairs: Pairs) {
    let dir = temp_dir(&format!("s{seed}"));
    let lib = build(&dir, seed, n, pairs);
    TEST_LIMITS.with(|l| l.set(limits));
    let mut r = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
    for i in 0..cases {
        let case = random_case(&mut r);
        if let Some(e) = check(&lib, &case) {
            let small = minimize(&lib, case);
            let why = check(&lib, &small).unwrap_or(e);
            TEST_LIMITS.with(|l| l.set(None));
            panic!(
                "seed {seed} n {n} limits {limits:?} pairs {pairs:?} case {i}:\n{why}\nclauses {:?}\nfilter {:?} limit {}",
                small
                    .clauses
                    .iter()
                    .map(|c| (
                        String::from_utf8_lossy(&c.text).into_owned(),
                        c.fields.clone(),
                        c.negate,
                        c.quoted
                    ))
                    .collect::<Vec<_>>(),
                small.filter,
                small.limit
            );
        }
    }
    TEST_LIMITS.with(|l| l.set(None));
    drop(lib);
    fs::remove_dir_all(&dir).unwrap();
}

const TIGHT: Limits = Limits {
    enumerate: 4_000,
    ranked: 4_000,
    walked: 4_000,
    tags: 60_000,
};

fn regression(seed: u64, case: Case) {
    let dir = temp_dir(&format!("reg{seed}"));
    let lib = build(&dir, seed, 400, Pairs::No);
    TEST_LIMITS.with(|l| l.set(Some(TIGHT)));
    let failed = check(&lib, &case);
    TEST_LIMITS.with(|l| l.set(None));
    assert_eq!(failed, None);
    drop(lib);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_relevance_walk_past_the_work_limit_goes_on_where_it_stopped() {
    regression(
        11,
        Case {
            clauses: vec![clause(
                "the love da".into(),
                Some(vec![NAME.0]),
                false,
                false,
            )],
            filter: Filter {
                characters: true,
                groups: true,
                ..Filter::default()
            },
            limit: 50,
        },
    );
}

#[test]
fn an_offset_past_the_tied_matches_skips_their_exact_number() {
    regression(
        12,
        Case {
            clauses: vec![clause("knight".into(), None, false, true)],
            filter: Filter {
                characters: true,
                groups: true,
                no_tags: vec![3],
                ..Filter::default()
            },
            limit: 50,
        },
    );
}

#[test]
fn random_searches_reach_every_match_under_the_default_limits() {
    for (seed, pairs) in [(1, Pairs::No), (2, Pairs::Written), (3, Pairs::Built)] {
        run(seed, 300, 60, None, pairs);
    }
}

#[test]
fn random_searches_reach_every_match_past_the_work_limits() {
    let seeds: Vec<u64> = match std::env::var("LIBDIFF_SEEDS") {
        Ok(n) => (100..100 + n.parse::<u64>().unwrap()).collect(),
        Err(_) => vec![11, 12, 13],
    };
    for seed in seeds {
        let pairs = [Pairs::No, Pairs::Written, Pairs::Built][(seed % 3) as usize];
        run(seed, 400, 60, Some(TIGHT), pairs);
    }
}
