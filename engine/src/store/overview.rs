use super::StoreError;
use super::books::{ENTRY, EntryKey, entry_key, parse_entry_key};
use super::chat_read::Js;
use super::counted;
use super::derive::View;
use super::kinds::{key, text_value};
use super::library::{self, entity_info, item_field};
use super::relations;
use crate::log::format::FieldRef;

pub const FIRST: usize = 3;
pub const DEPTH: usize = 2;
pub const TEXT: usize = 400;
pub const MAX_WINDOW: u64 = 200;

const COMMENT: u64 = 103;
const CONTENT: u64 = 104;

#[derive(Clone, Copy)]
pub struct Grouping<'a> {
    pub book: u64,
    pub relation: Option<&'a [u8]>,
}

#[derive(Debug, Clone, Copy)]
pub enum Move {
    By(i64),
    Parent,
    Child,
}

struct Node {
    e: u64,
    uid: EntryKey,
    key: String,
    members: u64,
    repeat: bool,
    children: Vec<Child>,
}

enum Child {
    Entry(Node),
    More { key: String, more: u64 },
}

fn refused(why: String) -> StoreError {
    StoreError::Refused(format!("overview: {why}"))
}

fn uid_in(view: &View, book: u64, e: u64) -> Result<Option<EntryKey>, StoreError> {
    Ok(match entity_info(view, e)? {
        Some((ENTRY, k, _)) => match parse_entry_key(&k)? {
            (b, uid) if b == book => Some(uid),
            _ => None,
        },
        _ => None,
    })
}

fn path_key(path: &[u64]) -> String {
    path.iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join("/")
}

fn region(view: &View, g: Grouping, path: &mut Vec<u64>, depth: usize) -> Result<Node, StoreError> {
    let e = *path.last().expect("a region has its entry");
    let uid = uid_in(view, g.book, e)?
        .ok_or_else(|| StoreError::Entry(format!("member {e} isn't an entry")))?;
    let key = path_key(path);
    let repeat = path[..path.len() - 1].contains(&e);
    let mut node = Node {
        e,
        key,
        members: 0,
        repeat,
        children: Vec::new(),
        uid,
    };
    let Some(r) = g.relation else {
        return Ok(node);
    };
    let t = node.uid.text();
    node.members = relations::group_count(view, g.book, r, &t)?;
    if repeat || node.members == 0 {
        return Ok(node);
    }
    let mut shown = 0;
    if depth < DEPTH {
        let prefix = relations::members_prefix(g.book, r, &t);
        for (k, _) in view.scan(&prefix, &key::prefix_end(&prefix), FIRST)? {
            path.push(relations::member_of(&prefix, &k)?);
            let child = region(view, g, path, depth + 1);
            path.pop();
            node.children.push(Child::Entry(child?));
            shown += 1;
        }
    }
    if node.members > shown {
        node.children.push(Child::More {
            key: format!("{}/+", node.key),
            more: node.members - shown,
        });
    }
    Ok(node)
}

fn order(node: &Node, out: &mut Vec<String>) {
    out.push(node.key.clone());
    for c in &node.children {
        match c {
            Child::Entry(n) => order(n, out),
            Child::More { key, .. } => out.push(key.clone()),
        }
    }
}

fn find<'n>(node: &'n Node, k: &str) -> Option<&'n Node> {
    if node.key == k {
        return Some(node);
    }
    node.children.iter().find_map(|c| match c {
        Child::Entry(n) if k.starts_with(&format!("{}/", n.key)) || n.key == k => find(n, k),
        _ => None,
    })
}

pub fn count(view: &View, g: Grouping) -> Result<u64, StoreError> {
    counted::size(view, &relations::space(g.book), g.relation)
}

fn root_at(view: &View, g: Grouping, rank: u64) -> Result<Option<Node>, StoreError> {
    let Some(x) = counted::take(view, &relations::space(g.book), g.relation, rank, 1)?.pop() else {
        return Ok(None);
    };
    region(view, g, &mut vec![counted::entity_of(&x)], 0).map(Some)
}

fn top_rank(view: &View, g: Grouping, e: u64) -> Result<Option<u64>, StoreError> {
    let Some(uid) = uid_in(view, g.book, e)? else {
        return Ok(None);
    };
    if let Some(r) = g.relation
        && relations::rels_of(view, e)?
            .keys()
            .any(|(k, _)| k.as_slice() == r)
    {
        return Ok(None);
    }
    let x = relations::elem_of(view, e, &uid)?;
    let sp = relations::space(g.book);
    if !counted::contains(view, &sp, &x)? {
        return Ok(None);
    }
    counted::rank(view, &sp, &x, g.relation).map(Some)
}

fn parse_path(k: &str) -> Option<Vec<&str>> {
    let parts: Vec<&str> = k.split('/').collect();
    let ok = parts.iter().enumerate().all(|(i, p)| {
        (*p == "+" && i == parts.len() - 1 && i > 0)
            || (!p.is_empty()
                && p.len() <= 20
                && p.bytes().all(|c| c.is_ascii_digit())
                && (p.len() == 1 || !p.starts_with('0')))
    });
    ok.then_some(parts)
}

fn locate(view: &View, g: Grouping, k: &str) -> Result<Option<(Node, String, u64)>, StoreError> {
    let Some(parts) = parse_path(k) else {
        return Err(refused(format!("{k:?} isn't an occurrence's key")));
    };
    let Ok(root) = parts[0].parse::<u64>() else {
        return Ok(None);
    };
    let Some(rank) = top_rank(view, g, root)? else {
        return Ok(None);
    };
    let tree = region(view, g, &mut vec![root], 0)?;
    let mut flat = Vec::new();
    order(&tree, &mut flat);
    let found = (1..=parts.len())
        .rev()
        .map(|at| parts[..at].join("/"))
        .find(|k| flat.contains(k))
        .unwrap_or_else(|| tree.key.clone());
    Ok(Some((tree, found, rank)))
}

fn flat_at(view: &View, g: Grouping, rank: u64) -> Result<Vec<String>, StoreError> {
    let mut flat = Vec::new();
    if let Some(n) = root_at(view, g, rank)? {
        order(&n, &mut flat);
    }
    Ok(flat)
}

fn landed(key: String, rank: u64) -> Js {
    Js::Obj(vec![
        ("key", Js::Text(key.into_bytes())),
        ("rank", Js::Num(rank as f64)),
    ])
}

pub fn moved(view: &View, g: Grouping, from: Option<&str>, how: Move) -> Result<Js, StoreError> {
    let total = count(view, g)?;
    if total == 0 {
        return Ok(Js::Null);
    }
    let (tree, key, rank) = match from {
        Some(k) => match locate(view, g, k)? {
            Some(found) => found,
            None => return Ok(Js::Null),
        },
        None => {
            let (rank, n, last) = match how {
                Move::By(n) if n > 0 => (0, n - 1, false),
                Move::By(n) if n < 0 => (total - 1, n + 1, true),
                _ => return Ok(Js::Null),
            };
            let flat = flat_at(view, g, rank)?;
            let start = if last { flat.len() - 1 } else { 0 };
            return walk(view, g, total, flat, start, rank, n);
        }
    };
    match how {
        Move::Parent => {
            let up = match key.rsplit_once('/') {
                Some((up, _)) => up.to_string(),
                None => key,
            };
            Ok(landed(up, rank))
        }
        Move::Child => {
            let first = find(&tree, &key)
                .and_then(|n| n.children.first())
                .map(|c| match c {
                    Child::Entry(n) => n.key.clone(),
                    Child::More { key, .. } => key.clone(),
                });
            Ok(landed(first.unwrap_or(key), rank))
        }
        Move::By(n) => {
            let mut flat = Vec::new();
            order(&tree, &mut flat);
            let at = flat
                .iter()
                .position(|k| *k == key)
                .expect("located in its tree");
            walk(view, g, total, flat, at, rank, n)
        }
    }
}

fn walk(
    view: &View,
    g: Grouping,
    total: u64,
    mut flat: Vec<String>,
    at: usize,
    mut rank: u64,
    n: i64,
) -> Result<Js, StoreError> {
    let mut target = at as i64 + n;
    loop {
        if target < 0 {
            if rank == 0 {
                return Ok(landed(flat[0].clone(), rank));
            }
            rank -= 1;
            flat = flat_at(view, g, rank)?;
            target += flat.len() as i64;
        } else if target as usize >= flat.len() {
            if rank + 1 >= total {
                return Ok(landed(flat[flat.len() - 1].clone(), rank));
            }
            target -= flat.len() as i64;
            rank += 1;
            flat = flat_at(view, g, rank)?;
        } else {
            return Ok(landed(flat[target as usize].clone(), rank));
        }
    }
}

fn cut(t: &[u8], n: usize) -> (Vec<u8>, bool) {
    if t.len() <= n {
        return (t.to_vec(), false);
    }
    let mut end = n;
    while end > 0 && t[end] & 0xc0 == 0x80 {
        end -= 1;
    }
    (t[..end].to_vec(), true)
}

fn text_or_null(view: &View, e: u64, code: u64) -> Result<Js, StoreError> {
    Ok(text_value(view, e, &FieldRef::Code(code))?.map_or(Js::Null, Js::Text))
}

fn card(
    view: &View,
    g: Grouping,
    keys_list: Option<u64>,
    n: &Node,
) -> Result<Vec<(&'static str, Js)>, StoreError> {
    let content = text_value(view, n.e, &FieldRef::Code(CONTENT))?.unwrap_or_default();
    let (text, was_cut) = cut(&content, TEXT);
    let mut keys = Vec::new();
    if let Some(list) = keys_list {
        let prefix = key::ids(key::ITEM, n.e, list);
        for (_, v) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
            let item = library::parse_uvarint(&v)?;
            if let Some(t) = text_value(view, n.e, &item_field(list, item))? {
                keys.push(Js::Text(t));
            }
        }
    }
    let mut rels = Vec::new();
    for ((r, t), _) in relations::rels_of(view, n.e)? {
        let target = library::entity_by_key(view, ENTRY, &entry_key(g.book, &EntryKey::parse(&t)))?;
        rels.push(Js::Obj(vec![
            ("relation", Js::Text(r)),
            ("target", Js::Text(t)),
            (
                "entry",
                target.map_or(Js::Null, |e| Js::Text(e.to_string().into_bytes())),
            ),
            (
                "title",
                match target {
                    Some(e) => text_or_null(view, e, COMMENT)?,
                    None => Js::Null,
                },
            ),
        ]));
    }
    Ok(vec![
        ("kind", Js::Text(b"entry".to_vec())),
        ("key", Js::Text(n.key.clone().into_bytes())),
        ("entry", Js::Text(n.e.to_string().into_bytes())),
        ("uid", Js::Text(n.uid.text())),
        ("title", text_or_null(view, n.e, COMMENT)?),
        ("text", Js::Text(text)),
        ("cut", Js::Bool(was_cut)),
        ("keys", Js::Arr(keys)),
        ("relations", Js::Arr(rels)),
        ("members", Js::Num(n.members as f64)),
        ("repeat", Js::Bool(n.repeat)),
    ])
}

fn drawn(view: &View, g: Grouping, keys_list: Option<u64>, n: &Node) -> Result<Js, StoreError> {
    let mut o = card(view, g, keys_list, n)?;
    let mut children = Vec::new();
    for c in &n.children {
        children.push(match c {
            Child::Entry(n) => drawn(view, g, keys_list, n)?,
            Child::More { key, more } => Js::Obj(vec![
                ("kind", Js::Text(b"more".to_vec())),
                ("key", Js::Text(key.clone().into_bytes())),
                ("more", Js::Num(*more as f64)),
            ]),
        });
    }
    o.push(("children", Js::Arr(children)));
    Ok(Js::Obj(o))
}

pub fn window(
    view: &View,
    g: Grouping,
    from: u64,
    to: u64,
    active: Option<&str>,
) -> Result<Js, StoreError> {
    let total = count(view, g)?;
    let from = from.min(total);
    let to = to.clamp(from, total.min(from + MAX_WINDOW));
    let keys_list = super::references::key_list(view, g.book)?;
    let mut items = Vec::new();
    let sp = relations::space(g.book);
    for (i, x) in counted::take(view, &sp, g.relation, from, (to - from) as usize)?
        .iter()
        .enumerate()
    {
        let node = region(view, g, &mut vec![counted::entity_of(x)], 0)?;
        let Js::Obj(mut o) = drawn(view, g, keys_list, &node)? else {
            unreachable!("a card is an object")
        };
        o.push(("rank", Js::Num((from + i as u64) as f64)));
        items.push(Js::Obj(o));
    }
    let active = match active {
        Some(k) => match locate(view, g, k)? {
            Some((_, key, rank)) => landed(key, rank),
            None => Js::Null,
        },
        None => Js::Null,
    };
    Ok(Js::Obj(vec![
        ("count", Js::Num(total as f64)),
        ("from", Js::Num(from as f64)),
        ("items", Js::Arr(items)),
        ("active", active),
    ]))
}
