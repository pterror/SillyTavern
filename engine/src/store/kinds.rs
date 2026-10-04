//! The derivers: current values for `fav`, `textValue` and `textEdit` (with the entity's version), search
//! entries for the text fields that are searched, tag membership for `tagAssign`, a message's record and its
//! chat search entries for `messageAppend`, the cleaner's `moved` marker, and the test kind `testSet`. Each
//! store stage adds its kinds' derivers here.

use super::StoreError;
use super::derive::{Deriver, Loc, Out, View};
use crate::log::FILE_SHIFT;
use crate::log::format::{
    Ctx, FieldRef, Record, Value, encode, get_uvarint, kind_by_name, put_uvarint, wtf8_to_utf16,
};
use crate::search::{self, Scope};

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
    /// Search (`crate::search`).
    pub const SEARCH_POSTING: u64 = 32;
    pub const SEARCH_DOC_FREQ: u64 = 33;
    pub const SEARCH_LENGTH: u64 = 35;
    pub const SEARCH_SHORTEST: u64 = 36;
    pub const SEARCH_FIELD_TOKENS: u64 = 37;
    pub const SEARCH_DOCS: u64 = 38;
    pub const SEARCH_MAX_DOC: u64 = 39;
    pub const SEARCH_FIELD_LENGTH: u64 = 34;
    /// Per (tag, entity): the `tagAssign` record assigning it.
    pub const MEMBER: u64 = 40;
    /// Per (entity, tag): assigned.
    pub const MEMBER_OF: u64 = 41;
    /// Per tag: its entities (a counter).
    pub const MEMBER_COUNT: u64 = 42;
    /// Per message: its `messageAppend` record.
    pub const MESSAGE: u64 = 43;
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
        if let Some(sf) = search_field(f) {
            let old = text_value(view, entity, f)?.unwrap_or_default();
            index_text(view, out, sf, entity, &old, bytes(rec, 2))?;
        }
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
        if let Some(sf) = search_field(f) {
            let old = materialize(view, entity, f, &head)?;
            let new = apply_edit(&old, id(rec, 2), id(rec, 3), bytes(rec, 4)).ok_or_else(|| {
                StoreError::Entry(format!("an edit of entity {entity}'s text is out of range"))
            })?;
            index_text(view, out, sf, entity, &old, &new)?;
        }
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

// ---- search ----

/// A text field that is searched: where, and whether its value is a list of items.
#[derive(Debug, Clone, Copy)]
pub struct SearchField {
    pub scope: Scope,
    pub field: u32,
    pub list: bool,
}

/// Separates a list field's items in its text value (test and measurement builds; the library stage defines
/// how card fields are stored).
pub const ITEM_SEPARATOR: u8 = 0x1e;

/// The searched field a record field is. Card and tag fields get their codes with the library's records; until
/// then only test and measurement builds have any.
pub fn search_field(f: &FieldRef) -> Option<SearchField> {
    #[cfg(any(test, feature = "measure"))]
    if let FieldRef::Code(c) = f {
        return test_codes::field(*c);
    }
    let _ = f;
    None
}

/// The record field a searched field is stored in, the inverse of `search_field`.
pub fn search_code(scope: Scope, field: u32) -> Option<(FieldRef, bool)> {
    #[cfg(any(test, feature = "measure"))]
    return test_codes::code(scope, field);
    #[cfg(not(any(test, feature = "measure")))]
    {
        let _ = (scope, field);
        None
    }
}

#[cfg(any(test, feature = "measure"))]
pub mod test_codes {
    use super::SearchField;
    use crate::log::format::FieldRef;
    use crate::search::Scope;

    /// Library field i is code `LIBRARY + i`; a tag's name is `TAG_NAME`.
    pub const LIBRARY: u64 = 1000;
    pub const TAG_NAME: u64 = 1100;
    pub const ALTERNATE_GREETINGS: u32 = 10;

    pub fn field(c: u64) -> Option<SearchField> {
        if c == TAG_NAME {
            return Some(SearchField {
                scope: Scope::TAGS,
                field: 0,
                list: false,
            });
        }
        let i = u32::try_from(c.checked_sub(LIBRARY)?).ok()?;
        let def = Scope::LIBRARY.fields().get(i as usize)?;
        (!def.joined).then_some(SearchField {
            scope: Scope::LIBRARY,
            field: i,
            list: i == ALTERNATE_GREETINGS,
        })
    }

    pub fn code(scope: Scope, field: u32) -> Option<(FieldRef, bool)> {
        let c = match scope.kind {
            crate::search::TAGS => TAG_NAME,
            crate::search::LIBRARY => LIBRARY + u64::from(field),
            _ => return None,
        };
        let sf = self::field(c)?;
        (sf.scope == scope && sf.field == field).then_some((FieldRef::Code(c), sf.list))
    }
}

fn items(text: &[u8], list: bool) -> Vec<&[u8]> {
    if text.is_empty() {
        Vec::new()
    } else if list {
        text.split(|b| *b == ITEM_SEPARATOR).collect()
    } else {
        vec![text]
    }
}

fn index_text(
    view: &View,
    out: &mut Out,
    sf: SearchField,
    doc: u64,
    old: &[u8],
    new: &[u8],
) -> Result<(), StoreError> {
    search::index::update(
        view,
        out,
        sf.scope,
        doc,
        sf.field,
        &items(old, sf.list),
        &items(new, sf.list),
    )
}

/// A searched field's values, for checking a phrase on them.
pub fn search_texts(
    view: &View,
    scope: Scope,
    doc: u64,
    field: u32,
) -> Result<Vec<Vec<u8>>, StoreError> {
    if scope.kind == search::CHAT {
        let Some(b) = view.get(&key::id(key::MESSAGE, doc))? else {
            return Ok(Vec::new());
        };
        let (rec, _) = view.record(parse_loc(&b)?.pos)?;
        return Ok(if id(&rec, 2) == scope.owner {
            vec![bytes(&rec, 6).to_vec()]
        } else {
            Vec::new()
        });
    }
    let Some((f, list)) = search_code(scope, field) else {
        return Ok(Vec::new());
    };
    let text = text_value(view, doc, &f)?.unwrap_or_default();
    Ok(items(&text, list).into_iter().map(<[u8]>::to_vec).collect())
}

// ---- tag membership ----

/// `tagAssign`: the record assigning a tag to an entity is the (tag, entity) membership entry's value; an
/// unassignment removes the entry and points at nothing.
struct TagAssign;

fn member_key(rec: &Record) -> Vec<u8> {
    key::ids(key::MEMBER, id(rec, 1), id(rec, 0))
}

impl Deriver for TagAssign {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (entity, tag) = (id(rec, 0), id(rec, 1));
        let k = member_key(rec);
        let old = view.get(&k)?.map(|b| parse_loc(&b)).transpose()?;
        if let Some(old) = old {
            dead(out, old);
        }
        if rec.values[2] == Value::Bit(true) {
            if old.is_none() {
                out.put(key::ids(key::MEMBER_OF, entity, tag), Vec::new());
                out.add(key::id(key::MEMBER_COUNT, tag), 1);
            }
            out.put(k, loc_bytes(at));
        } else {
            dead(out, at);
            if old.is_some() {
                out.del(key::ids(key::MEMBER_OF, entity, tag));
                out.add(key::id(key::MEMBER_COUNT, tag), -1);
                out.del(k);
            }
        }
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        Ok(view
            .get(&member_key(rec))?
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
            out.put(member_key(rec), loc_bytes(to));
        }
        Ok(())
    }
}

// ---- messages ----

/// `messageAppend`: the message's record, and its text in its owner's chat search.
struct MessageAppend;

impl Pointer for MessageAppend {
    fn key(&self, rec: &Record) -> Vec<u8> {
        key::id(key::MESSAGE, id(rec, 0))
    }

    fn others(
        &self,
        rec: &Record,
        _: Loc,
        old: Option<Loc>,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        let doc = id(rec, 0);
        let (owner, text) = (id(rec, 2), bytes(rec, 6));
        if let Some(old) = old {
            let (prev, _) = view.record(old.pos)?;
            let prev_owner = id(&prev, 2);
            if prev_owner != owner {
                search::index::update(
                    view,
                    out,
                    Scope::chat(prev_owner),
                    doc,
                    0,
                    &items(bytes(&prev, 6), false),
                    &[],
                )?;
            } else {
                return search::index::update(
                    view,
                    out,
                    Scope::chat(owner),
                    doc,
                    0,
                    &items(bytes(&prev, 6), false),
                    &items(text, false),
                );
            }
        }
        search::index::update(
            view,
            out,
            Scope::chat(owner),
            doc,
            0,
            &[],
            &items(text, false),
        )
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
        "tagAssign" => &TagAssign,
        "messageAppend" => &MessageAppend,
        "moved" => &Moved,
        #[cfg(any(test, feature = "measure"))]
        "testSet" => &TestSet,
        _ => return None,
    })
}
