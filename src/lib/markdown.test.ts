import { describe, expect, it } from "vitest";
import { renderIssueHtml } from "./markdown";

describe("renderIssueHtml", () => {
  it("renders headings and paragraphs", () => {
    const html = renderIssueHtml("# Hello\n\nWorld.");
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<p>World.</p>");
  });

  it("renders links", () => {
    const html = renderIssueHtml("[click here](https://example.com)");
    expect(html).toContain('<a href="https://example.com">click here</a>');
  });

  it("renders GFM tables", () => {
    const html = renderIssueHtml("| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(html).toContain("<table>");
  });
});
