# opl-webaccess

Provides configurable web search and readable URL/PDF retrieval with session-backed result recovery.

## Commands, flags, and shortcuts

- Tools: `web_search`, `fetch_content`, and `get_search_content`.
- `web_search` accepts `query` or parallel `queries` (at most 10 per call).
- `fetch_content` accepts `url` or `urls` (at most 20 per call) with at most three requests in flight.
- `get_search_content` uses a prior `responseId`, with `queryIndex`, `urlIndex`, or exact `url` selection. It returns one bounded page; pass `offset` to continue a truncated retrieval.
- No slash commands or shortcuts.

## Extension features

- Searches through `gemini`, `tavily`, `ddgs`, `searxng`, or `exa`; multiple queries run concurrently and results include citations where available.
- Extracts HTML with Readability and Markdown conversion, falls back to full-document Turndown conversion, normalizes PDF response buffers to plain `Uint8Array` input for text extraction, and returns plain text, Markdown, and JSON directly.
- Restricts `fetch_content` to http/https and applies its host policy to **resolved addresses**: a URL is rejected when any DNS answer for its hostname falls in blocked space, not merely when the hostname is written as an internal literal. Private/link-local/reserved answers are blocked by default (`allowPrivateNetwork` to opt in), loopback answers are refused unless `allowLoopback: true` opts in, and cloud-metadata and unspecified addresses (`0.0.0.0/8`, `::`) are always blocked. Every redirect hop is re-validated and re-resolved, so a public first hop cannot bounce into internal space. Caps each response at 10 MB and applies a 30s timeout; the DNS round-trip is bounded by the same signal, and concurrent lookups for one host share a single query. Gemini keys are sent via the `x-goog-api-key` header rather than the query string. The addresses that pass are the ones the socket dials, so a short-TTL record cannot answer one address for the check and another for the connection.
- Caps initial tool output at a configurable length (default 30,000 characters) and keeps results retrievable for one hour (expiry is enforced on read, not just on write) or until the session ends.
- Keeps the full body **out of the session transcript**: each result spills to `<agent dir>/web-access-cache/<responseId>.json` (the directory pi itself uses, so a relocated `PI_CODING_AGENT_DIR` moves it) and the session entry stores a bounded preview (512 bytes per answer or URL content, marked `truncated`) plus the file path. Reads rehydrate from disk; if the spill file is gone or expired, the preview is returned with a note to re-fetch rather than a silent stub. The cache is pruned by age, then oldest-first past a 32 MB ceiling.
- Pages `get_search_content` results (default 30,000 characters per page) with `offset` continuation, so a model never loads the whole stored body in one call.
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

Provider fields include `apiKeyEnv`, `apiUrl`, `baseUrl`, `model`, `maxResults`, `instanceUrl`, `categories`, `safeSearch`, `searchType`, and `includeSummary`. API keys are read only from named environment variables. Malformed config falls back to Gemini defaults - a non-object config, a non-string `provider`, a non-object `providers` map, or non-positive cap values (`maxContentChars`/`maxRetrievalChars`) are all treated as unset; an unknown provider returns an error.

Optional top-level caps control how much content reaches the model:

| Field | Default | Meaning |
|---|---|---|
| `maxContentChars` | `30000` | Cap on the initial `web_search`/`fetch_content` body. |
| `maxRetrievalChars` | `30000` | Cap on one `get_search_content` page. Pass `offset` to continue. |
| `maxSearchQueries` | `10` | Cap on how many queries one `web_search` call runs. Excess queries are skipped and reported. |
| `maxFetchUrls` | `20` | Cap on how many URLs one `fetch_content` call fetches. Excess URLs are skipped and reported. |
| `timeoutMs` | `30000` | Deadline for one provider search or URL fetch, composed with the caller's abort signal. A slow provider fails as its own error instead of hanging the tool. |
| `maxResponseBytes` | `10485760` | Ceiling on one fetched response body. The transport stops reading and drops the socket past it, so an oversized page cannot cost memory before `maxContentChars` truncates the text. |
| `allowPrivateNetwork` | `false` | Allow `fetch_content` to reach private/link-local ranges, literal or resolved (cloud metadata is always blocked). Provider API endpoints (e.g. `ddgs.apiUrl`, `searxng.instanceUrl`) are excluded from this guard. |
| `allowLoopback` | `false` | Allow `fetch_content` to reach loopback — `localhost`, `127.0.0.0/8`, `::1`, literal or resolved. Set `true` to fetch from a local dev server; metadata and private ranges are unaffected by this key. |

Install extraction dependencies before use:

```bash
cd extensions/opl-webaccess
npm install
```

`@mozilla/readability`, `linkedom`, `turndown`, and `unpdf` are runtime dependencies. The extension registers without them, but affected calls fail until installed; `unpdf` loads only for PDFs.

### Network policy

`fetch_content` classifies the address it is about to contact, not the text in the URL:

1. Scheme, userinfo and literal-host checks (`assertHttpUrl`).
2. For a non-literal hostname, `node:dns` `lookup(host, { all: true, verbatim: true })`, then the same classifier over **every** answer. One internal answer among many public ones rejects.
3. The addresses that passed are handed to the transport, which dials them through a pinned `lookup` (`http.ts`). Nothing in the connection path resolves the name again.
4. Each redirect hop re-enters at step 2 with the new hostname — re-resolved and re-pinned, with no reuse across hops and no cache between calls.
5. `Host` and TLS `servername` keep the hostname, so virtual hosting and certificate validation behave as they would unpinned. Sockets are never pooled, so a connection made under one hop's answer cannot carry a later request.

Compressed and fully expanded IPv6 forms share the same policy, including DNS answers. NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`), mapped and IPv4-compatible addresses are classified by their embedded IPv4. The entire local-use translation prefix `64:ff9b:1::/48` is always blocked, regardless of `allowPrivateNetwork` or `allowLoopback`; this also blocks translations of public IPv4 addresses within that prefix.

A resolver failure rejects the fetch (fail closed): unlike a browser's subresources, this URL was named by the model, so a host that does not resolve is an error to report rather than a request to wave through. The lookup honors the caller's abort signal and the 30s fetch budget.

Residuals, deliberately left open:

- **Operator endpoints are not pinned.** Provider API endpoints (`ddgs.apiUrl`, `searxng.instanceUrl`) are chosen by you, not by the model, so they stay reachable on private or loopback hosts and go through the ordinary client.
- **A response body can describe internal services.** The guard decides where the tool connects, not what the text says.
- **`opl-browser` cannot pin.** Chromium resolves names internally and no Playwright API exposes a per-connection resolver; see its README. This pin covers `fetch_content`, not page traffic.

## Architecture

`index.ts` registers the tools and session storage. Provider adapters live under `providers/`; `search.ts` dispatches search, `http.ts` owns the pinned transport (one request per hop, body cap enforced while reading), `extract.ts` converts readable content, `pdf.ts` handles PDFs, and stored response data backs `get_search_content`. `utils.ts` exports `resolveSafeHostUrl`, the only place a policy decision produces the address set a socket may use; `assertSafeHttpUrl` is the string-only wrapper for callers that never connect. Smoke tests bundle with these runtime dependencies externalized; they do not exercise credentials, network, extraction, or PDF behavior.
