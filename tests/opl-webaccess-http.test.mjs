import assert from "node:assert/strict";
import { test } from "bun:test";
import { createServer } from "node:http";
import { pinnedFetch, buildRequestOptions } from "../extensions/opl-webaccess/http.ts";
import { extractPdfBuffer } from "../extensions/opl-webaccess/pdf.ts";
import { fetchAllContent } from "../extensions/opl-webaccess/extract.ts";

// A complete one-page PDF with byte-correct stream lengths and cross references.
function pdfFixture() {
  const stream = "BT /F1 12 Tf 72 720 Td (PDF works) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

for (const kind of ["Buffer", "Uint8Array", "ArrayBuffer"]) {
  test(`extracts PDF text from ${kind}`, async () => {
    const bytes = pdfFixture();
    const input = kind === "Buffer" ? bytes : kind === "Uint8Array" ? new Uint8Array(bytes) : new Uint8Array(bytes).buffer;
    assert.equal(await extractPdfBuffer(input), "PDF works");
  });
}

test("fetch_content extracts PDF text through the pinned HTTP transport", async () => {
  const server = await serve(() => ({ headers: { "content-type": "application/pdf" }, body: pdfFixture() }));
  try {
    const url = `http://127.0.0.1:${server.address().port}/document.pdf`;
    const [result] = await fetchAllContent([url], undefined, { allowLoopback: true });
    assert.equal(result.error, null);
    assert.equal(result.content, "PDF works");
    assert.equal(result.url, url);
  } finally {
    await close(server);
  }
});

/** Listen on loopback with an ephemeral port and answer with a fixed behaviour. */
function serve(handler = () => null) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const decision = handler(req, res);
      if (decision === "hold") return; // leave the response open
      if (!decision) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("pong");
        return;
      }
      res.writeHead(decision.status ?? 200, decision.headers ?? {});
      res.end(decision.body ?? "pong");
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const close = (server) => new Promise((resolve) => server.close(resolve));
/** Stream a body in pieces with no content-length, the shape that defeats a declared-size check. */
function serveChunked(body) {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      const step = 512;
      for (let at = 0; at < body.length; at += step) res.write(body.slice(at, at + step));
      res.end();
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}


function target(url, addresses) {
  const parsed = new URL(url);
  return { url, host: parsed.hostname, addresses };
}

test("the socket goes to the pinned address, not to a fresh lookup", async () => {
  const server = await serve();
  try {
    const url = `http://pinned.invalid.example:${server.address().port}/x`;
    // The hostname does not exist in DNS at all: if the transport resolved it again, this is ENOTFOUND.
    const res = await pinnedFetch(target(url, ["127.0.0.1"]), {});
    assert.equal(res.status, 200);
    assert.equal(res.text(), "pong");
  } finally {
    await close(server);
  }
});

test("the Host header keeps the requested hostname and port", async () => {
  const seen = [];
  const server = await serve((req) => {
    seen.push(req.headers.host);
    return null;
  });
  try {
    const port = server.address().port;
    const url = `http://virtual.example:${port}/`;
    await pinnedFetch(target(url, ["127.0.0.1"]), {});
    assert.deepEqual(seen, [`virtual.example:${port}`], "virtual hosting keeps working when the address is pinned");
  } finally {
    await close(server);
  }
});

test("a refused connection names the address the guard approved", async () => {
  const server = await serve();
  const port = server.address().port;
  await close(server); // nothing listens any more
  await assert.rejects(
    () => pinnedFetch(target(`http://gone.example:${port}/`, ["127.0.0.1"]), {}),
    (err) => {
      assert.equal(err.code, "ECONNREFUSED");
      assert.match(String(err.message), /127\.0\.0\.1/, "triage needs the pinned address in the error");
      return true;
    },
  );
});

test("the response body is capped, not read whole", async () => {
  const body = "a".repeat(8192);
  const server = await serve(() => ({ status: 200, body }));
  try {
    const url = `http://big.example:${server.address().port}/`;
    await assert.rejects(
      () => pinnedFetch(target(url, ["127.0.0.1"]), { maxResponseBytes: 1024 }),
      /1024 byte limit/,
      "the declared content-length is enough to refuse early",
    );
    const stream = await serveChunked("b".repeat(4096));
    try {
      const surl = `http://chunked.example:${stream.address().port}/`;
      await assert.rejects(
        () => pinnedFetch(target(surl, ["127.0.0.1"]), { maxResponseBytes: 1024 }),
        /1024 byte limit/,
        "a body with no content-length is cut off while streaming",
      );
    } finally {
      await close(stream);
    }
    const ok = await pinnedFetch(target(url, ["127.0.0.1"]), { maxResponseBytes: 65536 });
    assert.equal(ok.body.length, body.length, "under the cap the whole body arrives");
  } finally {
    await close(server);
  }
});

test("redirects are returned, never followed", async () => {
  const server = await serve(() => ({ status: 302, headers: { location: "http://elsewhere.example/x" }, body: "" }));
  try {
    const res = await pinnedFetch(target(`http://hop.example:${server.address().port}/`, ["127.0.0.1"]), {});
    assert.equal(res.status, 302);
    assert.equal(res.ok, false);
    assert.equal(res.headers.get("location"), "http://elsewhere.example/x");
  } finally {
    await close(server);
  }
});

test("an aborted caller ends the request instead of hanging", async () => {
  const server = await serve(() => "hold");
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 15);
    await assert.rejects(
      () =>
        pinnedFetch(target(`http://slow.example:${server.address().port}/`, ["127.0.0.1"]), {
          signal: controller.signal,
        }),
      (err) => err.name === "AbortError" || /abort/i.test(String(err.message)),
    );
  } finally {
    await close(server);
  }
});

test("a stalled response hits the deadline", async () => {
  const server = await serve(() => "hold");
  try {
    await assert.rejects(
      () =>
        pinnedFetch(target(`http://stall.example:${server.address().port}/`, ["127.0.0.1"]), {
          timeoutMs: 60,
        }),
      /timed out|timeout/i,
    );
  } finally {
    await close(server);
  }
});

test("the request keeps the hostname for TLS identity and pins only the address", () => {
  const options = buildRequestOptions(target("https://shop.example/cart?id=7", ["93.184.216.34"]), {});
  assert.equal(options.servername, "shop.example", "certificate validation is against the name, not the IP");
  assert.equal(options.hostname, "shop.example", "the name drives TLS and Host");
  assert.equal(options.path, "/cart?id=7");
  assert.equal(options.headers.host, "shop.example");
  assert.equal(typeof options.lookup, "function", "the address set is the only thing the socket may use");
  assert.equal(options.agent.keepAlive, false, "no pooling, so a socket cannot outlive this hop's pin");
});

test("the pinned resolver answers from the validated set and never reaches DNS", async () => {
  const lookup = buildRequestOptions(target("https://multi.example/", ["93.184.216.34", "::1"]), {}).lookup;
  const v4 = await new Promise((resolve, reject) =>
    lookup("multi.example", { all: true, verbatim: true }, (err, hits) => (err ? reject(err) : resolve(hits))),
  );
  assert.deepEqual(v4.map((hit) => hit.address), ["93.184.216.34", "::1"]);
  assert.deepEqual(v4.map((hit) => hit.family), [4, 6], "node needs the family alongside each answer");
  const single = await new Promise((resolve, reject) =>
    lookup("multi.example", {}, (err, hit) => (err ? reject(err) : resolve(hit))),
  );
  assert.equal(single, "93.184.216.34", "the default shape returns one address, family-consistent");
  assert.equal(typeof single, "string");
});
