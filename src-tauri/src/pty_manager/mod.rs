mod cwd;
mod procinfo;
mod profiles;
mod spawn;
mod spawn_spec;

pub(crate) use cwd::exit_cwd_for;
pub use cwd::{get_process_cwd, get_process_cwd_with, parse_osc_cwd};
pub use procinfo::{
    command_line_for, detect_agent, foreground_command_lines, get_foreground_agent,
    get_foreground_agent_with_exe, get_foreground_process_info, session_at_bare_prompt,
};
pub use profiles::{
    add_custom_profile, delete_custom_profile, get_available_shells, get_profile,
    load_custom_profiles, save_custom_profiles, update_custom_profile, ProfilesConfig,
    ShellProfile,
};
pub use spawn::{kill_process_tree, spawn_terminal};
pub use spawn_spec::{
    build_spawn_spec, shell_emits_prompt_osc, FOREIGN_TERMINAL_ENV, HOST_CONTROL_ENV,
};
