# PweDeF

**An all-in-one PDF studio for Windows, created by Dean.** Edit, sign, fill, convert, organize, protect, redact, print and OCR PDFs in one app. It is free, needs no Adobe account, works offline, and updates itself from GitHub.

PweDeF is a clean-room application built on open-source engines: Mozilla **pdf.js** draws and reads pages, **pdf-lib** writes PDFs, **node-forge** does the cryptography, **Tesseract** does OCR. It contains no Adobe code and follows the public PDF standard (ISO 32000).

- [What it does](#what-it-does)
- [Install and update](#install-and-update)
- [A tour of the tools](#a-tour-of-the-tools)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [How it handles your files](#how-it-handles-your-files)
- [Known limits](#known-limits)
- [Develop](#develop)
- [Project layout](#project-layout)
- [Testing](#testing)
- [Releasing](#releasing)
- [Roadmap and notes](#roadmap-and-notes)

## What it does

| Area | Features |
|---|---|
| **Edit** | Click any line of existing text to retype it (font, size, colour, bold and italic are matched), add text boxes, whiteout, images, shapes, freehand and arrows. Undo and redo throughout. |
| **Sign** | Draw, type (cursive fonts) or upload a signature, plus initials. Saved signatures are reused. "Sign here" fields fill with one click. Stamps (APPROVED, PAID, RECEIVED and more) with name, date and time. Real certificate-based digital signatures, including countersigning an already signed PDF. |
| **Forms** | Fill text fields, checkboxes, radios and dropdowns on the page. The Form designer turns any PDF into a fillable form, and edits fields that already exist. Flatten on export. |
| **Review** | Highlight, underline, strikethrough and sticky-note comments saved as real PDF comments. Search with "highlight all". Compare two PDFs. |
| **Redact** | Draw a box or search and redact every match. Only the covered words are removed and the rest of the page stays editable text. Pages with pictures under a box are rebuilt as a picture instead. Removed content is deleted from the saved file, not just hidden. |
| **Organize** | Thumbnails with drag-to-reorder, rotate, delete, duplicate, extract, insert blank pages or other PDFs, merge and split. |
| **Protect** | Open password-protected PDFs and save with a password and permissions (AES-256). |
| **Layout** | Crop pages, put several pages on one sheet (n-up), make folded booklets, add headers and footers with page tokens. |
| **Navigate** | Bookmarks panel (add, rename, reorder) and an attached-files panel (add, save out, remove). |
| **Convert to PDF** | Word, Excel, PowerPoint (through Microsoft Office, or LibreOffice if Office is not installed), images, web pages by URL, HTML, text and Markdown. |
| **Convert from PDF** | Word (.docx, editable or exact look), Excel (.xlsx, with rows and columns rebuilt, also for tables without borders), PowerPoint (.pptx), PNG or JPG, plain text. |
| **Finish** | Watermark, page numbers and Bates numbering, document properties, optimize, flatten, PDF/A archive copy. |
| **Scan** | OCR (English, Filipino and more, fully offline) makes scanned PDFs searchable and selectable. |
| **Batch** | Run watermark, numbering, rotate, flatten, optimize or set author across many files, optionally merging the results. |
| **Print** | Ctrl+P or the printer button. Pages keep their own size. |

Also: tabs, drag and drop from Explorer, recent files, light and dark themes, a built-in help centre and tour, "Open with PweDeF" from Explorer, and a "What's new" card after each update.

## Install and update

1. Open the [Releases](https://github.com/bingusxz/PweDeF/releases) page and download `PweDeF-Setup-x.y.z.exe` from the newest release.
2. Run it. Windows SmartScreen may warn on the first run because the installer is not code-signed yet (see [`docs/CODE-SIGNING.md`](docs/CODE-SIGNING.md)). Choose **More info**, then **Run anyway**.
3. From then on PweDeF checks for updates on launch and every hour, downloads in the background, and shows **Restart to update**. **Check for updates** is also on the home screen and in Help, About.

If an update ever breaks the app so badly that it cannot start, it also cannot update itself. Run the newest installer once over the top. Settings and files are kept.

## A tour of the tools

Everything lives in the toolbar or in the **All tools** menu, which is grouped by job.

### Editing text
Choose **Edit text** (E) and click a line. The font is looked up among the fonts installed on the PC so the new text matches. Bold and italic are detected, including italic that comes from a slanted upright font. When no italic face is installed the text is slanted instead. Lines that are edited are pushed along so following words are not overlapped.

### Signing and stamping
**Sign** keeps your signatures and initials. Click a spot to place one, drag to move, drag a corner to resize. **Stamp** places APPROVED, PAID and similar marks with your name, date and time. **Digital signature** signs with a certificate (.pfx). You can make a self-signed one in the app. A PDF that is already signed gets a new revision appended, so the first signature stays valid.

### Forms
Click a field and type. The **Form designer** adds text boxes, checkboxes, radios and dropdowns to any page. In the designer you can click a field that is already in the PDF to rename it, change its type or delete it. Untouched fields are left exactly as they were.

### Redaction
Draw boxes, or search for text and redact every match, then save. PweDeF first tries the careful way: it cuts only the covered words out of the page, paints a black box, and checks the saved file again to prove the words are gone. If a picture, shading, many drawn shapes, a comment or a form field sits under a box, or the text cannot be cut cleanly, that page is rebuilt as a picture with a hidden text layer instead. After saving, the message says how many pages were rebuilt. Metadata, bookmarks and attachments that could leak the covered text are cleared, and unreachable objects are removed from the file.

### Passwords
Opening a protected file asks for the password (a wrong one is rejected and you can try again). **Protect** sets a user password, an owner password and permissions for printing, copying, editing and so on, saved as AES-256. The password is applied when you press Save. Supported on open: RC4 40 and 128 bit, AES 128 and AES 256.

### Pages and layout
Drag thumbnails to reorder, right-click for rotate, delete, duplicate and extract. **Crop** sets a crop box with a live preview and works on rotated pages. **Sheets** makes 2, 4, 6 or 9 pages per sheet, or a booklet in the right print order, on A4, Letter, Legal or A3. **Headers and footers** support tokens for page number, total pages, file name and date.

### Bookmarks and attachments
The side panels list the outline and the files inside the PDF. Add, rename, delete and reorder bookmarks. Attached files can be saved out or removed. A removed file is really deleted from the PDF.

### PDF/A
**Save as PDF/A** prepares an archive copy: XMP metadata, a colour profile, output intent, and removal of scripts, attachments and hidden annotations. A report lists what was fixed and what could not be (for example fonts that are not embedded). It has not been checked with a validator such as veraPDF yet, so treat it as "prepared for", not "certified".

### Converting
Word, Excel and PowerPoint to PDF use the Microsoft Office on the PC, with LibreOffice as a fallback. PDF to Word keeps real tables, and Excel export rebuilds rows and columns, including tables that have no ruling lines.

### OCR
Runs entirely offline. Pick the language, run it, and the scan becomes searchable and selectable. Large scans take a while on a slow PC.

### Printing
Pages are drawn as 200 dpi pictures and sent to the Windows print box, so printed text is sharp but not selectable on paper.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| V, H, E, T, W, I, U, S, N, D, R, O, L, A, X | Select, Hand, Edit text, Text, Whiteout, Image, Underline, Sign, Note, Draw, Rectangle, Oval, Line, Arrow, Redact |
| Ctrl+O | Open |
| Ctrl+S, Ctrl+Shift+S | Save, Save as |
| Ctrl+P | Print |
| Ctrl+Z, Ctrl+Y | Undo, Redo |
| Ctrl+F | Search |
| Ctrl+wheel, Ctrl+plus, Ctrl+minus | Zoom |
| Ctrl+W, Ctrl+Tab | Close tab, next tab |
| Enter or F2 on a selected text box | Edit it |

The full list is in Help, Keyboard shortcuts.

## How it handles your files

- **Everything stays on the PC.** No account, no upload, no tracking. The only network use is checking GitHub for updates (and web pages you ask it to convert).
- **Nothing changes until you save.** Edits are shown on top of the page and baked in when you save.
- **Saving over an open file.** If another program has the PDF open, PweDeF retries for a moment and then offers Save as instead of failing.
- **Deleted means deleted.** Removed pages and redacted content are dropped from the saved file.

## Known limits

- The installer is not code-signed, so SmartScreen warns on first run.
- Windows only. A mobile app and a document scanner mode are planned (see the roadmap).
- PDF/A output is prepared but not validated.
- The password is re-applied on Save, not on every copy you export.
- Very large files (hundreds of pages) and OCR are slow on weak PCs.
- Some Adobe-protected files with cross-reference streams have not been tested.
- The AI assistant is planned only, not built ([`docs/AI-ASSISTANT-PLAN.md`](docs/AI-ASSISTANT-PLAN.md)).

## Develop

Requires Node.js and Windows.

```bash
npm install          # also downloads Electron
npm run dev          # Vite plus Electron with hot reload
npm run typecheck    # TypeScript only
npm run test:engine  # headless tests for the PDF engine
npm run test:fuzz    # line-editing fuzz test
npm run build        # checks the Electron files, then type-checks and builds the UI
npm run dist         # build the Windows installer into release/
```

If Electron complains its binary is missing, run `node node_modules/electron/install.js`.

## Project layout

```
electron/main.cjs      window, file dialogs, IPC, fonts, printing, auto-update
electron/preload.cjs   the only bridge between UI and OS (no Node in the UI)
electron/convert.cjs   Office and LibreOffice to PDF, web and HTML to PDF
src/App.tsx            tabs, home screen, update card, password prompt, What's new
src/components/        React UI: Editor, PageView, Thumbnails, ToolHub, dialogs, panels
src/lib/bake.ts        writes edits into the PDF
src/lib/ops.ts         page operations (merge, split, delete, rotate, ...)
src/lib/redact.ts      careful and picture redaction
src/lib/pdfCrypt.ts    password handling (RC4, AES, R5 and R6)
src/lib/layout.ts      crop, n-up, booklet, headers and footers
src/lib/navdata.ts     bookmarks and attachments
src/lib/incremental.ts appended revisions for countersigning
src/lib/pdfa.ts        PDF/A preparation
src/lib/prune.ts       removes unreachable objects from saved files
src/lib/formFields.ts  form field import and editing
src/lib/pdfLayout.ts   table detection for Word and Excel export
src/help/              help topics, terms, licenses, What's new notes
tests/engine.test.ts   headless engine tests (fixtures in tests/fixtures)
```

## Testing

`npm run test:engine` bundles the engine with rolldown and runs it in Node. It covers text editing, forms, page operations, exporters, encryption (fixtures made with several PDF writers, passwords `user123` and `owner456`), layout, bookmarks, attachments, countersigning, tables, PDF/A and pruning. Real-app checks (opening, dialogs, saving, redaction) were done by launching Electron with `PWEDEF_TEST=1` and driving it over the Chrome DevTools Protocol.

## Releasing

**Every push to `main` that changes code ships an update.**

1. Bump `version` in `package.json`.
2. Add an entry to `src/help/whatsNew.ts`. It becomes the card users see after updating.
3. Push to `main`.
4. The **Release** workflow type-checks, builds and tests. If anything fails, nothing is released.
5. It publishes the Windows installer on the repo's [Releases](https://github.com/bingusxz/PweDeF/releases) page.
6. Installed copies download it in the background and offer **Restart to update**.

Pushes that only change `.md` files or `docs/` do not release. The workflow publishes with GitHub's built-in token, and because the repo is public installed apps download updates without any key.

## Roadmap and notes

- [`docs/ROADMAP.md`](docs/ROADMAP.md): what is done and what is next (mobile, scanner mode, code signing, AI assistant).
- [`docs/CODE-SIGNING.md`](docs/CODE-SIGNING.md): how to get rid of the SmartScreen warning.
- [`docs/AI-ASSISTANT-PLAN.md`](docs/AI-ASSISTANT-PLAN.md): the planned assistant.
- [`docs/HANDOFF.md`](docs/HANDOFF.md): notes for whoever maintains this next.

Created by Dean.
