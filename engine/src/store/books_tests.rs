//! Books, entries and lorebook links against a model, through commits, a reopen, a crash and cleaning.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use super::books::{self, BOOK, ENTRY, EntryKey, OWNED};
use super::chat_read::Js;
use super::library::{BY_NAME, CHARACTER, NAME};
use super::library_read::{Filter, Query, Sort};
use super::*;
use crate::log::format::{FieldRef, Record, Value, kind_by_name};

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-books-{}-{name}-{}",
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

fn update(e: u64, kind: u64, key: &str) -> Record {
    rec(
        "entityUpdate",
        vec![Value::Id(e), Value::UInt(kind), text(key), Value::Time(0)],
    )
}

fn delete(e: u64) -> Record {
    rec("entityDelete", vec![Value::Id(e)])
}

fn defined(book: u64, on: bool) -> Record {
    let f = Value::Field(FieldRef::Code(books::DEFINED));
    if on {
        rec(
            "jsonValue",
            vec![
                Value::Sel(0, book),
                f,
                text(""),
                Value::Absent,
                Value::Absent,
            ],
        )
    } else {
        rec(
            "valueDelete",
            vec![Value::Sel(0, book), f, Value::Absent, Value::Absent],
        )
    }
}

fn place(book: u64, entry: u64, position: u64) -> Record {
    rec(
        "itemPlace",
        vec![
            Value::Id(book),
            Value::UInt(books::ENTRIES),
            Value::UInt(entry),
            Value::UInt(position),
        ],
    )
}

fn index(entry: u64, book: u64, x: Option<f64>) -> Record {
    rec(
        "entryIndex",
        vec![
            Value::Id(entry),
            Value::Id(book),
            x.map_or(Value::Absent, Value::F64),
        ],
    )
}

fn link(e: u64, book: Option<u64>) -> Record {
    rec(
        "bookLink",
        vec![Value::Id(e), book.map_or(Value::Absent, Value::Id)],
    )
}

fn forward(from: u64, into: u64) -> Record {
    rec("bookForward", vec![Value::Id(from), Value::Id(into)])
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

#[derive(Default)]
struct Entry {
    key: String,
    position: u64,
    index: Option<f64>,
}

#[derive(Default)]
struct Model {
    /// Per book: its entries by id.
    books: BTreeMap<u64, BTreeMap<u64, Entry>>,
}

impl Model {
    fn check(&self, s: &Store) {
        for (book, entries) in &self.books {
            let mut want: Vec<(u64, u64)> = entries.iter().map(|(e, x)| (x.position, *e)).collect();
            want.sort();
            let mut got = Vec::new();
            let mut after = None;
            loop {
                let page = read(s, |v| books::entries_page(v, *book, after, 7));
                let Js::Arr(list) = field(&page, "entries") else {
                    panic!()
                };
                for x in list {
                    let (Js::Big(id), Js::Num(p)) = (field(x, "id"), field(x, "position")) else {
                        panic!()
                    };
                    got.push((*p as u64, *id));
                    after = Some(*p as u64);
                }
                if *field(&page, "more") != Js::Bool(true) {
                    break;
                }
            }
            assert_eq!(got, want, "book {book}");
            let free = (0..)
                .find(|n| !entries.values().any(|x| x.key == n.to_string()))
                .unwrap();
            let max = entries
                .values()
                .filter_map(|x| x.index)
                .fold(None, |m: Option<f64>, x| {
                    Some(match m {
                        None => x,
                        Some(m) if m.is_nan() || x.is_nan() => f64::NAN,
                        Some(m) => m.max(x),
                    })
                });
            let numbers = read(s, |v| books::book_numbers(v, *book));
            assert_eq!(
                *field(&numbers, "freeKey"),
                Js::Num(free as f64),
                "book {book}"
            );
            match (field(&numbers, "maxIndex"), max) {
                (Js::Null, None) => {}
                (Js::Num(g), Some(w)) if (g.is_nan() && w.is_nan()) || *g == w => {}
                (g, w) => panic!("book {book}: max index {g:?}, want {w:?}"),
            }
        }
    }
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

fn step(s: &Store, m: &mut Model, rng: &mut Rng, next: &mut u64) {
    let book = if rng.next().is_multiple_of(2) { 1 } else { 2 };
    let entries = m.books.get_mut(&book).unwrap();
    match rng.next() % 4 {
        0 | 1 => {
            let k = if rng.next().is_multiple_of(5) {
                format!("k{}", rng.next() % 9)
            } else {
                (rng.next() % 30).to_string()
            };
            let id = *next;
            let ek = books::entry_key(book, &EntryKey::parse(k.as_bytes()));
            let r = vec![
                create(id, ENTRY, std::str::from_utf8(&ek).unwrap()),
                place(book, id, rng.next() % 1000),
            ];
            let taken = entries.values().any(|x| x.key == k);
            let position = match &r[1].values[3] {
                Value::UInt(p) => *p,
                _ => unreachable!(),
            };
            let place_taken = entries.values().any(|x| x.position == position);
            match s.commit_wait(r) {
                Ok(_) => {
                    assert!(!taken && !place_taken, "{k} stored twice");
                    *next += 1;
                    entries.insert(
                        id,
                        Entry {
                            key: k,
                            position,
                            index: None,
                        },
                    );
                }
                Err(StoreError::Refused(_)) => assert!(taken || place_taken, "{k} refused"),
                Err(e) => panic!("{e}"),
            }
        }
        2 if !entries.is_empty() => {
            let ids: Vec<u64> = entries.keys().copied().collect();
            let e = ids[(rng.next() % ids.len() as u64) as usize];
            s.commit_wait(vec![delete(e)]).unwrap();
            entries.remove(&e);
        }
        3 if !entries.is_empty() => {
            let ids: Vec<u64> = entries.keys().copied().collect();
            let e = ids[(rng.next() % ids.len() as u64) as usize];
            let x = match rng.next() % 6 {
                0 => None,
                1 => Some(f64::NAN),
                n => Some((rng.next() % 50) as f64 - n as f64),
            };
            s.commit_wait(vec![index(e, book, x)]).unwrap();
            entries.get_mut(&e).unwrap().index = x;
        }
        _ => {}
    }
}

#[test]
fn entries_places_free_keys_and_indexes_follow_commits_reopens_crashes_and_cleaning() {
    let dir = temp_dir("entries");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    s.commit_wait(vec![
        defined(1, true),
        create(1, BOOK, "one"),
        create(3, CHARACTER, "c.png"),
        create(2, OWNED, "3:c"),
    ])
    .unwrap();
    let mut m = Model::default();
    m.books.insert(1, BTreeMap::new());
    m.books.insert(2, BTreeMap::new());
    let mut rng = Rng(0x2545_f491_4f6c_dd1d);
    let mut next = 100;
    for _ in 0..800 {
        step(&s, &mut m, &mut rng, &mut next);
    }
    m.check(&s);
    s.close();
    drop(s);
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    m.check(&s);
    for _ in 0..300 {
        step(&s, &mut m, &mut rng, &mut next);
    }
    s.abandon();
    std::mem::forget(s);
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    m.check(&s);
    for _ in 0..3000 {
        step(&s, &mut m, &mut rng, &mut next);
    }
    for _ in 0..20 {
        s.inner.ks.freeze_at(s.durable_end());
        s.inner.ks.wait_flushed().unwrap();
        s.wake_cleaner();
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let st = s.stats();
    assert!(st.cleaned_files > 0 && st.relocated_records > 0, "{st:?}");
    m.check(&s);
    s.close();
    drop(s);
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    m.check(&s);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn an_entry_needs_a_book_and_its_key_once() {
    let dir = temp_dir("refusals");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    s.commit_wait(vec![create(1, BOOK, "b"), create(2, CHARACTER, "c.png")])
        .unwrap();
    let refused = |r: Vec<Record>| matches!(s.commit_wait(r), Err(StoreError::Refused(_)));
    assert!(
        refused(vec![create(10, ENTRY, "2:0")]),
        "an entry of a character"
    );
    assert!(
        refused(vec![create(10, ENTRY, "9:0")]),
        "an entry of no book"
    );
    assert!(refused(vec![create(10, ENTRY, "x")]), "a key with no book");
    s.commit_wait(vec![create(10, ENTRY, "1:5")]).unwrap();
    assert!(refused(vec![create(11, ENTRY, "1:5")]), "a key twice");
    assert!(refused(vec![update(10, ENTRY, "1:6")]), "an entry re-keyed");
    assert!(
        refused(vec![index(10, 2, Some(1.0))]),
        "an index in another book"
    );
    // "05" and a key past the safe integers are text, so they don't take an integer key.
    s.commit_wait(vec![
        create(11, ENTRY, "1:05"),
        create(12, ENTRY, "1:9007199254740992"),
    ])
    .unwrap();
    let n = read(&s, |v| books::book_numbers(v, 1));
    assert_eq!(*field(&n, "freeKey"), Js::Num(0.0));
    s.commit_wait(vec![create(13, ENTRY, "1:0")]).unwrap();
    let n = read(&s, |v| books::book_numbers(v, 1));
    assert_eq!(*field(&n, "freeKey"), Js::Num(1.0));
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

fn world_page(s: &Store, key: &str) -> Vec<u64> {
    let q = Query {
        filter: Filter {
            characters: true,
            world: Some(key.as_bytes().to_vec()),
            ..Filter::default()
        },
        sort: Sort::Key {
            sort: BY_NAME,
            desc: false,
        },
        offset: 0,
        limit: 100,
        cursor: None,
        count: true,
        cap: 100_000,
    };
    let mut ids = s.library_page(&q).unwrap().ids;
    ids.sort();
    ids
}

fn listed(s: &Store) -> Vec<(u64, String)> {
    let page = read(s, |v| books::books_page(v, None, 100));
    let Js::Arr(list) = field(&page, "books") else {
        panic!()
    };
    list.iter()
        .map(|b| match (field(b, "id"), field(b, "key")) {
            (Js::Big(id), Js::Text(k)) => (*id, String::from_utf8(k.clone()).unwrap()),
            _ => panic!(),
        })
        .collect()
}

fn resolved(s: &Store, book: u64) -> (u64, String, bool) {
    let r = read(s, |v| books::resolved(v, &[book]));
    let Js::Arr(list) = r else { panic!() };
    match (
        field(&list[0], "id"),
        field(&list[0], "key"),
        field(&list[0], "defined"),
    ) {
        (Js::Big(id), Js::Text(k), Js::Bool(d)) => (*id, String::from_utf8(k.clone()).unwrap(), *d),
        other => panic!("{other:?}"),
    }
}

#[test]
fn links_name_books_by_id_and_resolve_unresolved_names() {
    let dir = temp_dir("links");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let character = |e: u64| {
        vec![
            create(e, CHARACTER, &format!("c{e}.png")),
            rec(
                "textValue",
                vec![
                    Value::Sel(0, e),
                    Value::Field(FieldRef::Code(NAME)),
                    text(&format!("c{e}")),
                    Value::Absent,
                    Value::Absent,
                ],
            ),
        ]
    };
    // A book, and a name no book has (unresolved), each linked by a character.
    let mut r = vec![
        defined(1, true),
        create(1, BOOK, "lore"),
        create(2, BOOK, "gone"),
    ];
    r.extend(character(10));
    r.extend(character(11));
    r.push(link(10, Some(1)));
    r.push(link(11, Some(2)));
    s.commit_wait(r).unwrap();
    assert_eq!(listed(&s), vec![(1, "lore".into())]);
    assert_eq!(world_page(&s, "lore"), vec![10]);
    assert_eq!(world_page(&s, "gone"), vec![11]);
    assert_eq!(world_page(&s, "none"), Vec::<u64>::new());
    assert_eq!(resolved(&s, 2), (2, "gone".into(), false));
    let refused = |r: Vec<Record>| matches!(s.commit_wait(r), Err(StoreError::Refused(_)));
    assert!(refused(vec![delete(1)]), "a book goes only forwarded");
    assert!(
        refused(vec![forward(1, 2)]),
        "a defined book isn't forwarded"
    );
    assert!(refused(vec![link(1, Some(1))]), "a book links nothing");
    assert!(refused(vec![link(10, Some(10))]), "a link names a book");
    // The book is renamed to the unresolved name: the name resolves as the book, and goes.
    s.commit_wait(vec![forward(2, 1), delete(2), update(1, BOOK, "gone")])
        .unwrap();
    assert_eq!(listed(&s), vec![(1, "gone".into())]);
    assert_eq!(resolved(&s, 2), (1, "gone".into(), true));
    assert_eq!(world_page(&s, "gone"), vec![10, 11]);
    assert_eq!(world_page(&s, "lore"), Vec::<u64>::new());
    // Deleted, the book is an unresolved name again; links keep naming it.
    s.commit_wait(vec![defined(1, false)]).unwrap();
    assert_eq!(listed(&s), Vec::<(u64, String)>::new());
    assert_eq!(resolved(&s, 2), (1, "gone".into(), false));
    assert_eq!(world_page(&s, "gone"), vec![10, 11]);
    // A link moves and goes; a character going takes its link.
    s.commit_wait(vec![link(10, None)]).unwrap();
    assert_eq!(world_page(&s, "gone"), vec![11]);
    s.commit_wait(vec![delete(11)]).unwrap();
    assert_eq!(world_page(&s, "gone"), Vec::<u64>::new());
    let links = read(&s, |v| books::links(v, &[10, 11]));
    assert_eq!(links, Js::Arr(vec![Js::Null, Js::Null]));
    s.close();
    drop(s);
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    assert_eq!(resolved(&s, 2), (1, "gone".into(), false));
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_change_to_an_entry_or_owned_book_changes_its_books_and_owners_versions() {
    let dir = temp_dir("versions");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let version = |e: u64| {
        s.library_entities(&[e]).unwrap()[0]
            .as_ref()
            .unwrap()
            .version
    };
    s.commit_wait(vec![
        create(1, CHARACTER, "c.png"),
        create(2, OWNED, "1:c"),
        create(3, ENTRY, "2:0"),
    ])
    .unwrap();
    let (c, b) = (version(1), version(2));
    s.commit_wait(vec![rec(
        "jsonValue",
        vec![
            Value::Sel(0, 3),
            Value::Field(FieldRef::Key(b"content".to_vec())),
            text("1"),
            Value::Absent,
            Value::Absent,
        ],
    )])
    .unwrap();
    assert!(version(2) > b && version(1) > c, "an entry's value");
    let (c, b) = (version(1), version(2));
    s.commit_wait(vec![delete(3)]).unwrap();
    assert!(version(2) > b && version(1) > c, "an entry going");
    let refused = |r: Vec<Record>| matches!(s.commit_wait(r), Err(StoreError::Refused(_)));
    assert!(
        refused(vec![create(4, OWNED, "x")]),
        "an owned book's key names its owner"
    );
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn an_entry_edit_writes_the_same_whatever_its_books_size() {
    let dir = temp_dir("edit-cost");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let content = |e: u64, t: &str| {
        rec(
            "textValue",
            vec![
                Value::Sel(0, e),
                Value::Field(FieldRef::Code(104)),
                text(t),
                Value::Absent,
                Value::Absent,
            ],
        )
    };
    let mut costs = Vec::new();
    let mut next = 10;
    for (book, size) in [(1, 10u64), (2, 1000)] {
        s.commit_wait(vec![
            defined(book, true),
            create(book, BOOK, &format!("b{book}")),
        ])
        .unwrap();
        for i in 0..size {
            let e = next;
            next += 1;
            s.commit_wait(vec![
                content(e, "the castle by the river"),
                create(e, ENTRY, &format!("{book}:{i}")),
                place(book, e, (i + 1) << 20),
                index(e, book, Some(i as f64)),
            ])
            .unwrap();
        }
        let e = next - 1 - size / 2;
        let before = (s.stats().ks.inserted, s.stats().log_bytes);
        s.commit_wait(vec![rec(
            "textEdit",
            vec![
                Value::Sel(0, e),
                Value::Field(FieldRef::Code(104)),
                Value::UInt(4),
                Value::UInt(6),
                text("tower"),
                Value::Absent,
                Value::Absent,
            ],
        )])
        .unwrap();
        let after = (s.stats().ks.inserted, s.stats().log_bytes);
        costs.push((after.0 - before.0, after.1 - before.1));
    }
    // Derived: the text's head, its edit, the entry's version and its book's, and the two changed terms' search
    // entries in the book's scope. The record (and its group's trailer) differs only by the varint of the entry's id.
    assert!(costs.iter().all(|c| c.0 == costs[0].0), "{costs:?}");
    assert!(costs.iter().all(|c| c.1 <= 17), "{costs:?}");
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}
