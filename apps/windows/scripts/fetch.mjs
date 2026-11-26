// Gather what Relay for Windows ships with, each piece checked before it's used:
//
//   vendor/win32-x64/engine/   whisper.cpp's Windows server, pinned to the build we tested
//                              (its checksum), plus Microsoft's Visual C++ runtime DLLs taken
//                              from Microsoft's own installer (each must be signed by Microsoft)
//                              — so the speech engine runs even on a PC that never installed them
//   models/                    the bundled "Fast" speech model (Hugging Face's checksum)
//
// Needs `cabextract` (brew install cabextract) to unpack Microsoft's installer.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const work = path.join(tmpdir(), 'relay-windows-fetch');
const engineDir = path.join(root, 'vendor', 'win32-x64', 'engine');
const modelsDir = path.join(root, 'models');

const ENGINE = {
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
  sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
  // the server and what it loads — the CPU backends cover every x64 chip from SSE4.2 to Alder Lake
  keep: (name) => /^(whisper-server\.exe|whisper\.dll|ggml\.dll|ggml-base\.dll|ggml-cpu-[\w]+\.dll)$/i.test(name),
};
const VC_REDIST = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
const VC_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll'];
const MODEL = {
  file: 'ggml-small-q5_1.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
  sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
};

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function fetchTo(url, dest) {
  if (!existsSync(dest) || statSync(dest).size === 0) {
    console.log(`  downloading ${url.split('/').pop()}`);
    execFileSync('curl', ['-fsSL', '--retry', '3', '-o', dest, url], { stdio: 'inherit' });
  }
}

/** Who signed a Windows binary (its Authenticode certificate), via openssl. */
function signer(file) {
  const d = readFileSync(file);
  const pe = d.readUInt32LE(0x3c);
  const opt = pe + 24;
  const dirs = opt + (d.readUInt16LE(opt) === 0x20b ? 112 : 96);
  const off = d.readUInt32LE(dirs + 4 * 8);
  const size = d.readUInt32LE(dirs + 4 * 8 + 4);
  if (!off || !size) return 'unsigned';
  const certs = execFileSync('openssl', ['pkcs7', '-inform', 'DER', '-print_certs', '-noout'], { input: d.subarray(off + 8, off + size) }).toString();
  return certs.includes('O=Microsoft Corporation') ? 'Microsoft Corporation' : 'someone else';
}

mkdirSync(work, { recursive: true });

// 1. the speech engine
const zip = path.join(work, 'whisper-bin-x64.zip');
fetchTo(ENGINE.url, zip);
if ((await sha256(zip)) !== ENGINE.sha256) throw new Error('the whisper.cpp download isn’t the build Relay was tested with');
rmSync(engineDir, { recursive: true, force: true });
mkdirSync(engineDir, { recursive: true });
const unzipped = path.join(work, 'engine');
rmSync(unzipped, { recursive: true, force: true });
execFileSync('unzip', ['-q', '-o', zip, '-d', unzipped]);
const release = path.join(unzipped, 'Release');
for (const name of readdirSync(release).filter(ENGINE.keep)) copyFileSync(path.join(release, name), path.join(engineDir, name));

// 2. Microsoft's runtime, beside the engine
const redist = path.join(work, 'vc_redist.x64.exe');
fetchTo(VC_REDIST, redist);
const outer = path.join(work, 'redist-outer');
const inner = path.join(work, 'redist-inner');
for (const d of [outer, inner]) {
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d);
}
execFileSync('cabextract', ['-q', '-d', outer, redist]);
for (const f of readdirSync(outer)) {
  try {
    execFileSync('cabextract', ['-q', '-d', inner, path.join(outer, f)], { stdio: 'ignore' });
  } catch {
    /* not every piece is a cabinet */
  }
}
for (const dll of VC_DLLS) {
  const from = path.join(inner, `${dll}_amd64`);
  if (!existsSync(from)) throw new Error(`Microsoft's installer had no ${dll}`);
  if (signer(from) !== 'Microsoft Corporation') throw new Error(`${dll} isn't signed by Microsoft`);
  copyFileSync(from, path.join(engineDir, dll));
}
console.log(`  engine: ${readdirSync(engineDir).length} files in ${path.relative(process.cwd(), engineDir)}`);

// 3. the bundled model
mkdirSync(modelsDir, { recursive: true });
const model = path.join(modelsDir, MODEL.file);
fetchTo(MODEL.url, model);
if ((await sha256(model)) !== MODEL.sha256) {
  rmSync(model);
  throw new Error('the speech model download was damaged — run this again');
}
console.log(`  model: ${MODEL.file} (${Math.round(statSync(model).size / 1e6)} MB, checksum ok)`);
