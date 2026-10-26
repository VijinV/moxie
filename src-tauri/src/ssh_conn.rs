//! Shared russh connect + auth helpers used by both sftp.rs and monitor.rs.

use russh::client::{self, KeyboardInteractiveAuthResponse};
use russh::keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

// ---------------------------------------------------------------- host-key checking

#[derive(Default)]
pub enum HostKeyIssue {
    #[default]
    None,
    Unknown(String),
    Changed(String),
}

pub struct Client {
    pub host: String,
    pub port: u16,
    pub trust: Option<String>,
    pub issue: Arc<Mutex<HostKeyIssue>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = match server_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => PublicKey::new(cert.public_key().clone(), ""),
        };
        let fp = key.fingerprint(HashAlg::Sha256).to_string();
        match keys::check_known_hosts(&self.host, self.port, &key) {
            Ok(true) => Ok(true),
            Err(keys::Error::KeyChanged { .. }) => {
                *self.issue.lock().unwrap() = HostKeyIssue::Changed(fp);
                Ok(false)
            }
            _ if self.trust.as_deref() == Some(fp.as_str()) => {
                let _ = keys::known_hosts::learn_known_hosts(&self.host, self.port, &key);
                Ok(true)
            }
            _ => {
                *self.issue.lock().unwrap() = HostKeyIssue::Unknown(fp);
                Ok(false)
            }
        }
    }
}

// ---------------------------------------------------------------- key discovery

pub fn candidate_keys(key_path: &str) -> Vec<PathBuf> {
    if !key_path.trim().is_empty() {
        return vec![PathBuf::from(key_path.trim())];
    }
    let Some(ssh) = dirs::home_dir().map(|h| h.join(".ssh")) else { return vec![] };
    ["id_ed25519", "id_ecdsa", "id_rsa"].iter().map(|n| ssh.join(n)).filter(|p| p.exists()).collect()
}

// ---------------------------------------------------------------- authentication

pub async fn authenticate(
    handle: &mut client::Handle<Client>,
    user: &str,
    key_path: &str,
    password: Option<&str>,
) -> Result<bool, russh::Error> {
    for path in candidate_keys(key_path) {
        let key = keys::load_secret_key(&path, None).or_else(|_| match password {
            Some(p) => keys::load_secret_key(&path, Some(p)),
            None => Err(keys::Error::CouldNotReadKey),
        });
        let Ok(key) = key else { continue };
        let hash = handle.best_supported_rsa_hash().await?.flatten();
        if handle.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await?.success() {
            return Ok(true);
        }
    }

    let Some(pw) = password else { return Ok(false) };
    if handle.authenticate_password(user, pw).await?.success() {
        return Ok(true);
    }
    let mut resp = handle.authenticate_keyboard_interactive_start(user, None).await?;
    for _ in 0..5 {
        match resp {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let answers = prompts.iter().map(|_| pw.to_string()).collect();
                resp = handle.authenticate_keyboard_interactive_respond(answers).await?;
            }
        }
    }
    Ok(false)
}

// ---------------------------------------------------------------- connect

/// Opens a russh handle (no channel yet). Returns Err with HOSTKEY_*/AUTH_* prefixes.
pub async fn connect(
    host: &str,
    port: u16,
    user: &str,
    key_path: &str,
    password: Option<&str>,
    trust: Option<String>,
    known_host_alias: Option<&str>,
) -> Result<client::Handle<Client>, String> {
    let issue = Arc::new(Mutex::new(HostKeyIssue::None));
    let (kh_host, kh_port) = match known_host_alias.filter(|a| !a.is_empty()) {
        Some(alias) => (alias.to_string(), 22),
        None => (host.to_string(), port),
    };
    let handler = Client { host: kh_host, port: kh_port, trust, issue: issue.clone() };
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    });

    let mut handle = match tokio::time::timeout(
        Duration::from_secs(20),
        client::connect(config, (host, port), handler),
    )
    .await
    {
        Err(_) => return Err(format!("timed out connecting to {host}:{port}")),
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            return Err(match std::mem::take(&mut *issue.lock().unwrap()) {
                HostKeyIssue::Unknown(fp) => format!("HOSTKEY_UNKNOWN:{fp}"),
                HostKeyIssue::Changed(fp) => format!("HOSTKEY_CHANGED:{fp}"),
                HostKeyIssue::None => format!("could not connect to {host}:{port}: {e}"),
            })
        }
    };

    let user = if user.trim().is_empty() {
        std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_else(|_| "root".into())
    } else {
        user.to_string()
    };
    let ok = authenticate(&mut handle, &user, key_path, password).await.map_err(|e| format!("auth error: {e}"))?;
    if !ok {
        return Err(if password.is_some() { "AUTH_FAILED".into() } else { "AUTH_NEED_PASSWORD".into() });
    }
    Ok(handle)
}
