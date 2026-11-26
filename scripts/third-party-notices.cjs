// Collects the license text of every third-party package that ends up in the app, into public/THIRD-PARTY-NOTICES.txt.
// MIT, Apache, ISC and BSD licenses all require the notice to travel with the software. Help shows this file.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// build and test tools never reach the installed app
const TOOLING = /^(concurrently|cross-env|electron-builder|vite|@vitejs\/plugin-react|wait-on|typescript|@types\/.*|rolldown)$/;
const roots = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((n) => !TOOLING.test(n));

/** Find a package folder the way Node would, starting from the folder of the package that needs it. */
function locate(name, from) {
  let dir = from;
  for (;;) {
    const p = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(p, 'package.json'))) return p;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const seen = new Map();
function visit(name, from) {
  const dir = locate(name, from);
  if (!dir) return;
  const real = fs.realpathSync(dir);
  if (seen.has(real)) return;
  const j = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8'));
  seen.set(real, { name: j.name, version: j.version, license: typeof j.license === 'string' ? j.license : j.license?.type || (j.licenses || []).map((l) => l.type).join(' OR ') || 'see package', dir: real, repo: typeof j.repository === 'string' ? j.repository : j.repository?.url || '' });
  for (const dep of Object.keys(j.dependencies || {})) visit(dep, real);
  for (const dep of Object.keys(j.optionalDependencies || {})) visit(dep, real);
}
for (const r of roots) visit(r, root);

const out = [];
out.push('THIRD-PARTY NOTICES', '', 'PweDeF includes the open-source packages below. Each is used under its own license, reproduced here.', '');
const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
for (const p of list) {
  out.push('='.repeat(78), `${p.name} ${p.version}`, `License: ${p.license}`, p.repo ? `Source: ${p.repo.replace(/^git\+/, '')}` : '', '');
  const files = fs.readdirSync(p.dir).filter((f) => /^(licen[sc]e|copying|notice)/i.test(f) && fs.statSync(path.join(p.dir, f)).isFile());
  if (!files.length) out.push('(No license file is included in the package. The license named above applies.)');
  for (const f of files) out.push(fs.readFileSync(path.join(p.dir, f), 'utf8').trim(), '');
}
fs.mkdirSync(path.join(root, 'public'), { recursive: true });
fs.writeFileSync(path.join(root, 'public', 'THIRD-PARTY-NOTICES.txt'), out.join('\n'), 'utf8');
console.log(`third-party notices: ${list.length} packages`);
