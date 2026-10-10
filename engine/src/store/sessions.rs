//! Sessions, fork choices and depths (`.plans/2026-10-03-storage-build-path.md` 5b, design 4.1): what follows from
//! the records that move a session's pointer (`pointerMove`, `pointerRoot`, an append made through a session), the records that
//! choose a reply at a fork (`forkSelection`, the same appends), and the moves and deletes of messages.
//!
//! A pointer is a message, or a tree's root (no message: the tree shows its card's greeting, as a new chat does).
//! In entries it is the message's id plus one, 0 for the root.

use std::collections::BTreeMap;

use super::StoreError;
use super::chat::{self, APPEND_OWNER, children_prefix, message_loc, parent_of, require_message};
use super::derive::{Layer, Loc, Out, View};
use super::kinds::{dead, id, key, parse_varints, varints};
use super::library::counter;
use crate::keyspace::val::{Val, get_bytes, get_u64, put_bytes, put_u64};
use crate::log::format::Record;

// ---- keys ----

/// Per session: `[tree, pointer]`.
pub const SESSION_PTR: u64 = 120;
/// Per (message, session): the session's pointer is at the message.
pub const SESSIONS_AT: u64 = 121;
/// Per (session, tree): `[pointer]`, the session's last position there.
pub const SESSION_TREE: u64 = 122;
/// Per (user, tree): `[session, pointer]`, the user's last move there and the session it was made through.
pub const USER_TREE: u64 = 123;
/// Per (message, which, a, b): a remembered position names the message: which 0 is (session a, tree b), 1 is
/// (user a, tree b).
pub const REMEMBERED_AT: u64 = 124;
/// Per (user, tree, position in the log, session): the user's sessions in the tree by their last move there; per
/// (user, tree, session): that position; per (session, user, tree): the session has an entry there.
pub const USER_TREE_ORDER: u64 = 125;
pub const USER_TREE_LAST: u64 = 126;
pub const SESSION_USERS: u64 = 127;
/// Per (session, n): the n-th entry of its history, `[target, gone, record position + 1 (0: an append's), record
/// length]`, the target a message's id times two, or a tree's id times two plus one for its root; per session: how
/// many (a maximum); per (message, session, n): an entry names the message; per record position: `[session, n]` for
/// a `pointerMove`'s or `pointerRoot`'s entry.
pub const HISTORY: u64 = 128;
pub const HISTORY_N: u64 = 129;
pub const HISTORY_BY: u64 = 130;
pub const HISTORY_AT: u64 = 131;
/// Per (position in the log, session): every session by its last pointer move; per session: that position.
pub const RECENT: u64 = 132;
pub const RECENT_AT: u64 = 133;
/// Per (tree, position in the log, session): the tree's sessions by their last meaningful activity there; per
/// (session, tree): that position.
pub const TREE_ACTIVITY: u64 = 134;
pub const TREE_ACTIVITY_AT: u64 = 135;
/// Fork choices, `[reply, record position + 1 (0: an append's), record length]`: per (session, fork), per (user,
/// fork), per fork (the last anyone made). Per (reply, choice key): a choice names the reply.
pub const FORK_SESSION: u64 = 136;
pub const FORK_USER: u64 = 137;
pub const FORK_ANY: u64 = 138;
pub const CHOSEN: u64 = 139;
/// Per message: its depth (an opening is 1).
pub const DEPTH: u64 = 140;
/// Per move (its record's position): `[tree, moved message, next message to recompute + 1 (0: done)]`; per tree:
/// how many are under way (a counter); per (message, move): the move's next message is that message.
pub const DEPTH_PENDING: u64 = 141;
pub const DEPTH_TREE: u64 = 142;
pub const DEPTH_CURSOR: u64 = 143;
/// Per (message, bookmark): a bookmark was created at the message.
pub const BRANCH_FROM: u64 = 144;

/// Messages a depth slice recomputes.
pub const DEPTH_SLICE: usize = 256;

fn bad(what: &str) -> StoreError {
    StoreError::Entry(format!("{what} doesn't decode"))
}

fn ptr(m: Option<u64>) -> u64 {
    m.map_or(0, |m| m + 1)
}

fn unptr(p: u64) -> Option<u64> {
    p.checked_sub(1)
}

/// Where a history entry moved the pointer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Message(u64),
    Root(u64),
}

impl Target {
    fn code(self) -> u64 {
        match self {
            Target::Message(m) => m << 1,
            Target::Root(t) => (t << 1) | 1,
        }
    }

    fn of(code: u64) -> Target {
        if code & 1 == 0 {
            Target::Message(code >> 1)
        } else {
            Target::Root(code >> 1)
        }
    }
}

fn get_vals<const N: usize>(view: &View, k: &[u8]) -> Result<Option<[u64; N]>, StoreError> {
    view.get(k)?.map(|b| parse_varints::<N>(&b)).transpose()
}

/// A fork: a message's replies, or the messages opening a tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Fork {
    Message(u64),
    Root(u64),
}

impl Fork {
    fn put(self, k: &mut Vec<u8>) {
        match self {
            Fork::Message(m) => {
                put_u64(k, 0);
                put_u64(k, m);
            }
            Fork::Root(t) => {
                put_u64(k, 1);
                put_u64(k, t);
            }
        }
    }

    fn prefix(self, tree: u64) -> Vec<u8> {
        match self {
            Fork::Message(m) => children_prefix(Some(m), tree),
            Fork::Root(t) => children_prefix(None, t),
        }
    }

    /// The fork a message is a reply at.
    pub fn of(view: &View, m: u64) -> Result<(Fork, u64), StoreError> {
        let (_, r) = require_message(view, m)?;
        let tree = id(&r, APPEND_OWNER);
        Ok((
            match parent_of(view, m, &r)? {
                Some(p) => Fork::Message(p),
                None => Fork::Root(tree),
            },
            tree,
        ))
    }
}

pub fn fork_key(structure: u64, who: Option<u64>, f: Fork) -> Vec<u8> {
    let mut k = match who {
        Some(w) => key::id(structure, w),
        None => key::of(structure),
    };
    f.put(&mut k);
    k
}

/// The tree a message is in.
pub fn tree_of(view: &View, m: u64) -> Result<u64, StoreError> {
    Ok(id(&require_message(view, m)?.1, APPEND_OWNER))
}

// ---- reads ----

/// A session's pointer: its tree and the message (None: the tree's root).
pub fn session_pointer(view: &View, s: u64) -> Result<Option<(u64, Option<u64>)>, StoreError> {
    Ok(get_vals::<2>(view, &key::id(SESSION_PTR, s))?.map(|[t, p]| (t, unptr(p))))
}

/// The session's last position in the tree (None outside: never there; Some(None): its root).
pub fn session_in_tree(view: &View, s: u64, tree: u64) -> Result<Option<Option<u64>>, StoreError> {
    Ok(get_vals::<1>(view, &key::ids(SESSION_TREE, s, tree))?.map(|[p]| unptr(p)))
}

/// The user's last move in the tree: the session it was made through and where.
pub fn user_in_tree(
    view: &View,
    u: u64,
    tree: u64,
) -> Result<Option<(u64, Option<u64>)>, StoreError> {
    Ok(get_vals::<2>(view, &key::ids(USER_TREE, u, tree))?.map(|[s, p]| (s, unptr(p))))
}

/// A message's depth (an opening is 1).
pub fn depth(view: &View, m: u64) -> Result<Option<u64>, StoreError> {
    Ok(get_vals::<1>(view, &key::id(DEPTH, m))?.map(|[d]| d))
}

/// Whether a depth rewrite is under way in the tree (its depths are estimates meanwhile).
pub fn depths_pending(view: &View, tree: u64) -> Result<bool, StoreError> {
    Ok(counter(view, &key::id(DEPTH_TREE, tree))? > 0)
}

/// The message count of a position (its message's depth, 0 at a tree's root), and whether it is an estimate (a
/// depth rewrite is under way in the tree).
pub fn message_count(view: &View, tree: u64, at: Option<u64>) -> Result<(u64, bool), StoreError> {
    let n = match at {
        Some(m) => depth(view, m)?.unwrap_or(0),
        None => 0,
    };
    Ok((n, depths_pending(view, tree)?))
}

/// Whether `reply` is a reply at `f` now.
fn is_reply_at(view: &View, reply: u64, f: Fork) -> Result<bool, StoreError> {
    let Some(l) = message_loc(view, reply)? else {
        return Ok(false);
    };
    let (r, _) = view.record(l.pos)?;
    Ok(match (f, parent_of(view, reply, &r)?) {
        (Fork::Message(m), Some(p)) => m == p,
        (Fork::Root(t), None) => id(&r, APPEND_OWNER) == t,
        _ => false,
    })
}

/// The reply followed at a fork: this session's choice, else this user's from any session, else the last choice
/// anyone made there, else the newest reply (design 4.1). None when the fork has no reply.
pub fn followed(
    view: &View,
    s: Option<u64>,
    u: Option<u64>,
    f: Fork,
    tree: u64,
) -> Result<Option<u64>, StoreError> {
    let tiers = [
        s.map(|s| fork_key(FORK_SESSION, Some(s), f)),
        u.map(|u| fork_key(FORK_USER, Some(u), f)),
        Some(fork_key(FORK_ANY, None, f)),
    ];
    for k in tiers.into_iter().flatten() {
        if let Some([reply, _, _]) = get_vals::<3>(view, &k)?
            && is_reply_at(view, reply, f)?
        {
            return Ok(Some(reply));
        }
    }
    let p = f.prefix(tree);
    match view
        .scan_vals_rev(&p, &crate::store::kinds::key::prefix_end(&p), 1)?
        .first()
    {
        Some((k, _)) => Ok(Some(chat::child_of_key(k, p.len())?)),
        None => Ok(None),
    }
}

/// The messages below `from` (a message, or the tree's root) along the followed replies, to the end.
pub fn path_below(
    view: &View,
    s: Option<u64>,
    u: Option<u64>,
    tree: u64,
    from: Option<u64>,
) -> Result<Vec<u64>, StoreError> {
    let mut out = Vec::new();
    let mut f = match from {
        Some(m) => Fork::Message(m),
        None => Fork::Root(tree),
    };
    while let Some(next) = followed(view, s, u, f, tree)? {
        out.push(next);
        f = Fork::Message(next);
    }
    Ok(out)
}

/// Where a session lands entering a tree: its own last position there, else the user's last there, else the end
/// of the tree's path from its root (design 4.1). None: the tree's root (no message).
pub fn landing(
    view: &View,
    s: Option<u64>,
    u: Option<u64>,
    tree: u64,
) -> Result<Option<u64>, StoreError> {
    if let Some(s) = s
        && let Some(p) = session_in_tree(view, s, tree)?
    {
        return Ok(p);
    }
    if let Some(u) = u
        && let Some((_, p)) = user_in_tree(view, u, tree)?
    {
        return Ok(p);
    }
    Ok(path_below(view, s, u, tree, None)?.last().copied())
}

/// The history entries of a session from the n-th on: `(n, target, gone)`.
pub fn history(
    view: &View,
    s: u64,
    from: u64,
    limit: usize,
) -> Result<Vec<(u64, Target, bool)>, StoreError> {
    let p = key::id(HISTORY, s);
    let mut start = p.clone();
    put_u64(&mut start, from);
    view.scan(&start, &key::prefix_end(&p), limit)?
        .into_iter()
        .map(|(k, v)| {
            let mut at = p.len();
            let n = get_u64(&k, &mut at).ok_or_else(|| bad("a history key"))?;
            let [t, gone, _, _] = parse_varints::<4>(&v)?;
            Ok((n, Target::of(t), gone == 1))
        })
        .collect()
}

/// Sessions by their last pointer move, the newest first, from before `before` (a log position).
pub fn recent(
    view: &View,
    before: Option<u64>,
    limit: usize,
) -> Result<Vec<(u64, u64)>, StoreError> {
    let p = key::of(RECENT);
    let end = match before {
        Some(b) => key::id(RECENT, b),
        None => key::prefix_end(&p),
    };
    view.scan_vals_rev(&p, &end, limit)?
        .into_iter()
        .map(|(k, _)| {
            let mut at = p.len();
            let pos = get_u64(&k, &mut at).ok_or_else(|| bad("a recent key"))?;
            Ok((
                pos,
                get_u64(&k, &mut at).ok_or_else(|| bad("a recent key"))?,
            ))
        })
        .collect()
}

/// A tree's sessions by their last meaningful activity there, the newest first, from before `before`.
pub fn in_tree(
    view: &View,
    tree: u64,
    before: Option<u64>,
    limit: usize,
) -> Result<Vec<(u64, u64)>, StoreError> {
    let p = key::id(TREE_ACTIVITY, tree);
    let end = match before {
        Some(b) => key::ids(TREE_ACTIVITY, tree, b),
        None => key::prefix_end(&p),
    };
    view.scan_vals_rev(&p, &end, limit)?
        .into_iter()
        .map(|(k, _)| {
            let mut at = p.len();
            let pos = get_u64(&k, &mut at).ok_or_else(|| bad("an activity key"))?;
            Ok((
                pos,
                get_u64(&k, &mut at).ok_or_else(|| bad("an activity key"))?,
            ))
        })
        .collect()
}

/// The bookmarks created at a message, in the order they were created (their ids).
pub fn branches_from(view: &View, m: u64) -> Result<Vec<u64>, StoreError> {
    let p = key::id(BRANCH_FROM, m);
    view.scan(&p, &key::prefix_end(&p), usize::MAX)?
        .into_iter()
        .map(|(k, _)| {
            let mut at = p.len();
            get_u64(&k, &mut at).ok_or_else(|| bad("a branch key"))
        })
        .collect()
}

// ---- writes ----

/// A remembered (session, tree) position, with its index.
fn set_session_tree(
    view: &View,
    out: &mut Out,
    s: u64,
    tree: u64,
    p: Option<u64>,
) -> Result<(), StoreError> {
    if let Some(Some(old)) = session_in_tree(view, s, tree)? {
        out.del(remembered_key(old, 0, s, tree));
    }
    out.put(key::ids(SESSION_TREE, s, tree), varints(&[ptr(p)]));
    if let Some(m) = p {
        out.put(remembered_key(m, 0, s, tree), Vec::new());
    }
    Ok(())
}

fn set_user_tree(
    view: &View,
    out: &mut Out,
    u: u64,
    tree: u64,
    s: u64,
    p: Option<u64>,
) -> Result<(), StoreError> {
    if let Some((_, Some(old))) = user_in_tree(view, u, tree)? {
        out.del(remembered_key(old, 1, u, tree));
    }
    out.put(key::ids(USER_TREE, u, tree), varints(&[s, ptr(p)]));
    if let Some(m) = p {
        out.put(remembered_key(m, 1, u, tree), Vec::new());
    }
    Ok(())
}

fn remembered_key(m: u64, which: u64, a: u64, b: u64) -> Vec<u8> {
    let mut k = key::ids(REMEMBERED_AT, m, which);
    put_u64(&mut k, a);
    put_u64(&mut k, b);
    k
}

fn set_pointer(
    view: &View,
    out: &mut Out,
    s: u64,
    tree: u64,
    p: Option<u64>,
) -> Result<(), StoreError> {
    if let Some((_, Some(old))) = session_pointer(view, s)? {
        out.del(key::ids(SESSIONS_AT, old, s));
    }
    out.put(key::id(SESSION_PTR, s), varints(&[tree, ptr(p)]));
    if let Some(m) = p {
        out.put(key::ids(SESSIONS_AT, m, s), Vec::new());
    }
    Ok(())
}

/// The session's last meaningful activity in the tree is at `pos`.
pub fn activity(view: &View, out: &mut Out, s: u64, tree: u64, pos: u64) -> Result<(), StoreError> {
    let at = key::ids(TREE_ACTIVITY_AT, s, tree);
    if let Some([old]) = get_vals::<1>(view, &at)? {
        out.del(activity_key(tree, old, s));
    }
    out.put(activity_key(tree, pos, s), Vec::new());
    out.put(at, varints(&[pos]));
    Ok(())
}

fn activity_key(tree: u64, pos: u64, s: u64) -> Vec<u8> {
    let mut k = key::ids(TREE_ACTIVITY, tree, pos);
    put_u64(&mut k, s);
    k
}

/// A record naming a session and a user is theirs: the session must be one (it has a key) and the user mapped.
pub fn check_actor(view: &View, s: Option<u64>, u: Option<u64>) -> Result<(), StoreError> {
    if let Some(s) = s
        && !chat::is_session(view, s)?
    {
        return Err(StoreError::Refused(format!("no session {s}")));
    }
    if let Some(u) = u
        && view.get(&chat::key_of_key(chat::KEYED_USER, u))?.is_none()
    {
        return Err(StoreError::Refused(format!("no user {u}")));
    }
    Ok(())
}

/// The session's pointer moves to `target` (in `tree`; None: its root) by `u`, through the record at `at` (`owned`:
/// a `pointerMove` or `pointerRoot`, whose history entry points at it). `meaningful`: the move counts as activity in the tree
/// whether or not it enters it.
#[allow(clippy::too_many_arguments)]
pub fn moved(
    view: &View,
    out: &mut Out,
    s: u64,
    u: u64,
    tree: u64,
    target: Option<u64>,
    at: Loc,
    owned: bool,
    meaningful: bool,
) -> Result<(), StoreError> {
    let entering = session_pointer(view, s)?.map(|(t, _)| t) != Some(tree);
    set_pointer(view, out, s, tree, target)?;
    let n = get_vals::<1>(view, &key::id(HISTORY_N, s))?.map_or(1, |[n]| n + 1);
    out.put(key::id(HISTORY_N, s), varints(&[n]));
    let (rp, rl) = if owned { (at.pos + 1, at.len) } else { (0, 0) };
    let code = match target {
        Some(m) => Target::Message(m),
        None => Target::Root(tree),
    }
    .code();
    out.put(key::ids(HISTORY, s, n), varints(&[code, 0, rp, rl]));
    if let Some(m) = target {
        let mut hb = key::ids(HISTORY_BY, m, s);
        put_u64(&mut hb, n);
        out.put(hb, Vec::new());
    }
    if owned {
        out.put(key::id(HISTORY_AT, at.pos), varints(&[s, n]));
    }
    if let Some([old]) = get_vals::<1>(view, &key::id(RECENT_AT, s))? {
        out.del(key::ids(RECENT, old, s));
    }
    out.put(key::ids(RECENT, at.pos, s), Vec::new());
    out.put(key::id(RECENT_AT, s), varints(&[at.pos]));
    set_session_tree(view, out, s, tree, target)?;
    set_user_tree(view, out, u, tree, s, target)?;
    let mut last = key::ids(USER_TREE_LAST, u, tree);
    put_u64(&mut last, s);
    if let Some([old]) = get_vals::<1>(view, &last)? {
        out.del(user_tree_order_key(u, tree, old, s));
    }
    out.put(user_tree_order_key(u, tree, at.pos, s), Vec::new());
    out.put(last, varints(&[at.pos]));
    let mut su = key::ids(SESSION_USERS, s, u);
    put_u64(&mut su, tree);
    out.put(su, Vec::new());
    if meaningful || !entering {
        activity(view, out, s, tree, at.pos)?;
    }
    Ok(())
}

fn user_tree_order_key(u: u64, tree: u64, pos: u64, s: u64) -> Vec<u8> {
    let mut k = key::ids(USER_TREE_ORDER, u, tree);
    put_u64(&mut k, pos);
    put_u64(&mut k, s);
    k
}

/// The three choices (session, user, anyone) at `f` become `reply`, by the record at `at` (`owned`: a
/// `forkSelection`, which the choices point at).
#[allow(clippy::too_many_arguments)]
pub fn chosen(
    view: &View,
    out: &mut Out,
    s: u64,
    u: u64,
    f: Fork,
    reply: u64,
    at: Loc,
    owned: bool,
) -> Result<(), StoreError> {
    let keys = [
        fork_key(FORK_SESSION, Some(s), f),
        fork_key(FORK_USER, Some(u), f),
        fork_key(FORK_ANY, None, f),
    ];
    let (rp, rl) = if owned { (at.pos + 1, at.len) } else { (0, 0) };
    let mut replaced = Vec::new();
    for k in &keys {
        if let Some([old, op, ol]) = get_vals::<3>(view, k)? {
            out.del(chosen_key(old, k));
            if op > 0 {
                replaced.push(Loc {
                    pos: op - 1,
                    len: ol,
                });
            }
        }
        out.put(k.clone(), varints(&[reply, rp, rl]));
        out.put(chosen_key(reply, k), Vec::new());
    }
    for l in replaced {
        if !still_chosen(view, l, &keys)? {
            dead(out, l);
        }
    }
    Ok(())
}

fn chosen_key(reply: u64, k: &[u8]) -> Vec<u8> {
    let mut c = key::id(CHOSEN, reply);
    put_bytes(&mut c, k);
    c
}

/// Whether a `forkSelection` at `l` is still a choice under one of its keys other than `gone` (keys being
/// replaced or removed now).
fn still_chosen(view: &View, l: Loc, gone: &[Vec<u8>]) -> Result<bool, StoreError> {
    for k in selection_keys(&view.record(l.pos)?.0, view)? {
        if gone.contains(&k) {
            continue;
        }
        if get_vals::<3>(view, &k)?.is_some_and(|[_, p, _]| p == l.pos + 1) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// A `forkSelection`'s three choice keys (its reply is still a message: a choice of a message that goes goes
/// with it).
fn selection_keys(rec: &Record, view: &View) -> Result<[Vec<u8>; 3], StoreError> {
    let reply = id(rec, 1);
    let f = match rec.values[0] {
        crate::log::format::Value::Id(m) => Fork::Message(m),
        _ => Fork::Root(tree_of(view, reply)?),
    };
    Ok([
        fork_key(FORK_SESSION, Some(id(rec, 2)), f),
        fork_key(FORK_USER, Some(id(rec, 3)), f),
        fork_key(FORK_ANY, None, f),
    ])
}

/// Whether a `forkSelection` at `pos` is a current choice.
pub fn selection_live(view: &View, rec: &Record, pos: u64) -> Result<bool, StoreError> {
    if message_loc(view, id(rec, 1))?.is_none() {
        return Ok(false);
    }
    for k in selection_keys(rec, view)? {
        if get_vals::<3>(view, &k)?.is_some_and(|[_, p, _]| p == pos + 1) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Points a `forkSelection`'s choices at its copy.
pub fn selection_repoint(
    view: &View,
    out: &mut Out,
    rec: &Record,
    from: u64,
    to: Loc,
) -> Result<(), StoreError> {
    if message_loc(view, id(rec, 1))?.is_none() {
        return Ok(());
    }
    for k in selection_keys(rec, view)? {
        if let Some([reply, p, _]) = get_vals::<3>(view, &k)?
            && p == from + 1
        {
            out.put(k, varints(&[reply, to.pos + 1, to.len]));
        }
    }
    Ok(())
}

/// Whether the history entry of a `pointerMove` at `pos` is kept, and its key.
pub fn history_entry(view: &View, pos: u64) -> Result<Option<Vec<u8>>, StoreError> {
    Ok(get_vals::<2>(view, &key::id(HISTORY_AT, pos))?.map(|[s, n]| key::ids(HISTORY, s, n)))
}

/// Points a `pointerMove`'s history entry at its copy.
pub fn history_repoint(view: &View, out: &mut Out, from: u64, to: Loc) -> Result<(), StoreError> {
    let Some([s, n]) = get_vals::<2>(view, &key::id(HISTORY_AT, from))? else {
        return Ok(());
    };
    let k = key::ids(HISTORY, s, n);
    if let Some([t, gone, _, _]) = get_vals::<4>(view, &k)? {
        out.put(k, varints(&[t, gone, to.pos + 1, to.len]));
    }
    out.del(key::id(HISTORY_AT, from));
    out.put(key::id(HISTORY_AT, to.pos), varints(&[s, n]));
    Ok(())
}

// ---- a message goes ----

/// What a message's going changes here: pointers and remembered positions at it move to its parent (an opening's
/// to the tree's newest other opening, else the tree's root), history entries naming it are marked gone, choices
/// of it go, and its depth, branches and any depth rewrite's place at it.
pub fn message_gone(
    view: &View,
    out: &mut Out,
    m: u64,
    parent: Option<u64>,
    tree: u64,
) -> Result<(), StoreError> {
    let to = match parent {
        Some(p) => Some(p),
        None => {
            let p = children_prefix(None, tree);
            view.scan_vals_rev(&p, &key::prefix_end(&p), 2)?
                .iter()
                .map(|(k, _)| chat::child_of_key(k, p.len()))
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .find(|o| *o != m)
        }
    };
    let sp = key::id(SESSIONS_AT, m);
    for (k, _) in view.scan(&sp, &key::prefix_end(&sp), usize::MAX)? {
        let mut at = sp.len();
        let s = get_u64(&k, &mut at).ok_or_else(|| bad("a pointer index key"))?;
        set_pointer(view, out, s, tree, to)?;
    }
    let rp = key::id(REMEMBERED_AT, m);
    for (k, _) in view.scan(&rp, &key::prefix_end(&rp), usize::MAX)? {
        let mut at = rp.len();
        let which = get_u64(&k, &mut at).ok_or_else(|| bad("a remembered key"))?;
        let a = get_u64(&k, &mut at).ok_or_else(|| bad("a remembered key"))?;
        let t = get_u64(&k, &mut at).ok_or_else(|| bad("a remembered key"))?;
        if which == 0 {
            set_session_tree(view, out, a, t, to)?;
        } else if let Some((s, _)) = user_in_tree(view, a, t)? {
            set_user_tree(view, out, a, t, s, to)?;
        }
    }
    let hp = key::id(HISTORY_BY, m);
    for (k, _) in view.scan(&hp, &key::prefix_end(&hp), usize::MAX)? {
        let mut at = hp.len();
        let s = get_u64(&k, &mut at).ok_or_else(|| bad("a history index key"))?;
        let n = get_u64(&k, &mut at).ok_or_else(|| bad("a history index key"))?;
        let hk = key::ids(HISTORY, s, n);
        if let Some([t, _, rp, rl]) = get_vals::<4>(view, &hk)? {
            out.put(hk, varints(&[t, 1, rp, rl]));
        }
        out.del(k);
    }
    // Every choice of `m` goes, so a selection of it is chosen nowhere any more.
    let cp = key::id(CHOSEN, m);
    let mut owned = Vec::new();
    for (k, _) in view.scan(&cp, &key::prefix_end(&cp), usize::MAX)? {
        let mut at = cp.len();
        let ck = get_bytes(&k, &mut at).ok_or_else(|| bad("a choice index key"))?;
        if let Some([_, p, l]) = get_vals::<3>(view, &ck)?
            && p > 0
        {
            owned.push(Loc { pos: p - 1, len: l });
        }
        out.del(ck);
        out.del(k);
    }
    owned.sort_by_key(|l| l.pos);
    owned.dedup();
    for l in owned {
        dead(out, l);
    }
    out.del(key::id(DEPTH, m));
    let bp = key::id(BRANCH_FROM, m);
    for (k, _) in view.scan(&bp, &key::prefix_end(&bp), usize::MAX)? {
        out.del(k);
    }
    let dp = key::id(DEPTH_CURSOR, m);
    for (k, _) in view.scan(&dp, &key::prefix_end(&dp), usize::MAX)? {
        let mut at = dp.len();
        let mv = get_u64(&k, &mut at).ok_or_else(|| bad("a depth cursor key"))?;
        out.del(k);
        let pk = key::id(DEPTH_PENDING, mv);
        if let Some([t, root, _]) = get_vals::<3>(view, &pk)? {
            // `m` replies to nothing, so the walk goes on from the next message after it.
            let next = if m == root {
                None
            } else {
                after_subtree(view, m, root)?
            };
            set_cursor(out, mv, t, root, next);
        }
    }
    Ok(())
}

// ---- a session goes ----

/// A session goes: its pointer, its history, its places in the orders, its remembered positions, its own fork
/// choices (the user's and anyone's stay); its outside key becomes a tombstone (its UUID says it was deleted). A user whose last move
/// in a tree was through it falls back to their most recent other session there, if any.
pub fn session_gone(view: &View, out: &mut Out, s: u64) -> Result<(), StoreError> {
    chat::tombstone_key(view, out, chat::KEYED_SESSION, s)?;
    let fp = key::id(FORK_SESSION, s);
    let mut gone = Vec::new();
    let mut owned = Vec::new();
    for (k, v) in view.scan(&fp, &key::prefix_end(&fp), usize::MAX)? {
        let [reply, p, l] = parse_varints::<3>(&v)?;
        out.del(chosen_key(reply, &k));
        if p > 0 {
            owned.push(Loc { pos: p - 1, len: l });
        }
        out.del(k.clone());
        gone.push(k);
    }
    owned.sort_by_key(|l| l.pos);
    owned.dedup();
    for l in owned {
        if !still_chosen(view, l, &gone)? {
            dead(out, l);
        }
    }
    if let Some((_, Some(m))) = session_pointer(view, s)? {
        out.del(key::ids(SESSIONS_AT, m, s));
    }
    out.del(key::id(SESSION_PTR, s));
    let hp = key::id(HISTORY, s);
    for (k, v) in view.scan(&hp, &key::prefix_end(&hp), usize::MAX)? {
        let mut at = hp.len();
        let n = get_u64(&k, &mut at).ok_or_else(|| bad("a history key"))?;
        let [t, gone, rp, rl] = parse_varints::<4>(&v)?;
        if let (0, Target::Message(m)) = (gone, Target::of(t)) {
            let mut hb = key::ids(HISTORY_BY, m, s);
            put_u64(&mut hb, n);
            out.del(hb);
        }
        if rp > 0 {
            dead(
                out,
                Loc {
                    pos: rp - 1,
                    len: rl,
                },
            );
            out.del(key::id(HISTORY_AT, rp - 1));
        }
        out.del(k);
    }
    out.del(key::id(HISTORY_N, s));
    if let Some([pos]) = get_vals::<1>(view, &key::id(RECENT_AT, s))? {
        out.del(key::ids(RECENT, pos, s));
        out.del(key::id(RECENT_AT, s));
    }
    let tp = key::id(SESSION_TREE, s);
    for (k, v) in view.scan(&tp, &key::prefix_end(&tp), usize::MAX)? {
        let mut at = tp.len();
        let t = get_u64(&k, &mut at).ok_or_else(|| bad("a session tree key"))?;
        let [p] = parse_varints::<1>(&v)?;
        if let Some(m) = unptr(p) {
            out.del(remembered_key(m, 0, s, t));
        }
        out.del(k);
    }
    let ap = key::id(TREE_ACTIVITY_AT, s);
    for (k, v) in view.scan(&ap, &key::prefix_end(&ap), usize::MAX)? {
        let mut at = ap.len();
        let t = get_u64(&k, &mut at).ok_or_else(|| bad("an activity key"))?;
        let [pos] = parse_varints::<1>(&v)?;
        out.del(activity_key(t, pos, s));
        out.del(k);
    }
    let up = key::id(SESSION_USERS, s);
    for (k, _) in view.scan(&up, &key::prefix_end(&up), usize::MAX)? {
        let mut at = up.len();
        let u = get_u64(&k, &mut at).ok_or_else(|| bad("a session user key"))?;
        let t = get_u64(&k, &mut at).ok_or_else(|| bad("a session user key"))?;
        out.del(k);
        let mut last = key::ids(USER_TREE_LAST, u, t);
        put_u64(&mut last, s);
        if let Some([pos]) = get_vals::<1>(view, &last)? {
            out.del(user_tree_order_key(u, t, pos, s));
        }
        out.del(last);
        if user_in_tree(view, u, t)?.is_some_and(|(us, _)| us == s) {
            let op = key::ids(USER_TREE_ORDER, u, t);
            let mut next = None;
            for (ok, _) in view.scan_vals_rev(&op, &key::prefix_end(&op), 2)? {
                let mut at = op.len();
                get_u64(&ok, &mut at).ok_or_else(|| bad("a user tree key"))?;
                let o = get_u64(&ok, &mut at).ok_or_else(|| bad("a user tree key"))?;
                if o != s {
                    next = Some(o);
                    break;
                }
            }
            match next {
                Some(o) => {
                    let p = session_in_tree(view, o, t)?.flatten();
                    set_user_tree(view, out, u, t, o, p)?;
                }
                None => {
                    if let Some((_, Some(m))) = user_in_tree(view, u, t)? {
                        out.del(remembered_key(m, 1, u, t));
                    }
                    out.del(key::ids(USER_TREE, u, t));
                }
            }
        }
    }
    Ok(())
}

// ---- depths ----

/// A new message's depth: its parent's plus one.
pub fn appended(view: &View, out: &mut Out, m: u64, parent: Option<u64>) -> Result<(), StoreError> {
    let d = match parent {
        Some(p) => depth(view, p)?.unwrap_or(0) + 1,
        None => 1,
    };
    out.put(key::id(DEPTH, m), varints(&[d]));
    Ok(())
}

fn set_cursor(out: &mut Out, mv: u64, tree: u64, root: u64, next: Option<u64>) {
    let pk = key::id(DEPTH_PENDING, mv);
    match next {
        Some(n) => {
            out.put(pk, varints(&[tree, root, n + 1]));
            out.put(key::ids(DEPTH_CURSOR, n, mv), Vec::new());
        }
        None => {
            out.del(pk);
            out.add(key::id(DEPTH_TREE, tree), -1);
        }
    }
}

/// A message `m` moved by the record at `pos`: its subtree's depths are recomputed in slices from it on. A walk of
/// another move that would go on at `m` goes on past `m`'s subtree instead (that move's slices no longer reach it;
/// this one's do).
pub fn reparented(
    view: &View,
    out: &mut Out,
    m: u64,
    tree: u64,
    pos: u64,
) -> Result<(), StoreError> {
    let dp = key::id(DEPTH_CURSOR, m);
    for (k, _) in view.scan(&dp, &key::prefix_end(&dp), usize::MAX)? {
        let mut at = dp.len();
        let mv = get_u64(&k, &mut at).ok_or_else(|| bad("a depth cursor key"))?;
        out.del(k);
        if let Some([t, root, _]) = get_vals::<3>(view, &key::id(DEPTH_PENDING, mv))? {
            let next = if m == root {
                None
            } else {
                after_subtree(view, m, root)?
            };
            set_cursor(out, mv, t, root, next);
        }
    }
    out.add(key::id(DEPTH_TREE, tree), 1);
    out.put(key::id(DEPTH_PENDING, pos), varints(&[tree, m, m + 1]));
    out.put(key::ids(DEPTH_CURSOR, m, pos), Vec::new());
    Ok(())
}

/// The message after `m`'s subtree in a walk of `root`'s subtree (replies in order, each before its own replies):
/// the next reply after `m` at its parent, else after its parent, up to `root`. None: the walk is done.
fn after_subtree(view: &View, m: u64, root: u64) -> Result<Option<u64>, StoreError> {
    let mut x = m;
    loop {
        if x == root {
            return Ok(None);
        }
        let (_, r) = require_message(view, x)?;
        let tree = id(&r, APPEND_OWNER);
        let p = parent_of(view, x, &r)?;
        let prefix = children_prefix(p, tree);
        let mut start = chat::child_key(p, tree, chat_time(&r), x);
        start.push(0);
        if let Some((k, _)) = view
            .scan(&start, &key::prefix_end(&prefix), 1)?
            .into_iter()
            .next()
        {
            return Ok(Some(chat::child_of_key(&k, prefix.len())?));
        }
        match p {
            Some(p) => x = p,
            // Left the root's subtree (a message moved away meanwhile): nothing more of it to walk.
            None => return Ok(None),
        }
    }
}

fn chat_time(r: &Record) -> i64 {
    match r.values[chat::APPEND_TIME] {
        crate::log::format::Value::Time(t) => t,
        _ => unreachable!("checked by Record::new"),
    }
}

/// The next message of a walk of `root`'s subtree after `m`: its first reply, else what follows its subtree.
fn walk_next(view: &View, m: u64, root: u64, tree: u64) -> Result<Option<u64>, StoreError> {
    let p = children_prefix(Some(m), tree);
    if let Some((k, _)) = view.scan(&p, &key::prefix_end(&p), 1)?.into_iter().next() {
        return Ok(Some(chat::child_of_key(&k, p.len())?));
    }
    after_subtree(view, m, root)
}

/// One slice of the oldest depth rewrite under way: up to `DEPTH_SLICE` messages, each its parent's depth plus
/// one, in walk order so a parent is done before its replies. Returns whether one was found.
pub fn depth_step(view: &View, out: &mut Out) -> Result<bool, StoreError> {
    let pp = key::of(DEPTH_PENDING);
    let Some((pk, v)) = view.scan(&pp, &key::prefix_end(&pp), 1)?.into_iter().next() else {
        return Ok(false);
    };
    let mut at = pp.len();
    let mv = get_u64(&pk, &mut at).ok_or_else(|| bad("a depth pending key"))?;
    let [tree, root, cur] = parse_varints::<3>(&v)?;
    let mut local: BTreeMap<Vec<u8>, Val> = BTreeMap::new();
    let mut next = unptr(cur);
    if let Some(n) = next {
        local.insert(key::ids(DEPTH_CURSOR, n, mv), Val::Del);
    }
    for _ in 0..DEPTH_SLICE {
        let Some(n) = next else { break };
        let mut layers = vec![Layer::Sorted(&local)];
        layers.extend(view.layers.iter().copied());
        let lv = View {
            layers,
            pending: view.pending.clone(),
            staged: view.staged,
            bulk: view.bulk,
            ks: view.ks,
            snap: view.snap,
            log: view.log,
        };
        let mut o = Out::default();
        if message_loc(&lv, n)?.is_none() {
            next = None;
        } else {
            let (_, r) = require_message(&lv, n)?;
            let d = match parent_of(&lv, n, &r)? {
                Some(p) => depth(&lv, p)?.unwrap_or(0) + 1,
                None => 1,
            };
            if depth(&lv, n)? != Some(d) {
                o.put(key::id(DEPTH, n), varints(&[d]));
            }
            next = walk_next(&lv, n, root, tree)?;
        }
        drop(lv);
        o.apply(&mut local);
    }
    let mut o = Out::default();
    set_cursor(&mut o, mv, tree, root, next);
    o.apply(&mut local);
    out.entries.extend(local);
    Ok(true)
}

/// Every depth rewrite under way (for a store opening with some left).
pub fn any_pending(view: &View) -> Result<bool, StoreError> {
    let pp = key::of(DEPTH_PENDING);
    Ok(!view.scan(&pp, &key::prefix_end(&pp), 1)?.is_empty())
}

/// A bookmark created at `m`.
pub fn branch_created(out: &mut Out, m: u64, b: u64) {
    out.put(key::ids(BRANCH_FROM, m, b), Vec::new());
}

pub fn branch_gone(out: &mut Out, m: u64, b: u64) {
    out.del(key::ids(BRANCH_FROM, m, b));
}
