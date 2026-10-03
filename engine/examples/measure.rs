//! Measures a store against the design's bounds table (`.plans/2026-10-03-storage-from-needs.md` 4.3) on the
//! test kind `testSet`, whose deriver keeps two entries per id (its current value and its place in an order by
//! key) and a count.
//!
//!   cargo run --release --features measure --example measure -- run <dir> <entries>
//!     loads entries/2 ids, reads, updates every id once (so half the log is dead and cleaning runs), reads
//!     again, closes and reopens; prints one JSON object per phase.
//!   cargo run --release --features measure --example measure -- crash <dir> <rounds>
//!     on a store `run` made: a child process commits updates under load and is killed with SIGKILL at a random
//!     moment; the store is reopened and every commit the child saw acknowledged is checked to be readable.
//!   cargo run --release --features measure --example measure -- calibrate <dir>
//!     the memory a buffer of `testSet`'s entries takes, against the bytes it counts toward B.
//! Linux only (`/proc/self/status`). The constants can be overridden from the environment (`config`).

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use st_engine::keyspace::val::get_u64;
use st_engine::log::format::{Record, Value, kind_by_name};
use st_engine::store::kinds::{key, parse_loc};
use st_engine::store::{Store, StoreConfig, StoreStats};

const BATCH: u64 = 1000;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
}

fn set(id: u64, k: u64) -> Record {
    Record::new(
        kind_by_name("testSet").unwrap(),
        vec![
            Value::Id(id),
            Value::UInt(k),
            Value::Bytes(id.to_le_bytes().to_vec()),
        ],
    )
    .unwrap()
}

fn proc_kb(field: &str) -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .unwrap()
        .lines()
        .find_map(|l| l.strip_prefix(field))
        .and_then(|v| v.trim().trim_end_matches(" kB").trim().parse().ok())
        .unwrap_or(0)
}

/// Bytes a directory's files take on disk (holes excluded), and their sizes.
fn disk(dir: &Path) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    let (mut used, mut size) = (0, 0);
    for e in std::fs::read_dir(dir).unwrap() {
        let m = e.unwrap().metadata().unwrap();
        if m.is_file() {
            used += m.blocks() * 512;
            size += m.len();
        }
    }
    (used, size)
}

fn settle(s: &Store) {
    let ks = s.keyspace();
    ks.freeze_at(s.durable_end());
    ks.wait_flushed().unwrap();
    ks.wait_merged();
}

/// Settles, then cleans until no file is queued, and removes what the runs cover.
fn clean_all(s: &Store) {
    for _ in 0..1000 {
        settle(s);
        s.clean().unwrap();
        let q = key::of(key::CLEAN);
        let g = key::of(key::GONE);
        let queued = s.scan(&q, &key::prefix_end(&q), usize::MAX).unwrap();
        let gone = s.scan(&g, &key::prefix_end(&g), usize::MAX).unwrap();
        let covered = s.keyspace().covered() >> st_engine::log::FILE_SHIFT;
        // Files at or past the newest run's file wait for later flushes; they aren't counted.
        let pending = queued
            .iter()
            .filter(|(k, _)| file_of_key(k) < covered)
            .count();
        if pending == 0 && gone.is_empty() {
            return;
        }
    }
}

fn file_of_key(k: &[u8]) -> u64 {
    let mut at = 0;
    get_u64(k, &mut at).unwrap();
    get_u64(k, &mut at).unwrap()
}

fn commit_all(s: &Store, mut recs: impl Iterator<Item = Record>) -> Duration {
    let started = Instant::now();
    // Up to 8 commits in flight, as concurrent actions would be.
    let inflight = Arc::new((std::sync::Mutex::new(0u32), std::sync::Condvar::new()));
    loop {
        let chunk: Vec<Record> = recs.by_ref().take(BATCH as usize).collect();
        if chunk.is_empty() {
            break;
        }
        let (m, cv) = &*inflight;
        let mut n = m.lock().unwrap();
        while *n >= 8 {
            n = cv.wait(n).unwrap();
        }
        *n += 1;
        drop(n);
        let f = inflight.clone();
        s.commit(
            chunk,
            Box::new(move |r| {
                r.unwrap();
                *f.0.lock().unwrap() -= 1;
                f.1.notify_all();
            }),
        );
    }
    let (m, cv) = &*inflight;
    let mut n = m.lock().unwrap();
    while *n > 0 {
        n = cv.wait(n).unwrap();
    }
    started.elapsed()
}

fn stats_json(st: &StoreStats) -> String {
    let k = &st.ks;
    format!(
        "\"log_bytes\":{},\"log_rounds\":{},\"flushes\":{},\"flush_bytes\":{},\"merges\":{},\"merge_bytes\":{},\
         \"inserted\":{},\"runs\":{},\"run_bytes\":{},\"top_bytes\":{},\"buffer_bytes\":{},\"cache_bytes\":{},\
         \"cleaned_files\":{},\"relocated_records\":{},\"relocated_bytes\":{},\"removed_bytes\":{},\
         \"replay_bytes\":{},\"replay_ms\":{:.1}",
        st.log_bytes,
        st.log_rounds,
        k.flushes,
        k.flush_bytes,
        k.merges,
        k.merge_bytes,
        k.inserted,
        k.runs,
        k.run_bytes,
        k.top_bytes,
        k.buffer_bytes,
        k.cache_bytes,
        st.cleaned_files,
        st.relocated_records,
        st.relocated_bytes,
        st.removed_bytes,
        st.replay_bytes,
        st.replay_micros as f64 / 1000.0
    )
}

fn mem_json() -> String {
    format!(
        "\"rss_kb\":{},\"hwm_kb\":{}",
        proc_kb("VmRSS:"),
        proc_kb("VmHWM:")
    )
}

fn report(phase: &str, s: &Store, dir: &Path, extra: &str) {
    let (log_used, log_size) = disk(dir);
    let (run_used, _) = disk(&dir.join("runs"));
    println!(
        "{{\"phase\":\"{phase}\",{},{},\"log_disk\":{log_used},\"log_size\":{log_size},\"runs_disk\":{run_used}{extra}}}",
        stats_json(&s.stats()),
        mem_json()
    );
    std::io::stdout().flush().unwrap();
}

/// Point lookups of random ids and pages of the order from random keys: blocks fetched per read (from the
/// cache or the file) and file reads (cache misses) per read.
fn reads(s: &Store, ids: u64, rng: &mut Rng) -> String {
    let ks = s.keyspace();
    let before = ks.stats();
    let n = 20_000;
    let started = Instant::now();
    for _ in 0..n {
        let id = rng.next() % ids;
        let v = s.get(&key::id(key::TEST_SET, id)).unwrap().unwrap();
        parse_loc(&v).unwrap();
    }
    let point_us = started.elapsed().as_secs_f64() * 1e6 / n as f64;
    let mid = ks.stats();
    let pages = 2_000;
    let started = Instant::now();
    let order = key::of(key::TEST_ORDER);
    let end = key::prefix_end(&order);
    let mut got = 0;
    for _ in 0..pages {
        let from = key::ids(key::TEST_ORDER, rng.next() % (1 << 32), 0);
        got += s.scan(&from, &end, 100).unwrap().len();
    }
    let page_us = started.elapsed().as_secs_f64() * 1e6 / pages as f64;
    let after = ks.stats();
    format!(
        ",\"point_blocks\":{:.2},\"point_file_reads\":{:.2},\"point_us\":{point_us:.1},\
         \"page_blocks\":{:.2},\"page_file_reads\":{:.2},\"page_us\":{page_us:.1},\"page_entries\":{:.1}",
        (mid.blocks - before.blocks) as f64 / n as f64,
        (mid.file_reads - before.file_reads) as f64 / n as f64,
        (after.blocks - mid.blocks) as f64 / pages as f64,
        (after.file_reads - mid.file_reads) as f64 / pages as f64,
        got as f64 / pages as f64
    )
}

/// Bytes of the live records: every id's current record.
fn live_bytes(s: &Store) -> u64 {
    let start = key::of(key::TEST_SET);
    let end = key::prefix_end(&start);
    let mut total = 0;
    let mut from = start;
    loop {
        let page = s.scan(&from, &end, 100_000).unwrap();
        let Some((last, _)) = page.last() else { break };
        from = last.clone();
        from.push(0);
        total += page
            .iter()
            .map(|(_, v)| parse_loc(v).unwrap().len)
            .sum::<u64>();
    }
    total
}

/// The default config, with any constant overridden by an environment variable (ST_B, ST_L, ST_DELTA, ST_U,
/// ST_C, ST_BLOCK, ST_LOG_BLOCK; sizes in bytes).
fn config() -> StoreConfig {
    let mut c = StoreConfig::default();
    let env = |k: &str| std::env::var(k).ok();
    if let Some(v) = env("ST_B") {
        c.ks.buffer_bytes = v.parse().unwrap();
    }
    if let Some(v) = env("ST_L") {
        c.ks.log_bytes = v.parse().unwrap();
    }
    if let Some(v) = env("ST_DELTA") {
        c.ks.fan_in = v.parse().unwrap();
    }
    if let Some(v) = env("ST_U") {
        c.live_fraction = v.parse().unwrap();
    }
    if let Some(v) = env("ST_C") {
        c.ks.cache_bytes = v.parse().unwrap();
    }
    if let Some(v) = env("ST_BLOCK") {
        c.ks.block_size = v.parse().unwrap();
    }
    if let Some(v) = env("ST_LOG_BLOCK") {
        c.log.block_size = v.parse().unwrap();
    }
    c
}

/// Memory a buffer of entries shaped like `testSet`'s takes, against what it counts.
fn calibrate(dir: &Path) {
    use st_engine::keyspace::val::Val;
    use st_engine::keyspace::{Hooks, Keyspace, Mem};
    struct NoHooks;
    impl Hooks for NoHooks {
        fn flush_extra(
            &self,
            _: &Keyspace,
            _: &Mem,
            _: &[Arc<st_engine::keyspace::run::Run>],
        ) -> st_engine::keyspace::KsResult<Vec<(Vec<u8>, Val)>> {
            Ok(Vec::new())
        }
        fn flushed(&self, _: &Keyspace) {}
    }
    let mut cfg = StoreConfig::default().ks;
    cfg.buffer_bytes = usize::MAX;
    let ks = Keyspace::open(dir, cfg).unwrap();
    ks.start(Box::new(NoHooks)).unwrap();
    let before = proc_kb("VmRSS:");
    let mut rng = Rng(7);
    for id in 0..2_000_000u64 {
        let k = rng.next() % (1 << 32);
        let loc = st_engine::store::kinds::loc_bytes(st_engine::store::derive::Loc {
            pos: id * 20,
            len: 18,
        });
        ks.insert(
            [
                (key::id(key::TEST_SET, id), Val::Put(loc)),
                (key::ids(key::TEST_ORDER, k, id), Val::Put(Vec::new())),
            ],
            None,
        );
    }
    let after = proc_kb("VmRSS:");
    let counted = ks.stats().buffer_bytes;
    println!(
        "{{\"phase\":\"calibrate\",\"entries\":4000000,\"rss_delta\":{},\"counted\":{counted},\"real_per_counted\":{:.3}}}",
        (after - before) * 1024,
        (after - before) as f64 * 1024.0 / counted as f64
    );
    ks.stop();
}

fn run(dir: &Path, entries: u64) {
    let ids = entries / 2;
    let cfg = config();
    let s = Store::open(dir, cfg).unwrap();
    s.wait_ready().unwrap();
    let mut rng = Rng(1);
    let t = commit_all(&s, (0..ids).map(|id| set(id, Rng(id).next() % (1 << 32))));
    report(
        "load",
        &s,
        dir,
        &format!(
            ",\"ids\":{ids},\"secs\":{:.1},\"us_per_record\":{:.2}",
            t.as_secs_f64(),
            t.as_secs_f64() * 1e6 / ids as f64
        ),
    );
    settle(&s);
    let r = reads(&s, ids, &mut rng);
    report("loaded", &s, dir, &r);
    let t = commit_all(
        &s,
        (0..ids).map(|i| {
            let mut r = Rng(i ^ 0x5555);
            set(r.next() % ids, r.next() % (1 << 32))
        }),
    );
    report(
        "update",
        &s,
        dir,
        &format!(
            ",\"secs\":{:.1},\"us_per_record\":{:.2}",
            t.as_secs_f64(),
            t.as_secs_f64() * 1e6 / ids as f64
        ),
    );
    let started = Instant::now();
    clean_all(&s);
    let live = live_bytes(&s);
    report(
        "cleaned",
        &s,
        dir,
        &format!(
            ",\"secs\":{:.1},\"live_record_bytes\":{live}",
            started.elapsed().as_secs_f64()
        ),
    );
    let r = reads(&s, ids, &mut rng);
    report("updated", &s, dir, &r);
    let started = Instant::now();
    s.close();
    drop(s);
    let closed = started.elapsed();
    let started = Instant::now();
    let s = Store::open(dir, cfg).unwrap();
    let opened = started.elapsed();
    s.wait_ready().unwrap();
    report(
        "reopened",
        &s,
        dir,
        &format!(
            ",\"close_ms\":{:.1},\"open_ms\":{:.1},\"ready_ms\":{:.1}",
            closed.as_secs_f64() * 1e3,
            opened.as_secs_f64() * 1e3,
            started.elapsed().as_secs_f64() * 1e3
        ),
    );
    let r = reads(&s, ids, &mut rng);
    report("reopened-reads", &s, dir, &r);
    s.close();
}

/// The crash child: commits rounds of updates, keeping up to 32 commits in flight, and prints each commit's
/// number once it is acknowledged. Commit `i` sets `BATCH` ids to the key `base + i`.
fn child(dir: &Path, ids: u64, base: u64) {
    let s = Arc::new(Store::open(dir, config()).unwrap());
    s.wait_ready().unwrap();
    let inflight = Arc::new((std::sync::Mutex::new(0u32), std::sync::Condvar::new()));
    // Until killed.
    let mut i = 0;
    loop {
        let (m, cv) = &*inflight;
        let mut n = m.lock().unwrap();
        while *n >= 32 {
            n = cv.wait(n).unwrap();
        }
        *n += 1;
        drop(n);
        let mut r = Rng(base + i);
        let recs = (0..BATCH).map(|_| set(r.next() % ids, base + i)).collect();
        let f = inflight.clone();
        s.commit(
            recs,
            Box::new(move |r| {
                r.unwrap();
                let mut out = std::io::stdout().lock();
                writeln!(out, "{i}").unwrap();
                out.flush().unwrap();
                *f.0.lock().unwrap() -= 1;
                f.1.notify_all();
            }),
        );
        i += 1;
    }
}

fn crash(dir: &Path, rounds: u64) {
    let ids = {
        let s = Store::open(dir, StoreConfig::default()).unwrap();
        let c = s.get(&key::of(key::TEST_COUNT)).unwrap().unwrap();
        s.close();
        st_engine::keyspace::val::counter_value(&c).unwrap() as u64
    };
    let mut rng = Rng(rounds);
    for round in 0..rounds {
        let base = (1u64 << 40) + round * (1 << 30);
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "child",
                dir.to_str().unwrap(),
                &ids.to_string(),
                &base.to_string(),
            ])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let out = child.stdout.take().unwrap();
        let acked = Arc::new(AtomicU64::new(u64::MAX));
        let a = acked.clone();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(out).lines() {
                let Ok(line) = line else { break };
                a.store(line.trim().parse().unwrap(), Ordering::SeqCst);
            }
        });
        let wait = Duration::from_millis(2000 + rng.next() % 6000);
        std::thread::sleep(wait);
        // SIGKILL: nothing in the child runs after it.
        child.kill().unwrap();
        child.wait().unwrap();
        reader.join().unwrap();
        let last = acked.load(Ordering::SeqCst);
        let started = Instant::now();
        let s = Store::open(dir, config()).unwrap();
        let opened = started.elapsed();
        s.wait_ready().unwrap();
        let ready = started.elapsed();
        // Every id an acknowledged commit set holds that commit's key or a later one.
        let mut checked = 0;
        let mut expect = std::collections::HashMap::new();
        if last != u64::MAX {
            for i in 0..=last {
                let mut r = Rng(base + i);
                for _ in 0..BATCH {
                    expect.insert(r.next() % ids, base + i);
                }
            }
        }
        for (id, k) in &expect {
            let v = s.get(&key::id(key::TEST_SET, *id)).unwrap().unwrap();
            let rec = s.read(parse_loc(&v).unwrap().pos).unwrap();
            let Value::UInt(got) = rec.values[1] else {
                unreachable!()
            };
            assert!(
                got >= *k,
                "id {id}: key {got}, but commit {k} was acknowledged"
            );
            checked += 1;
        }
        let st = s.stats();
        println!(
            "{{\"phase\":\"crash\",\"round\":{round},\"killed_after_ms\":{},\"acked_commits\":{},\"checked_ids\":{checked},\
             \"open_ms\":{:.1},\"ready_ms\":{:.1},{}}}",
            wait.as_millis(),
            last.wrapping_add(1),
            opened.as_secs_f64() * 1e3,
            ready.as_secs_f64() * 1e3,
            stats_json(&st)
        );
        std::io::stdout().flush().unwrap();
        assert!(st.replay_bytes < config().ks.log_bytes + config().log.file_target);
        s.close();
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = PathBuf::from(&args[2]);
    match args[1].as_str() {
        "run" => run(&dir, args[3].parse().unwrap()),
        "crash" => crash(&dir, args[3].parse().unwrap()),
        "calibrate" => calibrate(&dir),
        "child" => child(&dir, args[3].parse().unwrap(), args[4].parse().unwrap()),
        a => panic!("unknown command {a}"),
    }
}
