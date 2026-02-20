import { describe, expect, it } from "vitest";
import { escapeHtml } from "../lib/email/escape-html";

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes less-than signs", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes greater-than signs", () => {
    expect(escapeHtml("a>b")).toBe("a&gt;b");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('a"b')).toBe("a&quot;b");
  });

  it("escapes single quotes", () => {
    expect(escapeHtml("a'b")).toBe("a&#x27;b");
  });

  it("escapes all special characters in one string", () => {
    expect(escapeHtml(`<div class="x" data-a='b'>&</div>`)).toBe(
      "&lt;div class=&quot;x&quot; data-a=&#x27;b&#x27;&gt;&amp;&lt;/div&gt;",
    );
  });

  it("returns unchanged string when no special characters", () => {
    const safe = "Hello World 123";
    expect(escapeHtml(safe)).toBe(safe);
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("handles string with only special characters", () => {
    expect(escapeHtml("<>&\"'")).toBe("&lt;&gt;&amp;&quot;&#x27;");
  });

  it("prevents XSS via script injection", () => {
    const malicious = '<img onerror="alert(1)" src=x>';
    const escaped = escapeHtml(malicious);
    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
    expect(escaped).not.toContain('"');
  });
});
