# Publishing Checklist

Use this before creating a public repository, GitHub release, or Obsidian community plugin submission.

## Source Contents

- Keep source code, scripts, workflow files, `README.md`, `LICENSE`, `manifest.json`, `versions.json`, package metadata, TypeScript config, and source CSS.
- Do not commit generated `main.js`; build it for release assets only.
- Do not commit `node_modules`, `dist`, local Obsidian vaults, test PDFs, exported annotation JSON, screenshots, downloaded images, or archives.

## Sensitive Information

- Search for local paths such as `C:\Users`, `OneDrive`, `Desktop`, vault names, usernames, and machine-specific paths.
- Search for credentials and auth material such as API keys, tokens, cookies, private keys, passwords, connection strings, and bearer tokens.
- Search for time, location, device, and environment details that do not need to be public.
- Check Git history, not only the current working tree.

## Copyright And Data

- Remove third-party PDFs, screenshots, book scans, movie stills, downloaded images, and sample vault data unless the license is clear and intentionally documented.
- Keep dependency code out of the repository; publish dependency names and lockfiles instead.
- Keep generated release archives out of source control.

## Release Assets

- Build with `npm run build`.
- Package or upload only:
  - `manifest.json`
  - `main.js`
  - `styles.css`
- Ensure the GitHub release tag exactly matches `manifest.json` and `versions.json`.
