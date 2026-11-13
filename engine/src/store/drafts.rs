//! Drafts: the text being written, kept with what it will be sent after. That is a stored message, a chat's root (its
//! tree: the character or group), or a card greeting not yet stored (the card and the greeting's id). A draft is a
//! value with edits, as a text field is, but it is no part of what it follows: writing it changes no message, card,
//! version or feed.

use super::StoreError;
use super::chat::{opt_id, require_message};
use super::derive::{Deriver, Loc, Out, View};
use super::kinds::{Head, apply_edit, bytes, dead, full_text, id, key, loc_bytes, parse_loc};
use super::{library, prune, sessions};
use crate::keyspace::val::put_u64;
use crate::log::format::{Ctx, Record, Value, encode, kind_by_name, wtf8_to_utf16};

/// A draft's head, by owner: as a text field's head
pub const DRAFT: u64 = 306;
/// A draft's edits, by owner and edit number
pub const DRAFT_EDIT: u64 = 307;

const AT: usize = 0;
const GREETING: usize = 1;
const VALUE_SESSION: usize = 3;
const VALUE_USER: usize = 4;
const EDIT_OFFSET: usize = 2;
const EDIT_REMOVED: usize = 3;
const EDIT_TEXT: usize = 4;
const EDIT_SESSION: usize = 5;
const EDIT_USER: usize = 6;

/// What a draft will be sent after
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    Message(u64),
    /// A chat at its root: the tree
    Root(u64),
    /// A greeting not yet stored: the card, and the greeting's id
    Greeting(u64, u64),
}

impl Owner {
    fn of(rec: &Record) -> Result<Owner, StoreError> {
        let greeting = match rec.values[GREETING] {
            Value::UInt(g) => Some(g),
            _ => None,
        };
        match (rec.values[AT].clone(), greeting) {
            (Value::Sel(1, m), None) => Ok(Owner::Message(m)),
            (Value::Sel(1, m), Some(_)) => Err(StoreError::Refused(format!(
                "a draft after message {m} has no greeting"
            ))),
            (Value::Sel(_, t), None) => Ok(Owner::Root(t)),
            (Value::Sel(_, t), Some(g)) => Ok(Owner::Greeting(t, g)),
            _ => unreachable!("checked by Record::new"),
        }
    }

    fn prefix(self, structure: u64) -> Vec<u8> {
        let mut k = key::of(structure);
        match self {
            Owner::Message(m) => {
                put_u64(&mut k, 1);
                put_u64(&mut k, m);
            }
            Owner::Root(t) => {
                put_u64(&mut k, 0);
                put_u64(&mut k, t);
                put_u64(&mut k, 0);
            }
            Owner::Greeting(t, g) => {
                put_u64(&mut k, 0);
                put_u64(&mut k, t);
                put_u64(&mut k, g + 1);
            }
        }
        k
    }

    fn head_key(self) -> Vec<u8> {
        self.prefix(DRAFT)
    }

    fn edits_prefix(self) -> Vec<u8> {
        self.prefix(DRAFT_EDIT)
    }

    fn edit_key(self, n: u64) -> Vec<u8> {
        let mut k = self.edits_prefix();
        put_u64(&mut k, n);
        k
    }

    fn partition(self) -> u64 {
        match self {
            Owner::Message(x) | Owner::Root(x) | Owner::Greeting(x, _) => x,
        }
    }
}

fn head(view: &View, o: Owner) -> Result<Option<Head>, StoreError> {
    view.get(&o.head_key())?
        .map(|b| match super::kinds::Cur::parse(&b)? {
            super::kinds::Cur::Text(h) => Ok(h),
            _ => Err(StoreError::Entry(format!(
                "{o:?}'s draft head has another form"
            ))),
        })
        .transpose()
}

fn edits(view: &View, o: Owner, h: &Head) -> Result<Vec<(Vec<u8>, Loc)>, StoreError> {
    if h.edits() == 0 {
        return Ok(Vec::new());
    }
    let start = o.edits_prefix();
    let found = view.scan(&start, &key::prefix_end(&start), h.edits() as usize)?;
    if found.len() as u64 != h.edits() {
        return Err(StoreError::Entry(format!(
            "{o:?}'s draft has {} edit entries, its head says {}",
            found.len(),
            h.edits()
        )));
    }
    found
        .into_iter()
        .map(|(k, v)| Ok((k, parse_loc(&v)?)))
        .collect()
}

fn materialize(view: &View, o: Owner, h: &Head) -> Result<Vec<u8>, StoreError> {
    let (full, _) = view.record(h.full.pos)?;
    let mut text = full_text(&full).to_vec();
    for (_, l) in edits(view, o, h)? {
        let (e, _) = view.record(l.pos)?;
        text = apply_edit(
            &text,
            id(&e, EDIT_OFFSET),
            id(&e, EDIT_REMOVED),
            bytes(&e, EDIT_TEXT),
        )
        .ok_or_else(|| StoreError::Entry(format!("an edit of {o:?}'s draft is out of range")))?;
    }
    Ok(text)
}

/// The draft kept after an owner, if any
pub fn draft(view: &View, o: Owner) -> Result<Option<Vec<u8>>, StoreError> {
    match head(view, o)? {
        Some(h) => materialize(view, o, &h).map(Some),
        None => Ok(None),
    }
}

fn drop_draft(view: &View, out: &mut Out, o: Owner) -> Result<(), StoreError> {
    let Some(h) = head(view, o)? else {
        return Ok(());
    };
    dead(out, h.full);
    for (k, l) in edits(view, o, &h)? {
        dead(out, l);
        out.del(k);
    }
    out.del(o.head_key());
    Ok(())
}

fn check_owner(view: &View, o: Owner) -> Result<(), StoreError> {
    match o {
        Owner::Message(m) => {
            let (_, append) = require_message(view, m)?;
            prune::refuse_doomed(view, id(&append, super::chat::APPEND_OWNER), m)
        }
        Owner::Root(e) | Owner::Greeting(e, _) => {
            if library::entity_info(view, e)?.is_none() {
                return Err(StoreError::Refused(format!(
                    "a draft after entity {e}, which isn't there"
                )));
            }
            Ok(())
        }
    }
}

/// Drops the draft after a message going away
pub fn message_gone(view: &View, out: &mut Out, m: u64) -> Result<(), StoreError> {
    drop_draft(view, out, Owner::Message(m))
}

/// Drops the drafts at a tree's root and after each of a card's greetings, for an entity going away
pub fn entity_gone(view: &View, out: &mut Out, e: u64) -> Result<(), StoreError> {
    let mut p = key::of(DRAFT);
    put_u64(&mut p, 0);
    put_u64(&mut p, e);
    for (k, _) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        let mut at = p.len();
        let g = crate::keyspace::val::get_u64(&k, &mut at)
            .ok_or_else(|| StoreError::Entry("a draft key doesn't decode".into()))?;
        drop_draft(
            view,
            out,
            if g == 0 {
                Owner::Root(e)
            } else {
                Owner::Greeting(e, g - 1)
            },
        )?;
    }
    Ok(())
}

fn repoint(
    view: &View,
    out: &mut Out,
    o: Owner,
    from: u64,
    to: Option<Loc>,
) -> Result<bool, StoreError> {
    let Some(h) = head(view, o)? else {
        return Ok(false);
    };
    if h.full.pos == from {
        if let Some(to) = to {
            let moved = Head::with_edits(to, h.size(), h.edits(), h.edit_bytes());
            out.put(o.head_key(), moved.bytes());
        }
        return Ok(true);
    }
    for (k, l) in edits(view, o, &h)? {
        if l.pos == from {
            if let Some(to) = to {
                let moved =
                    Head::with_edits(h.full, h.size(), h.edits(), h.edit_bytes() - l.len + to.len);
                out.put(o.head_key(), moved.bytes());
                out.put(k, loc_bytes(to));
            }
            return Ok(true);
        }
    }
    Ok(false)
}

pub struct DraftValue;

impl Deriver for DraftValue {
    fn partition(&self, rec: &Record) -> u64 {
        Owner::of(rec).map_or(0, Owner::partition)
    }

    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let o = Owner::of(rec)?;
        check_owner(view, o)?;
        sessions::check_actor(view, opt_id(rec, VALUE_SESSION), opt_id(rec, VALUE_USER))?;
        drop_draft(view, out, o)?;
        let text = bytes(rec, 2);
        if text.is_empty() {
            dead(out, at);
            return Ok(());
        }
        out.put(o.head_key(), Head::new(at, text.len() as u64).bytes());
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        repoint(view, &mut Out::default(), Owner::of(rec)?, pos, None)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint(view, out, Owner::of(rec)?, from, Some(to)).map(drop)
    }
}

pub struct DraftEdit;

impl Deriver for DraftEdit {
    fn prepares(&self) -> bool {
        true
    }

    /// An edit of no draft, an edit that empties it, and an edit whose draft's edits would outweigh its text are
    /// written as the whole value
    fn prepare(&self, rec: Record, view: &View) -> Result<Record, StoreError> {
        let o = Owner::of(&rec)?;
        let h = head(view, o)?;
        let current = match &h {
            Some(h) => materialize(view, o, h)?,
            None => Vec::new(),
        };
        let (offset, removed) = (id(&rec, EDIT_OFFSET), id(&rec, EDIT_REMOVED));
        let new =
            apply_edit(&current, offset, removed, bytes(&rec, EDIT_TEXT)).ok_or_else(|| {
                StoreError::Refused(format!(
                    "draftEdit of {o:?}: bytes {offset}..{} are outside its {} bytes",
                    offset.saturating_add(removed),
                    current.len()
                ))
            })?;
        if wtf8_to_utf16(&new).is_err() {
            return Err(StoreError::Refused(format!(
                "draftEdit of {o:?}: an offset falls inside a character"
            )));
        }
        let mut encoded = Vec::new();
        encode(&rec, &mut Ctx::default(), &mut encoded);
        if new.is_empty()
            || h.is_none_or(|h| h.edit_bytes() + encoded.len() as u64 >= new.len() as u64)
        {
            return Ok(Record::new(
                kind_by_name("draftValue").unwrap(),
                vec![
                    rec.values[AT].clone(),
                    rec.values[GREETING].clone(),
                    Value::Text(new),
                    rec.values[EDIT_SESSION].clone(),
                    rec.values[EDIT_USER].clone(),
                ],
            )
            .expect("a draftValue of a draftEdit's values"));
        }
        Ok(rec)
    }

    fn partition(&self, rec: &Record) -> u64 {
        Owner::of(rec).map_or(0, Owner::partition)
    }

    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let o = Owner::of(rec)?;
        check_owner(view, o)?;
        sessions::check_actor(view, opt_id(rec, EDIT_SESSION), opt_id(rec, EDIT_USER))?;
        let h = head(view, o)?
            .ok_or_else(|| StoreError::Entry(format!("a draftEdit of {o:?} with no draft")))?;
        let size = h.size().checked_sub(id(rec, EDIT_REMOVED)).ok_or_else(|| {
            StoreError::Entry(format!("a draftEdit of {o:?} removes more than it has"))
        })? + bytes(rec, EDIT_TEXT).len() as u64;
        let n = h.edits() + 1;
        out.put(o.edit_key(n), loc_bytes(at));
        out.put(
            o.head_key(),
            Head::with_edits(h.full, size, n, h.edit_bytes() + at.len).bytes(),
        );
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        repoint(view, &mut Out::default(), Owner::of(rec)?, pos, None)
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint(view, out, Owner::of(rec)?, from, Some(to)).map(drop)
    }
}

pub fn deriver(kind: &str) -> Option<&'static dyn Deriver> {
    Some(match kind {
        "draftValue" => &DraftValue,
        "draftEdit" => &DraftEdit,
        _ => return None,
    })
}
