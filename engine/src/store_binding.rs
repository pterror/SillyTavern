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
    FieldRef, MAX_SAFE, Record, Slot, Space, Ty, Value, kind_by_name, wtf8_from_utf16,
    wtf8_to_utf16,
};
use crate::search::Scope;
use crate::search::query::{After, Clause, Filter, Found, Limits, Order, Query};
use crate::store::kinds::key;
use crate::store::{
    Store as Inner, StoreConfig, StoreError, StoreResult, library, library_read, library_search,
    tags,
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
        Ty::Sel(_) => unreachable!("read by sel_from_js"),
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

/// The names a slot's value may be given by: its own, or for a `Sel` slot each of its spaces'.
fn slot_names(slot: &Slot) -> Vec<&'static str> {
    match slot.ty {
        Ty::Sel(spaces) => spaces.iter().map(|(_, n)| *n).collect(),
        _ => vec![slot.name],
    }
}

/// A `Sel` slot's value: exactly one of its spaces' names given.
fn sel_from_js(slot: &Slot, spaces: &[(Space, &str)], obj: &Object) -> Result<Value> {
    let mut found = None;
    for (i, (_, n)) in spaces.iter().enumerate() {
        if let Some(v) = obj.get::<Unknown>(n)? {
            if found.is_some() {
                return Err(invalid(format!(
                    "{} takes one of {}",
                    slot.name,
                    slot_names(slot).join(", ")
                )));
            }
            found = Some(Value::Sel(i as u8, integer(n, v)?));
        }
    }
    match found {
        Some(v) => Ok(v),
        None if slot.optional => Ok(Value::Absent),
        None => Err(invalid(format!(
            "{} is missing: give one of {}",
            slot.name,
            slot_names(slot).join(", ")
        ))),
    }
}

fn record_from_js(obj: &Object) -> Result<Record> {
    let kind_name: String = obj
        .get("kind")?
        .ok_or_else(|| invalid("a record needs a kind".into()))?;
    let kind = kind_by_name(&kind_name)
        .filter(|k| !k.internal)
        .ok_or_else(|| invalid(format!("no record kind {kind_name}")))?;
    for key in Object::keys(obj)? {
        if key != "kind"
            && !kind
                .slots
                .iter()
                .any(|s| slot_names(s).contains(&key.as_str()))
        {
            return Err(invalid(format!("{kind_name} has no value {key}")));
        }
    }
    let values = kind
        .slots
        .iter()
        .map(|slot| match slot.ty {
            Ty::Sel(spaces) => sel_from_js(slot, spaces, obj),
            _ => value_from_js(slot, obj.get::<Unknown>(slot.name)?),
        })
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
                Value::Sel(i, n) => obj.set(slot_names(slot)[usize::from(i)], n)?,
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

/// A read answering a `JsTree`, run on the store.
type TreeRead = Box<dyn FnOnce(&Inner) -> StoreResult<JsTree> + Send>;

/// A chat read's answer (`store::chat_read::Js`) as JavaScript.
struct JsTree(crate::store::chat_read::Js);

impl ToNapiValue for JsTree {
    unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        use crate::store::chat_read::Js;
        let env = Env::from_raw(raw_env);
        unsafe {
            match val.0 {
                Js::Null => <Option<bool>>::to_napi_value(raw_env, None),
                Js::Bool(b) => bool::to_napi_value(raw_env, b),
                Js::Num(n) => f64::to_napi_value(raw_env, n),
                Js::Big(n) => u64::to_napi_value(raw_env, n),
                Js::Text(t) => JsText::to_napi_value(raw_env, text_to_js(t)?),
                Js::Bytes(b) => Buffer::to_napi_value(raw_env, Buffer::from(b)),
                Js::Arr(list) => {
                    <Vec<JsTree>>::to_napi_value(raw_env, list.into_iter().map(JsTree).collect())
                }
                Js::Obj(fields) => {
                    let mut o = Object::new(&env)?;
                    for (k, v) in fields {
                        o.set(k, JsTree(v))?;
                    }
                    Object::to_napi_value(raw_env, o)
                }
            }
        }
    }
}

fn opt_integer(o: &Object, name: &str) -> Result<Option<u64>> {
    match o.get::<Unknown>(name)? {
        Some(v) if !matches!(v.get_type()?, ValueType::Null | ValueType::Undefined) => {
            Ok(Some(integer(name, v)?))
        }
        _ => Ok(None),
    }
}

fn req_integer(o: &Object, name: &str) -> Result<u64> {
    opt_integer(o, name)?.ok_or_else(|| invalid(format!("{name} is missing")))
}

fn integers(o: &Object, name: &str) -> Result<Vec<u64>> {
    let list: Vec<Unknown> = o
        .get(name)?
        .ok_or_else(|| invalid(format!("{name} is missing")))?;
    list.into_iter().map(|v| integer(name, v)).collect()
}

fn byte_list(o: &Object, name: &str) -> Result<Vec<Vec<u8>>> {
    let list: Vec<Unknown> = o
        .get(name)?
        .ok_or_else(|| invalid(format!("{name} is missing")))?;
    list.into_iter()
        .map(|v| match v.get_type()? {
            ValueType::String => string(name, v),
            _ => Ok(Uint8Array::from_unknown(v)
                .map_err(|_| invalid(format!("{name} holds strings or Uint8Arrays")))?
                .to_vec()),
        })
        .collect()
}

/// A string (as WTF-8) or a Uint8Array's bytes.
fn bytes_of(o: &Object, name: &str) -> Result<Vec<u8>> {
    let v: Unknown = o
        .get(name)?
        .ok_or_else(|| invalid(format!("{name} is missing")))?;
    match v.get_type()? {
        ValueType::String => string(name, v),
        _ => Ok(Uint8Array::from_unknown(v)
            .map_err(|_| invalid(format!("{name} is a string or a Uint8Array")))?
            .to_vec()),
    }
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
object_type_name!(LibraryKeys);
object_type_name!(TagAssignments);
object_type_name!(TagKeys);

fn tag_state_js(st: crate::store::TagState) -> &'static str {
    match st {
        crate::store::TagState::Live => "live",
        crate::store::TagState::Undefined => "undefined",
        crate::store::TagState::Gone => "gone",
    }
}

pub struct LibraryKeys(Vec<Option<(u64, Vec<u8>)>>);

impl ToNapiValue for LibraryKeys {
    unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let mut list = Vec::with_capacity(val.0.len());
        for e in val.0 {
            list.push(match e {
                Some((t, k)) => {
                    let mut o = Object::new(&env)?;
                    o.set("type", t as f64)?;
                    o.set("key", text_to_js(k)?)?;
                    Some(o)
                }
                None => None,
            });
        }
        unsafe { Vec::<Option<Object>>::to_napi_value(raw_env, list) }
    }
}

pub struct TagAssignments(Vec<(u64, Vec<u64>)>, Option<u64>);

impl ToNapiValue for TagAssignments {
    unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let mut entries = Vec::with_capacity(val.0.len());
        for (e, tags) in val.0 {
            let mut o = Object::new(&env)?;
            o.set("entity", e)?;
            o.set("tags", tags)?;
            entries.push(o);
        }
        let mut obj = Object::new(&env)?;
        obj.set("entries", entries)?;
        if let Some(n) = val.1 {
            obj.set("next", n)?;
        }
        unsafe { Object::to_napi_value(raw_env, obj) }
    }
}

pub struct TagKeys(Vec<Option<(Vec<u8>, crate::store::TagStatus)>>);

impl ToNapiValue for TagKeys {
    unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let mut list = Vec::with_capacity(val.0.len());
        for e in val.0 {
            list.push(match e {
                Some((k, st)) => {
                    let mut o = Object::new(&env)?;
                    o.set("key", text_to_js(k)?)?;
                    o.set("state", tag_state_js(st.state))?;
                    if let Some(i) = st.into {
                        o.set("into", text_to_js(i)?)?;
                    }
                    Some(o)
                }
                None => None,
            });
        }
        unsafe { Vec::<Option<Object>>::to_napi_value(raw_env, list) }
    }
}

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

pub struct TagPositions(Vec<Option<Vec<u8>>>);

impl ToNapiValue for TagPositions {
    unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let list: Vec<Option<Buffer>> = val.0.into_iter().map(|c| c.map(Buffer::from)).collect();
        unsafe { Vec::to_napi_value(raw_env, list) }
    }
}

pub struct TagQueue(Vec<tags::Queued>, bool);

impl ToNapiValue for TagQueue {
    unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let mut entries = Vec::with_capacity(val.0.len());
        for e in val.0 {
            let mut o = Object::new(&env)?;
            o.set("seq", e.seq as f64)?;
            o.set("tag", e.tag)?;
            o.set("after", e.after)?;
            if let Some(a) = e.anchor {
                o.set("anchor", a)?;
            }
            if let Some(v) = e.value {
                o.set("value", text_to_js(v)?)?;
            }
            entries.push(o);
        }
        let mut obj = Object::new(&env)?;
        obj.set("entries", entries)?;
        obj.set("more", val.1)?;
        unsafe { Object::to_napi_value(raw_env, obj) }
    }
}

pub struct TagPassStatus(tags::PassStatus);

impl ToNapiValue for TagPassStatus {
    unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let st = val.0;
        let mut obj = Object::new(&env)?;
        obj.set("pass", st.pass as f64)?;
        if let Some(m) = st.mode {
            obj.set("mode", m as f64)?;
        }
        if let Some(p) = st.phase {
            obj.set("phase", p as f64)?;
        }
        if let Some(n) = st.n {
            obj.set("n", n as f64)?;
        }
        if let Some(a) = st.after {
            obj.set("after", Buffer::from(a))?;
        }
        obj.set("stamped", st.stamped as f64)?;
        obj.set("live", st.live as f64)?;
        unsafe { Object::to_napi_value(raw_env, obj) }
    }
}

pub struct MetaValues(Vec<Option<Vec<u8>>>);

impl ToNapiValue for MetaValues {
    unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let list = val
            .0
            .into_iter()
            .map(|v| v.map(text_to_js).transpose())
            .collect::<Result<Vec<Option<JsText>>>>()?;
        unsafe { Vec::to_napi_value(raw_env, list) }
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
            o.set("state", tag_state_js(st.state))?;
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
        reverse: q.get::<bool>("reverse")?.unwrap_or(false),
        ordered: q.get::<bool>("ordered")?,
        unstamped: match q.get::<Unknown>("unstamped")? {
            Some(v) => Some(integer("unstamped", v)?),
            None => None,
        },
    })
}

/// A searched page of the library list as JavaScript sees it.
pub struct LibrarySearched(library_search::Searched);

impl ToNapiValue for LibrarySearched {
    unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let p = val.0;
        let mut obj = Object::new(&env)?;
        obj.set("ids", p.ids)?;
        obj.set("scores", p.scores)?;
        obj.set("total", p.total as f64)?;
        obj.set("totalExact", p.total_exact)?;
        obj.set("more", p.more)?;
        if let Some(c) = p.cursor {
            obj.set("cursor", Buffer::from(c))?;
        }
        let mut tags = Vec::with_capacity(p.tags.len());
        for t in p.tags {
            let mut o = Object::new(&env)?;
            o.set("tag", t.tag)?;
            o.set("name", text_to_js(t.name)?)?;
            o.set("carriers", t.carriers as f64)?;
            tags.push(o);
        }
        obj.set("tags", tags)?;
        obj.set("tagsExact", p.tags_exact)?;
        unsafe { Object::to_napi_value(raw_env, obj) }
    }
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
            if let Some(order) = e.tag_order {
                match order {
                    Some(v) => o.set("tagOrder", v)?,
                    None => o.set("tagOrder", napi::bindgen_prelude::Null)?,
                }
            }
            if let Some((book, k, version)) = e.link {
                let mut lo = Object::new(&env)?;
                lo.set("book", book)?;
                lo.set("key", text_to_js(k)?)?;
                lo.set("version", version)?;
                o.set("link", lo)?;
            }
            if let Some(x) = e.entry_index {
                o.set("entryIndex", x)?;
            }
            list.push(Some(o));
        }
        unsafe { Vec::<Option<Object>>::to_napi_value(raw_env, list) }
    }
}

/// `sorted`: the query needs a sort (a relevance search has none; its page is read as by name).
fn library_query_from_js(q: &Object, sorted: bool) -> Result<library_read::Query> {
    use library_read::{Filter, RangeField, Sort};
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
    let s: Option<Object> = q.get("sort")?;
    let Some(s) = s.filter(|_| sorted) else {
        if sorted {
            return Err(invalid("a library page needs a sort".into()));
        }
        return library_query_rest(
            q,
            filter,
            Sort::Key {
                sort: library::BY_NAME,
                desc: false,
            },
        );
    };
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
    library_query_rest(q, filter, sort)
}

fn library_query_rest(
    q: &Object,
    filter: library_read::Filter,
    sort: library_read::Sort,
) -> Result<library_read::Query> {
    let num = |name: &str, default: u64| -> Result<u64> {
        match q.get::<Unknown>(name)? {
            Some(v) => integer(name, v),
            None => Ok(default),
        }
    };
    Ok(library_read::Query {
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

fn clauses_from_js(q: &Object, scope: Scope) -> Result<Vec<Clause>> {
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
    Ok(clauses)
}

fn query_from_js(q: &Object) -> Result<Query> {
    let scope = match q.get::<Unknown>("scope")? {
        None => return Err(invalid("a search needs a scope".into())),
        Some(v) if v.get_type()? == ValueType::String => match String::from_unknown(v)?.as_str() {
            "library" => Scope::LIBRARY,
            "tags" => Scope::TAGS,
            "sessions" => Scope::SESSIONS,
            other => return Err(invalid(format!("no search scope {other}"))),
        },
        Some(v) => {
            let o = Object::from_unknown(v)?;
            if let Some(owner) = o.get::<Unknown>("chat")? {
                Scope::chat(integer("chat", owner)?)
            } else if let Some(book) = o.get::<Unknown>("book")? {
                Scope::book(integer("book", book)?)
            } else {
                return Err(invalid(
                    "a search scope is 'library', 'tags', 'sessions', { chat: owner } or { book }"
                        .into(),
                ));
            }
        }
    };
    let clauses = clauses_from_js(q, scope)?;
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

    /// Keeps tokenizing results in the cache: `[{ table, identity, hash, value, replace? }]` (`identity` and `hash`
    /// strings or bytes, `value` bytes) at `now` (ms); a stored one keeps its value unless `replace`, and is marked
    /// used once `granularity` ms or more behind. Resolves once they are readable; a crash may lose them.
    #[napi(
        ts_args_type = "puts: object[], now: number, granularity: number",
        ts_return_type = "Promise<void>"
    )]
    pub fn token_cache_put<'env>(
        &self,
        env: &'env Env,
        puts: Vec<Object>,
        now: f64,
        granularity: f64,
    ) -> Result<Object<'env>> {
        let puts = puts
            .iter()
            .map(|o| {
                Ok(crate::store::token_cache::Put {
                    table: req_integer(o, "table")?,
                    identity: bytes_of(o, "identity")?,
                    hash: bytes_of(o, "hash")?,
                    value: bytes_of(o, "value")?,
                    replace: o.get::<bool>("replace")?.unwrap_or(false),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let (deferred, promise) = env.create_deferred()?;
        self.store.token_cache_put(
            puts,
            now as u64,
            granularity as u64,
            Box::new(move |r| match r {
                Ok(()) => deferred.resolve(|_| Ok(())),
                Err(e) => deferred.reject(store_error(e)),
            }),
        );
        Ok(promise)
    }

    /// Evicts up to `batch` of a cache table's least recently used entries while it holds more than `cap`; resolves
    /// with whether it still does.
    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn token_cache_evict<'env>(
        &self,
        env: &'env Env,
        table: u32,
        cap: f64,
        batch: u32,
    ) -> Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred()?;
        self.store.token_cache_evict(
            u64::from(table),
            cap as u64,
            batch as usize,
            Box::new(move |r| match r {
                Ok(more) => deferred.resolve(move |_| Ok(more)),
                Err(e) => deferred.reject(store_error(e)),
            }),
        );
        Ok(promise)
    }

    /// One slice of the pair postings' pass (the `searchPairs` record starts one); resolves with whether more
    /// follow.
    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn pairs_step<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred()?;
        self.store.pairs_step(Box::new(move |r| match r {
            Ok(more) => deferred.resolve(move |_| Ok(more)),
            Err(e) => deferred.reject(store_error(e)),
        }));
        Ok(promise)
    }

    /// The pair postings' mode: 0 off, 1 building, 2 on, 3 deleting.
    #[napi(ts_return_type = "Promise<number>")]
    pub fn pairs_mode<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        derived(env, &self.store, |s| s.pairs_mode().map(|m| m as u32))
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

    /// A chat read (`store::chat_read`), by `op` with its arguments in `args`:
    /// - `messages { ids }`: each message's values, or null;
    /// - `children { parent?, tree, after?, limit }`: `{ ids, more }`, a message's replies or a tree's openings;
    /// - `path { tree, at? }`: the messages from the tree's root down to `at`;
    /// - `landing { tree, session?, user? }`, `followed { tree, at?, session?, user? }`: a message or null;
    /// - `sessions { ids }`, `sessionInTree { session, tree }`, `userInTree { user, tree }`;
    /// - `sessionsNamed { user, tree, name }`: the sessions named exactly `name` that the user has moved in the tree;
    /// - `history { session, from, limit }`, `recent { before?, limit }`, `inTree { tree, before?, limit }`;
    /// - `historyStep { session, back }`: the entry a step reaches, or null; `openingChoice { session, tree }`;
    /// - `messageCount { tree, at? }`: `{ count, estimate }`;
    /// - `ids { space: 0 message | 1 session | 2 user, keys }`, `keyStates { space, keys }` (`{ id }`, `'gone'` for a
    ///   deleted session's, or null), `nextIds {}`;
    /// - `bookmarks { ids }`, `treeBookmarks { tree, after?, limit }`, `bookmarksAt { message }`;
    /// - `state { tree, at? }`: `[{ variable, field, json }]`;
    /// - `stats { owners }`: `{ owners, totals }`; `itemization { message }`; `sent { owner, keys }`;
    /// - `itemized { after?, limit }`: `{ ids, more }`, messages with an itemization in id order;
    /// - `tokenCache { table, identity, hash }`: `{ used, value }` or null; `tokenCacheCount { table }`.
    #[napi(
        ts_args_type = "op: string, args: object",
        ts_return_type = "Promise<any>"
    )]
    pub fn chat_read<'env>(
        &self,
        env: &'env Env,
        op: String,
        args: Object,
    ) -> Result<Object<'env>> {
        use crate::store::chat_read as cr;
        let a = &args;
        let limit = |a: &Object| -> Result<usize> { Ok(req_integer(a, "limit")? as usize) };
        let read: TreeRead = match op.as_str() {
            "messages" => {
                let ids = integers(a, "ids")?;
                Box::new(move |s| s.chat_read(|v| cr::messages(v, &ids)).map(JsTree))
            }
            "children" => {
                let (parent, tree, after, limit) = (
                    opt_integer(a, "parent")?,
                    req_integer(a, "tree")?,
                    opt_integer(a, "after")?,
                    limit(a)?,
                );
                Box::new(move |s| {
                    s.chat_read(|v| cr::children(v, parent, tree, after, limit))
                        .map(JsTree)
                })
            }
            "path" | "followed" | "landing" => {
                let (tree, at, ses, user) = (
                    req_integer(a, "tree")?,
                    opt_integer(a, "at")?,
                    opt_integer(a, "session")?,
                    opt_integer(a, "user")?,
                );
                let op = op.clone();
                Box::new(move |s| {
                    s.chat_read(|v| match op.as_str() {
                        "path" => cr::path(v, at),
                        "followed" => cr::followed(v, tree, at, ses, user),
                        _ => cr::landing(v, tree, ses, user),
                    })
                    .map(JsTree)
                })
            }
            "sessions" => {
                let ids = integers(a, "ids")?;
                Box::new(move |s| s.chat_read(|v| cr::sessions(v, &ids)).map(JsTree))
            }
            "sessionInTree" => {
                let (ses, tree) = (req_integer(a, "session")?, req_integer(a, "tree")?);
                Box::new(move |s| {
                    s.chat_read(|v| cr::session_in_tree(v, ses, tree))
                        .map(JsTree)
                })
            }
            "sessionsNamed" => {
                let (user, tree) = (req_integer(a, "user")?, req_integer(a, "tree")?);
                let name = string(
                    "name",
                    a.get::<Unknown>("name")?
                        .ok_or_else(|| invalid("sessionsNamed needs a name".into()))?,
                )?;
                Box::new(move |s| {
                    s.chat_read(|v| {
                        Ok(cr::Js::Arr(
                            crate::store::sessions::by_name(v, user, tree, &name)?
                                .into_iter()
                                .map(cr::Js::Big)
                                .collect(),
                        ))
                    })
                    .map(JsTree)
                })
            }
            "userInTree" => {
                let (user, tree) = (req_integer(a, "user")?, req_integer(a, "tree")?);
                Box::new(move |s| s.chat_read(|v| cr::user_in_tree(v, user, tree)).map(JsTree))
            }
            "history" => {
                let (ses, from, limit) = (
                    req_integer(a, "session")?,
                    opt_integer(a, "from")?.unwrap_or(0),
                    limit(a)?,
                );
                Box::new(move |s| {
                    s.chat_read(|v| cr::history(v, ses, from, limit))
                        .map(JsTree)
                })
            }
            "historyStep" => {
                let ses = req_integer(a, "session")?;
                let back: bool = a.get("back")?.unwrap_or(false);
                Box::new(move |s| s.chat_read(|v| cr::history_step(v, ses, back)).map(JsTree))
            }
            "openingChoice" => {
                let (ses, tree) = (req_integer(a, "session")?, req_integer(a, "tree")?);
                Box::new(move |s| {
                    s.chat_read(|v| cr::opening_choice(v, ses, tree))
                        .map(JsTree)
                })
            }
            "recent" => {
                let (before, limit) = (opt_integer(a, "before")?, limit(a)?);
                Box::new(move |s| s.chat_read(|v| cr::recent(v, before, limit)).map(JsTree))
            }
            "inTree" => {
                let (tree, before, limit) = (
                    req_integer(a, "tree")?,
                    opt_integer(a, "before")?,
                    limit(a)?,
                );
                Box::new(move |s| {
                    s.chat_read(|v| cr::in_tree(v, tree, before, limit))
                        .map(JsTree)
                })
            }
            "messageCount" => {
                let (tree, at) = (req_integer(a, "tree")?, opt_integer(a, "at")?);
                Box::new(move |s| s.chat_read(|v| cr::message_count(v, tree, at)).map(JsTree))
            }
            "ids" => {
                let space = req_integer(a, "space")?;
                if space > 2 {
                    return Err(invalid(format!("no key space {space}")));
                }
                let keys = byte_list(a, "keys")?;
                Box::new(move |s| {
                    s.chat_read(|v| cr::ids_by_keys(v, space as u8, &keys))
                        .map(JsTree)
                })
            }
            "keyStates" => {
                let space = req_integer(a, "space")?;
                if space > 2 {
                    return Err(invalid(format!("no key space {space}")));
                }
                let keys = byte_list(a, "keys")?;
                Box::new(move |s| {
                    s.chat_read(|v| cr::key_states(v, space as u8, &keys))
                        .map(JsTree)
                })
            }
            "nextIds" => Box::new(|s| s.chat_read(cr::next_ids).map(JsTree)),
            "bookmarks" => {
                let ids = integers(a, "ids")?;
                Box::new(move |s| s.chat_read(|v| cr::bookmarks(v, &ids)).map(JsTree))
            }
            "treeBookmarks" => {
                let (tree, after, limit) =
                    (req_integer(a, "tree")?, opt_integer(a, "after")?, limit(a)?);
                Box::new(move |s| {
                    s.chat_read(|v| cr::tree_bookmarks(v, tree, after, limit))
                        .map(JsTree)
                })
            }
            "bookmarksAt" => {
                let m = req_integer(a, "message")?;
                Box::new(move |s| s.chat_read(|v| cr::bookmarks_at(v, m)).map(JsTree))
            }
            "state" => {
                let (tree, at) = (req_integer(a, "tree")?, opt_integer(a, "at")?);
                Box::new(move |s| s.chat_read(|v| cr::state_at(v, tree, at)).map(JsTree))
            }
            "stats" => {
                let owners = integers(a, "owners")?;
                Box::new(move |s| s.chat_read(|v| cr::chat_stats(v, &owners)).map(JsTree))
            }
            "itemization" => {
                let m = req_integer(a, "message")?;
                Box::new(move |s| s.chat_read(|v| cr::itemization(v, m)).map(JsTree))
            }
            "itemized" => {
                let (after, limit) = (opt_integer(a, "after")?, limit(a)?);
                Box::new(move |s| s.chat_read(|v| cr::itemized(v, after, limit)).map(JsTree))
            }
            "tokenCache" => {
                let (table, identity, hash) = (
                    req_integer(a, "table")?,
                    bytes_of(a, "identity")?,
                    bytes_of(a, "hash")?,
                );
                Box::new(move |s| {
                    s.chat_read(|v| {
                        Ok(
                            match crate::store::token_cache::get(v, table, &identity, &hash)? {
                                Some((used, value)) => cr::Js::Obj(vec![
                                    ("used", cr::Js::Num(used as f64)),
                                    ("value", cr::Js::Bytes(value)),
                                ]),
                                None => cr::Js::Null,
                            },
                        )
                    })
                    .map(JsTree)
                })
            }
            "tokenCacheCount" => {
                let table = req_integer(a, "table")?;
                Box::new(move |s| {
                    s.chat_read(|v| {
                        Ok(cr::Js::Num(
                            crate::store::token_cache::count(v, table)? as f64
                        ))
                    })
                    .map(JsTree)
                })
            }
            "sent" => {
                let (owner, keys) = (req_integer(a, "owner")?, byte_list(a, "keys")?);
                Box::new(move |s| s.chat_read(|v| cr::sent(v, owner, &keys)).map(JsTree))
            }
            other => return Err(invalid(format!("no chat read {other}"))),
        };
        derived(env, &self.store, read)
    }

    /// A page of a tree's sessions searched (`store::chat_search`): `{ tree, clauses, before?, limit }`, `clauses`
    /// as `search` takes them (their fields ignored). Resolves with `{ hits: [{ position, session, at }], more,
    /// next? }`: most recent first; `next` is the `before` to read on from.
    #[napi(
        ts_args_type = "query: object",
        ts_return_type = "Promise<{ hits: { position: bigint, session: bigint, at: bigint | null }[], more: boolean, next?: bigint }>"
    )]
    pub fn chat_search<'env>(&self, env: &'env Env, query: Object) -> Result<Object<'env>> {
        use crate::store::chat_read::Js;
        let tree = req_integer(&query, "tree")?;
        let (before, limit) = (
            opt_integer(&query, "before")?,
            req_integer(&query, "limit")? as usize,
        );
        let clauses = clauses_from_js(&query, Scope::LIBRARY)?;
        derived(env, &self.store, move |s| {
            let p = s.chat_search(tree, &clauses, before, limit)?;
            let hits = p
                .hits
                .into_iter()
                .map(|h| {
                    Js::Obj(vec![
                        ("position", Js::Big(h.position)),
                        ("session", Js::Big(h.session)),
                        ("at", h.at.map_or(Js::Null, Js::Big)),
                    ])
                })
                .collect();
            let mut o = vec![("hits", Js::Arr(hits)), ("more", Js::Bool(p.more))];
            if let Some(n) = p.next {
                o.push(("next", Js::Big(n)));
            }
            Ok(JsTree(Js::Obj(o)))
        })
    }

    /// A world-info read (`store::books`), by `op` with its arguments in `args`:
    /// - `books { after?, limit }`: `{ books: [{ id, key }], more }`, the defined world books in key order;
    /// - `entries { book, after?, limit }`: `{ entries: [{ id, position }], more }`, a book's entries in place order;
    /// - `resolved { ids }`: each book as its forwards resolve it, `{ id, key, defined }` or null;
    /// - `links { ids }`: each character's linked book, or null;
    /// - `numbers { book }`: `{ lastPosition, freeKey, maxIndex }`;
    /// - `linkers { book, after?, limit }`: `{ ids, more }`, the characters linking the book itself, in id order;
    /// - `resolving { book }`: the book and every unresolved book resolving as it.
    #[napi(
        ts_args_type = "op: string, args: object",
        ts_return_type = "Promise<any>"
    )]
    pub fn world_read<'env>(
        &self,
        env: &'env Env,
        op: String,
        args: Object,
    ) -> Result<Object<'env>> {
        use crate::store::books as b;
        let a = &args;
        let read: TreeRead = match op.as_str() {
            "books" => {
                let after = match a.get::<Unknown>("after")? {
                    Some(v) if !matches!(v.get_type()?, ValueType::Null | ValueType::Undefined) => {
                        Some(string("after", v)?)
                    }
                    _ => None,
                };
                let limit = req_integer(a, "limit")? as usize;
                Box::new(move |s| {
                    s.chat_read(|v| b::books_page(v, after.as_deref(), limit))
                        .map(JsTree)
                })
            }
            "entries" => {
                let (book, after, limit) = (
                    req_integer(a, "book")?,
                    opt_integer(a, "after")?,
                    req_integer(a, "limit")? as usize,
                );
                Box::new(move |s| {
                    s.chat_read(|v| b::entries_page(v, book, after, limit))
                        .map(JsTree)
                })
            }
            "resolved" => {
                let ids = integers(a, "ids")?;
                Box::new(move |s| s.chat_read(|v| b::resolved(v, &ids)).map(JsTree))
            }
            "links" => {
                let ids = integers(a, "ids")?;
                Box::new(move |s| s.chat_read(|v| b::links(v, &ids)).map(JsTree))
            }
            "numbers" => {
                let book = req_integer(a, "book")?;
                Box::new(move |s| s.chat_read(|v| b::book_numbers(v, book)).map(JsTree))
            }
            "linkers" => {
                let (book, after, limit) = (
                    req_integer(a, "book")?,
                    opt_integer(a, "after")?,
                    req_integer(a, "limit")? as usize,
                );
                Box::new(move |s| {
                    s.chat_read(|v| b::linkers_page(v, book, after, limit))
                        .map(JsTree)
                })
            }
            "resolving" => {
                let book = req_integer(a, "book")?;
                Box::new(move |s| s.chat_read(|v| b::resolving_page(v, book)).map(JsTree))
            }
            other => return Err(invalid(format!("no world read {other}"))),
        };
        derived(env, &self.store, read)
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
        let q = library_query_from_js(&query, true)?;
        derived(env, &self.store, move |s| {
            s.library_page(&q).map(LibraryPage)
        })
    }

    /// A page of the library list searched: `libraryPage`'s query plus `clauses` (as `search` takes them, in the
    /// library scope) and `relevance: true` for best match first (then `after: { score, doc }`, the last hit of
    /// the page before; `sort` is ignored). Resolves with `{ ids, scores, total, totalExact, more, cursor?, tags,
    /// tagsExact }`: `scores` in relevance order, `cursor` in a list order, `tags` the tags whose names match.
    #[napi(
        ts_args_type = "query: object",
        ts_return_type = "Promise<{ ids: bigint[], scores: number[], total: number, totalExact: boolean, more: boolean, cursor?: Buffer, tags: { tag: bigint, name: string, carriers: number }[], tagsExact: boolean }>"
    )]
    pub fn library_search<'env>(&self, env: &'env Env, query: Object) -> Result<Object<'env>> {
        let relevance = query.get::<bool>("relevance")?.unwrap_or(false);
        let q = library_query_from_js(&query, !relevance)?;
        let clauses = clauses_from_js(&query, Scope::LIBRARY)?;
        let ordered = if relevance {
            let after = match query.get::<Object>("after")? {
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
                    Some((score, doc))
                }
            };
            library_search::Ordered::Relevance { after }
        } else {
            library_search::Ordered::List
        };
        derived(env, &self.store, move |s| {
            s.library_search(&q, &clauses, ordered).map(LibrarySearched)
        })
    }

    /// Each entity with everything it holds, or null. With `only: { fields, lists }` just those values (a field
    /// by code or key; a list's items with their texts) and no hashes.
    #[napi(
        ts_args_type = "ids: (bigint | number)[], only?: { fields: (number | string)[], lists: number[] }",
        ts_return_type = "Promise<(object | null)[]>"
    )]
    pub fn library_entities<'env>(
        &self,
        env: &'env Env,
        ids: Vec<Unknown>,
        only: Option<Object>,
    ) -> Result<Object<'env>> {
        let ids = ids
            .into_iter()
            .map(|v| integer("id", v))
            .collect::<Result<Vec<_>>>()?;
        let only = match only {
            None => None,
            Some(o) => {
                let mut fields = Vec::new();
                for v in o.get::<Vec<Unknown>>("fields")?.unwrap_or_default() {
                    fields.push(match v.get_type()? {
                        ValueType::String => FieldRef::Key(string("field", v)?),
                        _ => FieldRef::Code(integer("field", v)?),
                    });
                }
                let lists = o
                    .get::<Vec<Unknown>>("lists")?
                    .unwrap_or_default()
                    .into_iter()
                    .map(|v| integer("list", v))
                    .collect::<Result<Vec<_>>>()?;
                Some(library_read::Only { fields, lists })
            }
        };
        derived(env, &self.store, move |s| {
            s.library_entities_with(&ids, only.as_ref())
                .map(LibraryEntities)
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

    /// Each tag's cursor in a sort's order, null for one that isn't live: `{ id, order? }`, an `order` (a
    /// number, or null for none) placing it in the manual order as if it had that order.
    #[napi(
        ts_args_type = "sort: number, items: { id: bigint | number, order?: number | null }[]",
        ts_return_type = "Promise<(Buffer | null)[]>"
    )]
    pub fn tag_positions<'env>(
        &self,
        env: &'env Env,
        sort: u32,
        items: Vec<Object>,
    ) -> Result<Object<'env>> {
        if u64::from(sort) >= tags::SORTS {
            return Err(invalid(format!("no tag sort {sort}")));
        }
        let items = items
            .into_iter()
            .map(|o| {
                let id = match o.get::<Unknown>("id")? {
                    Some(v) => integer("id", v)?,
                    None => return Err(invalid("an item needs an id".into())),
                };
                let order = match o.get::<Unknown>("order")? {
                    None => None,
                    Some(v) if v.get_type()? == ValueType::Null => Some(None),
                    Some(v) => Some(Some(f64::from_unknown(v)?)),
                };
                Ok((id, order))
            })
            .collect::<Result<Vec<_>>>()?;
        derived(env, &self.store, move |s| {
            s.tag_positions(u64::from(sort), &items).map(TagPositions)
        })
    }

    /// Up to `limit` queued moves of the manual order after `after` (a `seq`, 0 for the first), in order:
    /// `{ seq, tag, after, anchor?, value? }`; and whether more follow.
    #[napi(
        ts_return_type = "Promise<{ entries: { seq: number, tag: bigint, after: boolean, anchor?: bigint, value?: string }[], more: boolean }>"
    )]
    pub fn tag_queue<'env>(&self, env: &'env Env, after: u32, limit: u32) -> Result<Object<'env>> {
        derived(env, &self.store, move |s| {
            s.tag_queue(u64::from(after), limit as usize)
                .map(|(e, more)| TagQueue(e, more))
        })
    }

    /// The reorder pass: `{ pass, mode?, phase?, n?, after?, stamped, live }`, `pass` the last one's id (0 for
    /// none), `mode` present while one runs, `stamped` the live tags it has written, `live` the live tags.
    #[napi(
        ts_return_type = "Promise<{ pass: number, mode?: number, phase?: number, n?: number, after?: Buffer, stamped: number, live: number }>"
    )]
    pub fn tag_pass<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        derived(env, &self.store, |s| s.tag_pass().map(TagPassStatus))
    }

    /// Each name's value as its `metaValue` record holds it (JSON text), or null for none.
    #[napi(
        ts_args_type = "names: string[]",
        ts_return_type = "Promise<(string | null)[]>"
    )]
    pub fn meta<'env>(&self, env: &'env Env, names: Vec<Unknown>) -> Result<Object<'env>> {
        let names = names
            .into_iter()
            .map(|v| string("name", v))
            .collect::<Result<Vec<_>>>()?;
        derived(env, &self.store, move |s| s.meta(&names).map(MetaValues))
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

    /// Each entity's `{ type, key }`, or null.
    #[napi(
        ts_args_type = "ids: (bigint | number)[]",
        ts_return_type = "Promise<({ type: number, key: string } | null)[]>"
    )]
    pub fn library_keys<'env>(&self, env: &'env Env, ids: Vec<Unknown>) -> Result<Object<'env>> {
        let ids = ids
            .into_iter()
            .map(|v| integer("id", v))
            .collect::<Result<Vec<_>>>()?;
        derived(env, &self.store, move |s| {
            s.library_keys(&ids).map(LibraryKeys)
        })
    }

    /// The tags each entity carries as they are now (merged tags as their targets), in id order.
    #[napi(
        ts_args_type = "ids: (bigint | number)[]",
        ts_return_type = "Promise<bigint[][]>"
    )]
    pub fn library_tag_ids<'env>(&self, env: &'env Env, ids: Vec<Unknown>) -> Result<Object<'env>> {
        let ids = ids
            .into_iter()
            .map(|v| integer("id", v))
            .collect::<Result<Vec<_>>>()?;
        derived(env, &self.store, move |s| s.library_tag_ids(&ids))
    }

    /// Up to `limit` entities from id `from` on that carry tags, `{ entity, tags }` in id order, and `next`, the
    /// id to go on from (none at the end).
    #[napi(
        ts_args_type = "from: bigint | number, limit: number",
        ts_return_type = "Promise<{ entries: { entity: bigint, tags: bigint[] }[], next?: bigint }>"
    )]
    pub fn tag_assignments<'env>(
        &self,
        env: &'env Env,
        from: Unknown,
        limit: u32,
    ) -> Result<Object<'env>> {
        let from = integer("from", from)?;
        derived(env, &self.store, move |s| {
            s.tag_assignments(from, limit as usize)
                .map(|(e, next)| TagAssignments(e, next))
        })
    }

    /// For each tag id: `{ key, state, into? }` as `tagStatus` gives them, or null.
    #[napi(
        ts_args_type = "ids: (bigint | number)[]",
        ts_return_type = "Promise<({ key: string, state: 'live' | 'undefined' | 'gone', into?: string } | null)[]>"
    )]
    pub fn tag_keys<'env>(&self, env: &'env Env, ids: Vec<Unknown>) -> Result<Object<'env>> {
        let ids = ids
            .into_iter()
            .map(|v| integer("id", v))
            .collect::<Result<Vec<_>>>()?;
        derived(env, &self.store, move |s| s.tag_keys(&ids).map(TagKeys))
    }

    /// The highest manual sort order of a live tag, or null.
    #[napi(ts_return_type = "Promise<number | null>")]
    pub fn tag_max_order<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        derived(env, &self.store, |s| s.tag_max_order())
    }

    /// For each tag key: `{ id, state, into? }`, `state` 'live' for a defined tag, 'undefined' for a key only
    /// assignments name, 'gone' for a deleted tag (`into` the key of the live tag its merges lead to); null for a
    /// key no tag entity ever had.
    #[napi(
        ts_args_type = "keys: string[]",
        ts_return_type = "Promise<({ id: bigint, state: 'live' | 'undefined' | 'gone', into?: string } | null)[]>"
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
