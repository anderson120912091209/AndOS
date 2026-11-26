import { AnimatePresence, motion } from 'framer-motion';
import type { TaskStep } from '@relay/shared';
import { STEP_GLYPH, elapsed } from '../lib/format.js';

const TYPE_COLOR: Record<TaskStep['type'], string> = {
  think: 'text-dim',
  act: 'text-bone',
  observe: 'text-sky',
  tool: 'text-signal',
  note: 'text-faint',
  result: 'text-good',
};

/** The machine's work, rendered as a technical log. Mono on purpose — this is the
 *  agent "thinking out loud", visually distinct from your (human) words above it. */
export function StepTimeline({ steps, startTs }: { steps: TaskStep[]; startTs: number }) {
  return (
    <ol className="relative mt-3 space-y-0.5 font-mono text-[12.5px] leading-relaxed">
      {/* the spine */}
      <span className="pointer-events-none absolute bottom-2 left-[6px] top-2 w-px bg-[rgba(236,232,225,0.08)]" />
      <AnimatePresence initial={false}>
        {steps.map((s) => (
          <motion.li
            key={s.id}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="relative flex items-start gap-3 pl-0"
          >
            <span className={`mt-[1px] w-3 shrink-0 text-center ${TYPE_COLOR[s.type]}`}>{STEP_GLYPH[s.type]}</span>
            <span className={`flex-1 ${s.type === 'result' ? 'text-good' : 'text-bone/85'}`}>
              {s.text}
            </span>
            <span className="tabular shrink-0 pt-[1px] text-[10.5px] text-faint">+{elapsed(startTs, s.ts)}</span>
          </motion.li>
        ))}
      </AnimatePresence>
    </ol>
  );
}
