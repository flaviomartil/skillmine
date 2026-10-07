# skillmine

Mine your coding-agent sessions for reusable knowledge. Skillmine watches a Claude Code
session as it happens and batch-reads past sessions of Claude Code, Codex CLI, Kimi CLI,
OpenCode and Antigravity. When a session taught something reusable, a cheap classifier
says so, the LLM decides what to write, and Skillmine creates or updates a skill, runbook
or agent definition on disk with full provenance and one-command undo.

```
/skillmine 30        # mine the last 30 days of sessions from every client
skillmine undo --last
```

Status: phase 4 (CLI plus the Claude Code mod). See [SPEC.md](SPEC.md) for the full design.

## Install the Claude Code mod

```
/plugin marketplace add flaviomartil/skillmine
/plugin install skillmine@skillmine
```

The mod needs the `skillmine` CLI on your PATH (`bun run build` then link `dist/skillmine`),
or set the mod's `cli` option to `bun run /path/to/skillmine/src/cli.ts`. For a checkout,
`claude --plugin-dir /path/to/skillmine` loads it for one session.

What it does once loaded:

- Every 3 completed turns it digests the fresh part of the chat and asks the classifier
  (Jev by default) whether something reusable was taught. On a yes it plans with the
  session model from the prompt cache and applies the edits through the CLI.
- Each lesson lands as one collapsed line in the transcript: `🧠 Skillmine learned a new
  skill: pnpm-workspace-gotchas — …  [ show ]`. Press show to read what was written and
  why, with an undo button. The status line shows how many lessons landed today.
- `/skillmine 30` mines the last 30 days of Claude, Codex, Kimi, OpenCode and Antigravity
  sessions in the background and posts one collapsed line per lesson as they land.
- `/skillmine undo` reverts the last edit, `/skillmine` lists what was learned.

## Try it

```sh
bun install
bun run src/cli.ts doctor                     # which session stores exist on this machine
bun run src/cli.ts mine --days 30 --dry       # sessions, turns, windows and signals per client
bun run src/cli.ts mine --days 7 --dry --clients claude,agy --project ~/projects/foo --json
bun test
```

`--dry` reads sessions, slices them into windows, drops automated prompts, embeds the
windows with a local model (Ollama, `nomic-embed-text` by default) and collapses
near-duplicates into clusters. Only cluster representatives reach the classifier, so a
3-day run on a busy machine costs a few dozen Jev calls instead of thousands.

```sh
ollama pull nomic-embed-text                                   # once, ~270 MB, runs on CPU
bun run src/cli.ts mine --days 3 --dry --classify jev --max-calls 40 --out clusters.jsonl
bun run src/cli.ts mine --days 3 --dry --classify laya         # same API served locally by laya-server
bun run src/cli.ts mine --days 3 --dry --embed none            # skip embeddings, every window is a cluster
echo 'user: no, the lock is in redis' | bun run src/cli.ts classify --digest - --skill redis-locks="Locking with Redis."
```

Classifier backends: `jev` (TypeSafe, `TYPESAFE_API_KEY`), `laya` (laya-server at
`SKILLMINE_LAYA_URL`, default `http://localhost:8000`), `haiku` (`claude -p`, costs more
per call).

## Mine for real

```sh
bun run src/cli.ts mine --days 3 --classify jev --planner claude          # Jev gates, Claude plans, edits land
bun run src/cli.ts mine --days 3 --planner codex                          # or agy, kimi, opencode
bun run src/cli.ts ledger                                                 # what was written, by whom, from where
bun run src/cli.ts undo --last                                            # or --id <edit> / --run <run>
echo '{"edits":[...]}' | bun run src/cli.ts apply --edits - --project .   # apply edits planned elsewhere (the mod uses this)
```

Clusters that pass the classifier go to the planner, which answers with typed edits
(`create`, `update`, `add_reference`, `archive`). Every edit is validated (name shape, no
secrets, no dates or ticket IDs, read-before-write), the skills tree is snapshotted to
`~/.skillmine/backups/` before the first write of a run, before and after blobs go to
`~/.skillmine/blobs/`, and every outcome is appended to `~/.skillmine/ledger.jsonl`.
Skills Skillmine did not create are never rewritten: an `update` on a human-authored skill
becomes a reference file under it. Pass `--allow-human-edits` to lift that.

Skills land in `<project>/.agents/skills/<name>/SKILL.md` (local) or `~/.agents/skills`
(global, when the lesson was seen in two or more projects), with a symlink into each
client's skills dir that exists, and frontmatter carrying `created_by: skillmine` plus the
session refs it came from.

## Why

Most of what an agent session teaches is lost when the session ends. Tools that save
memory keep facts. Skillmine keeps procedures: the fix that worked, the gotcha that cost
an hour, the tradeoff that was decided. It writes them where every future session reads
them.

## Principles

- The LLM decides. There is no approval queue, there is an undo.
- Update before create. A lesson learned twice is one rule.
- Local first. A skill lives in the project it came from until it shows up elsewhere.
- Skillmine edits only what it created. Your hand-written skills get reference files,
  never rewrites.
- Deterministic writes. Every edit is validated, snapshotted and logged before it lands.

## License

MIT.
