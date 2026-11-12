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
        Owner::Message(m) | Owner::Reply { message: true, after: m, .. } => [Value::Sel(1, m), Value::Absent],
        Owner::Root(t) | Owner::Reply { message: false, after: t, .. } => [Value::Sel(0, t), Value::Absent],
        Owner::Greeting(t, g) => [Value::Sel(0, t), Value::UInt(g)],
    }
}

const GENERATION: &str = "0190a1b2-0000-7000-8000-0000000000ab";

fn generation(o: Owner) -> Value {
    match o {
        Owner::Reply { .. } => Value::Bytes(GENERATION.as_bytes().to_vec()),
        _ => Value::Absent,
    }
}

fn value(o: Owner, text: &str) -> Record {
    let [a, g] = at(o);
    rec(
        "draftValue",
        vec![a, g, Value::Text(text.as_bytes().to_vec()), Value::Absent, Value::Absent, generation(o)],
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
            generation(o),
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
            vec![a, Value::UInt(0), Value::Text(b"x".to_vec()), Value::Absent, Value::Absent, Value::Absent]
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

#[test]
fn a_draft_after_a_reply_being_generated_is_its_own_and_goes_with_what_the_reply_follows() {
    let dir = temp_dir("reply");
    let s = open(&dir);
    s.commit_wait(vec![card(10), append(0, None, 10), append(1, Some(0), 10)]).unwrap();
    let id = drafts::generation_id(GENERATION.as_bytes()).unwrap();
    let after_message = Owner::Reply { message: true, after: 1, generation: id };
    let at_root = Owner::Reply { message: false, after: 10, generation: id };
    s.commit_wait(vec![value(after_message, "while it streams"), value(at_root, "at the root"), value(M, "after the message")])
        .unwrap();
    assert_eq!(read(&s, after_message).as_deref(), Some("while it streams"));
    assert_eq!(read(&s, M).as_deref(), Some("after the message"));
    s.commit_wait(vec![append(2, Some(1), 10), value(Owner::Message(2), "while it streams"), value(after_message, "")])
        .unwrap();
    assert_eq!(read(&s, Owner::Message(2)).as_deref(), Some("while it streams"));
    assert_eq!(read(&s, after_message), None);
    s.commit_wait(vec![value(after_message, "again")]).unwrap();
    for m in [2, 1] {
        s.commit_wait(vec![rec("messageDelete", vec![Value::Id(m), Value::Absent, Value::Absent, Value::Time(9)])])
            .unwrap();
    }
    assert_eq!(read(&s, after_message), None, "goes with the message the reply follows");
    s.commit_wait(vec![rec("entityDelete", vec![Value::Id(10)])]).unwrap();
    assert_eq!(read(&s, at_root), None, "goes with the tree the reply starts");
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}
