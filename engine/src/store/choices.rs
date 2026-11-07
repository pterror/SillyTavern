use super::StoreError;
use super::books::{self, BOOK};
use super::chat_read::Js;
use super::derive::{Deriver, Loc, Out, View};
use super::kinds::{bytes, dead, id, key, loc_bytes};
use super::library::entity_info;
use crate::keyspace::val::{get_u64, put_u64};
use crate::log::format::{Record, Value, get_uvarint, kind_by_name, put_uvarint};

pub const CHOSEN: u64 = 223;
pub const CHOOSERS: u64 = 224;

pub const KEY_SEPARATOR: u8 = b'\n';

fn chosen_key(holder: u64, slot: u64) -> Vec<u8> {
    key::ids(CHOSEN, holder, slot)
}

fn choosers_key(book: u64, holder: u64, slot: u64) -> Vec<u8> {
    let mut k = key::ids(CHOOSERS, book, holder);
    put_u64(&mut k, slot);
    k
}

fn chosen_bytes(at: Loc, books: &[u64]) -> Vec<u8> {
    let mut b = loc_bytes(at);
    for book in books {
        put_uvarint(&mut b, *book);
    }
    b
}

fn parse_chosen(b: &[u8]) -> Result<(Loc, Vec<u64>), StoreError> {
    let bad = || StoreError::Entry("a book choice doesn't decode".into());
    let mut at = 0;
    let pos = get_uvarint(b, &mut at).map_err(|_| bad())?;
    let len = get_uvarint(b, &mut at).map_err(|_| bad())?;
    let mut books = Vec::new();
    while at < b.len() {
        books.push(get_uvarint(b, &mut at).map_err(|_| bad())?);
    }
    Ok((Loc { pos, len }, books))
}

fn chosen(view: &View, holder: u64, slot: u64) -> Result<Option<(Loc, Vec<u64>)>, StoreError> {
    view.get(&chosen_key(holder, slot))?
        .map(|b| parse_chosen(&b))
        .transpose()
}

pub fn books_of(view: &View, holder: u64, slot: u64) -> Result<Vec<u64>, StoreError> {
    Ok(chosen(view, holder, slot)?
        .map(|(_, b)| b)
        .unwrap_or_default())
}

fn parse_books(text: &[u8]) -> Result<Vec<u64>, StoreError> {
    let bad = || {
        StoreError::Refused(
            "a book choice is books' ids in decimal, each after a single space but the first"
                .into(),
        )
    };
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let mut out: Vec<u64> = Vec::new();
    for digits in text.split(|c| *c == b' ') {
        let canonical = !digits.is_empty()
            && digits.iter().all(u8::is_ascii_digit)
            && (digits.len() == 1 || digits[0] != b'0');
        let b = canonical
            .then(|| std::str::from_utf8(digits).ok()?.parse::<u64>().ok())
            .flatten()
            .ok_or_else(bad)?;
        if out.contains(&b) {
            return Err(StoreError::Refused(format!(
                "a book choice names book {b} twice"
            )));
        }
        out.push(b);
    }
    Ok(out)
}

fn books_text(books: &[u64]) -> Vec<u8> {
    books
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(" ")
        .into_bytes()
}

fn refs_record(holder: u64, slot: u64, books: &[u64]) -> Result<Record, StoreError> {
    Record::new(
        kind_by_name("bookRefs").expect("a choice kind"),
        vec![
            Value::Id(holder),
            Value::UInt(slot),
            Value::Text(books_text(books)),
        ],
    )
    .map_err(|e| StoreError::Refused(e.to_string()))
}

pub fn is_chosen(view: &View, book: u64) -> Result<bool, StoreError> {
    let p = key::id(CHOOSERS, book);
    Ok(!view.scan(&p, &key::prefix_end(&p), 1)?.is_empty())
}

pub struct BookChoose;

impl Deriver for BookChoose {
    fn prepares(&self) -> bool {
        true
    }

    fn prepare(&self, rec: Record, view: &View) -> Result<Record, StoreError> {
        let mut found: Vec<u64> = Vec::new();
        for k in bytes(&rec, 2).split(|c| *c == KEY_SEPARATOR) {
            if k.is_empty() {
                continue;
            }
            if let Some(b) = books::defined_by_key(view, k)?
                && !found.contains(&b)
            {
                found.push(b);
            }
        }
        refs_record(id(&rec, 0), id(&rec, 1), &found)
    }

    fn derive(&self, _: &Record, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Err(StoreError::Refused(
            "bookChoose is logged as the bookRefs it makes".into(),
        ))
    }

    fn is_live(&self, _: &Record, _: u64, _: &View) -> Result<bool, StoreError> {
        Ok(false)
    }

    fn repoint(&self, _: &Record, _: u64, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Ok(())
    }
}

pub struct BookUnchoose;

impl Deriver for BookUnchoose {
    fn prepares(&self) -> bool {
        true
    }

    fn prepare(&self, rec: Record, view: &View) -> Result<Record, StoreError> {
        let (holder, slot, book) = (id(&rec, 0), id(&rec, 1), id(&rec, 2));
        let mut left = books_of(view, holder, slot)?;
        left.retain(|b| *b != book);
        refs_record(holder, slot, &left)
    }

    fn derive(&self, _: &Record, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Err(StoreError::Refused(
            "bookUnchoose is logged as the bookRefs it makes".into(),
        ))
    }

    fn is_live(&self, _: &Record, _: u64, _: &View) -> Result<bool, StoreError> {
        Ok(false)
    }

    fn repoint(&self, _: &Record, _: u64, _: Loc, _: &View, _: &mut Out) -> Result<(), StoreError> {
        Ok(())
    }
}

pub struct BookRefs;

impl Deriver for BookRefs {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let (holder, slot) = (id(rec, 0), id(rec, 1));
        let books = parse_books(bytes(rec, 2))?;
        if entity_info(view, holder)?.is_none() {
            return Err(StoreError::Refused(format!("no entity {holder}")));
        }
        for b in &books {
            if !matches!(entity_info(view, *b)?, Some((BOOK, _, _))) || !books::defined(view, *b)? {
                return Err(StoreError::Refused(format!("no book {b}")));
            }
        }
        let (old_at, old) = match chosen(view, holder, slot)? {
            Some((l, b)) => (Some(l), b),
            None => (None, Vec::new()),
        };
        if let Some(l) = old_at {
            dead(out, l);
        }
        for b in old.iter().filter(|b| !books.contains(b)) {
            out.del(choosers_key(*b, holder, slot));
        }
        for b in books.iter().filter(|b| !old.contains(b)) {
            out.put(choosers_key(*b, holder, slot), Vec::new());
        }
        if books.is_empty() {
            out.del(chosen_key(holder, slot));
            dead(out, at);
        } else {
            out.put(chosen_key(holder, slot), chosen_bytes(at, &books));
        }
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        Ok(chosen(view, id(rec, 0), id(rec, 1))?.is_some_and(|(l, _)| l.pos == pos))
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        let (holder, slot) = (id(rec, 0), id(rec, 1));
        if let Some((l, books)) = chosen(view, holder, slot)?
            && l.pos == from
        {
            out.put(chosen_key(holder, slot), chosen_bytes(to, &books));
        }
        Ok(())
    }
}

pub fn holder_gone(view: &View, out: &mut Out, holder: u64) -> Result<(), StoreError> {
    let p = key::id(CHOSEN, holder);
    for (k, v) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        let mut at = p.len();
        let slot = get_u64(&k, &mut at)
            .ok_or_else(|| StoreError::Entry("a book choice key doesn't decode".into()))?;
        let (l, books) = parse_chosen(&v)?;
        dead(out, l);
        for b in books {
            out.del(choosers_key(b, holder, slot));
        }
        out.del(k);
    }
    Ok(())
}

pub fn deriver(kind: &str) -> Option<&'static dyn Deriver> {
    Some(match kind {
        "bookChoose" => &BookChoose,
        "bookUnchoose" => &BookUnchoose,
        "bookRefs" => &BookRefs,
        _ => return None,
    })
}

pub fn choosers_page(
    view: &View,
    book: u64,
    after: Option<u64>,
    limit: usize,
) -> Result<Js, StoreError> {
    let p = key::id(CHOOSERS, book);
    let start = match after {
        Some(a) => key::ids(CHOOSERS, book, a + 1),
        None => p.clone(),
    };
    let mut found = Vec::new();
    let mut holders = 0;
    let mut last: Option<u64> = None;
    let mut more = false;
    for (k, _) in view.scan(&start, &key::prefix_end(&p), usize::MAX)? {
        let mut at = p.len();
        let bad = || StoreError::Entry("a book chooser key doesn't decode".into());
        let holder = get_u64(&k, &mut at).ok_or_else(bad)?;
        let slot = get_u64(&k, &mut at).ok_or_else(bad)?;
        if last != Some(holder) {
            if holders == limit {
                more = true;
                break;
            }
            holders += 1;
            last = Some(holder);
        }
        let (kind, hk) = match entity_info(view, holder)? {
            Some((kind, hk, _)) => (Js::Num(kind as f64), Js::Text(hk)),
            None => (Js::Null, Js::Null),
        };
        found.push(Js::Obj(vec![
            ("holder", Js::Big(holder)),
            ("slot", Js::Num(slot as f64)),
            ("type", kind),
            ("key", hk),
        ]));
    }
    Ok(Js::Obj(vec![
        ("choosers", Js::Arr(found)),
        ("more", Js::Bool(more)),
    ]))
}

pub fn choices(view: &View, holders: &[u64]) -> Result<Js, StoreError> {
    let mut out = Vec::with_capacity(holders.len());
    for &holder in holders {
        let p = key::id(CHOSEN, holder);
        let mut slots = Vec::new();
        for (k, v) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
            let mut at = p.len();
            let slot = get_u64(&k, &mut at)
                .ok_or_else(|| StoreError::Entry("a book choice key doesn't decode".into()))?;
            let (_, books) = parse_chosen(&v)?;
            let mut named = Vec::with_capacity(books.len());
            for b in books {
                let k = match entity_info(view, b)? {
                    Some((BOOK, k, _)) => Js::Text(k),
                    _ => Js::Null,
                };
                named.push(Js::Obj(vec![("id", Js::Big(b)), ("key", k)]));
            }
            slots.push(Js::Obj(vec![
                ("slot", Js::Num(slot as f64)),
                ("books", Js::Arr(named)),
            ]));
        }
        out.push(Js::Arr(slots));
    }
    Ok(Js::Arr(out))
}
