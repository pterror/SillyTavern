use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;

use super::*;
use crate::log::format::{Value, kind_by_name, wtf8_from_utf16};

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-store-{}-{name}-{}",
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
        buffer_bytes: 16 << 10,
        log_bytes: 8 << 10,
        fan_in: 3,
        cache_bytes: 64 << 10,
        block_size: 256,
        merge_threads: 2,
        max_frozen: 1,
    },
    live_fraction: 0.5,
    relocate_bytes: 1024,
};

fn text(s: &str) -> Vec<u8> {
    wtf8_from_utf16(&s.encode_utf16().collect::<Vec<_>>())
}

fn rec(kind: &str, values: Vec<Value>) -> Record {
    Record::new(kind_by_name(kind).unwrap(), values).unwrap()
}

fn fav(e: u64, on: bool) -> Record {
    rec("fav", vec![Value::Id(e), Value::Bit(on)])
}

fn set_text(e: u64, f: u64, s: &str) -> Record {
    rec(
        "textValue",
        vec![
            Value::Id(e),
            Value::Field(FieldRef::Code(f)),
            Value::Text(text(s)),
        ],
    )
}

fn edit(e: u64, f: u64, offset: u64, removed: u64, s: &str) -> Record {
    rec(
        "textEdit",
        vec![
            Value::Id(e),
            Value::Field(FieldRef::Code(f)),
            Value::UInt(offset),
            Value::UInt(removed),
            Value::Text(text(s)),
        ],
    )
}

fn test_set(id: u64, key: u64, value: &[u8]) -> Record {
    rec(
        "testSet",
        vec![
            Value::Id(id),
            Value::UInt(key),
            Value::Bytes(value.to_vec()),
        ],
    )
}

/// What the derived reads must show.
#[derive(Default, Clone)]
struct Model {
    favs: HashMap<u64, bool>,
    texts: HashMap<u64, String>,
    sets: HashMap<u64, u64>,
}

impl Model {
    fn check(&self, s: &Store) {
        for (e, f) in &self.favs {
            assert_eq!(s.fav(*e).unwrap(), Some(*f), "fav of {e}");
        }
        for (e, t) in &self.texts {
            assert_eq!(
                s.text(*e, &FieldRef::Code(1)).unwrap(),
                Some(text(t)),
                "text of {e}"
            );
        }
        for (id, key) in &self.sets {
            let k = key::id(key::TEST_SET, *id);
            let loc = kinds::parse_loc(&s.get(&k).unwrap().unwrap()).unwrap();
            assert_eq!(s.read(loc.pos).unwrap().values[1], Value::UInt(*key));
        }
        // The order holds each id once, under its current key, and the count matches.
        let order = key::of(key::TEST_ORDER);
        let all = s
            .scan(&order, &key::prefix_end(&order), usize::MAX)
            .unwrap();
        assert_eq!(all.len(), self.sets.len());
        for (k, _) in all {
            let mut at = 0;
            crate::keyspace::val::get_u64(&k, &mut at).unwrap();
            let key = crate::keyspace::val::get_u64(&k, &mut at).unwrap();
            let id = crate::keyspace::val::get_u64(&k, &mut at).unwrap();
            assert_eq!(self.sets.get(&id), Some(&key));
        }
        let count = s.get(&key::of(key::TEST_COUNT)).unwrap();
        assert_eq!(
            count.and_then(|b| counter_value(&b)).unwrap_or(0),
            self.sets.len() as i64
        );
    }
}

/// A deterministic workload of favs, text values and edits, and test sets over a few entities, so records
/// keep replacing each other; commits of 1–4 records.
fn workload(s: &Store, model: &mut Model, from: u64, n: u64) {
    let mut i = from;
    while i < from + n {
        let mut commit = Vec::new();
        for _ in 0..(i % 4 + 1) {
            let e = i * 7 % 23;
            commit.push(match i % 5 {
                0 => {
                    model.favs.insert(e, i.is_multiple_of(3));
                    fav(e, i.is_multiple_of(3))
                }
                1 => {
                    let t = format!("text {i} of {e} {}", "é".repeat((i % 50) as usize));
                    model.texts.insert(e, t.clone());
                    set_text(e, 1, &t)
                }
                2 if model.texts.contains_key(&e) => {
                    let t = model.texts.get_mut(&e).unwrap();
                    // Replace the first "t" with "T!" (ASCII, so byte offsets are char offsets).
                    let at = t.find('t').unwrap_or(0);
                    let removed = usize::from(t.as_bytes().get(at) == Some(&b't'));
                    t.replace_range(at..at + removed, "T!");
                    edit(e, 1, at as u64, removed as u64, "T!")
                }
                _ => {
                    let id = i % 41;
                    model.sets.insert(id, i);
                    test_set(id, i, &i.to_le_bytes())
                }
            });
            i += 1;
        }
        s.commit_wait(commit).unwrap();
    }
}

#[test]
fn derived_values_follow_commits_through_flushes_merges_and_reopens() {
    let dir = temp_dir("follow");
    let mut model = Model::default();
    let s = Store::open(&dir, SMALL).unwrap();
    workload(&s, &mut model, 0, 3000);
    model.check(&s);
    let st = s.stats();
    assert!(st.ks.flushes > 5 && st.ks.merges > 0, "{st:?}");
    s.close();
    drop(s);
    let s = Store::open(&dir, SMALL).unwrap();
    s.wait_ready().unwrap();
    assert_eq!(
        s.stats().replay_records,
        0,
        "a clean close flushes everything"
    );
    model.check(&s);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_text_value_is_written_whole_once_its_edits_reach_its_size() {
    let dir = temp_dir("text");
    let s = Store::open(&dir, SMALL).unwrap();
    let base = "0123456789".repeat(10);
    s.commit_wait(vec![set_text(1, 1, &base)]).unwrap();
    let mut value = base.clone();
    let mut kinds = Vec::new();
    for i in 0..40 {
        let at = (i * 7) % 90;
        value.replace_range(at..at + 2, "ab");
        let p = s.commit_wait(vec![edit(1, 1, at as u64, 2, "ab")]).unwrap();
        kinds.push(s.read(p[0]).unwrap().kind.name);
        assert_eq!(s.text(1, &FieldRef::Code(1)).unwrap(), Some(text(&value)));
    }
    // An edit record is ~8 bytes: the 100-byte value is rewritten about every 12 edits.
    let full = kinds.iter().filter(|k| **k == "textValue").count();
    assert!((2..=5).contains(&full), "{kinds:?}");
    assert_eq!(kinds[0], "textEdit");
    // A first edit of a field with no value is its full value.
    let p = s.commit_wait(vec![edit(2, 1, 0, 0, "new")]).unwrap();
    assert_eq!(s.read(p[0]).unwrap().kind.name, "textValue");
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_commit_that_cant_apply_writes_nothing() {
    let dir = temp_dir("refuse");
    let s = Store::open(&dir, SMALL).unwrap();
    s.commit_wait(vec![set_text(1, 1, "héllo")]).unwrap();
    let end = s.durable_end();
    for bad in [
        vec![fav(3, true), edit(1, 1, 4, 3, "x")],
        vec![edit(1, 1, 2, 0, "x")],
        vec![rec("moved", vec![Value::Id(0)])],
    ] {
        assert!(matches!(s.commit_wait(bad), Err(StoreError::Refused(_))));
    }
    assert_eq!(s.durable_end(), end);
    assert_eq!(s.fav(3).unwrap(), None);
    assert_eq!(s.text(1, &FieldRef::Code(1)).unwrap(), Some(text("héllo")));
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn after_a_crash_replay_restores_every_acknowledged_commit() {
    let dir = temp_dir("replay");
    let mut model = Model::default();
    let mut from = 0;
    for round in 0..6 {
        let s = Store::open(&dir, SMALL).unwrap();
        s.wait_ready().unwrap();
        model.check(&s);
        if round > 0 {
            let st = s.stats();
            assert!(
                st.replay_bytes > 0 && st.replay_bytes < SMALL.ks.log_bytes + SMALL.log.file_target,
                "{st:?}"
            );
        }
        let n = 300 + round * 211;
        workload(&s, &mut model, from, n);
        from += n;
        // As a crash would leave it: nothing flushed at the end, merges cut off.
        s.abandon();
        std::mem::forget(s);
    }
    let s = Store::open(&dir, SMALL).unwrap();
    model.check(&s);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn reads_before_replay_ends_wait_for_it() {
    let dir = temp_dir("wait");
    let s = Store::open(&dir, SMALL).unwrap();
    s.commit_wait(vec![fav(5, true)]).unwrap();
    s.abandon();
    std::mem::forget(s);
    let s = Store::open(&dir, SMALL).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let s = Arc::new(s);
    let s2 = s.clone();
    let parked = s.after_replay(Box::new(move || {
        let _ = tx.send(s2.fav(5).unwrap());
    }));
    if let Some(f) = parked {
        f();
    }
    assert_eq!(rx.recv().unwrap(), Some(true));
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

fn log_files(dir: &Path) -> Vec<u64> {
    let mut files: Vec<u64> = fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| {
            let name = e.unwrap().file_name().into_string().unwrap();
            let hex = name.strip_prefix("log-")?.strip_suffix(".blk")?.to_string();
            Some((u64::from_str_radix(&hex, 16).unwrap() * SMALL.log.block_size) >> log::FILE_SHIFT)
        })
        .collect();
    files.sort();
    files
}

#[test]
fn cleaning_drops_replaced_records_and_keeps_every_live_one() {
    let dir = temp_dir("clean");
    let mut model = Model::default();
    let s = Store::open(&dir, SMALL).unwrap();
    let first_feed = s.feed(0, 10).unwrap();
    assert!(first_feed.0.is_empty());
    // A text that is never replaced stays live in the first file throughout.
    s.commit_wait(vec![set_text(99, 1, "kept from the start")])
        .unwrap();
    model.texts.insert(99, "kept from the start".into());
    workload(&s, &mut model, 0, 6000);
    // Let the flushes catch up so every file is covered and checked.
    for _ in 0..20 {
        s.inner.ks.freeze_at(s.durable_end());
        s.inner.ks.wait_flushed().unwrap();
        s.wake_cleaner();
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let st = s.stats();
    assert!(st.cleaned_files > 5 && st.removed_bytes > 0, "{st:?}");
    assert!(st.relocated_records > 0, "{st:?}");
    model.check(&s);
    let files = log_files(&dir);
    assert!(files[0] > 0, "the first files were removed: {files:?}");
    // The feed from a removed file is gone; from the first file left, it never shows a copy as a change.
    assert!(matches!(
        s.feed(0, 10),
        Err(StoreError::Log(LogError::Gone(0)))
    ));
    let mut from = log::position(files[0], 0);
    loop {
        let (recs, next) = s.feed(from, 100).unwrap();
        for (_, r) in &recs {
            assert_ne!(r.kind.name, "moved");
        }
        if recs.is_empty() {
            break;
        }
        from = next;
    }
    let left: u64 = log_files(&dir)
        .iter()
        .map(|f| fs::metadata(s.log().file_path(*f)).unwrap().len())
        .sum();
    assert!(
        left < st.log_bytes / 2,
        "{left} bytes of log left of {} written",
        st.log_bytes
    );
    s.close();
    drop(s);
    // Reopened by probing from the newest run's file: the removed files are never looked for.
    let s = Store::open(&dir, SMALL).unwrap();
    model.check(&s);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn concurrent_commits_share_syncs_and_each_sees_the_ones_before() {
    let dir = temp_dir("concurrent");
    let s = Arc::new(Store::open(&dir, SMALL).unwrap());
    let threads: Vec<_> = (0..8)
        .map(|t| {
            let s = s.clone();
            std::thread::spawn(move || {
                for i in 0..100 {
                    s.commit_wait(vec![test_set(t * 1000 + i % 10, i, b"v")])
                        .unwrap();
                }
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    assert!(s.stats().log_rounds < 800, "{:?}", s.stats());
    let count = s.get(&key::of(key::TEST_COUNT)).unwrap();
    assert_eq!(count.and_then(|b| counter_value(&b)), Some(80));
    let order = key::of(key::TEST_ORDER);
    assert_eq!(
        s.scan(&order, &key::prefix_end(&order), usize::MAX)
            .unwrap()
            .len(),
        80
    );
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_log_whose_runs_are_missing_after_cleaning_refuses_to_open() {
    let dir = temp_dir("noruns");
    let mut model = Model::default();
    let s = Store::open(&dir, SMALL).unwrap();
    workload(&s, &mut model, 0, 6000);
    for _ in 0..20 {
        s.inner.ks.freeze_at(s.durable_end());
        s.inner.ks.wait_flushed().unwrap();
        s.wake_cleaner();
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    s.close();
    drop(s);
    assert!(log_files(&dir)[0] > 0);
    fs::remove_dir_all(dir.join("runs")).unwrap();
    let err = Store::open(&dir, SMALL).err().unwrap();
    assert!(
        err.to_string()
            .contains("runs that covered its cleaned files are missing"),
        "{err}"
    );
    fs::remove_dir_all(&dir).unwrap();
}
