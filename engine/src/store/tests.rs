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
        log_bytes: 8 << 10,
        fan_in: 3,
        block_size: 256,
        max_frozen: 1,
    },
    live_fraction: 0.5,
    relocate_bytes: 1024,
};

fn small_pool() -> Arc<Pool> {
    Pool::new(16 << 10, 64 << 10, 4, 1, 2, 2)
}

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
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    workload(&s, &mut model, 0, 3000);
    model.check(&s);
    let st = s.stats();
    assert!(st.ks.flushes > 5 && st.ks.merges > 0, "{st:?}");
    s.close();
    drop(s);
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
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
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
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
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
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
        // A budget the workload never fills: flushes come from L, so the buffer holds what replay must redo.
        let s = Store::open_in(&dir, SMALL, Pool::new(16 << 20, 64 << 10, 4, 1, 2, 2)).unwrap();
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
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    model.check(&s);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn reads_before_replay_ends_wait_for_it() {
    let dir = temp_dir("wait");
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    s.commit_wait(vec![fav(5, true)]).unwrap();
    s.abandon();
    std::mem::forget(s);
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
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
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
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
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    model.check(&s);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn concurrent_commits_share_syncs_and_each_sees_the_ones_before() {
    let dir = temp_dir("concurrent");
    let s = Arc::new(Store::open_in(&dir, SMALL, small_pool()).unwrap());
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
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
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
    let err = Store::open_in(&dir, SMALL, small_pool()).err().unwrap();
    assert!(
        err.to_string()
            .contains("runs that covered its cleaned files are missing"),
        "{err}"
    );
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_commit_that_writes_nothing_resolves_after_the_ones_before_it() {
    let dir = temp_dir("order");
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    s.wait_ready().unwrap();
    let order = Arc::new(Mutex::new(Vec::new()));
    for i in 0..200u64 {
        let o = order.clone();
        let recs = if i % 3 == 0 {
            Vec::new()
        } else {
            vec![fav(i, true)]
        };
        s.commit(
            recs,
            Box::new(move |r| {
                r.unwrap();
                o.lock().unwrap().push(i);
            }),
        );
    }
    s.commit_wait(vec![fav(1000, true)]).unwrap();
    let order = order.lock().unwrap().clone();
    assert_eq!(order, (0..200).collect::<Vec<_>>());
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

// ---- bulk loads ----

/// A library of `n` entities: searched text fields from a small vocabulary (so terms repeat across fields and
/// entities), tags, favs and test sets; an entity's records together.
fn library(from: u64, n: u64) -> Vec<Record> {
    use kinds::test_codes::{CARD_TAGS, LIBRARY};
    let words = [
        "dark",
        "knight",
        "dragon",
        "vampire",
        "love",
        "the",
        "girl",
        "quokka",
        "saxophone",
        "drab",
        "élan",
        "東京",
        "o'neil",
        "foo-bar",
    ];
    let mut out = Vec::new();
    for e in from..from + n {
        let word = |i: u64| words[((e * 31 + i * 17) % words.len() as u64) as usize];
        for f in [0u64, 2, 4, 8, u64::from(CARD_TAGS)] {
            let len = (e + f) % 9 + 1;
            let t: Vec<&str> = (0..len).map(|i| word(i + f)).collect();
            let sep = if f == u64::from(CARD_TAGS) {
                "\u{1e}"
            } else {
                " "
            };
            out.push(set_text(e, LIBRARY + f, &t.join(sep)));
        }
        if e % 3 == 0 {
            out.push(fav(e, e % 2 == 0));
        }
        out.push(rec(
            "tagAssign",
            vec![Value::Id(e), Value::Id(e % 5 + 1), Value::Bit(true)],
        ));
        out.push(test_set(e, e % 13, b"x"));
    }
    out
}

/// The search structures' entries, their maps without removed slots, and each entity's texts and fav.
fn derived(s: &Store, entities: std::ops::Range<u64>) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut out = Vec::new();
    for st in [
        key::SEARCH_POSTING,
        key::SEARCH_DOC_FREQ,
        key::SEARCH_BLOCK_MAX,
        key::SEARCH_SHORTEST,
        key::SEARCH_LENGTH,
        key::SEARCH_TERM_DOCS,
        key::SEARCH_FIELD_TOKENS,
        key::SEARCH_DOCS,
        key::SEARCH_MAX_DOC,
        key::MEMBER_OF,
        key::MEMBER_COUNT,
        key::MEMBER_BLOCK,
        key::TEST_ORDER,
        key::TEST_COUNT,
    ] {
        let p = key::of(st);
        for (k, v) in s.scan(&p, &key::prefix_end(&p), usize::MAX).unwrap() {
            let v = match crate::keyspace::val::map_pairs(&v) {
                Some(pairs) if st != key::TEST_COUNT && st != key::SEARCH_DOCS => {
                    let pairs: Vec<_> = pairs.into_iter().filter(|p| p.1 != 0).collect();
                    if pairs.is_empty() {
                        continue;
                    }
                    format!("{pairs:?}").into_bytes()
                }
                _ => v,
            };
            out.push((k, v));
        }
    }
    for e in entities {
        for f in 0..12 {
            let t = s
                .text(e, &FieldRef::Code(kinds::test_codes::LIBRARY + f))
                .unwrap();
            out.push((format!("text {e} {f}").into_bytes(), t.unwrap_or_default()));
        }
        out.push((
            format!("fav {e}").into_bytes(),
            format!("{:?}", s.fav(e).unwrap()).into_bytes(),
        ));
    }
    out
}

fn bulk_dirs(name: &str) -> (PathBuf, PathBuf) {
    (
        temp_dir(&format!("{name}-commits")),
        temp_dir(&format!("{name}-bulk")),
    )
}

#[test]
fn a_bulk_load_derives_what_commits_derive() {
    let (a, b) = bulk_dirs("bulk");
    let (sa, sb) = (
        Store::open_in(&a, SMALL, small_pool()).unwrap(),
        Store::open_in(&b, SMALL, small_pool()).unwrap(),
    );
    // Some state first, which the load reads and replaces in part.
    for s in [&sa, &sb] {
        for c in library(1, 20).chunks(7) {
            s.commit_wait(c.to_vec()).unwrap();
        }
    }
    let recs = library(10, 300);
    for c in recs.chunks(9) {
        sa.commit_wait(c.to_vec()).unwrap();
    }
    let mut l = sb.loader().unwrap();
    for c in recs.chunks(100) {
        l.add(c.to_vec()).unwrap();
    }
    let st = l.finish().unwrap();
    assert_eq!(st.records, recs.len() as u64);
    assert!(!b.join(bulk::LOAD_DIR).exists());
    assert_eq!(derived(&sa, 0..320), derived(&sb, 0..320));
    // A flush the pool asks for, of entries that no record brought (as cleaning's), covers the log past the
    // load.
    sb.inner
        .ks
        .insert([(key::id(key::GONE, u64::MAX), Val::Del)], None);
    sb.inner.ks.request_freeze();
    sb.inner.ks.wait_flushed().unwrap();
    // Commits go on after it, and everything holds across reopening.
    for s in [&sa, &sb] {
        s.commit_wait(library(5, 3)).unwrap();
        s.commit_wait(vec![fav(400, true)]).unwrap();
    }
    assert_eq!(derived(&sa, 0..401), derived(&sb, 0..401));
    drop(sb);
    let sb = Store::open_in(&b, SMALL, small_pool()).unwrap();
    assert_eq!(derived(&sa, 0..401), derived(&sb, 0..401));
    let _ = (fs::remove_dir_all(&a), fs::remove_dir_all(&b));
}

#[test]
fn a_bulk_load_out_of_partition_order_derives_what_commits_derive() {
    let (a, b) = bulk_dirs("bulk-order");
    let (sa, sb) = (
        Store::open_in(&a, SMALL, small_pool()).unwrap(),
        Store::open_in(&b, SMALL, small_pool()).unwrap(),
    );
    // Each entity's records split, and the second halves in reverse entity order.
    let recs = library(1, 120);
    let (first, second): (Vec<_>, Vec<_>) = recs
        .iter()
        .cloned()
        .enumerate()
        .partition(|(i, _)| i % 2 == 0);
    let mut order: Vec<Record> = first.into_iter().map(|(_, r)| r).collect();
    order.extend(second.into_iter().rev().map(|(_, r)| r));
    for r in &order {
        sa.commit_wait(vec![r.clone()]).unwrap();
    }
    let mut l = sb.loader().unwrap();
    l.add(order).unwrap();
    l.finish().unwrap();
    assert_eq!(derived(&sa, 0..130), derived(&sb, 0..130));
    let _ = (fs::remove_dir_all(&a), fs::remove_dir_all(&b));
}

#[test]
fn an_abandoned_or_refused_bulk_load_leaves_the_store_as_it_was() {
    let dir = temp_dir("bulk-abandon");
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    s.commit_wait(library(1, 5)).unwrap();
    let before = derived(&s, 0..60);
    {
        let mut l = s.loader().unwrap();
        l.add(library(10, 40)).unwrap();
        // Another load can't start meanwhile; commits go on.
        assert!(matches!(s.loader(), Err(StoreError::Refused(_))));
        s.commit_wait(vec![fav(3, true)]).unwrap();
        s.commit_wait(vec![fav(3, false)]).unwrap();
    }
    assert!(!dir.join(bulk::LOAD_DIR).exists());
    assert_eq!(derived(&s, 0..60), before);
    // A kind whose commit may change the record isn't loaded.
    let mut l = s.loader().unwrap();
    assert!(matches!(
        l.add(vec![edit(1, 2, 0, 0, "x")]),
        Err(StoreError::Refused(_))
    ));
    assert!(l.finish().is_err());
    // A record committed meanwhile in a partition the load holds refuses the load.
    let mut l = s.loader().unwrap();
    l.add(library(10, 40)).unwrap();
    s.commit_wait(vec![fav(25, true)]).unwrap();
    assert!(matches!(l.finish(), Err(StoreError::Refused(_))));
    assert_eq!(s.fav(25).unwrap(), Some(true));
    assert_eq!(
        s.text(30, &FieldRef::Code(kinds::test_codes::LIBRARY))
            .unwrap(),
        None
    );
    drop(s);
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    assert_eq!(s.fav(25).unwrap(), Some(true));
    s.commit_wait(library(10, 40)).unwrap();
    drop(s);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_bulk_load_stopped_while_installing_is_whole_or_absent_after_reopening() {
    for (point, visible) in [(1u8, false), (2, true)] {
        let dir = temp_dir("bulk-crash");
        let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
        s.commit_wait(library(1, 3)).unwrap();
        let mut l = s.loader().unwrap();
        l.add(library(10, 50)).unwrap();
        bulk::FAIL_AT.store(point, Ordering::Relaxed);
        assert!(l.finish().is_err());
        bulk::FAIL_AT.store(0, Ordering::Relaxed);
        // Nothing more is written until reopening.
        assert!(s.commit_wait(vec![fav(1, true)]).is_err());
        drop(s);
        let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
        assert!(!dir.join(bulk::LOAD_DIR).exists());
        let t = s
            .text(30, &FieldRef::Code(kinds::test_codes::LIBRARY))
            .unwrap();
        assert_eq!(t.is_some(), visible, "failpoint {point}");
        assert!(
            s.text(2, &FieldRef::Code(kinds::test_codes::LIBRARY))
                .unwrap()
                .is_some()
        );
        // The log goes on from wherever it ends.
        s.commit_wait(library(100, 5)).unwrap();
        drop(s);
        let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
        assert!(
            s.text(100, &FieldRef::Code(kinds::test_codes::LIBRARY))
                .unwrap()
                .is_some()
        );
        drop(s);
        let _ = fs::remove_dir_all(&dir);
    }
}
