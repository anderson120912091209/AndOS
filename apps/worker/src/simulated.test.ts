import { describe, it, expect } from 'vitest';
import { createTask, type Proposal } from '@relay/shared';
import { SimulatedDriver } from './simulated.js';
import type { DriverContext, EmitStep, Outcome } from './driver.js';
import type { EmailDraft } from './mime.js';

function harness(signal = new AbortController().signal, speed = 0) {
  const steps: EmitStep[] = [];
  const drafts = new Map<string, EmailDraft>();
  const discarded: string[] = [];
  const ctx: DriverContext = {
    emit: async (s) => void steps.push(s),
    signal,
    speed, // 0 = instant, no real delays in tests
    drafts: {
      createEmail: async (email) => {
        const id = `d${drafts.size + 1}`;
        drafts.set(id, email);
        return { id };
      },
      discardEmail: async (id) => void discarded.push(id),
    },
  };
  return { ctx, steps, drafts, discarded };
}

function proposalOf(o: Outcome): Proposal {
  if (o.type !== 'proposal') throw new Error(`expected a proposal, got ${o.type}`);
  return o.proposal;
}

const agent = (utterance: string, timeZone = 'Asia/Taipei') =>
  createTask({ kind: 'agent', title: utterance, utterance, context: { timeZone } });

describe('SimulatedDriver', () => {
  it('stops a booking before payment, with a result instead of a proposal', async () => {
    const { ctx, steps } = harness();
    const out = await new SimulatedDriver().run(agent('find a flight to Tokyo and book it'), ctx);

    expect(steps[0]).toMatchObject({ type: 'note', status: 'running' });
    expect(steps.some((s) => s.type === 'think')).toBe(true);
    expect(out.type).toBe('done');
    if (out.type === 'done') expect(out.result.summary).toMatch(/payment/i);
  });

  it('selects the coding archetype for a repo task', async () => {
    const { ctx, steps } = harness();
    const out = await new SimulatedDriver().run(agent('fix the failing test in the repo'), ctx);
    expect(steps.some((s) => JSON.stringify(s.data ?? {}).includes('git.clone'))).toBe(true);
    expect(out.type === 'done' && out.result.summary).toMatch(/PR/);
  });

  it('drafts an email, saves it, and stops for approval instead of sending', async () => {
    const { ctx, drafts } = harness();
    const p = proposalOf(await new SimulatedDriver().run(agent("email Alex saying I'll be 20 minutes late tomorrow"), ctx));

    expect(p.verb).toBe('Send');
    expect(p.commit).toEqual({ action: 'email.send', args: { draftId: 'd1' } });
    expect(p.preview).toMatchObject({ kind: 'email', to: ['alex@example.com'] });
    expect(drafts.get('d1')?.body).toContain("I'll be 20 minutes late tomorrow.");
  });

  it('turns a Chinese scheduling request into an event in your time zone', async () => {
    const { ctx } = harness();
    const p = proposalOf(await new SimulatedDriver().run(agent('明天下午三點跟Alex開會一小時'), ctx));
    expect(p.verb).toBe('Add to Calendar');
    expect(p.preview).toMatchObject({ kind: 'event', title: '跟Alex開會' });
    if (p.preview.kind !== 'event') throw new Error('not an event');
    expect(p.preview.start).toMatch(/T15:00:00\+08:00$/);
    expect(p.preview.end).toMatch(/T16:00:00\+08:00$/);
  });

  it('revises a draft with your note into a new proposal', async () => {
    const { ctx } = harness();
    const driver = new SimulatedDriver();
    const task = agent('email Alex saying the launch moved to Friday and thanks for the help');
    const first = proposalOf(await driver.run(task, ctx));
    const second = proposalOf(await driver.revise(task, first, 'make it more formal', ctx));
    expect(second.id).not.toBe(first.id);
    expect(second.commit.args.draftId).toBe('d2');
    expect(second.preview.kind === 'email' && second.preview.body).toMatch(/^Dear Alex,/);
  });

  it('does not invent a draft when asked to read the inbox', async () => {
    const { ctx, drafts } = harness();
    const out = await new SimulatedDriver().run(agent('Go through my email and tell me what tasks I need to do today'), ctx);
    expect(out.type).toBe('done');
    expect(drafts.size).toBe(0);
  });

  it('aborts promptly when signaled', async () => {
    const controller = new AbortController();
    const { ctx } = harness(controller.signal, 1);
    controller.abort();
    await expect(new SimulatedDriver().run(agent('research the market'), ctx)).rejects.toThrow(/abort/i);
  });
});

describe('SimulatedDriver with Gmail connected', () => {
  it('lists what is actually in the inbox instead of drafting anything', async () => {
    const { ctx, drafts } = harness();
    const queries: string[] = [];
    ctx.reads = {
      mcp: [],
      accounts: { gmail: 'me@x.io' },
      mail: {
        search: async (q) => {
          queries.push(q);
          return [
            { id: '1', threadId: 't1', from: 'Alex Chen <alex@acme.com>', to: 'me@x.io', subject: 'Contract v2', date: '', snippet: '', unread: true },
            { id: '2', threadId: 't2', from: 'billing@aws.com', to: 'me@x.io', subject: 'Your invoice', date: '', snippet: '', unread: false },
          ];
        },
        read: async () => {
          throw new Error('not needed');
        },
      },
    };
    const out = await new SimulatedDriver().run(agent('go through my email and tell me what to do today'), ctx);
    expect(queries).toEqual(['in:inbox newer_than:2d']);
    expect(drafts.size).toBe(0);
    expect(out.type === 'done' && out.result.answer?.block).toEqual({
      kind: 'list',
      items: [
        { title: 'Alex Chen', sub: 'Contract v2', tag: 'unread', tone: 'amber' },
        { title: 'billing@aws.com', sub: 'Your invoice' },
      ],
    });
  });
});
