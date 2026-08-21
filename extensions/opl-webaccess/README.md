# opl-webaccess

Web search and content extraction for Pi. Search providers, readable web pages, and PDFs are exposed as model-callable tools.

## Features

- `web_search`: query Gemini, Tavily, DDGS, SearXNG, or Exa according to `opl-webaccess.json`.
- `fetch_content`: fetch HTML, plain text, Markdown, JSON, or PDFs and return readable Markdown.
- `get_search_content`: retrieve stored results by response ID after an initial response is truncated.
- Multiple URLs or queries are processed in batches of up to three concurrent requests.
- Search and fetch results are persisted for the session and restored on session start.

## Configuration

Create `~/.pi/agent/configs/opl-webaccess.json` or copy [`configs/opl-webaccess.json`](../../configs/opl-webaccess.json). Set `provider` to one key in `providers`; the selected provider supplies the settings used by `web_search`.

```json
{
  "provider": "searxng",
  "providers": {
    "searxng": {
      "instanceUrl": "http://localhost:8888",
      "maxResults": 12,
      "categories": "general",
      "safeSearch": 0
    },
    "tavily": {
      "apiKeyEnv": "TAVILY_API_KEY",
      "maxResults": 5
    }
  }
}
```

Provider options include `apiKeyEnv`, `apiUrl`, `baseUrl`, `model`, `maxResults`, `instanceUrl`, `categories`, `safeSearch`, `searchType`, and `includeSummary`, depending on the provider. API keys are read from the named environment variable. Keep credentials in the environment or an ignored `.env` file, never in tracked JSON. If the file is missing or invalid, the built-in Gemini defaults are used.

## Runtime dependencies

`node_modules/` is intentionally excluded from this repository. Install the declared runtime dependencies before using the extension:

```bash
cd extensions/opl-webaccess
npm install
```

The required packages are `@mozilla/readability`, `linkedom`, `turndown`, and `unpdf`. Without them, the extension may register successfully but affected `fetch_content` calls fail at runtime with module resolution errors. `unpdf` is dynamically imported only when PDF extraction is requested.

## Verification

After installation, check the regular extraction dependencies and PDF dependency:

```bash
node -e "require('@mozilla/readability'); require('linkedom'); require('turndown'); console.log('ok')"
node -e "import('unpdf').then(() => console.log('unpdf ok'))"
```

For a bundle smoke test, mark Pi runtime packages and the dynamic/runtime web packages external:

```bash
bun build extensions/opl-webaccess/index.ts --bundle --platform=node \
  --external '@earendil-works/pi-coding-agent' \
  --external '@earendil-works/pi-tui' \
  --external '@earendil-works/pi-ai' \
  --external typebox \
  --external turndown \
  --external linkedom \
  --external '@mozilla/readability' \
  --external unpdf \
  --outfile=/tmp/opl-webaccess.js
```

A successful run reports a bundle without unresolved imports. This verifies module resolution and bundling only; a real Pi session is still needed to verify provider credentials, network access, and PDF extraction.
