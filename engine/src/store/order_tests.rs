use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

use super::order::{self, List, Where, Writes};
use super::*;

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-order-{}-{name}-{}",
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

fn store(name: &str) -> (Store, PathBuf) {
    let dir = temp_dir(name);
    let s = Store::open_in(&dir, SMALL, Pool::new(16 << 20, 64 << 10, 4, 1, 2, 2)).unwrap();
    (s, dir)
}

const L: fn() -> List = || List::children(7);

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

#[derive(Debug, Clone, Copy)]
enum Op {
    Insert(u64, Where),
    Remove(u64),
}

#[derive(Debug, Default, Clone, Copy)]
struct Cost {
    reads: u64,
    writes: usize,
}

fn run(s: &Store, op: Op) -> Cost {
    let cost = Arc::new(Mutex::new(Cost::default()));
    let seen = cost.clone();
    s.derive_now(move |v, out| {
        let mut w = Writes::new(v);
        match op {
            Op::Insert(x, to) => order::insert(&mut w, L(), x, to)?,
            Op::Remove(x) => order::remove(&mut w, L(), x)?,
        }
        *seen.lock().unwrap() = Cost {
            reads: w.reads.get(),
            writes: w.writes(),
        };
        w.finish(out);
        Ok(())
    })
    .unwrap();
    *cost.lock().unwrap()
}

fn check(s: &Store, model: &[u64]) {
    let model = model.to_vec();
    s.derived_read(move |v| {
        assert_eq!(order::all(v, L())?, model);
        assert_eq!(order::count(v, L())?, model.len() as u64);
        assert_eq!(order::first(v, L())?, model.first().copied());
        assert_eq!(order::last(v, L())?, model.last().copied());
        for (i, x) in model.iter().enumerate() {
            assert_eq!(order::place(v, L(), *x)?, i as u64 + 1, "the place of {x}");
            assert_eq!(
                order::at_place(v, L(), i as u64 + 1)?,
                Some(*x),
                "the node at {}",
                i + 1
            );
        }
        assert_eq!(order::at_place(v, L(), model.len() as u64 + 1)?, None);
        assert_eq!(order::at_place(v, L(), 0)?, None);
        Ok(())
    })
    .unwrap();
}

#[test]
fn random_inserts_and_removes_keep_order_places_and_counts_as_a_plain_list_does() {
    let seeds = std::env::var("ST_MODEL_SEEDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3u64);
    for seed in 1..=seeds {
        let (s, dir) = store("model");
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
        let mut model: Vec<u64> = Vec::new();
        let mut next_id = 1;
        for step in 0..400 {
            let op = if model.is_empty() || rng.below(3) > 0 {
                let x = next_id;
                next_id += 1;
                let to = match rng.below(3) {
                    0 => Where::Last,
                    1 => Where::First,
                    _ if model.is_empty() => Where::Last,
                    _ => Where::After(model[rng.below(model.len() as u64) as usize]),
                };
                match to {
                    Where::Last => model.push(x),
                    Where::First => model.insert(0, x),
                    Where::After(a) => {
                        let i = model.iter().position(|m| *m == a).unwrap();
                        model.insert(i + 1, x);
                    }
                }
                Op::Insert(x, to)
            } else {
                let i = rng.below(model.len() as u64) as usize;
                Op::Remove(model.remove(i))
            };
            run(&s, op);
            if step % 20 == 0 || model.len() < 8 {
                check(&s, &model);
            }
        }
        check(&s, &model);
        while let Some(x) = model.pop() {
            run(&s, Op::Remove(x));
        }
        check(&s, &model);
        s.derived_read(|v| {
            let p = key::of(order::LIST_LINK);
            assert!(
                v.scan(&p, &key::prefix_end(&p), 1)?.is_empty(),
                "an emptied list leaves no links"
            );
            for p in [
                key::of(order::LIST_HEAD),
                key::of(order::LIST_TAIL),
                key::of(order::LIST_COUNT),
            ] {
                assert!(
                    v.scan(&p, &key::prefix_end(&p), 1)?.is_empty(),
                    "an emptied list leaves nothing"
                );
            }
            Ok(())
        })
        .unwrap();
        s.close();
        let _ = fs::remove_dir_all(dir);
    }
}

#[test]
fn inserting_where_a_node_already_is_or_after_a_stranger_is_refused() {
    let (s, dir) = store("refused");
    run(&s, Op::Insert(1, Where::Last));
    let again = s.derive_now(|v, _| order::insert(&mut Writes::new(v), L(), 1, Where::Last));
    assert!(matches!(again, Err(StoreError::Refused(_))));
    let stranger = s.derive_now(|v, _| order::insert(&mut Writes::new(v), L(), 2, Where::After(9)));
    assert!(matches!(stranger, Err(StoreError::Refused(_))));
    let absent = s.derive_now(|v, _| order::remove(&mut Writes::new(v), L(), 9));
    assert!(matches!(absent, Err(StoreError::Refused(_))));
    s.close();
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn an_append_costs_the_same_at_any_length_and_a_middle_insert_grows_with_the_log_of_it() {
    let (s, dir) = store("costs");
    let n = 4096u64;
    let mut append_max = Cost::default();
    for x in 1..=n {
        let c = run(&s, Op::Insert(x, Where::Last));
        append_max.reads = append_max.reads.max(c.reads);
        append_max.writes = append_max.writes.max(c.writes);
    }
    let h = order::LEVELS as u64;
    assert!(
        append_max.reads <= 4 * h + 2,
        "an append read {} entries",
        append_max.reads
    );
    assert!(
        append_max.writes <= 3 * order::LEVELS + 1,
        "an append wrote {} entries",
        append_max.writes
    );

    let mut rng = Rng(42);
    let (mut reads, mut writes, mut ops) = (0u64, 0usize, 0u64);
    for i in 0..256 {
        let a = 1 + rng.below(n);
        let c = run(&s, Op::Insert(n + 1 + i, Where::After(a)));
        reads += c.reads;
        writes += c.writes;
        ops += 1;
    }
    let log4 = (64 - (n.leading_zeros() as u64)) / 2;
    let (mean_reads, mean_writes) = (reads / ops, writes as u64 / ops);
    assert!(
        mean_reads <= 12 * log4 + 4 * h,
        "a middle insert read {mean_reads} entries on average"
    );
    assert!(
        mean_writes <= 4 * log4 + 3 * h,
        "a middle insert wrote {mean_writes} entries on average"
    );

    let place_reads = Arc::new(AtomicU64::new(0));
    let seen = place_reads.clone();
    s.derive_now(move |v, _| {
        let w = Writes::new(v);
        let mut rng = Rng(7);
        for _ in 0..256 {
            order::place(&w, L(), 1 + rng.below(n))?;
        }
        seen.store(w.reads.get() / 256, Ordering::Relaxed);
        Ok(())
    })
    .unwrap();
    let mean = place_reads.load(Ordering::Relaxed);
    assert!(mean <= 12 * log4, "a place read {mean} entries on average");
    s.close();
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn heights_are_one_in_three_quarters_and_never_change() {
    let n = 1 << 16;
    let tall = (0..n).filter(|x| order::height(*x) > 1).count();
    assert!(
        (n / 4 - n / 40..n / 4 + n / 40).contains(&(tall as u64)),
        "{tall} of {n} are taller than one"
    );
    assert_eq!(order::height(12345), order::height(12345));
}
