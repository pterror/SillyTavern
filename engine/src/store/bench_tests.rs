//! Read costs on a real store, measured by hand (ignored): `ST_BENCH_STORE=<store dir> cargo test --release --lib
//! store::bench_tests -- --ignored --nocapture`. The store is opened and read only (use a copy: opening may replay
//! and flush). Entities and fields are sampled with a fixed seed, so two builds read the same things.
//!
//! Each read runs twice and the second is timed (warm); `ST_BENCH_COLD=1` times the first instead.

use std::path::Path;
use std::time::Instant;

use super::derive::View;
use super::kinds::key;
use super::library_read::{self, Only};
use super::{Store, StoreConfig, chat_read, tags};

fn rng(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}

fn timed<T>(cold: bool, mut f: impl FnMut() -> T) -> f64 {
    if !cold {
        f();
    }
    let t = Instant::now();
    std::hint::black_box(f());
    t.elapsed().as_secs_f64() * 1e6
}

fn report(name: &str, mut v: Vec<f64>) {
    if v.is_empty() {
        println!("{name}: no samples");
        return;
    }
    v.sort_by(f64::total_cmp);
    let mean = v.iter().sum::<f64>() / v.len() as f64;
    println!(
        "{name}: n {} mean {mean:.1} p50 {:.1} p99 {:.1} us",
        v.len(),
        v[v.len() / 2],
        v[(v.len() * 99 / 100).min(v.len() - 1)]
    );
}

/// Up to `n` ids of the structure's entries (keys `structure, id, ...`), sampled from the first `scan` of them.
fn sample_ids(view: &View, structure: u64, scan: usize, n: usize, seed: &mut u64) -> Vec<u64> {
    let p = key::of(structure);
    let mut ids: Vec<u64> = view
        .scan(&p, &key::prefix_end(&p), scan)
        .unwrap()
        .into_iter()
        .filter_map(|(k, _)| crate::keyspace::val::get_u64(&k, &mut p.len()))
        .collect();
    ids.dedup();
    let mut out = Vec::new();
    while out.len() < n && !ids.is_empty() {
        let i = (rng(seed) % ids.len() as u64) as usize;
        out.push(ids.swap_remove(i));
    }
    out
}

#[test]
#[ignore]
fn reads_on_a_real_store() {
    let Some(dir) = std::env::var_os("ST_BENCH_STORE") else {
        return;
    };
    let cold = std::env::var_os("ST_BENCH_COLD").is_some();
    let store = Store::open(Path::new(&dir), StoreConfig::default()).unwrap();
    store.wait_ready().unwrap();
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    store
        .derived(|view| {
            let entities = sample_ids(view, key::ENTITY, 2_000_000, 2000, &mut seed);
            let (mut one, mut whole) = (Vec::new(), Vec::new());
            for &e in &entities {
                let Some(ent) = library_read::entity(view, e)? else {
                    continue;
                };
                if ent.values.is_empty() {
                    continue;
                }
                let f = ent.values[(rng(&mut seed) % ent.values.len() as u64) as usize]
                    .0
                    .clone();
                let only = Only {
                    fields: vec![f],
                    lists: Vec::new(),
                };
                one.push(timed(cold, || {
                    library_read::entities_only(view, &[e], &only).unwrap()
                }));
                whole.push(timed(cold, || library_read::entity(view, e).unwrap()));
            }
            report("field read (entities_only, one field)", one);
            report("whole entity (entity)", whole);

            let mut lib = Vec::new();
            for i in 0..50u64 {
                let q = library_read::Query {
                    filter: Default::default(),
                    sort: library_read::Sort::Key {
                        sort: super::library::BY_NAME,
                        desc: false,
                    },
                    offset: i * 50,
                    limit: 50,
                    cursor: None,
                    count: false,
                    cap: 20_000,
                };
                lib.push(timed(cold, || library_read::page(view, &q).unwrap()));
            }
            report("library page of 50", lib);

            let mut tag = Vec::new();
            for _ in 0..50 {
                let q = tags::Query {
                    limit: 50,
                    ..Default::default()
                };
                tag.push(timed(cold, || tags::page(view, &q).unwrap()));
            }
            report("tag page of 50", tag);

            let messages = sample_ids(view, key::MESSAGE, 2_000_000, 50 * 40, &mut seed);
            let mut chat = Vec::new();
            for c in messages.chunks(50) {
                chat.push(timed(cold, || chat_read::messages(view, c).unwrap()));
            }
            report("chat messages, 50 per read", chat);
            let mut paths = Vec::new();
            for &m in messages.iter().take(200) {
                paths.push(timed(cold, || chat_read::path(view, Some(m)).unwrap()));
            }
            report("chat path to a message", paths);

            let (mut recent, mut convos) = (Vec::new(), Vec::new());
            for _ in 0..50 {
                recent.push(timed(cold, || chat_read::recent(view, None, 50).unwrap()));
                convos.push(timed(cold, || {
                    chat_read::conversations(view, None, 50).unwrap()
                }));
            }
            report("recent sessions, 50", recent);
            report("conversations, 50", convos);
            Ok(())
        })
        .unwrap();
    store.close();
}
