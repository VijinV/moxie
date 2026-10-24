# Starts Moxie in dev mode. Adds cargo to PATH in case this shell predates the Rust install.
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
Set-Location (Join-Path $PSScriptRoot "..")
npm run tauri dev
