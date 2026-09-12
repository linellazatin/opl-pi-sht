import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

// Structured extraction of a rendered HTML string (post-JS DOM from Playwright).
// Pipeline mirrors opl-webaccess/extract.ts on purpose; duplicated ~40 lines to
// keep per-extension installs independent (see research/browser-structured-extraction-plan.md).

const td = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

export interface ExtractedMarkdown {
  title: string;
  markdown: string;
}

export function extractMarkdown(html: string, opts?: { raw?: boolean }): ExtractedMarkdown {
  // Readability's candidate scoring is a whole-document heuristic; on a small
  // selector-scoped fragment it drops siblings. Pass raw:true for fragments.
  if (opts?.raw) {
    return { title: "", markdown: td.turndown(html) };
  }
  const { document } = parseHTML(html);
  let article = null;
  try {
    article = new Readability(document as unknown as Document).parse();
  } catch {
    // Readability failed — fall back to raw turndown
  }
  if (!article?.content) {
    return { title: "", markdown: td.turndown(html) };
  }
  return { title: article.title ?? "", markdown: td.turndown(article.content) };
}
