// Where connection secrets live: your login Keychain.
//
// Written through `security -i` on stdin, so a token never shows up in a process listing, and
// stored base64-encoded so any text survives the round trip. Tests (and RELAY_SECRETS=memory)
// use an in-memory store instead.

import { spawn } from 'node:child_process';

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

function run(cmd: string, args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}

export class KeychainStore implements SecretStore {
  constructor(private service = 'com.relay.connections') {}

  async get(key: string): Promise<string | undefined> {
    const { code, stdout } = await run('security', ['find-generic-password', '-s', this.service, '-a', key, '-w']);
    if (code !== 0) return undefined;
    return Buffer.from(stdout.trim(), 'base64').toString('utf8');
  }

  async set(key: string, value: string): Promise<void> {
    if (/["\n]/.test(key)) throw new Error('unsupported keychain key');
    const b64 = Buffer.from(value, 'utf8').toString('base64');
    await run('security', ['-i'], `add-generic-password -U -s "${this.service}" -a "${key}" -l "Relay — ${key}" -w ${b64}\n`);
    // `security -i` reports success either way; reading it back is the real check.
    if ((await this.get(key)) !== value) throw new Error(`couldn't save ${key} to the Keychain`);
  }

  async delete(key: string): Promise<void> {
    await run('security', ['delete-generic-password', '-s', this.service, '-a', key]);
  }
}

export class MemoryStore implements SecretStore {
  private map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key);
  }
  async set(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

export function secretStoreFromEnv(env = process.env): SecretStore {
  return env.RELAY_SECRETS === 'memory' || process.platform !== 'darwin' ? new MemoryStore() : new KeychainStore();
}
