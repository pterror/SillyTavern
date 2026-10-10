//! A store (record log and derived keyspace) as JavaScript sees it.
//!
//! A record is an object `{ kind, ...values }` named by its kind's schema (`log::format::KINDS`). Ids and
//! positions are BigInts (they pass 2^53); other integers, times (ms) and floats are numbers; a field is a
//! number (a known field's code) or a string (an extension's own key); text is a string, bytes a Uint8Array;
//! bits are booleans; an optional value is left out when absent. Anything else, including a property the
//! kind doesn't have, is refused rather than dropped.

use std::path::PathBuf;
use std::sync::Arc;

use napi::bindgen_prelude::{
    AsyncTask, BigInt, Buffer, FromNapiValue, Object, ToNapiValue, TypeName, Uint8Array, Unknown,
    Utf16String,
};
use napi::{Env, Error, Result, Status, Task, ValueType, sys};
use napi_derive::napi;

use crate::log::format::{
    FieldRef, MAX_SAFE, Record, Slot, Ty, Value, kind_by_name, wtf8_from_utf16, wtf8_to_utf16,
};
use crate::search::Scope;
use crate::search::query::{After, Clause, Filter, Found, Limits, Order, Query};
use crate::store::kinds::key;
use crate::store::{
    Store as Inner, StoreConfig, StoreError, StoreResult, library, library_read, tags,
};

fn invalid(msg: String) -> Error {
    Error::new(Status::InvalidArg, msg)
}

fn store_error(e: StoreError) -> Error {
    match e {
        StoreError::Refused(why) => invalid(why),
        e => Error::from_reason(e.to_string()),
    }
}

fn integer(name: &str, v: Unknown) -> Result<u64> {
    match v.get_type()? {
        ValueType::Number => {
            let n = f64::from_unknown(v)?;
            if n.fract() == 0.0 && n >= 0.0 && n <= MAX_SAFE as f64 {
                Ok(n as u64)
            } else {
                Err(invalid(format!(
                    "{name} must be a non-negative safe integer, got {n}"
                )))
            }
        }
        ValueType::BigInt => match BigInt::from_unknown(v)?.get_u64() {
            (false, n, true) => Ok(n),
            _ => Err(invalid(format!(
                "{name} must be a non-negative BigInt below 2^64"
            ))),
        },
        t => Err(invalid(format!("{name} must be an integer, got {t}"))),
    }
}

fn signed(name: &str, v: Unknown) -> Result<i64> {
    if v.get_type()? != ValueType::Number {
        return Err(invalid(format!("{name} must be a number")));
    }
    let n = f64::from_unknown(v)?;
    if n.fract() == 0.0 && n.abs() <= MAX_SAFE as f64 {
        Ok(n as i64)
    } else {
        Err(invalid(format!("{name} must be a safe integer, got {n}")))
    }
}

fn string(name: &str, v: Unknown) -> Result<Vec<u8>> {
    if v.get_type()? != ValueType::String {
        return Err(invalid(format!("{name} must be a string")));
    }
    Ok(wtf8_from_utf16(&Utf16String::from_unknown(v)?))
}

fn value_from_js(slot: &Slot, v: Option<Unknown>) -> Result<Value> {
    let name = slot.name;
    let Some(v) = v else {
        return if slot.optional {
            Ok(Value::Absent)
        } else {
            Err(invalid(format!("{name} is missing")))
        };
    };
    Ok(match slot.ty {
        Ty::Bit => {
            if v.get_type()? != ValueType::Boolean {
                return Err(invalid(format!("{name} must be a boolean")));
            }
            Value::Bit(bool::from_unknown(v)?)
        }
        Ty::UInt => Value::UInt(integer(name, v)?),
        Ty::Id(_) => Value::Id(integer(name, v)?),
        Ty::Int => Value::Int(signed(name, v)?),
        Ty::Time => Value::Time(signed(name, v)?),
        Ty::F64 => {
            if v.get_type()? != ValueType::Number {
                return Err(invalid(format!("{name} must be a number")));
            }
            Value::F64(f64::from_unknown(v)?)
        }
        Ty::Field => match v.get_type()? {
            ValueType::String => Value::Field(FieldRef::Key(string(name, v)?)),
            _ => Value::Field(FieldRef::Code(integer(name, v)?)),
        },
        Ty::Text => Value::Text(string(name, v)?),
        Ty::Bytes => Value::Bytes(
            Uint8Array::from_unknown(v)
                .map_err(|_| invalid(format!("{name} must be a Uint8Array")))?
                .to_vec(),
        ),
    })
}

fn record_from_js(obj: &Object) -> Result<Record> {
    let kind_name: String = obj
        .get("kind")?
        .ok_or_else(|| invalid("a record needs a kind".into()))?;
    let kind = kind_by_name(&kind_name)
        .filter(|k| !k.internal)
        .ok_or_else(|| invalid(format!("no record kind {kind_name}")))?;
    for key in Object::keys(obj)? {
        if key != "kind" && !kind.slots.iter().any(|s| s.name == key) {
            return Err(invalid(format!("{kind_name} has no value {key}")));
        }
    }
    let values = kind
        .slots
        .iter()
        .map(|slot| value_from_js(slot, obj.get::<Unknown>(slot.name)?))
        .collect::<Result<Vec<_>>>()?;
    Record::new(kind, values).map_err(invalid)
}

/// A record and its position, converted to a JavaScript object.
pub struct RecordAt(u64, Record);

impl ToNapiValue for RecordAt {
    unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let mut obj = Object::new(&env)?;
        let RecordAt(position, rec) = val;
        obj.set("kind", rec.kind.name)?;
        obj.set("position", position)?;
        for (slot, value) in rec.kind.slots.iter().zip(rec.values) {
            match value {
                Value::Absent => {}
                Value::Bit(b) => obj.set(slot.name, b)?,
                Value::UInt(n) => obj.set(slot.name, n as f64)?,
                Value::Int(n) | Value::Time(n) => obj.set(slot.name, n as f64)?,
                Value::F64(n) => obj.set(slot.name, n)?,
                Value::Id(n) => obj.set(slot.name, n)?,
                Value::Field(FieldRef::Code(c)) => obj.set(slot.name, c as f64)?,
                Value::Field(FieldRef::Key(k)) | Value::Text(k) => {
                    obj.set(slot.name, text_to_js(k)?)?
                }
                Value::Bytes(b) => obj.set(slot.name, Buffer::from(b))?,
            }
        }
        unsafe { Object::to_napi_value(raw_env, obj) }
    }
}

pub struct Page(Vec<(u64, Record)>, u64);

impl ToNapiValue for Page {
    unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let mut obj = Object::new(&env)?;
        obj.set(
            "records",
            val.0
                .into_iter()
                .map(|(p, r)| RecordAt(p, r))
                .collect::<Vec<_>>(),
        )?;
        obj.set("next", val.1)?;
        unsafe { Object::to_napi_value(raw_env, obj) }
    }
}

fn text_to_js(b: Vec<u8>) -> Result<JsText> {
    Ok(JsText(
        wtf8_to_utf16(&b).map_err(|e| Error::from_reason(e.to_string()))?,
    ))
}

/// A JavaScript string from UTF-16 code units, lone surrogates kept.
pub struct JsText(Vec<u16>);

unsafe fn utf16_string(env: sys::napi_env, units: &[u16]) -> Result<sys::napi_value> {
    let mut out = std::ptr::null_mut();
    napi::check_status!(unsafe {
        sys::napi_create_string_utf16(env, units.as_ptr(), units.len() as isize, &mut out)
    })?;
    Ok(out)
}

/// The lengths of the pieces the text splits into around each lone surrogate, or None if it has none.
#[cfg(any(target_family = "wasm", test))]
fn lone_surrogate_pieces(units: &[u16]) -> Option<Vec<usize>> {
    let mut pieces = Vec::new();
    let (mut start, mut i, mut lone) = (0, 0, false);
    while i < units.len() {
        let u = units[i];
        let paired = (0xd800..0xdc00).contains(&u)
            && units
                .get(i + 1)
                .is_some_and(|n| (0xdc00..0xe000).contains(n));
        if paired {
            i += 2;
        } else if (0xd800..0xe000).contains(&u) {
            lone = true;
            if i > start {
                pieces.push(i - start);
            }
            pieces.push(1);
            i += 1;
            start = i;
        } else {
            i += 1;
        }
    }
    if i > start {
        pieces.push(i - start);
    }
    lone.then_some(pieces)
}

impl ToNapiValue for JsText {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        // emnapi (the wasm build's Node-API) decodes a string of more than 16 code units with
        // TextDecoder('utf-16le'), which turns a lone surrogate into U+FFFD; one or a few units it copies
        // exactly. So a text holding lone surrogates is made of pieces, each lone surrogate a piece of its
        // own, joined by String.prototype.concat.
        #[cfg(target_family = "wasm")]
        if let Some(pieces) = lone_surrogate_pieces(&val.0) {
            unsafe {
                let mut values = Vec::with_capacity(pieces.len());
                let mut at = 0;
                for len in pieces {
                    values.push(utf16_string(env, &val.0[at..at + len])?);
                    at += len;
                }
                let mut global = std::ptr::null_mut();
                napi::check_status!(sys::napi_get_global(env, &mut global))?;
                let mut f = global;
                for name in [c"String", c"prototype", c"concat"] {
                    let mut next = std::ptr::null_mut();
                    napi::check_status!(sys::napi_get_named_property(
                        env,
                        f,
                        name.as_ptr(),
                        &mut next
                    ))?;
                    f = next;
                }
                let mut acc = values[0];
                for args in values[1..].chunks(1024) {
                    let mut out = std::ptr::null_mut();
                    napi::check_status!(sys::napi_call_function(
                        env,
                        acc,
                        f,
                        args.len(),
                        args.as_ptr(),
                        &mut out
                    ))?;
                    acc = out;
                }
                return Ok(acc);
            }
        }
        unsafe { utf16_string(env, &val.0) }
    }
}

#[cfg(test)]
#[test]
fn lone_surrogates_are_pieces_of_their_own() {
    let t = |s: &[u16]| lone_surrogate_pieces(s);
    assert_eq!(t(&[0x61, 0x62]), None);
    assert_eq!(t(&[0xd83d, 0xde00, 0x61]), None);
    assert_eq!(t(&[0x61, 0xd800, 0x62, 0x63]), Some(vec![1, 1, 2]));
    assert_eq!(t(&[0xdc00, 0xd83d, 0xde00, 0xd800]), Some(vec![1, 2, 1]));
}

/// Runs a job on a libuv thread.
struct RunTask(Option<Box<dyn FnOnce() + Send>>);

impl Task for RunTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<()> {
        if let Some(f) = self.0.take() {
            f();
        }
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _: ()) -> Result<()> {
        Ok(())
    }
}

/// A promise of a read of derived data: run once replay is done, on a libuv thread (or, while replay runs, on
/// its thread right after it), so no thread waits for replay.
fn derived<'env, T, F>(env: &'env Env, store: &Arc<Inner>, read: F) -> Result<Object<'env>>
where
    T: ToNapiValue + Send + 'static,
    F: FnOnce(&Inner) -> StoreResult<T> + Send + 'static,
{
    let (deferred, promise) = env.create_deferred()?;
    let s = store.clone();
    let job: Box<dyn FnOnce() + Send> = Box::new(move || match read(&s) {
        Ok(v) => deferred.resolve(move |_| Ok(v)),
        Err(e) => deferred.reject(store_error(e)),
    });
    if let Some(job) = store.after_replay(job) {
        env.spawn(RunTask(Some(job)))?;
    }
    Ok(promise)
}

fn field_arg(v: Unknown) -> Result<FieldRef> {
    match value_from_js(
        &Slot {
            name: "field",
            ty: Ty::Field,
            optional: false,
        },
        Some(v),
    )? {
        Value::Field(f) => Ok(f),
        _ => unreachable!(),
    }
}

/// One store directory: its record log and derived keyspace.
#[napi]
pub struct Store {
    store: Arc<Inner>,
}

pub struct OpenTask(PathBuf);

impl Task for OpenTask {
    type Output = Inner;
    type JsValue = Store;

    fn compute(&mut self) -> Result<Inner> {
        Inner::open(&self.0, StoreConfig::default()).map_err(store_error)
    }

    fn resolve(&mut self, _env: Env, store: Inner) -> Result<Store> {
        Ok(Store {
            store: Arc::new(store),
        })
    }
}

pub struct ReadTask(Arc<Inner>, u64);

impl Task for ReadTask {
    type Output = Record;
    type JsValue = RecordAt;

    fn compute(&mut self) -> Result<Record> {
        self.0.read(self.1).map_err(store_error)
    }

    fn resolve(&mut self, _env: Env, rec: Record) -> Result<RecordAt> {
        Ok(RecordAt(self.1, rec))
    }
}

pub struct FeedTask(Arc<Inner>, u64, usize);

impl Task for FeedTask {
    type Output = (Vec<(u64, Record)>, u64);
    type JsValue = Page;

    fn compute(&mut self) -> Result<Self::Output> {
        self.0.feed(self.1, self.2).map_err(store_error)
    }

    fn resolve(&mut self, _env: Env, (records, next): Self::Output) -> Result<Page> {
        Ok(Page(records, next))
    }
}

pub struct CloseTask(Arc<Inner>);

impl Task for CloseTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<()> {
        self.0.close();
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _: ()) -> Result<()> {
        Ok(())
    }
}

macro_rules! object_type_name {
    ($t:ident) => {
        impl TypeName for $t {
            fn type_name() -> &'static str {
                "Object"
            }
            fn value_type() -> ValueType {
                ValueType::Object
            }
        }
    };
}
object_type_name!(RecordAt);
object_type_name!(Page);
object_type_name!(SearchPage);
object_type_name!(LibraryPage);
object_type_name!(LibraryEntities);
object_type_name!(TagPage);
object_type_name!(TagCounts);
object_type_name!(TagUnused);
object_type_name!(TagStatuses);
object_type_name!(TagFeed);

/// A page of the tag manager's list as JavaScript sees it.
pub struct TagPage(tags::Page);

impl ToNapiValue for TagPage {
    unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let p = val.0;
        let mut obj = Object::new(&env)?;
        obj.set("ids", p.ids)?;
        obj.set("more", p.more)?;
        if let Some(c) = p.cursor {
            obj.set("cursor", Buffer::from(c))?;
        }
        unsafe { Object::to_napi_value(raw_env, obj) }
    }
}

pub struct TagCounts(Vec<(i64, bool)>);

impl ToNapiValue for TagCounts {
    unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let mut list = Vec::with_capacity(val.0.len());
        for (count, approximate) in val.0 {
            let mut o = Object::new(&env)?;
            o.set("count", count as f64)?;
            o.set("approximate", approximate)?;
            list.push(o);
        }
        unsafe { Vec::<Object>::to_napi_value(raw_env, list) }
    }
}

pub struct TagUnused(u64, Vec<u64>);

impl ToNapiValue for TagUnused {
    unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let mut obj = Object::new(&env)?;
        obj.set("count", val.0 as f64)?;
        obj.set("ids", val.1)?;
        unsafe { Object::to_napi_value(raw_env, obj) }
    }
}

pub struct TagStatuses(Vec<Option<crate::store::TagStatus>>);

impl ToNapiValue for TagStatuses {
    unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let mut list = Vec::with_capacity(val.0.len());
        for st in val.0 {
            let Some(st) = st else {
                list.push(None);
                continue;
            };
            let mut o = Object::new(&env)?;
            o.set("id", st.id)?;
            o.set("live", st.live)?;
            if let Some(k) = st.into {
                o.set("into", text_to_js(k)?)?;
            }
            list.push(Some(o));
        }
        unsafe { Vec::<Option<Object>>::to_napi_value(raw_env, list) }
    }
}

pub struct TagFeed(Vec<(u64, u64)>, bool, u64);

impl ToNapiValue for TagFeed {
    unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let mut entries = Vec::with_capacity(val.0.len());
        for (pos, id) in val.0 {
            let mut o = Object::new(&env)?;
            o.set("pos", pos)?;
            o.set("id", id)?;
            entries.push(o);
        }
        let mut obj = Object::new(&env)?;
        obj.set("entries", entries)?;
        obj.set("more", val.1)?;
        obj.set("end", val.2)?;
        unsafe { Object::to_napi_value(raw_env, obj) }
    }
}

fn tag_query_from_js(q: &Object) -> Result<tags::Query> {
    let sort = match q.get::<Unknown>("sort")? {
        Some(v) => integer("sort", v)?,
        None => return Err(invalid("a tag page needs a sort".into())),
    };
    if sort >= tags::SORTS {
        return Err(invalid(format!("no tag sort {sort}")));
    }
    let text = |name: &str| -> Result<Option<Vec<u8>>> {
        match q.get::<Unknown>(name)? {
            Some(v) => Ok(Some(string(name, v)?)),
            None => Ok(None),
        }
    };
    let num = |name: &str, default: u64| -> Result<u64> {
        match q.get::<Unknown>(name)? {
            Some(v) => integer(name, v),
            None => Ok(default),
        }
    };
    Ok(tags::Query {
        sort,
        folders: q.get::<bool>("folders")?.unwrap_or(false),
        used: q.get::<bool>("used")?.unwrap_or(false),
        folder_type: text("folderType")?,
        search: text("search")?,
        name: text("name")?,
        contains: text("contains")?,
        ids: ids_arg("ids", q.get("ids")?)?,
        after: q
            .get::<Uint8Array>("after")?
            .map(|c| c.to_vec())
            .filter(|c| !c.is_empty()),
        limit: num("limit", 50)? as usize,
        cap: num("cap", tags::WORK_CAP)?,
    })
}

/// A page of the library list as JavaScript sees it.
pub struct LibraryPage(library_read::Page);

impl ToNapiValue for LibraryPage {
    unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let p = val.0;
        let mut obj = Object::new(&env)?;
        obj.set("ids", p.ids)?;
        if let Some(t) = p.total {
            obj.set("total", t as f64)?;
        }
        obj.set("totalExact", p.total_exact)?;
        obj.set("more", p.more)?;
        if let Some(c) = p.cursor {
            obj.set("cursor", Buffer::from(c))?;
        }
        unsafe { Object::to_napi_value(raw_env, obj) }
    }
}

/// Entities with their values as JavaScript sees them; null where there is none.
pub struct LibraryEntities(Vec<Option<library_read::Entity>>);

impl ToNapiValue for LibraryEntities {
    unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let mut list = Vec::with_capacity(val.0.len());
        for e in val.0 {
            let Some(e) = e else {
                list.push(None);
                continue;
            };
            let mut o = Object::new(&env)?;
            o.set("id", e.id)?;
            o.set("type", e.kind as f64)?;
            o.set("key", text_to_js(e.key)?)?;
            o.set("added", e.added as f64)?;
            o.set("version", e.version)?;
            o.set("fav", e.fav)?;
            o.set("tags", e.tags)?;
            let mut values = Vec::with_capacity(e.values.len());
            for (f, v) in e.values {
                let mut vo = Object::new(&env)?;
                match f {
                    FieldRef::Code(c) => vo.set("field", c as f64)?,
                    FieldRef::Key(k) => vo.set("field", text_to_js(k)?)?,
                }
                match v {
                    library_read::Stored::Text(t) => vo.set("text", text_to_js(t)?)?,
                    library_read::Stored::Json(j) => vo.set("json", text_to_js(j)?)?,
                }
                values.push(vo);
            }
            o.set("values", values)?;
            let mut items = Vec::with_capacity(e.items.len());
            for (list, item, position) in e.items {
                let mut io = Object::new(&env)?;
                io.set("list", list as f64)?;
                io.set("item", item as f64)?;
                io.set("position", position as f64)?;
                items.push(io);
            }
            o.set("items", items)?;
            if let Some(n) = e.data_size {
                o.set("dataSize", n as f64)?;
            }
            if let Some(ms) = e.create_ms {
                o.set("createMs", ms)?;
            }
            let mut hashes = Vec::with_capacity(e.hashes.len());
            for (which, h) in e.hashes {
                let mut ho = Object::new(&env)?;
                ho.set("which", which as f64)?;
                ho.set("hash", Buffer::from(h))?;
                hashes.push(ho);
            }
            o.set("hashes", hashes)?;
            list.push(Some(o));
        }
        unsafe { Vec::<Option<Object>>::to_napi_value(raw_env, list) }
    }
}

fn library_query_from_js(q: &Object) -> Result<library_read::Query> {
    use library_read::{Filter, Query, RangeField, Sort};
    let tags = |name: &str| ids_arg(name, q.get(name)?).map(Option::unwrap_or_default);
    let mut ranges = Vec::new();
    for r in q.get::<Vec<Object>>("ranges")?.unwrap_or_default() {
        let field = match r.get::<Unknown>("field")? {
            Some(v) if v.get_type()? == ValueType::String => {
                match String::from_unknown(v)?.as_str() {
                    "create_date" => RangeField::Created,
                    "date_last_chat" => RangeField::LastChat,
                    "chat_size" => RangeField::ChatSize,
                    "data_size" => RangeField::Data,
                    "closed_folders" => RangeField::ClosedFolders,
                    other => return Err(invalid(format!("no range field {other}"))),
                }
            }
            Some(v) => RangeField::Tag(integer("field", v)?),
            None => return Err(invalid("a range needs a field".into())),
        };
        ranges.push((field, r.get::<f64>("min")?, r.get::<f64>("max")?));
    }
    let world = match q.get::<Unknown>("world")? {
        Some(v) => Some(string("world", v)?),
        None => None,
    };
    let filter = Filter {
        characters: q.get::<bool>("characters")?.unwrap_or(false),
        groups: q.get::<bool>("groups")?.unwrap_or(false),
        fav: q.get::<bool>("fav")?,
        all_tags: tags("allTags")?,
        any_tags: tags("anyTags")?,
        no_tags: tags("noTags")?,
        world,
        ranges,
        ids: ids_arg("ids", q.get("ids")?)?,
        not_ids: tags("notIds")?,
    };
    let s: Object = q
        .get("sort")?
        .ok_or_else(|| invalid("a library page needs a sort".into()))?;
    let desc = s.get::<bool>("desc")?.unwrap_or(false);
    let sort = if let Some(k) = s.get::<Unknown>("key")? {
        let key = integer("key", k)?;
        if key >= library::SORTS {
            return Err(invalid(format!("no sort key {key}")));
        }
        Sort::Key { sort: key, desc }
    } else if s.get::<bool>("fav")?.unwrap_or(false) {
        Sort::Fav { desc }
    } else if let Some(seed) = s.get::<Unknown>("seed")? {
        let seed = match seed.get_type()? {
            ValueType::BigInt => BigInt::from_unknown(seed)?.get_u64().1,
            _ => f64::from_unknown(seed)?.trunc() as i64 as u64,
        };
        Sort::Random { seed, desc }
    } else {
        return Err(invalid(
            "a sort is { key }, { fav: true } or { seed }".into(),
        ));
    };
    let num = |name: &str, default: u64| -> Result<u64> {
        match q.get::<Unknown>(name)? {
            Some(v) => integer(name, v),
            None => Ok(default),
        }
    };
    Ok(Query {
        filter,
        sort,
        offset: num("offset", 0)?,
        limit: num("limit", 500)? as usize,
        cursor: q
            .get::<Uint8Array>("cursor")?
            .map(|c| c.to_vec())
            .filter(|c| !c.is_empty()),
        count: q.get::<bool>("count")?.unwrap_or(false),
        cap: num("cap", 20_000)?,
    })
}

/// A page of search results as JavaScript sees it.
pub struct SearchPage(Found);

impl ToNapiValue for SearchPage {
    unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let f = val.0;
        let mut hits = Vec::with_capacity(f.hits.len());
        for h in f.hits {
            let mut o = Object::new(&env)?;
            o.set("doc", h.doc)?;
            o.set("score", h.score)?;
            hits.push(o);
        }
        let mut tags = Vec::with_capacity(f.tags.len());
        for t in f.tags {
            let mut o = Object::new(&env)?;
            o.set("tag", t.tag)?;
            o.set("name", text_to_js(t.name)?)?;
            o.set("carriers", t.carriers as f64)?;
            tags.push(o);
        }
        let mut obj = Object::new(&env)?;
        obj.set("hits", hits)?;
        obj.set("total", f.total as f64)?;
        obj.set("totalExact", f.total_exact)?;
        obj.set("pageExact", f.page_exact)?;
        obj.set("more", f.more)?;
        obj.set("tags", tags)?;
        obj.set("tagsExact", f.tags_exact)?;
        unsafe { Object::to_napi_value(raw_env, obj) }
    }
}

fn ids_arg(name: &str, v: Option<Vec<Unknown>>) -> Result<Option<Vec<u64>>> {
    v.map(|xs| xs.into_iter().map(|x| integer(name, x)).collect())
        .transpose()
}

fn query_from_js(q: &Object) -> Result<Query> {
    let scope = match q.get::<Unknown>("scope")? {
        None => return Err(invalid("a search needs a scope".into())),
        Some(v) if v.get_type()? == ValueType::String => match String::from_unknown(v)?.as_str() {
            "library" => Scope::LIBRARY,
            "tags" => Scope::TAGS,
            other => return Err(invalid(format!("no search scope {other}"))),
        },
        Some(v) => {
            let o = Object::from_unknown(v)?;
            let owner = o.get::<Unknown>("chat")?.ok_or_else(|| {
                invalid("a search scope is 'library', 'tags' or { chat: owner }".into())
            })?;
            Scope::chat(integer("chat", owner)?)
        }
    };
    let nfields = scope.fields().len() as u64;
    let mut clauses = Vec::new();
    for c in q.get::<Vec<Object>>("clauses")?.unwrap_or_default() {
        let text = string(
            "text",
            c.get::<Unknown>("text")?
                .ok_or_else(|| invalid("a clause needs text".into()))?,
        )?;
        let fields = match c.get::<Vec<Unknown>>("fields")? {
            None => None,
            Some(fs) => Some(
                fs.into_iter()
                    .map(|f| {
                        let f = integer("field", f)?;
                        if f >= nfields {
                            return Err(invalid(format!("the scope has no field {f}")));
                        }
                        Ok(f as u32)
                    })
                    .collect::<Result<Vec<_>>>()?,
            ),
        };
        clauses.push(Clause {
            text,
            fields,
            negate: c.get::<bool>("negate")?.unwrap_or(false),
            quoted: c.get::<bool>("quoted")?.unwrap_or(false),
        });
    }
    let mut filters = Vec::new();
    if let Some(f) = q.get::<Object>("filters")? {
        if let Some(t) = ids_arg("allTags", f.get("allTags")?)? {
            filters.push(Filter::AllTags(t));
        }
        if let Some(t) = ids_arg("anyTag", f.get("anyTag")?)? {
            filters.push(Filter::AnyTag(t));
        }
        if let Some(t) = ids_arg("noTag", f.get("noTag")?)? {
            filters.push(Filter::NoTag(t));
        }
        if let Some(t) = ids_arg("ids", f.get("ids")?)? {
            filters.push(Filter::Ids(t));
        }
        if let Some(t) = ids_arg("notIds", f.get("notIds")?)? {
            filters.push(Filter::NotIds(t));
        }
    }
    let limit = match q.get::<Unknown>("limit")? {
        Some(v) => integer("limit", v)? as usize,
        None => return Err(invalid("a search needs a limit".into())),
    };
    let after = match q.get::<Object>("after")? {
        None => None,
        Some(a) => {
            let score: f64 = a
                .get("score")?
                .ok_or_else(|| invalid("after needs a score".into()))?;
            let doc = integer(
                "doc",
                a.get::<Unknown>("doc")?
                    .ok_or_else(|| invalid("after needs a doc".into()))?,
            )?;
            Some(After::Score(score, doc))
        }
    };
    Ok(Query {
        scope,
        clauses,
        filters,
        order: Order::Relevance,
        limit,
        after,
        limits: Limits::default(),
    })
}

#[napi(object)]
pub struct StoreStats {
    /// Groups written and synced, and their bytes.
    pub log_rounds: f64,
    pub log_bytes: f64,
    pub runs: f64,
    pub run_bytes: f64,
    pub flushes: f64,
    pub merges: f64,
    /// Bytes of runs written by flushes and by merges.
    pub flush_bytes: f64,
    pub merge_bytes: f64,
    /// Bytes of log replayed at the last open, and in how long.
    pub replay_bytes: f64,
    pub replay_ms: f64,
    pub cleaned_files: f64,
    pub relocated_bytes: f64,
    pub removed_bytes: f64,
}

fn position_arg(p: BigInt) -> Result<u64> {
    match p.get_u64() {
        (false, n, true) => Ok(n),
        _ => Err(invalid(
            "a position is a non-negative BigInt below 2^64".into(),
        )),
    }
}

#[napi]
impl Store {
    /// Opens (creating if missing) the store in `dir`. Resolves before the log after the last flush is
    /// replayed; reads of derived data and commits wait for that.
    #[napi(ts_return_type = "Promise<Store>")]
    pub fn open(dir: String) -> AsyncTask<OpenTask> {
        AsyncTask::new(OpenTask(PathBuf::from(dir)))
    }

    /// Resolves once replay is done; rejects if it failed.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn ready<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        derived(env, &self.store, |s| s.wait_ready())
    }

    /// Commits the records together; resolves with their positions once they are durable and their derived
    /// entries readable. Throws for a record that doesn't fit its kind; rejects, writing nothing, for one that
    /// can't apply (such as a text edit outside the value).
    #[napi(
        ts_args_type = "records: object[]",
        ts_return_type = "Promise<bigint[]>"
    )]
    pub fn commit<'env>(&self, env: &'env Env, records: Vec<Object>) -> Result<Object<'env>> {
        let records = records
            .iter()
            .map(record_from_js)
            .collect::<Result<Vec<_>>>()?;
        let (deferred, promise) = env.create_deferred()?;
        self.store.commit(
            records,
            Box::new(move |result| match result {
                Ok(positions) => deferred.resolve(move |_| Ok(positions)),
                Err(e) => deferred.reject(store_error(e)),
            }),
        );
        Ok(promise)
    }

    /// The record at a durable record's position.
    #[napi(ts_return_type = "Promise<object>")]
    pub fn read(&self, position: BigInt) -> Result<AsyncTask<ReadTask>> {
        Ok(AsyncTask::new(ReadTask(
            self.store.clone(),
            position_arg(position)?,
        )))
    }

    /// The change feed: up to `limit` records committed from `from` (0n or a `next` from here) on, and the
    /// position to continue from. Rejects for a position whose log file cleaning has removed.
    #[napi(ts_return_type = "Promise<{ records: object[], next: bigint }>")]
    pub fn feed(&self, from: BigInt, limit: u32) -> Result<AsyncTask<FeedTask>> {
        Ok(AsyncTask::new(FeedTask(
            self.store.clone(),
            position_arg(from)?,
            limit as usize,
        )))
    }

    /// The entity's fav bit, or null if it has none.
    #[napi(ts_return_type = "Promise<boolean | null>")]
    pub fn fav<'env>(&self, env: &'env Env, entity: Unknown) -> Result<Object<'env>> {
        let e = integer("entity", entity)?;
        derived(env, &self.store, move |s| s.fav(e))
    }

    /// A text field's value, or null if it has none.
    #[napi(
        ts_args_type = "entity: bigint | number, field: number | string",
        ts_return_type = "Promise<string | null>"
    )]
    pub fn text<'env>(
        &self,
        env: &'env Env,
        entity: Unknown,
        field: Unknown,
    ) -> Result<Object<'env>> {
        let e = integer("entity", entity)?;
        let f = field_arg(field)?;
        derived(env, &self.store, move |s| {
            s.text(e, &f)?
                .map(|b| text_to_js(b).map_err(|e| StoreError::Entry(e.to_string())))
                .transpose()
        })
    }

    /// The position of the entity's latest record, or null.
    #[napi(
        ts_args_type = "entity: bigint | number",
        ts_return_type = "Promise<bigint | null>"
    )]
    pub fn version<'env>(&self, env: &'env Env, entity: Unknown) -> Result<Object<'env>> {
        let e = integer("entity", entity)?;
        derived(env, &self.store, move |s| s.version(e))
    }

    /// A page of search results in relevance order: `{ scope: 'library' | 'tags' | { chat: owner }, clauses:
    /// [{ text, fields?, negate?, quoted? }], filters?: { allTags?, anyTag?, noTag?, ids?, notIds? }, limit,
    /// after? }` (`after` the last hit of the page before). Resolves with `{ hits: [{ doc, score }], total,
    /// totalExact, pageExact, more, tags: [{ tag, name, carriers }], tagsExact }`: in the library, `tags` are
    /// the tags whose names match the query, best first, at most 5.
    #[napi(
        ts_args_type = "query: object",
        ts_return_type = "Promise<{ hits: { doc: bigint, score: number }[], total: number, totalExact: boolean, pageExact: boolean, more: boolean, tags: { tag: bigint, name: string, carriers: number }[], tagsExact: boolean }>"
    )]
    pub fn search<'env>(&self, env: &'env Env, query: Object) -> Result<Object<'env>> {
        let q = query_from_js(&query)?;
        derived(env, &self.store, move |s| s.search(&q).map(SearchPage))
    }

    /// A page of the library list: `{ characters, groups, fav?, allTags?, anyTags?, noTags?, world?, ranges?:
    /// [{ field: 'create_date' | 'date_last_chat' | 'chat_size' | 'data_size' | 'closed_folders' | tag id,
    /// min?, max? }], ids?, notIds?, sort: { key, desc? } | { fav: true, desc? } | { seed, desc? }, offset?,
    /// limit?, cursor?, count?, cap? }`. Resolves with `{ ids, total?, totalExact, more, cursor? }`: `more`
    /// when the work cap cut the page short, `cursor` to read on from.
    #[napi(
        ts_args_type = "query: object",
        ts_return_type = "Promise<{ ids: bigint[], total?: number, totalExact: boolean, more: boolean, cursor?: Buffer }>"
    )]
    pub fn library_page<'env>(&self, env: &'env Env, query: Object) -> Result<Object<'env>> {
        let q = library_query_from_js(&query)?;
        derived(env, &self.store, move |s| {
            s.library_page(&q).map(LibraryPage)
        })
    }

    /// Each entity with everything it holds, or null.
    #[napi(
        ts_args_type = "ids: (bigint | number)[]",
        ts_return_type = "Promise<(object | null)[]>"
    )]
    pub fn library_entities<'env>(
        &self,
        env: &'env Env,
        ids: Vec<Unknown>,
    ) -> Result<Object<'env>> {
        let ids = ids
            .into_iter()
            .map(|v| integer("id", v))
            .collect::<Result<Vec<_>>>()?;
        derived(env, &self.store, move |s| {
            s.library_entities(&ids).map(LibraryEntities)
        })
    }

    /// The entity of each `[type, key]`, or null.
    #[napi(
        ts_args_type = "keys: [number, string][]",
        ts_return_type = "Promise<(bigint | null)[]>"
    )]
    pub fn library_ids<'env>(
        &self,
        env: &'env Env,
        keys: Vec<Vec<Unknown>>,
    ) -> Result<Object<'env>> {
        let keys = keys
            .into_iter()
            .map(|pair| {
                let mut it = pair.into_iter();
                let (Some(t), Some(k), None) = (it.next(), it.next(), it.next()) else {
                    return Err(invalid("a key is [type, key]".into()));
                };
                Ok((integer("type", t)?, string("key", k)?))
            })
            .collect::<Result<Vec<_>>>()?;
        derived(env, &self.store, move |s| s.library_ids(&keys))
    }

    /// One more than the highest entity id ever created (1 for none).
    #[napi(ts_return_type = "Promise<bigint>")]
    pub fn library_next_id<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        derived(env, &self.store, |s| s.library_next_id())
    }

    /// The entities a card hash of kind `which` finds, at most `limit`.
    #[napi(ts_return_type = "Promise<bigint[]>")]
    pub fn library_by_hash<'env>(
        &self,
        env: &'env Env,
        which: u32,
        hash: Uint8Array,
        limit: u32,
    ) -> Result<Object<'env>> {
        let hash = hash.to_vec();
        derived(env, &self.store, move |s| {
            s.library_by_hash(u64::from(which), &hash, limit as usize)
        })
    }

    /// The entities both a hash of kind `which_a` and one of kind `which_b` find, at most `limit`.
    #[napi(ts_return_type = "Promise<bigint[]>")]
    pub fn library_by_hashes<'env>(
        &self,
        env: &'env Env,
        which_a: u32,
        hash_a: Uint8Array,
        which_b: u32,
        hash_b: Uint8Array,
        limit: u32,
    ) -> Result<Object<'env>> {
        let (hash_a, hash_b) = (hash_a.to_vec(), hash_b.to_vec());
        derived(env, &self.store, move |s| {
            s.library_by_hashes(
                (u64::from(which_a), &hash_a),
                (u64::from(which_b), &hash_b),
                limit as usize,
            )
        })
    }

    /// A page of the tag manager's list: `{ sort: 0 alphabetical | 1 by entries | 2 manual, folders?, used?,
    /// folderType?, search?, name?, contains?, ids?, after?, limit, cap? }`. Resolves with `{ ids, more,
    /// cursor? }`: `more` when the work cap cut the page short, `cursor` to read on from (none at the end).
    /// Rejects a cursor made for another sort.
    #[napi(
        ts_args_type = "query: object",
        ts_return_type = "Promise<{ ids: bigint[], more: boolean, cursor?: Buffer }>"
    )]
    pub fn tag_page<'env>(&self, env: &'env Env, query: Object) -> Result<Object<'env>> {
        let q = tag_query_from_js(&query)?;
        derived(env, &self.store, move |s| s.tag_page(&q).map(TagPage))
    }

    /// Each tag's carriers, with the carriers of tags merged into it that haven't moved yet; `approximate` when
    /// those may count an entity twice.
    #[napi(
        ts_args_type = "ids: (bigint | number)[]",
        ts_return_type = "Promise<{ count: number, approximate: boolean }[]>"
    )]
    pub fn tag_counts<'env>(&self, env: &'env Env, ids: Vec<Unknown>) -> Result<Object<'env>> {
        let ids = ids
            .into_iter()
            .map(|v| integer("id", v))
            .collect::<Result<Vec<_>>>()?;
        derived(env, &self.store, move |s| s.tag_counts(&ids).map(TagCounts))
    }

    /// How many tags nothing carries, and up to `limit` of them in alphabetical order.
    #[napi(ts_return_type = "Promise<{ count: number, ids: bigint[] }>")]
    pub fn tag_unused<'env>(&self, env: &'env Env, limit: u32) -> Result<Object<'env>> {
        derived(env, &self.store, move |s| {
            s.tag_unused(limit as usize)
                .map(|(n, ids)| TagUnused(n, ids))
        })
    }

    /// The live tag each name stands for (names compared folded), or null.
    #[napi(
        ts_args_type = "names: string[]",
        ts_return_type = "Promise<(bigint | null)[]>"
    )]
    pub fn tag_by_names<'env>(&self, env: &'env Env, names: Vec<Unknown>) -> Result<Object<'env>> {
        let names = names
            .into_iter()
            .map(|v| string("name", v))
            .collect::<Result<Vec<_>>>()?;
        derived(env, &self.store, move |s| s.tag_by_names(&names))
    }

    /// The highest manual sort order of a live tag, or null.
    #[napi(ts_return_type = "Promise<number | null>")]
    pub fn tag_max_order<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        derived(env, &self.store, |s| s.tag_max_order())
    }

    /// For each tag key: `{ id, live: true }`, `{ id, live: false, into? }` for a deleted tag (`into` the key of
    /// the live tag its merges lead to), or null for a key no tag ever had.
    #[napi(
        ts_args_type = "keys: string[]",
        ts_return_type = "Promise<({ id: bigint, live: boolean, into?: string } | null)[]>"
    )]
    pub fn tag_status<'env>(&self, env: &'env Env, keys: Vec<Unknown>) -> Result<Object<'env>> {
        let keys = keys
            .into_iter()
            .map(|v| string("key", v))
            .collect::<Result<Vec<_>>>()?;
        derived(env, &self.store, move |s| {
            s.tag_status(&keys).map(TagStatuses)
        })
    }

    /// Up to `limit` entries of a change feed after position `after`, each `{ pos, id }` once at its last
    /// change: `'tags'` lists tags whose definitions changed (deleted ones too), `'entities'` characters and
    /// groups whose tags changed. `end` is the feed's last position (0n for none).
    #[napi(
        ts_args_type = "which: 'tags' | 'entities', after: bigint, limit: number",
        ts_return_type = "Promise<{ entries: { pos: bigint, id: bigint }[], more: boolean, end: bigint }>"
    )]
    pub fn tag_feed<'env>(
        &self,
        env: &'env Env,
        which: String,
        after: BigInt,
        limit: u32,
    ) -> Result<Object<'env>> {
        let structure = match which.as_str() {
            "tags" => key::TAG_CHANGE,
            "entities" => key::ENTITY_TAG_CHANGE,
            other => return Err(invalid(format!("no tag feed {other}"))),
        };
        let after = position_arg(after)?;
        derived(env, &self.store, move |s| {
            s.tag_feed(structure, after, limit as usize)
                .map(|(e, more, end)| TagFeed(e, more, end))
        })
    }

    /// The position after the last durable record.
    #[napi]
    pub fn durable_end(&self) -> u64 {
        self.store.durable_end()
    }

    #[napi]
    pub fn stats(&self) -> StoreStats {
        let s = self.store.stats();
        StoreStats {
            log_rounds: s.log_rounds as f64,
            log_bytes: s.log_bytes as f64,
            runs: s.ks.runs as f64,
            run_bytes: s.ks.run_bytes as f64,
            flushes: s.ks.flushes as f64,
            merges: s.ks.merges as f64,
            flush_bytes: s.ks.flush_bytes as f64,
            merge_bytes: s.ks.merge_bytes as f64,
            replay_bytes: s.replay_bytes as f64,
            replay_ms: s.replay_micros as f64 / 1000.0,
            cleaned_files: s.cleaned_files as f64,
            relocated_bytes: s.relocated_bytes as f64,
            removed_bytes: s.removed_bytes as f64,
        }
    }

    /// Finishes queued commits, flushes, and stops; later commits reject.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn close(&self) -> AsyncTask<CloseTask> {
        AsyncTask::new(CloseTask(self.store.clone()))
    }
}
