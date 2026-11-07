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
            Value::Sel(0, e),
            Value::Field(FieldRef::Code(f)),
            Value::Text(text(s)),
            Value::Absent,
            Value::Absent,
        ],
    )
}

fn edit(e: u64, f: u64, offset: u64, removed: u64, s: &str) -> Record {
    rec(
        "textEdit",
        vec![
            Value::Sel(0, e),
            Value::Field(FieldRef::Code(f)),
            Value::UInt(offset),
            Value::UInt(removed),
            Value::Text(text(s)),
            Value::Absent,
            Value::Absent,
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
    let full = kinds.iter().filter(|k| **k == "textValue").count();
    assert!((2..=5).contains(&full), "{kinds:?}");
    assert_eq!(kinds[0], "textEdit");
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
    s.commit_wait(vec![set_text(99, 1, "kept from the start")])
        .unwrap();
    model.texts.insert(99, "kept from the start".into());
    workload(&s, &mut model, 0, 6000);
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

fn derived(s: &Store, entities: std::ops::Range<u64>) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut out = Vec::new();
    for st in [
        key::SEARCH_POSTING,
        key::SEARCH_TERM_COUNTS.id(),
        key::SEARCH_BLOCK_MAX,
        key::SEARCH_SHORTEST,
        key::SEARCH_LENGTH,
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
    let mut first = library(1, 20);
    first.retain(|r| r.kind.name != "tagAssign");
    for s in [&sa, &sb] {
        for c in first.chunks(7) {
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
    sb.inner
        .ks
        .insert([(key::id(key::GONE, u64::MAX), Val::Del)], None);
    sb.inner.ks.request_freeze();
    sb.inner.ks.wait_flushed().unwrap();
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
fn a_bulk_load_spills_to_files_only_past_its_budget() {
    let recs = library(1, 300);
    let (first, second): (Vec<_>, Vec<_>) = recs
        .iter()
        .cloned()
        .enumerate()
        .partition(|(i, _)| i % 2 == 0);
    let mut shuffled: Vec<Record> = first.into_iter().map(|(_, r)| r).collect();
    shuffled.extend(second.into_iter().rev().map(|(_, r)| r));
    let committed = temp_dir("bulk-budget-commits");
    let sa = Store::open_in(&committed, SMALL, small_pool()).unwrap();
    for c in recs.chunks(9) {
        sa.commit_wait(c.to_vec()).unwrap();
    }
    let want = derived(&sa, 0..310);
    for (name, order) in [("ordered", &recs), ("shuffled", &shuffled)] {
        for budget in [None, Some(1)] {
            let dir = temp_dir(&format!("bulk-budget-{name}-{budget:?}"));
            let sb = Store::open_in(&dir, SMALL, small_pool()).unwrap();
            let mut l = sb.loader_in(budget).unwrap();
            for c in order.chunks(100) {
                l.add(c.to_vec()).unwrap();
            }
            let st = l.finish().unwrap();
            match budget {
                None => assert_eq!(st.spills, 0, "{name}: {st:?}"),
                Some(_) => {
                    assert!(st.spills > 0, "{name}: {st:?}");
                    assert_eq!(st.kept_runs, 0, "{name}: {st:?}");
                }
            }
            assert_eq!(derived(&sb, 0..310), want, "{name}, budget {budget:?}");
            drop(sb);
            let _ = fs::remove_dir_all(&dir);
        }
    }
    let _ = fs::remove_dir_all(&committed);
}

#[test]
fn a_bulk_load_out_of_partition_order_derives_what_commits_derive() {
    let (a, b) = bulk_dirs("bulk-order");
    let (sa, sb) = (
        Store::open_in(&a, SMALL, small_pool()).unwrap(),
        Store::open_in(&b, SMALL, small_pool()).unwrap(),
    );
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
fn a_bulk_load_add_reports_the_worker_error_before_abandoning() {
    let dir = temp_dir("bulk-worker-error");
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    let mut load = s.loader().unwrap();
    let bad = Record::new(
        crate::log::format::kind_by_name("entityCreate").unwrap(),
        vec![
            Value::Id(1),
            Value::UInt(99),
            Value::Text(b"bad".to_vec()),
            Value::F64(0.0),
        ],
    )
    .unwrap();
    load.add([bad]).unwrap();
    let mut error = None;
    for i in 1..100 {
        if let Err(e) = load.add(library(i * 100, (i + 1) * 100)) {
            error = Some(e.to_string());
            break;
        }
    }
    assert!(error.unwrap().contains("no entity type 99"));
    drop(load);
    assert!(!dir.join(bulk::LOAD_DIR).exists());
    drop(s);
    let _ = fs::remove_dir_all(dir);
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
        assert!(matches!(s.loader(), Err(StoreError::Refused(_))));
        s.commit_wait(vec![fav(3, true)]).unwrap();
        s.commit_wait(vec![fav(3, false)]).unwrap();
    }
    assert!(!dir.join(bulk::LOAD_DIR).exists());
    assert_eq!(derived(&s, 0..60), before);
    let mut l = s.loader().unwrap();
    assert!(matches!(
        l.add(vec![edit(1, 2, 0, 0, "x")]),
        Err(StoreError::Refused(_))
    ));
    assert!(l.finish().is_err());
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
        let mut before = library(1, 3);
        before.retain(|r| r.kind.name != "tagAssign");
        s.commit_wait(before).unwrap();
        let mut l = s.loader().unwrap();
        l.add(library(10, 50)).unwrap();
        l.fail_at(point);
        assert!(l.finish().is_err());
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

#[test]
fn an_added_map_kinds_keys_take_added_maps_and_deletes() {
    use crate::keyspace::val::{Val, map_bytes};
    let k = key::test_add_map(3);
    let mut layer = std::collections::BTreeMap::new();
    let mut out = derive::Out::default();
    out.add_map(k.clone(), vec![(1, 2), (4, 1)]);
    out.add_map(k.clone(), vec![(1, -1)]);
    out.apply(&mut layer);
    assert_eq!(
        layer.get(k.bytes()),
        Some(&Val::AddMap(vec![(1, 1), (4, 1)]))
    );
    let mut out = derive::Out::default();
    out.del(k.clone());
    out.add_map(k.clone(), vec![(4, 5)]);
    out.apply(&mut layer);
    assert_eq!(layer.get(k.bytes()), Some(&Val::Put(map_bytes(&[(4, 5)]))));
}

#[test]
fn a_feed_key_put_and_deleted_in_one_layer_leaves_no_deletion() {
    use crate::keyspace::val::Val;
    let feed = key::ids(key::ENTITY_CHANGE, 7, 1);
    let other = key::id(key::VERSION, 1);
    let mut layer = std::collections::BTreeMap::new();
    let mut out = derive::Out::default();
    out.put(feed.clone(), Vec::new());
    out.put(other.clone(), Vec::new());
    out.apply(&mut layer);
    let mut out = derive::Out::default();
    out.del(feed.clone());
    out.del(other.clone());
    out.del(key::ids(key::ENTITY_TAG_CHANGE, 3, 1));
    out.apply(&mut layer);
    assert_eq!(layer.get(&feed), None);
    assert_eq!(layer.get(&other), Some(&Val::Del));
    assert_eq!(
        layer.get(&key::ids(key::ENTITY_TAG_CHANGE, 3, 1)),
        Some(&Val::Del)
    );
}

#[test]
fn a_page_reads_a_commits_own_entries_only_as_far_as_it_goes() {
    use crate::keyspace::val::Val;
    let dir = temp_dir("page-reads");
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    s.wait_ready().unwrap();
    let k = |i: u32| {
        let mut k = vec![0xfe, 0xfc];
        k.extend_from_slice(&i.to_be_bytes());
        k
    };
    let (start, end) = (vec![0xfe, 0xfc], vec![0xfe, 0xfd]);
    s.inner.ks.insert(
        (0..4000u32)
            .step_by(3)
            .map(|i| (k(i), Val::Put(format!("p{i}").into_bytes()))),
        None,
    );
    for n in [100u32, 1600] {
        let mut layer = std::collections::BTreeMap::new();
        for i in (0..n).step_by(2) {
            let v = if i % 10 == 0 {
                Val::Del
            } else {
                Val::Put(format!("u{i}").into_bytes())
            };
            layer.insert(k(i), v);
        }
        let mut model = std::collections::BTreeMap::new();
        for i in (0..4000u32).step_by(3) {
            model.insert(k(i), format!("p{i}").into_bytes());
        }
        for (key, v) in &layer {
            match v {
                Val::Put(b) => model.insert(key.clone(), b.clone()),
                _ => model.remove(key),
            };
        }
        let before = derive::LAYER_READS.with(|c| c.get());
        s.derived(|v| {
            let v = v.with_layer(&layer);
            for i in 0..n {
                let back: Vec<_> = v.scan_vals_rev(&start, &k(i), 1)?;
                let want = model.range(start.clone()..k(i)).next_back();
                assert_eq!(
                    back.first()
                        .map(|(key, v)| (key.clone(), v.clone().into_bytes(key))),
                    want.map(|(key, b)| (key.clone(), b.clone())),
                    "n {n}: last before {i}"
                );
                let on: Vec<_> = v.scan_vals(&k(i), &end, 1)?;
                let want = model.range(k(i)..end.clone()).next();
                assert_eq!(
                    on.first()
                        .map(|(key, v)| (key.clone(), v.clone().into_bytes(key))),
                    want.map(|(key, b)| (key.clone(), b.clone())),
                    "n {n}: first from {i}"
                );
            }
            Ok(())
        })
        .unwrap();
        let per_page = (derive::LAYER_READS.with(|c| c.get()) - before) as f64 / f64::from(2 * n);
        assert!(
            per_page <= 4.0,
            "n {n}: {per_page} layer entries read per one-key page"
        );
    }
    s.close();
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_layers_map_values_read_over_every_published_value_they_can_meet() {
    use crate::keyspace::val::{Val, count_bytes, map_bytes};
    let dir = temp_dir("layered-maps");
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    s.wait_ready().unwrap();
    let plain = |i: u8| vec![0xfe, 0xfe, i];
    let added = |i: u64| key::test_add_map(i).bytes().to_vec();
    let base = [(1, 5), (4, 2), (9, 7)];
    let wide: Vec<(u32, u64)> = base.iter().map(|&(s, v)| (s, u64::from(v))).collect();
    let cases: Vec<(&str, Vec<u8>, Val, Val, Vec<(u32, u32)>)> = vec![
        (
            "Map over a Map",
            plain(1),
            Val::Map(base.to_vec()),
            Val::Map(vec![(4, 0), (6, 3), (9, 1)]),
            vec![(1, 5), (6, 3), (9, 1)],
        ),
        (
            "Map over a Put",
            plain(2),
            Val::Put(map_bytes(&base)),
            Val::Map(vec![(4, 0), (6, 3), (9, 1)]),
            vec![(1, 5), (6, 3), (9, 1)],
        ),
        (
            "Map over a Del",
            plain(3),
            Val::Del,
            Val::Map(vec![(4, 0), (6, 3)]),
            vec![(6, 3)],
        ),
        (
            "MaxMap over a Map",
            plain(4),
            Val::MaxMap(base.to_vec()),
            Val::MaxMap(vec![(4, 1), (6, 3), (9, 8)]),
            vec![(1, 5), (4, 2), (6, 3), (9, 8)],
        ),
        (
            "MaxMap over a Put",
            plain(5),
            Val::Put(map_bytes(&base)),
            Val::MaxMap(vec![(4, 1), (6, 3), (9, 8)]),
            vec![(1, 5), (4, 2), (6, 3), (9, 8)],
        ),
        (
            "MaxMap over a Del",
            plain(6),
            Val::Del,
            Val::MaxMap(vec![(4, 1), (6, 3)]),
            vec![(4, 1), (6, 3)],
        ),
        (
            "AddMap over Counts",
            added(1),
            Val::AddMap(wide.iter().map(|&(s, v)| (s, v as i64)).collect()),
            Val::AddMap(vec![(4, -2), (6, 3), (9, 1)]),
            vec![(1, 5), (6, 3), (9, 8)],
        ),
        (
            "AddMap over a Put",
            added(2),
            Val::Put(count_bytes(&wide)),
            Val::AddMap(vec![(4, -2), (6, 3), (9, 1)]),
            vec![(1, 5), (6, 3), (9, 8)],
        ),
        (
            "AddMap over a Del",
            added(3),
            Val::Del,
            Val::AddMap(vec![(6, 3)]),
            vec![(6, 3)],
        ),
    ];
    s.inner
        .ks
        .insert(cases.iter().map(|c| (c.1.clone(), c.2.clone())), None);
    let mut layer = std::collections::BTreeMap::new();
    for c in &cases {
        layer.insert(c.1.clone(), c.3.clone());
    }
    s.derived(|v| {
        let v = v.with_layer(&layer);
        for (name, k, _, _, want) in &cases {
            let end = key::prefix_end(k);
            let got = |x: Option<Val>| x.and_then(|x| x.into_pairs(k)).unwrap_or_default();
            assert_eq!(&got(v.get_val(k)?), want, "{name}: get");
            let scanned = v.scan_vals(k, &end, 1)?.into_iter().next().map(|x| x.1);
            assert_eq!(&got(scanned), want, "{name}: scan");
            let back = v.scan_vals_rev(k, &end, 1)?.into_iter().next().map(|x| x.1);
            assert_eq!(&got(back), want, "{name}: scan back");
        }
        Ok(())
    })
    .unwrap();
    s.close();
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_layers_map_values_range_read_over_every_published_value_they_can_meet() {
    use crate::keyspace::val::{Val, count_bytes, map_bytes};
    let dir = temp_dir("layered-map-ranges");
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    s.wait_ready().unwrap();
    let plain = |i: u8| vec![0xfe, 0xfd, i];
    let added = |i: u64| key::test_add_map(i).bytes().to_vec();
    let base = [(1, 5), (4, 2), (9, 7)];
    let wide: Vec<(u32, u64)> = base.iter().map(|&(s, v)| (s, u64::from(v))).collect();
    let cases: Vec<(&str, Vec<u8>, Val, Val, Vec<(u32, u32)>)> = vec![
        (
            "Map over a Map",
            plain(1),
            Val::Map(base.to_vec()),
            Val::Map(vec![(4, 0), (6, 3), (9, 1)]),
            vec![(1, 5), (6, 3), (9, 1)],
        ),
        (
            "Map over a Put",
            plain(2),
            Val::Put(map_bytes(&base)),
            Val::Map(vec![(4, 0), (6, 3), (9, 1)]),
            vec![(1, 5), (6, 3), (9, 1)],
        ),
        (
            "Map over a Del",
            plain(3),
            Val::Del,
            Val::Map(vec![(4, 0), (6, 3)]),
            vec![(6, 3)],
        ),
        (
            "MaxMap over a Map",
            plain(4),
            Val::MaxMap(base.to_vec()),
            Val::MaxMap(vec![(4, 1), (6, 3), (9, 8)]),
            vec![(1, 5), (4, 2), (6, 3), (9, 8)],
        ),
        (
            "MaxMap over a Put",
            plain(5),
            Val::Put(map_bytes(&base)),
            Val::MaxMap(vec![(4, 1), (6, 3), (9, 8)]),
            vec![(1, 5), (4, 2), (6, 3), (9, 8)],
        ),
        (
            "MaxMap over a Del",
            plain(6),
            Val::Del,
            Val::MaxMap(vec![(4, 1), (6, 3)]),
            vec![(4, 1), (6, 3)],
        ),
        (
            "AddMap over Counts",
            added(1),
            Val::AddMap(wide.iter().map(|&(s, v)| (s, v as i64)).collect()),
            Val::AddMap(vec![(4, -2), (6, 3), (9, 1)]),
            vec![(1, 5), (6, 3), (9, 8)],
        ),
        (
            "AddMap over a Put",
            added(2),
            Val::Put(count_bytes(&wide)),
            Val::AddMap(vec![(4, -2), (6, 3), (9, 1)]),
            vec![(1, 5), (6, 3), (9, 8)],
        ),
        (
            "AddMap over a Del",
            added(3),
            Val::Del,
            Val::AddMap(vec![(6, 3)]),
            vec![(6, 3)],
        ),
    ];
    s.inner
        .ks
        .insert(cases.iter().map(|c| (c.1.clone(), c.2.clone())), None);
    let mut layer = std::collections::BTreeMap::new();
    for c in &cases {
        layer.insert(c.1.clone(), c.3.clone());
    }
    s.derived(|v| {
        let v = v.with_layer(&layer);
        for (name, k, _, _, want) in &cases {
            assert_eq!(&v.map_range(k, 0, u32::MAX, true)?, want, "{name}: all");
            let inner: Vec<(u32, u32)> = want
                .iter()
                .copied()
                .filter(|x| x.0 >= 2 && x.0 < 9)
                .collect();
            assert_eq!(&v.map_range(k, 2, 9, true)?, &inner, "{name}: [2, 9)");
        }
        Ok(())
    })
    .unwrap();
    s.close();
    let _ = fs::remove_dir_all(&dir);
}

fn files_in(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut todo = vec![dir.to_path_buf()];
    while let Some(d) = todo.pop() {
        for e in fs::read_dir(&d).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                out.insert(p.clone(), Vec::new());
                todo.push(p);
            } else {
                out.insert(p.clone(), fs::read(&p).unwrap());
            }
        }
    }
    out
}

fn assert_same_files(dir: &Path, before: &BTreeMap<PathBuf, Vec<u8>>) {
    let now = files_in(dir);
    let changed: Vec<_> = before
        .keys()
        .chain(now.keys())
        .filter(|p| before.get(*p) != now.get(*p))
        .collect();
    assert!(changed.is_empty(), "a refused open changed {changed:?}");
}

const QUIET: StoreConfig = StoreConfig {
    ks: KsConfig {
        log_bytes: 1 << 40,
        ..SMALL.ks
    },
    ..SMALL
};

fn quiet_pool() -> Arc<Pool> {
    Pool::new(1 << 30, 64 << 10, 4, 1, 2, 2)
}

#[test]
fn a_second_open_of_an_open_store_fails_and_leaves_the_first_untouched() {
    let dir = temp_dir("locked");
    let s = Store::open_in(&dir, QUIET, quiet_pool()).unwrap();
    let mut model = Model::default();
    workload(&s, &mut model, 0, 300);
    let mut l = s.loader_in(Some(1 << 30)).unwrap();
    l.add((1000..2000).map(|e| fav(e, true))).unwrap();
    model.favs.extend((1000..2000).map(|e| (e, true)));
    assert!(fs::read_dir(dir.join(bulk::LOAD_DIR)).unwrap().count() > 0);
    let before = files_in(&dir);
    for again in [
        Store::open_in(&dir, QUIET, quiet_pool()),
        Store::open_in(&dir.join("."), QUIET, quiet_pool()),
    ] {
        let e = again.err().unwrap();
        assert!(
            matches!(&e, StoreError::InUse(d) if d.starts_with(&dir)),
            "{e}"
        );
        assert!(e.to_string().contains(&dir.display().to_string()), "{e}");
    }
    assert_same_files(&dir, &before);
    l.finish().unwrap();
    workload(&s, &mut model, 300, 100);
    model.check(&s);
    drop(s);
    let s = Store::open_in(&dir, QUIET, quiet_pool()).unwrap();
    model.check(&s);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_bulk_load_holds_the_store_until_it_ends() {
    let dir = temp_dir("load-holds");
    let s = Store::open_in(&dir, QUIET, quiet_pool()).unwrap();
    let l = s.loader().unwrap();
    s.close();
    let e = Store::open_in(&dir, QUIET, quiet_pool()).err().unwrap();
    assert!(matches!(e, StoreError::InUse(_)), "{e}");
    drop(l);
    drop(s);
    drop(Store::open_in(&dir, QUIET, quiet_pool()).unwrap());
    fs::remove_dir_all(&dir).unwrap();
}

const CHILD_OPENS: &str = "ST_ENGINE_TEST_OPEN";

#[test]
#[ignore = "run by another_process_cant_open_an_open_store"]
fn open_in_child() {
    let dir = PathBuf::from(std::env::var_os(CHILD_OPENS).unwrap());
    let e = Store::open_in(&dir, QUIET, quiet_pool()).err().unwrap();
    assert!(matches!(e, StoreError::InUse(_)), "{e}");
}

#[test]
fn another_process_cant_open_an_open_store() {
    let dir = temp_dir("locked-process");
    let s = Store::open_in(&dir, QUIET, quiet_pool()).unwrap();
    let mut model = Model::default();
    workload(&s, &mut model, 0, 200);
    let before = files_in(&dir);
    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "store::tests::open_in_child", "--ignored"])
        .env(CHILD_OPENS, &dir)
        .output()
        .unwrap();
    let said = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success() && said.contains("1 passed"), "{said}");
    assert_same_files(&dir, &before);
    workload(&s, &mut model, 200, 50);
    model.check(&s);
    drop(s);
    fs::remove_dir_all(&dir).unwrap();
}
