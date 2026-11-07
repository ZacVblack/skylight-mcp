import { describe, expect, it } from "vitest";
import { scanForLeaks } from "./live/leak-scan.js";

const kinds = (text: string) => scanForLeaks(text).map((f) => f.kind).sort();

describe("scanForLeaks", () => {
  it("finds a feed scheme, a query string, a token path, a jwt, a bearer header and a bare token", () => {
    expect(kinds("source: webcal://p1.example.com/published/abc")).toEqual(["feed-scheme"]);
    expect(kinds("image: https://media.example.com/a.jpg?sig=zzz")).toEqual(["url-with-query"]);
    expect(kinds("link: https://x.example.com/cal/Ab3dEf6hIj9lMn2pQr5tUv8")).toEqual(["url-token-path"]);
    expect(kinds("t: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig")).toEqual(["jwt-like"]);
    expect(kinds("Authorization: Bearer abc")).toEqual(["bearer-header"]);
    expect(kinds("id: Ab3dEf6hIj9lMn2pQr5tUv8Ab3dEf6hIj9lMn2pQr5")).toEqual(["bare-token"]);
  });

  it("ignores the stock avatar CDN without a query, but not with one", () => {
    expect(kinds("image: https://skylight-frame-res.cloudinary.com/image/upload/v1/avatars/avatar_cat.png")).toEqual([]);
    // A long token-like path segment would be flagged anywhere else; on the stock host it is allowed.
    expect(kinds("image: https://skylight-frame-res.cloudinary.com/image/upload/Ab3dEf6hIj9lMn2pQr5tUv8")).toEqual([]);
    expect(kinds("image: https://other.example.com/image/upload/Ab3dEf6hIj9lMn2pQr5tUv8")).toEqual(["url-token-path"]);
    expect(kinds("image: https://skylight-frame-res.cloudinary.com/image/upload/v1/a.png?sig=1")).toEqual(["url-with-query"]);
  });

  it("ignores links in text a person wrote", () => {
    expect(kinds("  description: Join https://meet.example.com/room/Ab3dEf6hIj9lMn2pQr5tUv8?pwd=1")).toEqual([]);
    expect(kinds("  location: https://maps.example.com/p?q=1")).toEqual([]);
  });

  it("ignores a link on a continuation line of a free-text attribute, but not under any other key", () => {
    expect(kinds("  description: first line\nJoin https://meet.example.com/x?pwd=1\n  title: next")).toEqual([]);
    const f = scanForLeaks("  image_url: https://media.example.com/a.jpg?sig=zzz");
    expect(f).toEqual([{ kind: "url-with-query", key: "image_url", count: 1 }]);
    // A continuation after a non-free-text key stays under that key.
    expect(scanForLeaks("  something: x\nhttps://a.example.com/x?t=1")).toEqual([{ kind: "url-with-query", key: "something", count: 1 }]);
  });

  it("a new item header ends the previous item's free-text attribute", () => {
    const text = "- Event (ID: 1)\n  description: first\n- Event (ID: 2)\nhttps://a.example.com/x?t=1";
    expect(scanForLeaks(text)).toEqual([{ kind: "url-with-query", key: "(other)", count: 1 }]);
  });

  it("accepts a redacted feed address and still flags a real one", () => {
    expect(kinds("  source_id: webcal://p1.example.com/... (feed address hidden)")).toEqual([]);
    expect(kinds("  source_id: webcal://p1.example.com/published/abc (feed address hidden)")).toEqual(["feed-scheme"]);
    expect(kinds("  source_id: webcal://p1.example.com/...")).toEqual(["feed-scheme"]);
  });

  it("does not flag ordinary output", () => {
    expect(kinds("id: 123456\nname: Dinner\ndate: 2026-11-06\ncolor: #aabbcc\nhttps://example.com/recipes/pasta")).toEqual([]);
  });

  it("counts repeats", () => {
    const f = scanForLeaks("a: webcal://x.example.com/1\nb: webcals://y.example.com/2");
    expect(f).toEqual([{ kind: "feed-scheme", key: "(other)", count: 2 }]);
  });

  it("never returns any input text", () => {
    const marker = "MARKERVALUE9x8y7z6w5v4u3t2s1r0q";
    const out = JSON.stringify(scanForLeaks(`feed: webcal://p1.example.com/${marker}\nk: https://a.example.com/x?t=${marker}`));
    expect(out).not.toContain("MARKERVALUE");
    expect(out).not.toContain("example.com");
  });
});
