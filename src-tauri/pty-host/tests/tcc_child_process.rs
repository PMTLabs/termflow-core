#![cfg(feature = "tcc-test-fixtures")]
use std::process::Command;

#[test]
fn fake_child_exits_with_one_json_line_without_socket_or_record() {
    let dir = std::env::temp_dir().join(format!(
        "tf-tcc-child-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    std::fs::create_dir(&dir).unwrap();
    for mode in ["status", "request-sc"] {
        let result = Command::new(env!("CARGO_BIN_EXE_tcc-test-child"))
            .args(["--tcc", mode])
            .env("TERMFLOW_PTY_PIPE", dir.join("socket"))
            .env("TERMFLOW_PTY_RECORD", dir.join("record"))
            .output()
            .unwrap();
        assert!(result.status.success());
        assert!(result.stderr.is_empty());
        let text = std::str::from_utf8(&result.stdout).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(text.ends_with('\n'));
        let json: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(
            json["screen_recording"],
            if mode == "status" {
                "NotGranted"
            } else {
                "Granted"
            }
        );
        assert!(!dir.join("socket").exists());
        assert!(!dir.join("record").exists());
    }
    std::fs::remove_dir(dir).unwrap();
}
