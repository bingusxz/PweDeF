/** Shown once, in a small card, the first time the app opens after an update. Newest first. Add an entry for every release. */
export type Release = { version: string; title: string; items: string[] };

export const RELEASES: Release[] = [
  {
    version: '1.2.4',
    title: 'Updated terms and license information',
    items: [
      'The terms of use were updated to make clear that PweDeF is free to use but the code is not free to copy or resell. You will be asked to accept them once.',
      'Help, Open-source licenses can now show the full license text of every component the app uses.',
    ],
  },
  {
    version: '1.2.3',
    title: 'Report a problem',
    items: [
      'New in Help: Report a problem. Tell the developer what went wrong or what you would like, and it is sent straight to them.',
      'Your PDF is never attached. You see exactly what will be sent before you press Send.',
      'Everything from 1.2.2 is included: double page view, portrait or landscape for conversions, and names under signatures.',
    ],
  },
  {
    version: '1.2.2',
    title: 'Double page view and better Excel to PDF',
    items: [
      'Double view: switch from Single to Double at the bottom right to see two pages side by side. Zoom and editing work as usual.',
      'Signatures can print your name and date under them. It is placed and saved as one item.',
      'Word, Excel, images and HTML or text to PDF now ask for portrait or landscape.',
      'A new option fits all columns on the page width, so wide sheets are no longer cut off.',
      'This card is now a taped paper slip.',
    ],
  },
  {
    version: '1.2.1',
    title: 'Fixes the 1.2.0 start-up error, plus everything new in 1.2.0',
    items: [
      'Fixes the error that stopped PweDeF from opening after the 1.2.0 update.',
      'Print with Ctrl+P or the printer button.',
      'Open and save password-protected PDFs.',
      'Crop pages, put several pages on one sheet, make booklets, add headers and footers.',
      'Bookmarks and attached files panels.',
      'Edit form fields that are already in a PDF, and countersign a PDF that is already signed.',
      'Redact now removes only the covered words and keeps the rest of the page editable.',
      'Save as PDF/A for archiving.',
      'Italic text is detected and kept when you edit a line.',
      'A file that is open in another program no longer fails to save: you are offered a copy.',
    ],
  },
];

const KEY = 'pwedef.lastSeenVersion';

/** The release notes to show for this version, or null (first install, or already seen). Remembers the version. */
export function whatsNewFor(version: string): Release | null {
  if (!version) return null;
  let seen: string | null = null;
  try {
    seen = localStorage.getItem(KEY);
    localStorage.setItem(KEY, version);
  } catch {
    return null;
  }
  if (!seen || seen === version) return null;
  return RELEASES.find((r) => r.version === version) ?? null;
}
