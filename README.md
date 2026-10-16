# assembly-parser

Collects the AI subtitles (AI 자막) from a live National Assembly webcast
(`assembly.webcast.go.kr`), summarizes every 5-minute window, and files the
content into topics grouped into two categories: the focus institution
(e.g. 한국교원대학교) and 그외.

## Processes

Three independent processes share `data/<xcgcd>/`. Only `collect` must stay up
for the whole meeting; restart `summarize` and `serve` freely while iterating.

| Process | Reads | Writes |
|---|---|---|
| `collect` | AI subtitle WebSocket | `meeting.json`, `transcript.jsonl` (append-only) |
| `summarize` | `meeting.json`, `transcript.jsonl` | `state.json`, `topics/*.json` + `topics/*.md` |
| `serve` | all of the above | — (web UI at `/`, JSON at `/api/state`, new transcript lines pushed over SSE at `/api/live`) |

```bash
URL='https://assembly.webcast.go.kr/main/player.asp?xcode=58&xcgcd=DCM00005822439A401&'
npm run collect -- "$URL"
npm run summarize -- "$URL" --focus 한국교원대학교 --focus-keywords 교원대,교원대학교
npm run serve -- "$URL"            # http://localhost:3000
```

`summarize` and `serve` also accept the bare xcgcd (`DCM00005822439A401`).

### summarize options

- `--window <min>` window length (default 5, should divide 60).
- `--focus <name>` makes the categories `<name>` / `그외` (without it: `전체`).
  `--focus-keywords` comma list; a mention is passed to the router as a hint
  (spaces ignored; defaults to the name).
- `--rebuild` start over from the saved transcript (use after changing prompts
  in `src/summarizer.js`). Existing topics are moved to `topics-archived-<time>/`,
  never deleted. Changing `--window` or the categories does the same.
- `--once` process closed windows and exit (e.g. after the meeting).
- `--factcheck` web-check members' factual claims (see below). Off by default:
  each check runs web searches and takes ~15–30 s per topic.
- `--curate` review the whole topic list every 30 min (when new entries came in)
  and log proposed merges, entry moves, renames and category fixes to
  `curation.jsonl`. Proposal mode: topics are not changed. `CURATE_MODEL`
  overrides the model (default `sonnet`).

### Pipeline per closed window

1. **Window summary** for the left column, using the previous window as context.
2. **Topic routing** (parallel with 1): the router sees the topic catalog
   (id, category, title, description), the previous window's items, and the
   subtitles. It splits the window into items and assigns each to an existing
   topic or creates a new one with a category, via `claude -p --json-schema`.
3. Each item becomes that topic's entry for the window (`topics/tNNN.json`).
   Entries are only added, or replaced when the same window is re-run.
4. **Topic summaries**: every topic with new entries folds them into its stored
   summary (`summary.until` marks what is included), up to 4 in parallel.
   The whole meeting is never re-sent.

5. **Fact checks** (`--factcheck`, on a separate loop so they never delay the
   steps above): for each topic with new entries where a member spoke, the
   checker picks up to 3 verifiable factual claims (figures, events, laws,
   budgets), checks them on the web and stores verdict, explanation and
   sources in `topic.factcheck`. Disputed claims (`논쟁 중`) list each side's
   view with its own sources. Earlier checks are passed along so a claim is not
   checked twice. Runs with `WebSearch`/`WebFetch` only; `FACTCHECK_MODEL`
   overrides the model (default `sonnet`).

Windows themselves go in order, because each one uses the previous window and
the topic list built so far.

Summaries run through the local Claude Code CLI (`claude -p`, tools disabled,
no session persistence). `SUMMARY_MODEL` overrides the model (default `haiku`).
Calls in flight are written to `state.json` as `running` (with the summarize
pid, so a killed process leaves no stale entry) and shown in the web UI header.

## Subtitle protocol

`live_play.asp?xcode=…&xcgcd=…` returns `xsami`, the subtitle server
(e.g. `wss://smiai.webcast.go.kr:8091/aistt/gyoyuk`). The collector connects to
`${xsami}/hls` with subprotocol `echo-protocol`, as the site's `openos_util.js`
does. Frames carry `segment`, `segment-offset`, `transcript`, `transcripts`
(speaker split; `-` prefix = new speaker) and `final`. Only finals are stored;
a later final for the same segment replaces the earlier one when read.
Subtitles stream only while the meeting is live; there is no backlog.

```bash
npm test
npm run lint      # Biome lint + format check (npm run lint:fix to apply)
```
