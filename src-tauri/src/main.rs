#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod config;
mod pty;
mod secrets;
mod sftp;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyState::default())
        .manage(ai::AiState::default())
        .manage(sftp::SftpState::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_all,
            sftp::sftp_disconnect_all,
            pty::list_shells,
            pty::find_program,
            config::get_settings,
            config::save_settings,
            config::get_sessions,
            config::save_sessions,
            config::load_shell_history,
            ai::ai_chat,
            ai::ai_cancel,
            ai::ai_oneshot,
            secrets::secret_set,
            secrets::secret_delete,
            secrets::secret_exists,
            sftp::sftp_connect,
            sftp::sftp_disconnect,
            sftp::sftp_list,
            sftp::sftp_canonicalize,
            sftp::sftp_mkdir,
            sftp::sftp_rename,
            sftp::sftp_remove,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_open,
            sftp::reveal_local,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Moxie");
}
