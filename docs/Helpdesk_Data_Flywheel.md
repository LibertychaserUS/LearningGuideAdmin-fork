# Helpdesk data flywheel (v5 Part G3 to G6, Admin server)

Specs: `helpdesk-v5-context-chips-and-smalltalk.md` Part G, and `helpdesk-v5-faq-graph-design.md` §3 and §5 item 5. The staff screens are in the BackOffice client (see [Staff screens](#staff-screens-g4-and-g6-backoffice-client)). There is no Figma for them, so they reuse the existing HelpDesk styles and need visual sign-off (待视觉验收).

## Where the data comes from

**Admin cannot read Portal's database.** Every number and every learner phrase in the flywheel comes from Portal's integration feed, `GET /api/integration/helpdesk/insights` (contract fixture v7). Admin calls it nightly through `portalHelpdeskClient.insights` and stores the rows in its own fact table, `helpdesk_insight_turns`.

- **Learner text.** Portal runs its code-only PII scrubber before any text leaves Portal. Placeholders look like `<email>`, `<phone>` and `<name>`.
- **Everything else** is an enum label: kind, guard, vote, rating, covered, handover, the ticket outcome, and signals.
- **What the feed never contains:** learner ids, names, emails, orders, ticket ids or titles, answer text, or trace ids.
- **Upserts** are idempotent by Portal's turn id. A row whose content has not changed is not rewritten, but its `checked_at` is set to the time of the pull.
- **Pull window.** Each pull starts 72 hours before the newest stored turn, so late votes and ratings settle. The first pull covers the last 30 days. One night reads at most 200 pages of 500 turns; if more remain, `moreDue` is set and the next run carries on.
- **Outcome refresh.** Ticket outcomes settle later than 72 hours: a ticket can open up to 24 h after the chat, the agent then works on it, and auto-confirm waits up to 72 h more. So each night also re-pulls an older window, from the earliest turn of the last 14 days whose outcome can still change (a ticket that is not closed yet, or no pull yet at least 24 h after the turn) up to the start of the normal window (`until`), at most 100 pages. It is reported as `pull.refresh`. After mining, every open candidate's source mix and draft sources are refreshed from its member turns (`mine.refreshed`), so a ticket that was resolved later gives "起草" a source.
- **If Portal is not configured,** the run skips the pull and still mines (`not_connected`). If Portal fails, the run still mines what is stored, but the run is recorded as failed and is retried.
- **Raw text retention** (180 days, then scrubbed text and labels only) is Portal's job, `assist_retention`. Admin only shows its runs and has a "run now" button (see the endpoints below).

## Nightly gap mining (G3)

The code is in `server/src/backoffice/modules/helpdesk/flywheel/`.

1. **Select.** Take the unsolved, mineable turns from the last 30 days that no candidate holds yet, newest first, at most 2,000. The mineable rule is applied in SQL before the limit, so small talk and greetings followed by a ticket never take the places of real gaps. A turn is unsolved if it has `no_match`, a `not_helpful` vote, a clarify that was not covered, a handover, a ticket after the chat, or a rating of 2 or less.
   - The same rule exists in SQL (the `unsolved` column of the view) and in TS (`unsolvedReasons`).
   - Small talk, handover requests, greetings and farewells, prompt-injection attempts and private-data turns are never mined.
2. **Group.** Turns are grouped by meaning with the existing retrieval similarity: opencc forms, character n-grams and English stems, IDF weighted, compared by cosine to each group's centroid. This sits behind the `TextSimilarity` interface, so embeddings can replace it later.
   - Groups need at least 2 turns.
   - A turn close to an open or dismissed candidate grows that candidate instead. Dismissed candidates absorb their repeats and do not come back to the queue.
3. **Label.** Each new group gets one small guarded model call, larger groups first, at most 30 calls and USD 0.10 a night. The call is made through `HELPDESK_GAP_LABELLER`, which `app.module.ts` wires to the Agent's pi step runner and the suggest model.
   - The model sees up to 5 scrubbed examples. It returns a topic, one learner-style question and a category enum. It never writes answers.
   - Both texts pass `guardGapLabel`, which rejects markup, emails, links, digits or number words not found in the examples, overlong text, AI filler and wrong script.
   - With no `OPENROUTER_API_KEY`, under `NODE_ENV=test`, over budget, on error or timeout, or when the guard fails, a code label is used instead.
4. **Dedupe.** Each group is compared with the working table's published answer nodes (their questions and phrasings), which gives one of three suggestions:
   - `add_phrasing` to node X, when the score is 0.5 or more;
   - `follow_up` under `parent_node_id`, when most members were shown children of the same parent;
   - otherwise `new_faq`.
5. **Store.** `helpdesk_faq_candidates` holds the topic, the proposed question, the count, at most 5 scrubbed examples, the related, parent and shown nodes, the source mix, at most 3 scrubbed human replies from resolved enquiries (draft sources only), and the status (new, accepted, dismissed or merged), plus the reason and an audit trail.
   - `helpdesk_faq_candidate_turns` makes a turn belong to at most one candidate, so re-runs never double count.

**Scheduling** happens in process. `HelpdeskFlywheelScheduler` starts after application bootstrap. It first checks 2 to 3 minutes after start and then every 30 minutes, with unref'd timers, so it never blocks startup or shutdown.

- From 18:00 UTC (02:00 Beijing time), a check takes the PostgreSQL advisory lock `(719320, 1)` and claims the day's row in `helpdesk_flywheel_runs`. The day's run happens once, which makes it idempotent per day.
- A failed run is retried, up to 3 attempts a day. A run whose heartbeat is more than 30 minutes old is taken over. A manual run still `running` when another run takes the lock was left by an instance that died; it is closed as failed with error code `stale`.
- Each run writes one structured log line: `{"type":"helpdesk","event":"flywheel_job_run",...}`, with counts and error codes only, never text.
- **No new ops config.** It needs no AWS and no scheduler outside the app. The scheduler is not started under `NODE_ENV=test`.

## Staff endpoints (G3 and G4)

All endpoints are under `/api/helpdesk/`. The guard is menu `helpDesk`: GET needs VIEW, writes need FULL. The actor is always the signed-in employee. Decisions carry `version`, and an optional `Idempotency-Key` makes the same decision replay as 200. A different decision with the same key is 422, and a stale version is 409 `CANDIDATE_CHANGED`. Each decision writes a revision row in the same transaction (`helpdesk_faq_candidate_revisions`, append-only).

| Method and path | What it does |
| --- | --- |
| `GET faq-candidates?status&suggestion&origin&q&page&pageSize` | The queue, biggest groups first, with per-status counts and node summaries |
| `GET faq-candidates/:id` | One candidate, its revisions (with `employeeName`, the staff member's display name at the time) and its nodes. Revisions never hold learner text: examples, draft sources, topic and question are stored as counts |
| `GET faq-candidates/:id/review` | Review data for one candidate (read only, no model call): the suggestion and its reason, how the AI handled those turns at the time, similar cards and the suggested place |
| `GET faq-map` | The structure map (process tree and rule table) used by the review page's place picker |
| `GET faq-candidates/:id/draft` | Prefill for a new FAQ or a follow-up: questions by language, category, placeholder-free phrasings. **The answer is empty for staff to write.** `answerDraft` holds only human replies from resolved enquiries, labelled 草稿 待核实 / "Draft, to be verified" |
| `POST faq-candidates/:id/accept` `{as, faqId, parentId?, phrasings?, version}` | `as` is one of `add_phrasing`, `new_faq` or `follow_up`. FAQs have no draft state (saving publishes), so for `new_faq` and `follow_up` staff create the node with `POST faqs` from the draft first, then accept with its `faqId`. `follow_up` also links `parentId` to `faqId`. The chosen examples (`phrasings`, example numbers; by default every example without a placeholder) alternate: the first becomes a `flywheel` phrasing of that node, the next only a **regression case for that node**, and so on (a single example only becomes a phrasing), so the release check never grades a card on its own sentences (owner 2026-11-06, overfitting). The review drawer says how many were held out as cases. Unticked examples and examples with a placeholder never become cases. The whole accept runs under a per-candidate PostgreSQL advisory lock, so when two staff accept at once the second gets 409 and leaves no phrasings, edges or cases behind. |
| `POST faq-candidates/:id/dismiss` `{reason, note?, version}` | `reason` is one of duplicate, not_a_gap, out_of_scope, personal_data, spam or other; `other` needs a note. The note is scrubbed. With `personal_data`, the same transaction empties the candidate's examples and draft sources, sets its topic and proposed question to `<redacted>`, and clears the text and agent reply of its member turns in the fact table (`redacted_at`, so a later pull does not write them back) |
| `POST faq-candidates/:id/merge` `{targetId, version}` | Moves turns, counts and examples into an open candidate |
| `POST tickets/:ticketId/faq-candidate` | "转成 FAQ 候选". Only for a resolved enquiry (CLOSED, not cancelled). Takes the learner's first message and the last public agent reply and scrubs them **in Admin** with the same scrubber (`piiScrubber.ts`, corpus pinned by hash in both repos) plus the learner's own name and emails. The reply becomes a draft source only, and only when the agent resolved the enquiry (close reason `user_confirmed` or `auto_confirmed`); a ticket the learner closed themselves (`user_closed`) gives no draft source. Idempotent per ticket: 201, then 200 |
| `GET faq-eval-cases` | The regression cases as JSON Lines `{faqKey, locale, text}` |
| `GET flywheel/jobs/gap_mining/runs`, `GET …/runs/:runId` | The run rows: status, attempts, counts, duration, error code, who started it |
| `POST flywheel/jobs/gap_mining/run` (Idempotency-Key required) | Run now: 201 new (it runs in the background; poll the run), 200 same key, 409 `JOB_ALREADY_RUNNING`, 503 `JOB_START_FAILED` when the run could not be started (for example a database error; try again). Audited (`HELPDESK_JOB_RUN`) |
| `GET jobs/assist-retention`, `POST jobs/assist-retention/run` | Portal's retention job: its runs, and run now (Portal does the locking and idempotency). Audited |
| `GET flywheel/metrics?granularity=day\|week&from&to&split=none\|locale\|entry\|signal` | See G6 below |
| `GET flywheel/ticket-stats?from&to` | Portal's read-only daily ticket numbers (UTC days, at most 92): created, resolved, cancelled, still open at day end, time to first staff reply |

## Release gate (G5)

The retrieval gate run before publishing (`createRetrievalGate`) also evaluates `helpdesk_faq_eval_cases`, labelled with the node staff chose. Cases for nodes that are not retrievable entry answers in that release are counted in `regressionSkipped`. A case whose text is the node's own question or one of its phrasings (cases accepted before the split above) is not asked and is counted in `regressionLeaked`; the live-pipeline check skips it the same way. The metrics also report `regressionCases`.

**CI** has a job named "HelpDesk eval gate" in `.github/workflows/ci.yml`. It is free: no model and no key. It runs four specs with `CI=true`, so a missing database fails the job instead of skipping:

- `helpdesk-eval-gate.pg.spec.ts` seeds `server/eval/helpdesk/faq-library.json` (the reviewed v2 library without its evidence) through the normal services and publishes v1. Recall@8 must be at least 95% over the questions, the phrasings and `server/eval/helpdesk/regression-cases.jsonl`.
- The guard corpus (`guard.spec.ts`, `gap-labeller.spec.ts`).
- The shared PII corpus (`helpdesk-pii-corpus.spec.ts`).

To grow the regression file, export `GET /api/helpdesk/faq-eval-cases` and append the lines. Portal's CI has the matching "HelpDesk scrubber corpus" job.

## Metrics (G6)

All metrics come from SQL over the view `helpdesk_insight_turn_facts`, with no second data source. Where a denominator is 0, the rate is `null`.

| Metric | Definition |
| --- | --- |
| AI-solved rate | Settled answers with no ticket within 24 h, over settled answers. An answer is settled once a pull at least 24 h after it has seen it (`checked_at >= created_at + 24 h`), so a late or failed pull never overstates the rate |
| no_match rate | `no_match` turns over all turns |
| Helpful rate | helpful + solved, over all votes |
| Average rating | Mean of the ratings given |
| Handover rate | Handover turns over all turns |
| Clarify covered rate | Covered clarifies over all clarifies |
| Guard fallback rate | Guard result other than `passed`, over turns that have a guard result |

- **Granularity:** daily (up to 92 days) or weekly (up to 366 days). Days and weeks are cut in UTC (`timezone: "UTC"`) and weeks start on Monday (`weekStartsOn: "monday"`). A week that the range covers only in part has `partial: true`.
- **Splits:** by locale, by entry or by signal. Signals are unnested, and `none` means no signal.
- **Also returned:** the top 10 gap groups, the 10 FAQs that most often lead to a ticket within 24 hours, and `lastIngestedAt`.

**"Entry" is the turn's `source`** (submit, chat or chip). Portal's feed has no entry page, so a page-level split needs a new Portal field first.

## Staff screens (G4 and G6, BackOffice client)

The screens have no Figma boards. They reuse the HelpDesk filter row, table, chip, drawer and notice styles, and they need visual sign-off (待视觉验收). The copy is in both `en-GB` and `zh-CN`. Every control is a native button, select, checkbox or radio, so it works with the keyboard. Drawers trap focus, close on Escape and give focus back. Results are announced in a status or alert region.

The code is in `client/src/backoffice/helpdesk/`. The pure logic is in `client/src/backoffice/lib/helpdeskFlywheel.ts`.

**"FAQ 候选" tab** (`/help-desk?tab=candidates`, `CandidatesView.tsx`):
- **Jobs.** The last nightly gap-mining run and the last Portal `assist_retention` run show when they ran, who started them and their counts.
  - **Run now** (FULL only) sends an Idempotency-Key. A key is reused only when a network failure leaves no response.
  - Gap mining then polls its run every second and reloads the queue when it ends. Retention reports the rows it scrubbed.
- **Queue.** The server sorts it by count. Staff filter by status (default `new`), suggestion, origin and text. The filters live in the address bar.
- **Each row** shows the topic, the proposed question, the suggestion, the source mix, the count and when it was last seen.
- **Paging.** The pager shows whenever there is more than one page or the page is past the first. A page past the end (the queue shrank after a decision, or a stale link) goes back to the last page.

**Candidate detail** (`?candidate=<id>`, `CandidateDrawer.tsx`) is open to every role. It shows:
- the scrubbed examples, with placeholders marked as hidden personal details;
- the source mix and the related nodes (closest FAQ and its similarity, parent, card on screen, accepted FAQ);
- the source ticket, and the audit history (who, by display name when the server has it, and when);
- for a merged candidate, a button that opens the candidate it was merged into.

Escape closes an open form, then the drawer, but does nothing while a decision is being sent or the draft is loading, so the result is always shown. If the drawer is closed while the draft loads, the FAQ editor does not open on its own.

**Decisions** are for FULL staff, and only while the candidate is `new`. Each sends the candidate's `version` and an Idempotency-Key, and a retry of the same decision reuses the key. When someone else changed the candidate first (409 `CANDIDATE_CHANGED`), the drawer reloads it and explains.
- **New FAQ** fetches `GET …/draft` and opens the FAQ editor prefilled: questions, category and entry come from the draft, and the answers are empty. When the group has human replies from resolved tickets, the editor shows a **草稿 待核实 / Draft, to be verified** panel. "起草" copies a reply into the answer box for its language and keeps a "check every fact" warning under that box. After the FAQ is saved, the page accepts the candidate with the new `faqId` and the ticked examples.
- **Add as follow-up** first asks for the parent question; the default is the parent the learners were on. It then opens the same editor with entry off, and accepting creates the edge.
- **Add phrasing** adds the ticked examples to the closest FAQ, or to another answer card found by search.
- **Dismiss** needs a reason; `other` needs a note. `personal_data` also removes the examples, sources and the turns' text on the server.
- Examples with a placeholder can never be ticked.

**"转成 FAQ 候选"** appears under the action bar of a resolved ticket (CLOSED, not cancelled), for FULL staff only. The result notice links to the candidate.

**"HelpDesk 数据" tab** (`/help-desk?tab=data`, `FlywheelDataView.tsx`):
- **Controls:** daily (7, 28 or 92 days) or weekly (12, 26 or 52 weeks), ending today (UTC), and a split. A note says that days and weeks are in UTC and weeks start on Monday; a week the range covers only in part is labelled "(partial week)".
- **The "Channel" split** (`split=entry` in the API) is the turn's source: ticket form, chat or suggested question. A hint under the controls says it is not the page the learner was on (Portal's feed has no page yet).
- **Trends** (2026-10-31): one module with selectable tabs instead of separate blocks: Questions, AI-solved rate, no-match rate, handover rate, helpful rate, user rating, Tickets (from `flywheel/ticket-stats`, at most 92 days) and the nightly Background job. Each tab shows the period value and the last change; the chosen one draws one large line chart (`LineChart.tsx`, hand-written SVG; the client still has no chart library) with hover and keyboard read-out, gaps for empty periods and hollow points for a partial week.
- **Per-segment table** when a split is chosen (the trend stays overall).
- **Lists** in a two-tab switch: the top gap groups (with "Open" to the candidate) and the FAQs that most often lead to a ticket; long lists fold behind "Show all".
- **States:** loading, empty ("no conversations in this period yet") and error. The page also shows when data was last pulled from Portal.

