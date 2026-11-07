# Security & credential handling

This server signs in to Skylight through your browser (`skylight-mcp auth
login`) and stores the resulting OAuth tokens locally, or, in the deprecated
fallback, logs in with your email and password. Treat all of the following as
secrets and never commit them:

- The credential store (`credential.enc.json` / `credential.json`) and the
  `pending-login.json` file; see README > Authentication for locations
- `SKYLIGHT_EMAIL`, `SKYLIGHT_PASSWORD`, `SKYLIGHT_TOKEN`
- Your Skylight **frame ID** (identifies your household)
- Anything captured from app traffic: HAR files, proxy dumps, bearer tokens,
  calendar IDs, or real family member names/emails
- Calendar **feed addresses** (the `webcal://` or `.ics` links behind subscribed
  calendars, such as a published iCloud calendar or a team schedule). Anyone
  holding the link can read that calendar. Every tool that prints raw
  attributes passes them through one shared redactor, so only the host is shown;
  do not paste the full address anywhere. An opt-in live test (`LIVE_TAGS=security`) runs every
  read tool against your real account and reports only tool name, kind and count of anything
  shaped like a secret. Links in text a person wrote (descriptions, notes, locations) are kept by
  design, so a feed address pasted into an event description is not redacted
  `skylight-mcp calendars add` takes a new address through a hidden prompt only. It is
  refused as an argument, never sent to a tool, and removed from any error text.

## Where credentials belong

- **Preferred:** nowhere in your config. `auth login` keeps tokens in the
  per-user credential store (macOS: AES-256-GCM, key in Keychain; elsewhere a
  `0600` file). The server refuses to fall back to plaintext if the Keychain is
  unavailable, and it only ever sends the token to `app.ourskylight.com`.
- **Local use (fallback):** in your MCP client config's `env` block, or an untracked `.env`
  file. `.env` and variants are git-ignored; only `.env.example` (placeholders
  only) is tracked.
- **Settings file:** `skylight-mcp init` saves `frameId` and `timezone` (no secret) to `config.json` in the per-user config directory, mode `0600`. Its schema is strict: any other key, including a host or URL, makes the server refuse to start, so the file cannot redirect where a token is sent. The file is read only by local entry points, never by the Worker bundle.
- **Never** hard-code credentials in source, tests, docs, or commit messages.
- Use a **unique password** for your Skylight account so a leak can't reach
  anything else.

## Guardrails in this repo

1. `.gitignore` excludes `.env*` (except `.env.example`), HAR captures, key
   files, token/state files, and the generated API types file.
2. `.githooks/pre-commit` blocks commits containing secret-looking content.
   Enable it once per clone: `git config core.hooksPath .githooks`
   (also runs `gitleaks` automatically if it is installed).
3. `.github/workflows/secret-scan.yml` runs gitleaks on every push and PR.
4. Before making the repo public, enable GitHub **secret scanning** and
   **push protection** (Settings → Code security). Both are on by default
   for public repos.

## Hosted server (Cloudflare Workers)

- `.dev.vars` (local secrets for `wrangler dev`) and `.wrangler/` are
  git-ignored and blocked by the pre-commit hook.
- `SETUP_PASSPHRASE` is a Worker secret (`wrangler secret put`), never a
  `vars` entry in `wrangler.jsonc`.
- The Worker stores Skylight tokens only inside OAuth grant props, which
  workers-oauth-provider encrypts; it keeps no plaintext credential anywhere.
- The hosted tool set excludes photo uploads and every `delete_*` tool except an explicit
  allowlist (`HOSTED_DESTRUCTIVE_ALLOWLIST` in `src/worker/mcp.ts`). Each allowlisted delete is
  preview-first and needs `confirm: true`. `delete_source_calendar` and `delete_label` are local-only.
- **Change limit and log.** Every non-read tool call counts against a limit of 60 changes and 10
  deletes per hour (previews and failures included). Over the limit the call is refused and nothing
  is changed. Each attempt logs one line to stderr: tool name, effect, outcome, the running count
  and where it is counted (`limiter`), never arguments, text or ids. On the hosted Worker the count
  lives in a Durable Object (`WRITE_LIMITER`, one per Skylight frame), so it persists across
  requests and restarts and is exact under concurrent calls. If the Durable Object cannot be
  reached, the change is refused: a safety control that is down does not become permission.
  Limits of this control: it is a backstop against a runaway loop, not an authentication control
  and not a billing quota. A Worker deployed with a config from before 1.13.1 has no
  `WRITE_LIMITER` binding; it still runs, but counts in memory, which does not limit across
  requests (version 1.13.0 shipped that way and the limit never applied on the Worker). Such a
  Worker says `"limiter":"memory"` in every log line. Check for `"limiter":"durable"` and a count
  that rises (1, 2, 3) after you deploy. Cloudflare logs must be enabled to keep the lines.
- The setup passphrase form has no attempt limit in code. Use a long random passphrase (20+
  characters from a password manager; the code enforces 12 as a floor). A Cloudflare WAF
  rate-limiting rule does not help here: those rules belong to a zone you own, and the Worker is
  served from `workers.dev` with no zone. Options if you need an attempt limit: a Workers
  rate-limiting binding called from the passphrase step (code change, approximate and per
  location), or a custom domain on your own zone plus a WAF rule. Not built: the passphrase only
  lets someone link their own Skylight account through your Worker, and does not expose your data.
- Anyone who finds the URL can reach the consent page but cannot link an
  account without the passphrase, and a linked account only ever grants
  access to the Skylight account whose sign-in was pasted.

## Generated API types

`src/api/generated-types.ts` is produced from an OpenAPI spec that was built
from real traffic captures, and the generator can embed real sample values
(emails, calendar IDs). It is not used at runtime, is git-ignored, and must
not be committed. If you regenerate it, keep it local.

## If a secret is committed

1. **Rotate it immediately** (change your Skylight password; tokens expire on
   re-login).
2. Remove it from history (`git filter-repo`) — deleting it in a new commit is
   not enough, especially once the repo is public.
3. Force-push and ask collaborators to re-clone.
