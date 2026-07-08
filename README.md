# GH Internships

Electron app that browses GitHub internship-listing repos, assesses job fit with Claude, and auto-logs applications to Google Sheets. It bundles a Chrome (Manifest V2) extension and a small local HTTP server used to bridge the extension to the OS and filesystem.

## Prerequisites

- Node.js
- Credentials, provided as symlinks in `credentials/` pointing at the sibling `JobApplier` project:
  - `answers.json`, `profile.json`, `resume.pdf` — applicant profile used to seed the extension and auto-fill applications
  - `sheets-config.json`, `sheets-credentials.json` — Google Sheets spreadsheet ID + service account credentials used for logging

  Make sure the underlying files exist at `../JobApplier/credentials/`. If `sheets-config.json`/`sheets-credentials.json` are missing, the app still runs — Sheets logging is just disabled.
- An Anthropic API key, entered into the extension's Settings screen (`GH Internships > Settings…` in the app menu), if you want AI fit-assessment via the API instead of the Claude tab.

## Install

```
npm install
```

## Run

```
npm start
```

This runs `electron .`, which on launch:
- loads the `extension/` folder into Electron's session (no manual "load unpacked" step needed)
- starts the local bridge server on `http://127.0.0.1:3743` (handles physical apply-button clicks and persisting scanned Q&A answers)
- seeds the extension's storage from `credentials/profile.json` and `credentials/answers.json`
- opens tabs for the tracked internship-listing repos, a Claude project tab, and an always-on-top control/assessor panel

## Notes

- The bridge server port (3743) is intentionally different from the sibling `JobApplier` project's (3742) so both apps can run at the same time.
- Use the app menu (`GH Internships > Reload Credentials`) to re-seed the extension after editing files in `credentials/`.
