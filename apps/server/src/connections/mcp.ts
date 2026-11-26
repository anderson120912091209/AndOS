// Just enough MCP to ask a server what it can do — once, right after you connect — so the
// agent gets an explicit list of read-only tools. The agent itself talks to the server
// through Claude's MCP connector; this server never calls tools.

import type { Fetch } from './oauth.js';

export interface ToolInfo {
  name: string;
  readOnly: boolean;
}

const PROTOCOL = '2025-06-18';

interface Rpc {
  id?: number;
  result?: { tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[]; nextCursor?: string };
  error?: { message?: string };
}

/** Streamable HTTP answers either as JSON or as a short event stream. */
async function readRpc(res: Response, id: number): Promise<Rpc> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const msg = JSON.parse(line.slice(5)) as Rpc;
        if (msg.id === id) return msg;
      } catch {
        /* keep-alive or partial line */
      }
    }
    throw new Error('no reply in the event stream');
  }
  return JSON.parse(text) as Rpc;
}

export async function listTools(url: string, token: string, http: Fetch = fetch): Promise<ToolInfo[]> {
  let session: string | undefined;
  let next = 1;
  const post = async (message: object, expectReply: boolean): Promise<Rpc | undefined> => {
    const res = await http(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL,
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: JSON.stringify(message),
    });
    session = res.headers.get('mcp-session-id') ?? session;
    if (!res.ok) throw new Error(`MCP ${res.status}`);
    return expectReply ? readRpc(res, (message as { id: number }).id) : undefined;
  };

  await post(
    { jsonrpc: '2.0', id: next++, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Relay', version: '0.1.0' } } },
    true,
  );
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);

  const tools: ToolInfo[] = [];
  let cursor: string | undefined;
  do {
    const reply = await post({ jsonrpc: '2.0', id: next++, method: 'tools/list', params: cursor ? { cursor } : {} }, true);
    if (reply?.error) throw new Error(reply.error.message ?? 'tools/list failed');
    for (const t of reply?.result?.tools ?? []) tools.push({ name: t.name, readOnly: t.annotations?.readOnlyHint === true });
    cursor = reply?.result?.nextCursor;
  } while (cursor);
  return tools;
}

/** Servers whose every tool only reads, per their own documentation. */
const READ_ONLY_SERVERS = new Set(['https://api.fathom.ai/mcp']);

/** The tools the agent may use on its own: marked read-only, or from a read-only server. */
export function readOnlyTools(serverUrl: string, tools: ToolInfo[]): string[] {
  const everything = READ_ONLY_SERVERS.has(serverUrl);
  return tools.filter((t) => (everything || t.readOnly) && !soundsLikeAnAction(t.name)).map((t) => t.name);
}

/**
 * The last line of defence: a server can label a tool read-only by mistake. Return true for a
 * tool name that sounds like it acts on the world (sends, posts, deletes…) so it never runs
 * without you — it simply isn't offered to the agent.
 */
function soundsLikeAnAction(name: string): boolean {
  // send_email, deleteDraft, create-event → [send, email], [delete, draft], [create, event]
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/);
  return words.some((w) => ACTION_WORDS.has(w));
}

/** Verbs that reach the world or change it. A whole word only: "bookmark" isn't "mark". */
const ACTION_WORDS = new Set([
  'send', 'post', 'reply', 'forward', 'publish', 'share', 'invite', 'notify', 'message',
  'create', 'add', 'insert', 'write', 'upload', 'submit', 'update', 'edit', 'modify', 'set', 'rename',
  'delete', 'remove', 'trash', 'archive', 'move', 'cancel', 'close', 'merge', 'approve', 'assign',
  'schedule', 'book', 'pay', 'purchase', 'transfer', 'label', 'mark', 'star',
]);
