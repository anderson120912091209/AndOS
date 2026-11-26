import { describe, it, expect } from 'vitest';
import { detectSurface, layoutEmail, layoutText, oneLine, splitSentences } from './layout.js';

// What the Mac app actually reads from Dia with Gmail's compose box focused.
const gmailBody = { bundleId: 'company.thebrowser.dia', host: 'mail.google.com', role: 'AXTextArea', label: 'Message Body' };

describe('detectSurface', () => {
  it('recognizes a Gmail compose body in a browser', () => {
    expect(detectSurface(gmailBody)).toBe('email');
    expect(detectSurface({ ...gmailBody, label: '郵件內文' })).toBe('email');
  });

  it('treats To, Subject and search boxes as one-line fields, even in email', () => {
    expect(detectSurface({ host: 'mail.google.com', role: 'AXTextField', label: 'Subject' })).toBe('field');
    expect(detectSurface({ host: 'mail.google.com', role: 'AXComboBox', label: 'To recipients' })).toBe('field');
    expect(detectSurface({ host: 'mail.google.com', role: 'AXTextField', subrole: 'AXSearchField', label: 'Search mail' })).toBe('field');
    expect(detectSurface({ host: 'mail.google.com', role: 'AXTextField', label: '主旨' })).toBe('field');
  });

  it("doesn't call every box on a webmail site an email", () => {
    // e.g. Google Chat inside Gmail: labelled, but not a message body
    expect(detectSurface({ host: 'mail.google.com', role: 'AXTextArea', label: 'Chat message' })).toBe('general');
  });

  it('knows native mail apps, chat apps and documents', () => {
    expect(detectSurface({ bundleId: 'com.apple.mail', role: 'AXWebArea' })).toBe('email');
    expect(detectSurface({ bundleId: 'com.microsoft.Outlook', role: 'AXTextArea' })).toBe('email');
    expect(detectSurface({ host: 'outlook.office.com', role: 'AXTextArea', label: 'Message body' })).toBe('email');
    expect(detectSurface({ bundleId: 'com.tinyspeck.slackmacgap', role: 'AXTextArea' })).toBe('chat');
    expect(detectSurface({ bundleId: 'jp.naver.line.mac', role: 'AXTextArea' })).toBe('chat');
    expect(detectSurface({ bundleId: 'com.apple.Notes', role: 'AXTextArea' })).toBe('document');
    expect(detectSurface({ bundleId: 'com.google.Chrome', host: 'docs.google.com', role: 'AXTextArea' })).toBe('document');
  });

  it('leaves unknown places alone', () => {
    expect(detectSurface(undefined)).toBe('general');
    expect(detectSurface({ bundleId: 'com.conductor.app', role: 'AXTextArea' })).toBe('general');
  });
});

describe('layoutEmail', () => {
  it('puts greeting, paragraphs, a numbered list and the sign-off on their own lines', () => {
    const said =
      'Hi John, thanks for the update. I reviewed the deck and I have two comments. First, the pricing slide is outdated. ' +
      'Second, we need the Q3 numbers. Let me know when you can sync. Best, Anderson.';
    expect(layoutEmail(said)).toBe(
      [
        'Hi John,',
        '',
        'Thanks for the update. I reviewed the deck and I have two comments:',
        '',
        '1. The pricing slide is outdated.',
        '2. We need the Q3 numbers.',
        '',
        'Let me know when you can sync.',
        '',
        'Best,',
        'Anderson',
      ].join('\n'),
    );
  });

  it('lays out a formal email', () => {
    const said =
      "Dear Professor Lee, I hope this email finds you well. I'm writing to ask about the deadline for the final project. " +
      'Would it be possible to get an extension until next Monday? Thank you for your time. Sincerely, Anderson Chen.';
    expect(layoutEmail(said)).toBe(
      [
        'Dear Professor Lee,',
        '',
        'I hope this email finds you well.',
        '',
        "I'm writing to ask about the deadline for the final project. Would it be possible to get an extension until next Monday?",
        '',
        'Thank you for your time.',
        '',
        'Sincerely,',
        'Anderson Chen',
      ].join('\n'),
    );
  });

  it('lays out a Chinese email, list and closing included', () => {
    const said = '王經理您好，謝謝您的回覆。關於下週的會議，我有兩個問題。第一，會議地點在哪裡？第二，需要準備什麼資料？再麻煩您了，謝謝。Anderson';
    expect(layoutEmail(said)).toBe(
      [
        '王經理您好，',
        '',
        '謝謝您的回覆。關於下週的會議，我有兩個問題：',
        '',
        '1. 會議地點在哪裡？',
        '2. 需要準備什麼資料？',
        '',
        '再麻煩您了，謝謝。',
        'Anderson',
      ].join('\n'),
    );
  });

  it('handles English greetings with Chinese names and a short thank-you', () => {
    expect(layoutEmail('Hi 小明，明天的會議改到下午三點，麻煩幫我通知大家。謝謝！')).toBe(
      ['Hi 小明，', '', '明天的會議改到下午三點，麻煩幫我通知大家。', '', '謝謝！'].join('\n'),
    );
  });

  it('starts a new paragraph on "Also," and before the wrap-up', () => {
    const said = "Hey team, quick update on the launch. We're on track for Friday. Also, the docs are live. Thanks!";
    expect(layoutEmail(said)).toBe(
      ['Hey team,', '', "Quick update on the launch. We're on track for Friday.", '', 'Also, the docs are live.', '', 'Thanks!'].join('\n'),
    );
  });

  it('peels off a sign-off that Whisper ran into the last sentence', () => {
    expect(layoutEmail('Hi team, the release is ready, let me know if anything breaks, thanks, Anderson.')).toBe(
      ['Hi team,', '', 'The release is ready, let me know if anything breaks.', '', 'Thanks,', 'Anderson'].join('\n'),
    );
  });

  it('gives a long, cue-less email room to breathe', () => {
    const said =
      "Hi Sam, I wanted to share a quick update on the migration project before Friday's review. " +
      'The database cutover finished on Tuesday and we saw no data loss during the switch. ' +
      'Latency dropped by about thirty percent across the main API endpoints after the change. ' +
      'We still need to move the reporting jobs, which depend on the old schema. ' +
      'That work is scheduled for next week and should take about two days. Let me know if you have questions. Best, Anderson.';
    const paragraphs = layoutEmail(said).split('\n\n');
    expect(paragraphs).toHaveLength(5); // greeting · two body paragraphs · wrap-up · sign-off
    expect(paragraphs[1]).toMatch(/^I wanted .* endpoints after the change\.$/);
    expect(paragraphs[2]).toMatch(/^We still need .* two days\.$/);
    expect(paragraphs[3]).toBe('Let me know if you have questions.');
  });

  it('keeps paragraph breaks you asked for', () => {
    expect(layoutEmail('Hi John,\n\nFirst thought.\n\nSecond thought.')).toBe('Hi John,\n\nFirst thought.\n\nSecond thought.');
  });

  it('leaves a plain sentence alone', () => {
    const s = 'Can you send me the Q3 numbers by Friday? I need them for the board deck.';
    expect(layoutEmail(s)).toBe(s);
  });

  it('does not mistake "Hey can you…" for a greeting', () => {
    expect(layoutEmail('Hey can you send me the file today?')).toBe('Hey can you send me the file today?');
  });
});

describe('splitSentences', () => {
  it('keeps decimals, addresses and titles whole', () => {
    expect(splitSentences('Dr. Lee said 3.5 is fine. Email me at a@b.com. 好的。謝謝！')).toEqual([
      'Dr. Lee said 3.5 is fine.',
      'Email me at a@b.com.',
      '好的。',
      '謝謝！',
    ]);
  });
});

describe('one-line fields and documents', () => {
  it('flattens to one line and drops a final full stop', () => {
    expect(oneLine('Best ramen in Taipei.')).toBe('Best ramen in Taipei');
    expect(oneLine('Quarterly review\nnext steps.')).toBe('Quarterly review next steps');
    expect(oneLine('Really?')).toBe('Really?');
    expect(oneLine('下週開會。')).toBe('下週開會');
  });

  it('turns spoken enumerations into a list in notes', () => {
    expect(layoutText('Groceries for the week. First, milk. Second, eggs. Finally, bread.', 'document')).toBe(
      'Groceries for the week.\n\n1. Milk.\n2. Eggs.\n3. Bread.',
    );
  });

  it('leaves general text untouched', () => {
    expect(layoutText('Hi John, see you.', 'general')).toBe('Hi John, see you.');
  });
});
