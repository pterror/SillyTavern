use super::StoreError;
use super::chat_read::Js;
use super::derive::View;
use super::entry_label::{self, COMMENT, CONTENT};
use super::kinds::text_value;
use super::overview::{relations_line, uid_in};
use super::references::{key_items_with_text, key_list};
use super::relations::{self, order_key_of_entry, order_tree_space};
use super::world_order_tree as tree;
use crate::log::format::FieldRef;

pub const ORDER_VALUES_MOVED_AT_MOST: usize = 1000;

pub fn read_entry(view: &View, book: u64, entity: u64) -> Result<Js, StoreError> {
    let Some(own_key) = uid_in(view, book, entity)? else {
        return Ok(if relations::is_deleted_entry_of(view, book, entity)? {
            Js::Obj(vec![("deleted", Js::Bool(true))])
        } else {
            Js::Null
        });
    };
    let keys_list = key_list(view, book)?;
    let title = text_value(view, entity, &FieldRef::Code(COMMENT))?;
    let content = text_value(view, entity, &FieldRef::Code(CONTENT))?.unwrap_or_default();
    let keys = entry_label::keys_of(view, keys_list, entity)?;
    let names = entry_label::names_among(view, entity, &keys)?;
    let label = entry_label::label(entity, title.as_deref(), &names, || Ok(content.clone()))?;
    let mut keys_js = Vec::with_capacity(keys.len());
    for key_text in &keys {
        let own = keys.iter().filter(|other| *other == key_text).count() as u64;
        let also = key_items_with_text(view, book, key_text)?.saturating_sub(own);
        keys_js.push(Js::Obj(vec![
            ("text", Js::Text(key_text.clone())),
            ("isName", Js::Bool(names.contains(key_text))),
            ("alsoBringsUp", Js::Num(also as f64)),
        ]));
    }
    Ok(Js::Obj(vec![
        ("deleted", Js::Bool(false)),
        ("entryKey", Js::Text(own_key.text())),
        ("label", label.js()),
        ("title", title.map_or(Js::Null, Js::Text)),
        ("keys", Js::Arr(keys_js)),
        ("text", Js::Text(content)),
        ("relations", Js::Arr(relations_line(view, book, keys_list, entity)?)),
    ]))
}

pub fn labels(view: &View, book: u64, entities: &[u64]) -> Result<Js, StoreError> {
    let keys_list = key_list(view, book)?;
    let mut out = Vec::with_capacity(entities.len());
    for &entity in entities {
        out.push(match uid_in(view, book, entity)? {
            Some(_) => entry_label::named(view, keys_list, entity)?.js(),
            None => Js::Null,
        });
    }
    Ok(Js::Arr(out))
}

fn number_of_order_value(order_key: &tree::OrderKey) -> Option<f64> {
    let bits = u64::from_be_bytes(order_key[..8].try_into().expect("8 bytes"));
    let number = f64::from_bits(if bits >> 63 == 1 { bits & !(1 << 63) } else { !bits });
    number.is_finite().then_some(number)
}

fn above(low: f64, high: Option<f64>) -> Option<f64> {
    let whole = low.floor() + 1.0;
    match high {
        None => (whole > low).then_some(whole),
        Some(high) if whole < high => Some(whole),
        Some(high) => {
            let middle = low + (high - low) / 2.0;
            (middle > low && middle < high).then_some(middle)
        }
    }
}

fn placed(display_index: f64, moved: Vec<(u64, f64)>) -> Js {
    Js::Obj(vec![
        ("displayIndex", Js::Num(display_index)),
        (
            "moved",
            Js::Arr(
                moved
                    .into_iter()
                    .map(|(entity, index)| {
                        Js::Obj(vec![("entry", Js::Big(entity)), ("displayIndex", Js::Num(index))])
                    })
                    .collect(),
            ),
        ),
    ])
}

pub fn place_after(view: &View, book: u64, after: Option<u64>) -> Result<Js, StoreError> {
    let book_tree = order_tree_space(book);
    let numbered = tree::top_level_rank(view, &book_tree, &tree::order_key(u64::MAX, 0), None)?;
    let last_number = || -> Result<Option<f64>, StoreError> {
        if numbered == 0 {
            return Ok(None);
        }
        Ok(tree::top_level_from_rank(view, &book_tree, None, numbered - 1, 1)?
            .first()
            .and_then(number_of_order_value))
    };
    let at_the_end = |last: Option<f64>| match last {
        None => placed(0.0, Vec::new()),
        Some(last) => placed(above(last, None).unwrap_or(last), Vec::new()),
    };
    let Some(after) = after else {
        return Ok(at_the_end(last_number()?));
    };
    let Some(own_key) = uid_in(view, book, after)? else {
        return Ok(Js::Obj(vec![(
            "refused",
            Js::Text(b"That entry isn't in this world.".to_vec()),
        )]));
    };
    let after_key = order_key_of_entry(view, after, &own_key)?;
    let Some(low) = number_of_order_value(&after_key) else {
        return Ok(at_the_end(last_number()?));
    };
    let rank = tree::top_level_rank(view, &book_tree, &after_key, None)?;
    let next = tree::top_level_from_rank(view, &book_tree, None, rank + 1, 1)?;
    let high = next.first().and_then(number_of_order_value);
    if high != Some(low) {
        return Ok(placed(above(low, high).unwrap_or(low), Vec::new()));
    }
    let mut tied = Vec::new();
    let mut beyond = None;
    let mut from = rank + 1;
    while tied.len() <= ORDER_VALUES_MOVED_AT_MOST {
        let page = tree::top_level_from_rank(view, &book_tree, None, from, 256)?;
        if page.is_empty() {
            break;
        }
        from += page.len() as u64;
        let mut ended = false;
        for order_key in &page {
            match number_of_order_value(order_key) {
                Some(value) if value == low => tied.push(tree::entity_of_order_key(order_key)),
                value => {
                    beyond = Some(value);
                    ended = true;
                    break;
                }
            }
        }
        if ended {
            break;
        }
    }
    let moved_to = match beyond {
        Some(Some(value)) => above(low, Some(value)),
        _ => above(low, None),
    };
    match moved_to {
        Some(index) if tied.len() <= ORDER_VALUES_MOVED_AT_MOST => Ok(placed(
            low,
            tied.into_iter().map(|entity| (entity, index)).collect(),
        )),
        _ => Ok(placed(low, Vec::new())),
    }
}
