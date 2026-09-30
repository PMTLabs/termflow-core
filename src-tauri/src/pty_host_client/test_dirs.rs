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
