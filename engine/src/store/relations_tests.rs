use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use super::books::{BOOK, ENTRY, EntryKey};
use super::counted::{self, TREE_COUNT, TREE_EDGE, TREE_KINDS};
use super::relations::{self, GROUP_COUNT, MEMBERS, REL_OF};
use super::*;
use crate::log::format::{FieldRef, Record, Value, kind_by_name};

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-relations-{}-{name}-{}",
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

pub(super) fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
}

pub(super) fn text(s: &str) -> Value {
    Value::Text(s.as_bytes().to_vec())
}

pub(super) fn create(e: u64, kind: u64, key: &str) -> Record {
    rec(
        "entityCreate",
        vec![Value::Id(e), Value::UInt(kind), text(key), Value::F64(0.0)],
    )
}

pub(super) fn set_json(e: u64, f: FieldRef, j: &str) -> Record {
    rec(
        "jsonValue",
        vec![
            Value::Sel(0, e),
            Value::Field(f),
            text(j),
            Value::Absent,
            Value::Absent,
        ],
    )
}

fn set_text(e: u64, f: FieldRef, t: &str) -> Record {
    rec(
        "textValue",
        vec![
            Value::Sel(0, e),
            Value::Field(f),
            text(t),
            Value::Absent,
            Value::Absent,
        ],
    )
}

fn drop_value(e: u64, f: FieldRef) -> Record {
    rec(
        "valueDelete",
        vec![
            Value::Sel(0, e),
            Value::Field(f),
            Value::Absent,
            Value::Absent,
        ],
    )
}

pub(super) fn index(e: u64, book: u64, x: Option<f64>) -> Record {
    rec(
        "entryIndex",
        vec![
            Value::Id(e),
            Value::Id(book),
            x.map_or(Value::Absent, Value::F64),
        ],
    )
}

pub(super) fn json_of(rels: &[(&str, u64, &str)]) -> String {
    let items: Vec<String> = rels
        .iter()
        .map(|(r, t, p)| format!(r#"{{"relation":"{r}","target":{t},"position":"{p}"}}"#))
        .collect();
    format!("[{}]", items.join(","))
}

pub(super) fn book(s: &Store, id: u64, key: &str) {
    s.commit_wait(vec![
        create(id, BOOK, key),
        set_json(id, FieldRef::Code(books::DEFINED), ""),
    ])
    .unwrap();
}

fn read<T>(s: &Store, f: impl FnOnce(&derive::View) -> StoreResult<T>) -> T {
    s.chat_read(f).unwrap()
}

const B: u64 = 1;

type Members = Vec<(Vec<u8>, u64)>;

#[derive(Clone, Default)]
struct Ent {
    uid: u64,
    index: Option<f64>,
    rels: Option<String>,
}

#[derive(Default)]
struct Model {
    entries: BTreeMap<u64, Ent>,
}

impl Model {
    fn set(&self, e: u64) -> relations::Set {
        self.entries[&e]
            .rels
            .as_deref()
            .map(|j| relations::parse(j.as_bytes()))
            .unwrap_or_default()
    }

    fn top(&self, kind: Option<&str>) -> Vec<u64> {
        let mut v: Vec<(u64, u64)> = self
            .entries
            .iter()
            .filter(|(e, _)| {
                kind.is_none_or(|k| !self.set(**e).keys().any(|(r, _)| r == k.as_bytes()))
            })
            .map(|(e, x)| (relations::order_value(x.index, &EntryKey::Int(x.uid)), *e))
            .collect();
        v.sort();
        v.into_iter().map(|(_, e)| e).collect()
    }

    fn groups(&self) -> BTreeMap<(Vec<u8>, Vec<u8>), Members> {
        let mut g: BTreeMap<_, Vec<_>> = BTreeMap::new();
        for e in self.entries.keys() {
            for ((r, t), p) in self.set(*e) {
                g.entry((r, t)).or_default().push((p, *e));
            }
        }
        for v in g.values_mut() {
            v.sort();
        }
        g
    }

    fn check(&self, s: &Store) {
        let sp = relations::space(B);
        for kind in [None, Some("in"), Some("owes"), Some("never")] {
            let want = self.top(kind);
            let k = kind.map(str::as_bytes);
            read(s, |v| {
                assert_eq!(counted::size(v, &sp, k)?, want.len() as u64, "{kind:?}");
                let all: Vec<u64> = counted::take(v, &sp, k, 0, usize::MAX)?
                    .iter()
                    .map(counted::entity_of)
                    .collect();
                assert_eq!(all, want, "{kind:?}");
                for skip in [1, 3, 7] {
                    let got: Vec<u64> = counted::take(v, &sp, k, skip, 3)?
                        .iter()
                        .map(counted::entity_of)
                        .collect();
                    let from = (skip as usize).min(want.len());
                    assert_eq!(
                        got,
                        want[from..(from + 3).min(want.len())],
                        "{kind:?} at {skip}"
                    );
                }
                for (i, e) in want.iter().enumerate() {
                    let x = relations::elem_of(v, *e, &EntryKey::Int(self.entries[e].uid))?;
                    assert_eq!(
                        counted::rank(v, &sp, &x, k)?,
                        i as u64,
                        "{kind:?} rank of {e}"
                    );
                }
                Ok(())
            });
        }
        let groups = self.groups();
        read(s, |v| {
            for ((r, t), members) in &groups {
                assert_eq!(relations::group_count(v, B, r, t)?, members.len() as u64);
                let prefix = relations::members_prefix(B, r, t);
                let got: Vec<u64> = v
                    .scan(&prefix, &kinds::key::prefix_end(&prefix), usize::MAX)?
                    .iter()
                    .map(|(k, _)| relations::member_of(&prefix, k))
                    .collect::<Result<_, _>>()?;
                let want: Vec<u64> = members.iter().map(|(_, e)| *e).collect();
                assert_eq!(got, want);
            }
            for e in self.entries.keys() {
                assert_eq!(relations::rels_of(v, *e)?, self.set(*e), "entry {e}");
            }
            Ok(())
        });
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
        self.next() % n
    }
}

fn random_rels(rng: &mut Rng) -> String {
    let n = rng.below(4);
    let mut rels = Vec::new();
    for _ in 0..n {
        let r = ["in", "owes", "in"][rng.below(3) as usize];
        let t = rng.below(12);
        let p = ["a", "b", "m", "mm", "z", ""][rng.below(6) as usize];
        rels.push((r, t, p));
    }
    json_of(&rels)
}

fn random_index(rng: &mut Rng) -> Option<f64> {
    [
        None,
        Some(0.0),
        Some(1.0),
        Some(2.5),
        Some(-1.0),
        Some(1e12),
        Some(-0.0),
    ][rng.below(7) as usize]
}

fn dump(s: &Store) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut out = Vec::new();
    for st in [
        TREE_EDGE,
        TREE_COUNT.id(),
        TREE_KINDS.id(),
        REL_OF,
        MEMBERS,
        GROUP_COUNT,
    ] {
        let p = kinds::key::of(st);
        out.extend(read(s, |v| {
            v.scan(&p, &kinds::key::prefix_end(&p), usize::MAX)
        }));
    }
    out
}

fn step(s: &Store, m: &mut Model, rng: &mut Rng, next: &mut u64) {
    let ids: Vec<u64> = m.entries.keys().copied().collect();
    let pick = |rng: &mut Rng| ids[rng.below(ids.len() as u64) as usize];
    let rf = relations::field;
    match rng.below(10) {
        0..=2 => {
            let u = rng.below(20);
            if m.entries.values().any(|x| x.uid == u) {
                return;
            }
            let (e, uid) = (*next, u);
            *next += 1;
            let mut r = vec![create(e, ENTRY, &format!("{B}:{uid}"))];
            let mut ent = Ent {
                uid,
                ..Ent::default()
            };
            if rng.below(2) == 0 {
                let j = random_rels(rng);
                r.push(set_json(e, rf(), &j));
                ent.rels = Some(j);
            }
            if rng.below(2) == 0 {
                ent.index = random_index(rng);
                r.push(index(e, B, ent.index));
            }
            s.commit_wait(r).unwrap();
            m.entries.insert(e, ent);
        }
        3 | 4 if !ids.is_empty() => {
            let e = pick(rng);
            let j = random_rels(rng);
            s.commit_wait(vec![set_json(e, rf(), &j)]).unwrap();
            m.entries.get_mut(&e).unwrap().rels = Some(j);
        }
        5 if !ids.is_empty() => {
            let e = pick(rng);
            let x = random_index(rng);
            s.commit_wait(vec![index(e, B, x)]).unwrap();
            m.entries.get_mut(&e).unwrap().index = x;
        }
        6 if !ids.is_empty() => {
            let e = pick(rng);
            s.commit_wait(vec![rec("entityDelete", vec![Value::Id(e)])])
                .unwrap();
            m.entries.remove(&e);
        }
        7 if !ids.is_empty() => {
            let e = pick(rng);
            let (r, j) = match rng.below(3) {
                0 => (drop_value(e, rf()), None),
                1 => (
                    set_json(
                        e,
                        rf(),
                        r#"[{"relation":"in","target":1.5,"position":"a"}]"#,
                    ),
                    Some("[]".into()),
                ),
                _ => (set_text(e, rf(), "in: somewhere"), None),
            };
            if m.entries[&e].rels.is_none() && j.is_none() {
                return;
            }
            s.commit_wait(vec![r]).unwrap();
            m.entries.get_mut(&e).unwrap().rels = j;
        }
        8 if ids.len() >= 2 => {
            let (a, b) = (pick(rng), pick(rng));
            let ja = random_rels(rng);
            let xb = random_index(rng);
            s.commit_wait(vec![
                set_json(a, rf(), &ja),
                index(b, B, xb),
                set_json(b, rf(), &ja),
            ])
            .unwrap();
            m.entries.get_mut(&a).unwrap().rels = Some(ja.clone());
            m.entries.get_mut(&b).unwrap().index = xb;
            m.entries.get_mut(&b).unwrap().rels = Some(ja);
        }
        _ => {}
    }
}

fn fresh(m: &Model) -> Vec<(Vec<u8>, Vec<u8>)> {
    let dir = temp_dir("fresh");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    book(&s, B, "one");
    let mut r = Vec::new();
    for (e, x) in m.entries.iter().rev() {
        r.push(create(*e, ENTRY, &format!("{B}:{}", x.uid)));
        if let Some(j) = &x.rels {
            r.push(set_json(*e, relations::field(), j));
        }
        if x.index.is_some() {
            r.push(index(*e, B, x.index));
        }
    }
    s.commit_wait(r).unwrap();
    let d = dump(&s);
    s.close();
    let _ = fs::remove_dir_all(&dir);
    d
}

#[test]
fn every_write_keeps_the_top_the_groups_and_the_counts_and_the_tree_is_the_one_a_fresh_store_builds()
 {
    let seeds: u64 = std::env::var("ST_MODEL_SEEDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);
    let steps: usize = std::env::var("ST_MODEL_STEPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(300);
    for seed in 0..seeds {
        let dir = temp_dir("model");
        let mut m = Model::default();
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15 ^ (seed + 1).wrapping_mul(0x2545_f491_4f6c_dd1d));
        let mut next = 100;
        {
            let s = Store::open_in(&dir, SMALL, pool()).unwrap();
            book(&s, B, "one");
            for i in 0..steps {
                step(&s, &mut m, &mut rng, &mut next);
                if i % 10 == 0 {
                    m.check(&s);
                }
            }
            m.check(&s);
            assert_eq!(
                dump(&s),
                fresh(&m),
                "seed {seed}: the tree depends on its history"
            );
            s.close();
        }
        let s = Store::open_in(&dir, SMALL, pool()).unwrap();
        m.check(&s);
        for _ in 0..steps / 3 {
            step(&s, &mut m, &mut rng, &mut next);
        }
        m.check(&s);
        assert_eq!(dump(&s), fresh(&m), "seed {seed} after a reopen");
        s.close();
        let _ = fs::remove_dir_all(&dir);
    }
}

#[test]
fn a_value_that_isnt_a_list_of_relations_holds_none_and_a_repeated_pair_counts_once() {
    let none = |j: &str| assert!(relations::parse(j.as_bytes()).is_empty(), "{j}");
    none("{}");
    none("[1]");
    none(r#"[{"relation":"in","target":3}]"#);
    none(r#"[{"relation":"","target":3,"position":"a"}]"#);
    none(r#"[{"relation":"in","target":3,"position":"a"},{"relation":"in"}]"#);
    none(r#"[{"relation":"in","target":-3,"position":"a"}]"#);
    none(r#"[{"relation":"in","target":3e2,"position":"a"}]"#);
    none(r#"[{"relation":"\ud800","target":3,"position":"a"}]"#);
    none(r#"[{"relation":"in","target":3,"position":"a"}"#);
    let got = relations::parse(
        r#" [ {"relation":"in","target":3,"position":"b","note":{"x":[1,2]}},
              {"relation":"in","target":"3","position":"a"},
              {"relation":"works at","target":"Inn","position":"é😀"} ] "#
            .as_bytes(),
    );
    let want: relations::Set = [
        ((b"in".to_vec(), b"3".to_vec()), b"b".to_vec()),
        (
            (b"works at".to_vec(), b"Inn".to_vec()),
            "é😀".as_bytes().to_vec(),
        ),
    ]
    .into_iter()
    .collect();
    assert_eq!(got, want);
}

#[test]
fn history_writes_restores_and_a_target_written_before_it_exists_keep_the_groups() {
    let dir = temp_dir("history");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    let user = 1;
    s.commit_wait(vec![rec(
        "keyMap",
        vec![
            Value::Sel(chat::KEYED_USER, user),
            Value::Bytes(b"user-1".to_vec()),
        ],
    )])
    .unwrap();
    book(&s, B, "one");
    let meta = |c: u64| {
        vec![
            Value::Id(c),
            Value::Time(1_700_000_000_000 + c as i64),
            Value::Absent,
            Value::Id(user),
        ]
    };
    let hist_set = |c: u64, e: u64, j: &str| {
        let mut v = vec![
            Value::Id(e),
            Value::Field(relations::field()),
            text(j),
            Value::Bit(true),
        ];
        v.extend(meta(c));
        rec("histSet", v)
    };
    let hist_edit = |c: u64, e: u64, at: u64, removed: u64, t: &str| {
        let mut v = vec![
            Value::Id(e),
            Value::Field(relations::field()),
            Value::UInt(at),
            Value::UInt(removed),
            text(t),
            Value::Bit(true),
        ];
        v.extend(meta(c));
        rec("histEdit", v)
    };
    let a = json_of(&[("in", 2, "m")]);
    s.commit_wait(vec![
        hist_set(1, 10, &a),
        create(10, ENTRY, "1:1"),
        hist_set(2, 11, &json_of(&[("in", 1, "a")])),
        create(11, ENTRY, "1:2"),
        create(12, ENTRY, "1:3"),
    ])
    .unwrap();
    let sp = relations::space(B);
    let top = |s: &Store| -> Vec<u64> {
        read(s, |v| {
            Ok(counted::take(v, &sp, Some(b"in"), 0, usize::MAX)?
                .iter()
                .map(counted::entity_of)
                .collect())
        })
    };
    assert_eq!(top(&s), vec![12]);
    let at = a.find("\"m\"").unwrap() as u64 + 1;
    s.commit_wait(vec![hist_edit(3, 10, at, 1, "c")]).unwrap();
    assert_eq!(
        read(&s, |v| relations::rels_of(v, 10)),
        relations::parse(json_of(&[("in", 2, "c")]).as_bytes())
    );
    let mut del = vec![Value::Id(11)];
    del.extend(meta(4));
    s.commit_wait(vec![rec("histEntityDelete", del)]).unwrap();
    assert_eq!(top(&s), vec![12]);
    assert_eq!(read(&s, |v| relations::group_count(v, B, b"in", b"2")), 1);
    assert_eq!(read(&s, |v| relations::group_count(v, B, b"in", b"1")), 0);
    let mut restore = vec![
        Value::Id(11),
        Value::UInt(ENTRY),
        text("1:2"),
        Value::F64(0.0),
    ];
    restore.extend(meta(5));
    s.commit_wait(vec![rec("histRestore", restore)]).unwrap();
    assert_eq!(top(&s), vec![12]);
    assert_eq!(read(&s, |v| relations::group_count(v, B, b"in", b"1")), 1);
    s.commit_wait(vec![hist_set(6, 10, "[]"), hist_set(7, 11, "[]")])
        .unwrap();
    assert_eq!(top(&s), vec![10, 11, 12]);
    assert!(read(&s, |v| relations::rels_of(v, 10)).is_empty());
    s.close();
    let _ = fs::remove_dir_all(&dir);
}

fn derive_job<T: Send + 'static>(
    s: &Store,
    f: impl FnOnce(&derive::View, &mut derive::Out) -> StoreResult<T> + Send + 'static,
) -> T {
    let (tx, rx) = std::sync::mpsc::channel();
    let got = Arc::new(std::sync::Mutex::new(None));
    let put = got.clone();
    s.inner.submit(Job::Derive(
        Box::new(move |v, out| {
            *put.lock().unwrap() = Some(f(v, out)?);
            Ok(())
        }),
        Box::new(move |r| {
            let _ = tx.send(r);
        }),
    ));
    s.inner.ks.pool().exec.recv(&rx).unwrap().unwrap();
    got.lock().unwrap().take().unwrap()
}

#[test]
fn the_cutover_builds_for_a_store_written_before_the_tree_what_its_writes_would_have() {
    let dir = temp_dir("cutover");
    let s = Store::open_in(&dir, SMALL, pool()).unwrap();
    book(&s, B, "one");
    let mut m = Model::default();
    let mut rng = Rng(77);
    let mut next = 100;
    for _ in 0..120 {
        step(&s, &mut m, &mut rng, &mut next);
    }
    let want = dump(&s);
    assert!(!want.is_empty());
    derive_job(&s, |v, out| {
        for st in [
            TREE_EDGE,
            TREE_COUNT.id(),
            TREE_KINDS.id(),
            REL_OF,
            MEMBERS,
            GROUP_COUNT,
        ] {
            let p = kinds::key::of(st);
            for (k, _) in v.scan(&p, &kinds::key::prefix_end(&p), usize::MAX)? {
                out.del(k);
            }
        }
        Ok(())
    });
    assert!(dump(&s).is_empty());
    let mut after: Option<Vec<u8>> = None;
    let mut jobs = 0;
    loop {
        let from = after.clone();
        after = derive_job(&s, move |v, out| {
            relations::cutover_step(v, out, from.as_deref(), 3)
        });
        jobs += 1;
        if after.is_none() {
            break;
        }
    }
    assert!(jobs > 1);
    assert_eq!(dump(&s), want);
    derive_job(&s, |v, out| relations::cutover_step(v, out, None, 1000));
    assert_eq!(dump(&s), want);
    m.check(&s);
    s.close();
    let _ = fs::remove_dir_all(&dir);
}
