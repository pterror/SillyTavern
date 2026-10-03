use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use super::format::{FieldRef, Record, Value, kind_by_name, wtf8_from_utf16};
use super::*;

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-log-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    dir
}

fn text(s: &str) -> Value {
    Value::Text(wtf8_from_utf16(&s.encode_utf16().collect::<Vec<_>>()))
}

fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
}

/// A deterministic mix of every kind, with texts from empty to several blocks long.
fn records(n: u64) -> Vec<Record> {
    (0..n)
        .map(|i| match i % 7 {
            0 => rec(
                "fav",
                vec![Value::Id(i * 7919 % 100_003), Value::Bit(i % 2 == 0)],
            ),
            1 => rec(
                "tagAssign",
                vec![Value::Id(i), Value::Id(i % 13), Value::Bit(true)],
            ),
            2 => rec(
                "pointerMove",
                vec![Value::Id(3), Value::Id(1), Value::Id(i)],
            ),
            3 => rec(
                "forkSelection",
                vec![Value::Id(i), Value::Id(i + 1), Value::Id(3), Value::Id(1)],
            ),
            4 => rec(
                "messageAppend",
                vec![
                    Value::Id(i),
                    if i % 3 == 0 {
                        Value::Absent
                    } else {
                        Value::Id(i - 1)
                    },
                    Value::Id(42),
                    Value::Id(42),
                    if i % 5 == 0 {
                        text("Narrator")
                    } else {
                        Value::Absent
                    },
                    Value::Time(1_700_000_000_000 + i as i64 * 1000),
                    text(&"word ".repeat((i * 37 % 400) as usize)),
                    Value::UInt(i % 4),
                    Value::Id(3),
                    Value::Id(1),
                ],
            ),
            5 => rec(
                "textEdit",
                vec![
                    Value::Id(i % 5),
                    Value::Field(FieldRef::Code(2)),
                    Value::UInt(i),
                    Value::UInt(4),
                    text("new"),
                ],
            ),
            _ => rec(
                "textValue",
                vec![
                    Value::Id(i % 5),
                    Value::Field(FieldRef::Key(b"ext/x".to_vec())),
                    text(&"x".repeat((i % 3000) as usize)),
                ],
            ),
        })
        .collect()
}

fn all(log: &Log) -> Vec<(u64, Record)> {
    let mut out = Vec::new();
    let mut from = 0;
    loop {
        let (batch, next) = log.iterate(from, 7).unwrap();
        if batch.is_empty() {
            assert_eq!(next, log.durable_end());
            return out;
        }
        out.extend(batch);
        from = next;
    }
}

const SMALL: Config = Config {
    block_size: 256,
    file_target: 4096,
};

/// Commits `recs` in commits of 1..=5 records, waiting for each; returns each commit's positions.
fn commit_all(log: &Log, recs: &[Record]) -> Vec<Vec<u64>> {
    let mut out = Vec::new();
    let mut i = 0;
    let mut n = 1;
    while i < recs.len() {
        let end = (i + n).min(recs.len());
        out.push(log.append_wait(recs[i..end].to_vec()).unwrap());
        i = end;
        n = n % 5 + 1;
    }
    out
}

#[test]
fn records_read_back_by_position_and_in_order_across_blocks_and_files() {
    let dir = temp_dir("roundtrip");
    let recs = records(400);
    let log = Log::open(&dir, SMALL).unwrap();
    let positions: Vec<u64> = commit_all(&log, &recs).concat();
    for (p, r) in positions.iter().zip(&recs) {
        assert_eq!(&log.read(*p).unwrap(), r);
    }
    let read: Vec<_> = all(&log);
    assert_eq!(read.iter().map(|(p, _)| *p).collect::<Vec<_>>(), positions);
    assert_eq!(read.into_iter().map(|(_, r)| r).collect::<Vec<_>>(), recs);
    let files = fs::read_dir(&dir).unwrap().count();
    assert!(files > 3, "rolled over into {files} files");
    log.close();
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn positions_that_are_not_record_starts_are_refused() {
    let dir = temp_dir("badpos");
    let log = Log::open(&dir, SMALL).unwrap();
    let p = log.append_wait(records(5)).unwrap();
    assert!(matches!(log.read(p[1] + 1), Err(LogError::Position(..))));
    assert!(matches!(
        log.read(log.durable_end()),
        Err(LogError::Position(..))
    ));
    assert!(matches!(
        log.iterate(p[1] + 1, 10),
        Err(LogError::Position(..))
    ));
    assert!(matches!(
        log.iterate(log.durable_end() + 1, 10),
        Err(LogError::Position(..))
    ));
    log.close();
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_reopened_log_continues_where_it_ended() {
    let dir = temp_dir("reopen");
    let recs = records(300);
    let mut positions = Vec::new();
    for chunk in recs.chunks(37) {
        let log = Log::open(&dir, SMALL).unwrap();
        positions.extend(commit_all(&log, chunk).concat());
        log.close();
    }
    let log = Log::open(&dir, SMALL).unwrap();
    let read = all(&log);
    assert_eq!(read.iter().map(|(p, _)| *p).collect::<Vec<_>>(), positions);
    assert_eq!(read.into_iter().map(|(_, r)| r).collect::<Vec<_>>(), recs);
    log.close();
    fs::remove_dir_all(&dir).unwrap();
}

fn copy_dir(from: &Path, to: &Path) {
    let _ = fs::remove_dir_all(to);
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        fs::copy(e.path(), to.join(e.file_name())).unwrap();
    }
}

#[test]
fn every_truncation_point_reopens_to_exactly_the_whole_groups() {
    let dir = temp_dir("torn");
    // One file, so every byte of the log is in the file opening reads.
    let cfg = Config {
        block_size: 256,
        file_target: 1 << 20,
    };
    let recs = records(60);
    let log = Log::open(&dir, cfg).unwrap();
    // Each commit's positions and where its group ends.
    let mut commits: Vec<(Vec<u64>, u64)> = Vec::new();
    for chunk in recs.chunks(3) {
        let p = log.append_wait(chunk.to_vec()).unwrap();
        commits.push((p, log.durable_end()));
    }
    log.close();
    let len_all = fs::metadata(dir.join(file_name(&cfg, 0))).unwrap().len();
    assert_eq!(len_all, commits.last().unwrap().1);
    let copy = temp_dir("torn-copy");
    for len in 0..=len_all {
        copy_dir(&dir, &copy);
        let f = OpenOptions::new()
            .write(true)
            .open(copy.join(file_name(&cfg, 0)))
            .unwrap();
        f.set_len(len).unwrap();
        drop(f);
        let log = Log::open(&copy, cfg).unwrap();
        let whole: Vec<_> = commits.iter().filter(|(_, end)| *end <= len).collect();
        let end = whole.last().map_or(0, |(_, end)| *end);
        assert_eq!(log.durable_end(), end, "truncated to {len}");
        assert_eq!(
            fs::metadata(copy.join(file_name(&cfg, 0))).unwrap().len(),
            end
        );
        let read = all(&log);
        assert_eq!(
            read.iter().map(|(p, _)| *p).collect::<Vec<_>>(),
            whole
                .iter()
                .flat_map(|(p, _)| p.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            read.into_iter().map(|(_, r)| r).collect::<Vec<_>>(),
            recs[..whole.len() * 3]
        );
        let p = log.append_wait(records(3)).unwrap();
        assert_eq!(log.read(p[2]).unwrap(), records(3)[2]);
        log.close();
    }
    fs::remove_dir_all(&dir).unwrap();
    fs::remove_dir_all(&copy).unwrap();
}

#[test]
fn a_corrupted_last_group_is_dropped() {
    let dir = temp_dir("corrupt");
    let log = Log::open(&dir, SMALL).unwrap();
    let first = log.append_wait(records(3)).unwrap();
    let end = log.durable_end();
    log.append_wait(records(4)).unwrap();
    log.close();
    let file = dir.join(file_name(&SMALL, 0));
    let mut bytes = fs::read(&file).unwrap();
    let last = bytes.len() - TRAILER_LEN - 1;
    bytes[last] ^= 0x40;
    fs::write(&file, &bytes).unwrap();
    let log = Log::open(&dir, SMALL).unwrap();
    assert_eq!(log.durable_end(), end);
    assert_eq!(
        all(&log).into_iter().map(|(p, _)| p).collect::<Vec<_>>(),
        first
    );
    log.close();
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn concurrent_commits_share_syncs_and_each_resolves_after_its_own() {
    let dir = temp_dir("group");
    let log = Arc::new(Log::open(&dir, Config::default()).unwrap());
    let threads: Vec<_> = (0..16)
        .map(|t| {
            let log = log.clone();
            std::thread::spawn(move || {
                (0..50)
                    .map(|i| {
                        let r = vec![rec("fav", vec![Value::Id(t * 1000 + i), Value::Bit(true)])];
                        let p = log.append_wait(r.clone()).unwrap();
                        // Durable once resolved: readable right away.
                        assert!(p[0] < log.durable_end());
                        assert_eq!(log.read(p[0]).unwrap(), r[0]);
                        p[0]
                    })
                    .collect::<Vec<_>>()
            })
        })
        .collect();
    let mut positions: Vec<u64> = threads
        .into_iter()
        .flat_map(|t| t.join().unwrap())
        .collect();
    positions.sort();
    positions.dedup();
    assert_eq!(positions.len(), 800);
    let rounds = log.stats().rounds;
    assert!(rounds < 800, "{rounds} rounds for 800 commits");
    log.close();
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn appends_after_close_fail() {
    let dir = temp_dir("closed");
    let log = Log::open(&dir, SMALL).unwrap();
    log.close();
    assert!(matches!(log.append_wait(records(1)), Err(LogError::Closed)));
    fs::remove_dir_all(&dir).unwrap();
}
