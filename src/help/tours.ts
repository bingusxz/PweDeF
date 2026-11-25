// Guided tours. Each step points at a real part of the screen by CSS selector; a step with no target is a centred note.
export interface TourStep {
  target?: string;
  title: string;
  text: string;
}

export const HOME_TOUR: TourStep[] = [
  { title: 'Welcome to PweDeF', text: 'A short tour of the home screen: 5 quick stops. You can skip it any time with Esc, and take it again from Help.' },
  { target: '.home-actions .primary', title: 'Open a PDF', text: 'Click here to choose a file, or just drag a PDF anywhere onto the window.' },
  { target: '.start', title: 'Start here', text: 'The jobs people do most: edit a PDF, sign, merge files, and turn a PDF into Word.' },
  { target: '.hub .form-set', title: 'All the tools', text: 'Everything else, grouped by what you are doing. Look for the NEW stamps: Compare, Form designer and Digital signature.' },
  { target: '.filing-log', title: 'Your recent files', text: 'PDFs you open are listed here, so you can reopen them in one click.' },
  { target: '.help-btn', title: 'Help is always here', text: 'Click the ? (or press F1) for step-by-step guides, shortcuts and the terms of use.' },
];

export const EDITOR_TOUR: TourStep[] = [
  { target: '.editor .toolbar', title: 'The toolbar', text: 'Edit text, add text, highlight, draw shapes, sign and stamp. Hover over any icon to see its name and shortcut key.' },
  { target: '.editor .contextbar', title: 'Tool options', text: 'This bar changes with the tool you pick: colours, thickness, fonts, form field settings and tips for what to do next.' },
  { target: '.editor .rail', title: 'Pages, Search and Comments', text: 'Use Pages to reorder, rotate or delete pages. Search finds words in the document.' },
  { target: '.editor button[title^="Save"]', title: 'Save', text: 'Press Ctrl+S to save. Use Save As to keep the original file untouched.' },
  { title: 'All tools', text: 'The "All tools" menu at the top right has the rest: split, redact, watermark, optimize, OCR, export to Word, digital signature and more.' },
];
