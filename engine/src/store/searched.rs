use super::StoreError;
use super::books::{BOOK, ENTRY, OWNED, parse_entry_key};
use super::derive::{Out, View};
use super::kinds::{bytes, key, parse_loc, text_value};
use super::library::{self, CHARACTER, GROUP, ITEM_BASE, LISTS, TAG, entity_info};
use crate::log::format::FieldRef;
use crate::search::{self, Scope};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Text(u64),
    List(u64),
    Key,
    Uid,
}

#[derive(Debug, Clone, Copy)]
pub struct Def {
    pub field: u32,
    pub source: Source,
}

const fn def(field: u32, source: Source) -> Def {
    Def { field, source }
}

const NAME: u64 = 1;
const CREATOR: u64 = 2;
const DESCRIPTION: u64 = 10;
const PERSONALITY: u64 = 11;
const SCENARIO: u64 = 12;
const FIRST_MES: u64 = 13;
const MES_EXAMPLE: u64 = 14;
const CREATOR_NOTES: u64 = 15;
const ALTERNATE_GREETINGS: u64 = 0;
const CARD_TAGS: u64 = 2;
const MEMBERS: u64 = 3;
const ENTRY_UID: u64 = 100;
const ENTRY_COMMENT: u64 = 103;
const ENTRY_CONTENT: u64 = 104;
const ENTRY_GROUP: u64 = 127;
const ENTRY_AUTOMATION_ID: u64 = 134;
const ENTRY_ID: u64 = 153;
const EXT_GROUP: u64 = 170;
const EXT_AUTOMATION_ID: u64 = 177;
const ENTRY_NO_UID: u64 = 97;
const ENTRY_KEY: u64 = 0;
const ENTRY_KEYSECONDARY: u64 = 1;
const ENTRY_KEYS: u64 = 3;
const ENTRY_SECONDARY_KEYS: u64 = 4;

static CHARACTER_DEFS: &[Def] = &[
    def(0, Source::Text(NAME)),
    def(1, Source::Text(DESCRIPTION)),
    def(2, Source::Text(MES_EXAMPLE)),
    def(3, Source::Text(SCENARIO)),
    def(4, Source::Text(PERSONALITY)),
    def(5, Source::Text(FIRST_MES)),
    def(6, Source::Text(CREATOR_NOTES)),
    def(7, Source::Text(CREATOR)),
    def(8, Source::List(CARD_TAGS)),
    def(9, Source::List(ALTERNATE_GREETINGS)),
];

static GROUP_DEFS: &[Def] = &[
    def(0, Source::Text(NAME)),
    def(10, Source::List(MEMBERS)),
    def(11, Source::Key),
];

static TAG_DEFS: &[Def] = &[def(0, Source::Text(NAME))];

static WORLD_ENTRY_DEFS: &[Def] = &[
    def(0, Source::List(ENTRY_KEY)),
    def(1, Source::Text(ENTRY_GROUP)),
    def(2, Source::Text(ENTRY_COMMENT)),
    def(3, Source::List(ENTRY_KEYSECONDARY)),
    def(4, Source::Text(ENTRY_CONTENT)),
    def(5, Source::Uid),
    def(6, Source::Text(ENTRY_AUTOMATION_ID)),
];

static OWNED_ENTRY_DEFS: &[Def] = &[
    def(0, Source::List(ENTRY_KEYS)),
    def(1, Source::Text(EXT_GROUP)),
    def(2, Source::Text(ENTRY_COMMENT)),
    def(3, Source::List(ENTRY_SECONDARY_KEYS)),
    def(4, Source::Text(ENTRY_CONTENT)),
    def(5, Source::Uid),
    def(6, Source::Text(EXT_AUTOMATION_ID)),
];

#[derive(Clone, Copy)]
pub struct Searched {
    pub scope: Scope,
    pub defs: &'static [Def],
    world: bool,
}

fn of(view: &View, e: u64) -> Result<Option<(Vec<u8>, Searched)>, StoreError> {
    let Some((kind, k, _)) = entity_info(view, e)? else {
        return Ok(None);
    };
    let m = marked(view, kind, e)?;
    Ok(searched(view, kind, &k, m)?.map(|s| (k, s)))
}

pub fn marked(view: &View, kind: u64, e: u64) -> Result<bool, StoreError> {
    Ok(kind == TAG
        && super::tags::has_marker(view, e)?
        && view.get(&key::id(key::MERGE, e))?.is_none())
}

pub fn searched(
    view: &View,
    kind: u64,
    k: &[u8],
    marked: bool,
) -> Result<Option<Searched>, StoreError> {
    let (scope, defs, world) = match kind {
        CHARACTER => (Scope::LIBRARY, CHARACTER_DEFS, false),
        GROUP => (Scope::LIBRARY, GROUP_DEFS, false),
        TAG if !marked => return Ok(None),
        TAG => (Scope::TAGS, TAG_DEFS, false),
        ENTRY => {
            let (book, _) = parse_entry_key(k)?;
            match entity_info(view, book)? {
                Some((BOOK, _, _)) => (Scope::book(book), WORLD_ENTRY_DEFS, true),
                Some((OWNED, bk, _)) if bk.ends_with(b":c") => {
                    (Scope::book(book), OWNED_ENTRY_DEFS, false)
                }
                _ => return Ok(None),
            }
        }
        _ => return Ok(None),
    };
    Ok(Some(Searched { scope, defs, world }))
}

fn item_of(f: &FieldRef) -> Option<(u64, u64)> {
    match f {
        FieldRef::Code(c) if *c >= ITEM_BASE => {
            Some(((c - ITEM_BASE) % LISTS, (c - ITEM_BASE) / LISTS))
        }
        _ => None,
    }
}

fn list_items(
    view: &View,
    e: u64,
    list: u64,
    but: Option<u64>,
) -> Result<Vec<Vec<u8>>, StoreError> {
    let start = key::field(key::HEAD, e, &FieldRef::Code(ITEM_BASE));
    let end = key::prefix_end(&key::id(key::HEAD, e));
    let mut out = Vec::new();
    for (k, _) in view.scan(&start, &end, usize::MAX)? {
        let f = library::field_after(&k, key::HEAD)?;
        if let Some((l, item)) = item_of(&f)
            && l == list
            && Some(item) != but
            && let Some(t) = text_value(view, e, &f)?
        {
            out.push(t);
        }
    }
    Ok(out)
}

fn json_value(view: &View, e: u64, code: u64) -> Result<Option<Vec<u8>>, StoreError> {
    super::history::json_value(view, e, &FieldRef::Code(code))
}

fn uid_from(stored: Option<Vec<u8>>, no_uid: bool, k: &[u8], world: bool) -> Vec<Vec<u8>> {
    match stored {
        Some(j) => vec![j],
        None if world && !no_uid => parse_entry_key(k)
            .map(|(_, ek)| vec![ek.text()])
            .unwrap_or_default(),
        None => Vec::new(),
    }
}

fn uid_code(world: bool) -> u64 {
    if world { ENTRY_UID } else { ENTRY_ID }
}

fn uid_now(view: &View, e: u64, k: &[u8], world: bool) -> Result<Vec<Vec<u8>>, StoreError> {
    let no_uid = world && json_value(view, e, ENTRY_NO_UID)?.is_some();
    Ok(uid_from(
        json_value(view, e, uid_code(world))?,
        no_uid,
        k,
        world,
    ))
}

fn current(
    view: &View,
    e: u64,
    k: &[u8],
    s: &Searched,
    d: &Def,
) -> Result<Vec<Vec<u8>>, StoreError> {
    Ok(match d.source {
        Source::Text(c) => text_value(view, e, &FieldRef::Code(c))?
            .into_iter()
            .collect(),
        Source::List(l) => list_items(view, e, l, None)?,
        Source::Key => vec![k.to_vec()],
        Source::Uid => uid_now(view, e, k, s.world)?,
    })
}

fn refs(v: &[Vec<u8>]) -> Vec<&[u8]> {
    v.iter().map(Vec::as_slice).collect()
}

fn update(
    view: &View,
    out: &mut Out,
    scope: Scope,
    doc: u64,
    field: u32,
    old: &[Vec<u8>],
    new: &[Vec<u8>],
) -> Result<(), StoreError> {
    search::index::update(view, out, scope, doc, field, &refs(old), &refs(new))
}

fn whole(
    view: &View,
    out: &mut Out,
    scope: Scope,
    doc: u64,
    fields: &[(u32, Vec<Vec<u8>>)],
    on: bool,
) -> Result<(), StoreError> {
    let values: Vec<(u32, Vec<&[u8]>)> = fields
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(f, v)| (*f, refs(v)))
        .collect();
    let fields: Vec<search::index::FieldValues> =
        values.iter().map(|(f, v)| (*f, v.as_slice())).collect();
    search::index::whole(view, out, scope, doc, &fields, on)
}

pub fn text_written(
    view: &View,
    out: &mut Out,
    e: u64,
    f: &FieldRef,
    old: Option<&[u8]>,
    new: Option<&[u8]>,
) -> Result<(), StoreError> {
    let Some((_, s)) = of(view, e)? else {
        #[cfg(any(test, feature = "measure"))]
        if let Some(sf) = super::kinds::test_codes::field(f) {
            return super::kinds::index_test_text(
                view,
                out,
                sf,
                e,
                old.unwrap_or_default(),
                new.unwrap_or_default(),
            );
        }
        return Ok(());
    };
    let one = |t: Option<&[u8]>| t.map(<[u8]>::to_vec).into_iter().collect::<Vec<_>>();
    for d in s.defs {
        match d.source {
            Source::Text(c) if *f == FieldRef::Code(c) => {
                return update(view, out, s.scope, e, d.field, &one(old), &one(new));
            }
            Source::List(l) => {
                if let Some((list, item)) = item_of(f)
                    && list == l
                {
                    let others = list_items(view, e, l, Some(item))?;
                    let with = |t: Option<&[u8]>| {
                        let mut v = others.clone();
                        v.extend(one(t));
                        v
                    };
                    return update(view, out, s.scope, e, d.field, &with(old), &with(new));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

pub fn wants(view: &View, e: u64, f: &FieldRef) -> Result<bool, StoreError> {
    let Some((_, s)) = of(view, e)? else {
        #[cfg(any(test, feature = "measure"))]
        return Ok(super::kinds::test_codes::field(f).is_some());
        #[cfg(not(any(test, feature = "measure")))]
        return Ok(false);
    };
    Ok(s.defs.iter().any(|d| match d.source {
        Source::Text(c) => *f == FieldRef::Code(c),
        Source::List(l) => item_of(f).is_some_and(|(list, _)| list == l),
        _ => false,
    }))
}

pub fn json_written(
    view: &View,
    out: &mut Out,
    e: u64,
    f: &FieldRef,
    new: Option<&[u8]>,
) -> Result<(), StoreError> {
    super::book_stats::value_changed(view, out, e, f, true, new)?;
    let FieldRef::Code(code) = f else {
        return Ok(());
    };
    if ![ENTRY_UID, ENTRY_ID, ENTRY_NO_UID].contains(code) {
        return Ok(());
    }
    let Some((k, s)) = of(view, e)? else {
        return Ok(());
    };
    let Some(d) = s.defs.iter().find(|d| d.source == Source::Uid) else {
        return Ok(());
    };
    let uc = uid_code(s.world);
    if *code != uc && !(s.world && *code == ENTRY_NO_UID) {
        return Ok(());
    }
    let old = uid_now(view, e, &k, s.world)?;
    let stored = if *code == uc {
        new.map(<[u8]>::to_vec)
    } else {
        json_value(view, e, uc)?
    };
    let no_uid = if *code == ENTRY_NO_UID {
        new.is_some()
    } else {
        s.world && json_value(view, e, ENTRY_NO_UID)?.is_some()
    };
    let new = uid_from(stored, no_uid, &k, s.world);
    if old != new {
        update(view, out, s.scope, e, d.field, &old, &new)?;
    }
    Ok(())
}

pub fn created(
    view: &View,
    out: &mut Out,
    e: u64,
    kind: u64,
    k: &[u8],
    marked: bool,
) -> Result<(), StoreError> {
    let Some(s) = searched(view, kind, k, marked)? else {
        return Ok(());
    };
    let mut now = Vec::new();
    for d in s.defs {
        now.push((d.field, current(view, e, k, &s, d)?));
    }
    whole(view, out, s.scope, e, &now, true)
}

pub fn gone(view: &View, out: &mut Out, e: u64, kind: u64, k: &[u8]) -> Result<(), StoreError> {
    let Some(s) = searched(view, kind, k, marked(view, kind, e)?)? else {
        return Ok(());
    };
    let mut was = Vec::new();
    for d in s.defs {
        was.push((d.field, current(view, e, k, &s, d)?));
    }
    whole(view, out, s.scope, e, &was, false)
}

pub fn rekeyed(
    view: &View,
    out: &mut Out,
    e: u64,
    kind: u64,
    old: &[u8],
    new: &[u8],
) -> Result<(), StoreError> {
    let Some(s) = searched(view, kind, old, marked(view, kind, e)?)? else {
        return Ok(());
    };
    for d in s.defs.iter().filter(|d| d.source == Source::Key) {
        update(
            view,
            out,
            s.scope,
            e,
            d.field,
            &[old.to_vec()],
            &[new.to_vec()],
        )?;
    }
    Ok(())
}

pub fn session_named(
    view: &View,
    out: &mut Out,
    session: u64,
    old: Option<&[u8]>,
    new: Option<&[u8]>,
) -> Result<(), StoreError> {
    let one = |t: Option<&[u8]>| t.map(<[u8]>::to_vec).into_iter().collect::<Vec<_>>();
    update(view, out, Scope::SESSIONS, session, 0, &one(old), &one(new))
}

pub fn position_name(view: &View, p: u64) -> Result<Option<Vec<u8>>, StoreError> {
    let Some(b) = view.get(&key::id(key::POSITION_NAME, p))? else {
        return Ok(None);
    };
    let (rec, _) = view.record(parse_loc(&b)?.pos)?;
    Ok(Some(bytes(&rec, 1).to_vec()))
}

pub fn texts(view: &View, scope: Scope, doc: u64, field: u32) -> Result<Vec<Vec<u8>>, StoreError> {
    if scope.kind == search::SESSIONS {
        return Ok(position_name(view, doc)?.into_iter().collect());
    }
    let Some((k, s)) = of(view, doc)? else {
        #[cfg(any(test, feature = "measure"))]
        return super::kinds::test_texts(view, scope, doc, field);
        #[cfg(not(any(test, feature = "measure")))]
        return Ok(Vec::new());
    };
    if s.scope != scope {
        return Ok(Vec::new());
    }
    match s.defs.iter().find(|d| d.field == field) {
        Some(d) => current(view, doc, &k, &s, d),
        None => Ok(Vec::new()),
    }
}
