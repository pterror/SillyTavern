//! Randomized model tests: seeded sequences of commits of every value kind, reads of every kind (point gets,
//! limited and unlimited pages up and down, snapshots held across later writes) and flushes, merges and reopens at
//! random points, every read checked against a plain model of what each key holds. Churn writes values to
//! never-used keys and undoes them in the same commit, then pages over them before a flush: the buffer then holds
//! entries that settle to nothing where no run holds anything (the case 50d22b76c fixed).
//!
//! `ST_MODEL_SEEDS=<n>` runs n seeds from `ST_MODEL_BASE` (default 12 from 1, sized for CI); `ST_MODEL_SEED=<s>`
//! runs seed s alone, to replay a failure; `ST_MODEL_STEPS` sets steps per seed. A failure names its seed and step.
//! The sequence of operations is fixed by the seed. The simulated runs also fix the interleaving: background
//! flushes and merges run as steps picked by the seed between operations (`Executor::simulated`), so a failure
//! replays exactly; the threaded runs let real threads interleave as they will.

use std::collections::BTreeMap;
use std::sync::atomic::AtomicU64;

use super::val::{count_bytes, counter_bytes, map_bytes, max_bytes, put_u64};
use super::*;

/// SplitMix64: small, seedable, the same everywhere.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, one_in: u64) -> bool {
        self.below(one_in) == 0
    }
}

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-model-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    dir
}

struct NoHooks;

impl Hooks for NoHooks {
    fn flush_extra(&self, _: &Keyspace, _: &Mem, _: &[Arc<Run>]) -> KsResult<Vec<(Vec<u8>, Val)>> {
        Ok(Vec::new())
    }
    fn flushed(&self, _: &Keyspace) {}
}

/// What a key holds in the model. A key's family fixes which value kinds it is written with, as the derivers
/// keep them apart (`over` treats other mixes as faults).
#[derive(Clone, Debug, PartialEq)]
enum Held {
    Bytes(Vec<u8>),
    Counter(i64),
    Max(u64),
    /// Slots of a map written with `Map` (set; 0 removes) or `MaxMap` (raise), as the family says.
    Map(BTreeMap<u32, u32>),
    /// Counts of a map written with `AddMap`.
    Counts(BTreeMap<u32, u64>),
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Family {
    Bytes,
    Counter,
    Max,
    SetMap,
    MaxMap,
    AddMap,
}

const FAMILIES: [Family; 6] = [
    Family::Bytes,
    Family::Counter,
    Family::Max,
    Family::SetMap,
    Family::MaxMap,
    Family::AddMap,
];

fn key(i: u64) -> Vec<u8> {
    let mut k = vec![7];
    put_u64(&mut k, i);
    k
}

fn family(i: u64) -> Family {
    FAMILIES[(i % FAMILIES.len() as u64) as usize]
}

fn held_bytes(h: &Held) -> Option<Vec<u8>> {
    match h {
        Held::Bytes(b) => Some(b.clone()),
        Held::Counter(n) => Some(counter_bytes(*n)),
        Held::Max(m) => Some(max_bytes(*m)),
        Held::Map(m) => {
            let pairs: Vec<(u32, u32)> = m
                .iter()
                .filter(|(_, v)| **v != 0)
                .map(|(s, v)| (*s, *v))
                .collect();
            (!pairs.is_empty()).then(|| map_bytes(&pairs))
        }
        Held::Counts(m) => {
            let pairs: Vec<(u32, u64)> = m.iter().map(|(s, v)| (*s, *v)).collect();
            (!pairs.is_empty()).then(|| count_bytes(&pairs))
        }
    }
}

type Model = BTreeMap<Vec<u8>, Held>;

fn model_bytes(model: &Model) -> BTreeMap<Vec<u8>, Vec<u8>> {
    model
        .iter()
        .filter_map(|(k, h)| held_bytes(h).map(|b| (k.clone(), b)))
        .collect()
}

fn slots(rng: &mut Rng, max_value: u32) -> Vec<(u32, u32)> {
    let mut m = BTreeMap::new();
    for _ in 0..1 + rng.below(4) {
        m.insert(
            rng.below(12) as u32,
            rng.below(u64::from(max_value) + 1) as u32,
        );
    }
    m.into_iter().collect()
}

/// A random write of key `i`'s family, applied to the model.
fn write(rng: &mut Rng, model: &mut Model, i: u64) -> (Vec<u8>, Val) {
    let k = key(i);
    let cur = model.get(&k).cloned();
    if rng.chance(7) {
        model.remove(&k);
        return (k, Val::Del);
    }
    let (val, new) = match family(i) {
        Family::Bytes => {
            let b = vec![rng.below(256) as u8; rng.below(60) as usize];
            (Val::Put(b.clone()), Some(Held::Bytes(b)))
        }
        Family::Counter => {
            let base = match cur {
                Some(Held::Counter(n)) => n,
                _ => 0,
            };
            if rng.chance(4) {
                let n = rng.below(1000) as i64 - 500;
                (Val::Put(counter_bytes(n)), Some(Held::Counter(n)))
            } else {
                let d = rng.below(21) as i64 - 10;
                (Val::Add(d), Some(Held::Counter(base.wrapping_add(d))))
            }
        }
        Family::Max => {
            let base = match cur {
                Some(Held::Max(m)) => Some(m),
                _ => None,
            };
            if rng.chance(4) {
                // A lowering, as search writes it: a `Put` of the exact value.
                let m = rng.below(1000);
                (Val::Put(max_bytes(m)), Some(Held::Max(m)))
            } else {
                let m = rng.below(1000);
                (Val::Max(m), Some(Held::Max(base.map_or(m, |b| b.max(m)))))
            }
        }
        Family::SetMap => {
            let mut map = match cur {
                Some(Held::Map(m)) => m,
                _ => BTreeMap::new(),
            };
            if rng.chance(5) {
                let pairs: Vec<(u32, u32)> =
                    slots(rng, 50).into_iter().filter(|p| p.1 != 0).collect();
                if pairs.is_empty() {
                    model.remove(&k);
                    return (k, Val::Del);
                }
                let m: BTreeMap<u32, u32> = pairs.iter().copied().collect();
                (Val::Put(map_bytes(&pairs)), Some(Held::Map(m)))
            } else {
                let pairs = slots(rng, 50);
                for &(s, v) in &pairs {
                    if v == 0 {
                        map.remove(&s);
                    } else {
                        map.insert(s, v);
                    }
                }
                let new = (!map.is_empty()).then_some(Held::Map(map));
                (Val::Map(pairs), new)
            }
        }
        Family::MaxMap => {
            let mut map = match cur {
                Some(Held::Map(m)) => m,
                _ => BTreeMap::new(),
            };
            if rng.chance(5) {
                let pairs: Vec<(u32, u32)> =
                    slots(rng, 50).into_iter().filter(|p| p.1 != 0).collect();
                if pairs.is_empty() {
                    model.remove(&k);
                    return (k, Val::Del);
                }
                let m: BTreeMap<u32, u32> = pairs.iter().copied().collect();
                (Val::Put(map_bytes(&pairs)), Some(Held::Map(m)))
            } else {
                let pairs: Vec<(u32, u32)> =
                    slots(rng, 50).into_iter().filter(|p| p.1 != 0).collect();
                if pairs.is_empty() {
                    model.remove(&k);
                    return (k, Val::Del);
                }
                for &(s, v) in &pairs {
                    let e = map.entry(s).or_insert(0);
                    *e = (*e).max(v);
                }
                (Val::MaxMap(pairs), Some(Held::Map(map)))
            }
        }
        Family::AddMap => {
            let mut map = match cur {
                Some(Held::Counts(m)) => m,
                _ => BTreeMap::new(),
            };
            let mut deltas = BTreeMap::new();
            for _ in 0..1 + rng.below(4) {
                let s = rng.below(12) as u32;
                let have = i64::try_from(*map.get(&s).unwrap_or(&0)).unwrap()
                    + deltas.get(&s).copied().unwrap_or(0);
                // Never below 0: a count that would leave its range is a fault in the derived data.
                let d = rng.below(11) as i64 - have.min(5);
                if d != 0 {
                    *deltas.entry(s).or_insert(0) += d;
                }
            }
            deltas.retain(|_, d| *d != 0);
            if deltas.is_empty() {
                deltas.insert(rng.below(12) as u32, 1);
            }
            for (&s, &d) in &deltas {
                let n = (i64::try_from(*map.get(&s).unwrap_or(&0)).unwrap() + d) as u64;
                if n == 0 {
                    map.remove(&s);
                } else {
                    map.insert(s, n);
                }
            }
            let new = (!map.is_empty()).then_some(Held::Counts(map));
            (Val::AddMap(deltas.into_iter().collect()), new)
        }
    };
    match new {
        Some(h) => model.insert(k.clone(), h),
        None => model.remove(&k),
    };
    (k, val)
}

fn wait_for_room(pool: &Pool) {
    loop {
        let (active, frozen) = pool.buffered();
        if active + frozen < 2 * pool.buffer_bytes as u64 {
            return;
        }
        pool.request_room();
        if pool.exec.is_simulated() {
            assert!(pool.exec.pump(), "no room and no step queued to make some");
        } else {
            std::thread::sleep(std::time::Duration::from_micros(100));
        }
    }
}

fn bytes_of(v: Vec<(Vec<u8>, Val)>) -> Vec<(Vec<u8>, Vec<u8>)> {
    v.into_iter()
        .map(|(k, v)| {
            let b = v.into_bytes(&k);
            (k, b)
        })
        .collect()
}

/// A random range bound: a key, sometimes one between keys, or the end of the keyspace.
fn bound(rng: &mut Rng, keys: u64) -> Vec<u8> {
    match rng.below(8) {
        0 => vec![8],
        1 => vec![7],
        2 => {
            let mut k = key(rng.below(keys));
            k.push(0);
            k
        }
        5 | 6 => key(FRESH + rng.below(CHURN + 1)),
        _ => key(rng.below(keys + 1)),
    }
}

/// A page read: `[start, end)` up to `limit` entries, as bytes.
type PageRead<'a> = &'a dyn Fn(&[u8], &[u8], usize) -> Vec<(Vec<u8>, Vec<u8>)>;

/// Checks one random read against `expect` (the model's bytes when the read's state was taken).
fn check_read(
    rng: &mut Rng,
    keys: u64,
    expect: &BTreeMap<Vec<u8>, Vec<u8>>,
    get: &dyn Fn(&[u8]) -> Option<Vec<u8>>,
    fwd: PageRead,
    rev: PageRead,
    at: &str,
) {
    match rng.below(3) {
        0 => {
            let k = if rng.chance(4) {
                key(FRESH + rng.below(CHURN))
            } else {
                key(rng.below(keys))
            };
            assert_eq!(get(&k), expect.get(&k).cloned(), "{at}: get {k:?}");
        }
        r => {
            let (a, b) = (bound(rng, keys), bound(rng, keys));
            let (start, end) = if a <= b { (a, b) } else { (b, a) };
            let limit = match rng.below(4) {
                0 => usize::MAX,
                _ => 1 + rng.below(20) as usize,
            };
            let all = expect.range(start.clone()..end.clone());
            if r == 1 {
                let want: Vec<_> = all
                    .take(limit)
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                assert_eq!(
                    fwd(&start, &end, limit),
                    want,
                    "{at}: page {start:?}..{end:?} limit {limit}"
                );
            } else {
                let want: Vec<_> = all
                    .rev()
                    .take(limit)
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                assert_eq!(
                    rev(&start, &end, limit),
                    want,
                    "{at}: page down {start:?}..{end:?} limit {limit}"
                );
            }
        }
    }
}

/// What a run ended with: the steps run under simulation, and every key and value at the end.
type Outcome = (u64, Vec<(Vec<u8>, Vec<u8>)>);

fn run_seed(seed: u64, steps: u64, sim: bool) -> Outcome {
    let mut rng = Rng(seed);
    let dir = temp_dir(&format!("s{seed}"));
    let keys = 40 + rng.below(400);
    let cfg = KsConfig {
        log_bytes: if rng.chance(2) {
            u64::MAX
        } else {
            64 + rng.below(4096)
        },
        fan_in: 2 + rng.below(3) as usize,
        block_size: 128 + rng.below(1024) as usize,
        max_frozen: 1 + rng.below(2) as usize,
    };
    // A small buffer flushes often; a larger one keeps churned windows unflushed while they are read.
    let buffer = if rng.chance(2) {
        (4 + rng_free(seed)) << 10
    } else {
        256 << 10
    };
    let pool = || {
        if sim {
            Pool::simulated(buffer, 64 << 10, 2, 2, seed ^ 0x5eed)
        } else {
            Pool::new(buffer, 64 << 10, 4, 1, 2, 2)
        }
    };
    let mut sim_steps = 0u64;
    let mut fresh = 0u64;
    let open = |dir: &Path| {
        let ks = Keyspace::open(dir, cfg, pool()).unwrap();
        ks.start(Box::new(NoHooks)).unwrap();
        ks
    };
    let mut ks = open(&dir);
    let mut model: Model = BTreeMap::new();
    let mut end = 0u64;
    // Snapshots held across later writes, each with the model as it was.
    for step in 0..steps {
        let at = format!("seed {seed}{} step {step}", if sim { " (simulated)" } else { "" });
        if sim {
            // Background work between operations: a few of the queued steps, picked by the executor's seed.
            for _ in 0..rng.below(6) {
                ks.pool().exec.pump();
            }
        }
        match rng.below(100) {
            0..=54 => {
                let n = match rng.below(10) {
                    0 => 50 + rng.below(400),
                    _ => 1 + rng.below(8),
                };
                let mut batch = Vec::new();
                for _ in 0..n {
                    // Several writes of one key in a commit go in one insert, oldest first, as a commit's do.
                    let i = rng_key(&mut rng, keys);
                    batch.push(write(&mut rng, &mut model, i));
                }
                end += 1;
                insert_batch(&ks, batch, end);
            }
            55..=84 => {
                let expect = model_bytes(&model);
                let k = &*ks;
                check_read(
                    &mut rng,
                    keys,
                    &expect,
                    &|key| k.get(key).unwrap(),
                    &|s, e, n| k.scan(s, e, n).unwrap(),
                    &|s, e, n| bytes_of(k.scan_vals_rev(s, e, n).unwrap()),
                    &at,
                );
            }
            85..=87 => {
                // Churn over a window of keys past the written ones: each written, then undone by a later insert of
                // the same commit (a map's slot set then removed, counts added then taken back, a value put then
                // deleted), so the buffer holds entries that settle to nothing where the runs may hold nothing.
                // Never-used keys, so no run holds anything in the window.
                let from = FRESH + fresh;
                let n = 1 + rng.below(120);
                fresh += n;
                let (mut first, mut undo) = (Vec::new(), Vec::new());
                for i in from..from + n {
                    if rng.chance(5) {
                        // A live value among the undone ones, which a short page must not hide.
                        let (k, v) = write(&mut rng, &mut model, i);
                        undo.push((k, v));
                        continue;
                    }
                    let s = rng.below(12) as u32;
                    let (a, b) = match family(i) {
                        Family::SetMap => (
                            Val::Map(vec![(s, 1 + rng.below(9) as u32)]),
                            Val::Map(vec![(s, 0)]),
                        ),
                        Family::AddMap => {
                            let d = 1 + rng.below(9) as i64;
                            (Val::AddMap(vec![(s, d)]), Val::AddMap(vec![(s, -d)]))
                        }
                        _ => (Val::Put(vec![1, 2, 3]), Val::Del),
                    };
                    if model.contains_key(&key(i)) {
                        // Live from an earlier churn: undoing would read as an edit the model doesn't know.
                        continue;
                    }
                    first.push((key(i), a));
                    undo.push((key(i), b));
                }
                end += 1;
                wait_for_room(ks.pool());
                ks.insert(first, None);
                wait_for_room(ks.pool());
                ks.insert(undo, Some((end, 1)));
                // Short pages over the window, before a flush takes it into a run.
                let expect = model_bytes(&model);
                for _ in 0..4 {
                    let (s, e) = (
                        key(from + rng.below(n)),
                        if rng.chance(2) {
                            vec![8]
                        } else {
                            key(from + n)
                        },
                    );
                    let limit = 1 + rng.below(12) as usize;
                    let want: Vec<_> = expect
                        .range(s.clone()..e.clone())
                        .take(limit)
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    assert_eq!(
                        ks.scan(&s, &e, limit).unwrap(),
                        want,
                        "{at}: churn page {s:?}..{e:?} limit {limit}"
                    );
                    let want: Vec<_> = expect
                        .range(key(from)..s.clone())
                        .rev()
                        .take(limit)
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    assert_eq!(
                        bytes_of(ks.scan_vals_rev(&key(from), &s, limit).unwrap()),
                        want,
                        "{at}: churn page down to {s:?} limit {limit}"
                    );
                }
            }
            88..=89 => {
                // A snapshot, then writes, then reads through the snapshot see the state of then.
                let expect = model_bytes(&model);
                let snap = ks.snapshot();
                let mut later = model.clone();
                let writes = 1 + rng.below(30);
                let mut batch = Vec::new();
                for _ in 0..writes {
                    let i = rng_key(&mut rng, keys);
                    batch.push(write(&mut rng, &mut later, i));
                }
                end += 1;
                insert_batch(&ks, batch, end);
                model = later;
                if rng.chance(2) {
                    ks.freeze_at(end);
                }
                for _ in 0..1 + rng.below(4) {
                    check_read(
                        &mut rng,
                        keys,
                        &expect,
                        &|key| snap.get_val(key).unwrap().map(|v| v.into_bytes(key)),
                        &|s, e, n| bytes_of(snap.scan_vals(s, e, n).unwrap()),
                        &|s, e, n| bytes_of(snap.scan_vals_rev(s, e, n).unwrap()),
                        &format!("{at} (snapshot)"),
                    );
                }
            }
            90..=94 => {
                ks.freeze_at(end);
                if rng.chance(2) {
                    ks.wait_flushed().unwrap();
                }
                if rng.chance(3) {
                    ks.wait_merged();
                }
            }
            95..=97 => {
                ks.freeze_at(end);
                ks.wait_flushed().unwrap();
                ks.wait_merged();
                let expect = model_bytes(&model);
                assert_eq!(
                    ks.scan(&[7], &[8], usize::MAX).unwrap(),
                    expect.clone().into_iter().collect::<Vec<_>>(),
                    "{at}: all, settled"
                );
            }
            _ => {
                // Reopen: what the runs hold is all there is (a store replays its log tail; this keyspace has
                // none, so everything is flushed first).
                ks.freeze_at(end);
                ks.wait_flushed().unwrap();
                ks.stop();
                sim_steps += ks.pool().exec.sim_steps();
                drop(ks);
                ks = open(&dir);
                assert_eq!(ks.covered(), end, "{at}: covered after reopen");
            }
        }
    }
    let expect = model_bytes(&model);
    let all = ks.scan(&[7], &[8], usize::MAX).unwrap();
    assert_eq!(
        all,
        expect.into_iter().collect::<Vec<_>>(),
        "seed {seed}: all at the end"
    );
    ks.stop();
    sim_steps += ks.pool().exec.sim_steps();
    drop(ks);
    let _ = fs::remove_dir_all(&dir);
    (sim_steps, all)
}

/// A commit's writes, oldest first, as inserts each holding a key at most once (a later write of a key goes in a
/// later insert), the last carrying the commit's log end. No fold here: the keyspace's own folding is what is
/// under test.
fn insert_batch(ks: &Keyspace, batch: Vec<(Vec<u8>, Val)>, end: u64) {
    let mut groups: Vec<Vec<(Vec<u8>, Val)>> = Vec::new();
    let mut seen: Vec<std::collections::BTreeSet<Vec<u8>>> = Vec::new();
    let mut last_group: BTreeMap<Vec<u8>, usize> = BTreeMap::new();
    for (k, v) in batch {
        let g = last_group.get(&k).map_or(0, |g| g + 1);
        if groups.len() <= g {
            groups.push(Vec::new());
            seen.push(Default::default());
        }
        seen[g].insert(k.clone());
        last_group.insert(k.clone(), g);
        groups[g].push((k, v));
    }
    let n = groups.len();
    for (i, mut g) in groups.into_iter().enumerate() {
        g.sort_by(|a, b| a.0.cmp(&b.0));
        wait_for_room(ks.pool());
        ks.insert(g, (i + 1 == n).then_some((end, 1)));
    }
}

/// How far past `FRESH` random reads reach (churn has used a few thousand keys there by the end of a seed).
const CHURN: u64 = 4000;
/// Where never-used keys for churn start: past every key the other writes use.
const FRESH: u64 = 1 << 40;

/// A key, skewed so some keys get many writes.
fn rng_key(rng: &mut Rng, keys: u64) -> u64 {
    if rng.chance(3) {
        rng.below(keys.min(12))
    } else {
        rng.below(keys)
    }
}

/// A small per-seed variation of the buffer size, so flushes come at different points.
fn rng_free(seed: u64) -> usize {
    (seed % 4) as usize
}

fn seeds() -> Vec<u64> {
    if let Ok(s) = std::env::var("ST_MODEL_SEED") {
        return vec![s.parse().expect("ST_MODEL_SEED is a number")];
    }
    let n: u64 = std::env::var("ST_MODEL_SEEDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(12);
    let base: u64 = std::env::var("ST_MODEL_BASE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    (base..base + n).collect()
}

#[test]
fn random_writes_flushes_merges_and_reopens_read_as_the_model_says() {
    let steps: u64 = std::env::var("ST_MODEL_STEPS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1500);
    for seed in seeds() {
        run_seed(seed, steps, false);
    }
}

#[test]
fn random_writes_flushes_merges_and_reopens_read_as_the_model_says_in_every_simulated_interleaving() {
    let steps: u64 = std::env::var("ST_MODEL_STEPS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1500);
    for seed in seeds() {
        run_seed(seed, steps, true);
    }
}

#[test]
fn a_simulated_seed_replays_exactly() {
    for seed in [3, 11] {
        let a = run_seed(seed, 400, true);
        let b = run_seed(seed, 400, true);
        assert!(a.0 > 0, "seed {seed}: no background step ran");
        assert_eq!(a, b, "seed {seed}: two runs of one seed differ");
    }
}
