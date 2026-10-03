//! The record log's byte format: varints, the record kinds and their schemas, encoding and decoding.
//!
//! A log is a sequence of items laid out in fixed-size blocks:
//! - `0x00` pad: the rest of the block is unused; the next item starts at the next block.
//! - `0x01` trailer: ends a sync group; four bytes of CRC-32C (little-endian) follow: the CRC of the group's
//!   start position (8 bytes, little-endian), continued over every item byte since the previous trailer (pads
//!   included, unused block tails not).
//! - a record: a header varint (`>= 2`) naming the kind and carrying its bits, then the kind's values in
//!   schema order, with no per-value type tags.
//!
//! Records carry no length: a kind's schema fixes how its values are read. Ids are coded as the difference
//! from the previous id of the same space in the same block, and times as the difference from the previous
//! time in the block, so the decoding context resets at every block start.

use std::fmt;

/// A record's or an item's undecodable bytes, or a value the format can't hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FormatError {
    /// The bytes end before the item does.
    Incomplete,
    /// The bytes don't decode as an item.
    Invalid(String),
}

impl fmt::Display for FormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FormatError::Incomplete => write!(f, "the log ends inside an item"),
            FormatError::Invalid(why) => write!(f, "invalid log bytes: {why}"),
        }
    }
}

pub type FormatResult<T> = Result<T, FormatError>;

fn invalid<T>(why: impl Into<String>) -> FormatResult<T> {
    Err(FormatError::Invalid(why.into()))
}

pub const PAD: u8 = 0x00;
pub const TRAILER: u8 = 0x01;
/// A trailer's size: its marker and the CRC-32C.
pub const TRAILER_LEN: usize = 5;

/// Largest integer a JavaScript number holds exactly; the bound for every non-id integer value.
pub const MAX_SAFE: u64 = (1 << 53) - 1;
/// Ids are below 2^63, so the difference of two fits an i64.
pub const MAX_ID: u64 = i64::MAX as u64;

// ---- varints ----

pub fn put_uvarint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

pub fn get_uvarint(buf: &[u8], at: &mut usize) -> FormatResult<u64> {
    let mut v: u64 = 0;
    let mut shift = 0u32;
    loop {
        let Some(&b) = buf.get(*at) else {
            return Err(FormatError::Incomplete);
        };
        *at += 1;
        if shift == 63 && b > 1 {
            return invalid("varint overflows 64 bits");
        }
        v |= u64::from(b & 0x7f) << shift;
        if b < 0x80 {
            // A non-minimal varint (a trailing zero byte) would give one value two encodings.
            if b == 0 && shift > 0 {
                return invalid("varint not minimally encoded");
            }
            return Ok(v);
        }
        shift += 7;
        if shift > 63 {
            return invalid("varint overflows 64 bits");
        }
    }
}

fn zigzag(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

fn unzigzag(v: u64) -> i64 {
    ((v >> 1) as i64) ^ -((v & 1) as i64)
}

pub fn uvarint_len(v: u64) -> usize {
    let bits = 64 - (v | 1).leading_zeros() as usize;
    bits.div_ceil(7)
}

// ---- WTF-8: text as JavaScript holds it (UTF-16, lone surrogates included), at UTF-8's size ----

/// Encodes UTF-16 code units as WTF-8: UTF-8, with a lone surrogate as its 3-byte form.
pub fn wtf8_from_utf16(units: &[u16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(units.len());
    let mut i = 0;
    while i < units.len() {
        let u = u32::from(units[i]);
        let cp = if (0xd800..0xdc00).contains(&u)
            && i + 1 < units.len()
            && (0xdc00..0xe000).contains(&u32::from(units[i + 1]))
        {
            i += 1;
            0x10000 + ((u - 0xd800) << 10) + (u32::from(units[i]) - 0xdc00)
        } else {
            u
        };
        i += 1;
        match cp {
            0..0x80 => out.push(cp as u8),
            0x80..0x800 => {
                out.extend_from_slice(&[0xc0 | (cp >> 6) as u8, 0x80 | (cp & 0x3f) as u8])
            }
            0x800..0x10000 => out.extend_from_slice(&[
                0xe0 | (cp >> 12) as u8,
                0x80 | ((cp >> 6) & 0x3f) as u8,
                0x80 | (cp & 0x3f) as u8,
            ]),
            _ => out.extend_from_slice(&[
                0xf0 | (cp >> 18) as u8,
                0x80 | ((cp >> 12) & 0x3f) as u8,
                0x80 | ((cp >> 6) & 0x3f) as u8,
                0x80 | (cp & 0x3f) as u8,
            ]),
        }
    }
    out
}

/// Decodes well-formed WTF-8 to UTF-16 code units. A surrogate pair written as two 3-byte forms is not
/// well-formed (it has a 4-byte form), so every string has exactly one encoding.
pub fn wtf8_to_utf16(bytes: &[u8]) -> FormatResult<Vec<u16>> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let mut prev_lead = false;
    while i < bytes.len() {
        let b0 = bytes[i];
        let (cp, len) = match b0 {
            0..0x80 => (u32::from(b0), 1),
            0xc2..0xe0 => (u32::from(b0 & 0x1f), 2),
            0xe0..0xf0 => (u32::from(b0 & 0x0f), 3),
            0xf0..0xf5 => (u32::from(b0 & 0x07), 4),
            _ => return invalid("text is not WTF-8"),
        };
        if i + len > bytes.len() {
            return invalid("text is not WTF-8");
        }
        let mut cp = cp;
        for &b in &bytes[i + 1..i + len] {
            if b & 0xc0 != 0x80 {
                return invalid("text is not WTF-8");
            }
            cp = (cp << 6) | u32::from(b & 0x3f);
        }
        let min = [0, 0, 0x80, 0x800, 0x10000][len];
        if cp < min || cp > 0x10ffff {
            return invalid("text is not WTF-8");
        }
        i += len;
        if cp >= 0x10000 {
            let c = cp - 0x10000;
            out.push(0xd800 + (c >> 10) as u16);
            out.push(0xdc00 + (c & 0x3ff) as u16);
            prev_lead = false;
        } else {
            let is_trail = (0xdc00..0xe000).contains(&cp);
            if is_trail && prev_lead {
                return invalid("text is not WTF-8 (a surrogate pair in two parts)");
            }
            prev_lead = (0xd800..0xdc00).contains(&cp);
            out.push(cp as u16);
        }
    }
    Ok(out)
}

// ---- kinds ----

/// The id spaces. An id's delta is taken against the previous id of its own space.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Space {
    Entity = 0,
    Tag = 1,
    Message = 2,
    Position = 3,
    User = 4,
    /// Positions in the log.
    Log = 5,
}
pub const SPACES: usize = 6;

/// A value's type in a kind's schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ty {
    /// One bit, packed in the record's header.
    Bit,
    /// An unsigned integer up to 2^53 - 1: a varint.
    UInt,
    /// A signed integer within ±(2^53 - 1): a zigzag varint.
    Int,
    /// A float: 8 bytes, little-endian.
    F64,
    /// An id below 2^63: a zigzag varint of its difference from the previous id of the space in the block.
    Id(Space),
    /// Milliseconds since the epoch, within ±(2^53 - 1): a zigzag varint of the difference from the previous
    /// time in the block.
    Time,
    /// A field: a varint code; code 0 is the escape, followed by the key as text.
    Field,
    /// Text: a varint byte length, then WTF-8.
    Text,
    /// Bytes: a varint length, then the bytes.
    Bytes,
}

#[derive(Debug)]
pub struct Slot {
    pub name: &'static str,
    pub ty: Ty,
    /// Absent values cost nothing but a header bit.
    pub optional: bool,
}

#[derive(Debug)]
pub struct Kind {
    pub name: &'static str,
    /// The first header value of this kind; it takes `2^bits` values from there, one per combination of its
    /// bits. Fixed once written: a different schema is a new kind with new header values.
    pub base: u64,
    pub slots: &'static [Slot],
    /// Written by the engine itself, never taken from a caller.
    pub internal: bool,
}

/// A kind is its header values.
impl PartialEq for Kind {
    fn eq(&self, other: &Self) -> bool {
        self.base == other.base
    }
}

impl Kind {
    /// Bits carried in the header: one per `Bit` value and one per optional value (present or not).
    pub fn header_bits(&self) -> u32 {
        self.slots
            .iter()
            .filter(|s| s.ty == Ty::Bit || s.optional)
            .count() as u32
    }
}

const fn req(name: &'static str, ty: Ty) -> Slot {
    Slot {
        name,
        ty,
        optional: false,
    }
}
const fn opt(name: &'static str, ty: Ty) -> Slot {
    Slot {
        name,
        ty,
        optional: true,
    }
}

/// Every kind the log knows. Header values 0 and 1 are the pad and the trailer.
pub static KINDS: &[Kind] = &[
    Kind {
        name: "fav",
        base: 2,
        slots: &[req("entity", Ty::Id(Space::Entity)), req("fav", Ty::Bit)],
        internal: false,
    },
    Kind {
        name: "tagAssign",
        base: 4,
        slots: &[
            req("entity", Ty::Id(Space::Entity)),
            req("tag", Ty::Id(Space::Tag)),
            req("assigned", Ty::Bit),
        ],
        internal: false,
    },
    Kind {
        name: "pointerMove",
        base: 6,
        slots: &[
            req("session", Ty::Id(Space::Position)),
            req("user", Ty::Id(Space::User)),
            req("target", Ty::Id(Space::Message)),
        ],
        internal: false,
    },
    Kind {
        name: "forkSelection",
        base: 7,
        slots: &[
            req("message", Ty::Id(Space::Message)),
            req("reply", Ty::Id(Space::Message)),
            req("session", Ty::Id(Space::Position)),
            req("user", Ty::Id(Space::User)),
        ],
        internal: false,
    },
    Kind {
        name: "messageAppend",
        base: 8,
        slots: &[
            req("id", Ty::Id(Space::Message)),
            opt("parent", Ty::Id(Space::Message)),
            req("owner", Ty::Id(Space::Entity)),
            opt("speaker", Ty::Id(Space::Entity)),
            opt("name", Ty::Text),
            req("time", Ty::Time),
            req("text", Ty::Text),
            req("flags", Ty::UInt),
            req("session", Ty::Id(Space::Position)),
            req("user", Ty::Id(Space::User)),
        ],
        internal: false,
    },
    Kind {
        name: "textEdit",
        base: 16,
        slots: &[
            req("entity", Ty::Id(Space::Entity)),
            req("field", Ty::Field),
            req("offset", Ty::UInt),
            req("removed", Ty::UInt),
            req("text", Ty::Text),
        ],
        internal: false,
    },
    Kind {
        name: "textValue",
        base: 17,
        slots: &[
            req("entity", Ty::Id(Space::Entity)),
            req("field", Ty::Field),
            req("text", Ty::Text),
        ],
        internal: false,
    },
    // The next record is a copy, written by cleaning, of the record at `from`.
    Kind {
        name: "moved",
        base: 18,
        slots: &[req("from", Ty::Id(Space::Log))],
        internal: true,
    },
];

/// Kinds that exist only in the crate's tests and measurements (feature `measure`). Their header values are
/// far above the real kinds'.
#[cfg(any(test, feature = "measure"))]
pub static TEST_KINDS: &[Kind] = &[
    // The value types `KINDS` doesn't use.
    Kind {
        name: "testAll",
        base: 1000,
        slots: &[
            req("u", Ty::UInt),
            req("i", Ty::Int),
            req("f", Ty::F64),
            opt("t", Ty::Time),
            req("k", Ty::Field),
            req("b", Ty::Bytes),
            req("x", Ty::Bit),
            opt("o", Ty::Id(Space::Tag)),
        ],
        internal: false,
    },
    // Sets `id`'s value; its deriver keeps the current value, an order by `key` and a count.
    Kind {
        name: "testSet",
        base: 1256,
        slots: &[
            req("id", Ty::Id(Space::Entity)),
            req("key", Ty::UInt),
            req("value", Ty::Bytes),
        ],
        internal: false,
    },
];

fn all_kinds() -> impl Iterator<Item = &'static Kind> {
    #[cfg(any(test, feature = "measure"))]
    {
        KINDS.iter().chain(TEST_KINDS.iter())
    }
    #[cfg(not(any(test, feature = "measure")))]
    {
        KINDS.iter()
    }
}

pub fn kind_by_name(name: &str) -> Option<&'static Kind> {
    all_kinds().find(|k| k.name == name)
}

/// The kind a record header value names, and the header's bits.
pub fn kind_by_header(h: u64) -> Option<(&'static Kind, u64)> {
    all_kinds()
        .find(|k| h >= k.base && h < k.base + (1 << k.header_bits()))
        .map(|k| (k, h - k.base))
}

// ---- values and records ----

#[derive(Debug, Clone, PartialEq)]
pub enum FieldRef {
    /// A known field's code, >= 1.
    Code(u64),
    /// An extension's own key, WTF-8.
    Key(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Bit(bool),
    UInt(u64),
    Int(i64),
    F64(f64),
    Id(u64),
    Time(i64),
    Field(FieldRef),
    /// WTF-8.
    Text(Vec<u8>),
    Bytes(Vec<u8>),
    /// An optional value left out.
    Absent,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    pub kind: &'static Kind,
    /// One per slot, in schema order.
    pub values: Vec<Value>,
}

/// Checks that a value fits its slot and the format's bounds.
pub fn check_value(slot: &Slot, value: &Value) -> Result<(), String> {
    let ok = match (slot.ty, value) {
        (_, Value::Absent) => slot.optional,
        (Ty::Bit, Value::Bit(_)) => true,
        (Ty::UInt, Value::UInt(v)) => *v <= MAX_SAFE,
        (Ty::Int, Value::Int(v)) | (Ty::Time, Value::Time(v)) => v.unsigned_abs() <= MAX_SAFE,
        (Ty::F64, Value::F64(_)) => true,
        (Ty::Id(_), Value::Id(v)) => *v <= MAX_ID,
        (Ty::Field, Value::Field(FieldRef::Code(c))) => *c >= 1 && *c <= MAX_SAFE,
        (Ty::Field, Value::Field(FieldRef::Key(_)))
        | (Ty::Text, Value::Text(_))
        | (Ty::Bytes, Value::Bytes(_)) => true,
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(format!(
            "{} is not a valid {:?}{}",
            slot.name,
            slot.ty,
            if slot.optional { " (optional)" } else { "" }
        ))
    }
}

impl Record {
    pub fn new(kind: &'static Kind, values: Vec<Value>) -> Result<Record, String> {
        if values.len() != kind.slots.len() {
            return Err(format!(
                "{} takes {} values, got {}",
                kind.name,
                kind.slots.len(),
                values.len()
            ));
        }
        for (slot, value) in kind.slots.iter().zip(&values) {
            check_value(slot, value).map_err(|e| format!("{}: {e}", kind.name))?;
        }
        Ok(Record { kind, values })
    }
}

/// The decoding context: reset at every block start.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Ctx {
    ids: [u64; SPACES],
    time: i64,
}

/// Appends the record's bytes to `out`, advancing the context.
pub fn encode(rec: &Record, ctx: &mut Ctx, out: &mut Vec<u8>) {
    let mut bits = 0u64;
    let mut bit = 0;
    for (slot, value) in rec.kind.slots.iter().zip(&rec.values) {
        if slot.ty == Ty::Bit || slot.optional {
            let set = match value {
                Value::Bit(b) => *b,
                Value::Absent => false,
                _ => true,
            };
            bits |= u64::from(set) << bit;
            bit += 1;
        }
    }
    put_uvarint(out, rec.kind.base + bits);
    for (slot, value) in rec.kind.slots.iter().zip(&rec.values) {
        match (slot.ty, value) {
            (_, Value::Absent) | (_, Value::Bit(_)) => {}
            (_, Value::UInt(v)) => put_uvarint(out, *v),
            (_, Value::Int(v)) => put_uvarint(out, zigzag(*v)),
            (_, Value::F64(v)) => out.extend_from_slice(&v.to_le_bytes()),
            (Ty::Id(space), Value::Id(v)) => {
                let prev = &mut ctx.ids[space as usize];
                put_uvarint(out, zigzag((*v as i64).wrapping_sub(*prev as i64)));
                *prev = *v;
            }
            (_, Value::Time(v)) => {
                put_uvarint(out, zigzag(v - ctx.time));
                ctx.time = *v;
            }
            (_, Value::Field(FieldRef::Code(c))) => put_uvarint(out, *c),
            (_, Value::Field(FieldRef::Key(k))) => {
                put_uvarint(out, 0);
                put_uvarint(out, k.len() as u64);
                out.extend_from_slice(k);
            }
            (_, Value::Text(b)) | (_, Value::Bytes(b)) => {
                put_uvarint(out, b.len() as u64);
                out.extend_from_slice(b);
            }
            (_, Value::Id(_)) => unreachable!("checked by Record::new"),
        }
    }
}

fn get_slice<'a>(buf: &'a [u8], at: &mut usize, len: u64) -> FormatResult<&'a [u8]> {
    let len = usize::try_from(len).map_err(|_| FormatError::Invalid("length overflows".into()))?;
    let end = at
        .checked_add(len)
        .ok_or_else(|| FormatError::Invalid("length overflows".into()))?;
    let s = buf.get(*at..end).ok_or(FormatError::Incomplete)?;
    *at = end;
    Ok(s)
}

/// Steps over the values of a record at `buf[*at..]` (its header already read) without decoding them: ids
/// and times are differences from earlier records in the block, so this needs none of them.
pub fn skip_body(
    kind: &'static Kind,
    mut bits: u64,
    buf: &[u8],
    at: &mut usize,
) -> FormatResult<()> {
    for slot in kind.slots {
        let set = bits & 1 == 1;
        if slot.ty == Ty::Bit || slot.optional {
            bits >>= 1;
        }
        if slot.ty == Ty::Bit || (slot.optional && !set) {
            continue;
        }
        match slot.ty {
            Ty::UInt | Ty::Int | Ty::Id(_) | Ty::Time => {
                get_uvarint(buf, at)?;
            }
            Ty::F64 => {
                get_slice(buf, at, 8)?;
            }
            Ty::Field => {
                if get_uvarint(buf, at)? == 0 {
                    let len = get_uvarint(buf, at)?;
                    get_slice(buf, at, len)?;
                }
            }
            Ty::Text | Ty::Bytes => {
                let len = get_uvarint(buf, at)?;
                get_slice(buf, at, len)?;
            }
            Ty::Bit => unreachable!(),
        }
    }
    Ok(())
}

/// Decodes the record at `buf[*at..]`, given its header value (already read), advancing `at` and the
/// context. Every value is checked as on append.
pub fn decode_body(
    kind: &'static Kind,
    mut bits: u64,
    buf: &[u8],
    at: &mut usize,
    ctx: &mut Ctx,
) -> FormatResult<Record> {
    let mut values = Vec::with_capacity(kind.slots.len());
    for slot in kind.slots {
        let carries_bit = slot.ty == Ty::Bit || slot.optional;
        let set = bits & 1 == 1;
        if carries_bit {
            bits >>= 1;
        }
        if slot.ty == Ty::Bit {
            values.push(Value::Bit(set));
            continue;
        }
        if slot.optional && !set {
            values.push(Value::Absent);
            continue;
        }
        let v = match slot.ty {
            Ty::UInt => Value::UInt(get_uvarint(buf, at)?),
            Ty::Int => Value::Int(unzigzag(get_uvarint(buf, at)?)),
            Ty::F64 => Value::F64(f64::from_le_bytes(
                get_slice(buf, at, 8)?.try_into().unwrap(),
            )),
            Ty::Id(space) => {
                let prev = &mut ctx.ids[space as usize];
                let v = (*prev as i64).wrapping_add(unzigzag(get_uvarint(buf, at)?));
                if v < 0 {
                    return invalid("negative id");
                }
                *prev = v as u64;
                Value::Id(v as u64)
            }
            Ty::Time => {
                let d = unzigzag(get_uvarint(buf, at)?);
                let t = ctx
                    .time
                    .checked_add(d)
                    .ok_or_else(|| FormatError::Invalid("time overflows".into()))?;
                ctx.time = t;
                Value::Time(t)
            }
            Ty::Field => match get_uvarint(buf, at)? {
                0 => {
                    let len = get_uvarint(buf, at)?;
                    let k = get_slice(buf, at, len)?;
                    wtf8_to_utf16(k)?;
                    Value::Field(FieldRef::Key(k.to_vec()))
                }
                c => Value::Field(FieldRef::Code(c)),
            },
            Ty::Text => {
                let len = get_uvarint(buf, at)?;
                let b = get_slice(buf, at, len)?;
                wtf8_to_utf16(b)?;
                Value::Text(b.to_vec())
            }
            Ty::Bytes => {
                let len = get_uvarint(buf, at)?;
                Value::Bytes(get_slice(buf, at, len)?.to_vec())
            }
            Ty::Bit => unreachable!(),
        };
        values.push(v);
    }
    let rec = Record { kind, values };
    for (slot, value) in kind.slots.iter().zip(&rec.values) {
        check_value(slot, value)
            .map_err(|e| FormatError::Invalid(format!("{}: {e}", kind.name)))?;
    }
    Ok(rec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varints_round_trip_and_reject_overlong() {
        for v in [0u64, 1, 127, 128, 300, 1 << 34, u64::MAX] {
            let mut b = Vec::new();
            put_uvarint(&mut b, v);
            assert_eq!(b.len(), uvarint_len(v));
            let mut at = 0;
            assert_eq!(get_uvarint(&b, &mut at).unwrap(), v);
            assert_eq!(at, b.len());
        }
        assert!(matches!(
            get_uvarint(&[0x80, 0x00], &mut 0),
            Err(FormatError::Invalid(_))
        ));
        assert!(matches!(
            get_uvarint(&[0x80], &mut 0),
            Err(FormatError::Incomplete)
        ));
        assert!(matches!(
            get_uvarint(&[0xff; 10], &mut 0),
            Err(FormatError::Invalid(_))
        ));
        for v in [0i64, -1, 1, i64::MIN, i64::MAX] {
            assert_eq!(unzigzag(zigzag(v)), v);
        }
    }

    #[test]
    fn wtf8_round_trips_every_js_string() {
        let cases: Vec<Vec<u16>> = vec![
            "".encode_utf16().collect(),
            "héllo wörld ✓ 😀".encode_utf16().collect(),
            vec![0xd800],
            vec![0xdc00, 0xd800],
            vec![0x61, 0xd83d, 0x62],
            vec![0xd83d, 0xde00, 0xdc00],
        ];
        for c in cases {
            let w = wtf8_from_utf16(&c);
            assert_eq!(wtf8_to_utf16(&w).unwrap(), c);
        }
        // Valid UTF-8 is the same bytes.
        assert_eq!(
            wtf8_from_utf16(&"ab😀".encode_utf16().collect::<Vec<_>>()),
            "ab😀".as_bytes()
        );
        // A pair written as two 3-byte forms, overlong forms and stray bytes are rejected.
        assert!(wtf8_to_utf16(&[0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80]).is_err());
        assert!(wtf8_to_utf16(&[0xc0, 0x80]).is_err());
        assert!(wtf8_to_utf16(&[0x80]).is_err());
        assert!(wtf8_to_utf16(&[0xf4, 0x90, 0x80, 0x80]).is_err());
    }

    #[test]
    fn header_values_never_overlap() {
        let mut used = std::collections::BTreeSet::from([0u64, 1]);
        for k in all_kinds() {
            for h in k.base..k.base + (1 << k.header_bits()) {
                assert!(used.insert(h), "{} reuses header value {h}", k.name);
            }
        }
    }

    fn round_trip(recs: &[Record]) -> Vec<u8> {
        let mut ctx = Ctx::default();
        let mut buf = Vec::new();
        for r in recs {
            encode(r, &mut ctx, &mut buf);
        }
        let mut ctx = Ctx::default();
        let mut at = 0;
        for r in recs {
            let h = get_uvarint(&buf, &mut at).unwrap();
            let (k, bits) = kind_by_header(h).unwrap();
            assert_eq!(&decode_body(k, bits, &buf, &mut at, &mut ctx).unwrap(), r);
        }
        assert_eq!(at, buf.len());
        buf
    }

    #[test]
    fn every_type_round_trips() {
        let k = kind_by_name("testAll").unwrap();
        let recs = [
            Record::new(
                k,
                vec![
                    Value::UInt(MAX_SAFE),
                    Value::Int(-5),
                    Value::F64(0.7),
                    Value::Time(-1),
                    Value::Field(FieldRef::Key(b"ext/key".to_vec())),
                    Value::Bytes(vec![0, 1, 2]),
                    Value::Bit(true),
                    Value::Absent,
                ],
            )
            .unwrap(),
            Record::new(
                k,
                vec![
                    Value::UInt(0),
                    Value::Int(i64::from(i32::MIN)),
                    Value::F64(f64::NAN.copysign(-1.0)),
                    Value::Absent,
                    Value::Field(FieldRef::Code(3)),
                    Value::Bytes(vec![]),
                    Value::Bit(false),
                    Value::Id(MAX_ID),
                ],
            )
            .unwrap(),
        ];
        // NaN != NaN, so compare the bytes of a second encoding instead of the values.
        let mut ctx = Ctx::default();
        let mut buf = Vec::new();
        for r in &recs {
            encode(r, &mut ctx, &mut buf);
        }
        let mut ctx = Ctx::default();
        let mut at = 0;
        let mut again = Vec::new();
        let mut ctx2 = Ctx::default();
        for _ in &recs {
            let h = get_uvarint(&buf, &mut at).unwrap();
            let (k, bits) = kind_by_header(h).unwrap();
            let r = decode_body(k, bits, &buf, &mut at, &mut ctx).unwrap();
            encode(&r, &mut ctx2, &mut again);
        }
        assert_eq!(again, buf);
    }

    #[test]
    fn out_of_range_values_are_refused() {
        let k = kind_by_name("fav").unwrap();
        assert!(Record::new(k, vec![Value::Id(MAX_ID + 1), Value::Bit(true)]).is_err());
        assert!(Record::new(k, vec![Value::Absent, Value::Bit(true)]).is_err());
        assert!(Record::new(k, vec![Value::Id(1)]).is_err());
        let k = kind_by_name("textEdit").unwrap();
        assert!(
            Record::new(
                k,
                vec![
                    Value::Id(1),
                    Value::Field(FieldRef::Code(0)),
                    Value::UInt(0),
                    Value::UInt(0),
                    Value::Text(vec![])
                ]
            )
            .is_err()
        );
        assert!(
            Record::new(
                k,
                vec![
                    Value::Id(1),
                    Value::Field(FieldRef::Code(1)),
                    Value::UInt(MAX_SAFE + 1),
                    Value::UInt(0),
                    Value::Text(vec![])
                ]
            )
            .is_err()
        );
    }

    #[test]
    fn ids_are_deltas_within_the_context() {
        let fav = kind_by_name("fav").unwrap();
        let f = |id| Record::new(fav, vec![Value::Id(id), Value::Bit(true)]).unwrap();
        // 34-bit id: the header (bit packed) and a 5-byte varint; a repeat costs 1 byte for the id.
        let b = round_trip(&[f(1 << 33), f(1 << 33)]);
        assert_eq!(b.len(), 6 + 2);
    }
}
