//! The I/O fault seam: every write, sync, directory sync, rename, removal and truncation the log and the runs
//! make passes through a hook here first. Outside tests every hook is an inlined `Ok`, so production pays
//! nothing.
//!
//! In tests, a `Plan` installed for a directory counts the operations on paths under it and, at a chosen
//! operation, fails it (EIO, ENOSPC), tears a write (part of its bytes, then EIO) or crashes (the operation and
//! every later one fail). It also follows each file's written and synced lengths, so `crash_cut` can leave a
//! file as a power loss would: synced bytes kept, unsynced ones cut at a seeded point. Not modelled: a rename or
//! a new file lost because its directory wasn't synced.

use std::io;
#[cfg(not(test))]
use std::path::Path;

/// What the hooks are asked about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Sync,
    SyncDir,
    Remove,
}

#[cfg(not(test))]
#[inline(always)]
pub fn op(_: Op, _: &Path) -> io::Result<()> {
    Ok(())
}

/// Before writing `len` bytes at `offset` of `path`: Ok(None) writes them all; Ok(Some(n)) writes the first n
/// and then fails (a torn write); Err fails before writing.
#[cfg(not(test))]
#[inline(always)]
pub fn write(_: &Path, _: u64, _: usize) -> io::Result<Option<usize>> {
    Ok(None)
}

#[cfg(not(test))]
#[inline(always)]
pub fn rename(_: &Path, _: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(not(test))]
#[inline(always)]
pub fn set_len(_: &Path, _: u64) -> io::Result<()> {
    Ok(())
}

/// The error a torn write ends with.
pub fn torn() -> io::Error {
    io::Error::other("injected: a write torn part way")
}

#[cfg(test)]
pub use sim::*;

#[cfg(test)]
mod sim {
    use std::collections::BTreeMap;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    use super::Op;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Fault {
        Eio,
        Enospc,
        /// A write is written part way and fails (a non-write operation fails as `Eio`); the next operation
        /// crashes.
        Torn,
        /// The process is gone: the operation unwinds with `Crashed` (a step under simulation runs on the thread
        /// that waits for it, so the test catches it), and nothing more is written.
        Crash,
    }

    /// The panic payload of a crash (`Fault::Crash`).
    pub struct Crashed;

    /// Runs `f`; Some(its value), or None if a crash (`Fault::Crash`) ended it. Other panics go on.
    pub fn catch_crash<T>(f: impl FnOnce() -> T) -> Option<T> {
        static QUIET: std::sync::Once = std::sync::Once::new();
        QUIET.call_once(|| {
            let default = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                if info.payload().downcast_ref::<Crashed>().is_none() {
                    default(info);
                }
            }));
        });
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
            Ok(v) => Some(v),
            Err(e) if e.downcast_ref::<Crashed>().is_some() => None,
            Err(e) => std::panic::resume_unwind(e),
        }
    }

    #[derive(Default, Debug, Clone, Copy)]
    struct Lengths {
        written: u64,
        synced: u64,
    }

    struct Plan {
        dir: PathBuf,
        ops: u64,
        at: Option<(u64, Fault)>,
        crashed: bool,
        seed: u64,
        files: BTreeMap<PathBuf, Lengths>,
    }

    static PLANS: Mutex<Vec<Arc<Mutex<Plan>>>> = Mutex::new(Vec::new());

    /// A plan for the operations on paths under `dir`; removed when dropped.
    pub struct Faults(Arc<Mutex<Plan>>);

    impl Faults {
        /// Counts operations under `dir`; with `at = Some((n, fault))`, the n-th (from 1) gets `fault`. `seed`
        /// picks where torn writes and `crash_cut` cut.
        pub fn install(dir: &Path, at: Option<(u64, Fault)>, seed: u64) -> Faults {
            let plan = Arc::new(Mutex::new(Plan {
                dir: dir.to_path_buf(),
                ops: 0,
                at,
                crashed: false,
                seed,
                files: BTreeMap::new(),
            }));
            PLANS.lock().unwrap().push(plan.clone());
            Faults(plan)
        }

        /// Operations counted so far.
        pub fn ops(&self) -> u64 {
            self.0.lock().unwrap().ops
        }

        /// Whether the planned fault has happened.
        pub fn fired(&self) -> bool {
            let p = self.0.lock().unwrap();
            p.at.is_some_and(|(n, _)| p.ops >= n)
        }

        /// After a crash: cuts every file written since the plan began to a seeded length between what was
        /// synced and what is on disk, as a power loss may leave it. Returns the bytes cut.
        pub fn crash_cut(&self) -> u64 {
            let mut p = self.0.lock().unwrap();
            let mut cut = 0;
            let files: Vec<_> = p.files.iter().map(|(f, l)| (f.clone(), *l)).collect();
            for (f, l) in files {
                let Ok(meta) = std::fs::metadata(&f) else {
                    continue;
                };
                let len = meta.len();
                if len <= l.synced {
                    continue;
                }
                let keep = l.synced + next(&mut p.seed) % (len - l.synced + 1);
                if keep < len {
                    let h = std::fs::OpenOptions::new().write(true).open(&f).unwrap();
                    h.set_len(keep).unwrap();
                    cut += len - keep;
                }
            }
            cut
        }
    }

    impl Drop for Faults {
        fn drop(&mut self) {
            PLANS.lock().unwrap().retain(|p| !Arc::ptr_eq(p, &self.0));
        }
    }

    fn next(state: &mut u64) -> u64 {
        *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = *state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn plan_for(path: &Path) -> Option<Arc<Mutex<Plan>>> {
        PLANS
            .lock()
            .unwrap()
            .iter()
            .find(|p| path.starts_with(&p.lock().unwrap().dir))
            .cloned()
    }

    fn error(f: Fault) -> io::Error {
        match f {
            Fault::Enospc => io::Error::from_raw_os_error(28),
            _ => io::Error::from_raw_os_error(5),
        }
    }

    /// Counts an operation; the fault it gets, if any. `ST_FAULT_TRACE` prints each.
    fn count(p: &mut Plan, what: &str, path: &Path) -> Option<Fault> {
        p.ops += 1;
        if std::env::var_os("ST_FAULT_TRACE").is_some() {
            eprintln!("fault op {} {what} {}", p.ops, path.display());
        }
        if p.crashed {
            return Some(Fault::Crash);
        }
        match p.at {
            Some((n, f)) if n == p.ops => {
                if f != Fault::Eio && f != Fault::Enospc {
                    p.crashed = true;
                }
                Some(f)
            }
            _ => None,
        }
    }

    /// The error for `f`, after letting go of the plan; a crash unwinds instead.
    fn fail(p: std::sync::MutexGuard<'_, Plan>, f: Fault) -> io::Error {
        drop(p);
        // Already unwinding (a destructor doing I/O after the crash): an error, not a second panic.
        if f == Fault::Crash && !std::thread::panicking() {
            std::panic::panic_any(Crashed);
        }
        error(f)
    }

    pub fn op(op: Op, path: &Path) -> io::Result<()> {
        let Some(plan) = plan_for(path) else {
            return Ok(());
        };
        let mut p = plan.lock().unwrap();
        if let Some(f) = count(&mut p, &format!("{op:?}"), path) {
            return Err(fail(p, f));
        }
        match op {
            Op::Sync => {
                let l = p.files.entry(path.to_path_buf()).or_default();
                l.synced = l.synced.max(l.written);
            }
            Op::Remove => {
                p.files.remove(path);
            }
            Op::SyncDir => {}
        }
        Ok(())
    }

    pub fn write(path: &Path, offset: u64, len: usize) -> io::Result<Option<usize>> {
        let Some(plan) = plan_for(path) else {
            return Ok(None);
        };
        let mut p = plan.lock().unwrap();
        let fault = count(&mut p, "Write", path);
        let n = match fault {
            None => len,
            Some(Fault::Torn) => (next(&mut p.seed) % len.max(1) as u64) as usize,
            Some(f) => return Err(fail(p, f)),
        };
        let l = p.files.entry(path.to_path_buf()).or_default();
        l.written = l.written.max(offset + n as u64);
        Ok((n < len || fault.is_some()).then_some(n))
    }

    pub fn rename(from: &Path, to: &Path) -> io::Result<()> {
        let Some(plan) = plan_for(from) else {
            return Ok(());
        };
        let mut p = plan.lock().unwrap();
        if let Some(f) = count(&mut p, "Rename", from) {
            return Err(fail(p, f));
        }
        if let Some(l) = p.files.remove(from) {
            p.files.insert(to.to_path_buf(), l);
        }
        Ok(())
    }

    pub fn set_len(path: &Path, len: u64) -> io::Result<()> {
        let Some(plan) = plan_for(path) else {
            return Ok(());
        };
        let mut p = plan.lock().unwrap();
        if let Some(f) = count(&mut p, "SetLen", path) {
            return Err(fail(p, f));
        }
        let l = p.files.entry(path.to_path_buf()).or_default();
        l.written = len;
        l.synced = l.synced.min(len);
        Ok(())
    }
}
