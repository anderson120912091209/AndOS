// One model turn: Claude, or with PIKO_MODEL=fake a scripted stand-in that exercises the same paths
// (a question, an approval, a final answer) so the harness can be tested without an API key.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { TOOLS } from './tools.js';

let client: Anthropic | undefined;

export async function respond(messages: Anthropic.Beta.BetaMessageParam[]): Promise<Anthropic.Beta.BetaMessage> {
  if (config.fakeModel) return fakeTurn(messages);
  client ??= new Anthropic();
  const stream = client.beta.messages.stream({
    model: config.model,
    max_tokens: 64000,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
    output_config: { effort: 'medium' },
    cache_control: { type: 'ephemeral' },
    // Screenshots pile up in long computer jobs. Old tool results are cleared on the server (the log itself is
    // never edited, which keeps earlier thinking valid); answers from the user and memory are always kept.
    context_management: {
      edits: [
        {
          type: 'clear_tool_uses_20250919',
          trigger: { type: 'input_tokens', value: 80_000 },
          keep: { type: 'tool_uses', value: 8 },
          exclude_tools: ['ask_user', 'request_approval', 'connect_google', 'request_takeover', 'memory', 'update_plan'],
        },
      ],
    },
    // On a safety decline, the API re-runs the turn on a fallback model inside the same call.
    betas: ['server-side-fallback-2026-07-01', 'context-management-2025-06-27'],
    fallbacks: 'default',
  });
  return stream.finalMessage();
}

function fakeTurn(messages: Anthropic.Beta.BetaMessageParam[]): Anthropic.Beta.BetaMessage {
  const last = messages.at(-1);
  const blocks = Array.isArray(last?.content) ? last.content : [];
  const answered = (name: string) =>
    blocks.some((b) => b.type === 'tool_result' && String(b.tool_use_id).startsWith(`fake_${name}`));
  const firstText = (() => {
    const first = messages[0]?.content;
    const block = Array.isArray(first) ? first.find((b) => b.type === 'text') : undefined;
    return block && 'text' in block ? block.text.split('\n').at(-1) ?? '' : '';
  })();
  const turn = messages.filter((m) => m.role === 'assistant').length;
  const tool = (name: string, input: unknown): Anthropic.Beta.BetaContentBlock =>
    ({ type: 'tool_use', id: `fake_${name}_${turn}`, name, input }) as Anthropic.Beta.BetaContentBlock;
  const text = (t: string): Anthropic.Beta.BetaContentBlock => ({ type: 'text', text: t }) as Anthropic.Beta.BetaContentBlock;

  let content: Anthropic.Beta.BetaContentBlock[];
  let stop: Anthropic.Beta.BetaStopReason = 'tool_use';
  if (answered('request_takeover')) {
    content = [text('好，畫面交回來了，我接著處理（測試模式）。')];
    stop = 'end_turn';
  } else if (/登入/.test(firstText) && turn === 0) {
    content = [tool('request_takeover', { reason: '請登入測試網站，登入好按完成。' })];
  } else if (answered('request_approval')) {
    const approved = blocks.some((b) => b.type === 'tool_result' && JSON.stringify(b.content).includes('approved'));
    content = [text(approved ? '好的，已經幫您處理好了（測試模式）。' : '好的，那我就先不處理（測試模式）。')];
    stop = 'end_turn';
  } else if (answered('ask_user')) {
    content = [tool('request_approval', { title: '幫您訂位（測試）', detail: '測試餐廳，週六晚上7點，人數依您剛剛的回答。' })];
  } else if (/訂|預約/.test(firstText)) {
    content = [tool('ask_user', { question: '請問幾位呢？', options: ['2位', '4位', '6位'] })];
  } else {
    content = [text(`（測試模式）您說：「${firstText}」`)];
    stop = 'end_turn';
  }
  return {
    id: `fake_msg_${turn}`,
    type: 'message',
    role: 'assistant',
    model: 'fake',
    content,
    stop_reason: stop,
  } as unknown as Anthropic.Beta.BetaMessage;
}
