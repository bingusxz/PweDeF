# Acrobatics

**An all-in-one PDF studio for Windows, built in-house.** You can edit, sign, convert, organize, redact and OCR PDFs. It's free per seat, needs no Adobe account, and updates itself from GitHub.

Acrobatics is a clean-room application built on open-source engines (Mozilla **pdf.js** for rendering and **pdf-lib** for writing PDFs). It uses no Adobe code and follows the public PDF standard (ISO 32000).

## What it does

| Area | Features |
|---|---|
| **Edit** | Edit existing text (click any line), add text boxes, whiteout, images, shapes, freehand, arrows. Undo/redo throughout. |
| **Sign** | Draw, type (cursive fonts) or upload a signature, plus initials. Saved signatures are reused. "Sign here" fields fill with one click. Stamps (APPROVED, PAID, RECEIVED…) with name and date. |
| **Forms** | Fill text fields, checkboxes, radios and dropdowns directly on the page. Flatten on export. |
| **Review** | Highlight, underline, strikethrough and sticky-note comments (saved as real PDF comments). Search with "highlight all". |
| **Redact** | True redaction: marked pages are rebuilt so the hidden content is gone. You can also search and redact every match. |
| **Organize** | Thumbnails with drag-to-reorder, rotate, delete, duplicate, extract, insert blank pages or other PDFs, merge and split. |
| **Convert to PDF** | Word, Excel, PowerPoint (via Microsoft Office, or LibreOffice if Office isn't installed), images, web pages (URL), HTML, text and Markdown. |
| **Convert from PDF** | Word (.docx: editable or exact-look), Excel (.xlsx: rows and columns rebuilt), PowerPoint (.pptx), PNG/JPG, plain text. |
| **Finish** | Watermark, page numbers and Bates numbering, document properties, optimize, flatten. |
| **Scan** | OCR (English, Filipino and more) makes scanned PDFs searchable and selectable. |
| **Batch** | Run watermark, numbering, rotate, flatten, optimize or set author across many files, optionally merging the results. |

Tabs, drag-and-drop, recent files, keyboard shortcuts (V, H, E, T, W, I, U, S, N, D, R, O, L, A, X, plus Ctrl+S, Ctrl+Z, Ctrl+F and Ctrl+wheel zoom), and "Open with → Acrobatics" from Explorer are all supported.

## Develop

```bash
npm install          # also downloads Electron (approved in package.json → allowScripts)
npm run dev          # Vite + Electron with hot reload
npm run test:engine  # headless tests for the PDF engine (edit, forms, page ops, exporters)
npm run dist         # build the Windows installer into release/
```

If Electron complains its binary is missing, run `node node_modules/electron/install.js`.

### Layout

```
electron/main.cjs      window, file dialogs, IPC, auto-update
electron/preload.cjs   the only bridge between UI and OS (no Node in the UI)
electron/convert.cjs   Office/LibreOffice → PDF, web/HTML → PDF
src/lib/               the engine: bake.ts (write edits), ops.ts (pages), redact.ts, ocr.ts, exporters.ts…
src/components/        React UI: Editor, PageView, Thumbnails, ToolHub, dialogs
tests/engine.test.ts   headless engine tests
```

## Releasing updates (automatic)

**Every push to `main` ships an update.** You don't need to bump the version by hand.

1. Push to `main`.
2. The **Release** workflow type-checks, builds and tests. If anything fails, nothing is released.
3. It stamps the version as `major.minor.<build number>` (for example `0.1.7`) and publishes `Acrobatics-Setup-0.1.7.exe` to **[bingusxz/acrobatics-releases](https://github.com/bingusxz/acrobatics-releases/releases)**.
4. Every installed Acrobatics checks hourly (and on launch), downloads in the background, and shows **"Restart to update"**. Staff can also click **Check for updates** on the home screen.

Pushes that only change `.md` files or `docs/` don't release. To start a new line (for example 0.2.x), change `version` in `package.json`.

### Why two repos

| Repo | Visibility | Contains |
|---|---|---|
| `bingusxz/acrobatics` | **private** | source code |
| `bingusxz/acrobatics-releases` | public | installers only (what the auto-updater downloads) |

The app reads updates from the public releases repo, so it needs no token. A token embedded in the app could be extracted and used against the private repo.

### One-time setup

1. Create the **public** repo `bingusxz/acrobatics-releases` and tick "Add a README" so it isn't empty.
2. Create a **fine-grained personal access token** (GitHub → Settings → Developer settings → Fine-grained tokens):
   - Repository access: only `bingusxz/acrobatics-releases`
   - Permissions: **Contents: Read and write**
3. In `bingusxz/acrobatics` → Settings → Secrets and variables → Actions, add a secret named **`RELEASES_TOKEN`** with that token.
4. Make `bingusxz/acrobatics` **private** (Settings → General → Danger Zone → Change visibility).

Until `RELEASES_TOKEN` exists, pushes still build and test but don't publish. The workflow shows a warning.

**First install:** download `Acrobatics-Setup-*.exe` from the releases repo. After that it updates itself.
The installer isn't code-signed yet, so Windows SmartScreen will warn on first run. See the roadmap.

See [`docs/ROADMAP.md`](docs/ROADMAP.md) and [`docs/AI-ASSISTANT-PLAN.md`](docs/AI-ASSISTANT-PLAN.md).
