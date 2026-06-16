import { describe, expect, it } from "vitest";
import { escapeHtml } from "../src/util/html.js";

describe("escapeHtml", () => {
  it("escapes all five significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("neutralizes a script-injection attempt", () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;",
    );
  });

  it("leaves safe text untouched", () => {
    expect(escapeHtml("Companion user 123")).toBe("Companion user 123");
  });

  it("escapes ampersand first so entities are not double-formed wrongly", () => {
    expect(escapeHtml("a & b < c")).toBe("a &amp; b &lt; c");
  });
});
