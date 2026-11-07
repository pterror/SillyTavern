use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use super::books::{self, BOOK};
use super::chat_read::Js;
use super::library::{self, CHARACTER, GROUP};
use super::*;
use crate::log::format::{FieldRef, Record, Value, kind_by_name};

const USER_TYPE: u64 = 11;
const PERSONA: u64 = 21;
const USER: u64 = 1;

const SELECTED: u64 = 0;
const LOREBOOK: u64 = 1;

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-choices-{}-{name}-{}",
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

fn update(e: u64, kind: u64, key: &str) -> Record {
    rec(
        "entityUpdate",
        vec![Value::Id(e), Value::UInt(kind), text(key), Value::F64(0.0)],
    )
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

fn book(e: u64, key: &str) -> Vec<Record> {
    vec![create(e, BOOK, key), defined(e, true)]
}

fn delete(e: u64) -> Record {
    rec("entityDelete", vec![Value::Id(e)])
}

fn hist_delete(e: u64, change: u64) -> Record {
    rec(
        "histEntityDelete",
        vec![
            Value::Id(e),
            Value::Id(change),
            Value::Time(1_700_000_000_000),
            Value::Absent,
            Value::Id(USER),
        ],
    )
}

fn choose(holder: u64, slot: u64, keys: &[&str]) -> Record {
    rec(
        "bookChoose",
        vec![Value::Id(holder), Value::UInt(slot), text(&keys.join("\n"))],
    )
}

fn unchoose(holder: u64, slot: u64, book: u64) -> Record {
    rec(
        "bookUnchoose",
        vec![Value::Id(holder), Value::UInt(slot), Value::Id(book)],
    )
}

fn field<'a>(o: &'a Js, name: &str) -> &'a Js {
    let Js::Obj(fields) = o else {
        panic!("not an object: {o:?}")
    };
    &fields.iter().find(|(k, _)| *k == name).unwrap().1
}

fn chosen(s: &Store, holder: u64) -> Vec<(u64, Vec<(u64, String)>)> {
    let read = s
        .chat_read(|v| super::choices::choices(v, &[holder]))
        .unwrap();
    let Js::Arr(holders) = read else { panic!() };
    let Js::Arr(slots) = &holders[0] else {
        panic!()
    };
    slots
        .iter()
        .map(|slot| {
            let Js::Num(n) = field(slot, "slot") else {
                panic!()
            };
            let Js::Arr(books) = field(slot, "books") else {
                panic!()
            };
            let books = books
                .iter()
                .map(|b| match (field(b, "id"), field(b, "key")) {
                    (Js::Big(id), Js::Text(k)) => (*id, String::from_utf8(k.clone()).unwrap()),
                    other => panic!("{other:?}"),
                })
                .collect();
            (*n as u64, books)
        })
        .collect()
}

fn choosers(
    s: &Store,
    book: u64,
    after: Option<u64>,
    limit: usize,
) -> (Vec<(u64, u64, u64, String)>, bool) {
    let page = s
        .chat_read(|v| super::choices::choosers_page(v, book, after, limit))
        .unwrap();
    let Js::Arr(list) = field(&page, "choosers") else {
        panic!()
    };
    let Js::Bool(more) = field(&page, "more") else {
        panic!()
    };
    let rows = list
        .iter()
        .map(|c| {
            match (
                field(c, "holder"),
                field(c, "slot"),
                field(c, "type"),
                field(c, "key"),
            ) {
                (Js::Big(h), Js::Num(slot), Js::Num(t), Js::Text(k)) => (
                    *h,
                    *slot as u64,
                    *t as u64,
                    String::from_utf8(k.clone()).unwrap(),
                ),
                other => panic!("{other:?}"),
            }
        })
        .collect();
    (rows, *more)
}

fn refused(s: &Store, r: Vec<Record>) -> bool {
    matches!(s.commit_wait(r), Err(StoreError::Refused(_)))
}

fn seeded(dir: &std::path::Path) -> Store {
    let s = Store::open_in(dir, SMALL, pool()).unwrap();
    let mut r = vec![rec(
        "keyMap",
        vec![
            Value::Sel(super::chat::KEYED_USER, USER),
            Value::Bytes(b"user-1".to_vec()),
        ],
    )];
    r.extend(book(1, "Lore"));
    r.extend(book(2, "Other"));
    r.extend(book(3, "Third"));
    r.push(create(4, BOOK, "Ghost"));
    r.push(create(10, USER_TYPE, "u"));
    r.push(create(11, PERSONA, "p.png"));
    r.push(create(12, CHARACTER, "c.png"));
    r.push(create(13, GROUP, "g1"));
    s.commit_wait(r).unwrap();
    s
}

#[test]
fn a_choice_keeps_the_defined_books_it_names_in_order_by_id() {
    let dir = temp_dir("choose");
    let s = seeded(&dir);
    s.commit_wait(vec![
        choose(
            10,
            SELECTED,
            &["Other", "Ghost", "Missing", "Lore", "Other", ""],
        ),
        choose(11, LOREBOOK, &["Third"]),
    ])
    .unwrap();
    assert_eq!(
        chosen(&s, 10),
        vec![(SELECTED, vec![(2, "Other".into()), (1, "Lore".into())])],
        "a placeholder, a missing name and a repeat are left out"
    );
    assert_eq!(
        choosers(&s, 1, None, 10).0,
        vec![(10, SELECTED, USER_TYPE, "u".into())]
    );
    assert_eq!(choosers(&s, 4, None, 10).0, Vec::new());

    s.commit_wait(vec![update(1, BOOK, "Renamed")]).unwrap();
    assert_eq!(
        chosen(&s, 10),
        vec![(SELECTED, vec![(2, "Other".into()), (1, "Renamed".into())])],
        "a choice follows its book's rename"
    );

    s.commit_wait(vec![choose(10, SELECTED, &["Third", "Other"])])
        .unwrap();
    assert_eq!(choosers(&s, 1, None, 10).0, Vec::new());
    assert_eq!(choosers(&s, 3, None, 10).0.len(), 2);
    s.close();
    drop(s);

    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    assert_eq!(
        chosen(&s, 10),
        vec![(SELECTED, vec![(3, "Third".into()), (2, "Other".into())])]
    );
    assert_eq!(chosen(&s, 11), vec![(LOREBOOK, vec![(3, "Third".into())])]);
    s.commit_wait(vec![choose(10, SELECTED, &[])]).unwrap();
    assert_eq!(chosen(&s, 10), Vec::new());
    assert_eq!(choosers(&s, 2, None, 10).0, Vec::new());
    assert!(
        refused(&s, vec![choose(99, SELECTED, &["Lore"])]),
        "a choice needs its holder"
    );
    let refs = |t: &str| {
        rec(
            "bookRefs",
            vec![Value::Id(10), Value::UInt(SELECTED), text(t)],
        )
    };
    assert!(
        refused(&s, vec![refs("2")]),
        "bookRefs is only made by a choose"
    );
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn unchoosing_a_book_keeps_the_rest_and_a_book_is_deleted_only_once_nothing_chooses_it() {
    let dir = temp_dir("unchoose");
    let s = seeded(&dir);
    s.commit_wait(vec![
        choose(10, SELECTED, &["Lore", "Other"]),
        choose(11, LOREBOOK, &["Lore"]),
        choose(12, SELECTED, &["Lore"]),
        choose(13, SELECTED, &["Other", "Lore"]),
    ])
    .unwrap();
    assert_eq!(
        choosers(&s, 1, None, 2),
        (
            vec![
                (10, SELECTED, USER_TYPE, "u".into()),
                (11, LOREBOOK, PERSONA, "p.png".into())
            ],
            true
        )
    );
    assert_eq!(
        choosers(&s, 1, Some(11), 2),
        (
            vec![
                (12, SELECTED, CHARACTER, "c.png".into()),
                (13, SELECTED, GROUP, "g1".into())
            ],
            false
        )
    );
    assert!(refused(&s, vec![delete(1)]), "settings choose it");
    assert!(
        refused(
            &s,
            vec![
                unchoose(10, SELECTED, 1),
                unchoose(11, LOREBOOK, 1),
                unchoose(12, SELECTED, 1),
                delete(1)
            ]
        ),
        "a group still chooses it"
    );
    assert!(
        refused(&s, vec![defined(1, false)]),
        "a chosen book stays defined"
    );
    s.commit_wait(vec![
        unchoose(10, SELECTED, 1),
        unchoose(11, LOREBOOK, 1),
        unchoose(12, SELECTED, 1),
        unchoose(13, SELECTED, 1),
        unchoose(13, SELECTED, 1),
        delete(1),
    ])
    .unwrap();
    assert_eq!(chosen(&s, 10), vec![(SELECTED, vec![(2, "Other".into())])]);
    assert_eq!(chosen(&s, 11), Vec::new());
    assert_eq!(chosen(&s, 12), Vec::new());
    assert_eq!(chosen(&s, 13), vec![(SELECTED, vec![(2, "Other".into())])]);
    assert_eq!(choosers(&s, 1, None, 10).0, Vec::new());
    s.commit_wait(book(5, "Lore")).unwrap();
    assert_eq!(
        choosers(&s, 5, None, 10).0,
        Vec::new(),
        "a new book of the name is chosen by nobody"
    );
    s.close();
    drop(s);
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    assert_eq!(chosen(&s, 13), vec![(SELECTED, vec![(2, "Other".into())])]);
    assert_eq!(choosers(&s, 2, None, 10).0.len(), 2);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_holder_takes_its_choices_along_when_it_goes() {
    let dir = temp_dir("holder-gone");
    let s = seeded(&dir);
    s.commit_wait(vec![
        choose(11, LOREBOOK, &["Lore"]),
        choose(12, SELECTED, &["Lore", "Other"]),
        choose(13, SELECTED, &["Other"]),
    ])
    .unwrap();
    s.commit_wait(vec![hist_delete(11, 500), delete(12), delete(13)])
        .unwrap();
    assert_eq!(choosers(&s, 1, None, 10).0, Vec::new());
    assert_eq!(choosers(&s, 2, None, 10).0, Vec::new());
    s.commit_wait(vec![delete(1), delete(2)]).unwrap();
    s.close();
    drop(s);
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    s.chat_read(|v| {
        assert_eq!(library::entity_info(v, 1)?, None);
        assert!(!super::choices::is_chosen(v, 2)?);
        Ok(())
    })
    .unwrap();
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn choices_follow_reopens_crashes_and_cleaning() {
    let dir = temp_dir("cleaning");
    let s = seeded(&dir);
    let names = ["Lore", "Other", "Third"];
    let mut want: Vec<Vec<u64>> = vec![Vec::new(); 3];
    let mut n: u64 = 0x2545_f491_4f6c_dd1d;
    let mut step = |s: &Store, want: &mut Vec<Vec<u64>>| {
        n ^= n << 13;
        n ^= n >> 7;
        n ^= n << 17;
        let holder = (n % 3) as usize;
        let pick: Vec<&str> = names
            .iter()
            .enumerate()
            .filter(|(i, _)| (n >> (8 + i)) & 1 == 1)
            .map(|(_, k)| *k)
            .collect();
        s.commit_wait(vec![choose(10 + holder as u64, SELECTED, &pick)])
            .unwrap();
        want[holder] = pick
            .iter()
            .map(|k| names.iter().position(|x| x == k).unwrap() as u64 + 1)
            .collect();
    };
    let check = |s: &Store, want: &Vec<Vec<u64>>| {
        for (i, books) in want.iter().enumerate() {
            let got: Vec<u64> = chosen(s, 10 + i as u64)
                .into_iter()
                .flat_map(|(_, b)| b.into_iter().map(|(id, _)| id))
                .collect();
            assert_eq!(&got, books);
        }
        for b in 1..=3u64 {
            let mut by: Vec<u64> = choosers(s, b, None, 10)
                .0
                .into_iter()
                .map(|c| c.0)
                .collect();
            by.sort();
            let expected: Vec<u64> = (0..3)
                .filter(|i| want[*i as usize].contains(&b))
                .map(|i| 10 + i)
                .collect();
            assert_eq!(by, expected);
        }
    };
    for _ in 0..600 {
        step(&s, &mut want);
    }
    check(&s, &want);
    s.abandon();
    std::mem::forget(s);
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    check(&s, &want);
    for _ in 0..2000 {
        step(&s, &mut want);
    }
    for _ in 0..20 {
        s.inner.ks.freeze_at(s.durable_end());
        s.inner.ks.wait_flushed().unwrap();
        s.wake_cleaner();
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let st = s.stats();
    assert!(st.cleaned_files > 0 && st.relocated_records > 0, "{st:?}");
    check(&s, &want);
    s.close();
    drop(s);
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    check(&s, &want);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}
