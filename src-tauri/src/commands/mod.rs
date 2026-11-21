//! Tauri `#[tauri::command]` entry points, split by domain (see the module list
//! below). `lib.rs` names every handler as `commands::<name>`; the `pub use`
//! re-exports below keep every one of those paths resolving unchanged, so this
//! split needed no edits to `lib.rs`'s `tauri::generate_handler![...]` list.

mod ssh_fs;
pub mod ssh_session;
pub(crate) mod ssh_launch;
pub(crate) use ssh_launch::*;
pub use ssh_fs::{ssh_fs_download, __cmd__ssh_fs_download, __tauri_command_name_ssh_fs_download};
pub use ssh_fs::{
    ssh_fs_download, __cmd__ssh_fs_download, __tauri_command_name_ssh_fs_download,
    ssh_fs_open, __cmd__ssh_fs_open, __tauri_command_name_ssh_fs_open,
    ssh_fs_open_with, __cmd__ssh_fs_open_with, __tauri_command_name_ssh_fs_open_with,
    ssh_fs_edit_stop, __cmd__ssh_fs_edit_stop, __tauri_command_name_ssh_fs_edit_stop,
    ssh_fs_edit_list, __cmd__ssh_fs_edit_list, __tauri_command_name_ssh_fs_edit_list,
};
pub use ssh_fs::*;
pub use ssh_session::*;
mod config_history;
mod drag;
mod menu;
mod snippets;
pub mod ssh_store;
mod system;
mod terminal;
mod panes;
pub(crate) mod permissions;
mod update;
mod window;

pub use config_history::*;
pub use drag::*;
pub use menu::*;
pub use snippets::*;
pub use ssh_store::*;
pub use system::*;
pub use terminal::*;
pub(crate) use panes::*;
pub use permissions::*;
pub use update::*;
pub use window::*;
