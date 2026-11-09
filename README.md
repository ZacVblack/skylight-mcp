# Skylight MCP Server

An MCP (Model Context Protocol) server for the Skylight Calendar. Lets Claude
(including Claude Duet, via the hosted mode) read and plan against your family
calendar, chores, lists, meals and rewards.

> **Unofficial.** This project is not affiliated with or endorsed by Skylight.
> Skylight has no public API; this talks to the same private endpoints their
> own apps use, discovered by observing app traffic. It can stop working or be
> blocked at any time, without notice. Use it with your own account, at your
> own risk, and keep request volume modest.
>
> Forked from [TheEagleByte/skylight-mcp](https://github.com/TheEagleByte/skylight-mcp)
> (MIT). The sign-in and credential-store design follows
> [kamilio/skylight-calendar-agent](https://github.com/kamilio/skylight-calendar-agent)
> (MIT). See `THIRD_PARTY_NOTICES.md`.

## Features

- **Calendar**: read events and connected calendars; create, update and delete events
- **Planning**: one-call week overview, overlap detection, free-slot search, bulk meal planning
- **Meals** (Plus): see, add, rename, move and delete scheduled meals; browse and edit recipes
- **Messages**: sending to specific devices, scheduling, repeating, voice notes, editing a message that was sent to specific profiles (the app's edit form does not allow changing recipients), and read-aloud (the option exists on `send_message` but was not tested live).
- **Chores and tasks**: read, create, update and delete chores; add to the task box
- **Lists**: read, create, update and delete lists and items
- **Family**: read profiles, devices and household info
- **Rewards** (Plus): read points and rewards; create, update, redeem and delete

See [What is supported](#what-is-supported) for what is tested, what is not, and
what the hosted server leaves out.

## Quick Start

You need Node 20+, a Skylight account, and an MCP client (Claude desktop, Claude
Code, or any other). Nothing to clone or build. Run the `npx` commands from any
normal folder, **not from inside a clone of this repo** (see Troubleshooting).

**Do I need the hosted server?** Probably not. The steps below give you the
*local* server: it runs on your own computer while your MCP client is open and
exposes every tool. The *hosted* server (a Cloudflare Worker) is optional. You
only need it if Claude Duet or Claude on another device has to reach Skylight
when this computer is off. It means cloning the repo, a free Cloudflare
account, `npx wrangler login`, `npm run worker:setup`, and a second sign-in,
and it exposes read and write tools plus a short list of deletes (chores, lists, list items, rewards, recipes, meal sittings, messages; not calendar events). Do the local
setup first; see
[Hosted server (Claude Duet, Claude on other devices)](#hosted-server-claude-duet-claude-on-other-devices)
if you need it later.

### 1. Run the setup

```bash
npx -y @davidwoods/skylight-mcp init
```

`init` asks for your timezone (it offers the one your computer uses), runs the
browser sign-in, finds your frame from your account, saves the frame ID and
timezone to a small settings file, runs `doctor`, and prints the lines to paste
into your MCP client. If your account has more than one frame it asks which;
if it cannot list frames it asks for the number from the address bar
(`https://ourskylight.com/my-skylight/<number>`; see
[Finding your Frame ID](#finding-your-frame-id)).

The sign-in works like this: `init` prints a Skylight URL and offers to open it:
press Enter and your browser opens it (or open the URL yourself). Sign in there. The browser bounces through
`https://ourskylight.com/welcome?code=...` and on to the home page too fast to
copy. Get the link from your browser history: `Cmd-Y` (Mac) / `Ctrl-H` (PC),
search `welcome?code`, right-click the Skylight result dated today (top of the
list; older ones are earlier sign-ins and will not work), Copy link address,
and paste it when `init` asks. Your password never touches this program; only
the resulting OAuth tokens are stored, encrypted with a key in the macOS
Keychain (plain `0600` file on Linux/Windows). macOS may ask once to allow
Keychain access. If the Keychain is unusable, `init` stops; it never falls back
to plaintext on macOS.

The settings file holds the frame ID and timezone only: no token, no host.
It lives in `~/Library/Application Support/skylight-mcp/config.json` (macOS),
`%APPDATA%\skylight-mcp\config.json` (Windows) or
`~/.config/skylight-mcp/config.json` (elsewhere), mode `0600`, and an
unrecognised key makes the server refuse to start. Environment variables
(`SKYLIGHT_FRAME_ID`, `SKYLIGHT_TIMEZONE`) override it. Run `init` again to
change either value.

### 2. Add to your MCP client

**Claude desktop** (Settings → Desktop app → Local MCP servers → Edit config; older versions: Settings → Developer → Edit Config), or any client that uses `mcp.json`:
```json
{
  "mcpServers": {
    "skylight": {
      "command": "npx",
      "args": ["-y", "@davidwoods/skylight-mcp"]
    }
  }
}
```

**Claude Code:**
```bash
claude mcp add skylight -- npx -y @davidwoods/skylight-mcp
```

Restart the client fully (Cmd-Q on Mac), then ask it "what's on the family
calendar this week?"

### 3. Check it any time

```bash
npx -y @davidwoods/skylight-mcp doctor
```

`doctor` checks Node, the frame ID, the timezone, your sign-in and one real call
to Skylight, and says what to fix. It never prints tokens or your frame ID.
Add `--offline` to skip the network call.

### What you can sync, and what this server can do

Skylight's **Sync Calendar** screen offers these. From the app's screen; the "this server" column is what changes here.

| Option in Skylight | Add it | Manage it with this server |
| --- | --- | --- |
| Calendar URL (team, school, league, iCloud published calendar) | `skylight-mcp calendars add`, or in the app | Rename, link to profiles, remove, list |
| Google, Outlook/Hotmail/Live, iCloud account, Cozi, TeamSnap | Sign in inside the Skylight app (cannot be done here) | List only |
| US Holidays, Individual Events | In the app | List only |

Calendars from a subscription link are one-way: Skylight reads them and cannot write back.

### Add a team, school or league calendar

```
npx -y @davidwoods/skylight-mcp calendars add
```

Paste the calendar's address when asked (the link ending in `.ics`, or starting with
`webcal://`). Nothing is shown as you paste, and the address never goes into your
shell history, a chat, or a log: it is a secret, because anyone with the link can
read that calendar. Skylight fetches the feed itself, names the calendar from it, and
the events appear on your frame. This is a command and deliberately not an MCP tool.
To stop syncing one, ask your assistant to remove it (`delete_source_calendar`, which
previews first), or remove it in the Skylight app. Google, Outlook, iCloud and Cozi
accounts are connected in the Skylight app, not here.

### Manual setup (without `init`)

If you would rather not use `init`, or it fails, set the two values yourself
and sign in with the lower-level commands. Find your frame ID as above; the
timezone is an IANA name such as `America/Chicago` and **must be set**: it
defaults to `America/New_York`, and event times come out wrong anywhere else.

```bash
# macOS / Linux
export SKYLIGHT_FRAME_ID=your_frame_id
export SKYLIGHT_TIMEZONE=America/New_York
# Windows PowerShell:  $env:SKYLIGHT_FRAME_ID="your_frame_id"; $env:SKYLIGHT_TIMEZONE="America/New_York"
npx -y @davidwoods/skylight-mcp auth login
npx -y @davidwoods/skylight-mcp auth complete   # then paste the welcome?code= link
```

Terminal variables are not inherited by your MCP client. Put them in the
client's `env` block instead:
`"env": {"SKYLIGHT_FRAME_ID": "your_frame_id", "SKYLIGHT_TIMEZONE": "America/New_York"}`
(Claude Code: `-e SKYLIGHT_FRAME_ID=... -e SKYLIGHT_TIMEZONE=...`).
`auth status` and `auth logout` do what they say.

### From source (contributors)

```bash
git clone https://github.com/dwooods/skylight-mcp.git
cd skylight-mcp && npm install && npm run build
node dist/index.js auth login    # same steps as above, using node dist/index.js
```

In the client config use `"command": "node", "args": ["/path/to/skylight-mcp/dist/index.js"]`.

### Windows (partly verified)

Verified on one Windows machine (Node 24): `npx` runs the package, `doctor --offline`
works, `auth login` and `auth complete` finish the real sign-in, the credential is
saved to `%APPDATA%\skylight-mcp\credential.json`, and the Claude desktop app runs the
server from the config below and reads real calendar data. **Not yet verified:**
`doctor`'s Skylight check on Windows (it was broken on every platform in 1.7.0 and is
fixed in 1.8.0), the live test suite, and `worker:setup`.

- `npx` is a `.cmd` file on Windows, so in a client config use
  `"command": "cmd", "args": ["/c", "npx", "-y", "@davidwoods/skylight-mcp"]`.
- Set variables in PowerShell like this, then run the command on the next line:
  `$env:SKYLIGHT_FRAME_ID="your_frame_id"; $env:SKYLIGHT_TIMEZONE="America/New_York"`.
- In Windows Terminal you can hold Ctrl and click the sign-in URL. In the history
  search, right-click the result dated today and choose Copy link address.
- The sign-in is stored **unencrypted** in `%APPDATA%\skylight-mcp\credential.json`.
  There is no Keychain equivalent wired in, and Windows ignores Unix `0600`
  permissions. Only your Windows user profile protects it.

### Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `'skylight-mcp' is not recognized` (Windows) or `skylight-mcp: command not found` | You ran `npx` from inside a clone of this repo, so npx tried to run the local project, whose command is not linked. `cd` to any other folder and run it again. From a clone, use `node dist/index.js` instead. |
| Server fails to start, mentions configuration | No frame ID: run `init` (or `doctor` to see what is missing). An invalid settings file also stops the server; `doctor` names the problem. |
| "Not signed in" | Run `auth login` then `auth complete`. Logins expire after 10 minutes. |
| macOS Keychain error | The server refuses to fall back to plaintext. Unlock the Keychain or allow access when prompted. |
| Events show at the wrong hour | `SKYLIGHT_TIMEZONE` unset (defaults to New York). Set your zone. |
| Tools missing after an update | Fully quit and reopen the client; it caches the tool list. For a hosted connector use its "Refresh tools list". |
| Worked yesterday, fails today | Skylight has no public API and may have changed. Run `doctor`, then check the issues. |

### First five things to ask Claude

Once `doctor` is clean, try these in order. The first three only read. The last two show how the write guards work, so you see them before anything lands on your Skylight display.

1. **"What's on our family calendar this week?"** Reads events (`get_calendar_events`). If times are off by hours, your `SKYLIGHT_TIMEZONE` is wrong.
2. **"Give me an overview of the week and point out any conflicts."** One call that merges events, chores, meals and lists (`get_week_overview`, `find_conflicts`).
3. **"When are we all free for 90 minutes on Saturday?"** Finds gaps around the fixed events (`find_free_slots`).
4. **"Plan dinners for Monday to Thursday, but do a dry run first."** Shows what would be written and which slots are already filled (`plan_week_meals`). Nothing is written until you say so, and filled slots are never overwritten. Needs Skylight Plus.
5. **"Draft a message to everyone saying dinner is at 6, but don't send it yet."** The send tool previews the exact text and posts nothing until Claude is told to confirm. Messages show on your display, so say yes only when you mean it.

If a tool you expected is missing, see the [Troubleshooting](#troubleshooting) table, and check "What is supported" for tools that are local-only or Plus-only.

### Instructions for AI

Copy this into your AI's custom instructions or system prompt:

> You have access to the Skylight MCP server. Skylight is a smart family calendar display that shows calendars, chores, grocery lists, meals, and rewards. Use the Skylight tools to help manage family schedules and organization.
>
> Tips:
> - Call `get_family_members` before assigning chores to get member names
> - Grocery items default to the main grocery list if no list specified
> - Dates accept "today", "tomorrow", day names, or YYYY-MM-DD format
> - Some tools (rewards, meals, photos) require Skylight Plus subscription

## Prerequisites

- Node.js 20+
- A Skylight account with an active subscription
- Your Skylight Frame ID (see [Finding your Frame ID](#finding-your-frame-id))

## Authentication

Sources are tried in this order:

1. **`SKYLIGHT_TOKEN`** - an explicit token in the environment, if set.
2. **Stored OAuth credential** (recommended) - created by `skylight-mcp auth login`
   / `auth complete`. The access token is refreshed automatically; refresh tokens
   rotate and the rotated token is persisted.
3. **`SKYLIGHT_EMAIL` + `SKYLIGHT_PASSWORD`** (deprecated) - the server replays
   Skylight's web login form itself. This works but puts your password in your
   MCP client config in plaintext. Prefer the browser sign-in above.

If none is present the server fails with instructions rather than starting.

Where the credential lives:

| Platform | Location | Protection |
|----------|----------|------------|
| macOS | `~/Library/Application Support/skylight-mcp/credential.enc.json` | AES-256-GCM; key in Keychain (`skylight-mcp.encryption-key`) |
| Linux / other | `$XDG_CONFIG_HOME/skylight-mcp/credential.json` (default `~/.config/skylight-mcp/`) | `0600` file in a `0700` directory, no encryption |
| Windows | `%APPDATA%\\skylight-mcp\\credential.json` | Not encrypted. Windows ignores `0600`; only your user profile's own permissions protect it. Untested, see below. |

If the Keychain is unavailable on macOS the server refuses to read or write the
credential; it never silently downgrades to plaintext.

### Finding your Frame ID

The frame ID is the household identifier. The easy way: after signing in, the
Skylight web app lands on `https://ourskylight.com/my-skylight/<number>`. That
number is your frame ID. Treat it as a secret.

The hard way, if that URL doesn't appear:

1. Use a proxy tool ([Proxyman](https://proxyman.io/), [Charles](https://www.charlesproxy.com/), or [mitmproxy](https://mitmproxy.org/))
2. Capture any API request from the Skylight app
3. Look at the URL path: `/api/frames/{frameId}/...`
4. Example: `/api/frames/abc123/chores` → frame ID is `abc123`

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SKYLIGHT_TOKEN` | No | Explicit API token; overrides the stored credential |
| `SKYLIGHT_AUTH_TYPE` | No | `bearer` (default) or `basic` (only with `SKYLIGHT_TOKEN`) |
| `SKYLIGHT_EMAIL` | No (deprecated) | Fallback email/password login |
| `SKYLIGHT_PASSWORD` | No (deprecated) | Fallback email/password login |
| `SKYLIGHT_FRAME_ID` | Yes, unless saved by `init` | Your household frame ID; overrides the settings file |
| `SKYLIGHT_TIMEZONE` | No | Default timezone; overrides the settings file (default: `America/New_York`) |

### Auth Notes

- The API host is pinned to `https://app.ourskylight.com`. No environment
  variable or `.env` file can redirect requests (and the bearer token) elsewhere.
- `auth logout` deletes the local credential only; Skylight has no public way to
  revoke a session, so change your password if a credential may have leaked.
- Skylight has no official API. This uses the same OAuth client the Skylight
  app uses, and it may break or be blocked at any time.

## Hosted server (Claude Duet, Claude on other devices)

The same code also runs as a remote MCP server on Cloudflare Workers, which is
how Claude Duet (and any Claude client that can't reach your Mac) connects.
One Worker is both the OAuth authorization server Claude talks to and the MCP
resource server. Signing in is the same browser-paste flow as the CLI; your
Skylight password never reaches the Worker, and the Skylight tokens are kept
encrypted in the OAuth grant, not in a database you manage.

> [!CAUTION]
> **The hosted server can change and delete things other people own.** Whoever (or whatever) holds the
> connection can create, edit and delete anything in the connected Skylight frame, including events
> on every Google calendar connected to it, not only the shared family one. That includes another
> person's personal Google calendar if it is connected to Skylight: a delete or edit there is made at
> Google, shows on their phone, and cannot be undone from this server. Google records the change
> as made by the account that is connected to Skylight, not by you or by the AI. Deleting a repeating event
> with scope `all` removes the whole series, past and future. Claude Duet does not ask before a
> destructive tool call, and the preview step is a parameter the model sets, not something the server
> enforces. Limits that do hold: 60 changes an hour, at most 10 of them deletes, and events from
> subscribed feeds are read-only. Check which calendars your frame syncs (`get_source_calendars`)
> before you connect a client you do not supervise, and remove `delete_calendar_event` from
> `HOSTED_DESTRUCTIVE_ALLOWLIST` if that is more access than you want to give.

### Which tools the hosted server exposes, and why

The hosted server registers all **read and create/update tools**, plus these
deletes: `delete_chore`, `delete_list`, `delete_list_item`, `delete_reward`,
`delete_recipe`, `delete_meal_sitting`, `delete_message` and
`delete_calendar_event` (events created in Skylight or on a Google calendar, and repeating ones with an explicit scope; never subscribed feeds). It does **not**
register `delete_source_calendar`, `delete_label` or photo uploads. The local (stdio) server
registers everything. This is a deliberate choice, not a limitation of the Worker:

- The hosted server is what Claude Duet drives proactively, sometimes
  unattended. Every allowlisted delete previews and deletes nothing unless
  `confirm: true`. That flag is set by the model, not by a person: the server
  cannot tell whether anyone said yes, and some clients do not prompt before a
  tool runs. The model is meant to show the exact target and wait for a yes, and
  it can be told to in its instructions, but nothing here enforces it. The
  server's hard limits are the write limiter (60 changes an hour, at most 10
  deletes) and the fixed allowlist.
- `delete_source_calendar` (removing a synced calendar) and adding a feed stay
  local-only: a feed address is a secret and a wider, rarer change than deleting
  one event.
- Photo tools are uploads the Worker has no reason to carry.

The allowlist is one list, `HOSTED_DESTRUCTIVE_ALLOWLIST` in
`src/worker/mcp.ts`. Add or remove a tool name there and redeploy. For full
parity set `HOSTED_EFFECTS` to `["read", "write", "destructive"]` and
`photos: true` in the same file. Every tool's classification lives in
`src/tools/registry.ts`, so you can also carve out a profile of your own
(read-only, for example, is `["read"]`).

If you run both servers in the Claude desktop app, Claude sees two sets of
mostly duplicate tools and may use either for writes. Disable the local one
in Settings → Connectors when you do not need calendar deletes or photo tools, or
say "use the local Skylight server" when you do.

### Deploy (once)

You need a free Cloudflare account. From a clone of this repo:

```bash
npm install
npx wrangler login
npm run worker:setup        # add -- --dry-run first to see the steps
```

`worker:setup` creates your KV namespace, writes a gitignored
`wrangler.local.jsonc` with your real ID (the committed `wrangler.jsonc` keeps a
placeholder, so nothing account-specific can be committed), asks you for a
sign-in passphrase, deploys, sets `WORKER_URL`, deploys again and prints the
connector URL. Re-deploy later with `npm run worker:deploy:local`.

**Upgrading a Worker deployed before 1.13.1:** add the change counter to your
`wrangler.local.jsonc` (a new setup gets it automatically), then deploy:

```jsonc
"durable_objects": { "bindings": [{ "name": "WRITE_LIMITER", "class_name": "WriteLimiter" }] },
"migrations": [{ "tag": "v1-write-limiter", "new_sqlite_classes": ["WriteLimiter"] }],
```

Without it the Worker still runs, but its change limit counts in memory and
limits nothing across requests. After a deploy, make a change and look for
`"limiter":"durable"` in the Worker's logs.

Doing it by hand instead:

```bash
cp wrangler.jsonc wrangler.local.jsonc            # gitignored: your real IDs live only here
npx wrangler kv namespace create OAUTH_KV         # paste the id into wrangler.local.jsonc, not wrangler.jsonc
npx wrangler secret put SETUP_PASSPHRASE -c wrangler.local.jsonc   # 12+ chars; required to link an account
npm run worker:deploy:local                       # prints the Worker's URL
npx wrangler secret put WORKER_URL -c wrangler.local.jsonc   # paste that URL (origin only, no path)
npm run worker:deploy:local
```

`WORKER_URL` must be exactly the public origin of the Worker; every token is
bound to it. It is a secret rather than a `vars` entry so the server's
address is not published with the source.

### Connect from Claude

In Claude (or Duet) → Settings → Connectors → Add custom connector:

- Name: `Skylight`
- URL: `https://skylight-mcp.<your-subdomain>.workers.dev/mcp`

Claude opens the consent page. Enter the setup passphrase, your frame ID and
timezone, then follow the two-step Skylight sign-in and paste the redirect
URL. Connectors are shared across your Claude account, so Duet sees it too.

The server also serves `/setup` (these steps, for the host it runs on) and
`/version` (just the version number, handy for confirming a redeploy took).

### What is stored where

| Thing | Where | Protection |
|---|---|---|
| Skylight access + refresh tokens | OAuth grant props in `OAUTH_KV` | Encrypted by workers-oauth-provider; the key is derived from the token Claude holds, so KV alone is not enough |
| PKCE verifier during sign-in | Upstream transaction in `OAUTH_KV` | Bound to your browser by a `__Host-` cookie; single use; 10-minute TTL |
| Setup passphrase | Worker secret | Never in the repo or `wrangler.jsonc` |
| Nothing else | | The Worker has no database and no logs of tokens |

To revoke: remove the connector in Claude (revokes the grant), or
`npx wrangler kv key list --binding OAUTH_KV` and delete, or change your
Skylight password.

## What is supported

Status vocabulary, used honestly:

- **Live-tested**: run against a real Skylight frame by this project, with the result checked by reading back.
- **Inherited**: came from the upstream project and works there, but this project has not re-run it live.
- **Mocked only**: covered by this project's mocked tests; not yet run against real data.

Skylight has no public API. Everything below can break when Skylight ships a
web release, which happens without notice. The web app version and API version
last captured are recorded in the repository's build log.

| Area | What works | Hosted server (Claude Duet) | Status |
|------|------------|------------------------------|--------|
| Calendar | Read events and source calendars; create (with profiles), update, delete events | Everything except delete (local only) | Read, create and delete live-tested; update inherited |
| Planning | Week overview, conflicts, free slots, bulk meal plan | All four | Week overview live-tested; the rest mocked only |
| Meals (Plus) | Read categories and meals; create, rename, move, delete one-off meals | All, delete included | Live-tested |
| Recipes (Plus) | Read, create, update, delete recipes; push ingredients to the grocery list | All, delete included | Inherited |
| Messages | Read; post to everyone or to named profiles (silent by default); edit text and sender (everyone-messages only); delete | All four, delete included | Live-tested |
| Chores and routines | Read (routines marked, Up for Grabs included); create, update, delete chores; mark one occurrence of a routine or recurring chore done or not done | All, delete included | Read live-tested; completion captured live, tool not yet run live; the rest inherited |
| Task box | List items; add a task | Yes | List live-tested; add inherited |
| Lists | Read lists and items; create, update, delete lists and items | All, delete included | Inherited |
| Family and devices | Profiles with IDs, avatars, colours, household info, devices | Yes | Profiles live-tested; the rest inherited |
| Rewards (Plus) | Read points (by profile) and rewards; create, update, redeem, unredeem, delete | All, delete included | Inherited; points read live-tested |
| Photos (Plus) | List albums | No | Inherited |

### Not supported

Nothing here is hidden behind a flag. It is either unavailable from Skylight or not yet captured.

- **Messages**: sending to specific devices, scheduling, repeating, voice notes, and read-aloud (the option exists on `send_message` but was not tested live). Deleting works but the app has no delete button.
- **Meals**: editing a repeating meal (refused), repeat rules other than weekly, deleting a meal that was edited on its own after being in a series (refused), saving a meal to the recipe box from the edit form, and Skylight's own "Plan Meals" feature.
- **Task box**: editing or completing tasks, and saving a routine template to it.
- **Chores**: completing a one-off (non-recurring) chore, Skip, daily or monthly routine schedules (only the weekly format has been captured), and editing a recurring chore's date, time, assignee or stars. Un-completing a routine cannot reduce its `longest_streak`. Whether "this and future" from a later day keeps the earlier days has not been checked (the capture started from the first day).
- **Profiles**: creating or editing them. Read-only.
- **Settings, account, notifications, sleep schedule, device navigation**: none of these are exposed.
- **Photos**: uploads and anything beyond listing albums.
- **Accounts with more than one frame**: the server is pinned to one frame ID.
- **Calendar feeds**: adding one is a CLI command, `skylight-mcp calendars add`, and deliberately not an MCP tool, because the feed address is a secret and a tool argument would put it in the chat transcript. You paste it into a hidden prompt; only the calendar's name and host are printed. Linking a feed to a profile or label, changing which calendar new events are saved to, and adding Google, Outlook, iCloud or Cozi accounts (browser sign-in in the Skylight app) are not supported.
- **Credentials**: sign-in, sign-out and token access are CLI commands (`skylight-mcp auth ...`) and are deliberately not MCP tools.

### Keeping this honest

Every tool must appear in the tables below with the effect it really has, and a
test fails if one is missing or mislabelled. When you add, change or remove a
tool, update this section in the same change.

## Available Tools

Effects: **read** changes nothing; **write** creates or edits and can be edited
again; **destructive** cannot be undone from the API. The hosted server registers
read and write only, so destructive tools exist on the local server alone.

### Planning Tools

Built for "what does the week look like and what is for dinner" questions.
One call returns calendar, chores/tasks, meals and lists, merged per day.

| Tool | Effect | Description |
|------|--------|-------------|
| `get_week_overview` | read | Per-day events, chores/tasks (status, assignee, points), meals, overdue chores, conflicts and list summaries in one compact call. Omits owner emails and calendar IDs. |
| `find_conflicts` | read | Timed events that overlap in a date range. All-day events never conflict. A subscribed feed that lists the same event twice (same start, end and title apart from a trailing note such as "Arrive 20 minutes early") is reported separately as a duplicate, not a conflict. |
| `find_free_slots` | read | Gaps of at least N minutes inside a daily window (default 08:00 to 21:00). |
| `plan_week_meals` | write | Fill several meal slots at once. `dryRun` previews; occupied slots are skipped, never overwritten; all entries are validated before anything is written, and the text is checked: a placeholder such as `(plan doc URL)` refuses a real write, while an over-long name, a dessert over two words, non-ASCII characters or a cooking step in a note are reported as warnings that never block; optional grocery push for recipes. Entries can carry `note` and `description` (the app's "Instructions or ingredients" field), attached after the meal is created. |

Times are computed in the frame's time zone, including DST changes.

### Message Tools

Messages are the notes shown on the frame (Skylight's web app calls them "nudges").

| Tool | Effect | Description |
|------|--------|-------------|
| `get_messages` | read | Messages in a date range with time, text, recipients and sender. Never returns the presigned audio URLs. |
| `send_message` | write | Post a message to the frame now, on all devices. Previews by default and posts only with `confirm: true`. Read aloud is **off** unless asked for. `to` names the profiles to send to (see `get_family_members`); omit it for everyone. Optional sender profile. Up to 300 characters. The app has no delete button, but `delete_message` removes one. |
| `update_message` | write | Edit the text (and optionally the sender) of an existing message. Only messages sent to everyone on all devices that don't repeat; others must be edited in the app. |
| `delete_message` | destructive | Delete a message. The app has no delete button; this uses `DELETE /nudges/{id}`, documented by other Skylight clients and verified on a real frame. Available on both the local and hosted servers (the one destructive tool the hosted server offers). Previews unless `confirm: true`, then reads back and reports success only if the message is gone. |

### Calendar Tools

| Tool | Effect | Description |
|------|--------|-------------|
| `get_calendar_events` | read | Events for a date range |
| `get_source_calendars` | read | Connected calendar sources (Google, iCloud, etc.), with each one's role and whether it is editable. Private feed addresses are hidden: only the host is shown |
| `delete_source_calendar` | destructive | Stop syncing a subscribed calendar feed (a team, school or league schedule). Preview first, then `confirm: true`. Its events leave the family calendar and wall display until it is added again. Feeds only (`kind: webcal`); account calendars are refused. Local server only. |
| `update_source_calendar_profiles` | write | Link a subscribed calendar feed to family profiles, or unlink it (the "Link profiles" checkboxes). Preview first, then `confirm: true`; it sends the complete set so the calendar's label is kept, then reads it back. Feeds only (`kind: webcal`); a calendar can never be left with no profile or label. |
| `rename_source_calendar` | write | Rename a subscribed calendar feed as it appears in Skylight (feeds are named from the feed itself, often at length). Preview first, then `confirm: true`; reads it back and checks the linked profiles did not change. Feeds only (`kind: webcal`). |
| `create_calendar_event` | write | Add an event. `profiles` assigns it to named family members. Local times are sent with the frame's UTC offset. `repeat` (daily or weekly, ends by `until` or `count`, at most 104 occurrences) makes a series; a series is only previewed until `confirm: true`, is created on Skylight's own calendar (not written to Google), and is refused for all-day or multi-profile. |
| `update_calendar_event` | write | Change an event, including who it is assigned to (`profiles`). For a repeating event give the occurrence's `date` and a `scope`: `one` (that occurrence only, which becomes its own event) or `all` (the whole series; overwrites earlier single-occurrence edits). On a series you can change the title, the assignment and the time of day (`startsAt` and `endsAt` together, on the occurrence's date); the time change is verified live for both scopes (`one` detaches that occurrence as its own event; ids change, so re-read before the next call). Notes, location and all-day stay refused. There is no `future` scope: Skylight's API refuses it. Events on a Google calendar change at Google too. |
| `delete_calendar_event` | destructive | Delete one event, or part of a repeating one. Needs the event's `date`; preview first, then `confirm: true`. A repeating event needs a `scope`: `one`, `future` (this and later occurrences) or `all` (the whole series); the preview says which. Events on a Google calendar are deleted at Google too, for everyone who shares it. Refuses subscribed-feed events, non-editable events, an occurrence that was edited on its own, and a repeating event with no scope. Reads the day back to confirm it is gone. Also on the hosted server. |

### Chore Tools

| Tool | Effect | Description |
|------|--------|-------------|
| `get_chores` | read | Chores with optional filters (date, assignee, status) |
| `create_chore` | write | Create a one-off chore for one family member (assignee required; Skylight rejects a chore with no profile). Repeating tasks: `create_routine` |
| `update_chore` | write | Rename, reschedule, reassign a one-off chore. For recurring chores and routines only a rename and a weekly schedule (`days` + `timeOfDay`) are supported; a schedule change needs `acknowledgeReset: true` because it can reset streak history, and Skylight re-keys the chore (the reply gives the new id). Completion goes through `complete_chore`. |
| `create_routine` | write | Create a weekly routine (morning, afternoon or evening) for one or more profiles, via `create_multiple`. Optional habit tracking and stars. Weekly schedules only. |
| `complete_chore` | write | Mark one occurrence of a routine or recurring chore done, or undo it. Previews unless `confirm: true`; awards real stars and streaks on the family display. Recurring chores only. |
| `delete_chore` | destructive | Delete a chore. Previews unless `confirm: true`. Recurring chores and routines need `scope`: `future` (this day and later) or `all` (whole series), sent as `apply_to`. Reads back to confirm. Available on the hosted server too. |

### Task Tools

| Tool | Effect | Description |
|------|--------|-------------|
| `get_task_box` | read | List the task box: reusable chore and routine templates (no assignee or date) |
| `create_task` | write | Add a template to the task box |

### List Tools

| Tool | Effect | Description |
|------|--------|-------------|
| `get_lists` | read | All lists |
| `get_list_items` | read | Items in one list |
| `create_list` | write | Create a list |
| `update_list` | write | Rename or change a list |
| `create_list_item` | write | Add an item |
| `update_list_item` | write | Edit or tick off an item |
| `delete_list` | destructive | Delete a list. Local server only. |
| `delete_list_item` | destructive | Delete an item. Local server only. |

### Family Tools

| Tool | Effect | Description |
|------|--------|-------------|
| `get_family_members` | read | Family member profiles, with the IDs and names that `to` and `profiles` use |
| `get_frame_info` | read | Household/frame information |
| `get_devices` | read | Skylight devices |
| `get_labels` | read | Calendar labels (team, school year, holiday feed: the groupings that are not family members), each with its count of upcoming events and whether a synced calendar still writes to it, so unused ones are easy to spot |
| `delete_label` | destructive | Delete one calendar label (the iOS app can do this; the web app cannot). Preview first, then `confirm: true`; the preview lists the upcoming events that carry only this label, because those are removed with it, while events that also have a profile or another label stay and lose it. Refuses, even with confirm, a profile (family member) and a label a synced calendar still writes to (that would unsync the calendar). Confirms by reading the label list back. Local server only |
| `get_avatars` | read | Available profile avatars |
| `get_colors` | read | Available profile colours |

### Meal Tools

Meals and recipes need Skylight Plus.

| Tool | Effect | Description |
|------|--------|-------------|
| `get_meal_categories` | read | Breakfast, Lunch, Dinner, Snack and their IDs |
| `get_meal_sittings` | read | Scheduled meals in a date range, with sitting IDs; `details: true` also prints notes and instructions |
| `create_meal_sitting` | write | Schedule a meal on a date (free text or a saved recipe). `repeat: "weekly"` repeats it every week on that weekday. |
| `update_meal_sitting` | write | Rename, re-categorise, or set the note or the instructions (`description`) of a meal, by sitting ID and its current date; one-offs can also be moved. Repeating meals need `scope` (`one`, `future`, `all`), are preview-first and need `confirm: true`; they cannot be moved. `one` and `future` return a new sitting ID. |
| `delete_meal_sitting` | destructive | Delete a meal. For a repeating meal, `scope` is `one` (default), `future` or `all` (whole series). Previews unless `confirm: true`; reports success only when Skylight confirms the removal. A meal edited on its own after being in a series is refused. |
| `get_recipes` / `get_recipe` | read | Browse saved recipes |
| `create_recipe` / `update_recipe` | write | Add or change a recipe |
| `delete_recipe` | destructive | Delete a recipe. Local server only. |
| `add_recipe_to_grocery_list` | write | Push a recipe's ingredients to the grocery list |

### Reward Tools

Rewards need Skylight Plus.

| Tool | Effect | Description |
|------|--------|-------------|
| `get_rewards` | read | Available rewards |
| `get_reward_points` | read | Reward points balance |
| `create_reward` | write | Add a reward for one family member (assignee required) |
| `update_reward` | write | Change a reward |
| `redeem_reward` | write | Redeem a reward, spending points |
| `unredeem_reward` | write | Undo a redemption |
| `delete_reward` | destructive | Delete a reward. Local server only. |

### Photo Tools

Needs Skylight Plus. Local server only.

| Tool | Effect | Description |
|------|--------|-------------|
| `get_albums` | read | Photo albums |

## Skylight API calls used

All calls go to `https://app.ourskylight.com/api` (pinned in code). `{f}` is the frame ID. "Live" means run against a real frame by this project; everything else came from upstream and has not been re-run. Messages and meal edit/delete send `Skylight-Api-Version: 2026-10-15`, the version the web app sends; other calls use the client default.

| Function | Calls |
|----------|-------|
| Calendar | `GET/POST /frames/{f}/calendar_events` (live), `PUT /calendar_events/{id}`, `DELETE /calendar_events/{id}` (live), `GET /frames/{f}/source_calendars` (live) |
| Messages | `GET /frames/{f}/nudges?after&before`, `POST /nudges` (everyone or `category_ids`), `PATCH /nudges/{id}`, `DELETE /nudges/{id}` (all live) |
| Meals | `GET /meals/categories`, `GET/POST /meals/sittings`, `PATCH/DELETE /meals/sittings/{id}/instances/{date}` (all live) |
| Recipes | `GET/POST /meals/recipes`, `GET/PATCH/DELETE /meals/recipes/{id}`, `POST /meals/recipes/{id}/add_to_grocery_list` |
| Profiles and family | `GET /frames/{f}/categories` (live), `GET /frames/{f}`, `GET /frames/{f}/devices`, `GET /api/avatars`, `GET /api/colors` |
| Chores and routines | `GET /frames/{f}/chores` (live; `include_up_for_grabs`), `POST /chores`, `PUT/DELETE /chores/{id}` (one-off), `PUT /chores/{occurrence id}` (flat `{summary}` or `{recurrence_set}`; re-keys the chore), `DELETE /chores/{occurrence id}?apply_to=future\|all`, `PUT /chores/{series id}/completions` (body `status` `complete`/`pending`, `instance_date`, `instance_time`), `POST /chores/create_multiple`. All routine calls captured from the web app; the tools are not yet run live |
| Task box | `GET /frames/{f}/task_box/items` (live), `POST /frames/{f}/task_box/items` |
| Lists | `GET/POST /lists`, `GET/PUT/DELETE /lists/{id}`, `POST /lists/{id}/list_items`, `PUT/DELETE /lists/{id}/list_items/{itemId}` |
| Rewards | `GET/POST /rewards`, `PATCH/DELETE /rewards/{id}`, `POST /rewards/{id}/redeem`, `POST /rewards/{id}/unredeem`, `GET /reward_points` |
| Photos | `GET /frames/{f}/albums` (local only) |

The planning tools make no calls of their own; they combine the calendar, chore, meal and list calls above.

## Example Queries

Once configured, you can ask Claude things like:

- "What's on my calendar today?"
- "What chores do I need to do this week?"
- "Add 'take out trash' to my chores for tomorrow"
- "What's on the grocery list?"
- "Add milk to my task list"
- "Who are the family members on Skylight?"
- "How many reward points does each person have?"

## Development

```bash
# Run in development mode (with hot reload)
npm run dev

# Build
npm run build

# Run tests
npm test

# Type check
npm run typecheck
```

### Live tests

`npm test` uses mocked network calls and is what CI runs. A separate, opt-in
suite runs the real tools against your own Skylight frame to catch drift in
Skylight's API: read smoke checks, response-shape contract checks, and a
create/edit/move/delete round trip on a throwaway meal. It does nothing unless
you set `SKYLIGHT_LIVE=1`, never sends messages, and cleans up after itself.
Each test is one file in `tests/live/`, so adding or removing one is adding or
deleting a file. See [tests/live/README.md](tests/live/README.md).

```bash
SKYLIGHT_FRAME_ID=your_frame_id SKYLIGHT_TIMEZONE=America/Los_Angeles \
SKYLIGHT_LIVE=1 npm run test:live
```

Each new terminal starts without these variables; if one is missing the suite
says which and prints the full command. To keep them, add the `export` lines to
`~/.zshrc` (or `~/.bashrc`). On Windows PowerShell use `setx` and open a new window.

Set `SKYLIGHT_TIMEZONE` to your frame's zone. It defaults to `America/New_York`,
which shifts every date window the suite asks for if your frame is elsewhere.
Sign in first with `skylight-mcp auth login`.

## API Documentation

This MCP server is built on top of the reverse-engineered Skylight API. The API endpoints were documented using the [skylight-api](https://github.com/TheEagleByte/skylight-api) project, which converts browser network traffic (HAR files) into an OpenAPI specification.

**API Resources:**
- [Interactive API Docs (Swagger UI)](https://theeaglebyte.github.io/skylight-api/swagger.html)
- [API Reference (ReDoc)](https://theeaglebyte.github.io/skylight-api/redoc.html)
- [OpenAPI Specification](https://theeaglebyte.github.io/skylight-api/openapi/openapi.yaml)

If you discover new API endpoints or find issues with the current documentation, please contribute to the [skylight-api](https://github.com/TheEagleByte/skylight-api) repository.

## Contributing

Contributions are welcome! Here's how you can help:

1. **Fork the repository** and create a feature branch
2. **Make your changes** with clear, descriptive commits
3. **Run tests** (`npm test`) and linting (`npm run lint`) before submitting
4. **Open a pull request** with a description of your changes

### Development Setup

```bash
git clone https://github.com/dwooods/skylight-mcp.git
cd skylight-mcp
npm install
npm run dev  # Start with hot reload
```

### Areas for Contribution

- Adding support for new Skylight API endpoints
- Improving error handling and edge cases
- Enhancing documentation
- Writing additional tests

## Issues & Support

See [SUPPORT.md](SUPPORT.md) for what to run first and what must never be pasted into an issue.

- **Bug reports and feature requests**: [open an issue](https://github.com/dwooods/skylight-mcp/issues/new/choose) and pick a template.
- **Security problems**: use private vulnerability reporting, not a public issue (see SUPPORT.md).

## License

MIT

## Disclaimer

This is an unofficial integration. The Skylight API is reverse-engineered and may change without notice. Use at your own risk.
