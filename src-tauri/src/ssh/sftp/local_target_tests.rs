use super::*;

struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().canonicalize().unwrap()
            .join(format!("tf-target-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn download_rejects_parent_escape_symlink_and_windows_name_collision() {
    for name in ["", ".", "..", "../x", "/x", "\\x", "a/b", "a\\b", "a:b", "x.", "x ", "con.txt", "pRn.tar.gz", "AUX", "nul", "Lpt9", "COM¹", "x?", "x*", "x\"", "x<", "x>", "x|"] {
        assert_eq!(validate_local_name(name), Err(LocalNameError::Invalid), "{name:?}");
    }
    for prefix in ["cOm", "lPt"] {
        for i in 1..=9 {
            for ext in ["", ".txt"] {
                let name = format!("{prefix}{i}{ext}");
                assert_eq!(validate_local_name(&name), Err(LocalNameError::Invalid), "{name}");
            }
        }
    }
    for byte in (0..=0x1f).chain([0x7f]) {
        assert_eq!(validate_local_name(&format!("x{}y", char::from(byte))), Err(LocalNameError::Invalid));
    }
    for name in ["normal.txt", ".gitignore", "COM0", "LPT10", "conifer", "file name", "é"] {
        assert_eq!(validate_local_name(name), Ok(()), "{name}");
    }
    let mut names = PlannedNames::default();
    assert_eq!(names.insert("Report.txt"), Ok(()));
    assert_eq!(names.insert("report.TXT"), Err(LocalNameError::Collision));
    assert_eq!(PlannedNames::default().insert("report.TXT"), Ok(()));
}

#[test]
fn existing_folder_merge_refused() {
    let Tree(root) = &Tree::new();
    let child = create_child_dir_exclusive(root, "selected").unwrap();
    fs::write(child.join("sentinel"), b"keep").unwrap();
    assert!(matches!(create_child_dir_exclusive(root, "selected"), Err(LocalError::Exists)));
    assert_eq!(fs::read(child.join("sentinel")).unwrap(), b"keep");
}

#[cfg(any(unix, windows))]
fn link_or_skip(target: &Path, link: &Path, directory: bool) -> bool {
    #[cfg(unix)]
    {
        let _ = directory;
        std::os::unix::fs::symlink(target, link).unwrap();
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::{symlink_dir, symlink_file};
        use windows_sys::Win32::Foundation::ERROR_PRIVILEGE_NOT_HELD;
        let result = if directory { symlink_dir(target, link) } else { symlink_file(target, link) };
        if let Err(err) = result {
            if err.raw_os_error() == Some(ERROR_PRIVILEGE_NOT_HELD as i32) {
                eprintln!("SKIPPED: Windows symbolic link creation requires Developer Mode or SeCreateSymbolicLinkPrivilege ({err})");
                return false;
            }
            panic!("Could not create test link: {err}");
        }
    }
    assert!(fs::symlink_metadata(link).unwrap().is_symlink());
    true
}

#[cfg(any(unix, windows))]
#[test]
fn preexisting_part_symlink_sentinel_untouched() {
    let Tree(root) = &Tree::new();
    let sentinel = root.join("sentinel");
    fs::write(&sentinel, b"sentinel").unwrap();
    let planted = root.join(format!(".termflow-{}.part", uuid::Uuid::new_v4()));
    if !link_or_skip(&sentinel, &planted, false) {
        return;
    }
    let mut part = stage_file(root).unwrap();
    assert_ne!(part.path, planted);
    part.write_all(b"download").unwrap();
    let final_path = root.join("selected");
    part.commit_no_replace(&final_path).unwrap();
    assert_eq!(fs::read(final_path).unwrap(), b"download");
    assert_eq!(fs::read(sentinel).unwrap(), b"sentinel");
    assert!(fs::symlink_metadata(planted).unwrap().is_symlink());
    assert_eq!(fs::read_dir(root).unwrap().count(), 3);
}

#[test]
fn destination_appearing_before_commit_is_not_overwritten() {
    let Tree(root) = &Tree::new();
    let final_path = root.join("selected");
    let mut part = stage_file(root).unwrap();
    part.write_all(b"new").unwrap();
    let result = part.commit_with_link(&final_path, |from, to| {
        fs::write(to, b"racer")?;
        fs::hard_link(from, to)
    });
    assert!(matches!(result, Err(LocalError::Conflict)));
    assert_eq!(fs::read(&final_path).unwrap(), b"racer");
    assert_eq!(fs::read_dir(root).unwrap().count(), 1);
}

#[test]
fn no_hardlink_filesystem_refuses_commit() {
    let Tree(root) = &Tree::new();
    let final_path = root.join("selected");
    let mut part = stage_file(root).unwrap();
    part.write_all(b"new").unwrap();
    let result = part.commit_with_link(&final_path, |_, _| {
        #[cfg(windows)]
        let err = io::Error::from_raw_os_error(windows_sys::Win32::Foundation::ERROR_NOT_SUPPORTED as i32);
        #[cfg(unix)]
        let err = io::Error::from_raw_os_error(libc::EPERM);
        #[cfg(not(any(windows, unix)))]
        let err = io::Error::from(io::ErrorKind::Unsupported);
        Err(err)
    });
    assert!(matches!(result, Err(LocalError::Unsupported)));
    assert!(!final_path.exists());
    assert_eq!(fs::read_dir(root).unwrap().count(), 0);
}

#[cfg(any(unix, windows))]
#[test]
fn ancestor_swapped_to_symlink_or_junction_stops_copy() {
    let Tree(root) = &Tree::new();
    let picked = create_child_dir_exclusive(root, "picked").unwrap();
    let nested = create_child_dir_exclusive(&picked, "nested").unwrap();
    let outside = create_child_dir_exclusive(root, "outside").unwrap();
    let outside_nested = create_child_dir_exclusive(&outside, "nested").unwrap();
    fs::write(outside_nested.join("sentinel"), b"outside").unwrap();
    // On Windows a filesystem can prevent moving a directory with an open
    // child; exercise the pre-staging check there, and also commit on Unix.
    #[cfg(unix)]
    let part = {
        let mut part = stage_file(&nested).unwrap();
        part.write_all(b"download").unwrap();
        part
    };
    let moved = root.join("moved");
    fs::rename(&picked, &moved).unwrap();
    if !link_or_skip(&outside, &picked, true) {
        fs::rename(&moved, &picked).unwrap();
        return;
    }
    assert!(matches!(stage_file(&nested), Err(LocalError::Conflict)));
    #[cfg(unix)]
    assert!(matches!(part.commit_no_replace(&nested.join("selected")), Err(LocalError::Conflict)));
    assert_eq!(fs::read_dir(moved.join("nested")).unwrap().count(), 0);
    assert_eq!(fs::read(outside_nested.join("sentinel")).unwrap(), b"outside");
    assert_eq!(fs::read_dir(outside_nested).unwrap().count(), 1);
}

#[test]
fn save_snapshot_refuses_modified_regular_file() {
    let Tree(root) = &Tree::new();
    let path = root.join("selected");
    fs::write(&path, b"old").unwrap();
    let target = FileTarget::from_save_dialog(path.clone()).unwrap();
    let mut part = target.stage().unwrap();
    part.write_all(b"download").unwrap();
    fs::write(&path, b"edited during transfer").unwrap();
    assert!(matches!(target.commit(part), Err(LocalError::Conflict)));
    assert_eq!(fs::read(path).unwrap(), b"edited during transfer");
    assert_eq!(fs::read_dir(root).unwrap().count(), 1);
}
