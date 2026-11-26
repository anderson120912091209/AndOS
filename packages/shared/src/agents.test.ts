import { describe, expect, it } from 'vitest';
import { agentFor, agentSignals, CAST } from './agents.js';
import { resolvePointer } from './pointer.js';

const topics = (s: string) => [...agentSignals(s).topics].sort();

describe('agentSignals', () => {
  it('hears what a request is about, in English and Chinese, mid-sentence switches included', () => {
    expect(topics('research the top 3 CRMs and compare pricing')).toEqual(['research']);
    expect(topics('幫我查一下這三家 CRM 的價格')).toEqual(['research']);
    expect(topics('set up a meeting with Sam next Tuesday')).toEqual(['schedule']);
    expect(topics('明天下午跟 Sam 開會，幫我排程')).toEqual(['schedule']);
    expect(topics('what did we decide on the Acme call')).toEqual(['calls']);
    expect(topics('幫我整理那通電話的會議記錄')).toEqual(['calls']);
    expect(topics('catch me up on the design channel in Slack')).toEqual(['messages']);
    expect(topics('write a blog post about our launch')).toEqual(['writing']);
    expect(topics('find me the email from Sam about the invoice')).toEqual(['mail']);
    expect(topics('research CRMs and email Sam the comparison')).toEqual(['mail', 'research']);
  });

  it('reads the place you were pointing at', () => {
    const gmail = resolvePointer({ url: 'https://mail.google.com/mail/u/0/#inbox/FMfcgz', windowTitle: 'Q3 numbers - me@x.io - Gmail' });
    expect(agentSignals('summarize this', gmail).place).toBe('mail');
    const slack = resolvePointer({ url: 'https://app.slack.com/client/T01/C02' });
    expect(agentSignals('summarize this', slack).place).toBe('messages');
    expect(agentSignals('summarize this').place).toBeUndefined();
  });

  it('never trips on words inside other words', () => {
    expect(topics('the postman delivered')).toEqual([]);
    expect(topics('find the documentary')).toEqual([]);
  });
});

describe('agentFor', () => {
  it('gives Relay, the main agent, your mail and anything that is nobody else’s', () => {
    expect(agentFor('find me the email from Sam about the invoice')).toBe('relay');
    expect(agentFor('order more coffee filters')).toBe('relay');
  });

  it('only ever names someone in the cast', () => {
    for (const s of ['research CRMs', '開會', 'what did we decide', 'ping the channel', 'write a memo', '']) {
      expect(Object.keys(CAST)).toContain(agentFor(s));
    }
  });
});
