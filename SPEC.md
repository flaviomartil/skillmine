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

- Frontmatter has `name` and a one-sentence `description` of 250 characters or less, on a
  single line, with no secret-shaped string or TODO placeholder in it.
- Body under 24k characters and 300 non-blank lines (`SKILLMINE_BODY_MAX_LINES`, read when
  the check runs; the planner prompt states the same number). No
  ticket IDs, dates, PR numbers, quoted user text or TODO placeholders.
- Every source is free of control characters, newlines and the sequence `-->`, on every
  action, because sources are written into frontmatter and the reference header.
- No secret-shaped strings (tokens, keys, connection strings): `sk-`/`sk_` keys including
  `sk-ant-` and `sk-proj-`, GitHub and AWS keys, bearer tokens, private keys, credential URLs,
  and assignments to `password`, `secret`, `token`, `api_key` or `client_secret` names, with
  or without a prefix or suffix (`DB_PASSWORD=`, `AWS_SECRET_ACCESS_KEY=`, `NPM_TOKEN=`).
  A value that is an environment reference (`process.env.X`, `$X`, `${X}`) is not flagged.
  The same scan runs on every source string, and a rejected entry's ledger record drops any
  source that tripped a check. A rejection names only the
  pattern (`sk-...`, `ghp_...`, `password`, `credential_url` for `scheme://user:password@host`),
  never any part of the matched value.
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

### 9.1 Promoter lint as the sole writer

`applyEdits` in `src/apply/writer.ts` is the only code path that creates or changes a
skill file. Every edit passes `validateEdit` first, and every `create` or `update` also
passes `lintRendered` on the final rendered file just before the atomic write: frontmatter
parses, `name` and `description` are present, a new skill's name and description meet the
limits above, the body stays under the line cap, the whole text has no secret, and neither
the description nor the body has a placeholder (the description is checked on `update`
too). The description is written so that parsing the file returns exactly the string that
was measured: double-quoted values are JSON-escaped and `parseFrontmatter` unescapes them.
Sources are written as JSON-quoted list items and read back by a parser that looks only
inside the frontmatter block, so body bullets are never taken for sources. A lint failure
after rendering is recorded as `rejected` with an error that starts with `lint:`; nothing is
written. Rejections, pinned-skill archive refusals and failures all append a ledger entry
through `Store`, so no write attempt leaves no trace. An archive edit against a pinned skill
is rejected by the writer itself, not only by `curate`. That check runs right before the
archive, after the backup, and it fails closed: if `.usage.json` exists but cannot be parsed,
the archive is refused. `curate` reports such a skill with its own verdict, `unreadable`,
never archives it and does not rewrite the sidecar. `pin`, `unpin` and `touch` use the same
strict reader: `pin` and `unpin` exit non-zero with a message, `touch` skips the write.
The archive hashes `SKILL.md` before it moves the directory. If a step after the move
fails, the writer renames the directory back and records a `failed` entry; if the rename
back also fails, the skill really is archived, so it records an `applied` entry with
`archivedTo` and a note, and `skillmine undo --run <id>` restores it. Removing a fanout
symlink fails loudly on anything other than a missing path. An archive of a human-authored
skill (with `--allow-human-edits`) records the owner as `human`. `update` keeps the newest
20 sources. Temp files from a failed atomic write are removed. An `update` is refused with
`frontmatter not flat` (recorded as `rejected`, nothing rewritten) when the existing
frontmatter is anything other than plain `key: value` lines plus the `sources` list: block
scalars, nested maps, other lists and comments all count. `add_reference` refuses to replace
an existing references file unless its content already equals the new text or the ledger
shows an applied skillmine write whose `after` hash is the file's current content, so a file
a human wrote or edited afterwards is never overwritten. `update` records the owner as
`human` for a human skill edited with `--allow-human-edits`. `skillmine undo` of an archive
also recreates the fanout symlinks recorded in the entry. Backups run `tar -czh ... --`, so a
symlinked skill is archived as its contents and a folder name that looks like an option is
safe, and `tar`'s stderr is read while waiting for it to exit.

Filesystem rules in the writer: `create` refuses when `<root>/<name>/SKILL.md` already exists
on disk, whether or not the catalog knows it, and records `rejected`. If writing the file or
making its links fails, the file, the links already made and a directory the call created are
removed, so the `failed` entry is true. Archiving a local skill removes its project link
(`fanoutFor(layout, scope, project)`); relative link targets are resolved against the link's
own directory; if removing links fails midway, the links already removed are put back when
the directory is moved back. The archive stores the `before` blob it records. A pre-run
backup is made once per backed-up root and run, never overwritten by a later edit of the same
run. The root is the skills directory the skill was discovered in (the catalog root, the
parent of the discovered skill folder), never the parent of the real path, so a symlinked
skill does not pull its real parent directory into the archive; when the discovered folder
is itself a symlink, `tar -h` follows it so its contents are archived. A backup writes a `.ok` marker
after `tar` succeeds. `tar` exit code 1 (a warning such as a file that changed while it was read, or a broken link)
is accepted when the archive file exists and is not empty, and the marker is written; exit
code 2 or higher fails. (`SKILLMINE_TAR` names another `tar` binary, which the tests use.) A
failing `tar` deletes the partial archive, and an existing archive
without its marker is rebuilt instead of reused. Blobs for `before` and `after` are stored
before the file is changed. If appending the ledger entry fails, it is retried once; if it
still fails the change is reported as applied with its real path, hashes and a note, so it
is not lost. A fanout link matches the skill folder when their real paths agree, so a
symlinked skills root still matches. Names in rejected entries and error text are stripped of
control characters, capped at 80 characters and scanned for secrets (`[redacted]`).
Before the first edit of a run, every backup that the valid edits need is taken; if one fails,
the whole run is aborted before any edit, and each edit gets a `failed` ledger entry carrying
the backup error. A `create` is undone only if the skill folder holds nothing but `SKILL.md`,
`.usage.*` files and `references/` files that the ledger shows skillmine wrote (applied
`add_reference` entries for that skill, not rolled back) and whose current content hash still
equals the `after` hash of that entry; a file a human changed afterwards blocks the undo. The
check runs before any link is removed, and a recorded fanout link is only unlinked if it still
points at the skill folder (the same real-path test the archive uses).
An archive edit may carry the skill's `path` (its realpath). `applyEdits` then resolves the
target by that path, so a human skill that shares the name is never touched, and rejects the
edit with "no skill at the given path" when nothing matches; without a path it falls back to
the name. `curate` always sends the path. When the archive folder `.archive/<name>` already
exists, the skill goes to `.archive/<name>-<timestamp>`; the writer's catalog drops an archived
skill, so a later edit in the same run can create a skill with that name again. The edit's `reason` gets the same secret scan as sources, and a reason that tripped it is
left out of the ledger.
Undo is the only other code that touches skill files, and it restores ledger blobs rather
than authoring content.

Per-skill counters live in the existing `.usage.json` sidecar. Two fields were added next
to `use_count`: `offered_count` (times the skill was shown in a session-start index) and
`reject_count` (only rejections about the skill's content: a content check in `validateEdit`
such as secrets, placeholders or size, and the rendered lint). Pinned and unreadable-sidecar
archive refusals are policy and are not counted, nor are name collisions on `create`, bad
sources, ownership refusals, sha conflicts or I/O failures. A third field, `last_offered_at`,
records the latest offer. Counters are only read and written through a strict reader that
treats wrong field types (including non-numeric `scanned_until` values) as unreadable, a
failed write removes its temp file, every read-modify-write (`use`, `offered`, `reject`,
`patch`, `pin` and the `curate` write) runs inside a `.usage.lock` file created with the
exclusive `wx` flag next to the sidecar, holding the owner's pid, a timestamp and a unique
token. A waiter
backs off briefly and gives up after about two seconds with a lock-timeout error (the
deadline is checked on every pass, so the loop cannot spin). A lock is stale when its pid is
dead, when it carries no pid and is older than ten seconds, or when its pid is alive but it
is older than sixty seconds. Breaking it re-reads the file and renames it to a unique
temporary `.stale` name, so only one process wins the rename; the winner re-reads the renamed
file, deletes it when it still holds the content judged stale, and otherwise links it back to
the lock path and reports no takeover, and then the caller tries a fresh `wx` create. A
process that loses the rename sees the lock gone and retries. The holder removes
the lock only if the token in the file is still its own. `curate` re-reads the sidecar inside
the lock and applies only its own changes. A corrupt sidecar is never overwritten, and an
update never un-pins a skill by replacing it.

## 10. Undo and curate

- `skillmine undo --last | <edit-id> | --run <run-id>`: restores `before` blobs, deletes
  `create` results, records the reversal as a new ledger entry with `rollback_of`. Fails
  closed if the current file no longer matches `after`.
- Usage sidecar `.usage.json` per skill: `use_count`, `last_used_at`, `patch_count`,
  `pinned`. The mod stamps `last_used_at` from the `skill.prompt` event in Claude Code; `use_count`
  comes only from scanning the transcripts of every client for skill invocations.
- `skillmine curate`: skills with no use for 14 days become `stale`, 30 days `archived`
  (moved to `.archive/`, never deleted). Pinned and human-authored skills are exempt.
  A run with `--project` only sees that project's sessions, so it is report only: it records
  no uses, does not advance the `scanned_until` watermark, writes no status and archives
  nothing; its report says so, and `--json` carries `readOnly`. Only an unscoped run records
  uses and moves the watermark, because only it has scanned every session. The background
  reflection therefore runs `curate` without `--project` (it still mines the one project).
  Inside the locked update the verdict is recomputed from the sidecar as just re-read, and a
  skill whose locked update failed is never archived: a timed-out lock is reported `locked`,
  and any other failure (a permission error, a sidecar that cannot be parsed or has wrong
  field types) is reported `unreadable` with the error message.
  Scanned uses are matched to a skill by realpath when the use carries a path (a read of
  any `.../<folder>/SKILL.md`, whatever the folder or the frontmatter name is, with `~`, `$HOME` and `${HOME}` expanded and the rest resolved
  through symlinks and against the session's project). If that path matches no discovered
  skill at all (an old checkout, a moved folder), the use falls back to the name and counts
  when exactly one skillmine-authored skill has that name; a path that matches another
  discovered skill (a human twin) never counts for the mined one. A use that carries only a
  name (the `Skill` tool, a `/name` prompt) counts only when exactly one skillmine-authored
  skill has that name.
  The watermark is kept per client in `scanned_until`, keyed by client id (`codex`, `kimi`,
  and so on). A key advances to the newest turn timestamp scanned for that client, only for a
  client whose scan finished without a discover or read error, and never moves backwards.
  Kimi, antigravity and opencode do not give every turn its own reliable timestamp (kimi and
  antigravity stamp all turns of a session with the session file's modification time, opencode
  stamps a turn with its latest tool part), so for them a timestamp alone would recount a
  growing session. Their uses are also tracked per session in `scanned_uses`, keyed by client
  id and then session id, holding how many uses of the skill were already counted in that
  session. Only the uses past that number are counted and added, so a use is never counted
  twice and `last_used_at` does not jump when the file changes. When the session list shrinks
  (Kimi compaction or clear, OpenCode undo), the number is reset to the new length and counting
  continues from there, and a session that was scanned but no longer holds any use of the skill
  is reset to 0. A reader that exposes a stable turn id (`turnId`, which only OpenCode does:
  Kimi has none and Antigravity step indexes are reused after a truncation) also gets
  `scanned_turns`, keyed by client id and session id, holding the ids of the turns whose use
  was counted; a use is then new exactly when its turn id is not in that list, so an undo
  followed by new uses is counted correctly. Turns stamped more than 60 seconds after the
  curate run's clock are ignored: they count no use and do not advance `scanned_until`. A session without an entry yet
  counts only the uses stamped after the client's `scanned_until` value, which keeps the
  legacy watermark working. A legacy single `batch` value is used
  as the starting point for every client key and then dropped. The scan skips sessions that
  belong to the tool's own helpers (the same check `mine` uses). The scan covers
  every client, Claude included, and is the only thing that raises `use_count`. The mod's
  `skillmine touch` (run on `skill.prompt`) only stamps `last_used_at`, so a use is never
  counted twice, and a Read of any `.../<name>/SKILL.md` path counts as a use, which is how a
  skill found through the session index gets used. A client whose scan had an error
  contributes no uses that run and its watermark stays put, so a partial scan cannot re-count
  the same uses later; the report names the clients that failed (`scanErrors` in `--json`).
  If a use or a `last_used_at` stamp lands between curate's first read of a sidecar and its
  locked update, an `archive` verdict for that skill is dropped for this run, and the usage is
  checked once more right before the archive edit is built, after the lock is released. A
  failed client scan disables archiving for the whole run, and so does a run in which any
  client has no reader (for example `curate --clients claude`, or no readers at all): the
  verdicts are still reported, but no archive edit is applied, and the report and `--json`
  (`archiveDisabled`) say why (`scan incomplete for ...` or `no scan for ...`).
  The per-client watermark is the newest turn timestamp actually scanned for that client, not
  the wall-clock time, so a turn written while the scan ran is not skipped next time.
  Sidecars that cannot be read for any reason other than a lock timeout, including a failure
  in the final re-check before the archive edit, are `unreadable`, with the error message in
  the report; only a lock timeout is `locked`. Human-authored skills never receive scanned
  uses, so a human skill that shares a name takes nothing from a mined one.
  Optional LLM consolidation proposes umbrella merges as ordinary `Edit`s through the
  same apply path.

### 10.1 Opportunity-relative lifecycle

Wall-clock idleness punishes a skill that was never given a chance to be used. When a skill
has `offered_count > 0`, `curate` judges it by opportunities instead of days:

- Below the maturity threshold (default 300 offers, `SKILLMINE_MATURITY` or
  `curate --maturity`; a value that is not a positive integer falls back to the default) the verdict is `probation`. The skill is never marked stale or
  archived by time while it is on probation. Probation only applies while `use_count` is zero:
  a skill that has been used but has fewer offers than the threshold still ages out by idle
  time (`stale` after 14 days, `archive` after 30), so a used skill that went quiet is not
  kept forever.
- At or above the threshold, a skill with `use_count` of zero gets the `archive` verdict.
  A skill with uses falls back to the idle-day verdicts above.
- A skill on probation with zero uses that has not been offered for `SKILLMINE_PROBATION_MAX_DAYS`
  days (default 180, or `curate --probation-max-days`; measured from `last_offered_at`, or from
  creation when there is none) gets the `archive` verdict, so a skill that is never shown
  cannot stay on probation forever.
- A skill with no offer data (`offered_count` of zero) keeps the old time-based verdicts.
- Pinned and human-authored skills stay exempt. Archiving is the ordinary `archive` edit:
  the skill moves to `.archive/`, the ledger records it and `skillmine undo --run` restores
  it. Nothing is deleted.

## 11. CLI

```
skillmine mine [--days 30 | --since <ms|iso>] [--clients all|claude,codex,...] [--project <path>] [--dry] [--classifier jev|laya|haiku] [--planner claude|codex|agy|kimi|opencode]
skillmine apply --edits <file|->          # used by the mod
skillmine classify --window <file|->      # one window, prints Verdict
skillmine undo --last | <id> | --run <id>
skillmine ledger [--run <id>] [--limit 50]
skillmine curate [--dry] [--stale-days 14] [--archive-days 30] [--maturity 300] [--probation-max-days 180] [--clients ...]   # usage scan + stale/archive
skillmine pin <skill> | unpin <skill>     # exempt a mined skill from decay
skillmine touch <skill>                   # stamp last_used_at only; the mod calls it on skill.prompt
skillmine install-skill [--from <dir>]    # link clients/skillmine into Codex, Kimi, OpenCode, Antigravity skill dirs
skillmine gate --client <c> --session <id> [--project <p>] [--every 3] [--cooldown 20] [--force]
                                          # live gate for clients without a mod API, spawned detached by a Stop hook
skillmine tick --session <id> --calls <n> [--project <p>] [--every 50]
                                          # count tool calls; every Nth spawns `skillmine reflect` detached
skillmine reflect [--project <p>]         # background reflection: mine since the last reflection, then curate
skillmine index [--project <p>] [--session <id>] [--json]   # compact index of self-authored skills; with --session also prints a `#offered [paths]` line
skillmine offered --session <id> --paths <file|-> [--project <p>]   # mark the session injected and count the offers once the index reached it
skillmine doctor                          # readers found, classifier reachable, targets writable
```

`gate` keeps per-session state (`stops`, `gatedTurns`, `lastPlanned`) under
`~/.skillmine/gate/` and a lock per session. Only every Nth stop reaches the classifier;
rejected turns are consumed, turns blocked by the cooldown are kept for the next gate.
It is the same pipeline as the mod's live check, run as a subprocess.

`SKILLMINE_PLANNER_CWD` and `SKILLMINE_HAIKU_CWD` count as unset when empty.
`SKILLMINE_HOME` names the state directory (default `~/.skillmine`); an empty value counts as
unset and a relative value resolves against the home directory, in the store and in the
helper-session check alike. `skillmine undo` of a created skill ignores `.usage.json` and
`.usage.lock` (and their temp files) when it checks for files it did not write, and removes
them with the folder. In the mod, a `mine` that exits 3 (some classifier or planner calls
failed) counts as a success when its output parses: the applied lessons are shown and the
toast adds the number of failed calls.

### 11.1 Tool-call reflection trigger

`tick` keeps one counter file per session under `~/.skillmine/counters/` (written through a
temp file and a rename; fields that are not finite non-negative numbers are reset to 0).
Each call adds the tool calls made since the last tick. When the count reaches N (default
50, `SKILLMINE_REFLECT_EVERY_N`) it takes the reflection lock and spawns `skillmine reflect`
detached with `SKILLMINE_REFLECTING=1`. After a trigger, and also after finding the lock
held, the session count restarts from zero, so that session needs N further calls before
it tries again (a cooldown). A failed launch keeps the count.

The lock is a directory, `~/.skillmine/reflect.lock/`, created with `mkdir` (atomic, no
create-then-write gap). `owner.json` inside holds a random token, a pid and a timestamp
`ts`. The token reaches the child in `SKILLMINE_REFLECT_LOCK_TOKEN`; only a process whose
token matches releases it, and release re-reads `owner.json` right before removing the
directory and aborts if the token changed. After the spawn the tick records the child's pid
in `owner.json`; the child writes its own pid when it starts and refreshes `ts` every five
minutes from an unref'd timer. When a refresh finds that the token changed, the reflection
marks the lock as lost; `reflect` checks that after `mine` and again after `curate`, skips
`curate` when it is lost, prints "lock lost" and exits non-zero, without releasing a lock it
no longer owns. `reflect` awaits any
in-flight refresh before it releases the lock.

A lock is stale when any of these holds: `ts` lies in the future beyond a 60 second skew; the
recorded pid is not alive (`process.kill(pid, 0)` fails with `ESRCH`); no pid is recorded and
`ts` is more than 30 minutes old. A lock whose pid is alive is not stale until its
`ts` is three windows (90 minutes) old, which covers a long reflection whose refresh has been
delayed. A lock with no readable `ts` (empty or corrupt `owner.json`, or a legacy lock
file) is judged by the mtime of the lock path, so it counts as fresh until it ages. Takeover
first re-reads `owner.json` and gives up if it no longer matches what was judged stale, then
renames the stale directory to a unique name, which only one contender can win; the loser
gets `ENOENT` and does not acquire. The winner checks that the moved `owner.json` is the
content it judged stale. If it is not, the directory held a live lock that was claimed in the
meantime: the winner renames it back to `reflect.lock`, and when `reflect.lock` exists again
it deletes the moved directory instead; either way the lock counts as not acquired. If it
matches, the winner deletes the `.stale-` directory and makes its own with `mkdir`; losing
that race also means not acquired. Release reads the token, renames the directory to a
private `reflect.lock.release-<uuid>`, re-reads the token inside it and only then deletes it;
on a mismatch it renames the directory back. After creating its directory a contender
re-reads `owner.json` and treats a different token as not acquired, and `updateLockOwner`
writes a temp file inside the lock, re-reads the token and only then renames the temp file
over `owner.json`. A tiny window remains between that last token check and the rename, in
which a lock stolen at that instant can receive the old owner's `owner.json`.

This is a best-effort lock, not strict mutual exclusion. A small window remains between
reading a token and acting on it, in which a stale-judged lock can be replaced; the pid and
timestamp checks, the token on every write and the lost-lock abort limit the damage, and a
reflection is idempotent (it mines a window and applies validated, ledgered edits), so the
worst case is a duplicated reflection, not corrupted state.

`tick` waits for the child's `spawn` or `error` event: on error it releases the lock and
reports `failed`. A manual `skillmine reflect` without `SKILLMINE_REFLECTING` takes the lock
itself (and exits without running if it is held), marks its own process as a reflection and
releases only its own token. With `SKILLMINE_REFLECTING` set, `reflect` runs only when it
carries a lock token that matches the lock; otherwise it exits 0 with a "nested" message and
runs neither `mine` nor `curate`, which matters because planner subprocesses inherit the
guard. The token variable is removed from the process environment at start so that
grandchildren cannot reuse it. Helper sessions (the planner and classifier run in the state dir, and their subprocesses
carry `SKILLMINE_INDEX_SUSPENDED=1`) are never counted: `tick`, `index` and `offered` return
early when the project is under the state dir. `reflect` stores the start time of its last successful
mine in `~/.skillmine/reflect.json`, one record per project (keyed by a hash of the resolved
project path, with its own key when no project is given), and mines only windows since then (`mine --since`, at most
seven days back; the first run uses `--days 1`), then runs an unscoped `curate`, and exits
non-zero when either fails. The record advances when `mine` exits 0 or 3: `mine` exits 1 when
nothing succeeded (every classifier call failed, or every planner call failed and nothing was
applied; no advance) and 3 when only some calls failed (partial success); the failed cluster
ids and the counts (classifier errors, planner errors, applied, rejected) are written to
stderr, which for the detached child is `reflect.log`, and a window is never re-mined because of a partial failure. `--since` takes an ISO date or
epoch milliseconds of at least 13 digits; anything else exits 2. The project is resolved to an
absolute path in `tick` and `reflect`. Sessions of the tool's own helpers are left out of
every mine: the planner and the haiku classifier run with their working directory inside the
skillmine state dir (`~/.skillmine/empty`, or `SKILLMINE_PLANNER_CWD` and
`SKILLMINE_HAIKU_CWD`), and `mine` skips any session whose project lies under those
directories or the state dir, for every client. `tick --every` must be a positive integer, or
the command exits 2; `tick` exits 1 when the launch failed, so the mod logs it. A global cooldown
(`SKILLMINE_REFLECT_COOLDOWN_MS`, default 15 minutes, 0 turns it off) is checked before the
lock: a tick inside it resets the session counter and reports `cooldown`. The time of the last
launch is kept in `~/.skillmine/reflect-trigger.json`. The detached child's stdout and stderr
are appended to `~/.skillmine/reflect.log`. Each tick deletes counter and marker files older
than seven days and cuts `reflect.log` to its last 1 MB once it exceeds 2 MB, truncating the same file in place so
that a running child's append handle keeps writing to it (best effort).
The session marker is created by `offered`, which the mod calls only after the append
succeeded, so a failed append leaves the session unmarked and the next start offers the index
again; `offered` also uses a second marker (`<session>.offered`) so the counters rise once. The relaunch command is the current executable plus the
real path of the entry script (`Bun.main`), or the executable alone for a compiled binary.
With the guard set, `tick` and `index` do nothing, so a reflection never triggers another.
The Claude Code mod chains its tick calls so that overlapping runs cannot apply out of
order, and calls `tick` after each completed main-agent turn with the number of tool uses
found in the new session rows.

### 11.2 Session-start index

`index` trusts a skill only when the ledger holds an applied `create` for its path
(compared by realpath) that was not rolled back; a rolled-back create stops counting, but a
later applied create at the same path restores trust. The `created_by: skillmine`
frontmatter marker is an additional filter and never enough alone, because a cloned
repository can ship that line. A human skill that shares a name or carries the marker at a
different path is never indexed or written to. Skills are ranked by `use_count` and printed
one line each: `- name: description (/path/to/SKILL.md)`, so the model can open the file, with the name cut to 64 characters and the description
to 60, control characters and newlines replaced by spaces. The whole block, header
included, is capped at 2000 characters and 40 entries; skills that do not fit are neither
shown nor counted. With `--session`, `index` prints the block followed by a line
`#offered ["path", ...]` and writes nothing; it prints nothing when
`counters/<session>.injected` already exists, so a resumed session is not injected twice. The
mod appends the block (without the `#offered`
line) to the session and only after the append succeeds calls
`offered --session <id> --paths -` with the list on stdin. `offered` claims
`counters/<session>.injected` with the exclusive `wx` flag (a file separate from the tick
counter, so the two never write the same file) and does nothing when it already exists, then
re-checks each path against the same trust rule, then claims a second marker, `counters/<session>.offered`, with
`wx`, and adds one to `offered_count` and sets `last_offered_at` for each skill that was
shown, so the counters rise at most once per session; an append that failed counts nothing.
The counter is the denominator for 10.1. It is not written when the skill folder no longer
exists, and the sidecar writer no longer creates missing folders.
`SKILLMINE_INDEX_SUSPENDED=1` prints nothing and counts nothing. The mod schedules the call
after `session.start` returns, off the critical path, and logs stderr when `tick`, `index`
or `offered` exit non-zero. If the session has fewer rows than were counted (for example after
a compaction), the tool-call row counter moves to the new length and counts only the tool
uses after the last user row; the mod does nothing while the session id is empty. If the rows could not be read at session start, it is set on the first
successful read, again without counting that history.

### Adapter layout (per client)

| Client | Live loop | `/skillmine N` |
|---|---|---|
| Claude Code | mod, in process (`hooks/register.tsx`) | mod command |
| OpenCode | OpenCode plugin calls the shared dispatcher on `stop`, which spawns `skillmine gate` | thin skill |
| Codex, Kimi, Antigravity | Stop hook (`ai-harness-hook`) spawns `skillmine gate` detached | thin skill |

The CLI is the only engine. Adapters never contain pipeline logic.

Usage lives in `.usage.json` beside each mined `SKILL.md`: `use_count`, `last_used_at`,
`patch_count`, `pinned`, `first_seen_at`, `status`, `scanned_until`, `offered_count`,
`reject_count`, `last_offered_at`. The mod stamps
`last_used_at` on every `skill.prompt` event through `skillmine touch`; `curate` scans every
client's transcripts for `Skill`-style tool calls, reads of `.../<name>/SKILL.md` and
`/<name>` prompts, and only counts stamps newer than that client's previous scan. Patches by
Skillmine raise `patch_count`, never `use_count`. Idleness is measured from the latest of
`last_used_at`, the ledger `create` time and `first_seen_at`; an archive is an ordinary
`archive` edit through `applyEdits`, so it is validated, snapshotted, logged and undoable.

The index the mod appends to a session starts with the marker `[skillmine-index]`, and the
readers returned by `createReaders` drop user rows that begin with it, as does the mod's own
digest, so the index is never mined or classified as a conversation.

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
