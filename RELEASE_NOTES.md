# OBrowser v1.1.0 — Upload and download progress

## A unified Transfers panel

- Uploads and downloads now appear immediately in one collapsible panel, with file names, source/destination, transferred bytes, percentage, and status.
- Downloads show the selected local save path and follow Electron's actual progress, completion, cancellation and failure events. Single-file, batch and preview downloads all use the same panel.
- Unknown download sizes show received bytes and an indeterminate progress bar. Reaching the expected byte count does not count as success until the download has actually completed.
- Keep browsing or add files while transfers run. Queued uploads retain their original destination even if you change folders or connections.
- Completed, failed and cancelled entries remain visible until you clear them; active transfers cannot be cleared. Transfers are session-only: keep the app open until they finish.

## Large uploads and Unicode downloads

- Local uploads use streaming or multipart transfers instead of reading entire large files into memory. S3, Azure Blob, Aliyun OSS and GCS report real SDK progress.
- Chinese and other Unicode download names use RFC 5987 `filename*`, fixing S3's `400 InvalidArgument: Header value cannot be represented using ISO-8859-1` while preserving the original filename.
- Signed download URLs are still verified before starting a download, so storage errors are not silently saved as file contents.

## Release packaging

- Application packages include runtime files only. Local environment files, development tooling and emulator data are excluded and checked before release.

## Downloads

| Platform | File | Notes |
| :--- | :--- | :--- |
| macOS · Apple silicon | `OBrowser-1.1.0-arm64.dmg` | Signed and notarized |
| macOS · Intel | `OBrowser-1.1.0.dmg` | Signed and notarized |
| macOS · ZIP | `OBrowser-1.1.0-arm64-mac.zip`, `OBrowser-1.1.0-mac.zip` | Same signed and notarized apps |
| Windows · x64 | `OBrowser-1.1.0-x64.zip` | Unpack and run `OBrowser.exe`; unsigned |

Windows SmartScreen may warn because the Windows build is unsigned. No Linux binary is included in this release. SHA-256 checksums are provided in `SHA256SUMS.txt`.

## Verification

Unit and Electron UI tests cover transfer states, Unicode download names, failed preflights, unknown and zero-byte sizes, navigation, and light/dark/minimum-window layouts. An in-process fixture exercises real Chromium downloads, verifies saved bytes and Chinese filenames, and checks native cancellation. These tests do not use real cloud credentials or objects.

Full changelog: https://github.com/zhuermu/obrowser/compare/v1.0.0...v1.1.0
