//! The library's orders, numberings, counts and pages against a model of the entities, through flushes,
//! merges, cleaning and reopening.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use super::library::{
    self, ADDED, BY_NAME, CHARACTER, CHAT_SIZE, CREATED, DATA, GROUP, LAST_CHAT, NAME, TAG, WORLD,
};
use super::library_read::{Filter, Page, Query, RangeField, Sort, permute, unpermute};
use super::*;
use crate::log::format::{FieldRef, Record, Value, kind_by_name};

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-lib-{}-{name}-{}",
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

fn create(e: u64, kind: u64, key: &str, added: i64) -> Record {
    rec(
        "entityCreate",
        vec![
            Value::Id(e),
            Value::UInt(kind),
            text(key),
            Value::Time(added),
        ],
    )
}

fn set(e: u64, f: u64, s: &str) -> Record {
    rec(
        "textValue",
        vec![Value::Id(e), Value::Field(FieldRef::Code(f)), text(s)],
    )
}

fn assign(e: u64, t: u64, on: bool) -> Record {
    rec(
        "tagAssign",
        vec![Value::Id(e), Value::Id(t), Value::Bit(on)],
    )
}

#[derive(Debug, Clone)]
struct M {
    kind: u64,
    key: String,
    fav: bool,
    name: String,
    created: Option<f64>,
    added: i64,
    data: u64,
    tags: Vec<u64>,
    world: Option<String>,
}

impl M {
    fn num(&self, sort: u64) -> Option<f64> {
        match sort {
            CREATED if self.kind == GROUP => Some(self.added as f64),
            CREATED => self.created,
            ADDED => Some(self.added as f64),
            LAST_CHAT | CHAT_SIZE => Some(0.0),
            DATA if self.kind == GROUP => None,
            DATA => Some(self.data as f64),
            _ => unreachable!(),
        }
    }

    fn tie(&self) -> Vec<u8> {
        let mut t = self.key.as_bytes().to_vec();
        if self.kind == GROUP {
            t.extend_from_slice(b".json");
        }
        t
    }
}

fn cmp_num(a: Option<f64>, b: Option<f64>) -> std::cmp::Ordering {
    match (a, b) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, _) => std::cmp::Ordering::Less,
        (_, None) => std::cmp::Ordering::Greater,
        (Some(a), Some(b)) => a.partial_cmp(&b).unwrap(),
    }
}

/// The order upstream sorts by: the key, then characters before groups, then the tie; descending reverses it.
fn model_order(m: &BTreeMap<u64, M>, ids: &mut [u64], sort: &Sort) {
    let asc = |a: &M, b: &M, s: u64| {
        let k = if s == BY_NAME {
            library::fold_name(a.name.as_bytes()).cmp(&library::fold_name(b.name.as_bytes()))
        } else {
            cmp_num(a.num(s), b.num(s))
        };
        k.then(a.kind.cmp(&b.kind)).then(a.tie().cmp(&b.tie()))
    };
    ids.sort_by(|x, y| {
        let (a, b) = (&m[x], &m[y]);
        match *sort {
            Sort::Key { sort, desc } => {
                if desc {
                    asc(b, a, sort)
                } else {
                    asc(a, b, sort)
                }
            }
            Sort::Fav { desc } => {
                let g = |v: &M| u8::from(v.fav != desc);
                g(a).cmp(&g(b)).then(asc(a, b, BY_NAME))
            }
            Sort::Random { .. } => unreachable!(),
        }
    });
}

fn matches(m: &M, e: u64, f: &Filter) -> bool {
    (if m.kind == CHARACTER {
        f.characters
    } else {
        f.groups
    }) && f.fav.is_none_or(|v| v == m.fav)
        && f.all_tags.iter().all(|t| m.tags.contains(t))
        && (f.any_tags.is_empty() || f.any_tags.iter().any(|t| m.tags.contains(t)))
        && !f.no_tags.iter().any(|t| m.tags.contains(t))
        && (m.kind == GROUP
            || f.world
                .as_ref()
                .is_none_or(|w| m.world.as_deref().map(str::as_bytes) == Some(w.as_slice())))
        && f.ids.as_ref().is_none_or(|i| i.contains(&e))
        && !f.not_ids.contains(&e)
        && f.ranges.iter().all(|(field, lo, hi)| {
            let v = match field {
                RangeField::Created => m.num(CREATED),
                RangeField::Data => m.num(DATA),
                RangeField::Tag(t) => Some(if m.tags.contains(t) { 1.0 } else { 0.0 }),
                _ => Some(0.0),
            };
            v.is_some_and(|v| lo.is_none_or(|l| v >= l) && hi.is_none_or(|h| v <= h))
        })
}

fn query(f: Filter, sort: Sort, limit: usize) -> Query {
    Query {
        filter: f,
        sort,
        offset: 0,
        limit,
        cursor: None,
        count: true,
        cap: 100_000,
    }
}

/// Every page of `q` through cursors, and its total.
fn all_pages(s: &Store, mut q: Query) -> (Vec<u64>, Page) {
    let first = s.library_page(&q).unwrap();
    let mut ids = first.ids.clone();
    let mut cursor = first.cursor.clone();
    q.count = false;
    while let Some(c) = cursor {
        q.cursor = Some(c);
        let p = s.library_page(&q).unwrap();
        assert!(!p.more, "a page under the cap says more");
        ids.extend(&p.ids);
        cursor = p.cursor;
    }
    (ids, first)
}

const TAGS: [u64; 3] = [900, 901, 902];
const SORTS: [Sort; 15] = [
    Sort::Key {
        sort: BY_NAME,
        desc: false,
    },
    Sort::Key {
        sort: BY_NAME,
        desc: true,
    },
    Sort::Key {
        sort: CREATED,
        desc: false,
    },
    Sort::Key {
        sort: CREATED,
        desc: true,
    },
    Sort::Key {
        sort: ADDED,
        desc: false,
    },
    Sort::Key {
        sort: ADDED,
        desc: true,
    },
    Sort::Key {
        sort: LAST_CHAT,
        desc: false,
    },
    Sort::Key {
        sort: LAST_CHAT,
        desc: true,
    },
    Sort::Key {
        sort: CHAT_SIZE,
        desc: false,
    },
    Sort::Key {
        sort: CHAT_SIZE,
        desc: true,
    },
    Sort::Key {
        sort: DATA,
        desc: false,
    },
    Sort::Key {
        sort: DATA,
        desc: true,
    },
    Sort::Fav { desc: true },
    Sort::Fav { desc: false },
    Sort::Key {
        sort: BY_NAME,
        desc: false,
    },
];

fn filters() -> Vec<Filter> {
    let both = Filter {
        characters: true,
        groups: true,
        ..Filter::default()
    };
    vec![
        both.clone(),
        Filter {
            groups: false,
            ..both.clone()
        },
        Filter {
            characters: false,
            ..both.clone()
        },
        Filter {
            fav: Some(true),
            ..both.clone()
        },
        Filter {
            all_tags: vec![TAGS[0]],
            ..both.clone()
        },
        Filter {
            all_tags: vec![TAGS[0], TAGS[1]],
            ..both.clone()
        },
        Filter {
            any_tags: vec![TAGS[1], TAGS[2]],
            ..both.clone()
        },
        Filter {
            no_tags: vec![TAGS[2]],
            fav: Some(false),
            ..both.clone()
        },
        Filter {
            world: Some(b"lore".to_vec()),
            ..both.clone()
        },
        Filter {
            world: Some(b"lore".to_vec()),
            groups: false,
            ..both.clone()
        },
        Filter {
            ranges: vec![(RangeField::Data, Some(100.0), Some(300.0))],
            ..both.clone()
        },
        Filter {
            ranges: vec![(RangeField::Created, None, Some(5000.0))],
            ..both.clone()
        },
        Filter {
            ranges: vec![(RangeField::Tag(TAGS[1]), Some(1.0), None)],
            ..both.clone()
        },
        Filter {
            ranges: vec![(RangeField::Data, Some(50.0), Some(80.0))],
            ..both.clone()
        },
        Filter {
            ranges: vec![
                (RangeField::Created, Some(-500.0), Some(0.0)),
                (RangeField::Data, Some(0.0), Some(200.0)),
            ],
            all_tags: vec![TAGS[2]],
            ..both.clone()
        },
        Filter {
            ranges: vec![
                (RangeField::Data, Some(10.0), Some(390.0)),
                (RangeField::Data, Some(120.0), None),
            ],
            ..both.clone()
        },
        Filter {
            ranges: vec![(RangeField::Data, Some(300.0), Some(100.0))],
            ..both.clone()
        },
        Filter {
            ranges: vec![(RangeField::Tag(TAGS[0]), None, Some(0.0))],
            ..both.clone()
        },
        Filter {
            ranges: vec![(RangeField::Tag(TAGS[0]), Some(2.0), None)],
            ..both.clone()
        },
        Filter {
            all_tags: vec![TAGS[0], TAGS[1], TAGS[2]],
            ..both.clone()
        },
        Filter {
            all_tags: vec![TAGS[0]],
            no_tags: vec![TAGS[1]],
            ..both.clone()
        },
        Filter {
            any_tags: vec![TAGS[0], TAGS[2]],
            no_tags: vec![TAGS[1]],
            fav: Some(true),
            ..both.clone()
        },
        Filter {
            not_ids: vec![3, 4, 5, 1_000_000],
            ..both.clone()
        },
        Filter {
            ids: Some(vec![9, 2, 40, 41, 7, 1_000_000]),
            ..both.clone()
        },
    ]
}

fn check(s: &Store, m: &BTreeMap<u64, M>) {
    for f in filters() {
        let mut want: Vec<u64> = m
            .keys()
            .copied()
            .filter(|e| matches(&m[e], *e, &f))
            .collect();
        for sort in SORTS {
            model_order(m, &mut want, &sort);
            let (got, first) = all_pages(s, query(f.clone(), sort, 7));
            assert_eq!(got, want, "{f:?} {sort:?}");
            if first.total_exact {
                assert_eq!(first.total, Some(want.len() as u64), "{f:?}");
            }
            // An offset lands where the cursor pages do.
            let mut q = query(f.clone(), sort, 5);
            q.offset = 6;
            let p = s.library_page(&q).unwrap();
            assert_eq!(
                p.ids,
                want.iter().skip(6).take(5).copied().collect::<Vec<_>>()
            );
        }
        // Random: every match once, the same order for the same seed, descending its reverse.
        for desc in [false, true] {
            let (got, _) = all_pages(s, query(f.clone(), Sort::Random { seed: 42, desc }, 6));
            let mut sorted = got.clone();
            sorted.sort_unstable();
            let mut w = want.clone();
            w.sort_unstable();
            assert_eq!(sorted, w, "random {f:?}");
            let (again, _) = all_pages(s, query(f.clone(), Sort::Random { seed: 42, desc }, 4));
            assert_eq!(again, got);
        }
    }
    // Each numbering is dense and maps back.
    for scope in [library::Scope::All, library::Scope::Tag(TAGS[0])] {
        for kind in [CHARACTER, GROUP] {
            for fav in [false, true] {
                s.derived(|v| {
                    let n = library::counter(v, &library::count_key(&scope, kind, fav))?;
                    let want = m
                        .values()
                        .filter(|x| x.kind == kind && x.fav == fav)
                        .filter(|x| match scope {
                            library::Scope::Tag(t) => x.tags.contains(&t),
                            _ => true,
                        })
                        .count();
                    assert_eq!(n as usize, want);
                    let p = library::rand_prefix(&scope, kind, fav);
                    let all = v.scan(&p, &key::prefix_end(&p), usize::MAX)?;
                    assert_eq!(all.len(), want);
                    Ok(())
                })
                .unwrap();
            }
        }
    }
}

struct Lib {
    m: BTreeMap<u64, M>,
    seed: u64,
}

impl Lib {
    fn rand(&mut self) -> u64 {
        self.seed = self
            .seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.seed >> 33
    }

    fn records_for_new(&mut self, e: u64) -> Vec<Record> {
        let kind = if e.is_multiple_of(5) {
            GROUP
        } else {
            CHARACTER
        };
        let names = ["Ana", "bob", "Émile", "zed", "ana", "Ölaf", "carl", ""];
        let name = names[(self.rand() % names.len() as u64) as usize].to_string();
        let key = format!("k{:03}", self.rand() % 1000);
        let key = if self.m.values().any(|x| x.key == key && x.kind == kind) {
            format!("{key}-{e}")
        } else {
            key
        };
        let added = (self.rand() % 50) as i64 * 100;
        let mut recs = vec![create(e, kind, &key, added), set(e, NAME, &name)];
        let mut m = M {
            kind,
            key,
            fav: false,
            name,
            created: None,
            added,
            data: 0,
            tags: Vec::new(),
            world: None,
        };
        if kind == CHARACTER {
            if !self.rand().is_multiple_of(4) {
                let c = (self.rand() % 100) as f64 * 100.0 - 1000.0;
                recs.push(rec("createDate", vec![Value::Id(e), Value::F64(c)]));
                m.created = Some(c);
            }
            m.data = self.rand() % 400;
            recs.push(rec("dataSize", vec![Value::Id(e), Value::UInt(m.data)]));
            if self.rand().is_multiple_of(3) {
                recs.push(set(e, WORLD, "lore"));
                m.world = Some("lore".into());
            }
        }
        if self.rand().is_multiple_of(3) {
            recs.push(rec("fav", vec![Value::Id(e), Value::Bit(true)]));
            m.fav = true;
        }
        for t in TAGS {
            if self.rand().is_multiple_of(3) {
                recs.push(assign(e, t, true));
                m.tags.push(t);
            }
        }
        self.m.insert(e, m);
        recs
    }

    /// One random change to an existing entity.
    fn change(&mut self) -> Vec<Record> {
        let ids: Vec<u64> = self.m.keys().copied().collect();
        let e = ids[(self.rand() % ids.len() as u64) as usize];
        let kind = self.m[&e].kind;
        match self.rand() % 7 {
            0 => {
                let fav = !self.m[&e].fav;
                self.m.get_mut(&e).unwrap().fav = fav;
                vec![rec("fav", vec![Value::Id(e), Value::Bit(fav)])]
            }
            1 => {
                let t = TAGS[(self.rand() % 3) as usize];
                let on = !self.m[&e].tags.contains(&t);
                let m = self.m.get_mut(&e).unwrap();
                if on {
                    m.tags.push(t);
                    m.tags.sort_unstable();
                } else {
                    m.tags.retain(|x| *x != t);
                }
                vec![assign(e, t, on)]
            }
            2 => {
                let name = format!("n{}", self.rand() % 20);
                self.m.get_mut(&e).unwrap().name = name.clone();
                vec![set(e, NAME, &name)]
            }
            3 => {
                // A one-letter edit of the name.
                let old = self.m[&e].name.clone();
                if old.is_empty() || !old.is_ascii() {
                    return Vec::new();
                }
                let new = format!("X{}", &old[1..]);
                self.m.get_mut(&e).unwrap().name = new;
                vec![rec(
                    "textEdit",
                    vec![
                        Value::Id(e),
                        Value::Field(FieldRef::Code(NAME)),
                        Value::UInt(0),
                        Value::UInt(1),
                        text("X"),
                    ],
                )]
            }
            4 if kind == CHARACTER => {
                let d = self.rand() % 400;
                self.m.get_mut(&e).unwrap().data = d;
                vec![rec("dataSize", vec![Value::Id(e), Value::UInt(d)])]
            }
            5 if kind == CHARACTER => {
                let w = self.m[&e].world.is_none();
                self.m.get_mut(&e).unwrap().world = w.then(|| "lore".to_string());
                if w {
                    vec![set(e, WORLD, "lore")]
                } else {
                    vec![rec(
                        "valueDelete",
                        vec![Value::Id(e), Value::Field(FieldRef::Code(WORLD))],
                    )]
                }
            }
            6 if ids.len() > 30 => {
                self.m.remove(&e);
                vec![rec("entityDelete", vec![Value::Id(e)])]
            }
            _ => Vec::new(),
        }
    }
}

fn tag_records() -> Vec<Record> {
    TAGS.iter()
        .map(|t| create(*t, TAG, &format!("tag-{t}"), 0))
        .collect()
}

#[test]
fn pages_follow_every_change_through_flushes_cleaning_and_reopening() {
    let dir = temp_dir("pages");
    let mut lib = Lib {
        m: BTreeMap::new(),
        seed: 7,
    };
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    s.commit_wait(tag_records()).unwrap();
    for e in 1..=60 {
        let r = lib.records_for_new(e);
        s.commit_wait(r).unwrap();
    }
    check(&s, &lib.m);
    for round in 0..4 {
        for _ in 0..150 {
            let r = lib.change();
            if !r.is_empty() {
                s.commit_wait(r).unwrap();
            }
        }
        let next = 1000 + round * 10;
        for e in next..next + 5 {
            let r = lib.records_for_new(e);
            s.commit_wait(r).unwrap();
        }
        check(&s, &lib.m);
    }
    assert!(s.stats().ks.flushes > 0, "the test never flushed");
    s.close();
    drop(s);
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    check(&s, &lib.m);
    s.close();
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_merged_tags_carriers_read_as_the_targets_before_and_after_the_fold() {
    let dir = temp_dir("merge");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let (a, b) = (900, 901);
    s.commit_wait(vec![create(a, TAG, "a", 0), create(b, TAG, "b", 0)])
        .unwrap();
    let n = 700u64;
    for e in 1..=n {
        let mut r = vec![
            create(e, CHARACTER, &format!("c{e:04}"), e as i64),
            set(e, NAME, &format!("c{e:04}")),
        ];
        if e.is_multiple_of(2) {
            r.push(assign(e, a, true));
        }
        if e.is_multiple_of(3) {
            r.push(assign(e, b, true));
        }
        s.commit_wait(r).unwrap();
    }
    let want: Vec<u64> = (1..=n)
        .filter(|e| e.is_multiple_of(2) || e.is_multiple_of(3))
        .collect();
    let f = Filter {
        characters: true,
        groups: true,
        all_tags: vec![b],
        ..Filter::default()
    };
    let byname = Sort::Key {
        sort: BY_NAME,
        desc: false,
    };
    s.commit_wait(vec![rec("tagMerge", vec![Value::Id(a), Value::Id(b)])])
        .unwrap();
    // Whether or not the fold has run, b's readers see a's carriers, each once.
    let (got, first) = all_pages(&s, query(f.clone(), byname, 50));
    assert_eq!(got, want);
    if first.total_exact {
        assert_eq!(first.total, Some(want.len() as u64));
    }
    // Assigning the merged tag assigns its target.
    s.commit_wait(vec![assign(1, a, true)]).unwrap();
    let mut want1 = want.clone();
    want1.insert(0, 1);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let done = s
            .derived(|v| {
                let p = key::of(key::FOLD);
                Ok(v.scan(&p, &key::prefix_end(&p), 1)?.is_empty())
            })
            .unwrap();
        if done {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the fold never finished"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let (got, first) = all_pages(&s, query(f.clone(), byname, 50));
    assert_eq!(got, want1);
    assert_eq!(first.total, Some(want1.len() as u64));
    assert!(first.total_exact);
    // a's orders are empty; a filter on a reads as b.
    let fa = Filter {
        all_tags: vec![a],
        ..f.clone()
    };
    assert_eq!(all_pages(&s, query(fa, byname, 50)).0, want1);
    let ents = s.library_entities(&[6]).unwrap();
    assert_eq!(ents[0].as_ref().unwrap().tags, vec![b]);
    // Reopened, the same; random pages cover every carrier.
    s.close();
    drop(s);
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    assert_eq!(all_pages(&s, query(f.clone(), byname, 50)).0, want1);
    let (r, _) = all_pages(
        &s,
        query(
            f,
            Sort::Random {
                seed: 3,
                desc: false,
            },
            50,
        ),
    );
    let mut r = r;
    r.sort_unstable();
    assert_eq!(r, want1);
    s.close();
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn an_entity_key_is_taken_once_and_deleting_frees_everything_it_held() {
    let dir = temp_dir("delete");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    s.commit_wait(vec![create(900, TAG, "t", 0)]).unwrap();
    s.commit_wait(vec![
        create(1, CHARACTER, "a.png", 5),
        set(1, NAME, "A"),
        assign(1, 900, true),
        rec("fav", vec![Value::Id(1), Value::Bit(true)]),
        rec(
            "jsonValue",
            vec![
                Value::Id(1),
                Value::Field(FieldRef::Key(b"ext:x".to_vec())),
                text("{\"a\":1}"),
            ],
        ),
        rec(
            "itemPlace",
            vec![
                Value::Id(1),
                Value::UInt(0),
                Value::UInt(3),
                Value::UInt(10),
            ],
        ),
        rec(
            "textValue",
            vec![
                Value::Id(1),
                Value::Field(library::item_field(0, 3)),
                text("hi"),
            ],
        ),
        rec(
            "cardHash",
            vec![Value::Id(1), Value::UInt(0), Value::Bytes(vec![1, 2, 3])],
        ),
    ])
    .unwrap();
    assert!(
        s.commit_wait(vec![create(2, CHARACTER, "a.png", 6)])
            .is_err()
    );
    assert_eq!(
        s.library_ids(&[(CHARACTER, b"a.png".to_vec())]).unwrap(),
        vec![Some(1)]
    );
    assert_eq!(s.library_by_hash(0, &[1, 2, 3], 10).unwrap(), vec![1]);
    let e = s.library_entities(&[1]).unwrap()[0].clone().unwrap();
    assert_eq!(e.items, vec![(0, 3, 10)]);
    assert!(e.fav);
    assert_eq!(e.tags, vec![900]);
    assert_eq!(e.values.len(), 3);
    s.commit_wait(vec![rec("entityDelete", vec![Value::Id(1)])])
        .unwrap();
    // Nothing of entity 1 is left but the dead bytes of its records.
    let left = s
        .derived(|v| {
            let mut n = 0;
            for st in [
                key::ENTITY,
                key::TEXT,
                key::VALUE,
                key::ITEM,
                key::ITEM_AT,
                key::FAV,
                key::HASH,
                key::VERSION,
                key::MEMBER_OF,
            ] {
                let p = key::id(st, 1);
                n += v.scan(&p, &key::prefix_end(&p), usize::MAX)?.len();
            }
            for st in [key::ORDER, key::RAND, key::RAND_AT, key::HASH_INDEX] {
                let p = key::of(st);
                n += v.scan(&p, &key::prefix_end(&p), usize::MAX)?.len();
            }
            n += v
                .scan(
                    &key::ids(key::MEMBER, 900, 1),
                    &key::prefix_end(&key::ids(key::MEMBER, 900, 1)),
                    9,
                )?
                .len();
            Ok(n)
        })
        .unwrap();
    assert_eq!(left, 0);
    s.commit_wait(vec![create(2, CHARACTER, "a.png", 6)])
        .unwrap();
    // A tag goes only with its merge.
    assert!(
        s.commit_wait(vec![rec("entityDelete", vec![Value::Id(900)])])
            .is_err()
    );
    s.commit_wait(vec![
        rec("tagMerge", vec![Value::Id(900), Value::Absent]),
        rec("entityDelete", vec![Value::Id(900)]),
    ])
    .unwrap();
    s.close();
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn permute_is_a_bijection_and_unpermute_its_inverse() {
    for n in [1u64, 2, 3, 7, 64, 1000] {
        let mut seen = vec![false; n as usize];
        for i in 0..n {
            let r = permute(i, n, 99);
            assert!(!seen[r as usize]);
            seen[r as usize] = true;
            assert_eq!(unpermute(r, n, 99), i);
        }
    }
}

#[test]
fn a_bulk_load_into_an_empty_library_numbers_every_scope() {
    for failpoint in [0u8, 3] {
        let dir = temp_dir("bulk-numbers");
        let mut lib = Lib {
            m: BTreeMap::new(),
            seed: 11,
        };
        let s = Store::open_in(&dir, SMALL, pool()).unwrap();
        let mut l = s.loader().unwrap();
        l.add(tag_records()).unwrap();
        for e in 1..=80 {
            l.add(lib.records_for_new(e)).unwrap();
        }
        l.fail_at(failpoint);
        let done = l.finish();
        let s = if failpoint == 0 {
            assert!(done.unwrap().number_entries > 0);
            s
        } else {
            // Stopped between the numberings and the load's run: replay numbers the load again over them.
            assert!(done.is_err());
            drop(s);
            Store::open_in(&dir, SMALL, pool()).unwrap()
        };
        check(&s, &lib.m);
        // The commit path numbers on from the load's.
        for _ in 0..120 {
            let r = lib.change();
            if !r.is_empty() {
                s.commit_wait(r).unwrap();
            }
        }
        for e in 2000..2005 {
            s.commit_wait(lib.records_for_new(e)).unwrap();
        }
        check(&s, &lib.m);
        // Characters and groups load only into a library with none.
        let mut l = s.loader().unwrap();
        l.add(lib.records_for_new(3000)).unwrap();
        lib.m.remove(&3000);
        assert!(matches!(l.finish(), Err(StoreError::Refused(_))));
        check(&s, &lib.m);
        drop(s);
        let s = Store::open_in(&dir, SMALL, pool()).unwrap();
        check(&s, &lib.m);
        drop(s);
        fs::remove_dir_all(&dir).unwrap();
    }
}
