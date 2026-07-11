use std::path::PathBuf;
use std::process::Command;

fn main() {
  ensure_mcp_sidecar();
  tauri_build::build()
}

fn ensure_mcp_sidecar() {
  let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set"));
  let project_root = manifest_dir.parent().expect("src-tauri must have a parent directory");
  println!("cargo:rerun-if-changed={}", project_root.join("scripts/build-mcp-sidecar.mjs").display());
  println!("cargo:rerun-if-changed={}", project_root.join("mcp-server/src/index.ts").display());
  println!("cargo:rerun-if-changed={}", project_root.join("mcp-server/package.json").display());

  let status = Command::new("bun")
    .arg("scripts/build-mcp-sidecar.mjs")
    .current_dir(project_root)
    .status()
    .expect("failed to run bun to build MCP sidecar");

  if !status.success() {
    panic!("failed to build MCP sidecar");
  }
}
