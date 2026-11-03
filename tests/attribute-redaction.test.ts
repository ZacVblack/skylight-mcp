import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";
import { formatAttribute } from "../src/utils/redact.js";

const config = { frameId: "frame-1", timezone: "UTC", token: "test-access-1", authType: "bearer" as const };

const SECRETS = ["SECRETTOKEN123", "userId=777", "private/abc", "signed-sig-999", "deep-secret-555", "hunter2"];

// Secret addresses in a plain field, in an array, in a nested object, and with
// embedded credentials. The names are deliberately ones no tool special-cases.
const attributes = {
  name: "Visible name",
  image_url: "https://media.example.com/photos/abc.jpg?sig=signed-sig-999",
  links: ["https://league.example.com/ajax/load?userId=777", "plain text"],
  nested: { feed: "webcal://p1-caldav.example.com/published/2/SECRETTOKEN123", deeper: { u: "https://x.example.com/private/abc?k=deep-secret-555" } },
  login: "https://user:hunter2@feeds.example.com/cal.ics",
  notification_email: "someone@example.com",
};

async function call(name: string, args: Record<string, unknown>, body: unknown): Promise<string> {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  const server = new McpServer({ name: "skylight", version: "t" });
  registerTools(server, { hasPlus: true, photos: true });
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

afterEach(() => vi.unstubAllGlobals());

describe("formatAttribute", () => {
  it("redacts feed addresses in strings, arrays and nested objects", () => {
    for (const value of [attributes.image_url, attributes.links, attributes.nested, attributes.login]) {
      const out = formatAttribute("anything", value);
      for (const s of SECRETS) expect(out).not.toContain(s);
    }
  });

  it("keeps the stock avatar CDN link, but not the same host with a query string", () => {
    const stock = "https://skylight-frame-res.cloudinary.com/image/upload/v1/avatars/avatar_cat.png";
    expect(formatAttribute("image_url", stock)).toBe(stock);
    expect(formatAttribute("image_url", `${stock}?sig=abc`)).not.toContain("sig=abc");
  });

  it("keeps links a person wrote in free-text fields", () => {
    expect(formatAttribute("description", "Join: https://meet.example.com/room/42")).toContain("room/42");
    expect(formatAttribute("location", "https://maps.example.com/p/1")).toContain("p/1");
  });

  it("prints plain values as before", () => {
    expect(formatAttribute("brightness", 255)).toBe("255");
    expect(formatAttribute("enabled", true)).toBe("true");
    expect(formatAttribute("tags", ["a", "b"])).toBe("a,b");
  });
});

describe("tools that print raw attributes never print a feed address", () => {
  const list = { data: [{ id: "1", type: "x", attributes }] };
  const single = { data: { id: "1", type: "x", attributes } };
  const cases: Array<[string, Record<string, unknown>, unknown]> = [
    ["get_avatars", {}, list],
    ["get_colors", {}, list],
    ["get_rewards", {}, list],
    ["get_albums", {}, list],
    ["get_devices", {}, list],
    ["get_frame_info", {}, single],
    ["get_recipe", { recipeId: "1" }, single],
  ];

  for (const [name, args, body] of cases) {
    it(name, async () => {
      const text = await call(name, args, body);
      expect(text.length).toBeGreaterThan(0);
      for (const s of SECRETS) expect(text).not.toContain(s);
    });
  }

  it("get_frame_info does not print the notification address", async () => {
    const text = await call("get_frame_info", {}, single);
    expect(text).not.toContain("someone@example.com");
  });
});
