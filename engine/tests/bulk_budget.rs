//! A bulk load's memory stays under its budget, measured as the process's resident memory (`memory::Resident`),
//! and what it stores doesn't depend on the budget. A test binary of its own: the memory measured is this load's
//! alone.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use st_engine::log::format::{FieldRef, Record, Value, kind_by_name};
use st_engine::store::{Store, StoreConfig, bulk};

const TAGS: u64 = 50;
const CARDS: u64 = 20_000;

fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
}

fn text(e: u64, code: u64, s: &str) -> Record {
    rec(
        "textValue",
        vec![
            Value::Sel(0, e),
            Value::Field(FieldRef::Code(code)),
            Value::Text(s.as_bytes().to_vec()),
            Value::Absent,
            Value::Absent,
        ],
    )
}

fn create(e: u64, kind: u64, key: &str) -> Record {
    rec(
        "entityCreate",
        vec![
            Value::Id(e),
            Value::UInt(kind),
            Value::Text(key.as_bytes().to_vec()),
            Value::F64(0.0),
        ],
    )
}

/// Words from a vocabulary of 5,000, by a fixed sequence.
struct Words(u64);

impl Words {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn text(&mut self, n: usize) -> String {
        (0..n)
            .map(|_| format!("w{}", self.next() % 5000))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// Tags as entities, then cards with a name, two text fields and three tags each.
fn library() -> impl Iterator<Item = Record> {
    let tags = (1..=TAGS).flat_map(|t| {
        vec![
            text(t, 1, &format!("tag{t} w{}", t * 7)),
            rec(
                "jsonValue",
                vec![
                    Value::Sel(0, t),
                    Value::Field(FieldRef::Code(41)),
                    Value::Text(Vec::new()),
                    Value::Absent,
                    Value::Absent,
                ],
            ),
            create(t, 2, &format!("t{t}")),
        ]
    });
    let mut w = Words(0x9e37_79b9_7f4a_7c15);
    let cards = (TAGS + 1..=TAGS + CARDS).flat_map(move |c| {
        let mut out = vec![
            text(c, 1, &w.text(2)),
            text(c, 10, &w.text(200)),
            text(c, 11, &w.text(40)),
            create(c, 0, &format!("c{c}.png")),
        ];
        for _ in 0..3 {
            let t = w.next() % TAGS + 1;
            out.push(rec(
                "tagAssign",
                vec![Value::Id(c), Value::Id(t), Value::Bit(true)],
            ));
        }
        out
    });
    tags.chain(cards)
}

fn load(dir: &Path, budget: Option<usize>) -> (bulk::LoadStats, usize) {
    let s = Store::open(dir, StoreConfig::default()).unwrap();
    s.wait_ready().unwrap();
    // The most the process's resident memory reaches past what it was at the load's start, sampled meanwhile.
    let base = st_engine::memory::Resident::new().read().unwrap();
    let peak = Arc::new(AtomicUsize::new(0));
    let done = Arc::new(AtomicBool::new(false));
    let sampler = {
        let (peak, done) = (peak.clone(), done.clone());
        std::thread::spawn(move || {
            let mut resident = st_engine::memory::Resident::new();
            while !done.load(Ordering::Relaxed) {
                let c = resident.read().unwrap();
                peak.fetch_max(c.saturating_sub(base), Ordering::Relaxed);
                std::thread::sleep(std::time::Duration::from_micros(200));
            }
        })
    };
    let mut l = s.loader_in(budget).unwrap();
    let mut recs = library().peekable();
    while recs.peek().is_some() {
        l.add(recs.by_ref().take(4096).collect::<Vec<_>>()).unwrap();
    }
    let st = l.finish().unwrap();
    done.store(true, Ordering::Relaxed);
    sampler.join().unwrap();
    s.close();
    (st, peak.load(Ordering::Relaxed))
}

/// Every entry of the store at `dir`.
fn entries(dir: &Path) -> Vec<(Vec<u8>, Vec<u8>)> {
    let s = Store::open(dir, StoreConfig::default()).unwrap();
    s.wait_ready().unwrap();
    let end = vec![0xffu8; 64];
    let mut out = Vec::new();
    let mut from = Vec::new();
    loop {
        let page = s.scan(&from, &end, 65536).unwrap();
        let full = page.len() == 65536;
        if let Some((k, _)) = page.last() {
            from = k.clone();
            from.push(0);
        }
        out.extend(page);
        if !full {
            break;
        }
    }
    s.close();
    out
}

fn temp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("st-engine-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

#[test]
fn a_bulk_load_stays_in_its_budget_and_stores_the_same_in_any() {
    let budget = 256 << 20;
    let (a, b) = (temp("budget-roomy"), temp("budget-tight"));
    // The tight load first: memory the allocator keeps from a load before would be in its start.
    let (tight, sampled) = load(&b, Some(budget));
    let (roomy, _) = load(&a, None);
    eprintln!(
        "roomy {roomy:?}\ntight {tight:?}\nsampled peak {} MiB",
        sampled >> 20
    );
    assert_eq!(roomy.spills, 0, "{roomy:?}");
    assert!(tight.spills > 0, "the tight budget wasn't tight: {tight:?}");
    assert!(tight.peak_bytes <= budget as u64, "{tight:?}");
    assert!(
        sampled <= budget,
        "sampled {sampled} past {budget}: {tight:?}"
    );
    assert!(
        entries(&a) == entries(&b),
        "the two loads stored different entries"
    );
    let _ = (std::fs::remove_dir_all(&a), std::fs::remove_dir_all(&b));
}
