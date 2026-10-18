//! Seeded fuzzing of the keyspace's decoders: values (`Val::decode`, map and count encodings), blocks
//! (`Block::parse` and every cursor over what parses) and whole runs (`Run::in_memory`, its footer, index and
//! reads). Valid encodings are mutated: bytes flipped, inserted, removed, cut off, overwritten; and, so mutations
//! reach past the checksums, sometimes with the checksum recomputed over the damage. Every decode must refuse or
//! read back, never panic, never loop.
//!
//! `ST_FUZZ_SECS=<s>` runs each target for s seconds (default 2); a failure names the target, seed and input.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::time::{Duration, Instant};

use super::block::{Block, BlockBuilder, Cursor, KIND_DATA, RevCursor};
use super::cache::Cache;
use super::run::{ReadCounts, Run, RunIter, RunRevIter, RunWriter, Source};
use super::val::{self, Val, count_bytes, map_bytes, put_u64};
use super::*;

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
        self.next() % n.max(1)
    }
}

fn secs() -> Duration {
    Duration::from_secs_f64(
        std::env::var("ST_FUZZ_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(2.0),
    )
}

/// Runs `one(seed)` for fresh seeds until the time is up; a panic is reported with its seed.
fn fuzz(target: &str, salt: u64, one: impl Fn(u64)) {
    let until = Instant::now() + secs();
    let mut seed = salt.wrapping_mul(0x1000_0000_01b3);
    let mut n = 0u64;
    while Instant::now() < until {
        seed = seed.wrapping_add(1);
        if let Err(e) = catch_unwind(AssertUnwindSafe(|| one(seed))) {
            let msg = e
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default();
            panic!("{target}: seed {seed} panicked after {n} inputs: {msg}");
        }
        n += 1;
    }
    eprintln!("{target}: {n} inputs");
}

fn pairs(rng: &mut Rng, wide: bool) -> Vec<(u32, u32)> {
    let mut m = std::collections::BTreeMap::new();
    for _ in 0..rng.below(300) {
        let s = if wide {
            rng.next() as u32
        } else {
            rng.below(2000) as u32
        };
        let v = match rng.below(4) {
            0 => 1,
            1 => rng.next() as u32,
            _ => rng.below(100) as u32,
        };
        m.insert(s, v);
    }
    m.into_iter().collect()
}

fn gen_val(rng: &mut Rng) -> Val {
    match rng.below(8) {
        0 => Val::Put((0..rng.below(80)).map(|_| rng.next() as u8).collect()),
        1 => Val::Del,
        2 => Val::Add(rng.next() as i64 >> rng.below(64)),
        3 => Val::Max(rng.next() >> rng.below(64)),
        4 => {
            let wide = rng.below(2) == 0;
            Val::Map(pairs(rng, wide))
        }
        5 => {
            let wide = rng.below(2) == 0;
            Val::MaxMap(pairs(rng, wide))
        }
        6 => Val::AddMap(
            pairs(rng, false)
                .into_iter()
                .filter(|p| p.1 != 0)
                .map(|(s, v)| {
                    (
                        s,
                        if v % 2 == 0 {
                            i64::from(v)
                        } else {
                            -i64::from(v)
                        },
                    )
                })
                .collect(),
        ),
        _ => Val::Put(map_bytes(&pairs(rng, false))),
    }
}

/// `b` damaged in a random way.
fn mutate(rng: &mut Rng, b: &mut Vec<u8>) {
    for _ in 0..1 + rng.below(4) {
        match rng.below(6) {
            0 | 1 if !b.is_empty() => {
                let i = rng.below(b.len() as u64) as usize;
                b[i] ^= 1 << rng.below(8);
            }
            2 if !b.is_empty() => {
                let i = rng.below(b.len() as u64) as usize;
                b[i] = rng.next() as u8;
            }
            3 => {
                let i = rng.below(b.len() as u64 + 1) as usize;
                b.insert(i, rng.next() as u8);
            }
            4 if !b.is_empty() => {
                let i = rng.below(b.len() as u64) as usize;
                b.remove(i);
            }
            _ => {
                let n = rng.below(b.len() as u64 + 1) as usize;
                b.truncate(n);
            }
        }
    }
}

/// Recomputes a block's trailing CRC-32C over its damaged bytes, so the damage reaches the decoder.
fn fix_crc(b: &mut [u8]) {
    if b.len() >= 4 {
        let n = b.len() - 4;
        let crc = crc32c::crc32c(&b[..n]);
        b[n..].copy_from_slice(&crc.to_le_bytes());
    }
}

#[test]
fn fuzz_values_round_trip_and_damaged_ones_never_panic() {
    fuzz("values", 1, |seed| {
        let mut rng = Rng(seed);
        let v = gen_val(&mut rng);
        let mut b = Vec::new();
        v.encode(&mut b);
        let mut at = 0;
        let back = Val::decode(&b, &mut at);
        // An `AddMap`'s deltas round-trip by value; every other kind exactly.
        assert_eq!(back.as_ref(), Some(&v), "round trip of {v:?}");
        assert_eq!(at, b.len());
        if let Val::Map(p) | Val::MaxMap(p) = &v {
            let p: Vec<_> = p.iter().copied().filter(|x| x.1 != 0).collect();
            assert_eq!(val::map_pairs(&map_bytes(&p)), Some(p.clone()));
            let c: Vec<(u32, u64)> = p.iter().map(|&(s, v)| (s, u64::from(v))).collect();
            assert_eq!(val::map_counts(&count_bytes(&c)), Some(c));
        }
        for _ in 0..4 {
            let mut d = b.clone();
            mutate(&mut rng, &mut d);
            let mut at = 0;
            if Val::decode(&d, &mut at).is_some() {
                assert!(at <= d.len());
            }
            let _ = val::map_pairs(&d);
            let _ = val::map_counts(&d);
            let _ = val::max_value(&d);
            let _ = val::counter_value(&d);
        }
    });
}

fn key(i: u64) -> Vec<u8> {
    let mut k = vec![7];
    put_u64(&mut k, i);
    k
}

/// Entries in key order: keys sharing prefixes, some long, values of every kind.
fn entries(rng: &mut Rng, n: u64) -> Vec<(Vec<u8>, Val)> {
    let mut ids: Vec<u64> = (0..n).map(|_| rng.below(n * 4 + 1)).collect();
    ids.sort();
    ids.dedup();
    ids.into_iter()
        .map(|i| {
            let mut k = key(i);
            if rng.below(8) == 0 {
                k.extend(std::iter::repeat_n(b'z', rng.below(200) as usize));
            }
            (k, gen_val(rng))
        })
        .collect()
}

/// Every read of a block that parsed: forward through all, seeks, and backward through all. Bounded: a damaged
/// block that parses must still end.
fn read_block(b: Arc<Block>, rng: &mut Rng, keys: &[Vec<u8>]) {
    if let Ok(mut c) = Cursor::first(b.clone()) {
        let mut n = 0;
        while c.valid && n < 100_000 {
            let _ = c.val();
            let _ = c.put_bytes();
            if c.advance().is_err() {
                break;
            }
            n += 1;
        }
        assert!(n < 100_000, "a forward walk didn't end");
    }
    for _ in 0..4 {
        let t = if keys.is_empty() || rng.below(3) == 0 {
            key(rng.next())
        } else {
            keys[rng.below(keys.len() as u64) as usize].clone()
        };
        if let Ok(c) = Cursor::seek(b.clone(), &t)
            && c.valid
        {
            let _ = c.val();
        }
        if let Ok(c) = RevCursor::before(b.clone(), &t)
            && c.valid
        {
            let _ = c.val();
        }
        if let Ok(c) = RevCursor::covering(b.clone(), &t)
            && c.valid
        {
            let _ = (c.key(), c.val());
        }
        let mut k = Vec::new();
        let _ = b.seek_at_least(&t, &mut k);
    }
    if let Ok(mut c) = RevCursor::last(b) {
        let mut n = 0;
        while c.valid && n < 100_000 {
            let _ = c.val();
            if c.prev().is_err() {
                break;
            }
            n += 1;
        }
        assert!(n < 100_000, "a backward walk didn't end");
    }
}

#[test]
fn fuzz_blocks_read_back_and_damaged_ones_never_panic() {
    fuzz("blocks", 2, |seed| {
        let mut rng = Rng(seed);
        let n = 1 + rng.below(80);
        let es = entries(&mut rng, n);
        let mut bb = BlockBuilder::default();
        for (k, v) in &es {
            bb.add(k, v);
        }
        let bytes = bb.finish(KIND_DATA);
        let keys: Vec<Vec<u8>> = es.iter().map(|(k, _)| k.clone()).collect();
        // Whole: every entry reads back, in order.
        let b = Arc::new(Block::parse(bytes.clone()).unwrap());
        let mut c = Cursor::first(b.clone()).unwrap();
        for (k, v) in &es {
            assert!(c.valid);
            assert_eq!(&c.key, k);
            assert_eq!(&c.val().unwrap(), v);
            c.advance().unwrap();
        }
        assert!(!c.valid);
        read_block(b, &mut rng, &keys);
        for _ in 0..6 {
            let mut d = bytes.clone();
            mutate(&mut rng, &mut d);
            if rng.below(2) == 0 {
                fix_crc(&mut d);
            }
            if let Ok(b) = Block::parse(d) {
                read_block(Arc::new(b), &mut rng, &keys);
            }
        }
    });
}

/// Every read of a run that opened: point gets, a forward and a backward walk, sorted gets, an estimate.
fn read_run(run: Arc<Run>, rng: &mut Rng, keys: &[Vec<u8>]) {
    let cache = Cache::new(1 << 20);
    let counts = ReadCounts::default();
    let mut probes: Vec<Vec<u8>> = (0..6)
        .map(|_| {
            if keys.is_empty() || rng.below(3) == 0 {
                key(rng.next())
            } else {
                keys[rng.below(keys.len() as u64) as usize].clone()
            }
        })
        .collect();
    for p in &probes {
        let _ = run.get(p, &cache, &counts);
    }
    probes.sort();
    let refs: Vec<&[u8]> = probes.iter().map(|p| p.as_slice()).collect();
    let _ = run.get_sorted(&refs, &cache, &counts);
    let _ = run.estimate(&probes[0], &probes[probes.len() - 1], &cache, &counts);
    if let Ok(mut it) = RunIter::new(run.clone(), &[], Some(&cache), Some(&counts)) {
        let mut n = 0;
        while it.key().is_some() && n < 1_000_000 {
            let _ = it.val();
            if it.advance().is_err() {
                break;
            }
            n += 1;
        }
        assert!(n < 1_000_000, "a forward walk didn't end");
    }
    if let Ok(mut it) = RunRevIter::new(run.clone(), &[0xff; 4], &[], Some(&cache), Some(&counts)) {
        let mut n = 0;
        while it.key().is_some() && n < 1_000_000 {
            let _ = it.val();
            if it.advance().is_err() {
                break;
            }
            n += 1;
        }
        assert!(n < 1_000_000, "a backward walk didn't end");
    }
}

#[test]
fn fuzz_runs_read_back_and_damaged_ones_never_panic() {
    let path = std::env::temp_dir().join(format!("st-engine-fuzz-{}.run", std::process::id()));
    fuzz("runs", 3, |seed| {
        let mut rng = Rng(seed);
        let n = 1 + rng.below(600);
        let es = entries(&mut rng, n);
        let block = 128 + rng.below(1024) as usize;
        let mut w = RunWriter::in_memory(block, 1 << 16);
        for (k, v) in &es {
            w.add(k, v).unwrap();
        }
        let (lo, hi) = (rng.below(100), 100 + rng.below(100));
        let bytes = w.finish_in_memory(rng.below(1 << 40), lo, hi).unwrap();
        let keys: Vec<Vec<u8>> = es.iter().map(|(k, _)| k.clone()).collect();
        // Whole: every entry reads back by key and in order.
        let run = Arc::new(Run::in_memory(&path, bytes.clone(), lo, hi).unwrap());
        let cache = Cache::new(1 << 20);
        let counts = ReadCounts::default();
        for (k, v) in &es {
            assert_eq!(run.get(k, &cache, &counts).unwrap().as_ref(), Some(v));
        }
        let mut it = RunIter::new(run.clone(), &[], Some(&cache), Some(&counts)).unwrap();
        for (k, v) in &es {
            assert_eq!(it.key(), Some(k.as_slice()));
            assert_eq!(&it.val().unwrap(), v);
            it.advance().unwrap();
        }
        assert!(it.key().is_none());
        read_run(run, &mut rng, &keys);
        for _ in 0..4 {
            let mut d = bytes.clone();
            match rng.below(3) {
                // Damage in a block, which its checksum must catch on read.
                0 if d.len() > 64 + 16 => {
                    let at = rng.below((d.len() - 64) as u64) as usize;
                    let i = at.min(d.len() - 65);
                    d[i] ^= 1 << rng.below(8);
                }
                // Damage in the footer, its checksum (bytes 56..60 of it) made to hold.
                1 if d.len() >= 64 => {
                    let f = d.len() - 64;
                    let i = f + rng.below(56) as usize;
                    d[i] = rng.next() as u8;
                    let crc = crc32c::crc32c(&d[f..f + 56]);
                    d[f + 56..f + 60].copy_from_slice(&crc.to_le_bytes());
                }
                _ => mutate(&mut rng, &mut d),
            }
            if let Ok(r) = Run::in_memory(&path, d, lo, hi) {
                read_run(Arc::new(r), &mut rng, &keys);
            }
        }
    });
}
