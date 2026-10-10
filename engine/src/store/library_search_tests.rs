//! Searched library pages against a model: which entities match, in relevance order (scores descending, every
//! match once through `after`) and in the list's orders through cursors, under the list's filters.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;

use super::library::{BY_NAME, CHARACTER, GROUP, TAG, fold_name};
use super::library_read::{Filter, Query, Sort};
use super::library_search::{Ordered, Searched};
use super::*;
use crate::log::format::{Value, kind_by_name};
use crate::search::query::Clause;
use crate::search::text::tokens;

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-libsearch-{}-{name}-{}",
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

const WORDS: &[&str] = &[
    "dark", "knight", "dragon", "drab", "love", "quokka", "east", "the",
];

struct Ent {
    kind: u64,
    name: String,
    description: String,
    fav: bool,
    tags: BTreeSet<u64>,
}

const TAGS: [u64; 3] = [1, 2, 3];

fn build(s: &Store, n: u64) -> BTreeMap<u64, Ent> {
    let mut recs = Vec::new();
    for (t, name) in TAGS.iter().zip(["dragon riders", "love", "misc"]) {
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
                Value::Time(0),
            ],
        ));
    }
    s.commit_wait(recs).unwrap();
    let mut ents = BTreeMap::new();
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut rand = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for e in 10..10 + n {
        let kind = if rand() % 5 == 0 { GROUP } else { CHARACTER };
        let w = |r: u64| WORDS[(r % WORDS.len() as u64) as usize];
        let name = format!("{} {}", w(rand()), w(rand()));
        let description = (0..rand() % 6)
            .map(|_| w(rand()))
            .collect::<Vec<_>>()
            .join(" ");
        let fav = rand() % 3 == 0;
        let tags: BTreeSet<u64> = TAGS.iter().copied().filter(|_| rand() % 3 == 0).collect();
        let mut recs = vec![set(e, 1, &name)];
        if kind == CHARACTER && !description.is_empty() {
            recs.push(set(e, 10, &description));
        }
        recs.push(rec("fav", vec![Value::Id(e), Value::Bit(fav)]));
        recs.push(rec(
            "entityCreate",
            vec![
                Value::Id(e),
                Value::UInt(kind),
                text(&format!("k{e:04}")),
                Value::Time(0),
            ],
        ));
        for t in &tags {
            recs.push(rec(
                "tagAssign",
                vec![Value::Id(e), Value::Id(*t), Value::Bit(true)],
            ));
        }
        s.commit_wait(recs).unwrap();
        ents.insert(
            e,
            Ent {
                kind,
                name,
                description: if kind == CHARACTER {
                    description
                } else {
                    String::new()
                },
                fav,
                tags,
            },
        );
    }
    ents
}

fn clause(t: &str, quoted: bool) -> Clause {
    Clause {
        text: t.as_bytes().to_vec(),
        fields: None,
        negate: false,
        quoted,
    }
}

/// Whether `value` holds `phrase` (its tokens adjacent), its last token a prefix when `prefix`.
fn holds(value: &str, phrase: &str, prefix: bool) -> bool {
    let (v, p) = (tokens(value.as_bytes()), tokens(phrase.as_bytes()));
    v.windows(p.len()).any(|w| {
        w.iter().zip(&p).enumerate().all(|(i, (a, b))| {
            a == b
                || (prefix
                    && i == p.len() - 1
                    && b.chars().count() >= 2
                    && a.starts_with(b.as_str()))
        })
    })
}

/// The model's matches of one clause (the query's last), and the filter.
fn expected(ents: &BTreeMap<u64, Ent>, c: &Clause, f: &Filter) -> BTreeSet<u64> {
    let t = std::str::from_utf8(&c.text).unwrap();
    ents.iter()
        .filter(|(_, x)| {
            // The name is a prefix field; the description isn't.
            holds(&x.name, t, !c.quoted)
                || holds(
                    &x.description,
                    t,
                    !c.quoted && tokens(t.as_bytes()).len() > 1,
                )
        })
        .filter(|(_, x)| {
            if x.kind == CHARACTER {
                f.characters
            } else {
                f.groups
            }
        })
        .filter(|(_, x)| f.fav.is_none_or(|v| v == x.fav))
        .filter(|(_, x)| f.all_tags.iter().all(|t| x.tags.contains(t)))
        .filter(|(_, x)| f.no_tags.iter().all(|t| !x.tags.contains(t)))
        .map(|(e, _)| *e)
        .collect()
}

fn query(f: Filter, sort: Sort, limit: usize) -> Query {
    Query {
        filter: f,
        sort,
        offset: 0,
        limit,
        cursor: None,
        count: true,
        cap: 20_000,
    }
}

fn all_pages(s: &Store, q: &Query, c: &Clause, relevance: bool) -> (Vec<u64>, Searched) {
    let mut ids = Vec::new();
    let mut q = q.clone();
    let mut after = None;
    let mut first = None;
    loop {
        let ordered = if relevance {
            Ordered::Relevance { after }
        } else {
            Ordered::List
        };
        let p = s
            .library_search(&q, std::slice::from_ref(c), ordered)
            .unwrap();
        if relevance {
            for w in p.scores.windows(2) {
                assert!(w[0] >= w[1], "scores descend");
            }
        }
        ids.extend(&p.ids);
        let done = if relevance {
            after = p.ids.last().map(|d| (*p.scores.last().unwrap(), *d));
            !p.more || p.ids.is_empty()
        } else {
            q.cursor = p.cursor.clone();
            q.cursor.is_none()
        };
        match &first {
            None => first = Some(p),
            Some(f) => assert_eq!(p.total, f.total),
        }
        if done {
            break;
        }
    }
    (ids, first.unwrap())
}

#[test]
fn searched_pages_equal_the_model_in_every_order() {
    let dir = temp_dir("pages");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let ents = build(&s, 300);
    let filters = [
        Filter {
            characters: true,
            groups: true,
            ..Filter::default()
        },
        Filter {
            characters: true,
            groups: false,
            fav: Some(true),
            ..Filter::default()
        },
        Filter {
            characters: true,
            groups: true,
            all_tags: vec![1],
            no_tags: vec![2],
            ..Filter::default()
        },
    ];
    let clauses = [
        clause("dark", false),
        clause("dr", false),
        clause("dark kn", false),
        clause("dark kn", true),
        clause("dark knight", true),
        clause("quokka east", true),
    ];
    for f in &filters {
        for c in &clauses {
            let want = expected(&ents, c, f);
            // Relevance, pages of 7.
            let (got, first) = all_pages(
                &s,
                &query(
                    f.clone(),
                    Sort::Key {
                        sort: BY_NAME,
                        desc: false,
                    },
                    7,
                ),
                c,
                true,
            );
            assert_eq!(got.len(), want.len(), "{f:?} {c:?}");
            assert_eq!(
                got.iter().copied().collect::<BTreeSet<_>>(),
                want,
                "{f:?} {c:?}"
            );
            // A phrase's total is counted as its candidates are checked: exact once the walk is through them.
            let phrase = tokens(&c.text).len() > 1;
            assert!(phrase || first.total_exact, "{f:?} {c:?} {first:?}");
            if first.total_exact {
                assert_eq!(first.total, want.len() as u64, "{f:?} {c:?}");
            }
            // Random: every match once.
            let (got, _) = all_pages(
                &s,
                &query(
                    f.clone(),
                    Sort::Random {
                        seed: 7,
                        desc: false,
                    },
                    7,
                ),
                c,
                false,
            );
            assert_eq!(got.len(), want.len(), "{f:?} {c:?} random");
            assert_eq!(
                got.iter().copied().collect::<BTreeSet<_>>(),
                want,
                "{f:?} {c:?} random"
            );
            // By name, both ways, and favourites first.
            for sort in [
                Sort::Key {
                    sort: BY_NAME,
                    desc: false,
                },
                Sort::Key {
                    sort: BY_NAME,
                    desc: true,
                },
                Sort::Fav { desc: true },
            ] {
                let (got, _) = all_pages(&s, &query(f.clone(), sort, 7), c, false);
                let mut order: Vec<u64> = want.iter().copied().collect();
                let key = |e: &u64| {
                    let x = &ents[e];
                    (fold_name(x.name.as_bytes()), x.kind, format!("k{e:04}"))
                };
                match sort {
                    Sort::Key { desc: false, .. } => order.sort_by_key(key),
                    Sort::Key { desc: true, .. } => {
                        order.sort_by_key(key);
                        order.reverse();
                    }
                    _ => order.sort_by_key(|e| (!ents[e].fav, key(e))),
                }
                assert_eq!(got, order, "{f:?} {c:?} {sort:?}");
            }
        }
    }
    // A word naming a tag: its chip.
    let p = s
        .library_search(
            &query(
                filters[0].clone(),
                Sort::Key {
                    sort: BY_NAME,
                    desc: false,
                },
                5,
            ),
            &[clause("riders", false)],
            Ordered::Relevance { after: None },
        )
        .unwrap();
    assert_eq!(p.tags.iter().map(|t| t.tag).collect::<Vec<_>>(), vec![1]);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_sorted_search_past_the_few_walks_the_order() {
    let dir = temp_dir("walk");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let ents = build(&s, 400);
    let f = Filter {
        characters: true,
        groups: true,
        ..Filter::default()
    };
    // `the` matches about half: more than √(page · library) for a page of 5.
    let c = clause("the", false);
    let want = expected(&ents, &c, &f);
    assert!(want.len() as f64 > (5.0f64 * 400.0).sqrt());
    let (got, first) = all_pages(
        &s,
        &query(
            f.clone(),
            Sort::Key {
                sort: BY_NAME,
                desc: false,
            },
            5,
        ),
        &c,
        false,
    );
    let mut order: Vec<u64> = want.iter().copied().collect();
    order.sort_by_key(|e| {
        (
            fold_name(ents[e].name.as_bytes()),
            ents[e].kind,
            format!("k{e:04}"),
        )
    });
    assert_eq!(got, order);
    assert_eq!(first.total, want.len() as u64);
    let (got, _) = all_pages(
        &s,
        &query(
            f,
            Sort::Random {
                seed: 3,
                desc: true,
            },
            5,
        ),
        &c,
        false,
    );
    assert_eq!(got.len(), want.len());
    assert_eq!(got.into_iter().collect::<BTreeSet<_>>(), want);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}
