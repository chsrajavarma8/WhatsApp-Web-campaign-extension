// Builds the loadable extension into dist/ and a store-ready zip into release/.
// No dependencies. Usage: npm run build   (or: node scripts/build.mjs)
//
//   dist/                                  -> chrome://extensions → Load unpacked
//   release/wa-campaign-sender-<ver>.zip   -> Chrome Web Store upload
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, extname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const releaseDir = join(root, 'release');

/** What ships in the extension. Everything else (tests, scripts, docs, package.json) stays out. */
const INCLUDE_DIRS = ['ui', 'icons'];
const INCLUDE_ROOT_EXT = new Set(['.js', '.html', '.css', '.json']);
const EXCLUDE_ROOT = new Set(['package.json', 'package-lock.json']);
const ALLOWED_EXT = new Set(['.js', '.html', '.css', '.json', '.png', '.svg']);

const toPosix = (p) => p.split('\\').join('/');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function collectFiles() {
  const files = [];
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (statSync(full).isFile() && INCLUDE_ROOT_EXT.has(extname(name)) && !EXCLUDE_ROOT.has(name)) files.push(full);
  }
  for (const d of INCLUDE_DIRS) files.push(...walk(join(root, d)).filter((f) => ALLOWED_EXT.has(extname(f))));
  return files.map((f) => toPosix(relative(root, f))).sort();
}

/** Verifies every file referenced by the manifest, HTML pages and JS imports is in the build. */
function validate(files) {
  const have = new Set(files);
  const problems = [];
  const need = (path, from) => {
    if (!have.has(path)) problems.push(`${from} references missing file: ${path}`);
  };

  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
  need(manifest.background.service_worker, 'manifest.background');
  need(manifest.action.default_popup, 'manifest.action');
  Object.values(manifest.icons).forEach((p) => need(p, 'manifest.icons'));
  Object.values(manifest.action.default_icon).forEach((p) => need(p, 'manifest.action.default_icon'));
  manifest.content_scripts.forEach((cs) => cs.js.forEach((p) => need(p, 'manifest.content_scripts')));

  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    const base = posix.dirname(file);
    if (file.endsWith('.html')) {
      for (const m of text.matchAll(/(?:src|href)="([^"#:]+)"/g)) need(posix.normalize(posix.join(base, m[1])), file);
    }
    if (file.endsWith('.js')) {
      for (const m of text.matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
        need(posix.normalize(posix.join(base, m[1])), file);
      }
      for (const m of text.matchAll(/chrome\.runtime\.getURL\(`([^`$]+)/g)) need(m[1], file);
    }
  }
  return problems;
}

/* ---------------- minimal zip writer (deflate) ---------------- */

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/* ---------------- build ---------------- */

const files = collectFiles();
const problems = validate(files);
if (problems.length) {
  console.error('Build failed:\n  ' + problems.join('\n  '));
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
for (const file of files) {
  const target = join(dist, file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, file), target);
}

const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
mkdirSync(releaseDir, { recursive: true });
const zipPath = join(releaseDir, `wa-campaign-sender-${version}.zip`);
writeFileSync(zipPath, zip(files.map((name) => ({ name, data: readFileSync(join(root, name)) }))));

const size = files.reduce((n, f) => n + statSync(join(root, f)).size, 0);
console.log(`dist/ ready: ${files.length} files, ${(size / 1024).toFixed(1)} KB`);
console.log(`zip:  ${toPosix(relative(root, zipPath))} (${(statSync(zipPath).size / 1024).toFixed(1)} KB)`);
console.log('\nLoad in Chrome: chrome://extensions → Developer mode → Load unpacked → select the "dist" folder');
if (!existsSync(join(dist, 'manifest.json'))) process.exit(1);
