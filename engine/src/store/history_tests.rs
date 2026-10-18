//! History: changes kept with who and when, runs, reverts, deletes restored, forgetting with and without a marker,
//! through commits, a reopen, a crash and cleaning.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;

use super::books::{self, BOOK, ENTRY};
use super::chat;
use super::chat_read::Js;
use super::history::{self, FORGET_SLICE};
use super::library_read::Stored;
use super::*;
use crate::log::format::{FieldRef, Record, Value, kind_by_name};
use crate::search::Scope;
use crate::search::query::{Clause, Limits, Order, Query};

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-history-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    dir
}

const SMALL: StoreConfig = StoreConfig {
    log: log::Config {
        block_size: 256,
        file_target: 4096,
    },
    ks: KsConfig {
        log_bytes: 8 << 10,
        fan_in: 3,
        block_size: 256,
        max_frozen: 1,
    },
    live_fraction: 0.5,
    relocate_bytes: 1024,
};

fn pool() -> Arc<Pool> {
    Pool::new(16 << 10, 64 << 10, 4, 1, 2, 2)
}

fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
}

fn text(s: &str) -> Value {
    Value::Text(s.as_bytes().to_vec())
}

const BOOK_ID: u64 = 1;
const ENTRY_ID: u64 = 10;
const USER: u64 = 1;
const TAB: u64 = 7;
const OTHER_TAB: u64 = 8;
/// An entry's `content` (searched) and `uid` (JSON).
const CONTENT: u64 = 104;
const UID: u64 = 100;
/// An entry's `key` list.
const KEYS: u64 = 0;

fn content() -> FieldRef {
    FieldRef::Code(CONTENT)
}

/// Through which session (None: none) user 1 makes a change.
#[derive(Clone, Copy)]
struct By {
    tab: Option<u64>,
}

const NOBODY: By = By { tab: None };

fn by(tab: u64) -> By {
    By { tab: Some(tab) }
}

fn meta(c: u64, b: By) -> Vec<Value> {
    vec![
        Value::Id(c),
        Value::Time(1_700_000_000_000 + c as i64),
        b.tab.map_or(Value::Absent, Value::Id),
        Value::Id(USER),
    ]
}

fn set(c: u64, f: &FieldRef, v: &str, json: bool, b: By) -> Record {
    let mut vals = vec![
        Value::Id(ENTRY_ID),
        Value::Field(f.clone()),
        text(v),
        Value::Bit(json),
    ];
    vals.extend(meta(c, b));
    rec("histSet", vals)
}

fn edit(c: u64, f: &FieldRef, offset: u64, removed: u64, t: &str, b: By) -> Record {
    let mut vals = vec![
        Value::Id(ENTRY_ID),
        Value::Field(f.clone()),
        Value::UInt(offset),
        Value::UInt(removed),
        text(t),
        Value::Bit(false),
    ];
    vals.extend(meta(c, b));
    rec("histEdit", vals)
}

fn del(c: u64, f: &FieldRef, b: By) -> Record {
    let mut vals = vec![Value::Id(ENTRY_ID), Value::Field(f.clone())];
    vals.extend(meta(c, b));
    rec("histDelete", vals)
}

fn place(c: u64, list: u64, item: u64, position: Option<u64>, b: By) -> Record {
    let mut vals = vec![
        Value::Id(ENTRY_ID),
        Value::UInt(list),
        Value::UInt(item),
        position.map_or(Value::Absent, Value::UInt),
    ];
    vals.extend(meta(c, b));
    rec("histPlace", vals)
}

fn entity_delete(c: u64) -> Record {
    let mut vals = vec![Value::Id(ENTRY_ID)];
    vals.extend(meta(c, NOBODY).into_iter().take(4));
    rec("histEntityDelete", vals)
}

fn restore(c: u64, key: &str) -> Record {
    let mut vals = vec![
        Value::Id(ENTRY_ID),
        Value::UInt(ENTRY),
        text(key),
        Value::F64(0.0),
    ];
    vals.extend(meta(c, NOBODY).into_iter().take(4));
    rec("histRestore", vals)
}

fn revert(c: u64, f: &FieldRef, target: u64) -> Record {
    let mut vals = vec![
        Value::Id(ENTRY_ID),
        Value::Field(f.clone()),
        Value::Id(target),
    ];
    vals.extend(meta(c, NOBODY).into_iter().take(4));
    rec("histRevert", vals)
}

/// A forget of change `target` of `f` (None, None: everything up to now), leaving marker `marker` or none.
fn forget(f: Option<&FieldRef>, target: Option<u64>, marker: Option<u64>) -> Record {
    rec(
        "histForget",
        vec![
            Value::Id(ENTRY_ID),
            f.map_or(Value::Absent, |f| Value::Field(f.clone())),
            target.map_or(Value::Absent, Value::Id),
            Value::Bit(marker.is_some()),
            marker.map_or(Value::Absent, Value::Id),
            Value::Time(1_700_000_000_000),
            Value::Absent,
            Value::Id(USER),
        ],
    )
}

/// A store with a world book (1), an entry of it (10, key `1:0`, at place 5), user 1 and sessions 7 and 8.
fn open(dir: &std::path::Path) -> Store {
    let s = Store::open_in(dir, SMALL, pool()).unwrap();
    if s.derived(|v| library::entity_info(v, BOOK_ID))
        .unwrap()
        .is_none()
    {
        let key_map = |space: u8, id: u64, k: &str| {
            rec(
                "keyMap",
                vec![Value::Sel(space, id), Value::Bytes(k.as_bytes().to_vec())],
            )
        };
        s.commit_wait(vec![
            key_map(chat::KEYED_USER, USER, "user-1"),
            key_map(chat::KEYED_SESSION, TAB, "tab-7"),
            key_map(chat::KEYED_SESSION, OTHER_TAB, "tab-8"),
            rec(
                "jsonValue",
                vec![
                    Value::Sel(0, BOOK_ID),
                    Value::Field(FieldRef::Code(books::DEFINED)),
                    text(""),
                    Value::Absent,
                    Value::Absent,
                ],
            ),
            rec(
                "entityCreate",
                vec![
                    Value::Id(BOOK_ID),
                    Value::UInt(BOOK),
                    text("b"),
                    Value::F64(0.0),
                ],
            ),
            rec(
                "entityCreate",
                vec![
                    Value::Id(ENTRY_ID),
                    Value::UInt(ENTRY),
                    text("1:0"),
                    Value::F64(0.0),
                ],
            ),
            rec(
                "itemPlace",
                vec![
                    Value::Id(BOOK_ID),
                    Value::UInt(books::ENTRIES),
                    Value::UInt(ENTRY_ID),
                    Value::UInt(5),
                ],
            ),
        ])
        .unwrap();
    }
    s
}

fn refused(s: &Store, r: Vec<Record>) -> bool {
    matches!(s.commit_wait(r), Err(StoreError::Refused(_)))
}

/// The entry's values as a read finds them: (field, text or `json:` + JSON).
fn values(s: &Store) -> Vec<(FieldRef, String)> {
    let Some(e) = s.library_entities(&[ENTRY_ID]).unwrap().pop().unwrap() else {
        return Vec::new();
    };
    let mut out: Vec<(FieldRef, String)> = e
        .values
        .into_iter()
        .map(|(f, v)| {
            let v = match v {
                Stored::Text(t) => String::from_utf8(t).unwrap(),
                Stored::Json(j) => format!("json:{}", String::from_utf8(j).unwrap()),
            };
            (f, v)
        })
        .collect();
    out.sort_by(|a, b| format!("{:?}", a.0).cmp(&format!("{:?}", b.0)));
    out
}

fn value(s: &Store, f: &FieldRef) -> Option<String> {
    values(s).into_iter().find(|(g, _)| g == f).map(|(_, v)| v)
}

fn get<'a>(o: &'a Js, name: &str) -> &'a Js {
    let Js::Obj(fields) = o else {
        panic!("not an object: {o:?}")
    };
    &fields.iter().find(|(k, _)| *k == name).unwrap().1
}

/// The field's changes, last first: (id, kind).
fn changes(s: &Store, f: Option<&FieldRef>) -> Vec<(u64, String)> {
    let page = s
        .chat_read(|v| history::history_page(v, ENTRY_ID, f, None, 1000))
        .unwrap();
    let Js::Arr(rows) = get(&page, "changes") else {
        panic!()
    };
    rows.iter()
        .map(|r| {
            let (Js::Big(id), Js::Text(k)) = (get(r, "id"), get(r, "kind")) else {
                panic!("{r:?}")
            };
            (*id, String::from_utf8(k.clone()).unwrap())
        })
        .collect()
}

/// The field as change `c` left it (None: no value), or None when it reads as no value change.
fn at(s: &Store, f: &FieldRef, c: u64) -> Option<Option<String>> {
    match s.chat_read(|v| history::history_value(v, ENTRY_ID, f, c)) {
        Ok(Js::Null) => Some(None),
        Ok(o) => {
            let Js::Text(t) = get(&o, "value") else {
                panic!()
            };
            Some(Some(String::from_utf8(t.clone()).unwrap()))
        }
        Err(_) => None,
    }
}

fn found(s: &Store, word: &str) -> Vec<u64> {
    let q = Query {
        scope: Scope::book(BOOK_ID),
        clauses: vec![Clause {
            text: word.as_bytes().to_vec(),
            fields: None,
            negate: false,
            quoted: false,
        }],
        filters: Vec::new(),
        order: Order::Relevance,
        limit: 100,
        after: None,
        weights: None,
        limits: Limits::default(),
    };
    s.search(&q)
        .unwrap()
        .hits
        .into_iter()
        .map(|h| h.doc)
        .collect()
}

/// A text long enough that a few small edits of it stay edits.
const LONG: &str = "In the north of the old kingdom a dragon sleeps under the hill, and the village keeps its watch \
                    from the tower by the river, where the knight who once fought it still lives, older now, \
                    remembering every word of the song they sang that night.";

fn long(tail: &str) -> String {
    format!("{LONG}{tail}")
}

fn end(tail: &str) -> u64 {
    (LONG.len() + tail.len()) as u64
}

/// Commits `n` changes of field `f` from id `from`, each after a dead record (a value of the book written over), so
/// cleaning has log files to clean and moves history records.
fn churn(s: &Store, from: u64, n: u64, f: &FieldRef) {
    for c in from..from + n {
        s.commit_wait(vec![filler(), set(c, f, &format!("n{c}"), false, NOBODY)])
            .unwrap();
    }
}

/// A value of the book, each written over the one before.
fn filler() -> Record {
    rec(
        "textValue",
        vec![
            Value::Sel(0, BOOK_ID),
            Value::Field(FieldRef::Key(b"filler".to_vec())),
            text(&"f".repeat(400)),
            Value::Absent,
            Value::Absent,
        ],
    )
}

/// Flushes and cleans until some log file has been cleaned.
fn clean(s: &Store) {
    for _ in 0..20 {
        s.inner.ks.freeze_at(s.durable_end());
        s.inner.ks.wait_flushed().unwrap();
        s.wake_cleaner();
        s.clean().unwrap();
        if s.stats().cleaned_files > 0 {
            return;
        }
    }
    panic!("nothing was cleaned: {:?}", s.stats());
}

/// The kinds of the log's records something points at (what cleaning keeps).
fn live_kinds(s: &Store) -> Vec<&'static str> {
    let mut all = Vec::new();
    let mut next = 0;
    loop {
        let (batch, n) = s.log().iterate_sized(next, 4096).unwrap();
        if batch.is_empty() {
            break;
        }
        all.extend(batch.into_iter().map(|(p, r, _)| (p, r)));
        next = n;
    }
    s.derived(|v| {
        let mut out = Vec::new();
        for (p, r) in &all {
            if derive::deriver(r.kind).is_live(r, *p, v)? {
                out.push(r.kind.name);
            }
        }
        Ok(out)
    })
    .unwrap()
}

fn count(kinds: &[&str], kind: &str) -> usize {
    kinds.iter().filter(|k| **k == kind).count()
}

fn wait_forgotten(s: &Store) {
    for _ in 0..1000 {
        if !s.derived(history::any_forget_pending).unwrap() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    panic!("a forget is still pending");
}

#[test]
fn every_change_is_kept_with_who_and_when_and_current_reads_are_the_latest() {
    let dir = temp_dir("kept");
    let s = open(&dir);
    let f = content();
    let uid = FieldRef::Code(UID);
    s.commit_wait(vec![set(100, &f, &long(" quiet"), false, NOBODY)])
        .unwrap();
    s.commit_wait(vec![edit(101, &f, end(" "), 5, "loud", NOBODY)])
        .unwrap();
    s.commit_wait(vec![set(102, &uid, "0", true, NOBODY)])
        .unwrap();
    s.commit_wait(vec![rec(
        "histEdit",
        [
            vec![
                Value::Id(ENTRY_ID),
                Value::Field(uid.clone()),
                Value::UInt(0),
                Value::UInt(1),
                text("12"),
                Value::Bit(true),
            ],
            meta(103, NOBODY),
        ]
        .concat(),
    )])
    .unwrap();
    assert_eq!(value(&s, &f), Some(long(" loud")));
    assert_eq!(value(&s, &uid).as_deref(), Some("json:12"));
    assert_eq!(found(&s, "loud"), vec![ENTRY_ID]);
    assert!(found(&s, "quiet").is_empty());
    assert_eq!(found(&s, "12"), vec![ENTRY_ID]);
    assert_eq!(
        changes(&s, Some(&f)),
        vec![(101, "edit".into()), (100, "set".into())]
    );
    // A JSON value's edit is a full value while an edit would be about as big.
    assert_eq!(
        changes(&s, Some(&uid)),
        vec![(103, "set".into()), (102, "set".into())]
    );
    assert_eq!(at(&s, &f, 100), Some(Some(long(" quiet"))));
    assert_eq!(at(&s, &f, 101), Some(Some(long(" loud"))));
    assert_eq!(at(&s, &uid, 102), Some(Some("0".into())));
    // A change that changes nothing, an id already used, an id older than the field's latest: refused.
    assert!(refused(
        &s,
        vec![set(104, &f, &long(" loud"), false, NOBODY)]
    ));
    assert!(refused(&s, vec![set(101, &uid, "1", true, NOBODY)]));
    assert!(refused(&s, vec![set(99, &f, "older", false, NOBODY)]));
    s.commit_wait(vec![del(104, &f, NOBODY)]).unwrap();
    assert_eq!(value(&s, &f), None);
    assert!(found(&s, "loud").is_empty());
    assert_eq!(at(&s, &f, 104), Some(None));
    // Nothing superseded is dead.
    let live = live_kinds(&s);
    assert_eq!(count(&live, "histSet"), 3);
    assert_eq!(count(&live, "histEdit"), 1);
    assert_eq!(count(&live, "histDelete"), 1);
    // The changes and their values outlive a reopen, a crash and cleaning (which moves them).
    s.close();
    drop(s);
    let s = open(&dir);
    s.abandon();
    std::mem::forget(s);
    let s = open(&dir);
    let comment = FieldRef::Code(103);
    churn(&s, 200, 60, &comment);
    clean(&s);
    assert!(s.stats().relocated_records > 0);
    assert_eq!(at(&s, &f, 100), Some(Some(long(" quiet"))));
    assert_eq!(at(&s, &f, 101), Some(Some(long(" loud"))));
    assert_eq!(at(&s, &comment, 200), Some(Some("n200".into())));
    assert_eq!(value(&s, &uid).as_deref(), Some("json:12"));
    assert_eq!(value(&s, &comment).as_deref(), Some("n259"));
    assert_eq!(changes(&s, Some(&comment)).len(), 60);
    s.close();
    drop(s);
    let s = open(&dir);
    assert_eq!(at(&s, &comment, 230), Some(Some("n230".into())));
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn every_committed_write_is_a_change_of_its_own_with_its_session() {
    let dir = temp_dir("own");
    let s = open(&dir);
    let f = content();
    s.commit_wait(vec![set(100, &f, LONG, false, NOBODY)])
        .unwrap();
    // Writes one after another through one session, through another, through none: each its own change.
    s.commit_wait(vec![edit(101, &f, end(""), 0, " t", by(TAB))])
        .unwrap();
    s.commit_wait(vec![edit(102, &f, end(" t"), 0, "y", by(TAB))])
        .unwrap();
    s.commit_wait(vec![edit(103, &f, end(" ty"), 0, "p", by(OTHER_TAB))])
        .unwrap();
    s.commit_wait(vec![edit(104, &f, end(" typ"), 0, "e", NOBODY)])
        .unwrap();
    assert_eq!(value(&s, &f), Some(long(" type")));
    assert_eq!(
        changes(&s, Some(&f))
            .iter()
            .map(|c| c.0)
            .collect::<Vec<_>>(),
        vec![104, 103, 102, 101, 100]
    );
    assert_eq!(at(&s, &f, 102), Some(Some(long(" ty"))));
    assert_eq!(count(&live_kinds(&s), "histEdit"), 4);
    let page = s
        .chat_read(|v| history::history_page(v, ENTRY_ID, Some(&f), None, 2))
        .unwrap();
    let Js::Arr(rows) = get(&page, "changes") else {
        panic!()
    };
    assert_eq!(*get(&page, "more"), Js::Bool(true));
    assert_eq!(*get(&rows[0], "session"), Js::Null);
    assert_eq!(*get(&rows[1], "session"), Js::Big(OTHER_TAB));
    assert_eq!(*get(&rows[1], "user"), Js::Big(USER));
    let page = s
        .chat_read(|v| history::history_page(v, ENTRY_ID, Some(&f), Some(103), 10))
        .unwrap();
    let Js::Arr(rows) = get(&page, "changes") else {
        panic!()
    };
    assert_eq!(rows.len(), 3);
    assert_eq!(*get(&rows[0], "session"), Js::Big(TAB));
    // An unknown session is refused.
    assert!(refused(&s, vec![edit(105, &f, 0, 0, "x", by(99))]));
    // Places too, merged with the item's text in its history (an edit of a short text is a full value).
    let item = library::item_field(KEYS, 1);
    s.commit_wait(vec![set(400, &item, "k", false, NOBODY)])
        .unwrap();
    s.commit_wait(vec![place(401, KEYS, 1, Some(10), by(TAB))])
        .unwrap();
    s.commit_wait(vec![place(402, KEYS, 1, Some(20), by(TAB))])
        .unwrap();
    s.commit_wait(vec![edit(403, &item, 1, 0, "k", by(TAB))])
        .unwrap();
    assert_eq!(
        changes(&s, Some(&item)),
        vec![
            (403, "set".into()),
            (402, "place".into()),
            (401, "place".into()),
            (400, "set".into())
        ]
    );
    let e = s
        .library_entities(&[ENTRY_ID])
        .unwrap()
        .pop()
        .unwrap()
        .unwrap();
    assert_eq!(e.items, vec![(KEYS, 1, 20)]);
    s.close();
    drop(s);
    let s = open(&dir);
    assert_eq!(value(&s, &f), Some(long(" type")));
    assert_eq!(at(&s, &f, 101), Some(Some(long(" t"))));
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_revert_is_a_new_change_back_to_an_earlier_value() {
    let dir = temp_dir("revert");
    let s = open(&dir);
    let f = content();
    s.commit_wait(vec![set(100, &f, "one", false, NOBODY)])
        .unwrap();
    s.commit_wait(vec![set(101, &f, "two", false, NOBODY)])
        .unwrap();
    s.commit_wait(vec![del(102, &f, NOBODY)]).unwrap();
    s.commit_wait(vec![revert(103, &f, 100)]).unwrap();
    assert_eq!(value(&s, &f).as_deref(), Some("one"));
    assert_eq!(found(&s, "one"), vec![ENTRY_ID]);
    s.commit_wait(vec![revert(104, &f, 102)]).unwrap();
    assert_eq!(value(&s, &f), None);
    assert_eq!(
        changes(&s, Some(&f)),
        vec![
            (104, "delete".into()),
            (103, "set".into()),
            (102, "delete".into()),
            (101, "set".into()),
            (100, "set".into())
        ]
    );
    // Back to what it is already, or to no change of the field: refused.
    assert!(refused(&s, vec![revert(105, &f, 102)]));
    assert!(refused(&s, vec![revert(105, &f, 999)]));
    // A place goes back too.
    let item = library::item_field(KEYS, 0);
    s.commit_wait(vec![
        set(105, &item, "k", false, NOBODY),
        place(106, KEYS, 0, Some(1), NOBODY),
    ])
    .unwrap();
    s.commit_wait(vec![place(107, KEYS, 0, Some(2), NOBODY)])
        .unwrap();
    s.commit_wait(vec![revert(108, &item, 106)]).unwrap();
    let e = s
        .library_entities(&[ENTRY_ID])
        .unwrap()
        .pop()
        .unwrap()
        .unwrap();
    assert_eq!(e.items, vec![(KEYS, 0, 1)]);
    // A state revert can't name a history change.
    assert!(refused(
        &s,
        vec![rec(
            "stateRevert",
            vec![
                Value::Id(109),
                Value::Id(100),
                Value::Time(0),
                Value::UInt(0),
                Value::Absent,
                Value::Absent,
                Value::Absent,
            ],
        )]
    ));
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_deleted_entry_is_restored_with_its_values() {
    let dir = temp_dir("restore");
    let s = open(&dir);
    let f = content();
    let item = library::item_field(KEYS, 0);
    s.commit_wait(vec![
        set(100, &f, "a dragon", false, NOBODY),
        set(101, &FieldRef::Code(UID), "0", true, NOBODY),
        set(102, &item, "wyrm", false, NOBODY),
        place(103, KEYS, 0, Some(1), NOBODY),
        rec(
            "entryIndex",
            vec![Value::Id(ENTRY_ID), Value::Id(BOOK_ID), Value::F64(3.0)],
        ),
    ])
    .unwrap();
    let before = values(&s);
    s.commit_wait(vec![entity_delete(104)]).unwrap();
    assert!(s.library_entities(&[ENTRY_ID]).unwrap()[0].is_none());
    assert!(found(&s, "dragon").is_empty());
    assert!(found(&s, "wyrm").is_empty());
    let page = s
        .chat_read(|v| history::deleted_page(v, BOOK_ID, None, 10))
        .unwrap();
    let Js::Arr(rows) = get(&page, "entries") else {
        panic!()
    };
    assert_eq!(rows.len(), 1);
    assert_eq!(*get(&rows[0], "key"), Js::Text(b"0".to_vec()));
    assert_eq!(*get(&rows[0], "position"), Js::Num(5.0));
    assert_eq!(*get(&rows[0], "index"), Js::Num(3.0));
    // Writes to it are refused; its history is still read.
    assert!(refused(&s, vec![set(105, &f, "x", false, NOBODY)]));
    assert_eq!(at(&s, &f, 100), Some(Some("a dragon".into())));
    // Its key taken meanwhile: a restore under it, or into another book, is refused; under another key of its book it
    // comes back.
    s.commit_wait(vec![rec(
        "entityCreate",
        vec![
            Value::Id(11),
            Value::UInt(ENTRY),
            text("1:0"),
            Value::F64(0.0),
        ],
    )])
    .unwrap();
    assert!(refused(&s, vec![restore(105, "1:0")]));
    assert!(refused(&s, vec![restore(105, "2:0")]));
    s.commit_wait(vec![restore(105, "1:1")]).unwrap();
    s.close();
    drop(s);
    let s = open(&dir);
    assert_eq!(values(&s), before);
    let e = s
        .library_entities(&[ENTRY_ID])
        .unwrap()
        .pop()
        .unwrap()
        .unwrap();
    assert_eq!(e.key, b"1:1".to_vec());
    assert_eq!(e.items, vec![(KEYS, 0, 1)]);
    assert_eq!(found(&s, "dragon"), vec![ENTRY_ID]);
    assert_eq!(found(&s, "wyrm"), vec![ENTRY_ID]);
    assert_eq!(
        changes(&s, None),
        vec![(105, "restored".into()), (104, "deleted".into())]
    );
    let page = s
        .chat_read(|v| history::deleted_page(v, BOOK_ID, None, 10))
        .unwrap();
    assert_eq!(*get(&page, "entries"), Js::Arr(Vec::new()));
    // Restoring one not deleted is refused; it can be deleted and restored again, its records kept through
    // cleaning.
    assert!(refused(&s, vec![restore(106, "1:2")]));
    churn(&s, 300, 60, &FieldRef::Code(105));
    s.commit_wait(vec![entity_delete(400)]).unwrap();
    for _ in 0..60 {
        s.commit_wait(vec![filler()]).unwrap();
    }
    clean(&s);
    s.commit_wait(vec![restore(401, "1:1")]).unwrap();
    let after: Vec<_> = values(&s)
        .into_iter()
        .filter(|(f, _)| *f != FieldRef::Code(105))
        .collect();
    assert_eq!(after, before);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn forgetting_one_change_leaves_a_marker_or_nothing_and_never_the_current_value() {
    let dir = temp_dir("forget-one");
    let s = open(&dir);
    let f = content();
    s.commit_wait(vec![set(100, &f, LONG, false, NOBODY)])
        .unwrap();
    s.commit_wait(vec![edit(101, &f, end(""), 0, " def", NOBODY)])
        .unwrap();
    s.commit_wait(vec![edit(102, &f, end(" def"), 0, " ghi", NOBODY)])
        .unwrap();
    s.commit_wait(vec![edit(103, &f, end(" def ghi"), 0, " jkl", NOBODY)])
        .unwrap();
    assert!(
        refused(&s, vec![forget(Some(&f), Some(103), None)]),
        "the current one"
    );
    assert!(
        refused(&s, vec![forget(Some(&f), Some(99), None)]),
        "no such change"
    );
    // With a marker: 101 goes, and 102 (an edit of it) is written again from 100, its id kept.
    s.commit_wait(vec![forget(Some(&f), Some(101), Some(200))])
        .unwrap();
    assert_eq!(
        changes(&s, Some(&f)),
        vec![
            (103, "edit".into()),
            (102, "edit".into()),
            (101, "forgotten".into()),
            (100, "set".into())
        ]
    );
    assert_eq!(at(&s, &f, 101), None);
    assert_eq!(at(&s, &f, 102), Some(Some(long(" def ghi"))));
    assert_eq!(value(&s, &f), Some(long(" def ghi jkl")));
    let live = live_kinds(&s);
    assert_eq!(count(&live, "histEdit"), 2);
    assert_eq!(count(&live, "histForget"), 1);
    // Without a trace: nothing of 102 is left.
    s.commit_wait(vec![forget(Some(&f), Some(102), None)])
        .unwrap();
    assert_eq!(
        changes(&s, Some(&f)),
        vec![
            (103, "edit".into()),
            (101, "forgotten".into()),
            (100, "set".into())
        ]
    );
    assert_eq!(value(&s, &f), Some(long(" def ghi jkl")));
    assert_eq!(at(&s, &f, 103), Some(Some(long(" def ghi jkl"))));
    // The marker itself goes without a trace: the forget that left it is dead.
    s.commit_wait(vec![forget(Some(&f), Some(101), None)])
        .unwrap();
    assert_eq!(
        changes(&s, Some(&f)),
        vec![(103, "edit".into()), (100, "set".into())]
    );
    let live = live_kinds(&s);
    assert_eq!(count(&live, "histForget"), 0);
    assert_eq!(count(&live, "histEdit"), 1);
    assert_eq!(count(&live, "histSet"), 1);
    churn(&s, 300, 60, &FieldRef::Code(105));
    clean(&s);
    s.close();
    drop(s);
    let s = open(&dir);
    assert_eq!(value(&s, &f), Some(long(" def ghi jkl")));
    assert_eq!(at(&s, &f, 100), Some(Some(LONG.into())));
    assert_eq!(at(&s, &f, 103), Some(Some(long(" def ghi jkl"))));
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn forgetting_up_to_now_keeps_each_current_value_and_goes_in_slices_through_a_crash() {
    let dir = temp_dir("forget-all");
    let s = open(&dir);
    let f = content();
    let item = library::item_field(KEYS, 0);
    let comment = FieldRef::Code(103);
    let n = (FORGET_SLICE * 2 + 5) as u64;
    s.commit_wait(vec![set(100, &f, LONG, false, NOBODY)])
        .unwrap();
    for c in 101..101 + n {
        s.commit_wait(vec![edit(c, &f, 0, 0, "x", NOBODY)]).unwrap();
    }
    let last = 100 + n;
    let current = value(&s, &f);
    s.commit_wait(vec![
        set(last + 1, &item, "k", false, NOBODY),
        place(last + 2, KEYS, 0, Some(1), NOBODY),
        place(last + 3, KEYS, 0, Some(2), NOBODY),
        set(last + 4, &comment, "gone soon", false, NOBODY),
        del(last + 5, &comment, NOBODY),
        set(last + 6, &FieldRef::Code(106), "only", false, NOBODY),
    ])
    .unwrap();
    // The forget commits without its slices, as after a crash.
    let marker = last + 10;
    let (tx, rx) = std::sync::mpsc::channel();
    s.inner.submit(Job::Commit(
        vec![forget(None, None, Some(marker))],
        Box::new(move |r| {
            let _ = tx.send(r.map(|_| ()));
        }),
    ));
    rx.recv().unwrap().unwrap();
    // It reads as done at once: each field's current change (an edit written as a full value) after one marker.
    assert_eq!(
        changes(&s, Some(&f)),
        vec![(last, "set".into()), (100, "forgotten".into())]
    );
    assert_eq!(at(&s, &f, last), Some(current.clone()));
    assert_eq!(value(&s, &f), current);
    assert_eq!(
        changes(&s, Some(&item)),
        vec![
            (last + 3, "place".into()),
            (last + 2, "forgotten".into()),
            (last + 1, "set".into())
        ]
    );
    assert_eq!(
        changes(&s, Some(&comment)),
        vec![(last + 5, "delete".into()), (last + 4, "forgotten".into())]
    );
    let e = s
        .library_entities(&[ENTRY_ID])
        .unwrap()
        .pop()
        .unwrap()
        .unwrap();
    assert_eq!(e.items, vec![(KEYS, 0, 2)]);
    // A field with nothing to forget reads as it was.
    assert_eq!(
        changes(&s, Some(&FieldRef::Code(106))),
        vec![(last + 6, "set".into())]
    );
    assert!(
        refused(&s, vec![forget(Some(&f), Some(last), None)]),
        "pending"
    );
    assert!(refused(&s, vec![revert(marker + 1, &f, 101)]), "forgotten");
    // A change made meanwhile stays.
    s.commit_wait(vec![edit(marker + 1, &f, 0, 0, "y", NOBODY)])
        .unwrap();
    let current = value(&s, &f);
    s.abandon();
    std::mem::forget(s);
    let s = open(&dir);
    wait_forgotten(&s);
    assert_eq!(value(&s, &f), current);
    assert_eq!(
        changes(&s, Some(&f)),
        vec![
            (marker + 1, "edit".into()),
            (last, "set".into()),
            (100, "forgotten".into())
        ]
    );
    s.derived(|v| {
        for c in 100..last {
            assert_eq!(super::state::change_loc(v, c)?, None, "{c}");
        }
        let p = super::kinds::key::id(history::KEEP, ENTRY_ID);
        assert!(
            v.scan(&p, &super::kinds::key::prefix_end(&p), 1)?
                .is_empty()
        );
        Ok(())
    })
    .unwrap();
    let live = live_kinds(&s);
    assert_eq!(count(&live, "histEdit"), 1);
    assert_eq!(count(&live, "histForget"), 1);
    // Without a trace: no marker, and nothing of what went, the forget before included, is live.
    s.commit_wait(vec![forget(None, None, None)]).unwrap();
    wait_forgotten(&s);
    assert_eq!(changes(&s, Some(&f)), vec![(marker + 1, "set".into())]);
    assert_eq!(
        changes(&s, Some(&item)),
        vec![(last + 3, "place".into()), (last + 1, "set".into())]
    );
    assert_eq!(
        changes(&s, Some(&comment)),
        vec![(last + 5, "delete".into())]
    );
    assert_eq!(value(&s, &f), current);
    let live = live_kinds(&s);
    assert_eq!(count(&live, "histForget"), 0);
    assert_eq!(count(&live, "histEdit"), 0);
    assert_eq!(count(&live, "histSet"), 3);
    assert_eq!(count(&live, "histPlace"), 1);
    assert_eq!(count(&live, "histDelete"), 1);
    // A forget with nothing to forget leaves nothing.
    s.commit_wait(vec![forget(None, None, Some(marker + 2))])
        .unwrap();
    assert!(!s.derived(history::any_forget_pending).unwrap());
    assert_eq!(count(&live_kinds(&s), "histForget"), 0);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_change_over_a_value_written_before_history_takes_its_place() {
    let dir = temp_dir("legacy");
    let s = open(&dir);
    let f = content();
    let uid = FieldRef::Code(UID);
    let item = library::item_field(KEYS, 0);
    let old = |kind: &str, f: &FieldRef, v: &str| {
        rec(
            kind,
            vec![
                Value::Sel(0, ENTRY_ID),
                Value::Field(f.clone()),
                text(v),
                Value::Absent,
                Value::Absent,
            ],
        )
    };
    s.commit_wait(vec![
        old("textValue", &f, LONG),
        old("jsonValue", &uid, "0"),
        old("textValue", &item, "wyrm"),
        rec(
            "itemPlace",
            vec![
                Value::Id(ENTRY_ID),
                Value::UInt(KEYS),
                Value::UInt(0),
                Value::UInt(1),
            ],
        ),
    ])
    .unwrap();
    s.commit_wait(vec![rec(
        "textEdit",
        vec![
            Value::Sel(0, ENTRY_ID),
            Value::Field(f.clone()),
            Value::UInt(0),
            Value::UInt(2),
            text("An"),
            Value::Absent,
            Value::Absent,
        ],
    )])
    .unwrap();
    // The one-off finds what is written before history: the entry's text, JSON and item text, and its item's place.
    let legacy = |s: &Store| {
        s.chat_read(|v| history::legacy_entries(v, None, 10))
            .unwrap()
    };
    let page = legacy(&s);
    let Js::Arr(rows) = get(&page, "entries") else {
        panic!()
    };
    assert_eq!(rows.len(), 1);
    assert_eq!(*get(&rows[0], "id"), Js::Big(ENTRY_ID));
    let Js::Arr(fields) = get(&rows[0], "fields") else {
        panic!()
    };
    assert_eq!(fields.len(), 3);
    assert_eq!(
        *get(&rows[0], "items"),
        Js::Arr(vec![Js::Arr(vec![Js::Num(KEYS as f64), Js::Num(0.0)])])
    );
    let before = values(&s);
    // An edit of an old value is written as a full value; the old records die.
    s.commit_wait(vec![
        edit(100, &f, end("") - 1, 1, ".", NOBODY),
        set(101, &uid, "0", true, NOBODY),
        set(102, &item, "wyrm", false, NOBODY),
        place(103, KEYS, 0, Some(2), NOBODY),
    ])
    .unwrap();
    assert_eq!(changes(&s, Some(&f)), vec![(100, "set".into())]);
    let mut want = before.clone();
    for (g, v) in &mut want {
        if *g == f {
            v.pop();
            v.push('.');
        }
    }
    assert_eq!(values(&s), want);
    let e = s
        .library_entities(&[ENTRY_ID])
        .unwrap()
        .pop()
        .unwrap()
        .unwrap();
    assert_eq!(e.items, vec![(KEYS, 0, 2)]);
    assert_eq!(found(&s, "wyrm"), vec![ENTRY_ID]);
    let live = live_kinds(&s);
    assert_eq!(count(&live, "textValue"), 0);
    assert_eq!(count(&live, "textEdit"), 0);
    assert_eq!(
        count(&live, "itemPlace"),
        1,
        "the entry's place in its book"
    );
    assert_eq!(count(&live, "jsonValue"), 1, "the book's definition marker");
    assert_eq!(*get(&legacy(&s), "entries"), Js::Arr(Vec::new()));
    // The same value or place over one written before history is its first change.
    s.close();
    drop(s);
    let dir2 = temp_dir("legacy-same");
    let s = open(&dir2);
    s.commit_wait(vec![
        old("textValue", &f, "kept"),
        rec(
            "itemPlace",
            vec![
                Value::Id(ENTRY_ID),
                Value::UInt(KEYS),
                Value::UInt(0),
                Value::UInt(1),
            ],
        ),
    ])
    .unwrap();
    s.commit_wait(vec![
        set(100, &f, "kept", false, NOBODY),
        place(101, KEYS, 0, Some(1), NOBODY),
    ])
    .unwrap();
    assert!(refused(&s, vec![set(102, &f, "kept", false, NOBODY)]));
    assert_eq!(value(&s, &f).as_deref(), Some("kept"));
    let live = live_kinds(&s);
    assert_eq!(count(&live, "textValue"), 0);
    assert_eq!(count(&live, "itemPlace"), 1);
    drop(s);
    fs::remove_dir_all(&dir2).unwrap();
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn commits_that_read_what_they_change_stay_right_while_the_log_is_cleaned_flushed_and_merged() {
    // A commit's job reads each published value once (`derive::Memo`): while it derives, cleaning, flushes
    // and merges go on beside it, and every value and every change still reads as written, also reopened.
    let dir = temp_dir("memo-cleaning");
    let uid = FieldRef::Code(UID);
    const N: u64 = 160;
    // Ids `first(i) - 1 ..= first(i) + 3` are commit i's.
    let first = |i: u64| 1000 + i * 5;
    let check = |s: &Store| {
        let last = N - 1;
        assert_eq!(value(s, &content()), Some(format!("Z{last}b")));
        assert_eq!(value(s, &uid), Some(format!("json:\"u{last}\"")));
        for i in 0..N {
            let c = first(i);
            assert_eq!(
                at(s, &content(), c),
                Some(Some(format!("a{i}"))),
                "change {c}"
            );
            assert_eq!(
                at(s, &content(), c + 1),
                Some(Some(format!("a{i}b"))),
                "change {}",
                c + 1
            );
            assert_eq!(
                at(s, &content(), c + 3),
                Some(Some(format!("Z{i}b"))),
                "change {}",
                c + 3
            );
            if i % 2 == 1 {
                let before = format!("Z{}b", i - 1);
                assert_eq!(
                    at(s, &content(), c - 1),
                    Some(Some(format!("p{before}"))),
                    "change {}",
                    c - 1
                );
            }
        }
        let n = changes(s, Some(&content())).len() as u64;
        assert_eq!(n, N * 3 + N / 2);
    };
    {
        let s = open(&dir);
        let done = AtomicBool::new(false);
        std::thread::scope(|t| {
            t.spawn(|| {
                while !done.load(Ordering::Acquire) {
                    s.inner.ks.freeze_at(s.durable_end());
                    s.inner.ks.wait_flushed().unwrap();
                    s.wake_cleaner();
                    s.clean().unwrap();
                }
            });
            for i in 0..N {
                let c = first(i);
                let a = format!("a{i}");
                // A value set, then edited twice in the same commit (each edit reads the one before it,
                // unpublished), and a JSON value; every other commit also edits the value the commit before
                // left (published, read through the job's memo) before setting it again.
                let mut recs = vec![filler()];
                if i % 2 == 1 {
                    recs.push(edit(c - 1, &content(), 0, 0, "p", NOBODY));
                }
                recs.extend([
                    set(c, &content(), &a, false, NOBODY),
                    edit(c + 1, &content(), a.len() as u64, 0, "b", NOBODY),
                    set(c + 2, &uid, &format!("\"u{i}\""), true, NOBODY),
                    edit(c + 3, &content(), 0, 1, "Z", NOBODY),
                ]);
                s.commit_wait(recs).unwrap();
            }
            done.store(true, Ordering::Release);
        });
        clean(&s);
        assert!(s.stats().cleaned_files > 0, "{:?}", s.stats());
        check(&s);
    }
    {
        let s = open(&dir);
        check(&s);
    }
    fs::remove_dir_all(&dir).unwrap();
}

/// SplitMix64, seeded: the randomized history test's choices.
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

/// Random commits of sets, edits (several of one field in a commit, each over the one before) and deletes of three
/// fields, with dead records for cleaning, interleaved with flushes, merges, cleaning and reopens: every current
/// value, every past change's value and every field's change count read as a plain model says. `ST_MODEL_SEEDS`,
/// `ST_MODEL_SEED` and `ST_MODEL_STEPS` choose seeds and length as in the keyspace's model test.
#[test]
fn random_history_reads_as_the_model_says_through_flushes_cleaning_and_reopens() {
    let seeds: Vec<u64> = match std::env::var("ST_MODEL_SEED") {
        Ok(s) => vec![s.parse().unwrap()],
        Err(_) => {
            let n: u64 = std::env::var("ST_MODEL_SEEDS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(3);
            (1..=n).collect()
        }
    };
    let steps: u64 = std::env::var("ST_MODEL_STEPS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(300);
    let fields = [
        (FieldRef::Code(CONTENT), false),
        (FieldRef::Key(b"note".to_vec()), false),
        (FieldRef::Code(UID), true),
    ];
    for seed in seeds {
        let mut rng = Rng(seed);
        let dir = temp_dir(&format!("random-{seed}"));
        let mut s = open(&dir);
        // Per field: its current value, and the value each of its changes left (None: no value).
        let mut cur: Vec<Option<String>> = vec![None; fields.len()];
        let mut after: Vec<Vec<(u64, Option<String>)>> = vec![Vec::new(); fields.len()];
        let mut next = 1000u64;
        let mut cleaned = 0;
        for step in 0..steps {
            let here = format!("seed {seed} step {step}");
            match rng.below(10) {
                0..=5 => {
                    let mut recs = Vec::new();
                    if rng.below(2) == 0 {
                        recs.push(filler());
                    }
                    let mut planned = cur.clone();
                    let mut made = Vec::new();
                    for _ in 0..1 + rng.below(5) {
                        let fi = rng.below(fields.len() as u64) as usize;
                        let (f, json) = &fields[fi];
                        let c = next;
                        let r = rng.below(10);
                        let new = match (&planned[fi], r) {
                            (Some(old), 0..=4) if !json => {
                                let off = rng.below(old.len() as u64 + 1);
                                let removed = rng.below(old.len() as u64 - off + 1).min(5);
                                let ins: String = (0..rng.below(4))
                                    .map(|_| (b'a' + rng.below(26) as u8) as char)
                                    .collect();
                                if removed == 0 && ins.is_empty() {
                                    continue;
                                }
                                let mut v = old.clone();
                                v.replace_range(off as usize..(off + removed) as usize, &ins);
                                recs.push(edit(c, f, off, removed, &ins, NOBODY));
                                Some(v)
                            }
                            (Some(_), 5) => {
                                recs.push(del(c, f, NOBODY));
                                None
                            }
                            _ => {
                                let v = if *json {
                                    format!("\"j{}\"", rng.below(1000))
                                } else {
                                    format!(
                                        "t{}{}",
                                        rng.below(1000),
                                        "x".repeat(rng.below(30) as usize)
                                    )
                                };
                                recs.push(set(c, f, &v, *json, NOBODY));
                                Some(v)
                            }
                        };
                        if new == planned[fi] {
                            // A change that changes nothing is refused.
                            recs.pop();
                            continue;
                        }
                        next += 1;
                        planned[fi] = new.clone();
                        made.push((fi, c, new));
                    }
                    if made.is_empty() {
                        continue;
                    }
                    s.commit_wait(recs)
                        .unwrap_or_else(|e| panic!("{here}: commit refused: {e:?}"));
                    cur = planned;
                    for (fi, c, v) in made {
                        after[fi].push((c, v));
                    }
                }
                6..=7 => {
                    for (fi, (f, json)) in fields.iter().enumerate() {
                        let want = cur[fi].as_ref().map(|v| {
                            if *json {
                                format!("json:{v}")
                            } else {
                                v.clone()
                            }
                        });
                        assert_eq!(value(&s, f), want, "{here}: current {f:?}");
                        assert_eq!(
                            changes(&s, Some(f)).len(),
                            after[fi].len(),
                            "{here}: changes of {f:?}"
                        );
                        if !json && !after[fi].is_empty() {
                            let (c, v) = &after[fi][rng.below(after[fi].len() as u64) as usize];
                            assert_eq!(
                                at(&s, f, *c),
                                Some(v.clone()),
                                "{here}: {f:?} as change {c} left it"
                            );
                        }
                    }
                }
                8 => {
                    s.inner.ks.freeze_at(s.durable_end());
                    s.inner.ks.wait_flushed().unwrap();
                    s.wake_cleaner();
                    s.clean().unwrap();
                    cleaned += s.stats().cleaned_files;
                    if rng.below(2) == 0 {
                        s.inner.ks.wait_merged();
                    }
                }
                _ => {
                    drop(s);
                    s = open(&dir);
                }
            }
        }
        for (fi, (f, json)) in fields.iter().enumerate() {
            let want = cur[fi].as_ref().map(|v| {
                if *json {
                    format!("json:{v}")
                } else {
                    v.clone()
                }
            });
            assert_eq!(value(&s, f), want, "seed {seed}: current {f:?} at the end");
            if !json {
                for (c, v) in &after[fi] {
                    assert_eq!(
                        at(&s, f, *c),
                        Some(v.clone()),
                        "seed {seed}: {f:?} as change {c} left it"
                    );
                }
            }
        }
        assert!(
            steps < 100 || cleaned > 0,
            "seed {seed}: nothing was cleaned"
        );
        drop(s);
        fs::remove_dir_all(&dir).unwrap();
    }
}
