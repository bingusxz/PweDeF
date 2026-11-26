// Terms of Use shown on first run and in Help. Plain-language draft for a personal project.
// Change TERMS_VERSION whenever the text changes, and everyone is asked to accept again.
export const TERMS_VERSION = '2026-11c';
export const AUTHOR = 'Dean';
export const PROJECT_URL = 'https://github.com/bingusxz/PweDeF';

export interface TermsSection {
  title: string;
  body: string[];
}

export const TERMS: TermsSection[] = [
  {
    title: '1. What PweDeF is',
    body: [
      `PweDeF is a free PDF tool created by ${AUTHOR} as a personal project. It lets you edit, sign, convert, combine and organize PDF files on your own computer.`,
      'By clicking "I accept" you agree to these terms. If you do not agree, click "Decline" and the app will close.',
    ],
  },
  {
    title: '2. How you may use it',
    body: [
      'Use PweDeF for your own lawful work, and only on documents you are allowed to handle.',
      'Do not use it to create false, misleading or unlawful documents, or to alter a document in a way that deceives someone.',
      'The source code is published so people can see how the app works, but it still belongs to its author. You may not copy, change, share or sell the code or the app without the author\'s written permission. See the LICENSE file on the project page.',
    ],
  },
  {
    title: '3. Your documents and your privacy',
    body: [
      'Your files are opened, edited and converted on this computer. PweDeF does not upload your documents anywhere, and it does not collect usage statistics or track what you do.',
      "A few things do use the internet, only when you use them: checking for and downloading app updates (from the project's releases on GitHub); downloading the language data for OCR in languages other than English and Filipino; and \"Web page to PDF\", which loads the web address you type; and Report a problem, which sends the message you wrote (and, if you leave it ticked, the technical details shown on the form) to the developer only when you press Send.",
      'Word, Excel and PowerPoint to PDF use Microsoft Office or LibreOffice installed on this computer.',
      "PweDeF keeps a list of recently opened files, your saved signatures and stamps, and your settings on this computer only, in the app's own storage for your Windows account.",
    ],
  },
  {
    title: '4. You check the results',
    body: [
      'PweDeF is a tool, and you are responsible for the documents you produce with it. Always look over the result before you send, print, sign or file it.',
      'Redaction: after redacting, open the saved file and search for the words you removed to make sure they are gone before you share it. Redaction cannot be undone once the file is saved and the original is gone.',
      'OCR (text recognition) and conversions to Word, Excel and PowerPoint can contain mistakes or differ from the original layout. Check important numbers and names.',
      'Digital signatures: whether a signature has legal effect depends on the law and on the certificate used. A certificate you make yourself is not confirmed by a trusted authority, and other programs will show the signer as "not verified". Editing a signed file after signing breaks the signature.',
    ],
  },
  {
    title: '5. Keep your own copies',
    body: [
      'Keep a copy of important original files before you change them. PweDeF saves your edits to the files you choose; it cannot recover a file you overwrite or delete.',
    ],
  },
  {
    title: '6. No warranty',
    body: [
      `PweDeF is free and is provided as it is, without any promise that it is free of errors or that it suits every purpose. To the extent the law allows, ${AUTHOR} and the contributors are not responsible for losses caused by using it, such as lost files, wrong output or missed deadlines.`,
    ],
  },
  {
    title: '7. Updates and changes to these terms',
    body: [
      'PweDeF updates itself in the background and asks you to restart when an update is ready. If these terms change, you will be asked to accept them again.',
    ],
  },
  {
    title: '8. Other software inside PweDeF',
    body: ['PweDeF includes open-source components used under their own licenses. They are listed, with their full license texts, under Help, "Open-source licenses".'],
  },
  {
    title: '9. Questions and problems',
    body: [`For questions, bug reports or ideas, use the project page: ${PROJECT_URL}`],
  },
];

export interface LicenseEntry {
  name: string;
  what: string;
  license: string;
}

export const LICENSES: LicenseEntry[] = [
  { name: 'pdf.js', what: 'Reads and shows PDF pages', license: 'Apache-2.0' },
  { name: 'pdf-lib and fontkit', what: 'Writes and changes PDF files', license: 'MIT' },
  { name: 'Tesseract OCR (tesseract.js)', what: 'Text recognition engine', license: 'Apache-2.0' },
  { name: 'Tesseract English and Filipino language data', what: 'OCR language models', license: 'MIT / Apache-2.0' },
  { name: 'node-forge', what: 'Digital signature cryptography', license: 'BSD-3-Clause (dual-licensed with GPL-2.0; used under BSD-3-Clause)' },
  { name: 'docx', what: 'Creates Word files', license: 'MIT' },
  { name: 'ExcelJS', what: 'Creates Excel files', license: 'MIT' },
  { name: 'PptxGenJS', what: 'Creates PowerPoint files', license: 'MIT' },
  { name: 'React', what: 'App interface', license: 'MIT' },
  { name: 'Electron', what: 'Desktop app shell', license: 'MIT' },
  { name: 'electron-updater', what: 'Automatic updates', license: 'MIT' },
  { name: 'Lucide icons', what: 'Icons', license: 'ISC' },
  { name: 'Barlow Condensed and Courier Prime fonts', what: 'Headings and typewriter text', license: 'SIL Open Font License 1.1' },
];
