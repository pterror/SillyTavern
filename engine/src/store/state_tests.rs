use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;

use super::chat_read::Js;
use super::state::{self, Entry, Hang, VARIABLE};
use super::*;
use crate::log::format::{Value, kind_by_name};

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-state-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    dir
}

const NOW: i64 = 1_700_000_000_000;

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

fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
}

fn append(id: u64, parent: Option<u64>, tree: u64, time: i64) -> Record {
    rec(
        "messageAppend",
        vec![
            Value::Id(id),
            parent.map_or(Value::Absent, Value::Id),
            Value::Id(tree),
            Value::Absent,
            Value::Absent,
            Value::Time(time),
            Value::Text(b"m".to_vec()),
            Value::UInt(0),
            Value::Absent,
            Value::Id(1),
            Value::Absent,
        ],
    )
}

/// A store with user 1, whom every append names.
fn open(dir: &std::path::Path) -> Store {
    let s = Store::open_in(dir, SMALL, small_pool()).unwrap();
    if s.derived(|v| super::chat::id_by_key(v, super::chat::KEYED_USER, b"user-1"))
        .unwrap()
        .is_none()
    {
        s.commit_wait(vec![rec(
            "keyMap",
            vec![
                Value::Sel(super::chat::KEYED_USER, 1),
                Value::Bytes(b"user-1".to_vec()),
            ],
        )])
        .unwrap();
    }
    s
}

fn hang_value(h: Hang) -> Value {
    match h {
        Hang::Tree(t) => Value::Sel(0, t),
        Hang::Message(m) => Value::Sel(1, m),
    }
}

#[derive(Clone, Debug)]
enum Change {
    Set {
        at: Hang,
        variable: bool,
        key: String,
        value: Option<String>,
    },
    Revert(u64),
}

#[derive(Default)]
struct Model {
    parents: BTreeMap<u64, (u64, Option<u64>)>,
    changes: BTreeMap<u64, Change>,
}

impl Model {
    fn active(&self, c: u64) -> bool {
        !self
            .changes
            .iter()
            .any(|(r, ch)| matches!(ch, Change::Revert(t) if *t == c) && self.active(*r))
    }

    /// The state at `at`, as a JavaScript object would hold it after each change in turn.
    fn state(&self, tree: u64, at: Option<u64>) -> Vec<Entry> {
        let mut path = Vec::new();
        let mut cur = at;
        while let Some(m) = cur {
            path.push(Hang::Message(m));
            cur = self.parents[&m].1;
        }
        path.push(Hang::Tree(tree));
        path.reverse();
        let mut obj: Vec<Entry> = Vec::new();
        for h in path {
            for (c, ch) in &self.changes {
                let Change::Set {
                    at,
                    variable,
                    key,
                    value,
                } = ch
                else {
                    continue;
                };
                if *at != h || !self.active(*c) {
                    continue;
                }
                let k = FieldRef::Key(key.clone().into_bytes());
                let i = obj
                    .iter()
                    .position(|e| e.variable == *variable && e.key == k);
                match (value, i) {
                    (Some(v), Some(i)) => obj[i].json = v.clone().into_bytes(),
                    (Some(v), None) => obj.push(Entry {
                        variable: *variable,
                        key: k,
                        json: v.clone().into_bytes(),
                    }),
                    (None, Some(i)) => {
                        obj.remove(i);
                    }
                    (None, None) => {}
                }
            }
        }
        obj
    }

    fn check(&self, s: &Store) {
        s.derived(|v| {
            for (m, (tree, _)) in &self.parents {
                assert_eq!(
                    state::state_at(v, *tree, Some(*m))?,
                    self.state(*tree, Some(*m)),
                    "state at {m}"
                );
                assert_eq!(
                    super::chat::shapes(v, &[*m])?[0],
                    super::chat::shape_scanned(v, *m)?,
                    "shape of {m}"
                );
            }
            for tree in 1..=2 {
                assert_eq!(
                    state::state_at(v, tree, None)?,
                    self.state(tree, None),
                    "state at root of {tree}"
                );
            }
            Ok(())
        })
        .unwrap();
    }
}

struct Rng(u64);

impl Rng {
    fn below(&mut self, n: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % n.max(1)
    }
}

fn workload(s: &Store, model: &mut Model, rng: &mut Rng, from: u64, n: u64) {
    for i in from..from + n {
        let ids: Vec<u64> = model.parents.keys().copied().collect();
        let next_change = model.changes.keys().last().map_or(0, |c| c + 1);
        let r = rng.below(10);
        let recs = if ids.is_empty() || r < 3 {
            let id = model.parents.keys().last().map_or(0, |m| m + 1);
            let (tree, parent) = if ids.is_empty() || rng.below(5) == 0 {
                (1 + rng.below(2), None)
            } else {
                let p = ids[rng.below(ids.len() as u64) as usize];
                (model.parents[&p].0, Some(p))
            };
            model.parents.insert(id, (tree, parent));
            vec![append(id, parent, tree, i as i64)]
        } else if r < 8 {
            let at = if rng.below(6) == 0 {
                Hang::Tree(1 + rng.below(2))
            } else {
                Hang::Message(ids[rng.below(ids.len() as u64) as usize])
            };
            let variable = rng.below(2) == 0;
            let key = format!("k{}", rng.below(4));
            let value = (rng.below(4) > 0).then(|| format!("{i}"));
            model.changes.insert(
                next_change,
                Change::Set {
                    at,
                    variable,
                    key: key.clone(),
                    value: value.clone(),
                },
            );
            vec![rec(
                "stateChange",
                vec![
                    Value::Id(next_change),
                    hang_value(at),
                    Value::Time(i as i64),
                    Value::UInt(state::AUTHOR_SCRIPT | if variable { VARIABLE } else { 0 }),
                    Value::Absent,
                    Value::Absent,
                    Value::Field(FieldRef::Key(key.into_bytes())),
                    value.map_or(Value::Absent, |v| Value::Text(v.into_bytes())),
                    Value::Absent,
                    Value::Absent,
                ],
            )]
        } else if !model.changes.is_empty() {
            let cs: Vec<u64> = model.changes.keys().copied().collect();
            let t = cs[rng.below(cs.len() as u64) as usize];
            model.changes.insert(next_change, Change::Revert(t));
            vec![rec(
                "stateRevert",
                vec![
                    Value::Id(next_change),
                    Value::Id(t),
                    Value::Time(i as i64),
                    Value::UInt(state::AUTHOR_USER),
                    Value::Absent,
                    Value::Absent,
                    Value::Absent,
                ],
            )]
        } else {
            Vec::new()
        };
        if !recs.is_empty() {
            s.commit_wait(recs).unwrap();
        }
    }
}

#[test]
fn the_state_at_every_message_is_the_fold_of_its_path() {
    let dir = temp_dir("fold");
    let mut model = Model::default();
    let mut rng = Rng(0x2545_f491_4f6c_dd1d);
    let s = open(&dir);
    workload(&s, &mut model, &mut rng, 0, 600);
    model.check(&s);
    s.abandon();
    std::mem::forget(s);
    let s = open(&dir);
    model.check(&s);
    workload(&s, &mut model, &mut rng, 600, 600);
    // Values written over and over among the changes, so cleaning copies live changes and reverts.
    for i in 0..3000u64 {
        s.commit_wait(vec![rec(
            "jsonValue",
            vec![
                Value::Sel(1, 0),
                Value::Field(FieldRef::Key(b"k".to_vec())),
                Value::Text(format!("{i}").into_bytes()),
                Value::Absent,
                Value::Absent,
            ],
        )])
        .unwrap();
        if i % 30 == 0 {
            workload(&s, &mut model, &mut rng, 2000 + i, 1);
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
    let s = open(&dir);
    model.check(&s);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_change_moves_with_its_message_and_goes_with_it() {
    let dir = temp_dir("moves");
    let s = open(&dir);
    let set = |c: u64, at: Hang, key: &str, v: &str| {
        rec(
            "stateChange",
            vec![
                Value::Id(c),
                hang_value(at),
                Value::Time(c as i64),
                Value::UInt(state::AUTHOR_USER),
                Value::Absent,
                Value::Absent,
                Value::Field(FieldRef::Key(key.as_bytes().to_vec())),
                Value::Text(v.as_bytes().to_vec()),
                Value::Absent,
                Value::Absent,
            ],
        )
    };
    s.commit_wait(vec![
        append(0, None, 1, 0),
        append(1, Some(0), 1, 1),
        append(2, Some(0), 1, 2),
        set(0, Hang::Tree(1), "world", "1"),
        set(1, Hang::Message(1), "note", "\"a\""),
    ])
    .unwrap();
    let at = |s: &Store, m: Option<u64>| {
        s.derived(|v| state::state_at(v, 1, m))
            .unwrap()
            .into_iter()
            .map(|e| {
                (
                    String::from_utf8(match e.key {
                        FieldRef::Key(k) => k,
                        FieldRef::Code(c) => c.to_string().into_bytes(),
                    })
                    .unwrap(),
                    String::from_utf8(e.json).unwrap(),
                )
            })
            .collect::<Vec<_>>()
    };
    let kv = |p: &[(&str, &str)]| {
        p.iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect::<Vec<_>>()
    };
    assert_eq!(at(&s, Some(1)), kv(&[("world", "1"), ("note", "\"a\"")]));
    // A sibling branch doesn't see it; the tree's root change is seen everywhere.
    assert_eq!(at(&s, Some(2)), kv(&[("world", "1")]));
    // Moved under message 2, message 1 takes its change along.
    s.commit_wait(vec![rec(
        "messageParent",
        vec![Value::Id(1), Value::Id(2), Value::Absent, Value::Absent],
    )])
    .unwrap();
    assert_eq!(at(&s, Some(1)), kv(&[("world", "1"), ("note", "\"a\"")]));
    // Reverted, then the revert reverted: gone, then back.
    s.commit_wait(vec![rec(
        "stateRevert",
        vec![
            Value::Id(2),
            Value::Id(1),
            Value::Time(0),
            Value::UInt(0),
            Value::Absent,
            Value::Absent,
            Value::Absent,
        ],
    )])
    .unwrap();
    assert_eq!(at(&s, Some(1)), kv(&[("world", "1")]));
    s.commit_wait(vec![rec(
        "stateRevert",
        vec![
            Value::Id(3),
            Value::Id(2),
            Value::Time(0),
            Value::UInt(0),
            Value::Absent,
            Value::Absent,
            Value::Absent,
        ],
    )])
    .unwrap();
    assert_eq!(at(&s, Some(1)), kv(&[("world", "1"), ("note", "\"a\"")]));
    // The message goes, and its changes with it.
    s.commit_wait(vec![rec(
        "messageDelete",
        vec![Value::Id(1), Value::Absent, Value::Absent, Value::Time(NOW)],
    )])
    .unwrap();
    assert_eq!(
        s.derived(|v| state::changes_at(v, Hang::Message(1)))
            .unwrap(),
        vec![]
    );
    // Refused: a change of a missing message, a taken id, a revert of nothing, an author that isn't one.
    for bad in [
        set(9, Hang::Message(77), "k", "1"),
        set(0, Hang::Tree(1), "k", "1"),
        rec(
            "stateRevert",
            vec![
                Value::Id(9),
                Value::Id(50),
                Value::Time(0),
                Value::UInt(0),
                Value::Absent,
                Value::Absent,
                Value::Absent,
            ],
        ),
        rec(
            "stateRevert",
            vec![
                Value::Id(9),
                Value::Id(0),
                Value::Time(0),
                Value::UInt(7),
                Value::Absent,
                Value::Absent,
                Value::Absent,
            ],
        ),
    ] {
        assert!(matches!(
            s.commit_wait(vec![bad]),
            Err(StoreError::Refused(_))
        ));
    }
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_replys_produced_changes_read_back_reverted_or_not() {
    let dir = temp_dir("produced");
    let s = open(&dir);
    let change = |c: u64, at: Hang, author: u64, key: &str, v: Option<&str>| {
        rec(
            "stateChange",
            vec![
                Value::Id(c),
                hang_value(at),
                Value::Time(c as i64),
                Value::UInt(author),
                Value::Absent,
                Value::Absent,
                Value::Field(FieldRef::Key(key.as_bytes().to_vec())),
                v.map_or(Value::Absent, |v| Value::Text(v.as_bytes().to_vec())),
                Value::Absent,
                Value::Absent,
            ],
        )
    };
    let produced = state::PRODUCED | state::AUTHOR_SCRIPT;
    s.commit_wait(vec![
        append(0, None, 1, 0),
        append(1, Some(0), 1, 1),
        change(0, Hang::Message(1), produced | VARIABLE, "hp", Some("3")),
        change(1, Hang::Message(1), produced, "scene", None),
        // A later change on the reply isn't one made while producing it.
        change(2, Hang::Message(1), state::AUTHOR_USER, "note", Some("1")),
    ])
    .unwrap();
    s.commit_wait(vec![rec(
        "stateRevert",
        vec![
            Value::Id(3),
            Value::Id(0),
            Value::Time(0),
            Value::UInt(0),
            Value::Absent,
            Value::Absent,
            Value::Absent,
        ],
    )])
    .unwrap();
    let read = s
        .derived(|v| super::chat_read::produced(v, &[0, 1]))
        .unwrap();
    let c = |key: &str, variable: bool, value: Option<&str>| {
        Js::Obj(vec![
            ("key", Js::Text(key.as_bytes().to_vec())),
            ("variable", Js::Bool(variable)),
            (
                "value",
                value.map_or(Js::Null, |v| Js::Text(v.as_bytes().to_vec())),
            ),
        ])
    };
    assert_eq!(
        read,
        Js::Arr(vec![
            Js::Arr(vec![]),
            Js::Arr(vec![c("hp", true, Some("3")), c("scene", false, None)]),
        ])
    );
    // Refused: a reply's change on a tree's root; a revert marked as one.
    for r in [
        change(4, Hang::Tree(1), produced, "x", Some("1")),
        rec(
            "stateRevert",
            vec![
                Value::Id(4),
                Value::Id(2),
                Value::Time(0),
                Value::UInt(state::PRODUCED),
                Value::Absent,
                Value::Absent,
                Value::Absent,
            ],
        ),
    ] {
        assert!(matches!(
            s.commit_wait(vec![r]),
            Err(StoreError::Refused(_))
        ));
    }
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_root_clear_removes_the_roots_changes_and_their_reverts_in_slices_and_resumes_after_a_crash() {
    let dir = temp_dir("root-clear");
    let s = open(&dir);
    let set = |c: u64, at: Hang, k: &str| {
        rec(
            "stateChange",
            vec![
                Value::Id(c),
                hang_value(at),
                Value::Time(0),
                Value::UInt(state::AUTHOR_USER),
                Value::Absent,
                Value::Absent,
                Value::Field(FieldRef::Key(k.as_bytes().to_vec())),
                Value::Text(b"1".to_vec()),
                Value::Absent,
                Value::Absent,
            ],
        )
    };
    let revert = |c: u64, of: u64| {
        rec(
            "stateRevert",
            vec![
                Value::Id(c),
                Value::Id(of),
                Value::Time(0),
                Value::UInt(0),
                Value::Absent,
                Value::Absent,
                Value::Absent,
            ],
        )
    };
    // More changes at tree 1's root than a slice takes, a revert of one and a revert of that revert; one at tree
    // 2's root and one on a message of tree 1, which stay.
    let n = (state::CLEAR_SLICE * 2 + 3) as u64;
    let mut recs = vec![append(0, None, 1, 0)];
    for c in 0..n {
        recs.push(set(c, Hang::Tree(1), &format!("k{c}")));
    }
    recs.push(revert(n, 0));
    recs.push(revert(n + 1, n));
    recs.push(set(n + 2, Hang::Tree(2), "other"));
    recs.push(set(n + 3, Hang::Message(0), "on message"));
    s.commit_wait(recs).unwrap();
    // The clear commits without its slices, as after a crash.
    let (tx, rx) = std::sync::mpsc::channel();
    s.inner.submit(Job::Commit(
        vec![rec("rootStateClear", vec![Value::Id(1)])],
        Box::new(move |r| {
            let _ = tx.send(r.map(|_| ()));
        }),
    ));
    rx.recv().unwrap().unwrap();
    // A change made after it stays; the cleared ones read as gone at once, and can't be reverted.
    s.commit_wait(vec![set(n + 4, Hang::Tree(1), "after")])
        .unwrap();
    let keys = |s: &Store, tree: u64, at: Option<u64>| {
        s.derived(|v| state::state_at(v, tree, at))
            .unwrap()
            .into_iter()
            .map(|e| match e.key {
                FieldRef::Key(k) => String::from_utf8(k).unwrap(),
                FieldRef::Code(c) => c.to_string(),
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(keys(&s, 1, Some(0)), vec!["after", "on message"]);
    assert_eq!(
        s.derived(|v| state::changes_at(v, Hang::Tree(1))).unwrap(),
        vec![(n + 4, true)]
    );
    assert!(matches!(
        s.commit_wait(vec![revert(n + 5, 1)]),
        Err(StoreError::Refused(_))
    ));
    // A crash: the clear resumes on open and finishes, leaving no entry of the cleared changes or their reverts.
    s.abandon();
    std::mem::forget(s);
    let s = open(&dir);
    for _ in 0..1000 {
        if !s.derived(state::any_clear_pending).unwrap() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    s.derived(|v| {
        assert!(!state::any_clear_pending(v)?);
        for c in 0..n + 2 {
            assert_eq!(state::change_loc(v, c)?, None, "{c}");
            let p = key::id(state::REVERTED_BY, c);
            assert!(v.scan(&p, &key::prefix_end(&p), 1)?.is_empty(), "{c}");
        }
        let p = key::of(state::ROOT_CLEAR);
        assert!(v.scan(&p, &key::prefix_end(&p), 1)?.is_empty());
        Ok(())
    })
    .unwrap();
    assert_eq!(keys(&s, 1, Some(0)), vec!["after", "on message"]);
    assert_eq!(keys(&s, 2, None), vec!["other"]);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}
