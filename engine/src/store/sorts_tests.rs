use std::collections::BTreeMap;
use std::fs;

use super::books::ENTRY;
use super::entry_label::{COMMENT, CONTENT};
use super::relations_tests::{book, create, derive_job, history_user, rec, text};
use super::sorts::{self, SORTS, Sort};
use super::*;
use crate::log::format::{FieldRef, Record, Value};

const B: u64 = 1;
const ORDER: u64 = 110;
const DEPTH: u64 = 125;
const PROBABILITY: u64 = 123;
const CONSTANT: u64 = 105;
const DISABLE: u64 = 112;

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("st-engine-sorts-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir
}

fn pool() -> Arc<Pool> {
    Pool::new(64 << 10, 256 << 10, 4, 1, 2, 2)
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

struct Changes(u64);

impl Changes {
    fn meta(&mut self) -> Vec<Value> {
        self.0 += 1;
        vec![
            Value::Id(self.0),
            Value::Time(1_700_000_000_000 + self.0 as i64),
            Value::Absent,
            Value::Id(1),
        ]
    }

    fn set(&mut self, entity: u64, code: u64, value: &str, json: bool) -> Record {
        let mut values = vec![Value::Id(entity), Value::Field(FieldRef::Code(code)), text(value), Value::Bit(json)];
        values.extend(self.meta());
        rec("histSet", values)
    }

    fn soft_delete(&mut self, entity: u64) -> Record {
        let mut values = vec![Value::Id(entity)];
        values.extend(self.meta());
        rec("histEntityDelete", values)
    }

    fn restore(&mut self, entity: u64, own_key: &str) -> Record {
        let mut values = vec![Value::Id(entity), Value::UInt(ENTRY), text(own_key), Value::F64(0.0)];
        values.extend(self.meta());
        rec("histRestore", values)
    }
}

#[derive(Clone, Default, Debug)]
struct Entry {
    uid: u64,
    title: String,
    content: String,
    order: Option<f64>,
    depth: Option<f64>,
    probability: Option<f64>,
    constant: bool,
    disable: bool,
    live: bool,
    stored: BTreeMap<u64, String>,
}

fn number_key(n: Option<f64>) -> (u8, i64) {
    match n {
        None => (0, 0),
        Some(n) => (1, (n * 1000.0) as i64),
    }
}

fn expected(model: &BTreeMap<u64, Entry>, sort: Sort) -> Vec<u64> {
    let mut live: Vec<(&u64, &Entry)> = model.iter().filter(|(_, e)| e.live).collect();
    live.sort_by(|(ea, a), (eb, b)| {
        let primary = match sort {
            Sort::Title => (a.title.to_lowercase(), a.title.clone()).cmp(&(b.title.to_lowercase(), b.title.clone())),
            Sort::Depth => number_key(a.depth).cmp(&number_key(b.depth)),
            Sort::Order => number_key(a.order).cmp(&number_key(b.order)),
            Sort::Uid => a.uid.cmp(&b.uid),
            Sort::Probability => number_key(a.probability).cmp(&number_key(b.probability)),
            Sort::Priority => {
                let rank = |e: &Entry| if e.disable { 2 } else if e.constant { 0 } else { 1 };
                rank(a).cmp(&rank(b))
            }
        };
        primary
            .then(number_key(b.order).cmp(&number_key(a.order)))
            .then(a.uid.cmp(&b.uid))
            .then(ea.cmp(eb))
    });
    live.into_iter().map(|(entity, _)| *entity).collect()
}

fn check(store: &Store, model: &BTreeMap<u64, Entry>, when: &str) {
    for sort in SORTS {
        let want = expected(model, sort);
        let got = store
            .chat_read(|view| sorts::from_rank(view, B, sort, false, 0, usize::MAX >> 1))
            .unwrap();
        assert_eq!(got, want, "{sort:?} after {when}");
        let total = store.chat_read(|view| sorts::count(view, B, sort)).unwrap();
        assert_eq!(total as usize, want.len(), "{sort:?}'s count after {when}");
        if want.len() > 2 {
            let back = store.chat_read(|view| sorts::from_rank(view, B, sort, true, 1, 2)).unwrap();
            let reversed: Vec<u64> = want.iter().rev().skip(1).take(2).copied().collect();
            assert_eq!(back, reversed, "{sort:?} read backward after {when}");
        }
    }
}

struct Rng(u64);

impl Rng {
    fn below(&mut self, bound: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % bound
    }
}

const TITLES: [&str; 6] = ["Gerold", "gerold", "Ashwood", "", "zebra", "Ölmühle"];
const CONTENTS: [&str; 4] = ["", "a", "a longer text", "mid"];
const NUMBERS: [&str; 5] = ["100", "4", "-2.5", "0", "100"];

fn write_field(changes: &mut Changes, rng: &mut Rng, entity: u64, entry: &mut Entry) -> Option<Record> {
    let number = |rng: &mut Rng| NUMBERS[rng.below(NUMBERS.len() as u64) as usize];
    let mut next = entry.clone();
    let record = match rng.below(8) {
        7 => {
            next.title = String::new();
            changes.set(entity, COMMENT, "true", true)
        }
        0 => {
            let title = TITLES[rng.below(TITLES.len() as u64) as usize];
            next.title = title.into();
            changes.set(entity, COMMENT, title, false)
        }
        1 => {
            let content = CONTENTS[rng.below(CONTENTS.len() as u64) as usize];
            next.content = content.into();
            changes.set(entity, CONTENT, content, false)
        }
        2 => {
            let n = number(rng);
            next.order = n.parse().ok();
            changes.set(entity, ORDER, n, true)
        }
        3 => {
            let n = number(rng);
            next.depth = n.parse().ok();
            changes.set(entity, DEPTH, n, true)
        }
        4 => {
            let n = number(rng);
            next.probability = n.parse().ok();
            changes.set(entity, PROBABILITY, n, true)
        }
        5 => {
            next.constant = rng.below(2) == 0;
            changes.set(entity, CONSTANT, if next.constant { "true" } else { "false" }, true)
        }
        _ => {
            next.disable = rng.below(2) == 0;
            changes.set(entity, DISABLE, if next.disable { "true" } else { "false" }, true)
        }
    };
    let Some(Value::Field(FieldRef::Code(code_number))) = record.values.get(1).cloned() else {
        unreachable!("a set names its field")
    };
    let value = format!("{:?}", record.values.get(2));
    if entry.stored.get(&code_number) == Some(&value) {
        return None;
    }
    next.stored.insert(code_number, value);
    *entry = next;
    Some(record)
}

#[test]
fn every_write_keeps_each_sort_and_the_recount_builds_the_same() {
    let dir = temp_dir("model");
    let store = Store::open_in(&dir, SMALL, pool()).unwrap();
    history_user(&store);
    book(&store, B, "one");
    let mut changes = Changes(0);
    let mut rng = Rng(0x2545_f491_4f6c_dd1d);
    let mut model: BTreeMap<u64, Entry> = BTreeMap::new();
    let mut next = 100;
    for round in 0..300 {
        let live: Vec<u64> = model.iter().filter(|(_, e)| e.live).map(|(id, _)| *id).collect();
        let dead: Vec<u64> = model.iter().filter(|(_, e)| !e.live).map(|(id, _)| *id).collect();
        let what = if live.is_empty() { 0 } else { rng.below(10) };
        let mut records = Vec::new();
        match what {
            0 | 1 => {
                next += 1;
                let entity = next;
                let uid = rng.below(50);
                let own_key = format!("{B}:{}", entity * 100 + uid);
                let entry = model.entry(entity).or_default();
                entry.uid = entity * 100 + uid;
                entry.live = true;
                let fields: Vec<Record> =
                    (0..rng.below(4)).filter_map(|_| write_field(&mut changes, &mut rng, entity, entry)).collect();
                if rng.below(2) == 0 {
                    records.extend(fields);
                    records.push(create(entity, ENTRY, &own_key));
                } else {
                    records.push(create(entity, ENTRY, &own_key));
                    records.extend(fields);
                }
            }
            2 => {
                let entity = live[rng.below(live.len() as u64) as usize];
                records.push(changes.soft_delete(entity));
                model.get_mut(&entity).unwrap().live = false;
            }
            3 if !dead.is_empty() => {
                let entity = dead[rng.below(dead.len() as u64) as usize];
                let entry = model.get_mut(&entity).unwrap();
                records.push(changes.restore(entity, &format!("{B}:{}", entry.uid)));
                entry.live = true;
            }
            _ => {
                let entity = live[rng.below(live.len() as u64) as usize];
                let entry = model.get_mut(&entity).unwrap();
                for _ in 0..1 + rng.below(3) {
                    records.extend(write_field(&mut changes, &mut rng, entity, entry));
                }
                if records.is_empty() {
                    continue;
                }
            }
        }
        store.commit_wait(records).unwrap();
        check(&store, &model, &format!("round {round}"));
    }
    assert!(model.values().filter(|e| e.live).count() > 20, "the rounds leave a sizeable world");

    let mut after: Option<Vec<u8>> = None;
    loop {
        let from = after.clone();
        after = derive_job(&store, move |view, out| book_stats::recount_step(view, out, from.as_deref(), 3));
        if after.is_none() {
            break;
        }
    }
    check(&store, &model, "the recount");
    store.close();
    let _ = fs::remove_dir_all(&dir);
}

