//! State layer 1 (`.plans/2026-10-03-state-layer-1.md`, build path 5b): changes hang on a tree's root or on a
//! message, so the state at a message is every change on the path from the root down to it, in path order and, on
//! one message, in id order, skipping reverted ones. `chat_metadata` is that state: a key is a top-level metadata
//! key, or (the variable bit) a chat variable's name.

use super::StoreError;
use super::chat::{opt_id, parent_of, require_message};
use super::derive::{Deriver, Loc, Out, View};
use super::kinds::{bytes, dead, field, id, key, loc_bytes, parse_loc};
use super::sessions;
use crate::keyspace::val::{get_u64, put_u64};
use crate::log::format::{FieldRef, Record, Value};

pub const AUTHOR_USER: u64 = 0;
pub const AUTHOR_SCRIPT: u64 = 1;
pub const AUTHOR_MODEL: u64 = 2;
pub const AUTHOR_RULE: u64 = 3;
pub const AUTHOR_MIGRATION: u64 = 4;
/// `stateChange`'s `author` bit: the key is a variable's name.
pub const VARIABLE: u64 = 8;

/// Per change id: its `stateChange` or `stateRevert` record.
pub const CHANGE: u64 = 150;
/// Per (where it hangs, change id): a change hangs there.
pub const STATE_AT: u64 = 151;
/// Per (change, revert): the revert reverts the change.
pub const REVERTED_BY: u64 = 152;
/// One more than the highest change id given (a maximum).
pub const NEXT_CHANGE: u64 = 153;

/// Where a change hangs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hang {
    Tree(u64),
    Message(u64),
}

impl Hang {
    fn of(rec: &Record) -> Hang {
        match rec.values[1] {
            Value::Sel(1, m) => Hang::Message(m),
            Value::Sel(_, t) => Hang::Tree(t),
            _ => unreachable!("checked by Record::new"),
        }
    }

    fn prefix(self) -> Vec<u8> {
        let mut k = key::of(STATE_AT);
        match self {
            Hang::Tree(t) => {
                put_u64(&mut k, 0);
                put_u64(&mut k, t);
            }
            Hang::Message(m) => {
                put_u64(&mut k, 1);
                put_u64(&mut k, m);
            }
        }
        k
    }

    fn key(self, c: u64) -> Vec<u8> {
        let mut k = self.prefix();
        put_u64(&mut k, c);
        k
    }
}

fn change_loc(view: &View, c: u64) -> Result<Option<Loc>, StoreError> {
    view.get(&key::id(CHANGE, c))?
        .map(|b| parse_loc(&b))
        .transpose()
}

fn live_change(view: &View, c: u64, pos: u64) -> Result<bool, StoreError> {
    Ok(change_loc(view, c)?.is_some_and(|l| l.pos == pos))
}

fn repoint_change(
    view: &View,
    out: &mut Out,
    c: u64,
    from: u64,
    to: Loc,
) -> Result<(), StoreError> {
    if live_change(view, c, from)? {
        out.put(key::id(CHANGE, c), loc_bytes(to));
    }
    Ok(())
}

fn check_author(author: u64) -> Result<(), StoreError> {
    if author & !VARIABLE > AUTHOR_MIGRATION {
        return Err(StoreError::Refused(format!("no author kind {author}")));
    }
    Ok(())
}

fn new_id(view: &View, c: u64) -> Result<(), StoreError> {
    if change_loc(view, c)?.is_some() {
        return Err(StoreError::Refused(format!("change {c} exists")));
    }
    Ok(())
}

/// `stateChange`: a key set or deleted where the change hangs.
pub struct StateChange;

impl Deriver for StateChange {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let c = id(rec, 0);
        new_id(view, c)?;
        check_author(id(rec, 3))?;
        let hang = Hang::of(rec);
        if let Hang::Message(m) = hang {
            require_message(view, m)?;
        }
        sessions::check_actor(view, opt_id(rec, 8), opt_id(rec, 9))?;
        out.put(key::id(CHANGE, c), loc_bytes(at));
        out.put(hang.key(c), Vec::new());
        out.max(key::of(NEXT_CHANGE), c + 1);
        Ok(())
    }

    fn partition(&self, rec: &Record) -> u64 {
        id(rec, 0)
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        live_change(view, id(rec, 0), pos)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_change(view, out, id(rec, 0), from, to)
    }
}

/// `stateRevert`: a change (or a revert) is reverted.
pub struct StateRevert;

impl Deriver for StateRevert {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (c, target) = (id(rec, 0), id(rec, 1));
        new_id(view, c)?;
        check_author(id(rec, 3))?;
        if change_loc(view, target)?.is_none() {
            return Err(StoreError::Refused(format!("no change {target}")));
        }
        sessions::check_actor(view, opt_id(rec, 5), opt_id(rec, 6))?;
        out.put(key::id(CHANGE, c), loc_bytes(at));
        out.put(key::ids(REVERTED_BY, target, c), Vec::new());
        out.max(key::of(NEXT_CHANGE), c + 1);
        Ok(())
    }

    fn partition(&self, rec: &Record) -> u64 {
        id(rec, 0)
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        live_change(view, id(rec, 0), pos)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_change(view, out, id(rec, 0), from, to)
    }
}

/// The changes hanging on a message go with it.
pub fn message_gone(view: &View, out: &mut Out, m: u64) -> Result<(), StoreError> {
    let p = Hang::Message(m).prefix();
    for (k, _) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        let mut at = p.len();
        let c = get_u64(&k, &mut at)
            .ok_or_else(|| StoreError::Entry("a state key doesn't decode".into()))?;
        if let Some(l) = change_loc(view, c)? {
            dead(out, l);
        }
        out.del(key::id(CHANGE, c));
        out.del(k);
    }
    Ok(())
}

/// Whether change `c` counts: no revert of it counts (a revert of a revert restores what it reverted).
pub fn active(view: &View, c: u64) -> Result<bool, StoreError> {
    let p = key::id(REVERTED_BY, c);
    for (k, _) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        let mut at = p.len();
        let r = get_u64(&k, &mut at)
            .ok_or_else(|| StoreError::Entry("a revert key doesn't decode".into()))?;
        // A revert is newer than what it reverts, so this ends.
        if active(view, r)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// One key of the state: whether it is a variable's name, the key, and its value as JSON.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub variable: bool,
    pub key: FieldRef,
    pub json: Vec<u8>,
}

/// The state at a message of tree `tree` (None: at the tree's root), its keys in the order a JavaScript object
/// would hold them after the changes in turn: a key set keeps its place, a key deleted and set again goes last.
pub fn state_at(view: &View, tree: u64, at: Option<u64>) -> Result<Vec<Entry>, StoreError> {
    let mut path = Vec::new();
    let mut cur = at;
    while let Some(m) = cur {
        path.push(m);
        let (_, r) = require_message(view, m)?;
        cur = parent_of(view, m, &r)?;
    }
    let mut out: Vec<Entry> = Vec::new();
    let hangs = std::iter::once(Hang::Tree(tree)).chain(path.into_iter().rev().map(Hang::Message));
    for hang in hangs {
        let p = hang.prefix();
        for (k, _) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
            let mut at = p.len();
            let c = get_u64(&k, &mut at)
                .ok_or_else(|| StoreError::Entry("a state key doesn't decode".into()))?;
            let Some(l) = change_loc(view, c)? else {
                continue;
            };
            if !active(view, c)? {
                continue;
            }
            let (rec, _) = view.record(l.pos)?;
            let variable = id(&rec, 3) & VARIABLE != 0;
            let key = field(&rec, 6).clone();
            let found = out
                .iter()
                .position(|e| e.variable == variable && e.key == key);
            match (&rec.values[7], found) {
                (Value::Text(_), Some(i)) => out[i].json = bytes(&rec, 7).to_vec(),
                (Value::Text(_), None) => out.push(Entry {
                    variable,
                    key,
                    json: bytes(&rec, 7).to_vec(),
                }),
                (_, Some(i)) => {
                    out.remove(i);
                }
                (_, None) => {}
            }
        }
    }
    Ok(out)
}

/// The changes hanging at one place, in order: (id, active).
pub fn changes_at(view: &View, hang: Hang) -> Result<Vec<(u64, bool)>, StoreError> {
    let p = hang.prefix();
    view.scan(&p, &key::prefix_end(&p), usize::MAX)?
        .into_iter()
        .map(|(k, _)| {
            let mut at = p.len();
            let c = get_u64(&k, &mut at)
                .ok_or_else(|| StoreError::Entry("a state key doesn't decode".into()))?;
            Ok((c, active(view, c)?))
        })
        .collect()
}

pub fn deriver(kind: &str) -> Option<&'static dyn Deriver> {
    Some(match kind {
        "stateChange" => &StateChange,
        "stateRevert" => &StateRevert,
        _ => return None,
    })
}
