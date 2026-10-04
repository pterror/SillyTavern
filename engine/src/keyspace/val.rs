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

/// A map's pairs as stored: removals dropped; nothing when empty.
fn map_stored(mut pairs: Vec<(u32, u32)>) -> Val {
    pairs.retain(|&(_, v)| v != 0);
    if pairs.is_empty() {
        Val::Del
    } else {
        Val::Put(map_bytes(&pairs))
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
    /// This value (newer) over `older`.
    pub fn over(self, older: &Val) -> Val {
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
            (v, _) => v,
        }
    }

    /// `over`, taking the older value: a map over a map is merged in place.
    pub fn over_owned(self, older: Val) -> Val {
        match (self, older) {
            (Val::Map(n), Val::Map(o)) => Val::Map(map_over(&n, o)),
            (Val::MaxMap(n), Val::MaxMap(o)) => Val::MaxMap(map_max(&n, o)),
            (v, o) => v.over(&o),
        }
    }

    /// Whether the value builds on older ones (an `Add`, a `Max`, a `Map` or a `MaxMap`), so a read goes on to
    /// them.
    pub fn is_partial(&self) -> bool {
        matches!(
            self,
            Val::Add(_) | Val::Max(_) | Val::Map(_) | Val::MaxMap(_)
        )
    }

    /// The value as the oldest one of its key: a `Del` is nothing, an `Add` a counter from 0, a `Max` itself, a
    /// `Map` its pairs (nothing when none is left).
    pub fn bottom(self) -> Option<Val> {
        match self {
            Val::Del => None,
            Val::Add(d) => Some(Val::Put(counter_bytes(d))),
            Val::Max(m) => Some(Val::Put(max_bytes(m))),
            Val::Map(pairs) | Val::MaxMap(pairs) => match map_stored(pairs) {
                Val::Del => None,
                v => Some(v),
            },
            v => Some(v),
        }
    }

    /// The value it resolves to when nothing older exists.
    pub fn resolved(self) -> Option<Vec<u8>> {
        match self.bottom()? {
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
            _ => None,
        }
    }
}

/// Folds one key's values, newest first, into the value they amount to.
pub fn fold<I: IntoIterator<Item = Val>>(vals: I) -> Option<Val> {
    let mut acc: Option<Val> = None;
    for v in vals {
        let next = match acc {
            None => v,
            Some(newer) => newer.over(&v),
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
        assert_eq!(fold([Val::Add(2), Val::Add(3)]), Some(Val::Add(5)));
        assert_eq!(
            fold([Val::Add(2), Val::Put(counter_bytes(10)), Val::Add(100)]),
            Some(Val::Put(counter_bytes(12)))
        );
        assert_eq!(
            fold([Val::Add(2), Val::Del]),
            Some(Val::Put(counter_bytes(2)))
        );
        assert_eq!(fold([Val::Del, Val::Put(vec![1])]), Some(Val::Del));
        assert_eq!(fold([Val::Max(2), Val::Max(7)]), Some(Val::Max(7)));
        assert_eq!(
            fold([Val::Max(9), Val::Put(max_bytes(4)), Val::Max(100)]),
            Some(Val::Put(max_bytes(9)))
        );
        assert_eq!(fold([Val::Max(3), Val::Del]), Some(Val::Put(max_bytes(3))));
        // Maps: newer slots win, 0 removes, an empty map is no value.
        let older = Val::Put(map_bytes(&[(1, 1), (5, 7), (9, 2)]));
        assert_eq!(
            fold([
                Val::Map(vec![(5, 0), (6, 3)]),
                Val::Map(vec![(1, 4)]),
                older.clone()
            ]),
            Some(Val::Put(map_bytes(&[(1, 4), (6, 3), (9, 2)])))
        );
        assert_eq!(
            fold([Val::Map(vec![(1, 0), (5, 0), (9, 0)]), older]),
            Some(Val::Del)
        );
        assert_eq!(Val::Map(vec![(3, 0)]).bottom(), None);
        // Maxima per slot.
        assert_eq!(
            fold([
                Val::MaxMap(vec![(1, 3), (4, 1)]),
                Val::MaxMap(vec![(1, 5), (2, 2)]),
                Val::Put(map_bytes(&[(2, 7), (9, 1)]))
            ]),
            Some(Val::Put(map_bytes(&[(1, 5), (2, 7), (4, 1), (9, 1)])))
        );
        assert_eq!(
            Val::Map(vec![(2, 1), (300, 9)]).over_owned(Val::Map(vec![(1, 5), (2, 4)])),
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
}
