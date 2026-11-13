use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;

use super::drafts::{self, Owner};
use super::*;
use crate::log::format::{Value, kind_by_name};

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-drafts-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    dir
}

fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
}

fn card(e: u64) -> Record {
    rec(
        "entityCreate",
        vec![
            Value::Id(e),
            Value::UInt(super::library::CHARACTER),
            Value::Text(format!("c{e}.png").into_bytes()),
            Value::F64(0.0),
        ],
    )
}

fn append(id: u64, parent: Option<u64>, tree: u64) -> Record {
    rec(
        "messageAppend",
        vec![
            Value::Id(id),
            parent.map_or(Value::Absent, Value::Id),
            Value::Id(tree),
            Value::Absent,
            Value::Absent,
            Value::Time(id as i64),
            Value::Text(b"m".to_vec()),
            Value::UInt(0),
            Value::Absent,
            Value::Id(1),
            Value::Absent,
        ],
    )
}

fn at(o: Owner) -> [Value; 2] {
    match o {
        Owner::Message(m) => [Value::Sel(1, m), Value::Absent],
        Owner::Root(t) => [Value::Sel(0, t), Value::Absent],
        Owner::Greeting(t, g) => [Value::Sel(0, t), Value::UInt(g)],
    }
}

fn value(o: Owner, text: &str) -> Record {
    let [a, g] = at(o);
    rec(
        "draftValue",
        vec![a, g, Value::Text(text.as_bytes().to_vec()), Value::Absent, Value::Absent],
    )
}

fn edit(o: Owner, offset: u64, removed: u64, text: &str) -> Record {
    let [a, g] = at(o);
    rec(
        "draftEdit",
        vec![
            a,
            g,
            Value::UInt(offset),
            Value::UInt(removed),
            Value::Text(text.as_bytes().to_vec()),
            Value::Absent,
            Value::Absent,
        ],
    )
}

fn open(dir: &std::path::Path) -> Store {
    let s = Store::open_in(dir, StoreConfig::default(), Pool::new(16 << 20, 16 << 20, 4, 1, 2, 2)).unwrap();
    s.commit_wait(vec![rec(
        "keyMap",
        vec![Value::Sel(super::chat::KEYED_USER, 1), Value::Bytes(b"user-1".to_vec())],
    )])
    .unwrap();
    s
}

fn read(s: &Store, o: Owner) -> Option<String> {
    s.derived(|v| drafts::draft(v, o))
        .unwrap()
        .map(|b| String::from_utf8(b).unwrap())
}

fn live(s: &Store, pos: u64) -> bool {
    s.derived(|v| {
        let (r, _) = v.record(pos)?;
        super::kinds::deriver(r.kind.name).unwrap().is_live(&r, pos, v)
    })
    .unwrap()
}

fn kind_at(s: &Store, pos: u64) -> &'static str {
    s.derived(|v| Ok(v.record(pos)?.0.kind.name)).unwrap()
}

fn version(s: &Store, e: u64) -> Option<Vec<u8>> {
    s.derived(|v| v.get(&key::id(key::VERSION, e))).unwrap()
}

const M: Owner = Owner::Message(1);
const ROOT: Owner = Owner::Root(10);
const GREETING: Owner = Owner::Greeting(10, 0);
const OTHER_GREETING: Owner = Owner::Greeting(10, 3);

#[test]
fn a_draft_is_kept_by_what_it_follows_and_edited_in_place() {
    let dir = temp_dir("kept");
    let s = open(&dir);
    s.commit_wait(vec![card(10), append(0, None, 10), append(1, Some(0), 10)]).unwrap();
    let card_version = version(&s, 10);
    let message = s.derived(|v| super::chat_read::messages(v, &[1])).unwrap();
    s.commit_wait(vec![
        value(M, "after one"),
        value(ROOT, "at the root"),
        value(GREETING, "after greeting 0"),
        value(OTHER_GREETING, "after greeting 3"),
    ])
    .unwrap();
    assert_eq!(read(&s, M).as_deref(), Some("after one"));
    assert_eq!(read(&s, ROOT).as_deref(), Some("at the root"));
    assert_eq!(read(&s, GREETING).as_deref(), Some("after greeting 0"));
    assert_eq!(read(&s, OTHER_GREETING).as_deref(), Some("after greeting 3"));
    assert_eq!(read(&s, Owner::Message(0)), None);

    let long = "a long draft that outweighs its small edits";
    let first = s.commit_wait(vec![value(M, long)]).unwrap()[0];
    let edited = s.commit_wait(vec![edit(M, 0, 1, "A")]).unwrap()[0];
    assert_eq!(kind_at(&s, edited), "draftEdit");
    assert_eq!(read(&s, M).unwrap(), format!("A{}", &long[1..]));
    assert!(live(&s, first) && live(&s, edited));
    assert_eq!(version(&s, 10), card_version, "a draft is no change to the card");
    assert_eq!(s.derived(|v| super::chat_read::messages(v, &[1])).unwrap(), message, "nor to the message");
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn edits_that_outweigh_the_text_are_written_whole_and_an_emptied_draft_is_gone() {
    let dir = temp_dir("whole");
    let s = open(&dir);
    s.commit_wait(vec![card(10)]).unwrap();
    let first = s.commit_wait(vec![edit(ROOT, 0, 0, "hi")]).unwrap()[0];
    assert_eq!(kind_at(&s, first), "draftValue", "an edit of no draft");
    let second = s.commit_wait(vec![edit(ROOT, 2, 0, "!")]).unwrap()[0];
    assert_eq!(kind_at(&s, second), "draftValue", "its edit outweighs the text");
    assert_eq!(read(&s, ROOT).as_deref(), Some("hi!"));
    assert!(!live(&s, first) && live(&s, second));
    let emptied = s.commit_wait(vec![edit(ROOT, 0, 3, "")]).unwrap()[0];
    assert_eq!(read(&s, ROOT), None);
    assert!(!live(&s, second) && !live(&s, emptied));
    let cleared = s.commit_wait(vec![value(ROOT, "x"), value(ROOT, "")]).unwrap();
    assert_eq!(read(&s, ROOT), None);
    assert!(cleared.iter().all(|&p| !live(&s, p)));
    assert!(matches!(
        s.commit_wait(vec![edit(ROOT, 5, 0, "x")]),
        Err(StoreError::Refused(_))
    ));
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_draft_needs_what_it_follows_and_goes_with_it() {
    let dir = temp_dir("goes");
    let s = open(&dir);
    for bad in [value(Owner::Message(7), "x"), value(Owner::Root(11), "x"), value(Owner::Greeting(11, 0), "x")] {
        assert!(matches!(s.commit_wait(vec![bad]), Err(StoreError::Refused(_))));
    }
    s.commit_wait(vec![card(10), card(11), append(0, None, 10), append(1, Some(0), 10)]).unwrap();
    let [a, _] = at(M);
    assert!(matches!(
        s.commit_wait(vec![rec(
            "draftValue",
            vec![a, Value::UInt(0), Value::Text(b"x".to_vec()), Value::Absent, Value::Absent]
        )]),
        Err(StoreError::Refused(_))
    ));
    let long = "a draft long enough to be edited";
    let kept = s
        .commit_wait(vec![
            value(M, long),
            edit(M, 0, 1, "A"),
            value(ROOT, "root"),
            value(GREETING, "greeting"),
            value(Owner::Root(11), "another card's"),
        ])
        .unwrap();
    s.commit_wait(vec![rec(
        "messageDelete",
        vec![Value::Id(1), Value::Absent, Value::Absent, Value::Time(9)],
    )])
    .unwrap();
    assert_eq!(read(&s, M), None);
    assert!(!live(&s, kept[0]) && !live(&s, kept[1]));
    s.commit_wait(vec![rec("messageDelete", vec![Value::Id(0), Value::Absent, Value::Absent, Value::Time(9)])])
        .unwrap();
    s.commit_wait(vec![rec("entityDelete", vec![Value::Id(10)])]).unwrap();
    assert_eq!(read(&s, ROOT), None);
    assert_eq!(read(&s, GREETING), None);
    assert!(!live(&s, kept[2]) && !live(&s, kept[3]));
    assert_eq!(read(&s, Owner::Root(11)).as_deref(), Some("another card's"));
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

fn now(s: &Store, o: Owner) -> (String, drafts::Version) {
    let (t, v) = s.derived(|v| drafts::draft_now(v, o)).unwrap();
    (String::from_utf8(t).unwrap(), v)
}

fn then(s: &Store, o: Owner, v: drafts::Version) -> Option<String> {
    s.derived(|view| drafts::draft_at(view, o, v))
        .unwrap()
        .map(|b| String::from_utf8(b).unwrap())
}

#[test]
fn every_write_is_a_new_version_and_an_earlier_one_reads_while_its_history_is_kept() {
    let dir = temp_dir("versions");
    let s = open(&dir);
    s.commit_wait(vec![card(10)]).unwrap();
    assert_eq!(now(&s, ROOT), (String::new(), drafts::Version::NONE));
    assert_eq!(then(&s, ROOT, drafts::Version::NONE).as_deref(), Some(""));

    let long = "a long draft that outweighs its small edits";
    s.commit_wait(vec![value(ROOT, long)]).unwrap();
    let (_, v0) = now(&s, ROOT);
    assert_ne!(v0, drafts::Version::NONE);
    s.commit_wait(vec![edit(ROOT, 0, 1, "A")]).unwrap();
    let (_, v1) = now(&s, ROOT);
    s.commit_wait(vec![edit(ROOT, 1, 1, " ")]).unwrap();
    let (text, v2) = now(&s, ROOT);
    assert_eq!(text, format!("A {}", &long[2..]));
    assert!(v0 != v1 && v1 != v2 && v0.written == v2.written && v1.edits < v2.edits);
    assert_eq!(then(&s, ROOT, v0).as_deref(), Some(long));
    assert_eq!(then(&s, ROOT, v1).as_deref(), Some(&*format!("A{}", &long[1..])));
    assert_eq!(then(&s, ROOT, v2).as_deref(), Some(&*text));
    assert_eq!(then(&s, ROOT, drafts::Version { written: v2.written, edits: 9 }), None, "a version it never had");

    s.commit_wait(vec![value(ROOT, "whole again")]).unwrap();
    let (_, v3) = now(&s, ROOT);
    assert_ne!(v3.written, v2.written, "a whole value is a new version");
    assert_eq!(then(&s, ROOT, v1), None, "its history is gone");
    s.commit_wait(vec![value(ROOT, "")]).unwrap();
    let (text, cleared) = now(&s, ROOT);
    assert_eq!(text, "", "a cleared draft has no text");
    assert!(cleared.written > v3.written && cleared.edits == 0, "a clear is a later version");
    assert_eq!(then(&s, ROOT, v3), None);
    assert_eq!(then(&s, ROOT, cleared).as_deref(), Some(""));
    s.commit_wait(vec![value(ROOT, "whole again")]).unwrap();
    assert!(now(&s, ROOT).1.written > cleared.written, "the same text written again is a later version");
    s.commit_wait(vec![rec("entityDelete", vec![Value::Id(10)])]).unwrap();
    assert_eq!(now(&s, ROOT), (String::new(), drafts::Version::NONE), "the version goes with what it follows");
    s.commit_wait(vec![card(11), value(Owner::Root(11), "x"), value(Owner::Root(11), "")]).unwrap();
    s.commit_wait(vec![rec("entityDelete", vec![Value::Id(11)])]).unwrap();
    assert_eq!(now(&s, Owner::Root(11)).1, drafts::Version::NONE, "a cleared draft's version goes with it too");
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}
