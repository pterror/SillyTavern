use super::StoreError;
use super::chat::{opt_id, require_message};
use super::derive::{Deriver, Loc, Out, View};
use super::kinds::{bytes, dead, field, id, key, loc_bytes, parse_loc, parse_varints, varints};
use super::sessions;
use crate::keyspace::val::{get_u64, max_value, put_u64};
use crate::log::format::{FieldRef, Record, Value};

pub const AUTHOR_USER: u64 = 0;
pub const AUTHOR_SCRIPT: u64 = 1;
pub const AUTHOR_MODEL: u64 = 2;
pub const AUTHOR_RULE: u64 = 3;
pub const AUTHOR_MIGRATION: u64 = 4;
pub const VARIABLE: u64 = 8;
pub const PRODUCED: u64 = 16;

pub const CHANGE: u64 = 150;
pub const STATE_AT: u64 = 151;
pub const REVERTED_BY: u64 = 152;
pub const NEXT_CHANGE: u64 = 153;
pub const ROOT_CLEAR: u64 = 155;

pub const CLEAR_SLICE: usize = 256;

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

pub fn change_loc(view: &View, c: u64) -> Result<Option<Loc>, StoreError> {
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

fn check_author(author: u64, bits: u64) -> Result<(), StoreError> {
    if author & !bits > AUTHOR_MIGRATION {
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

pub struct StateChange;

impl Deriver for StateChange {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let c = id(rec, 0);
        new_id(view, c)?;
        let author = id(rec, 3);
        check_author(author, VARIABLE | PRODUCED)?;
        let hang = Hang::of(rec);
        if author & PRODUCED != 0 && matches!(hang, Hang::Tree(_)) {
            return Err(StoreError::Refused(
                "a change on a tree's root can't be a reply's".into(),
            ));
        }
        if let Hang::Message(m) = hang {
            let (_, r) = require_message(view, m)?;
            super::prune::refuse_doomed(view, super::kinds::id(&r, super::chat::APPEND_OWNER), m)?;
            super::chat::shape_add(out, m, super::chat::SHAPE_EXTRA);
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

pub struct StateRevert;

impl Deriver for StateRevert {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (c, target) = (id(rec, 0), id(rec, 1));
        new_id(view, c)?;
        check_author(id(rec, 3), VARIABLE)?;
        let is_state = match change_loc(view, target)? {
            Some(l) => matches!(
                view.record(l.pos)?.0.kind.name,
                "stateChange" | "stateRevert"
            ),
            None => false,
        };
        if !is_state || clearing(view, target)? {
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

pub fn message_gone(view: &View, out: &mut Out, m: u64) -> Result<(), StoreError> {
    let p = Hang::Message(m).prefix();
    for (k, _) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        let mut at = p.len();
        let c = get_u64(&k, &mut at)
            .ok_or_else(|| StoreError::Entry("a state key doesn't decode".into()))?;
        change_gone(view, out, c)?;
        out.del(k);
    }
    Ok(())
}

fn change_gone(view: &View, out: &mut Out, c: u64) -> Result<(), StoreError> {
    if let Some(l) = change_loc(view, c)? {
        dead(out, l);
    }
    out.del(key::id(CHANGE, c));
    let p = key::id(REVERTED_BY, c);
    for (k, _) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        let mut at = p.len();
        let r = get_u64(&k, &mut at)
            .ok_or_else(|| StoreError::Entry("a revert key doesn't decode".into()))?;
        change_gone(view, out, r)?;
        out.del(k);
    }
    Ok(())
}

fn root_clear(view: &View, tree: u64) -> Result<Option<[u64; 3]>, StoreError> {
    view.get(&key::id(ROOT_CLEAR, tree))?
        .map(|b| parse_varints::<3>(&b))
        .transpose()
}

fn clearing(view: &View, c: u64) -> Result<bool, StoreError> {
    let Some(l) = change_loc(view, c)? else {
        return Ok(false);
    };
    let (rec, _) = view.record(l.pos)?;
    if rec.kind.name != "stateChange" {
        return Ok(false);
    }
    match Hang::of(&rec) {
        Hang::Tree(t) => Ok(root_clear(view, t)?.is_some_and(|[upto, _, _]| c < upto)),
        Hang::Message(_) => Ok(false),
    }
}

pub struct RootStateClear;

impl Deriver for RootStateClear {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let tree = id(rec, 0);
        let upto = view
            .get(&key::of(NEXT_CHANGE))?
            .and_then(|b| max_value(&b))
            .unwrap_or(0);
        if let Some([_, pos, len]) = root_clear(view, tree)? {
            dead(out, Loc { pos, len });
        }
        out.put(key::id(ROOT_CLEAR, tree), varints(&[upto, at.pos, at.len]));
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        Ok(root_clear(view, id(rec, 0))?.is_some_and(|[_, rp, _]| rp == pos))
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        let tree = id(rec, 0);
        if let Some([upto, rp, _]) = root_clear(view, tree)?
            && rp == from
        {
            out.put(key::id(ROOT_CLEAR, tree), varints(&[upto, to.pos, to.len]));
        }
        Ok(())
    }
}

pub fn any_clear_pending(view: &View) -> Result<bool, StoreError> {
    let p = key::of(ROOT_CLEAR);
    Ok(!view.scan(&p, &key::prefix_end(&p), 1)?.is_empty())
}

pub fn clear_step(view: &View, out: &mut Out) -> Result<bool, StoreError> {
    let cp = key::of(ROOT_CLEAR);
    let Some((ck, v)) = view.scan(&cp, &key::prefix_end(&cp), 1)?.into_iter().next() else {
        return Ok(false);
    };
    let mut at = cp.len();
    let tree = get_u64(&ck, &mut at)
        .ok_or_else(|| StoreError::Entry("a root clear key doesn't decode".into()))?;
    let [upto, rp, rl] = parse_varints::<3>(&v)?;
    let p = Hang::Tree(tree).prefix();
    let mut left = false;
    for (n, (k, _)) in view
        .scan(&p, &key::prefix_end(&p), CLEAR_SLICE + 1)?
        .into_iter()
        .enumerate()
    {
        let mut at = p.len();
        let c = get_u64(&k, &mut at)
            .ok_or_else(|| StoreError::Entry("a state key doesn't decode".into()))?;
        if c >= upto {
            break;
        }
        if n == CLEAR_SLICE {
            left = true;
            break;
        }
        change_gone(view, out, c)?;
        out.del(k);
    }
    if !left {
        out.del(ck);
        dead(out, Loc { pos: rp, len: rl });
    }
    Ok(true)
}

pub fn active(view: &View, c: u64) -> Result<bool, StoreError> {
    let p = key::id(REVERTED_BY, c);
    for (k, _) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        let mut at = p.len();
        let r = get_u64(&k, &mut at)
            .ok_or_else(|| StoreError::Entry("a revert key doesn't decode".into()))?;
        if active(view, r)? {
            return Ok(false);
        }
    }
    Ok(true)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub variable: bool,
    pub key: FieldRef,
    pub json: Vec<u8>,
}

pub fn state_at(view: &View, tree: u64, at: Option<u64>) -> Result<Vec<Entry>, StoreError> {
    let path = super::chat::path_to(view, at)?;
    let shapes = super::chat::shapes(view, &path)?;
    let mut out: Vec<Entry> = Vec::new();
    let held = path
        .iter()
        .zip(shapes)
        .filter(|(_, s)| s.extras > 0)
        .map(|(m, _)| Hang::Message(*m));
    let hangs = std::iter::once(Hang::Tree(tree)).chain(held);
    let cleared = root_clear(view, tree)?.map_or(0, |[upto, _, _]| upto);
    for hang in hangs {
        let p = hang.prefix();
        for (k, _) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
            let mut at = p.len();
            let c = get_u64(&k, &mut at)
                .ok_or_else(|| StoreError::Entry("a state key doesn't decode".into()))?;
            if matches!(hang, Hang::Tree(_)) && c < cleared {
                continue;
            }
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

pub fn changes_at(view: &View, hang: Hang) -> Result<Vec<(u64, bool)>, StoreError> {
    let cleared = match hang {
        Hang::Tree(t) => root_clear(view, t)?.map_or(0, |[upto, _, _]| upto),
        Hang::Message(_) => 0,
    };
    let p = hang.prefix();
    let mut out = Vec::new();
    for (k, _) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        let mut at = p.len();
        let c = get_u64(&k, &mut at)
            .ok_or_else(|| StoreError::Entry("a state key doesn't decode".into()))?;
        if c < cleared {
            continue;
        }
        out.push((c, active(view, c)?));
    }
    Ok(out)
}

pub fn deriver(kind: &str) -> Option<&'static dyn Deriver> {
    Some(match kind {
        "stateChange" => &StateChange,
        "stateRevert" => &StateRevert,
        "rootStateClear" => &RootStateClear,
        _ => return None,
    })
}
