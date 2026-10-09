import assert from "node:assert/strict";
import { test } from "bun:test";
import { createServer } from "node:http";
import { fetchAllContent } from "../extensions/opl-webaccess/extract.ts";

/**
 * Two loopback listeners: the first 302s to the second. Both hosts are names that do not exist in
 * DNS, so the only way a fetch can complete is by dialing the address the guard approved for each
 * hop - which also proves each hop got its own resolution and its own pin.
 */
function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const close = (server) => new Promise((resolve) => server.close(resolve));

test("every hop of a redirect chain is resolved and pinned separately", async () => {
  const hops = [];
  const second = await listen((req, res) => {
    hops.push(`final:${req.headers.host}`);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><h1>Arrived</h1><p>content of the second hop</p></body></html>");
  });
  const first = await listen((req, res) => {
    hops.push(`start:${req.headers.host}`);
    res.writeHead(302, { location: `http://hop-two.invalid.example:${second.address().port}/landed` });
    res.end();
  });
  const resolutions = [];
  const resolveHost = async (host) => {
    resolutions.push(host);
    return ["127.0.0.1"];
  };
  try {
    const [result] = await fetchAllContent([`http://hop-one.invalid.example:${first.address().port}/start`], undefined, {
      allowLoopback: true,
      resolveHost,
    });
    assert.equal(result.error, null, JSON.stringify(result));
    assert.match(result.content, /Arrived/, "the chain was followed to the second hop");
    assert.deepEqual(hops, [
      `start:hop-one.invalid.example:${first.address().port}`,
      `final:hop-two.invalid.example:${second.address().port}`,
    ], "the Host header of each hop is that hop's own name");
    assert.deepEqual(resolutions, ["hop-one.invalid.example", "hop-two.invalid.example"], "one resolution per hop, no reuse");
  } finally {
    await close(first);
    await close(second);
  }
});

test("a hop that resolves into blocked space is refused mid-chain", async () => {
  const second = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("should never be read");
  });
  const first = await listen((_req, res) => {
    res.writeHead(302, { location: `http://internal.invalid.example:${second.address().port}/admin` });
    res.end();
  });
  try {
    const [result] = await fetchAllContent([`http://public.invalid.example:${first.address().port}/`], undefined, {
      allowLoopback: true, // the first hop is a loopback listener; the second answers RFC1918
      allowPrivateNetwork: false,
      resolveHost: async (host) => (host === "internal.invalid.example" ? ["10.0.0.5"] : ["127.0.0.1"]),
    });
    assert.match(String(result.error), /Blocked network host "internal\.invalid\.example"/, JSON.stringify(result));
    assert.match(String(result.error), /10\.0\.0\.5/, "the refused address is named");
  } finally {
    await close(first);
    await close(second);
  }
});

test("the response byte cap is enforced against a live body", async () => {
  const server = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    for (let i = 0; i < 64; i++) res.write("x".repeat(1024));
    res.end();
  });
  try {
    const [result] = await fetchAllContent([`http://huge.invalid.example:${server.address().port}/`], undefined, {
      allowLoopback: true,
      resolveHost: async () => ["127.0.0.1"],
      maxResponseBytes: 4096,
    });
    assert.match(String(result.error), /4096 byte limit/, JSON.stringify(result));
  } finally {
    await close(server);
  }
});
