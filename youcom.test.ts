import { describe, it, expect } from "vitest";
import { normalizeYoucomResults, buildYoucomPageResult, type YoucomResult } from "./youcom.ts";

describe("normalizeYoucomResults", () => {
  it("reads the flat `results` array from the keyed Agents API", () => {
    const data = {
      results: [{ title: "a", url: "https://a.example", snippet: "snip a" }],
    };
    expect(normalizeYoucomResults(data)).toEqual([
      { title: "a", url: "https://a.example", snippet: "snip a" },
    ]);
  });

  it("reads `results.web` from the keyless/Search API nested shape", () => {
    const data = {
      results: { web: [{ title: "b", url: "https://b.example", snippets: ["snip b"] }], news: [] },
    };
    expect(normalizeYoucomResults(data)).toEqual([
      { title: "b", url: "https://b.example", snippets: ["snip b"] },
    ]);
  });

  it("returns an empty list when `results` is missing", () => {
    expect(normalizeYoucomResults({})).toEqual([]);
  });

  it("returns an empty list when `results` is neither an array nor has a `web` array", () => {
    expect(normalizeYoucomResults({ results: { news: [] } })).toEqual([]);
    expect(normalizeYoucomResults({ results: "nope" })).toEqual([]);
  });

  it("returns an empty list for non-object input", () => {
    expect(normalizeYoucomResults(null)).toEqual([]);
    expect(normalizeYoucomResults("not an object")).toEqual([]);
  });
});

describe("buildYoucomPageResult", () => {
  const results: YoucomResult[] = [
    { title: "First", url: "https://first.example", snippets: ["first snippet"] },
    { title: "Second", url: "https://second.example", snippet: "second snippet" },
    { title: "No URL", description: "dropped" },
    { title: "Empty URL", url: "", description: "dropped too" },
    { title: "Third", url: "https://third.example", description: "third via description" },
  ];

  it("keeps only results with a non-empty URL, in order, up to `count`", () => {
    const built = buildYoucomPageResult(results, 2, "https://api.you.com/v1/agents/search");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.links).toEqual([
      { title: "First", url: "https://first.example" },
      { title: "Second", url: "https://second.example" },
    ]);
  });

  it("builds readable markdown with a heading, URL, and snippet per result", () => {
    const built = buildYoucomPageResult(results, 1, "https://api.you.com/v1/agents/search");
    if (!built.ok) throw new Error("expected ok result");
    expect(built.readableText).toBe("## First\nhttps://first.example\nfirst snippet");
  });

  it("falls back to `description` when `snippet`/`snippets` are absent", () => {
    const built = buildYoucomPageResult(
      [{ title: "T", url: "https://t.example", description: "desc text" }],
      5,
      "u",
    );
    if (!built.ok) throw new Error("expected ok result");
    expect(built.readableText).toContain("desc text");
  });

  it("uses `(untitled)` for a missing title", () => {
    const built = buildYoucomPageResult([{ url: "https://u.example", snippet: "s" }], 5, "u");
    if (!built.ok) throw new Error("expected ok result");
    expect(built.links[0]?.title).toBe("(untitled)");
    expect(built.readableText).toContain("(untitled)");
  });

  it("returns an error result when no result has a usable URL", () => {
    const built = buildYoucomPageResult(
      [
        { title: "No URL", description: "x" },
        { title: "Empty", url: "" },
      ],
      5,
      "https://api.you.com/v1/agents/search",
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toMatch(/no results with a usable URL/);
    expect(built.requestedUrl).toBe("https://api.you.com/v1/agents/search");
  });

  it("sets finalUrl equal to requestedUrl, since the API call does not redirect", () => {
    const built = buildYoucomPageResult(
      [{ title: "T", url: "https://t.example", snippet: "s" }],
      5,
      "https://api.you.com/v1/agents/search",
    );
    if (!built.ok) throw new Error("expected ok result");
    expect(built.finalUrl).toBe(built.requestedUrl);
  });
});
