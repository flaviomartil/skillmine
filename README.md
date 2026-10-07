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

Status: phase 1 (readers and dry run). See [SPEC.md](SPEC.md) for the full design.

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
per call). The planner and apply steps arrive in phase 3.

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
