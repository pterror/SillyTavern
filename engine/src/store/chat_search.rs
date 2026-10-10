//! A tree's sessions searched (`/api/chats/search`, design S5): a session matches when its name matches the query,
//! or when every positive clause matches some message on its path (root to its position in the tree) and no
//! negated clause matches any. Messages are matched through the tree's chat postings, each once per page (sessions
//! share most of their paths); sessions are read most recent first, under a work limit.

use std::collections::HashMap;

use super::StoreError;
use super::chat;
use super::derive::View;
use super::sessions;
use crate::search::Scope;
use crate::search::query::{Clause, Limits, Matching, Order, Query, StatsCache};

/// Work a page does at most (`query::Ctx` units: about 0.16 µs each), and per path message read.
pub const WORK: u64 = 2_000_000;
const PATH_MESSAGE: u64 = 8;

#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    /// Its place in the tree's order (a `before` for the next page).
    pub position: u64,
    pub session: u64,
    /// Its position in the tree (None: the tree's root).
    pub at: Option<u64>,
}

#[derive(Debug, Default)]
pub struct Page {
    pub hits: Vec<Hit>,
    /// Sessions follow the last one read: continue `before` `next`.
    pub more: bool,
    pub next: Option<u64>,
}

fn one(scope: Scope, clauses: Vec<Clause>) -> Query {
    Query {
        scope,
        clauses,
        filters: Vec::new(),
        order: Order::Relevance,
        limit: 0,
        after: None,
        limits: Limits::default(),
    }
}

pub fn page(
    view: &View,
    tree: u64,
    clauses: &[Clause],
    before: Option<u64>,
    limit: usize,
    cache: &StatsCache,
) -> Result<Page, StoreError> {
    let words: Vec<&Clause> = clauses
        .iter()
        .filter(|c| !crate::search::text::tokens(&c.text).is_empty())
        .collect();
    let mut texts = Vec::new();
    for c in &words {
        let plain = Clause {
            negate: false,
            fields: None,
            ..(*c).clone()
        };
        texts.push((
            c.negate,
            Matching::new(view, &one(Scope::chat(tree), vec![plain]), cache)?,
        ));
    }
    let named: Vec<Clause> = words
        .iter()
        .map(|c| Clause {
            fields: None,
            ..(*c).clone()
        })
        .collect();
    // A name matches a query with a word to find in it.
    let by_name = words.iter().any(|c| !c.negate);
    let mut names = Matching::new(view, &one(Scope::SESSIONS, named), cache)?;
    // Per message read: whether each clause matches it.
    let mut seen: HashMap<u64, Vec<bool>> = HashMap::new();
    let mut out = Page::default();
    let mut from = before;
    let mut read = 0u64;
    let work = |texts: &[(bool, Matching)], names: &Matching, read: u64| -> u64 {
        texts.iter().map(|t| t.1.work()).sum::<u64>() + names.work() + read * PATH_MESSAGE
    };
    loop {
        let batch = sessions::in_tree(view, tree, from, 64)?;
        let Some(last) = batch.last() else {
            return Ok(out);
        };
        let full = batch.len() == 64;
        from = Some(last.0);
        for (position, session) in batch {
            if out.hits.len() == limit || work(&texts, &names, read) > WORK {
                out.more = true;
                // The session at `position` hasn't been read: the next page starts at it.
                out.next = Some(position + 1);
                return Ok(out);
            }
            let Some(at) = sessions::session_in_tree(view, session, tree)? else {
                continue;
            };
            let hit = || Hit {
                position,
                session,
                at,
            };
            if words.is_empty() || (by_name && names.matches(session)?) {
                out.hits.push(hit());
                continue;
            }
            let mut found = vec![false; texts.len()];
            for m in chat::path_to(view, at)?.into_iter().rev() {
                let r = match seen.get(&m) {
                    Some(r) => r.clone(),
                    None => {
                        read += 1;
                        let mut r = Vec::with_capacity(texts.len());
                        for (_, t) in &mut texts {
                            r.push(t.matches(m)?);
                        }
                        seen.insert(m, r.clone());
                        r
                    }
                };
                for (f, x) in found.iter_mut().zip(r) {
                    *f |= x;
                }
            }
            if texts.iter().zip(&found).all(|((negate, _), f)| f != negate) {
                out.hits.push(hit());
            }
        }
        if !full {
            return Ok(out);
        }
    }
}
