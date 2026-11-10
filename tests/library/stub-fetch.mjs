// Preloaded into the importer's child process: replaces fetch, records every call, serves fixtures.
import fs from "node:fs";
const fx = JSON.parse(fs.readFileSync(process.env.LIB_FIXTURES, "utf8"));
const calls = [];
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  const auth = new Headers(init?.headers).get("authorization");
  calls.push({ url: String(url), host: u.host, auth });
  fs.writeFileSync(process.env.LIB_CALLS, JSON.stringify(calls));
  let body = { data: [] };
  for (const [suffix, value] of Object.entries(fx)) if (u.pathname.endsWith(suffix)) body = value;
  return new Response(JSON.stringify(body), { status: 200 });
};
