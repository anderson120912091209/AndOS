// Files Piko hands to users (screenshots, charts, PDFs, videos). LINE can't carry files itself; it shows
// images and opens links, so each file gets an unguessable URL under Piko's public address.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { config } from './config.js';

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/** Only these become links; anything else (scripts, HTML, archives) stays on the box. */
export function shareable(name: string): boolean {
  return extname(name).toLowerCase() in TYPES;
}

function dir(): string {
  const path = join(config.dataDir, 'media');
  mkdirSync(path, { recursive: true });
  return path;
}

/** Saves bytes and returns the public URL. The random id is the only key to the file. */
export function saveMedia(bytes: Buffer, name: string): string {
  const ext = extname(name).toLowerCase();
  const id = `${randomBytes(16).toString('base64url')}${ext}`;
  writeFileSync(join(dir(), id), bytes);
  return `${config.publicUrl}/media/${id}`;
}

/** For the gateway: the file behind /media/<id>, if the id is well-formed and exists. */
export function mediaFile(id: string): { path: string; type: string } | undefined {
  if (!/^[A-Za-z0-9_-]{22}\.[a-z0-9]{2,4}$/.test(id)) return undefined;
  const path = join(dir(), id);
  const type = TYPES[extname(id)];
  return type && existsSync(path) ? { path, type } : undefined;
}
