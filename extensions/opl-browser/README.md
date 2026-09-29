# opl-browser

Chromium browser automation for pi via [Playwright](https://playwright.dev). One
LLM-callable dispatcher tool covers navigation, accessibility snapshots, element
interaction, console/network capture, script evaluation, and screenshots —
enough to replace the `chrome-devtools` MCP server without running a separate
process.

## Commands, flags, and shortcuts

No slash commands. The extension registers a single tool, `browser`, chosen by an
`action` parameter:

```ts
browser({ action: "navigate", url: "https://example.com" })
browser({ action: "snapshot" })
browser({ action: "extract" })                          // rendered-page markdown
browser({ action: "extract", selector: "#about-gcash" }) // one element, verbatim
browser({ action: "click", selector: "button.login" })
browser({ action: "fill", selector: "#email", text: "a@b.com" })
browser({ action: "evaluate", script: "document.title" })
browser({ action: "console" })
browser({ action: "network" })
browser({ action: "screenshot", path: "shot.png", fullPage: true })
browser({ action: "get", responseId: "br-..." })   // retrieve a stored large result
browser({ action: "close" })
```

Full action set: `navigate` (url, or `back`/`forward`/`reload`), `snapshot`,
`extract`, `screenshot`, `click`, `fill`, `hover`, `press`, `select`, `evaluate`,
`console`, `network`, `wait_for`, `pages`, `new_page`, `select_page`, `close_page`,
`resize`, `get`, `close`.

## Extension features

- **Single dispatcher tool.** One compact schema in the system prompt instead of
  ~29 per-tool schemas. Keeps the cached prefix small.
- **Handle + preview output.** Large results (snapshots, console/network logs,
  evaluate output) are kept out of context: the tool returns a truncated preview
  plus a `responseId`; call `action: "get"` with that id to page through the full
  text (`getChars` per page, pass `offset` to continue). Screenshots are written to
  a file, never inlined as base64.
- **Structured extraction.** `extract` runs Readability + Turndown over the
  *rendered* (post-JS) DOM — the complement to `opl-webaccess`'s `fetch_content`,
  which only sees raw HTTP HTML. Static pages: `fetch_content`; rendered or
  interacted-with pages: `browser:extract`. With a `selector`, the matched element
  is converted verbatim (no article detection): Readability's candidate scoring is
  a whole-document heuristic and mispicks inside small subtrees.
- **Real Chromium via Playwright.** Navigation with `domcontentloaded` waits,
  CSS-selector interaction, viewport control, multi-page management.
- **Scheme + path guards.** `navigate`/`new_page` accept http(s) only; `file:`,
  `data:`, and `javascript:` are rejected, private-range and link-local hosts are
  blocked by default, and cloud-metadata endpoints are always blocked (SSRF guard).
  Loopback (`localhost`/`127.0.0.0/8`/`::1`) is allowed by default for local
  development; set `allowPrivateNetwork: true` for private ranges. Redirect targets
  are re-checked on the final URL. Screenshot paths must use `.png`/`.jpg`, stay
  inside the project directory, and are refused when the file already exists, so a
  bad action cannot overwrite or plant arbitrary files.
- **Per-page capture.** Console messages and network requests are buffered per
  page as they occur; `console` and `network` actions return the active page's
  buffer.
- **One reused browser per session.** Launched on first use, closed automatically
  on `session_shutdown`, or on demand via `action: "close"`.

## Configuration

Optional `~/.pi/agent/configs/opl-browser.json` (see `opl-browser.json.sample`):

| Field | Default | Meaning |
|---|---|---|
| `headless` | `true` | Run Chromium headless. Set `false` to watch. |
| `width` / `height` | `1280` / `800` | Initial viewport. |
| `navigationTimeoutMs` | `30000` | Default navigation and `wait_for` timeout. |
| `previewChars` | `4000` | Inline threshold; larger outputs are stored and previewed. |
| `getChars` | `30000` | Characters returned by one `action: "get"` page. |
| `allowPrivateNetwork` | `false` | Allow `navigate`/`new_page` to reach private/link-local ranges (loopback is always allowed; cloud metadata is always blocked). |

### Dependencies

Playwright is a real third-party dependency, so install it in the extension
directory and download the Chromium binary once:

```bash
cd extensions/opl-browser
npm install
npx playwright install chromium
```

## Architecture

```text
index.ts     Pi wiring: registers the single `browser` tool, TTL result store,
             preview/handle logic, and session_shutdown cleanup.
browser.ts   Playwright driver: browser/context/page lifecycle, per-page console
             and network buffers, and the action switch. Tool calls are serialized
             on the single shared context.
validate.ts  URL/path guards: http/https-only navigation, screenshot path confined
             to the project directory.
paging.ts    Bounded `get` pagination and continuation metadata.
extract.ts   Pure rendered-HTML → markdown pipeline (linkedom + Readability +
             turndown), duplicated from opl-webaccess to keep installs independent.
config.ts    DEFAULT_CONFIG + loadUserConfig (user overrides win via ??).
```

Interaction is CSS-selector based. Snapshot-uid interaction (referencing elements
by ids returned from `snapshot`) is intentionally not implemented; use CSS
selectors, which are simpler and robust. The in-memory result store expires
entries after one hour or when the browser is closed; expiry is checked on read,
not only when another result is stored, so an idle entry past its TTL is never
served.
