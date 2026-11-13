use std::collections::BTreeSet;

use super::StoreError;
use super::chat_read::Js;
use super::derive::View;
use super::kinds::{key, text_value};
use super::library::{self, item_field};
use crate::log::format::FieldRef;

pub const COMMENT: u64 = 103;
pub const CONTENT: u64 = 104;
pub const NAMES_FIELD: &[u8] = b"\x01names";
pub const OPENING_CHARACTERS: usize = 120;

pub fn names_field() -> FieldRef {
    FieldRef::Key(NAMES_FIELD.to_vec())
}

// The entry's picture: the id of an image in the user's image store, as text.
pub const PICTURE_FIELD: &[u8] = b"\x01picture";

pub fn picture(view: &View, entity: u64) -> Result<Js, StoreError> {
    Ok(text_value(view, entity, &FieldRef::Key(PICTURE_FIELD.to_vec()))?
        .filter(|id| !id.is_empty())
        .map_or(Js::Null, Js::Text))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShownAs {
    Name,
    Title,
    Opening,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Named {
    pub thing: u64,
    pub text: Vec<u8>,
    pub shown_as: ShownAs,
}

impl Named {
    pub fn js(&self) -> Js {
        Js::Obj(vec![
            ("thing", Js::Text(self.thing.to_string().into_bytes())),
            ("text", Js::Text(self.text.clone())),
            (
                "shownAs",
                Js::Text(
                    match self.shown_as {
                        ShownAs::Name => b"name".to_vec(),
                        ShownAs::Title => b"title".to_vec(),
                        ShownAs::Opening => b"opening".to_vec(),
                    },
                ),
            ),
        ])
    }
}

pub fn keys_of(
    view: &View,
    keys_list: Option<u64>,
    entity: u64,
) -> Result<Vec<Vec<u8>>, StoreError> {
    let mut keys = Vec::new();
    let Some(list) = keys_list else {
        return Ok(keys);
    };
    let prefix = key::ids(key::ITEM, entity, list);
    for (_, value) in view.scan(&prefix, &key::prefix_end(&prefix), usize::MAX)? {
        let item = library::parse_uvarint(&value)?;
        if let Some(key_text) = text_value(view, entity, &item_field(list, item))? {
            keys.push(key_text);
        }
    }
    Ok(keys)
}

pub fn names_among(
    view: &View,
    entity: u64,
    keys: &[Vec<u8>],
) -> Result<Vec<Vec<u8>>, StoreError> {
    let Some(json) = super::history::json_value(view, entity, &names_field())? else {
        return Ok(Vec::new());
    };
    let Some(marked) = super::relations::json_strings_of_list(&json) else {
        return Ok(Vec::new());
    };
    let marked: BTreeSet<Vec<u8>> = marked.into_iter().collect();
    let mut seen = BTreeSet::new();
    Ok(keys
        .iter()
        .filter(|key_text| marked.contains(*key_text) && seen.insert((*key_text).clone()))
        .cloned()
        .collect())
}

pub fn has_title(title: Option<&[u8]>) -> bool {
    title.is_some_and(|title| !title.iter().all(u8::is_ascii_whitespace))
}

pub fn opening(content: &[u8]) -> Vec<u8> {
    let start = content
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(content.len());
    let rest = &content[start..];
    let line_end = rest
        .iter()
        .position(|byte| *byte == b'\n' || *byte == b'\r')
        .unwrap_or(rest.len());
    let mut line = &rest[..line_end];
    let mut seen = 0;
    for (index, byte) in line.iter().enumerate() {
        if byte & 0xc0 != 0x80 {
            if seen == OPENING_CHARACTERS {
                line = &line[..index];
                break;
            }
            seen += 1;
        }
    }
    let end = line
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map_or(0, |last| last + 1);
    line[..end].to_vec()
}

pub fn label(
    entity: u64,
    title: Option<&[u8]>,
    names: &[Vec<u8>],
    content: impl FnOnce() -> Result<Vec<u8>, StoreError>,
) -> Result<Named, StoreError> {
    if let Some(title) = title.filter(|title| has_title(Some(title))) {
        let words = super::names_offer::trimmed(title);
        let shown_as = if names.iter().any(|name| super::names_offer::trimmed(name) == words) {
            ShownAs::Name
        } else {
            ShownAs::Title
        };
        return Ok(Named {
            thing: entity,
            text: title.to_vec(),
            shown_as,
        });
    }
    if let Some(name) = names.first() {
        return Ok(Named {
            thing: entity,
            text: name.clone(),
            shown_as: ShownAs::Name,
        });
    }
    Ok(Named {
        thing: entity,
        text: opening(&content()?),
        shown_as: ShownAs::Opening,
    })
}

pub fn named(view: &View, keys_list: Option<u64>, entity: u64) -> Result<Named, StoreError> {
    let title = text_value(view, entity, &FieldRef::Code(COMMENT))?;
    let keys = keys_of(view, keys_list, entity)?;
    let names = names_among(view, entity, &keys)?;
    label(entity, title.as_deref(), &names, || {
        Ok(text_value(view, entity, &FieldRef::Code(CONTENT))?.unwrap_or_default())
    })
}
