# opl-browser

Chromium browser automation for pi via [Playwright](https://playwright.dev). One LLM-callable dispatcher tool covers navigation, accessibility snapshots, element interaction, console/network capture, script evaluation, and screenshots — enough to replace the `chrome-devtools` MCP server without running a separate process.

## Commands, flags, and shortcuts

No slash commands. The extension registers a single tool, `browser`, chosen by an `action` parameter:

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

Full action set: `navigate` (url, or `back`/`forward`/`reload`), `snapshot`, `extract`, `screenshot`, `click`, `fill`, `hover`, `press`, `select`, `evaluate`, `console`, `network`, `wait_for`, `pages`, `new_page`, `select_page`, `close_page`, `resize`, `get`, `close`.

## Extension features

- **Single dispatcher tool.** One compact schema in the system prompt instead of ~29 per-tool schemas. Keeps the cached prefix small.
- **Handle + preview output.** Large results (snapshots, console/network logs, evaluate output) are kept out of context: the tool returns a truncated preview plus a `responseId`; call `action: "get"` with that id to page through the full text (`getChars` per page, pass `offset` to continue). Screenshots are written to a file, never inlined as base64.
- **Structured extraction.** `extract` runs Readability + Turndown over the *rendered* (post-JS) DOM — the complement to `opl-webaccess`'s `fetch_content`, which only sees raw HTTP HTML. Static pages: `fetch_content`; rendered or interacted-with pages: `browser:extract`. With a `selector`, the matched element is converted verbatim (no article detection): Readability's candidate scoring is a whole-document heuristic and mispicks inside small subtrees. A selector that matches multiple elements returns a clear error instead of a strict-mode crash, and a selector with no match reports `(no elements match ...)`.
- **Real Chromium via Playwright.** Navigation with `domcontentloaded` waits, CSS-selector interaction, viewport control, multi-page management.
- **Scheme + host guards, applied to the whole page.** `navigate`/`new_page` accept http(s)
  only; `file:`, `data:`, and `javascript:` are rejected. The policy is judged on **resolved
  addresses**, not on the URL text, and enforced wherever a page can reach the network:
  - **Navigation** — the requested URL, plus every live frame URL after the load.
  - **Page requests** — a context route blocks subresources, script-driven fetches, JS/meta
    redirects and popups (`net::ERR_BLOCKED_BY_CLIENT`), not only the URL the tool was given.
  - **Page WebSockets** — `ws://`/`wss://` handshakes are classified as if they were
    `http://`/`https://` and closed before they reach the target.
  - **Redirect landings** — Playwright sees only the first URL of a redirect chain, so a page or
    iframe that a redirect lands on a blocked host is sent back to `about:blank` before any
    action can read it.
  - **Service workers** — blocked on new contexts: routing does not see requests a worker has
    already intercepted.
  - **Toggles** — `allowPrivateNetwork` (default `false`) governs private/link-local/reserved,
    `allowLoopback` (default `false`) governs `localhost`, `127.0.0.0/8` and `::1` — set it to `true`
    when the browser must reach a local dev server. Cloud metadata and unspecified addresses
    (`0.0.0.0/8`, `::`) are refused whatever they say.
  - **Fail closed** — if a build cannot install either handler, the tool refuses to browse
    instead of browsing half-guarded.

  See [Network policy](#network-policy) for what this still cannot cover: DNS rebinding (the
  `opl-webaccess` fetch path pins its socket; browsing cannot), blind redirect side effects, and
  `evaluate` returning page-held data.
- **Screenshots are contained and reserved.** The target must use `.png`/`.jpg` and stay inside
  the **session directory** (`ExtensionContext.cwd`, never the directory the harness was started
  in). Containment is checked on the real path: every symlink in the existing part of the path is
  followed first, so a `shots -> ~/.pi` entry inside the project cannot carry the write out of it,
  and a symlink standing at the target is refused like any other existing file instead of being
  followed onto whatever it points at. Then the file is created with `wx`, so "refuse to overwrite"
  and "hand this path to Playwright" are one atomic operation rather than a check-then-write race.
  The action returns the resolved absolute path, and a capture that throws leaves no empty file
  behind.
- **Pages are addressed, not guessed.** Any page-scoped action accepts `index`; without it the
  selected page is used. A stale selection is an error that names the page count, never a silent
  retarget to the last page - so `close_page` cannot make a later `screenshot` or `navigate` act on
  a different document than the model meant. `new_page` selects the page it actually created, and
  `close_page` keeps the same page selected when what closed was a different one (stepping to the
  nearest survivor when the selected page itself closes).
- **Per-page capture.** Console messages and network requests are buffered per page as they occur; `console` and `network` actions return the target page's buffer, capped at the most recent `200` entries per page so an active long-running page cannot grow the buffer without bound. `navigate: back`/ `forward` on a fresh session reports `(no history to go back/forward)` instead of silently returning the unchanged page.
- **One reused browser per session.** Launched on first use, closed automatically on `session_shutdown`, or on demand via `action: "close"`.

## Configuration

Optional `~/.pi/agent/configs/opl-browser.json` (see `opl-browser.json.sample`):

| Field | Default | Meaning |
|---|---|---|
| `headless` | `true` | Run Chromium headless. Set `false` to watch. |
| `width` / `height` | `1280` / `800` | Initial viewport. |
| `navigationTimeoutMs` | `30000` | Default navigation and `wait_for` timeout. |
| `previewChars` | `4000` | Inline threshold; larger outputs are stored and previewed. |
| `getChars` | `30000` | Characters returned by one `action: "get"` page. |
| `allowPrivateNetwork` | `false` | Allow `navigate`/`new_page` and page requests to reach private/link-local ranges, literal or resolved (cloud metadata and unspecified addresses are always blocked). |
| `allowLoopback` | `false` | Allow loopback — `localhost`, `127.0.0.0/8`, `::1`, literal or resolved — for navigations, page requests and page WebSockets. Set `true` when the browser must reach a local dev server; `0.0.0.0/8` and `::` stay blocked either way, because they reach local listeners too. |

### Network policy

The guard runs at three points, and each one answers a different question:

| Point | What it covers | Behaviour on a blocked host |
|---|---|---|
| Navigation (`navigate`, `new_page`) | the URL the model asked for, plus every live frame URL after the load | refuses before connecting; clears the page to `about:blank` if a redirect already landed it on a blocked host |
| Context route | every request the page itself makes: subresources, script fetches, JS/meta redirects, popups | `net::ERR_BLOCKED_BY_CLIENT` |
| WebSocket route | `ws://` / `wss://` handshakes from page code, classified as if they were `http://` / `https://` | socket closed before it reaches the target |

Hosts are classified after resolution, not from the URL text, so `http://169.254.169.254.nip.io/` is refused the same way the literal is. Cloud-metadata and unspecified addresses (`0.0.0.0/8`, `::`) are refused whatever the toggles say, because reaching them means reaching local listeners or instance credentials. IPv6 literals that carry an IPv4 inside them — NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`), mapped (`::ffff:`) and the deprecated IPv4-compatible form — are classified by the embedded address, so `[64:ff9b::a9fe:a9fe]` cannot stand in for the metadata endpoint; a DNS64 answer for a real public site still passes. Service workers are blocked: Playwright routing does not see requests a worker has already intercepted, so a worker would be a hole rather than a client.

Compressed and fully expanded IPv6 forms share the same policy, including DNS answers. The entire local-use translation prefix `64:ff9b:1::/48` is always blocked, regardless of `allowPrivateNetwork` or `allowLoopback`; this also blocks translations of public IPv4 addresses within that prefix. Public translations under the well-known `64:ff9b::/96` prefix remain permitted.

What is **not** covered, and the reason:

- **DNS rebinding.** Validation resolves, then Playwright connects with its own lookup. An attacker who runs DNS for the hostname (TTL 0, alternating answers) can still land on an internal address. Closing this needs a filtering proxy the browser connects through: Chromium resolves names internally and no Playwright API exposes a per-connection resolver, so the pin `opl-webaccess` uses for `fetch_content` is not available here. It is a documented residual rather than a bug: the defaults (`allowPrivateNetwork: false`, `allowLoopback: false`) are what narrows what a rebound name can reach.
- **Blind side effects through redirects.** Playwright hands a route handler only the first URL of a redirect chain, and `<img>` or no-cors `fetch` results are not readable anyway, so those legs are not re-checked. The page-level result *is* cleared by the frame check above.
- **`ENOTFOUND` for page requests.** A hostname the resolver does not know is let through, because hosts a page references willy-nilly (telemetry that is blocked in the hosts file, ad domains) would otherwise break every page. Navigations and `opl-webaccess` fetches fail closed on the same error; only page-initiated subresources and WebSockets fail open, and only for that one code.
- **`evaluate` returns whatever the page holds.** That is the feature: a page that can read an internal endpoint from its own origin can also hand it to the model.

Loopback is opt-in. `allowLoopback: true` reopens `localhost`, `127.0.0.0/8` and `::1` for local development; left at the default, a model cannot drive a dev server, a Docker socket proxy or an IDaaS callback on your machine through the browser.

### Dependencies

Playwright is a real third-party dependency, so install it in the extension directory and download the Chromium binary once:

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
validate.ts  URL/path guards: http/https-only navigation with resolved-address host
             policy, page-request route decision, screenshot path confined
             to the project directory. The host guard region is mirrored verbatim from
             `opl-webaccess/utils.ts` (extensions install per directory, so it cannot be
             a shared import); `tests/net-guard-parity.test.mjs` fails if the two drift.
paging.ts    Bounded `get` pagination and continuation metadata.
extract.ts   Pure rendered-HTML → markdown pipeline (linkedom + Readability +
             turndown), duplicated from opl-webaccess to keep installs independent.
config.ts    DEFAULT_CONFIG + loadUserConfig (user overrides win via ??).
```

Interaction is CSS-selector based. Snapshot-uid interaction (referencing elements by ids returned from `snapshot`) is intentionally not implemented; use CSS selectors, which are simpler and robust. The in-memory result store expires entries after one hour or when the browser is closed; expiry is checked on read, not only when another result is stored, so an idle entry past its TTL is never served.
