# Skillmine — specification v0.1

Status: approved design; phases 1 to 3 implemented. Date: 2026-10-07.

Skillmine mines coding-agent sessions for reusable knowledge and turns it into skills,
runbooks and agent definitions on disk. It runs live inside Claude Code as a mod and in
batch over past sessions of Claude Code, Codex CLI, Kimi CLI, OpenCode and Antigravity
(`agy`). The LLM decides what to write. Humans get an undo, not an approval queue.

## 1. Decisions

| # | Question | Decision |
|---|---|---|
| D1 | Classifier | Pluggable. One contract, Jev-shaped. Backends: TypeSafe Jev (cloud), laya-server (local checkpoints behind the same API), Haiku, session fork. |
| D2 | Autonomy boundary | Hermes rule. Skillmine rewrites only skills it created. Human-authored skills receive new reference files under `references/`, never body edits. A flag lifts this. |
| D3 | Scope | Local by default: the skill lands in the project where the lesson happened. Promoted to global when the same lesson appears in two or more projects. |
| D4 | Budget | Unlimited edits per run. Safety is the ledger, snapshots and `undo`. |
| D5 | Distribution | Public MIT repo `flaviomartil/skillmine`, installable as a Claude Code plugin marketplace like maxlearn. Standalone CLI, no dependency on any private harness. |
| D6 | Trigger | Mod, not shell hooks. Every 3 main-agent turns and after compaction, 20 minute cooldown, never mid-turn. |

## 2. Components

```
skillmine (CLI, TypeScript on bun, single binary)
  readers/        claude, codex, kimi, opencode, antigravity  -> Turn[]
  windows/        slicing + deterministic prefilter           -> Window[]
  classify/       jev-shaped client (jev | laya), haiku, fork  -> Verdict
  cluster/        group windows by topic across sessions       -> Cluster[]
  plan/           LLM planner, pluggable backend               -> Edit[]
  apply/          validate, snapshot, write, ledger            -> LedgerEntry[]
  curate/         usage sidecar, stale/archive, consolidation
  undo/           reverse one edit, one run, or the last edit

skillmine-mod (Claude Code hooks module)
  turn.complete every 3 turns -> classify -> $.model.fork planner -> skillmine apply
  /skillmine [days] -> $.process.spawn skillmine mine
  pane: ledger · stale · catalog

skills/skillmine/SKILL.md (thin skill for Codex, Kimi, OpenCode, agy)
  "/skillmine 30" -> run `skillmine mine --days 30` and report
```

The CLI is the only component that writes to disk. The mod and the thin skills call it.

## 3. Data model

```ts
type Turn = {
  ref: string            // "<client>:<session>:<message>" provenance key
  client: 'claude' | 'codex' | 'kimi' | 'opencode' | 'antigravity'
  session: string
  project: string        // cwd at the time
  ts: number
  role: 'user' | 'assistant'
  text: string
  tools: { name: string; arg: string; failed?: boolean }[]
  sidechain: boolean     // subagent or nested conversation
}

type Window = {
  id: string
  turns: Turn[]          // main thread only, 6k chars max digest
  signals: ('correction' | 'fail-then-pass' | 'explanation' | 'decision')[]
  topics?: string[]
}

type Verdict = {
  knowledge: number      // 0..1, probability the window taught something reusable
  kind: 'procedure' | 'fact' | 'correction' | 'gotcha' | 'tradeoff' | 'none'
  novelty: 'new' | 'update' | 'duplicate'
  target?: string        // existing skill name when novelty = update | duplicate
  topics: string[]
}

type Edit =
  | { action: 'create';        kind: 'skill' | 'runbook' | 'agent'; name: string; scope: 'local' | 'global'; content: string; reason: string; sources: string[] }
  | { action: 'update';        name: string; content: string; reason: string; sources: string[] }
  | { action: 'add_reference'; name: string; file: string; content: string; reason: string; sources: string[] }
  | { action: 'archive';       name: string; reason: string }

type LedgerEntry = {
  id: string; run: string; ts: number; edit: Edit
  path: string; before: string | null; after: string | null   // sha256 of content blobs
  owner: 'skillmine' | 'human'
}
```

## 4. Readers

One reader per client, all producing `Turn[]`. Subagent and nested conversations are
marked `sidechain` and dropped from windows.

| Client | Source | Notes |
|---|---|---|
| Claude Code | `~/.claude/projects/<cwd-slug>/<session>.jsonl` | `type: user | assistant`, content blocks `text | thinking | tool_use | tool_result`. Subagents live in `<session>/subagents/`. |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `session_meta` for cwd; `response_item` with `message`, `function_call`, `function_call_output`; `event_msg.user_message`. |
| Kimi CLI | legacy `~/.kimi/sessions/<md5>/<uuid>/context.jsonl`; current `~/.kimi-code/sessions/*/agents/main/wire.jsonl` | legacy is OpenAI-style roles; wire is an event stream that must be replayed. |
| OpenCode | `~/.local/share/opencode/opencode.db` | sqlite: `session`, `message(data json)`, `part(data json)` with `type: text | tool | reasoning`. |
| Antigravity (`agy`) | `~/.gemini/antigravity-cli/conversations/<uuid>.db`, `conversation_summaries.db` | `steps.step_payload` is protobuf without a published schema. A schema-less wire-format walk recovers UTF-8 string fields; verified on a real conversation. Summaries DB gives title, workspace, parent id. |

Readers are pure and cached by file mtime under `~/.skillmine/cache/`.

## 5. Windows and prefilter

Free, deterministic, runs before any model call.

- Slice each session into windows of up to 6k chars of digest, newest first inside a window.
- Digest format per turn: `role: text [tools: Bash(git push...), Edit(src/app.ts)]`, tool args cut at 60 chars.
- Keep a window only if it carries a signal:
  - `correction`: user text starts with or contains a correction marker ("no,", "não", "errado", "na verdade", "actually", "wrong", "instead").
  - `fail-then-pass`: a tool call failed and a later call with the same tool succeeded.
  - `explanation`: assistant text over 400 chars with no tool call in the same turn.
  - `decision`: assistant text containing a tradeoff or choice marker ("because", "instead of", "trade-off", "porque", "em vez de").
- Drop windows that are only tool calls, and windows about Skillmine itself.

## 6. Classifier contract

Every backend answers the same three questions over the same state. State is the window
digest plus a catalog digest: names and descriptions of existing skills whose topics match.

```json
{
  "state": { "window": "...", "catalog": [{ "name": "rtk-gotchas", "description": "..." }] },
  "questions": [
    { "id": "knowledge", "type": "noul",   "instructions": "Does this window explain something reusable in a future session: how a system works, why a fix works, a tradeoff, a tool gotcha? Pure execution (commands, renames, commits) is not knowledge." },
    { "id": "kind",      "type": "choice", "criteria": { "procedure": "...", "fact": "...", "correction": "...", "gotcha": "...", "tradeoff": "...", "none": "..." } },
    { "id": "novelty",   "type": "choice", "criteria": { "new": "no catalog entry covers it", "update": "a catalog entry covers the topic but misses this", "duplicate": "a catalog entry already says this" } }
  ]
}
```

Backends:

- `jev`: TypeSafe Jev, `POST /v1/systemone`. Batch via `jev map` over JSONL, 20 req/s.
- `laya`: laya-server, same request and response shape, selected by `SKILLMINE_CLASSIFIER_BASE_URL`. Local, no cost, no quota.
- `haiku`: one small completion returning the same JSON. Default for the live loop inside Claude Code via `$.model.complete`.
- `fork`: `$.model.fork` over the session cache. Free-ish, Claude Code only.

Thresholds: `knowledge >= 0.6` proceeds. `novelty = duplicate` stops unless `kind = correction`
(a correction about an existing skill is always worth a planner look). Thresholds are
calibrated once against labelled data from the user's existing promotion ledger.

## 7. Clustering (batch only)

Windows that pass the gate are grouped before planning so the same lesson learned ten
times yields one edit. Group key: `novelty.target` when set, otherwise the top topic.
Within a cluster the planner sees the three windows with the strongest signals and a
count of the rest. A lesson seen in two or more distinct `project` values is marked
`scope: global`.

## 8. Planner

The planner is the LLM. Backend is configurable: `claude -p`, `codex exec`, `agy`, `kimi`,
`opencode run`, or an API key. In the Claude Code mod the backend is `$.model.fork`.

Input: the cluster digest, the full current content of the target skill when
`novelty = update`, the catalog digest, and the last 20 ledger entries.

Output: strict JSON `{ summary, edits: Edit[] }`. An empty `edits` array is a valid and
encouraged answer.

Prompt rules, in priority order (Hermes preference order, Prime constraints):

1. Update the skill that was loaded or targeted.
2. Update an existing umbrella skill on the same class of problem.
3. Add a reference file under an existing skill.
4. Create a new class-level skill. Its name describes a class of situations, never a
   ticket, PR, error string or date.
5. Lessons, not logs. A pitfall is one generalizable rule plus one clause of why.
6. The same lesson learned twice is one rule. Fix the misleading sentence in place, never
   append "UPDATE: actually".
7. Do not capture: environment-dependent failures, negative claims about tools ("X is
   broken"), transient errors that resolved themselves, unresolved attempts written up as
   workflows, anything specific to one codebase unless `scope: local`.
8. Never write secret values. Write where a secret lives, not what it is.
9. Prefer an empty edit list over a speculative one.

## 9. Apply

The only code path that writes. Deterministic.

Validation per edit, failure rejects the edit and records it in the ledger as `rejected`:

- Frontmatter has `name` and a one-sentence `description` of 250 characters or less.
- Body under 24k characters. No ticket IDs, dates, PR numbers or quoted user text.
- No secret-shaped strings (tokens, keys, connection strings).
- `update` requires the target to exist and its current sha256 to match what the planner
  read (read-before-write). `create` requires the name to be free.
- Ownership (D2): `update` and `archive` only on skills whose frontmatter has
  `created_by: skillmine`. On a human-authored skill the edit is downgraded to
  `add_reference`.

Write path:

1. Pre-run `tar.gz` snapshot of every target skills tree into `~/.skillmine/backups/`,
   keep the last two.
2. Store `before` and `after` content as sha256-addressed blobs under
   `~/.skillmine/blobs/`.
3. Atomic write (temp file, rename), mode 0644.
4. Append `LedgerEntry` to `~/.skillmine/ledger.jsonl`.
5. Provenance frontmatter on every written skill:

```yaml
---
name: pnpm-workspace-gotchas
description: Pitfalls when running scripts inside a pnpm monorepo.
created_by: skillmine
scope: local
sources:
  - claude:76b7bbde:ab12cd
  - codex:rollout-2026-10-03:f0e1
updated_at: 2026-10-07
---
```

Targets (D3):

- Local: `<project>/.agents/skills/<name>/SKILL.md`, plus a symlink or copy into the
  client-specific dir the project uses (`.claude/skills` today; others as they add support).
- Global: `~/.agents/skills/<name>/SKILL.md`. Clients that read their own dir get a
  symlink (`~/.claude/skills`, `~/.codex/skills`, `~/.kimi/skills`, `~/.gemini/skills`,
  `~/.config/opencode/skills`).
- Config `post_apply` runs a command after a successful run so an external compiler or
  harness can pick the changes up without Skillmine knowing about it.

Runbooks and agents use the same path with `kind: runbook | agent`, written as
`RUNBOOK.md` or `AGENT.md` next to a `SKILL.md`-style frontmatter. A client without a
native agent format gets them as skills.

## 10. Undo and curate

- `skillmine undo --last | <edit-id> | --run <run-id>`: restores `before` blobs, deletes
  `create` results, records the reversal as a new ledger entry with `rollback_of`. Fails
  closed if the current file no longer matches `after`.
- Usage sidecar `.usage.json` per skill: `use_count`, `last_used_at`, `patch_count`,
  `pinned`. The mod increments it from the `skill.prompt` event in Claude Code; batch runs
  increment it by scanning transcripts of the other clients for skill invocations.
- `skillmine curate`: skills with no use for 14 days become `stale`, 30 days `archived`
  (moved to `.archive/`, never deleted). Pinned and human-authored skills are exempt.
  Optional LLM consolidation proposes umbrella merges as ordinary `Edit`s through the
  same apply path.

## 11. CLI

```
skillmine mine [--days 30] [--clients all|claude,codex,...] [--project <path>] [--dry] [--classifier jev|laya|haiku] [--planner claude|codex|agy|kimi|opencode]
skillmine apply --edits <file|->          # used by the mod
skillmine classify --window <file|->      # one window, prints Verdict
skillmine undo --last | <id> | --run <id>
skillmine ledger [--run <id>] [--limit 50]
skillmine curate [--dry] [--stale-days 14] [--archive-days 30] [--clients ...]   # usage scan + stale/archive
skillmine pin <skill> | unpin <skill>     # exempt a mined skill from decay
skillmine touch <skill>                   # record one use; the mod calls it on skill.prompt
skillmine install-skill [--from <dir>]    # link clients/skillmine into Codex, Kimi, OpenCode, Antigravity skill dirs
skillmine gate --client <c> --session <id> [--project <p>] [--every 3] [--cooldown 20] [--force]
                                          # live gate for clients without a mod API, spawned detached by a Stop hook
skillmine doctor                          # readers found, classifier reachable, targets writable
```

`gate` keeps per-session state (`stops`, `gatedTurns`, `lastPlanned`) under
`~/.skillmine/gate/` and a lock per session. Only every Nth stop reaches the classifier;
rejected turns are consumed, turns blocked by the cooldown are kept for the next gate.
It is the same pipeline as the mod's live check, run as a subprocess.

### Adapter layout (per client)

| Client | Live loop | `/skillmine N` |
|---|---|---|
| Claude Code | mod, in process (`hooks/register.tsx`) | mod command |
| OpenCode | OpenCode plugin calls the shared dispatcher on `stop`, which spawns `skillmine gate` | thin skill |
| Codex, Kimi, Antigravity | Stop hook (`ai-harness-hook`) spawns `skillmine gate` detached | thin skill |

The CLI is the only engine. Adapters never contain pipeline logic.

Usage lives in `.usage.json` beside each mined `SKILL.md`: `use_count`, `last_used_at`,
`patch_count`, `pinned`, `first_seen_at`, `status`, `scanned_until`. The mod records a
use on every `skill.prompt` event through `skillmine touch`; `curate` scans the other
clients' transcripts for `Skill`-style tool calls, reads of `skills/<name>/SKILL.md` and
`/<name>` prompts, and only counts stamps newer than the previous scan. Patches by
Skillmine raise `patch_count`, never `use_count`. Idleness is measured from the latest of
`last_used_at`, the ledger `create` time and `first_seen_at`; an archive is an ordinary
`archive` edit through `applyEdits`, so it is validated, snapshotted, logged and undoable.

`mine --dry` prints sessions scanned, windows kept per signal, clusters with sample
digests and the catalog matches. No planner call. Always the first run on a new machine.

## 12. Claude Code mod

Adapted from maxlearn's shell. Kept: `gate.ts` digest and parser, `turn.complete`
cadence, `generate()` queue, `$.store` persistence, pane and statusline patterns.
Dropped: scheduling, lessons, quiz, analytics. Added: `$.fs` and `$.process` use, which
the engine exposes and maxlearn does not use.

- `turn.complete` (main agent, not aborted): every 3 turns, also once after
  `session.compact`, 20 minute cooldown. Build the digest from fresh rows, run the
  classifier (`haiku` default, `jev` or `laya` when configured, `fork` when cheap).
- On a pass: `$.model.fork` with the planner prompt and catalog digest, parse `Edit[]`,
  `$.process.run(["skillmine", "apply", "--edits", "-"])`. Toast the result with the undo
  key. Statusline shows edits this session and stale count.
- `/skillmine [days]`: `$.process.spawn` of `skillmine mine --days N`, progress in the
  statusline, summary in the pane when done.
- Pane tabs: `ledger` (recent edits, `u` undoes the highlighted one), `stale`, `catalog`
  (skills per scope and client, duplicates by description similarity).
- Settings: classifier, planner model, cadence, cooldown, ownership flag (D2 override),
  `post_apply` command.

## 13. Phases

1. CLI skeleton, five readers, `mine --dry`. No model calls. Exit: statistics over the
   last 30 days on the author's machine match a manual spot check of 20 windows.
2. Classifier backends `jev`, `laya`, `haiku`. Calibrate `knowledge` threshold against the
   existing promotion ledger (promoted = positive, rejected = negative).
3. Planner, apply, ledger, backups, undo. First real `skillmine mine --days 30`.
4. Claude Code mod: live loop, pane, undo toast, `/skillmine`.
5. Thin `/skillmine` skill for Codex, Kimi, OpenCode and agy.
6. Curate: usage sidecar, stale and archive, consolidation.

## 14. Non-goals

- No approval inbox by default. A `pending` mode exists for people who want one.
- No flashcards, lessons or spaced repetition.
- No editing of CLAUDE.md, AGENTS.md or client settings. Skills, runbooks and agents only.
- No network calls except the configured classifier and planner.

## 15. Prior art and what was borrowed

- maxlearn (MIT): turn cadence, gate digest, fork-from-cache, pane shell.
- Prime Agent `/refine` (MIT): typed edits, deterministic validation, before/after
  snapshots, mechanical rollback, cooldown and compaction trigger, "prefer empty edits".
- Hermes Agent (MIT): preference order, lessons-not-logs, do-not-capture list, provenance
  and ownership rule, read-before-write guard, usage sidecar, stale/archive curator.
- Kulaxyz/self-learning-skills (MIT): three-condition promotion rule, kept as a planner
  hint for `create`.
- obra/episodic-memory (MIT): drop sidechains, skip meta-conversations about the tool.
- TypeSafe Jev and laya-server: calibrated, typed classification at negligible cost.
