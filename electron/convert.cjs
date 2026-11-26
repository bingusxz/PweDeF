// Office <-> PDF conversion and web page -> PDF.
// Strategy: Microsoft Office (best fidelity, via COM) -> LibreOffice (free fallback) -> clear error.
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BrowserWindow } = require('electron');

const KIND_BY_EXT = {
  doc: 'word', docx: 'word', docm: 'word', rtf: 'word', odt: 'word', txt: 'word', wpd: 'word',
  xls: 'excel', xlsx: 'excel', xlsm: 'excel', csv: 'excel', ods: 'excel',
  ppt: 'ppt', pptx: 'ppt', pps: 'ppt', ppsx: 'ppt', odp: 'ppt',
};

const OFFICE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$in = $env:ACRO_IN; $out = $env:ACRO_OUT; $kind = $env:ACRO_KIND
switch ($kind) {
  'word' {
    $app = New-Object -ComObject Word.Application
    $app.Visible = $false; $app.DisplayAlerts = 0
    try {
      $d = $app.Documents.Open($in, $false, $true, $false)
      $o = $env:ACRO_ORIENT
      if ($o -eq 'portrait' -or $o -eq 'landscape') {
        $v = if ($o -eq 'landscape') { 1 } else { 0 }
        foreach ($s in $d.Sections) { try { $s.PageSetup.Orientation = $v } catch { } }
      }
      $d.ExportAsFixedFormat($out, 17); $d.Close(0)
    }
    finally { $app.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
  }
  'excel' {
    $app = New-Object -ComObject Excel.Application
    $app.Visible = $false; $app.DisplayAlerts = $false
    try {
      $wb = $app.Workbooks.Open($in, 0, $true)
      $orient = $env:ACRO_ORIENT; $fit = $env:ACRO_FIT
      if ($orient -or $fit -eq '1') {
        foreach ($ws in $wb.Worksheets) {
          try {
            $ps = $ws.PageSetup
            if ($orient -eq 'landscape') { $ps.Orientation = 2 }
            elseif ($orient -eq 'portrait') { $ps.Orientation = 1 }
            elseif ($orient -eq 'auto') {
              # wide sheets go landscape, tall narrow ones stay portrait
              $w = $ws.UsedRange.Width; $h = $ws.UsedRange.Height
              if ($w -gt 520 -and $w -ge $h * 0.6) { $ps.Orientation = 2 } else { $ps.Orientation = 1 }
            }
            if ($fit -eq '1') { $ps.Zoom = $false; $ps.FitToPagesWide = 1; $ps.FitToPagesTall = $false }
          } catch { }
        }
      }
      $wb.ExportAsFixedFormat(0, $out); $wb.Close($false)
    }
    finally { $app.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
  }
  'ppt' {
    $app = New-Object -ComObject PowerPoint.Application
    try { $p = $app.Presentations.Open($in, -1, 0, 0); $p.SaveAs($out, 32); $p.Close() }
    finally { $app.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
  }
}
`;

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 240000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').toString().trim().split('\n').slice(-3).join(' ')));
      else resolve(stdout);
    });
  });
}

async function viaOffice(kind, input, output, opts = {}) {
  if (process.platform !== 'win32') throw new Error('Microsoft Office automation is Windows-only');
  const encoded = Buffer.from(OFFICE_SCRIPT, 'utf16le').toString('base64');
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    env: { ...process.env, ACRO_IN: input, ACRO_OUT: output, ACRO_KIND: kind, ACRO_ORIENT: ['auto', 'portrait', 'landscape'].includes(opts.orientation) ? opts.orientation : '', ACRO_FIT: opts.fitWidth ? '1' : '' },
  });
  if (!fss.existsSync(output)) throw new Error('Office did not produce an output file');
}

function findSoffice() {
  const candidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/usr/bin/soffice',
    '/usr/local/bin/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ];
  return candidates.find((c) => fss.existsSync(c)) || null;
}

async function viaLibreOffice(input, outDir, target = 'pdf') {
  const soffice = findSoffice();
  if (!soffice) throw new Error('LibreOffice not installed');
  await run(soffice, ['--headless', '--norestore', '--convert-to', target, '--outdir', outDir, input]);
  const base = path.basename(input).replace(/\.[^.]+$/, '');
  const ext = target.split(':')[0];
  const out = path.join(outDir, `${base}.${ext}`);
  if (!fss.existsSync(out)) throw new Error('LibreOffice did not produce an output file');
  return out;
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pwedef-'));
}

/** Convert an Office/text document at `input` to PDF bytes. */
async function officeToPdf(input, opts = {}) {
  const ext = path.extname(input).slice(1).toLowerCase();
  const kind = KIND_BY_EXT[ext];
  if (!kind) throw new Error(`Unsupported file type: .${ext}`);
  const dir = await tempDir();
  const out = path.join(dir, path.basename(input).replace(/\.[^.]+$/, '') + '.pdf');
  const errors = [];
  try {
    try {
      await viaOffice(kind, input, out, opts);
    } catch (e) {
      errors.push('Microsoft Office: ' + e.message);
      try {
        await viaLibreOffice(input, dir, 'pdf');
      } catch (e2) {
        errors.push('LibreOffice: ' + e2.message);
        throw new Error(
          'No converter available. Install Microsoft Office or the free LibreOffice (libreoffice.org) on this PC.\n' + errors.join('\n'),
        );
      }
    }
    return new Uint8Array(await fs.readFile(out));
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Render a web page (URL or local .html) to PDF with Chromium. */
async function webToPdf(target, opts = {}) {
  let url = target;
  if (!/^https?:\/\//i.test(url)) {
    if (fss.existsSync(url)) url = require('node:url').pathToFileURL(url).toString();
    else if (/^[\w.-]+\.[a-z]{2,}/i.test(url)) url = 'https://' + url;
    else throw new Error('Enter a web address (https://…) or choose an HTML file');
  }
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
  });
  try {
    await win.loadURL(url);
    await new Promise((r) => setTimeout(r, 1500)); // let lazy content settle
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      landscape: !!opts.landscape,
      pageSize: opts.pageSize || 'A4',
      margins: { marginType: 'default' },
    });
    const title = (win.webContents.getTitle() || 'webpage').replace(/[<>:"/\\|?*]+/g, '_').slice(0, 80);
    return { name: `${title}.pdf`, data: new Uint8Array(pdf) };
  } finally {
    win.destroy();
  }
}

/** Render HTML string (used for text/markdown -> PDF). */
async function htmlToPdf(html, name, opts = {}) {
  const dir = await tempDir();
  const file = path.join(dir, 'doc.html');
  await fs.writeFile(file, html, 'utf8');
  try {
    const res = await webToPdf(file, { landscape: !!opts.landscape });
    return { name, data: res.data };
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function capabilities() {
  let office = false;
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('node:child_process');
      execFileSync('reg', ['query', 'HKCR\\Word.Application'], { windowsHide: true, stdio: 'ignore' });
      office = true;
    } catch {
      office = false;
    }
  }
  return { office, libreoffice: !!findSoffice() };
}

module.exports = { officeToPdf, webToPdf, htmlToPdf, capabilities, KIND_BY_EXT };
