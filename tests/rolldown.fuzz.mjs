// Bundles the line-edit bug hunt for Node.
export default {
  input: 'tests/linefuzz.ts',
  platform: 'node',
  external: (id) => /^(pdf-lib|@pdf-lib\/fontkit|exceljs|docx|jszip|tesseract\.js|pdfjs-dist|node:fs)(\/|$)/.test(id) || id.includes('?url') || /[\\/]src[\\/]lib[\\/]pdf(\.ts)?$/.test(id) || id === './pdf',
  output: { file: '.test-out/linefuzz.mjs', format: 'esm', codeSplitting: false },
};
