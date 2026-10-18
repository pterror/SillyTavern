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
            .map(|(k, v)| {
                let b = v.into_bytes(&k);
                (k, b)
            })
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
            .map(|(k, v)| {
                let b = v.into_bytes(&k);
                (k, b)
            })
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
        .map(|(k, v)| {
            let b = v.into_bytes(&k);
            (k, b)
        })
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
fn a_merge_runs_as_many_steps_reads_see_through_it_and_a_stop_part_way_leaves_nothing() {
    let dir = temp_dir("steps");
    let ks = open(&dir);
    let mut model = BTreeMap::new();
    let mut end = 0;
    // Until a merge is seen part way, everything flushed: its entries hold several 4 KB steps.
    let mut seen = false;
    for _ in 0..40 {
        load(&ks, 1500, &mut model, &mut end);
        ks.freeze_at(end);
        ks.wait_flushed().unwrap();
        if !ks.merging.lock().unwrap().is_empty() {
            seen = true;
            check(&ks, &model);
            break;
        }
    }
    assert!(seen, "no merge was under way between steps");
    ks.stop();
    assert!(ks.merging.lock().unwrap().is_empty());
    drop(ks);
    let tmps = fs::read_dir(&dir)
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        })
        .count();
    assert_eq!(tmps, 0, "a stopped merge left its partial run");
    // Reopened, the abandoned merge's inputs hold everything; the merge is started again and finishes.
    let ks = open(&dir);
    assert_eq!(ks.covered(), end);
    check(&ks, &model);
    ks.wait_merged();
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
fn a_narrow_page_down_reads_few_blocks_in_each_run() {
    let dir = temp_dir("rev-bound");
    let ks = open_with(
        &dir,
        KsConfig {
            block_size: 4096,
            ..SMALL
        },
    );
    // Even keys only, in a scattered order so every run spans the whole range: odd keys are gaps.
    let n = 20_000u64;
    let mut model = BTreeMap::new();
    let mut end = 0;
    for i in 0..n {
        let k = key(2 * (i * 7919 % n));
        end += 1;
        wait_for_room(ks.pool());
        ks.insert([(k.clone(), Val::Put(vec![2; 9]))], Some((end, 1)));
        model.insert(k, vec![2; 9]);
    }
    ks.freeze_at(end);
    ks.wait_flushed().unwrap();
    let runs = ks.stats().runs;
    assert!(runs > 1);
    for a in (0..2 * n).step_by(997) {
        for (lo, hi, limit) in [(a, a + 1, 1), (a, a + 6, 2), (a + 1, a + 2, 1), (a, a + 40, usize::MAX)] {
            let blocks = ks.stats().blocks;
            let got: Vec<_> = ks
                .scan_vals_rev(&key(lo), &key(hi), limit)
                .unwrap()
                .into_iter()
                .map(|(k, v)| {
                    let b = v.into_bytes(&k);
                    (k, b)
                })
                .collect();
            let read = ks.stats().blocks - blocks;
            let expect: Vec<_> = model
                .range(key(lo)..key(hi))
                .rev()
                .take(limit)
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            assert_eq!(got, expect, "[{lo}, {hi})");
            // Each run: its index levels below the top and the data blocks the range touches.
            assert!(read <= 4 * runs, "[{lo}, {hi}): {read} blocks over {runs} runs");
        }
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
            let one = val::fold(k, ks.values(k).unwrap()).and_then(|v| v.resolved(k));
            assert_eq!(
                val::fold(k, together[i].clone()).and_then(|v| v.resolved(k)),
                one,
                "key {i}"
            );
            assert_eq!(
                val::fold(k, snap[i].clone()).and_then(|v| v.resolved(k)),
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

#[test]
fn an_older_buffers_page_reaches_past_the_entries_a_newer_buffer_hides() {
    let mut older = Mem::default();
    let mut newer = Mem::default();
    for i in [1, 2] {
        older.insert(&key(i), Val::Put(vec![i as u8]), 1, &mem::Readers(&[]));
    }
    newer.insert(&key(2), Val::Del, 2, &mem::Readers(&[]));
    let mems = vec![Arc::new(RwLock::new(newer)), Arc::new(RwLock::new(older))];
    let (start, end) = (key(0), key(9));
    // The newest key is deleted: one live entry of the older buffer must still be in its page, in both directions.
    let rev = buffer_pages(&mems, &start, &end, 1, None, |m, n| {
        m.page_rev(&start, &end, n, None)
    });
    let mut merge = run::MergeRev::new(
        rev.into_iter()
            .map(|(p, _)| Box::new(run::VecSource::new(p)) as Box<dyn run::Source>)
            .collect(),
    );
    let mut live = Vec::new();
    while let Some((k, v)) = merge.next_entry().unwrap() {
        if v.settled(&k).is_some() {
            live.push(k);
            break;
        }
    }
    assert_eq!(live, vec![key(1)]);
    let fwd = buffer_pages(&mems, &start, &end, 1, None, |m, n| m.page(&start, &end, n));
    let mut older_page_keys: Vec<_> = fwd[1].0.iter().map(|(k, _)| k.clone()).collect();
    older_page_keys.sort();
    assert_eq!(older_page_keys, vec![key(1), key(2)]);
}

#[test]
fn a_seek_ahead_lands_where_a_fresh_iterator_starts() {
    use run::{Merge, Run, RunIter, RunWriter, Source};
    let dir = temp_dir("seek");
    fs::create_dir_all(&dir).unwrap();
    let key = |i: u32| format!("k{i:06}").into_bytes();
    // Two runs, every third key in both: blocks of 256 bytes give each several index levels.
    let mut runs = Vec::new();
    for (r, keep) in [|i: u32| i % 3 != 1, |i: u32| i % 3 != 2].into_iter().enumerate() {
        let path = dir.join(format!("{r}.run"));
        let mut w = RunWriter::create(&path, 256).unwrap();
        for i in (0..6000).filter(|&i| keep(i)) {
            w.add(&key(i), &val::Val::Add(1)).unwrap();
        }
        w.finish(0, 0, 0).unwrap();
        runs.push(Arc::new(Run::open(&path, 0, 0).unwrap()));
    }
    for stride in [1u32, 2, 7, 40, 333, 2500] {
        let mut it = RunIter::new(runs[0].clone(), &key(0), None, None).unwrap();
        let mut m = Merge::new(
            runs.iter()
                .map(|r| -> Box<dyn Source> {
                    Box::new(RunIter::new(r.clone(), &key(0), None, None).unwrap())
                })
                .collect(),
        );
        let mut t = 0;
        while t < 6100 {
            let target = key(t);
            it.seek(&target).unwrap();
            let fresh = RunIter::new(runs[0].clone(), &target, None, None).unwrap();
            assert_eq!(it.key(), fresh.key(), "stride {stride} target {t}");
            m.seek(&target).unwrap();
            let want = (t..6000).next().map(key);
            assert_eq!(m.peek().map(<[u8]>::to_vec), want, "stride {stride} target {t}");
            if let Some((k, v)) = m.next_entry().unwrap() {
                assert_eq!(k, key(t));
                let both = t % 3 == 0;
                assert_eq!(v, val::Val::Add(if both { 2 } else { 1 }));
            }
            t += stride;
        }
        it.seek(&key(6100)).unwrap();
        assert_eq!(it.key(), None);
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn added_maps_survive_flushes_merges_and_a_reopen() {
    let dir = temp_dir("addmap");
    let ks = open(&dir);
    let mut model: BTreeMap<Vec<u8>, BTreeMap<u32, u32>> = BTreeMap::new();
    let mut end = 0;
    let check = |ks: &Keyspace, model: &BTreeMap<Vec<u8>, BTreeMap<u32, u32>>| {
        for i in 0..40 {
            let k = key(i);
            let want: Vec<(u32, u32)> = model
                .get(&k)
                .map(|m| m.iter().map(|(&s, &n)| (s, n)).collect())
                .unwrap_or_default();
            let got = ks.get_val(&k).unwrap().and_then(|v| v.into_pairs(&k));
            assert_eq!(got.unwrap_or_default(), want, "key {i}");
            let bytes = ks.get(&k).unwrap();
            assert_eq!(
                bytes,
                (!want.is_empty()).then(|| val::map_bytes(&want)),
                "key {i}"
            );
        }
    };
    for round in 0..8u64 {
        for i in 0..1500u64 {
            let n = round * 1500 + i;
            let k = key(n * 7919 % 40);
            let slot = (n * 104729 % 64) as u32;
            let m = model.entry(k.clone()).or_default();
            let v = if n % 97 == 0 {
                m.clear();
                Val::Del
            } else {
                let have = m.get(&slot).copied().unwrap_or(0);
                // Down by 1 or to 0 when there is something to take, else up.
                let d: i32 = match (have, n % 3) {
                    (0, _) => (n % 4 + 1) as i32,
                    (h, 0) => -(h as i32),
                    (_, 1) => -1,
                    _ => 2,
                };
                let next = (i64::from(have) + i64::from(d)) as u32;
                if next == 0 {
                    m.remove(&slot);
                } else {
                    m.insert(slot, next);
                }
                Val::AddMap(vec![(slot, i64::from(d))])
            };
            end += 1;
            wait_for_room(ks.pool());
            ks.insert([(k, v)], Some((end, 1)));
        }
        check(&ks, &model);
        ks.freeze_at(end);
        ks.wait_flushed().unwrap();
    }
    ks.wait_merged();
    let s = ks.stats();
    assert!(s.merges > 0, "{s:?}");
    check(&ks, &model);
    ks.stop();
    drop(ks);
    // Reopened, every map is read back from the runs alone.
    let ks = open(&dir);
    check(&ks, &model);
    drop(ks);
    fs::remove_dir_all(&dir).unwrap();
}

/// A buffer's map entries that remove every slot fill its page without giving a scan anything: the scan reads on
/// past the page, and never shows a run's map those entries removed.
#[test]
fn removed_maps_in_a_buffer_hide_a_runs_maps_past_a_page_in_every_scan() {
    let dir = temp_dir("removed-maps");
    let ks = open(&dir);
    let mut end = 0;
    for i in 0..40u64 {
        end += 1;
        ks.insert(
            [(key(i), Val::Put(val::map_bytes(&[(1, 1), (2, 1)])))],
            Some((end, 1)),
        );
    }
    ks.freeze_at(end);
    ks.wait_flushed().unwrap();
    let (lo, hi) = (key(0), key(40));
    let scans = |ks: &Keyspace, from: &[u8], to: &[u8], n: usize| {
        let names = |v: Vec<(Vec<u8>, Val)>| v.into_iter().map(|(k, _)| k).collect::<Vec<_>>();
        let snap = ks.snapshot();
        (
            names(ks.scan_vals(from, to, n).unwrap()),
            names(ks.scan_vals_rev(from, to, n).unwrap()),
            names(snap.scan_vals(from, to, n).unwrap()),
            names(snap.scan_vals_rev(from, to, n).unwrap()),
        )
    };
    // Every map removed: nothing, at any page size.
    for i in 0..40u64 {
        end += 1;
        ks.insert([(key(i), Val::Map(vec![(1, 0), (2, 0)]))], Some((end, 1)));
    }
    for n in [1, 3, 16, 100] {
        let (f, r, sf, sr) = scans(&ks, &lo, &hi, n);
        assert!(
            f.is_empty() && r.is_empty() && sf.is_empty() && sr.is_empty(),
            "{n}"
        );
    }
    // Every fifth one back: exactly those, a page at a time, both ways and through a snapshot.
    for i in (0..40u64).step_by(5) {
        end += 1;
        ks.insert([(key(i), Val::Map(vec![(2, 3)]))], Some((end, 1)));
    }
    let live: Vec<Vec<u8>> = (0..40u64).step_by(5).map(key).collect();
    for n in [1, 2, 3, 7, 8, 100] {
        for from in [0u64, 1, 5, 17, 39] {
            let want: Vec<Vec<u8>> = live
                .iter()
                .filter(|k| **k >= key(from))
                .take(n)
                .cloned()
                .collect();
            let want_rev: Vec<Vec<u8>> = live
                .iter()
                .rev()
                .filter(|k| **k < key(from + 1))
                .take(n)
                .cloned()
                .collect();
            let (f, _, sf, _) = scans(&ks, &key(from), &hi, n);
            let (_, r, _, sr) = scans(&ks, &lo, &key(from + 1), n);
            assert_eq!(f, want, "forward {n} from {from}");
            assert_eq!(sf, want, "snapshot forward {n} from {from}");
            assert_eq!(r, want_rev, "reverse {n} to {from}");
            assert_eq!(sr, want_rev, "snapshot reverse {n} to {from}");
        }
    }
    ks.stop();
    drop(ks);
    let _ = fs::remove_dir_all(&dir);
}

/// A buffer's entries that settle to nothing (maps removing slots they never had, as a carrier move's added maps
/// cancelling out leave) fill its page without giving a scan anything, so the page is cut short of the scan's
/// limit. Past the page's last key its buffer is unread: the scan reads it again from there whatever the runs hold
/// beyond that key, whether nothing in either direction or only keys outside the range. A scan gives fewer than its
/// limit only when the range holds no more.
#[test]
fn a_scan_reads_on_past_a_buffers_cut_page_whatever_the_runs_hold_beyond_it() {
    // The run's keys, all outside the ranges scanned: past their ends, below their starts, or both.
    for outside in [&[100u64][..], &[0, 1], &[0, 1, 100]] {
        let dir = temp_dir("short-page");
        let ks = open(&dir);
        let mut end = 0;
        for &i in outside {
            end += 1;
            ks.insert([(key(i), Val::Put(vec![1]))], Some((end, 1)));
        }
        ks.freeze_at(end);
        ks.wait_flushed().unwrap();
        // In the buffer: from key 10 on, a map that settles to nothing before each live one.
        let mut live = Vec::new();
        for i in 10..50u64 {
            end += 1;
            let v = if i % 2 == 0 {
                Val::Map(vec![(1, 0)])
            } else {
                live.push(key(i));
                Val::Map(vec![(2, 3)])
            };
            ks.insert([(key(i), v)], Some((end, 1)));
        }
        let names = |v: Vec<(Vec<u8>, Val)>| v.into_iter().map(|(k, _)| k).collect::<Vec<_>>();
        let (lo, hi) = (key(5), key(60));
        for n in [1, 2, 3, 4, 7, 8, 100] {
            for from in [5u64, 10, 11, 12, 30, 49] {
                let want: Vec<Vec<u8>> = live
                    .iter()
                    .filter(|k| **k >= key(from))
                    .take(n)
                    .cloned()
                    .collect();
                let want_rev: Vec<Vec<u8>> = live
                    .iter()
                    .rev()
                    .filter(|k| **k < key(from + 1))
                    .take(n)
                    .cloned()
                    .collect();
                let snap = ks.snapshot();
                let (f, sf) = (
                    names(ks.scan_vals(&key(from), &hi, n).unwrap()),
                    names(snap.scan_vals(&key(from), &hi, n).unwrap()),
                );
                let (r, sr) = (
                    names(ks.scan_vals_rev(&lo, &key(from + 1), n).unwrap()),
                    names(snap.scan_vals_rev(&lo, &key(from + 1), n).unwrap()),
                );
                let at = format!("{n} from {from}, run {outside:?}");
                assert_eq!(f, want, "forward {at}");
                assert_eq!(sf, want, "snapshot forward {at}");
                assert_eq!(r, want_rev, "reverse {at}");
                assert_eq!(sr, want_rev, "snapshot reverse {at}");
            }
        }
        ks.stop();
        drop(ks);
        let _ = fs::remove_dir_all(&dir);
    }
}
