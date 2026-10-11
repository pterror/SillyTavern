//! Subtree deletes (`.plans/2026-10-03-storage-build-path.md` 5b addendum): a message and everything below it go.
//!
//! The `subtreeDelete` record is the delete, durable at its commit. Its own derivation does what is bounded by the
//! tree's positions, not by the subtree: the root leaves its parent's replies, the sessions, remembered positions
//! and bookmarks inside move to the root's parent (or, for an opening, sessions to the newest other opening;
//! pinned bookmarks, and following ones with no message to move to, go), and the root is recorded as pending.
//! Slices in the commit queue then delete the subtree's messages a bounded number at a time, leaves first, and
//! the last one deletes the root and clears the pending entry. A crash between slices resumes from the pending
//! entry on open.
//!
//! While a root is pending its subtree reads as deleted: it is no reply of its parent, a path stops above it,
//! search drops its messages, and nothing may be written to them; the tree's stats are marked estimates.

use std::collections::BTreeMap;

use super::StoreError;
use super::chat::{self, APPEND_OWNER, child_key, parent_of, require_message, shape_add};
use super::derive::{Deriver, Layer, Loc, Out, View};
use super::kinds::{dead, id, key, parse_varints, varints};
use super::library::counter;
use super::sessions;
use crate::keyspace::val::{Val, get_u64};
use crate::log::format::{Record, Value};

/// Per pending root: `[tree, next message to visit + 1, record position, record length]`.
pub const PRUNE: u64 = 172;
/// Per (tree, root): the tree's pending roots.
pub const PRUNE_IN: u64 = 173;
/// Per tree: how many roots are pending (a counter).
pub const PRUNE_TREE: u64 = 174;

/// Messages a slice visits (each is visited going down once and deleted once).
pub const PRUNE_SLICE: usize = 256;

fn bad(what: &str) -> StoreError {
    StoreError::Entry(format!("{what} doesn't decode"))
}

/// Whether a delete is pending in the tree.
pub fn pending_in(view: &View, tree: u64) -> Result<bool, StoreError> {
    Ok(counter(view, &key::id(PRUNE_TREE, tree))? > 0)
}

/// Whether a delete is pending anywhere (for a store opening with some left).
pub fn any_pending(view: &View) -> Result<bool, StoreError> {
    let p = key::of(PRUNE);
    Ok(!view.scan(&p, &key::prefix_end(&p), 1)?.is_empty())
}

/// The tree's pending roots.
pub fn roots(view: &View, tree: u64) -> Result<Vec<u64>, StoreError> {
    let p = key::id(PRUNE_IN, tree);
    view.scan(&p, &key::prefix_end(&p), usize::MAX)?
        .into_iter()
        .map(|(k, _)| {
            let mut at = p.len();
            get_u64(&k, &mut at).ok_or_else(|| bad("a pending root key"))
        })
        .collect()
}

/// Whether `m` is a pending root.
pub fn is_root(view: &View, m: u64) -> Result<bool, StoreError> {
    Ok(view.get(&key::id(PRUNE, m))?.is_some())
}

/// Whether `m` is `r` or below it. Through jump pointers, unless a depth rewrite is under way in the tree (its
/// jumps may name former ancestors then): through the parents.
pub fn under(view: &View, tree: u64, r: u64, m: u64) -> Result<bool, StoreError> {
    if sessions::depths_pending(view, tree)? {
        let mut cur = Some(m);
        while let Some(c) = cur {
            if c == r {
                return Ok(true);
            }
            cur = match chat::message_entry(view, c)? {
                Some((_, p)) => p,
                None => return Ok(false),
            };
        }
        return Ok(false);
    }
    let mut reads = 0;
    Ok(sessions::ancestor_or_self(view, r, m, &mut reads)?.unwrap_or(false))
}

/// Whether message `m` of `tree` is being deleted (it is a pending root or below one).
pub fn doomed(view: &View, tree: u64, m: u64) -> Result<bool, StoreError> {
    if !pending_in(view, tree)? {
        return Ok(false);
    }
    for r in roots(view, tree)? {
        if under(view, tree, r, m)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Refuses a write naming message `m` of `tree` while it is being deleted.
pub fn refuse_doomed(view: &View, tree: u64, m: u64) -> Result<(), StoreError> {
    if doomed(view, tree, m)? {
        return Err(StoreError::Refused(format!("message {m} is being deleted")));
    }
    Ok(())
}

/// Where what is at a message below `r` (a message with `parent`) goes: the parent, else the tree's newest other
/// opening, else the tree's root (None).
fn destination(
    view: &View,
    tree: u64,
    r: u64,
    parent: Option<u64>,
) -> Result<Option<u64>, StoreError> {
    if parent.is_some() {
        return Ok(parent);
    }
    let p = chat::children_prefix(None, tree);
    for (k, _) in view.scan_vals_rev(&p, &key::prefix_end(&p), 2)? {
        let o = chat::child_of_key(&k, p.len())?;
        if o != r {
            return Ok(Some(o));
        }
    }
    Ok(None)
}

/// The tree's bookmarks below `r`, each with whether it goes (pinned, or following with no parent of `r` to move
/// to).
pub fn bookmarks_below(
    view: &View,
    tree: u64,
    r: u64,
    parent: Option<u64>,
) -> Result<Vec<(u64, u64, bool)>, StoreError> {
    let p = key::id(key::TREE_BOOKMARK, tree);
    let mut out = Vec::new();
    for (k, _) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
        let mut at = p.len();
        let b = get_u64(&k, &mut at).ok_or_else(|| bad("a bookmark key"))?;
        let Some(m) = chat::bookmark_at(view, b)? else {
            continue;
        };
        if !under(view, tree, r, m)? {
            continue;
        }
        let mode = chat::bookmark_mode(view, b)?.unwrap_or(chat::FOLLOWING);
        out.push((b, m, mode == chat::PINNED || parent.is_none()));
    }
    Ok(out)
}

/// `subtreeDelete`: message `message` and everything below it go.
pub struct SubtreeDelete;

impl Deriver for SubtreeDelete {
    fn derive(&self, rec: &Record, at: Loc, view: &View, out: &mut Out) -> Result<(), StoreError> {
        let r = id(rec, 0);
        let (s, u) = (chat::opt_id(rec, 1), chat::opt_id(rec, 2));
        sessions::check_actor(view, s, u)?;
        let (_, append) = require_message(view, r)?;
        let tree = id(&append, APPEND_OWNER);
        refuse_doomed(view, tree, r)?;
        let parent = parent_of(view, r, &append)?;
        let to = destination(view, tree, r, parent)?;
        for ses in sessions::pointers_in(view, tree)? {
            if let Some((_, Some(p))) = sessions::session_pointer(view, ses)?
                && under(view, tree, r, p)?
            {
                sessions::set_pointer(view, out, ses, tree, to)?;
            }
        }
        for (which, a) in sessions::remembered_in(view, tree)? {
            if which == 0 {
                if let Some(Some(p)) = sessions::session_in_tree(view, a, tree)?
                    && under(view, tree, r, p)?
                {
                    sessions::set_session_tree(view, out, a, tree, to)?;
                }
            } else if let Some((us, Some(p))) = sessions::user_in_tree(view, a, tree)?
                && under(view, tree, r, p)?
            {
                sessions::set_user_tree(view, out, a, tree, us, to)?;
            }
        }
        for (b, m, goes) in bookmarks_below(view, tree, r, parent)? {
            if goes {
                let Some(v) = view.get(&key::id(key::POSITION, b))? else {
                    continue;
                };
                chat::bookmark_gone(view, out, b, super::kinds::parse_loc(&v)?)?;
            } else if let Some(p) = parent {
                chat::bookmark_entries(out, b, tree, m, false);
                chat::bookmark_entries(out, b, tree, p, true);
            }
        }
        let time = match append.values[chat::APPEND_TIME] {
            Value::Time(t) => t,
            _ => unreachable!("checked by Record::new"),
        };
        out.del(child_key(parent, tree, time, r));
        if let Some(p) = parent {
            shape_add(out, p, -1);
        }
        if let Some(s) = s {
            sessions::activity(view, out, s, tree, at.pos)?;
        }
        out.put(key::id(PRUNE, r), varints(&[tree, r + 1, at.pos, at.len]));
        out.put(key::ids(PRUNE_IN, tree, r), Vec::new());
        out.add(key::id(PRUNE_TREE, tree), 1);
        Ok(())
    }

    fn is_live(&self, rec: &Record, pos: u64, view: &View) -> Result<bool, StoreError> {
        Ok(view
            .get(&key::id(PRUNE, id(rec, 0)))?
            .map(|b| parse_varints::<4>(&b))
            .transpose()?
            .is_some_and(|[_, _, rp, _]| rp == pos))
    }

    fn repoint(
        &self,
        rec: &Record,
        from: u64,
        to: Loc,
        view: &View,
        out: &mut Out,
    ) -> Result<(), StoreError> {
        let k = key::id(PRUNE, id(rec, 0));
        if let Some(b) = view.get(&k)? {
            let [tree, cur, rp, _] = parse_varints::<4>(&b)?;
            if rp == from {
                out.put(k, varints(&[tree, cur, to.pos, to.len]));
            }
        }
        Ok(())
    }
}

/// The first reply of `m`, if any.
fn first_reply(view: &View, m: u64) -> Result<Option<u64>, StoreError> {
    let p = key::id(key::CHILD, m);
    match view.scan(&p, &key::prefix_end(&p), 1)?.into_iter().next() {
        Some((k, _)) => Ok(Some(chat::child_of_key(&k, p.len())?)),
        None => Ok(None),
    }
}

/// One slice of the first pending delete: from its next message, down to a leaf and deleting it, then on from its
/// parent, up to `PRUNE_SLICE` visits; the root last. Returns whether one was found.
pub fn step(view: &View, out: &mut Out) -> Result<bool, StoreError> {
    let pp = key::of(PRUNE);
    let Some((pk, v)) = view.scan(&pp, &key::prefix_end(&pp), 1)?.into_iter().next() else {
        return Ok(false);
    };
    let mut at = pp.len();
    let r = get_u64(&pk, &mut at).ok_or_else(|| bad("a pending root key"))?;
    let [tree, cur, rp, rl] = parse_varints::<4>(&v)?;
    let mut local: BTreeMap<Vec<u8>, Val> = BTreeMap::new();
    let mut c = cur.checked_sub(1).ok_or_else(|| bad("a pending delete"))?;
    let mut done = false;
    for _ in 0..PRUNE_SLICE {
        let mut layers = vec![Layer::Sorted(&local)];
        layers.extend(view.layers.iter().copied());
        let lv = View {
            layers,
            pending: view.pending.clone(),
            staged: view.staged,
            bulk: view.bulk,
            ks: view.ks,
            snap: view.snap,
            log: view.log,
        };
        let mut o = Out::default();
        match first_reply(&lv, c)? {
            Some(x) => c = x,
            None => {
                let (l, rec) = require_message(&lv, c)?;
                let parent = parent_of(&lv, c, &rec)?;
                super::stats::removed(&lv, &mut o, c)?;
                chat::delete_message(&lv, &mut o, c, (l, rec), c == r)?;
                if c == r {
                    done = true;
                } else {
                    c = parent.ok_or_else(|| bad("a pending delete's message"))?;
                }
            }
        }
        drop(lv);
        o.apply(&mut local);
        if done {
            break;
        }
    }
    let mut o = Out::default();
    if done {
        o.del(key::id(PRUNE, r));
        o.del(key::ids(PRUNE_IN, tree, r));
        o.add(key::id(PRUNE_TREE, tree), -1);
        dead(&mut o, Loc { pos: rp, len: rl });
    } else {
        o.put(key::id(PRUNE, r), varints(&[tree, c + 1, rp, rl]));
    }
    o.apply(&mut local);
    out.entries.extend(local);
    Ok(true)
}

/// What deleting the subtrees of `roots` (in `tree`) drops besides their messages: the bookmarks that go
/// (`[bookmark, at]`, pinned ones and following ones with nowhere to move) and the state changes hanging on their
/// messages (`[change, message]`), walking the subtrees. The subtrees of `keep` are left out: they move away first
/// (a cut's tail).
#[allow(clippy::type_complexity)]
pub fn drops(
    view: &View,
    tree: u64,
    roots: &[u64],
    keep: &[u64],
) -> Result<(Vec<(u64, u64)>, Vec<(u64, u64)>), StoreError> {
    let kept = |m: u64| -> Result<bool, StoreError> {
        for &k in keep {
            if under(view, tree, k, m)? {
                return Ok(true);
            }
        }
        Ok(false)
    };
    let mut bookmarks = Vec::new();
    let mut changes = Vec::new();
    for &r in roots {
        let (_, append) = require_message(view, r)?;
        if id(&append, APPEND_OWNER) != tree {
            return Err(StoreError::Refused(format!(
                "message {r} isn't in tree {tree}"
            )));
        }
        let parent = parent_of(view, r, &append)?;
        for (b, m, goes) in bookmarks_below(view, tree, r, parent)? {
            if goes && !kept(m)? {
                bookmarks.push((b, m));
            }
        }
        let mut stack = vec![r];
        while let Some(m) = stack.pop() {
            if keep.contains(&m) {
                continue;
            }
            let shape = chat::shapes(view, &[m])?[0];
            if shape.extras > 0 {
                for (c, _) in super::state::changes_at(view, super::state::Hang::Message(m))? {
                    changes.push((c, m));
                }
            }
            if shape.replies > 0 {
                let p = key::id(key::CHILD, m);
                for (k, _) in view.scan(&p, &key::prefix_end(&p), usize::MAX)? {
                    stack.push(chat::child_of_key(&k, p.len())?);
                }
            }
        }
    }
    Ok((bookmarks, changes))
}
