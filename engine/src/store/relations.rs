use std::collections::{BTreeMap, BTreeSet};

use super::StoreError;
use super::books::{self, EntryKey};
use super::counted::{self, Elem, Read, Work};
use super::derive::{Out, View};
use super::kinds::key;
use crate::keyspace::val::{counter_value, get_bytes, get_u64, put_bytes, put_u64};
use crate::log::format::FieldRef;

pub const REL_OF: u64 = 228;
pub const MEMBERS: u64 = 229;
pub const GROUP_COUNT: u64 = 230;

pub const FIELD: &[u8] = b"\x01relations";

pub fn is_field(f: &FieldRef) -> bool {
    matches!(f, FieldRef::Key(k) if k.as_slice() == FIELD)
}

pub fn field() -> FieldRef {
    FieldRef::Key(FIELD.to_vec())
}

fn corrupt(why: &str) -> StoreError {
    StoreError::Entry(format!("relations: {why}"))
}

pub type Set = BTreeMap<(Vec<u8>, Vec<u8>), Vec<u8>>;

pub fn space(book: u64) -> Vec<u8> {
    let mut k = Vec::new();
    put_u64(&mut k, book);
    k
}

pub fn sortable(x: f64) -> u64 {
    let x = if x.is_nan() {
        f64::NAN
    } else if x == 0.0 {
        0.0
    } else {
        x
    };
    let b = x.to_bits();
    if b >> 63 == 1 { !b } else { b | 1 << 63 }
}

pub fn order_value(index: Option<f64>, uid: &EntryKey) -> u64 {
    match (index, uid) {
        (Some(x), _) => sortable(x),
        (None, EntryKey::Int(n)) => sortable(*n as f64),
        (None, EntryKey::Text(_)) => u64::MAX,
    }
}

pub fn elem_of(view: &View, e: u64, uid: &EntryKey) -> Result<Elem, StoreError> {
    Ok(counted::elem(
        order_value(books::entry_index(view, e)?, uid),
        e,
    ))
}

fn rel_of_key(e: u64, r: &[u8], t: &[u8]) -> Vec<u8> {
    let mut k = key::id(REL_OF, e);
    put_bytes(&mut k, r);
    put_bytes(&mut k, t);
    k
}

pub fn members_prefix(book: u64, r: &[u8], t: &[u8]) -> Vec<u8> {
    let mut k = key::id(MEMBERS, book);
    put_bytes(&mut k, r);
    put_bytes(&mut k, t);
    k
}

fn member_key(book: u64, r: &[u8], t: &[u8], p: &[u8], e: u64) -> Vec<u8> {
    let mut k = members_prefix(book, r, t);
    put_bytes(&mut k, p);
    put_u64(&mut k, e);
    k
}

pub fn member_of(prefix: &[u8], k: &[u8]) -> Result<u64, StoreError> {
    let mut at = prefix.len();
    get_bytes(k, &mut at).ok_or_else(|| corrupt("a member key doesn't decode"))?;
    get_u64(k, &mut at).ok_or_else(|| corrupt("a member key doesn't decode"))
}

pub fn group_count_key(book: u64, r: &[u8], t: &[u8]) -> Vec<u8> {
    let mut k = key::id(GROUP_COUNT, book);
    put_bytes(&mut k, r);
    put_bytes(&mut k, t);
    k
}

pub fn group_count(g: &impl Read, book: u64, r: &[u8], t: &[u8]) -> Result<u64, StoreError> {
    match g.read(&group_count_key(book, r, t))? {
        Some(b) => counter_value(&b)
            .and_then(|n| u64::try_from(n).ok())
            .ok_or_else(|| corrupt("a group count doesn't decode")),
        None => Ok(0),
    }
}

fn count_by(w: &mut Work, book: u64, r: &[u8], t: &[u8], n: i64) -> Result<(), StoreError> {
    let k = group_count_key(book, r, t);
    if group_count(w, book, r, t)? as i64 + n == 0 {
        w.del(k);
    } else {
        w.add(k, n);
    }
    Ok(())
}

pub fn rels_of(g: &impl Read, e: u64) -> Result<Set, StoreError> {
    let prefix = key::id(REL_OF, e);
    let mut out = Set::new();
    for (k, v) in g.read_under(&prefix)? {
        let mut at = prefix.len();
        let bad = || corrupt("a relation key doesn't decode");
        let r = get_bytes(&k, &mut at).ok_or_else(bad)?;
        let t = get_bytes(&k, &mut at).ok_or_else(bad)?;
        out.insert((r, t), v);
    }
    Ok(out)
}

pub fn kinds(set: &Set) -> Vec<Vec<u8>> {
    let k: BTreeSet<&Vec<u8>> = set.keys().map(|(r, _)| r).collect();
    k.into_iter().cloned().collect()
}

pub fn written(
    view: &View,
    out: &mut Out,
    book: u64,
    e: u64,
    uid: &EntryKey,
    new: Option<&[u8]>,
) -> Result<(), StoreError> {
    let now = new.map(parse).unwrap_or_default();
    let was = rels_of(view, e)?;
    if now == was {
        return Ok(());
    }
    let mut w = Work::new(view);
    for ((r, t), p) in &was {
        if now.get(&(r.clone(), t.clone())) == Some(p) {
            continue;
        }
        w.del(member_key(book, r, t, p, e));
        if !now.contains_key(&(r.clone(), t.clone())) {
            count_by(&mut w, book, r, t, -1)?;
            w.del(rel_of_key(e, r, t));
        }
    }
    for ((r, t), p) in &now {
        let before = was.get(&(r.clone(), t.clone()));
        if before == Some(p) {
            continue;
        }
        w.put(member_key(book, r, t, p, e), Vec::new());
        w.put(rel_of_key(e, r, t), p.clone());
        if before.is_none() {
            count_by(&mut w, book, r, t, 1)?;
        }
    }
    let (old_kinds, new_kinds) = (kinds(&was), kinds(&now));
    let sp = space(book);
    let x = elem_of(view, e, uid)?;
    for k in old_kinds.iter().filter(|k| !new_kinds.contains(k)) {
        counted::add_kind(&mut w, &sp, &x, k, -1)?;
    }
    for k in new_kinds.iter().filter(|k| !old_kinds.contains(k)) {
        counted::add_kind(&mut w, &sp, &x, k, 1)?;
    }
    w.finish(out);
    Ok(())
}

pub fn entry_created(
    view: &View,
    out: &mut Out,
    book: u64,
    e: u64,
    uid: &EntryKey,
) -> Result<(), StoreError> {
    let mut w = Work::new(view);
    counted::insert(&mut w, &space(book), &elem_of(view, e, uid)?, &[])?;
    w.finish(out);
    Ok(())
}

pub fn entry_gone(
    view: &View,
    out: &mut Out,
    book: u64,
    e: u64,
    uid: &EntryKey,
) -> Result<(), StoreError> {
    let was = rels_of(view, e)?;
    let mut w = Work::new(view);
    counted::remove(&mut w, &space(book), &elem_of(view, e, uid)?, &kinds(&was))?;
    for ((r, t), p) in &was {
        w.del(member_key(book, r, t, p, e));
        count_by(&mut w, book, r, t, -1)?;
        w.del(rel_of_key(e, r, t));
    }
    w.finish(out);
    Ok(())
}

pub fn index_moved(
    view: &View,
    out: &mut Out,
    book: u64,
    e: u64,
    uid: &EntryKey,
    old: Option<f64>,
    new: Option<f64>,
) -> Result<(), StoreError> {
    let (a, b) = (order_value(old, uid), order_value(new, uid));
    if a == b {
        return Ok(());
    }
    let kinds = kinds(&rels_of(view, e)?);
    let sp = space(book);
    let mut w = Work::new(view);
    counted::remove(&mut w, &sp, &counted::elem(a, e), &kinds)?;
    counted::insert(&mut w, &sp, &counted::elem(b, e), &kinds)?;
    w.finish(out);
    Ok(())
}

pub fn cutover_step(
    view: &View,
    out: &mut Out,
    after: Option<&[u8]>,
    batch: usize,
) -> Result<Option<Vec<u8>>, StoreError> {
    let prefix = super::library::entity_key_key(books::ENTRY, b"");
    let prefix = &prefix[..prefix.len() - 2];
    let start = match after {
        Some(a) => {
            let mut k = a.to_vec();
            k.push(0);
            k
        }
        None => prefix.to_vec(),
    };
    let found = view.scan(&start, &key::prefix_end(prefix), batch)?;
    let mut local = std::collections::BTreeMap::new();
    for (k, v) in &found {
        let lv = view.with_layer(&local);
        let mut at = prefix.len();
        let ek = get_bytes(k, &mut at).ok_or_else(|| corrupt("an entry key doesn't decode"))?;
        let Some((book, uid)) = super::book_stats::counted_entry_key(&lv, &ek)? else {
            continue;
        };
        let e = super::library::parse_uvarint(v)?;
        let mut o = Out::default();
        if !counted::contains(&lv, &space(book), &elem_of(&lv, e, &uid)?)? {
            entry_created(&lv, &mut o, book, e, &uid)?;
        }
        out.entries.extend(o.entries.iter().cloned());
        o.apply(&mut local);
        let lv = view.with_layer(&local);
        let json = super::history::json_value(&lv, e, &field())?;
        let mut o = Out::default();
        written(&lv, &mut o, book, e, &uid, json.as_deref())?;
        out.entries.extend(o.entries.iter().cloned());
        o.apply(&mut local);
    }
    Ok((found.len() == batch)
        .then(|| found.last().map(|(k, _)| k.clone()))
        .flatten())
}

pub fn parse(json: &[u8]) -> Set {
    let mut set = Set::new();
    let Some(Json::Arr(items)) = Json::parse(json) else {
        return set;
    };
    for item in items {
        let Json::Obj(fields) = item else {
            return Set::new();
        };
        let get = |name: &str| {
            fields
                .iter()
                .find(|(k, _)| k == name.as_bytes())
                .map(|(_, v)| v)
        };
        let relation = match get("relation") {
            Some(Json::Str(s)) if !s.is_empty() => s.clone(),
            _ => return Set::new(),
        };
        let target = match get("target") {
            Some(Json::Str(s)) if !s.is_empty() => EntryKey::parse(s).text(),
            Some(Json::Num(n)) => match EntryKey::parse(n) {
                k @ EntryKey::Int(_) => k.text(),
                EntryKey::Text(_) => return Set::new(),
            },
            _ => return Set::new(),
        };
        let position = match get("position") {
            Some(Json::Str(s)) => s.clone(),
            _ => return Set::new(),
        };
        set.entry((relation, target)).or_insert(position);
    }
    set
}

#[derive(Debug, Clone, PartialEq)]
enum Json {
    Null,
    Bool,
    Num(Vec<u8>),
    Str(Vec<u8>),
    Arr(Vec<Json>),
    Obj(Vec<(Vec<u8>, Json)>),
}

const MAX_DEPTH: usize = 64;

impl Json {
    fn parse(b: &[u8]) -> Option<Json> {
        let mut p = Parser { b, at: 0 };
        let v = p.value(0)?;
        p.space();
        (p.at == b.len()).then_some(v)
    }
}

struct Parser<'a> {
    b: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn space(&mut self) {
        while matches!(self.b.get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn eat(&mut self, c: u8) -> Option<()> {
        self.space();
        (self.b.get(self.at) == Some(&c)).then(|| self.at += 1)
    }

    fn word(&mut self, w: &[u8]) -> Option<()> {
        self.b[self.at..].starts_with(w).then(|| self.at += w.len())
    }

    fn value(&mut self, depth: usize) -> Option<Json> {
        if depth > MAX_DEPTH {
            return None;
        }
        self.space();
        match *self.b.get(self.at)? {
            b'n' => self.word(b"null").map(|()| Json::Null),
            b't' => self.word(b"true").map(|()| Json::Bool),
            b'f' => self.word(b"false").map(|()| Json::Bool),
            b'"' => self.string().map(Json::Str),
            b'[' => {
                self.at += 1;
                let mut items = Vec::new();
                if self.eat(b']').is_some() {
                    return Some(Json::Arr(items));
                }
                loop {
                    items.push(self.value(depth + 1)?);
                    if self.eat(b']').is_some() {
                        return Some(Json::Arr(items));
                    }
                    self.eat(b',')?;
                }
            }
            b'{' => {
                self.at += 1;
                let mut fields = Vec::new();
                if self.eat(b'}').is_some() {
                    return Some(Json::Obj(fields));
                }
                loop {
                    self.space();
                    let k = self.string()?;
                    self.eat(b':')?;
                    fields.push((k, self.value(depth + 1)?));
                    if self.eat(b'}').is_some() {
                        return Some(Json::Obj(fields));
                    }
                    self.eat(b',')?;
                }
            }
            _ => self.number().map(Json::Num),
        }
    }

    fn number(&mut self) -> Option<Vec<u8>> {
        let start = self.at;
        if self.b.get(self.at) == Some(&b'-') {
            self.at += 1;
        }
        let digits = |p: &mut Self| {
            let s = p.at;
            while p.b.get(p.at).is_some_and(u8::is_ascii_digit) {
                p.at += 1;
            }
            p.at > s
        };
        if self.b.get(self.at) == Some(&b'0') {
            self.at += 1;
        } else if !digits(self) {
            return None;
        }
        if self.b.get(self.at) == Some(&b'.') {
            self.at += 1;
            if !digits(self) {
                return None;
            }
        }
        if matches!(self.b.get(self.at), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.b.get(self.at), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if !digits(self) {
                return None;
            }
        }
        Some(self.b[start..self.at].to_vec())
    }

    fn hex4(&mut self) -> Option<u32> {
        let h = self.b.get(self.at..self.at + 4)?;
        self.at += 4;
        u32::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok()
    }

    fn string(&mut self) -> Option<Vec<u8>> {
        if self.b.get(self.at) != Some(&b'"') {
            return None;
        }
        self.at += 1;
        let mut out = Vec::new();
        loop {
            let c = *self.b.get(self.at)?;
            self.at += 1;
            match c {
                b'"' => return std::str::from_utf8(&out).is_ok().then_some(out),
                b'\\' => {
                    let e = *self.b.get(self.at)?;
                    self.at += 1;
                    let ch = match e {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let hi = self.hex4()?;
                            let cp = if (0xd800..0xdc00).contains(&hi) {
                                self.word(b"\\u")?;
                                let lo = self.hex4()?;
                                if !(0xdc00..0xe000).contains(&lo) {
                                    return None;
                                }
                                0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00)
                            } else {
                                hi
                            };
                            char::from_u32(cp)?
                        }
                        _ => return None,
                    };
                    let mut buf = [0; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                }
                0..0x20 => return None,
                _ => out.push(c),
            }
        }
    }
}
