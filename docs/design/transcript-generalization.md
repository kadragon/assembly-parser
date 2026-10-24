# Transcript Generalization for Local Use

## Problem Statement

The application collects National Assembly AI captions and produces window summaries,
topic records, Markdown exports, and a local web view. Collection, summarization, and
serving already run independently, but all three assume an Assembly meeting.
File imports are missing; prompts, participant fields, labels, and exports assume
legislators and institutions. Other users cannot evaluate the application without
a live Assembly stream and a working Claude Code installation.

The user selected a first-release scope of National Assembly live captions plus
subtitle files from general meetings and lectures, started with one command and
configured in the browser. Broadcast selection uses the current Assembly list with
a direct-URL fallback; focus keywords are entered in the web UI. The user approved
this design and delivery order on 2026-10-24. Approval covers planning and ticket
creation, not repository publication or license selection.

## Solution

Make `npm start` the primary entry point: it opens a local web application without
requiring a meeting argument. The browser home page offers live-broadcast selection,
subtitle upload, and saved sessions. Users select a broadcast, enter focus words and
optional context, and start collection and summarization together. The server owns
worker lifecycle; users do not manage three terminal commands.

Keep the local, file-backed application and existing Assembly commands as advanced
compatibility interfaces. Normalize uploaded SRT, WebVTT, and documented JSONL files
into the same transcript pipeline. Introduce Assembly and general-content profiles that
control interpretation and presentation without requiring a plugin framework.

Retain Claude Code as the first supported model runner. Deliver a synthetic,
precomputed demo that can be viewed without live captions or model credentials.
Prepare reproducible setup and checks before a separate public-release decision.

## User Stories

- As a user, I can run `npm start` once, then select a live meeting and focus words
  in the browser without copying command-line arguments or opening more terminals.
- As a user, I can select from the current Assembly broadcast list or paste an
  Assembly player URL when the list is unavailable or the meeting is not listed.
- As a user, I can see collection and summary status separately, retry a failed
  summary without stopping collection, and stop or resume work from the browser.
- As an existing user, I can collect and summarize an Assembly meeting using my
  existing commands and inspect historical results without destructive conversion.
- As a meeting participant, I can upload a subtitle file in the browser and obtain topic summaries
  that include speakers without assigning them parliamentary titles.
- As a learner, I can inspect lecture topics using elapsed playback time rather
  than an invented calendar date.
- As a user, I can define several interest categories and reuse those rules across
  sessions without changing source code.
- As a prospective contributor, I can run a synthetic demo and automated checks
  without an ongoing broadcast, private data, or model access.

## Implementation Decisions

### Preserve the current application shape

Use the existing Node.js modules, JSON files, and static UI. Add `npm start` for the
application server; retain `collect`, `summarize`, and `serve` for compatibility.
File import is primarily a web action; a separate CLI importer is not required.
Keep the package name for this work.
Do not introduce a database, frontend framework, daemon, or adapter registry.
Extract small modules only where import, profile, or model boundaries require them.

### One server, browser-owned session setup

The server starts without a selected session. Its home page provides live broadcasts,
file upload, and saved sessions. The live flow is: choose a broadcast or paste a URL,
review meeting identity, enter focus keywords and optional scope notes, then press
Start. Empty focus means an overall summary. Offer window size and profile-specific
options as secondary controls. Users never need to edit JSON for the normal flow.

Keep the collector and summarizer as supervised workers for failure isolation.
The parent server starts them with argument arrays, tracks their exits, and exposes
separate collection/summary/error status. Starting an already-running session is
idempotent. A summary failure must not stop caption collection. Stop and retry
actions target the selected session, not whichever detail page was last opened.
Switching browser pages or closing a tab does not stop server-owned work.
Bound concurrent summary jobs across sessions so multiple starts cannot create
unlimited Claude processes. Multiple clients observe the same server-owned state.

Stopping collection closes its socket and prevents queued reconnects. A graceful
server shutdown stops all owned workers and model children; bounded cleanup must
not leave detached writers. After restart, saved sessions are visible as interrupted
or stopped until the user resumes them. Make any missed live interval visible:
resuming cannot retrieve captions that were never collected. A stopped live session
can finalize its last partial window before completing summary processing.

Existing standalone commands and the server share per-session collector/summarizer
ownership checks. Conflicts produce a useful message rather than duplicate writers.

### Discover broadcasts from the existing Assembly contract

On 2026-10-24, the official main-page script at
`https://assembly.webcast.go.kr/main/js/main.js` used
`https://assembly.webcast.go.kr/main/service/live_list.asp` and read its `xlist`.
A direct read returned 19 entries with identifiers, names, subjects, statuses, and
subtitle hints; none was live at inspection time. This is an observed website
contract, not a documented stability guarantee.

Fetch the list server-side from that fixed origin with bounded timeouts, caching,
and a manual refresh action. Show live status, committee, and subject; distinguish
an empty live list from a fetch error. Retain direct Assembly player-URL input
independently of list success. Do not fetch arbitrary user-provided URL origins.
Validate the player host/path/identifiers, then resolve metadata using the existing
fixed `live_play.asp` integration. Recheck meeting state and AI-subtitle support
before starting, since list state can change. Clearly explain unavailable AI
captions and unsupported stenographer captions without starting failed workers.

### Browser control and uploads

Add session-scoped read APIs and explicit write actions for starting, stopping,
retrying, configuration, rebuilding, and uploading. Validate all payloads and
session paths before side effects. Apply upload size limits and format checks;
never treat the browser-supplied filename as a destination path. Validate and stage
the full import before exposing a usable session, and clean up rejected uploads.

Keep control local: bind to loopback, validate Host and Origin, and protect write
actions with a same-origin session token. No permissive CORS and no mutations via
GET. Do not carry an unauthenticated external-host option into the control server.
The existing read-only viewer remains separate from these mutation endpoints.

### Normalize inputs and make time explicit

Introduce versioned session metadata with source kind, title, profile, and time
basis. Assembly timestamps remain absolute milliseconds. Imported subtitle times
are elapsed milliseconds from the media origin, displayed as duration, including
hours beyond 24. Do not apply `Asia/Seoul` formatting to elapsed time.

Normalized lines retain stable keys and text and add optional end time and explicit
speaker attribution. Keep source cue identifiers or ordinal positions for traceability.
For window assignment, use cue start time; a cue crossing a boundary is not duplicated.
Reject invalid or negative times, end-before-start intervals, and empty records
before publishing an imported session. Preserve valid overlapping cues in stable order.

Support UTF-8 SRT and WebVTT text cues, including BOM and CRLF input. Ignore WebVTT
NOTE/STYLE/REGION blocks and presentation settings; preserve voice labels where
explicitly provided. Do not claim speaker recognition from unlabeled text.
Document the normalized JSONL contract and error locations.

Require a safe local session identifier for imports and session lookup. Validate
that session paths remain within the configured data directory. Import to a new
session; refuse an existing destination rather than silently overwrite it.
Validate the complete file before making the session visible.

Imported sessions are complete: `summarize --once` processes all their populated
windows, including the last partial window, without depending on wall-clock time.
Live sessions retain the existing closure/grace behavior. The UI distinguishes
completed files from live collection and does not show an idle live-stream warning
for a completed import.

### Separate domain rules from shared processing

Provide built-in `assembly` and `general` profiles. Existing datasets without a
profile use `assembly`; file imports default to `general`. General includes meetings
and lectures, with neutral speakers, organizations, and content tags. Assembly keeps
its legislator-specific rules and institutional name normalization.

Use neutral speaker and organization fields for new general-profile output, with
optional roles only when supported by the input. Add a compatibility read adapter
for legacy `members`/`institutions` and singular summary fields. Do not rewrite
historical files merely to view them. Version new records and preserve source
records and previous derived outputs when an explicit rebuild is requested.
Apply profile-aware rendering to the UI, filters, Markdown, and share-image footer.

### Persist effective configuration

Persist validated configuration edited in the browser for profile, window length, and named categories
with descriptions and optional keywords. Categories are ordered; one fallback
category is explicit. Keywords are hints, not hard substring routing rules.
Keep the existing focus flags as a compatibility shorthand. Reject combining
explicit category configuration with focus flags rather than silently override it.
Explicit CLI values override configuration values; omitted flags do not override them.
The web form exposes keyword chips and an optional description rather than requiring
users to understand configuration fields. Save effective settings with each session
and make them available when creating the next session. Editing settings for an
existing summarized session explains that its saved output needs rebuilding; explicit
rebuild archives the old output. Collection may continue while summarization pauses
for a rebuild decision. A browser refresh must not lose saved settings.

Record effective configuration, model identity, and prompt/schema versions with
derived output. Changes affecting summaries cause a clear rebuild-required result
before any old output is modified. Presentation-only changes do not invalidate text.
Validate window length as a finite positive integer dividing 60 for this release.

### Make rebuilds and concurrent execution predictable

Allow only one summarizer to write a session at a time. Test lock acquisition and
safe stale-lock recovery, including abrupt process termination. Collection remains
independent and append-only; result reads are read-only, while the application server
owns explicit configuration and lifecycle mutations.

Track processed transcript content fingerprints. If an already-processed window
changes, mark derived output stale and require an explicit archived rebuild. This
first release deliberately avoids automatic partial replay: topic routing and
rolling summaries depend on earlier results. Never present changed source text as
already reflected in a summary. Archive state and topics together, preserving
previous output for inspection; do not archive only the topic directory.

### Keep model support narrow

Extract the existing Claude subprocess transport behind a small runner boundary.
Keep timeouts, bounded concurrency, and tool restrictions. Validate returned
structured data before persisting it and report missing CLI/authentication failures
as actionable errors. Do not add another provider in this scope.

Keep fact-check and curation opt-in and Assembly-only for the first release;
reject unsupported profile/option combinations clearly. General meeting and lecture
processing must work without either feature. Do not infer public web verification
for private meeting statements.

### Prepare a reproducible local release

Bind the application to `127.0.0.1` and validate port input. Document `npm start`
and the resulting browser URL as the quick start. A port conflict fails with a useful
message before any worker starts. Keep legacy commands in an advanced-use section.
Do not add hosted service features. Preserve escaping of untrusted text in all output views.

Include synthetic Assembly and general-content fixtures, a precomputed general
demo, setup instructions, supported-format limits, and CI running tests and lint.
Explain that local execution still sends text to the configured model service and
that image sharing currently depends on external browser assets. Keep runtime data,
logs, credentials, and real meeting exports out of committed demo material.

### Approved delivery order

Each item is an independently verifiable outcome, not a shared integration branch:

1. One-command browser workflow: server-owned workers, safe session controls,
   direct-URL selection, focus form, status/stop/retry, and saved Assembly sessions.
   Include validation, loopback protection, and writer ownership in this usable slice.
2. Live broadcast catalog: verified upstream integration, list selection, refresh,
   eligibility checks, and URL fallback in the existing browser workflow.
3. Trustworthy rebuilds: persisted configuration and source fingerprints, stale
   output reporting, and archived state/topic rebuilds.
4. End-to-end general JSONL session: browser upload, elapsed-time processing, neutral
   profile, compatible viewer/exports, and isolated model runner.
5. SRT and WebVTT uploads into that working general session flow.
6. Multiple interest categories in the browser with legacy focus compatibility and
   rebuild checks; the basic focus form already ships in the first slice.
7. Public-facing setup, synthetic demo, CI, and final compatibility/browser checks.

## Alternatives rejected

- A universal streaming/STT plugin platform: exceeds the selected two-input scope.
- A shell script launching three fixed commands: still requires terminal-selected
  meetings and provides no browser lifecycle or configuration control.
- Moving collection and model calls into request handlers: couples their lifetime
  to HTTP requests and weakens failure isolation; supervised workers fit existing code.
- Browser-side Assembly requests: depend on cross-origin access and expose upstream
  variability to the UI; normalize responses in the local server instead.
- Changing only prompt text: leaves parliamentary storage and presentation semantics.
- Epoch timestamps for imported files: invents dates and breaks elapsed-time display.
- Destructive migration of all stored sessions: unnecessary risk to existing records.
- Automatic replay of only a corrected window: later routing and cumulative summaries
  can retain invalid dependencies; an explicit full rebuild is simpler to verify.
- Supporting several model providers immediately: adds independent contracts before
  the first generic input flow is proven.
- A database or hosted multi-user service: adds operational obligations without
  serving the selected local workflow.

## Testing Decisions

- Baseline on 2026-10-24: `npm test` passed 16 tests; `npm run lint` passed.
- Use `node --test` for parser fixtures, malformed input, profile rules, legacy
  compatibility, elapsed/absolute time boundaries, and configuration invalidation.
- Exercise application subprocess/API flows in temporary directories: upload,
  fake-runner summary, read API, resume, rebuild, lock contention, and unchanged-source rerun.
  The fake runner tests orchestration, not actual model quality.
- Exercise one-command startup and browser control against fake workers and local
  upstream fixtures: duplicate Start, summary failure with collection continuing,
  stop during queued reconnect, tab close, server shutdown, and interrupted restart.
- Test catalog live/empty/unavailable/malformed states, unsupported captions, status
  changes between listing and starting, and direct-URL fallback. Fixtures must match
  observed upstream fields. Do not require a currently live broadcast in CI.
- Test Host/Origin/token checks, upload limits, invalid URLs and paths, invalid
  configuration, and subprocess argument handling before mutations occur.
- Include correction-after-summary and last-partial-window regression cases.
- Test failed imports and rejected configuration before writes, and inspect archived
  output to prove prior records remain available.
- Visually check desktop and mobile views for an Assembly fixture and a general
  meeting/lecture fixture, including speaker filters, elapsed times, and share images.
  Cover broadcast selection, focus entry, upload, start/stop/retry, saved-session
  navigation, and refresh while workers continue. Verify no normal workflow needs
  terminal arguments after `npm start`.
- Run a real Claude smoke test on synthetic input when credentials are available;
  report skipped live checks explicitly. A live Assembly connection is a separate
  verification from replayed protocol fixtures.
- Run `npm test` and `npm run lint` for every relevant implementation slice and CI.

## Out of Scope

- Audio/video transcription, diarization, translation, or new live platforms.
- Hosted accounts, authentication, multi-tenancy, or public deployment.
- Additional model providers, general-profile fact-checking/curation, and automatic
  curation application.
- Full WebVTT styling, streaming file ingestion, and editing imported source cues.
- Package renaming, npm publication, repository visibility changes, license choice,
  or redistribution of real Assembly transcripts in examples. Those publication
  decisions require a separate explicit release decision.

## Further Notes

The source inspection supports the design, but current live Assembly behavior,
Claude execution, and browser rendering have not been verified in this planning run.
Existing test success does not establish those integrations or general-input support.
Public release remains incomplete until a license is selected and release contents
and external-source usage requirements are reviewed for the actual publication.

### Publication approval update — 2026-10-24

During delivery item 1, the user separately requested a public GitHub repository
(`github에 public으로`). This authorizes publishing the audited repository as
`kadragon/assembly-parser`; it does not select a license or mark the remaining
delivery items complete. Minimal test/lint CI accompanies this publication.
