/** Shown once, in a small card, the first time the app opens after an update. Newest first. Add an entry for every release. */
export type Release = { version: string; title: string; items: string[] };

export const RELEASES: Release[] = [
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
