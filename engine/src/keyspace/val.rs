//! Entry values and the order-preserving key encodings.

use crate::log::format::{get_uvarint, put_uvarint};

/// An entry's value in the keyspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Val {
    Put(Vec<u8>),
    /// The key has no value: hides older values until a merge reaches the oldest run.
    Del,
    /// Adds to the key's counter (a `Put` of `counter_bytes`, or 0 if it has none) without reading it.
    Add(i64),
    /// Raises the key's maximum (a `Put` of `max_bytes`, or nothing if it has none) to at least this, without
    /// reading it.
    Max(u64),
    /// Sets slots of the key's map (a `Put` of `map_bytes`, or an empty map if it has none) without reading it:
    /// (slot, value) pairs sorted by slot, value 0 removing the slot.
    Map(Vec<(u32, u32)>),
    /// Raises slots of the key's map (as `Map`'s) to at least these values without reading it: pairs sorted by
    /// slot.
    MaxMap(Vec<(u32, u32)>),
    /// Adds to slots of the key's map (as `Map`'s) without reading it: (slot, delta) pairs sorted by slot, no
    /// delta 0; a slot whose count reaches 0 is removed. A key written with it is never written with `Map` or
    /// `MaxMap` (`store::derive::AddMapKind`). Its counts are up to 64 bits (`count_bytes`).
    AddMap(Vec<(u32, i64)>),
    /// An `AddMap` key's whole map as its counts, sorted by slot, none 0: only ever made by `settled` and
    /// `over_settled`, never written. Anywhere it isn't read as pairs it is `Put(count_bytes(..))`.
    Counts(Vec<(u32, u64)>),
}

/// A map's pairs (sorted by slot, values not 0) as `Put` bytes, the same encoding as a `Map` value's payload: a
/// varint of the count shifted left, its low bit the form, whichever is smaller. Packed (0): per chunk of `CHUNK`
/// pairs the bit widths of its slot differences and of its values (a byte each), then those bit-packed, least
/// significant first, difference then value per pair. Varints (1): per pair a varint of the slot difference
/// shifted left with the low bit set when the value is 1, any other value following as a varint. A slot's
/// difference is from the slot before (from 0 for the first).
pub fn map_bytes(pairs: &[(u32, u32)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(map_len(pairs));
    put_map(&mut out, pairs);
    out
}

const CHUNK: usize = 128;

fn bits(v: u32) -> u32 {
    32 - v.leading_zeros()
}

/// Each chunk's widths.
fn chunks(pairs: &[(u32, u32)]) -> impl Iterator<Item = (&[(u32, u32)], u32, u32, u32)> {
    let mut prev = 0u32;
    pairs.chunks(CHUNK).map(move |c| {
        let base = prev;
        let (mut bd, mut bv, mut p) = (0, 0, base);
        for &(slot, v) in c {
            bd = bd.max(bits(slot - p));
            bv = bv.max(bits(v));
            p = slot;
        }
        prev = p;
        (c, base, bd, bv)
    })
}

fn varints_len(pairs: &[(u32, u32)]) -> usize {
    let mut prev = 0u32;
    let mut n = 0;
    for &(slot, v) in pairs {
        n += crate::log::format::uvarint_len(u64::from(slot - prev) << 1);
        prev = slot;
        if v != 1 {
            n += crate::log::format::uvarint_len(u64::from(v));
        }
    }
    n
}

fn packed_len(pairs: &[(u32, u32)]) -> usize {
    chunks(pairs)
        .map(|(c, _, bd, bv)| 2 + ((bd + bv) as usize * c.len()).div_ceil(8))
        .sum()
}

fn put_map(out: &mut Vec<u8>, pairs: &[(u32, u32)]) {
    let varints = varints_len(pairs) < packed_len(pairs);
    put_uvarint(out, (pairs.len() as u64) << 1 | u64::from(varints));
    if varints {
        let mut prev = 0u32;
        for &(slot, v) in pairs {
            let d = u64::from(slot - prev);
            prev = slot;
            if v == 1 {
                put_uvarint(out, d << 1 | 1);
            } else {
                put_uvarint(out, d << 1);
                put_uvarint(out, u64::from(v));
            }
        }
        return;
    }
    for (c, base, bd, bv) in chunks(pairs) {
        out.push(bd as u8);
        out.push(bv as u8);
        let (mut acc, mut n, mut p) = (0u64, 0u32, base);
        let mut push = |x: u32, w: u32, acc: &mut u64, n: &mut u32| {
            *acc |= u64::from(x) << *n;
            *n += w;
            while *n >= 8 {
                out.push(*acc as u8);
                *acc >>= 8;
                *n -= 8;
            }
        };
        for &(slot, v) in c {
            push(slot - p, bd, &mut acc, &mut n);
            push(v, bv, &mut acc, &mut n);
            p = slot;
        }
        if n > 0 {
            out.push(acc as u8);
        }
    }
}

fn map_len(pairs: &[(u32, u32)]) -> usize {
    crate::log::format::uvarint_len((pairs.len() as u64) << 1)
        + varints_len(pairs).min(packed_len(pairs))
}

/// A map's pairs from `map_bytes` (or a `Map` payload).
pub fn map_pairs(b: &[u8]) -> Option<Vec<(u32, u32)>> {
    let mut at = 0;
    let head = get_uvarint(b, &mut at).ok()?;
    let count = usize::try_from(head >> 1).ok()?;
    let mut out = Vec::with_capacity(count.min(b.len() * 8));
    let mut slot = 0u32;
    if head & 1 == 1 {
        for _ in 0..count {
            let d = get_uvarint(b, &mut at).ok()?;
            if d >> 1 == 0 && !out.is_empty() {
                return None;
            }
            slot = slot.checked_add(u32::try_from(d >> 1).ok()?)?;
            let v = if d & 1 == 1 {
                1
            } else {
                u32::try_from(get_uvarint(b, &mut at).ok()?).ok()?
            };
            out.push((slot, v));
        }
        return (at == b.len()).then_some(out);
    }
    while out.len() < count {
        let (bd, bv) = (u32::from(*b.get(at)?), u32::from(*b.get(at + 1)?));
        if bd > 32 || bv > 32 {
            return None;
        }
        at += 2;
        let n = (count - out.len()).min(CHUNK);
        let bytes = ((bd + bv) as usize * n).div_ceil(8);
        let data = b.get(at..at + bytes)?;
        at += bytes;
        let (mut acc, mut have, mut i) = (0u64, 0u32, 0usize);
        let mut take = |w: u32| -> u32 {
            while have < w {
                acc |= u64::from(data[i]) << have;
                i += 1;
                have += 8;
            }
            let x = (acc & ((1u64 << w) - 1)) as u32;
            acc >>= w;
            have -= w;
            x
        };
        for _ in 0..n {
            let d = take(bd);
            let v = take(bv);
            if d == 0 && !out.is_empty() {
                return None;
            }
            slot = slot.checked_add(d)?;
            out.push((slot, v));
        }
    }
    (at == b.len()).then_some(out)
}

fn bits64(v: u64) -> u32 {
    64 - v.leading_zeros()
}

/// Each chunk's widths, for a map of wide counts.
fn count_chunks(pairs: &[(u32, u64)]) -> impl Iterator<Item = (&[(u32, u64)], u32, u32, u32)> {
    let mut prev = 0u32;
    pairs.chunks(CHUNK).map(move |c| {
        let base = prev;
        let (mut bd, mut bv, mut p) = (0, 0, base);
        for &(slot, v) in c {
            bd = bd.max(bits(slot - p));
            bv = bv.max(bits64(v));
            p = slot;
        }
        prev = p;
        (c, base, bd, bv)
    })
}

fn count_varints_len(pairs: &[(u32, u64)]) -> usize {
    let mut prev = 0u32;
    let mut n = 0;
    for &(slot, v) in pairs {
        n += crate::log::format::uvarint_len(u64::from(slot - prev) << 1);
        prev = slot;
        if v != 1 {
            n += crate::log::format::uvarint_len(v);
        }
    }
    n
}

fn count_packed_len(pairs: &[(u32, u64)]) -> usize {
    count_chunks(pairs)
        .map(|(c, _, bd, bv)| 2 + ((bd + bv) as usize * c.len()).div_ceil(8))
        .sum()
}

/// `put_map` for counts up to 64 bits: the same layout, value widths up to 64.
fn put_counts(out: &mut Vec<u8>, pairs: &[(u32, u64)]) {
    let varints = count_varints_len(pairs) < count_packed_len(pairs);
    put_uvarint(out, (pairs.len() as u64) << 1 | u64::from(varints));
    if varints {
        let mut prev = 0u32;
        for &(slot, v) in pairs {
            let d = u64::from(slot - prev);
            prev = slot;
            if v == 1 {
                put_uvarint(out, d << 1 | 1);
            } else {
                put_uvarint(out, d << 1);
                put_uvarint(out, v);
            }
        }
        return;
    }
    for (c, base, bd, bv) in count_chunks(pairs) {
        out.push(bd as u8);
        out.push(bv as u8);
        // At most 7 bits left over plus a 64-bit width: a u128 holds them.
        let (mut acc, mut n, mut p) = (0u128, 0u32, base);
        let mut push = |x: u64, w: u32, acc: &mut u128, n: &mut u32| {
            *acc |= u128::from(x) << *n;
            *n += w;
            while *n >= 8 {
                out.push(*acc as u8);
                *acc >>= 8;
                *n -= 8;
            }
        };
        for &(slot, v) in c {
            push(u64::from(slot - p), bd, &mut acc, &mut n);
            push(v, bv, &mut acc, &mut n);
            p = slot;
        }
        if n > 0 {
            out.push(acc as u8);
        }
    }
}

fn count_len(pairs: &[(u32, u64)]) -> usize {
    crate::log::format::uvarint_len((pairs.len() as u64) << 1)
        + count_varints_len(pairs).min(count_packed_len(pairs))
}

/// `map_bytes` for counts up to 64 bits. Counts that all fit in 32 bits give exactly `map_bytes`'s bytes.
pub fn count_bytes(pairs: &[(u32, u64)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(count_len(pairs));
    put_counts(&mut out, pairs);
    out
}

/// A map's pairs from `count_bytes` (or `map_bytes`), counts up to 64 bits.
pub fn map_counts(b: &[u8]) -> Option<Vec<(u32, u64)>> {
    let mut at = 0;
    let head = get_uvarint(b, &mut at).ok()?;
    let count = usize::try_from(head >> 1).ok()?;
    let mut out = Vec::with_capacity(count.min(b.len() * 8));
    let mut slot = 0u32;
    if head & 1 == 1 {
        for _ in 0..count {
            let d = get_uvarint(b, &mut at).ok()?;
            if d >> 1 == 0 && !out.is_empty() {
                return None;
            }
            slot = slot.checked_add(u32::try_from(d >> 1).ok()?)?;
            let v = if d & 1 == 1 {
                1
            } else {
                get_uvarint(b, &mut at).ok()?
            };
            out.push((slot, v));
        }
        return (at == b.len()).then_some(out);
    }
    while out.len() < count {
        let (bd, bv) = (u32::from(*b.get(at)?), u32::from(*b.get(at + 1)?));
        if bd > 32 || bv > 64 {
            return None;
        }
        at += 2;
        let n = (count - out.len()).min(CHUNK);
        let bytes = ((bd + bv) as usize * n).div_ceil(8);
        let data = b.get(at..at + bytes)?;
        at += bytes;
        let (mut acc, mut have, mut i) = (0u128, 0u32, 0usize);
        let mut take = |w: u32| -> u64 {
            while have < w {
                acc |= u128::from(data[i]) << have;
                i += 1;
                have += 8;
            }
            let x = (acc & ((1u128 << w) - 1)) as u64;
            acc >>= w;
            have -= w;
            x
        };
        for _ in 0..n {
            let d = take(bd) as u32;
            let v = take(bv);
            if d == 0 && !out.is_empty() {
                return None;
            }
            slot = slot.checked_add(d)?;
            out.push((slot, v));
        }
    }
    (at == b.len()).then_some(out)
}

/// `newer`'s pairs over `older`'s, sorted by slot.
pub fn map_over(newer: &[(u32, u32)], mut older: Vec<(u32, u32)>) -> Vec<(u32, u32)> {
    if newer.is_empty() {
        return older;
    }
    // Pairs past every older slot, as ids growing in order bring them: appended.
    if older.last().is_none_or(|&(s, _)| s < newer[0].0) {
        older.extend_from_slice(newer);
        return older;
    }
    let mut out = Vec::with_capacity(older.len() + newer.len());
    let (mut i, mut j) = (0, 0);
    while i < newer.len() || j < older.len() {
        match (newer.get(i), older.get(j)) {
            (Some(n), Some(o)) if n.0 == o.0 => {
                out.push(*n);
                i += 1;
                j += 1;
            }
            (Some(n), Some(o)) if n.0 < o.0 => {
                out.push(*n);
                i += 1;
            }
            (Some(n), None) => {
                out.push(*n);
                i += 1;
            }
            (_, Some(o)) => {
                out.push(*o);
                j += 1;
            }
            (None, None) => unreachable!(),
        }
    }
    out
}

/// Two maps' pairs, each slot at the higher value, sorted by slot.
pub fn map_max(a: &[(u32, u32)], mut b: Vec<(u32, u32)>) -> Vec<(u32, u32)> {
    if a.is_empty() {
        return b;
    }
    if b.last().is_none_or(|&(s, _)| s < a[0].0) {
        b.extend_from_slice(a);
        return b;
    }
    let mut out = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        match (a.get(i), b.get(j)) {
            (Some(x), Some(y)) if x.0 == y.0 => {
                out.push((x.0, x.1.max(y.1)));
                i += 1;
                j += 1;
            }
            (Some(x), Some(y)) if x.0 < y.0 => {
                out.push(*x);
                i += 1;
            }
            (Some(x), None) => {
                out.push(*x);
                i += 1;
            }
            (_, Some(y)) => {
                out.push(*y);
                j += 1;
            }
            (None, None) => unreachable!(),
        }
    }
    out
}

/// Two sets of deltas summed per slot (wrapping, as `Add`'s), sums of 0 dropped, sorted by slot.
pub fn add_pairs(a: &[(u32, i64)], mut b: Vec<(u32, i64)>) -> Vec<(u32, i64)> {
    if a.is_empty() {
        return b;
    }
    if b.last().is_none_or(|&(s, _)| s < a[0].0) {
        b.extend_from_slice(a);
        return b;
    }
    let mut out = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        match (a.get(i), b.get(j)) {
            (Some(x), Some(y)) if x.0 == y.0 => {
                let d = x.1.wrapping_add(y.1);
                if d != 0 {
                    out.push((x.0, d));
                }
                i += 1;
                j += 1;
            }
            (Some(x), Some(y)) if x.0 < y.0 => {
                out.push(*x);
                i += 1;
            }
            (Some(x), None) => {
                out.push(*x);
                i += 1;
            }
            (_, Some(y)) => {
                out.push(*y);
                j += 1;
            }
            (None, None) => unreachable!(),
        }
    }
    out
}

/// `deltas` added onto the counts of a whole map (`base`, sorted by slot), sorted by slot, counts of 0 dropped.
/// A count that leaves the range of a count is a fault in the derived data: the slot is dropped and logged.
pub fn add_onto(key: &[u8], deltas: &[(u32, i64)], base: Vec<(u32, u64)>) -> Vec<(u32, u64)> {
    let mut out = Vec::with_capacity(base.len() + deltas.len());
    let mut put = |slot: u32, n: i128| {
        if n == 0 {
            return;
        }
        match u64::try_from(n) {
            Ok(v) => out.push((slot, v)),
            Err(_) => {
                debug_assert!(false, "an AddMap takes slot {slot} of key {key:?} to {n}");
                eprintln!(
                    "st-engine: an added map's slot left the range of a count, dropped: key {key:?}, slot {slot}, count {n}"
                );
            }
        }
    };
    let (mut i, mut j) = (0, 0);
    while i < deltas.len() || j < base.len() {
        match (deltas.get(i), base.get(j)) {
            (Some(d), Some(b)) if d.0 == b.0 => {
                put(d.0, i128::from(b.1) + i128::from(d.1));
                i += 1;
                j += 1;
            }
            (Some(d), Some(b)) if d.0 < b.0 => {
                put(d.0, i128::from(d.1));
                i += 1;
            }
            (Some(d), None) => {
                put(d.0, i128::from(d.1));
                i += 1;
            }
            (_, Some(b)) => {
                put(b.0, i128::from(b.1));
                j += 1;
            }
            (None, None) => unreachable!(),
        }
    }
    out
}

/// Deltas as a map's pairs, each zigzagged: an `AddMap` value's payload. A delta that fits in an `i32` zigzags
/// to what it did as one, so its payload is a narrow map's bytes.
fn add_map_pairs(deltas: &[(u32, i64)]) -> Vec<(u32, u64)> {
    deltas.iter().map(|&(s, d)| (s, zigzag(d))).collect()
}

/// A map's pairs as stored: removals dropped; nothing when empty.
fn map_stored(mut pairs: Vec<(u32, u32)>) -> Val {
    pairs.retain(|&(_, v)| v != 0);
    if pairs.is_empty() {
        Val::Del
    } else {
        Val::Put(map_bytes(&pairs))
    }
}

/// Counts narrowed to a map's pairs; None when one doesn't fit in 32 bits.
fn narrow(p: Vec<(u32, u64)>) -> Option<Vec<(u32, u32)>> {
    p.into_iter()
        .map(|(s, v)| u32::try_from(v).ok().map(|v| (s, v)))
        .collect()
}

/// Counts as stored: nothing when empty.
fn counts_stored(pairs: Vec<(u32, u64)>) -> Val {
    if pairs.is_empty() {
        Val::Del
    } else {
        Val::Put(count_bytes(&pairs))
    }
}

/// A maximum's value as `Put` bytes.
pub fn max_bytes(n: u64) -> Vec<u8> {
    let mut out = Vec::new();
    put_uvarint(&mut out, n);
    out
}

/// A maximum's value from `Put` bytes.
pub fn max_value(b: &[u8]) -> Option<u64> {
    let mut at = 0;
    let v = get_uvarint(b, &mut at).ok()?;
    (at == b.len()).then_some(v)
}

fn zigzag(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

fn unzigzag(v: u64) -> i64 {
    ((v >> 1) as i64) ^ -((v & 1) as i64)
}

/// A counter's value as `Put` bytes.
pub fn counter_bytes(n: i64) -> Vec<u8> {
    let mut out = Vec::new();
    put_uvarint(&mut out, zigzag(n));
    out
}

/// A counter's value from `Put` bytes.
pub fn counter_value(b: &[u8]) -> Option<i64> {
    let mut at = 0;
    let v = get_uvarint(b, &mut at).ok()?;
    (at == b.len()).then_some(unzigzag(v))
}

impl Val {
    /// This value (newer) over `older`, the values of `key`.
    pub fn over(self, key: &[u8], older: &Val) -> Val {
        match (self, older) {
            (Val::Add(d), Val::Add(o)) => Val::Add(o.wrapping_add(d)),
            (Val::Add(d), Val::Put(b)) => {
                let base = counter_value(b);
                debug_assert!(base.is_some(), "an Add over a value that isn't a counter");
                Val::Put(counter_bytes(base.unwrap_or(0).wrapping_add(d)))
            }
            (Val::Add(d), Val::Del) => Val::Put(counter_bytes(d)),
            (Val::Max(m), Val::Max(o)) => Val::Max(m.max(*o)),
            (Val::Max(m), Val::Put(b)) => {
                let base = max_value(b);
                debug_assert!(base.is_some(), "a Max over a value that isn't a maximum");
                Val::Put(max_bytes(base.unwrap_or(0).max(m)))
            }
            (Val::Max(m), Val::Del) => Val::Put(max_bytes(m)),
            (Val::Map(n), Val::Map(o)) => Val::Map(map_over(&n, o.clone())),
            (Val::Map(n), Val::Put(b)) => {
                let base = map_pairs(b);
                debug_assert!(base.is_some(), "a Map over a value that isn't a map");
                map_stored(map_over(&n, base.unwrap_or_default()))
            }
            (Val::Map(n), Val::Del) => map_stored(n),
            (Val::MaxMap(n), Val::MaxMap(o)) => Val::MaxMap(map_max(&n, o.clone())),
            (Val::MaxMap(n), Val::Put(b)) => {
                let base = map_pairs(b);
                debug_assert!(base.is_some(), "a MaxMap over a value that isn't a map");
                map_stored(map_max(&n, base.unwrap_or_default()))
            }
            (Val::MaxMap(n), Val::Del) => map_stored(n),
            (Val::AddMap(n), Val::AddMap(o)) => Val::AddMap(add_pairs(&n, o.clone())),
            (Val::AddMap(n), Val::Put(b)) => {
                let base = map_counts(b);
                debug_assert!(base.is_some(), "an AddMap over a value that isn't a map");
                counts_stored(add_onto(key, &n, base.unwrap_or_default()))
            }
            (Val::AddMap(n), Val::Del) => counts_stored(add_onto(key, &n, Vec::new())),
            (Val::AddMap(n), Val::Counts(p)) => Val::Counts(add_onto(key, &n, p.clone())),
            (v @ Val::AddMap(_), Val::Map(_) | Val::MaxMap(_))
            | (v @ (Val::Map(_) | Val::MaxMap(_)), Val::AddMap(_) | Val::Counts(_)) => {
                debug_assert!(false, "an AddMap and another map at one key {key:?}");
                v
            }
            (v, _) => v,
        }
    }

    /// This value (newer) over `settled`, the value `key`'s older values settle to (`settled`), whose `Map` is
    /// the whole map. The settled forms only `settled` makes, `Counts` and the `Map` a key written by `MaxMap`
    /// settles to, combine with a newer value here; `over` would take the newer value alone.
    pub fn over_settled(self, key: &[u8], settled: &Val) -> Val {
        match (self, settled) {
            (Val::AddMap(n), Val::Counts(p)) => Val::Counts(add_onto(key, &n, p.clone())),
            (Val::MaxMap(n), Val::Map(p)) => Val::Map(map_max(&n, p.clone())),
            (v, b) => v.over(key, b),
        }
    }

    /// `over`, taking the older value: a map over a map is merged in place.
    pub fn over_owned(self, key: &[u8], older: Val) -> Val {
        match (self, older) {
            (Val::Map(n), Val::Map(o)) => Val::Map(map_over(&n, o)),
            (Val::MaxMap(n), Val::MaxMap(o)) => Val::MaxMap(map_max(&n, o)),
            (Val::AddMap(n), Val::AddMap(o)) => Val::AddMap(add_pairs(&n, o)),
            (v, o) => v.over(key, &o),
        }
    }

    /// Whether the value builds on older ones (an `Add`, a `Max` or a map's), so a read goes on to them.
    pub fn is_partial(&self) -> bool {
        matches!(
            self,
            Val::Add(_) | Val::Max(_) | Val::Map(_) | Val::MaxMap(_) | Val::AddMap(_)
        )
    }

    /// The value as the oldest one of `key`'s: a `Del` is nothing, an `Add` a counter from 0, a `Max` itself, a
    /// map its pairs (an `AddMap`'s added onto an empty map; nothing when none is left).
    pub fn bottom(self, key: &[u8]) -> Option<Val> {
        match self {
            Val::Del => None,
            Val::Add(d) => Some(Val::Put(counter_bytes(d))),
            Val::Max(m) => Some(Val::Put(max_bytes(m))),
            Val::Map(pairs) | Val::MaxMap(pairs) => match map_stored(pairs) {
                Val::Del => None,
                v => Some(v),
            },
            Val::AddMap(d) => match counts_stored(add_onto(key, &d, Vec::new())) {
                Val::Del => None,
                v => Some(v),
            },
            Val::Counts(p) => Some(counts_stored(p)),
            v => Some(v),
        }
    }

    /// The value it amounts to when nothing older exists, a map kept as its pairs (none removed): `resolved`
    /// without encoding a map that a reader would decode again.
    pub fn settled(self, key: &[u8]) -> Option<Val> {
        match self {
            Val::Map(mut pairs) | Val::MaxMap(mut pairs) => {
                pairs.retain(|&(_, v)| v != 0);
                (!pairs.is_empty()).then_some(Val::Map(pairs))
            }
            Val::AddMap(d) => {
                let pairs = add_onto(key, &d, Vec::new());
                (!pairs.is_empty()).then_some(Val::Counts(pairs))
            }
            Val::Counts(p) => (!p.is_empty()).then_some(Val::Counts(p)),
            v => v.bottom(key),
        }
    }

    /// A settled value's map pairs; None when a count doesn't fit in 32 bits.
    pub fn into_pairs(self, key: &[u8]) -> Option<Vec<(u32, u32)>> {
        match self {
            Val::Map(p) => Some(p),
            Val::Put(b) => map_pairs(&b),
            Val::Counts(p) => narrow(p),
            Val::AddMap(d) => narrow(add_onto(key, &d, Vec::new())),
            _ => None,
        }
    }

    /// A settled value's counts (an `AddMap` key's).
    pub fn into_counts(self, key: &[u8]) -> Option<Vec<(u32, u64)>> {
        match self {
            Val::Counts(p) => Some(p),
            Val::Put(b) => map_counts(&b),
            Val::AddMap(d) => Some(add_onto(key, &d, Vec::new())),
            _ => None,
        }
    }

    /// A settled value's bytes (a map's encoded).
    pub fn into_bytes(self, key: &[u8]) -> Vec<u8> {
        match self {
            Val::Put(b) => b,
            Val::Map(p) => map_bytes(&p),
            Val::Counts(p) => count_bytes(&p),
            v => v.resolved(key).unwrap_or_default(),
        }
    }

    /// The value it resolves to when nothing older exists.
    pub fn resolved(self, key: &[u8]) -> Option<Vec<u8>> {
        match self.bottom(key)? {
            Val::Put(b) => Some(b),
            _ => unreachable!(),
        }
    }

    /// Bytes of the encoded value (without its tag).
    pub fn payload_len(&self) -> usize {
        match self {
            Val::Put(b) => b.len(),
            Val::Del => 0,
            Val::Add(d) => crate::log::format::uvarint_len(zigzag(*d)),
            Val::Max(m) => crate::log::format::uvarint_len(*m),
            Val::Map(pairs) | Val::MaxMap(pairs) => map_len(pairs),
            Val::AddMap(d) => count_len(&add_map_pairs(d)),
            Val::Counts(p) => count_len(p),
        }
    }

    /// Appends the tag varint `(payload length << 3) | kind`, then the payload.
    pub fn encode(&self, out: &mut Vec<u8>) {
        match self {
            Val::Put(b) => {
                put_uvarint(out, (b.len() as u64) << 3);
                out.extend_from_slice(b);
            }
            Val::Del => put_uvarint(out, 1),
            Val::Add(d) => {
                let mut p = Vec::new();
                put_uvarint(&mut p, zigzag(*d));
                put_uvarint(out, ((p.len() as u64) << 3) | 2);
                out.extend_from_slice(&p);
            }
            Val::Max(m) => {
                put_uvarint(out, ((crate::log::format::uvarint_len(*m) as u64) << 3) | 3);
                put_uvarint(out, *m);
            }
            Val::Map(pairs) => {
                put_uvarint(out, ((map_len(pairs) as u64) << 3) | 4);
                put_map(out, pairs);
            }
            Val::MaxMap(pairs) => {
                put_uvarint(out, ((map_len(pairs) as u64) << 3) | 5);
                put_map(out, pairs);
            }
            Val::AddMap(d) => {
                let pairs = add_map_pairs(d);
                put_uvarint(out, ((count_len(&pairs) as u64) << 3) | 6);
                put_counts(out, &pairs);
            }
            Val::Counts(p) => {
                put_uvarint(out, (count_len(p) as u64) << 3);
                put_counts(out, p);
            }
        }
    }

    /// Decodes a value written by `encode`.
    pub fn decode(buf: &[u8], at: &mut usize) -> Option<Val> {
        let tag = get_uvarint(buf, at).ok()?;
        let len = usize::try_from(tag >> 3).ok()?;
        let end = at.checked_add(len)?;
        let payload = buf.get(*at..end)?;
        *at = end;
        match tag & 7 {
            0 => Some(Val::Put(payload.to_vec())),
            1 if len == 0 => Some(Val::Del),
            2 => {
                let mut p = 0;
                let v = get_uvarint(payload, &mut p).ok()?;
                (p == payload.len()).then_some(Val::Add(unzigzag(v)))
            }
            3 => max_value(payload).map(Val::Max),
            4 => map_pairs(payload).map(Val::Map),
            5 => map_pairs(payload).map(Val::MaxMap),
            6 => map_counts(payload)
                .map(|p| Val::AddMap(p.into_iter().map(|(s, z)| (s, unzigzag(z))).collect())),
            _ => None,
        }
    }
}

/// Folds `key`'s values, newest first, into the value they amount to.
pub fn fold<I: IntoIterator<Item = Val>>(key: &[u8], vals: I) -> Option<Val> {
    let mut acc: Option<Val> = None;
    for v in vals {
        let next = match acc {
            None => v,
            Some(newer) => newer.over(key, &v),
        };
        if !next.is_partial() {
            return Some(next);
        }
        acc = Some(next);
    }
    acc
}

// ---- key encodings: every component is prefix-free and sorts as its value ----

/// A u64 as one length byte (0–8) and its big-endian bytes without leading zeros: sorts numerically.
pub fn put_u64(out: &mut Vec<u8>, v: u64) {
    let n = (8 - v.leading_zeros() / 8) as usize;
    out.push(n as u8);
    out.extend_from_slice(&v.to_be_bytes()[8 - n..]);
}

pub fn get_u64(buf: &[u8], at: &mut usize) -> Option<u64> {
    let n = usize::from(*buf.get(*at)?);
    let bytes = buf.get(*at + 1..*at + 1 + n)?;
    if n > 8 || bytes.first() == Some(&0) {
        return None;
    }
    *at += 1 + n;
    Some(bytes.iter().fold(0, |acc, b| (acc << 8) | u64::from(*b)))
}

/// Bytes with 0x00 written as 0x00 0xff and ended by 0x00 0x01: sorts as the bytes do.
pub fn put_bytes(out: &mut Vec<u8>, b: &[u8]) {
    for &c in b {
        out.push(c);
        if c == 0 {
            out.push(0xff);
        }
    }
    out.extend_from_slice(&[0, 1]);
}

pub fn get_bytes(buf: &[u8], at: &mut usize) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let c = *buf.get(*at)?;
        *at += 1;
        if c != 0 {
            out.push(c);
            continue;
        }
        let next = *buf.get(*at)?;
        *at += 1;
        match next {
            0xff => out.push(0),
            1 => return Some(out),
            _ => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const K: &[u8] = b"k";

    #[test]
    fn u64_keys_sort_numerically_and_round_trip() {
        let vals = [0u64, 1, 255, 256, 65535, 1 << 34, u64::MAX];
        let enc: Vec<Vec<u8>> = vals
            .iter()
            .map(|v| {
                let mut b = Vec::new();
                put_u64(&mut b, *v);
                b
            })
            .collect();
        for w in enc.windows(2) {
            assert!(w[0] < w[1]);
        }
        for (v, e) in vals.iter().zip(&enc) {
            let mut at = 0;
            assert_eq!(get_u64(e, &mut at), Some(*v));
            assert_eq!(at, e.len());
        }
    }

    #[test]
    fn byte_keys_sort_as_bytes_and_are_prefix_free() {
        let vals: [&[u8]; 6] = [b"", b"\0", b"\0\0", b"\0a", b"a", b"a\0"];
        let enc: Vec<Vec<u8>> = vals
            .iter()
            .map(|v| {
                let mut b = Vec::new();
                put_bytes(&mut b, v);
                b.push(7);
                b
            })
            .collect();
        for w in enc.windows(2) {
            assert!(w[0] < w[1]);
        }
        for (v, e) in vals.iter().zip(&enc) {
            let mut at = 0;
            assert_eq!(get_bytes(e, &mut at).as_deref(), Some(*v));
            assert_eq!(e[at], 7);
        }
    }

    #[test]
    fn values_fold_newest_first() {
        assert_eq!(fold(K, [Val::Add(2), Val::Add(3)]), Some(Val::Add(5)));
        assert_eq!(
            fold(K, [Val::Add(2), Val::Put(counter_bytes(10)), Val::Add(100)]),
            Some(Val::Put(counter_bytes(12)))
        );
        assert_eq!(
            fold(K, [Val::Add(2), Val::Del]),
            Some(Val::Put(counter_bytes(2)))
        );
        assert_eq!(fold(K, [Val::Del, Val::Put(vec![1])]), Some(Val::Del));
        assert_eq!(fold(K, [Val::Max(2), Val::Max(7)]), Some(Val::Max(7)));
        assert_eq!(
            fold(K, [Val::Max(9), Val::Put(max_bytes(4)), Val::Max(100)]),
            Some(Val::Put(max_bytes(9)))
        );
        assert_eq!(
            fold(K, [Val::Max(3), Val::Del]),
            Some(Val::Put(max_bytes(3)))
        );
        // Maps: newer slots win, 0 removes, an empty map is no value.
        let older = Val::Put(map_bytes(&[(1, 1), (5, 7), (9, 2)]));
        assert_eq!(
            fold(
                K,
                [
                    Val::Map(vec![(5, 0), (6, 3)]),
                    Val::Map(vec![(1, 4)]),
                    older.clone()
                ]
            ),
            Some(Val::Put(map_bytes(&[(1, 4), (6, 3), (9, 2)])))
        );
        assert_eq!(
            fold(K, [Val::Map(vec![(1, 0), (5, 0), (9, 0)]), older]),
            Some(Val::Del)
        );
        assert_eq!(Val::Map(vec![(3, 0)]).bottom(K), None);
        // Maxima per slot.
        assert_eq!(
            fold(
                K,
                [
                    Val::MaxMap(vec![(1, 3), (4, 1)]),
                    Val::MaxMap(vec![(1, 5), (2, 2)]),
                    Val::Put(map_bytes(&[(2, 7), (9, 1)]))
                ]
            ),
            Some(Val::Put(map_bytes(&[(1, 5), (2, 7), (4, 1), (9, 1)])))
        );
        assert_eq!(
            Val::Map(vec![(2, 1), (300, 9)]).over_owned(K, Val::Map(vec![(1, 5), (2, 4)])),
            Val::Map(vec![(1, 5), (2, 1), (300, 9)])
        );
        for v in [
            Val::Put(vec![1, 2]),
            Val::Del,
            Val::Add(-7),
            Val::Add(i64::MIN),
            Val::Max(0),
            Val::Max(u64::MAX),
            Val::Map(vec![(0, 1), (7, 0), (1 << 20, u32::MAX)]),
            Val::Map(Vec::new()),
            Val::Map((0..300).map(|i| (i * 16 + 3, i % 5 + 1)).collect()),
            Val::Map((0..300).map(|i| (i * i, (i * 7) % 3)).collect()),
            Val::MaxMap(vec![(0, 2), (9, 70000)]),
        ] {
            let mut b = Vec::new();
            v.encode(&mut b);
            let mut at = 0;
            assert_eq!(Val::decode(&b, &mut at), Some(v));
            assert_eq!(at, b.len());
        }
    }

    /// Every value one bracketing of combining `vals` (newest first) neighbour by neighbour can give.
    fn bracketings(vals: &[Val]) -> Vec<Val> {
        if vals.len() == 1 {
            return vec![vals[0].clone()];
        }
        let mut out = Vec::new();
        for cut in 1..vals.len() {
            for newer in bracketings(&vals[..cut]) {
                for older in bracketings(&vals[cut..]) {
                    out.push(newer.clone().over_owned(K, older));
                }
            }
        }
        out
    }

    fn permutations(v: Vec<Val>) -> Vec<Vec<Val>> {
        if v.len() <= 1 {
            return vec![v];
        }
        let mut out = Vec::new();
        for i in 0..v.len() {
            let mut rest = v.clone();
            let first = rest.remove(i);
            for mut p in permutations(rest) {
                p.insert(0, first.clone());
                out.push(p);
            }
        }
        out
    }

    #[test]
    fn added_maps_merged_in_any_order_give_what_adding_each_in_turn_gives() {
        let base_pairs = [(1, 2), (5, 1)];
        let base = Val::Put(map_bytes(&base_pairs));
        // Oldest first.
        let adds = vec![
            Val::AddMap(vec![(1, -1), (3, 2)]),
            Val::AddMap(vec![(5, -1), (9, 4)]),
            Val::AddMap(vec![(1, -1), (3, -1), (9, -4)]),
            Val::AddMap(vec![(3, -1), (7, 1)]),
        ];
        let mut seq = base.clone();
        let mut steps = Vec::new();
        for a in &adds {
            seq = a.clone().over(K, &seq);
            steps.push(seq.clone());
        }
        // Slots reaching 0 are gone: 5 at the second add, 1 and 9 at the third, 3 at the fourth.
        assert_eq!(steps[1], Val::Put(map_bytes(&[(1, 1), (3, 2), (9, 4)])));
        assert_eq!(steps[2], Val::Put(map_bytes(&[(3, 1)])));
        assert_eq!(seq, Val::Put(map_bytes(&[(7, 1)])));
        let mut tried = 0;
        for order in permutations(adds.clone()) {
            for merged in bracketings(&order) {
                assert!(merged.is_partial());
                assert_eq!(merged.clone().over(K, &base), seq);
                assert_eq!(
                    merged
                        .over_settled(
                            K,
                            &Val::Counts(
                                base_pairs.iter().map(|&(s, v)| (s, u64::from(v))).collect()
                            )
                        )
                        .settled(K),
                    Some(Val::Counts(vec![(7, 1)]))
                );
                tried += 1;
            }
            let mut newest_first = order;
            newest_first.push(base.clone());
            assert_eq!(fold(K, newest_first), Some(seq.clone()));
        }
        assert_eq!(tried, 24 * 5);
        // Deltas summing to 0 are dropped while still partial.
        assert_eq!(
            Val::AddMap(vec![(3, -1), (9, -4)])
                .over_owned(K, Val::AddMap(vec![(3, 1), (9, 4), (12, 2)])),
            Val::AddMap(vec![(12, 2)])
        );
    }

    #[test]
    fn an_added_map_with_nothing_older_is_its_counts() {
        let v = Val::AddMap(vec![(2, 3), (8, 1)]);
        let stored = Val::Put(map_bytes(&[(2, 3), (8, 1)]));
        assert_eq!(
            v.clone().settled(K),
            Some(Val::Counts(vec![(2, 3), (8, 1)]))
        );
        assert_eq!(v.clone().bottom(K), Some(stored.clone()));
        assert_eq!(v.clone().into_pairs(K), Some(vec![(2, 3), (8, 1)]));
        assert_eq!(v.clone().over(K, &Val::Del), stored);
        assert_eq!(
            fold(K, [v, Val::Del, Val::Put(map_bytes(&[(2, 9)]))]),
            Some(stored.clone())
        );
        // Every count back at 0: no value.
        let gone = Val::AddMap(vec![(2, -3), (8, -1)]);
        assert_eq!(gone.over(K, &stored), Val::Del);
        assert_eq!(Val::AddMap(Vec::new()).bottom(K), None);
        assert_eq!(Val::AddMap(Vec::new()).settled(K), None);
    }

    fn form(b: &[u8]) -> u64 {
        get_uvarint(b, &mut 0).unwrap() & 1
    }

    #[test]
    fn wide_counts_encode_as_narrow_maps_do_when_they_fit() {
        let added: [(u32, i32); 4] = [
            (0, 1),
            (7, -1),
            (1 << 20, i32::MIN),
            ((1 << 20) + 1, i32::MAX),
        ];
        let maps: Vec<Vec<(u32, u32)>> = vec![
            vec![(0, 1), (7, 0), (1 << 20, u32::MAX)],
            Vec::new(),
            (0..300).map(|i| (i * 16 + 3, i % 5 + 1)).collect(),
            (0..300).map(|i| (i * i, (i * 7) % 3)).collect(),
            vec![(0, 2), (9, 70000)],
            (0..300)
                .map(|i| (i * 16 + 3, ((i as i32 % 7) - 3)))
                .filter(|x| x.1 != 0)
                .map(|(s, d)| (s, zigzag(i64::from(d)) as u32))
                .collect(),
            (0..300)
                .map(|i| (i * i, zigzag(if i % 2 == 0 { 1 } else { -2 }) as u32))
                .collect(),
            added
                .iter()
                .map(|&(s, d)| (s, zigzag(i64::from(d)) as u32))
                .collect(),
        ];
        for narrow in maps {
            let wide: Vec<(u32, u64)> = narrow.iter().map(|&(s, v)| (s, u64::from(v))).collect();
            assert_eq!(count_bytes(&wide), map_bytes(&narrow));
            assert_eq!(map_counts(&map_bytes(&narrow)), Some(wide));
        }
    }

    #[test]
    fn wide_counts_round_trip_in_both_forms() {
        for big in [1u64 << 32, 1 << 33, u64::MAX] {
            let varints = vec![(0u32, big), (1 << 30, 1)];
            let packed: Vec<(u32, u64)> = (0..200).map(|i| (i, big - u64::from(i))).collect();
            for (pairs, want) in [(varints, 1), (packed, 0)] {
                let b = count_bytes(&pairs);
                assert_eq!(form(&b), want);
                assert_eq!(b.len(), count_len(&pairs));
                assert_eq!(map_counts(&b), Some(pairs));
                // A narrow reader rejects a count past 32 bits.
                assert_eq!(map_pairs(&b), None);
            }
        }
    }

    #[test]
    fn an_added_map_keeps_a_count_past_32_bits() {
        let past = (1i64 << 32) + 5;
        let v = Val::AddMap(vec![(2, i64::from(u32::MAX)), (8, 1)])
            .over_owned(K, Val::AddMap(vec![(2, 6), (8, 1)]));
        let want = vec![(2, past as u64), (8, 2)];
        assert_eq!(v.clone().settled(K), Some(Val::Counts(want.clone())));
        let Some(Val::Put(b)) = v.clone().bottom(K) else {
            panic!("an added map's bottom isn't a Put");
        };
        assert_eq!(map_counts(&b), Some(want.clone()));
        assert_eq!(v.clone().into_counts(K), Some(want.clone()));
        // A narrow reader is told it doesn't fit.
        assert_eq!(v.clone().into_pairs(K), None);
        // Settled, then added onto, then stored and read back.
        let more = Val::AddMap(vec![(2, -1)]).over_settled(K, &v.settled(K).unwrap());
        assert_eq!(more, Val::Counts(vec![(2, past as u64 - 1), (8, 2)]));
        let stored = Val::AddMap(vec![(2, -1)]).over(K, &Val::Put(count_bytes(&want)));
        assert_eq!(
            stored,
            Val::Put(count_bytes(&[(2, past as u64 - 1), (8, 2)]))
        );
    }

    #[test]
    fn added_maps_round_trip() {
        for v in [
            Val::AddMap(Vec::new()),
            Val::AddMap(vec![
                (0, 1),
                (7, -1),
                (1 << 20, i64::from(i32::MIN)),
                ((1 << 20) + 1, i64::from(i32::MAX)),
            ]),
            Val::AddMap(
                (0..300)
                    .map(|i| (i * 16 + 3, (i as i64 % 7) - 3))
                    .filter(|x| x.1 != 0)
                    .collect(),
            ),
            Val::AddMap(
                (0..300)
                    .map(|i| (i * i, if i % 2 == 0 { 1 } else { -2 }))
                    .collect(),
            ),
        ] {
            let mut b = Vec::new();
            v.encode(&mut b);
            let mut at = 0;
            assert_eq!(
                get_uvarint(&b, &mut at).unwrap() >> 3,
                v.payload_len() as u64
            );
            assert_eq!(b.len() - at, v.payload_len());
            let mut at = 0;
            assert_eq!(Val::decode(&b, &mut at), Some(v));
            assert_eq!(at, b.len());
        }
    }
}
