use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;

use super::chat::{self, FOLLOWING, MES, PINNED};
use super::kinds::{Holder, key, parse_loc, text_value_of};
use super::*;
use crate::log::format::{Value, kind_by_name, wtf8_from_utf16};
use crate::search::Scope;

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-chat-{}-{name}-{}",
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

fn small_pool() -> Arc<Pool> {
    Pool::new(16 << 10, 64 << 10, 4, 1, 2, 2)
}

fn text(s: &str) -> Vec<u8> {
    wtf8_from_utf16(&s.encode_utf16().collect::<Vec<_>>())
}

fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
}

fn opt(v: Option<u64>) -> Value {
    v.map_or(Value::Absent, Value::Id)
}

const MES_F: FieldRef = FieldRef::Code(MES);

#[derive(Clone, Debug)]
struct Msg {
    owner: u64,
    parent: Option<u64>,
    time: i64,
    text: Option<String>,
    values: BTreeMap<String, String>,
    times: BTreeMap<String, i64>,
    send_key: Option<Vec<u8>>,
}

#[derive(Clone, Debug)]
struct Bookmark {
    at: u64,
    mode: u64,
    name: Option<String>,
}

/// What the derived chat structures must show.
#[derive(Default, Clone)]
struct Model {
    msgs: BTreeMap<u64, Msg>,
    bookmarks: BTreeMap<u64, Bookmark>,
    keys: BTreeMap<(u8, Vec<u8>), u64>,
    next_msg: u64,
    next_pos: u64,
}

impl Model {
    fn children(&self, parent: Option<u64>, owner: u64) -> Vec<u64> {
        let mut c: Vec<(i64, u64)> = self
            .msgs
            .iter()
            .filter(|(_, m)| m.parent == parent && (parent.is_some() || m.owner == owner))
            .map(|(id, m)| (m.time, *id))
            .collect();
        c.sort();
        c.into_iter().map(|(_, id)| id).collect()
    }

    fn below(&self, a: u64, m: u64) -> bool {
        let mut cur = Some(a);
        while let Some(c) = cur {
            if c == m {
                return true;
            }
            cur = self.msgs[&c].parent;
        }
        false
    }

    fn check(&self, s: &Store) {
        s.derived(|v| {
            let scan_ids = |prefix: Vec<u8>| -> Vec<u64> {
                v.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)
                    .unwrap()
                    .into_iter()
                    .map(|(k, _)| chat::child_of_key(&k, prefix.len()).unwrap())
                    .collect()
            };
            for (id, m) in &self.msgs {
                let (_, r) = chat::require_message(v, *id).unwrap();
                assert_eq!(
                    chat::parent_of(v, *id, &r).unwrap(),
                    m.parent,
                    "parent of {id}"
                );
                assert_eq!(
                    scan_ids(chat::children_prefix(Some(*id), m.owner)),
                    self.children(Some(*id), m.owner),
                    "replies to {id}"
                );
                let t = text_value_of(v, Holder::Message(*id), &MES_F).unwrap();
                assert_eq!(t, m.text.as_deref().map(text), "text of {id}");
                for (k, json) in &m.values {
                    let f = FieldRef::Key(k.as_bytes().to_vec());
                    let b = v.get(&Holder::Message(*id).value_key(&f)).unwrap().unwrap();
                    let (vr, _) = v.record(parse_loc(&b).unwrap().pos).unwrap();
                    assert_eq!(vr.values[2], Value::Text(text(json)), "{k} of {id}");
                }
                let vp = key::id(key::MSG_VALUE, *id);
                assert_eq!(
                    v.scan(&vp, &key::prefix_end(&vp), usize::MAX)
                        .unwrap()
                        .len(),
                    m.values.len(),
                    "values of {id}"
                );
                for (k, d) in &m.times {
                    let f = FieldRef::Key(k.as_bytes().to_vec());
                    let b = v.get(&chat::msg_time_key(*id, &f)).unwrap().unwrap();
                    let (tr, _) = v.record(parse_loc(&b).unwrap().pos).unwrap();
                    assert_eq!(tr.values[2], Value::Int(*d), "{k} of {id}");
                }
                if let Some(sk) = &m.send_key {
                    let b = v.get(&chat::send_key_key(m.owner, sk)).unwrap().unwrap();
                    assert_eq!(kinds::parse_varints::<1>(&b).unwrap(), [*id]);
                }
            }
            let owners: BTreeSet<u64> = self.msgs.values().map(|m| m.owner).collect();
            for o in &owners {
                assert_eq!(
                    scan_ids(chat::children_prefix(None, *o)),
                    self.children(None, *o),
                    "roots of {o}"
                );
            }
            let all = key::of(key::MESSAGE);
            assert_eq!(
                v.scan(&all, &key::prefix_end(&all), usize::MAX)
                    .unwrap()
                    .len(),
                self.msgs.len()
            );
            for (b, bm) in &self.bookmarks {
                assert_eq!(
                    chat::bookmark_at(v, *b).unwrap(),
                    Some(bm.at),
                    "bookmark {b}"
                );
                assert_eq!(
                    chat::bookmark_mode(v, *b).unwrap(),
                    Some(bm.mode),
                    "mode of {b}"
                );
                let name = v.get(&key::id(key::POSITION_NAME, *b)).unwrap().map(|l| {
                    let (r, _) = v.record(parse_loc(&l).unwrap().pos).unwrap();
                    r.values[1].clone()
                });
                assert_eq!(
                    name,
                    bm.name.as_deref().map(|n| Value::Text(text(n))),
                    "name of {b}"
                );
                assert!(chat::bookmarks_at(v, bm.at).unwrap().contains(b));
                let owner = self.msgs[&bm.at].owner;
                assert!(
                    v.get(&key::ids(key::TREE_BOOKMARK, owner, *b))
                        .unwrap()
                        .is_some()
                );
            }
            let all = key::of(key::BOOKMARK_AT);
            assert_eq!(
                v.scan(&all, &key::prefix_end(&all), usize::MAX)
                    .unwrap()
                    .len(),
                self.bookmarks.len()
            );
            for ((space, k), i) in &self.keys {
                assert_eq!(chat::id_by_key(v, *space, k).unwrap(), Some(*i));
                assert_eq!(
                    chat::key_by_id(v, *space, *i).unwrap().as_deref(),
                    Some(k.as_slice())
                );
            }
            let all = key::of(key::KEY_OF);
            assert_eq!(
                v.scan(&all, &key::prefix_end(&all), usize::MAX)
                    .unwrap()
                    .len(),
                self.keys.len()
            );
            let next = v.get(&key::of(key::NEXT_MESSAGE)).unwrap();
            assert_eq!(
                next.map(|b| library::parse_uvarint(&b).unwrap()),
                (self.next_msg > 0).then_some(self.next_msg)
            );
            Ok(())
        })
        .unwrap();
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

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

fn append(
    model: &mut Model,
    owner: u64,
    parent: Option<u64>,
    time: i64,
    t: &str,
    sk: Option<Vec<u8>>,
) -> Record {
    let id = model.next_msg;
    model.next_msg += 1;
    // Following bookmarks at the parent move to the reply.
    if let Some(p) = parent {
        for b in model.bookmarks.values_mut() {
            if b.at == p && b.mode == FOLLOWING {
                b.at = id;
            }
        }
    }
    model.msgs.insert(
        id,
        Msg {
            owner,
            parent,
            time,
            text: Some(t.to_string()),
            values: BTreeMap::new(),
            times: BTreeMap::new(),
            send_key: sk.clone(),
        },
    );
    rec(
        "messageAppend",
        vec![
            Value::Id(id),
            opt(parent),
            Value::Id(owner),
            Value::Absent,
            Value::Absent,
            Value::Time(time),
            Value::Text(text(t)),
            Value::UInt(0),
            Value::Id(1),
            Value::Id(1),
            sk.map_or(Value::Absent, Value::Bytes),
        ],
    )
}

/// One step of a deterministic chat workload, as one commit (or none when nothing fits).
fn step(model: &mut Model, rng: &mut Rng, i: u64) -> Vec<Record> {
    let ids: Vec<u64> = model.msgs.keys().copied().collect();
    let pick = |rng: &mut Rng| ids[rng.below(ids.len() as u64) as usize];
    let time = 1_700_000_000_000 + (i as i64) * 1000 - (rng.below(3) as i64) * 500;
    let owner = 1 + rng.below(3);
    match rng.below(14) {
        _ if ids.is_empty() => vec![append(
            model,
            owner,
            None,
            time,
            &format!("opening {i}"),
            None,
        )],
        0 => vec![append(
            model,
            owner,
            None,
            time,
            &format!("opening {i}"),
            None,
        )],
        1..=4 => {
            let p = pick(rng);
            let o = model.msgs[&p].owner;
            let sk = i.is_multiple_of(3).then(|| i.to_le_bytes().to_vec());
            vec![append(
                model,
                o,
                Some(p),
                time,
                &format!("reply {i} to {p} ünï"),
                sk,
            )]
        }
        5 => {
            let m = pick(rng);
            let msg = model.msgs.get_mut(&m).unwrap();
            match &mut msg.text {
                Some(t) if !t.is_empty() => {
                    let at = t.find(' ').unwrap_or(0);
                    t.replace_range(at..at, " edited");
                    vec![rec(
                        "textEdit",
                        vec![
                            Value::Sel(1, m),
                            Value::Field(MES_F),
                            Value::UInt(at as u64),
                            Value::UInt(0),
                            Value::Text(text(" edited")),
                        ],
                    )]
                }
                _ => {
                    msg.text = Some(format!("rewritten {i}"));
                    vec![rec(
                        "textValue",
                        vec![
                            Value::Sel(1, m),
                            Value::Field(MES_F),
                            Value::Text(text(&format!("rewritten {i}"))),
                        ],
                    )]
                }
            }
        }
        6 => {
            let m = pick(rng);
            let k = format!("extra.k{}", i % 3);
            let json = format!("{{\"n\":{i}}}");
            let msg = model.msgs.get_mut(&m).unwrap();
            msg.times.remove(&k);
            msg.values.insert(k.clone(), json.clone());
            vec![rec(
                "jsonValue",
                vec![
                    Value::Sel(1, m),
                    Value::Field(FieldRef::Key(k.into_bytes())),
                    Value::Text(text(&json)),
                ],
            )]
        }
        7 => {
            let m = pick(rng);
            let k = format!("extra.k{}", i % 3);
            let msg = model.msgs.get_mut(&m).unwrap();
            msg.values.remove(&k);
            msg.times.insert(k.clone(), -(i as i64));
            vec![rec(
                "messageTime",
                vec![
                    Value::Id(m),
                    Value::Field(FieldRef::Key(k.into_bytes())),
                    Value::Int(-(i as i64)),
                ],
            )]
        }
        8 => {
            // A leaf with no bookmark goes.
            let leaves: Vec<u64> = ids
                .iter()
                .copied()
                .filter(|m| {
                    !model.msgs.values().any(|x| x.parent == Some(*m))
                        && !model.bookmarks.values().any(|b| b.at == *m)
                })
                .collect();
            if leaves.is_empty() {
                return Vec::new();
            }
            let m = leaves[rng.below(leaves.len() as u64) as usize];
            model.msgs.remove(&m);
            model
                .keys
                .retain(|(sp, _), v| !(*sp == chat::KEYED_MESSAGE && *v == m));
            vec![rec("messageDelete", vec![Value::Id(m)])]
        }
        9 => {
            // A message moves under another of its tree (not below itself), or to the tree's openings.
            let m = pick(rng);
            let o = model.msgs[&m].owner;
            let cands: Vec<u64> = ids
                .iter()
                .copied()
                .filter(|p| model.msgs[p].owner == o && !model.below(*p, m))
                .collect();
            let new = if cands.is_empty() || rng.below(4) == 0 {
                None
            } else {
                Some(cands[rng.below(cands.len() as u64) as usize])
            };
            model.msgs.get_mut(&m).unwrap().parent = new;
            vec![rec("messageParent", vec![Value::Id(m), opt(new)])]
        }
        10 => {
            let m = pick(rng);
            let b = model.next_pos;
            model.next_pos += 1;
            let mode = if i.is_multiple_of(2) {
                FOLLOWING
            } else {
                PINNED
            };
            model.bookmarks.insert(
                b,
                Bookmark {
                    at: m,
                    mode,
                    name: None,
                },
            );
            vec![rec(
                "positionCreate",
                vec![
                    Value::Id(b),
                    Value::UInt(mode),
                    Value::Id(0),
                    Value::Id(1),
                    Value::Id(m),
                ],
            )]
        }
        11 if !model.bookmarks.is_empty() => {
            let bs: Vec<u64> = model.bookmarks.keys().copied().collect();
            let b = bs[rng.below(bs.len() as u64) as usize];
            match rng.below(3) {
                0 => {
                    let name = (!i.is_multiple_of(4)).then(|| format!("bookmark {i}"));
                    model.bookmarks.get_mut(&b).unwrap().name = name.clone();
                    vec![rec(
                        "positionName",
                        vec![
                            Value::Id(b),
                            name.map_or(Value::Absent, |n| Value::Text(text(&n))),
                        ],
                    )]
                }
                1 => {
                    let bm = model.bookmarks.get_mut(&b).unwrap();
                    bm.mode = if bm.mode == FOLLOWING {
                        PINNED
                    } else {
                        FOLLOWING
                    };
                    vec![rec(
                        "positionMode",
                        vec![Value::Id(b), Value::UInt(bm.mode)],
                    )]
                }
                _ => {
                    model.bookmarks.remove(&b);
                    vec![rec("positionDelete", vec![Value::Id(b)])]
                }
            }
        }
        12 => {
            let m = pick(rng);
            if model.keys.values().any(|v| *v == m) {
                return Vec::new();
            }
            let k = format!("old-{m}").into_bytes();
            model.keys.insert((chat::KEYED_MESSAGE, k.clone()), m);
            vec![rec(
                "keyMap",
                vec![Value::Sel(chat::KEYED_MESSAGE, m), Value::Bytes(k)],
            )]
        }
        _ => {
            let m = pick(rng);
            let msg = model.msgs.get_mut(&m).unwrap();
            if msg.values.is_empty() {
                return Vec::new();
            }
            let k = msg.values.keys().next().unwrap().clone();
            msg.values.remove(&k);
            vec![rec(
                "valueDelete",
                vec![
                    Value::Sel(1, m),
                    Value::Field(FieldRef::Key(k.into_bytes())),
                ],
            )]
        }
    }
}

fn workload(s: &Store, model: &mut Model, rng: &mut Rng, from: u64, n: u64) {
    for i in from..from + n {
        let recs = step(model, rng, i);
        if !recs.is_empty() {
            s.commit_wait(recs).unwrap();
        }
    }
}

#[test]
fn chat_structures_follow_commits_reopens_crashes_and_cleaning() {
    let dir = temp_dir("follow");
    let mut model = Model::default();
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    workload(&s, &mut model, &mut rng, 0, 1500);
    model.check(&s);
    s.close();
    drop(s);
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    model.check(&s);
    // As a crash would leave it.
    workload(&s, &mut model, &mut rng, 1500, 400);
    s.abandon();
    std::mem::forget(s);
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    model.check(&s);
    workload(&s, &mut model, &mut rng, 1900, 1000);
    // Values written over and over leave the files they were first in mostly dead.
    let ids: Vec<u64> = model.msgs.keys().copied().take(5).collect();
    for i in 0..4000u64 {
        let m = ids[(i % 5) as usize];
        let json = format!("{{\"v\":\"{}\"}}", "x".repeat((i % 40) as usize));
        let msg = model.msgs.get_mut(&m).unwrap();
        msg.times.remove("extra.k0");
        msg.values.insert("extra.k0".into(), json.clone());
        s.commit_wait(vec![rec(
            "jsonValue",
            vec![
                Value::Sel(1, m),
                Value::Field(FieldRef::Key(b"extra.k0".to_vec())),
                Value::Text(text(&json)),
            ],
        )])
        .unwrap();
        // Live records among them, so cleaning copies messages, values and positions.
        if i % 40 == 0 {
            let recs = step(&mut model, &mut rng, 5000 + i);
            if !recs.is_empty() {
                s.commit_wait(recs).unwrap();
            }
        }
    }
    for _ in 0..20 {
        s.inner.ks.freeze_at(s.durable_end());
        s.inner.ks.wait_flushed().unwrap();
        s.wake_cleaner();
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let st = s.stats();
    assert!(st.cleaned_files > 0 && st.relocated_records > 0, "{st:?}");
    model.check(&s);
    s.close();
    drop(s);
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    model.check(&s);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn chat_writes_that_cant_apply_are_refused_and_write_nothing() {
    let dir = temp_dir("refuse");
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    let mut model = Model::default();
    let a = append(&mut model, 1, None, 10, "a", Some(vec![1; 16]));
    let b = append(&mut model, 1, Some(0), 11, "b", None);
    let c = append(&mut model, 2, None, 12, "c", None);
    s.commit_wait(vec![a, b, c]).unwrap();
    let end = s.durable_end();
    let next = |parent: Option<u64>, sk: Option<Vec<u8>>| {
        append(&mut model.clone(), 1, parent, 13, "x", sk)
    };
    let mut taken = next(None, None);
    taken.values[0] = Value::Id(0);
    for bad in [
        // The id is taken; the parent is in another tree; no such parent; the send key is stored.
        vec![taken],
        vec![next(Some(2), None)],
        vec![next(Some(77), None)],
        vec![next(Some(1), Some(vec![1; 16]))],
        // A message with replies doesn't go; a move below itself or into another tree is refused.
        vec![rec("messageDelete", vec![Value::Id(0)])],
        vec![rec("messageParent", vec![Value::Id(0), Value::Id(1)])],
        vec![rec("messageParent", vec![Value::Id(1), Value::Id(2)])],
        // Values of a message that doesn't exist; a bookmark at one; a mode that isn't one.
        vec![rec(
            "textValue",
            vec![
                Value::Sel(1, 50),
                Value::Field(MES_F),
                Value::Text(text("x")),
            ],
        )],
        vec![rec(
            "jsonValue",
            vec![
                Value::Sel(1, 50),
                Value::Field(MES_F),
                Value::Text(text("1")),
            ],
        )],
        vec![rec(
            "positionCreate",
            vec![
                Value::Id(9),
                Value::UInt(1),
                Value::Id(0),
                Value::Id(1),
                Value::Id(50),
            ],
        )],
        vec![rec(
            "positionCreate",
            vec![
                Value::Id(9),
                Value::UInt(3),
                Value::Id(0),
                Value::Id(1),
                Value::Id(1),
            ],
        )],
        vec![rec(
            "positionName",
            vec![Value::Id(9), Value::Text(text("n"))],
        )],
    ] {
        let r = s.commit_wait(bad);
        assert!(matches!(r, Err(StoreError::Refused(_))), "{r:?}");
    }
    assert_eq!(s.durable_end(), end);
    // A key names one id, and an id has one key.
    s.commit_wait(vec![rec(
        "keyMap",
        vec![Value::Sel(1, 5), Value::Bytes(b"uuid".to_vec())],
    )])
    .unwrap();
    for bad in [
        rec(
            "keyMap",
            vec![Value::Sel(1, 6), Value::Bytes(b"uuid".to_vec())],
        ),
        rec(
            "keyMap",
            vec![Value::Sel(1, 5), Value::Bytes(b"other".to_vec())],
        ),
        // A session isn't a bookmark.
        rec(
            "positionCreate",
            vec![
                Value::Id(5),
                Value::UInt(1),
                Value::Id(5),
                Value::Id(1),
                Value::Id(1),
            ],
        ),
    ] {
        assert!(matches!(
            s.commit_wait(vec![bad]),
            Err(StoreError::Refused(_))
        ));
    }
    // A bookmark at a message keeps it from going.
    s.commit_wait(vec![rec(
        "positionCreate",
        vec![
            Value::Id(9),
            Value::UInt(2),
            Value::Id(5),
            Value::Id(1),
            Value::Id(1),
        ],
    )])
    .unwrap();
    model
        .keys
        .insert((chat::KEYED_SESSION, b"uuid".to_vec()), 5);
    model.bookmarks.insert(
        9,
        Bookmark {
            at: 1,
            mode: PINNED,
            name: None,
        },
    );
    assert!(matches!(
        s.commit_wait(vec![rec("messageDelete", vec![Value::Id(1)])]),
        Err(StoreError::Refused(_))
    ));
    model.check(&s);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_message_text_lives_in_its_append_until_replaced_and_its_search_follows() {
    let dir = temp_dir("text");
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    let mut model = Model::default();
    s.commit_wait(vec![append(
        &mut model,
        4,
        None,
        1,
        "hello brave world",
        None,
    )])
    .unwrap();
    let edit = |off: u64, removed: u64, t: &str| {
        rec(
            "textEdit",
            vec![
                Value::Sel(1, 0),
                Value::Field(MES_F),
                Value::UInt(off),
                Value::UInt(removed),
                Value::Text(text(t)),
            ],
        )
    };
    s.commit_wait(vec![edit(6, 5, "bold")]).unwrap();
    let t = s
        .derived(|v| text_value_of(v, Holder::Message(0), &MES_F))
        .unwrap();
    assert_eq!(t, Some(text("hello bold world")));
    // The append still holds the message: replacing its text never marks the append dead.
    let dead_before = s.derived(|v| v.get(&key::id(key::DEAD, 0))).unwrap();
    s.commit_wait(vec![rec(
        "textValue",
        vec![
            Value::Sel(1, 0),
            Value::Field(MES_F),
            Value::Text(text("new")),
        ],
    )])
    .unwrap();
    let dead_after = s.derived(|v| v.get(&key::id(key::DEAD, 0))).unwrap();
    let n = |b: Option<Vec<u8>>| {
        b.and_then(|b| crate::keyspace::val::counter_value(&b))
            .unwrap_or(0)
    };
    assert!(n(dead_after) > n(dead_before), "the edit died");
    let append_live = s.derived(|v| chat::message_loc(v, 0)).unwrap().unwrap();
    assert_eq!(append_live.pos, 0);
    s.derived(|v| {
        let texts = kinds::search_texts(v, Scope::chat(4), 0, 0)?;
        assert_eq!(texts, vec![text("new")]);
        assert!(kinds::search_texts(v, Scope::chat(5), 0, 0)?.is_empty());
        Ok(())
    })
    .unwrap();
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn chat_records_round_trip_their_bytes() {
    // Every chat kind decodes as encoded, and a message's id after its parent's costs one byte.
    let k = kind_by_name("messageAppend").unwrap();
    let r = Record::new(
        k,
        vec![
            Value::Id(1_000_001),
            Value::Id(1_000_000),
            Value::Id(7),
            Value::Absent,
            Value::Absent,
            Value::Time(1_700_000_000_123),
            Value::Text(text("hi")),
            Value::UInt(1),
            Value::Id(3),
            Value::Id(1),
            Value::Absent,
        ],
    )
    .unwrap();
    let mut ctx = crate::log::format::Ctx::default();
    let mut buf = Vec::new();
    crate::log::format::encode(&r, &mut ctx, &mut buf);
    let first = buf.len();
    let mut r2 = r.clone();
    r2.values[0] = Value::Id(1_000_002);
    r2.values[1] = Value::Id(1_000_001);
    r2.values[5] = Value::Time(1_700_000_001_000);
    crate::log::format::encode(&r2, &mut ctx, &mut buf);
    // header 1, id 1, parent 1, owner 1, time 2, text 3, flags 1, session 1, user 1.
    assert_eq!(buf.len() - first, 12);
    let mut ctx = crate::log::format::Ctx::default();
    let mut at = 0;
    for want in [&r, &r2] {
        let h = crate::log::format::get_uvarint(&buf, &mut at).unwrap();
        let (k, bits) = crate::log::format::kind_by_header(h).unwrap();
        assert_eq!(
            &crate::log::format::decode_body(k, bits, &buf, &mut at, &mut ctx).unwrap(),
            want
        );
    }
}
