//! Exact greeting/opening lookups. Built once at store open, maintained by writes thereafter.
use super::derive::{Out, View};
use super::kinds::{self, Holder, bytes, id, key, parse_loc};
use super::{StoreError, chat, library};
use crate::keyspace::val::{get_u64, put_u64};
use crate::log::format::FieldRef;

const GREETING_TEXT: u64 = 400;
const OPENING_TEXT: u64 = 401;
const OPENING_KEY: u64 = 402;
const BUILD_CURSOR: u64 = 403;
const DIRTY_IDENTITY: u64 = 404;

pub fn identity_changed(out: &mut Out, card: u64, present: bool) {
    let k = key::id(DIRTY_IDENTITY, card);
    if present {
        out.del(k);
    } else {
        out.put(k, Vec::new());
    }
}

pub fn dirty_identities(view: &View) -> Result<Vec<u64>, StoreError> {
    let p = key::of(DIRTY_IDENTITY);
    view.scan(&p, &key::prefix_end(&p), usize::MAX)?
        .into_iter()
        .map(|(k, _)| {
            get_u64(&k, &mut p.len())
                .ok_or_else(|| StoreError::Entry("dirty card identity key".into()))
        })
        .collect()
}

pub fn greeting_field(f: &FieldRef) -> bool {
    matches!(f, FieldRef::Code(n) if *n == 13 || (*n >= 1024 && (*n - 1024) % 8 == 0))
}

pub fn greeting_field_of(view: &View, card: u64, id: u64) -> Result<Option<u64>, StoreError> {
    let default = super::history::json_value(view, card, &FieldRef::Code(21))?
        .and_then(|json| {
            std::str::from_utf8(&json)
                .ok()
                .and_then(|s| s.parse::<u64>().ok())
        })
        .unwrap_or(0);
    if default == id
        && kinds::text_value(view, card, &FieldRef::Code(13))?.is_some_and(|t| !t.is_empty())
    {
        return Ok(Some(13));
    }
    let mut k = key::ids(key::ITEM_AT, card, 0);
    put_u64(&mut k, id);
    Ok(if view.get(&k)?.is_some() {
        id.checked_mul(8).and_then(|n| n.checked_add(1024))
    } else {
        None
    })
}

fn text_prefix(space: u64, card: u64, text: &[u8]) -> Vec<u8> {
    let mut k = key::ids(space, card, crc32c::crc32c(text) as u64);
    put_u64(&mut k, text.len() as u64);
    k
}

pub fn greeting_changed(
    view: &View,
    out: &mut Out,
    card: u64,
    f: &FieldRef,
    new: Option<&[u8]>,
) -> Result<(), StoreError> {
    if !greeting_field(f) {
        return Ok(());
    }
    let FieldRef::Code(field) = f else {
        unreachable!()
    };
    if let Some(old) = kinds::text_value(view, card, f)? {
        let mut k = text_prefix(GREETING_TEXT, card, &old);
        put_u64(&mut k, *field);
        out.del(k);
    }
    if let Some(text) = new {
        let mut k = text_prefix(GREETING_TEXT, card, text);
        put_u64(&mut k, *field);
        out.put(k, Vec::new());
    }
    Ok(())
}

pub fn matching_greetings(view: &View, card: u64, text: &[u8]) -> Result<Vec<u64>, StoreError> {
    let p = text_prefix(GREETING_TEXT, card, text);
    let mut found = Vec::new();
    for (k, _) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        let mut at = p.len();
        if let Some(f) = get_u64(&k, &mut at) {
            let placed = if f == 13 {
                true
            } else {
                let mut k = key::ids(key::ITEM_AT, card, 0);
                put_u64(&mut k, (f - 1024) / 8);
                view.get(&k)?.is_some()
            };
            if placed
                && library::entity_info(view, card)?.is_some()
                && kinds::text_value(view, card, &FieldRef::Code(f))?.as_deref() == Some(text)
            {
                found.push(f);
            }
        }
    }
    Ok(found)
}

pub fn remove_opening(view: &View, out: &mut Out, m: u64) -> Result<(), StoreError> {
    let reverse = key::id(OPENING_KEY, m);
    if let Some(k) = view.get(&reverse)? {
        out.del(k);
    }
    out.del(reverse);
    Ok(())
}

fn put_opening(out: &mut Out, m: u64, tree: u64, card: u64, text: &[u8]) {
    let mut k = text_prefix(OPENING_TEXT, card, text);
    put_u64(&mut k, m);
    out.put(k.clone(), kinds::varints(&[tree]));
    out.put(key::id(OPENING_KEY, m), k);
}

pub fn appended(out: &mut Out, rec: &crate::log::format::Record) {
    if chat::opt_id(rec, chat::APPEND_PARENT).is_none()
        && chat::text_in_append(id(rec, chat::APPEND_FLAGS))
    {
        let tree = id(rec, chat::APPEND_OWNER);
        put_opening(
            out,
            id(rec, chat::APPEND_ID),
            tree,
            chat::opt_id(rec, 3).unwrap_or(tree),
            bytes(rec, chat::APPEND_TEXT),
        );
    }
}

pub fn refresh_opening(
    view: &View,
    out: &mut Out,
    m: u64,
    text: Option<Option<&[u8]>>,
    speaker: Option<Option<u64>>,
    parent: Option<Option<u64>>,
) -> Result<(), StoreError> {
    remove_opening(view, out, m)?;
    let (_, rec) = chat::require_message(view, m)?;
    if parent.unwrap_or(chat::parent_of(view, m, &rec)?).is_some() {
        return Ok(());
    }
    let tree = id(&rec, chat::APPEND_OWNER);
    let card = match speaker {
        Some(s) => s.unwrap_or(tree),
        None => {
            let f = FieldRef::Code(18);
            let overridden = view
                .get(&Holder::Message(m).value_key(&f))?
                .map(|b| -> Result<Option<u64>, StoreError> {
                    let (r, _) = view.record(parse_loc(&b)?.pos)?;
                    Ok(std::str::from_utf8(bytes(&r, 2))
                        .ok()
                        .and_then(|s| s.trim_matches('"').parse().ok()))
                })
                .transpose()?;
            overridden.unwrap_or(chat::opt_id(&rec, 3)).unwrap_or(tree)
        }
    };
    let stored;
    let value = match text {
        Some(t) => t,
        None => {
            stored = kinds::text_value_of(view, Holder::Message(m), &FieldRef::Code(chat::MES))?;
            stored.as_deref()
        }
    };
    if let Some(t) = value {
        put_opening(out, m, tree, card, t);
    }
    Ok(())
}

pub fn matching_openings(
    view: &View,
    card: u64,
    text: &[u8],
) -> Result<Vec<(u64, u64)>, StoreError> {
    let p = text_prefix(OPENING_TEXT, card, text);
    let mut found = Vec::new();
    for (k, v) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        let mut at = p.len();
        if let Some(m) = get_u64(&k, &mut at) {
            if kinds::text_value_of(view, Holder::Message(m), &FieldRef::Code(chat::MES))?
                .as_deref()
                == Some(text)
            {
                found.push((kinds::parse_varints::<1>(&v)?[0], m));
            }
        }
    }
    Ok(found)
}

// Persisted cursor makes upgrades resumable. This runs at open, never in the edit request.
pub fn build_step(view: &View, out: &mut Out, batch: usize) -> Result<bool, StoreError> {
    let cursor_key = key::of(BUILD_CURSOR);
    let cursor = view.get(&cursor_key)?.unwrap_or_else(|| key::of(key::HEAD));
    if cursor == [0] {
        return Ok(false);
    }
    let mut at = 0;
    let phase = get_u64(&cursor, &mut at).unwrap_or(key::HEAD);
    let page = view.scan(&cursor, &key::prefix_end(&key::of(phase)), batch)?;
    for (k, _) in &page {
        let mut at = key::of(phase).len();
        let entity =
            get_u64(k, &mut at).ok_or_else(|| StoreError::Entry("greeting index cursor".into()))?;
        if phase == key::HEAD {
            let f = library::field_after(k, key::HEAD)?;
            if greeting_field(&f) {
                greeting_changed(
                    view,
                    out,
                    entity,
                    &f,
                    kinds::text_value(view, entity, &f)?.as_deref(),
                )?;
            }
        } else {
            refresh_opening(view, out, entity, None, None, None)?;
        }
    }
    if page.len() == batch {
        let mut next = page.last().unwrap().0.clone();
        next.push(0);
        out.put(cursor_key, next);
        Ok(true)
    } else if phase == key::HEAD {
        out.put(cursor_key, key::of(key::MESSAGE));
        Ok(true)
    } else {
        out.put(cursor_key, vec![0]);
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::format::{Record, Value, kind_by_name};
    use crate::store::{Store, StoreConfig};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn record(kind: &str, values: Vec<Value>) -> Record {
        Record::new(kind_by_name(kind).unwrap(), values).unwrap()
    }

    #[test]
    fn missing_indexes_are_built_in_resumable_pages_and_survive_reopen() {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "greeting-index-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let store = Store::open(&dir, StoreConfig::default()).unwrap();
        store
            .commit_wait(vec![
                record(
                    "entityCreate",
                    vec![
                        Value::Id(1),
                        Value::UInt(0),
                        Value::Text(b"a.png".to_vec()),
                        Value::F64(0.0),
                    ],
                ),
                record(
                    "textValue",
                    vec![
                        Value::Sel(0, 1),
                        Value::Field(FieldRef::Code(13)),
                        Value::Text(b"Hello".to_vec()),
                        Value::Absent,
                        Value::Absent,
                    ],
                ),
                record(
                    "keyMap",
                    vec![Value::Sel(chat::KEYED_USER, 1), Value::Bytes(b"u".to_vec())],
                ),
                record(
                    "messageAppend",
                    vec![
                        Value::Id(1),
                        Value::Absent,
                        Value::Id(1),
                        Value::Id(1),
                        Value::Absent,
                        Value::Time(0),
                        Value::Text(b"Hello".to_vec()),
                        Value::UInt(0),
                        Value::Absent,
                        Value::Id(1),
                        Value::Absent,
                    ],
                ),
            ])
            .unwrap();
        // Simulate a store created by the engine before these derived indexes existed.
        store
            .derive_now(|view, out| {
                for space in [GREETING_TEXT, OPENING_TEXT, OPENING_KEY] {
                    let prefix = key::of(space);
                    for (k, _) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
                        out.del(k);
                    }
                }
                Ok(())
            })
            .unwrap();
        store
            .derived(|v| {
                assert!(matching_openings(v, 1, b"Hello")?.is_empty());
                Ok(())
            })
            .unwrap();
        // Interrupt the backfill between phases, then resume from the persisted cursor.
        store
            .derive_now(|v, out| {
                build_step(v, out, 1)?;
                Ok(())
            })
            .unwrap();
        drop(store);
        let store = Store::open(&dir, StoreConfig::default()).unwrap();
        loop {
            let more = std::sync::Arc::new(std::sync::Mutex::new(false));
            let result = more.clone();
            store
                .derive_now(move |v, out| {
                    *result.lock().unwrap() = build_step(v, out, 1)?;
                    Ok(())
                })
                .unwrap();
            if !*more.lock().unwrap() {
                break;
            }
        }
        store
            .derived(|v| {
                assert_eq!(matching_greetings(v, 1, b"Hello")?, vec![13]);
                assert_eq!(matching_openings(v, 1, b"Hello")?, vec![(1, 1)]);
                assert!(matching_openings(v, 2, b"Hello")?.is_empty());
                Ok(())
            })
            .unwrap();
        drop(store);
        let store = Store::open(&dir, StoreConfig::default()).unwrap();
        store
            .derived(|v| {
                assert_eq!(matching_openings(v, 1, b"Hello")?, vec![(1, 1)]);
                Ok(())
            })
            .unwrap();
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
