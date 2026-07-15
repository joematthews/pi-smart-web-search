import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep loadSettings hermetic: point the "global" settings dir somewhere that does not exist,
// so only the per-project file under test is read.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => join(tmpdir(), "pi-sws-no-agent-dir"),
}));
vi.mock("wreq-js", () => ({ fetch: vi.fn() }));

import { fetch } from "wreq-js";
import { fetchReadablePage, loadSettings, DEFAULT_SEARCH_URL_TEMPLATE } from "./index.ts";

const mockFetch = vi.mocked(fetch);
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

function response(opts: {
  status?: number;
  ok?: boolean;
  statusText?: string;
  url?: string;
  html?: string;
}): FetchResponse {
  return {
    status: opts.status ?? 200,
    ok: opts.ok ?? true,
    statusText: opts.statusText ?? "OK",
    url: opts.url ?? "https://html.duckduckgo.com/html/?q=x",
    text: () => Promise.resolve(opts.html ?? "<html></html>"),
  } as unknown as FetchResponse;
}

describe("fetchReadablePage", () => {
  beforeEach(() => mockFetch.mockReset());

  it("returns extracted text and result links on success", async () => {
    const html =
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=1">Result A</a>' +
      "<p>Some readable body content here.</p>";
    mockFetch.mockResolvedValue(response({ html }));

    const result = await fetchReadablePage("https://html.duckduckgo.com/html/?q=x");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.links).toEqual([{ title: "Result A", url: "https://example.com/a" }]);
      expect(typeof result.readableText).toBe("string");
    }
  });

  it("treats HTTP 202 as a rate-limit soft-ban", async () => {
    mockFetch.mockResolvedValue(response({ status: 202 }));
    const result = await fetchReadablePage("https://x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/rate-limited/);
  });

  it("reports a non-2xx status as an error", async () => {
    mockFetch.mockResolvedValue(response({ ok: false, status: 500, statusText: "Server Error" }));
    const result = await fetchReadablePage("https://x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("HTTP 500 Server Error");
  });

  it("never throws -- a failure while reading the response comes back as a result", async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      statusText: "OK",
      url: "https://x",
      text: () => Promise.reject(new Error("network boom")),
    } as unknown as FetchResponse);
    const result = await fetchReadablePage("https://x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("network boom");
  });
});

describe("loadSettings", () => {
  it("returns defaults when the project has no settings file", () => {
    const s = loadSettings(join(tmpdir(), "pi-sws-nonexistent-project"));
    expect(s.searchUrlTemplate).toBe(DEFAULT_SEARCH_URL_TEMPLATE);
    expect(s.maxCharsPerQuery).toBe(10_000);
  });

  it("applies searchUrl and maxChars overrides from a project settings file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sws-"));
    mkdirSync(join(dir, ".pi"));
    writeFileSync(
      join(dir, ".pi", "settings.json"),
      JSON.stringify({ smartWebSearch: { searchUrl: "https://eng/?q={query}", maxChars: 500 } }),
    );
    const s = loadSettings(dir);
    expect(s.searchUrlTemplate).toBe("https://eng/?q={query}");
    expect(s.maxCharsPerQuery).toBe(500);
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores a searchUrl that lacks the {query} placeholder", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sws-"));
    mkdirSync(join(dir, ".pi"));
    writeFileSync(
      join(dir, ".pi", "settings.json"),
      JSON.stringify({ smartWebSearch: { searchUrl: "https://no-placeholder" } }),
    );
    const s = loadSettings(dir);
    expect(s.searchUrlTemplate).toBe(DEFAULT_SEARCH_URL_TEMPLATE);
    rmSync(dir, { recursive: true, force: true });
  });
});
