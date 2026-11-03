import { describe, expect, it } from "vitest";
import { isSkylightUrl, openSkylightUrl, openerFor } from "../src/open-url.js";

describe("open sign-in URL", () => {
  it("only ever opens the pinned Skylight host", async () => {
    for (const bad of [
      "https://evil.example/oauth/authorize",
      "http://app.ourskylight.com/oauth/authorize",
      "https://app.ourskylight.com.evil.example/x",
      "https://ourskylight.com/welcome",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(isSkylightUrl(bad), bad).toBe(false);
      expect(await openSkylightUrl(bad), bad).toBe(false);
    }
    expect(isSkylightUrl("https://app.ourskylight.com/oauth/authorize?a=1&b=2")).toBe(true);
  });

  it("passes the URL as one argument, never through a shell", () => {
    const url = "https://app.ourskylight.com/oauth/authorize?a=1&b=2";
    expect(openerFor("darwin", url)).toEqual({ command: "open", args: [url] });
    expect(openerFor("linux", url)).toEqual({ command: "xdg-open", args: [url] });
    const win = openerFor("win32", url);
    expect(win.command).toBe("rundll32");
    expect(win.args).toEqual(["url.dll,FileProtocolHandler", url]);
  });
});
