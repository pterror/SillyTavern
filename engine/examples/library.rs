//! Measures the library on a synthetic one: per action, the record and derived bytes and the device bytes of
//! an isolated commit; list pages at a size; and list pages after a bulk load of the same library (`bulk`).
//!
//!   cargo run --release --example library -- <dir> <cards> [actions|pages|bulk]
//!
//! `dir` is created and removed. Device bytes are `/proc/diskstats` sector deltas of the device holding `dir`
//! (`ST_DISK`, e.g. nvme0n1p5), less an idle window of the same length taken just before. With `ST_KEEP` set, `dir`
//! is kept; with `ST_REUSE` set, a kept `dir` is measured again without loading.

use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use st_engine::log::format::{FieldRef, Record, Value, kind_by_name};
use st_engine::store::library::{BY_NAME, CHARACTER, CREATED, DATA, NAME, TAG, WORLD};
use st_engine::store::library_read::{Filter, Query, RangeField, Sort};
use st_engine::store::{Store, StoreConfig};

fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
}

fn text(s: &str) -> Value {
    Value::Text(s.as_bytes().to_vec())
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const WORDS: [&str; 16] = [
    "the", "dragon", "quiet", "knight", "river", "smile", "ancient", "letter", "storm", "garden",
    "shadow", "silver", "voice", "window", "promise", "lantern",
];
const TAGS: u64 = 50;
const FIRST_CARD: u64 = 1000;
const DESCRIPTION: u64 = 10;

fn sentence(r: &mut Rng, words: usize) -> String {
    (0..words)
        .map(|_| WORDS[r.below(WORDS.len() as u64) as usize])
        .collect::<Vec<_>>()
        .join(" ")
}

fn card(r: &mut Rng, e: u64) -> Vec<Record> {
    let name = format!("{} {}", WORDS[r.below(16) as usize], e);
    let desc = sentence(r, 150);
    let mut recs = vec![
        rec(
            "textValue",
            vec![
                Value::Id(e),
                Value::Field(FieldRef::Code(NAME)),
                text(&name),
            ],
        ),
        rec(
            "textValue",
            vec![
                Value::Id(e),
                Value::Field(FieldRef::Code(DESCRIPTION)),
                text(&desc),
            ],
        ),
        rec(
            "dataSize",
            vec![Value::Id(e), Value::UInt((name.len() + desc.len()) as u64)],
        ),
        rec(
            "createDate",
            vec![Value::Id(e), Value::F64(1.6e12 + r.below(1 << 30) as f64)],
        ),
        rec(
            "cardHash",
            vec![
                Value::Id(e),
                Value::UInt(0),
                Value::Bytes(r.next().to_le_bytes().repeat(4)),
            ],
        ),
    ];
    if r.below(3) == 0 {
        recs.push(rec(
            "textValue",
            vec![
                Value::Id(e),
                Value::Field(FieldRef::Code(WORLD)),
                text("lore"),
            ],
        ));
    }
    if r.below(5) == 0 {
        recs.push(rec("fav", vec![Value::Id(e), Value::Bit(true)]));
    }
    for _ in 0..1 + r.below(3) {
        recs.push(rec(
            "tagAssign",
            vec![Value::Id(e), Value::Id(1 + r.below(TAGS)), Value::Bit(true)],
        ));
    }
    // After the values, as the writer does, so the card enters the orders once.
    recs.push(rec(
        "entityCreate",
        vec![
            Value::Id(e),
            Value::UInt(CHARACTER),
            text(&format!("{name}.png")),
            Value::Time(1_700_000_000_000 + e as i64),
        ],
    ));
    recs
}

fn load(s: &Store, cards: u64) {
    let mut r = Rng(1);
    let tags: Vec<Record> = (1..=TAGS)
        .map(|t| {
            rec(
                "entityCreate",
                vec![
                    Value::Id(t),
                    Value::UInt(TAG),
                    text(&format!("tag{t}")),
                    Value::Time(0),
                ],
            )
        })
        .collect();
    s.commit_wait(tags).unwrap();
    let started = Instant::now();
    let (tx, rx) = mpsc::channel();
    let mut in_flight = 0;
    let batch = 200;
    let mut e = FIRST_CARD;
    while e < FIRST_CARD + cards {
        let mut recs = Vec::new();
        for _ in 0..batch.min(FIRST_CARD + cards - e) {
            recs.extend(card(&mut r, e));
            e += 1;
        }
        let tx = tx.clone();
        s.commit(recs, Box::new(move |res| drop(tx.send(res.map(|_| ())))));
        in_flight += 1;
        if in_flight == 8 {
            rx.recv().unwrap().unwrap();
            in_flight -= 1;
        }
    }
    for _ in 0..in_flight {
        rx.recv().unwrap().unwrap();
    }
    let ks = s.keyspace().stats();
    eprintln!(
        "loaded {cards} cards in {:.1} s: {} entries ({:.1} per card), runs {:.1} MB, flush+merge written per inserted byte {:.2}",
        started.elapsed().as_secs_f64(),
        ks.inserted,
        ks.inserted as f64 / cards as f64,
        ks.run_bytes as f64 / 1e6,
        (ks.flush_bytes + ks.merge_bytes) as f64 / ks.inserted_bytes.max(1) as f64,
    );
}

/// The same library as `load`, through a bulk load (as the conversion one-off writes a store).
fn bulk_load(s: &Store, cards: u64) {
    let mut r = Rng(1);
    let started = Instant::now();
    let mut l = s.loader().unwrap();
    l.add((1..=TAGS).map(|t| {
        rec(
            "entityCreate",
            vec![
                Value::Id(t),
                Value::UInt(TAG),
                text(&format!("tag{t}")),
                Value::Time(0),
            ],
        )
    }))
    .unwrap();
    for e in FIRST_CARD..FIRST_CARD + cards {
        l.add(card(&mut r, e)).unwrap();
    }
    let st = l.finish().unwrap();
    eprintln!(
        "bulk loaded {cards} cards in {:.1} s: run {:.1} MB, {} entries; numberings {:.2} s, {} entries",
        started.elapsed().as_secs_f64(),
        st.run_bytes as f64 / 1e6,
        st.run_entries,
        st.numbers_micros as f64 / 1e6,
        st.number_entries,
    );
}

/// How many of the generator's cards have a data size in `[lo, hi]`.
fn data_size_count(cards: u64, lo: u64, hi: u64) -> u64 {
    let mut r = Rng(1);
    let mut n = 0;
    for e in FIRST_CARD..FIRST_CARD + cards {
        for rec in card(&mut r, e) {
            if rec.kind.name == "dataSize"
                && let Value::UInt(v) = rec.values[1]
                && (lo..=hi).contains(&v)
            {
                n += 1;
            }
        }
    }
    n
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

/// Commits `n` single actions one at a time; returns per action: record bytes, entries, entry bytes, device
/// bytes (idle window subtracted), and ms.
fn isolated(s: &Store, dev: &str, n: u64, mut action: impl FnMut(u64) -> Vec<Record>) -> [f64; 5] {
    // Idle window of the same length as the run, first.
    let probe = Instant::now();
    for i in 0..5 {
        s.commit_wait(action(i)).unwrap();
    }
    let est = probe.elapsed() * (n as u32) / 5;
    let d0 = disk_sectors(dev);
    std::thread::sleep(est);
    let idle = disk_sectors(dev) - d0;
    let (log0, ks0) = (s.stats().log_bytes, s.keyspace().stats());
    let rounds0 = s.stats().log_rounds;
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
    let record = ((st.log_bytes - log0) as f64 - 5.0 * rounds) / n as f64;
    [
        record,
        (ks.inserted - ks0.inserted) as f64 / n as f64,
        (ks.inserted_bytes - ks0.inserted_bytes) as f64 / n as f64,
        dev_bytes,
        ms,
    ]
}

fn actions(s: &Store, cards: u64, dev: &str) {
    let n = 400;
    let mut r = Rng(77);
    let pick = |r: &mut Rng| FIRST_CARD + r.below(cards);
    let mut favs = std::collections::HashMap::new();
    let rows: Vec<(&str, [f64; 5])> = vec![
        (
            "fav flip",
            isolated(s, dev, n, |_| {
                let e = pick(&mut r);
                let on = !favs.get(&e).copied().unwrap_or(false);
                favs.insert(e, on);
                vec![rec("fav", vec![Value::Id(e), Value::Bit(on)])]
            }),
        ),
        (
            "tag assign",
            isolated(s, dev, n, |i| {
                vec![rec(
                    "tagAssign",
                    vec![
                        Value::Id(FIRST_CARD + i),
                        Value::Id(TAGS + 1),
                        Value::Bit(true),
                    ],
                )]
            }),
        ),
        (
            "tag unassign",
            isolated(s, dev, n, |i| {
                vec![rec(
                    "tagAssign",
                    vec![
                        Value::Id(FIRST_CARD + i),
                        Value::Id(TAGS + 1),
                        Value::Bit(false),
                    ],
                )]
            }),
        ),
        (
            "one-word edit (edit + size + identity hash)",
            isolated(s, dev, n, |i| {
                let e = FIRST_CARD + i;
                vec![
                    rec(
                        "textEdit",
                        vec![
                            Value::Id(e),
                            Value::Field(FieldRef::Code(DESCRIPTION)),
                            Value::UInt(0),
                            Value::UInt(0),
                            text("brave "),
                        ],
                    ),
                    rec("dataSize", vec![Value::Id(e), Value::UInt(9999 + i)]),
                    rec(
                        "cardHash",
                        vec![
                            Value::Id(e),
                            Value::UInt(0),
                            Value::Bytes(i.to_le_bytes().repeat(4)),
                        ],
                    ),
                ]
            }),
        ),
        (
            "one-word edit (the edit alone)",
            isolated(s, dev, n, |i| {
                vec![rec(
                    "textEdit",
                    vec![
                        Value::Id(FIRST_CARD + 1000 + i),
                        Value::Field(FieldRef::Code(DESCRIPTION)),
                        Value::UInt(4),
                        Value::UInt(0),
                        text("old "),
                    ],
                )]
            }),
        ),
        (
            "rename (name value)",
            isolated(s, dev, n, |i| {
                vec![rec(
                    "textValue",
                    vec![
                        Value::Id(FIRST_CARD + 2000 + i),
                        Value::Field(FieldRef::Code(NAME)),
                        text(&format!("renamed {i}")),
                    ],
                )]
            }),
        ),
    ];
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

fn page_query(filter: Filter, sort: Sort, limit: usize) -> Query {
    Query {
        filter,
        sort,
        offset: 0,
        limit,
        cursor: None,
        count: true,
        cap: 20_000,
    }
}

fn pages(s: &Store) {
    let all = Filter {
        characters: true,
        groups: true,
        ..Filter::default()
    };
    let cases: Vec<(&str, Query)> = vec![
        (
            "name A-Z, first page",
            page_query(
                all.clone(),
                Sort::Key {
                    sort: BY_NAME,
                    desc: false,
                },
                500,
            ),
        ),
        (
            "name Z-A",
            page_query(
                all.clone(),
                Sort::Key {
                    sort: BY_NAME,
                    desc: true,
                },
                500,
            ),
        ),
        (
            "newest",
            page_query(
                all.clone(),
                Sort::Key {
                    sort: CREATED,
                    desc: true,
                },
                500,
            ),
        ),
        (
            "most tokens",
            page_query(
                all.clone(),
                Sort::Key {
                    sort: DATA,
                    desc: true,
                },
                500,
            ),
        ),
        (
            "favourites first",
            page_query(all.clone(), Sort::Fav { desc: true }, 500),
        ),
        (
            "fav only",
            page_query(
                Filter {
                    fav: Some(true),
                    ..all.clone()
                },
                Sort::Key {
                    sort: BY_NAME,
                    desc: false,
                },
                500,
            ),
        ),
        (
            "one tag",
            page_query(
                Filter {
                    all_tags: vec![7],
                    ..all.clone()
                },
                Sort::Key {
                    sort: BY_NAME,
                    desc: false,
                },
                500,
            ),
        ),
        (
            "lorebook",
            page_query(
                Filter {
                    world: Some(b"lore".to_vec()),
                    groups: false,
                    ..all.clone()
                },
                Sort::Key {
                    sort: CREATED,
                    desc: false,
                },
                500,
            ),
        ),
        (
            "two tags (checked)",
            page_query(
                Filter {
                    all_tags: vec![7, 8],
                    ..all.clone()
                },
                Sort::Key {
                    sort: BY_NAME,
                    desc: false,
                },
                500,
            ),
        ),
        (
            "tag excluded (checked)",
            page_query(
                Filter {
                    no_tags: vec![3],
                    ..all.clone()
                },
                Sort::Key {
                    sort: BY_NAME,
                    desc: false,
                },
                500,
            ),
        ),
        (
            "data range (checked)",
            page_query(
                Filter {
                    ranges: vec![(RangeField::Data, Some(900.0), Some(950.0))],
                    ..all.clone()
                },
                Sort::Key {
                    sort: BY_NAME,
                    desc: false,
                },
                500,
            ),
        ),
        (
            "two tags, newest (checked)",
            page_query(
                Filter {
                    all_tags: vec![7, 8],
                    ..all.clone()
                },
                Sort::Key {
                    sort: CREATED,
                    desc: true,
                },
                500,
            ),
        ),
        (
            "two tags, fav only (checked)",
            page_query(
                Filter {
                    all_tags: vec![7, 8],
                    fav: Some(true),
                    ..all.clone()
                },
                Sort::Key {
                    sort: BY_NAME,
                    desc: false,
                },
                500,
            ),
        ),
        (
            "three tags (checked)",
            page_query(
                Filter {
                    all_tags: vec![7, 8, 9],
                    ..all.clone()
                },
                Sort::Key {
                    sort: BY_NAME,
                    desc: false,
                },
                500,
            ),
        ),
        (
            "any of two tags (checked)",
            page_query(
                Filter {
                    any_tags: vec![7, 8],
                    ..all.clone()
                },
                Sort::Key {
                    sort: BY_NAME,
                    desc: false,
                },
                500,
            ),
        ),
        (
            "tag and excluded tag (checked)",
            page_query(
                Filter {
                    all_tags: vec![7],
                    no_tags: vec![8],
                    ..all.clone()
                },
                Sort::Key {
                    sort: BY_NAME,
                    desc: false,
                },
                500,
            ),
        ),
        (
            "data range, matching ~15% (checked)",
            page_query(
                Filter {
                    ranges: vec![(RangeField::Data, Some(1025.0), Some(1100.0))],
                    ..all.clone()
                },
                Sort::Key {
                    sort: BY_NAME,
                    desc: false,
                },
                500,
            ),
        ),
        (
            "data range, sorted by data size (checked)",
            page_query(
                Filter {
                    ranges: vec![(RangeField::Data, Some(900.0), Some(950.0))],
                    ..all.clone()
                },
                Sort::Key {
                    sort: DATA,
                    desc: true,
                },
                500,
            ),
        ),
        (
            "random",
            page_query(
                all.clone(),
                Sort::Random {
                    seed: 5,
                    desc: false,
                },
                500,
            ),
        ),
        (
            "random, two tags (checked)",
            page_query(
                Filter {
                    all_tags: vec![7, 8],
                    ..all.clone()
                },
                Sort::Random {
                    seed: 5,
                    desc: false,
                },
                500,
            ),
        ),
        (
            "random, one tag",
            page_query(
                Filter {
                    all_tags: vec![7],
                    ..all.clone()
                },
                Sort::Random {
                    seed: 5,
                    desc: false,
                },
                500,
            ),
        ),
    ];
    println!("| page (500) | ms (median of 5) | blocks (from file) | rows | total |");
    println!("|---|---|---|---|---|");
    for (name, q) in cases {
        let mut times = Vec::new();
        let mut last = None;
        let ks0 = s.keyspace().stats();
        for _ in 0..5 {
            let t = Instant::now();
            let p = s.library_page(&q).unwrap();
            times.push(t.elapsed());
            last = Some(p);
        }
        let ks = s.keyspace().stats();
        times.sort();
        let p = last.unwrap();
        println!(
            "| {name} | {:.2} | {:.0} ({:.0}) | {} | {}{} |",
            times[2].as_secs_f64() * 1000.0,
            (ks.blocks - ks0.blocks) as f64 / 5.0,
            (ks.file_reads - ks0.file_reads) as f64 / 5.0,
            p.ids.len(),
            p.total.unwrap_or(0),
            if p.total_exact { "" } else { " ~" },
        );
        // A deep page: through cursors to the 20th.
        if name == "name A-Z, first page" {
            let mut q2 = q.clone();
            q2.count = false;
            let mut c = p.cursor.clone();
            let t = Instant::now();
            for _ in 0..19 {
                q2.cursor = c;
                c = s.library_page(&q2).unwrap().cursor;
            }
            println!(
                "| name A-Z, pages 2-20 by cursor (each) | {:.2} | | | |",
                t.elapsed().as_secs_f64() * 1000.0 / 19.0
            );
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = Path::new(&args[1]);
    let cards: u64 = args[2].parse().unwrap();
    let mode = args.get(3).map_or("actions", String::as_str);
    let dev = std::env::var("ST_DISK").unwrap_or_else(|_| "nvme0n1p5".into());
    let reuse = std::env::var_os("ST_REUSE").is_some();
    if !reuse {
        let _ = std::fs::remove_dir_all(dir);
    }
    let s = Store::open(dir, StoreConfig::default()).unwrap();
    s.wait_ready().unwrap();
    if !reuse && mode == "bulk" {
        bulk_load(&s, cards);
    } else if !reuse {
        load(&s, cards);
    }
    match mode {
        "actions" => {
            actions(&s, cards, &dev);
            s.close();
        }
        "pages" => {
            if std::env::var_os("ST_EXACT").is_some() {
                eprintln!(
                    "cards with a data size in [1025, 1100]: {}",
                    data_size_count(cards, 1025, 1100)
                );
            }
            // Cold-ish: everything flushed, reopened.
            s.close();
            drop(s);
            let s = Store::open(dir, StoreConfig::default()).unwrap();
            s.wait_ready().unwrap();
            pages(&s);
            let rss = std::fs::read_to_string("/proc/self/status")
                .unwrap()
                .lines()
                .find(|l| l.starts_with("VmHWM"))
                .map(str::to_string)
                .unwrap_or_default();
            eprintln!("{rss}");
            s.close();
        }
        "bulk" => {
            pages(&s);
            s.close();
        }
        _ => panic!("mode is actions, pages or bulk"),
    }
    std::thread::sleep(Duration::from_millis(10));
    if std::env::var_os("ST_KEEP").is_none() {
        let _ = std::fs::remove_dir_all(dir);
    }
}
