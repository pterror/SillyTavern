use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use super::book_stats::{self, book_stat, entry_stat};
use super::books::{self, BOOK, ENTRY, EntryKey, OWNED};
use super::chat_read::Js;
use super::library::{self, CHARACTER};
use super::references::{self, CONTENT_FIELD, KEY_FIELD};
use super::*;
use crate::log::format::{FieldRef, Record, Value, kind_by_name};

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-refs-{}-{name}-{}",
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
        vec![Value::Id(e), Value::UInt(kind), text(key), Value::F64(0.0)],
    )
}

fn delete(e: u64) -> Record {
    rec("entityDelete", vec![Value::Id(e)])
}

fn set_text(e: u64, f: u64, t: &str) -> Record {
    rec(
        "textValue",
        vec![
            Value::Sel(0, e),
            Value::Field(FieldRef::Code(f)),
            text(t),
            Value::Absent,
            Value::Absent,
        ],
    )
}

fn set_json(e: u64, f: u64, j: &str) -> Record {
    rec(
        "jsonValue",
        vec![
            Value::Sel(0, e),
            Value::Field(FieldRef::Code(f)),
            text(j),
            Value::Absent,
            Value::Absent,
        ],
    )
}

fn drop_value(e: u64, f: u64) -> Record {
    rec(
        "valueDelete",
        vec![
            Value::Sel(0, e),
            Value::Field(FieldRef::Code(f)),
            Value::Absent,
            Value::Absent,
        ],
    )
}

fn append(e: u64, f: u64, at: usize, t: &str) -> Record {
    rec(
        "textEdit",
        vec![
            Value::Sel(0, e),
            Value::Field(FieldRef::Code(f)),
            Value::UInt(at as u64),
            Value::UInt(0),
            text(t),
            Value::Absent,
            Value::Absent,
        ],
    )
}

fn read<T>(s: &Store, f: impl FnOnce(&derive::View) -> StoreResult<T>) -> T {
    s.chat_read(f).unwrap()
}

fn field<'a>(o: &'a Js, name: &str) -> &'a Js {
    let Js::Obj(fields) = o else {
        panic!("not an object: {o:?}")
    };
    &fields.iter().find(|(k, _)| *k == name).unwrap().1
}

fn bigs(o: &Js, name: &str) -> Vec<u64> {
    let Js::Arr(list) = field(o, name) else {
        panic!("not a list")
    };
    list.iter()
        .map(|x| match x {
            Js::Big(n) => *n,
            other => panic!("not a big: {other:?}"),
        })
        .collect()
}

const CONTENT: u64 = 104;
const CONSTANT: u64 = 105;
const COMMENT: u64 = 103;

fn key_field(list: u64, item: u64) -> u64 {
    library::ITEM_BASE + item * library::LISTS + list
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn pick<T: Copy>(&mut self, v: &[T]) -> T {
        v[(self.next() % v.len() as u64) as usize]
    }
}

#[derive(Default, Clone)]
struct Ent {
    values: BTreeMap<(u64, bool), String>,
}

#[derive(Default)]
struct Model {
    books: BTreeMap<u64, (u64, BTreeMap<u64, Ent>, BTreeMap<(u64, bool), String>)>,
}

const WORDS: &[&str] = &[
    "the", "tavern", "Elara", "elara's", "concatenate", "cat", "bobcat", "/dr(a|e)gon/i", "dragon",
    "drEgon", "{{char}}", "!!!", "Sir Rowan of Vale", "rowan", "Vale", "ΟΔΟΣ", "οδος", "İstanbul",
    "東京に行く", "東京", "x", "_cat_",
];

fn hash_of(values: &BTreeMap<(u64, bool), String>) -> (i64, i64) {
    let mut bytes = 0i64;
    let mut hash = 0i64;
    for ((f, json), v) in values {
        bytes += v.len() as i64;
        hash = hash.wrapping_add(book_stats::field_hash(&FieldRef::Code(*f), *json, v.as_bytes()));
    }
    (bytes, hash)
}

impl Model {
    fn check(&self, s: &Store) {
        for (book, (list, entries, own)) in &self.books {
            let (mut bytes, mut hash) = hash_of(own);
            let mut unindexed = BTreeSet::new();
            for (e, ent) in entries {
                let (b, h) = hash_of(&ent.values);
                let got = read(s, |v| entry_stat(v, *e));
                assert_eq!((got.bytes, got.hash), (b, h), "entry {e}");
                bytes += b;
                hash = hash.wrapping_add(h);
                for ((f, json), v) in &ent.values {
                    if !json
                        && *f >= library::ITEM_BASE
                        && (f - library::ITEM_BASE) % library::LISTS == *list
                        && references::unindexable(v.as_bytes())
                    {
                        unindexed.insert((*e, v.clone()));
                    }
                }
            }
            let got = read(s, |v| book_stat(v, *book));
            assert_eq!(
                (got.bytes, got.hash, got.entries),
                (bytes, hash, entries.len() as i64),
                "book {book}"
            );
            let mut seen = BTreeSet::new();
            let mut after = None;
            loop {
                let page = read(s, |v| references::unindexed_page(v, *book, after, 3));
                let Js::Arr(names) = field(&page, "names") else {
                    panic!()
                };
                for n in names {
                    let Js::Big(e) = field(n, "entry") else { panic!() };
                    let Js::Text(t) = field(n, "name") else { panic!() };
                    seen.insert((*e, String::from_utf8(t.clone()).unwrap()));
                    after = Some(*e);
                }
                if field(&page, "more") != &Js::Bool(true) {
                    break;
                }
            }
            assert_eq!(seen, unindexed, "book {book} unindexed names");
        }
    }
}

fn step(s: &Store, m: &mut Model, rng: &mut Rng, next: &mut u64) {
    let book = if rng.next().is_multiple_of(2) { 1 } else { 2 };
    let (list, entries, _) = m.books.get_mut(&book).unwrap();
    let list = *list;
    let ids: Vec<u64> = entries.keys().copied().collect();
    let words = |rng: &mut Rng| {
        (0..1 + rng.next() % 4)
            .map(|_| rng.pick(WORDS))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let (records, apply): (Vec<Record>, Box<dyn FnOnce(&mut BTreeMap<u64, Ent>)>) =
        match rng.next() % 9 {
            0 | 1 => {
                let id = *next;
                *next += 1;
                let ek = books::entry_key(book, &EntryKey::parse(id.to_string().as_bytes()));
                let c = words(rng);
                (
                    vec![
                        create(id, ENTRY, std::str::from_utf8(&ek).unwrap()),
                        set_text(id, CONTENT, &c),
                    ],
                    Box::new(move |es| {
                        let mut ent = Ent::default();
                        ent.values.insert((CONTENT, false), c);
                        es.insert(id, ent);
                    }),
                )
            }
            2 if !ids.is_empty() => {
                let e = rng.pick(&ids);
                let k = rng.pick(WORDS).to_string();
                let f = key_field(list, rng.next() % 3);
                (
                    vec![set_text(e, f, &k)],
                    Box::new(move |es| {
                        let ent = es.get_mut(&e).unwrap();
                        ent.values.remove(&(f, true));
                        ent.values.insert((f, false), k);
                    }),
                )
            }
            3 if !ids.is_empty() => {
                let e = rng.pick(&ids);
                let kf = key_field(list, rng.next() % 3);
                let f = rng.pick(&[CONTENT, COMMENT, kf]);
                (
                    vec![drop_value(e, f)],
                    Box::new(move |es| {
                        let ent = es.get_mut(&e).unwrap();
                        ent.values.remove(&(f, false));
                        ent.values.remove(&(f, true));
                    }),
                )
            }
            4 if !ids.is_empty() => {
                let e = rng.pick(&ids);
                let j = if rng.next().is_multiple_of(2) { "true" } else { "false" };
                let f = rng.pick(&[CONSTANT, COMMENT]);
                (
                    vec![set_json(e, f, j)],
                    Box::new(move |es| {
                        let ent = es.get_mut(&e).unwrap();
                        ent.values.remove(&(f, false));
                        ent.values.insert((f, true), j.to_string());
                    }),
                )
            }
            5 if !ids.is_empty() => {
                let e = rng.pick(&ids);
                let old = entries[&e].values.get(&(CONTENT, false)).cloned();
                let Some(old) = old else {
                    return;
                };
                let w = format!(" {}", rng.pick(WORDS));
                (
                    vec![append(e, CONTENT, old.len(), &w)],
                    Box::new(move |es| {
                        es.get_mut(&e)
                            .unwrap()
                            .values
                            .insert((CONTENT, false), format!("{old}{w}"));
                    }),
                )
            }
            6 if !ids.is_empty() => {
                let e = rng.pick(&ids);
                (
                    vec![delete(e)],
                    Box::new(move |es| {
                        es.remove(&e);
                    }),
                )
            }
            7 if !ids.is_empty() => {
                let e = rng.pick(&ids);
                let t = words(rng);
                (
                    vec![set_text(e, COMMENT, &t), set_text(e, CONTENT, &t)],
                    Box::new(move |es| {
                        let ent = es.get_mut(&e).unwrap();
                        ent.values.remove(&(COMMENT, true));
                        ent.values.insert((COMMENT, false), t.clone());
                        ent.values.insert((CONTENT, false), t);
                    }),
                )
            }
            _ => return,
        };
    s.commit_wait(records).unwrap();
    apply(entries);
}

fn setup(s: &Store, m: &mut Model) {
    s.commit_wait(vec![
        create(1, BOOK, "one"),
        set_json(1, books::DEFINED, ""),
        create(3, CHARACTER, "c.png"),
        create(2, OWNED, "3:c"),
    ])
    .unwrap();
    let mut own = BTreeMap::new();
    own.insert((books::DEFINED, true), String::new());
    m.books.insert(1, (0, BTreeMap::new(), own));
    m.books.insert(2, (3, BTreeMap::new(), BTreeMap::new()));
}

#[test]
fn sizes_hashes_and_unindexed_names_follow_every_write_reopens_and_cleaning() {
    let dir = temp_dir("model");
    let mut m = Model::default();
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut next = 100;
    {
        let s = Store::open_in(&dir, SMALL, pool()).unwrap();
        setup(&s, &mut m);
        for i in 0..600 {
            step(&s, &mut m, &mut rng, &mut next);
            if i % 25 == 0 {
                m.check(&s);
            }
        }
        m.check(&s);
        s.close();
    }
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    m.check(&s);
    for _ in 0..200 {
        step(&s, &mut m, &mut rng, &mut next);
    }
    m.check(&s);
}

#[test]
fn a_deleted_book_takes_its_totals_and_its_entries_leave_nothing() {
    let dir = temp_dir("gone");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let mut m = Model::default();
    setup(&s, &mut m);
    s.commit_wait(vec![
        create(10, ENTRY, "1:10"),
        set_text(10, CONTENT, "the tavern"),
        set_text(10, key_field(0, 0), "/tav/i"),
    ])
    .unwrap();
    assert_eq!(read(&s, |v| book_stat(v, 1)).entries, 1);
    s.commit_wait(vec![delete(10)]).unwrap();
    let left = read(&s, |v| book_stat(v, 1));
    assert_eq!((left.entries, left.bytes), (0, 0));
    assert_eq!(read(&s, |v| entry_stat(v, 10)), Default::default());
    s.commit_wait(vec![
        create(4, BOOK, "four"),
        drop_value(1, books::DEFINED),
        rec("bookForward", vec![Value::Id(1), Value::Id(4)]),
        delete(1),
    ])
    .unwrap();
    assert_eq!(read(&s, |v| book_stat(v, 1)), Default::default());
    let page = read(&s, |v| references::unindexed_page(v, 1, None, 10));
    assert_eq!(field(&page, "names"), &Js::Arr(Vec::new()));
}

fn candidates(s: &Store, book: u64, t: &str, names: bool) -> Option<Vec<u64>> {
    let mut out = Vec::new();
    let mut after = None;
    loop {
        let page = read(s, |v| {
            if names {
                references::name_candidates(v, book, t.as_bytes(), after, 2)
            } else {
                references::mention_candidates(v, book, t.as_bytes(), after, 2)
            }
        });
        if page == Js::Null {
            return None;
        }
        let docs = bigs(&page, "entries");
        after = docs.last().copied().or(after);
        out.extend(docs);
        if field(&page, "more") != &Js::Bool(true) {
            return Some(out);
        }
    }
}

#[test]
fn a_text_finds_every_entry_whose_name_it_contains_and_a_long_name_every_text_containing_it() {
    let dir = temp_dir("candidates");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let mut m = Model::default();
    setup(&s, &mut m);
    let names: &[(u64, &str)] = &[
        (10, "cat"),
        (11, "Elara"),
        (12, "Sir Rowan of Vale"),
        (13, "οδος"),
        (14, "i̇stanbul"),
        (15, "東京"),
        (16, "x"),
        (17, "averyveryverylongsinglewordname"),
        (18, "dragon"),
    ];
    let mut r = Vec::new();
    for (e, n) in names {
        r.push(create(*e, ENTRY, &format!("1:{e}")));
        r.push(set_text(*e, key_field(0, 0), n));
        r.push(set_text(*e, CONTENT, &format!("about {n}, and more about the Vale")));
    }
    s.commit_wait(r).unwrap();
    let found = |t: &str| candidates(&s, 1, t, true).unwrap();
    let has = |t: &str, e: u64| found(t).contains(&e);
    assert!(has("a CONCATENATED string", 10));
    assert!(has("bobcat", 10));
    assert!(has("ELARA's sword", 11));
    assert!(has("sir rowan of vale.", 12));
    assert!(has("ΟΔΟΣ", 13));
    assert!(has("İstanbul", 14));
    assert!(has("東京に行く", 15));
    assert!(has("max", 16));
    assert!(has("xaveryveryverylongsinglewordnamesss", 17));
    assert!(!has("a dog", 11));
    assert!(!has("averyveryvery", 17));

    assert_eq!(candidates(&s, 1, "cat", false), None);
    assert_eq!(candidates(&s, 1, "Rowan Vale", false), None);
    let long = candidates(&s, 1, "Sir Rowan of Vale", false).unwrap();
    assert!(long.contains(&12));
    assert!(!long.contains(&11));

    s.commit_wait(vec![
        create(20, ENTRY, "1:20"),
        set_text(20, CONTENT, "hailing from Rowan's lands"),
    ])
    .unwrap();
    assert!(candidates(&s, 1, "lord rowan's lands", false).unwrap().contains(&20));
    assert!(!candidates(&s, 1, "lord rowan's lands", false).unwrap().contains(&10));
}

#[test]
fn a_field_write_touches_only_its_own_entry_and_book_totals() {
    let dir = temp_dir("bounds");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let mut m = Model::default();
    setup(&s, &mut m);
    let mut r = Vec::new();
    for e in 10..60 {
        r.push(create(e, ENTRY, &format!("1:{e}")));
        r.push(set_text(e, key_field(0, 0), &format!("name{e}")));
        r.push(set_text(e, CONTENT, "mentions name11 and name12"));
    }
    s.commit_wait(r).unwrap();
    let before = read(&s, |v| book_stat(v, 1));
    let rename = set_text(11, key_field(0, 0), "renamed");
    let produced = read(&s, |v| {
        let mut out = derive::Out::default();
        let at = derive::Loc { pos: 1 << 40, len: 1 };
        kinds::deriver("textValue")
            .unwrap()
            .derive(&rename, at, v, &mut out)?;
        Ok(out.entries.into_iter().map(|(k, _)| k).collect::<Vec<_>>())
    });
    let stat_keys: Vec<&Vec<u8>> = produced
        .iter()
        .filter(|k| {
            let s = crate::keyspace::val::get_u64(k, &mut 0).unwrap();
            [book_stats::STAT_FIELD, book_stats::STAT_ENTRY, book_stats::STAT_BOOK, references::UNINDEXED]
                .contains(&s)
        })
        .collect();
    assert!(stat_keys.len() <= 6, "{} stat keys for one field write", stat_keys.len());
    s.commit_wait(vec![rename]).unwrap();
    let after = read(&s, |v| book_stat(v, 1));
    assert_eq!(after.entries, before.entries);
    assert_eq!(after.bytes - before.bytes, "renamed".len() as i64 - "name11".len() as i64);
    let _ = (KEY_FIELD, CONTENT_FIELD);
}
