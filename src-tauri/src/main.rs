#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod bastion;
mod chats;
mod config;
mod monitor;
mod pty;
mod secrets;
mod sftp;
mod ssh_conn;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(pty::PtyState::default())
        .manage(ai::AiState::default())
        .manage(sftp::SftpState::default())
        .manage(bastion::BastionState::default())
        .manage(monitor::MonitorState::default())
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
            config::fs_list,
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
            sftp::sftp_edit,
            sftp::reveal_local,
            sftp::open_url,
            chats::chats_list,
            chats::chat_load,
            chats::chat_save,
            chats::chat_delete,
            bastion::bastion_tunnel_start,
            bastion::bastion_tunnel_stop,
            bastion::bastion_stop_all,
            monitor::get_stats,
            monitor::get_remote_stats,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Moxie")
        .run(|app, event| {
            // Bastion tunnels are separate az processes; don't leave them running after exit.
            if let tauri::RunEvent::Exit = event {
                bastion::stop_all(&app.state::<bastion::BastionState>());
            }
        });
}
