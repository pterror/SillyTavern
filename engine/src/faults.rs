use std::io;
#[cfg(not(test))]
use std::path::Path;

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
        Torn,
        Crash,
    }

    pub struct Crashed;

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

    pub struct Faults(Arc<Mutex<Plan>>);

    impl Faults {
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

        pub fn ops(&self) -> u64 {
            self.0.lock().unwrap().ops
        }

        pub fn fired(&self) -> bool {
            let p = self.0.lock().unwrap();
            p.at.is_some_and(|(n, _)| p.ops >= n)
        }

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

    fn fail(p: std::sync::MutexGuard<'_, Plan>, f: Fault) -> io::Error {
        drop(p);
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
