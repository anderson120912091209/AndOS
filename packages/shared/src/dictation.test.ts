import { describe, it, expect } from 'vitest';
import { cleanTranscript } from './dictation.js';

describe('cleanTranscript', () => {
  it('removes fillers but keeps real words like "like"', () => {
    // "um"/"uh" are dropped; standalone "like" is a real word and must survive.
    expect(cleanTranscript('um so uh this is a test')).toBe('So this is a test');
    expect(cleanTranscript('i really like this, you know')).toBe('I really like this,');
  });

  it('applies spoken punctuation', () => {
    expect(cleanTranscript('hello comma world period')).toBe('Hello, world.');
  });

  it('handles new line and new paragraph', () => {
    expect(cleanTranscript('first line new line second line')).toBe('First line\nSecond line');
    expect(cleanTranscript('para one new paragraph para two')).toBe('Para one\n\nPara two');
  });

  it('capitalizes each sentence', () => {
    expect(cleanTranscript('hello world. how are you?')).toBe('Hello world. How are you?');
  });

  it('tucks punctuation against the preceding word', () => {
    expect(cleanTranscript('wait comma what question mark')).toBe('Wait, what?');
  });

  it('does not corrupt already-clean text when run twice', () => {
    const once = cleanTranscript('Send the report by Friday.');
    expect(cleanTranscript(once)).toBe(once);
  });

  it('can be told to keep fillers and literal punctuation words', () => {
    expect(cleanTranscript('um period', { removeFillers: false, spokenPunctuation: false })).toBe('Um period');
  });
});

describe('cleanTranscript — punctuated engines (Whisper)', () => {
  const clean = (s: string) => cleanTranscript(s, { punctuated: true });

  it('keeps words the spoken-punctuation rules would have eaten', () => {
    expect(clean('The trial period ends Friday.')).toBe('The trial period ends Friday.');
    expect(clean('We need a new line of products.')).toBe('We need a new line of products.');
    expect(clean('I kind of like it, you know.')).toBe('I kind of like it, you know.');
  });

  it('keeps dots inside numbers and addresses', () => {
    expect(clean('Email anderson@gmail.com about version 2.5.')).toBe('Email anderson@gmail.com about version 2.5.');
  });

  it('drops pure fillers only', () => {
    expect(clean('Um, I think, uh, we should ship.')).toBe('I think, we should ship.');
  });

  it('honors "new paragraph" / 換段 said as their own sentence', () => {
    expect(clean('First point. New paragraph. Second point.')).toBe('First point.\n\nSecond point.');
    expect(clean('第一段。換段。第二段。')).toBe('第一段。\n\n第二段。');
    expect(clean('Line one. New line. Line two.')).toBe('Line one.\nLine two.');
  });
});
