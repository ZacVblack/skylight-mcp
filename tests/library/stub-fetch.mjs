// Preloaded into the importer's child process: replaces fetch, records every call, serves fixtures.
// A fixture with a numeric `__status` is served with that status.
import fs from "node:fs";
const fx = JSON.parse(fs.readFileSync(process.env.LIB_FIXTURES, "utf8"));
const calls = [];
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  const auth = new Headers(init?.headers).get("authorization");
  calls.push({ url: String(url), host: u.host, auth, method: init?.method ?? "GET", body: init?.body === undefined || init?.body === null ? null : String(init.body) });
  fs.writeFileSync(process.env.LIB_CALLS, JSON.stringify(calls));
  let body = { data: [] };
  for (const [suffix, value] of Object.entries(fx)) if (u.pathname.endsWith(suffix)) body = value;
  const status = typeof body?.__status === "number" ? body.__status : 200;
  return new Response(JSON.stringify(body), { status });
};
