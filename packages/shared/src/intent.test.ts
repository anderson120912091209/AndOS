import { describe, it, expect } from 'vitest';
import { routeIntent } from './intent.js';

describe('routeIntent', () => {
  it('defaults plain speech to dictation and cleans it', () => {
    const r = routeIntent('um the quarterly numbers look strong comma honestly');
    expect(r.kind).toBe('dictation');
    expect(r.cleanedText).toBe('The quarterly numbers look strong, honestly');
  });

  it('routes a short imperative to a local command', () => {
    const r = routeIntent('bold that');
    expect(r.kind).toBe('command');
    expect(r.action?.verb).toBe('bold that');
  });

  it('dispatches a multi-step request to an agent', () => {
    const r = routeIntent('research the top three CRMs and draft a comparison email');
    expect(r.kind).toBe('agent');
    expect(r.confidence).toBeGreaterThan(0.7);
  });

  it('dispatches an agent job that opens with a verb', () => {
    const r = routeIntent('find a direct flight to Tokyo next Friday');
    expect(r.kind).toBe('agent');
    expect(r.action?.verb).toBe('find');
  });

  it('strips the wake word before routing', () => {
    const r = routeIntent('Relay, summarize this page and send it to my team');
    expect(r.kind).toBe('agent');
    expect(r.title.startsWith('Relay')).toBe(false);
  });

  it('resolves "this" to the screen selection when present', () => {
    const r = routeIntent('summarize this and email the team', {
      selectionText: 'a long article body',
      appName: 'Safari',
    });
    expect(r.kind).toBe('agent');
    expect(r.action?.on).toBe('selection');
  });

  it('keeps a lone action verb as dictation without multi-step scope', () => {
    const r = routeIntent('create a new paragraph here');
    // "new paragraph" is a command phrase, so this is a command, not an agent job.
    expect(r.kind).not.toBe('agent');
  });

  it('honors an LLM classifier override seam', () => {
    const r = routeIntent('the numbers look strong', {}, { classify: () => 'agent' });
    expect(r.kind).toBe('agent');
  });

  it('treats empty input as empty dictation', () => {
    expect(routeIntent('   ').cleanedText).toBe('');
  });
});

describe('routeIntent — layout for where you are typing', () => {
  const gmailBody = { bundleId: 'company.thebrowser.dia', host: 'mail.google.com', role: 'AXTextArea', label: 'Message Body' };

  it('lays dictation into a Gmail body out as an email', () => {
    const r = routeIntent('Hi John, see you at three. Thanks, Anderson.', { target: gmailBody, punctuated: true }, {
      classify: () => 'dictation',
    });
    expect(r.cleanedText).toBe('Hi John,\n\nSee you at three.\n\nThanks,\nAnderson');
    expect(r.reason).toContain('an email');
  });

  it('gives a subject line one clean line', () => {
    const r = routeIntent('Quarterly review.', { target: { role: 'AXTextField', label: 'Subject' }, punctuated: true });
    expect(r.cleanedText).toBe('Quarterly review');
  });

  it("doesn't turn the word \"period\" into a dot for a punctuating engine", () => {
    expect(routeIntent('The trial period ends Friday.', { punctuated: true }).cleanedText).toBe('The trial period ends Friday.');
  });
});

describe('routeIntent — what "this" is for the AI', () => {
  it('carries a pointer for agent requests made while looking at something', () => {
    const r = routeIntent(
      'reply to this and say I can do Thursday',
      { url: 'https://mail.google.com/mail/u/0/#inbox/FMfcgzQXJWDsKqTpvBmWkQrlNbcGvLdk', windowTitle: 'Q3 numbers - a@b.com - Gmail' },
      { classify: () => 'agent' },
    );
    expect(r.kind).toBe('agent');
    expect(r.pointer).toMatchObject({ service: 'gmail', kind: 'thread', label: 'Q3 numbers' });
    expect(r.reason).toContain('“Q3 numbers”');
  });
});
