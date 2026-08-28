# opl-webaccess

Provides configurable web search and readable URL/PDF retrieval with session-backed result recovery.

## Commands, flags, and shortcuts

- Tools: `web_search`, `fetch_content`, and `get_search_content`.
- `web_search` accepts `query` or parallel `queries`.
- `fetch_content` accepts `url` or `urls` with at most three requests in flight.
- `get_search_content` uses a prior `responseId`, with `queryIndex`, `urlIndex`, or exact `url` selection.
- No slash commands or shortcuts.

## Extension features

- Searches through `gemini`, `tavily`, `ddgs`, `searxng`, or `exa`; multiple queries run concurrently and results include citations where available.
- Extracts HTML with Readability and Markdown conversion, falls back to full-document Turndown conversion, passes PDF responses to the PDF extractor, and returns plain text, Markdown, and JSON directly.
- Caps initial tool output at 30,000 characters, then keeps it for retrieval for one hour or until the session ends.
- Honors abort signals and returns provider, HTTP, and per-result failures through the tool boundary rather than throwing.

## Configuration

Copy [`configs/opl-webaccess.json.sample`](../../configs/opl-webaccess.json.sample) to `~/.pi/agent/configs/opl-webaccess.json`. The top-level `provider` must name an entry in `providers`; configuration is loaded when search runs.

```json
{
  "provider": "searxng",
  "providers": {
    "searxng": { "instanceUrl": "http://localhost:8888", "maxResults": 12 },
    "tavily": { "apiKeyEnv": "TAVILY_API_KEY", "maxResults": 5 }
  }
}
```

Provider fields include `apiKeyEnv`, `apiUrl`, `baseUrl`, `model`, `maxResults`, `instanceUrl`, `categories`, `safeSearch`, `searchType`, and `includeSummary`. API keys are read only from named environment variables. Missing or invalid config falls back to Gemini defaults; an unknown provider returns an error.

Install extraction dependencies before use:

```bash
cd extensions/opl-webaccess
npm install
```

`@mozilla/readability`, `linkedom`, `turndown`, and `unpdf` are runtime dependencies. The extension registers without them, but affected calls fail until installed; `unpdf` loads only for PDFs.

## Architecture

`index.ts` registers the tools and session storage. Provider adapters live under `providers/`; `search.ts` dispatches search, `extract.ts` converts readable content, `pdf.ts` handles PDFs, and stored response data backs `get_search_content`. Smoke tests bundle with these runtime dependencies externalized; they do not exercise credentials, network, extraction, or PDF behavior.
