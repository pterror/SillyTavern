use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;

use super::token_cache::{self, Put};
use super::*;

fn temp_dir(name: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "st-engine-tokens-{}-{name}-{}",
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

fn put(s: &Store, puts: Vec<Put>, now: u64) {
    let (tx, rx) = std::sync::mpsc::channel();
    s.token_cache_put(puts, now, 100, Box::new(move |r| drop(tx.send(r))));
    rx.recv().unwrap().unwrap();
}

fn evict(s: &Store, table: u64, cap: u64, batch: usize) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    s.token_cache_evict(table, cap, batch, Box::new(move |r| drop(tx.send(r))));
    rx.recv().unwrap().unwrap()
}

fn p(table: u64, n: u64, value: &[u8], replace: bool) -> Put {
    Put {
        table,
        identity: b"tok\0id".to_vec(),
        hash: format!("hash-{n}").into_bytes(),
        value: value.to_vec(),
        replace,
    }
}

fn get(s: &Store, table: u64, n: u64) -> Option<(u64, Vec<u8>)> {
    s.chat_read(|v| token_cache::get(v, table, b"tok\0id", format!("hash-{n}").as_bytes()))
        .unwrap()
}

#[test]
fn results_are_kept_marked_used_replaced_and_evicted_least_recently_used_first() {
    let dir = temp_dir("lru");
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    // Keys 0..40 in table 0 at times 1000 + n; one key in table 1.
    for n in 0..40 {
        put(&s, vec![p(0, n, &[n as u8], false)], 1000 + n);
    }
    put(&s, vec![p(1, 0, b"ids", false)], 5);
    assert_eq!(s.chat_read(|v| token_cache::count(v, 0)).unwrap(), 40);
    assert_eq!(get(&s, 0, 3), Some((1003, vec![3])));
    // Used again within the granularity: nothing changes; after it, marked used, the value kept.
    put(&s, vec![p(0, 3, b"other", false)], 1050);
    assert_eq!(get(&s, 0, 3), Some((1003, vec![3])));
    put(&s, vec![p(0, 3, b"other", false)], 2000);
    assert_eq!(get(&s, 0, 3), Some((2000, vec![3])));
    // Replaced on purpose; twice in one batch, the later wins.
    put(&s, vec![p(0, 4, b"a", true), p(0, 4, b"b", true)], 2001);
    assert_eq!(get(&s, 0, 4), Some((2001, b"b".to_vec())));
    assert_eq!(s.chat_read(|v| token_cache::count(v, 0)).unwrap(), 40);
    // Down to 30 in slices of 4: the oldest go (0..13 but not 3 or 4), table 1 untouched.
    while evict(&s, 0, 30, 4) {}
    assert_eq!(s.chat_read(|v| token_cache::count(v, 0)).unwrap(), 30);
    let kept: Vec<u64> = (0..40).filter(|n| get(&s, 0, *n).is_some()).collect();
    let mut want: Vec<u64> = (12..40).collect();
    want.extend([3, 4]);
    want.sort();
    assert_eq!(kept, want);
    assert!(!evict(&s, 0, 30, 4));
    assert_eq!(get(&s, 1, 0), Some((5, b"ids".to_vec())));
    // Kept through a clean reopen.
    drop(s);
    let s = Store::open_in(&dir, SMALL, small_pool()).unwrap();
    assert_eq!(s.chat_read(|v| token_cache::count(v, 0)).unwrap(), 30);
    assert_eq!(get(&s, 0, 4), Some((2001, b"b".to_vec())));
    drop(s);
    let _ = fs::remove_dir_all(&dir);
}
