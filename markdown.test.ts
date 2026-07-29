import { describe, it, expect } from "vitest";
import {
  cleanUpLinks,
  demoteHeadings,
  expandRedirectLinks,
  flattenMarkdownLinks,
  numberResultHeadings,
  renderLinkSummary,
  renderQuerySection,
  renderSearchResults,
  renderToolResult,
  BATCH_FETCH_TOOL_NAME,
  FETCH_TOOL_NAME,
  type QueryProgress,
  type SearchResultLink,
} from "./markdown.ts";

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

describe("expandRedirectLinks", () => {
  it("unwraps an absolute redirect to the real URL and drops trailing params", () => {
    const input = "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc123";
    expect(expandRedirectLinks(input)).toBe("https://example.com/page");
  });

  it("unwraps a protocol-relative redirect", () => {
    expect(expandRedirectLinks("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com")).toBe(
      "https://a.com",
    );
  });

  it("handles a subdomain on the redirect host", () => {
    expect(expandRedirectLinks("//links.duckduckgo.com/l/?uddg=https%3A%2F%2Fb.com")).toBe(
      "https://b.com",
    );
  });

  it("unwraps inside a markdown link without disturbing surrounding text", () => {
    const input = "[Example](//duckduckgo.com/l/?uddg=https%3A%2F%2Fc.com%2Fp&rut=1)";
    expect(expandRedirectLinks(input)).toBe("[Example](https://c.com/p)");
  });

  it("preserves encoded query params in the destination URL", () => {
    const input = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fd.com%2Fp%3Fa%3D1%26b%3D2";
    expect(expandRedirectLinks(input)).toBe("https://d.com/p?a=1&b=2");
  });

  it("unwraps every redirect in a blob", () => {
    const input =
      "one //duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com two //duckduckgo.com/l/?uddg=https%3A%2F%2Fb.com";
    expect(expandRedirectLinks(input)).toBe("one https://a.com two https://b.com");
  });

  it("leaves non-DDG links untouched", () => {
    const input = "[real](https://example.com/already/clean)";
    expect(expandRedirectLinks(input)).toBe(input);
  });
});

describe("numberResultHeadings", () => {
  it("numbers each result heading in document order", () => {
    expect(numberResultHeadings("## A\n\ntext\n\n## B\n\n## C")).toBe(
      "## 1. A\n\ntext\n\n## 2. B\n\n## 3. C",
    );
  });

  it("leaves body prose alone, including mid-line hashes", () => {
    expect(numberResultHeadings("## A\n\nsee issue #12")).toBe("## 1. A\n\nsee issue #12");
  });

  it("restarts numbering on each body, so every query counts from one", () => {
    expect(numberResultHeadings("## A")).toBe("## 1. A");
    expect(numberResultHeadings("## B")).toBe("## 1. B");
  });

  it("returns an empty body unchanged", () => {
    expect(numberResultHeadings("")).toBe("");
  });
});

describe("demoteHeadings", () => {
  it("shifts every heading down one level", () => {
    expect(demoteHeadings("## A\n\ntext\n\n## B")).toBe("### A\n\ntext\n\n### B");
  });

  it("leaves non-heading text alone, including mid-line hashes", () => {
    expect(demoteHeadings("issue #12 is open")).toBe("issue #12 is open");
  });

  it("does not push an h6 past the bottom", () => {
    expect(demoteHeadings("###### deep")).toBe("###### deep");
  });
});

describe("flattenMarkdownLinks", () => {
  it("collapses a URL-labelled link to the bare href", () => {
    expect(flattenMarkdownLinks("[example.com/page](https://example.com/page)")).toBe(
      "https://example.com/page",
    );
  });

  it("keeps the label and drops the href when the label is prose", () => {
    expect(flattenMarkdownLinks("[Some snippet text here](https://example.com/page)")).toBe(
      "Some snippet text here",
    );
  });

  it("leaves surrounding text and headings untouched", () => {
    const input = "## A Title\n\n[a.com/x](https://a.com/x)\n\nplain text";
    expect(flattenMarkdownLinks(input)).toBe("## A Title\n\nhttps://a.com/x\n\nplain text");
  });

  it("flattens every link in a body", () => {
    const input = "[a.com](https://a.com) and [some words](https://b.com)";
    expect(flattenMarkdownLinks(input)).toBe("https://a.com and some words");
  });
});

describe("cleanUpLinks", () => {
  it("unwraps the redirect and leaves a bare link when the engine is DDG", () => {
    const input = "[x y](//duckduckgo.com/l/?uddg=https%3A%2F%2Fe.com%2Fp&rut=9)";
    expect(cleanUpLinks(input)).toBe("x y");
  });

  it("collapses a display-URL label to the unwrapped destination", () => {
    const input = "[e.com/p](//duckduckgo.com/l/?uddg=https%3A%2F%2Fe.com%2Fp&rut=9)";
    expect(cleanUpLinks(input)).toBe("https://e.com/p");
  });

  it("leaves a body with no links untouched", () => {
    const input = "## A Title\n\nplain prose with no links at all";
    expect(cleanUpLinks(input)).toBe(input);
  });
});

describe("renderQuerySection", () => {
  it("puts the query heading above the cleaned body", () => {
    const out = renderQuerySection(okEntry("q one", [], "## A Result\n\nsome prose"));
    expect(out.startsWith('## Query: "q one"')).toBe(true);
    expect(out).toContain("### 1. A Result");
  });

  it("numbers the result headings inside the body", () => {
    const out = renderQuerySection(okEntry("q", [], "## First\n\nprose\n\n## Second"));
    expect(out).toContain("### 1. First");
    expect(out).toContain("### 2. Second");
  });

  it("does not number the query heading itself", () => {
    const out = renderQuerySection(okEntry("q one", [], "## First"));
    expect(out.startsWith('## Query: "q one"')).toBe(true);
  });

  it("renders a failure line instead of a body when the search failed", () => {
    const out = renderQuerySection(failEntry("q", "HTTP 500 Server Error"));
    expect(out).toContain('## Query: "q"');
    expect(out).toContain("_search failed: HTTP 500 Server Error_");
  });

  it("marks an empty body rather than emitting nothing", () => {
    expect(renderQuerySection(okEntry("q", [], ""))).toContain("_no content extracted_");
  });
});

describe("renderSearchResults", () => {
  it("opens with the root heading and holds every query", () => {
    const out = renderSearchResults([okEntry("q one", []), okEntry("q two", [])]);
    expect(out.startsWith("# Search results by query")).toBe(true);
    expect(out).toContain('## Query: "q one"');
    expect(out).toContain('## Query: "q two"');
  });

  it("emits just the root heading when there are no queries", () => {
    expect(renderSearchResults([])).toBe("# Search results by query");
  });
});

describe("renderLinkSummary", () => {
  it("builds a nested query -> links list under the header", () => {
    const out = renderLinkSummary([
      okEntry("q one", [
        { title: "A", url: "https://a.com" },
        { title: "B", url: "https://b.com" },
      ]),
      okEntry("q two", [{ title: "C", url: "https://c.com" }]),
    ]);
    expect(out).toContain("# Read these pages");
    expect(out).toContain("## q one");
    expect(out).toContain("1. [A](https://a.com)");
    expect(out).toContain("2. [B](https://b.com)");
    expect(out).toContain("## q two");
    expect(out).toContain("1. [C](https://c.com)");
  });

  it("separates query blocks with a blank line", () => {
    const out = renderLinkSummary([
      okEntry("q one", [{ title: "A", url: "https://a.com" }]),
      okEntry("q two", [{ title: "B", url: "https://b.com" }]),
    ]);
    expect(out).toContain("1. [A](https://a.com)\n\n## q two");
  });

  it("names both fetch tools and carries the skip-if-answered caveat", () => {
    const out = renderLinkSummary([okEntry("q", [{ title: "A", url: "https://a.com" }])]);
    expect(out).toContain(FETCH_TOOL_NAME);
    expect(out).toContain(BATCH_FETCH_TOOL_NAME);
    expect(out).toContain("skip fetching only if");
  });

  it("does not number the query heading", () => {
    const out = renderLinkSummary([okEntry("q one", [{ title: "A", url: "https://a.com" }])]);
    expect(out).toContain("## q one");
    expect(out).not.toContain("1. q one");
  });

  it("returns an empty string when no query has links", () => {
    expect(renderLinkSummary([okEntry("q", []), failEntry("q2", "boom")])).toBe("");
  });
});

describe("renderToolResult", () => {
  it("lists each query, then appends the menu at the end", () => {
    const out = renderToolResult([
      okEntry("q1", [{ title: "A", url: "https://a.com" }], "the body text"),
    ]);
    expect(out).toContain('## Query: "q1"');
    expect(out).toContain("the body text");
    expect(out.indexOf("# Read these pages")).toBeGreaterThan(out.indexOf("## Query"));
    expect(out.startsWith("# Search results by query")).toBe(true);
  });

  it("renders a failure line for a failed search", () => {
    const out = renderToolResult([failEntry("q", "HTTP 500 Server Error")]);
    expect(out).toContain("_search failed: HTTP 500 Server Error_");
  });

  it("omits the menu when there are no links to offer", () => {
    const out = renderToolResult([okEntry("q", [], "body")]);
    expect(out).not.toContain("# Read these pages");
  });
});
