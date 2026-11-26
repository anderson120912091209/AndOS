// Turns what the harness wants to say (an `Outgoing`) into LINE messages, laid out for older users:
// big text, one thing per message, buttons instead of typing wherever possible.
import { connectLink } from '../connect/google.js';
import { addMinutes, clock, googleCalendarLink, spoken } from '../time.js';
import type { CalendarEvent, Card, CardButton, Outgoing, Place } from '../types.js';
import type { LineMessage } from './api.js';

type Action = Record<string, string>;

/** Google Maps search for a place; on a phone it opens the Maps app. */
function mapsLink(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** Only https links and dialable numbers become buttons: everything in a card comes from the model. */
function safeLink(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && url.length <= 1000 ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function dial(phone: string): string | undefined {
  const digits = phone.replace(/[^\d+#*]/g, '');
  return digits.length >= 3 ? `tel:${digits}` : undefined;
}

function action(button: CardButton): Action | undefined {
  const label = button.label.slice(0, 20);
  switch (button.kind) {
    case 'link': {
      const uri = safeLink(button.value);
      return uri ? { type: 'uri', label, uri } : undefined;
    }
    case 'call': {
      const uri = dial(button.value);
      return uri ? { type: 'uri', label, uri } : undefined;
    }
    case 'map':
      return { type: 'uri', label, uri: mapsLink(button.value) };
    case 'reply':
      return { type: 'message', label, text: button.value.slice(0, 300) };
  }
}

function buttonBox(actions: Action[]) {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    contents: actions.map((a, i) => ({ type: 'button', style: i === 0 ? 'primary' : 'secondary', height: 'md', action: a })),
  };
}

function placeBubble(place: Place) {
  const actions = [
    { type: 'uri', label: '📍 導航', uri: mapsLink([place.name, place.address].filter(Boolean).join(' ')) },
    ...(place.phone && dial(place.phone) ? [{ type: 'uri', label: '📞 打電話', uri: dial(place.phone) as string }] : []),
    ...(place.url && safeLink(place.url) ? [{ type: 'uri', label: '🌐 網站', uri: safeLink(place.url) as string }] : []),
  ];
  return {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: place.name, weight: 'bold', size: 'xl', wrap: true },
        ...(place.note ? [{ type: 'text', text: plain(place.note), size: 'lg', wrap: true }] : []),
        ...(place.address ? [{ type: 'text', text: place.address, size: 'md', color: '#888888', wrap: true }] : []),
        ...(place.phone ? [{ type: 'text', text: place.phone, size: 'md', color: '#888888' }] : []),
      ],
    },
    footer: buttonBox(actions),
  };
}

function placesCarousel(places: Place[]): LineMessage {
  return {
    type: 'flex',
    altText: `📍 ${places.map((p) => p.name).join('、')}`.slice(0, 400),
    contents: { type: 'carousel', contents: places.slice(0, 10).map(placeBubble) },
  };
}

function genericCard(card: Card): LineMessage {
  const actions = (card.buttons ?? []).map(action).filter((a): a is Action => a !== undefined);
  const image = card.image_url ? safeLink(card.image_url) : undefined;
  return {
    type: 'flex',
    altText: card.title.slice(0, 400),
    contents: {
      type: 'bubble',
      ...(image ? { hero: { type: 'image', url: image, size: 'full', aspectMode: 'cover', aspectRatio: '20:13' } } : {}),
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: card.title, weight: 'bold', size: 'xl', wrap: true },
          ...(card.lines ?? []).map((line) =>
            line.label
              ? {
                  type: 'box',
                  layout: 'baseline',
                  spacing: 'md',
                  contents: [
                    { type: 'text', text: line.label, size: 'md', color: '#888888', flex: 2 },
                    { type: 'text', text: plain(line.text), size: 'lg', wrap: true, flex: 7 },
                  ],
                }
              : { type: 'text', text: plain(line.text), size: 'lg', wrap: true },
          ),
        ],
      },
      ...(actions.length > 0 ? { footer: buttonBox(actions) } : {}),
    },
  };
}

const MAX_TEXT = 5000;
const MAX_MESSAGES = 5;

/** Postback payloads the gateway understands. LINE allows 300 characters. */
export const postback = {
  decision: (taskId: string, requestId: string, approved: boolean) => `d|${taskId}|${requestId}|${approved ? 1 : 0}`,
  feedback: (taskId: string, value: 'up' | 'down') => `f|${taskId}|${value}`,
};

/** LINE shows markdown literally, so strip the marks Claude sometimes still uses. */
function plain(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '・')
    .trim();
}

function textMessage(text: string): LineMessage {
  return { type: 'text', text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text };
}

/** Splits on blank lines so each LINE bubble stays readable; never more than LINE's five per call. */
function bubbles(text: string): LineMessage[] {
  const parts: string[] = [];
  for (const para of plain(text).split(/\n{2,}/)) {
    const last = parts.length - 1;
    if (last >= 0 && parts.length >= MAX_MESSAGES) parts[last] += `\n\n${para}`;
    else if (last >= 0 && (parts[last]?.length ?? 0) + para.length < 280) parts[last] += `\n\n${para}`;
    else parts.push(para);
  }
  return parts.filter(Boolean).map(textMessage);
}

function approvalCard(out: Extract<Outgoing, { kind: 'approval' }>): LineMessage {
  const button = (label: string, approved: boolean, style: 'primary' | 'secondary') => ({
    type: 'button',
    style,
    height: 'md',
    action: { type: 'postback', label, displayText: label, data: postback.decision(out.taskId, out.requestId, approved) },
  });
  return {
    type: 'flex',
    altText: `請確認：${out.title}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '請您確認', size: 'md', color: '#888888' },
          { type: 'text', text: out.title, weight: 'bold', size: 'xl', wrap: true },
          { type: 'text', text: plain(out.detail), size: 'lg', wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [button('好，請進行', true, 'primary'), button('先不要', false, 'secondary')],
      },
    },
  };
}

function calendarCard(event: CalendarEvent): LineMessage {
  const end = event.end ?? addMinutes(event.start, 60);
  const row = (label: string, value: string) => ({
    type: 'box',
    layout: 'baseline',
    spacing: 'md',
    contents: [
      { type: 'text', text: label, size: 'md', color: '#888888', flex: 2 },
      { type: 'text', text: value, size: 'lg', wrap: true, flex: 7 },
    ],
  });
  const sameDay = end.slice(0, 10) === event.start.slice(0, 10);
  const rows = [row('時間', `${spoken(event.start)}\n到 ${sameDay ? clock(end) : spoken(end)}`)];
  if (event.location) rows.push(row('地點', event.location));
  if (event.notes) rows.push(row('備註', event.notes));
  return {
    type: 'flex',
    altText: `📅 ${event.title}：${spoken(event.start)}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '📅 行程', size: 'md', color: '#888888' },
          { type: 'text', text: event.title, weight: 'bold', size: 'xl', wrap: true },
          ...rows,
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'primary',
            height: 'md',
            action: { type: 'uri', label: '加到 Google 日曆', uri: googleCalendarLink({ ...event, end }) },
          },
        ],
      },
    },
  };
}

function connectCard(out: Extract<Outgoing, { kind: 'connect' }>): LineMessage {
  return {
    type: 'flex',
    altText: '連結 Google 帳號',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '連結 Google 帳號', weight: 'bold', size: 'xl' },
          { type: 'text', text: plain(out.reason), size: 'lg', wrap: true },
          {
            type: 'text',
            text: '會打開 Google 自己的登入頁。Piko 看不到你的密碼，隨時可以在 Google 帳號裡取消。',
            size: 'sm',
            color: '#888888',
            wrap: true,
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'button', style: 'primary', height: 'md', action: { type: 'uri', label: '用 Google 登入', uri: connectLink(out.userId, out.taskId) } },
        ],
      },
    },
  };
}

/**
 * Asks the user to take over the computer. The button carries a single-use ticket (src/takeover.ts); without
 * one (the takeover was already opened) the card only explains. Quick replies let them answer in the chat.
 */
function takeoverCard(out: Extract<Outgoing, { kind: 'takeover' }>): LineMessage {
  const message: LineMessage = {
    type: 'flex',
    altText: `換你操作一下：${plain(out.reason).slice(0, 80)}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '🖐️ 換你操作一下', weight: 'bold', size: 'xl' },
          { type: 'text', text: plain(out.reason), size: 'lg', wrap: true },
          {
            type: 'text',
            text: '按下去會看到 Piko 的電腦畫面。你操作的時候 Piko 會完全停下來，看不到畫面，也收不到你打的字。好了按「完成」交還給 Piko。',
            size: 'sm',
            color: '#888888',
            wrap: true,
          },
          { type: 'text', text: '連結 10 分鐘內有效，只能用一次，只有你本人能打開。', size: 'xs', color: '#AAAAAA', wrap: true },
        ],
      },
      ...(out.link
        ? {
            footer: {
              type: 'box',
              layout: 'vertical',
              contents: [{ type: 'button', style: 'primary', height: 'md', action: { type: 'uri', label: '打開電腦畫面', uri: out.link } }],
            },
          }
        : {}),
    },
  };
  message.quickReply = {
    items: ['我弄好了', '先不用了'].map((text) => ({ type: 'action', action: { type: 'message', label: text, text } })),
  };
  return message;
}

export function render(out: Outgoing): LineMessage[] {
  switch (out.kind) {
    case 'text':
      return bubbles(out.text);
    case 'still_working':
      return [textMessage('收到了！我正在幫您處理，好了馬上告訴您 🙏')];
    case 'question': {
      const message = textMessage(plain(out.question));
      if (out.options.length > 0) {
        message.quickReply = {
          items: out.options.slice(0, 13).map((option) => ({
            type: 'action',
            action: { type: 'message', label: option.slice(0, 20), text: option },
          })),
        };
      }
      return [message];
    }
    case 'approval':
      return [approvalCard(out)];
    case 'calendar':
      return [calendarCard(out.event)];
    case 'places':
      return [placesCarousel(out.places)];
    case 'card':
      return [genericCard(out.card)];
    case 'connect':
      return [connectCard(out)];
    case 'image':
      return [
        { type: 'image', originalContentUrl: out.url, previewImageUrl: out.previewUrl },
        ...(out.caption ? [textMessage(plain(out.caption))] : []),
      ];
    case 'file':
      return [
        genericCard({
          title: `📄 ${out.name}`,
          lines: out.caption ? [{ text: out.caption }] : [],
          buttons: [{ label: '打開', kind: 'link', value: out.url }],
        }),
      ];
    case 'reminder':
      return [textMessage(`⏰ 提醒您：${plain(out.text)}`)];
    case 'takeover':
      return [takeoverCard(out)];
    case 'final': {
      const messages = bubbles(out.text);
      const last = messages.at(-1);
      if (last) {
        const feedback = (label: string, value: 'up' | 'down') => ({
          type: 'action',
          action: { type: 'postback', label, displayText: label, data: postback.feedback(out.taskId, value) },
        });
        last.quickReply = { items: [feedback('👍 有幫到我', 'up'), feedback('👎 沒幫到', 'down')] };
      }
      return messages;
    }
  }
}
