---
name: skillmine
description: Mine the last N days of coding-agent sessions (Claude, Codex, Kimi, OpenCode, Antigravity) into skills with the skillmine CLI. Use on "/skillmine 30", "skillmine", "mine my sessions", "undo the last skillmine edit", "what did skillmine learn".
---

# Skillmine

Skillmine reads session transcripts, keeps only windows that taught something reusable,
lets the model plan typed edits and writes them to the skill library with a ledger and
undo. This skill is the thin client for agents without a mod API. The CLI does the work.

## Workflow

1. Parse the request. `/skillmine 30` means the last 30 days; no number means 7.
   `undo` reverts the last edit. `status` or `ledger` lists what was written.
2. Run the matching command from the current project directory so local skills land
   in this project:

   ```sh
   skillmine mine --days 30 --json          # mine; prints a JSON summary
   skillmine undo --last                    # revert the newest edit
   skillmine ledger --limit 20              # what was written, from where
   skillmine curate --dry                   # stale and archive candidates
   ```

   A run over 30 days can take several minutes. Run it in the background when the
   agent supports it and report when it finishes.
3. Report one line per lesson, from the `applied` entries of the JSON: the action
   (`learned a new skill`, `updated a skill`, `added a reference to`, `archived`), the
   skill name and the file path. Then one line with totals: sessions scanned, clusters
   classified, edits applied, rejected, and the run id for `skillmine undo --run <id>`.
4. Do not describe the pipeline, do not paste the ledger, do not open the written files
   unless asked.

## If the CLI is missing

`skillmine doctor` reports which session stores were found and whether the classifier
is reachable. Install from https://github.com/flaviomartil/skillmine:

```sh
git clone https://github.com/flaviomartil/skillmine ~/projects/skillmine
cd ~/projects/skillmine && bun install && bun run build && ln -sf "$PWD/dist/skillmine" ~/.local/bin/skillmine
skillmine install-skill                  # links this skill into every client's skills dir
```

The classifier defaults to TypeSafe Jev (`TYPESAFE_API_KEY`); `--classify laya` uses a
local laya-server. The planner defaults to `claude -p`; `--planner codex|agy|kimi|opencode`
uses that CLI instead.
