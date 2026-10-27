//! Atomic, update-stable staging of the complete macOS helper bundle.
//!
//! The source is validated before any staging I/O. A persistent advisory lock
//! serializes publishers across app processes as well as threads. Invalid images
//! are renamed aside, never unlinked: an old host may still be executing one.
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const NAME: &str = "TermFlow Host.app";
const EXE: &str = "Contents/MacOS/termflow-pty-host";
const PLIST: &str = "Contents/Info.plist";
const SEAL: &str = "Contents/_CodeSignature/CodeResources";
const ID: &str = crate::helper_identity::HELPER_IDENTIFIER;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StagedHost {
    pub exe: PathBuf,
    pub generation: String,
    pub build_id: String,
}

/// Signature verification is injectable so fixtures need no signing identity.
trait SignatureVerifier {
    fn verify(&self, bundle: &Path) -> io::Result<bool>;
}

struct Codesign;
impl SignatureVerifier for Codesign {
    fn verify(&self, bundle: &Path) -> io::Result<bool> {
        let mut cmd = Command::new("/usr/bin/codesign");
        cmd.args(["--verify", "--strict"]);
        // Debug accepts ad-hoc signatures with the helper identifier; release
        // additionally requires Apple's anchor and the Developer ID team.
        let requirement = format!("={}", crate::helper_identity::helper_requirement());
        cmd.args(["-R", &requirement]);
        Ok(cmd.arg(bundle).output()?.status.success())
    }
}

struct Snapshot {
    digest: [u8; 32],
    plist: Vec<u8>,
    seal: Vec<u8>,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

impl Snapshot {
    fn read(source: &Path, verifier: &dyn SignatureVerifier) -> io::Result<Self> {
        // Missing bundle components are invalid artifacts, not staging I/O
        // failures eligible for a fallback to this same source.
        let required = |e: io::Error| {
            if e.kind() == io::ErrorKind::NotFound {
                invalid("missing source helper component")
            } else {
                e
            }
        };
        let plist = fs::read(source.join(PLIST)).map_err(&required)?;
        let seal = fs::read(source.join(SEAL)).map_err(&required)?;
        let snapshot = Self {
            digest: super::sha256_file(&source.join(EXE)).map_err(required)?,
            plist,
            seal,
        };
        if !bundle_is_valid(source, &snapshot, verifier)? {
            return Err(invalid("invalid source helper bundle"));
        }
        Ok(snapshot)
    }
}

/// All three sites (source, reuse, and staged copy) apply the same predicate.
fn bundle_is_valid(
    path: &Path,
    expected: &Snapshot,
    verifier: &dyn SignatureVerifier,
) -> io::Result<bool> {
    let check = || -> io::Result<bool> {
        let metadata = fs::metadata(path.join(EXE))?;
        if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
            return Ok(false);
        }
        let plist = fs::read(path.join(PLIST))?;
        if plist != expected.plist
            || fs::read(path.join(SEAL))? != expected.seal
            || super::sha256_file(&path.join(EXE))? != expected.digest
        {
            return Ok(false);
        }
        let value = match plist::Value::from_reader(std::io::Cursor::new(&plist)) {
            Ok(value) => value,
            Err(_) => return Ok(false),
        };
        if value
            .as_dictionary()
            .and_then(|d| d.get("CFBundleIdentifier"))
            .and_then(|v| v.as_string())
            != Some(ID)
        {
            return Ok(false);
        }
        verifier.verify(path)
    };
    match check() {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        result => result,
    }
}

struct Lock(File);
impl Lock {
    fn acquire(root: &Path) -> io::Result<Self> {
        use fs4::FileExt;
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(root.join(".bundle-staging.lock"))?;
        FileExt::lock(&file)?;
        Ok(Self(file))
    }
}
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs4::FileExt::unlock(&self.0);
    }
}

struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

trait Operations {
    fn copy(&self, src: &Path, dest: &Path) -> io::Result<()>;
    fn publish(&self, src: &Path, dest: &Path) -> io::Result<()> {
        fs::rename(src, dest)
    }
}
struct SystemOperations;
impl Operations for SystemOperations {
    fn copy(&self, src: &Path, dest: &Path) -> io::Result<()> {
        #[cfg(target_os = "macos")]
        let mut command = Command::new("/usr/bin/ditto");
        #[cfg(not(target_os = "macos"))]
        let mut command = {
            let mut c = Command::new("cp");
            c.arg("-pR");
            c
        };
        let status = command.arg(src).arg(dest).status()?;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!("bundle copy failed: {status}")))
        }
    }
}

pub(super) fn validate_source(src_bundle: &Path) -> io::Result<String> {
    let snapshot = Snapshot::read(src_bundle, &Codesign)?;
    Ok(super::hex_full(&snapshot.digest))
}

pub(super) fn install_host_bundle_into(
    src_bundle: &Path,
    dest_root: &Path,
) -> io::Result<StagedHost> {
    install_with(src_bundle, dest_root, &Codesign, &SystemOperations)
}

fn install_with(
    src: &Path,
    root: &Path,
    verifier: &dyn SignatureVerifier,
    ops: &dyn Operations,
) -> io::Result<StagedHost> {
    let expected = Snapshot::read(src, verifier)?;
    let generation = super::hex16(&expected.digest);
    let dir = root.join(&generation);
    let dest = dir.join(NAME);
    let staged = StagedHost {
        exe: dest.join(EXE),
        generation,
        build_id: super::hex_full(&expected.digest),
    };
    fs::create_dir_all(root)?;
    let _lock = Lock::acquire(root)?;
    fs::create_dir_all(&dir)?;
    if bundle_is_valid(&dest, &expected, verifier)? {
        return Ok(staged);
    }
    let tmp = Temporary(dir.join(format!("{NAME}.staging-{}", uuid::Uuid::new_v4())));
    ops.copy(src, &tmp.0)?;
    if !bundle_is_valid(&tmp.0, &expected, verifier)? {
        return Err(invalid("staged helper failed validation"));
    }
    if fs::symlink_metadata(&dest).is_ok() {
        fs::rename(
            &dest,
            dir.join(format!("{NAME}.invalid-{}", uuid::Uuid::new_v4())),
        )?;
    }
    match ops.publish(&tmp.0, &dest) {
        Ok(()) => Ok(staged),
        Err(_) if bundle_is_valid(&dest, &expected, verifier)? => Ok(staged),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Barrier,
    };

    struct Fixture {
        root: PathBuf,
        source: PathBuf,
        runtime: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("tf-bundle-test-{}", uuid::Uuid::new_v4()));
            let source = root.join("source").join(NAME);
            fs::create_dir_all(source.join("Contents/MacOS")).unwrap();
            fs::create_dir_all(source.join("Contents/_CodeSignature")).unwrap();
            fs::create_dir_all(source.join("Contents/Resources")).unwrap();
            fs::write(source.join(EXE), b"fixture executable").unwrap();
            fs::set_permissions(source.join(EXE), fs::Permissions::from_mode(0o751)).unwrap();
            fs::write(source.join(PLIST), format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>{ID}</string></dict></plist>")).unwrap();
            fs::write(source.join(SEAL), b"fixture seal").unwrap();
            symlink("../Info.plist", source.join("Contents/Resources/link")).unwrap();
            let runtime = root.join("runtime");
            Self {
                root,
                source,
                runtime,
            }
        }
        fn install(&self) -> io::Result<StagedHost> {
            install_with(&self.source, &self.runtime, &Fake, &SystemOperations)
        }
        fn bundle(&self, host: &StagedHost) -> PathBuf {
            self.runtime.join(&host.generation).join(NAME)
        }
        fn entries(&self, host: &StagedHost, marker: &str) -> Vec<PathBuf> {
            fs::read_dir(self.runtime.join(&host.generation))
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| p.file_name().unwrap().to_string_lossy().contains(marker))
                .collect()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    struct Fake;
    impl SignatureVerifier for Fake {
        fn verify(&self, _: &Path) -> io::Result<bool> {
            Ok(true)
        }
    }

    #[test]
    fn reuse_when_valid_preserves_symlink_and_mode() {
        let f = Fixture::new();
        let a = f.install().unwrap();
        let bundle = f.bundle(&a);
        fs::write(bundle.join("marker"), b"untouched").unwrap();
        assert_eq!(a, f.install().unwrap());
        assert!(bundle.join("marker").exists());
        assert!(fs::symlink_metadata(bundle.join("Contents/Resources/link"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::metadata(&a.exe).unwrap().permissions().mode() & 0o777,
            0o751
        );
        assert_eq!(a.generation.len(), 16);
    }
    #[test]
    fn tampered_plist_is_renamed_aside_and_running_image_remains() {
        let f = Fixture::new();
        let a = f.install().unwrap();
        let bundle = f.bundle(&a);
        let open_image = File::open(&a.exe).unwrap();
        fs::write(bundle.join(PLIST), b"tampered plist").unwrap();
        assert_eq!(a, f.install().unwrap());
        let invalid = f.entries(&a, ".invalid-");
        assert_eq!(invalid.len(), 1);
        assert_eq!(fs::read(invalid[0].join(PLIST)).unwrap(), b"tampered plist");
        assert_eq!(
            fs::read(invalid[0].join(EXE)).unwrap(),
            b"fixture executable"
        );
        assert_eq!(open_image.metadata().unwrap().len(), 18);
    }
    #[test]
    fn tampered_seal_and_missing_seal_are_repaired() {
        let f = Fixture::new();
        let a = f.install().unwrap();
        let bundle = f.bundle(&a);
        fs::write(bundle.join(SEAL), b"tampered").unwrap();
        f.install().unwrap();
        assert_eq!(f.entries(&a, ".invalid-").len(), 1);
        fs::remove_file(bundle.join(SEAL)).unwrap();
        f.install().unwrap();
        assert_eq!(f.entries(&a, ".invalid-").len(), 2);
        fs::remove_file(f.source.join(SEAL)).unwrap();
        assert!(f.install().is_err());
    }
    #[test]
    fn source_identity_and_signature_are_required() {
        struct Reject;
        impl SignatureVerifier for Reject {
            fn verify(&self, _: &Path) -> io::Result<bool> {
                Ok(false)
            }
        }
        let f = Fixture::new();
        assert_eq!(
            install_with(&f.source, &f.runtime, &Reject, &SystemOperations)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        let plist = fs::read_to_string(f.source.join(PLIST))
            .unwrap()
            .replace(ID, "wrong.identity");
        fs::write(f.source.join(PLIST), plist).unwrap();
        assert_eq!(f.install().unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert!(!f.runtime.exists());
    }
    #[test]
    fn signature_verification_error_cleans_staging() {
        struct FailStaged;
        impl SignatureVerifier for FailStaged {
            fn verify(&self, path: &Path) -> io::Result<bool> {
                if path.to_string_lossy().contains(".staging-") {
                    Err(io::Error::other("injected verification error"))
                } else {
                    Ok(true)
                }
            }
        }
        let f = Fixture::new();
        assert!(install_with(&f.source, &f.runtime, &FailStaged, &SystemOperations).is_err());
        let generation =
            super::super::hex16(&super::super::sha256_file(&f.source.join(EXE)).unwrap());
        assert_eq!(fs::read_dir(f.runtime.join(generation)).unwrap().count(), 0);
    }
    #[test]
    fn resolver_chain_stages_explicit_generation_and_pins_endpoint() {
        let f = Fixture::new();
        let source = f.source.join(EXE);
        let expected = install_with(&f.source, &f.runtime, &Fake, &SystemOperations).unwrap();
        let launch = super::super::resolve_bundle_launch(
            &source,
            &f.source,
            Some(&f.runtime),
            |p| Snapshot::read(p, &Fake).map(|s| super::super::hex_full(&s.digest)),
            |s, d| install_with(s, d, &Fake, &SystemOperations),
        )
        .unwrap();
        assert_eq!(launch.path, expected.exe);
        assert_eq!(launch.build_id.as_deref(), Some(expected.build_id.as_str()));
        assert_eq!(
            launch.generation.as_deref(),
            Some(expected.generation.as_str())
        );
        assert_eq!(expected.generation.len(), 16);
        assert_ne!(
            launch.path.parent().unwrap().file_name().unwrap(),
            expected.generation.as_str()
        );
        let paths = super::super::endpoints::test_pinned_paths(launch.generation.as_deref());
        assert!(paths.endpoint.contains(&expected.generation));
    }
    #[test]
    fn resolver_fallback_policy_rejects_invalid_and_uses_valid_source_on_io() {
        let f = Fixture::new();
        let source = f.source.join(EXE);
        let valid = |p: &Path| Snapshot::read(p, &Fake).map(|s| super::super::hex_full(&s.digest));
        let launch = super::super::resolve_bundle_launch(
            &source,
            &f.source,
            Some(&f.runtime),
            valid,
            |_, _| Err(io::Error::new(io::ErrorKind::PermissionDenied, "injected")),
        )
        .unwrap();
        assert_eq!(launch.path, source);
        assert_eq!(launch.generation, None);
        assert!(super::super::exe_origin::spawned_from_bundled_fallback(
            true,
            &launch.path,
            Some(&f.runtime),
            false
        ));
        for error in [io::ErrorKind::InvalidData, io::ErrorKind::NotFound] {
            assert!(super::super::resolve_bundle_launch(
                &source,
                &f.source,
                Some(&f.runtime),
                |_| Err(io::Error::new(error, "invalid or missing")),
                |_, _| panic!("must not stage rejected source")
            )
            .is_none());
        }
        assert!(super::super::resolve_bundle_launch(
            &source,
            &f.source,
            Some(&f.runtime),
            valid,
            |_, _| Err(invalid("signature rejected"))
        )
        .is_none());
    }
    #[test]
    fn release_selection_ignores_dev_and_debug_keeps_it() {
        let f = Fixture::new();
        let bare = f.root.join("bare");
        fs::write(&bare, b"bare").unwrap();
        assert_eq!(
            super::super::select_macos_host(None, false, vec![bare.clone()]),
            None
        );
        assert_eq!(
            super::super::select_macos_host(None, true, vec![bare.clone()]),
            Some(bare)
        );
        let helper = f.source.join(EXE);
        assert_eq!(
            super::super::select_macos_host(Some(helper.clone()), false, vec![]),
            Some(helper)
        );
    }
    #[cfg(all(target_os = "macos", debug_assertions))]
    #[test]
    fn debug_bare_override_still_installs() {
        let f = Fixture::new();
        let bare = f.root.join("bare");
        fs::write(&bare, b"bare").unwrap();
        let launch = super::super::resolve_macos_launch(bare.clone(), Some(&f.runtime)).unwrap();
        assert_eq!(fs::read(launch.path).unwrap(), b"bare");
    }
    #[test]
    fn live_probe_matches_nested_host_image() {
        let path = Path::new(
            "/tmp/runtime/0123456789abcdef/TermFlow Host.app/Contents/MacOS/termflow-pty-host",
        );
        assert!(super::super::host_image_matches(
            std::ffi::OsStr::new("other"),
            Some(path)
        ));
        assert!(!super::super::host_image_matches(
            std::ffi::OsStr::new("other"),
            Some(Path::new("/tmp/other"))
        ));
    }
    struct Counting(AtomicUsize);
    impl Operations for Counting {
        fn copy(&self, s: &Path, d: &Path) -> io::Result<()> {
            SystemOperations.copy(s, d)
        }
        fn publish(&self, s: &Path, d: &Path) -> io::Result<()> {
            self.0.fetch_add(1, Ordering::SeqCst);
            fs::rename(s, d)
        }
    }
    #[test]
    fn concurrent_stagers_publish_once() {
        let f = Fixture::new();
        let barrier = Arc::new(Barrier::new(2));
        let ops = Arc::new(Counting(AtomicUsize::new(0)));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let b = barrier.clone();
                let o = ops.clone();
                let s = f.source.clone();
                let r = f.runtime.clone();
                std::thread::spawn(move || {
                    b.wait();
                    install_with(&s, &r, &Fake, &*o).unwrap()
                })
            })
            .collect();
        let result: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(result[0], result[1]);
        assert_eq!(ops.0.load(Ordering::SeqCst), 1);
    }
    struct Failing(&'static str);
    impl Operations for Failing {
        fn copy(&self, s: &Path, d: &Path) -> io::Result<()> {
            SystemOperations.copy(s, d)?;
            if self.0 == "copy" {
                return Err(io::Error::other("copy"));
            }
            if self.0 == "verify" {
                fs::write(d.join(SEAL), b"bad")?;
            }
            Ok(())
        }
        fn publish(&self, _: &Path, _: &Path) -> io::Result<()> {
            Err(io::Error::other("rename"))
        }
    }
    #[test]
    fn failures_clean_temporary_bundles() {
        for mode in ["copy", "verify", "rename"] {
            let f = Fixture::new();
            assert!(install_with(&f.source, &f.runtime, &Fake, &Failing(mode)).is_err());
            let generation =
                super::super::hex16(&super::super::sha256_file(&f.source.join(EXE)).unwrap());
            let names: Vec<_> = fs::read_dir(f.runtime.join(generation))
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect();
            assert!(names.is_empty(), "{mode}: {names:?}");
        }
    }
}
