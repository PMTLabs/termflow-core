use std::path::{Path, PathBuf};

pub(super) struct TestDir(PathBuf);
impl TestDir {
    pub(super) fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
pub(super) fn tempdir() -> std::io::Result<TestDir> {
    let path = std::env::temp_dir().join(format!("tfhost-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path)?;
    Ok(TestDir(path))
}

/// Serialises tests that run a real child process against tests that inspect the
/// test process's own descendants (the foreground-cwd walk would otherwise pick
/// up the child and report its working directory).
pub(crate) static CHILD_PROCESS_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn child_process_gate() -> std::sync::MutexGuard<'static, ()> {
    CHILD_PROCESS_TESTS.lock().unwrap_or_else(|e| e.into_inner())
}
