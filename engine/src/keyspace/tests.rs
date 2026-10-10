use std::collections::BTreeMap;
use std::sync::atomic::AtomicU64;

use super::val::{counter_bytes, put_u64};
use super::*;

pub fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-ks-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    dir
}

const SMALL: KsConfig = KsConfig {
    log_bytes: u64::MAX,
    fan_in: 3,
    block_size: 256,
    max_frozen: 2,
};

fn small_pool() -> Arc<Pool> {
    Pool::new(16 << 10, 64 << 10, 4, 1, 2, 2)
}

struct NoHooks;

impl Hooks for NoHooks {
    fn flush_extra(&self, _: &Keyspace, _: &Mem, _: &[Arc<Run>]) -> KsResult<Vec<(Vec<u8>, Val)>> {
        Ok(Vec::new())
    }
    fn flushed(&self, _: &Keyspace) {}
}

fn open_with(dir: &Path, cfg: KsConfig) -> Arc<Keyspace> {
    let ks = Keyspace::open(dir, cfg, small_pool()).unwrap();
    ks.start(Box::new(NoHooks)).unwrap();
    ks
}

fn open(dir: &Path) -> Arc<Keyspace> {
    open_with(dir, SMALL)
}

fn key(i: u64) -> Vec<u8> {
    let mut k = vec![7];
    put_u64(&mut k, i);
    k
}

/// As a store's sync step does: publish only once the pool has room.
fn wait_for_room(pool: &Pool) {
    loop {
        let (active, frozen) = pool.buffered();
        if active + frozen < 2 * pool.buffer_bytes as u64 {
            return;
        }
        pool.request_room();
        std::thread::sleep(std::time::Duration::from_micros(100));
    }
}

/// A deterministic stream of puts, deletes and counter adds over 2000 keys; returns the model of what every
/// key holds after it.
fn load(ks: &Keyspace, n: u64, model: &mut BTreeMap<Vec<u8>, Vec<u8>>, end: &mut u64) {
    for i in 0..n {
        let k = key(i * 7919 % 2000);
        let (v, m) = match i % 5 {
            0 => (Val::Del, None),
            // An add only onto a counter or nothing.
            1 => match model.get(&k) {
                Some(b) if val::counter_value(b).is_none() => {
                    let b = i.to_le_bytes().to_vec();
                    (Val::Put(b.clone()), Some(b))
                }
                other => {
                    let base = other.and_then(|b| val::counter_value(b)).unwrap_or(0);
                    (Val::Add(3), Some(counter_bytes(base + 3)))
                }
            },
            _ => {
                let b = format!("value {i} {}", "x".repeat((i % 40) as usize)).into_bytes();
                (Val::Put(b.clone()), Some(b))
            }
        };
        match m {
            Some(b) => model.insert(k.clone(), b),
            None => model.remove(&k),
        };
        *end += 1;
        wait_for_room(ks.pool());
        ks.insert([(k, v)], Some((*end, 1)));
    }
}

fn check(ks: &Keyspace, model: &BTreeMap<Vec<u8>, Vec<u8>>) {
    for i in 0..2000 {
        assert_eq!(
            ks.get(&key(i)).unwrap().as_ref(),
            model.get(&key(i)),
            "key {i}"
        );
    }
    let all = ks.scan(&key(0), &[8], usize::MAX).unwrap();
    let expect: Vec<(Vec<u8>, Vec<u8>)> = model.clone().into_iter().collect();
    assert_eq!(all, expect);
    // Pages from every 97th key.
    for i in (0..2000).step_by(97) {
        let page = ks.scan(&key(i), &[8], 10).unwrap();
        let expect: Vec<_> = model
            .range(key(i)..)
            .take(10)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        assert_eq!(page, expect, "page from {i}");
        let rev: Vec<_> = ks
            .scan_vals_rev(&key(0), &key(i), 10)
            .unwrap()
            .into_iter()
            .map(|(k, v)| (k, v.into_bytes()))
            .collect();
        let expect: Vec<_> = model
            .range(..key(i))
            .rev()
            .take(10)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        assert_eq!(rev, expect, "page down from {i}");
        let snap: Vec<_> = ks
            .snapshot()
            .scan_vals_rev(&key(i), &[8], 7)
            .unwrap()
            .into_iter()
            .map(|(k, v)| (k, v.into_bytes()))
            .collect();
        let expect: Vec<_> = model
            .range(key(i)..)
            .rev()
            .take(7)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        assert_eq!(snap, expect, "snapshot page down to {i}");
    }
    let all: Vec<_> = ks
        .scan_vals_rev(&key(0), &[8], usize::MAX)
        .unwrap()
        .into_iter()
        .map(|(k, v)| (k, v.into_bytes()))
        .collect();
    let expect: Vec<_> = model.clone().into_iter().rev().collect();
    assert_eq!(all, expect);
}

#[test]
fn reads_merge_buffers_and_runs_through_flushes_and_merges() {
    let dir = temp_dir("rw");
    let ks = open(&dir);
    let mut model = BTreeMap::new();
    let mut end = 0;
    for _ in 0..6 {
        load(&ks, 3000, &mut model, &mut end);
        check(&ks, &model);
    }
    ks.freeze_at(end);
    ks.wait_flushed().unwrap();
    ks.wait_merged();
    let s = ks.stats();
    assert!(s.flushes > 10 && s.merges > 3, "{s:?}");
    assert!(s.runs < 12, "{s:?}");
    check(&ks, &model);
    assert_eq!(ks.covered(), end);
    ks.stop();
    drop(ks);
    // Reopened, every value is read back from the runs alone.
    let ks = open(&dir);
    assert_eq!(ks.covered(), end);
    check(&ks, &model);
    drop(ks);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn runs_left_over_from_a_merge_and_unfinished_runs_are_removed_on_open() {
    let dir = temp_dir("leftover");
    let ks = open(&dir);
    let mut model = BTreeMap::new();
    let mut end = 0;
    load(&ks, 3000, &mut model, &mut end);
    ks.freeze_at(end);
    ks.wait_flushed().unwrap();
    ks.wait_merged();
    let runs: Vec<(u64, u64)> = ks.version().runs.iter().map(|r| (r.lo, r.hi)).collect();
    ks.stop();
    drop(ks);
    let (lo, hi) = *runs.iter().find(|(lo, hi)| hi > lo).unwrap();
    // As if the merge's inputs hadn't been removed yet, and a write was cut off.
    for i in lo..=hi {
        fs::write(dir.join(run_name(i, i)), b"anything").unwrap();
    }
    fs::write(
        dir.join("run-0000000000000009-0000000000000009.tmp"),
        b"half",
    )
    .unwrap();
    // Merges off: tiers are reckoned again after a reopen, so a merge could otherwise follow.
    let ks = open_with(
        &dir,
        KsConfig {
            fan_in: 1000,
            ..SMALL
        },
    );
    check(&ks, &model);
    let mut names: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    let mut expect: Vec<String> = runs.iter().map(|&(lo, hi)| run_name(lo, hi)).collect();
    expect.sort();
    assert_eq!(names, expect);
    drop(ks);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_missing_or_damaged_run_refuses_to_open() {
    let dir = temp_dir("damaged");
    // Nothing merges: the runs stay one per flush.
    let unmerged = KsConfig {
        fan_in: 1000,
        ..SMALL
    };
    let ks = open_with(&dir, unmerged);
    let mut model = BTreeMap::new();
    let mut end = 0;
    load(&ks, 1500, &mut model, &mut end);
    ks.freeze_at(end);
    ks.wait_flushed().unwrap();
    ks.stop();
    drop(ks);
    let mut names: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    names.sort();
    assert!(names.len() >= 3);
    // Damage in a footer or top block is found on open; in another block, by the read that fetches it.
    let original = fs::read(&names[0]).unwrap();
    for i in [original.len() - 10, original.len() - 70] {
        let mut d = original.clone();
        d[i] ^= 1;
        fs::write(&names[0], &d).unwrap();
        assert!(
            matches!(
                Keyspace::open(&dir, SMALL, small_pool()),
                Err(KsError::Corrupt { .. })
            ),
            "byte {i}"
        );
    }
    let mut d = original.clone();
    d[3] ^= 1;
    fs::write(&names[0], &d).unwrap();
    let ks = Keyspace::open(&dir, SMALL, small_pool()).unwrap();
    let r = (0..2000).try_for_each(|i| ks.get(&key(i)).map(drop));
    assert!(matches!(r, Err(KsError::Corrupt { .. })));
    drop(ks);
    fs::write(&names[0], &original).unwrap();
    fs::remove_file(&names[1]).unwrap();
    let err = Keyspace::open(&dir, SMALL, small_pool()).err().unwrap();
    assert!(err.to_string().contains("are in no run"), "{err}");
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn keyspaces_sharing_a_pool_stay_within_its_budget_together() {
    let pool = Pool::new(16 << 10, 64 << 10, 4, 1, 2, 2);
    let dirs: Vec<PathBuf> = (0..8).map(|i| temp_dir(&format!("pool{i}"))).collect();
    let all: Vec<Arc<Keyspace>> = dirs
        .iter()
        .map(|d| {
            let ks = Keyspace::open(d, SMALL, pool.clone()).unwrap();
            ks.start(Box::new(NoHooks)).unwrap();
            ks
        })
        .collect();
    let mut models = vec![BTreeMap::new(); all.len()];
    let mut ends = vec![0; all.len()];
    let mut peak = 0;
    for round in 0..40 {
        for (i, ks) in all.iter().enumerate() {
            // Uneven load: some keyspaces take far more than others.
            load(
                ks,
                20 + (i as u64 * 37 + round) % 200,
                &mut models[i],
                &mut ends[i],
            );
            let (active, frozen) = pool.buffered();
            peak = peak.max(active + frozen);
        }
    }
    // A batch of inserts may pass 2B by its own entries (in a new chunk) before the next waits.
    assert!(peak <= 2 * (16 << 10) + 64 * 1024, "peak {peak}");
    for (ks, model) in all.iter().zip(&models) {
        check(ks, model);
        assert!(ks.stats().flushes > 0);
    }
    for ks in &all {
        ks.stop();
    }
    drop(all);
    assert_eq!(pool.buffered(), (0, 0));
    for d in dirs {
        fs::remove_dir_all(d).unwrap();
    }
}

#[test]
fn a_range_estimate_reads_few_blocks_and_comes_near_the_count() {
    let dir = temp_dir("estimate");
    let ks = open_with(
        &dir,
        KsConfig {
            block_size: 4096,
            ..SMALL
        },
    );
    let n = 40_000u64;
    let mut end = 0;
    // Keys in a scattered order, so runs of every flush overlap; a buffer left unflushed holds some too.
    for i in 0..n {
        end += 1;
        wait_for_room(ks.pool());
        ks.insert([(key(i * 7919 % n), Val::Put(vec![1; 9]))], Some((end, 1)));
    }
    ks.freeze_at(end);
    ks.wait_flushed().unwrap();
    for i in n..n + 500 {
        end += 1;
        ks.insert([(key(i), Val::Put(vec![1; 9]))], Some((end, 1)));
    }
    assert!(ks.stats().runs > 1);
    for (a, b) in [
        (0, n + 500),
        (100, 101),
        (1000, 1300),
        (5000, 21_000),
        (39_000, 40_200),
        (n + 600, n + 700),
    ] {
        let exact = (b.min(n + 500) - a.min(n + 500)) as f64;
        let blocks = ks.stats().blocks;
        let est = ks.estimate(&key(a), &key(b)).unwrap();
        let read = ks.stats().blocks - blocks;
        assert!(
            (est - exact).abs() <= exact * 0.05 + 10.0,
            "[{a}, {b}): {est} for {exact}"
        );
        assert!(read <= 4 * 6 * ks.stats().runs, "[{a}, {b}): {read} blocks");
        assert_eq!(ks.snapshot().estimate(&key(a), &key(b)).unwrap(), est);
    }
    ks.stop();
    drop(ks);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn sorted_reads_give_each_key_what_a_read_of_it_gives() {
    let dir = temp_dir("sorted");
    let ks = open(&dir);
    let mut model = BTreeMap::new();
    let mut end = 0;
    for round in 0..4 {
        load(&ks, 3000, &mut model, &mut end);
        if round == 2 {
            ks.freeze_at(end);
            ks.wait_flushed().unwrap();
        }
        let keys: Vec<Vec<u8>> = (0..2100).step_by(3).map(key).collect();
        let refs: Vec<&[u8]> = keys.iter().map(Vec::as_slice).collect();
        let together = ks.values_sorted(&refs).unwrap();
        let snap = ks.snapshot().values_sorted(&refs).unwrap();
        for (i, k) in keys.iter().enumerate() {
            let one = val::fold(ks.values(k).unwrap()).and_then(Val::resolved);
            assert_eq!(
                val::fold(together[i].clone()).and_then(Val::resolved),
                one,
                "key {i}"
            );
            assert_eq!(
                val::fold(snap[i].clone()).and_then(Val::resolved),
                one,
                "snapshot key {i}"
            );
            assert_eq!(one.as_ref(), model.get(k));
        }
    }
    ks.stop();
    drop(ks);
    fs::remove_dir_all(&dir).unwrap();
}
