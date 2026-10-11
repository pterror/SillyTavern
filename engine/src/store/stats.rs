//! Chat stats (design Q-C5; build path 5b): per owner (a character's or group's tree) and in total, kept exact at
//! every write to a message. What counts is today's (`src/message-stats.js`): every user message, and every
//! character message except the ones opening a tree; system messages don't count. A swipe is every counted
//! character message beyond the first under one parent. Chat size is the bytes the tree's messages store (texts,
//! JSON values and stored names, every alternative); the last chat is the newest message's time. The last chat and
//! chat size are the library's sort keys of the same names.

use std::collections::HashMap;

use super::StoreError;
use super::chat::{
    self, APPEND_FLAGS, APPEND_OWNER, APPEND_TIME, GEN_FINISHED, GEN_FINISHED_AT, GEN_FINISHED_NUM,
    GEN_STARTED, GEN_STARTED_AT, GEN_STARTED_NUM, IS_SYSTEM, IS_USER, MES, SEND_AT, SEND_DATE,
    SEND_DATE_NUM, message_loc, parent_of,
};
use super::derive::{Deriver, Layer, Loc, Out, View};
use super::kinds::{Holder, bytes, id, key, parse_loc, parse_varints, text_value_of};
use super::library::{self, CHAT_SIZE, LAST_CHAT, counter};
use crate::keyspace::val::{get_u64, put_u64};
use crate::log::format::{FieldRef, Record, Value};

/// Per (owner, counter) and per counter (`TOTAL`): a counter.
pub const STAT: u64 = 160;
pub const STAT_TOTAL: u64 = 161;
/// Per message that has replies: its counted character replies (a counter).
pub const CHAR_REPLIES: u64 = 162;
/// Per (owner, send time, message) and per (send time, message): a counted user message's send time.
pub const USER_AT: u64 = 163;
pub const ALL_USER_AT: u64 = 164;
/// Per (owner, time, message): every message by its time.
pub const OWNER_TIME: u64 = 165;

pub const USER_MSGS: u64 = 0;
pub const CHAR_MSGS: u64 = 1;
pub const USER_WORDS: u64 = 2;
pub const CHAR_WORDS: u64 = 3;
pub const SWIPES: u64 = 4;
pub const GEN_MS: u64 = 5;
pub const GEN_UNKNOWN: u64 = 6;
pub const SIZE: u64 = 7;
pub const COUNTERS: usize = 8;

/// One owner's (or the totals') stats.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Stats {
    pub counters: [i64; COUNTERS],
    /// The earliest send time of a counted user message.
    pub first_user_at: Option<i64>,
    /// The newest message's time (None: no message).
    pub last_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Who {
    User,
    Char,
}

/// What one message adds to its owner's stats.
#[derive(Debug, Clone, PartialEq)]
struct Contrib {
    owner: u64,
    parent: Option<u64>,
    time: i64,
    /// Who it counts for: None for a system message or one opening its tree as a character's.
    counted: Option<Who>,
    words: i64,
    send_at: Option<i64>,
    gen_ms: Option<i64>,
    size: i64,
}

/// JavaScript's truthiness of a JSON value.
fn truthy(json: &[u8]) -> bool {
    match json {
        b"false" | b"null" | b"\"\"" => false,
        _ => !std::str::from_utf8(json)
            .ok()
            .and_then(|s| s.parse::<f64>().ok())
            .is_some_and(|n| n == 0.0),
    }
}

/// Words as `countWords()` counts them: runs of ASCII letters, digits and `_`.
pub fn count_words(text: &[u8]) -> i64 {
    let mut n = 0;
    let mut in_word = false;
    for &b in text {
        let w = b.is_ascii_alphanumeric() || b == b'_';
        if w && !in_word {
            n += 1;
        }
        in_word = w;
    }
    n
}

fn json_value(view: &View, m: u64, code: u64) -> Result<Option<Vec<u8>>, StoreError> {
    match view.get(&Holder::Message(m).value_key(&FieldRef::Code(code)))? {
        Some(b) => Ok(Some(bytes(&view.record(parse_loc(&b)?.pos)?.0, 2).to_vec())),
        None => Ok(None),
    }
}

fn time_value(view: &View, m: u64, code: u64) -> Result<Option<i64>, StoreError> {
    match view.get(&chat::msg_time_key(m, &FieldRef::Code(code)))? {
        Some(b) => match view.record(parse_loc(&b)?.pos)?.0.values[2] {
            Value::Int(d) => Ok(Some(d)),
            _ => unreachable!("checked by Record::new"),
        },
        None => Ok(None),
    }
}

/// A fixed boolean's value from its two flag bits: `on` is the state meaning true, 3 its JSON value's truthiness.
fn flag(
    view: &View,
    m: u64,
    flags: u64,
    shift: u32,
    on: u64,
    code: u64,
) -> Result<bool, StoreError> {
    let state = (flags >> shift) & 3;
    Ok(if state == 3 {
        json_value(view, m, code)?.is_some_and(|j| truthy(&j))
    } else {
        state == on
    })
}

/// A time value as `parseTimestamp()` reads it: its ISO time (`messageTime` of `code`) or number (of `num`; 0 is
/// falsy), else the time the writer read from its JSON value (`messageTime` of `parsed`), else 0 for a JSON value it
/// couldn't read; None when the message doesn't have it or it is falsy. `own` is the append's time, which the deltas
/// are from.
fn parsed_time(
    view: &View,
    m: u64,
    own: i64,
    [code, num, parsed]: [u64; 3],
) -> Result<Option<i64>, StoreError> {
    if let Some(d) = time_value(view, m, code)? {
        return Ok(Some(own + d));
    }
    if let Some(d) = time_value(view, m, num)? {
        return Ok((own + d != 0).then_some(own + d));
    }
    match json_value(view, m, code)? {
        Some(j) if truthy(&j) => Ok(Some(time_value(view, m, parsed)?.map_or(0, |d| own + d))),
        _ => Ok(None),
    }
}

fn contrib(view: &View, m: u64) -> Result<Option<Contrib>, StoreError> {
    let Some(l) = message_loc(view, m)? else {
        return Ok(None);
    };
    let (r, _) = view.record(l.pos)?;
    let owner = id(&r, APPEND_OWNER);
    let time = match r.values[APPEND_TIME] {
        Value::Time(t) => t,
        _ => unreachable!("checked by Record::new"),
    };
    // A later change of the fixed values' shape is a value of its own (`chat::FLAGS`).
    let flags = match json_value(view, m, chat::FLAGS)? {
        Some(j) => std::str::from_utf8(&j)
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .ok_or_else(|| {
                StoreError::Entry(format!("message {m}'s flags value isn't a number"))
            })?,
        None => id(&r, APPEND_FLAGS),
    };
    let parent = parent_of(view, m, &r)?;
    let who = if flag(view, m, flags, chat::FLAG_IS_SYSTEM, 2, IS_SYSTEM)? {
        None
    } else if flag(view, m, flags, chat::FLAG_IS_USER, 1, IS_USER)? {
        Some(Who::User)
    } else {
        Some(Who::Char)
    };
    let counted = match who {
        Some(Who::Char) if parent.is_none() => None,
        w => w,
    };
    let words = match counted {
        Some(_) => text_value_of(view, Holder::Message(m), &FieldRef::Code(MES))?
            .map_or(0, |t| count_words(&t)),
        None => 0,
    };
    let send_at = match counted {
        Some(Who::User) => {
            let at = match (flags >> chat::FLAG_SEND_DATE) & 3 {
                1 | 2 => Some(time),
                3 => None,
                _ => Some(if let Some(d) = time_value(view, m, SEND_DATE)? {
                    time + d
                } else if let Some(d) = time_value(view, m, SEND_DATE_NUM)? {
                    time + d
                } else if json_value(view, m, SEND_DATE)?.is_some() {
                    time_value(view, m, SEND_AT)?.map_or(0, |d| time + d)
                } else {
                    0
                }),
            };
            at.filter(|t| *t > 0)
        }
        _ => None,
    };
    let gen_ms = match counted {
        Some(Who::Char) => {
            let started = parsed_time(
                view,
                m,
                time,
                [GEN_STARTED, GEN_STARTED_NUM, GEN_STARTED_AT],
            )?;
            let finished = parsed_time(
                view,
                m,
                time,
                [GEN_FINISHED, GEN_FINISHED_NUM, GEN_FINISHED_AT],
            )?;
            match (started, finished) {
                (Some(s), Some(f)) if s > 0 && f >= s => Some(f - s),
                _ => None,
            }
        }
        _ => None,
    };
    let mut size = match &r.values[4] {
        Value::Text(n) => n.len() as i64,
        _ => 0,
    };
    let tp = key::id(key::MSG_TEXT, m);
    for (_, v) in view.scan(&tp, &key::prefix_end(&tp), usize::MAX)? {
        size += parse_varints::<5>(&v)?[2] as i64;
    }
    let vp = key::id(key::MSG_VALUE, m);
    for (_, v) in view.scan(&vp, &key::prefix_end(&vp), usize::MAX)? {
        size += bytes(&view.record(parse_loc(&v)?.pos)?.0, 2).len() as i64;
    }
    Ok(Some(Contrib {
        owner,
        parent,
        time,
        counted,
        words,
        send_at,
        gen_ms,
        size,
    }))
}

fn stat_key(owner: u64, c: u64) -> Vec<u8> {
    key::ids(STAT, owner, c)
}

fn counters(c: &Option<Contrib>) -> [i64; COUNTERS] {
    let mut out = [0; COUNTERS];
    let Some(c) = c else { return out };
    out[SIZE as usize] = c.size;
    match c.counted {
        Some(Who::User) => {
            out[USER_MSGS as usize] = 1;
            out[USER_WORDS as usize] = c.words;
        }
        Some(Who::Char) => {
            out[CHAR_MSGS as usize] = 1;
            out[CHAR_WORDS as usize] = c.words;
            match c.gen_ms {
                Some(ms) => out[GEN_MS as usize] = ms,
                None => out[GEN_UNKNOWN as usize] = 1,
            }
        }
        None => {}
    }
    out
}

fn swipes_of(n: i64) -> i64 {
    (n - 1).max(0)
}

fn user_at_key(owner: u64, at: i64, m: u64) -> Vec<u8> {
    let mut k = key::id(USER_AT, owner);
    put_u64(&mut k, (at + (1 << 53)) as u64);
    put_u64(&mut k, m);
    k
}

fn all_user_at_key(at: i64, m: u64) -> Vec<u8> {
    let mut k = key::id(ALL_USER_AT, (at + (1 << 53)) as u64);
    put_u64(&mut k, m);
    k
}

fn owner_time_key(owner: u64, t: i64, m: u64) -> Vec<u8> {
    let mut k = key::id(OWNER_TIME, owner);
    put_u64(&mut k, (t + (1 << 53)) as u64);
    put_u64(&mut k, m);
    k
}

fn time_of_key(k: &[u8], prefix_len: usize) -> Result<(i64, u64), StoreError> {
    let mut at = prefix_len;
    let bad = || StoreError::Entry("a stats key doesn't decode".into());
    let t = get_u64(k, &mut at).ok_or_else(bad)? as i64 - (1 << 53);
    Ok((t, get_u64(k, &mut at).ok_or_else(bad)?))
}

/// The owner's newest message time, read from the entries as they are.
pub fn last_chat(view: &View, owner: u64) -> Result<Option<i64>, StoreError> {
    let p = key::id(OWNER_TIME, owner);
    match view.scan_vals_rev(&p, &key::prefix_end(&p), 1)?.first() {
        Some((k, _)) => Ok(Some(time_of_key(k, p.len())?.0)),
        None => Ok(None),
    }
}

pub fn chat_size(view: &View, owner: u64) -> Result<i64, StoreError> {
    counter(view, &stat_key(owner, SIZE))
}

/// Applies a message's change of contribution from `before` to `after` (one owner).
fn apply(
    view: &View,
    out: &mut Out,
    m: u64,
    before: &Option<Contrib>,
    after: &Option<Contrib>,
) -> Result<(), StoreError> {
    let Some(owner) = after.as_ref().or(before.as_ref()).map(|c| c.owner) else {
        return Ok(());
    };
    let (b, a) = (counters(before), counters(after));
    for i in 0..COUNTERS {
        let d = a[i] - b[i];
        if d != 0 && i != SWIPES as usize {
            out.add(stat_key(owner, i as u64), d);
            out.add(key::id(STAT_TOTAL, i as u64), d);
        }
    }
    // Swipes: per parent, its counted character replies beyond the first.
    let char_parent = |c: &Option<Contrib>| {
        c.as_ref()
            .filter(|c| c.counted == Some(Who::Char))
            .and_then(|c| c.parent)
    };
    let (bp, ap) = (char_parent(before), char_parent(after));
    if bp != ap {
        let mut swipes = 0;
        for (p, d) in [(bp, -1), (ap, 1)] {
            let Some(p) = p else { continue };
            let n = counter(view, &key::id(CHAR_REPLIES, p))?;
            swipes += swipes_of(n + d) - swipes_of(n);
            out.add(key::id(CHAR_REPLIES, p), d);
        }
        if swipes != 0 {
            out.add(stat_key(owner, SWIPES), swipes);
            out.add(key::id(STAT_TOTAL, SWIPES), swipes);
        }
    }
    let at = |c: &Option<Contrib>| c.as_ref().and_then(|c| c.send_at);
    if at(before) != at(after) {
        if let Some(t) = at(before) {
            out.del(user_at_key(owner, t, m));
            out.del(all_user_at_key(t, m));
        }
        if let Some(t) = at(after) {
            out.put(user_at_key(owner, t, m), Vec::new());
            out.put(all_user_at_key(t, m), Vec::new());
        }
    }
    let t = |c: &Option<Contrib>| c.as_ref().map(|c| c.time);
    if t(before) != t(after) {
        // The newest time after: the two newest now, without this message's old one, and its new one.
        let p = key::id(OWNER_TIME, owner);
        let mut last = None;
        for (k, _) in view.scan_vals_rev(&p, &key::prefix_end(&p), 2)? {
            let (time, who) = time_of_key(&k, p.len())?;
            if who != m {
                last = last.max(Some(time));
                break;
            }
        }
        last = last.max(t(after));
        if let Some(old) = t(before) {
            out.del(owner_time_key(owner, old, m));
        }
        if let Some(new) = t(after) {
            out.put(owner_time_key(owner, new, m), Vec::new());
        }
        let size = chat_size(view, owner)? + a[SIZE as usize] - b[SIZE as usize];
        library::change(view, out, owner, |st| {
            st.nums[(LAST_CHAT - 1) as usize] = Some(last.unwrap_or(0) as f64);
            st.nums[(CHAT_SIZE - 1) as usize] = Some(size as f64);
        })?;
    } else if a[SIZE as usize] != b[SIZE as usize] {
        let size = chat_size(view, owner)? + a[SIZE as usize] - b[SIZE as usize];
        library::change(view, out, owner, |st| {
            st.nums[(CHAT_SIZE - 1) as usize] = Some(size as f64);
        })?;
    }
    Ok(())
}

/// The message a record changes the stats of, if any.
fn message_of(rec: &Record) -> Option<u64> {
    match rec.kind.name {
        "messageAppend" | "messageDelete" | "messageParent" | "messageTime" => Some(id(rec, 0)),
        "textValue" | "textEdit" | "jsonValue" | "valueDelete" => match Holder::of(rec, 0) {
            Holder::Message(m) => Some(m),
            Holder::Entity(_) => None,
        },
        _ => None,
    }
}

/// Message `m` is about to go without a record of its own (a subtree delete's slice): its contribution leaves the
/// stats.
pub fn removed(view: &View, out: &mut Out, m: u64) -> Result<(), StoreError> {
    let before = contrib(view, m)?;
    if before.is_some() {
        apply(view, out, m, &before, &None)?;
    }
    Ok(())
}

/// A deriver whose records change a message: it also keeps the stats of the message's owner.
pub struct Counted(pub &'static dyn Deriver);

impl Deriver for Counted {
    fn prepare(&self, rec: Record, view: &View) -> Result<Record, StoreError> {
        self.0.prepare(rec, view)
    }

    fn prepares(&self) -> bool {
        self.0.prepares()
    }

    fn partition(&self, rec: &Record) -> u64 {
        self.0.partition(rec)
    }

    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let Some(m) = message_of(rec) else {
            return self.0.derive(rec, at, view, out);
        };
        let before = contrib(view, m)?;
        let mut own = Out::default();
        self.0.derive(rec, at, view, &mut own)?;
        let mut local = std::collections::BTreeMap::new();
        for (k, v) in &own.entries {
            super::derive::apply(&mut local, k.clone(), v.clone());
        }
        let mut pending: HashMap<u64, (Record, u64)> = HashMap::new();
        pending.insert(at.pos, (rec.clone(), at.len));
        let mut layers = vec![Layer::Sorted(&local)];
        layers.extend(view.layers.iter().copied());
        let mut pend = vec![&pending];
        pend.extend(view.pending.iter().copied());
        let after_view = View {
            layers,
            pending: pend,
            staged: view.staged,
            bulk: view.bulk,
            ks: view.ks,
            snap: view.snap,
            log: view.log,
        };
        let after = contrib(&after_view, m)?;
        drop(after_view);
        out.entries.extend(own.entries);
        if before != after {
            apply(view, out, m, &before, &after)?;
        }
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        self.0.is_live(rec, pos, view)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        self.0.repoint(rec, from, to, view, out)
    }
}

fn read_counters(view: &View, k: impl Fn(u64) -> Vec<u8>) -> Result<[i64; COUNTERS], StoreError> {
    let mut out = [0; COUNTERS];
    for (i, c) in out.iter_mut().enumerate() {
        *c = counter(view, &k(i as u64))?;
    }
    Ok(out)
}

/// An owner's stats.
pub fn owner_stats(view: &View, owner: u64) -> Result<Stats, StoreError> {
    let p = key::id(USER_AT, owner);
    let first_user_at = match view.scan(&p, &key::prefix_end(&p), 1)?.first() {
        Some((k, _)) => Some(time_of_key(k, p.len())?.0),
        None => None,
    };
    Ok(Stats {
        counters: read_counters(view, |c| stat_key(owner, c))?,
        first_user_at,
        last_at: last_chat(view, owner)?,
    })
}

/// The stats of every owner together.
pub fn total_stats(view: &View) -> Result<Stats, StoreError> {
    let p = key::of(ALL_USER_AT);
    let first_user_at = match view.scan(&p, &key::prefix_end(&p), 1)?.first() {
        Some((k, _)) => {
            let mut at = p.len();
            Some(
                get_u64(k, &mut at)
                    .ok_or_else(|| StoreError::Entry("a stats key doesn't decode".into()))?
                    as i64
                    - (1 << 53),
            )
        }
        None => None,
    };
    Ok(Stats {
        counters: read_counters(view, |c| key::id(STAT_TOTAL, c))?,
        first_user_at,
        last_at: None,
    })
}
