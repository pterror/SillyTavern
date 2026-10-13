//! Searched library pages against a model: which entities match, in relevance order (scores descending, every
//! match once through `after`) and in the list's orders through cursors, under the list's filters.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;

use super::library::{BY_NAME, CHARACTER, GROUP, TAG, fold_name};
use super::library_read::{Filter, Query, Sort};
use super::library_search::{Ordered, Resume, Searched};
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

const TAG_NAMES: [&str; 3] = ["dragon riders", "love", "misc"];

/// Whether an entity carries a tag whose name holds the clause's text.
fn tagged(x: &Ent, t: &str, c: &Clause) -> bool {
    x.tags
        .iter()
        .any(|tag| holds(TAG_NAMES[(*tag - 1) as usize], t, !c.quoted))
}

/// Whether the clause matches the entity's text.
fn texted(x: &Ent, t: &str, c: &Clause) -> bool {
    // The name is a prefix field; the description isn't.
    holds(&x.name, t, !c.quoted)
        || holds(
            &x.description,
            t,
            !c.quoted && tokens(t.as_bytes()).len() > 1,
        )
}

/// The model's matches of one clause (the query's last), and the filter.
fn expected(ents: &BTreeMap<u64, Ent>, c: &Clause, f: &Filter) -> BTreeSet<u64> {
    let t = std::str::from_utf8(&c.text).unwrap();
    ents.iter()
        .filter(|(_, x)| texted(x, t, c) || tagged(x, t, c))
        .filter(|(_, x)| {
            if x.kind == CHARACTER {
                f.characters
            } else {
                f.groups
            }
        })
        .filter(|(_, x)| f.fav.is_none_or(|v| v == x.fav))
        .filter(|(_, x)| f.all_tags.iter().all(|t| x.tags.contains(t)))
        .filter(|(_, x)| f.any_tags.is_empty() || f.any_tags.iter().any(|t| x.tags.contains(t)))
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
    let (mut after, mut weights) = (None, None);
    let mut first = None;
    loop {
        let ordered = if relevance {
            Ordered::Relevance {
                after: after.clone(),
                weights: weights.clone(),
            }
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
            after = p.next.clone();
            weights = p.weights.clone();
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
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

/// Every relevance page of a query, by `next` (`by_offset`: by offsets instead), as (entity, score).
fn relevance_pages(s: &Store, q: &Query, c: &Clause, by_offset: bool) -> Vec<(u64, f64)> {
    let mut q = q.clone();
    let mut out = Vec::new();
    let mut after: Option<Resume> = None;
    let mut weights = None;
    loop {
        let p = s
            .library_search(
                &q,
                std::slice::from_ref(c),
                Ordered::Relevance {
                    after: after.clone(),
                    weights: weights.clone(),
                },
            )
            .unwrap();
        out.extend(p.ids.iter().copied().zip(p.scores.iter().copied()));
        if !p.more || p.ids.is_empty() {
            return out;
        }
        if by_offset {
            q.offset += p.ids.len() as u64;
        } else {
            after = p.next.clone();
            weights = p.weights.clone();
            assert!(after.is_some(), "a page with more has a next");
        }
    }
}

#[test]
fn matches_only_a_tag_name_matches_tie_in_the_lists_order() {
    let dir = temp_dir("tied");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let ents = build(&s, 300);
    let all = Filter {
        characters: true,
        groups: true,
        ..Filter::default()
    };
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
        Sort::Random {
            seed: 3,
            desc: false,
        },
    ] {
        for (word, limit) in [("dr", 7), ("riders", 7), ("lo", 5), ("dr", 300)] {
            let c = clause(word, false);
            let q = query(all.clone(), sort, limit);
            let got = relevance_pages(&s, &q, &c, false);
            assert_eq!(
                got,
                relevance_pages(&s, &q, &c, true),
                "{word} {sort:?} by offsets"
            );
            let want = expected(&ents, &c, &all);
            assert_eq!(got.len(), want.len(), "{word} {sort:?}");
            assert_eq!(got.iter().map(|x| x.0).collect::<BTreeSet<_>>(), want);
            // The tied: carriers of a matching tag the text doesn't match, together, in the list's order.
            let tied: Vec<u64> = want
                .iter()
                .copied()
                .filter(|e| !texted(&ents[e], word, &c))
                .collect();
            let at = got.iter().position(|x| tied.contains(&x.0)).unwrap();
            let tie = got[at].1;
            let segment: Vec<u64> = got[at..at + tied.len()].iter().map(|x| x.0).collect();
            let mut listed = query(all.clone(), sort, 1000);
            listed.filter.ids = Some(tied.clone());
            assert_eq!(
                segment,
                s.library_page(&listed).unwrap().ids,
                "{word} {sort:?}"
            );
            assert!(
                got[..at].iter().all(|x| x.1 >= tie)
                    && got[at + tied.len()..].iter().all(|x| x.1 < tie)
            );
        }
    }
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

#[test]
fn a_tag_merge_moves_its_carriers_matches() {
    let dir = temp_dir("merge");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let mut ents = build(&s, 500);
    let all = Filter {
        characters: true,
        groups: true,
        ..Filter::default()
    };
    let c = clause("dr", false);
    let q = query(
        all.clone(),
        Sort::Key {
            sort: BY_NAME,
            desc: false,
        },
        7,
    );
    // "dragon riders" merges into "misc": its carriers move.
    s.commit_wait(vec![rec("tagMerge", vec![Value::Id(1), Value::Id(3)])])
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !s
        .derived(|v| {
            let p = key::of(key::FOLD);
            Ok(v.scan(&p, &key::prefix_end(&p), 1)?.is_empty())
        })
        .unwrap()
    {
        assert!(
            std::time::Instant::now() < deadline,
            "the fold never finished"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    for x in ents.values_mut() {
        if x.tags.remove(&1) {
            x.tags.insert(3);
        }
    }
    let got = relevance_pages(&s, &q, &c, false);
    assert_eq!(
        got.iter().map(|x| x.0).collect::<BTreeSet<_>>(),
        expected(&ents, &c, &all)
    );
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

/// Whether tag `tag`'s carriers still wait to move (its fold hasn't run).
fn unfolded(s: &Store, tag: u64) -> bool {
    s.derived(|v| {
        let p = key::id(key::MEMBER, tag);
        Ok(!v.scan(&p, &key::prefix_end(&p), 1)?.is_empty())
    })
    .unwrap()
}

/// The list's required tags lead the search through their merge sources: while a merge's carriers wait to move,
/// and once they have, pages in relevance and list order equal the model, for a merged tag, its target, and tags of
/// which one is required.
#[test]
fn tag_filters_lead_through_merges_in_flight() {
    let dir = temp_dir("merging");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let mut ents = build(&s, 500);
    let all = Filter {
        characters: true,
        groups: true,
        ..Filter::default()
    };
    // (the filter, the model's: tag 1 merged into 3 reads as 3)
    let filters = [
        (
            Filter {
                all_tags: vec![3],
                ..all.clone()
            },
            vec![3],
            vec![],
        ),
        (
            Filter {
                all_tags: vec![1],
                ..all.clone()
            },
            vec![3],
            vec![],
        ),
        (
            Filter {
                any_tags: vec![1, 2],
                ..all.clone()
            },
            vec![],
            vec![3, 2],
        ),
        (
            Filter {
                all_tags: vec![2],
                any_tags: vec![3],
                ..all.clone()
            },
            vec![2],
            vec![3],
        ),
    ];
    let sort = Sort::Key {
        sort: BY_NAME,
        desc: false,
    };
    let check = |ents: &BTreeMap<u64, Ent>, at: &str| {
        for (f, all_tags, any_tags) in &filters {
            let model = Filter {
                all_tags: all_tags.clone(),
                any_tags: any_tags.clone(),
                ..f.clone()
            };
            // Clauses no tag name holds: a merged tag's name matching its carriers is no part of this.
            for c in [clause("dark kn", false), clause("east", false)] {
                let want = expected(ents, &c, &model);
                let got = relevance_pages(&s, &query(f.clone(), sort, 7), &c, false);
                assert_eq!(
                    got.iter().map(|x| x.0).collect::<BTreeSet<_>>(),
                    want,
                    "{at} {f:?} {c:?} relevance"
                );
                assert_eq!(got.len(), want.len(), "{at} {f:?} {c:?} relevance");
                let (got, _) = all_pages(&s, &query(f.clone(), sort, 7), &c, false);
                let mut order: Vec<u64> = want.iter().copied().collect();
                order.sort_by_key(|e| {
                    let x = &ents[e];
                    (fold_name(x.name.as_bytes()), x.kind, format!("k{e:04}"))
                });
                assert_eq!(got, order, "{at} {f:?} {c:?} list");
            }
        }
    };
    s.hold_folds(true);
    s.commit_wait(vec![rec("tagMerge", vec![Value::Id(1), Value::Id(3)])])
        .unwrap();
    for x in ents.values_mut() {
        if x.tags.remove(&1) {
            x.tags.insert(3);
        }
    }
    assert!(unfolded(&s, 1), "the merge's carriers wait to move");
    check(&ents, "in flight");
    s.hold_folds(false);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while unfolded(&s, 1) {
        assert!(
            std::time::Instant::now() < deadline,
            "the fold never finished"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    check(&ents, "folded");
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

/// A walk under a library tag filter leads by the tag: with 10 carriers among 10^4 cards holding the words, it
/// takes about two steps per carrier, not one per card.
#[test]
fn a_rare_library_tag_leads_the_walk() {
    let dir = temp_dir("rare-tag");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    s.commit_wait(vec![
        set(1, 1, "rare"),
        rec(
            "jsonValue",
            vec![
                Value::Sel(0, 1),
                Value::Field(FieldRef::Code(41)),
                text(""),
                Value::Absent,
                Value::Absent,
            ],
        ),
        rec(
            "entityCreate",
            vec![Value::Id(1), Value::UInt(TAG), text("t1"), Value::Time(0)],
        ),
    ])
    .unwrap();
    let (n, carriers) = (10_000u64, 10u64);
    let mut recs = Vec::new();
    for e in 10..10 + n {
        recs.push(set(e, 1, "omega psi"));
        recs.push(rec(
            "entityCreate",
            vec![
                Value::Id(e),
                Value::UInt(CHARACTER),
                text(&format!("k{e:05}")),
                Value::Time(0),
            ],
        ));
        if (e - 10) % (n / carriers) == 0 {
            recs.push(rec(
                "tagAssign",
                vec![Value::Id(e), Value::Id(1), Value::Bit(true)],
            ));
        }
        if recs.len() >= 1000 {
            s.commit_wait(std::mem::take(&mut recs)).unwrap();
        }
    }
    s.commit_wait(recs).unwrap();
    let q = query(
        Filter {
            characters: true,
            groups: true,
            all_tags: vec![1],
            ..Filter::default()
        },
        Sort::Key {
            sort: BY_NAME,
            desc: false,
        },
        20,
    );
    let filters = s
        .derived(|v| super::library_search::filters(v, &q))
        .unwrap();
    let found = s
        .search(&crate::search::query::Query {
            scope: crate::search::Scope::LIBRARY,
            clauses: vec![clause("omega", false), clause("psi", false)],
            filters,
            order: crate::search::query::Order::Relevance,
            limit: 20,
            after: None,
            weights: None,
            limits: crate::search::query::Limits::default(),
        })
        .unwrap();
    assert_eq!(found.hits.len() as u64, carriers);
    assert!(
        found.steps <= 2 * carriers + 4,
        "{} steps for {carriers} carriers",
        found.steps
    );
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

/// A merged tag stops existing at its merge: while its carriers wait to move, its old name matches nothing (a
/// search for it finds only cards matching by text), alone or deleted in the same commit as the app does it, as
/// a word, a prefix and a phrase; once the fold ends, its flight is gone.
#[test]
fn a_merged_tags_old_name_matches_nothing_while_its_carriers_wait() {
    let dir = temp_dir("merged-name");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let mut ents = build(&s, 500);
    let all = Filter {
        characters: true,
        groups: true,
        ..Filter::default()
    };
    // Two light tags of five carriers each, no word of the cards' text in their names.
    for (t, name, first) in [(4u64, "wyvern", 10u64), (5, "griffin", 20)] {
        let mut recs = vec![
            set(t, 1, name),
            rec(
                "jsonValue",
                vec![
                    Value::Sel(0, t),
                    Value::Field(FieldRef::Code(41)),
                    text(""),
                    Value::Absent,
                    Value::Absent,
                ],
            ),
            rec(
                "entityCreate",
                vec![
                    Value::Id(t),
                    Value::UInt(TAG),
                    text(&format!("t{t}")),
                    Value::Time(0),
                ],
            ),
        ];
        for e in first..first + 5 {
            recs.push(rec(
                "tagAssign",
                vec![Value::Id(e), Value::Id(t), Value::Bit(true)],
            ));
        }
        s.commit_wait(recs).unwrap();
    }
    s.jobs_wait();
    assert!(s.get(&key::id(key::TAG_MAP, 4)).unwrap().is_none(), "light");
    s.hold_folds(true);
    // Moves held too: a merge queueing one would show.
    s.hold_carriers(true);
    // "griffin" is renamed: its move waits, and it merges in flight.
    s.commit_wait(vec![set(5, 1, "hippogriff")]).unwrap();
    assert!(s.get(&key::id(key::MOVING, 5)).unwrap().is_some());
    for t in [4, 5] {
        s.commit_wait(vec![
            rec("tagMerge", vec![Value::Id(t), Value::Absent]),
            rec("entityDelete", vec![Value::Id(t)]),
        ])
        .unwrap();
    }
    // "dragon riders" into "misc"; "love" into none, deleted with it.
    s.commit_wait(vec![rec("tagMerge", vec![Value::Id(1), Value::Id(3)])])
        .unwrap();
    s.commit_wait(vec![
        rec("tagMerge", vec![Value::Id(2), Value::Absent]),
        rec("entityDelete", vec![Value::Id(2)]),
    ])
    .unwrap();
    for x in ents.values_mut() {
        if x.tags.remove(&1) {
            x.tags.insert(3);
        }
        x.tags.remove(&2);
    }
    let merged = [1, 2, 4, 5];
    assert!(merged.iter().all(|&t| unfolded(&s, t)));
    for tag in merged {
        assert!(
            s.get(&key::id(key::MOVING, tag)).unwrap().is_none(),
            "the fold is tag {tag}'s only walk"
        );
    }
    let sort = Sort::Key {
        sort: BY_NAME,
        desc: false,
    };
    let check = |at: &str| {
        for c in [
            clause("dr", false),
            clause("riders", false),
            clause("dragon riders", true),
            clause("lo", false),
            clause("love", true),
            clause("wyvern", false),
            clause("wy", false),
            clause("griffin", true),
            clause("hippogriff", false),
            clause("hip", false),
        ] {
            let want = expected(&ents, &c, &all);
            let got = relevance_pages(&s, &query(all.clone(), sort, 7), &c, false);
            assert_eq!(
                got.iter().map(|x| x.0).collect::<BTreeSet<_>>(),
                want,
                "{at} {c:?}"
            );
            assert_eq!(got.len(), want.len(), "{at} {c:?}");
        }
    };
    check("in flight");
    s.hold_carriers(false);
    s.hold_folds(false);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while merged.iter().any(|&t| unfolded(&s, t)) {
        assert!(
            std::time::Instant::now() < deadline,
            "the folds never finished"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    check("folded");
    for tag in merged {
        assert!(s.get(&key::id(key::TAG_MAP, tag)).unwrap().is_none());
    }
    let p = key::of(key::TERM_MOVING);
    assert!(
        s.derived(|v| v.scan(&p, &key::prefix_end(&p), 1))
            .unwrap()
            .is_empty()
    );
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

/// Characters `from..from + n`, named from `WORDS`, every fourth carrying tag 1 (whose name "dragon riders" the
/// tied words match).
fn create_cards(s: &Store, from: u64, n: u64) {
    let mut recs = Vec::new();
    for i in 0..n {
        let e = from + i;
        let w = |k: u64| WORDS[(k % WORDS.len() as u64) as usize];
        recs.push(set(e, 1, &format!("{} {}", w(i), w(i * 3 + 1))));
        recs.push(rec(
            "entityCreate",
            vec![
                Value::Id(e),
                Value::UInt(CHARACTER),
                text(&format!("n{e:05}")),
                Value::Time(0),
            ],
        ));
        if i % 4 == 0 {
            recs.push(rec(
                "tagAssign",
                vec![Value::Id(e), Value::Id(1), Value::Bit(true)],
            ));
        }
    }
    s.commit_wait(recs).unwrap();
}

/// One word's next page goes on from the page before by its rank, which cards created in between (changing the
/// library's count and the word's, so its idf and every score) don't move: page 2 is the new view's order after
/// page 1's last card, none repeated or skipped. Pages end among the text matches and among the tied.
#[test]
fn a_words_next_page_goes_on_where_it_was_after_cards_are_created() {
    let dir = temp_dir("rank-stays");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    build(&s, 300);
    let all = Filter {
        characters: true,
        groups: true,
        ..Filter::default()
    };
    let sort = Sort::Key {
        sort: BY_NAME,
        desc: false,
    };
    let mut from = 10_000;
    let mut tied_cursors = 0;
    for (word, quoted) in [("dr", false), ("riders", false), ("knight", true), ("lo", false)] {
        for limit in [5, 40, 120] {
            let c = clause(word, quoted);
            let q = query(all.clone(), sort, limit);
            let first = s
                .library_search(
                    &q,
                    std::slice::from_ref(&c),
                    Ordered::Relevance {
                        after: None,
                        weights: None,
                    },
                )
                .unwrap();
            let Some(next) = first.next.clone() else {
                continue;
            };
            tied_cursors += usize::from(!matches!(next, Resume::Score(..)));
            create_cards(&s, from, 40);
            from += 40;
            let second = s
                .library_search(
                    &q,
                    std::slice::from_ref(&c),
                    Ordered::Relevance {
                        after: Some(next),
                        weights: first.weights.clone(),
                    },
                )
                .unwrap();
            let order = relevance_pages(&s, &q, &c, true);
            let last = *first.ids.last().unwrap();
            let at = order.iter().position(|x| x.0 == last).unwrap();
            let want: Vec<(u64, f64)> = order[at + 1..].iter().copied().take(limit).collect();
            let got: Vec<(u64, f64)> = second
                .ids
                .iter()
                .copied()
                .zip(second.scores.iter().copied())
                .collect();
            assert_eq!(got, want, "{word} limit {limit}");
        }
    }
    assert!(tied_cursors > 0, "some page ends among the tied");
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

/// Every relevance page of a query by offsets, each ranked by `weights` (`Searched::weights`).
fn relevance_order_under(s: &Store, q: &Query, c: &Clause, weights: &Option<Vec<f64>>) -> Vec<(u64, f64)> {
    let mut q = q.clone();
    let mut out = Vec::new();
    loop {
        let p = s
            .library_search(
                &q,
                std::slice::from_ref(c),
                Ordered::Relevance {
                    after: None,
                    weights: weights.clone(),
                },
            )
            .unwrap();
        out.extend(p.ids.iter().copied().zip(p.scores.iter().copied()));
        if !p.more || p.ids.is_empty() {
            return out;
        }
        q.offset += p.ids.len() as u64;
    }
}

/// Several words' next page ranks by the idfs page 1 ranked by, which come back with its `next`: cards created in
/// between change the words' counts, and page 2 is the order under page 1's idfs after page 1's last card, none
/// repeated or skipped. Pages end among the text matches and among the tied; a cursor's weights that don't fit the
/// query are an invalid cursor.
#[test]
fn several_words_next_page_ranks_by_the_first_pages_idfs() {
    let dir = temp_dir("weights-stay");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    build(&s, 300);
    let all = Filter {
        characters: true,
        groups: true,
        ..Filter::default()
    };
    let sort = Sort::Key {
        sort: BY_NAME,
        desc: false,
    };
    let mut from = 10_000;
    let (mut tied_cursors, mut moved) = (0, 0);
    for (words, quoted) in [("dragon ri", false), ("dark knight", true), ("the dr", false)] {
        for limit in [5, 40, 120] {
            let c = clause(words, quoted);
            let q = query(all.clone(), sort, limit);
            let fresh = Ordered::Relevance {
                after: None,
                weights: None,
            };
            let first = s
                .library_search(&q, std::slice::from_ref(&c), fresh)
                .unwrap();
            let Some(next) = first.next.clone() else {
                continue;
            };
            assert_eq!(first.weights.as_ref().map(Vec::len), Some(2), "{words}");
            tied_cursors += usize::from(!matches!(next, Resume::Score(..)));
            let before = relevance_order_under(&s, &q, &c, &None);
            create_cards(&s, from, 40);
            from += 40;
            moved += usize::from(relevance_order_under(&s, &q, &c, &None) != before);
            let second = s
                .library_search(
                    &q,
                    std::slice::from_ref(&c),
                    Ordered::Relevance {
                        after: Some(next.clone()),
                        weights: first.weights.clone(),
                    },
                )
                .unwrap();
            let order = relevance_order_under(&s, &q, &c, &first.weights);
            let last = *first.ids.last().unwrap();
            let at = order.iter().position(|x| x.0 == last).unwrap();
            let want: Vec<(u64, f64)> = order[at + 1..].iter().copied().take(limit).collect();
            let got: Vec<(u64, f64)> = second
                .ids
                .iter()
                .copied()
                .zip(second.scores.iter().copied())
                .collect();
            assert_eq!(got, want, "{words} limit {limit}");
            let wrong = s.library_search(
                &q,
                std::slice::from_ref(&c),
                Ordered::Relevance {
                    after: Some(next),
                    weights: Some(vec![1.0]),
                },
            );
            assert!(
                wrong.is_err_and(|e| e.to_string().contains("invalid cursor")),
                "{words}"
            );
        }
    }
    assert!(tied_cursors > 0, "some page ends among the tied");
    assert!(moved > 0, "the created cards moved some order");
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}
