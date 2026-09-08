//! Tauri `#[tauri::command]` entry points, split by domain (see the module list
//! below). `lib.rs` names every handler as `commands::<name>`; the `pub use`
//! re-exports below keep every one of those paths resolving unchanged, so this
//! split needed no edits to `lib.rs`'s `tauri::generate_handler![...]` list.

mod config_history;
mod drag;
mod menu;
mod snippets;
mod system;
mod terminal;
mod update;
mod window;

pub use config_history::*;
pub use drag::*;
pub use menu::*;
pub use snippets::*;
pub use system::*;
pub use terminal::*;
pub use update::*;
pub use window::*;
