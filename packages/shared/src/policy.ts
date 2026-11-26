// Which agent actions run on their own, and which stop and wait for your OK.
//
// The line Relay draws: work that stays inside the sandbox or can be undone
// (searching, reading, writing a draft) just happens. Anything that reaches
// another person, lands on your calendar, or can't be taken back becomes a
// Proposal — a card in the notch with a button you have to press.
//
// Unknown tools ask. A new tool has to be listed here before it can run
// unattended, so forgetting to classify one fails safe.
//
// Tools from a connected MCP server (Fathom…) never reach this table: Anthropic calls
// them during the model's turn. They're safe because the connection only ever exposes
// that server's read-only tools (ConnectionCredential.tools in connections.ts).

export type Approval = 'auto' | 'ask';

const POLICY: Record<string, Approval> = {
  // reading the world — and your own accounts, once connected
  web_search: 'auto',
  web_fetch: 'auto',
  search_email: 'auto',
  read_email: 'auto',
  // acting in the box's own browser — reading/navigating/typing; sign-in & 2FA go through
  // request_takeover, and the prompt tells the agent to stop before sending to other people
  read_page: 'auto',
  browse: 'auto',
  click: 'auto',
  type_text: 'auto',
  // the box's own computer — its shell, its workspace files, its screen (the whole computer
  // toolset is classified by its toolset name). The shell holds none of your accounts and is
  // firewalled off your Mac; on the screen, the prompt has the agent stop before it sends,
  // submits or pays for anything on your behalf.
  bash: 'auto',
  str_replace_based_edit_tool: 'auto',
  computer: 'auto',
  // the engine's own bookkeeping when the agent runs on your Claude Code login (worker
  // claude-code.ts): its task list and its helper agents. They act on nothing outside the
  // conversation, and every tool a helper calls is checked against this table on its own.
  TaskCreate: 'auto',
  TaskUpdate: 'auto',
  TaskGet: 'auto',
  TaskList: 'auto',
  Agent: 'auto',
  // reversible: drafts sit in Drafts until something sends them
  draft_email: 'auto',
  // reaches another person / your calendar — always your call
  send_email: 'ask',
  create_calendar_event: 'ask',
};

export function approvalFor(tool: string): Approval {
  return POLICY[tool] ?? 'ask';
}
