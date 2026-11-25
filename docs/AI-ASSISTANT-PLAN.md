# AI assistant: plan (not built yet)

The goal is a side panel where staff can ask a PDF questions and have it do the busywork. This is where Acrobatics can go well beyond Acrobat.

## What it should do (by priority)

1. **Ask the document**, e.g. "What's the total on this invoice?" or "When does this contract expire?". Answers cite the page and highlight the source text.
2. **Summarize** a long PDF (supplier agreement, policy, report) into key points, deadlines and amounts.
3. **Extract to Excel**: pull line items, prices and SKUs from invoices, POs and delivery receipts into rows, even from messy layouts. This beats the rule-based PDF → Excel.
4. **Smart form fill**: "Fill this form using my details / this other PDF". The model proposes values and the user reviews before applying.
5. **Batch AI**: run one of the actions above across a folder (for example, extract totals from 200 invoices into one sheet).
6. **Smart redact**: "Redact all customer phone numbers and addresses". The model finds them; the user confirms; the existing true-redaction engine applies them.
7. **Compare**: "What changed between v1 and v2 of this contract?"

## Architecture

```
UI side panel ──IPC──► main process ──HTTPS──► Claude API
     │                      │
     │  page text + images   │  holds the API key (never in the UI)
     ▼                      ▼
 existing engine:  pdf.js text, OCR text, page renders, bake/redact/form APIs
```

- **Model**: Claude via the Anthropic API. Use a fast, low-cost model for chat and extraction, and the most capable model for long or complex documents.
- **Input**: send extracted text with page numbers. For scans, use OCR text, or page images, since the model can read images directly. Large PDFs are chunked per page with a page index.
- **Tool use**: expose the app's own engine as tools the model can call, such as `search_text`, `get_page_text`, `highlight(page, rects)`, `mark_redaction(page, rects)`, `set_form_field(name, value)`, `export_table(rows)`. The model proposes; **the user always approves** before the document changes, and every change goes on the normal undo stack.
- **Key handling**: an API key per organization, stored with Windows DPAPI (`safeStorage` in Electron) and used only in the main process. A proxy server option lets IT keep the key off desktops entirely.
- **Privacy**: an admin setting can disable AI or restrict it to non-confidential docs. Show clearly when content is sent. Use prompt caching for repeated questions on the same document.

## Effort estimate

| Phase | Scope | Size |
|---|---|---|
| 1 | Side panel chat, ask and summarize with page citations | ~1–2 weeks |
| 2 | Extract to Excel plus batch extraction | ~1 week |
| 3 | Tool use: highlight, redact and form fill with approval UI | ~2 weeks |
| 4 | Compare, admin controls, proxy | ~1–2 weeks |

## Open decisions for MF

- Who pays and manages the API account, and what's the monthly budget cap?
- Are any document types (HR, payroll, customer IDs) off-limits for AI?
- Is a central proxy wanted, or a key per installation?
