// Build Relay for Windows into dist/: the app (Node side) and its two pages, bundled with esbuild,
// plus Windows icons made from the Mac app's icon so Relay looks the same on both.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const dist = path.join(root, 'dist');
const src = path.join(root, 'src');

rmSync(dist, { recursive: true, force: true });
mkdirSync(path.join(dist, 'assets'), { recursive: true });

const common = { bundle: true, logLevel: 'warning', legalComments: 'none' };
await Promise.all([
  // The app itself: Electron's Node side. uiohook-napi is a native module, loaded at run time.
  build({ ...common, entryPoints: [path.join(src, 'main.ts')], outfile: path.join(dist, 'main.cjs'), platform: 'node', format: 'cjs', target: 'node22', external: ['electron', 'uiohook-napi'] }),
  build({ ...common, entryPoints: [path.join(src, 'preload.ts')], outfile: path.join(dist, 'preload.cjs'), platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] }),
  // The pages: plain browser scripts.
  build({ ...common, entryPoints: [path.join(src, 'recorder.ts')], outfile: path.join(dist, 'recorder.js'), platform: 'browser', format: 'iife', target: 'chrome130' }),
  build({ ...common, entryPoints: [path.join(src, 'hud.ts')], outfile: path.join(dist, 'hud.js'), platform: 'browser', format: 'iife', target: 'chrome130' }),
]);
for (const f of ['hud.html', 'hud.css', 'recorder.html', 'capture-worklet.js']) copyFileSync(path.join(src, f), path.join(dist, f));

// --- icons: the Mac app's artwork, as Windows .ico files -------------------------------------

/** An .ico holding PNG images (Windows Vista and later read PNG entries at every size). */
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e); // 0 means 256
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2); // no palette
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4); // colour planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

const icns = path.join(root, '..', 'mac', 'Resources', 'AppIcon.icns');
if (existsSync(icns) && process.platform === 'darwin') {
  const work = path.join(tmpdir(), 'relay-windows-icon');
  rmSync(work, { recursive: true, force: true });
  execFileSync('iconutil', ['-c', 'iconset', icns, '-o', path.join(work, 'AppIcon.iconset')]);
  const set = path.join(work, 'AppIcon.iconset');
  const png = (size) => {
    const out = path.join(work, `${size}.png`);
    execFileSync('sips', ['-z', String(size), String(size), path.join(set, 'icon_512x512.png'), '--out', out], { stdio: 'ignore' });
    return { size, data: readFileSync(out) };
  };
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256].map(png);
  writeFileSync(path.join(dist, 'assets', 'relay.ico'), ico(sizes));
  writeFileSync(path.join(dist, 'assets', 'tray.ico'), ico(sizes.filter((p) => p.size <= 64)));
  copyFileSync(path.join(set, 'icon_16x16@2x.png'), path.join(dist, 'assets', 'tray.png'));
} else {
  console.warn('  (no icon tools here — keeping the default icons)');
}

console.log(`built ${path.relative(process.cwd(), dist)}`);
