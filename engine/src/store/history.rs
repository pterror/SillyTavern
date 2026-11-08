use std::collections::BTreeMap;

use super::StoreError;
use super::books::{self, ENTRIES, ENTRY, LINKS};
use super::chat_read::Js;
use super::derive::{Deriver, Loc, Out, View};
use super::kinds::{
    Cur, Head, Holder, apply_edit, bytes, dead, field, id, key, loc_bytes, parse_loc,
    parse_varints, repoint_text_of, text_of, varints, version, version_gone,
};
use super::library::{
    self, ITEM_BASE, LISTS, entity_info, entity_key_key, host_bytes, item_field, parse_host,
    parse_place, parse_uvarint, place_bytes, uvarint,
};
use super::sessions::check_actor;
use super::state::{CHANGE, NEXT_CHANGE, change_loc};
use crate::keyspace::val::{Val, get_bytes, get_u64, max_value, put_bytes, put_u64};
use crate::log::format::{
    Ctx, FieldRef, Record, Value, encode, get_uvarint, kind_by_name, wtf8_to_utf16,
};

pub const HIST: u64 = 210;
pub const JSON_EDIT: u64 = 212;
pub const GONE: u64 = 213;
pub const DELETED: u64 = 214;
pub const MARKS: u64 = 215;
pub const FORGET: u64 = 216;
pub const KEEP: u64 = 217;

pub const FORGET_SLICE: usize = 256;

fn refused(why: String) -> StoreError {
    StoreError::Refused(why)
}

fn corrupt(why: &str) -> StoreError {
    StoreError::Entry(format!("history: {why}"))
}

type Part = u8;
const VALUES: Part = 0;
const PLACES: Part = 1;

fn put_slot(k: &mut Vec<u8>, slot: Option<&FieldRef>) {
    match slot {
        None => k.push(0),
        Some(FieldRef::Code(c)) => {
            k.push(1);
            put_u64(k, *c);
        }
        Some(FieldRef::Key(b)) => {
            k.push(2);
            put_bytes(k, b);
        }
    }
}

fn slot_prefix(e: u64, slot: Option<&FieldRef>) -> Vec<u8> {
    let mut k = key::id(HIST, e);
    put_slot(&mut k, slot);
    k
}

fn part_prefix(e: u64, slot: Option<&FieldRef>, part: Part) -> Vec<u8> {
    let mut k = slot_prefix(e, slot);
    k.push(part);
    k
}

fn hist_key(e: u64, slot: Option<&FieldRef>, part: Part, c: u64) -> Vec<u8> {
    let mut k = part_prefix(e, slot, part);
    put_u64(&mut k, c);
    k
}

fn parse_hist(e: u64, k: &[u8]) -> Result<(Option<FieldRef>, Part, u64), StoreError> {
    let mut at = key::id(HIST, e).len();
    let bad = || corrupt("a history key doesn't decode");
    let slot = match k.get(at) {
        Some(0) => {
            at += 1;
            None
        }
        Some(1) => {
            at += 1;
            Some(FieldRef::Code(get_u64(k, &mut at).ok_or_else(bad)?))
        }
        Some(2) => {
            at += 1;
            Some(FieldRef::Key(get_bytes(k, &mut at).ok_or_else(bad)?))
        }
        _ => return Err(bad()),
    };
    let part = *k.get(at).ok_or_else(bad)?;
    at += 1;
    let c = get_u64(k, &mut at).ok_or_else(bad)?;
    Ok((slot, part, c))
}

fn keep_key(e: u64, slot: Option<&FieldRef>) -> Vec<u8> {
    let mut k = key::id(KEEP, e);
    put_slot(&mut k, slot);
    k
}

fn json_key(e: u64, f: &FieldRef) -> Vec<u8> {
    key::field(key::HEAD, e, f)
}

pub fn json_edit_key(e: u64, f: &FieldRef, n: u64) -> Vec<u8> {
    let mut k = key::field(JSON_EDIT, e, f);
    put_u64(&mut k, n);
    k
}

fn change_key(c: u64) -> Vec<u8> {
    key::id(CHANGE, c)
}

fn marker_of(b: &[u8]) -> Result<Option<u64>, StoreError> {
    if b.is_empty() {
        Ok(None)
    } else {
        Ok(Some(parse_uvarint(b)?))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Family {
    Value,
    Place,
    Entity,
    Forget,
}

fn family(rec: &Record) -> Option<Family> {
    Some(match rec.kind.name {
        "histSet" | "histEdit" | "histDelete" => Family::Value,
        "histPlace" => Family::Place,
        "histEntityDelete" | "histRestore" => Family::Entity,
        "histForget" => Family::Forget,
        _ => return None,
    })
}

fn part_of(fam: Family) -> Part {
    if fam == Family::Place { PLACES } else { VALUES }
}

#[derive(Debug, Clone, PartialEq)]
struct Meta {
    id: Option<u64>,
    time: i64,
    session: Option<u64>,
    user: Option<u64>,
}

fn meta_slots(kind: &str) -> Option<[usize; 4]> {
    Some(match kind {
        "histSet" | "histPlace" | "histRestore" | "histForget" => [4, 5, 6, 7],
        "histEdit" => [6, 7, 8, 9],
        "histDelete" => [2, 3, 4, 5],
        "histEntityDelete" => [1, 2, 3, 4],
        "histRevert" => [3, 4, 5, 6],
        _ => return None,
    })
}

impl Meta {
    fn of(rec: &Record) -> Meta {
        let [i, t, s, u] = meta_slots(rec.kind.name).expect("a history kind");
        let opt = |i: usize| match rec.values[i] {
            Value::Id(v) => Some(v),
            _ => None,
        };
        Meta {
            id: opt(i),
            time: match rec.values[t] {
                Value::Time(t) => t,
                _ => 0,
            },
            session: opt(s),
            user: opt(u),
        }
    }

    fn change(&self) -> u64 {
        self.id.expect("a change record has an id")
    }

    fn values(&self) -> [Value; 4] {
        [
            Value::Id(self.change()),
            Value::Time(self.time),
            self.session.map_or(Value::Absent, Value::Id),
            self.user.map_or(Value::Absent, Value::Id),
        ]
    }
}

fn record(kind: &str, mut head: Vec<Value>, m: &Meta) -> Record {
    head.extend(m.values());
    Record::new(kind_by_name(kind).expect("a history kind"), head).expect("a history record")
}

fn set_record(e: u64, f: &FieldRef, json: bool, v: Vec<u8>, m: &Meta) -> Record {
    record(
        "histSet",
        vec![
            Value::Id(e),
            Value::Field(f.clone()),
            Value::Text(v),
            Value::Bit(json),
        ],
        m,
    )
}

fn edit_record(e: u64, f: &FieldRef, json: bool, edit: (u64, u64, Vec<u8>), m: &Meta) -> Record {
    record(
        "histEdit",
        vec![
            Value::Id(e),
            Value::Field(f.clone()),
            Value::UInt(edit.0),
            Value::UInt(edit.1),
            Value::Text(edit.2),
            Value::Bit(json),
        ],
        m,
    )
}

fn delete_record(e: u64, f: &FieldRef, m: &Meta) -> Record {
    record("histDelete", vec![Value::Id(e), Value::Field(f.clone())], m)
}

fn place_record(e: u64, list: u64, item: u64, position: Option<u64>, m: &Meta) -> Record {
    record(
        "histPlace",
        vec![
            Value::Id(e),
            Value::UInt(list),
            Value::UInt(item),
            position.map_or(Value::Absent, Value::UInt),
        ],
        m,
    )
}

fn bit(rec: &Record, i: usize) -> bool {
    rec.values[i] == Value::Bit(true)
}

fn opt_uint(rec: &Record, i: usize) -> Option<u64> {
    match rec.values[i] {
        Value::UInt(v) => Some(v),
        _ => None,
    }
}

fn slot_of(rec: &Record) -> Option<FieldRef> {
    match family(rec) {
        Some(Family::Value) => Some(field(rec, 1).clone()),
        Some(Family::Place) => Some(item_field(id(rec, 1), id(rec, 2))),
        _ => None,
    }
}

fn read_at(view: &View, extra: Option<(u64, &Record)>, l: Loc) -> Result<Record, StoreError> {
    match extra {
        Some((p, r)) if p == l.pos => Ok(r.clone()),
        _ => Ok(view.record(l.pos)?.0),
    }
}

fn encoded_len(rec: &Record) -> u64 {
    let mut b = Vec::new();
    encode(rec, &mut Ctx::default(), &mut b);
    b.len() as u64
}

pub fn one_edit(before: &[u8], after: &[u8]) -> (u64, u64, Vec<u8>) {
    let cont = |b: Option<&u8>| b.is_some_and(|b| (0x80..0xc0).contains(b));
    let max = before.len().min(after.len());
    let mut start = 0;
    while start < max && before[start] == after[start] {
        start += 1;
    }
    while start > 0 && (cont(before.get(start)) || cont(after.get(start))) {
        start -= 1;
    }
    let mut end = 0;
    while end < max - start && before[before.len() - 1 - end] == after[after.len() - 1 - end] {
        end += 1;
    }
    while end > 0 && cont(before.get(before.len() - end)) {
        end -= 1;
    }
    (
        start as u64,
        (before.len() - end - start) as u64,
        after[start..after.len() - end].to_vec(),
    )
}

fn walk_back(
    view: &View,
    e: u64,
    slot: Option<&FieldRef>,
    part: Part,
    end: Option<u64>,
    page: usize,
    mut each: impl FnMut(u64, Option<u64>) -> Result<bool, StoreError>,
) -> Result<(), StoreError> {
    let p = part_prefix(e, slot, part);
    let mut to = match end {
        Some(c) => hist_key(e, slot, part, c),
        None => key::prefix_end(&p),
    };
    loop {
        let found = view.scan_vals_rev(&p, &to, page)?;
        let full = found.len() == page;
        for (k, v) in &found {
            let (_, _, c) = parse_hist(e, k)?;
            if !each(c, marker_of(&v.clone().into_bytes(k))?)? {
                return Ok(());
            }
        }
        match found.last() {
            Some((k, _)) if full => to = k.clone(),
            _ => return Ok(()),
        }
    }
}

fn latest(
    view: &View,
    e: u64,
    slot: Option<&FieldRef>,
    part: Part,
) -> Result<Option<(u64, Option<u64>)>, StoreError> {
    let mut last = None;
    walk_back(view, e, slot, part, None, 1, |c, m| {
        last = Some((c, m));
        Ok(false)
    })?;
    Ok(last)
}

fn change(view: &View, extra: Option<(u64, &Record)>, c: u64) -> Result<(Loc, Record), StoreError> {
    let l = change_loc(view, c)?.ok_or_else(|| corrupt("a change in the history has no record"))?;
    Ok((l, read_at(view, extra, l)?))
}

fn slots(view: &View, e: u64) -> Result<Vec<Option<FieldRef>>, StoreError> {
    let hp = key::id(HIST, e);
    let end = key::prefix_end(&hp);
    let mut from = hp;
    let mut out = Vec::new();
    while let Some((hk, _)) = view.scan(&from, &end, 1)?.into_iter().next() {
        let (slot, _, _) = parse_hist(e, &hk)?;
        from = key::prefix_end(&slot_prefix(e, slot.as_ref()));
        out.push(slot);
    }
    Ok(out)
}

pub type Got = Option<(bool, Vec<u8>)>;

struct Chain {
    base: Option<(Loc, Record)>,
    edits: Vec<(Loc, Record)>,
}

impl Chain {
    fn json(&self) -> bool {
        self.base.as_ref().is_some_and(|(_, r)| bit(r, 3))
    }

    fn value(&self) -> Result<Got, StoreError> {
        let Some((_, base)) = &self.base else {
            return Ok(None);
        };
        let mut v = bytes(base, 2).to_vec();
        for (_, e) in &self.edits {
            v = apply_edit(&v, id(e, 2), id(e, 3), bytes(e, 4))
                .ok_or_else(|| corrupt("an edit is out of range"))?;
        }
        Ok(Some((self.json(), v)))
    }

    fn edit_bytes(&self) -> u64 {
        self.edits.iter().map(|(l, _)| l.len).sum()
    }
}

fn chain_before(
    view: &View,
    extra: Option<(u64, &Record)>,
    e: u64,
    f: &FieldRef,
    end: Option<u64>,
) -> Result<Chain, StoreError> {
    let mut edits = Vec::new();
    let mut base = None;
    let mut err = None;
    walk_back(view, e, Some(f), VALUES, end, 32, |c, marker| {
        if marker.is_some() {
            return Ok(true);
        }
        let (l, r) = change(view, extra, c)?;
        match r.kind.name {
            "histEdit" => {
                edits.push((l, r));
                Ok(true)
            }
            "histSet" => {
                base = Some((l, r));
                Ok(false)
            }
            "histDelete" => Ok(false),
            _ => {
                err = Some(corrupt("a field's value history holds another kind"));
                Ok(false)
            }
        }
    })?;
    if let Some(e) = err {
        return Err(e);
    }
    if base.is_none() && !edits.is_empty() {
        return Err(corrupt("an edit of no value"));
    }
    edits.reverse();
    if let Some((_, b)) = &base
        && edits.iter().any(|(_, r)| bit(r, 5) != bit(b, 3))
    {
        return Err(corrupt("an edit of a value of the other type"));
    }
    Ok(Chain { base, edits })
}

fn value_at(view: &View, e: u64, f: &FieldRef, c: u64) -> Result<Got, StoreError> {
    chain_before(view, None, e, f, Some(c + 1))?.value()
}

fn json_of_head(view: &View, e: u64, f: &FieldRef, head: &Head) -> Result<Vec<u8>, StoreError> {
    let (full, _) = view.record(head.full.pos)?;
    let mut v = bytes(&full, 2).to_vec();
    for n in 1..=head.edits() {
        let l = parse_loc(
            &view
                .get(&json_edit_key(e, f, n))?
                .ok_or_else(|| corrupt("a JSON head misses an edit"))?,
        )?;
        let (r, _) = view.record(l.pos)?;
        v = apply_edit(&v, id(&r, 2), id(&r, 3), bytes(&r, 4))
            .ok_or_else(|| corrupt("an edit is out of range"))?;
    }
    Ok(v)
}

fn json_head(view: &View, e: u64, f: &FieldRef) -> Result<Option<Head>, StoreError> {
    Ok(match Cur::get(view, e, f)? {
        Some(Cur::Json(h)) => Some(h),
        _ => None,
    })
}

pub(super) fn value_of(
    view: &View,
    e: u64,
    f: &FieldRef,
    cur: &Cur,
) -> Result<(bool, Vec<u8>), StoreError> {
    Ok(match cur {
        Cur::Text(h) => (false, text_of(view, e, f, h)?),
        Cur::Json(h) => (true, json_of_head(view, e, f, h)?),
        Cur::Whole(l) => {
            let (rec, _) = view.record(l.pos)?;
            (true, bytes(&rec, 2).to_vec())
        }
    })
}

pub fn json_value(view: &View, e: u64, f: &FieldRef) -> Result<Option<Vec<u8>>, StoreError> {
    match Cur::get(view, e, f)? {
        Some(cur @ (Cur::Json(_) | Cur::Whole(_))) => Ok(Some(value_of(view, e, f, &cur)?.1)),
        Some(Cur::Text(_)) | None => Ok(None),
    }
}

fn current(view: &View, e: u64, f: &FieldRef) -> Result<Got, StoreError> {
    Cur::get(view, e, f)?
        .map(|cur| value_of(view, e, f, &cur))
        .transpose()
}

fn head_edit_bytes(view: &View, e: u64, f: &FieldRef) -> Result<u64, StoreError> {
    Ok(match Cur::get(view, e, f)? {
        Some(Cur::Text(h) | Cur::Json(h)) => h.edit_bytes(),
        Some(Cur::Whole(_)) | None => 0,
    })
}

fn value_record(e: u64, f: &FieldRef, base: &Got, base_bytes: u64, new: &Got, m: &Meta) -> Record {
    let Some((json, v)) = new else {
        return delete_record(e, f, m);
    };
    if let Some((bj, bv)) = base
        && bj == json
    {
        let edit = edit_record(e, f, *json, one_edit(bv, v), m);
        if base_bytes + encoded_len(&edit) < v.len() as u64 {
            return edit;
        }
    }
    set_record(e, f, *json, v.clone(), m)
}

fn set_head(
    view: &View,
    out: &mut Out,
    e: u64,
    f: &FieldRef,
    chain: &Chain,
) -> Result<(), StoreError> {
    let h = Holder::Entity(e);
    let json = chain.json();
    let edit_key = |is_json: bool, n: u64| {
        if is_json {
            json_edit_key(e, f, n)
        } else {
            h.edit_key(f, n)
        }
    };
    let mut in_place: Vec<Option<Loc>> = Vec::new();
    let cur = Cur::get(view, e, f)?;
    let old = match cur {
        Some(Cur::Text(old)) => Some((false, old)),
        Some(Cur::Json(old)) => Some((true, old)),
        Some(Cur::Whole(l)) => {
            dead(out, l);
            None
        }
        None => None,
    };
    if let Some((is_json, old)) = old {
        let kept = chain.base.is_some() && is_json == json;
        for n in 1..=old.edits() {
            let k = edit_key(is_json, n);
            if kept && n as usize <= chain.edits.len() {
                in_place.push(view.get(&k)?.map(|b| parse_loc(&b)).transpose()?);
                continue;
            }
            out.del(k);
        }
    }
    let Some((base, _)) = &chain.base else {
        if cur.is_some() {
            out.del(h.text_key(f));
        }
        return Ok(());
    };
    let size = chain.value()?.map_or(0, |(_, v)| v.len() as u64);
    let n = chain.edits.len() as u64;
    let head = Head::with_edits(*base, size, n, chain.edit_bytes());
    out.put(
        h.text_key(f),
        if json {
            Cur::Json(head)
        } else {
            Cur::Text(head)
        }
        .bytes(),
    );
    for (i, (l, _)) in chain.edits.iter().enumerate() {
        if in_place
            .get(i)
            .copied()
            .flatten()
            .is_some_and(|o| o.pos == l.pos)
        {
            continue;
        }
        out.put(edit_key(json, i as u64 + 1), loc_bytes(*l));
    }
    Ok(())
}

fn drop_head(view: &View, out: &mut Out, e: u64, f: &FieldRef) -> Result<(), StoreError> {
    let none = Chain {
        base: None,
        edits: Vec::new(),
    };
    set_head(view, out, e, f, &none)
}

fn changed(
    view: &View,
    out: &mut Out,
    e: u64,
    f: &FieldRef,
    old: &Got,
    new: &Got,
    at: Loc,
) -> Result<(), StoreError> {
    let text = |g: &Got| g.as_ref().filter(|(j, _)| !j).map(|(_, v)| v.clone());
    let json = |g: &Got| g.as_ref().filter(|(j, _)| *j).map(|(_, v)| v.clone());
    let (ot, nt) = (text(old), text(new));
    if ot != nt {
        if super::searched::wants(view, e, f)? {
            super::searched::text_written(view, out, e, f, ot.as_deref(), nt.as_deref())?;
        }
        if nt.is_none() {
            super::book_stats::value_changed(view, out, e, f, false, None)?;
        }
        library::text_changed(view, out, e, f, nt.as_deref())?;
        let w = match &nt {
            Some(t) => super::tags::Written::Text(t),
            None => super::tags::Written::Gone,
        };
        super::tags::field_written(view, out, e, at, f, w)?;
    }
    let (oj, nj) = (json(old), json(new));
    if oj != nj {
        super::searched::json_written(view, out, e, f, nj.as_deref())?;
        books::field_written(view, out, e, f, nj.is_some())?;
        let w = match &nj {
            Some(j) => super::tags::Written::Json(j),
            None => super::tags::Written::Gone,
        };
        super::tags::field_written(view, out, e, at, f, w)?;
    }
    Ok(())
}

fn item_at_key(e: u64, list: u64, item: u64) -> Vec<u8> {
    let mut k = key::ids(key::ITEM_AT, e, list);
    put_u64(&mut k, item);
    k
}

fn item_key(e: u64, list: u64, position: u64) -> Vec<u8> {
    let mut k = key::ids(key::ITEM, e, list);
    put_u64(&mut k, position);
    k
}

fn item_of(f: &FieldRef) -> Option<(u64, u64)> {
    match f {
        FieldRef::Code(c) if *c >= ITEM_BASE => {
            Some(((c - ITEM_BASE) % LISTS, (c - ITEM_BASE) / LISTS))
        }
        _ => None,
    }
}

fn latest_place(
    view: &View,
    extra: Option<(u64, &Record)>,
    e: u64,
    f: &FieldRef,
) -> Result<Option<(Loc, Option<u64>)>, StoreError> {
    let Some((c, None)) = latest(view, e, Some(f), PLACES)? else {
        return Ok(None);
    };
    let (l, r) = change(view, extra, c)?;
    Ok(Some((l, opt_uint(&r, 3))))
}

fn set_place(
    view: &View,
    out: &mut Out,
    e: u64,
    list: u64,
    item: u64,
    latest: Option<(Loc, Option<u64>)>,
) -> Result<(), StoreError> {
    let ak = item_at_key(e, list, item);
    let was = view.get(&ak)?.map(|b| parse_place(&b)).transpose()?;
    let new = latest.and_then(|(l, p)| p.map(|p| (p, l)));
    if was.map(|(p, _)| p) == new.map(|(p, _)| p) {
        if let Some((p, l)) = new {
            out.put(ak, place_bytes(p, l));
        }
        return Ok(());
    }
    if list == LINKS {
        match new {
            Some(_) => books::link_placed(view, out, e, item, was.is_some())?,
            None if was.is_some() => books::link_deleted(view, out, e, item)?,
            None => {}
        }
    }
    if let Some((p, _)) = was {
        out.del(item_key(e, list, p));
    }
    match new {
        Some((p, l)) => {
            let ik = item_key(e, list, p);
            if let Some(b) = view.get(&ik)?
                && parse_uvarint(&b)? != item
            {
                return Err(refused(format!(
                    "position {p} of list {list} holds another item"
                )));
            }
            out.put(ik, uvarint(item));
            out.put(ak, place_bytes(p, l));
        }
        None => out.del(ak),
    }
    Ok(())
}

fn gone(view: &View, e: u64) -> Result<Option<[u64; 3]>, StoreError> {
    view.get(&key::id(GONE, e))?
        .map(|b| parse_varints::<3>(&b))
        .transpose()
}

fn refuse_gone(view: &View, e: u64) -> Result<(), StoreError> {
    if gone(view, e)?.is_some() {
        return Err(refused(format!("entity {e} is deleted: restore it first")));
    }
    Ok(())
}

pub fn gone_at(view: &View, e: u64, pos: u64) -> Result<bool, StoreError> {
    Ok(gone(view, e)?.is_some_and(|[p, _, _]| p == pos))
}

pub fn repoint_gone(
    view: &View,
    out: &mut Out,
    e: u64,
    from: u64,
    to: Loc,
) -> Result<(), StoreError> {
    if let Some([p, _, d]) = gone(view, e)?
        && p == from
    {
        out.put(key::id(GONE, e), varints(&[to.pos, to.len, d]));
    }
    Ok(())
}

fn deleted_key(book: u64, e: u64) -> Vec<u8> {
    key::ids(DELETED, book, e)
}

fn place_change(
    view: &View,
    out: &mut Out,
    e: u64,
    slot: Option<&FieldRef>,
    fam: Family,
    c: u64,
) -> Result<bool, StoreError> {
    match change_loc(view, c)? {
        Some(l) => {
            let (old, _) = view.record(l.pos)?;
            if family(&old) != Some(fam) || id(&old, 0) != e || slot_of(&old).as_ref() != slot {
                return Err(refused(format!("change {c} exists")));
            }
            dead(out, l);
            Ok(true)
        }
        None => {
            if let Some((last, _)) = latest(view, e, slot, part_of(fam))?
                && last >= c
            {
                return Err(refused(format!(
                    "change {c} is older than change {last} of the same field"
                )));
            }
            Ok(false)
        }
    }
}

fn file(
    out: &mut Out,
    local: &mut BTreeMap<Vec<u8>, Val>,
    e: u64,
    slot: Option<&FieldRef>,
    fam: Family,
    c: u64,
    at: Loc,
) {
    let mut o = Out::default();
    o.put(change_key(c), loc_bytes(at));
    o.put(hist_key(e, slot, part_of(fam), c), Vec::new());
    o.max(key::of(NEXT_CHANGE), c + 1);
    out.entries.extend(o.entries.iter().cloned());
    o.apply(local);
}

#[derive(Debug, Clone)]
struct Forgetting {
    upto: u64,
    at: Loc,
    marker: Option<u64>,
    cursor: Vec<u8>,
}

impl Forgetting {
    fn bytes(&self) -> Vec<u8> {
        let mut b = varints(&[
            self.upto,
            self.at.pos,
            self.at.len,
            self.marker.map_or(0, |m| m + 1),
        ]);
        b.extend_from_slice(&self.cursor);
        b
    }

    fn parse(b: &[u8]) -> Result<Forgetting, StoreError> {
        let mut at = 0;
        let mut next = || get_uvarint(b, &mut at).map_err(|_| corrupt("a forget doesn't decode"));
        let (upto, pos, len, m) = (next()?, next()?, next()?, next()?);
        Ok(Forgetting {
            upto,
            at: Loc { pos, len },
            marker: m.checked_sub(1),
            cursor: b[at..].to_vec(),
        })
    }
}

fn pending_forget(view: &View, e: u64) -> Result<Option<Forgetting>, StoreError> {
    view.get(&key::id(FORGET, e))?
        .map(|b| Forgetting::parse(&b))
        .transpose()
}

fn keep_bytes(keep: &[(Part, u64)]) -> Vec<u8> {
    let mut b = Vec::new();
    for (p, c) in keep {
        b.push(*p);
        crate::log::format::put_uvarint(&mut b, *c);
    }
    b
}

fn parse_keep(b: &[u8]) -> Result<Vec<(Part, u64)>, StoreError> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < b.len() {
        let p = b[at];
        at += 1;
        let c = get_uvarint(b, &mut at).map_err(|_| corrupt("a keep list doesn't decode"))?;
        out.push((p, c));
    }
    Ok(out)
}

type Kept = Option<Vec<(Part, u64)>>;

fn kept(view: &View, e: u64, slot: Option<&FieldRef>) -> Result<Kept, StoreError> {
    view.get(&keep_key(e, slot))?
        .map(|b| parse_keep(&b))
        .transpose()
}

fn hidden(
    view: &View,
    e: u64,
    f: &Option<Forgetting>,
    slot: Option<&FieldRef>,
    part: Part,
    c: u64,
) -> Result<bool, StoreError> {
    let Some(f) = f else { return Ok(false) };
    Ok(c < f.upto && kept(view, e, slot)?.is_some_and(|k| !k.contains(&(part, c))))
}

fn entry_of(
    view: &View,
    e: u64,
    slot: Option<&FieldRef>,
    c: u64,
) -> Result<Option<(Part, Option<u64>)>, StoreError> {
    for part in [VALUES, PLACES] {
        if let Some(b) = view.get(&hist_key(e, slot, part, c))? {
            return Ok(Some((part, marker_of(&b)?)));
        }
    }
    Ok(None)
}

struct ValueChange;

impl Deriver for ValueChange {
    fn prepares(&self) -> bool {
        true
    }

    fn prepare(&self, rec: Record, view: &View) -> Result<Record, StoreError> {
        let (e, f) = (id(&rec, 0), field(&rec, 1).clone());
        let m = Meta::of(&rec);
        if change_loc(view, m.change())?.is_some() {
            return Err(refused(format!("change {} exists", m.change())));
        }
        refuse_gone(view, e)?;
        let cur = current(view, e, &f)?;
        let new: Got = match rec.kind.name {
            "histSet" => Some((bit(&rec, 3), bytes(&rec, 2).to_vec())),
            "histDelete" => None,
            _ => {
                let json = bit(&rec, 5);
                let Some((cj, cv)) = &cur else {
                    return Err(refused(format!(
                        "an edit of entity {e}'s field with no value"
                    )));
                };
                if *cj != json {
                    return Err(refused(format!(
                        "an edit of entity {e}'s field as the other type"
                    )));
                }
                let (offset, removed) = (id(&rec, 2), id(&rec, 3));
                let v = apply_edit(cv, offset, removed, bytes(&rec, 4)).ok_or_else(|| {
                    refused(format!(
                        "an edit of entity {e}: bytes {offset}..{} are outside its {} bytes",
                        offset.saturating_add(removed),
                        cv.len()
                    ))
                })?;
                if wtf8_to_utf16(&v).is_err() {
                    return Err(refused(format!(
                        "an edit of entity {e}: an offset falls inside a character"
                    )));
                }
                Some((json, v))
            }
        };
        if new == cur {
            return Err(refused(format!(
                "a change of entity {e} that changes nothing"
            )));
        }
        if rec.kind.name == "histEdit" {
            let bytes = head_edit_bytes(view, e, &f)?;
            return Ok(value_record(e, &f, &cur, bytes, &new, &m));
        }
        Ok(rec)
    }

    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (e, f) = (id(rec, 0), field(rec, 1).clone());
        let m = Meta::of(rec);
        check_actor(view, m.session, m.user)?;
        let replaces = place_change(view, out, e, Some(&f), Family::Value, m.change())?;
        let mut local = BTreeMap::new();
        file(out, &mut local, e, Some(&f), Family::Value, m.change(), at);
        if gone(view, e)?.is_some() {
            return if replaces {
                Ok(())
            } else {
                refuse_gone(view, e)
            };
        }
        let lv = view.with_layer(&local);
        let chain = chain_before(&lv, Some((at.pos, rec)), e, &f, None)?;
        let new = chain.value()?;
        let old = current(view, e, &f)?;
        if old != new {
            changed(view, out, e, &f, &old, &new, at)?;
        }
        set_head(view, out, e, &f, &chain)?;
        if !replaces || old != new {
            version(view, out, e, at)?;
            books::touched(view, out, e, at)?;
        }
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        Ok(change_loc(view, Meta::of(rec).change())?.is_some_and(|l| l.pos == pos))
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        let c = Meta::of(rec).change();
        if !change_loc(view, c)?.is_some_and(|l| l.pos == from) {
            return Ok(());
        }
        out.put(change_key(c), loc_bytes(to));
        let (e, f) = (id(rec, 0), field(rec, 1));
        if repoint_text_of(Holder::Entity(e), f, from, Some(to), view, out)? {
            return Ok(());
        }
        let Some(mut head) = json_head(view, e, f)? else {
            return Ok(());
        };
        if head.full.pos == from {
            head.full = to;
            out.put(json_key(e, f), Cur::Json(head).bytes());
            return Ok(());
        }
        for n in 1..=head.edits() {
            let k = json_edit_key(e, f, n);
            if let Some(b) = view.get(&k)?
                && let old = parse_loc(&b)?
                && old.pos == from
            {
                let bytes = head.edit_bytes() - old.len + to.len;
                let h = Head::with_edits(head.full, head.size(), head.edits(), bytes);
                out.put(json_key(e, f), Cur::Json(h).bytes());
                out.put(k, loc_bytes(to));
                return Ok(());
            }
        }
        Ok(())
    }
}

struct PlaceChange;

impl Deriver for PlaceChange {
    fn prepares(&self) -> bool {
        true
    }

    fn prepare(&self, rec: Record, view: &View) -> Result<Record, StoreError> {
        let (e, list, item) = (id(&rec, 0), id(&rec, 1), id(&rec, 2));
        let m = Meta::of(&rec);
        if change_loc(view, m.change())?.is_some() {
            return Err(refused(format!("change {} exists", m.change())));
        }
        refuse_gone(view, e)?;
        if list >= LISTS {
            return Err(refused(format!("no list {list}")));
        }
        let position = opt_uint(&rec, 3);
        let now = view
            .get(&item_at_key(e, list, item))?
            .map(|b| parse_place(&b))
            .transpose()?;
        if now.map(|(p, _)| p) == position {
            return Err(refused(format!(
                "a change of entity {e} that changes nothing"
            )));
        }
        Ok(rec)
    }

    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (e, list, item) = (id(rec, 0), id(rec, 1), id(rec, 2));
        let f = item_field(list, item);
        let m = Meta::of(rec);
        check_actor(view, m.session, m.user)?;
        refuse_gone(view, e)?;
        if list >= LISTS {
            return Err(refused(format!("no list {list}")));
        }
        place_change(view, out, e, Some(&f), Family::Place, m.change())?;
        let mut local = BTreeMap::new();
        file(out, &mut local, e, Some(&f), Family::Place, m.change(), at);
        let lv = view.with_layer(&local);
        let latest = latest_place(&lv, Some((at.pos, rec)), e, &f)?;
        set_place(view, out, e, list, item, latest)?;
        version(view, out, e, at)?;
        books::touched(view, out, e, at)
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        Ok(change_loc(view, Meta::of(rec).change())?.is_some_and(|l| l.pos == pos))
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        let c = Meta::of(rec).change();
        if !change_loc(view, c)?.is_some_and(|l| l.pos == from) {
            return Ok(());
        }
        out.put(change_key(c), loc_bytes(to));
        let ak = item_at_key(id(rec, 0), id(rec, 1), id(rec, 2));
        if let Some(b) = view.get(&ak)? {
            let (p, l) = parse_place(&b)?;
            if l.pos == from {
                out.put(ak, place_bytes(p, to));
            }
        }
        Ok(())
    }
}

struct EntityDelete;

impl Deriver for EntityDelete {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let e = id(rec, 0);
        let m = Meta::of(rec);
        check_actor(view, m.session, m.user)?;
        let Some((kind, k, _)) = entity_info(view, e)? else {
            return Err(refused(format!("no entity {e}")));
        };
        if !library::history_kept(kind) {
            return Err(refused(format!(
                "entity {e} is of type {kind}: only a world-info entry or a settings entity is deleted with its history kept"
            )));
        }
        place_change(view, out, e, None, Family::Entity, m.change())?;
        if kind == ENTRY {
            let (book, _) = books::parse_entry_key(&k)?;
            let place = view
                .get(&item_at_key(book, ENTRIES, e))?
                .map(|b| parse_place(&b))
                .transpose()?
                .map(|(p, _)| p);
            let index = books::entry_index(view, e)?;
            let flags = u64::from(place.is_some()) | (u64::from(index.is_some()) << 1);
            out.put(
                deleted_key(book, e),
                varints(&[flags, place.unwrap_or(0), index.map_or(0, f64::to_bits)]),
            );
        }
        let made = take_down(view, out, e, kind, &k, at)?;
        out.put(key::id(GONE, e), varints(&[made.pos, made.len, at.pos]));
        let mut local = BTreeMap::new();
        file(out, &mut local, e, None, Family::Entity, m.change(), at);
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        Ok(change_loc(view, Meta::of(rec).change())?.is_some_and(|l| l.pos == pos))
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        let c = Meta::of(rec).change();
        if change_loc(view, c)?.is_some_and(|l| l.pos == from) {
            out.put(change_key(c), loc_bytes(to));
        }
        Ok(())
    }
}

fn take_down(
    view: &View,
    out: &mut Out,
    e: u64,
    kind: u64,
    k: &[u8],
    at: Loc,
) -> Result<Loc, StoreError> {
    super::searched::gone(view, out, e, kind, k)?;
    super::book_stats::gone(view, out, e, kind, k)?;
    super::tags::entity_gone(view, out, e)?;
    super::local_import::entity_gone(view, out, e)?;
    super::choices::holder_gone(view, out, e)?;
    if kind == ENTRY {
        books::touched(view, out, e, at)?;
        books::entry_gone(view, out, e, k)?;
    }
    let p = key::id(key::HEAD, e);
    for (vk, v) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        if matches!(Cur::parse(&v)?, Cur::Whole(_)) {
            continue;
        }
        drop_head(view, out, e, &library::field_after(&vk, key::HEAD)?)?;
    }
    let ap = key::id(key::ITEM_AT, e);
    for (ak, _) in view.scan(&ap, &key::prefix_end(&ap), usize::MAX)? {
        out.del(ak);
    }
    let ip = key::id(key::ITEM, e);
    for (ik, _) in view.scan(&ip, &key::prefix_end(&ip), usize::MAX)? {
        out.del(ik);
    }
    let ek = key::id(key::ENTITY, e);
    let host = view
        .get(&ek)?
        .ok_or_else(|| corrupt("an entity without its entry"))?;
    let (made, _) = parse_host(&host)?;
    out.del(ek);
    out.del(entity_key_key(kind, k));
    version_gone(view, out, e, kind, k, at)?;
    Ok(made)
}

fn held_by_its_change(view: &View, l: Loc) -> Result<bool, StoreError> {
    let (r, _) = view.record(l.pos)?;
    Ok(family(&r) == Some(Family::Entity)
        && change_loc(view, Meta::of(&r).change())?.is_some_and(|c| c.pos == l.pos))
}

pub fn erase(view: &View, out: &mut Out, e: u64, at: Loc) -> Result<bool, StoreError> {
    let made = match entity_info(view, e)? {
        Some((kind, k, _)) if library::history_kept(kind) => take_down(view, out, e, kind, &k, at)?,
        Some(_) => return Ok(false),
        None => {
            let Some([pos, len, _]) = gone(view, e)? else {
                return Ok(false);
            };
            let made = Loc { pos, len };
            let (was, _) = view.record(made.pos)?;
            if id(&was, 1) == ENTRY {
                let (book, _) = books::parse_entry_key(bytes(&was, 2))?;
                out.del(deleted_key(book, e));
                super::relations::deleted_entry_erased(view, out, e)?;
                super::relations::removed_by_deletion_of_erased(view, out, book, e)?;
            }
            out.del(key::id(GONE, e));
            made
        }
    };
    if !held_by_its_change(view, made)? {
        dead(out, made);
    }
    let p = key::id(key::HEAD, e);
    for (vk, v) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        if let Cur::Whole(l) = Cur::parse(&v)? {
            dead(out, l);
            out.del(vk);
        }
    }
    let slots = slots(view, e)?;
    if slots.is_empty() {
        dead(out, at);
        return Ok(true);
    }
    for slot in &slots {
        out.put(keep_key(e, slot.as_ref()), Vec::new());
    }
    let upto = view
        .get(&key::of(NEXT_CHANGE))?
        .and_then(|b| max_value(&b))
        .unwrap_or(0);
    let f = match pending_forget(view, e)? {
        Some(f) => {
            dead(out, at);
            Forgetting {
                upto,
                cursor: key::id(HIST, e),
                ..f
            }
        }
        None => Forgetting {
            upto,
            at,
            marker: None,
            cursor: key::id(HIST, e),
        },
    };
    out.put(key::id(FORGET, e), f.bytes());
    Ok(true)
}

pub fn erasing_at(view: &View, e: u64, pos: u64) -> Result<bool, StoreError> {
    Ok(pending_forget(view, e)?.is_some_and(|f| f.at.pos == pos))
}

pub fn repoint_erasing(
    view: &View,
    out: &mut Out,
    e: u64,
    from: u64,
    to: Loc,
) -> Result<(), StoreError> {
    if let Some(mut f) = pending_forget(view, e)?
        && f.at.pos == from
    {
        f.at = to;
        out.put(key::id(FORGET, e), f.bytes());
    }
    Ok(())
}

struct Restore;

impl Deriver for Restore {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (e, kind, k) = (id(rec, 0), id(rec, 1), bytes(rec, 2).to_vec());
        let m = Meta::of(rec);
        check_actor(view, m.session, m.user)?;
        let Some([gp, _, deleted_at]) = gone(view, e)? else {
            return Err(refused(format!("entity {e} isn't deleted")));
        };
        let (was, _) = view.record(gp)?;
        if id(&was, 1) != kind || !library::history_kept(kind) {
            return Err(refused(format!(
                "entity {e} was of type {}, not {kind}",
                id(&was, 1)
            )));
        }
        let book = if kind == ENTRY {
            let (book, _) = books::parse_entry_key(&k)?;
            let (from, _) = books::parse_entry_key(bytes(&was, 2))?;
            if book != from {
                return Err(refused(format!("entry {e} is of book {from}, not {book}")));
            }
            Some(book)
        } else {
            None
        };
        if view.get(&entity_key_key(kind, &k))?.is_some() {
            return Err(refused(format!(
                "an entity of type {kind} has that key already"
            )));
        }
        place_change(view, out, e, None, Family::Entity, m.change())?;
        if kind == ENTRY {
            books::entry_created(view, out, &k)?;
        }
        let mut local = BTreeMap::new();
        let mut o = Out::default();
        o.put(key::id(key::ENTITY, e), host_bytes(at, None));
        o.put(entity_key_key(kind, &k), uvarint(e));
        o.del(key::id(GONE, e));
        if let Some(book) = book {
            o.del(deleted_key(book, e));
        }
        o.del(key::ids(key::ENTITY_CHANGE, deleted_at, e));
        out.entries.extend(o.entries.iter().cloned());
        o.apply(&mut local);
        file(out, &mut local, e, None, Family::Entity, m.change(), at);
        for slot in slots(view, e)? {
            let Some(f) = slot else { continue };
            let lv = view.with_layer(&local);
            let mut o = Out::default();
            set_head(&lv, &mut o, e, &f, &chain_before(&lv, None, e, &f, None)?)?;
            if let Some((list, item)) = item_of(&f) {
                let place = latest_place(&lv, None, e, &f)?;
                set_place(&lv, &mut o, e, list, item, place)?;
            }
            out.entries.extend(o.entries.iter().cloned());
            o.apply(&mut local);
        }
        let lv = view.with_layer(&local);
        super::searched::created(&lv, out, e, kind, &k, false)?;
        super::book_stats::created(&lv, out, e, kind, &k)?;
        version(&lv, out, e, at)?;
        books::container_touched(&lv, out, kind, &k, at)
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        let e = id(rec, 0);
        Ok(
            change_loc(view, Meta::of(rec).change())?.is_some_and(|l| l.pos == pos)
                || library::live_host(view, &key::id(key::ENTITY, e), pos)?
                || gone_at(view, e, pos)?,
        )
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        let (e, c) = (id(rec, 0), Meta::of(rec).change());
        if change_loc(view, c)?.is_some_and(|l| l.pos == from) {
            out.put(change_key(c), loc_bytes(to));
        }
        library::repoint_host(view, out, &key::id(key::ENTITY, e), from, to)?;
        repoint_gone(view, out, e, from, to)
    }
}

struct Revert;

impl Deriver for Revert {
    fn prepares(&self) -> bool {
        true
    }

    fn prepare(&self, rec: Record, view: &View) -> Result<Record, StoreError> {
        let (e, f, target) = (id(&rec, 0), field(&rec, 1).clone(), id(&rec, 2));
        let m = Meta::of(&rec);
        if change_loc(view, m.change())?.is_some() {
            return Err(refused(format!("change {} exists", m.change())));
        }
        refuse_gone(view, e)?;
        let no_change = || refused(format!("entity {e}'s field has no change {target}"));
        let Some((part, None)) = entry_of(view, e, Some(&f), target)? else {
            return Err(no_change());
        };
        if hidden(view, e, &pending_forget(view, e)?, Some(&f), part, target)? {
            return Err(no_change());
        }
        let (_, t) = change(view, None, target)?;
        let made = match family(&t) {
            Some(Family::Value) => {
                let want = value_at(view, e, &f, target)?;
                let cur = current(view, e, &f)?;
                if want == cur {
                    return Err(refused(format!(
                        "entity {e}'s field is as change {target} left it"
                    )));
                }
                value_record(e, &f, &cur, head_edit_bytes(view, e, &f)?, &want, &m)
            }
            Some(Family::Place) => {
                let (list, item) = (id(&t, 1), id(&t, 2));
                place_record(e, list, item, opt_uint(&t, 3), &m)
            }
            _ => return Err(no_change()),
        };
        deriver(made.kind.name)
            .expect("a history kind")
            .prepare(made, view)
    }

    fn derive(&self, _: &Record, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Err(refused(
            "histRevert is logged as the change it makes".into(),
        ))
    }

    fn is_live(&self, _: &Record, _: u64, _: &View) -> Result<bool, StoreError> {
        Ok(false)
    }

    fn repoint(&self, _: &Record, _: u64, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Ok(())
    }
}

#[derive(Default)]
struct Marks(BTreeMap<u64, i64>);

impl Marks {
    fn add(&mut self, m: u64, n: i64) {
        *self.0.entry(m).or_default() += n;
    }

    fn settle(self, view: &View, out: &mut Out) -> Result<(), StoreError> {
        for (m, d) in self.0 {
            if d == 0 {
                continue;
            }
            let k = key::id(MARKS, m);
            out.add(k.clone(), d);
            if library::counter(view, &k)? + d == 0 {
                if let Some(l) = change_loc(view, m)? {
                    dead(out, l);
                }
                out.del(change_key(m));
                out.del(k);
            }
        }
        Ok(())
    }
}

struct Entry<'a> {
    e: u64,
    slot: Option<&'a FieldRef>,
    part: Part,
    c: u64,
    old: Option<u64>,
}

fn forget_one(
    view: &View,
    out: &mut Out,
    marks: &mut Marks,
    entry: Entry,
    marker: Option<u64>,
) -> Result<(), StoreError> {
    let Entry {
        e,
        slot,
        part,
        c,
        old,
    } = entry;
    match old {
        Some(o) => marks.add(o, -1),
        None => {
            if let Some(l) = change_loc(view, c)? {
                let pointed = slot.is_none()
                    && (library::live_host(view, &key::id(key::ENTITY, e), l.pos)?
                        || gone_at(view, e, l.pos)?);
                if !pointed {
                    dead(out, l);
                }
            }
            out.del(change_key(c));
        }
    }
    match marker {
        Some(m) => {
            marks.add(m, 1);
            out.put(hist_key(e, slot, part, c), uvarint(m));
        }
        None => out.del(hist_key(e, slot, part, c)),
    }
    Ok(())
}

struct Summary {
    keep: Vec<(Part, u64)>,
    first: Option<(Part, u64, Option<u64>)>,
}

fn summarize(
    view: &View,
    e: u64,
    slot: Option<&FieldRef>,
    upto: u64,
) -> Result<Summary, StoreError> {
    let mut keep = Vec::new();
    let mut first: Option<(Part, u64, Option<u64>)> = None;
    for part in [VALUES, PLACES] {
        let Some((last, _)) = latest(view, e, slot, part)? else {
            continue;
        };
        keep.push((part, last));
        let p = part_prefix(e, slot, part);
        if let Some((k, v)) = view.scan(&p, &key::prefix_end(&p), 1)?.into_iter().next() {
            let (_, _, c) = parse_hist(e, &k)?;
            if c != last && c < upto && first.is_none_or(|(_, fc, _)| c < fc) {
                first = Some((part, c, marker_of(&v)?));
            }
        }
    }
    Ok(Summary { keep, first })
}

struct Forget;

struct Forgets {
    e: u64,
    what: Option<Option<FieldRef>>,
    target: Option<u64>,
    marker: Option<u64>,
}

fn forget_parts(rec: &Record) -> Result<Forgets, StoreError> {
    let e = id(rec, 0);
    let f = match &rec.values[1] {
        Value::Field(f) => Some(f.clone()),
        _ => None,
    };
    let target = match rec.values[2] {
        Value::Id(t) => Some(t),
        _ => None,
    };
    let marker = Meta::of(rec).id;
    if bit(rec, 3) != marker.is_some() {
        return Err(refused(
            "a forget has an id exactly when it leaves a marker".into(),
        ));
    }
    let what = match (f, target) {
        (f, Some(_)) => Some(f),
        (None, None) => None,
        (Some(_), None) => return Err(refused("a forget of a field names its change".into())),
    };
    Ok(Forgets {
        e,
        what,
        target,
        marker,
    })
}

impl Deriver for Forget {
    fn prepares(&self) -> bool {
        true
    }

    fn expand(&self, rec: Record, view: &View) -> Result<Vec<Record>, StoreError> {
        let Forgets {
            e,
            what,
            target,
            marker,
        } = forget_parts(&rec)?;
        if let Some(m) = marker
            && change_loc(view, m)?.is_some()
        {
            return Err(refused(format!("change {m} exists")));
        }
        if pending_forget(view, e)?.is_some() {
            return Err(refused(format!(
                "entity {e}'s history is being forgotten already"
            )));
        }
        let mut out = vec![rec];
        let Some(slot) = what else {
            for slot in slots(view, e)? {
                let Some(f) = &slot else { continue };
                let Some((c, None)) = latest(view, e, Some(f), VALUES)? else {
                    continue;
                };
                let (_, r) = change(view, None, c)?;
                if r.kind.name == "histEdit" {
                    let (json, v) =
                        value_at(view, e, f, c)?.ok_or_else(|| corrupt("an edit of no value"))?;
                    out.push(set_record(e, f, json, v, &Meta::of(&r)));
                }
            }
            return Ok(out);
        };
        let c = target.expect("a target");
        let Some((part, old)) = entry_of(view, e, slot.as_ref(), c)? else {
            return Err(refused(format!("entity {e} has no change {c} there")));
        };
        if old.is_some() {
            return Ok(out);
        }
        if latest(view, e, slot.as_ref(), part)?.map(|(l, _)| l) == Some(c) {
            return Err(refused(format!(
                "change {c} is the current one: it can't be forgotten"
            )));
        }
        if let (VALUES, Some(f)) = (part, &slot) {
            let p = part_prefix(e, Some(f), VALUES);
            let mut from = hist_key(e, Some(f), VALUES, c + 1);
            let mut next = None;
            'scan: loop {
                let found = view.scan(&from, &key::prefix_end(&p), 32)?;
                for (k, v) in &found {
                    let (_, _, nc) = parse_hist(e, k)?;
                    if v.is_empty() {
                        next = Some(change(view, None, nc)?.1);
                        break 'scan;
                    }
                }
                match found.last() {
                    Some((k, _)) if found.len() == 32 => {
                        from = k.clone();
                        from.push(0);
                    }
                    _ => break,
                }
            }
            if let Some(r) = next
                && r.kind.name == "histEdit"
            {
                let before = chain_before(view, None, e, f, Some(c))?;
                let want = value_at(view, e, f, Meta::of(&r).change())?;
                let base = before.value()?;
                out.push(value_record(
                    e,
                    f,
                    &base,
                    before.edit_bytes(),
                    &want,
                    &Meta::of(&r),
                ));
            }
        }
        Ok(out)
    }

    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let Forgets {
            e,
            what,
            target,
            marker,
        } = forget_parts(rec)?;
        let m = Meta::of(rec);
        check_actor(view, m.session, m.user)?;
        if pending_forget(view, e)?.is_some() {
            return Err(refused(format!(
                "entity {e}'s history is being forgotten already"
            )));
        }
        let mut marks = Marks::default();
        if let Some(mk) = marker {
            out.put(change_key(mk), loc_bytes(at));
            out.max(key::of(NEXT_CHANGE), mk + 1);
        }
        let Some(slot) = what else {
            let upto = view
                .get(&key::of(NEXT_CHANGE))?
                .and_then(|b| max_value(&b))
                .unwrap_or(0);
            let mut any = false;
            for slot in slots(view, e)? {
                let Summary { mut keep, first } = summarize(view, e, slot.as_ref(), upto)?;
                let Some((part, c, old)) = first else {
                    continue;
                };
                any = true;
                if let Some(mk) = marker {
                    if let Some(o) = old {
                        marks.add(o, -1);
                    }
                    marks.add(mk, 1);
                    out.put(hist_key(e, slot.as_ref(), part, c), uvarint(mk));
                    keep.push((part, c));
                }
                out.put(keep_key(e, slot.as_ref()), keep_bytes(&keep));
            }
            if any {
                let f = Forgetting {
                    upto,
                    at,
                    marker,
                    cursor: key::id(HIST, e),
                };
                out.put(key::id(FORGET, e), f.bytes());
            } else {
                if let Some(mk) = marker {
                    out.del(change_key(mk));
                }
                dead(out, at);
            }
            return marks.settle(view, out);
        };
        let c = target.expect("a target");
        let Some((part, old)) = entry_of(view, e, slot.as_ref(), c)? else {
            return Err(refused(format!("entity {e} has no change {c} there")));
        };
        let entry = Entry {
            e,
            slot: slot.as_ref(),
            part,
            c,
            old,
        };
        forget_one(view, out, &mut marks, entry, marker)?;
        if marker.is_none() {
            dead(out, at);
        }
        marks.settle(view, out)
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        if let Some(m) = Meta::of(rec).id
            && change_loc(view, m)?.is_some_and(|l| l.pos == pos)
        {
            return Ok(true);
        }
        Ok(pending_forget(view, id(rec, 0))?.is_some_and(|f| f.at.pos == pos))
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        if let Some(m) = Meta::of(rec).id
            && change_loc(view, m)?.is_some_and(|l| l.pos == from)
        {
            out.put(change_key(m), loc_bytes(to));
        }
        let e = id(rec, 0);
        if let Some(mut f) = pending_forget(view, e)?
            && f.at.pos == from
        {
            f.at = to;
            out.put(key::id(FORGET, e), f.bytes());
        }
        Ok(())
    }
}

pub fn any_forget_pending(view: &View) -> Result<bool, StoreError> {
    let p = key::of(FORGET);
    Ok(!view.scan(&p, &key::prefix_end(&p), 1)?.is_empty())
}

pub fn forget_step(view: &View, out: &mut Out) -> Result<bool, StoreError> {
    let fp = key::of(FORGET);
    let Some((fk, v)) = view.scan(&fp, &key::prefix_end(&fp), 1)?.into_iter().next() else {
        return Ok(false);
    };
    let mut at = fp.len();
    let e = get_u64(&fk, &mut at).ok_or_else(|| corrupt("a forget key doesn't decode"))?;
    let mut f = Forgetting::parse(&v)?;
    let hp = key::id(HIST, e);
    let found = view.scan(&f.cursor, &key::prefix_end(&hp), FORGET_SLICE)?;
    let done = found.len() < FORGET_SLICE;
    let mut marks = Marks::default();
    let mut keep: Option<(Option<FieldRef>, Kept)> = None;
    for (k, v) in &found {
        let (slot, part, c) = parse_hist(e, k)?;
        if c >= f.upto {
            continue;
        }
        if keep.as_ref().is_none_or(|(s, _)| *s != slot) {
            let list = kept(view, e, slot.as_ref())?;
            keep = Some((slot.clone(), list));
        }
        let marker = marker_of(v)?;
        if keep
            .as_ref()
            .is_some_and(|(_, l)| l.as_ref().is_none_or(|l| l.contains(&(part, c))))
        {
            if marker.is_some() && marker == f.marker {
                if let Some(l) = change_loc(view, c)? {
                    dead(out, l);
                    out.del(change_key(c));
                }
            }
            continue;
        }
        let entry = Entry {
            e,
            slot: slot.as_ref(),
            part,
            c,
            old: marker,
        };
        forget_one(view, out, &mut marks, entry, None)?;
    }
    if done {
        out.del(fk);
        let kp = key::id(KEEP, e);
        for (k, _) in view.scan(&kp, &key::prefix_end(&kp), usize::MAX)? {
            out.del(k);
        }
        if f.marker.is_none() {
            dead(out, f.at);
        }
    } else {
        f.cursor = found.last().expect("a full slice").0.clone();
        f.cursor.push(0);
        out.put(fk, f.bytes());
    }
    marks.settle(view, out)?;
    Ok(true)
}

fn field_js(f: &Option<FieldRef>) -> Js {
    match f {
        None => Js::Null,
        Some(FieldRef::Code(c)) => Js::Num(*c as f64),
        Some(FieldRef::Key(k)) => Js::Text(k.clone()),
    }
}

fn opt_big(v: Option<u64>) -> Js {
    v.map_or(Js::Null, Js::Big)
}

fn change_js(view: &View, c: u64, marker: Option<u64>) -> Result<Js, StoreError> {
    let (r, by) = match marker {
        Some(m) => (change(view, None, m)?.1, Some(m)),
        None => (change(view, None, c)?.1, None),
    };
    let kind = match (by, r.kind.name) {
        (Some(_), _) => "forgotten",
        (None, "histSet") => "set",
        (None, "histEdit") => "edit",
        (None, "histDelete") => "delete",
        (None, "histPlace") => "place",
        (None, "histEntityDelete") => "deleted",
        (None, "histRestore") => "restored",
        _ => return Err(corrupt("a change of another kind")),
    };
    let m = Meta::of(&r);
    let mut o = vec![
        ("id", Js::Big(c)),
        ("kind", Js::Text(kind.as_bytes().to_vec())),
        ("time", Js::Num(m.time as f64)),
        ("session", opt_big(m.session)),
        ("user", opt_big(m.user)),
    ];
    match (by, r.kind.name) {
        (Some(m), _) => o.push(("by", Js::Big(m))),
        (None, "histSet") => o.push(("json", Js::Bool(bit(&r, 3)))),
        (None, "histEdit") => o.push(("json", Js::Bool(bit(&r, 5)))),
        (None, "histPlace") => {
            let p = opt_uint(&r, 3).map_or(Js::Null, |p| Js::Num(p as f64));
            o.push(("position", p));
        }
        _ => {}
    }
    Ok(Js::Obj(o))
}

pub fn history_page(
    view: &View,
    e: u64,
    slot: Option<&FieldRef>,
    before: Option<u64>,
    limit: usize,
) -> Result<Js, StoreError> {
    let keep = match pending_forget(view, e)? {
        Some(f) => kept(view, e, slot)?.map(|k| (f.upto, k)),
        None => None,
    };
    let upto = keep.as_ref().map(|(u, _)| *u);
    let mut rows: Vec<(u64, Option<u64>)> = Vec::new();
    for part in [VALUES, PLACES] {
        let mut n = 0;
        walk_back(view, e, slot, part, before, 32, |c, marker| {
            if upto.is_some_and(|u| c < u) {
                return Ok(false);
            }
            rows.push((c, marker));
            n += 1;
            Ok(n <= limit)
        })?;
    }
    if let Some((u, keep)) = keep {
        for (part, c) in keep {
            if c < u
                && before.is_none_or(|b| c < b)
                && let Some(b) = view.get(&hist_key(e, slot, part, c))?
            {
                rows.push((c, marker_of(&b)?));
            }
        }
    }
    rows.sort_unstable_by_key(|r| std::cmp::Reverse(r.0));
    let more = rows.len() > limit;
    rows.truncate(limit);
    let changes = rows
        .into_iter()
        .map(|(c, m)| change_js(view, c, m))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Js::Obj(vec![
        ("changes", Js::Arr(changes)),
        ("more", Js::Bool(more)),
    ]))
}

pub fn history_value(view: &View, e: u64, f: &FieldRef, c: u64) -> Result<Js, StoreError> {
    let no_change = || refused(format!("entity {e}'s field has no value change {c}"));
    if view.get(&hist_key(e, Some(f), VALUES, c))? != Some(Vec::new())
        || hidden(view, e, &pending_forget(view, e)?, Some(f), VALUES, c)?
    {
        return Err(no_change());
    }
    Ok(match value_at(view, e, f, c)? {
        Some((json, v)) => Js::Obj(vec![("json", Js::Bool(json)), ("value", Js::Text(v))]),
        None => Js::Null,
    })
}

pub fn history_fields(
    view: &View,
    e: u64,
    after: Option<Option<FieldRef>>,
    limit: usize,
) -> Result<Js, StoreError> {
    let hp = key::id(HIST, e);
    let end = key::prefix_end(&hp);
    let mut from = match &after {
        Some(slot) => key::prefix_end(&slot_prefix(e, slot.as_ref())),
        None => hp,
    };
    let mut fields = Vec::new();
    let mut more = false;
    while let Some((hk, _)) = view.scan(&from, &end, 1)?.into_iter().next() {
        if fields.len() == limit {
            more = true;
            break;
        }
        let (slot, _, _) = parse_hist(e, &hk)?;
        from = key::prefix_end(&slot_prefix(e, slot.as_ref()));
        fields.push(field_js(&slot));
    }
    Ok(Js::Obj(vec![
        ("fields", Js::Arr(fields)),
        ("more", Js::Bool(more)),
    ]))
}

pub fn deleted_page(
    view: &View,
    book: u64,
    after: Option<u64>,
    limit: usize,
) -> Result<Js, StoreError> {
    let p = key::id(DELETED, book);
    let start = match after {
        Some(a) => deleted_key(book, a + 1),
        None => p.clone(),
    };
    let found = view.scan(&start, &key::prefix_end(&p), limit + 1)?;
    let more = found.len() > limit;
    let mut rows = Vec::new();
    for (k, v) in found.into_iter().take(limit) {
        let mut at = p.len();
        let e = get_u64(&k, &mut at).ok_or_else(|| corrupt("a deleted key doesn't decode"))?;
        let [flags, place, index] = parse_varints::<3>(&v)?;
        let [gp, _, _] = gone(view, e)?.ok_or_else(|| corrupt("a deleted entry isn't gone"))?;
        let (r, _) = view.record(gp)?;
        let (_, ek) = books::parse_entry_key(bytes(&r, 2))?;
        let position = if flags & 1 != 0 {
            Js::Num(place as f64)
        } else {
            Js::Null
        };
        let index = if flags & 2 != 0 {
            Js::Num(f64::from_bits(index))
        } else {
            Js::Null
        };
        rows.push(Js::Obj(vec![
            ("id", Js::Big(e)),
            ("key", Js::Text(ek.text())),
            ("position", position),
            ("index", index),
        ]));
    }
    Ok(Js::Obj(vec![
        ("entries", Js::Arr(rows)),
        ("more", Js::Bool(more)),
    ]))
}

static VALUE_CHANGE: ValueChange = ValueChange;

pub fn deriver(kind: &str) -> Option<&'static dyn Deriver> {
    Some(match kind {
        "histSet" | "histEdit" | "histDelete" => &VALUE_CHANGE,
        "histPlace" => &PlaceChange,
        "histEntityDelete" => &EntityDelete,
        "histRestore" => &Restore,
        "histRevert" => &Revert,
        "histForget" => &Forget,
        _ => return None,
    })
}
