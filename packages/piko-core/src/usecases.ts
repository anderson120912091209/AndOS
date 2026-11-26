/**
 * What each task was for. This is the backbone of the beta's market validation
 * (docs/plans/2026-10-26-line-agent-design.md §6).
 *
 * The front desk tags every task it opens, and every analytics event carries the tag, so the
 * weekly scorecard can say which jobs LINE users start, finish and come back for.
 *
 * Keys are analytics identifiers. Never rename or reuse one once the beta starts: add a new key
 * and leave the old one in place.
 */

/** The four v1 jobs plus plain chat. Each maps to a cost center we can move resources between. */
export const JOBS = ['research', 'errand', 'group', 'routine', 'chat'] as const;
export type Job = (typeof JOBS)[number];

export interface UseCase {
  /** Stable analytics key, namespaced by domain, e.g. `travel.plan`. */
  key: string;
  job: Job;
  /** One line in zh-TW. The front desk model reads it when it tags a task, so write it for the model. */
  hint: string;
}

/** Used when no seed use case fits. The weekly clustering of `intent` lines finds what hides in it. */
export const OTHER = 'other';

// A starting guess for 長輩, to be replaced by what the beta actually shows (the weekly intent clustering).
export const USE_CASES: readonly UseCase[] = [
  { key: 'health.booking', job: 'errand', hint: '看病掛號、預約門診、查看診進度' },
  { key: 'health.reminder', job: 'routine', hint: '吃藥、回診、量血壓的定時提醒' },
  { key: 'transit.trip', job: 'research', hint: '查公車、捷運、台鐵、高鐵的時間和怎麼去' },
  { key: 'food.reserve', job: 'errand', hint: '訂餐廳、訂位、查營業時間' },
  { key: 'safety.scam_check', job: 'chat', hint: '問某則訊息、電話、連結是不是詐騙' },
  { key: 'docs.explain', job: 'research', hint: '看懂帳單、信件、公文、藥袋上的說明' },
  { key: 'shopping.compare', job: 'research', hint: '比價、找要買的東西、查商品好不好' },
  { key: 'family.group', job: 'group', hint: '家族群組裡整理重點、約時間、分工' },
  { key: 'news.daily', job: 'routine', hint: '每天的天氣、新聞、行程提醒' },
  { key: 'howto.phone', job: 'chat', hint: '手機、LINE 怎麼用的教學' },
];

/** The tag stored on every task and sent with every analytics event. */
export interface TaskTag {
  job: Job;
  /** A key from USE_CASES, or OTHER. */
  useCase: string;
  /** One line, no personal data: what the user wanted. Input to the weekly clustering. */
  intent: string;
}

/** The seed use cases the front desk may choose from once it has picked a job. */
export function useCasesFor(job: Job): UseCase[] {
  return USE_CASES.filter((u) => u.job === job);
}

/** Maps a model-chosen tag onto known keys, so a typo never opens a new analytics bucket. */
export function normalizeTag(tag: TaskTag): TaskTag {
  const known = USE_CASES.some((u) => u.key === tag.useCase && u.job === tag.job);
  return known ? tag : { ...tag, useCase: OTHER };
}
