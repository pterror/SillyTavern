//! Chats (`.plans/2026-10-03-storage-build-path.md` 5b): messages in each character's or group's tree, positions
//! (sessions and bookmarks) and the outside keys that name messages, sessions and users.
//!
//! A message's own values are the `messageAppend` record's fixed slots; every other value it holds is a value of
//! the message (`Holder::Message`) in the value kinds, by field. Its text is the field `MES`: the append's text
//! is its first full value, and edits and later full values follow it as any text value's do.

use super::StoreError;
use super::derive::{Deriver, Loc, Out, View};
use super::kinds::{
    Head, Holder, bytes, dead, drop_text_of, field, id, key, loc_bytes, parse_loc, parse_varints,
    varints,
};
use crate::keyspace::val::{get_u64, put_bytes, put_u64};
use crate::log::format::{FieldRef, Record, Value};
use crate::search::{self, Scope};

use super::sessions::{self, Fork};

/// A message's known top-level keys as field codes (1–63; `extra`'s known keys take 64 on; the JavaScript writer,
/// `src/chat-codec.js`, holds the whole list). Codes the engine reads: the text (`mes`), the fixed booleans when they
/// hold another value than the flags can say, `send_date` and the generation times. A time is a `messageTime` delta
/// from the append's time: of `SEND_DATE`, `GEN_STARTED`, `GEN_FINISHED` for an ISO string, of the `_NUM` codes for a
/// number; for another JSON value, the `_AT` codes hold the time the writer read from it (`parseTimestamp()`).
pub const MES: u64 = 1;
pub const IS_USER: u64 = 2;
pub const IS_SYSTEM: u64 = 3;
pub const IS_NAME: u64 = 4;
pub const NAME: u64 = 5;
pub const SEND_DATE: u64 = 6;
pub const EXTRA: u64 = 7;
pub const GEN_STARTED: u64 = 8;
pub const GEN_FINISHED: u64 = 9;
pub const SEND_AT: u64 = 20;
pub const GEN_STARTED_AT: u64 = 21;
pub const GEN_FINISHED_AT: u64 = 22;
pub const SEND_DATE_NUM: u64 = 23;
pub const GEN_STARTED_NUM: u64 = 24;
pub const GEN_FINISHED_NUM: u64 = 25;

/// `messageAppend`'s slots.
pub const APPEND_ID: usize = 0;
pub const APPEND_PARENT: usize = 1;
pub const APPEND_OWNER: usize = 2;
pub const APPEND_TIME: usize = 5;
pub const APPEND_TEXT: usize = 6;
pub const APPEND_FLAGS: usize = 7;
pub const APPEND_SESSION: usize = 8;
pub const APPEND_USER: usize = 9;
pub const APPEND_SEND_KEY: usize = 10;

/// `messageAppend`'s `flags`: the shape of the message's fixed values, two bits each (lowest first), laid out so
/// the usual messages (one the page sends, a reply the server stores, an upstream reply) take one byte:
/// - `is_user`: 0 false, 1 true, 2 absent, 3 another value (a JSON value of its own);
/// - `send_date`: 0 its own value (a `messageTime` or JSON value), 1 the append's time as a number, 2 the ISO
///   string of the append's time, 3 absent;
/// - key order: 0, 1, 2 one of the writer's three usual orders, 3 its own order value;
/// - `is_system`: 0 absent, 1 false, 2 true, 3 another value;
/// - `mes`: 0 the append's text (then edited as the text value `MES`), 1 absent, 2 another value;
/// - `extra`: 0 an object (its keys are values of their own), 1 absent, 2 another value;
/// - `name`: 0 a string (the append's `name`, else the speaker's), 1 absent, 2 another value;
/// - `is_name`: 0 absent, 1 true, 2 false, 3 another value;
/// - then one bit each: `original_avatar` is the speaker's key; `force_avatar` is the speaker's thumbnail URL.
pub const FLAG_IS_USER: u32 = 0;
pub const FLAG_SEND_DATE: u32 = 2;
pub const FLAG_ORDER: u32 = 4;
pub const FLAG_IS_SYSTEM: u32 = 6;
pub const FLAG_MES: u32 = 8;
pub const FLAG_EXTRA: u32 = 10;
pub const FLAG_NAME: u32 = 12;
pub const FLAG_IS_NAME: u32 = 14;
pub const FLAG_ORIGINAL_AVATAR: u32 = 16;
pub const FLAG_FORCE_AVATAR: u32 = 17;

/// A message's text is the append's own (its `mes` is a string).
pub fn text_in_append(flags: u64) -> bool {
    (flags >> FLAG_MES) & 3 == 0
}

/// A time as a key component that sorts as the time does (times are within ±(2^53 - 1)).
fn time_key(k: &mut Vec<u8>, t: i64) {
    put_u64(k, (t + (1 << 53)) as u64);
}

fn time_of(rec: &Record) -> i64 {
    match rec.values[APPEND_TIME] {
        Value::Time(t) => t,
        _ => unreachable!("checked by Record::new"),
    }
}

pub fn opt_id(rec: &Record, i: usize) -> Option<u64> {
    match rec.values[i] {
        Value::Id(v) => Some(v),
        _ => None,
    }
}

/// The key of a message's place among its parent's replies, or among the messages opening its owner's tree.
pub fn child_key(parent: Option<u64>, owner: u64, time: i64, m: u64) -> Vec<u8> {
    let mut k = match parent {
        Some(p) => key::id(key::CHILD, p),
        None => key::id(key::ROOT, owner),
    };
    time_key(&mut k, time);
    put_u64(&mut k, m);
    k
}

/// The prefix of a message's replies (`Some`) or of an owner's opening messages.
pub fn children_prefix(parent: Option<u64>, owner: u64) -> Vec<u8> {
    match parent {
        Some(p) => key::id(key::CHILD, p),
        None => key::id(key::ROOT, owner),
    }
}

/// The message id at the end of a `child_key`.
pub fn child_of_key(k: &[u8], prefix_len: usize) -> Result<u64, StoreError> {
    let mut at = prefix_len;
    let bad = || StoreError::Entry("a child key doesn't decode".into());
    get_u64(k, &mut at).ok_or_else(bad)?;
    get_u64(k, &mut at).ok_or_else(bad)
}

pub fn message_loc(view: &View, m: u64) -> Result<Option<Loc>, StoreError> {
    view.get(&key::id(key::MESSAGE, m))?
        .map(|b| parse_loc(&b))
        .transpose()
}

/// The message's `messageAppend` record, or a refusal naming it.
pub fn require_message(view: &View, m: u64) -> Result<(Loc, Record), StoreError> {
    let Some(l) = message_loc(view, m)? else {
        return Err(StoreError::Refused(format!("no message {m}")));
    };
    Ok((l, view.record(l.pos)?.0))
}

/// A change to message `m` made through session `s` by user `u` (each optional): it is meaningful activity in
/// the message's tree. Refuses a missing message, or an actor that isn't one.
pub fn edit_activity(
    view: &View,
    out: &mut Out,
    m: u64,
    s: Option<u64>,
    u: Option<u64>,
    at: Loc,
) -> Result<(), StoreError> {
    let (_, r) = require_message(view, m)?;
    sessions::check_actor(view, s, u)?;
    if let Some(s) = s {
        sessions::activity(view, out, s, id(&r, APPEND_OWNER), at.pos)?;
    }
    Ok(())
}

/// The message's parent now: its last `messageParent`'s, else its append's.
pub fn parent_of(view: &View, m: u64, append: &Record) -> Result<Option<u64>, StoreError> {
    match view.get(&key::id(key::MESSAGE_PARENT, m))? {
        Some(b) => {
            let (r, _) = view.record(parse_loc(&b)?.pos)?;
            Ok(opt_id(&r, 1))
        }
        None => Ok(opt_id(append, APPEND_PARENT)),
    }
}

/// Whether a change to the message field `f` derives anything from its text.
pub fn text_watched(f: &FieldRef) -> bool {
    *f == FieldRef::Code(MES)
}

/// A change of the message's text value of `f` from `old` to `new` (None: none).
pub fn text_changed(
    view: &View,
    out: &mut Out,
    m: u64,
    f: &FieldRef,
    old: Option<&[u8]>,
    new: Option<&[u8]>,
) -> Result<(), StoreError> {
    if !text_watched(f) {
        return Ok(());
    }
    let (_, rec) = require_message(view, m)?;
    let owner = id(&rec, APPEND_OWNER);
    search::index::update(
        view,
        out,
        Scope::chat(owner),
        m,
        0,
        &items(old),
        &items(new),
    )
}

fn items(t: Option<&[u8]>) -> Vec<&[u8]> {
    match t {
        Some(t) if !t.is_empty() => vec![t],
        _ => Vec::new(),
    }
}

/// The send key's entry: the message stored for it in the owner's tree.
pub fn send_key_key(owner: u64, sk: &[u8]) -> Vec<u8> {
    let mut k = key::id(key::SEND_KEY, owner);
    put_bytes(&mut k, sk);
    k
}

fn bookmark_entries(out: &mut Out, b: u64, owner: u64, at: u64, put: bool) {
    let a = key::ids(key::BOOKMARKS_AT, at, b);
    let t = key::ids(key::TREE_BOOKMARK, owner, b);
    if put {
        out.put(key::id(key::BOOKMARK_AT, b), varints(&[at]));
        out.put(a, Vec::new());
        out.put(t, Vec::new());
    } else {
        out.del(key::id(key::BOOKMARK_AT, b));
        out.del(a);
        out.del(t);
    }
}

/// The message a bookmark is at.
pub fn bookmark_at(view: &View, b: u64) -> Result<Option<u64>, StoreError> {
    view.get(&key::id(key::BOOKMARK_AT, b))?
        .map(|v| parse_varints::<1>(&v).map(|[m]| m))
        .transpose()
}

/// A bookmark's mode: its last `positionMode`'s, else its create's.
pub fn bookmark_mode(view: &View, b: u64) -> Result<Option<u64>, StoreError> {
    if let Some(v) = view.get(&key::id(key::POSITION_MODE, b))? {
        let (r, _) = view.record(parse_loc(&v)?.pos)?;
        return Ok(Some(id(&r, 1)));
    }
    match view.get(&key::id(key::POSITION, b))? {
        Some(v) => Ok(Some(id(&view.record(parse_loc(&v)?.pos)?.0, 1))),
        None => Ok(None),
    }
}

pub const FOLLOWING: u64 = 1;
pub const PINNED: u64 = 2;

/// The bookmarks at a message (each id).
pub fn bookmarks_at(view: &View, m: u64) -> Result<Vec<u64>, StoreError> {
    let start = key::id(key::BOOKMARKS_AT, m);
    let end = key::prefix_end(&start);
    view.scan(&start, &end, usize::MAX)?
        .into_iter()
        .map(|(k, _)| {
            let mut at = start.len();
            get_u64(&k, &mut at)
                .ok_or_else(|| StoreError::Entry("a bookmark key doesn't decode".into()))
        })
        .collect()
}

// ---- messages ----

pub struct MessageAppend;

impl Deriver for MessageAppend {
    fn partition(&self, rec: &Record) -> u64 {
        id(rec, APPEND_OWNER)
    }

    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let m = id(rec, APPEND_ID);
        let owner = id(rec, APPEND_OWNER);
        let parent = opt_id(rec, APPEND_PARENT);
        if message_loc(view, m)?.is_some() {
            return Err(StoreError::Refused(format!("message {m} exists")));
        }
        if let Some(p) = parent {
            let (_, pr) = require_message(view, p)?;
            if id(&pr, APPEND_OWNER) != owner {
                return Err(StoreError::Refused(format!(
                    "message {p} is in another tree than {owner}'s"
                )));
            }
        }
        if let Value::Bytes(sk) = &rec.values[APPEND_SEND_KEY] {
            let k = send_key_key(owner, sk);
            if view.get(&k)?.is_some() {
                return Err(StoreError::Refused(format!(
                    "a message with that send key is stored in {owner}'s tree"
                )));
            }
            out.put(k, varints(&[m]));
        }
        let (s, u) = (opt_id(rec, APPEND_SESSION), id(rec, APPEND_USER));
        sessions::check_actor(view, s, Some(u))?;
        out.put(key::id(key::MESSAGE, m), loc_bytes(at));
        out.max(key::of(key::NEXT_MESSAGE), m + 1);
        sessions::appended(view, out, m, parent)?;
        // Shown through its session: the session moves to it, and continuing there is choosing it.
        if let Some(s) = s {
            sessions::moved(view, out, s, u, owner, m, at, false, true)?;
            let f = match parent {
                Some(p) => Fork::Message(p),
                None => Fork::Root(owner),
            };
            sessions::chosen(view, out, s, u, f, m, at, false)?;
        }
        out.put(child_key(parent, owner, time_of(rec), m), Vec::new());
        if text_in_append(id(rec, APPEND_FLAGS)) {
            let text = bytes(rec, APPEND_TEXT);
            let h = Holder::Message(m);
            out.put(
                h.text_key(&FieldRef::Code(MES)),
                Head::new(at, text.len() as u64).bytes(),
            );
            search::index::update(view, out, Scope::chat(owner), m, 0, &[], &items(Some(text)))?;
        }
        // A following bookmark at the parent moves to the reply.
        if let Some(p) = parent {
            for b in bookmarks_at(view, p)? {
                if bookmark_mode(view, b)? == Some(FOLLOWING) {
                    bookmark_entries(out, b, owner, p, false);
                    bookmark_entries(out, b, owner, m, true);
                }
            }
        }
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        Ok(message_loc(view, id(rec, APPEND_ID))?.is_some_and(|l| l.pos == pos))
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        let m = id(rec, APPEND_ID);
        if !message_loc(view, m)?.is_some_and(|l| l.pos == from) {
            return Ok(());
        }
        out.put(key::id(key::MESSAGE, m), loc_bytes(to));
        super::kinds::repoint_text_of(
            Holder::Message(m),
            &FieldRef::Code(MES),
            from,
            Some(to),
            view,
            out,
        )
        .map(drop)
    }
}

/// `messageDelete`: a message nothing replies to goes, with every value it holds.
pub struct MessageDelete;

impl Deriver for MessageDelete {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let m = id(rec, 0);
        let (l, append) = require_message(view, m)?;
        let start = key::id(key::CHILD, m);
        if !view.scan(&start, &key::prefix_end(&start), 1)?.is_empty() {
            return Err(StoreError::Refused(format!("message {m} has replies")));
        }
        if !bookmarks_at(view, m)?.is_empty() {
            return Err(StoreError::Refused(format!("a bookmark is at message {m}")));
        }
        let (s, u) = (opt_id(rec, 1), opt_id(rec, 2));
        sessions::check_actor(view, s, u)?;
        dead(out, at);
        let owner = id(&append, APPEND_OWNER);
        if let Some(s) = s {
            sessions::activity(view, out, s, owner, at.pos)?;
        }
        let h = Holder::Message(m);
        // Text values (the message's own included), then the rest of what it holds.
        let tp = key::id(key::MSG_TEXT, m);
        for (tk, _) in view.scan(&tp, &key::prefix_end(&tp), usize::MAX)? {
            let f = super::library::field_after(&tk, key::MSG_TEXT)?;
            drop_text_of(view, out, h, &f)?;
        }
        for s in [key::MSG_VALUE, key::MSG_TIME, ITEMIZED] {
            let p = key::id(s, m);
            for (k, v) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
                dead(out, parse_loc(&v)?);
                out.del(k);
            }
        }
        let parent = parent_of(view, m, &append)?;
        if let Some(v) = view.get(&key::id(key::MESSAGE_PARENT, m))? {
            dead(out, parse_loc(&v)?);
            out.del(key::id(key::MESSAGE_PARENT, m));
        }
        out.del(child_key(parent, owner, time_of(&append), m));
        if let Value::Bytes(sk) = &append.values[APPEND_SEND_KEY] {
            out.del(send_key_key(owner, sk));
        }
        drop_key(view, out, KEYED_MESSAGE, m)?;
        sessions::message_gone(view, out, m, parent, owner)?;
        super::state::message_gone(view, out, m)?;
        dead(out, l);
        out.del(key::id(key::MESSAGE, m));
        Ok(())
    }

    fn is_live(&self, _: &Record, _: u64, _: &View) -> Result<bool, StoreError> {
        Ok(false)
    }

    fn repoint(&self, _: &Record, _: u64, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Ok(())
    }
}

/// Whether `a` is `m` or one of its ancestors' (walking up from `a`).
fn is_at_or_below(view: &View, a: u64, m: u64) -> Result<bool, StoreError> {
    let mut cur = Some(a);
    let mut steps = 0u64;
    while let Some(c) = cur {
        if c == m {
            return Ok(true);
        }
        let (_, r) = require_message(view, c)?;
        cur = parent_of(view, c, &r)?;
        steps += 1;
        if steps > 1 << 32 {
            return Err(StoreError::Entry(
                "a message's ancestors form a cycle".into(),
            ));
        }
    }
    Ok(false)
}

/// `messageParent`: a message moves under another parent of its tree (none: it opens the tree).
pub struct MessageParent;

impl Deriver for MessageParent {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let m = id(rec, 0);
        let new = opt_id(rec, 1);
        let (s, u) = (opt_id(rec, 2), opt_id(rec, 3));
        sessions::check_actor(view, s, u)?;
        let (_, append) = require_message(view, m)?;
        let owner = id(&append, APPEND_OWNER);
        if let Some(p) = new {
            let (_, pr) = require_message(view, p)?;
            if id(&pr, APPEND_OWNER) != owner {
                return Err(StoreError::Refused(format!(
                    "message {p} is in another tree than message {m}"
                )));
            }
            if is_at_or_below(view, p, m)? {
                return Err(StoreError::Refused(format!(
                    "message {p} is message {m} or one of its replies"
                )));
            }
        }
        let old = parent_of(view, m, &append)?;
        let k = key::id(key::MESSAGE_PARENT, m);
        if let Some(v) = view.get(&k)? {
            dead(out, parse_loc(&v)?);
        }
        out.put(k, loc_bytes(at));
        let t = time_of(&append);
        out.del(child_key(old, owner, t, m));
        out.put(child_key(new, owner, t, m), Vec::new());
        sessions::reparented(view, out, m, owner, at.pos)?;
        if let Some(s) = s {
            sessions::activity(view, out, s, owner, at.pos)?;
        }
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        live_at(view, &key::id(key::MESSAGE_PARENT, id(rec, 0)), pos)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_at(
            view,
            out,
            &key::id(key::MESSAGE_PARENT, id(rec, 0)),
            from,
            to,
        )
    }
}

fn live_at(view: &View, k: &[u8], pos: u64) -> Result<bool, StoreError> {
    Ok(view
        .get(k)?
        .map(|b| parse_loc(&b))
        .transpose()?
        .is_some_and(|l| l.pos == pos))
}

fn repoint_at(view: &View, out: &mut Out, k: &[u8], from: u64, to: Loc) -> Result<(), StoreError> {
    if live_at(view, k, from)? {
        out.put(k.to_vec(), loc_bytes(to));
    }
    Ok(())
}

/// The entry of a message's time value.
pub fn msg_time_key(m: u64, f: &FieldRef) -> Vec<u8> {
    key::field(key::MSG_TIME, m, f)
}

/// `messageTime`: one of a message's times as an ISO string a delta from its append's time.
pub struct MessageTime;

impl Deriver for MessageTime {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (m, f) = (id(rec, 0), field(rec, 1));
        edit_activity(view, out, m, opt_id(rec, 3), opt_id(rec, 4), at)?;
        let h = Holder::Message(m);
        // A time takes the place of any other value of the field.
        drop_text_of(view, out, h, f)?;
        super::library::drop_json_of(view, out, h, f)?;
        let k = msg_time_key(m, f);
        if let Some(v) = view.get(&k)? {
            dead(out, parse_loc(&v)?);
        }
        out.put(k, loc_bytes(at));
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        live_at(view, &msg_time_key(id(rec, 0), field(rec, 1)), pos)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_at(
            view,
            out,
            &msg_time_key(id(rec, 0), field(rec, 1)),
            from,
            to,
        )
    }
}

/// Clears the message field's time value before another value takes its place.
pub fn drop_time(view: &View, out: &mut Out, m: u64, f: &FieldRef) -> Result<(), StoreError> {
    let k = msg_time_key(m, f);
    if let Some(v) = view.get(&k)? {
        dead(out, parse_loc(&v)?);
        out.del(k);
    }
    Ok(())
}

// ---- outside keys ----

/// `KEYED`'s spaces, by their index in it.
pub const KEYED_MESSAGE: u8 = 0;
pub const KEYED_SESSION: u8 = 1;
pub const KEYED_USER: u8 = 2;

pub fn key_map_key(space: u8, k: &[u8]) -> Vec<u8> {
    let mut out = key::id(key::KEY_MAP, u64::from(space));
    put_bytes(&mut out, k);
    out
}

pub fn key_of_key(space: u8, i: u64) -> Vec<u8> {
    key::ids(key::KEY_OF, u64::from(space), i)
}

/// The id an outside key names in `space`.
pub fn id_by_key(view: &View, space: u8, k: &[u8]) -> Result<Option<u64>, StoreError> {
    view.get(&key_map_key(space, k))?
        .map(|v| parse_varints::<1>(&v).map(|[i]| i))
        .transpose()
}

/// The outside key naming `i` in `space`.
pub fn key_by_id(view: &View, space: u8, i: u64) -> Result<Option<Vec<u8>>, StoreError> {
    match view.get(&key_of_key(space, i))? {
        Some(v) => Ok(Some(bytes(&view.record(parse_loc(&v)?.pos)?.0, 1).to_vec())),
        None => Ok(None),
    }
}

/// Drops `i`'s outside key, if it has one.
pub(super) fn drop_key(view: &View, out: &mut Out, space: u8, i: u64) -> Result<(), StoreError> {
    let k = key_of_key(space, i);
    let Some(v) = view.get(&k)? else {
        return Ok(());
    };
    let l = parse_loc(&v)?;
    let (r, _) = view.record(l.pos)?;
    out.del(key_map_key(space, bytes(&r, 1)));
    out.del(k);
    dead(out, l);
    Ok(())
}

fn keyed(rec: &Record) -> (u8, u64) {
    match rec.values[0] {
        Value::Sel(s, i) => (s, i),
        _ => unreachable!("checked by Record::new"),
    }
}

/// `keyMap`: an outside key names an id, one key per id and one id per key.
pub struct KeyMap;

impl Deriver for KeyMap {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (space, i) = keyed(rec);
        let k = bytes(rec, 1);
        if id_by_key(view, space, k)?.is_some() {
            return Err(StoreError::Refused("that key names an id already".into()));
        }
        if view.get(&key_of_key(space, i))?.is_some() {
            return Err(StoreError::Refused(format!("id {i} has a key already")));
        }
        if space == KEYED_SESSION && view.get(&key::id(key::POSITION, i))?.is_some() {
            return Err(StoreError::Refused(format!("position {i} is a bookmark")));
        }
        out.put(key_map_key(space, k), varints(&[i]));
        out.put(key_of_key(space, i), loc_bytes(at));
        let next = match space {
            KEYED_MESSAGE => key::NEXT_MESSAGE,
            KEYED_SESSION => key::NEXT_POSITION,
            _ => key::NEXT_USER,
        };
        out.max(key::of(next), i + 1);
        Ok(())
    }

    fn partition(&self, rec: &Record) -> u64 {
        keyed(rec).1
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        let (space, i) = keyed(rec);
        live_at(view, &key_of_key(space, i), pos)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        let (space, i) = keyed(rec);
        repoint_at(view, out, &key_of_key(space, i), from, to)
    }
}

// ---- positions ----

/// Whether position `p` is a session: it has an outside key (sessions are named by UUIDs).
pub fn is_session(view: &View, p: u64) -> Result<bool, StoreError> {
    Ok(view.get(&key_of_key(KEYED_SESSION, p))?.is_some())
}

fn check_mode(mode: u64) -> Result<(), StoreError> {
    if mode == FOLLOWING || mode == PINNED {
        Ok(())
    } else {
        Err(StoreError::Refused(format!("no bookmark mode {mode}")))
    }
}

/// `positionCreate`: a bookmark comes to be at a message.
pub struct PositionCreate;

impl Deriver for PositionCreate {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (b, mode, ptr) = (id(rec, 0), id(rec, 1), id(rec, 4));
        check_mode(mode)?;
        if view.get(&key::id(key::POSITION, b))?.is_some() || is_session(view, b)? {
            return Err(StoreError::Refused(format!("position {b} exists")));
        }
        let (_, m) = require_message(view, ptr)?;
        let (s, u) = (id(rec, 2), id(rec, 3));
        sessions::check_actor(view, Some(s), Some(u))?;
        let tree = id(&m, APPEND_OWNER);
        out.put(key::id(key::POSITION, b), loc_bytes(at));
        out.max(key::of(key::NEXT_POSITION), b + 1);
        bookmark_entries(out, b, tree, ptr, true);
        sessions::branch_created(out, ptr, b);
        sessions::activity(view, out, s, tree, at.pos)
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        live_at(view, &key::id(key::POSITION, id(rec, 0)), pos)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_at(view, out, &key::id(key::POSITION, id(rec, 0)), from, to)
    }
}

/// `positionName`: a bookmark's or session's name.
pub struct PositionName;

impl Deriver for PositionName {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let p = id(rec, 0);
        if view.get(&key::id(key::POSITION, p))?.is_none() && !is_session(view, p)? {
            return Err(StoreError::Refused(format!("no position {p}")));
        }
        let k = key::id(key::POSITION_NAME, p);
        if let Some(v) = view.get(&k)? {
            dead(out, parse_loc(&v)?);
        }
        if rec.values[1] == Value::Absent {
            dead(out, at);
            out.del(k);
        } else {
            out.put(k, loc_bytes(at));
        }
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        live_at(view, &key::id(key::POSITION_NAME, id(rec, 0)), pos)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_at(
            view,
            out,
            &key::id(key::POSITION_NAME, id(rec, 0)),
            from,
            to,
        )
    }
}

/// `positionMode`: a bookmark becomes following or pinned.
pub struct PositionMode;

impl Deriver for PositionMode {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (b, mode) = (id(rec, 0), id(rec, 1));
        check_mode(mode)?;
        if view.get(&key::id(key::POSITION, b))?.is_none() {
            return Err(StoreError::Refused(format!("no bookmark {b}")));
        }
        let k = key::id(key::POSITION_MODE, b);
        if let Some(v) = view.get(&k)? {
            dead(out, parse_loc(&v)?);
        }
        out.put(k, loc_bytes(at));
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        live_at(view, &key::id(key::POSITION_MODE, id(rec, 0)), pos)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_at(
            view,
            out,
            &key::id(key::POSITION_MODE, id(rec, 0)),
            from,
            to,
        )
    }
}

/// `positionDelete`: a bookmark goes.
pub struct PositionDelete;

impl Deriver for PositionDelete {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let b = id(rec, 0);
        let Some(v) = view.get(&key::id(key::POSITION, b))? else {
            if !is_session(view, b)? {
                return Err(StoreError::Refused(format!("no position {b}")));
            }
            dead(out, at);
            if let Some(n) = view.get(&key::id(key::POSITION_NAME, b))? {
                dead(out, parse_loc(&n)?);
                out.del(key::id(key::POSITION_NAME, b));
            }
            return sessions::session_gone(view, out, b);
        };
        dead(out, at);
        let cl = parse_loc(&v)?;
        let (create, _) = view.record(cl.pos)?;
        sessions::branch_gone(out, id(&create, 4), b);
        dead(out, cl);
        out.del(key::id(key::POSITION, b));
        for s in [key::POSITION_NAME, key::POSITION_MODE] {
            if let Some(v) = view.get(&key::id(s, b))? {
                dead(out, parse_loc(&v)?);
                out.del(key::id(s, b));
            }
        }
        if let Some(m) = bookmark_at(view, b)? {
            let (_, r) = require_message(view, m)?;
            bookmark_entries(out, b, id(&r, APPEND_OWNER), m, false);
        }
        Ok(())
    }

    fn is_live(&self, _: &Record, _: u64, _: &View) -> Result<bool, StoreError> {
        Ok(false)
    }

    fn repoint(&self, _: &Record, _: u64, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Ok(())
    }
}

/// `pointerMove`: a session's pointer moves; the record is its history entry's, kept while the session is.
pub struct PointerMove;

impl Deriver for PointerMove {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (s, u, target) = (id(rec, 0), id(rec, 1), id(rec, 2));
        sessions::check_actor(view, Some(s), Some(u))?;
        let (_, r) = require_message(view, target)?;
        sessions::moved(
            view,
            out,
            s,
            u,
            id(&r, APPEND_OWNER),
            target,
            at,
            true,
            false,
        )
    }

    fn is_live(&self, _: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        Ok(sessions::history_entry(view, pos)?.is_some())
    }

    fn repoint(
        &self,
        _: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        sessions::history_repoint(view, out, from, to)
    }
}

/// `forkSelection`: a reply is chosen at its fork by a session and a user.
pub struct ForkSelection;

impl Deriver for ForkSelection {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (reply, s, u) = (id(rec, 1), id(rec, 2), id(rec, 3));
        sessions::check_actor(view, Some(s), Some(u))?;
        let (f, tree) = Fork::of(view, reply)?;
        let named = match opt_id(rec, 0) {
            Some(m) => Fork::Message(m),
            None => Fork::Root(tree),
        };
        if named != f {
            return Err(StoreError::Refused(format!(
                "message {reply} isn't a reply at that fork"
            )));
        }
        sessions::chosen(view, out, s, u, f, reply, at, true)?;
        sessions::activity(view, out, s, tree, at.pos)
    }

    fn partition(&self, rec: &Record) -> u64 {
        id(rec, 1)
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        sessions::selection_live(view, rec, pos)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        sessions::selection_repoint(view, out, rec, from, to)
    }
}

/// Per message: its `itemization` record.
pub const ITEMIZED: u64 = 170;

/// The message's itemization: whether it holds the prompt as sent, and its data.
pub fn itemization(view: &View, m: u64) -> Result<Option<(bool, Vec<u8>)>, StoreError> {
    match view.get(&key::id(ITEMIZED, m))? {
        Some(b) => {
            let (r, _) = view.record(parse_loc(&b)?.pos)?;
            Ok(Some((
                r.values[1] == Value::Bit(true),
                bytes(&r, 2).to_vec(),
            )))
        }
        None => Ok(None),
    }
}

/// `itemization`: a message's prompt itemization is set, or goes.
pub struct Itemization;

impl Deriver for Itemization {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let m = id(rec, 0);
        require_message(view, m)?;
        let k = key::id(ITEMIZED, m);
        if let Some(b) = view.get(&k)? {
            dead(out, parse_loc(&b)?);
        }
        if rec.values[2] == Value::Absent {
            dead(out, at);
            out.del(k);
        } else {
            out.put(k, loc_bytes(at));
        }
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        live_at(view, &key::id(ITEMIZED, id(rec, 0)), pos)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_at(view, out, &key::id(ITEMIZED, id(rec, 0)), from, to)
    }
}

pub fn deriver(kind: &str) -> Option<&'static dyn Deriver> {
    Some(match kind {
        "itemization" => &Itemization,
        "pointerMove" => &PointerMove,
        "forkSelection" => &ForkSelection,
        "messageAppend" => &MessageAppend,
        "messageDelete" => &MessageDelete,
        "messageParent" => &MessageParent,
        "messageTime" => &MessageTime,
        "keyMap" => &KeyMap,
        "positionCreate" => &PositionCreate,
        "positionName" => &PositionName,
        "positionMode" => &PositionMode,
        "positionDelete" => &PositionDelete,
        _ => return None,
    })
}
