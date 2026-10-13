//! Measures the tree edits (`store::prune`, `ChatEngine`'s deletes and cuts) as the records they commit: per
//! operation, the record bytes and the derived entries written, slices included, against what an append of the
//! same messages wrote.
//!
//!   cargo run --release --example edits -- <dir>
//!
//! Each case runs on its own tree: a chain of 600-byte messages through one session. `dir` is created and removed.

use std::path::Path;
use std::time::Duration;

use st_engine::log::format::{Record, Value, kind_by_name};
use st_engine::store::chat::{KEYED_SESSION, KEYED_USER, PINNED};
use st_engine::store::{Store, StoreConfig, prune, sessions};

const WORDS: [&str; 8] = [
    "the", "dragon", "quiet", "knight", "river", "smile", "ancient", "letter",
];

fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
}

fn text(n: usize, seed: u64) -> Value {
    let mut s = String::new();
    let mut i = seed;
    while s.len() < n {
        s.push_str(WORDS[(i % 8) as usize]);
        s.push(' ');
        i = i
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407)
            >> 7;
    }
    s.truncate(n);
    Value::Text(s.into_bytes())
}

fn append(id: u64, parent: Option<u64>, tree: u64, session: Option<u64>) -> Record {
    rec(
        "messageAppend",
        vec![
            Value::Id(id),
            parent.map_or(Value::Absent, Value::Id),
            Value::Id(tree),
            Value::Absent,
            Value::Absent,
            Value::Time(1_800_000_000_000 + id as i64),
            text(600, id),
            Value::UInt(0),
            session.map_or(Value::Absent, Value::Id),
            Value::Id(1),
            Value::Absent,
        ],
    )
}

/// Waits for the slices (subtree deletes, depth rewrites) to finish.
fn settle(s: &Store) {
    while s
        .chat_read(|v| Ok(prune::any_pending(v)? || sessions::any_pending(v)?))
        .unwrap()
    {
        std::thread::sleep(Duration::from_millis(1));
    }
}

/// Commits `recs`, waits for its slices: (record bytes, derived entries).
fn measure(s: &Store, recs: Vec<Record>) -> (f64, f64) {
    let (log0, ks0) = (s.stats().log_bytes, s.keyspace().stats().inserted);
    s.commit_wait(recs).unwrap();
    settle(s);
    (
        (s.stats().log_bytes - log0) as f64,
        (s.keyspace().stats().inserted - ks0) as f64,
    )
}

struct Ids {
    message: u64,
    tree: u64,
}

impl Ids {
    /// A chain of `n` messages in a new tree through session 1, the session at its end: its ids.
    fn chain(
        &mut self,
        s: &Store,
        n: u64,
        parent: Option<u64>,
        tree: Option<u64>,
    ) -> (Vec<u64>, (f64, f64)) {
        let tree = tree.unwrap_or_else(|| {
            self.tree += 1;
            self.tree
        });
        let mut ids = Vec::new();
        let mut recs = Vec::new();
        let mut p = parent;
        for _ in 0..n {
            let id = self.message;
            self.message += 1;
            recs.push(append(id, p, tree, Some(1)));
            ids.push(id);
            p = Some(id);
        }
        let m = measure(s, recs);
        (ids, m)
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = Path::new(&args[1]);
    let _ = std::fs::remove_dir_all(dir);
    let s = Store::open(dir, StoreConfig::default()).unwrap();
    s.wait_ready().unwrap();
    s.commit_wait(vec![
        rec(
            "keyMap",
            vec![Value::Sel(KEYED_USER, 1), Value::Bytes(b"user".to_vec())],
        ),
        rec(
            "keyMap",
            vec![Value::Sel(KEYED_SESSION, 1), Value::Bytes(b"s1".to_vec())],
        ),
        rec(
            "keyMap",
            vec![Value::Sel(KEYED_SESSION, 2), Value::Bytes(b"s2".to_vec())],
        ),
    ])
    .unwrap();
    let mut ids = Ids {
        message: 1,
        tree: 100,
    };
    let del = |m: u64| {
        rec(
            "subtreeDelete",
            vec![
                Value::Id(m),
                Value::Id(1),
                Value::Id(1),
                Value::Time(1_700_000_000_000),
            ],
        )
    };
    println!(
        "| operation | messages removed / copied / moved | record B | derived entries | entries per message | appending them wrote |"
    );
    println!("|---|---|---|---|---|---|");
    let row = |name: &str, what: &str, (rb, e): (f64, f64), per: u64, appended: f64| {
        println!(
            "| {name} | {what} | {rb:.0} | {e:.0} | {:.1} | {appended:.0} |",
            e / per.max(1) as f64
        );
    };
    for n in [1u64, 10, 100, 1000] {
        // Delete this path / this swipe and below / everything below: one `subtreeDelete` of a chain of n.
        let (base, _) = ids.chain(&s, 5, None, None);
        let tree = ids.tree;
        let (tail, appended) = ids.chain(&s, n, Some(base[4]), Some(tree));
        let m = measure(&s, vec![del(tail[0])]);
        row(
            "delete a path's own end (one root)",
            &format!("{n} / 0 / 0"),
            m,
            n,
            appended.1,
        );
    }
    {
        // Every swipe at a position and below: 3 alternatives, 10 below each.
        let (base, _) = ids.chain(&s, 5, None, None);
        let tree = ids.tree;
        let mut roots = Vec::new();
        let mut appended = 0.0;
        for _ in 0..3 {
            let (b, a) = ids.chain(&s, 11, Some(base[4]), Some(tree));
            roots.push(b[0]);
            appended += a.1;
        }
        let m = measure(&s, roots.iter().map(|r| del(*r)).collect());
        row(
            "delete every swipe here and below (3 roots)",
            "33 / 0 / 0",
            m,
            33,
            appended,
        );
    }
    {
        // A delete dropping a pinned bookmark and moving two sessions: what it adds to the root's record.
        let (base, _) = ids.chain(&s, 5, None, None);
        let tree = ids.tree;
        let (tail, appended) = ids.chain(&s, 10, Some(base[4]), Some(tree));
        s.commit_wait(vec![
            rec(
                "pointerMove",
                vec![Value::Id(2), Value::Id(1), Value::Id(tail[3])],
            ),
            rec(
                "positionCreate",
                vec![
                    Value::Id(900),
                    Value::UInt(PINNED),
                    Value::Id(1),
                    Value::Id(1),
                    Value::Id(tail[5]),
                ],
            ),
        ])
        .unwrap();
        let m = measure(&s, vec![del(tail[0])]);
        row(
            "the same with 2 sessions and a pinned bookmark inside",
            "10 / 0 / 0",
            m,
            10,
            appended.1,
        );
    }
    for (shared, own) in [(0u64, 10u64), (10, 10), (100, 0)] {
        // Cut 2 messages from a path: `shared` after them are another branch's too (copied), `own` this path's
        // (moved under the copies); the cut messages go when nothing else passes through them.
        let (base, _) = ids.chain(&s, 3, None, None);
        let tree = ids.tree;
        let (cut, _) = ids.chain(&s, 2, Some(base[2]), Some(tree));
        let (sh, _) = ids.chain(&s, shared, Some(cut[1]), Some(tree));
        let (mine, _) = ids.chain(&s, own, Some(*sh.last().unwrap_or(&cut[1])), Some(tree));
        let mut recs = Vec::new();
        let mut parent = base[2];
        let mut appended = 0.0;
        if shared > 0 {
            // Another branch under the last shared message.
            ids.chain(&s, 1, Some(*sh.last().unwrap()), Some(tree));
            for m in &sh {
                let id = ids.message;
                ids.message += 1;
                let mut r = append(id, Some(parent), tree, None);
                r.values[5] = Value::Time(1_800_000_000_000 + *m as i64);
                recs.push(r);
                parent = id;
            }
            let (_, a) = ids.chain(&s, shared, None, None);
            appended = a.1;
        }
        let first = if shared > 0 {
            parent - shared + 1
        } else {
            mine[0]
        };
        if own > 0 {
            recs.push(rec(
                "messageParent",
                vec![
                    Value::Id(mine[0]),
                    Value::Id(parent),
                    Value::Id(1),
                    Value::Id(1),
                ],
            ));
        }
        recs.push(rec(
            "forkSelection",
            vec![
                Value::Id(base[2]),
                Value::Id(first),
                Value::Id(1),
                Value::Id(1),
            ],
        ));
        let removed = if shared == 0 { 2 } else { 0 };
        if removed > 0 {
            recs.push(del(cut[0]));
        }
        let m = measure(&s, recs);
        row(
            "cut 2 from this path",
            &format!("{removed} / {shared} / {own}"),
            m,
            removed + shared + own,
            appended,
        );
    }
    {
        // Cut everywhere: 2 messages out, the reply below and one other branch move up, the 2 go.
        let (base, _) = ids.chain(&s, 3, None, None);
        let tree = ids.tree;
        let (cut, _) = ids.chain(&s, 2, Some(base[2]), Some(tree));
        let (below, _) = ids.chain(&s, 10, Some(cut[1]), Some(tree));
        let (other, _) = ids.chain(&s, 10, Some(cut[0]), Some(tree));
        let m = measure(
            &s,
            vec![
                rec(
                    "messageParent",
                    vec![
                        Value::Id(below[0]),
                        Value::Id(base[2]),
                        Value::Id(1),
                        Value::Id(1),
                    ],
                ),
                rec(
                    "messageParent",
                    vec![
                        Value::Id(other[0]),
                        Value::Id(base[2]),
                        Value::Id(1),
                        Value::Id(1),
                    ],
                ),
                del(cut[0]),
            ],
        );
        row(
            "cut 2 everywhere (20 below move up)",
            "2 / 0 / 20",
            m,
            22,
            0.0,
        );
    }
    s.close();
    drop(s);
    let _ = std::fs::remove_dir_all(dir);
}
