// The tools Piko's model can call. Three kinds:
//   - server tools Anthropic runs (web_search, web_fetch): results arrive inside the model's own response;
//   - client tools the harness runs (memory): executed by the runTool activity;
//   - conversation tools the workflow itself handles (ask_user, request_approval, send_update, update_plan),
//     because they pause the task, wait for the user, or change the task's own state.
// The list order is fixed: it is part of the cached prompt prefix.
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

export const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  {
    type: 'web_search_20260209',
    name: 'web_search',
    max_uses: 6,
    user_location: { type: 'approximate', country: 'TW', timezone: 'Asia/Taipei' },
  },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6 },
  { type: 'memory_20250818', name: 'memory' },
  // Piko's own computer (a Linux desktop per user), with Anthropic's trained tools. See src/box/.
  { type: 'computer_toolset_20260801' },
  { type: 'bash_20250124', name: 'bash' },
  { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' },
  {
    name: 'share_file',
    description:
      'Send the user a file from your computer: a picture appears in the chat; a PDF, Word, Excel, PowerPoint, ' +
      'video or text file arrives as a link they can open. Use it to deliver what you made or downloaded.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path on your computer, e.g. /home/agent/outbox/chart.png.' },
        caption: { type: 'string', description: 'One short line shown with it.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'show_screen',
    description: 'Send the user a picture of your computer’s screen right now, e.g. a confirmation page or a result.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: { caption: { type: 'string', description: 'One short line shown with it.' } },
    },
  },
  {
    name: 'ask_user',
    description:
      'Ask the user one short question when you need information only they have, then wait for their answer. ' +
      'Offer two to four short options they can tap (each at most 20 characters), unless the answer must be free text.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One short question in the user’s language.' },
        options: { type: 'array', items: { type: 'string' }, description: 'Two to four tap-able answers.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'request_approval',
    description:
      'Ask the user to approve one specific action before you take it. Required before anything that reaches other ' +
      'people, spends money, books, registers, sends, deletes, or changes an account. Returns whether they approved.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The action in a few words, e.g. 「幫您訂位：鼎泰豐 信義店」.' },
        detail: { type: 'string', description: 'Exactly what will happen: who, when, how much, where.' },
      },
      required: ['title', 'detail'],
    },
  },
  {
    name: 'send_update',
    description: 'Tell the user what you are doing during a long task. Use at most once per task, and only if the task will take more than a few minutes.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'One or two short sentences.' } },
      required: ['text'],
    },
  },
  {
    name: 'add_to_calendar',
    description:
      'Put an event on the user’s calendar. Sends a card with the event and a one-tap 「加到 Google 日曆」 button that ' +
      'opens Google Calendar with everything filled in; the user taps it once to save. Use this whenever the user ' +
      'wants something on their calendar or schedule. If you do not know the date or time, ask with ask_user first.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short event title, e.g. 「台大打球」.' },
        start: { type: 'string', description: 'Start in Taiwan time, formatted 2026-10-26T16:00.' },
        end: { type: 'string', description: 'End in Taiwan time, same format. Defaults to one hour after the start.' },
        location: { type: 'string', description: 'Place name or address, if known.' },
        notes: { type: 'string', description: 'Anything useful to see in the event: what to bring, phone numbers.' },
      },
      required: ['title', 'start'],
    },
  },
  {
    name: 'show_places',
    description:
      'Show places (restaurants, clinics, shops, stations, parks) as swipeable cards, each with 「導航」 (opens Google ' +
      'Maps) and, when a phone number is known, 「打電話」 buttons. Use it whenever your answer recommends or names ' +
      'places the user might go to or call, then keep your text reply to a short sentence or two.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        places: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              address: { type: 'string', description: 'Full address if known; it makes the map link precise.' },
              phone: { type: 'string', description: 'Phone number as listed, e.g. 07-123-4567.' },
              note: { type: 'string', description: 'One line on why it fits: hours, price, what is good there.' },
              url: { type: 'string', description: 'Official https page, if any.' },
            },
            required: ['name'],
          },
        },
      },
      required: ['places'],
    },
  },
  {
    name: 'show_card',
    description:
      'Show information as a card with up to four buttons, so the user taps instead of typing or copying: open a ' +
      'link, call a number, open a map, or reply with a preset answer. Use it for anything with a next step: a ' +
      'website to open, a number to call, a form, a summary they will want to keep.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        lines: {
          type: 'array',
          description: 'Short lines; an optional label shows on the left (e.g. 時間, 地點, 費用).',
          items: { type: 'object', properties: { label: { type: 'string' }, text: { type: 'string' } }, required: ['text'] },
        },
        buttons: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'At most 20 characters.' },
              kind: { type: 'string', enum: ['link', 'call', 'map', 'reply'] },
              value: { type: 'string', description: 'link: https URL · call: phone number · map: place or address · reply: the text to send.' },
            },
            required: ['label', 'kind', 'value'],
          },
        },
        image_url: { type: 'string', description: 'Optional https image shown at the top.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'set_reminder',
    description:
      'Have Piko send the user a LINE message at a set time: to leave for an appointment, take medicine, call ' +
      'someone. It is delivered even if nothing else happens in between. Use it when they ask to be reminded, and ' +
      'offer it for anything time-sensitive.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The reminder exactly as the user should read it, e.g. 「該出發去台大打球了，記得帶球拍！」' },
        at: { type: 'string', description: 'When to send it, in Taiwan time, formatted 2026-10-26T15:30.' },
      },
      required: ['text', 'at'],
    },
  },
  {
    name: 'connect_google',
    description:
      'Ask the user to connect their Google account (Google Calendar) so Piko can put events straight into their ' +
      'calendar and read their schedule. Sends a 「用 Google 登入」 button: they sign in on Google’s own page (Piko ' +
      'never sees the password) and come back to LINE. Waits until they finish. Only use it when a job needs it.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'One sentence: what connecting lets you do for them right now.' } },
      required: ['reason'],
    },
  },
  {
    name: 'request_takeover',
    description:
      'Hand your computer to the user for a few minutes, for anything only they should type or pass: signing in ' +
      'to a site (Facebook, a bank, a government portal), a verification code, a CAPTCHA. First open the page on ' +
      'your computer. They get a 「打開電腦畫面」 button showing your screen on their phone; while they have it you ' +
      'are fully stopped and see nothing. Waits until they hand it back (or 30 minutes). Sign-ins stay on your ' +
      'computer, so check whether they are already signed in before asking.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'One or two short sentences in their language: what to do on the screen, e.g. 「請登入你的 Facebook，登入好按完成。」',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'google_calendar_add',
    description: 'Add an event directly to the user’s Google Calendar. Needs a connected Google account.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start: { type: 'string', description: 'Taiwan time, formatted 2026-10-26T16:00.' },
        end: { type: 'string', description: 'Taiwan time, same format. Defaults to one hour after the start.' },
        location: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['title', 'start'],
    },
  },
  {
    name: 'google_calendar_list',
    description: 'List the events in the user’s Google Calendar between two times. Needs a connected Google account.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Taiwan time, formatted 2026-10-26T00:00.' },
        to: { type: 'string', description: 'Taiwan time, same format.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'update_plan',
    description: 'Write or update the checklist for a multi-step task. Send the whole list every time.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              status: { type: 'string', enum: ['todo', 'doing', 'done'] },
            },
            required: ['title', 'status'],
          },
        },
      },
      required: ['items'],
    },
  },
];

/**
 * Runtime checks for tool inputs. With eager input streaming the API no longer validates them, and the SDK's
 * tolerant parser can hand back a silently truncated object, so every call is checked before it runs.
 */
const taiwanTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'use the format 2026-10-26T16:00');

export const INPUTS = {
  share_file: z.object({ path: z.string().min(1), caption: z.string().optional() }),
  show_screen: z.object({ caption: z.string().optional() }),
  ask_user: z.object({ question: z.string().min(1), options: z.array(z.string().min(1)).max(4).default([]) }),
  add_to_calendar: z.object({
    title: z.string().min(1),
    start: taiwanTime,
    end: taiwanTime.optional(),
    location: z.string().optional(),
    notes: z.string().optional(),
  }),
  set_reminder: z.object({ text: z.string().min(1), at: taiwanTime }),
  connect_google: z.object({ reason: z.string().min(1) }),
  request_takeover: z.object({ reason: z.string().min(1).max(300) }),
  google_calendar_add: z.object({
    title: z.string().min(1),
    start: taiwanTime,
    end: taiwanTime.optional(),
    location: z.string().optional(),
    notes: z.string().optional(),
  }),
  google_calendar_list: z.object({ from: taiwanTime, to: taiwanTime }),
  show_places: z.object({
    places: z
      .array(
        z.object({
          name: z.string().min(1),
          address: z.string().optional(),
          phone: z.string().optional(),
          note: z.string().optional(),
          url: z.string().optional(),
        }),
      )
      .min(1)
      .max(10),
  }),
  show_card: z.object({
    title: z.string().min(1),
    lines: z.array(z.object({ label: z.string().optional(), text: z.string().min(1) })).max(8).optional(),
    buttons: z
      .array(z.object({ label: z.string().min(1), kind: z.enum(['link', 'call', 'map', 'reply']), value: z.string().min(1) }))
      .max(4)
      .optional(),
    image_url: z.string().optional(),
  }),
  request_approval: z.object({ title: z.string().min(1), detail: z.string().min(1) }),
  send_update: z.object({ text: z.string().min(1) }),
  update_plan: z.object({
    items: z.array(z.object({ title: z.string().min(1), status: z.enum(['todo', 'doing', 'done']) })).max(15),
  }),
  memory: z.discriminatedUnion('command', [
    z.object({ command: z.literal('view'), path: z.string(), view_range: z.array(z.number().int()).length(2).optional() }),
    z.object({ command: z.literal('create'), path: z.string(), file_text: z.string() }),
    z.object({ command: z.literal('str_replace'), path: z.string(), old_str: z.string(), new_str: z.string() }),
    z.object({ command: z.literal('insert'), path: z.string(), insert_line: z.number().int().min(0), insert_text: z.string() }),
    z.object({ command: z.literal('delete'), path: z.string() }),
    z.object({ command: z.literal('rename'), old_path: z.string(), new_path: z.string() }),
  ]),
} as const;

export type ToolName = keyof typeof INPUTS;

export function isKnownTool(name: string): name is ToolName {
  return name in INPUTS;
}

/** Anthropic-defined tools: the API checks their inputs itself, and they have no schema of ours. */
export function isAnthropicTool(name: string, toolset: string | null | undefined): boolean {
  return toolset === 'computer' || name === 'bash' || name === 'str_replace_based_edit_tool';
}
