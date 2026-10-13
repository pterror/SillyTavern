//! Measures chats on a synthetic set: per action, the record and derived bytes and the device bytes of an
//! isolated commit; and the reads a session list page, a bookmark list page and opening a position make.
//!
//!   cargo run --release --example chat -- <dir> <trees>
//!
//! Each tree has 200 messages in a chain (every fifth with a second alternative), sent through 8 of 64 sessions,
//! and 3 bookmarks; one more tree is a chain of 10,000. `dir` is created and removed. Device bytes are
//! `/proc/diskstats` sector deltas of the device holding `dir` (`ST_DISK`, e.g. nvme0n1p5), less an idle window of
//! the same length taken just before.

use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use st_engine::log::format::{Record, Value, kind_by_name};
use st_engine::store::chat::{FOLLOWING, KEYED_SESSION, KEYED_USER};
use st_engine::store::{Store, StoreConfig, chat_read, sessions};

const SESSIONS: u64 = 64;
const PER_TREE: u64 = 200;
const LONG: u64 = 10_000;
const BOOKMARKS: u64 = 3;
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

fn opt(v: Option<u64>) -> Value {
    v.map_or(Value::Absent, Value::Id)
}

fn append(
    id: u64,
    parent: Option<u64>,
    tree: u64,
    time: i64,
    len: usize,
    session: Option<u64>,
) -> Record {
    rec(
        "messageAppend",
        vec![
            Value::Id(id),
            opt(parent),
            Value::Id(tree),
            Value::Absent,
            Value::Absent,
            Value::Time(time),
            text(len, id),
            Value::UInt(0),
            opt(session),
            Value::Id(1),
            Value::Absent,
        ],
    )
}

struct Load {
    next_message: u64,
    next_position: u64,
    /// The last message of each tree's chain, by tree (1-based), and the long tree's.
    ends: Vec<u64>,
    long_tree: u64,
    long_end: u64,
}

fn commit_all(s: &Store, batches: impl Iterator<Item = Vec<Record>>) {
    let (tx, rx) = mpsc::channel();
    let mut in_flight = 0;
    for recs in batches {
        let tx = tx.clone();
        s.commit(recs, Box::new(move |r| drop(tx.send(r.map(|_| ())))));
        in_flight += 1;
        if in_flight == 8 {
            rx.recv().unwrap().unwrap();
            in_flight -= 1;
        }
    }
    for _ in 0..in_flight {
        rx.recv().unwrap().unwrap();
    }
}

fn load(s: &Store, trees: u64) -> Load {
    let mut actors = vec![rec(
        "keyMap",
        vec![Value::Sel(KEYED_USER, 1), Value::Bytes(b"user".to_vec())],
    )];
    for p in 1..=SESSIONS {
        actors.push(rec(
            "keyMap",
            vec![
                Value::Sel(KEYED_SESSION, p),
                Value::Bytes(format!("session-{p}").into_bytes()),
            ],
        ));
    }
    s.commit_wait(actors).unwrap();
    let started = Instant::now();
    let mut l = Load {
        next_message: 1,
        next_position: SESSIONS + 1,
        ends: Vec::new(),
        long_tree: trees + 1,
        long_end: 0,
    };
    let mut batches = Vec::new();
    for t in 1..=trees {
        let mut recs = Vec::new();
        let mut parent = None;
        for i in 0..PER_TREE {
            let id = l.next_message;
            l.next_message += 1;
            let session = 1 + (t * 8 + i % 8) % SESSIONS;
            recs.push(append(
                id,
                parent,
                t,
                1_700_000_000_000 + (t * 1000 + i) as i64,
                100,
                Some(session),
            ));
            if i % 5 == 4 {
                let alt = l.next_message;
                l.next_message += 1;
                recs.push(append(
                    alt,
                    parent,
                    t,
                    1_700_000_000_000 + (t * 1000 + i) as i64 + 1,
                    100,
                    None,
                ));
            }
            if i % (PER_TREE / BOOKMARKS) == 0 && i > 0 {
                let b = l.next_position;
                l.next_position += 1;
                recs.push(rec(
                    "positionCreate",
                    vec![
                        Value::Id(b),
                        Value::UInt(FOLLOWING),
                        Value::Id(session),
                        Value::Id(1),
                        Value::Id(id),
                    ],
                ));
            }
            parent = Some(id);
        }
        l.ends.push(parent.unwrap());
        batches.push(recs);
    }
    commit_all(s, batches.into_iter());
    let mut parent = None;
    let mut batches = Vec::new();
    let mut recs = Vec::new();
    for i in 0..LONG {
        let id = l.next_message;
        l.next_message += 1;
        recs.push(append(
            id,
            parent,
            l.long_tree,
            1_800_000_000_000 + i as i64,
            300,
            Some(1),
        ));
        parent = Some(id);
        if recs.len() == 1000 {
            batches.push(std::mem::take(&mut recs));
        }
    }
    batches.push(recs);
    // In order: each batch's first message replies to the batch before's last.
    for b in batches {
        s.commit_wait(b).unwrap();
    }
    l.long_end = parent.unwrap();
    let ks = s.keyspace().stats();
    eprintln!(
        "loaded {} messages in {:.1} s: {} entries ({:.1} per message), runs {:.1} MB",
        l.next_message - 1,
        started.elapsed().as_secs_f64(),
        ks.inserted,
        ks.inserted as f64 / (l.next_message - 1) as f64,
        ks.run_bytes as f64 / 1e6,
    );
    l
}

fn disk_sectors(dev: &str) -> u64 {
    let s = std::fs::read_to_string("/proc/diskstats").unwrap();
    for l in s.lines() {
        let f: Vec<&str> = l.split_whitespace().collect();
        if f.get(2) == Some(&dev) {
            return f[9].parse().unwrap();
        }
    }
    panic!("no device {dev}");
}

/// Commits `n` single actions one at a time; per action: record bytes, entries, entry bytes, device bytes (idle
/// window subtracted), ms.
fn isolated(s: &Store, dev: &str, n: u64, mut action: impl FnMut(u64) -> Vec<Record>) -> [f64; 5] {
    let probe = Instant::now();
    for i in 0..5 {
        s.commit_wait(action(i)).unwrap();
    }
    let est = probe.elapsed() * (n as u32) / 5;
    let d0 = disk_sectors(dev);
    std::thread::sleep(est);
    let idle = disk_sectors(dev) - d0;
    let (log0, ks0, rounds0) = (
        s.stats().log_bytes,
        s.keyspace().stats(),
        s.stats().log_rounds,
    );
    let d1 = disk_sectors(dev);
    let t = Instant::now();
    for i in 5..5 + n {
        s.commit_wait(action(i)).unwrap();
    }
    let ms = t.elapsed().as_secs_f64() * 1000.0 / n as f64;
    let dev_bytes = (disk_sectors(dev) - d1).saturating_sub(idle) as f64 * 512.0 / n as f64;
    let st = s.stats();
    let ks = s.keyspace().stats();
    let rounds = (st.log_rounds - rounds0) as f64;
    [
        ((st.log_bytes - log0) as f64 - 5.0 * rounds) / n as f64,
        (ks.inserted - ks0.inserted) as f64 / n as f64,
        (ks.inserted_bytes - ks0.inserted_bytes) as f64 / n as f64,
        dev_bytes,
        ms,
    ]
}

fn actions(s: &Store, l: &mut Load, trees: u64, dev: &str) {
    let n = 300;
    let mut ends = l.ends.clone();
    let mut next = l.next_message;
    let mut rows: Vec<(&str, [f64; 5])> = Vec::new();
    rows.push((
        "message append (600 B, through a session)",
        isolated(s, dev, n, |i| {
            let t = 1 + i % trees;
            let id = next;
            next += 1;
            let r = append(
                id,
                Some(ends[(t - 1) as usize]),
                t,
                1_900_000_000_000 + i as i64,
                600,
                Some(1 + i % SESSIONS),
            );
            ends[(t - 1) as usize] = id;
            vec![r]
        }),
    ));
    l.next_message = next;
    rows.push((
        "pointer move",
        isolated(s, dev, n, |i| {
            vec![rec(
                "pointerMove",
                vec![
                    Value::Id(1 + i % SESSIONS),
                    Value::Id(1),
                    Value::Id(1 + (i * 7919) % (l.next_message - 1)),
                ],
            )]
        }),
    ));
    rows.push((
        "fork choice",
        isolated(s, dev, n, |i| {
            // The alternative stored beside every fifth message of tree 1 + i.
            let t = 1 + i % trees;
            let first = 1 + (t - 1) * (PER_TREE + PER_TREE / 5);
            let alt = first + 5;
            vec![rec(
                "forkSelection",
                vec![
                    Value::Id(first + 3),
                    Value::Id(alt),
                    Value::Id(1 + i % SESSIONS),
                    Value::Id(1),
                ],
            )]
        }),
    ));
    rows.push((
        "history step back",
        isolated(s, dev, n, |i| {
            let p = 1 + i % SESSIONS;
            let (n, _) = s
                .chat_read(|v| sessions::step_target(v, p, true))
                .unwrap()
                .expect("a step back");
            vec![rec(
                "historyStep",
                vec![
                    Value::Id(p),
                    Value::Id(1),
                    Value::UInt(n),
                    Value::Time(1_700_000_000_000),
                ],
            )]
        }),
    ));
    rows.push((
        "state change (a variable)",
        isolated(s, dev, n, |i| {
            vec![rec(
                "stateChange",
                vec![
                    Value::Id(1 + i),
                    Value::Sel(1, l.ends[(i % trees) as usize]),
                    Value::Time(1_900_000_000_000 + i as i64),
                    Value::UInt(8),
                    Value::Absent,
                    Value::Absent,
                    Value::Field(st_engine::log::format::FieldRef::Key(b"hp".to_vec())),
                    Value::Text(format!("{i}").into_bytes()),
                    Value::Id(1 + i % SESSIONS),
                    Value::Id(1),
                ],
            )]
        }),
    ));
    println!("| action | record B | derived entries | entry B | device KB | ms |");
    println!("|---|---|---|---|---|---|");
    for (name, v) in rows {
        println!(
            "| {name} | {:.1} | {:.1} | {:.0} | {:.1} | {:.2} |",
            v[0],
            v[1],
            v[2],
            v[3] / 1000.0,
            v[4]
        );
    }
}

fn median_ms(mut f: impl FnMut()) -> f64 {
    let mut t: Vec<f64> = (0..31)
        .map(|_| {
            let s = Instant::now();
            f();
            s.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    t.sort_by(|a, b| a.partial_cmp(b).unwrap());
    t[15]
}

/// The `replies` of each message `chat_read::messages` answers.
fn replies(js: &chat_read::Js) -> Vec<u64> {
    let chat_read::Js::Arr(list) = js else {
        unreachable!()
    };
    list.iter()
        .map(|m| {
            let chat_read::Js::Obj(fields) = m else {
                unreachable!()
            };
            match fields.iter().find(|(k, _)| *k == "replies") {
                Some((_, chat_read::Js::Num(n))) => *n as u64,
                _ => unreachable!(),
            }
        })
        .collect()
}

/// The alternatives `ChatEngine.load` reads: the openings, and the replies of each message on the path with more
/// than one.
fn alternatives(
    v: &st_engine::store::derive::View,
    tree: u64,
    ids: &[u64],
    replies: &[u64],
) -> Result<(), st_engine::store::StoreError> {
    chat_read::children(v, None, tree, None, 500)?;
    for (i, m) in ids.iter().enumerate() {
        if i + 1 < ids.len() && replies[i] > 1 {
            chat_read::children(v, Some(*m), tree, None, 500)?;
        }
    }
    Ok(())
}

/// Opening a position as `ChatEngine.load` reads it: the path, its messages, their alternatives, the state there.
fn open_position(s: &Store, tree: u64, at: u64) -> usize {
    s.chat_read(|v| {
        let ids = st_engine::store::chat::path_to(v, Some(at))?;
        let r = replies(&chat_read::messages(v, &ids)?);
        alternatives(v, tree, &ids, &r)?;
        chat_read::state_at(v, tree, Some(at))?;
        Ok(ids.len())
    })
    .unwrap()
}

fn reads(s: &Store, l: &Load) {
    println!("| read | median ms |");
    println!("|---|---|");
    let rows: Vec<(String, f64)> = vec![
        (
            "session list: all sessions, a page of 50".into(),
            median_ms(|| drop(s.chat_read(|v| chat_read::recent(v, None, 50)).unwrap())),
        ),
        (
            "session list: a tree's, a page of 50".into(),
            median_ms(|| drop(s.chat_read(|v| chat_read::in_tree(v, 1, None, 50)).unwrap())),
        ),
        (
            "bookmark list: a tree's, a page of 50".into(),
            median_ms(|| {
                drop(
                    s.chat_read(|v| chat_read::tree_bookmarks(v, 1, None, 50))
                        .unwrap(),
                )
            }),
        ),
    ];
    for (name, ms) in rows {
        println!("| {name} | {ms:.3} |");
    }
    // Where opening the longest position spends its time.
    let at = l.long_end;
    let tree = l.long_tree;
    let ids: Vec<u64> = s
        .chat_read(|v| {
            let chat_read::Js::Arr(p) = chat_read::path(v, Some(at))? else {
                unreachable!()
            };
            Ok(p.iter()
                .map(|j| match j {
                    chat_read::Js::Big(m) => *m,
                    _ => unreachable!(),
                })
                .collect())
        })
        .unwrap();
    let parts: Vec<(&str, f64)> = vec![
        (
            "path",
            median_ms(|| drop(s.chat_read(|v| chat_read::path(v, Some(at))).unwrap())),
        ),
        (
            "messages",
            median_ms(|| drop(s.chat_read(|v| chat_read::messages(v, &ids)).unwrap())),
        ),
        (
            "alternatives",
            median_ms(|| {
                s.chat_read(|v| {
                    let mut parent = None;
                    for m in &ids {
                        chat_read::children(v, parent, tree, None, 500)?;
                        parent = Some(*m);
                    }
                    Ok(())
                })
                .unwrap()
            }),
        ),
        (
            "state",
            median_ms(|| {
                drop(
                    s.chat_read(|v| chat_read::state_at(v, tree, Some(at)))
                        .unwrap(),
                )
            }),
        ),
    ];
    for (name, ms) in parts {
        println!("| open at L = {LONG}: {name} | {ms:.2} |");
    }
    if std::env::var_os("ST_PROBE").is_some() {
        use st_engine::store::kinds::{key, parse_loc};
        let keys: Vec<Vec<u8>> = ids.iter().map(|m| key::id(key::MESSAGE, *m)).collect();
        let probes: Vec<(&str, f64)> = vec![
            (
                "point gets",
                median_ms(|| {
                    s.chat_read(|v| {
                        for k in &keys {
                            v.get(k)?;
                        }
                        Ok(())
                    })
                    .unwrap()
                }),
            ),
            (
                "get_many",
                median_ms(|| drop(s.chat_read(|v| v.get_many(&keys)).unwrap())),
            ),
            (
                "prefix scans",
                median_ms(|| {
                    s.chat_read(|v| {
                        for k in &keys {
                            v.scan(k, &key::prefix_end(k), 10)?;
                        }
                        Ok(())
                    })
                    .unwrap()
                }),
            ),
            (
                "record reads",
                median_ms(|| {
                    s.chat_read(|v| {
                        for b in v.get_many(&keys)? {
                            v.record(parse_loc(&b.unwrap())?.pos)?;
                        }
                        Ok(())
                    })
                    .unwrap()
                }),
            ),
        ];
        for (name, ms) in probes {
            println!("| probe, {LONG} messages: {name} | {ms:.2} |");
        }
    }
    for len in [100u64, 1000, LONG] {
        let at = l.long_end - (LONG - len);
        let mut got = 0;
        let ms = median_ms(|| got = open_position(s, l.long_tree, at));
        assert_eq!(got as u64, len);
        println!(
            "| open a position at L = {len} (path, messages, alternatives, state) | {ms:.2} |"
        );
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = Path::new(&args[1]);
    let trees: u64 = args[2].parse().unwrap();
    let dev = std::env::var("ST_DISK").unwrap_or_else(|_| "nvme0n1p5".into());
    let _ = std::fs::remove_dir_all(dir);
    let s = Store::open(dir, StoreConfig::default()).unwrap();
    s.wait_ready().unwrap();
    let mut l = load(&s, trees);
    actions(&s, &mut l, trees, &dev);
    // Reads on a reopened store (everything flushed).
    s.close();
    drop(s);
    let s = Store::open(dir, StoreConfig::default()).unwrap();
    s.wait_ready().unwrap();
    reads(&s, &l);
    s.close();
    drop(s);
    std::thread::sleep(Duration::from_millis(10));
    let _ = std::fs::remove_dir_all(dir);
}
