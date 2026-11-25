// Help center text. Plain steps, one topic per job. Keep it in step with what the tools really do.
export interface HelpTopic {
  id: string;
  group: string;
  title: string;
  intro?: string;
  steps?: string[];
  tips?: string[];
}

export const HELP: HelpTopic[] = [
  {
    id: 'start',
    group: 'Getting started',
    title: 'Quick start',
    intro: 'PweDeF edits, signs, converts and organizes PDFs on your own computer. Nothing is uploaded.',
    steps: [
      'Click Open PDF, or drag a PDF anywhere onto the window.',
      'Use the toolbar to edit text, add notes, draw, highlight or sign.',
      'Press Ctrl+S to save, or use Save As to keep the original untouched.',
      'Come back to the home screen any time by clicking the PweDeF logo. All the tools are listed there.',
    ],
    tips: ['Starting from the home screen: the "Start here" cards cover the most common jobs.', 'The Filing log on the right reopens recent files in one click.'],
  },
  {
    id: 'edit-text',
    group: 'Editing',
    title: 'Edit text in a PDF',
    steps: ['Open the PDF and choose Edit text (E) in the toolbar.', 'Click any word or line. It gets an outline: type to change it.', 'Press Esc or click elsewhere to finish, then save.'],
    tips: ['The original words are removed from the page and the new text uses the same font and size where possible.', 'No outlines appear? The page is a scan. Run Recognize text (OCR) first.', 'Add brand-new text with the Add text tool (T).'],
  },
  {
    id: 'markup',
    group: 'Editing',
    title: 'Highlight, draw and add notes',
    steps: ['Pick Highlight, Underline or Strikethrough, then select text.', 'Use Draw, Rectangle, Ellipse, Line or Arrow for shapes. Hold Shift for straight lines, squares and circles.', 'Click a shape to select it: change its colour and thickness, drag to move, use the corner to resize.', 'Esc returns to the Select tool.'],
  },
  {
    id: 'images',
    group: 'Editing',
    title: 'Insert an image',
    steps: ['Click the picture icon in the toolbar (Insert image).', 'Choose a JPG or PNG.', 'Click on the page where it should go. Drag or resize it afterwards.'],
    tips: ['Very large photos are shrunk automatically so the PDF does not become huge.'],
  },
  {
    id: 'sign',
    group: 'Signing',
    title: 'Sign and stamp',
    steps: ['Click Sign in the toolbar.', 'Choose Draw, Type or Image to make a signature, or pick it from Saved.', 'Click on the page to place it. Drag to move, use the corner to resize.', 'Stamps (the stamp icon): pick a set such as Accounting or Purchasing, choose what prints under it (name, date, time), then click to place.'],
    tips: ['"My stamps" keeps stamps you designed on this computer.'],
  },
  {
    id: 'digital',
    group: 'Signing',
    title: 'Digital signature with a certificate',
    intro: 'A digital signature proves who signed and that the file has not changed since. It is saved as a new copy.',
    steps: ['Open the PDF and choose All tools, then Sign with a certificate. (Or use Digital signature on the home screen.)', 'Choose your .pfx certificate file and type its password.', 'Add a reason if you like. Keep "Show a signature box" ticked to draw where it appears.', 'Draw the box on the page. Choose where to save the signed copy.'],
    tips: ['No certificate? In that window click "Make your own". Other programs will say the signer is "not verified". That is normal for self-made certificates.', 'Sign last. Any edit after signing breaks the signature.', 'A PDF that is already signed cannot be signed again here.', 'To check a file: All tools, then Check signatures.'],
  },
  {
    id: 'redact',
    group: 'Protecting',
    title: 'Redact (remove sensitive content)',
    steps: ['Choose Redact (X) and drag over the words, numbers or pictures to remove. Each gets a red box.', 'Save. On save the marked pages are rebuilt so the content is gone for good.', 'After saving, search the new file for the removed words to be sure.'],
    tips: ['Redaction cannot be undone once saved. Keep the original file safe.', 'Use Whiteout only for looks: it covers content but does not remove it.'],
  },
  {
    id: 'merge',
    group: 'Organizing',
    title: 'Merge PDFs',
    steps: ['Click Merge on the home screen.', 'Add files with "Add files…" or drag them into the window.', 'Drag the rows (or use ↑ ↓) to set the order. Use Sort A–Z if you like.', 'Optional per file: type pages like 1-3, 7 and use the turn button to rotate.', 'Click Merge. The result opens in a new tab.'],
  },
  {
    id: 'split',
    group: 'Organizing',
    title: 'Split a PDF',
    steps: ['Open the PDF and choose All tools, then Split.', 'Pick how: every N pages, page ranges, by file size (e.g. 5 MB for email) or by bookmarks.', 'In Page ranges, tick "Put all ranges in one file" to extract pages instead.', 'Choose a folder. The pieces are saved there.'],
  },
  {
    id: 'pages',
    group: 'Organizing',
    title: 'Organize pages',
    steps: ['Open the Pages panel on the left.', 'Click a page, or Ctrl/Shift-click several.', 'Use the panel buttons to rotate, duplicate, extract, insert a blank page, insert pages from another PDF or delete.', 'Drag thumbnails to reorder.'],
  },
  {
    id: 'optimize',
    group: 'Finishing',
    title: 'Make a PDF smaller (Optimize)',
    steps: ['Choose All tools, then Optimize file size.', 'Pick High quality, Balanced or Smallest.', 'Optimize. A message shows the size before and after.'],
    tips: ['If the file cannot be made smaller, it is left as it is.', 'Scanned black-and-white pages do not shrink much.'],
  },
  {
    id: 'ocr',
    group: 'Finishing',
    title: 'Make scans searchable (OCR)',
    steps: ['Open the scanned PDF and choose All tools, then Recognize text (OCR).', 'Pick the language (English and Filipino work offline).', 'Leave "Accurate", "Straighten" and "Skip pages that already have text" ticked unless the PC is slow.', 'Run OCR. When it finishes, search and copy work on the scan.'],
    tips: ['The message shows how sure the reading was. Under about 65% means a poor read: try a cleaner scan.'],
  },
  {
    id: 'convert-from',
    group: 'Converting',
    title: 'PDF to Word, Excel or PowerPoint',
    steps: ['Open the PDF and choose Export to Word, Excel or PowerPoint.', 'Word: Flowing text for editing, Retain page layout to look like the PDF, or Exact picture.', 'PowerPoint: Editable slides (real text boxes) or Exact picture.', 'Excel: tables become cells, and numbers and dates become real values.'],
    tips: ['A scanned PDF needs OCR first, so there is text to convert.'],
  },
  {
    id: 'convert-to',
    group: 'Converting',
    title: 'Word, Excel, PowerPoint, images or a web page to PDF',
    steps: ['Pick the tool under Convert to PDF on the home screen.', 'Choose the file, or type the web address.', 'The PDF opens in a new tab.'],
    tips: ['Word, Excel and PowerPoint need Microsoft Office or LibreOffice installed on this PC.'],
  },
  {
    id: 'compare',
    group: 'Checking',
    title: 'Compare two PDFs',
    steps: ['Click Compare PDFs. Drop the original and the revised file into the two boxes (or drop both at once).', 'Click Compare.', 'The list shows each changed, added or removed piece. Click one to see it highlighted on both pages.', 'Switch to Visual overlay to see layout, colour and picture differences.'],
  },
  {
    id: 'forms',
    group: 'Forms',
    title: 'Fill a form',
    steps: ['Open the PDF. Fields are live: click and type, tick boxes and pick from lists.', 'Save when you are done.'],
    tips: ['A printed form with no real fields: use the Add text tool and the Check mark tool (K).'],
  },
  {
    id: 'form-designer',
    group: 'Forms',
    title: 'Form designer: make a form fillable',
    steps: ['Choose Form designer (F). Pick a Type in the bar: text, check box, radio button, dropdown, list or signature.', 'Click the page to drop a field, or drag to draw its size.', 'Click a field to set its name, tooltip, choices, required or read-only.', 'Radio buttons placed one after another form a group. Rename the group to start another.', 'Choose All tools, then "Test the form", or Save, to make the fields real.'],
    tips: ['Fields can be edited only until they are saved.'],
  },
  {
    id: 'batch',
    group: 'Finishing',
    title: 'Batch: one action on many files',
    steps: ['Click Batch process.', 'Add the files and the steps (watermark, page numbers, rotate, flatten, optimize, author).', 'Run and choose an output folder. Originals are not changed.'],
  },
  {
    id: 'shortcuts',
    group: 'Reference',
    title: 'Keyboard shortcuts',
    steps: [
      'Ctrl+O: open a PDF',
      'Ctrl+S: save, Ctrl+Shift+S: save as',
      'Ctrl+Z / Ctrl+Y: undo / redo',
      'Ctrl+F: search the document',
      'Ctrl + and Ctrl −: zoom, Ctrl+0: fit width',
      'V select, H pan, E edit text, T add text, M move, W whiteout',
      'D draw, R rectangle, O ellipse, L line, A arrow',
      'X redact, K check mark, N note, F form designer',
      'Esc: back to Select',
      'F1: open Help',
    ],
  },
  {
    id: 'fix',
    group: 'Reference',
    title: 'If something goes wrong',
    steps: [
      'Edit text shows no outlines: the page is a scan. Run OCR first.',
      'A PDF will not open: it may be password-protected. Password-protected files are not supported yet.',
      'The text in a converted Word file is out of place: try "Retain page layout", or "Exact picture".',
      'The app seems slow on a large PDF: close other tabs, and use OCR "Fast" instead of "Accurate".',
      'A signed copy shows "changed after signing": the file was edited after it was signed. Sign again from an unsigned copy.',
      'Still stuck: tell whoever supports PweDeF for you what you clicked and what you saw.',
    ],
  },
];
