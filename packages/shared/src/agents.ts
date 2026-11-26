// Relay's agents — a small cast of characters who live in the notch, each good at one kind of
// work. You never pick one or set one up: Relay reads what you asked (in any language) and
// where you were, and the right one shows up. Relay, the main agent, takes everything that
// isn't clearly someone else's — your mail included.
//
// The cast is drawn natively (apps/mac Agent/AgentCharacter.swift); this file is who they are
// and how one gets chosen, shared by the server, the worker and the Command Center.

import type { Pointer } from './pointer.js';

export type AgentId = 'relay' | 'scout' | 'tock' | 'quill' | 'echo' | 'chirp';

export interface Agent {
  id: AgentId;
  name: string;
  /** what it's for, in a few words */
  role: string;
  /** body colour, for anything that draws them */
  color: string;
}

export const CAST: Readonly<Record<AgentId, Agent>> = {
  relay: { id: 'relay', name: 'Relay', role: 'Your main agent — mail, errands, anything', color: '#E5493A' },
  scout: { id: 'scout', name: 'Scout', role: 'Research — looks things up and compares', color: '#34D399' },
  tock: { id: 'tock', name: 'Tock', role: 'Your calendar — meetings and plans', color: '#60A5FA' },
  quill: { id: 'quill', name: 'Quill', role: 'Writing — docs, posts, long pieces', color: '#A78BFA' },
  echo: { id: 'echo', name: 'Echo', role: 'Calls — recaps, decisions, follow-ups', color: '#FB923C' },
  chirp: { id: 'chirp', name: 'Chirp', role: 'Messages — Slack, WhatsApp, DMs', color: '#F472B6' },
};

/** What a request is about. */
export type Topic = 'mail' | 'research' | 'schedule' | 'writing' | 'calls' | 'messages';

export interface AgentSignals {
  /** what the words talk about (several can match: "research CRMs and email Sam") */
  topics: ReadonlySet<Topic>;
  /** what the place you were pointing at is — a Gmail thread is mail, a Slack channel messages */
  place?: Topic;
}

// Words, in English and Chinese (simplified and traditional — you code-switch mid-sentence).
// `\b` doesn't work around CJK, so the Chinese alternatives stand on their own.
const TOPIC_WORDS: Record<Topic, RegExp> = {
  mail: /\b(e-?mails?|inbox|gmail|mail|unread|reply to|forward)\b|郵件|邮件|信箱|收件匣|收件箱|回信|寄信|電郵|电邮/i,
  research:
    /\b(research|look (?:up|into)|find out|compare|comparison|investigate|dig into|pros and cons|competitors?|market|best \w+ for|top \d+)\b|研究|調查|调查|比較|比较|查一下|查查|找資料|找资料|搜尋|搜索|分析/i,
  schedule:
    /\b(schedule|calendar|book (?:a|some) (?:time|slot|meeting)|availability|free slot|reschedule|set up a (?:meeting|call)|meet with|invite)\b|行事曆|行事历|日曆|日历|約時間|约时间|預約|预约|開會|开会|排程|改期|安排會議|安排会议/i,
  writing:
    /\b(write|draft|blog|post|essay|article|doc(?:ument)?|outline|rewrite|polish|memo|report|proposal|pitch)\b|寫|写|草稿|文章|文件|大綱|大纲|報告|报告|改寫|改写|潤飾|润色|提案/i,
  calls:
    /\b(calls?|transcripts?|recordings?|meeting notes|recap|what did (?:we|they|he|she) (?:say|decide|agree)|fathom|zoom|standup)\b|通話|通话|錄音|录音|會議記錄|会议记录|逐字稿|那通電話|那通电话/i,
  messages:
    /\b(slack|whatsapp|telegram|imessage|dms?|direct message|messages?|text (?:him|her|them)|channel|ping)\b|訊息|讯息|私訊|私讯|傳訊|传讯|頻道|频道|群組|群组/i,
};

/** Where you were pointing, by service and kind — see pointer.ts. */
function placeOf(pointer: Pointer | undefined): Topic | undefined {
  if (!pointer) return undefined;
  switch (pointer.service) {
    case 'gmail':
      return 'mail';
    case 'slack':
      return 'messages';
    case 'fathom':
      return 'calls';
    case 'google-docs':
    case 'notion':
      return 'writing';
    default:
      return undefined;
  }
}

/** Read a request for what it's about: its words, and the place you were looking at. */
export function agentSignals(utterance: string, pointer?: Pointer): AgentSignals {
  const topics = new Set<Topic>();
  for (const [topic, words] of Object.entries(TOPIC_WORDS) as [Topic, RegExp][]) {
    if (words.test(utterance)) topics.add(topic);
  }
  return { topics, place: placeOf(pointer) };
}

/**
 * Who takes this request. Relay (the main agent) unless it's clearly someone else's work —
 * "find me the email from Sam" is Relay's.
 */
export function pickAgent(signals: AgentSignals): AgentId {
  // TODO(human): decide which agent takes the request from its topics and place.
  return 'relay';
}

/** The agent for a request, from what was said and where. */
export function agentFor(utterance: string, pointer?: Pointer): AgentId {
  return pickAgent(agentSignals(utterance, pointer));
}
