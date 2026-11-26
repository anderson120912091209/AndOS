import { describe, expect, it } from 'vitest';
import { approvalFor, displayName, jobFor, summarize, type Proposal } from './index.js';

const email: Proposal = {
  id: 'prop_1',
  createdAt: 1,
  verb: 'Send',
  summary: 'Email to Alex · Running late',
  preview: { kind: 'email', to: ['alex@acme.com'], subject: 'Running late', body: 'Hi Alex' },
  commit: { action: 'email.send', args: { draftId: 'd1' } },
};

describe('jobFor', () => {
  it('runs a task that has no proposal yet', () => {
    expect(jobFor({})).toEqual({ type: 'run' });
  });

  it('waits (stays a run job) while the proposal is undecided', () => {
    expect(jobFor({ proposal: email }).type).toBe('run');
  });

  it('commits an approved proposal exactly once', () => {
    const approved = { ...email, decision: { verdict: 'approve' as const, at: 2 } };
    expect(jobFor({ proposal: approved })).toEqual({ type: 'commit', proposal: approved });
    expect(jobFor({ proposal: { ...approved, committedAt: 3 } }).type).toBe('run');
  });

  it('turns a rejection into a discard job, so the draft gets cleaned up', () => {
    const rejected = { ...email, decision: { verdict: 'reject' as const, at: 2 } };
    expect(jobFor({ proposal: rejected })).toEqual({ type: 'discard', proposal: rejected });
  });

  it('turns a revise decision into a revise job carrying your note', () => {
    const revise = { ...email, decision: { verdict: 'revise' as const, at: 2, feedback: 'shorter' } };
    expect(jobFor({ proposal: revise })).toEqual({ type: 'revise', proposal: revise, feedback: 'shorter' });
  });
});

describe('summarize / displayName', () => {
  it('names the first recipient and counts the rest', () => {
    const a = { kind: 'email' as const, to: ['alex.chen@acme.com', 'sam@acme.com'], subject: 'Running late', body: '' };
    expect(summarize(a)).toBe('Email to Alex Chen +1 · Running late');
  });

  it('leaves non-address names alone', () => {
    expect(displayName('Alex')).toBe('Alex');
    expect(displayName('mary-jane_w@x.io')).toBe('Mary Jane W');
  });

  it('shows an event with its start time', () => {
    expect(summarize({ kind: 'event', title: 'Coffee with Alex', start: '2026-10-26T15:00:00+08:00' })).toBe(
      'Coffee with Alex · 2026-10-26 15:00',
    );
  });
});

describe('approvalFor', () => {
  it('lets reversible work run and stops at anything that reaches someone', () => {
    expect(approvalFor('draft_email')).toBe('auto');
    expect(approvalFor('web_search')).toBe('auto');
    expect(approvalFor('send_email')).toBe('ask');
    expect(approvalFor('create_calendar_event')).toBe('ask');
  });

  it('asks for tools it has never heard of', () => {
    expect(approvalFor('wire_money')).toBe('ask');
  });
});
