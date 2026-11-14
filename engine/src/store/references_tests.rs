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

fn set_names(e: u64, names: &[&str]) -> Record {
    rec(
        "jsonValue",
        vec![
            Value::Sel(0, e),
            Value::Field(super::entry_label::names_field()),
            text(&names_json(names)),
            Value::Absent,
            Value::Absent,
        ],
    )
}

fn names_json(names: &[&str]) -> String {
    let quoted: Vec<String> = names
        .iter()
        .map(|n| format!("\"{}\"", n.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect();
    format!("[{}]", quoted.join(","))
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
    names: Option<Vec<String>>,
}

#[derive(Default)]
struct Model {
    books: BTreeMap<u64, (u64, BTreeMap<u64, Ent>, BTreeMap<(u64, bool), String>)>,
}

const WORDS: &[&str] = &[
    "the", "tavern", "Elara", "elara's", "concatenate", "cat", "bobcat", "/dr(a|e)gon/i", "dragon",
    "drEgon", "{{char}}", "!!!", "Sir Rowan of Vale", "rowan", "Vale", "ΟΔΟΣ", "οδος", "İstanbul",
    "東京に行く", "東京", "x", "_cat_", " Elara\u{feff}", "\u{85}cat", "  ", "/Vale/", "the Vale",
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

fn ent_hash(ent: &Ent) -> (i64, i64) {
    let (mut bytes, mut hash) = hash_of(&ent.values);
    if let Some(names) = &ent.names {
        let json = names_json(&names.iter().map(String::as_str).collect::<Vec<_>>());
        bytes += json.len() as i64;
        hash = hash.wrapping_add(book_stats::field_hash(&super::entry_label::names_field(), true, json.as_bytes()));
    }
    (bytes, hash)
}

fn keys_of_ent(ent: &Ent, list: u64) -> Vec<String> {
    ent.values
        .iter()
        .filter(|((f, json), _)| !json && *f >= library::ITEM_BASE && (f - library::ITEM_BASE) % library::LISTS == list)
        .map(|(_, v)| v.clone())
        .collect()
}

fn js_trimmed(name: &str) -> &str {
    name.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// Every name of another entry the text's fold holds, and every name with a pattern's shape or a macro.
fn names_in(text: &str, entry: u64, entries: &BTreeMap<u64, Ent>, list: u64) -> BTreeSet<(u64, String)> {
    let folded = references::names_fold(text);
    let mut found = BTreeSet::new();
    for (e, ent) in entries {
        if *e == entry {
            continue;
        }
        let keys = keys_of_ent(ent, list);
        for name in ent.names.iter().flatten().filter(|n| keys.contains(n)) {
            let trimmed = js_trimmed(name);
            let shaped = trimmed.len() > 2
                && trimmed.starts_with('/')
                && trimmed[1..].rfind('/').is_some_and(|i| i > 0 && trimmed[2 + i..].chars().all(|c| "gimsuy".contains(c)));
            if name.contains("{{") || shaped || (!trimmed.is_empty() && folded.contains(&references::names_fold(trimmed))) {
                found.insert((*e, name.clone()));
            }
        }
    }
    found
}

fn candidates_found(page: &Js) -> BTreeSet<(u64, String)> {
    let Js::Arr(list) = field(page, "candidates") else {
        panic!("no candidates")
    };
    let mut found = BTreeSet::new();
    for candidate in list {
        let Js::Big(e) = field(candidate, "entry") else { panic!() };
        let Js::Arr(names) = field(candidate, "names") else { panic!() };
        for name in names {
            let Js::Text(t) = name else { panic!() };
            found.insert((*e, String::from_utf8(t.clone()).unwrap()));
        }
    }
    found
}

impl Model {
    fn check(&self, s: &Store) {
        for (book, (list, entries, own)) in &self.books {
            let (mut bytes, mut hash) = hash_of(own);
            let mut key_entries: BTreeMap<(String, u64), i64> = BTreeMap::new();
            for (e, ent) in entries {
                let (b, h) = ent_hash(ent);
                let got = read(s, |v| entry_stat(v, *e));
                assert_eq!((got.bytes, got.hash), (b, h), "entry {e}");
                bytes += b;
                hash = hash.wrapping_add(h);
                for key_text in keys_of_ent(ent, *list) {
                    *key_entries.entry((key_text, *e)).or_insert(0) += 1;
                }
            }
            let got = read(s, |v| book_stat(v, *book));
            assert_eq!(
                (got.bytes, got.hash, got.entries),
                (bytes, hash, entries.len() as i64),
                "book {book}"
            );
            let prefix = super::kinds::key::id(references::KEY_ENTRIES_BY_TEXT, *book);
            let stored: BTreeMap<(String, u64), i64> = read(s, |v| {
                let mut stored = BTreeMap::new();
                for (k, _) in v.scan(&prefix, &super::kinds::key::prefix_end(&prefix), usize::MAX)? {
                    let mut at = prefix.len();
                    let text = crate::keyspace::val::get_bytes(&k, &mut at).unwrap();
                    let e = crate::keyspace::val::get_u64(&k, &mut at).unwrap();
                    stored.insert((String::from_utf8(text).unwrap(), e), library::counter(v, &k)?);
                }
                Ok(stored)
            });
            assert_eq!(stored, key_entries, "book {book} entries per key text");
            for (e, ent) in entries {
                let content = ent.values.get(&(CONTENT, false)).cloned().unwrap_or_default();
                let page = read(s, |v| references::link_candidates(v, *book, *e, &content, usize::MAX));
                assert_eq!(field(&page, "complete"), &Js::Bool(true));
                assert_eq!(candidates_found(&page), names_in(&content, *e, entries, *list), "book {book} entry {e}: {content}");
            }
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
        match rng.next() % 11 {
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
            8 | 9 if !ids.is_empty() => {
                let e = rng.pick(&ids);
                let mut names: Vec<String> = keys_of_ent(&entries[&e], list);
                names.push(rng.pick(WORDS).to_string());
                let names: Vec<String> = names.into_iter().filter(|_| !rng.next().is_multiple_of(3)).collect();
                let as_str: Vec<&str> = names.iter().map(String::as_str).collect();
                (
                    vec![set_names(e, &as_str)],
                    Box::new(move |es| {
                        es.get_mut(&e).unwrap().names = Some(names);
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
fn sizes_hashes_key_entries_and_names_in_texts_follow_every_write_reopens_and_cleaning() {
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
        set_text(10, key_field(0, 1), "Tavern"),
        set_names(10, &["/tav/i", "Tavern"]),
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
    for structure in [references::KEY_ENTRIES_BY_TEXT, references::NAMES_BY_FOLD, references::NAMES_CHECKED_ONE_BY_ONE] {
        let prefix = super::kinds::key::of(structure);
        let left = read(&s, |v| v.scan(&prefix, &super::kinds::key::prefix_end(&prefix), usize::MAX));
        assert!(left.is_empty(), "structure {structure} keeps {} keys", left.len());
    }
}

fn linked(s: &Store, book: u64, t: &str) -> Vec<u64> {
    let page = read(s, |v| references::link_candidates(v, book, 0, t, usize::MAX));
    candidates_found(&page).into_iter().map(|(e, _)| e).collect()
}

fn mentioning(s: &Store, book: u64, t: &str) -> Option<Vec<u64>> {
    let mut out = Vec::new();
    let mut after = None;
    loop {
        let page = read(s, |v| {
            let names = [references::MentionName {
                text: t.as_bytes().to_vec(),
                regex_flags: None,
            }];
            references::mention_candidates(v, book, &names, after, 2)
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
fn a_text_finds_every_entry_whose_name_it_holds_and_a_long_name_every_text_containing_it() {
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
        r.push(set_names(*e, &[n]));
        r.push(set_text(*e, CONTENT, &format!("about {n}, and more about the Vale")));
    }
    s.commit_wait(r).unwrap();
    let has = |t: &str, e: u64| linked(&s, 1, t).contains(&e);
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
    assert!(!has("Sir Rowan of", 12));

    assert_eq!(mentioning(&s, 1, "cat"), None);
    assert_eq!(mentioning(&s, 1, "Rowan Vale"), None);
    let long = mentioning(&s, 1, "Sir Rowan of Vale").unwrap();
    assert!(long.contains(&12));
    assert!(!long.contains(&11));

    s.commit_wait(vec![
        create(20, ENTRY, "1:20"),
        set_text(20, CONTENT, "hailing from Rowan's lands"),
    ])
    .unwrap();
    assert!(mentioning(&s, 1, "lord rowan's lands").unwrap().contains(&20));
    assert!(!mentioning(&s, 1, "lord rowan's lands").unwrap().contains(&10));
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
            [
                book_stats::STAT_FIELD,
                book_stats::STAT_ENTRY,
                book_stats::STAT_BOOK,
                references::KEY_ITEMS_BY_TEXT,
                references::KEY_ENTRIES_BY_TEXT,
            ]
            .contains(&s)
        })
        .collect();
    assert!(stat_keys.len() <= 10, "{} stat keys for one field write", stat_keys.len());
    s.commit_wait(vec![rename]).unwrap();
    let after = read(&s, |v| book_stat(v, 1));
    assert_eq!(after.entries, before.entries);
    assert_eq!(after.bytes - before.bytes, "renamed".len() as i64 - "name11".len() as i64);
    let _ = (KEY_FIELD, CONTENT_FIELD);
}

fn regex_term(source: &str, flags: &str) -> Option<Vec<String>> {
    references::regex_mention_terms(source.as_bytes(), flags)
        .map(|terms| terms.into_iter().map(|(term, _)| term).collect())
}

#[test]
fn a_regex_key_is_looked_up_by_a_word_every_match_holds_whole_and_only_then() {
    let some = |words: &[&str]| Some(words.iter().map(|w| w.to_string()).collect::<Vec<_>>());
    assert_eq!(regex_term("the old (king|queen)", ""), some(&["old"]));
    assert_eq!(regex_term("lord of the north", ""), some(&["the"]));
    assert_eq!(regex_term(r"x\.miller\.y", ""), some(&["miller"]));
    assert_eq!(regex_term("x mill (?:a|b) the end", ""), some(&["mill"]));
    assert_eq!(regex_term("x? the old  y", ""), some(&["old"]));
    assert_eq!(regex_term(r"\p{L}x mill y", ""), some(&["mill"]));
    assert_eq!(regex_term(r"\k<n>x mill y", ""), some(&["mill"]));
    assert_eq!(regex_term("a mill road", "i"), some(&["mill"]));
    assert_eq!(regex_term("a mill road", "iu"), some(&["mill"]));
    assert_eq!(regex_term("a sir road", "i"), some(&["sir"]));
    assert_eq!(regex_term("a sir road", "iu"), None);
    assert_eq!(regex_term("a Μῆνιν b", ""), some(&["μηνιν"]));
    assert_eq!(regex_term("a Μῆνιν b", "i"), None);
    assert_eq!(regex_term("a ΟΔΟΣ b", ""), some(&["οδος", "οδοσ"]));
    for unknown in [
        "dragon",
        "dr(a|e)gon",
        "^Vale",
        "cat|dog",
        "a (b) c",
        "a [bc] d",
        "x mills? y",
        "x mill+ y",
        "x mill* y",
        "x mil{2} y",
        "x mill{0,2} y",
        "x m.ll y",
        r"\bmill\b",
        r"a\smill\sb",
        r"\p{L} mill",
        r"\k<n> mill",
        "(a",
    ] {
        assert_eq!(regex_term(unknown, ""), None, "{unknown}");
    }
}

#[test]
fn a_text_finds_names_by_their_fold_and_stops_at_its_bound_saying_so() {
    let dir = temp_dir("links");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let mut m = Model::default();
    setup(&s, &mut m);
    let names: &[(u64, &str)] = &[
        (10, "ΟΔΟΣ"),
        (11, "İstanbul"),
        (12, "Ilse"),
        (13, "Ilse Varro"),
        (14, "/Vale/i"),
        (15, "{{char}}"),
        (16, "  "),
    ];
    let mut r = Vec::new();
    for (e, n) in names {
        r.push(create(*e, ENTRY, &format!("1:{e}")));
        r.push(set_text(*e, key_field(0, 0), n));
        r.push(set_text(*e, key_field(0, 1), "a trigger"));
        r.push(set_names(*e, &[n]));
    }
    r.push(set_json(12, 131, "true"));
    r.push(set_json(12, 132, "false"));
    s.commit_wait(r).unwrap();
    let entries = |t: &str| linked(&s, 1, t);
    assert_eq!(entries("the οδοσa road"), vec![10, 14, 15], "a sigma in a word is the name's final sigma");
    assert_eq!(entries("to i̇stanbul"), vec![11, 14, 15]);
    assert_eq!(entries("ILSE VARRO"), vec![12, 13, 14, 15], "case is the matcher's to check");
    assert_eq!(entries("a trigger"), vec![14, 15], "a key that is no name links nothing");

    let page = read(&s, |v| references::link_candidates(v, 1, 0, "Ilse Varro", usize::MAX));
    let Js::Arr(list) = field(&page, "candidates") else { panic!() };
    let ilse = list.iter().find(|c| field(c, "entry") == &Js::Big(12)).unwrap();
    assert_eq!((field(ilse, "caseSensitive"), field(ilse, "matchWholeWords")), (&Js::Bool(true), &Js::Bool(false)));
    let Js::Num(all) = field(&page, "reads") else { panic!() };
    let bounded = read(&s, |v| references::link_candidates(v, 1, 0, "Ilse Varro", *all as usize - 1));
    assert_eq!(field(&bounded, "complete"), &Js::Bool(false));
    assert!(candidates_found(&bounded).is_subset(&candidates_found(&page)));
    let Js::Num(spent) = field(&bounded, "reads") else { panic!() };
    assert!(*spent < *all);
    assert_eq!(field(&read(&s, |v| references::link_candidates(v, 1, 12, "Ilse", usize::MAX)), "complete"), &Js::Bool(true));
    assert!(!linked(&s, 1, "Ilse").is_empty());
    let own = read(&s, |v| references::link_candidates(v, 1, 12, "Ilse", usize::MAX));
    assert!(!candidates_found(&own).iter().any(|(e, _)| *e == 12), "an entry's own names are left out");

    s.commit_wait(vec![set_names(13, &[])]).unwrap();
    assert_eq!(entries("ILSE VARRO"), vec![12, 14, 15]);
    s.commit_wait(vec![delete(12)]).unwrap();
    assert_eq!(entries("ILSE VARRO"), vec![14, 15]);
}

#[test]
fn a_world_with_no_names_costs_a_text_one_read_not_one_per_character() {
    let dir = temp_dir("no-names");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let mut m = Model::default();
    setup(&s, &mut m);
    s.commit_wait(vec![create(10, ENTRY, "1:10"), set_text(10, key_field(0, 0), "Ilse")]).unwrap();
    let text = "Ilse walks to the harbour and back again. ".repeat(20);
    let page = read(&s, |v| references::link_candidates(v, 1, 0, &text, usize::MAX));
    assert_eq!(field(&page, "complete"), &Js::Bool(true));
    assert_eq!(field(&page, "reads"), &Js::Num(1.0), "a trigger is no name, so nothing is in the index");
    assert!(candidates_found(&page).is_empty());
    assert_eq!(field(&read(&s, |v| references::link_candidates(v, 1, 0, &text, 0)), "complete"), &Js::Bool(false));

    s.commit_wait(vec![set_names(10, &["Ilse"])]).unwrap();
    let named = read(&s, |v| references::link_candidates(v, 1, 0, &text, usize::MAX));
    let Js::Num(reads) = field(&named, "reads") else { panic!() };
    assert!(*reads > 20.0, "with a name, every start of the text is looked up");
    assert_eq!(linked(&s, 1, &text), vec![10]);
}

#[test]
fn the_entries_with_a_key_are_listed_by_id_without_the_entry_asking() {
    let dir = temp_dir("sharers");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let mut m = Model::default();
    setup(&s, &mut m);
    let mut r = Vec::new();
    for e in 10..16 {
        r.push(create(e, ENTRY, &format!("1:{e}")));
        r.push(set_text(e, key_field(0, 0), if e == 15 { "Ledger" } else { "ledger" }));
        r.push(set_text(e, COMMENT, &format!("entry {e}")));
    }
    r.push(set_text(11, key_field(0, 1), "ledger"));
    s.commit_wait(r).unwrap();
    let sharers = |entry: u64, limit: usize| {
        let page = read(&s, |v| references::key_sharers(v, 1, entry, b"ledger", limit));
        let Js::Arr(list) = field(&page, "entries") else { panic!() };
        let things: Vec<Js> = list.iter().map(|named| field(named, "thing").clone()).collect();
        (things, field(&page, "more").clone())
    };
    let thing = |e: u64| Js::Text(e.to_string().into_bytes());
    assert_eq!(sharers(10, 10), (vec![thing(11), thing(12), thing(13), thing(14)], Js::Bool(false)));
    assert_eq!(sharers(12, 2), (vec![thing(10), thing(11)], Js::Bool(true)));
    assert_eq!(sharers(14, 4), (vec![thing(10), thing(11), thing(12), thing(13)], Js::Bool(false)));
    s.commit_wait(vec![drop_value(11, key_field(0, 0))]).unwrap();
    assert_eq!(sharers(10, 10).0, vec![thing(11), thing(12), thing(13), thing(14)], "its other item still has the key");
    s.commit_wait(vec![drop_value(11, key_field(0, 1)), delete(13)]).unwrap();
    assert_eq!(sharers(10, 10).0, vec![thing(12), thing(14)]);
    assert_eq!(read(&s, |v| references::key_sharers(v, 99, 10, b"ledger", 3)), Js::Null);
}

#[test]
fn recounting_from_nothing_gives_the_counts_the_writes_kept() {
    let dir = temp_dir("recount");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let mut m = Model::default();
    let mut rng = Rng(0x2545_f491_4f6c_dd1d);
    let mut next = 100;
    setup(&s, &mut m);
    for _ in 0..300 {
        step(&s, &mut m, &mut rng, &mut next);
    }
    m.check(&s);
    super::relations_tests::derive_job(&s, |view, out| {
        for structure in [book_stats::STAT_FIELD, book_stats::STAT_ENTRY, book_stats::STAT_BOOK] {
            let p = super::kinds::key::of(structure);
            for (k, _) in view.scan(&p, &super::kinds::key::prefix_end(&p), usize::MAX)? {
                out.del(k);
            }
        }
        Ok(())
    });
    assert_eq!(read(&s, |v| book_stat(v, 1)), Default::default());
    let mut after: Option<Vec<u8>> = None;
    loop {
        let from = after.clone();
        after = super::relations_tests::derive_job(&s, move |view, out| {
            book_stats::recount_step(view, out, from.as_deref(), 3)
        });
        if after.is_none() {
            break;
        }
    }
    m.check(&s);
}
