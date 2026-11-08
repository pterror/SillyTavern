use std::collections::BTreeMap;

use super::StoreError;

use super::derive::{Out, View};
use super::kinds::key;

use super::relations;
use super::world_order_tree::LayeredWrites;
use crate::keyspace::val::{Val, get_u64, put_u64};

// Keys of this structure live only in one commit's own layer: the commit runs them at its end and drops them.
pub const COMMIT_CHECK: u64 = 231;

const TARGET_EXISTS: u8 = 1;
const RELATION_KIND_EXISTS: u8 = 2;

fn check_key(what: u8, book: u64) -> Vec<u8> {
    let mut check = key::of(COMMIT_CHECK);
    check.push(what);
    put_u64(&mut check, book);
    check
}

pub fn require_target(writes: &mut LayeredWrites, book: u64, target: u64) {
    let mut check = check_key(TARGET_EXISTS, book);
    put_u64(&mut check, target);
    writes.put(check, Vec::new());
}

pub fn require_relation_kind(writes: &mut LayeredWrites, book: u64, kind: u64) {
    writes.put(relation_kind_check_key(book, kind), Vec::new());
}

pub fn relation_kind_check_key(book: u64, kind: u64) -> Vec<u8> {
    let mut check = check_key(RELATION_KIND_EXISTS, book);
    put_u64(&mut check, kind);
    check
}

pub fn is_check(stored_key: &[u8]) -> bool {
    get_u64(stored_key, &mut 0) == Some(COMMIT_CHECK)
}

pub fn strip(derived: &mut Out) {
    derived
        .entries
        .retain(|(stored_key, _)| !is_check(stored_key));
}

pub fn take(entries: &mut BTreeMap<Vec<u8>, Val>) -> Vec<Vec<u8>> {
    let start = key::of(COMMIT_CHECK);
    let found: Vec<Vec<u8>> = entries
        .range(start.clone()..key::prefix_end(&start))
        .map(|(stored_key, _)| stored_key.clone())
        .collect();
    for stored_key in &found {
        entries.remove(stored_key);
    }
    found
}

fn corrupt() -> StoreError {
    StoreError::Entry("a commit check doesn't decode".into())
}

pub fn run(view: &View, checks: &[Vec<u8>]) -> Result<(), StoreError> {
    for check in checks {
        let mut read_at = key::of(COMMIT_CHECK).len();
        let what = *check.get(read_at).ok_or_else(corrupt)?;
        read_at += 1;
        let book = get_u64(check, &mut read_at).ok_or_else(corrupt)?;
        match what {
            TARGET_EXISTS => {
                let target = get_u64(check, &mut read_at).ok_or_else(corrupt)?;
                if relations::any_relation_targets(view, book, target)?
                    && !relations::is_entry_of(view, book, target)?
                    && !relations::is_deleted_entry_of(view, book, target)?
                {
                    return Err(StoreError::Refused(format!(
                        "an entry of book {book} still has a relation to entity {target}, which is no entry of the book, live or deleted"
                    )));
                }
            }
            RELATION_KIND_EXISTS => {
                let kind = get_u64(check, &mut read_at).ok_or_else(corrupt)?;
                if (relations::relation_kind_in_use(view, book, kind)?
                    || relations::some_kind_is_being_merged_into(view, book, kind)?)
                    && relations::relation_kind_name(view, book, kind)?.is_none()
                    && relations::relation_kind_being_merged_into(view, book, kind)?.is_none()
                {
                    return Err(StoreError::Refused(format!(
                        "an entry of book {book} still has a relation of kind {kind}, or a kind being merged into it, which the book doesn't have"
                    )));
                }
            }
            _ => return Err(corrupt()),
        }
    }
    Ok(())
}
