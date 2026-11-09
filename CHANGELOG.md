# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `create_calendar_event` with `calendar` always refused on a real frame: Skylight gives an event's Google account only as a `calendar_account` relationship, and only when the request asks for it (`include=calendar_account`, as the web app does); the lookup read an attribute that is not there. It now asks for the relationship and reads it. The account id is also accepted as a string or a number (it was string-only), and a refusal says how many events it looked at, how many carried a calendar address and what type the account id had (counts and types only, never ids). Found on the first live run, where a refusal gave no way to tell a missing event from a misread field.

## [1.18.0] - 2026-11-09

### Added
- `create_calendar_event` takes `calendar`: the name of a linked Google calendar (a `gmail` source from `get_source_calendars`). Without it nothing changes: events and series go to Skylight's own calendar and do not appear in Google. With it the event (one-off or series) is written to that Google calendar, so everyone who shares it sees it. It is only previewed until `confirm: true`, and the preview names the calendar. The calendar address and account id never appear in any output. Refused, with nothing sent: an unknown or ambiguous name, a read-only calendar, a subscription feed, and a calendar with no existing event within 90 days of the new one (its account id is taken from such an event; Skylight's source-calendar record does not carry it). Decision D5. Not verified live: the real create against Google, and that the account id taken from an existing event is the one Skylight expects.
- `create_calendar_event` allows an all-day repeating series (`allDay: true` with `repeat`). Give `startsAt` and `endsAt` as dates `YYYY-MM-DD`, `endsAt` being the day after `startsAt` (one day per occurrence; the end is exclusive, as in the Skylight app). The request carries date-only start and end, `all_day: true`, and the same UNTIL-date rule as a timed series; it may start today. Multi-day occurrences and more than one profile are still refused. Shape taken from the captured app request (issue #62); not verified live: whether Skylight accepts the UNTIL, and that occurrences read back as all-day.

## [1.17.1] - 2026-11-08

### Fixed
- `get_chores` now prints each chore's id, `(ID: n)` after the name. `delete_chore`, `update_chore` and `complete_chore` take an id "from get_chores", but it was never printed, so a chore made in the app (or in an earlier session) could not be deleted or edited through the tools. Found 2026-11-08 while cleaning up a test chore. Recurring occurrences show their composite id.
- The live API-version test now accepts `unfiltered_linked_category_ids`, a chore attribute that appears only under API version 2026-10-15 (named by the fixed probe on 2026-11-08, the first time chores existed during a run; null on the sample). It is additive and no tool reads it. Test code only.

## [1.17.0] - 2026-11-08

### Added
- `delete_task_box_item`: delete one Task Box template by ID. When a chore is added in the Skylight app with "Save to Task Box" ticked, the app also saves a template, and neither record points at the other, so deleting the chore left the template behind (and deleting a template leaves already-scheduled chores alone, checked live on 2026-11-08 for a one-off chore). The tool deletes exactly the ID it is given, never by name; the preview names the template and lists same-name scheduled chores over the next 90 days as "link unverified"; it needs `confirm: true` and reads the Task Box back to confirm. `DELETE /task_box/items/{id}` is 204 with no body (captured from the web app). It is on the hosted delete allowlist (now nine entries). `get_task_box` now shows each item's ID. Not verified: the tool against the real API (the capture came from the app); deleting a routine template and what, if anything, that does to a habit tracker.

### Fixed
- `create_chore` and `create_reward` never worked against the real API: both sent a JSON:API wrapper and Skylight answered HTTP 422 ("Category is required." / "Category ids is required.") every time, with or without an assignee. They now send the flat bodies the web app sends (captured 2026-11-08): chores go to `POST /chores/create_multiple` with `category_ids`, rewards to `POST /rewards` with `category_ids`, and the array replies (one item per profile) are read correctly. An assignee is now required (it was documented as optional) and a missing one is refused before any request. `create_chore` no longer accepts `recurring` or `recurrencePattern`: only the routine shape has been captured, so use `create_routine`. Description and emoji keys for rewards are sent only when given and were not in the capture. Request shape checked against the capture in tests (mutation-checked); live create and delete of one chore and one reward was done through the web app, not through these tools, so a live run of the fixed tools is still to do.
- The live API-version test printed `<key>` for any key of 24 or more characters, which hid a real long field name behind its own leak guard. It now keeps lowercase snake_case field names and still hides ids, dates and token-like keys. Test code only.
- `update_calendar_event` with scope `one` on a series no longer prints an ID for the detached event. Skylight's reply carries the series occurrence's ID, not the new event's, so the old message pointed a caller at the wrong event; it now says to read the new ID back with `get_calendar_events`. Checked live on 2026-11-08: a time change with scope `one` detached only that occurrence and left the rest of the series alone (scope `all` was verified earlier the same day), so the "not tried live" caveat on scope `one` is gone from the tool description and README.

## [1.16.0] - 2026-11-08

### Added
- `update_calendar_event` on a repeating series can change the time of day: give `startsAt` and `endsAt` together, both on the occurrence's `date`, local times with no offset. Sent as `starts_at`, `ends_at` and `timezone` with `apply_to`, plus the current profile assignment. Checked live on 2026-11-08 with scope `all` on a throwaway weekly series of 3: every occurrence moved, it stayed one series with the same rule, and the occurrence ids changed (they embed the start time). Scope `one` is accepted but has not been tried live. Notes, location and all-day edits on a series are still refused.

### Fixed
- The live API-version test now counts an endpoint that answers with a bare empty array as empty (it only looked at a `data` array), so an empty endpoint is no longer reported as compared. The counting moved to a small tested helper (`itemCount`), mutation-checked. Test code only; no change to the shipped server.

### Documentation
- README, hosted-server section: removed the sentence saying calendar events stay local-only (since 1.14.0 `delete_calendar_event` is on the hosted allowlist, as the paragraph above it says), and stopped implying that `confirm: true` guarantees a person approved a delete. It is a flag the model sets; the limiter and the allowlist are the enforced limits.

## [1.15.0] - 2026-11-08

### Added
- `create_calendar_event` takes `repeat` to create a repeating series: `frequency` daily or weekly, `interval`, `byDay` (weekly, must be the weekday of `startsAt`), and exactly one of `until` or `count`; at most 104 occurrences over two years, no open-ended series. A series is only previewed (every date listed, nothing written) until the call repeats with `confirm: true`. It is created on Skylight's own calendar (the caller cannot choose a calendar; checked live on 2026-11-08: no calendar fields are sent, the series reads back as `source: skylight`, and nothing is written to Google), and is refused for all-day events, more than one profile, past starts and unknown fields. `count` is sent as the `UNTIL` of the last occurrence, never as `COUNT`. Checked live: a weekly series of 3 read back with the right dates and times, the generated `UNTIL` was accepted, and `delete_calendar_event` scope `all` removed it. Not yet verified live: daily rules.

### Documentation
- A red caution (GitHub `[!CAUTION]` alert) in the README and SECURITY.md spells out the access a hosted connection has: create, edit and delete on every Google calendar synced to the frame, including a family member's personal calendar, with no undo from this server and no confirmation prompt in some clients. Google records these changes as made by the account connected to Skylight.

### Security
- The CI workflow now declares `permissions: contents: read` explicitly (a CodeQL finding, "Workflow does not contain permissions"). The repository default was already read-only, so behaviour is unchanged; the declaration makes it independent of that setting.

## [1.14.0] - 2026-11-07

### Added
- Repeating events: `delete_calendar_event` takes a `scope` (`one`, `future`, `all`) and `update_calendar_event` takes a `scope` (`one`, `all`) plus the occurrence's `date`. Captured from the Skylight web app and checked against a Google calendar on 2026-11-07. The scope is sent as `apply_to`: in the JSON body for an edit, as a query parameter for a delete. The delete preview names what the scope removes and shows the repeat rule.
- `update_calendar_event` on a series only changes the title and the profile assignment (the only fields captured); it re-sends the current assignment the way the app does, so a title change cannot clear it. Time, notes and location edits on a series are refused as unverified.

### Changed
- `delete_calendar_event` now works on events synced from a Google calendar (it refused them before because write-through was unverified). The preview says the delete also removes the event at Google for everyone who shares that calendar. Subscribed-feed events, non-editable events and an occurrence that was edited on its own are still refused.
- There is no `future` scope for edits: Skylight's own API answers 400 "All this and future updates are not currently supported", although its app offers the option.
- Still unverified: feed-backed calendars, all-day repeating events, deleting a one-off Google event by this path (the plain DELETE is the same call as before), and whether a deleted Google event stays gone over days.

## [1.13.1] - 2026-11-06

### Fixed
- The change limit now works on the hosted Worker. In 1.13.0 the count lived in module memory and the Worker did not carry it from one request to the next: three calls a few seconds apart each logged a count of 1, so the 60-changes and 10-deletes-per-hour limit never applied there (it was never checked live before release, and the mocked tests ran in one long-lived Node process). The count is now kept in a Durable Object, one per Skylight frame. Checked in the real Workers runtime locally: counts rise 1, 2, 3, 4; 80 concurrent calls admit exactly 60; the count survives a restart; frames are independent; deletes stop at 10. The local stdio server is unchanged.
- If the Durable Object cannot be reached, the change is refused with nothing changed (logged as `limiter_error`).

### Changed
- Every change log line now includes `limiter`: `"durable"` (counted across requests) or `"memory"` (this process only). A Worker without the new binding still runs, but says `"memory"` and does not limit across requests.
- **Existing hosted deployments:** add the `WRITE_LIMITER` Durable Object binding and migration to your `wrangler.local.jsonc` and redeploy; see the README. New `worker:setup` runs include it.
- Docs: the 1.13.0 note below that the count "stops a tight loop" per isolate was wrong for the Worker; SECURITY.md now describes the real behaviour.

## [1.13.0] - 2026-11-06

### Added
- Change limit and change log for every write and delete tool, on the local and hosted servers. At most 60 changes and 10 deletes per process per hour (previews and failures count); over the limit the call is refused with nothing changed. Each attempt logs one stderr line with the tool name, effect and outcome, never arguments or ids. Reason: the per-call guards (preview, confirm, allowlist) cannot see a loop, and an unattended assistant on a shared family display needed a backstop. The count is per process (per Worker isolate), so it stops a tight loop and is not an exact quota.
- Opt-in live test `tests/live/redaction.live.ts` (`LIVE_TAGS=security`): runs every read tool against the real account and fails on anything shaped like a secret, reporting only tool name, kind and count. The scanner (`tests/live/leak-scan.ts`) is unit-tested, including that no input text can appear in its output. Reason: the mocked redaction tests use invented data.
- Opt-in live test `tests/live/api-version.live.ts` (`LIVE_TAGS=contract`): fetches each read endpoint under the default `Skylight-Api-Version` and under the newer version the iOS app 2.31.0 sends, and reports key-path and type differences only (never values or ids). Reason: Skylight changes response shapes silently by version, and most reads still send the older default. The fingerprint helper (`tests/live/shape.ts`) is unit-tested, including that no input value can appear in its output.

### Changed
- SECURITY.md no longer recommends a Cloudflare WAF rate-limit rule on `/authorize`: those rules need a zone you own and the Worker runs on `workers.dev`. It now lists the options that do apply and says why none is built.

## [1.12.0] - 2026-11-03

### Added
- `get_labels` lists the calendar labels (categories that are not family members) with each one's upcoming-event count and whether a synced calendar writes to it. `delete_label` (local server only) deletes one, preview-first with `confirm: true`. Its preview lists the upcoming events that carry only this label, because Skylight removes those with the label (as the iOS app's own delete dialog states); events with a profile or another label stay and lose it. Refuses a profile or a feed-backed label even with confirm (deleting a feed-backed label would unsync the calendar). The web app has no label delete; the iOS app does. Verified live on one unused label.
- `plan_week_meals` and `update_meal_sitting` check the meal text before writing. A placeholder left in a name, note or instructions (`(plan doc URL)`, `[recipe link]`, `<dessert name>`, `TBD`) refuses a real write with nothing written; a dry run lists it as an error. Advice that never blocks: a name over 25 characters (35 with a dessert), a dessert of more than two words, non-ASCII characters, and a cooking step in a note. Reason: these were the errors a human had to catch by reading drafts before the family's devices showed them.

### Fixed
- The hosted `get_source_calendars` description no longer tells the model that `delete_source_calendar` manages added feeds. That tool is local-only, so a hosted client went looking for a tool that is not there. The description now names only the feed tools the server actually registers; the local server is unchanged. A new test fails if any hosted tool description names a tool the hosted server does not expose.

## [1.11.0] - 2026-11-03

### Changed
- `find_conflicts` and `get_week_overview` no longer report a subscribed feed's double-listed event (for example a TeamSnap game listed twice, one copy with "Arrive 20 minutes early") as a conflict. It is listed separately as a duplicate. Deliberately narrow: both events must come from a feed and have the same start, end and title apart from trailing "(...)" notes. Two Google or Skylight events at the same time are still conflicts, because that may be a real double-booking.

### Changed
- `delete_calendar_event` is now preview-first and available on the hosted server. It takes the event's `date` as well as its ID, shows the event, and deletes only with `confirm: true`, then reads the day back to confirm it is gone. It refuses events synced from Google or a subscribed feed, repeating events and non-editable events, because what a delete does to those is unverified or would be undone by the next sync. **Breaking for callers of the old local tool:** `date` is now required and an unconfirmed call no longer deletes.

## [1.10.1] - 2026-11-03

### Fixed
- `get_calendar_events`, `get_week_overview`, `find_conflicts` and `find_free_slots` named at most one profile on an event shared by two people (an event set to Alex and Jordan read back as one of them). The request now asks for `include=categories`, as the web app does, so every assigned profile is returned.

## [1.10.0] - 2026-11-03

### Added
- The new write tools re-check their read-back a few times before calling a write a failure, because Skylight's list can lag a write by a moment (a delete returned success and the immediate list still showed the calendar).
- `get_source_calendars` now explains Skylight's Sync Calendar options (Calendar URL, Google, Outlook, iCloud, Cozi, TeamSnap, US Holidays, Individual Events) and which of them this server can add or manage; the README has the same table. A test checks every tool the guidance names exists.
- `rename_source_calendar`: rename a subscribed feed. Write tool, preview-first with `confirm: true`, also on the hosted server. Refuses a blank name or one that looks like a web address, and checks after the change that the name changed and the linked profiles did not.
- `update_source_calendar_profiles`: link or unlink a subscribed calendar feed to family profiles (the Edit Calendar "Link profiles" checkboxes). Write tool, preview-first with `confirm: true`, also on the hosted server. Skylight replaces the whole set on each save, so the tool sends the full wanted set to keep the label, reads it back, and refuses to leave a calendar with nothing linked.
- `skylight-mcp calendars add`: sync a team, school or league calendar feed. The address is typed into a hidden prompt and is refused on the command line, so it never reaches shell history, an MCP tool argument, a chat transcript or a log. Only the calendar's name and the feed host are printed. A feed that is already synced is reported as such, not as a failure. While pasting it shows a running character count (never the text), and an address pasted twice is refused before anything is sent.
- `delete_source_calendar` (destructive, local server only): stop syncing a subscribed feed. Preview first, then `confirm: true`; reads the list back to confirm it is gone. Account calendars (Google and others) and the calendar new events are saved to are refused.

## [1.9.2] - 2026-11-03

### Security
- Feed-address redaction now covers every tool that prints raw attributes (avatars, colors, rewards, reward points, albums, devices, frame info, recipes, events), not only `get_source_calendars`. One shared formatter redacts strings, arrays and nested objects, so a subscription address cannot reach the transcript from a field nobody special-cased. Links a person wrote in free-text fields (description, location, note, summary) and Skylight's stock avatar images are kept.
- `get_frame_info` no longer prints the notification email address.

## [1.9.1] - 2026-11-02

### Added
- `init` offers to open the Skylight sign-in page for you (press Enter). It only opens URLs on the pinned Skylight host and never goes through a shell. The paste-back of the `welcome?code=` link is still needed: Skylight's registered redirect cannot reach this program.

## [1.9.0] - 2026-11-02

### Added
- `skylight-mcp init`: guided setup. Detects the timezone, runs the browser-paste sign-in, finds the frame from `/api/frames`, saves `frameId` and `timezone` to a settings file, runs `doctor`, prints the MCP client snippet. Falls back to typing the frame ID if frames cannot be listed.
- Settings file (`config.json` in the per-user config directory, `0600`). Strict schema: only `frameId` and `timezone`; any other key (including anything host-like) makes the server refuse to start. Environment variables override it. The hosted Worker does not read it.
- `doctor` understands the settings file and reports a bad one.

### Changed
- Missing-frame error now says "No frame ID. Run init" and drops the proxy-capture advice.
- `init` and `doctor` no longer print per-request trace lines (the MCP server still does).
- README Quick Start is now `init`, add to client, `doctor`; the manual environment-variable path moved to "Manual setup".

## [1.8.9] - 2026-11-02

### Added
- `plan_week_meals` entries take `note` (500 characters) and `description` (the app's "Instructions or ingredients" field, 2000 characters), so a whole week can be planned with its text in one call. Each is attached with a second request per meal, the same PATCH `update_meal_sitting` uses; if that step fails the reply says the meal was added without its text. A dry run shows which meals would carry a note or instructions. Slots that already have a meal are still skipped, never overwritten.

## [1.8.8] - 2026-11-02

### Added
- `update_meal_sitting` can set `description`, the app's "Instructions or ingredients" field (recipe link, steps), separately from `note`. Each is preserved when only the other is changed. The 2000-character cap is ours; Skylight's own limit is not confirmed.
- `get_meal_sittings` takes `details: true` to print each meal's note and instructions, so a write can be read back. Off by default because they can be long.

### Fixed
- A weekday name ("friday") was resolved from the machine's clock, then offset in the configured timezone. The hosted Worker runs in UTC, so after 4pm Pacific "friday" could land a day early; `plan_week_meals` and every other tool taking a weekday were exposed. The weekday is now taken from today's date in the configured timezone.

## [1.8.7] - 2026-11-02

### Fixed
- The profile list was cached process-wide, never expired, and was not tied to a frame. On the hosted Worker a second user's request in the same process could be served the first user's profile names; locally a profile added in Skylight did not appear until a restart. Lookups are now scoped to the current request's client (nothing crosses users or frames on the Worker), expire after 5 minutes locally, and an unknown profile name triggers one fresh look before it is rejected.

### Added
- Hosted Worker: `GET /version` returns the version and nothing else, so a deploy can be confirmed without counting tools. `GET /setup` is an instructions-only page (connector address for the host it is served from, what to have ready, the steps); the landing page links to it.
- `doctor` prints macOS/Linux and PowerShell forms for setting `SKYLIGHT_FRAME_ID` and `SKYLIGHT_TIMEZONE` when either is missing, and says the MCP client's config is separate from the terminal.
- Live test harness: names every missing variable (`SKYLIGHT_LIVE`, `SKYLIGHT_FRAME_ID`, `SKYLIGHT_TIMEZONE`) and prints the full command with placeholders, instead of failing on the first one.

### Changed
- Meal categories are looked up once per request (or per 5 minutes locally) instead of on every meal call.

## [1.8.6] - 2026-11-02

### Added
- `update_meal_sitting` can now edit a repeating meal, with a required `scope`: `one` (that date only; Skylight detaches it into its own meal with a new ID), `future` (that date onward; splits the series, new ID from that date) or `all` (the whole series, same ID). Preview first, then `confirm: true`. Repeating meals cannot be moved to another date. For `all`, the series start is derived from the earliest instance and sent as the body date, because Skylight moves the series start to the body date and silently drops earlier occurrences otherwise (verified live); if the start cannot be determined the tool refuses and says to use `future` or the Skylight app. The reply re-reads the start afterwards and warns if it moved.
- Detached meals (a single week edited with `one`) are refused for edit and delete with a message that says so.

## [1.8.5] - 2026-11-01

### Added
- `create_meal_sitting` takes `repeat: "weekly"`: the meal repeats every week on the weekday of `date`, with no end. Weekly only; other rules were not captured. Sends the web app's whole create form; verified live (create, then delete with each scope).
- `delete_meal_sitting` can now delete from a repeating meal, with `scope`: `one` (default, that date only), `future` (that date and every later one; earlier ones are kept) or `all` (the whole series, past dates included). Sent as `apply_to`, like `delete_chore`. Previews name the exact effect and the `all` preview says it removes the entire series. Success is confirmed from Skylight's response, not assumed.

### Changed
- A meal that was edited on its own after belonging to a series (Skylight keeps it as `recurring` with no rule) is recognised as detached and refused for edit and delete, with a message saying so. Previously the one-off guard treated it as a one-off by accident.
- `update_meal_sitting` still refuses repeating meals. Editing an occurrence, "this and future" or "all" was captured, but "all" moves the series' start date to the date sent and silently drops earlier occurrences, so it stays out until that is tested live. See the build log.

## [1.8.4] - 2026-10-31

### Security
- `get_source_calendars` no longer prints subscription feed addresses. Published iCloud calendars and league or team schedule feeds are private URLs that work like passwords, and the tool returned them in full to the assistant and its logs. Only the scheme and host are shown now (`webcal://host/... (feed address hidden)`), in every field. Label, kind, role and editable are unchanged.

### Added
- `create_routine`: create a weekly routine (morning, afternoon or evening) for one or more profiles, via the web app's `create_multiple` call. Weekly schedules only.
- `delete_chore` takes `scope`: `future` ("this and future tasks") or `all` ("all tasks in series"), sent as `apply_to`. Required for recurring chores and routines, which replaces the 1.8.3 refusal. It reads the chores back and reports whether the occurrence is gone.
- `update_chore` works on recurring chores and routines for a rename and for a weekly schedule (`days` + `timeOfDay`). Schedule changes need `acknowledgeReset: true` because they can reset streak history. Skylight re-keys the chore on every edit; the reply gives the new id.

### Changed
- `update_chore` on a recurring chore refuses date, time, assignee and stars (never captured) instead of guessing.

## [1.8.3] - 2026-10-31

### Changed
- `delete_chore` refuses occurrence ids of recurring chores and routines (like `12345-2026-11-03-0600`) and points to the app, because the delete scope ("this and future" vs "all in series") is not captured. One-off chores are unaffected.

### Fixed
- `get_reward_points` now names points held by non-profile categories (for example a shared "Household" bucket) and labels ids it cannot match `unknown profile (id)` instead of `profile <id>`.

## [1.8.2] - 2026-10-31

### Changed
- The hosted Worker now also offers `delete_chore`, `delete_list`, `delete_list_item`, `delete_reward`, `delete_recipe` and `delete_meal_sitting` (plus `delete_message`). `delete_calendar_event` stays local-only.
- **Behavior change:** `delete_chore`, `delete_list`, `delete_list_item`, `delete_reward` and `delete_recipe` now preview and delete nothing unless `confirm: true` (as `delete_meal_sitting` and `delete_message` already did). This applies to the local server too.

### Added
- `complete_chore`: mark one occurrence of a routine or recurring chore done, or undo it, via Skylight's completions endpoint. Previews unless `confirm: true` (it awards real stars and streaks). Available on both the local and hosted servers. One-off chores are refused until their payload is captured.
- `get_chores` prints `Routine: Yes` and `get_week_overview` tags `[routine]` for routines. A routine
  is a recurring chore with `routine: true` (captured from the web app's create call; "In the Morning"
  was `BYHOUR=6`; afternoon, evening and weekly values are not captured). Read-only marking; completing one is `complete_chore`; there is no tool
  to create a routine yet.

### Fixed
- `get_reward_points` showed `ID: undefined` and raw category ids; it now shows each profile's name, current balance and lifetime earned.
- `update_chore` no longer accepts a completion `status` (it used the wrong endpoint and value, so it never awarded stars). It refuses and points to `complete_chore`.

## [1.8.1] - 2026-10-31

### Fixed

- The client's request log (stderr, including during `doctor` and in MCP client logs) printed the full
  URL, so your frame ID appeared in terminals and pasted bug reports, contradicting the README's
  "never prints your frame ID". Logged URLs now show `/frames/<frame>`; the real request is unchanged.
  A test fails if the ID appears in any log line.

### Changed

- README: warns not to run `npx` from inside a clone of the repo and adds the error to Troubleshooting. Found publishing 1.8.0 from a Windows clone.

## [1.8.0] - 2026-10-31

### Fixed

- The credential-store tests asserted Unix file modes (0600/0700), which Windows does not report, so
  `vitest run` and therefore `npm publish` failed on any Windows clone. The mode checks now run on
  POSIX only; a deliberately loosened mode still fails them there. Found when publishing from Windows.
- `doctor` always failed its Skylight API check with "client has not been initialized": the
  real check used the process-wide client that only the server's startup sets up, and the tests
  replaced the check with a mock. It now builds its own client. Found on the first Windows run;
  not Windows-specific.
- On Windows the sign-in message said "credential file (0600)". Windows ignores Unix modes, so
  it now says the file is unencrypted and protected only by the Windows profile.
- A completed chore is reported by Skylight as `complete`; the tools compared against `completed`.
  `get_chores` with `status: completed` found nothing and `pending` listed done chores, and
  `get_week_overview` showed done chores as `[ ]` and as overdue. Both values now count as done.
  Not fixed here: `update_chore` still sends the old status value to a different endpoint than
  the web app's completion call (see build log).

### Changed

- **Behavior change:** profile names are now matched exactly (case-insensitive) everywhere:
  `create_chore`, `update_chore`, `get_chores` (assignee filter), `create_reward`,
  `redeem_reward`, and `from` on `send_message` / `update_message`. Previously a partial
  name such as "Alex" could resolve to "Alexander" and put the chore or message under the
  wrong person. An unknown or partial name now fails before any write and lists the valid
  profile names.
- `get_calendar_events` no longer prints `owner_email`, `calendar_id`,
  `calendar_account_id`, `invited_emails`, `uid` or `supports_notification_settings`.
  They identified accounts and people and gave a model nothing to act on. Other
  fields, including ones Skylight adds later, are still printed.

### Added

- **Up for Grabs chores**: chore reads now always ask Skylight for shared chores that anyone
  can take (the web app does; without it they were never returned). `get_chores` shows them as
  "Assigned to: nobody (up for grabs)" and `get_week_overview` labels them. Verified live with
  the Skylight toggle off only.
- `get_task_box` (read-only, available on the hosted server): lists the task box. Items are
  reusable chore and routine templates with no assignee or date, so a task saved there does
  not appear in `get_chores`. Shape captured from the web app; an unrecognised response is
  an error (top-level keys only), never "empty".
- `get_calendar_events` prints a `profiles:` line naming who an event is assigned to.
  The response field it reads (`relationships.categories`, or `category_ids`) is inferred
  from chores and messages and has not been confirmed on a real event.
- **Live test suite** (`npm run test:live`, development only). Real tools against a
  real frame, to catch drift in Skylight's undocumented API that mocked tests
  cannot see. Off unless `SKYLIGHT_LIVE=1`, never part of `npm test` or CI, and
  the harness refuses `send_message`, `update_message` and `delete_message`. One suite per file in
  `tests/live/`, filterable by tag. First suites: read smoke checks,
  response-shape contract checks, write guards and a meal
  create/rename/move/delete round trip with guaranteed cleanup. A normal-suite
  test checks that every live file is gated.

## [1.7.0] - 2026-10-30

### Changed

- npm package name is `@davidwoods/skylight-mcp` (the `dwooods` npm scope was not
  available; the GitHub repository is still `dwooods/skylight-mcp`).

### Added

- **`skylight-mcp doctor`**: checks Node, frame ID, timezone, sign-in and one real
  API call, and says what to fix. Never prints tokens or the frame ID. `--offline`
  skips the network call. It warns when `SKYLIGHT_TIMEZONE` is unset, because the
  default (America/New_York) silently shifts event times for everyone else.
- **`npm run worker:setup`**: one command to create your own hosted Worker (KV
  namespace, gitignored `wrangler.local.jsonc`, passphrase, `WORKER_URL`, deploy).
  `-- --dry-run` shows the steps. Not yet run against a real Cloudflare account.
- README quick start is now `npx` based (no clone), with a troubleshooting table.
- `package.json`: `publishConfig.access`, and `prepublishOnly` runs typecheck, lint,
  tests and build before any publish.

### Fixed

- Meal listing: Skylight's `date_max` leaves out the end day, so one-day queries
  returned nothing and ranges lost their last day (week overview too).
- `get_colors` and `get_reward_points` tolerate responses that are not plain
  JSON:API lists; an unrecognised shape fails with top-level keys only.

## [1.6.0] - 2026-10-30

### Added

- **Messages**: `delete_message` (destructive) deletes a message with
  `DELETE /nudges/{id}`. The Skylight app has no delete button for messages; the
  call comes from other open-source clients and was verified on a real frame.
  It previews unless `confirm: true`, reads the list back and reports success only
  if the message is gone. It is available on the hosted server too, through a
  per-tool allowlist, and is the only destructive tool the hosted server offers.
- **Profiles**: `get_family_members` prints profile IDs. `send_message` takes
  `to` (profile names) to send to specific people, and `create_calendar_event`
  and `update_calendar_event` take `profiles`. Names are matched exactly
  (case-insensitive, no prefix matching); an unknown name fails with the list of
  valid names and sends nothing.
- README: a support matrix, a Not supported list, a Skylight API calls table, and
  a test that fails if a tool is missing from the README or its effect differs.

### Fixed

- **Event times were stored 7 hours early.** A start or end time with no UTC
  offset was read by Skylight as UTC, so 8:00 AM was stored as 1:00 AM Pacific.
  Local times now get the frame's UTC offset (daylight saving aware) on create and
  update. Times that already carry an offset or Z, and all-day dates, are unchanged.
  Events created with earlier versions are still wrong in Skylight and need
  correcting by hand.
- A response with an empty body (the message delete) no longer throws "Unexpected
  end of JSON input".

## [1.5.0] - 2026-10-30

### Added

- **Meals**: `update_meal_sitting` (write) renames or moves a scheduled meal, or
  changes its note or category, and `delete_meal_sitting` (destructive, local
  server only) removes one. Both use the web app's own calls:
  `PATCH` and `DELETE` on `/meals/sittings/{id}/instances/{date}`, sent with the
  newer `Skylight-Api-Version` (`2026-10-15`). The edit sends the whole form, with
  unchanged fields read back first. A move keeps the current date in the path and
  puts the new date in the body. Only one-off meals are supported; repeating meals
  are refused and left to the Skylight app, because editing one occurrence of a
  series was not captured. `delete_meal_sitting` previews unless `confirm: true`
  and only reports success when Skylight lists the sitting in
  `meta.deleted_sitting_ids`. Sitting IDs and dates are format-checked before they
  reach a URL path.

## [1.4.1] - 2026-10-29

### Fixed

- **Messages**: `get_messages` showed every message as "selected devices" and listed
  profile names instead of "everyone", and `update_message` would have refused
  every message. Messages need the newer `Skylight-Api-Version` that the web app
  sends (`2026-10-15`); under the repo-wide older version the responses omit
  `all_profiles`, `all_devices` and `voice_kind`. The messages endpoints now send
  the newer version; every other endpoint is unchanged.

## [1.4.0] - 2026-10-29

### Added

- **Messages**: `get_messages` (read) and `send_message` (write) for the notes
  shown on the frame. Endpoint and payload were taken from the web app's own
  calls. Sends are silent unless `readAloud` is set, go to everyone on all
  devices, and are capped at 300 characters. Skylight offers no way to delete a
  message, so `send_message` previews by default and posts only with an explicit
  `confirm: true` after the user has approved the text. Presigned audio URLs, which carry
  temporary storage credentials, are never returned.

- `update_message` edits a message's text or sender (PATCH with the whole form, as
  the web app does) for messages sent to everyone on all devices that don't repeat.
  Message IDs are validated as numeric before they reach a URL path.

### Not yet supported

- Targeting specific profiles or devices, scheduling, repeats and voice notes.
  The request fields for these have not been captured.

## [1.3.0] - 2026-10-29

### Added

- **Planning tools**: `get_week_overview`, `find_conflicts`, `find_free_slots`
  (all read-only) and `plan_week_meals` (write, with dry run). Chores and
  tasks are first-class in the overview: status, assignee, points, and an
  overdue section.
- `src/utils/schedule.ts`: zone-aware interval math (Intl only, no library)
  with explicit handling of DST gaps/overlaps and all-day events.
- Tests for the schedule math and the four planning tools.

### Notes

- `plan_week_meals` registers without Plus and fails with a clear message there.
- The hosted Worker exposes the new tools automatically (read + write profile).
  Redeploy to pick them up.

## [1.2.0] - 2026-10-29

### Fixed

- **Meals**: `get_meal_categories` showed every category as "Unknown"; the
  API field is `label`, not `name`. `get_meal_sittings` now shows what is
  planned (summary or recipe), the category name, and each date in range.
  `create_meal_sitting` accepts a free-text `summary` so a meal can be
  scheduled without creating a recipe first, and reads the list-shaped
  create response correctly.

### Added

- **Browser-paste sign-in**: `skylight-mcp auth login` / `auth complete <url>` /
  `auth status` / `auth logout`. You sign in in your own browser and paste the
  redirect URL; the password never reaches the server. PKCE (S256) and a
  state check bound to a short-lived `0600` pending-login file.
- **Encrypted credential store**: AES-256-GCM with the key in macOS Keychain;
  `0600` file store elsewhere. Fails closed when the Keychain is unavailable.
- Automatic access-token refresh with rotation persisted; one in-flight
  refresh shared across concurrent requests; one retry on 401.
- Tests for the OAuth module, both credential stores, client auth order,
  API host pinning, the tool registry, request context and the hosted MCP
  handler (82 total).

- **Hosted server for Claude Duet** (`src/worker/`, `wrangler.jsonc`): a
  Cloudflare Worker that is both OAuth authorization server and MCP resource
  server (`@cloudflare/workers-oauth-provider` 1.x). Consent page gated by a
  setup passphrase; the same browser-paste Skylight sign-in, with the PKCE
  verifier held in a browser-bound upstream transaction; Skylight tokens kept
  in encrypted grant props and refreshed in `tokenExchangeCallback`. Exposes
  read + create/update tools only.
- `src/context.ts`: per-request AsyncLocalStorage context so one process can
  serve many grants; `src/tools/registry.ts`: effect classification and MCP
  annotations for every tool.

### Changed

- Package renamed to `@dwooods/skylight-mcp`; repository metadata points at
  this fork. README carries an explicit unofficial-status notice.
- Auth source order is now explicit token, stored credential, then the
  deprecated email/password login. Startup no longer requires email/password or
  token env vars.
- The client refuses absolute endpoint URLs whose origin is not the Skylight API
  host, so a bearer token can never be sent elsewhere.
- README, SECURITY.md and `.env.example` rewritten for the new flow.
- `THIRD_PARTY_NOTICES.md` credits kamilio/skylight-calendar-agent (MIT), whose
  design informed the sign-in flow and credential store.

### Security

- `npm audit`: 24 → 0. Runtime: `@modelcontextprotocol/sdk` 1.25 → 1.32
  (GHSA-345p-7cg4-v4c7, cross-client data leak via shared transport reuse;
  this server already creates one server+transport per request) and `zod`
  3 → 4 (GHSA-mrhx-c7xc-m3w5). Dev: `vitest` 1 → 5, `vite` 8, `@types/node`
  22.

### Removed

- Node 18 support (end-of-life April 2025; `wrangler` needs 20+). `engines` is now `>=20`.

### Deprecated

- `SKYLIGHT_EMAIL` / `SKYLIGHT_PASSWORD` login.

## [1.1.8] - 2026-04-14

### Fixed

- **Authentication**: Updated email/password authentication to match Skylight's current web OAuth flow. The server now follows the browser login sequence (`/oauth/authorize` -> `/auth/session` -> `/oauth/token`) and uses the returned bearer token for API requests.

### Changed

- Centralized shared API constants, including the Skylight API version header
- Updated auth-related docs and error guidance to reflect OAuth-based login
- Added automated tests for the OAuth login flow and kept live smoke validation against the real API

## [1.1.7] - 2025-12-30

### Fixed

- **Authentication**: Fixed email/password authentication to use correct `Basic base64(userId:token)` format instead of `Bearer token`. The Skylight API requires the user ID and token to be combined and base64-encoded for Basic auth.
- **Calendar Events**: Fixed `get_calendar_events` returning no events when querying a single day. The API treats `date_max` as exclusive, so we now add 1 day to ensure events on the end date are included.

### Changed

- Added debug logging for authentication flow to help troubleshoot login issues
- Added automatic retry on 401 errors for email/password auth (attempts re-login once before failing)

## [1.1.6] - 2025-12-29

- Initial public release
