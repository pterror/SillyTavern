//! Recent history. A chat's tips are the messages where a line of its conversation ends: where a move of its cursor left
//! from, unless the move went on below it, or it is an alternative of the message the move split off at. A tip's split
//! is the closest common ancestor of where that move left and where it went (none: the tree's root), worked out once,
//! when the move is recorded. A chat's tips with one split are a group. A chat is a conversation as the chat list names
//! it (`sessions::Convo`): the session's current bookmark in the tree, else its own conversation there.
//!
//! Activities are log positions of the records that moved, so later is greater.

use std::collections::{BTreeMap, HashSet};

use super::StoreError;
use super::chat;
use super::derive::{Layer, Out, View};
use super::kinds::{key, parse_varints, varints};
use super::sessions::{self, Convo};
use crate::keyspace::val::{Val, get_u64, put_u64};

/// chat → [where it is (`code`), activity]
pub const TIP_AT: u64 = 260;
/// (m, chat): the chats that are at message m
pub const TIP_AT_BY: u64 = 261;
/// (chat, m) → [split (`code`), activity]
pub const TIP: u64 = 262;
/// (chat, split, activity, m): a group's tips
pub const TIP_ORDER: u64 = 263;
/// (m, chat): the chats m is a tip of
pub const TIP_BY: u64 = 264;
/// (chat, split) → [the latest activity of its tips, how many tips]
pub const TIP_GROUP: u64 = 265;
/// (m, chat): the chats with a group split off at message m
pub const TIP_SPLIT_BY: u64 = 266;
/// (chat, activity, kind, split): a chat's entries
pub const TIP_RECENT: u64 = 267;
/// (activity, chat, kind, split): every chat's entries
pub const TIP_ALL: u64 = 268;

const SPACES: std::ops::RangeInclusive<u64> = TIP_AT..=TIP_ALL;

/// A group sorts after the place a chat is at when both have one activity, so the place it is at reads first.
const GROUP: u64 = 0;
const AT: u64 = 1;

/// A place in a tree, or a split: 0 the tree's root, m + 1 message m.
fn code(m: Option<u64>) -> u64 {
    m.map_or(0, |m| m + 1)
}

fn uncode(c: u64) -> Option<u64> {
    c.checked_sub(1)
}

fn bad(what: &str) -> StoreError {
    StoreError::Entry(format!("{what} doesn't decode"))
}

fn get_vals<const N: usize>(view: &View, k: &[u8]) -> Result<Option<[u64; N]>, StoreError> {
    view.get(k)?.map(|b| parse_varints::<N>(&b)).transpose()
}

fn put_chat(k: &mut Vec<u8>, c: Convo) {
    let (w, a, b) = c.parts();
    put_u64(k, w);
    put_u64(k, a);
    put_u64(k, b);
}

fn get_chat(k: &[u8], at: &mut usize) -> Option<Convo> {
    let (w, a, b) = (get_u64(k, at)?, get_u64(k, at)?, get_u64(k, at)?);
    Some(if w == 0 {
        Convo::Bookmark(a)
    } else {
        Convo::Session(a, b)
    })
}

fn chat_key(space: u64, c: Convo) -> Vec<u8> {
    let mut k = key::of(space);
    put_chat(&mut k, c);
    k
}

fn by_key(space: u64, m: u64, c: Convo) -> Vec<u8> {
    let mut k = key::id(space, m);
    put_chat(&mut k, c);
    k
}

fn tip_key(c: Convo, m: u64) -> Vec<u8> {
    let mut k = chat_key(TIP, c);
    put_u64(&mut k, m);
    k
}

fn group_key(c: Convo, split: u64) -> Vec<u8> {
    let mut k = chat_key(TIP_GROUP, c);
    put_u64(&mut k, split);
    k
}

fn order_prefix(c: Convo, split: u64) -> Vec<u8> {
    let mut k = chat_key(TIP_ORDER, c);
    put_u64(&mut k, split);
    k
}

fn order_key(c: Convo, split: u64, pos: u64, m: u64) -> Vec<u8> {
    let mut k = order_prefix(c, split);
    put_u64(&mut k, pos);
    put_u64(&mut k, m);
    k
}

fn recent_key(c: Convo, pos: u64, kind: u64, split: u64) -> Vec<u8> {
    let mut k = chat_key(TIP_RECENT, c);
    put_u64(&mut k, pos);
    put_u64(&mut k, kind);
    put_u64(&mut k, split);
    k
}

fn all_key(pos: u64, c: Convo, kind: u64, split: u64) -> Vec<u8> {
    let mut k = key::id(TIP_ALL, pos);
    put_chat(&mut k, c);
    put_u64(&mut k, kind);
    put_u64(&mut k, split);
    k
}

fn entry_put(out: &mut Out, c: Convo, pos: u64, kind: u64, split: u64) {
    out.put(recent_key(c, pos, kind, split), Vec::new());
    out.put(all_key(pos, c, kind, split), Vec::new());
}

fn entry_del(out: &mut Out, c: Convo, pos: u64, kind: u64, split: u64) {
    out.del(recent_key(c, pos, kind, split));
    out.del(all_key(pos, c, kind, split));
}

/// The chat a session's move in a tree is a move of.
pub fn chat_of(view: &View, s: u64, tree: u64) -> Result<Convo, StoreError> {
    Ok(match sessions::current_chat(view, s, tree)? {
        Some(b) => Convo::Bookmark(b),
        None => Convo::Session(s, tree),
    })
}

/// Writes made one after another, each reading what the ones before it wrote.
struct Steps<'v, 'a> {
    view: &'v View<'a>,
    local: BTreeMap<Vec<u8>, Val>,
}

impl<'v, 'a> Steps<'v, 'a> {
    fn new(view: &'v View<'a>) -> Self {
        Steps {
            view,
            local: BTreeMap::new(),
        }
    }

    fn run<T>(
        &mut self,
        f: impl FnOnce(&View, &mut Out) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let mut o = Out::default();
        let r = {
            let mut layers = vec![Layer::Sorted(&self.local)];
            layers.extend(self.view.layers.iter().copied());
            let lv = View {
                layers,
                pending: self.view.pending.clone(),
                staged: self.view.staged,
                bulk: self.view.bulk,
                ks: self.view.ks,
                snap: self.view.snap,
                log: self.view.log,
                memo: self.view.memo,
            };
            f(&lv, &mut o)?
        };
        o.apply(&mut self.local);
        Ok(r)
    }

    fn finish(self, out: &mut Out) {
        out.entries.extend(self.local);
    }
}

fn parent(view: &View, m: u64) -> Result<Option<u64>, StoreError> {
    Ok(chat::message_entry(view, m)?.and_then(|(_, p)| p))
}

/// The closest common ancestor of two messages of a tree, each counting as its own; none when they share no message.
/// With the tree's depths known it climbs jump pointers, a step per halving of the depth; while they are being
/// rewritten it walks parents.
pub fn closest_common(view: &View, tree: u64, a: u64, b: u64) -> Result<Option<u64>, StoreError> {
    if a == b {
        return Ok(Some(a));
    }
    if !sessions::depths_pending(view, tree)?
        && let Some(found) = by_jumps(view, a, b)?
    {
        return Ok(found);
    }
    let mut above = HashSet::new();
    let mut cur = Some(a);
    while let Some(c) = cur {
        above.insert(c);
        cur = parent(view, c)?;
    }
    let mut cur = Some(b);
    while let Some(c) = cur {
        if above.contains(&c) {
            return Ok(Some(c));
        }
        cur = parent(view, c)?;
    }
    Ok(None)
}

/// None when a depth or a parent it needs is missing.
#[allow(clippy::option_option)]
fn by_jumps(view: &View, a: u64, b: u64) -> Result<Option<Option<u64>>, StoreError> {
    let (Some((da, ja)), Some((db, jb))) = (
        sessions::depth_jump(view, a)?,
        sessions::depth_jump(view, b)?,
    ) else {
        return Ok(None);
    };
    let d = da.min(db);
    let mut reads = 0;
    let Some((mut u, mut ju)) = sessions::climb(view, a, da, ja, d, &mut reads)? else {
        return Ok(None);
    };
    let Some((mut v, mut jv)) = sessions::climb(view, b, db, jb, d, &mut reads)? else {
        return Ok(None);
    };
    let mut d = d;
    loop {
        if u == v {
            return Ok(Some(Some(u)));
        }
        if d <= 1 {
            return Ok(Some(None));
        }
        match (ju, jv) {
            (Some(x), Some(y)) if x != y => {
                u = x;
                v = y;
                d = sessions::jump_depth(d);
            }
            _ => {
                let (Some(pu), Some(pv)) = (parent(view, u)?, parent(view, v)?) else {
                    return Ok(None);
                };
                u = pu;
                v = pv;
                d -= 1;
            }
        }
        let (Some((_, nu)), Some((_, nv))) = (
            sessions::depth_jump(view, u)?,
            sessions::depth_jump(view, v)?,
        ) else {
            return Ok(None);
        };
        ju = nu;
        jv = nv;
    }
}

/// Where a chat is, and the activity it got there at.
fn at_of(view: &View, c: Convo) -> Result<Option<(Option<u64>, u64)>, StoreError> {
    Ok(get_vals::<2>(view, &chat_key(TIP_AT, c))?.map(|[p, pos]| (uncode(p), pos)))
}

fn set_at(
    view: &View,
    out: &mut Out,
    c: Convo,
    to: Option<u64>,
    pos: u64,
) -> Result<(), StoreError> {
    if let Some((old, opos)) = at_of(view, c)?
        && let Some(m) = old
    {
        out.del(by_key(TIP_AT_BY, m, c));
        entry_del(out, c, opos, AT, 0);
    }
    out.put(chat_key(TIP_AT, c), varints(&[code(to), pos]));
    if let Some(m) = to {
        out.put(by_key(TIP_AT_BY, m, c), Vec::new());
        entry_put(out, c, pos, AT, 0);
    }
    Ok(())
}

fn regroup_entry(out: &mut Out, c: Convo, split: u64, from: u64, to: u64) {
    if from != to {
        entry_del(out, c, from, GROUP, split);
        entry_put(out, c, to, GROUP, split);
    }
}

fn drop_tip(view: &View, out: &mut Out, c: Convo, m: u64) -> Result<(), StoreError> {
    let Some([split, pos]) = get_vals::<2>(view, &tip_key(c, m))? else {
        return Ok(());
    };
    out.del(tip_key(c, m));
    out.del(order_key(c, split, pos, m));
    out.del(by_key(TIP_BY, m, c));
    let [latest, n] =
        get_vals::<2>(view, &group_key(c, split))?.ok_or_else(|| bad("a tip's group"))?;
    if n <= 1 {
        out.del(group_key(c, split));
        entry_del(out, c, latest, GROUP, split);
        if let Some(s) = uncode(split) {
            out.del(by_key(TIP_SPLIT_BY, s, c));
        }
        return Ok(());
    }
    let mut next = latest;
    if pos == latest {
        let p = order_prefix(c, split);
        for (k, _) in view.scan_vals_rev(&p, &key::prefix_end(&p), 2)? {
            let mut at = p.len();
            let tp = get_u64(&k, &mut at).ok_or_else(|| bad("a tip order key"))?;
            if get_u64(&k, &mut at).ok_or_else(|| bad("a tip order key"))? != m {
                next = tp;
                break;
            }
        }
    }
    out.put(group_key(c, split), varints(&[next, n - 1]));
    regroup_entry(out, c, split, latest, next);
    Ok(())
}

/// `m` is no tip of the chat yet.
fn add_tip(
    view: &View,
    out: &mut Out,
    c: Convo,
    m: u64,
    split: u64,
    pos: u64,
) -> Result<(), StoreError> {
    out.put(tip_key(c, m), varints(&[split, pos]));
    out.put(order_key(c, split, pos, m), Vec::new());
    out.put(by_key(TIP_BY, m, c), Vec::new());
    match get_vals::<2>(view, &group_key(c, split))? {
        Some([latest, n]) => {
            let next = latest.max(pos);
            out.put(group_key(c, split), varints(&[next, n + 1]));
            regroup_entry(out, c, split, latest, next);
        }
        None => {
            out.put(group_key(c, split), varints(&[pos, 1]));
            entry_put(out, c, pos, GROUP, split);
            if let Some(s) = uncode(split) {
                out.put(by_key(TIP_SPLIT_BY, s, c), Vec::new());
            }
        }
    }
    Ok(())
}

/// `appended`: when `to` is a message the move's record appends, its parent, as the view doesn't hold it yet.
fn move_chat(
    steps: &mut Steps,
    c: Convo,
    tree: u64,
    to: Option<u64>,
    appended: Option<Option<u64>>,
    pos: u64,
) -> Result<(), StoreError> {
    let from = steps.run(|v, _| at_of(v, c))?;
    if let Some((Some(a), _)) = from
        && Some(a) != to
    {
        let (split, above) = steps.run(|v, _| {
            let split = match (to, appended) {
                (None, _) | (Some(_), Some(None)) => None,
                (Some(_), Some(Some(p))) => closest_common(v, tree, a, p)?,
                (Some(b), None) => closest_common(v, tree, a, b)?,
            };
            Ok((split, parent(v, a)?))
        })?;
        if split != Some(a) && above != split {
            steps.run(|v, o| drop_tip(v, o, c, a))?;
            steps.run(|v, o| add_tip(v, o, c, a, code(split), pos))?;
        }
    }
    if let Some(b) = to {
        steps.run(|v, o| drop_tip(v, o, c, b))?;
    }
    steps.run(|v, o| set_at(v, o, c, to, pos))
}

/// A session's move in a tree, to a message or to the tree's root, by the record at log position `pos`; `appended` as
/// for `move_chat`.
pub fn moved(
    view: &View,
    out: &mut Out,
    s: u64,
    tree: u64,
    to: Option<u64>,
    appended: Option<Option<u64>>,
    pos: u64,
) -> Result<(), StoreError> {
    let c = chat_of(view, s, tree)?;
    let mut steps = Steps::new(view);
    move_chat(&mut steps, c, tree, to, appended, pos)?;
    steps.finish(out);
    Ok(())
}

fn chats_by(view: &View, space: u64, m: u64) -> Result<Vec<Convo>, StoreError> {
    let p = key::id(space, m);
    view.scan(&p, &key::prefix_end(&p), usize::MAX)?
        .into_iter()
        .map(|(k, _)| {
            let mut at = p.len();
            get_chat(&k, &mut at).ok_or_else(|| bad("a recent history index key"))
        })
        .collect()
}

/// Message `m` is deleted; a chat at it is at `to` now, keeping its activity, and a group split off at it is split
/// off at `parent`, the message its replies were moved under.
pub fn message_gone(
    view: &View,
    out: &mut Out,
    m: u64,
    parent: Option<u64>,
    to: Option<u64>,
) -> Result<(), StoreError> {
    let mut steps = Steps::new(view);
    for c in chats_by(view, TIP_BY, m)? {
        steps.run(|v, o| drop_tip(v, o, c, m))?;
    }
    for c in chats_by(view, TIP_AT_BY, m)? {
        let Some((_, pos)) = steps.run(|v, _| at_of(v, c))? else {
            continue;
        };
        if let Some(t) = to {
            steps.run(|v, o| drop_tip(v, o, c, t))?;
        }
        steps.run(|v, o| set_at(v, o, c, to, pos))?;
    }
    for c in chats_by(view, TIP_SPLIT_BY, m)? {
        let p = order_prefix(c, code(Some(m)));
        let tips = steps.run(|v, _| {
            v.scan(&p, &key::prefix_end(&p), usize::MAX)?
                .into_iter()
                .map(|(k, _)| {
                    let mut at = p.len();
                    let pos = get_u64(&k, &mut at).ok_or_else(|| bad("a tip order key"))?;
                    Ok((
                        pos,
                        get_u64(&k, &mut at).ok_or_else(|| bad("a tip order key"))?,
                    ))
                })
                .collect::<Result<Vec<_>, StoreError>>()
        })?;
        for (pos, t) in tips {
            steps.run(|v, o| drop_tip(v, o, c, t))?;
            steps.run(|v, o| add_tip(v, o, c, t, code(parent), pos))?;
        }
    }
    steps.finish(out);
    Ok(())
}

/// A chat is gone: its place and its tips go with it.
pub fn chat_gone(view: &View, out: &mut Out, c: Convo) -> Result<(), StoreError> {
    if let Some((at, pos)) = at_of(view, c)? {
        out.del(chat_key(TIP_AT, c));
        if let Some(m) = at {
            out.del(by_key(TIP_AT_BY, m, c));
            entry_del(out, c, pos, AT, 0);
        }
    }
    let tp = chat_key(TIP, c);
    for (k, v) in view.scan(&tp, &key::prefix_end(&tp), usize::MAX)? {
        let mut at = tp.len();
        let m = get_u64(&k, &mut at).ok_or_else(|| bad("a tip key"))?;
        let [split, pos] = parse_varints::<2>(&v)?;
        out.del(order_key(c, split, pos, m));
        out.del(by_key(TIP_BY, m, c));
        out.del(k);
    }
    let gp = chat_key(TIP_GROUP, c);
    for (k, v) in view.scan(&gp, &key::prefix_end(&gp), usize::MAX)? {
        let mut at = gp.len();
        let split = get_u64(&k, &mut at).ok_or_else(|| bad("a tip group key"))?;
        let [latest, _] = parse_varints::<2>(&v)?;
        entry_del(out, c, latest, GROUP, split);
        if let Some(s) = uncode(split) {
            out.del(by_key(TIP_SPLIT_BY, s, c));
        }
        out.del(k);
    }
    Ok(())
}

/// A session is gone, with its own conversations.
pub fn session_gone(view: &View, out: &mut Out, s: u64) -> Result<(), StoreError> {
    let mut p = key::of(TIP_AT);
    put_u64(&mut p, 1);
    put_u64(&mut p, s);
    for (k, _) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        let mut at = key::of(TIP_AT).len();
        let c = get_chat(&k, &mut at).ok_or_else(|| bad("a recent history key"))?;
        chat_gone(view, out, c)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entry {
    /// Where a chat is now.
    At { chat: Convo, at: u64, activity: u64 },
    /// A group: its latest tip, the activity it got that at, and how many tips it has.
    Group {
        chat: Convo,
        split: Option<u64>,
        latest: u64,
        activity: u64,
        tips: u64,
    },
}

fn entry_of(view: &View, c: Convo, kind: u64, split: u64) -> Result<Option<Entry>, StoreError> {
    if kind == AT {
        return Ok(at_of(view, c)?.and_then(|(at, activity)| {
            at.map(|at| Entry::At {
                chat: c,
                at,
                activity,
            })
        }));
    }
    let Some([_, tips]) = get_vals::<2>(view, &group_key(c, split))? else {
        return Ok(None);
    };
    let p = order_prefix(c, split);
    let Some((k, _)) = view
        .scan_vals_rev(&p, &key::prefix_end(&p), 1)?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    let mut at = p.len();
    let activity = get_u64(&k, &mut at).ok_or_else(|| bad("a tip order key"))?;
    let latest = get_u64(&k, &mut at).ok_or_else(|| bad("a tip order key"))?;
    Ok(Some(Entry::Group {
        chat: c,
        split: uncode(split),
        latest,
        activity,
        tips,
    }))
}

/// A page of entries, the latest activity first: one chat's, or with `chat` none every chat's. Each comes with the
/// cursor to read the entries after it from (`before`).
pub fn entries(
    view: &View,
    chat: Option<Convo>,
    before: Option<&[u8]>,
    limit: usize,
) -> Result<Vec<(Vec<u8>, Entry)>, StoreError> {
    let p = match chat {
        Some(c) => chat_key(TIP_RECENT, c),
        None => key::of(TIP_ALL),
    };
    let end = match before {
        Some(b) if b.starts_with(&p) && b.len() > p.len() => b.to_vec(),
        Some(_) => {
            return Err(StoreError::Refused(
                "a recent history cursor of another list".into(),
            ));
        }
        None => key::prefix_end(&p),
    };
    let mut out = Vec::new();
    for (k, _) in view.scan_vals_rev(&p, &end, limit)? {
        let mut at = p.len();
        let c = match chat {
            Some(c) => {
                get_u64(&k, &mut at).ok_or_else(|| bad("a recent history key"))?;
                c
            }
            None => {
                get_u64(&k, &mut at).ok_or_else(|| bad("a recent history key"))?;
                get_chat(&k, &mut at).ok_or_else(|| bad("a recent history key"))?
            }
        };
        let kind = get_u64(&k, &mut at).ok_or_else(|| bad("a recent history key"))?;
        let split = get_u64(&k, &mut at).ok_or_else(|| bad("a recent history key"))?;
        if let Some(e) = entry_of(view, c, kind, split)? {
            out.push((k, e));
        }
    }
    Ok(out)
}

/// A page of a group's tips, the latest activity first, each with its activity and the cursor to read the tips after
/// it from.
pub fn group_tips(
    view: &View,
    chat: Convo,
    split: Option<u64>,
    before: Option<&[u8]>,
    limit: usize,
) -> Result<Vec<(Vec<u8>, u64, u64)>, StoreError> {
    let p = order_prefix(chat, code(split));
    let end = match before {
        Some(b) if b.starts_with(&p) && b.len() > p.len() => b.to_vec(),
        Some(_) => return Err(StoreError::Refused("a tip cursor of another group".into())),
        None => key::prefix_end(&p),
    };
    view.scan_vals_rev(&p, &end, limit)?
        .into_iter()
        .map(|(k, _)| {
            let mut at = p.len();
            let pos = get_u64(&k, &mut at).ok_or_else(|| bad("a tip order key"))?;
            let m = get_u64(&k, &mut at).ok_or_else(|| bad("a tip order key"))?;
            Ok((k, m, pos))
        })
        .collect()
}

const CLEAR: u8 = 0;
const REPLAY: u8 = 1;
const SETTLE: u8 = 2;

fn state(phase: u8, k: &[u8]) -> Vec<u8> {
    let mut s = vec![phase];
    s.extend_from_slice(k);
    s
}

/// The first key after `k`.
fn after(k: &[u8]) -> Vec<u8> {
    let mut a = k.to_vec();
    a.push(0);
    a
}

/// One step of the conversion that builds recent history from the moves sessions kept from before it was recorded:
/// it clears it, replays every session's moves in their order, then puts each chat where its session is. Each move
/// counts towards its session's current chat in its tree; a step does at most `batch` keys or moves. `from`: the
/// state the step before returned; none to start. Returns the state to go on from, none when done.
pub fn conversion_step(
    view: &View,
    out: &mut Out,
    from: Option<&[u8]>,
    batch: usize,
) -> Result<Option<Vec<u8>>, StoreError> {
    let (phase, cursor) = match from {
        None => (CLEAR, key::of(*SPACES.start())),
        Some([p, rest @ ..]) if *p <= SETTLE => (*p, rest.to_vec()),
        Some(_) => {
            return Err(StoreError::Refused(
                "not a recent history conversion state".into(),
            ));
        }
    };
    match phase {
        CLEAR => {
            let end = key::of(SPACES.end() + 1);
            let found = view.scan(&cursor, &end, batch)?;
            let full = found.len() == batch;
            let last = found.last().map(|(k, _)| k.clone());
            for (k, _) in found {
                out.del(k);
            }
            Ok(Some(match (full, last) {
                (true, Some(k)) => state(CLEAR, &after(&k)),
                _ => state(REPLAY, &key::of(sessions::HISTORY)),
            }))
        }
        REPLAY => {
            let hp = key::of(sessions::HISTORY);
            let found = view.scan(&cursor, &key::prefix_end(&hp), batch)?;
            let full = found.len() == batch;
            let mut steps = Steps::new(view);
            let mut last = None;
            for (k, v) in found {
                let mut at = hp.len();
                let s = get_u64(&k, &mut at).ok_or_else(|| bad("a history key"))?;
                let [t, gone, rp, _] = parse_varints::<4>(&v)?;
                last = Some(k);
                if gone == 1 || !chat::is_session(view, s)? {
                    continue;
                }
                let (tree, to, pos) = match sessions::Target::of(t) {
                    sessions::Target::Message(m) => {
                        let Some(l) = chat::message_loc(view, m)? else {
                            continue;
                        };
                        (
                            sessions::tree_of(view, m)?,
                            Some(m),
                            rp.checked_sub(1).unwrap_or(l.pos),
                        )
                    }
                    sessions::Target::Root(tree) => {
                        let Some(pos) = rp.checked_sub(1) else {
                            continue;
                        };
                        (tree, None, pos)
                    }
                };
                let c = chat_of(view, s, tree)?;
                move_chat(&mut steps, c, tree, to, None, pos)?;
            }
            steps.finish(out);
            Ok(Some(match (full, last) {
                (true, Some(k)) => state(REPLAY, &after(&k)),
                _ => state(SETTLE, &key::of(sessions::SESSION_TREE)),
            }))
        }
        _ => {
            let tp = key::of(sessions::SESSION_TREE);
            let found = view.scan(&cursor, &key::prefix_end(&tp), batch)?;
            let full = found.len() == batch;
            let mut steps = Steps::new(view);
            let mut last = None;
            for (k, v) in found {
                let mut at = tp.len();
                let s = get_u64(&k, &mut at).ok_or_else(|| bad("a session tree key"))?;
                let tree = get_u64(&k, &mut at).ok_or_else(|| bad("a session tree key"))?;
                last = Some(k);
                let (Some(m), _) = sessions::parse_session_tree(&v)? else {
                    continue;
                };
                let c = chat_of(view, s, tree)?;
                let Some((now, pos)) = steps.run(|v, _| at_of(v, c))? else {
                    continue;
                };
                if now != Some(m) {
                    move_chat(&mut steps, c, tree, Some(m), None, pos)?;
                }
            }
            steps.finish(out);
            Ok(match (full, last) {
                (true, Some(k)) => Some(state(SETTLE, &after(&k))),
                _ => None,
            })
        }
    }
}
