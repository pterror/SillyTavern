//! The local import scan's bookkeeping (`localImport.directories`): per source file, the mtime it was processed at
//! (with the character it duplicated, whose delete forgets it) and the skips of files that aren't characters.

use super::StoreError;
use super::derive::{Deriver, Loc, Out, View};
use super::kinds::{bytes, dead, key, loc_bytes, parse_loc};
use crate::keyspace::val::{get_bytes, put_bytes};
use crate::log::format::{Record, Value};

/// Per source path: its `localImportMtime` record.
pub const MTIME: u64 = 86;
/// Per (character, source path): the path's mtime record names the character as what it duplicated.
pub const DUPLICATE_OF: u64 = 87;
/// Per source path: its `localImportSkip` record.
pub const SKIP: u64 = 88;

fn path_key(structure: u64, path: &[u8]) -> Vec<u8> {
    let mut k = key::of(structure);
    put_bytes(&mut k, path);
    k
}

fn dup_key(entity: u64, path: &[u8]) -> Vec<u8> {
    let mut k = key::id(DUPLICATE_OF, entity);
    put_bytes(&mut k, path);
    k
}

fn opt_entity(rec: &Record, i: usize) -> Option<u64> {
    match rec.values[i] {
        Value::Id(v) => Some(v),
        _ => None,
    }
}

/// The record a path's entry points at, if any.
fn current(view: &View, k: &[u8]) -> Result<Option<(Loc, Record)>, StoreError> {
    match view.get(k)? {
        Some(b) => {
            let l = parse_loc(&b)?;
            Ok(Some((l, view.record(l.pos)?.0)))
        }
        None => Ok(None),
    }
}

/// `localImportMtime` and `localImportSkip`: the last record of a path is its value; one with no `mtime` forgets it.
pub struct PathValue {
    structure: u64,
}

pub static MTIME_VALUE: PathValue = PathValue { structure: MTIME };
pub static SKIP_VALUE: PathValue = PathValue { structure: SKIP };

impl Deriver for PathValue {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let path = bytes(rec, 0);
        let k = path_key(self.structure, path);
        if let Some((l, old)) = current(view, &k)? {
            dead(out, l);
            if self.structure == MTIME
                && let Some(e) = opt_entity(&old, 2)
            {
                out.del(dup_key(e, path));
            }
        }
        if rec.values[1] == Value::Absent {
            out.del(k);
            dead(out, at);
            return Ok(());
        }
        out.put(k, loc_bytes(at));
        if self.structure == MTIME
            && let Some(e) = opt_entity(rec, 2)
        {
            out.put(dup_key(e, path), Vec::new());
        }
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        Ok(view
            .get(&path_key(self.structure, bytes(rec, 0)))?
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
            out.put(path_key(self.structure, bytes(rec, 0)), loc_bytes(to));
        }
        Ok(())
    }
}

/// A character is deleted: the paths recorded as its duplicates are forgotten, so the scan reads them again.
pub fn entity_gone(view: &View, out: &mut Out, entity: u64) -> Result<(), StoreError> {
    let p = key::id(DUPLICATE_OF, entity);
    for (k, _) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        let mut at = p.len();
        let path = get_bytes(&k, &mut at)
            .ok_or_else(|| StoreError::Entry("a duplicate-of key doesn't decode".into()))?;
        let mk = path_key(MTIME, &path);
        if let Some(b) = view.get(&mk)? {
            dead(out, parse_loc(&b)?);
            out.del(mk);
        }
        out.del(k);
    }
    Ok(())
}

/// A path's mtime record: `(mtime, duplicate of)`, or None.
pub fn mtime(view: &View, path: &[u8]) -> Result<Option<(f64, Option<u64>)>, StoreError> {
    Ok(current(view, &path_key(MTIME, path))?.map(|(_, r)| {
        let m = match r.values[1] {
            Value::F64(v) => v,
            _ => 0.0,
        };
        (m, opt_entity(&r, 2))
    }))
}

/// A path's skip: `(mtime, reason)`, or None.
pub fn skip(view: &View, path: &[u8]) -> Result<Option<(f64, Vec<u8>)>, StoreError> {
    Ok(current(view, &path_key(SKIP, path))?.map(|(_, r)| {
        let m = match r.values[1] {
            Value::F64(v) => v,
            _ => 0.0,
        };
        let reason = match &r.values[2] {
            Value::Text(t) => t.clone(),
            _ => Vec::new(),
        };
        (m, reason)
    }))
}

/// Up to `limit` paths holding an mtime record after `after` (none: from the first), in path order.
pub fn mtime_paths_after(
    view: &View,
    after: Option<&[u8]>,
    limit: usize,
) -> Result<Vec<Vec<u8>>, StoreError> {
    let p = key::of(MTIME);
    let start = match after {
        Some(a) => {
            let mut k = path_key(MTIME, a);
            k.push(0);
            k
        }
        None => p.clone(),
    };
    view.scan(&start, &key::prefix_end(&p), limit)?
        .into_iter()
        .map(|(k, _)| {
            let mut at = p.len();
            get_bytes(&k, &mut at)
                .ok_or_else(|| StoreError::Entry("a local import key doesn't decode".into()))
        })
        .collect()
}
