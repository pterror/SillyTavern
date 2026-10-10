//! Chat reads for the binding (build path 5b): what the JavaScript side assembles upstream's shapes from.
//! Each answers a `Js` value, a plain tree the binding turns into JavaScript.

use super::chat::{self, APPEND_OWNER, children_prefix, message_loc, parent_of};
use super::derive::View;
use super::kinds::{Holder, bytes, key, parse_loc, parse_varints, text_value_of};
use super::library::field_after;
use super::sessions::{self, Fork};
use super::{StoreError, state, stats};
use crate::keyspace::val::{get_u64, max_value};
use crate::log::format::{FieldRef, Value};

/// A value as JavaScript gets it.
#[derive(Debug, Clone, PartialEq)]
pub enum Js {
    Null,
    Bool(bool),
    Num(f64),
    /// A BigInt.
    Big(u64),
    /// A string, from WTF-8.
    Text(Vec<u8>),
    Bytes(Vec<u8>),
    Arr(Vec<Js>),
    Obj(Vec<(&'static str, Js)>),
}

fn opt_big(v: Option<u64>) -> Js {
    v.map_or(Js::Null, Js::Big)
}

fn field_js(f: &FieldRef) -> Js {
    match f {
        FieldRef::Code(c) => Js::Num(*c as f64),
        FieldRef::Key(k) => Js::Text(k.clone()),
    }
}

/// Every message's own values: its append's slots, its values, texts and times, its depth, its itemization's
/// kind, the bookmarks created at it, and its outside key (its id from before the engine), or null.
pub fn messages(view: &View, ids: &[u64]) -> Result<Js, StoreError> {
    let mut out = Vec::with_capacity(ids.len());
    for &m in ids {
        let Some(l) = message_loc(view, m)? else {
            out.push(Js::Null);
            continue;
        };
        let (r, _) = view.record(l.pos)?;
        let h = Holder::Message(m);
        let mut texts = Vec::new();
        let tp = key::id(key::MSG_TEXT, m);
        for (k, _) in view.scan(&tp, &key::prefix_end(&tp), usize::MAX)? {
            let f = field_after(&k, key::MSG_TEXT)?;
            let t = text_value_of(view, h, &f)?.unwrap_or_default();
            texts.push(Js::Obj(vec![
                ("field", field_js(&f)),
                ("text", Js::Text(t)),
            ]));
        }
        let mut values = Vec::new();
        let vp = key::id(key::MSG_VALUE, m);
        for (k, v) in view.scan(&vp, &key::prefix_end(&vp), usize::MAX)? {
            let f = field_after(&k, key::MSG_VALUE)?;
            let (vr, _) = view.record(parse_loc(&v)?.pos)?;
            values.push(Js::Obj(vec![
                ("field", field_js(&f)),
                ("json", Js::Text(bytes(&vr, 2).to_vec())),
            ]));
        }
        let mut times = Vec::new();
        let mp = key::id(key::MSG_TIME, m);
        for (k, v) in view.scan(&mp, &key::prefix_end(&mp), usize::MAX)? {
            let f = field_after(&k, key::MSG_TIME)?;
            let (tr, _) = view.record(parse_loc(&v)?.pos)?;
            let d = match tr.values[2] {
                Value::Int(d) => d,
                _ => unreachable!("checked by Record::new"),
            };
            times.push(Js::Obj(vec![
                ("field", field_js(&f)),
                ("delta", Js::Num(d as f64)),
            ]));
        }
        let itemized = match chat::itemization(view, m)? {
            Some((raw, _)) => Js::Obj(vec![("raw", Js::Bool(raw))]),
            None => Js::Null,
        };
        let opt_id = |i: usize| match r.values[i] {
            Value::Id(v) => Js::Big(v),
            _ => Js::Null,
        };
        let opt_text = |i: usize| match &r.values[i] {
            Value::Text(t) => Js::Text(t.clone()),
            _ => Js::Null,
        };
        let time = match r.values[chat::APPEND_TIME] {
            Value::Time(t) => t,
            _ => unreachable!("checked by Record::new"),
        };
        out.push(Js::Obj(vec![
            ("id", Js::Big(m)),
            ("parent", opt_big(parent_of(view, m, &r)?)),
            ("owner", Js::Big(super::kinds::id(&r, APPEND_OWNER))),
            ("speaker", opt_id(3)),
            ("name", opt_text(4)),
            ("time", Js::Num(time as f64)),
            (
                "flags",
                Js::Num(super::kinds::id(&r, chat::APPEND_FLAGS) as f64),
            ),
            ("session", opt_id(chat::APPEND_SESSION)),
            ("user", Js::Big(super::kinds::id(&r, chat::APPEND_USER))),
            (
                "sendKey",
                match &r.values[chat::APPEND_SEND_KEY] {
                    Value::Bytes(b) => Js::Bytes(b.clone()),
                    _ => Js::Null,
                },
            ),
            ("depth", opt_big(sessions::depth(view, m)?)),
            ("texts", Js::Arr(texts)),
            ("values", Js::Arr(values)),
            ("times", Js::Arr(times)),
            ("itemized", itemized),
            (
                "branches",
                Js::Arr(
                    sessions::branches_from(view, m)?
                        .into_iter()
                        .map(Js::Big)
                        .collect(),
                ),
            ),
            (
                "oldKey",
                chat::key_by_id(view, chat::KEYED_MESSAGE, m)?.map_or(Js::Null, Js::Text),
            ),
        ]));
    }
    Ok(Js::Arr(out))
}

/// The replies of `parent` (None: the messages opening `tree`) in order, from after `after`, at most `limit`.
pub fn children(
    view: &View,
    parent: Option<u64>,
    tree: u64,
    after: Option<u64>,
    limit: usize,
) -> Result<Js, StoreError> {
    let p = children_prefix(parent, tree);
    let start = match after {
        Some(a) => {
            let (_, r) = chat::require_message(view, a)?;
            let t = match r.values[chat::APPEND_TIME] {
                Value::Time(t) => t,
                _ => unreachable!("checked by Record::new"),
            };
            let mut k = chat::child_key(parent, tree, t, a);
            k.push(0);
            k
        }
        None => p.clone(),
    };
    let found = view.scan(&start, &key::prefix_end(&p), limit + 1)?;
    let more = found.len() > limit;
    let ids = found
        .iter()
        .take(limit)
        .map(|(k, _)| chat::child_of_key(k, p.len()).map(Js::Big))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Js::Obj(vec![
        ("ids", Js::Arr(ids)),
        ("more", Js::Bool(more)),
    ]))
}

/// The messages from the tree's root down to `at` (a position shows nothing below it).
pub fn path(view: &View, at: Option<u64>) -> Result<Js, StoreError> {
    let mut above = Vec::new();
    let mut cur = at;
    while let Some(m) = cur {
        above.push(m);
        let (_, r) = chat::require_message(view, m)?;
        cur = parent_of(view, m, &r)?;
    }
    above.reverse();
    Ok(Js::Arr(above.into_iter().map(Js::Big).collect()))
}

pub fn landing(view: &View, tree: u64, s: Option<u64>, u: Option<u64>) -> Result<Js, StoreError> {
    Ok(opt_big(sessions::landing(view, s, u, tree)?))
}

/// The reply followed at a fork (the replies of `at`, or the tree's openings).
pub fn followed(
    view: &View,
    tree: u64,
    at: Option<u64>,
    s: Option<u64>,
    u: Option<u64>,
) -> Result<Js, StoreError> {
    let f = match at {
        Some(m) => Fork::Message(m),
        None => Fork::Root(tree),
    };
    Ok(opt_big(sessions::followed(view, s, u, f, tree)?))
}

fn position_name(view: &View, p: u64) -> Result<Js, StoreError> {
    match view.get(&key::id(key::POSITION_NAME, p))? {
        Some(b) => Ok(Js::Text(
            bytes(&view.record(parse_loc(&b)?.pos)?.0, 1).to_vec(),
        )),
        None => Ok(Js::Null),
    }
}

/// Each session's pointer, name and outside key, or null.
pub fn sessions(view: &View, ids: &[u64]) -> Result<Js, StoreError> {
    let mut out = Vec::new();
    for &s in ids {
        let key = chat::key_by_id(view, chat::KEYED_SESSION, s)?;
        let Some(key) = key else {
            out.push(Js::Null);
            continue;
        };
        let (tree, at) = match sessions::session_pointer(view, s)? {
            Some((t, a)) => (Js::Big(t), opt_big(a)),
            None => (Js::Null, Js::Null),
        };
        out.push(Js::Obj(vec![
            ("id", Js::Big(s)),
            ("key", Js::Text(key)),
            ("name", position_name(view, s)?),
            ("tree", tree),
            ("at", at),
        ]))
    }
    Ok(Js::Arr(out))
}

/// The session's last position in a tree (`{ at }`, at null for the root), or null when it hasn't been there.
pub fn session_in_tree(view: &View, s: u64, tree: u64) -> Result<Js, StoreError> {
    Ok(match sessions::session_in_tree(view, s, tree)? {
        Some(at) => Js::Obj(vec![("at", opt_big(at))]),
        None => Js::Null,
    })
}

/// The user's last move in a tree: `{ session, at }`, or null.
pub fn user_in_tree(view: &View, u: u64, tree: u64) -> Result<Js, StoreError> {
    Ok(match sessions::user_in_tree(view, u, tree)? {
        Some((s, at)) => Js::Obj(vec![("session", Js::Big(s)), ("at", opt_big(at))]),
        None => Js::Null,
    })
}

/// A session's history entries from the n-th on: `{ n, target, tree, gone }`, `target` the message (null: `tree`'s
/// root, `tree` null otherwise).
pub fn history(view: &View, s: u64, from: u64, limit: usize) -> Result<Js, StoreError> {
    Ok(Js::Arr(
        sessions::history(view, s, from, limit)?
            .into_iter()
            .map(|(n, t, gone)| {
                let (target, tree) = match t {
                    sessions::Target::Message(m) => (Js::Big(m), Js::Null),
                    sessions::Target::Root(t) => (Js::Null, Js::Big(t)),
                };
                Js::Obj(vec![
                    ("n", Js::Num(n as f64)),
                    ("target", target),
                    ("tree", tree),
                    ("gone", Js::Bool(gone)),
                ])
            })
            .collect(),
    ))
}

fn order_page(list: Vec<(u64, u64)>) -> Js {
    Js::Arr(
        list.into_iter()
            .map(|(pos, s)| Js::Obj(vec![("position", Js::Big(pos)), ("session", Js::Big(s))]))
            .collect(),
    )
}

/// Sessions by their last move, newest first, before a position (the last one of a page before).
pub fn recent(view: &View, before: Option<u64>, limit: usize) -> Result<Js, StoreError> {
    Ok(order_page(sessions::recent(view, before, limit)?))
}

/// A tree's sessions by their last meaningful activity there, newest first.
pub fn in_tree(
    view: &View,
    tree: u64,
    before: Option<u64>,
    limit: usize,
) -> Result<Js, StoreError> {
    Ok(order_page(sessions::in_tree(view, tree, before, limit)?))
}

pub fn message_count(view: &View, tree: u64, at: Option<u64>) -> Result<Js, StoreError> {
    let (n, estimate) = sessions::message_count(view, tree, at)?;
    Ok(Js::Obj(vec![
        ("count", Js::Num(n as f64)),
        ("estimate", Js::Bool(estimate)),
    ]))
}

/// The id each outside key names in a space (0 message, 1 session, 2 user), or null.
pub fn ids_by_keys(view: &View, space: u8, keys: &[Vec<u8>]) -> Result<Js, StoreError> {
    Ok(Js::Arr(
        keys.iter()
            .map(|k| chat::id_by_key(view, space, k).map(opt_big))
            .collect::<Result<_, _>>()?,
    ))
}

/// What each outside key names in a space: `{ id }`, `'gone'` (a deleted session's), or null.
pub fn key_states(view: &View, space: u8, keys: &[Vec<u8>]) -> Result<Js, StoreError> {
    Ok(Js::Arr(
        keys.iter()
            .map(|k| {
                Ok(match chat::key_state(view, space, k)? {
                    chat::KeyState::Live(i) => Js::Obj(vec![("id", Js::Big(i))]),
                    chat::KeyState::Gone => Js::Text(b"gone".to_vec()),
                    chat::KeyState::None => Js::Null,
                })
            })
            .collect::<Result<_, StoreError>>()?,
    ))
}

/// One more than the highest id given, per space.
pub fn next_ids(view: &View) -> Result<Js, StoreError> {
    let get = |s: u64| -> Result<Js, StoreError> {
        Ok(Js::Big(
            view.get(&key::of(s))?
                .and_then(|b| max_value(&b))
                .unwrap_or(0),
        ))
    };
    Ok(Js::Obj(vec![
        ("message", get(key::NEXT_MESSAGE)?),
        ("position", get(key::NEXT_POSITION)?),
        ("user", get(key::NEXT_USER)?),
        ("change", get(state::NEXT_CHANGE)?),
    ]))
}

fn bookmark(view: &View, b: u64) -> Result<Js, StoreError> {
    let Some(v) = view.get(&key::id(key::POSITION, b))? else {
        return Ok(Js::Null);
    };
    let (r, _) = view.record(parse_loc(&v)?.pos)?;
    let id = |i| super::kinds::id(&r, i);
    Ok(Js::Obj(vec![
        ("id", Js::Big(b)),
        ("at", opt_big(chat::bookmark_at(view, b)?)),
        (
            "mode",
            Js::Num(chat::bookmark_mode(view, b)?.unwrap_or(0) as f64),
        ),
        ("name", position_name(view, b)?),
        ("createdAt", Js::Big(id(4))),
        ("session", Js::Big(id(2))),
        ("user", Js::Big(id(3))),
    ]))
}

/// A tree's bookmarks in id order (the order they were made), after `after`, at most `limit`.
pub fn tree_bookmarks(
    view: &View,
    tree: u64,
    after: Option<u64>,
    limit: usize,
) -> Result<Js, StoreError> {
    let p = key::id(key::TREE_BOOKMARK, tree);
    let start = match after {
        Some(a) => key::ids(key::TREE_BOOKMARK, tree, a + 1),
        None => p.clone(),
    };
    let mut out = Vec::new();
    for (k, _) in view.scan(&start, &key::prefix_end(&p), limit)? {
        let mut at = p.len();
        let b = get_u64(&k, &mut at)
            .ok_or_else(|| StoreError::Entry("a bookmark key doesn't decode".into()))?;
        out.push(bookmark(view, b)?);
    }
    Ok(Js::Arr(out))
}

/// Each bookmark, or null.
pub fn bookmarks(view: &View, ids: &[u64]) -> Result<Js, StoreError> {
    Ok(Js::Arr(
        ids.iter()
            .map(|b| bookmark(view, *b))
            .collect::<Result<_, _>>()?,
    ))
}

/// The bookmarks at a message now.
pub fn bookmarks_at(view: &View, m: u64) -> Result<Js, StoreError> {
    Ok(Js::Arr(
        chat::bookmarks_at(view, m)?
            .into_iter()
            .map(Js::Big)
            .collect(),
    ))
}

/// The state at a message (None: the tree's root): `[{ variable, field, json }]` in object order.
pub fn state_at(view: &View, tree: u64, at: Option<u64>) -> Result<Js, StoreError> {
    Ok(Js::Arr(
        state::state_at(view, tree, at)?
            .into_iter()
            .map(|e| {
                Js::Obj(vec![
                    ("variable", Js::Bool(e.variable)),
                    ("field", field_js(&e.key)),
                    ("json", Js::Text(e.json)),
                ])
            })
            .collect(),
    ))
}

fn stats_js(s: stats::Stats) -> Js {
    let c = |i: u64| Js::Num(s.counters[i as usize] as f64);
    Js::Obj(vec![
        ("userMsgs", c(stats::USER_MSGS)),
        ("charMsgs", c(stats::CHAR_MSGS)),
        ("userWords", c(stats::USER_WORDS)),
        ("charWords", c(stats::CHAR_WORDS)),
        ("swipes", c(stats::SWIPES)),
        ("genMs", c(stats::GEN_MS)),
        ("genUnknown", c(stats::GEN_UNKNOWN)),
        ("chatSize", c(stats::SIZE)),
        (
            "firstUserAt",
            s.first_user_at.map_or(Js::Null, |t| Js::Num(t as f64)),
        ),
        ("lastAt", s.last_at.map_or(Js::Null, |t| Js::Num(t as f64))),
    ])
}

/// Each owner's stats, then the totals.
pub fn chat_stats(view: &View, owners: &[u64]) -> Result<Js, StoreError> {
    let list = owners
        .iter()
        .map(|o| stats::owner_stats(view, *o).map(stats_js))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Js::Obj(vec![
        ("owners", Js::Arr(list)),
        ("totals", stats_js(stats::total_stats(view)?)),
    ]))
}

pub fn itemization(view: &View, m: u64) -> Result<Js, StoreError> {
    Ok(match chat::itemization(view, m)? {
        Some((raw, data)) => Js::Obj(vec![("raw", Js::Bool(raw)), ("data", Js::Bytes(data))]),
        None => Js::Null,
    })
}

/// The message stored for each send key in the owner's tree, or null.
pub fn sent(view: &View, owner: u64, keys: &[Vec<u8>]) -> Result<Js, StoreError> {
    let mut out = Vec::new();
    for k in keys {
        out.push(match view.get(&chat::send_key_key(owner, k))? {
            Some(b) => Js::Big(parse_varints::<1>(&b)?[0]),
            None => Js::Null,
        });
    }
    Ok(Js::Arr(out))
}
