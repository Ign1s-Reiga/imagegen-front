//! API keys live in the OS credential store (Windows Credential Manager,
//! macOS Keychain, Secret Service on Linux), never in the settings file.

use keyring::Entry;

use crate::error::Result;

const SERVICE: &str = "io.imagegen.desktop";

fn entry(key: &str) -> Result<Entry> {
    Ok(Entry::new(SERVICE, key)?)
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<()> {
    entry(&key)?.set_password(&value)?;
    Ok(())
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>> {
    match entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<()> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.into()),
    }
}
