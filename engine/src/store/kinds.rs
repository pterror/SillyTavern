//! The derivers stage 3 has: current values for `fav`, `textValue` and `textEdit` (with the entity's version),
//! the cleaner's `moved` marker, and the test kind `testSet`. Each store stage adds its kinds' derivers here.

use super::StoreError;
use super::derive::{Deriver, Loc, Out, View};
use crate::log::FILE_SHIFT;
use crate::log::format::{
    Ctx, FieldRef, Record, Value, encode, get_uvarint, kind_by_name, put_uvarint, wtf8_to_utf16,
};

/// Entry keys: a structure's id, then its key's components (`keyspace::val::put_u64` / `put_bytes`).
pub mod key {
    use crate::keyspace::val::{put_bytes, put_u64};
    use crate::log::format::FieldRef;

    /// Per log file: bytes of its records that nothing points at any more (a counter).
    pub const DEAD: u64 = 1;
    /// Per log file: its live fraction has fallen under u; the cleaner's queue.
    pub const CLEAN: u64 = 2;
    /// Per log file: cleaned; removed once the runs cover the log up to the position held.
    pub const GONE: u64 = 3;
    /// Per entity: the position of its latest record.
    pub const VERSION: u64 = 16;
    /// Per entity: the record holding its fav bit.
    pub const FAV: u64 = 17;
    /// Per (entity, field): the text's last full value, size, and the edits since.
    pub const TEXT: u64 = 18;
    /// Per (entity, field, n): the n-th edit since the last full value.
    pub const TEXT_EDIT: u64 = 19;
    #[cfg(any(test, feature = "measure"))]
    pub const TEST_SET: u64 = 4096;
    #[cfg(any(test, feature = "measure"))]
    pub const TEST_ORDER: u64 = 4097;
    #[cfg(any(test, feature = "measure"))]
    pub const TEST_COUNT: u64 = 4098;

    pub fn of(structure: u64) -> Vec<u8> {
        let mut k = Vec::new();
        put_u64(&mut k, structure);
        k
    }

    pub fn id(structure: u64, id: u64) -> Vec<u8> {
        let mut k = of(structure);
        put_u64(&mut k, id);
        k
    }

    pub fn ids(structure: u64, a: u64, b: u64) -> Vec<u8> {
        let mut k = id(structure, a);
        put_u64(&mut k, b);
        k
    }

    pub fn field(structure: u64, entity: u64, f: &FieldRef) -> Vec<u8> {
        let mut k = id(structure, entity);
        match f {
            FieldRef::Code(c) => {
                k.push(1);
                put_u64(&mut k, *c);
            }
            FieldRef::Key(b) => {
                k.push(2);
                put_bytes(&mut k, b);
            }
        }
        k
    }

    pub fn edit(entity: u64, f: &FieldRef, n: u64) -> Vec<u8> {
        let mut k = field(TEXT_EDIT, entity, f);
        put_u64(&mut k, n);
        k
    }

    /// The first key after every key starting with `prefix`.
    pub fn prefix_end(prefix: &[u8]) -> Vec<u8> {
        let mut end = prefix.to_vec();
        while let Some(last) = end.pop() {
            if last < 0xff {
                end.push(last + 1);
                return end;
            }
        }
        vec![0xff; 9]
    }
}

pub fn file_of(pos: u64) -> u64 {
    pos >> FILE_SHIFT
}

fn varints(vals: &[u64]) -> Vec<u8> {
    let mut out = Vec::new();
    for v in vals {
        put_uvarint(&mut out, *v);
    }
    out
}

fn parse_varints<const N: usize>(b: &[u8]) -> Result<[u64; N], StoreError> {
    let mut out = [0; N];
    let mut at = 0;
    for v in &mut out {
        *v = get_uvarint(b, &mut at)
            .map_err(|_| StoreError::Entry("an entry doesn't decode".into()))?;
    }
    if at != b.len() {
        return Err(StoreError::Entry("an entry has bytes left over".into()));
    }
    Ok(out)
}

pub fn loc_bytes(l: Loc) -> Vec<u8> {
    varints(&[l.pos, l.len])
}

pub fn parse_loc(b: &[u8]) -> Result<Loc, StoreError> {
    let [pos, len] = parse_varints(b)?;
    Ok(Loc { pos, len })
}

fn dead(out: &mut Out, l: Loc) {
    out.add(key::id(key::DEAD, file_of(l.pos)), l.len as i64);
}

fn version(out: &mut Out, entity: u64, at: Loc) {
    out.put(key::id(key::VERSION, entity), pos_bytes(at.pos));
}

pub fn pos_bytes(pos: u64) -> Vec<u8> {
    varints(&[pos])
}

pub fn parse_pos(b: &[u8]) -> Result<u64, StoreError> {
    let [pos] = parse_varints(b)?;
    Ok(pos)
}

fn id(rec: &Record, i: usize) -> u64 {
    match rec.values[i] {
        Value::Id(v) | Value::UInt(v) => v,
        _ => unreachable!("checked by Record::new"),
    }
}

fn field(rec: &Record, i: usize) -> &FieldRef {
    match &rec.values[i] {
        Value::Field(f) => f,
        _ => unreachable!("checked by Record::new"),
    }
}

fn bytes(rec: &Record, i: usize) -> &[u8] {
    match &rec.values[i] {
        Value::Text(b) | Value::Bytes(b) => b,
        _ => unreachable!("checked by Record::new"),
    }
}

/// A kind whose record is the current value of one key: the entry at `key` points at it.
trait Pointer {
    fn key(&self, rec: &Record) -> Vec<u8>;

    /// Entries besides the pointer, given the record it replaces.
    fn others(
        &self,
        rec: &Record,
        at: Loc,
        old: Option<Loc>,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError>;
}

impl<P: Pointer + Sync> Deriver for P {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let k = self.key(rec);
        let old = view.get(&k)?.map(|b| parse_loc(&b)).transpose()?;
        self.others(rec, at, old, view, out)?;
        if let Some(old) = old {
            dead(out, old);
        }
        out.put(k, loc_bytes(at));
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        let cur = view.get(&self.key(rec))?;
        Ok(cur
            .map(|b| parse_loc(&b))
            .transpose()?
            .is_some_and(|l| l.pos == pos))
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        if self.is_live(rec, from, view)? {
            out.put(self.key(rec), loc_bytes(to));
        }
        Ok(())
    }
}

struct Fav;

impl Pointer for Fav {
    fn key(&self, rec: &Record) -> Vec<u8> {
        key::id(key::FAV, id(rec, 0))
    }

    fn others(
        &self,
        rec: &Record,
        at: Loc,
        _: Option<Loc>,
        _: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        version(out, id(rec, 0), at);
        Ok(())
    }
}

// ---- text ----

/// A text value: its last full value, its size in bytes, and the edits since (count and encoded bytes).
#[derive(Debug, Clone, Copy)]
struct Head {
    full: Loc,
    size: u64,
    edits: u64,
    edit_bytes: u64,
}

impl Head {
    fn bytes(&self) -> Vec<u8> {
        varints(&[
            self.full.pos,
            self.full.len,
            self.size,
            self.edits,
            self.edit_bytes,
        ])
    }

    fn get(view: &View, entity: u64, f: &FieldRef) -> Result<Option<Head>, StoreError> {
        let Some(b) = view.get(&key::field(key::TEXT, entity, f))? else {
            return Ok(None);
        };
        let [pos, len, size, edits, edit_bytes] = parse_varints(&b)?;
        Ok(Some(Head {
            full: Loc { pos, len },
            size,
            edits,
            edit_bytes,
        }))
    }
}

/// The edits since the head's full value, in order.
fn edits(
    view: &View,
    entity: u64,
    f: &FieldRef,
    head: &Head,
) -> Result<Vec<(Vec<u8>, Loc)>, StoreError> {
    let start = key::field(key::TEXT_EDIT, entity, f);
    let end = key::prefix_end(&start);
    let found = view.scan(&start, &end, head.edits as usize)?;
    if found.len() as u64 != head.edits {
        return Err(StoreError::Entry(format!(
            "entity {entity}'s text has {} edit entries, its head says {}",
            found.len(),
            head.edits
        )));
    }
    found
        .into_iter()
        .map(|(k, v)| Ok((k, parse_loc(&v)?)))
        .collect()
}

fn apply_edit(text: &[u8], offset: u64, removed: u64, inserted: &[u8]) -> Option<Vec<u8>> {
    let start = usize::try_from(offset).ok()?;
    let end = start.checked_add(usize::try_from(removed).ok()?)?;
    let kept_after = text.get(end..)?;
    let mut out = Vec::with_capacity(start + inserted.len() + kept_after.len());
    out.extend_from_slice(text.get(..start)?);
    out.extend_from_slice(inserted);
    out.extend_from_slice(kept_after);
    Some(out)
}

/// The text's current value: its full value with the edits since applied.
fn materialize(view: &View, entity: u64, f: &FieldRef, head: &Head) -> Result<Vec<u8>, StoreError> {
    let (full, _) = view.record(head.full.pos)?;
    let mut text = bytes(&full, 2).to_vec();
    for (_, l) in edits(view, entity, f, head)? {
        let (e, _) = view.record(l.pos)?;
        text = apply_edit(&text, id(&e, 2), id(&e, 3), bytes(&e, 4)).ok_or_else(|| {
            StoreError::Entry(format!("an edit of entity {entity}'s text is out of range"))
        })?;
    }
    Ok(text)
}

pub(super) fn text_value(
    view: &View,
    entity: u64,
    f: &FieldRef,
) -> Result<Option<Vec<u8>>, StoreError> {
    match Head::get(view, entity, f)? {
        Some(h) => materialize(view, entity, f, &h).map(Some),
        None => Ok(None),
    }
}

/// Points the text's head or edit entry at `to` if it points at `from`; returns whether one did.
fn repoint_text(
    rec: &Record,
    from: u64,
    to: Option<Loc>,
    view: &View,
    out: &mut Out,
) -> Result<bool, StoreError> {
    let (entity, f) = (id(rec, 0), field(rec, 1));
    let Some(mut head) = Head::get(view, entity, f)? else {
        return Ok(false);
    };
    if head.full.pos == from {
        if let Some(to) = to {
            head.full = to;
            out.put(key::field(key::TEXT, entity, f), head.bytes());
        }
        return Ok(true);
    }
    for (k, l) in edits(view, entity, f, &head)? {
        if l.pos == from {
            if let Some(to) = to {
                // An edit's length counts toward the full-value rule, so the head follows the copy's.
                head.edit_bytes = head.edit_bytes - l.len + to.len;
                out.put(key::field(key::TEXT, entity, f), head.bytes());
                out.put(k, loc_bytes(to));
            }
            return Ok(true);
        }
    }
    Ok(false)
}

struct TextValue;

impl Deriver for TextValue {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (entity, f) = (id(rec, 0), field(rec, 1));
        if let Some(old) = Head::get(view, entity, f)? {
            dead(out, old.full);
            for (k, l) in edits(view, entity, f, &old)? {
                dead(out, l);
                out.del(k);
            }
        }
        let head = Head {
            full: at,
            size: bytes(rec, 2).len() as u64,
            edits: 0,
            edit_bytes: 0,
        };
        out.put(key::field(key::TEXT, entity, f), head.bytes());
        version(out, entity, at);
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        repoint_text(rec, pos, None, view, &mut Out::default())
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_text(rec, from, Some(to), view, out).map(drop)
    }
}

struct TextEdit;

impl Deriver for TextEdit {
    /// Applies the edit to the current value to check it; writes the new full value instead once the edits
    /// since the last one would reach the value's size (design 4.1), so a read stays within about twice it.
    fn prepare(&self, rec: Record, view: &View) -> Result<Record, StoreError> {
        let (entity, f) = (id(&rec, 0), field(&rec, 1).clone());
        let head = Head::get(view, entity, &f)?;
        let current = match &head {
            Some(h) => materialize(view, entity, &f, h)?,
            None => Vec::new(),
        };
        let (offset, removed) = (id(&rec, 2), id(&rec, 3));
        let new = apply_edit(&current, offset, removed, bytes(&rec, 4)).ok_or_else(|| {
            StoreError::Refused(format!(
                "textEdit of entity {entity}: bytes {offset}..{} are outside its {} bytes",
                offset.saturating_add(removed),
                current.len()
            ))
        })?;
        if wtf8_to_utf16(&new).is_err() {
            return Err(StoreError::Refused(format!(
                "textEdit of entity {entity}: an offset falls inside a character"
            )));
        }
        let mut encoded = Vec::new();
        encode(&rec, &mut Ctx::default(), &mut encoded);
        if head.is_none_or(|h| h.edit_bytes + encoded.len() as u64 >= new.len() as u64) {
            return Ok(Record::new(
                kind_by_name("textValue").unwrap(),
                vec![Value::Id(entity), Value::Field(f), Value::Text(new)],
            )
            .expect("a textValue of a textEdit's values"));
        }
        Ok(rec)
    }

    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (entity, f) = (id(rec, 0), field(rec, 1));
        let mut head = Head::get(view, entity, f)?.ok_or_else(|| {
            StoreError::Entry(format!("a textEdit of entity {entity} with no value"))
        })?;
        head.size = head.size.checked_sub(id(rec, 3)).ok_or_else(|| {
            StoreError::Entry(format!(
                "a textEdit of entity {entity} removes more than it has"
            ))
        })? + bytes(rec, 4).len() as u64;
        head.edits += 1;
        head.edit_bytes += at.len;
        out.put(key::edit(entity, f, head.edits), loc_bytes(at));
        out.put(key::field(key::TEXT, entity, f), head.bytes());
        version(out, entity, at);
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        repoint_text(rec, pos, None, view, &mut Out::default())
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        repoint_text(rec, from, Some(to), view, out).map(drop)
    }
}

/// `moved`: points nowhere; replay pairs it with the copy after it.
struct Moved;

impl Deriver for Moved {
    fn derive(&self, _: &Record, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Ok(())
    }

    fn is_live(&self, _: &Record, _: u64, _: &View) -> Result<bool, StoreError> {
        Ok(false)
    }

    fn repoint(&self, _: &Record, _: u64, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Ok(())
    }
}

#[cfg(any(test, feature = "measure"))]
struct TestSet;

#[cfg(any(test, feature = "measure"))]
impl Pointer for TestSet {
    fn key(&self, rec: &Record) -> Vec<u8> {
        key::id(key::TEST_SET, id(rec, 0))
    }

    fn others(
        &self,
        rec: &Record,
        _: Loc,
        old: Option<Loc>,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        let i = id(rec, 0);
        match old {
            Some(old) => {
                let (old, _) = view.record(old.pos)?;
                out.del(key::ids(key::TEST_ORDER, id(&old, 1), i));
            }
            None => out.add(key::of(key::TEST_COUNT), 1),
        }
        out.put(key::ids(key::TEST_ORDER, id(rec, 1), i), Vec::new());
        Ok(())
    }
}

pub fn deriver(kind: &str) -> Option<&'static dyn Deriver> {
    Some(match kind {
        "fav" => &Fav,
        "textValue" => &TextValue,
        "textEdit" => &TextEdit,
        "moved" => &Moved,
        #[cfg(any(test, feature = "measure"))]
        "testSet" => &TestSet,
        _ => return None,
    })
}
