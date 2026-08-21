# opl-webaccess

Registers three model-callable tools for web research and content retrieval: `web_search`, `fetch_content`, and `get_search_content`. Results are returned as Markdown with source links where available and are persisted in the Pi session so truncated or earlier results can be retrieved later.

## Tools

### `web_search`

Searches one or more queries using the configured provider and returns a synthesized answer with citations. Provide either `query` or a non-empty `queries` array. Supported providers are `gemini`, `tavily`, `ddgs`, `searxng`, and `exa`; multiple queries run concurrently.

### `fetch_content`

Fetches one URL or a non-empty `urls` array, with at most three requests in flight. HTML is parsed with Readability and converted to Markdown; if Readability cannot extract an article, the full response is converted with Turndown. Plain text, Markdown, JSON, and other non-HTML responses are returned as-is. URLs or responses identified as PDF are passed to the PDF extractor.

### `get_search_content`

Retrieves stored results by the `responseId` returned from either other tool. Search results can be selected with `queryIndex`; fetched results with `urlIndex` or an exact `url`. Stored content is capped at 30,000 characters in the initial tool response and remains available for retrieval for one hour or until a new session starts.

## Configuration

Create `~/.pi/agent/configs/opl-webaccess.json` or copy [`configs/opl-webaccess.json`](../../configs/opl-webaccess.json). The selected top-level `provider` must name an entry under `providers`. Configuration is loaded when a search is made; changes do not require rebuilding the extension.

```json
{
  "provider": "searxng",
  "providers": {
    "gemini": {
      "apiKeyEnv": "GEMINI_API_KEY",
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "model": "gemini-3.5-flash-lite"
    },
    "tavily": {
      "apiKeyEnv": "TAVILY_API_KEY",
      "maxResults": 5
    },
    "ddgs": { "apiUrl": "http://localhost:8000", "maxResults": 12 },
    "searxng": { "instanceUrl": "http://localhost:8888", "maxResults": 12 },
    "exa": { "apiKeyEnv": "EXA_API_KEY", "maxResults": 5 }
  }
}
```

Provider-specific fields include `apiKeyEnv`, `apiUrl`, `baseUrl`, `model`, `maxResults`, `instanceUrl`, `categories`, `safeSearch`, `searchType`, and `includeSummary`. API keys are read from the named environment variable. Keep credentials out of tracked JSON and do not expose them through commands that print the environment. If the config is missing or invalid, built-in Gemini defaults are used. An unknown provider returns an error.

## Runtime dependencies

`node_modules/` is intentionally excluded. Install dependencies before using HTML or PDF extraction:

```bash
cd extensions/opl-webaccess
npm install
```

Required packages are `@mozilla/readability`, `linkedom`, `turndown`, and `unpdf`. The extension can register without them, but affected runtime calls fail with module-resolution errors. `unpdf` is loaded only when PDF extraction is requested.

## Operational limits

- Requests honor the tool abort signal; an aborted multi-URL fetch stops starting later batches.
- Failed HTTP requests and provider failures are returned as tool errors or per-result error text rather than throwing through the Pi tool boundary.
- Tool responses are truncated to the shared 30,000-character limit, with a response ID for retrieval.
- Smoke tests verify bundling with runtime dependencies externalized, not live credentials, network access, provider behavior, HTML extraction, or PDF extraction.
