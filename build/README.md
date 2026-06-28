# Build resources (electron-builder)

This folder is electron-builder's `buildResources` directory.

## App icon (optional)

Drop an icon here to brand the installer and the .exe:

- **Windows:** `build/icon.ico` (256×256, multi-resolution `.ico`)
- macOS: `build/icon.icns`
- Linux: `build/icon.png` (512×512)

electron-builder picks these up automatically. Without them it uses the default
Electron icon — fine for personal use.

## Code signing (optional)

The Windows installer is unsigned by default, so SmartScreen may show a
"unknown publisher" warning on first run — expected for a personal build. To
sign it, add an Authenticode certificate to the `win` build config
(`certificateFile` + `CSC_KEY_PASSWORD`), or use an EV/Azure Trusted Signing
setup. Not required for personal, non-commercial use.
