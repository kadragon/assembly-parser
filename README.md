# assembly-parser

A local browser app that turns long spoken sessions into time-window summaries and
topics grouped by your own interest categories. It has two inputs:

- **Live National Assembly broadcasts**: collects the AI captions of a live broadcast
  on the National Assembly webcast (`assembly.webcast.go.kr`) while it runs.
- **Meeting or lecture transcripts**: uploads a finished JSONL, SRT, or WebVTT file.

Every window (5 minutes by default) gets a summary, and its content is routed into
topics with cumulative summaries. Summaries are made by your local
[Claude Code](https://claude.com/claude-code) CLI. The interface is in Korean.

## Quick start

Requirements: Node.js 22 or later, and for new summaries a Claude Code CLI (`claude`)
that is installed and logged in.

```bash
npm install
npm start
# Open the printed http://127.0.0.1:3000 address in your browser.
# Optional: npm start -- --port 3100 --data /path/to/local/data
```

Everything after `npm start` happens in the browser: choosing a broadcast or uploading
a file, setting categories, starting, stopping, retrying, and rebuilding.

### Demo without credentials

```bash
npm run demo        # optional: npm run demo -- --port 3100
```

This serves a precomputed session: a synthetic, roughly 17-minute library committee meeting
([source](demo/source/library-committee.jsonl)) summarized in four windows with three
categories. It needs no Claude login and no live broadcast. The demo runs on a
temporary copy that is deleted on exit, so you can edit settings or rebuild without
changing `demo/`; rebuilding or uploading in the demo does call Claude.

## Using the app

### Live Assembly broadcasts

Choose a meeting from the live broadcast list or paste an official Assembly player URL
(`https://assembly.webcast.go.kr/main/player.asp?xcode=…&xcgcd=…`). The list comes from
the Assembly main-page feed, is cached briefly, and **Refresh** rechecks it. Direct URL
entry works even when the list cannot be loaded. Only broadcasts that are live and have
AI captions can start; this is rechecked at Start.

Start launches collection and summarization together. Keep in mind:

- Captions arrive only while the broadcast is live; past captions cannot be retrieved.
  Start before the part you care about.
- Closing the tab or switching sessions does not stop work. **Stop** stops both
  workers for that session.
- Restarting the server never resumes collection automatically. **Resume collection**
  shows the missed interval, whose captions are lost.
- **Finalize last window** summarizes the last partial window after collection stops.
  Resume is then refused until that window ends, so new captions cannot slip into an
  already completed summary.

### Uploaded meetings and lectures

Under "회의·강의 자막 파일 올리기", choose a file, a title, and a new session ID.

| Format | Extension | Speakers | Notes |
|---|---|---|---|
| JSONL | `.jsonl` | optional `speaker` field | [contract](docs/jsonl-format.md) |
| SRT | `.srt` | never (SRT has no speaker syntax) | formatting tags removed |
| WebVTT | `.vtt` | `<v Name>` voice spans | cue settings, `NOTE`/`STYLE`/`REGION` ignored |

Files must be UTF-8 and at most 5 MB. The whole file is validated before the session
appears; errors list their line numbers, and an existing session ID is never
overwritten. Times are elapsed from the start of the recording (hours keep counting
past 24). Speakers are never inferred from text, and no parliamentary titles are added.
All windows, including the last partial one, are summarized once; there is no live
collection to stop or resume. See [the format notes](docs/jsonl-format.md#srt-and-webvtt)
for exact parsing rules and exclusions.

### Interest categories

Categories are optional; without them everything is summarized as one overall category.
Each category has a name, an optional description, and keyword chips (type a word, then
Enter). Order sets the viewer's grouping, and exactly one category is the fallback for
anything that fits no other. The description decides routing; keywords only hint the
router when they appear in a window. **Load saved categories** copies another session's
categories. A legacy focus setting appears as its two categories and is kept as is
unless edited.

### Settings changes and rebuilds

**Edit settings** on a saved session changes its categories or window length without
touching existing output. Summaries record the settings, model, prompt version, and
caption fingerprints they were made from. A summary-affecting change, or captions
corrected after their window was summarized, pauses summaries as "다시 만들기 필요"
while collection continues. Nothing is overwritten until you choose "요약 다시
만들기", which first moves the previous `state.json`, `topics/`, and `curation.jsonl`
to `archive/<time>/`. Legacy records without recorded settings remain viewable and are
rebuilt only on request.

### Viewer

- **Left column**: window summary cards, newest first, each with chips for the topics
  it covered. New live captions appear in real time.
- **Right column**: topics by category. Opening a topic shows its cumulative summary,
  fact checks (when enabled), and per-window records.
- **Filters**: select a speaker or organization to show only topics that mention it.
  Filters survive a refresh; `Esc` clears them.
- **Share as image**: window cards and open topics can be exported as PNG images with
  the meeting information. Touch devices open the share sheet, desktops copy to the
  clipboard, and otherwise the image is downloaded.

## Privacy, model use, and external assets

- Storage is local (`data/` by default), but **transcript text is sent to Anthropic**
  through the Claude Code CLI for every summary. Do not upload material you may not send
  to that service.
- The server binds to `127.0.0.1`. Write requests require the exact printed address
  (matching Host and Origin) and a per-run session token. It is not designed for hosting
  or for access by other users.
- The viewer loads the Pretendard web font and the `html-to-image` library (used for
  share images) from the jsDelivr CDN. Without network access the viewer still works
  with a fallback font, but image sharing does not.
- Live collection and the broadcast list contact the Assembly webcast servers.
  Uploaded sessions need no Assembly access; their only network use is the model calls.

## Recovery

- **Summary error**: the session pauses summaries and keeps collecting. Check the
  session's error (often a missing `claude` CLI or an expired login), fix it, then
  **Retry summary**. A window that fails three times is skipped so later windows are
  not blocked; the next summary run retries it.
- **Server stopped or crashed**: start it again. Sessions that were collecting show as
  interrupted with their missed interval; resume them explicitly.
- **Busy port**: `npm start` fails before starting any worker; choose another
  `--port`.
- **Locks**: one server controls a data directory, and the standalone commands use the
  same per-session writer locks. Locks of dead processes are recovered; unknown owners
  fail closed.

## Limitations

- Live input is only the Assembly webcast's AI captions. Broadcasts with
  stenographer-only captions, or no captions, cannot start.
- Captions missed while collection was stopped cannot be recovered.
- No audio/video transcription, translation, or speaker diarization; uploads must
  already be transcripts.
- Fact checks and curation suggestions are Assembly-only and available only through
  the standalone `summarize` command (below). Curation only records suggestions.
- Summary quality depends on the model; the tests check orchestration with a fake
  model runner, not summary quality.

## Advanced usage

### Standalone commands

The original per-process commands remain available, each in its own terminal. Start
`collect` before the broadcast reaches the part you need.

```bash
URL='https://assembly.webcast.go.kr/main/player.asp?xcode=58&xcgcd=DCM00005822439A401&'

npm run collect -- "$URL"
npm run summarize -- "$URL" --focus 한국교원대학교 --focus-keywords 교원대,교원대학교 \
  --focus-note "부설 장애인 체육 중·고등 특수학교(2028년 3월 개교 예정) 설립"
npm run serve -- "$URL"            # http://localhost:3000
```

Only `collect` must keep running during the meeting; `summarize` and `serve` can be
restarted at any time and also accept the bare `xcgcd` (`DCM00005822439A401`). After the
meeting, `npm run summarize -- "$URL" --once --finalize` processes the last partial
window and exits.

| Command | Options |
|---|---|
| `start` | `--port <n>` (1–65535, default 3000), `--data <dir>` |
| `demo` | `--port <n>` (default 3000) |
| `collect <URL>` | `--data <dir>` (default `data`) |
| `summarize <URL\|xcgcd>` | the options below and `--data <dir>` |
| `serve <URL\|xcgcd>` | `--port <n>` (default 3000), `--data <dir>` |

### `summarize` options

- `--window <minutes>`: window length (default 5); must divide 60.
- Omitted options reuse the settings saved with existing output. If a given value
  differs from them, or captions of a summarized window change later, nothing is
  modified: it prints `rebuild required` with the reasons and exits with code 3.
- `--focus <organization>`: two categories, `<organization>` / `그외`. Without it there
  is one overall category. `--focus-keywords` is a comma-separated keyword list passed
  as router hints (default: the organization name). `--focus-note` describes work that
  belongs to the organization even when its name is not spoken.
- `--categories '<JSON>'`: ordered categories, each
  `{"name", "description", "keywords": [...], "fallback"}`, with unique names and
  exactly one `fallback: true`. `[]` means no categories. It cannot be combined with
  the `--focus` options.
- `--rebuild`: summarize again from the stored captions, archiving `state.json`,
  `topics/`, and `curation.jsonl` to `archive/<time>/` first; `transcript.jsonl` is
  kept. After changing prompts or the output shape, raise `PROMPT_VERSION` in
  `src/summarizer.js` so existing summaries are reported as stale.
- `--once`: process completed windows and exit.
- `--finalize`: with `--once`, after collection has stopped, also process the last
  partial window.
- `--factcheck`: check factual claims in members' statements with web search (verdict,
  explanation, sources per claim). Off by default because each topic takes about
  15–30 seconds.
- `--curate`: every 30 minutes with new records, review the topic list and record merge,
  move, rename, and category suggestions in `curation.jsonl` without applying them.
- `--factcheck` and `--curate` refuse uploaded sessions and exit without writing.

### Models

| Variable | Used for | Default |
|---|---|---|
| `SUMMARY_MODEL` | window summaries, topic routing, topic summaries | `haiku` |
| `FACTCHECK_MODEL` | `--factcheck` | `sonnet` |
| `CURATE_MODEL` | `--curate` | `sonnet` |

Model calls run `claude -p` with tools disabled (web tools only for fact checks) and
no saved sessions, with a timeout and at most four topic calls in parallel per
session.

## How it works

### Processes

The browser app supervises the same workers that the standalone commands run, all
sharing `data/<session>/`:

| Worker | Reads | Writes |
|---|---|---|
| collector | Assembly AI caption WebSocket | `meeting.json`, `transcript.jsonl` (append-only) |
| summarizer | `meeting.json`, `transcript.jsonl` | `state.json`, `topics/*.json` + `*.md`, `curation.jsonl` |
| viewer | all of the above | nothing |

### Window pipeline

Windows are processed in order, because each uses the previous window and the topic
list built so far:

1. **Window summary**, using the previous window's summary as context.
2. **Topic routing** (in parallel with 1): the router receives the topic list, the
   previous window's items, and the captions, splits the window into items, and assigns
   each to an existing topic or a new topic in a category (`claude -p --json-schema`).
3. Each item becomes that topic's record for the window (`topics/tNNN.json`). Records
   are append-only and replaced only when the same window is processed again.
4. **Topic summaries**: topics with new records update their stored summary with just
   the new records, so the whole meeting is never resent.
5. **Fact checks** (`--factcheck`) run in a separate loop so they never delay 1–4.

### Caption protocol

`live_play.asp?xcode=…&xcgcd=…` returns the caption server address `xsami`
(for example `wss://smiai.webcast.go.kr:8091/aistt/gyoyuk`). Like the site's
`openos_util.js`, the collector connects to `${xsami}/hls` with the `echo-protocol`
subprotocol. Frames carry `segment`, `segment-offset`, `transcript`, `transcripts`
(diarized, with a `-` prefix marking a speaker change), and `final`. Only `final` frames
are stored; a later `final` for the same segment replaces the earlier one when read.

## Development

```bash
npm test          # node --test; no Claude login or live broadcast needed
npm run lint      # Biome lint and format check (npm run lint:fix applies fixes)
```

CI (`.github/workflows/checks.yml`) runs both on every push to `main` and on pull
requests. The demo in `demo/sessions/` was produced by uploading
`demo/source/library-committee.jsonl` through the app with the default model; the tests
check that its transcript still matches that source.

## License and publication

No license has been selected yet, so no reuse rights are granted beyond what applicable
law allows. Choosing a license and any further release or redistribution are separate
decisions from this documentation.
