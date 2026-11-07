use std::fs;
use std::path::Path;
#[cfg(target_family = "wasm")]
use std::path::PathBuf;

use super::{StoreError, StoreResult};

// Never removed: a second open would lock a new file while the first still holds the old one.
pub const LOCK_FILE: &str = "lock";

// WASI preview 1 has no file locking, so a wasm build excludes only other stores in its own instance.
pub struct DirLock {
    #[cfg(not(target_family = "wasm"))]
    _file: fs::File,
    #[cfg(target_family = "wasm")]
    held: PathBuf,
}

impl DirLock {
    pub fn take(dir: &Path) -> StoreResult<DirLock> {
        if !dir.exists() {
            fs::create_dir_all(dir)?;
            if let Some(parent) = dir.parent() {
                crate::faults::op(crate::faults::Op::SyncDir, parent)?;
                #[cfg(not(windows))]
                fs::File::open(parent)?.sync_all()?;
            }
        }
        DirLock::lock(dir)
    }

    #[cfg(not(target_family = "wasm"))]
    fn lock(dir: &Path) -> StoreResult<DirLock> {
        let path = dir.join(LOCK_FILE);
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;
        match file.try_lock() {
            Ok(()) => Ok(DirLock { _file: file }),
            Err(fs::TryLockError::WouldBlock) => Err(StoreError::InUse(dir.to_path_buf())),
            Err(fs::TryLockError::Error(e)) => Err(std::io::Error::new(
                e.kind(),
                format!("locking {} failed: {e}", path.display()),
            )
            .into()),
        }
    }

    #[cfg(target_family = "wasm")]
    fn lock(dir: &Path) -> StoreResult<DirLock> {
        let held = fs::canonicalize(dir)?;
        if !HELD.lock().unwrap().insert(held.clone()) {
            return Err(StoreError::InUse(dir.to_path_buf()));
        }
        Ok(DirLock { held })
    }
}

#[cfg(target_family = "wasm")]
static HELD: std::sync::Mutex<std::collections::BTreeSet<PathBuf>> =
    std::sync::Mutex::new(std::collections::BTreeSet::new());

#[cfg(target_family = "wasm")]
impl Drop for DirLock {
    fn drop(&mut self) {
        HELD.lock().unwrap().remove(&self.held);
    }
}
