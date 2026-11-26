import { describe, expect, it } from 'vitest';
import { createTask, type Takeover } from '@relay/shared';
import { TaskStore } from './store.js';

const agent = () => createTask({ kind: 'agent', title: 'x', utterance: 'look at my gmail' });
const tk: Takeover = { id: 'tk1', reason: 'Sign in to Gmail', service: 'gmail', url: 'https://mail.google.com' };

describe('TaskStore takeover lifecycle', () => {
  it('parks a task as needs_input with the takeover, then re-queues it when you finish', () => {
    const store = new TaskStore();
    const task = store.add(agent());

    const parked = store.awaitTakeover(task.id, tk);
    expect(parked?.status).toBe('needs_input');
    expect(parked?.takeover).toEqual(tk);
    // a parked task isn't claimable until it's resumed
    expect(store.claimNext()).toBeUndefined();

    const resumed = store.resumeFromTakeover(task.id);
    expect(resumed?.status).toBe('queued');
    expect(resumed?.takeover).toEqual(tk); // kept as the record of what happened
    // now a worker can pick it up again and the agent carries on
    expect(store.claimNext()?.id).toBe(task.id);
  });

  it("won't resume a task that isn't waiting on you", () => {
    const store = new TaskStore();
    const task = store.add(agent());
    expect(store.resumeFromTakeover(task.id)?.status).toBe('queued'); // unchanged (was queued)
    store.setStatus(task.id, 'done');
    expect(store.resumeFromTakeover(task.id)?.status).toBe('done'); // terminal, left alone
  });
})
