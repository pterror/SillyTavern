//! The record log as JavaScript sees it.
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
use crate::log::{Config, Log, LogError};

fn invalid(msg: String) -> Error {
    Error::new(Status::InvalidArg, msg)
}

fn log_error(e: LogError) -> Error {
    Error::from_reason(e.to_string())
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
    let kind =
        kind_by_name(&kind_name).ok_or_else(|| invalid(format!("no record kind {kind_name}")))?;
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
                Value::Field(FieldRef::Key(k)) | Value::Text(k) => obj.set(
                    slot.name,
                    Utf16String::from(
                        wtf8_to_utf16(&k).map_err(|e| Error::from_reason(e.to_string()))?,
                    ),
                )?,
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

/// The record log of one store directory.
#[napi]
pub struct RecordLog {
    log: Arc<Log>,
}

pub struct OpenTask(PathBuf);

impl Task for OpenTask {
    type Output = Log;
    type JsValue = RecordLog;

    fn compute(&mut self) -> Result<Log> {
        Log::open(&self.0, Config::default()).map_err(log_error)
    }

    fn resolve(&mut self, _env: Env, log: Log) -> Result<RecordLog> {
        Ok(RecordLog { log: Arc::new(log) })
    }
}

pub struct ReadTask(Arc<Log>, u64);

impl Task for ReadTask {
    type Output = Record;
    type JsValue = RecordAt;

    fn compute(&mut self) -> Result<Record> {
        self.0.read(self.1).map_err(log_error)
    }

    fn resolve(&mut self, _env: Env, rec: Record) -> Result<RecordAt> {
        Ok(RecordAt(self.1, rec))
    }
}

pub struct IterateTask(Arc<Log>, u64, usize);

impl Task for IterateTask {
    type Output = (Vec<(u64, Record)>, u64);
    type JsValue = Page;

    fn compute(&mut self) -> Result<Self::Output> {
        self.0.iterate(self.1, self.2).map_err(log_error)
    }

    fn resolve(&mut self, _env: Env, (records, next): Self::Output) -> Result<Page> {
        Ok(Page(records, next))
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
pub struct LogStats {
    /// Groups written and synced.
    pub rounds: f64,
    /// Bytes written: records, pads and trailers.
    pub bytes: f64,
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
impl RecordLog {
    /// Opens (creating if missing) the log in `dir`, cutting off a group a crash left torn.
    #[napi(ts_return_type = "Promise<RecordLog>")]
    pub fn open(dir: String) -> AsyncTask<OpenTask> {
        AsyncTask::new(OpenTask(PathBuf::from(dir)))
    }

    /// Appends the records as one commit; resolves with their positions once they are durable. Throws for a
    /// record that doesn't fit its kind.
    #[napi(
        ts_args_type = "records: object[]",
        ts_return_type = "Promise<bigint[]>"
    )]
    pub fn append<'env>(&self, env: &'env Env, records: Vec<Object>) -> Result<Object<'env>> {
        let records = records
            .iter()
            .map(record_from_js)
            .collect::<Result<Vec<_>>>()?;
        let (deferred, promise) = env.create_deferred()?;
        self.log.append(
            records,
            Box::new(move |result| match result {
                Ok(positions) => deferred.resolve(move |_| Ok(positions)),
                Err(e) => deferred.reject(log_error(e)),
            }),
        );
        Ok(promise)
    }

    /// The record at a durable record's position.
    #[napi(ts_return_type = "Promise<object>")]
    pub fn read(&self, position: BigInt) -> Result<AsyncTask<ReadTask>> {
        Ok(AsyncTask::new(ReadTask(
            self.log.clone(),
            position_arg(position)?,
        )))
    }

    /// Up to `limit` durable records from `from` (0n, a record's position, or a `next` from here), and the
    /// position to continue from.
    #[napi(ts_return_type = "Promise<{ records: object[], next: bigint }>")]
    pub fn iterate(&self, from: BigInt, limit: u32) -> Result<AsyncTask<IterateTask>> {
        Ok(AsyncTask::new(IterateTask(
            self.log.clone(),
            position_arg(from)?,
            limit as usize,
        )))
    }

    /// The position after the last durable record.
    #[napi]
    pub fn durable_end(&self) -> u64 {
        self.log.durable_end()
    }

    #[napi]
    pub fn stats(&self) -> LogStats {
        let s = self.log.stats();
        LogStats {
            rounds: s.rounds as f64,
            bytes: s.bytes as f64,
        }
    }

    /// Waits for queued commits, then stops the writer; later appends reject.
    #[napi]
    pub fn close(&self) {
        self.log.close();
    }
}
