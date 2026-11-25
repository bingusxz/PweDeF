# PweDeF roadmap

Status of the v0.1 build, and what's left before it matches Acrobat Pro feature for feature.

## Known limitations in v0.1 (honest list)

| Area | Today | Plan |
|---|---|---|
| **Edit existing text** | The original line is covered with white and the new text is written on top in a standard font (Helvetica, Times or Courier, chosen to match). It looks right, but the old words still exist underneath and can be found by copy or search. | Parse the page content stream and delete the original text operators. Reuse the document's embedded font when it has the needed glyphs. This is the biggest remaining gap with Acrobat. |
| **Annotations after save** | Highlights, drawings and so on are flattened into the page when saved. Sticky notes stay as real comments. | Write markup as real PDF annotations (`/Highlight`, `/Ink`, `/FreeText`, …) with appearance streams, so they stay editable in any reader. |
| **Non-Latin text** | Added or edited text supports Western characters (₱ is written as "PHP"). | Embed a Unicode font (for example Noto Sans) with `@pdf-lib/fontkit`. |
| **Password-protected PDFs** | Can't open or edit them. | Add password prompt and decryption, plus "Protect PDF" (AES-256) using qpdf (WASM) or a bundled qpdf binary. |
| **PDF → Word** | Our own converter: editable paragraphs (simplified layout) or an exact-look image mode. | Add a layout-preserving mode with positioned text frames and table detection. Optionally use Word's PDF Reflow; that needs a one-time per-user Office setting, so it's opt-in only. |
| **Optimize** | Lossless re-save only. | Downsample and re-compress images (target dpi and JPEG quality presets). |
| **OCR** | Downloads the language model on first use (needs internet once). | Bundle `eng` and `fil` models in the installer for fully offline use. |
| **Code signing** | The installer is unsigned, so SmartScreen warns. | Buy an OV/EV code-signing certificate and add it to the Release workflow (`CSC_LINK` / `CSC_KEY_PASSWORD` secrets). |

## Next features

- [ ] Compare two PDFs (visual and text diff)
- [ ] Form designer: create fields (text, checkbox, signature) on any PDF
- [ ] Digital signatures (PKCS#7 / certificate-based), not just signature images
- [ ] PDF/A export for archiving
- [ ] Headers and footers with templates; Bates presets per department
- [ ] Crop pages and page boxes; n-up / booklet printing
- [ ] Print dialog with page ranges
- [ ] Remember last-used tool and colors per user
- [ ] Bookmarks / outline panel, attachments panel
- [ ] Light theme
- [ ] AI assistant (see [AI-ASSISTANT-PLAN.md](AI-ASSISTANT-PLAN.md))
