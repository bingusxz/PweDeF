// Bundles the engine test for Node. Browser-only modules (Vite ?url imports) stay external.
export default {
  input: 'tests/engine.test.ts',
  platform: 'node',
  external: (id) => /^(pdf-lib|@pdf-lib\/fontkit|exceljs|docx|jszip|tesseract\.js|pdfjs-dist|node:fs)(\/|$)/.test(id) || id.includes('?url') || /[\\/]src[\\/]lib[\\/]pdf(\.ts)?$/.test(id) || id === './pdf',
  output: { file: '.test-out/engine.mjs', format: 'esm', codeSplitting: false },
};


