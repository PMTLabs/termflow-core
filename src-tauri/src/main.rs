// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // Velopack startup hook MUST run before anything else (it may relaunch/exit
  // the process to service an install/update). Compiled out unless the
  // `velopack-updates` feature is enabled (GitHub distribution builds only).
  #[cfg(feature = "velopack-updates")]
  app_lib::updater::run_startup_hook();

  app_lib::run();
}
