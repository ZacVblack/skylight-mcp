import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";

const config = { frameId: "frame-1", timezone: "America/Los_Angeles", token: "test-access-1", authType: "bearer" as const };

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const server = new McpServer({ name: "skylight", version: "t" });
  registerTools(server, { hasPlus: true, photos: false });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const req = new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await runWithContext({ client: new SkylightClient(config, null), config }, () => transport.handleRequest(req));
  const json = (await res.json()) as { result: { content: Array<{ text: string }> } };
  return json.result.content.map((c) => c.text).join("\n");
}

const game = (id: string, summary: string, source = "ics_link") => ({
  id,
  type: "calendar_event",
  attributes: { summary, starts_at: "2026-11-08T18:30:00.000-08:00", ends_at: "2026-11-08T19:30:00.000-08:00", all_day: false, source },
});

function stub(events: unknown[]): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: events }), { status: 200 })));
}

afterEach(() => vi.unstubAllGlobals());

describe("find_conflicts and feed duplicates", () => {
  it("lists a double-listed feed game as a duplicate, with no conflict", async () => {
    stub([game("1", "Game: Team vs Rivals (Arrive 20 minutes early)"), game("2", "Game: Team vs Rivals")]);
    const out = await call("find_conflicts", { date: "2026-11-08", dateEnd: "2026-11-08" });
    expect(out).toContain("No conflicts");
    expect(out).toContain("Duplicate feed entries");
    expect(out).toContain("[event IDs: 1, 2]");
  });

  it("still reports two identical Google events as a conflict", async () => {
    stub([game("1", "Dentist", "google"), game("2", "Dentist", "google")]);
    const out = await call("find_conflicts", { date: "2026-11-08", dateEnd: "2026-11-08" });
    expect(out).toContain("Conflicts between");
    expect(out).not.toContain("Duplicate feed entries");
  });

  it("keeps a real conflict and a duplicate apart in the same range", async () => {
    stub([game("1", "Game (Arrive 20 minutes early)"), game("2", "Game"), game("3", "Dentist", "google")]);
    const out = await call("find_conflicts", { date: "2026-11-08", dateEnd: "2026-11-08" });
    expect(out).toContain("Conflicts between");
    expect(out).toContain("Duplicate feed entries");
  });
});
