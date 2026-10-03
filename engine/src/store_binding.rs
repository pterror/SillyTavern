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
use crate::store::{Store as Inner, StoreConfig, StoreError, StoreResult};

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
