# Medallion PR - Development Guidelines

## After each functionality change

1. Bump the patch version in `manifest.json` (e.g. `1.0.0` → `1.0.1`)
2. Set `APP_VERSION` in `background.js` to match the manifest version string
3. Commit the changes
