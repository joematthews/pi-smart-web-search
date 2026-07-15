import { describe, it, expect } from "vitest";
import {
  buildSearchUrl,
  cleanSearchResultLinks,
  parseDdgLinks,
  extractResultLinks,
  renderNextStepMenu,
  formatResultsForModel,
  renderProgressCard,
  formatStatusBadge,
  DEFAULT_SEARCH_URL_TEMPLATE,
  type QueryProgress,
  type SearchResultLink,
} from "./index.ts";

describe("buildSearchUrl", () => {
  it("substitutes {query} with the URL-encoded query", () => {
    expect(buildSearchUrl("https://x/?q={query}", "hello world")).toBe(
      "https://x/?q=hello%20world",
    );
  });

  it("encodes reserved characters", () => {
    expect(buildSearchUrl("https://x/?q={query}", "a&b=c?d")).toBe("https://x/?q=a%26b%3Dc%3Fd");
  });

  it("fills the default DDG template", () => {
    expect(buildSearchUrl(DEFAULT_SEARCH_URL_TEMPLATE, "rust traits")).toBe(
      "https://html.duckduckgo.com/html/?q=rust%20traits",
    );
  });
});

describe("parseDdgLinks", () => {
  it("unwraps an absolute redirect to the real URL and drops trailing params", () => {
    const input = "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc123";
    expect(parseDdgLinks(input)).toBe("https://example.com/page");
  });

  it("unwraps a protocol-relative redirect", () => {
    expect(parseDdgLinks("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com")).toBe("https://a.com");
  });

  it("handles a subdomain on the redirect host", () => {
    expect(parseDdgLinks("//links.duckduckgo.com/l/?uddg=https%3A%2F%2Fb.com")).toBe(
      "https://b.com",
    );
  });

  it("unwraps inside a markdown link without disturbing surrounding text", () => {
    const input = "[Example](//duckduckgo.com/l/?uddg=https%3A%2F%2Fc.com%2Fp&rut=1)";
    expect(parseDdgLinks(input)).toBe("[Example](https://c.com/p)");
  });

  it("preserves encoded query params in the destination URL", () => {
    const input = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fd.com%2Fp%3Fa%3D1%26b%3D2";
    expect(parseDdgLinks(input)).toBe("https://d.com/p?a=1&b=2");
  });

  it("unwraps every redirect in a blob", () => {
    const input =
      "one //duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com two //duckduckgo.com/l/?uddg=https%3A%2F%2Fb.com";
    expect(parseDdgLinks(input)).toBe("one https://a.com two https://b.com");
  });

  it("leaves non-DDG links untouched", () => {
    const input = "[real](https://example.com/already/clean)";
    expect(parseDdgLinks(input)).toBe(input);
  });

  it("leaves the original link when the encoded target is malformed", () => {
    const input = "//duckduckgo.com/l/?uddg=%E0%A4%A"; // invalid percent-encoding
    expect(parseDdgLinks(input)).toBe(input);
  });
});

describe("cleanSearchResultLinks", () => {
  it("unwraps when the configured engine is DDG", () => {
    const input = "[x](//duckduckgo.com/l/?uddg=https%3A%2F%2Fe.com%2Fp&rut=9)";
    expect(cleanSearchResultLinks(input, DEFAULT_SEARCH_URL_TEMPLATE)).toBe("[x](https://e.com/p)");
  });

  it("returns markdown untouched for a non-DDG engine, even with DDG-style links present", () => {
    const input = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fe.com";
    const nonDdgEngine = "https://www.google.com/search?q={query}";
    expect(cleanSearchResultLinks(input, nonDdgEngine)).toBe(input);
  });
});

// --- Fixtures for the result-assembly helpers ---
const anchor = (href: string, title: string) => `<a class="result__a" href="${href}">${title}</a>`;

function okEntry(query: string, links: SearchResultLink[], readableText = "body"): QueryProgress {
  return {
    query,
    status: "done",
    result: { ok: true, requestedUrl: "", finalUrl: "", title: "", readableText, links },
  };
}

function failEntry(query: string, error: string): QueryProgress {
  return { query, status: "error", result: { ok: false, requestedUrl: "", error } };
}

describe("extractResultLinks", () => {
  it("extracts the title and redirect-unwrapped URL from a result anchor", () => {
    const html = anchor(
      "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x",
      "Example A",
    );
    expect(extractResultLinks(html)).toEqual([
      { title: "Example A", url: "https://example.com/a" },
    ]);
  });

  it("dedups repeated destination URLs", () => {
    const html =
      anchor("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com", "One") +
      anchor("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com", "One again");
    expect(extractResultLinks(html)).toEqual([{ title: "One", url: "https://a.com" }]);
  });

  it("caps at MAX_LINKS_PER_QUERY (4)", () => {
    const html = Array.from({ length: 6 }, (_, i) => anchor(`https://s${i}.com`, `S${i}`)).join("");
    expect(extractResultLinks(html)).toHaveLength(4);
  });

  it("returns [] for a page with no result anchors", () => {
    expect(extractResultLinks("<div>no results here</div>")).toEqual([]);
  });

  it("falls back to the URL as the title when anchor text is empty", () => {
    expect(extractResultLinks(anchor("https://x.com/p", ""))).toEqual([
      { title: "https://x.com/p", url: "https://x.com/p" },
    ]);
  });
});

describe("renderNextStepMenu", () => {
  it("builds a nested query -> links list under the Fetch header", () => {
    const out = renderNextStepMenu([
      okEntry("q one", [
        { title: "A", url: "https://a.com" },
        { title: "B", url: "https://b.com" },
      ]),
      okEntry("q two", [{ title: "C", url: "https://c.com" }]),
    ]);
    expect(out).toContain("# Fetch the most relevant links");
    expect(out).toContain('1. "q one"');
    expect(out).toContain("   1.1 [A](https://a.com)");
    expect(out).toContain("   1.2 [B](https://b.com)");
    expect(out).toContain('2. "q two"');
    expect(out).toContain("   2.1 [C](https://c.com)");
  });

  it("returns an empty string when no query has links", () => {
    expect(renderNextStepMenu([okEntry("q", []), failEntry("q2", "boom")])).toBe("");
  });
});

describe("formatResultsForModel", () => {
  it("lists each query, then appends the Fetch menu at the end", () => {
    const out = formatResultsForModel(
      [okEntry("q1", [{ title: "A", url: "https://a.com" }], "the body text")],
      10_000,
      DEFAULT_SEARCH_URL_TEMPLATE,
    );
    expect(out).toContain('## Query: "q1"');
    expect(out).toContain("the body text");
    expect(out.indexOf("# Fetch the most relevant links")).toBeGreaterThan(out.indexOf("## Query"));
  });

  it("renders a failure line for a failed search", () => {
    const out = formatResultsForModel(
      [failEntry("q", "HTTP 500 Server Error")],
      10_000,
      DEFAULT_SEARCH_URL_TEMPLATE,
    );
    expect(out).toContain("_search failed: HTTP 500 Server Error_");
  });

  it("truncates body text at maxCharsPerQuery", () => {
    const out = formatResultsForModel(
      [okEntry("q", [], "x".repeat(50))],
      10,
      DEFAULT_SEARCH_URL_TEMPLATE,
    );
    expect(out).toContain("...(truncated)");
    expect(out).not.toContain("x".repeat(50));
  });

  it("omits the menu when there are no links to offer", () => {
    const out = formatResultsForModel(
      [okEntry("q", [], "body")],
      10_000,
      DEFAULT_SEARCH_URL_TEMPLATE,
    );
    expect(out).not.toContain("# Fetch the most relevant links");
  });
});

describe("progress card", () => {
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

  it("summarizes counts and hides the drop suffix when nothing was dropped", () => {
    const card = renderProgressCard([okEntry("a", []), failEntry("b", "x")], 0, theme, 80);
    expect(card).toContain("web_search 2/2 done | ok 1 | err 1");
    expect(card).not.toContain("drop");
  });

  it("shows the drop count when queries were capped", () => {
    const card = renderProgressCard([okEntry("a", [])], 3, theme, 80);
    expect(card).toContain("| drop 3");
  });

  it("centers a status label in a fixed-width badge", () => {
    expect(formatStatusBadge("done")).toBe("[   done    ]");
  });

  it("renders an empty card instead of throwing when progressByQuery is undefined", () => {
    let card = "";
    expect(() => {
      card = renderProgressCard(undefined, 0, theme, 80);
    }).not.toThrow();
    expect(card).toContain("0/0 done");
  });
});
