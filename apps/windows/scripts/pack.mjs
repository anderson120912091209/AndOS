// Package Relay for Windows (64-bit Intel/AMD) as a zip you can send: unzip, double-click
// Relay.exe. Builds from a Mac — @electron/packager writes the Windows icon and file details
// itself, no Windows machine needed. Run `node scripts/fetch.mjs` once first.

import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const electronVersion = pkg.devDependencies.electron;
const engine = path.join(root, 'vendor', 'win32-x64', 'engine');
const models = path.join(root, 'models');
const release = path.join(root, 'release');

for (const need of [path.join(engine, 'whisper-server.exe'), path.join(engine, 'vcruntime140.dll'), path.join(models, 'ggml-small-q5_1.bin')]) {
  if (!existsSync(need)) throw new Error(`missing ${path.relative(root, need)} — run: node scripts/fetch.mjs`);
}

// 1. a fresh build
execFileSync('node', [path.join(here, 'build.mjs')], { stdio: 'inherit' });

// 2. a clean app folder: the build, and the keyboard hook with only its Windows binary
const stage = path.join(tmpdir(), 'relay-windows-stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify({ name: 'relay', productName: 'Relay', version, description: 'Relay — hold Ctrl + Win and talk', main: 'dist/main.cjs', author: 'Relay' }, null, 2),
);
cpSync(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
const hook = path.join(root, 'node_modules', 'uiohook-napi');
const hookTo = path.join(stage, 'node_modules', 'uiohook-napi');
for (const part of ['package.json', 'dist', path.join('prebuilds', 'win32-x64')]) {
  cpSync(path.join(hook, part), path.join(hookTo, part), { recursive: true });
}
const gypBuild = path.dirname(execFileSync('node', ['-e', "process.stdout.write(require.resolve('node-gyp-build/package.json'))"], { cwd: hook }).toString());
cpSync(gypBuild, path.join(stage, 'node_modules', 'node-gyp-build'), { recursive: true });

// 3. Windows app: Relay.exe with the engine and the model beside it in resources/
const out = path.join(tmpdir(), 'relay-windows-out');
rmSync(out, { recursive: true, force: true });
const [appDir] = await packager({
  dir: stage,
  out,
  platform: 'win32',
  arch: 'x64',
  electronVersion,
  name: 'Relay',
  executableName: 'Relay',
  appVersion: version,
  buildVersion: version,
  icon: path.join(root, 'dist', 'assets', 'relay.ico'),
  asar: false, // plain files: the native keyboard hook and its loader find each other without tricks
  prune: false,
  overwrite: true,
  extraResource: [engine, models],
  appCopyright: 'Relay',
  win32metadata: { CompanyName: 'Relay', FileDescription: 'Relay — dictation', ProductName: 'Relay', InternalName: 'Relay' },
});

// 4. a note for whoever opens the zip, then the zip itself
cpSync(path.join(root, 'START HERE.txt'), path.join(appDir, 'START HERE.txt'));
const folder = path.join(out, 'Relay');
rmSync(folder, { recursive: true, force: true });
renameSync(appDir, folder);
mkdirSync(release, { recursive: true });
const zip = path.join(release, `Relay-Windows-x64-${version}.zip`);
rmSync(zip, { force: true });
execFileSync('zip', ['-r', '-X', '-q', '-9', zip, 'Relay'], { cwd: out });
const sha = createHash('sha256').update(readFileSync(zip)).digest('hex');
writeFileSync(`${zip}.sha256`, `${sha}  ${path.basename(zip)}\n`);

const mb = (p) => `${Math.round(statSync(p).size / 1e6)} MB`;
console.log(`✓ ${path.relative(process.cwd(), zip)} (${mb(zip)})`);
console.log(`  Relay/ holds ${readdirSync(folder).length} items · engine: ${readdirSync(path.join(folder, 'resources', 'engine')).length} files`);
console.log(`  sha256 ${sha}`);
