import type { ClassifyInput, Kind, Novelty } from './types.ts'

export const KNOWLEDGE_INSTRUCTIONS =
  'Does this conversation window teach something reusable in a future, unrelated session: how a system or tool behaves, why a fix worked, a tradeoff that was decided, a non-obvious pitfall, or a correction of a wrong assumption? Executing tasks (running commands, editing files, committing, renaming) without explaining anything is not knowledge. Details that only matter inside this one codebase are not knowledge.'

export const KIND_CRITERIA: Record<Kind, string> = {
  procedure: 'A repeatable sequence of steps or a workflow to achieve a goal.',
  fact: 'A durable fact about how a system, API, library or tool behaves.',
  correction: 'The user corrected the agent: a wrong approach, assumption, scope or style.',
  gotcha: 'A pitfall, trap or non-obvious failure mode, with how to avoid or recover from it.',
  tradeoff: 'A design or tooling decision with the reasons for choosing one option over another.',
  none: 'Nothing reusable: task execution, status updates, chit-chat or one-off details.',
}

export const NOVELTY_CRITERIA: Record<Novelty, string> = {
  new: 'No listed skill covers this topic.',
  update: 'A listed skill covers the topic but does not state this specific point.',
  duplicate: 'A listed skill already states this point.',
}

export type JevQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }

export type JevRequest = {
  model: string
  state: { window: string; skills: { name: string; description: string }[] }
  questions: Record<string, JevQuestion>
}

export function buildJevRequest(input: ClassifyInput, model = 'jev-latest'): JevRequest {
  const questions: Record<string, JevQuestion> = {
    knowledge: { type: 'noul', instructions: KNOWLEDGE_INSTRUCTIONS },
    kind: { type: 'choice', instructions: 'Which kind of knowledge does `window` mostly contain?', criteria: KIND_CRITERIA },
  }
  if (input.catalog.length) {
    questions.novelty = {
      type: 'choice',
      instructions: 'Compared with the skills listed in `skills` (name and description), how novel is the knowledge in `window`?',
      criteria: NOVELTY_CRITERIA,
    }
    const targets: Record<string, string> = {}
    for (const s of input.catalog) targets[s.name] = s.description || s.name
    targets.none = 'None of the listed skills is about this knowledge.'
    questions.target = { type: 'choice', instructions: 'Which listed skill is the right home for the knowledge in `window`?', criteria: targets }
  }
  return { model, state: { window: input.digest, skills: input.catalog }, questions }
}

export function haikuPrompt(input: ClassifyInput): string {
  const skills = input.catalog.length ? input.catalog.map((s) => `- ${s.name}: ${s.description}`).join('\n') : '(none)'
  return [
    'You classify a window of a coding-agent conversation. Answer with one JSON object and nothing else.',
    '',
    `knowledge (0..1): ${KNOWLEDGE_INSTRUCTIONS}`,
    'kind: one of ' + Object.entries(KIND_CRITERIA).map(([k, v]) => `${k} (${v})`).join('; '),
    'novelty: one of ' + Object.entries(NOVELTY_CRITERIA).map(([k, v]) => `${k} (${v})`).join('; ') + '. Use "new" when no skills are listed.',
    'target: the name of the listed skill that should hold this knowledge, or null.',
    'topics: up to 5 short lowercase topic names.',
    '',
    'Existing skills:',
    skills,
    '',
    'Window:',
    '<window>',
    input.digest,
    '</window>',
    '',
    'JSON shape: {"knowledge": 0.0, "kind": "...", "novelty": "...", "target": null, "topics": []}',
  ].join('\n')
}
