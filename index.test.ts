import { describe, it, expect } from "vitest";
import {
  buildSearchUrl,
  cleanSearchResultLinks,
  parseDdgLinks,
  renderProgressCard,
  DEFAULT_SEARCH_URL_TEMPLATE,
} from "./index.ts";

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

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

describe("renderProgressCard", () => {
  it("does not throw and renders an empty card when progressByQuery is undefined", () => {
    let card = "";
    expect(() => {
      card = renderProgressCard(undefined, plainTheme, 80);
    }).not.toThrow();
    expect(card).toContain("0/0 done");
  });

  it("renders a header and one row per query for a populated result", () => {
    const card = renderProgressCard(
      [
        { query: "rust traits", status: "done", result: undefined },
        { query: "zig comptime", status: "error", result: undefined },
      ],
      plainTheme,
      80,
    );
    expect(card).toContain("2/2 done · ok 1 · err 1");
    expect(card).toContain("rust traits");
    expect(card).toContain("zig comptime");
  });
});
