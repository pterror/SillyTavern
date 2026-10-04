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
            (v, _) => v,
        }
    }

    /// Whether the value builds on older ones (an `Add` or a `Max`), so a read goes on to them.
    pub fn is_partial(&self) -> bool {
        matches!(self, Val::Add(_) | Val::Max(_))
    }

    /// The value as the oldest one of its key: a `Del` is nothing, an `Add` a counter from 0, a `Max` itself.
    pub fn bottom(self) -> Option<Val> {
        match self {
            Val::Del => None,
            Val::Add(d) => Some(Val::Put(counter_bytes(d))),
            Val::Max(m) => Some(Val::Put(max_bytes(m))),
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
        }
    }

    /// Appends the tag varint `(payload length << 2) | kind`, then the payload.
    pub fn encode(&self, out: &mut Vec<u8>) {
        match self {
            Val::Put(b) => {
                put_uvarint(out, (b.len() as u64) << 2);
                out.extend_from_slice(b);
            }
            Val::Del => put_uvarint(out, 1),
            Val::Add(d) => {
                let mut p = Vec::new();
                put_uvarint(&mut p, zigzag(*d));
                put_uvarint(out, ((p.len() as u64) << 2) | 2);
                out.extend_from_slice(&p);
            }
            Val::Max(m) => {
                put_uvarint(out, ((crate::log::format::uvarint_len(*m) as u64) << 2) | 3);
                put_uvarint(out, *m);
            }
        }
    }

    /// Decodes a value written by `encode`.
    pub fn decode(buf: &[u8], at: &mut usize) -> Option<Val> {
        let tag = get_uvarint(buf, at).ok()?;
        let len = usize::try_from(tag >> 2).ok()?;
        let end = at.checked_add(len)?;
        let payload = buf.get(*at..end)?;
        *at = end;
        match tag & 3 {
            0 => Some(Val::Put(payload.to_vec())),
            1 if len == 0 => Some(Val::Del),
            2 => {
                let mut p = 0;
                let v = get_uvarint(payload, &mut p).ok()?;
                (p == payload.len()).then_some(Val::Add(unzigzag(v)))
            }
            3 => max_value(payload).map(Val::Max),
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
        for v in [
            Val::Put(vec![1, 2]),
            Val::Del,
            Val::Add(-7),
            Val::Add(i64::MIN),
            Val::Max(0),
            Val::Max(u64::MAX),
        ] {
            let mut b = Vec::new();
            v.encode(&mut b);
            let mut at = 0;
            assert_eq!(Val::decode(&b, &mut at), Some(v));
            assert_eq!(at, b.len());
        }
    }
}
