// Speech models. "Fast" ships inside the app, so it works the moment it's unzipped; "More
// accurate" (the same model Relay uses on the Mac) is a download, checked byte for byte before
// it's used. Both understand English, Hindi and ~100 other languages, and a mix of them.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export type ModelId = 'fast' | 'accurate';

export interface ModelInfo {
  id: ModelId;
  file: string;
  bytes: number;
  sha256: string;
  label: string;
}

export const MODELS: Record<ModelId, ModelInfo> = {
  fast: {
    id: 'fast',
    file: 'ggml-small-q5_1.bin',
    bytes: 190_085_487,
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
    label: 'Fast',
  },
  accurate: {
    id: 'accurate',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    bytes: 574_041_195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    label: 'More accurate',
  },
};

export const modelUrl = (m: ModelInfo) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${m.file}`;

export async function present(file: string, bytes: number): Promise<boolean> {
  try {
    return (await stat(file)).size === bytes;
  } catch {
    return false;
  }
}

/** Download to `<dest>.part`, check the SHA-256, then move it into place. */
export async function download(
  m: ModelInfo,
  dest: string,
  onProgress: (fraction: number) => void,
  http: typeof fetch = fetch,
): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const res = await http(modelUrl(m));
  if (!res.ok || !res.body) throw new Error(`the download didn't start (${res.status})`);
  const hash = createHash('sha256');
  const out = createWriteStream(part);
  let got = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
      onProgress(Math.min(1, got / m.bytes));
    }
    await new Promise<void>((resolve, reject) => {
      out.once('error', reject);
      out.end(() => resolve());
    });
  } catch (err) {
    out.destroy();
    await rm(part, { force: true });
    throw err;
  }
  if (hash.digest('hex') !== m.sha256) {
    await rm(part, { force: true });
    throw new Error('the download was damaged — try again');
  }
  await rename(part, dest);
}
