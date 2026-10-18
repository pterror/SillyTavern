//! Measures how a commit's cost grows with its size: N chained message appends as one commit, for several N,
//! each on a fresh store; prints time and keyspace reads per record.
//!
//!   cargo run --release --features measure --example commitsize -- <dir> [hist] [N...]
//!
//! `hist`: N `histSet`s of one entry's field instead of N chained message appends.

use std::path::Path;
use std::time::Instant;

use st_engine::log::format::{FieldRef, Record, Value, kind_by_name};
use st_engine::store::books;
use st_engine::store::chat::{KEYED_SESSION, KEYED_USER};
use st_engine::store::{Store, StoreConfig};

fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
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
            Value::Time(1_800_000_000_000 + id as i64),
            Value::Text(format!("message {id} with some words in it").into_bytes()),
            Value::UInt(0),
            Value::Id(1),
            Value::Id(1),
            Value::Absent,
        ],
    )
}

/// Change `c` of entry 10's content (a history field), as one `histSet`.
fn hist_set(c: u64) -> Record {
    rec(
        "histSet",
        vec![
            Value::Id(10),
            Value::Field(FieldRef::Code(104)),
            Value::Text(format!("content as of change {c}").into_bytes()),
            Value::Bit(false),
            Value::Id(c),
            Value::Time(1_700_000_000_000 + c as i64),
            Value::Absent,
            Value::Id(1),
        ],
    )
}

/// A world book (1) with entry 10 in it.
fn book() -> Vec<Record> {
    vec![
        rec(
            "jsonValue",
            vec![
                Value::Sel(0, 1),
                Value::Field(FieldRef::Code(books::DEFINED)),
                Value::Text(Vec::new()),
                Value::Absent,
                Value::Absent,
            ],
        ),
        rec(
            "entityCreate",
            vec![
                Value::Id(1),
                Value::UInt(books::BOOK),
                Value::Text(b"b".to_vec()),
                Value::F64(0.0),
            ],
        ),
        rec(
            "entityCreate",
            vec![
                Value::Id(10),
                Value::UInt(books::ENTRY),
                Value::Text(b"1:0".to_vec()),
                Value::F64(0.0),
            ],
        ),
        rec(
            "itemPlace",
            vec![
                Value::Id(1),
                Value::UInt(books::ENTRIES),
                Value::UInt(10),
                Value::UInt(5),
            ],
        ),
    ]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let root = Path::new(&args[1]);
    let hist = args.get(2).is_some_and(|a| a == "hist");
    let from = if hist { 3 } else { 2 };
    let ns: Vec<usize> = if args.len() > from {
        args[from..].iter().map(|a| a.parse().unwrap()).collect()
    } else {
        vec![500, 2000, 8000, 32000]
    };
    for n in ns {
        let dir = root.join(format!("n{n}"));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Store::open(&dir, StoreConfig::default()).unwrap();
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
        ])
        .unwrap();
        let recs: Vec<Record> = if hist {
            s.commit_wait(book()).unwrap();
            (0..n as u64).map(|i| hist_set(1 + i)).collect()
        } else {
            (0..n as u64)
                .map(|i| append(1000 + i, (i > 0).then(|| 1000 + i - 1), 100))
                .collect()
        };
        let t = Instant::now();
        s.commit_wait(recs).unwrap();
        let ms = t.elapsed().as_secs_f64() * 1e3;
        println!(
            "{} N {n:>6}: {ms:>9.1} ms, {:>7.2} us/record",
            if hist { "histSet" } else { "append " },
            ms * 1e3 / n as f64
        );
        drop(s);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
