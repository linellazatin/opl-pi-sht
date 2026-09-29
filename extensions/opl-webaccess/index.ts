import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { searchWeb } from "./search.js";
import { fetchAllContent } from "./extract.js";
import {
  generateId,
  storeResult,
  getResult,
  persistResult,
  restoreFromSession,
} from "./storage.js";
import { truncate, errorMessage, paginateContent, continuationNotice } from "./utils.js";
import { loadConfig, resolveCaps } from "./config.js";
import type { StoredData } from "./types.js";

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const caps = resolveCaps(config);
  const allowPrivateNetwork = config.allowPrivateNetwork === true;

  // Note shown to the model when the per-call URL/query cap drops some inputs.
  const skippedNote = (dropped: number, limit: number, singular: string, plural: string) =>
    dropped > 0
      ? `\n\n*Note: ${dropped} additional ${dropped === 1 ? singular : plural} beyond the per-call limit of ${limit} ${dropped === 1 ? "was" : "were"} skipped.*`
      : "";

  pi.on("session_start", async (_event, ctx) => {
    restoreFromSession(ctx);
  });

  // ── web_search ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using the configured search provider (gemini, tavily, ddgs, searxng, or exa). Returns a synthesized answer with source citations. Provider is set in ~/.pi/agent/configs/opl-webaccess.json. Use queries (plural) to run multiple searches in parallel.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Single search query" })),
      queries: Type.Optional(
        Type.Array(Type.String(), { description: "Multiple search queries run in parallel" })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const rawQueries = params.queries ?? (params.query ? [params.query] : null);
      if (!rawQueries?.length) {
        return {
          content: [{ type: "text", text: "Error: provide either query or queries." }],
          isError: true,
          details: {} as Record<string, unknown>,
        };
      }
      const queryList = rawQueries.slice(0, caps.maxSearchQueries);
      const dropped = rawQueries.length - queryList.length;

      let results;
      try {
        // allSettled so one provider's throw (non-JSON body, missing key) cannot
        // discard the sibling queries' results.
        const settled = await Promise.allSettled(queryList.map((q) => searchWeb(q, signal)));
        results = settled.map((s, i) =>
          s.status === "fulfilled"
            ? s.value
            : { query: queryList[i], answer: "", results: [], error: errorMessage(s.reason) }
        );
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${errorMessage(err)}` }],
          isError: true,
          details: {} as Record<string, unknown>,
        };
      }

      const id = generateId();
      const data: StoredData = { id, type: "search", timestamp: Date.now(), queries: results };
      storeResult(id, data);
      persistResult(pi, data);

      const sections = results.map((r) => {
        if (r.error) return `## Query: "${r.query}"\n\nError: ${r.error}`;
        const sources =
          r.results.length > 0
            ? "\n\n**Sources:**\n" +
              r.results.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")
            : "";
        return `## Query: "${r.query}"\n\n${r.answer}${sources}`;
      });

      const body = truncate(sections.join("\n\n---\n\n"), caps.maxContentChars);
      const note = skippedNote(dropped, caps.maxSearchQueries, "query", "queries");
      return {
        content: [{ type: "text", text: `${body}${note}\n\n*responseId: ${id}*` }],
        details: { responseId: id, queryCount: results.length },
      };
    },
  });

  // ── fetch_content ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: "fetch_content",
    label: "Fetch Content",
    description:
      "Fetch one or more URLs and extract readable content as markdown. Supports regular web pages and PDFs. No API key required. Use urls (plural) for multiple URLs.",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
      urls: Type.Optional(
        Type.Array(Type.String(), { description: "Multiple URLs to fetch in parallel (max 3 at a time)" })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const urlList = params.urls ?? (params.url ? [params.url] : null);
      if (!urlList?.length) {
        return {
          content: [{ type: "text", text: "Error: provide either url or urls." }],
          isError: true,
          details: {} as Record<string, unknown>,
        };
      }

      let results;
      const dropped = urlList.length > caps.maxFetchUrls ? urlList.length - caps.maxFetchUrls : 0;
      try {
        results = await fetchAllContent(urlList, signal, { allowPrivateNetwork }, caps.maxFetchUrls);
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${errorMessage(err)}` }],
          isError: true,
          details: {} as Record<string, unknown>,
        };
      }

      const id = generateId();
      const data: StoredData = { id, type: "fetch", timestamp: Date.now(), urls: results };
      storeResult(id, data);
      persistResult(pi, data);

      const sections = results.map((r) => {
        if (r.error) return `## ${r.url}\n\nError: ${r.error}`;
        const title = r.title ? `**${r.title}**\n\n` : "";
        return `## ${r.url}\n\n${title}${r.content}`;
      });

      const body = truncate(sections.join("\n\n---\n\n"), caps.maxContentChars);
      const note = skippedNote(dropped, caps.maxFetchUrls, "URL", "URLs");
      return {
        content: [{ type: "text", text: `${body}${note}\n\n*responseId: ${id}*` }],
        details: { responseId: id, urlCount: results.length },
      };
    },
  });

  // ── get_search_content ────────────────────────────────────────────────────

  pi.registerTool({
    name: "get_search_content",
    label: "Get Search Content",
    description:
      "Retrieve full stored content from a previous web_search or fetch_content call. Use when content was truncated in the original response.",
    parameters: Type.Object({
      responseId: Type.String({
        description: "The responseId returned by web_search or fetch_content",
      }),
      queryIndex: Type.Optional(
        Type.Number({ description: "Index of the query to retrieve (web_search, default: 0)" })
      ),
      urlIndex: Type.Optional(
        Type.Number({ description: "Index of the URL to retrieve (fetch_content, default: 0)" })
      ),
      url: Type.Optional(
        Type.String({ description: "Retrieve content for a specific URL (fetch_content)" })
      ),
      offset: Type.Optional(
        Type.Number({ description: "Character offset to continue a truncated retrieval" })
      ),
    }),
    async execute(_toolCallId, params) {
      const data = getResult(params.responseId);
      if (!data) {
        return {
          content: [
            {
              type: "text",
              text: `No stored content found for responseId: ${params.responseId}. Results expire after 1 hour or when a new session starts.`,
            },
          ],
          isError: true,
          details: {} as Record<string, unknown>,
        };
      }

      if (data.type === "search") {
        const idx = params.queryIndex ?? 0;
        const result = data.queries?.[idx];
        if (!result) {
          return {
            content: [
              {
                type: "text",
                text: `No query at index ${idx}. This response has ${data.queries?.length ?? 0} quer${data.queries?.length === 1 ? "y" : "ies"}.`,
              },
            ],
            isError: true,
            details: {} as Record<string, unknown>,
          };
        }
        const sources =
          result.results.length > 0
            ? "\n\n**Sources:**\n" +
              result.results.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")
            : "";
        const page = paginateContent(
          `## Query: "${result.query}"\n\n${result.answer}${sources}`,
          params.offset ?? 0,
          caps.maxRetrievalChars,
        );
        return {
          content: [{ type: "text", text: page.text + continuationNotice(page) }],
          details: { responseId: params.responseId },
        };
      }

      if (data.type === "fetch") {
        const result =
          params.url != null
            ? data.urls?.find((u) => u.url === params.url)
            : data.urls?.[params.urlIndex ?? 0];

        if (!result) {
          return {
            content: [
              {
                type: "text",
                text: `No URL found. This response has ${data.urls?.length ?? 0} URL(s).`,
              },
            ],
            isError: true,
            details: {} as Record<string, unknown>,
          };
        }
        if (result.error) {
          return {
            content: [{ type: "text", text: `Error fetching ${result.url}: ${result.error}` }],
            isError: true,
            details: {} as Record<string, unknown>,
          };
        }
        const title = result.title ? `**${result.title}**\n\n` : "";
        const page = paginateContent(
          `## ${result.url}\n\n${title}${result.content}`,
          params.offset ?? 0,
          caps.maxRetrievalChars,
        );
        return {
          content: [{ type: "text", text: page.text + continuationNotice(page) }],
          details: { responseId: params.responseId },
        };
      }

      return {
        content: [{ type: "text", text: "Unknown result type." }],
        isError: true,
        details: {},
      };
    },
  });
}
