# Live tests

These run the real tool surface against a real Skylight frame, the way Claude
calls it. They exist because mocked tests prove our code does what we meant,
not that Skylight still behaves the way our captures say.

They are **not** part of `npm test` or CI. They run only when you ask, on your
own machine, against your own frame.

## Run

```sh
SKYLIGHT_FRAME_ID=<your frame id> SKYLIGHT_TIMEZONE=America/Los_Angeles \
SKYLIGHT_LIVE=1 npm run test:live
```

- Put the frame ID in your shell, not in a file in this repo.
- Sign in first with `skylight-mcp auth login`. On macOS the Keychain may ask
  for permission. If the credential store is unusable the run fails; there is
  no fallback.
- Without `SKYLIGHT_LIVE=1` every suite is skipped, so a mistyped command cannot
  touch the frame.

## Pick what runs

Each suite has tags. Filter with environment variables:

```sh
LIVE_TAGS=read         SKYLIGHT_LIVE=1 npm run test:live   # only suites tagged read
LIVE_SKIP_TAGS=write   SKYLIGHT_LIVE=1 npm run test:live   # everything except writes
npm run test:live -- meals                                 # by file name
```

Current tags: `read`, `smoke`, `contract`, `guards`, `write`, `meals`. `LIVE_TAGS=contract` includes the API-version shape comparison (read-only; prints key paths, never values).

## Check a new suite registers

A suite body runs when the file is loaded, before the live connection exists, so reading `ctx.today()`, `ctx.timezone`, `ctx.hasPlus` or `ctx.client()` outside an `it` or hook throws "Live connection is not ready". Mocked tests never load these files, so check it with no credentials:

```sh
env -u SKYLIGHT_LIVE npx vitest run --config vitest.live.config.ts
```

Every suite must report skipped, none failed.

## Add a test

Create `tests/live/<name>.live.ts` and declare one suite:

```ts
import { expect, it } from "vitest";
import { liveSuite } from "./harness.js";

liveSuite("my check", { tags: ["read"] }, (ctx) => {
  it("does the thing", async () => {
    const r = await ctx.call("get_lists");
    expect(r.isError).toBe(false);
  });
});
```

`ctx` gives you `call(tool, args)`, `client()` for raw checks, `today()`,
`daysFromToday(n)`, `hasPlus`, `onCleanup(fn)` and `note(msg)`.

## Remove a test

Delete its file. Nothing else refers to it. To switch one off for a while, skip
its tag with `LIVE_SKIP_TAGS`.

## Rules for every live test

1. **Throwaway data only.** Name anything you create with `LIVE_PREFIX`, put it
   far from real plans (the meal test uses 75 days out), and register an
   `onCleanup` that removes it even if an assertion fails.
2. **No messages.** `send_message`, `update_message` and `delete_message` are
   denied by the harness. A message shows on the family's wall and is seen by
   people before any cleanup runs; `delete_message` exists but was only verified
   once by hand. Allowing them is a deliberate edit of `DENIED_TOOLS` in
   `harness.ts`, plus a test that says why.
3. **Verify by reading back**, not by trusting a success message.
4. **Never print or store** tokens, frame IDs, emails or family names. Assert on
   shapes and counts, not on real content.
5. **Every file uses `liveSuite`.** A guard test in the normal suite fails if a
   file in this folder does not, because an ungated live test would hit the
   frame on any run of this folder.
6. **These tests are allowed to fail for reasons outside our code** (a Skylight
   release, rate limits). That is the point of the contract checks.
