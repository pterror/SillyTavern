//! Faults injected into the store's I/O (`crate::faults`) under deterministic simulation (`Executor::simulated`):
//! a failed or torn write or sync, a full disk, and a crash at every single operation of a workload that commits,
//! flushes, merges and cleans the log. Every run is a function of its seed and fault point, so a failure replays
//! exactly (`ST_SIM_SEED`, `ST_FAULT_AT`).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;

use super::*;
use crate::faults::{Fault, Faults};
use crate::log::format::{Value, kind_by_name, wtf8_from_utf16};

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-faults-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    dir
}

/// Small enough that a short workload flushes, merges and cleans: every kind of operation gets a fault.
const SMALL: StoreConfig = StoreConfig {
    log: log::Config {
        block_size: 256,
        file_target: 2048,
    },
    ks: KsConfig {
        log_bytes: 2 << 10,
        fan_in: 2,
        block_size: 256,
        max_frozen: 1,
    },
    live_fraction: 0.5,
    relocate_bytes: 1024,
};

const ENTITIES: u64 = 11;

fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
}

fn text(s: &str) -> Vec<u8> {
    wtf8_from_utf16(&s.encode_utf16().collect::<Vec<_>>())
}

/// What the workload's entities hold: fav and text per entity.
type State = Vec<(Option<bool>, Option<Vec<u8>>)>;

fn read_state(s: &Store) -> StoreResult<State> {
    (0..ENTITIES)
        .map(|e| Ok((s.fav(e)?, s.text(e, &FieldRef::Code(1))?)))
        .collect()
}

struct Rng(u64);

impl Rng {
    fn below(&mut self, n: u64) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        (z ^ (z >> 31)) % n
    }
}

/// How a run under a fault went.
struct Run {
    /// The state after each commit issued, from before the first: `states[k]` is the state after k commits.
    states: Vec<State>,
    /// Commits acknowledged (they come first; once one fails, none later is).
    acked: usize,
}

/// Commits, flushes, merges and cleaning in `dir` until `commits` commits or the first refused one; reads are
/// checked against the acknowledged state as they go. The store is left as a crash would leave it.
fn workload(dir: &Path, seed: u64, commits: usize) -> Run {
    let mut run = Run {
        states: vec![vec![(None, None); ENTITIES as usize]],
        acked: 0,
    };
    // A crash unwinds out of the engine (its steps run here, simulated); the store is left unclosed.
    crate::faults::catch_crash(|| drive(dir, seed, commits, &mut run));
    run
}

fn drive(dir: &Path, seed: u64, commits: usize, run: &mut Run) {
    let pool = Pool::simulated(16 << 10, 64 << 10, 2, 2, seed);
    let mut rng = Rng(seed);
    let mut state = run.states[0].clone();
    // A fault while opening: nothing was committed. Never closed: as the process would leave it.
    let Ok(s) = Store::open_in(dir, SMALL, pool) else {
        return;
    };
    let s = std::mem::ManuallyDrop::new(s);
    for i in 0..commits {
        let mut recs = Vec::new();
        for _ in 0..1 + rng.below(3) {
            let e = rng.below(ENTITIES);
            if rng.below(2) == 0 {
                let on = rng.below(2) == 0;
                state[e as usize].0 = Some(on);
                recs.push(rec("fav", vec![Value::Id(e), Value::Bit(on)]));
            } else {
                let t = format!("v{i}{}", "x".repeat(rng.below(60) as usize));
                state[e as usize].1 = Some(text(&t));
                recs.push(rec(
                    "textValue",
                    vec![
                        Value::Sel(0, e),
                        Value::Field(FieldRef::Code(1)),
                        Value::Text(text(&t)),
                        Value::Absent,
                        Value::Absent,
                    ],
                ));
            }
        }
        run.states.push(state.clone());
        match s.commit_wait(recs) {
            Ok(_) => run.acked = i + 1,
            Err(_) => {
                // G3: nothing later is acknowledged either.
                let probe = rec("fav", vec![Value::Id(0), Value::Bit(true)]);
                assert!(
                    s.commit_wait(vec![probe]).is_err(),
                    "a commit after a failed one was acknowledged"
                );
                break;
            }
        }
        // Reads see exactly what was acknowledged, whatever failed underneath.
        if let Ok(now) = read_state(&s) {
            assert!(
                now == run.states[run.acked],
                "commit {i}: reads differ from the acknowledged state"
            );
        }
        match rng.below(10) {
            0 => {
                s.inner.ks.freeze_at(s.durable_end());
                let _ = s.inner.ks.wait_flushed();
            }
            1 => {
                s.wake_cleaner();
                let _ = s.clean();
            }
            2 => s.inner.ks.wait_merged(),
            _ => {}
        }
    }
    s.abandon();
}

/// Reopens `dir` with no faults: it opens, and holds exactly the state after some k commits, k at least the
/// acknowledged ones and at most the issued ones (whole commits, in order: nothing lost, nothing invented).
fn check_reopened(dir: &Path, seed: u64, run: &Run, at: &str) {
    let s = Store::open_in(dir, SMALL, Pool::simulated(16 << 10, 64 << 10, 2, 2, seed))
        .unwrap_or_else(|e| panic!("{at}: doesn't reopen: {e}"));
    let now = read_state(&s).unwrap_or_else(|e| panic!("{at}: unreadable after reopen: {e}"));
    assert!(
        run.states[run.acked..].contains(&now),
        "{at}: after reopen the state is no prefix of whole commits with all {} acknowledged ones",
        run.acked
    );
    drop(s);
}

fn commits() -> usize {
    std::env::var("ST_FAULT_COMMITS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60)
}

/// The fault points to try out of `ops`: `ST_FAULT_AT` alone, else every one (a long run) up to
/// `ST_FAULT_POINTS` (default 40) spread evenly.
fn points(ops: u64) -> Vec<u64> {
    if let Some(n) = std::env::var("ST_FAULT_AT")
        .ok()
        .and_then(|s| s.parse().ok())
    {
        return vec![n];
    }
    let want: u64 = std::env::var("ST_FAULT_POINTS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(40);
    if want >= ops {
        return (1..=ops).collect();
    }
    (0..want).map(|i| 1 + i * ops / want).collect()
}

/// The operations a fault-free run of `seed` does (the same every time: the run is simulated).
fn count_ops(seed: u64) -> u64 {
    let dir = temp_dir("count");
    let faults = Faults::install(&dir, None, seed);
    let run = workload(&dir, seed, commits());
    assert_eq!(run.acked, commits(), "seed {seed}: a fault-free run failed");
    let ops = faults.ops();
    drop(faults);
    check_reopened(&dir, seed, &run, &format!("seed {seed}, no fault"));
    let _ = fs::remove_dir_all(&dir);
    ops
}

/// Names the fault point a panic happened at (replay it with `ST_SIM_SEED` and `ST_FAULT_AT`).
struct Named<'a>(&'a str);

impl Drop for Named<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            eprintln!("failed at {}", self.0);
        }
    }
}

fn each_point(fault: Fault, cut: bool) {
    for seed in crate::keyspace::exec::sim_seeds(2) {
        let ops = count_ops(seed);
        assert!(ops > 50, "seed {seed}: only {ops} operations");
        for n in points(ops) {
            let at = format!("seed {seed}, {fault:?} at operation {n} of {ops}");
            let _named = Named(&at);
            let dir = temp_dir("fault");
            let faults = Faults::install(&dir, Some((n, fault)), seed ^ n);
            let run = workload(&dir, seed, commits());
            assert!(faults.fired(), "{at}: the fault never came");
            if cut {
                faults.crash_cut();
            }
            drop(faults);
            check_reopened(&dir, seed, &run, &at);
            let _ = fs::remove_dir_all(&dir);
        }
    }
}

/// A store stopped by a failed log write stops cleaning too: each relocation it handed the commit path failed at
/// once and started the file over, a step loop without end (an engine thread spinning, a log line each time).
/// Found at seed 2, the 187th operation failing (a log write while a file was being cleaned).
#[test]
fn cleaning_stops_with_a_store_stopped_by_a_failed_write() {
    let (seed, n) = (2, 187);
    let dir = temp_dir("stopped-clean");
    let faults = Faults::install(&dir, Some((n, Fault::Eio)), seed ^ n);
    let run = workload(&dir, seed, 60);
    assert!(faults.fired());
    drop(faults);
    check_reopened(&dir, seed, &run, "seed 2, Eio at operation 187");
    let _ = fs::remove_dir_all(&dir);
}

/// G13 measured: opening after a crash that left a full log tail (`LOG_BYTES`, 64 MB, written since the last
/// flush) to replay. The default configuration, with a buffer budget large enough that only L freezes the buffer,
/// so the tail reaches its bound. Text values of 10k entities, about 250 bytes each. Prints the time; run by hand:
/// `cargo test --release --lib -- --ignored opening_after_a_crash_with_a_full_log_tail --nocapture`.
#[test]
#[ignore]
fn opening_after_a_crash_with_a_full_log_tail() {
    let dir = temp_dir("tail");
    let cfg = StoreConfig::default();
    let pool = || Pool::new(1 << 30, CACHE_BYTES, 4, 1, 2, 2);
    let s = Store::open_in(&dir, cfg, pool()).unwrap();
    let mut written = 0u64;
    let mut i = 0u64;
    while written < cfg.ks.log_bytes - (1 << 20) {
        let mut recs = Vec::new();
        for _ in 0..1000 {
            let t = format!("{i} {}", "lorem ipsum ".repeat(19));
            written += t.len() as u64 + 16;
            recs.push(rec(
                "textValue",
                vec![
                    Value::Sel(0, i % 10_000),
                    Value::Field(FieldRef::Code(1)),
                    Value::Text(text(&t)),
                    Value::Absent,
                    Value::Absent,
                ],
            ));
            i += 1;
        }
        s.commit_wait(recs).unwrap();
    }
    let st = s.stats();
    assert_eq!(
        st.ks.flushes, 0,
        "the buffer was flushed: the tail isn't full"
    );
    s.abandon();
    std::mem::forget(s);
    let started = std::time::Instant::now();
    let s = Store::open_in(&dir, cfg, pool()).unwrap();
    let opened = started.elapsed();
    s.wait_ready().unwrap();
    let ready = started.elapsed();
    let st = s.stats();
    eprintln!(
        "G13: {} records, {:.1} MB of log replayed: open {opened:?}, ready {ready:?} (replay {} ms)",
        st.replay_records,
        st.replay_bytes as f64 / 1e6,
        st.replay_micros / 1000
    );
    drop(s);
    let _ = fs::remove_dir_all(&dir);
}

/// A crash at any operation: then nothing more reaches the disk, and what wasn't synced may be cut anywhere.
#[test]
fn a_crash_at_any_operation_loses_no_acknowledged_commit_and_invents_nothing() {
    each_point(Fault::Crash, true);
}

/// A failed write or sync (G3): the commit isn't acknowledged, no later one is, reads keep showing what was;
/// reopened, the store holds whole commits with every acknowledged one.
#[test]
fn a_failed_write_or_sync_stops_commits_and_keeps_what_was_acknowledged() {
    each_point(Fault::Eio, false);
}

#[test]
fn a_full_disk_stops_commits_and_keeps_what_was_acknowledged() {
    each_point(Fault::Enospc, false);
}

/// A write torn part way, then a crash cutting what wasn't synced.
#[test]
fn a_torn_write_then_a_crash_loses_no_acknowledged_commit() {
    each_point(Fault::Torn, true);
}
