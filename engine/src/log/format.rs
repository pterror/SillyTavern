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
    /// State changes (`stateChange`, `stateRevert`).
    Change = 6,
}
pub const SPACES: usize = 7;

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
    /// An id of one of these spaces, each named as JavaScript gives it: header bits pick the space (as few as
    /// tell them apart), and the id is coded as an `Id` of that space.
    Sel(&'static [(Space, &'static str)]),
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
    /// Bits carried in the header: one per `Bit` value, one per optional value (present or not), and a `Sel`
    /// value's space.
    pub fn header_bits(&self) -> u32 {
        self.slots.iter().map(Slot::header_bits).sum()
    }
}

impl Slot {
    /// The header bits this slot's value takes.
    pub fn header_bits(&self) -> u32 {
        let own = match self.ty {
            Ty::Bit => 1,
            Ty::Sel(spaces) => sel_bits(spaces.len()),
            _ => 0,
        };
        own + u32::from(self.optional)
    }
}

/// The header bits that tell `n` spaces apart.
pub const fn sel_bits(n: usize) -> u32 {
    if n <= 1 {
        0
    } else {
        usize::BITS - (n - 1).leading_zeros()
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

/// A value's holder: a character, group or tag, or a message.
pub const HOLDER: &[(Space, &str)] = &[(Space::Entity, "entity"), (Space::Message, "message")];
/// Where a state change hangs: a tree's root (the character or group), or a message.
pub const HANG: &[(Space, &str)] = &[(Space::Entity, "tree"), (Space::Message, "message")];
/// What an outside key names: a message (its id before the engine), a session (its UUID), a user (their handle).
pub const KEYED: &[(Space, &str)] = &[
    (Space::Message, "message"),
    (Space::Position, "session"),
    (Space::User, "user"),
];

/// Every kind the log knows. Header values 0 and 1 are the pad and the trailer. Kinds written often have header
/// values below 128 (one byte); the tag manager's queue and reorder pass, written rarely, are above.
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
    // A session's pointer moves to `target`, by `user`.
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
    // A session's pointer moves to the root of `tree` (no message), by `user`, at `time` (where the chat list
    // places a position at a root).
    Kind {
        name: "pointerRoot",
        base: 127,
        slots: &[
            req("session", Ty::Id(Space::Position)),
            req("user", Ty::Id(Space::User)),
            req("tree", Ty::Id(Space::Entity)),
            req("time", Ty::Time),
        ],
        internal: false,
    },
    // `user`'s remembered position in `tree` (the user tier of landing) is `at` (absent: the tree's root), set by no
    // session's move: an import that keeps the chat a card names as where the character opens.
    Kind {
        name: "userPosition",
        base: 250,
        slots: &[
            req("user", Ty::Id(Space::User)),
            req("tree", Ty::Id(Space::Entity)),
            opt("at", Ty::Id(Space::Message)),
        ],
        internal: false,
    },
    // `session`'s current chat in `tree` (upstream's open chat file) becomes `bookmark` (absent: none), by `user`: an
    // explicit switch (opening a chat, a new chat, a branch opened), never an append or a move.
    Kind {
        name: "currentChat",
        base: 254,
        slots: &[
            req("session", Ty::Id(Space::Position)),
            req("user", Ty::Id(Space::User)),
            req("tree", Ty::Id(Space::Entity)),
            opt("bookmark", Ty::Id(Space::Position)),
        ],
        internal: false,
    },
    // A conversation, a `bookmark` or a `session`'s in `tree` (where it has no current chat), has its last
    // meaningful activity here: written only by the conversion, in the order of the conversations' last messages.
    Kind {
        name: "conversationActive",
        base: 1400,
        slots: &[
            opt("bookmark", Ty::Id(Space::Position)),
            opt("session", Ty::Id(Space::Position)),
            opt("tree", Ty::Id(Space::Entity)),
        ],
        internal: false,
    },
    // A session steps back or forward to the `n`-th entry of its history: the cursor and the pointer go there, and
    // no entry is added. `time`: when (a step to a root is when the session got there).
    Kind {
        name: "historyStep",
        base: 220,
        slots: &[
            req("session", Ty::Id(Space::Position)),
            req("user", Ty::Id(Space::User)),
            req("n", Ty::UInt),
            req("time", Ty::Time),
        ],
        internal: false,
    },
    // `session` (new, with nothing of its own yet) is forked from `from` by `user` at `time`: its history's entries 1
    // to `length` are `from`'s (read through it, never copied) and its cursor is the `cursor`-th; its pointer goes
    // where that entry points (a gone one's: the nearest earlier entry still there, as a step back lands).
    Kind {
        name: "sessionFork",
        base: 1300,
        slots: &[
            req("session", Ty::Id(Space::Position)),
            req("from", Ty::Id(Space::Position)),
            req("user", Ty::Id(Space::User)),
            req("length", Ty::UInt),
            req("cursor", Ty::UInt),
            req("time", Ty::Time),
        ],
        internal: false,
    },
    // A session chooses, for `tree`, the card greeting at `index` in the card's greeting list, with no message
    // stored: what it shows at the tree's root until it continues from there.
    Kind {
        name: "openingChoice",
        base: 221,
        slots: &[
            req("session", Ty::Id(Space::Position)),
            req("user", Ty::Id(Space::User)),
            req("tree", Ty::Id(Space::Entity)),
            req("index", Ty::UInt),
        ],
        internal: false,
    },
    // At the fork `message` (absent: among the messages opening the reply's tree), `reply` is chosen, through
    // `session` by `user`.
    Kind {
        name: "forkSelection",
        base: 7,
        slots: &[
            opt("message", Ty::Id(Space::Message)),
            req("reply", Ty::Id(Space::Message)),
            req("session", Ty::Id(Space::Position)),
            req("user", Ty::Id(Space::User)),
        ],
        internal: false,
    },
    // A text edit of a holder's field: `removed` bytes at `offset` replaced by `text`.
    Kind {
        name: "textEdit",
        base: 9,
        slots: &[
            req("entity", Ty::Sel(HOLDER)),
            req("field", Ty::Field),
            req("offset", Ty::UInt),
            req("removed", Ty::UInt),
            req("text", Ty::Text),
            opt("session", Ty::Id(Space::Position)),
            opt("user", Ty::Id(Space::User)),
        ],
        internal: false,
    },
    Kind {
        name: "textValue",
        base: 17,
        slots: &[
            req("entity", Ty::Sel(HOLDER)),
            req("field", Ty::Field),
            req("text", Ty::Text),
            opt("session", Ty::Id(Space::Position)),
            opt("user", Ty::Id(Space::User)),
        ],
        internal: false,
    },
    // A value the app keeps as it came (JSON text), or, empty, a marker that something is present.
    Kind {
        name: "jsonValue",
        base: 25,
        slots: &[
            req("entity", Ty::Sel(HOLDER)),
            req("field", Ty::Field),
            req("json", Ty::Text),
            opt("session", Ty::Id(Space::Position)),
            opt("user", Ty::Id(Space::User)),
        ],
        internal: false,
    },
    // The field's value (text or JSON) goes.
    Kind {
        name: "valueDelete",
        base: 33,
        slots: &[
            req("entity", Ty::Sel(HOLDER)),
            req("field", Ty::Field),
            opt("session", Ty::Id(Space::Position)),
            opt("user", Ty::Id(Space::User)),
        ],
        internal: false,
    },
    // A bookmark comes to be: following (mode 1: it moves to a reply added right after it) or pinned (mode 2),
    // made through `session` by `user`, at `pointer`.
    Kind {
        name: "positionCreate",
        base: 56,
        slots: &[
            req("id", Ty::Id(Space::Position)),
            req("mode", Ty::UInt),
            req("session", Ty::Id(Space::Position)),
            req("user", Ty::Id(Space::User)),
            req("pointer", Ty::Id(Space::Message)),
        ],
        internal: false,
    },
    // A bookmark at the root of `tree` (no message), as `positionCreate` makes one at a message, made at `time`.
    Kind {
        name: "positionRoot",
        base: 234,
        slots: &[
            req("id", Ty::Id(Space::Position)),
            req("mode", Ty::UInt),
            req("session", Ty::Id(Space::Position)),
            req("user", Ty::Id(Space::User)),
            req("tree", Ty::Id(Space::Entity)),
            req("time", Ty::Time),
        ],
        internal: false,
    },
    // A position's name (absent: it has none).
    Kind {
        name: "positionName",
        base: 59,
        slots: &[req("id", Ty::Id(Space::Position)), opt("name", Ty::Text)],
        internal: false,
    },
    // The next record is a copy, written by cleaning, of the record at `from`.
    Kind {
        name: "moved",
        base: 41,
        slots: &[req("from", Ty::Id(Space::Log))],
        internal: true,
    },
    // ---- the library: characters, groups and tags share the entity ids ----
    // An entity comes to be: its kind (0 character, 1 group, 2 tag), the key the app knows it by (a character's
    // avatar, a group's or tag's id), and the date it was added.
    Kind {
        name: "entityCreate",
        base: 42,
        slots: &[
            req("entity", Ty::Id(Space::Entity)),
            req("type", Ty::UInt),
            req("key", Ty::Text),
            // File-derived dates can include fractional milliseconds; preserve the original number.
            req("added", Ty::F64),
        ],
        internal: false,
    },
    // Everything the entity holds goes; a tag's assignments go with its `tagMerge`.
    Kind {
        name: "entityDelete",
        base: 43,
        slots: &[req("entity", Ty::Id(Space::Entity))],
        internal: false,
    },
    // A position's mode changes (1 following, 2 pinned; a session's never does).
    Kind {
        name: "positionMode",
        base: 57,
        slots: &[req("id", Ty::Id(Space::Position)), req("mode", Ty::UInt)],
        internal: false,
    },
    // A bookmark moves to `at`, a message of its tree (absent: the tree's root), at `time` (where the chat list
    // places one at a root). The message it was made at stays its own.
    Kind {
        name: "positionMove",
        base: 252,
        slots: &[
            req("id", Ty::Id(Space::Position)),
            req("time", Ty::Time),
            opt("at", Ty::Id(Space::Message)),
        ],
        internal: false,
    },
    // A list item's place in its list; its text is the text value of `item_field(list, item)`.
    Kind {
        name: "itemPlace",
        base: 44,
        slots: &[
            req("entity", Ty::Id(Space::Entity)),
            req("list", Ty::UInt),
            req("item", Ty::UInt),
            req("position", Ty::UInt),
        ],
        internal: false,
    },
    // The item and its text go.
    Kind {
        name: "itemDelete",
        base: 45,
        slots: &[
            req("entity", Ty::Id(Space::Entity)),
            req("list", Ty::UInt),
            req("item", Ty::UInt),
        ],
        internal: false,
    },
    // Sort keys the writer computes with the app's own functions: a card's data size, and its create date as
    // epoch ms (absent: none, or not a date).
    Kind {
        name: "dataSize",
        base: 46,
        slots: &[req("entity", Ty::Id(Space::Entity)), req("size", Ty::UInt)],
        internal: false,
    },
    Kind {
        name: "createDate",
        base: 47,
        slots: &[req("entity", Ty::Id(Space::Entity)), opt("ms", Ty::F64)],
        internal: false,
    },
    // A hash a card is found by (`library::HASH_*`); absent: it has none.
    Kind {
        name: "cardHash",
        base: 49,
        slots: &[
            req("entity", Ty::Id(Space::Entity)),
            req("which", Ty::UInt),
            opt("hash", Ty::Bytes),
        ],
        internal: false,
    },
    // A tag goes: its carriers become `into`'s (or, with none, carry nothing).
    Kind {
        name: "tagMerge",
        base: 51,
        slots: &[
            req("tag", Ty::Id(Space::Tag)),
            opt("into", Ty::Id(Space::Tag)),
        ],
        internal: false,
    },
    // An entity's key (a character's avatar) or date added changes; its type is `entityCreate`'s, repeated.
    Kind {
        name: "entityUpdate",
        base: 53,
        slots: &[
            req("entity", Ty::Id(Space::Entity)),
            req("type", Ty::UInt),
            req("key", Ty::Text),
            req("added", Ty::F64),
        ],
        internal: false,
    },
    // A tag's manual sort order: its stored `sort_order` as upstream coerces it (absent: it has none).
    Kind {
        name: "tagOrder",
        base: 54,
        slots: &[req("tag", Ty::Id(Space::Tag)), opt("order", Ty::F64)],
        internal: false,
    },
    // A tag goes, as a `tagMerge` into none and its `entityDelete` would, only if nothing carries it (nor a tag
    // merged into it whose carriers haven't moved); else nothing happens.
    Kind {
        name: "tagPrune",
        base: 113,
        slots: &[req("tag", Ty::Id(Space::Tag))],
        internal: false,
    },
    // A move of the tag manager's manual order, queued until the reorder pass applies it, `seq` its place in the
    // queue: `tag` right after (`after`) or before `anchor`, or `tag`'s `sort_order` set to `value` (JSON).
    Kind {
        name: "tagQueue",
        base: 128,
        slots: &[
            req("seq", Ty::UInt),
            req("tag", Ty::Id(Space::Tag)),
            req("after", Ty::Bit),
            opt("anchor", Ty::Id(Space::Tag)),
            opt("value", Ty::Text),
        ],
        internal: false,
    },
    // The queued move `seq` was applied.
    Kind {
        name: "tagQueuePop",
        base: 114,
        slots: &[req("seq", Ty::UInt)],
        internal: false,
    },
    // The reorder pass: its id, the order it writes (0 alphabetical, 1 by entries; absent: no pass is running),
    // its phase (0 walk, 1 sweep, 2 drain), the next value the walk gives, and the order's cursor it goes on from.
    Kind {
        name: "tagPass",
        base: 136,
        slots: &[
            req("pass", Ty::UInt),
            opt("mode", Ty::UInt),
            opt("phase", Ty::UInt),
            opt("n", Ty::UInt),
            opt("after", Ty::Bytes),
        ],
        internal: false,
    },
    // A value the app keeps for itself by name (`json`; absent: it has none), such as what an import has done.
    Kind {
        name: "metaValue",
        base: 115,
        slots: &[req("key", Ty::Text), opt("json", Ty::Text)],
        internal: false,
    },
    // `tagOrder` written by reorder pass `pass`, which marks the tag as done by it.
    Kind {
        name: "tagPassOrder",
        base: 117,
        slots: &[
            req("tag", Ty::Id(Space::Tag)),
            opt("order", Ty::F64),
            req("pass", Ty::UInt),
        ],
        internal: false,
    }, // ---- chats ----
    // A message: `parent` (absent: it opens its owner's tree), `owner` (the character or group whose tree it is
    // in), `speaker` (absent: none by id), `name` (absent: the speaker's), the time the server took it, its text,
    // the shape of its fixed values (`chat::FLAGS`), the session it was sent through (absent: none) and the
    // user, and the key its sender made for it (absent: none).
    Kind {
        name: "messageAppend",
        base: 65,
        slots: &[
            req("id", Ty::Id(Space::Message)),
            opt("parent", Ty::Id(Space::Message)),
            req("owner", Ty::Id(Space::Entity)),
            opt("speaker", Ty::Id(Space::Entity)),
            opt("name", Ty::Text),
            req("time", Ty::Time),
            req("text", Ty::Text),
            req("flags", Ty::UInt),
            opt("session", Ty::Id(Space::Position)),
            req("user", Ty::Id(Space::User)),
            opt("sendKey", Ty::Bytes),
        ],
        internal: false,
    },
    // An outside key names an id: a message's id from before the engine, a session's UUID, a user's handle.
    Kind {
        name: "keyMap",
        base: 61,
        slots: &[req("id", Ty::Sel(KEYED)), req("key", Ty::Bytes)],
        internal: false,
    },
    // A bookmark goes; or a session, with its pointer and its history.
    Kind {
        name: "positionDelete",
        base: 58,
        slots: &[req("id", Ty::Id(Space::Position))],
        internal: false,
    },
    // A message goes (only one nothing replies to), at `time` (a tree's last opening going puts the positions at it
    // at the root then).
    Kind {
        name: "messageDelete",
        base: 97,
        slots: &[
            req("message", Ty::Id(Space::Message)),
            opt("session", Ty::Id(Space::Position)),
            opt("user", Ty::Id(Space::User)),
            req("time", Ty::Time),
        ],
        internal: false,
    },
    // A message and everything below it go (`store::prune`), through `session` by `user`, at `time` (as
    // `messageDelete`'s).
    Kind {
        name: "subtreeDelete",
        base: 228,
        slots: &[
            req("message", Ty::Id(Space::Message)),
            opt("session", Ty::Id(Space::Position)),
            opt("user", Ty::Id(Space::User)),
            req("time", Ty::Time),
        ],
        internal: false,
    },
    // Every state change hanging at a tree's root when this commits goes (a tree deleted whole; `store::state`).
    Kind {
        name: "rootStateClear",
        base: 248,
        slots: &[req("tree", Ty::Id(Space::Entity))],
        internal: false,
    },
    // A message moves under another parent (absent: it opens its owner's tree).
    Kind {
        name: "messageParent",
        base: 101,
        slots: &[
            req("message", Ty::Id(Space::Message)),
            opt("parent", Ty::Id(Space::Message)),
            opt("session", Ty::Id(Space::Position)),
            opt("user", Ty::Id(Space::User)),
        ],
        internal: false,
    },
    // A state change (`.plans/2026-10-03-state-layer-1.md`): `id` (stable, given in order), where it hangs, when
    // (ms), its author (`state::AUTHOR_*` in the low bits; bit 3: the key is a variable's name) and their reference, a
    // confidence, the key, and its value as JSON (absent: the key is deleted).
    Kind {
        name: "stateChange",
        base: 152,
        slots: &[
            req("id", Ty::Id(Space::Change)),
            req("at", Ty::Sel(HANG)),
            req("time", Ty::Time),
            req("author", Ty::UInt),
            opt("ref", Ty::Text),
            opt("confidence", Ty::F64),
            req("key", Ty::Field),
            opt("value", Ty::Text),
            opt("session", Ty::Id(Space::Position)),
            opt("user", Ty::Id(Space::User)),
        ],
        internal: false,
    },
    // A state change (or a revert) is reverted: the state is as if it never happened.
    Kind {
        name: "stateRevert",
        base: 119,
        slots: &[
            req("id", Ty::Id(Space::Change)),
            req("reverts", Ty::Id(Space::Change)),
            req("time", Ty::Time),
            req("author", Ty::UInt),
            opt("ref", Ty::Text),
            opt("session", Ty::Id(Space::Position)),
            opt("user", Ty::Id(Space::User)),
        ],
        internal: false,
    },
    // A reply's prompt itemization (D14): zstd-compressed JSON, and whether it holds the prompt as sent (absent:
    // the message has none any more).
    Kind {
        name: "itemization",
        base: 216,
        slots: &[
            req("message", Ty::Id(Space::Message)),
            req("raw", Ty::Bit),
            opt("data", Ty::Bytes),
        ],
        internal: false,
    },
    // A world-info entry's `displayIndex` as JavaScript's `Number(displayIndex ?? -1)` reads it (absent: the entry
    // has none recorded); `book` is the book holding the entry.
    Kind {
        name: "entryIndex",
        base: 222,
        slots: &[
            req("entry", Ty::Id(Space::Entity)),
            req("book", Ty::Id(Space::Entity)),
            opt("index", Ty::F64),
        ],
        internal: false,
    },
    // Reserved: a character's one lorebook link from before a character's links were its list 4. The log's format
    // keeps an old kind decodable so cleaning can read its records and drop them; every one is dead, and a new one is
    // refused (`store::books::BookLink`).
    Kind {
        name: "bookLink",
        base: 224,
        slots: &[
            req("entity", Ty::Id(Space::Entity)),
            opt("book", Ty::Id(Space::Entity)),
        ],
        internal: false,
    },
    // The local import scan's record of a source file (`localImport.directories`): processed at `mtime` (absent:
    // forgotten), and the character it was found to duplicate, whose delete forgets it.
    Kind {
        name: "localImportMtime",
        base: 235,
        slots: &[
            req("path", Ty::Text),
            opt("mtime", Ty::F64),
            opt("duplicateOf", Ty::Id(Space::Entity)),
        ],
        internal: false,
    },
    // The local import scan's skip of a source file that isn't a character: at `mtime` (absent: forgotten), why,
    // and when it was checked.
    Kind {
        name: "localImportSkip",
        base: 239,
        slots: &[
            req("path", Ty::Text),
            opt("mtime", Ty::F64),
            opt("reason", Ty::Text),
            opt("checked", Ty::Time),
        ],
        internal: false,
    },
    // Pair postings on or off (`search::pairs`): a pass builds or deletes them.
    Kind {
        name: "searchPairs",
        base: 232,
        slots: &[req("on", Ty::Bit)],
        internal: false,
    },
    // An unresolved book (no definition) is resolved as `into` from now on, for every link naming it.
    Kind {
        name: "bookForward",
        base: 226,
        slots: &[
            req("from", Ty::Id(Space::Entity)),
            req("into", Ty::Id(Space::Entity)),
        ],
        internal: false,
    },
    // One of a message's times as the ISO string `new Date(time + delta).toISOString()`: which is its field.
    Kind {
        name: "messageTime",
        base: 109,
        slots: &[
            req("message", Ty::Id(Space::Message)),
            req("field", Ty::Field),
            req("delta", Ty::Int),
            opt("session", Ty::Id(Space::Position)),
            opt("user", Ty::Id(Space::User)),
        ],
        internal: false,
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
    /// A `Sel` slot's id: which of its spaces (an index into them) and the id.
    Sel(u8, u64),
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
        (Ty::Sel(spaces), Value::Sel(i, v)) => usize::from(*i) < spaces.len() && *v <= MAX_ID,
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
        if let Ty::Sel(spaces) = slot.ty {
            if let Value::Sel(i, _) = value {
                bits |= u64::from(*i) << bit;
            }
            bit += sel_bits(spaces.len());
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
            (Ty::Sel(spaces), Value::Sel(i, v)) => {
                let prev = &mut ctx.ids[spaces[usize::from(*i)].0 as usize];
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
            (_, Value::Id(_) | Value::Sel(..)) => unreachable!("checked by Record::new"),
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
        if let Ty::Sel(spaces) = slot.ty {
            bits >>= sel_bits(spaces.len());
        }
        if slot.ty == Ty::Bit || (slot.optional && !set) {
            continue;
        }
        match slot.ty {
            Ty::UInt | Ty::Int | Ty::Id(_) | Ty::Sel(_) | Ty::Time => {
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
        let sel = match slot.ty {
            Ty::Sel(spaces) => {
                let n = sel_bits(spaces.len());
                let i = bits & ((1 << n) - 1);
                bits >>= n;
                i
            }
            _ => 0,
        };
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
            Ty::Sel(spaces) => {
                let Some((space, _)) = spaces.get(sel as usize) else {
                    return invalid("no such id space");
                };
                let prev = &mut ctx.ids[*space as usize];
                let v = (*prev as i64).wrapping_add(unzigzag(get_uvarint(buf, at)?));
                if v < 0 {
                    return invalid("negative id");
                }
                *prev = v as u64;
                Value::Sel(sel as u8, v as u64)
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
                    Value::Sel(0, 1),
                    Value::Field(FieldRef::Code(0)),
                    Value::UInt(0),
                    Value::UInt(0),
                    Value::Text(vec![]),
                    Value::Absent,
                    Value::Absent
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
