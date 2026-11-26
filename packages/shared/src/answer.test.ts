import { describe, expect, it } from 'vitest';
import { answerFromText, answerResult, answerText, displayWidth, followUpFrom, normalizeAnswer, placeFor, type Answer } from './index.js';

const triage: Answer = {
  tone: 'answer',
  headline: '3 封要你回，其他都不急',
  basis: '讀完 40 封未讀',
  block: {
    kind: 'list',
    items: [
      { title: 'Sam Lee', sub: '合約第 3 條', detail: '要你週五前確認付款條件', tag: '週五前', tone: 'amber' },
      { title: 'Stripe', sub: '扣款失敗', detail: '信用卡過期', tag: '3 天內', tone: 'red' },
    ],
    more: '還有 37 封不急',
  },
  followups: ['回覆 Sam'],
};

describe('placeFor', () => {
  it('keeps a one-line answer in the chin, in either language', () => {
    expect(placeFor({ tone: 'answer', headline: '這個月 Uber 花了 NT$3,420' })).toBe('chin');
    expect(placeFor({ tone: 'done', headline: 'Added lunch with Mei to your calendar.' })).toBe('chin');
  });

  it('opens a card when the headline runs past one line — Chinese counts double', () => {
    expect(placeFor({ tone: 'answer', headline: '你這個月搭了十四趟 Uber，總共花了三千四百二十元，比上個月同期少了大約百分之十二' })).toBe('card');
  });

  it('gives a question a card, even with no block, so its answers have room', () => {
    expect(placeFor({ tone: 'needs_you', headline: '要送出報名表嗎？', followups: ['送出', '先不要'] })).toBe('card');
  });

  it('puts every structured block in a card, and documents in the reader', () => {
    expect(placeFor(triage)).toBe('card');
    expect(placeFor({ tone: 'answer', headline: 'x', block: { kind: 'facts', rows: [{ label: 'a', value: 'b' }] } })).toBe('card');
    expect(placeFor({ tone: 'answer', headline: 'x', block: { kind: 'doc', title: 'Report', markdown: '# Hi' } })).toBe('reader');
  });

  it('sends a long paragraph to the reader, keeps a short one in the card', () => {
    expect(placeFor({ tone: 'answer', headline: 'x', block: { kind: 'text', body: '字'.repeat(300) } })).toBe('reader');
    expect(placeFor({ tone: 'answer', headline: 'x', block: { kind: 'text', body: 'A few words.' } })).toBe('card');
  });
});

describe('displayWidth', () => {
  it('counts CJK and full-width characters double', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('收件匣')).toBe(6);
    expect(displayWidth('3 封要回：')).toBe(10); // the full-width colon is wide too
  });
});

describe('normalizeAnswer', () => {
  it('drops the empty fields the strict schema makes the model fill in', () => {
    const a = normalizeAnswer({
      tone: 'answer',
      headline: '  3 封要你回  ',
      basis: '',
      note: '',
      followups: [],
      block: { kind: 'list', items: [{ title: 'Sam', sub: '', detail: '', tag: '', tone: 'neutral' }], more: '' },
    });
    expect(a).toEqual({ tone: 'answer', headline: '3 封要你回', block: { kind: 'list', items: [{ title: 'Sam' }] } });
  });

  it('keeps at most three follow-ups and an unknown tone falls back to answer', () => {
    const a = normalizeAnswer({ tone: 'shout', headline: 'Done', followups: ['a', ' ', 'b', 'c', 'd'] });
    expect(a.tone).toBe('answer');
    expect(a.followups).toEqual(['a', 'b', 'c']);
  });

  it('lines a comparison up: one value per column, and a pick that exists', () => {
    const a = normalizeAnswer({
      tone: 'answer',
      headline: 'HubSpot',
      block: { kind: 'compare', columns: ['HubSpot', 'Pipedrive'], rows: [{ label: '價格', values: ['免費'] }, { label: '上手', values: ['1 天', '2 天', 'extra'] }], pick: 7 },
    });
    expect(a.block).toEqual({
      kind: 'compare',
      columns: ['HubSpot', 'Pipedrive'],
      rows: [{ label: '價格', values: ['免費', '—'] }, { label: '上手', values: ['1 天', '2 天'] }],
    });
  });

  it('drops a block that has nothing to show rather than drawing an empty card', () => {
    expect(normalizeAnswer({ tone: 'answer', headline: 'x', block: { kind: 'compare', columns: ['only one'], rows: [] } }).block).toBeUndefined();
    expect(normalizeAnswer({ tone: 'answer', headline: 'x', block: { kind: 'list', items: [] } }).block).toBeUndefined();
  });

  it('cuts a long list and says how many it left out', () => {
    const items = Array.from({ length: 11 }, (_, n) => ({ title: `#${n}`, sub: '', detail: '', tag: '', tone: 'neutral' }));
    const a = normalizeAnswer({ tone: 'answer', headline: 'x', block: { kind: 'list', items, more: '' } });
    expect(a.block).toMatchObject({ kind: 'list', more: '+3' });
    expect(a.block?.kind === 'list' && a.block.items).toHaveLength(8);
  });

  it('falls back to the document title, then "Done.", when the headline is empty', () => {
    expect(normalizeAnswer({ tone: 'answer', headline: '', block: { kind: 'doc', title: 'CRM 選型', markdown: '# x' } }).headline).toBe('CRM 選型');
    expect(normalizeAnswer({}).headline).toBe('Done.');
  });
});

describe('answerFromText', () => {
  it('turns a one-sentence reply into a one-line answer', () => {
    expect(answerFromText('Sunny, 24°C.')).toEqual({ tone: 'answer', headline: 'Sunny, 24°C.' });
  });

  it('leads with the first sentence and keeps the rest as a paragraph', () => {
    expect(answerFromText('HubSpot fits best. It is free and has the cleanest Gmail add-on.')).toEqual({
      tone: 'answer',
      headline: 'HubSpot fits best.',
      block: { kind: 'text', body: 'It is free and has the cleanest Gmail add-on.' },
    });
  });

  it('keeps a structured markdown reply whole, as a document for the reader', () => {
    const md = '**今天收件匣有 40 封未讀。** 有幾封要你處理：\n\n**需要你回覆**\n1. **Sam Lee** — 合約第 3 條\n2. **林怡君** — 面試時間';
    const a = answerFromText(md);
    expect(a.headline).toBe('今天收件匣有 40 封未讀。');
    expect(a.block).toMatchObject({ kind: 'doc', title: '今天收件匣有 40 封未讀。' });
    expect(a.block?.kind === 'doc' && a.block.markdown).toContain('1. **Sam Lee** — 合約第 3 條');
    expect(placeFor(a)).toBe('reader');
  });
});

describe('answerText / answerResult / followUpFrom', () => {
  it('reads as plain text: headline, what it went through, then the block', () => {
    expect(answerText(triage)).toBe(
      '3 封要你回，其他都不急\n\n(讀完 40 封未讀)\n\n• Sam Lee · 合約第 3 條 — 要你週五前確認付款條件 [週五前]\n• Stripe · 扣款失敗 — 信用卡過期 [3 天內]\n還有 37 封不急',
    );
  });

  it('makes a task result whose summary still works for anything that only reads text', () => {
    expect(answerResult(triage)).toEqual({ summary: answerText(triage), answer: triage, place: 'card' });
  });

  it('carries the earlier answer into a follow-up, as text', () => {
    const task = { id: 't1', utterance: '幫我看收件匣', result: answerResult(triage) };
    expect(followUpFrom(task)).toEqual({ taskId: 't1', utterance: '幫我看收件匣', answer: answerText(triage) });
    expect(followUpFrom({ id: 't2', utterance: 'x', result: { summary: 'old style' } }).answer).toBe('old style');
  });
});
