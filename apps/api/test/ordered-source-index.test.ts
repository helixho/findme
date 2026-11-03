import { describe, expect, it } from "vitest";
import { firstBy, groupBy, messageKey } from "../src/dogfood/ordered-index.js";

describe("source lookup indexes preserve ordered scan semantics", () => {
  const rows = [
    { id: "b", value: 1 },
    { id: "a", value: 2 },
    { id: "b", value: 3 },
  ];
  it("keeps the first duplicate exactly as Array.find", () => {
    const index = firstBy(rows, (row) => row.id);
    expect(index.get("b")).toBe(rows.find((row) => row.id === "b"));
    expect(index.get("missing")).toBeUndefined();
    expect([...index.keys()]).toEqual(["b", "a"]);
  });
  it("keeps all group members in original order without changing the input", () => {
    const original = JSON.stringify(rows);
    const groups = groupBy(rows, (row) => row.id);
    expect(groups.get("b")).toEqual(rows.filter((row) => row.id === "b"));
    expect(groups.get("a")?.[0]).toBe(rows[1]);
    expect(JSON.stringify(rows)).toBe(original);
    expect([...groupBy([], (row: string) => row)]).toEqual([]);
  });
  it("does not collapse compound identifiers or missing identifiers", () => {
    expect(messageKey("a:b", "c")).not.toBe(messageKey("a", "b:c"));
    expect(messageKey("a", undefined)).not.toBe(messageKey("a", "undefined"));
    expect(messageKey("a", "")).not.toBe(messageKey("a", undefined));
    expect(messageKey("会话", "😀")).toBe(messageKey("会话", "😀"));
  });
});
