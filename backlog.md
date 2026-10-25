# Backlog

The design and seven-slice delivery order were approved on 2026-10-24.
Each heading owns one independently mergeable task. Keep the numbered slugs stable;
remove a dependency marker only after its prerequisite has landed.
Every implementation task runs `npm test` and `npm run lint`, preserves existing
Assembly commands and data, and records any live/model/browser checks not performed.
No task authorizes publishing the repository, selecting a license, or deploying a service.

## 1-browser-session-control

  - Source: [Approved design](docs/design/transcript-generalization.md), One server,
    browser-owned session setup; Browser control and uploads; delivery item 1.
  - Scope: `npm start`, home/session views, direct player-URL entry, basic focus
    keywords and scope notes, worker ownership, and session lifecycle controls.
  - Approach: Keep the existing Node/file/static-UI stack. Supervise collector and
    summarizer workers through a local application server; retain standalone commands.
    Use argument arrays, validated session-scoped APIs, and shared writer locks.
  - Acceptance: A fresh start without a meeting argument serves a loopback home page;
    port conflicts start no workers. URL and focus submission starts collection and
    summary together without further terminal input. Prove through subprocess/API
    integration tests and a desktop/mobile browser walkthrough.
  - Acceptance: Validate Assembly player origin/path/identifiers and metadata before
    starting. Invalid session paths, window values, ports, and payloads cause no
    writes or worker starts; Host/Origin/token checks reject foreign write requests.
    Prove with negative API cases, including shell metacharacters as literal input.
  - Acceptance: Repeated Start and concurrent clients cannot create duplicate writers;
    existing CLI workers conflict safely. Summary failure leaves collection running.
    Bound summary execution across sessions. Prove with controlled subprocess workers.
  - Acceptance: Saved sessions and focus settings survive browser refresh; opening a
    different session or closing a tab does not stop work. Show distinct collection,
    summary, stopped/interrupted, and error states, with session-specific retry/resume.
  - Acceptance: Stop cancels reconnect timers; graceful server shutdown cleans up owned
    workers/model children. Restart does not silently resume collection and identifies
    missed intervals. Finalizing a stopped session includes its last partial window.
    Prove with shutdown/restart, queued-reconnect, and partial-window regression cases.
  - Boundary: No catalog, uploads, category editor, or silent reconfiguration of
    processed sessions. Until task 3, refuse changes that require rebuilding.
  - Dependencies: None.

## 2-live-broadcast-catalog

  - Source: [Approved design](docs/design/transcript-generalization.md), Discover
    broadcasts from the existing Assembly contract; delivery item 2.
  - Scope: Server-side catalog fetch, normalized listing, refresh, meeting selection,
    and start-time eligibility feedback in the existing browser flow.
  - Approach: Verify the official `main.js` / `service/live_list.asp` contract again
    at implementation time. Use the fixed Assembly origin, bounded requests/cache,
    and the existing metadata resolver. Do not invent an unrelated generic feed API.
  - Acceptance: Display committee, subject, and live status; distinguish no live
    broadcasts from a failed lookup. A selected meeting enters the existing focus
    and Start flow. Manual refresh and direct-URL entry remain usable independently.
  - Acceptance: Revalidate state and AI-caption eligibility before Start; explain
    unavailable/stenographer captions without launching doomed workers. Test state
    changes between listing and starting, malformed responses, timeout, and empty data.
  - Acceptance: Fixture-backed integration checks and desktop/mobile browser checks
    cover selection through Start. Record a real catalog probe separately from any
    live-caption connection test; CI does not require an ongoing broadcast.
  - Dependencies: 1-browser-session-control.

## 3-trustworthy-rebuilds

  - Source: [Approved design](docs/design/transcript-generalization.md), Persist
    effective configuration; Make rebuilds and concurrent execution predictable;
    delivery item 3.
  - Scope: Effective configuration/version persistence, source fingerprints, stale
    reporting, browser rebuild action, and state/topic archives.
  - Approach: Record all summary-affecting settings, model identity, prompt/schema
    versions, and processed transcript fingerprints. Require explicit full rebuild
    because later routing and summaries depend on earlier output.
  - Acceptance: Reproduce the current missed-invalidation cases for changed focus
    notes/keywords and corrected processed captions before implementing the fix.
    Afterwards, show stale/rebuild-required status without silently overwriting output.
  - Acceptance: Unchanged input resumes without duplicate entries or redundant model
    calls; presentation-only changes do not invalidate summaries. Test configuration
    precedence and omitted CLI flags against saved effective settings.
  - Acceptance: Collection can continue while summaries pause for a rebuild decision.
    Explicit rebuild archives both state and topics, preserves original transcripts,
    and reprocesses in order. Simulated interruption cannot destroy the only prior
    output; no concurrent writer can mix old and new results.
  - Acceptance: Verify old records without version metadata remain viewable without
    rewriting them. Browser checks cover stale indicators, archive/rebuild feedback,
    refresh persistence, and error recovery.
  - Dependencies: 1-browser-session-control. Task 2 precedes this in the approved
    delivery order but is not a technical prerequisite.

## 4-general-jsonl-sessions

  - Source: [Approved design](docs/design/transcript-generalization.md), Normalize
    inputs and make time explicit; Separate domain rules from shared processing;
    Keep model support narrow; delivery item 4.
  - Scope: Browser JSONL upload, versioned session/line contract, general profile,
    elapsed-time processing, compatible UI/exports, and Claude runner boundary.
  - Approach: Validate/stage the full upload before exposing a new session. Keep
    absolute Assembly time separate from elapsed file time. Use neutral speakers and
    organizations for general output and read adapters for legacy Assembly fields.
    Extract only the existing Claude transport; do not add another provider.
  - Acceptance: Document and exercise the JSONL contract with synthetic meeting and
    lecture examples. Upload, summarize, view/filter, export, and reopen a session
    without terminal arguments; optional explicit speakers are retained without
    invented titles. UI, Markdown, and share images use the selected profile.
  - Acceptance: Process all populated windows, including a last partial window,
    independently of wall-clock time. Durations beyond 24 hours do not wrap; overlapping
    cues retain stable order and start-time window assignment avoids duplication.
  - Acceptance: Reject invalid/negative times, inverted intervals, empty records,
    duplicate destination sessions, unsafe names, and oversized uploads before
    exposing a session; clean staging files after failure. Report error locations.
  - Acceptance: General sessions reject Assembly-only fact-check/curation options.
    Structured model output is validated before persistence; missing CLI/auth failures
    are actionable. Preserve timeout, tool restrictions, and concurrency bounds.
  - Acceptance: Legacy fixtures remain readable without mutation. Fake-runner API
    tests prove orchestration; a real synthetic Claude smoke test is reported separately.
    Desktop/mobile checks show completed files without misleading live-idle warnings.
  - Dependencies: 3-trustworthy-rebuilds (and its browser-control prerequisite).

## 5-subtitle-file-uploads

- [ ] [FEAT] Upload SRT and WebVTT into the general-session workflow.
  - Source: [Approved design](docs/design/transcript-generalization.md), Normalize
    inputs and make time explicit; delivery item 5.
  - Scope: SRT/WebVTT parsing and format feedback in the existing browser uploader.
  - Approach: Normalize cues into the contract from task 4; keep cue identifiers or
    ordinal positions for traceability. Reuse staging, size limits, and atomic import.
  - Acceptance: UTF-8 BOM, CRLF, multiline cues, overlapping cues, WebVTT cue settings,
    and explicit voice labels work. Ignore NOTE/STYLE/REGION presentation blocks;
    do not infer speakers from unlabeled text or render caption markup as HTML.
  - Acceptance: Malformed timestamps, inverted ranges, empty usable content, and
    invalid format produce actionable locations and no partially usable session.
    Fixture tests cover the supported subset and documented exclusions.
  - Acceptance: Upload one SRT meeting and one VTT lecture through the browser and
    verify elapsed-time summaries, filters, saved sessions, and exports using the
    same pipeline as JSONL. Include a fixture whose final cue crosses a window edge.
  - Dependencies: 4-general-jsonl-sessions.

## 6-interest-category-editor

- [ ] [FEAT] Configure multiple interest categories in the browser.
  - Source: [Approved design](docs/design/transcript-generalization.md), Persist
    effective configuration; delivery item 6.
  - Scope: Named ordered categories, descriptions, keyword chips, explicit fallback,
    configuration reuse, and legacy focus compatibility across both profiles.
  - Approach: Extend the basic focus form and persisted settings. Supply category
    rules to the profile-specific router; keywords remain contextual hints.
  - Acceptance: Create, edit, reorder, and reuse categories without editing JSON;
    validate unique nonempty names and exactly one fallback. Refresh retains saved
    settings; UI filters and exports reflect the selected categories.
  - Acceptance: Empty focus retains overall summaries; old focus flags still provide
    their original two-category shorthand. Reject mixing explicit categories with
    focus flags, and test explicit-vs-omitted CLI precedence.
  - Acceptance: Editing summary-affecting category rules invokes task 3's explicit
    rebuild flow and preserves old results. Prompt/contract tests and synthetic
    browser runs cover both profiles; do not equate a mocked route with model quality.
  - Dependencies: 4-general-jsonl-sessions, which includes rebuild support.
    Task 5 precedes this in delivery order but is not a technical prerequisite.

## 7-public-release-preparation

- [ ] [DOCS] Deliver a reproducible demo, CI, and public-facing setup documentation. *(blocked by: 5-subtitle-file-uploads)* *(blocked by: 6-interest-category-editor)*
  - Source: [Approved design](docs/design/transcript-generalization.md), Prepare a
    reproducible local release; Testing Decisions; Out of Scope; delivery item 7.
  - Scope: Synthetic fixtures/precomputed demo, one-command quick start, supported
    formats and limitations, CI, and final compatibility/browser validation.
  - Approach: Keep `npm start` as the primary documented workflow and move legacy
    commands into advanced usage. Provide demo content that does not require live
    broadcast access or Claude credentials to view; do not copy real session data.
  - Acceptance: A clean checkout can install dependencies, run checks, start the app,
    and view the documented demo. CI runs `npm test` and `npm run lint` without model
    credentials or active broadcasts. Package description matches implemented behavior.
  - Acceptance: Document Claude installation/authentication, text sent to the model
    service despite local execution, external share-image assets, input limitations,
    missed-live-caption intervals, recovery, and supported fact-check/curation scope.
  - Acceptance: Verify the complete desktop/mobile flow: catalog/URL, focus, Start,
    stop/retry, uploads, saved-session navigation, rebuild, filters, and sharing.
    Compare legacy Assembly fixtures and general fixtures; report actual CLI/live
    smoke-test evidence separately from fixtures and skipped checks.
  - Acceptance: Inspect committed release/demo contents for runtime data, logs, and
    credentials. Document that license selection and actual publication remain
    separate decisions; do not claim the repository has been published.
  - Dependencies: 2-live-broadcast-catalog, 5-subtitle-file-uploads,
    6-interest-category-editor, and their transitive prerequisites.

## Review Backlog

### PR #2 — Live broadcast catalog (2026-10-25)

- [ ] [debt] Use the live_list.asp `xsami` subtitle hint to mark caption-ineligible live entries in the catalog once its meaning is confirmed against a live broadcast; Start already revalidates (source: code-review) — src/catalog.js:37

### PR #3 — Trustworthy rebuilds (2026-10-25)

- [ ] [debt] Confirm against a live broadcast how late STT finals arrive after the 30s grace period; word changes or first captions landing after a window was summarized still pause live summaries until a full rebuild (source: code-review) — src/rebuild.js:86
