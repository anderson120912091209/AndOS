// The accounts Relay's AI can work with once you connect them.
//
// Connecting is a one-time sign-in. After that the agent can *read* through the account —
// search your mail, open a Fathom call's transcript — without asking. Anything that reaches
// another person (sending an email, posting a message) still becomes a card in the notch
// that waits for your OK (policy.ts, proposal.ts).
//
// How an account gets wired in:
//   box    — Relay's own computer (apps/box): a real browser the agent works in. It opens the
//            site, you sign in once in the Box window, and the site stays signed in there.
//            Works for any site, with nothing to set up — what Relay ships with.
//   mcp    — the service's official MCP server; Relay signs in with OAuth and registers
//            itself (Fathom). A developer connector, for now.
//   google — Gmail over Google's APIs with a key from your own Google Cloud project. A
//            developer connector (RELAY_DEV_CONNECTORS=1), in place of Gmail on the box.

export type ConnectionId = 'claude' | 'gmail' | 'fathom' | 'slack' | 'notion' | 'linear';

export type ConnectionAuth =
  /**
   * Signed in on Relay's computer. `signedIn` names a cookie only a signed-in session has, so
   * Relay can tell without opening the site; without one, finishing the sign-in is the signal.
   */
  | { type: 'box'; url: string; signedIn?: { domains: string[]; cookie: string } }
  | { type: 'mcp'; url: string }
  | { type: 'google'; scopes: string[] }
  /** an API key you paste once — Claude, the model that does the work */
  | { type: 'key'; prefix: string; getKeyUrl: string }
  | { type: 'soon'; note: string };

export interface CatalogEntry {
  id: ConnectionId;
  name: string;
  /** what Relay can do with it, in a line */
  blurb: string;
  /** something to try once it's connected */
  example: string;
  auth: ConnectionAuth;
  /** what a developer build offers instead (RELAY_DEV_CONNECTORS=1) */
  devAuth?: ConnectionAuth;
  /** only offered in a developer build — Relay doesn't ship it yet */
  devOnly?: true;
}

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.events',
];

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: 'claude',
    name: 'Claude',
    blurb: 'The AI behind Fn + Control. Uses your Anthropic API key.',
    example: '“Summarize this page and draft a reply.”',
    auth: { type: 'key', prefix: 'sk-ant-', getKeyUrl: 'https://platform.claude.com/settings/keys' },
  },
  {
    id: 'gmail',
    name: 'Gmail',
    blurb: 'Search and read your mail, draft replies.',
    example: '“Go through my inbox and draft replies to anything urgent.”',
    auth: { type: 'box', url: 'https://mail.google.com/', signedIn: { domains: ['google.com'], cookie: 'SID' } },
    devAuth: { type: 'google', scopes: GOOGLE_SCOPES },
  },
  {
    id: 'fathom',
    name: 'Fathom',
    blurb: 'Search your calls, transcripts and summaries.',
    example: '“What did we decide in my last call with Acme?”',
    auth: { type: 'mcp', url: 'https://api.fathom.ai/mcp' },
    devOnly: true,
  },
  {
    id: 'slack',
    name: 'Slack',
    blurb: 'Search messages and catch up on threads.',
    example: '“Catch me up on #design since yesterday.”',
    auth: { type: 'box', url: 'https://app.slack.com/signin', signedIn: { domains: ['slack.com'], cookie: 'd' } },
  },
  {
    id: 'notion',
    name: 'Notion',
    blurb: 'Search and read your pages.',
    example: '“Find the launch plan and summarize the open questions.”',
    auth: { type: 'box', url: 'https://www.notion.so/login', signedIn: { domains: ['notion.so', 'notion.com'], cookie: 'token_v2' } },
  },
  {
    id: 'linear',
    name: 'Linear',
    blurb: 'Look up issues and projects.',
    example: '“What’s blocking the REL milestone?”',
    auth: { type: 'box', url: 'https://linear.app/login' },
  },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((c) => c.id === id);
}

/** How a connection looks in the Connections window. Never carries a secret. */
export interface ConnectionStatus {
  id: ConnectionId;
  name: string;
  blurb: string;
  example: string;
  state: 'connected' | 'available' | 'soon' | 'broken';
  /** who you're signed in as, when the service says */
  account?: string;
  connectedAt?: number;
  /** what the agent may use on its own — read-only tools */
  tools?: string[];
  /** why it can't be connected yet, or what went wrong */
  note?: string;
  /** Gmail needs your Google key before it can sign in */
  needsKey?: boolean;
  /** signed in on Relay's computer, not through an API — Connect opens the Box window */
  via?: 'box';
}

/**
 * Handed to the worker for one job — short-lived, never stored in a task or a log.
 * `tools` is always an explicit list of read-only tools; side effects stay client tools that
 * end in a Proposal.
 */
export type ConnectionCredential =
  | { id: ConnectionId; kind: 'mcp'; name: string; url: string; token: string; tools: string[]; account?: string }
  | { id: 'gmail'; kind: 'google'; token: string; scopes: string[]; account?: string }
  /** the key the worker's agent runs on; without it the worker can only simulate */
  | { id: 'claude'; kind: 'anthropic'; apiKey: string }
  /** a site Relay's computer is signed in to — no token; the agent works it in the box's browser */
  | { id: ConnectionId; kind: 'box'; name: string; url: string; account?: string };
