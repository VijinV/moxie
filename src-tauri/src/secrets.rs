//! SSH passwords. Remembered ones go to the OS credential store (Windows Credential Manager,
//! macOS Keychain, Secret Service on Linux); "don't remember" ones live in memory until exit.
//! Passwords never travel back to the webview: the backend uses them directly for
//! SSH auto-login and SFTP.

use std::collections::HashMap;
use std::sync::Mutex;

const SERVICE: &str = "moxie-ssh";

static MEMORY: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

pub fn get(key: &str) -> Option<String> {
    if let Some(p) = MEMORY.lock().unwrap().as_ref().and_then(|m| m.get(key).cloned()) {
        return Some(p);
    }
    keyring::Entry::new(SERVICE, key).ok()?.get_password().ok()
}

#[tauri::command]
pub fn secret_set(key: String, value: String, persist: bool) -> Result<(), String> {
    MEMORY.lock().unwrap().get_or_insert_with(HashMap::new).insert(key.clone(), value.clone());
    let entry = keyring::Entry::new(SERVICE, &key).map_err(|e| e.to_string())?;
    if persist {
        entry.set_password(&value).map_err(|e| format!("could not save to credential store: {e}"))
    } else {
        let _ = entry.delete_credential();
        Ok(())
    }
}

#[tauri::command]
pub fn secret_delete(key: String) {
    if let Some(m) = MEMORY.lock().unwrap().as_mut() {
        m.remove(&key);
    }
    if let Ok(entry) = keyring::Entry::new(SERVICE, &key) {
        let _ = entry.delete_credential();
    }
}

#[tauri::command]
pub fn secret_exists(key: String) -> bool {
    get(&key).is_some()
}
