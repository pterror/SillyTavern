//! The tag manager's orders, counts, lookups and change feeds against a model of the tags, through flushes,
//! merges, folds, prunes and reopening.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use super::library::{CHARACTER, FOLDER_TYPE, NAME, TAG};
use super::tags::{self, ALPHA, ENTRIES, MANUAL, Query};
use super::*;
use crate::log::format::{FieldRef, Record, Value, kind_by_name};

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-tags-{}-{name}-{}",
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

fn create(e: u64, kind: u64, key: &str) -> Record {
    rec(
        "entityCreate",
        vec![Value::Id(e), Value::UInt(kind), text(key), Value::Time(0)],
    )
}

fn set(e: u64, f: u64, s: &str) -> Record {
    rec(
        "textValue",
        vec![Value::Id(e), Value::Field(FieldRef::Code(f)), text(s)],
    )
}

fn json(e: u64, f: FieldRef, s: &str) -> Record {
    rec("jsonValue", vec![Value::Id(e), Value::Field(f), text(s)])
}

fn unset(e: u64, f: u64) -> Record {
    rec(
        "valueDelete",
        vec![Value::Id(e), Value::Field(FieldRef::Code(f))],
    )
}

fn order(t: u64, v: Option<f64>) -> Record {
    rec(
        "tagOrder",
        vec![Value::Id(t), v.map_or(Value::Absent, Value::F64)],
    )
}

fn assign(e: u64, t: u64, on: bool) -> Record {
    rec(
        "tagAssign",
        vec![Value::Id(e), Value::Id(t), Value::Bit(on)],
    )
}

/// A deterministic stream of numbers.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[derive(Debug, Clone)]
struct T {
    name: String,
    folder: Vec<u8>,
    order: Option<f64>,
    carriers: BTreeSet<u64>,
}

const NAMES: &[&str] = &[
    "Alpha",
    "alpha",
    "Ábc",
    "abd",
    "Beta",
    "b",
    "zeta",
    "Ölaf",
    "",
    "a\u{0301}x",
    "İs",
    "ΣΑΣ",
];
const FOLDERS: &[Option<&str>] = &[None, Some("NONE"), Some("OPEN"), Some("CLOSED")];
const ORDERS: &[Option<f64>] = &[
    None,
    Some(0.0),
    Some(1.0),
    Some(1.0),
    Some(-0.0),
    Some(2.5),
    Some(f64::INFINITY),
];

fn ord_cmp(a: Option<f64>, b: Option<f64>) -> std::cmp::Ordering {
    a.unwrap().partial_cmp(&b.unwrap()).unwrap()
}

/// The model's tags matching `q`, in its sort's order.
fn model_page(m: &BTreeMap<u64, T>, q: &Query) -> Vec<u64> {
    let fold = |s: Option<&Vec<u8>>| s.map(|b| tags::name_key(b));
    let (exact, prefix, contains) = (
        fold(q.name.as_ref()),
        fold(q.search.as_ref()).filter(|k| !k.is_empty()),
        fold(q.contains.as_ref()).filter(|k| !k.is_empty()),
    );
    let mut ids: Vec<u64> = m
        .iter()
        .filter(|(_, t)| {
            let k = tags::name_key(t.name.as_bytes());
            (!q.folders || t.folder != b"NONE")
                && (!q.used || !t.carriers.is_empty())
                && q.folder_type.as_ref().is_none_or(|f| *f == t.folder)
                && exact.as_ref().is_none_or(|e| *e == k)
                && prefix.as_ref().is_none_or(|p| k.starts_with(p))
                && contains
                    .as_ref()
                    .is_none_or(|c| k.windows(c.len()).any(|w| w == c.as_slice()))
        })
        .map(|(id, _)| *id)
        .collect();
    ids.sort_by(|a, b| {
        let (x, y) = (&m[a], &m[b]);
        let (kx, ky) = (
            tags::name_key(x.name.as_bytes()),
            tags::name_key(y.name.as_bytes()),
        );
        let o = match q.sort {
            ALPHA => kx.cmp(&ky),
            ENTRIES => y.carriers.len().cmp(&x.carriers.len()).then(kx.cmp(&ky)),
            _ => match (x.order, y.order) {
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => kx.cmp(&ky),
                (o1, o2) => ord_cmp(o1, o2),
            },
        };
        o.then(a.cmp(b))
    });
    ids
}

fn read_all(s: &Store, q: &Query) -> Vec<u64> {
    let mut out = Vec::new();
    let mut q = q.clone();
    for _ in 0..1000 {
        let p = s.tag_page(&q).unwrap();
        out.extend(p.ids);
        match p.cursor {
            Some(c) => q.after = Some(c),
            None => return out,
        }
    }
    panic!("a tag walk never ended");
}

fn wait_folds(s: &Store) {
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
            "a fold never finished"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

fn check(s: &Store, m: &BTreeMap<u64, T>) {
    for sort in [ALPHA, ENTRIES, MANUAL] {
        for (folders, used) in [(false, false), (true, false), (false, true), (true, true)] {
            for names in 0..5 {
                for folder_type in [None, Some(b"OPEN".to_vec())] {
                    let mut q = Query {
                        sort,
                        folders: folders || folder_type.is_some(),
                        used,
                        folder_type,
                        limit: 3,
                        cap: tags::WORK_CAP,
                        ..Query::default()
                    };
                    match names {
                        1 => q.search = Some(b"A".to_vec()),
                        2 => q.name = Some("ALPHA".into()),
                        3 => q.contains = Some(b"E".to_vec()),
                        4 => q.search = Some("a\u{301}".into()),
                        _ => {}
                    }
                    let want = model_page(m, &q);
                    assert_eq!(read_all(s, &q), want, "{q:?}");
                    // The same read through ids, from a cursor in the middle.
                    let all: Vec<u64> = m.keys().copied().collect();
                    let iq = Query {
                        ids: Some(all.clone()),
                        limit: 2,
                        ..q.clone()
                    };
                    assert_eq!(read_all(s, &iq), want, "ids {q:?}");
                }
            }
        }
        // A cap of 1 examines one tag per page, and the walk still ends with every match.
        let q = Query {
            sort,
            search: Some(b"b".to_vec()),
            limit: 50,
            cap: 1,
            ..Query::default()
        };
        assert_eq!(read_all(s, &q), model_page(m, &q));
    }
    let ids: Vec<u64> = m.keys().copied().collect();
    let counts = s.tag_counts(&ids).unwrap();
    for (i, id) in ids.iter().enumerate() {
        assert_eq!(counts[i], (m[id].carriers.len() as i64, false));
    }
    let unused: Vec<u64> = m
        .iter()
        .filter(|(_, t)| t.carriers.is_empty())
        .map(|(id, _)| *id)
        .collect();
    let (n, page) = s.tag_unused(1000).unwrap();
    assert_eq!(n, unused.len() as u64);
    let mut page = page;
    page.sort_unstable();
    assert_eq!(page, unused);
    for name in NAMES {
        let want = m
            .iter()
            .filter(|(_, t)| tags::name_key(t.name.as_bytes()) == tags::name_key(name.as_bytes()))
            .map(|(id, _)| *id)
            .min();
        assert_eq!(
            s.tag_by_names(&[name.as_bytes().to_vec()]).unwrap(),
            vec![want]
        );
    }
    let max = m
        .values()
        .filter_map(|t| t.order)
        .fold(None, |a: Option<f64>, v| Some(a.map_or(v, |a| a.max(v))));
    assert_eq!(s.tag_max_order().unwrap(), max);
}

#[test]
fn tag_pages_counts_and_lookups_follow_every_change() {
    let dir = temp_dir("model");
    let mut s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut m: BTreeMap<u64, T> = BTreeMap::new();
    let mut gone: BTreeMap<u64, Option<u64>> = BTreeMap::new();
    let entities: Vec<u64> = (1..=30).collect();
    let mut carriers: BTreeMap<u64, BTreeSet<u64>> = BTreeMap::new();
    let mut retagged = BTreeSet::new();
    let mut r = Vec::new();
    for &e in &entities {
        r.push(set(e, NAME, "c"));
        r.push(create(e, CHARACTER, &format!("c{e}.png")));
    }
    s.commit_wait(r).unwrap();
    let mut next = 100u64;
    for step in 0..400 {
        let live: Vec<u64> = m.keys().copied().collect();
        let pick = |rng: &mut Rng| live[rng.below(live.len() as u64) as usize];
        match if live.len() < 4 { 0 } else { rng.below(10) } {
            0 | 1 => {
                let t = next;
                next += 1;
                let name = NAMES[rng.below(NAMES.len() as u64) as usize];
                let folder = FOLDERS[rng.below(FOLDERS.len() as u64) as usize];
                let o = ORDERS[rng.below(ORDERS.len() as u64) as usize];
                let mut r = vec![set(t, NAME, name)];
                if let Some(f) = folder {
                    r.push(set(t, FOLDER_TYPE, f));
                }
                if o.is_some() {
                    r.push(order(t, o));
                }
                r.push(json(t, FieldRef::Key(b"tag:color".to_vec()), "\"#fff\""));
                r.push(create(t, TAG, &format!("t{t}")));
                s.commit_wait(r).unwrap();
                m.insert(
                    t,
                    T {
                        name: name.into(),
                        folder: folder.unwrap_or("NONE").as_bytes().to_vec(),
                        order: o,
                        carriers: BTreeSet::new(),
                    },
                );
            }
            2 => {
                let t = pick(&mut rng);
                let name = NAMES[rng.below(NAMES.len() as u64) as usize];
                s.commit_wait(vec![set(t, NAME, name)]).unwrap();
                m.get_mut(&t).unwrap().name = name.into();
            }
            3 => {
                let t = pick(&mut rng);
                match rng.below(3) {
                    0 => {
                        s.commit_wait(vec![unset(t, FOLDER_TYPE)]).unwrap();
                        m.get_mut(&t).unwrap().folder = b"NONE".to_vec();
                    }
                    1 => {
                        s.commit_wait(vec![json(t, FieldRef::Code(FOLDER_TYPE), "7")])
                            .unwrap();
                        m.get_mut(&t).unwrap().folder = b"7".to_vec();
                    }
                    _ => {
                        let f = FOLDERS[1 + rng.below(3) as usize].unwrap();
                        s.commit_wait(vec![set(t, FOLDER_TYPE, f)]).unwrap();
                        m.get_mut(&t).unwrap().folder = f.as_bytes().to_vec();
                    }
                }
            }
            4 => {
                let t = pick(&mut rng);
                let o = ORDERS[rng.below(ORDERS.len() as u64) as usize];
                s.commit_wait(vec![order(t, o)]).unwrap();
                m.get_mut(&t).unwrap().order = o;
            }
            5..=7 => {
                let t = pick(&mut rng);
                let e = entities[rng.below(entities.len() as u64) as usize];
                let on = rng.below(3) > 0;
                s.commit_wait(vec![assign(e, t, on)]).unwrap();
                let c = &mut m.get_mut(&t).unwrap().carriers;
                let changed = if on { c.insert(e) } else { c.remove(&e) };
                if changed {
                    retagged.insert(e);
                }
                if on {
                    carriers.entry(e).or_default().insert(t);
                } else {
                    carriers.entry(e).or_default().remove(&t);
                }
            }
            8 => {
                let t = pick(&mut rng);
                let into = if rng.below(3) == 0 {
                    None
                } else {
                    Some(pick(&mut rng)).filter(|i| *i != t)
                };
                s.commit_wait(vec![
                    rec(
                        "tagMerge",
                        vec![Value::Id(t), into.map_or(Value::Absent, Value::Id)],
                    ),
                    rec("entityDelete", vec![Value::Id(t)]),
                ])
                .unwrap();
                let old = m.remove(&t).unwrap();
                for e in &old.carriers {
                    carriers.get_mut(e).unwrap().remove(&t);
                    if let Some(i) = into {
                        m.get_mut(&i).unwrap().carriers.insert(*e);
                        carriers.get_mut(e).unwrap().insert(i);
                    }
                }
                gone.insert(t, into);
                // Readers of the target see the merged carriers before the fold; counts mark them.
                if let Some(i) = into
                    && !old.carriers.is_empty()
                {
                    let (n, _) = s.tag_counts(&[i]).unwrap()[0];
                    assert!(n >= m[&i].carriers.len() as i64);
                }
                wait_folds(&s);
            }
            _ => {
                let t = pick(&mut rng);
                s.commit_wait(vec![rec("tagPrune", vec![Value::Id(t)])])
                    .unwrap();
                if m[&t].carriers.is_empty() {
                    m.remove(&t);
                    gone.insert(t, None);
                }
            }
        }
        if step % 50 == 49 {
            check(&s, &m);
            let keys: Vec<Vec<u8>> = gone.keys().map(|t| format!("t{t}").into_bytes()).collect();
            for (st, (t, _)) in s.tag_status(&keys).unwrap().iter().zip(&gone) {
                let st = st.as_ref().unwrap();
                assert_eq!((st.id, st.live), (*t, false));
            }
            if step % 100 == 99 {
                s.close();
                drop(s);
                s = Store::open_in(&dir, SMALL, pool()).unwrap();
            }
        }
    }
    check(&s, &m);
    // The feed lists every tag once, at its last change, live and deleted alike.
    let (entries, more, end) = s.tag_feed(key::TAG_CHANGE, 0, 10_000).unwrap();
    assert!(!more);
    let listed: BTreeSet<u64> = entries.iter().map(|(_, t)| *t).collect();
    let all: BTreeSet<u64> = m.keys().chain(gone.keys()).copied().collect();
    assert_eq!(listed, all);
    assert_eq!(entries.last().map(|(p, _)| *p), Some(end));
    assert!(entries.windows(2).all(|w| w[0].0 < w[1].0));
    let (half, _, _) = s
        .tag_feed(key::TAG_CHANGE, entries[entries.len() / 2].0, 10_000)
        .unwrap();
    assert_eq!(half, entries[entries.len() / 2 + 1..]);
    // The assignment feed lists the entities whose tags changed.
    let (ents, _, _) = s.tag_feed(key::ENTITY_TAG_CHANGE, 0, 10_000).unwrap();
    let changed: BTreeSet<u64> = ents.iter().map(|(_, e)| *e).collect();
    assert_eq!(changed, retagged);
    s.close();
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_cursor_for_another_sort_is_refused() {
    let dir = temp_dir("cursor");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    s.commit_wait(vec![
        set(1, NAME, "a"),
        create(1, TAG, "a"),
        set(2, NAME, "b"),
        create(2, TAG, "b"),
    ])
    .unwrap();
    let q = Query {
        sort: ALPHA,
        limit: 1,
        cap: tags::WORK_CAP,
        ..Query::default()
    };
    let c = s.tag_page(&q).unwrap().cursor.unwrap();
    let bad = Query {
        sort: MANUAL,
        after: Some(c),
        ..q
    };
    assert!(matches!(s.tag_page(&bad), Err(StoreError::Refused(_))));
    s.close();
    let _ = fs::remove_dir_all(&dir);
}

/// The same tags, carriers and orders, through a bulk load and through commits.
fn tag_library() -> Vec<Vec<Record>> {
    let mut rng = Rng(7);
    let mut out = Vec::new();
    for t in 1..=40u64 {
        let mut r = vec![set(t, NAME, NAMES[rng.below(NAMES.len() as u64) as usize])];
        if let Some(f) = FOLDERS[rng.below(FOLDERS.len() as u64) as usize] {
            r.push(set(t, FOLDER_TYPE, f));
        }
        r.push(order(t, ORDERS[rng.below(ORDERS.len() as u64) as usize]));
        r.push(create(t, TAG, &format!("t{t}")));
        out.push(r);
    }
    for e in 100..400u64 {
        let mut r = vec![
            set(e, NAME, "c"),
            create(e, CHARACTER, &format!("c{e}.png")),
        ];
        for _ in 0..rng.below(4) {
            r.push(assign(e, 1 + rng.below(40), true));
        }
        out.push(r);
    }
    out
}

#[test]
fn a_bulk_load_places_every_tag_as_commits_do() {
    for failpoint in [0u8, 3] {
        let committed = temp_dir("bulk-commits");
        let c = Store::open_in(&committed, SMALL, pool()).unwrap();
        for r in tag_library() {
            c.commit_wait(r).unwrap();
        }
        let dir = temp_dir("bulk");
        let s = Store::open_in(&dir, SMALL, pool()).unwrap();
        let mut l = s.loader().unwrap();
        for r in tag_library() {
            l.add(r).unwrap();
        }
        l.fail_at(failpoint);
        let done = l.finish();
        let s = if failpoint == 0 {
            done.unwrap();
            s
        } else {
            assert!(done.is_err());
            drop(s);
            Store::open_in(&dir, SMALL, pool()).unwrap()
        };
        for sort in [ALPHA, ENTRIES, MANUAL] {
            for (folders, used) in [(false, false), (true, false), (false, true), (true, true)] {
                let q = Query {
                    sort,
                    folders,
                    used,
                    limit: 7,
                    cap: tags::WORK_CAP,
                    ..Query::default()
                };
                assert_eq!(read_all(&s, &q), read_all(&c, &q), "{q:?}");
            }
        }
        let ids: Vec<u64> = (1..=40).collect();
        assert_eq!(s.tag_counts(&ids).unwrap(), c.tag_counts(&ids).unwrap());
        assert_eq!(s.tag_unused(100).unwrap(), c.tag_unused(100).unwrap());
        // The commit path goes on from the load's places.
        for st in [&s, &c] {
            st.commit_wait(vec![
                assign(100, 2, false),
                assign(101, 3, true),
                set(4, NAME, "renamed"),
            ])
            .unwrap();
        }
        let q = Query {
            sort: ENTRIES,
            limit: 100,
            cap: tags::WORK_CAP,
            ..Query::default()
        };
        assert_eq!(read_all(&s, &q), read_all(&c, &q));
        for st in [s, c] {
            st.close();
        }
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&committed);
    }
}
