import { describe, expect, it } from "vitest";
import { diffShapes, isSameShape, itemCount, shapeOf } from "./live/shape.js";

describe("shape fingerprint", () => {
  it("is the same for the same structure with different values", () => {
    const a = { data: [{ id: "1", attributes: { name: "Ann", count: 2 } }] };
    const b = { data: [{ id: "9", attributes: { name: "Bob", count: 7 } }] };
    expect(isSameShape(diffShapes(a, b))).toBe(true);
  });

  it("reports a key present under one version only", () => {
    const oldV = { data: { attributes: { name: "x" } } };
    const newV = { data: { attributes: { name: "x", all_devices: true } } };
    const d = diffShapes(oldV, newV);
    expect(d.onlyOld).toEqual([]);
    expect(d.onlyNew).toEqual(["data.attributes.all_devices:boolean"]);
  });

  it("reports a type change on both sides", () => {
    const d = diffShapes({ a: "1" }, { a: 1 });
    expect(d.onlyOld).toEqual(["a:string"]);
    expect(d.onlyNew).toEqual(["a:number"]);
  });

  it("collapses arrays to the union of their elements", () => {
    const d = diffShapes({ list: [{ a: 1 }, { b: 2 }] }, { list: [{ b: 2 }, { a: 1 }] });
    expect(isSameShape(d)).toBe(true);
    expect([...shapeOf({ list: [{ a: 1 }, { b: 2 }] })]).toContain("list[].b:number");
  });

  it("an empty array and a missing array differ", () => {
    expect(isSameShape(diffShapes({ list: [] }, {}))).toBe(false);
  });

  it("never prints a value from the input", () => {
    const secret = "webcal://example.com/private-token-value";
    const out = JSON.stringify([...shapeOf({ data: [{ attributes: { address: secret, n: 123456 } }] })]);
    expect(out).not.toContain("private-token-value");
    expect(out).not.toContain("123456");
    expect(out).not.toContain("webcal");
  });

  it("hides data-like object keys (ids, dates, long tokens)", () => {
    const paths = [...shapeOf({ "12345678": { x: 1 }, "2026-11-04": 1, abcdefghijklmnopqrstuvwxyz: 1, plain: 1 })];
    const joined = paths.join("\n");
    expect(joined).not.toContain("12345678");
    expect(joined).not.toContain("2026-11-04");
    expect(joined).not.toContain("abcdefghijklmnop");
    expect(joined).toContain("<key>");
    expect(joined).toContain("plain:number");
  });
});

describe("long field names versus tokens", () => {
  it("keeps a long lowercase snake_case field name so a new attribute can be named", () => {
    const joined = [...shapeOf({ attributes: { completed_by_habit_tracker_entry: null } })].join("\n");
    expect(joined).toContain("completed_by_habit_tracker_entry");
    expect(joined).not.toContain("<key>");
  });

  it("still hides token-like keys, even with underscores, digits or capitals", () => {
    const joined = [...shapeOf({ Ab3_Xk9_Qz7_Lm2_Pw8_Rt5_Yu1: 1, abcdefghijklmnopqrstuvwxyz: 1, "9f8e7d6c5b4a39281706f5e4d3c2b1a0": 1 })].join("\n");
    expect(joined).not.toContain("Xk9");
    expect(joined).not.toContain("abcdefghij");
    expect(joined).not.toContain("9f8e7d6c");
    expect(joined).toContain("<key>");
  });
});

describe("itemCount", () => {
  it("counts a data array, empty or not", () => {
    expect(itemCount({ data: [] })).toBe(0);
    expect(itemCount({ data: [{ id: "1" }, { id: "2" }] })).toBe(2);
  });
  it("counts a bare top-level array, so an empty one is empty and not unknown", () => {
    expect(itemCount([])).toBe(0);
    expect(itemCount([{ id: "1" }])).toBe(1);
  });
  it("is null when the body is not a list", () => {
    expect(itemCount({ data: { id: "1" } })).toBeNull();
    expect(itemCount(null)).toBeNull();
    expect(itemCount("x")).toBeNull();
  });
});
