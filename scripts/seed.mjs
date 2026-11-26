// Post a handful of utterances so the Command Center has a lively, representative
// feed: an immediate dictation + command, plus agent jobs across archetypes.
const SERVER = process.env.RELAY_SERVER ?? 'http://localhost:8787';

const utterances = [
  { utterance: 'um the Q3 numbers look strong comma honestly we should ship the launch period', context: { appName: 'Notes' } },
  { utterance: 'bold that', context: { appName: 'Pages', selectionText: 'Relay — speak, and it is done' } },
  { utterance: 'research the top three CRMs for a 10 person startup and draft a comparison email to the team', context: { appName: 'Safari', url: 'https://news.ycombinator.com' } },
  { utterance: 'find a direct flight to Tokyo next Friday under 500 dollars and get it ready to book', context: { appName: 'Safari' } },
  { utterance: 'fix the failing test in the parser and open a draft PR', context: { appName: 'VS Code', url: 'repo: relay' } },
  { utterance: 'summarize this and reply to the thread for me', context: { appName: 'Mail', selectionText: 'long customer email about renewal pricing…' } },
];

for (const u of utterances) {
  const res = await fetch(`${SERVER}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(u),
  });
  const data = await res.json();
  console.log(`seeded [${data.intent.kind}] ${data.task.title}`);
  await new Promise((r) => setTimeout(r, 120));
}
console.log('done seeding');
