import { describe, expect, it } from 'vitest';
import { checkRequest, fenceFromEnv } from './fence.js';

const fence = fenceFromEnv(8787, {});
const local = { remoteAddress: '127.0.0.1', host: 'localhost:8787' };
const ok = { ok: true };

describe('checkRequest', () => {
  it('lets this Mac in: the app, the worker and curl send no Origin', () => {
    expect(checkRequest({ ...local, path: '/api/tasks' }, fence)).toEqual(ok);
    expect(checkRequest({ remoteAddress: '::1', host: '[::1]:8787', path: '/api/worker/claim' }, fence)).toEqual(ok);
  });

  it("lets the Command Center in, from Vite or from the server's own page", () => {
    expect(checkRequest({ ...local, origin: 'http://localhost:5173', path: '/api/tasks/t1/decision' }, fence)).toEqual(ok);
    expect(checkRequest({ ...local, origin: 'http://127.0.0.1:8787', path: '/ws' }, fence)).toEqual(ok);
  });

  it('refuses any other web page — including approving a send behind your back', () => {
    const v = checkRequest({ ...local, origin: 'https://evil.example', path: '/api/tasks/t1/decision' }, fence);
    expect(v).toEqual({ ok: false, reason: 'origin https://evil.example not allowed' });
    expect(checkRequest({ ...local, origin: 'null', path: '/ws' }, fence).ok).toBe(false); // sandboxed iframes, file://
  });

  it('refuses DNS rebinding: right address, wrong Host', () => {
    expect(checkRequest({ remoteAddress: '127.0.0.1', host: 'evil.example:8787', path: '/api/tasks' }, fence).ok).toBe(false);
  });

  it('refuses other machines unless they show the worker token', () => {
    expect(checkRequest({ remoteAddress: '192.168.0.42', host: '192.168.0.10:8787', path: '/api/worker/claim' }, fence).ok).toBe(false);
    const shared = fenceFromEnv(8787, { RELAY_TOKEN: 's3cret' });
    const remote = { remoteAddress: '192.168.0.42', host: '192.168.0.10:8787', path: '/api/worker/claim' };
    expect(checkRequest({ ...remote, authorization: 'Bearer s3cret' }, shared)).toEqual(ok);
    expect(checkRequest({ ...remote, authorization: 'Bearer guess' }, shared).ok).toBe(false);
  });

  it('keeps worker routes for programs: no web page may claim or complete a task', () => {
    expect(checkRequest({ ...local, origin: 'http://localhost:5173', path: '/api/worker/claim' }, fence).ok).toBe(false);
  });

  it('holds a container (sandbox Host) to the worker token, even over loopback', () => {
    // A prompt-injected box could otherwise pull /api/connections/credentials or approve its own send.
    const box = { remoteAddress: '127.0.0.1', host: 'host.docker.internal:8787', path: '/api/connections/credentials' };
    expect(checkRequest(box, fence)).toEqual({ ok: false, reason: 'sandbox host needs RELAY_TOKEN' });
    expect(checkRequest({ ...box, path: '/api/tasks' }, fence).ok).toBe(false);
    // With the shared token, the real sandbox worker gets in.
    const shared = fenceFromEnv(8787, { RELAY_TOKEN: 's3cret' });
    expect(checkRequest({ ...box, path: '/api/worker/claim', authorization: 'Bearer s3cret' }, shared)).toEqual(ok);
    expect(checkRequest({ ...box, path: '/api/worker/claim' }, shared).ok).toBe(false);
  });

  it('adds extra pages from RELAY_ORIGINS', () => {
    const f = fenceFromEnv(8787, { RELAY_ORIGINS: 'http://mac.local:5173, https://relay.example' });
    expect(checkRequest({ ...local, origin: 'https://relay.example', path: '/api/tasks' }, f)).toEqual(ok);
  });
});
