import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import * as webGuard from "../extensions/opl-webaccess/utils.ts";
import * as browserGuard from "../extensions/opl-browser/validate.ts";

const networkOptions = [
  {},
  { allowPrivateNetwork: true },
  { allowLoopback: true },
  { allowPrivateNetwork: true, allowLoopback: true },
];

for (const [name, guard] of [["webaccess", webGuard], ["browser", browserGuard]]) {
  test(`${name}: expanded and compressed embedded IPv4 have identical policy`, async () => {
    const cases = [
      ["2002:7f00:1::", "2002:7f00:1:1:1:1:1:1", "loopback"],
      ["2002:a00:1::", "2002:a00:1:1:1:1:1:1", "private"],
      ["2002:a9fe:a9fe::", "2002:a9fe:a9fe:1:1:1:1:1", "always"],
      ["2002:0:1::", "2002:0:1:1:1:1:1:1", "always"],
      ["2002::1", "2002:0:0:1:1:1:1:1", "always"],
      ["64:ff9b::a9fe:a9fe", "64:ff9b:0:0:0:0:a9fe:a9fe", "always"],
      ["::ffff:127.0.0.1", "0:0:0:0:0:ffff:127.0.0.1", "loopback"],
      ["::a9fe:a9fe", "0:0:0:0:0:0:a9fe:a9fe", "always"],
    ];
    for (const [compressed, expanded, policy] of cases) {
      for (const address of [compressed, expanded]) {
        for (const options of networkOptions) {
          const allowed = policy === "loopback" ? options.allowLoopback === true : policy === "private" && options.allowPrivateNetwork === true;
          const url = `http://[${address}]/`;
          const resolve = () => guard.assertSafeHttpUrl("http://answer.test/", { ...options, resolveHost: async () => [address] });
          if (allowed) {
            assert.equal(guard.assertHttpUrl(url, options), new URL(url).href);
            assert.equal(await resolve(), "http://answer.test/");
          } else {
            assert.throws(() => guard.assertHttpUrl(url, options), /Blocked network host/, address);
            await assert.rejects(resolve, /Blocked network host/, address);
          }
        }
      }
    }
  });

  test(`${name}: the whole local-use translation prefix is never toggleable`, async () => {
    const addresses = [
      "64:ff9b:1::", "64:ff9b:1::5d96:98b6",
      "64:ff9b:1:a9fe:a9:fe00::", "64:ff9b:1:0:a9:fea9:fe00:0",
      "0064:FF9B:0001:ffff:ffff:ffff:ffff:ffff",
      "64:ff9b:1::93.150.152.182",
    ];
    for (const address of addresses) {
      for (const options of networkOptions) {
        assert.throws(() => guard.assertHttpUrl(`http://[${address}]/`, options), /Blocked network host/, address);
        await assert.rejects(() => guard.assertSafeHttpUrl("http://mixed.test/", {
          ...options, resolveHost: async () => ["93.150.152.182", address],
        }), /Blocked network host/, address);
      }
    }
  });

  test(`${name}: native IPv6 special addresses are classified numerically`, async () => {
    for (const options of networkOptions) {
      for (const address of ["0:0:0:0:0:0:0:0", "fd00:ec2:0:0:0:0:0:254"]) {
        await assert.rejects(() => guard.assertSafeHttpUrl("http://answer.test/", {
          ...options, resolveHost: async () => [address],
        }), /Blocked network host/, address);
      }
      const resolve = () => guard.assertSafeHttpUrl("http://answer.test/", {
        ...options, resolveHost: async () => ["0:0:0:0:0:0:0:1"],
      });
      if (options.allowLoopback) assert.equal(await resolve(), "http://answer.test/");
      else await assert.rejects(resolve, /Blocked network host/);
    }
  });

  test(`${name}: public IPv6 and supported public translations remain permitted`, async () => {
    for (const address of ["2606:4700:4700::1111", "2606:4700:4700:1:1:1:1:1111", "64:ff9b::5d96:98b6", "64:ff9b:0:0:0:0:5d96:98b6", "2002:5d96:98b6:1:1:1:1:1", "64:ff9b:2::1"]) {
      assert.equal(guard.assertHttpUrl(`http://[${address}]/`), new URL(`http://[${address}]/`).href);
      assert.equal(await guard.assertSafeHttpUrl("http://answer.test/", { resolveHost: async () => [address] }), "http://answer.test/");
    }
  });
}

// The host guard is deliberately duplicated: install.sh installs one extension directory at
// a time, so opl-browser cannot import from opl-webaccess. This test is what keeps the two
// copies honest — it compares the marked region with comments and whitespace stripped.
function grab(rel, marker) {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  const m = src.match(new RegExp(`// BEGIN ${marker}[\\s\\S]*?// END ${marker}`));
  assert.ok(m, `${rel} must contain the ${marker} region`);
  return m[0]
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

test("the two SSRF guard copies have not drifted", () => {
  assert.equal(
    grab("../extensions/opl-webaccess/utils.ts", "SHARED HOST GUARD"),
    grab("../extensions/opl-browser/validate.ts", "SHARED HOST GUARD"),
    "host guard drifted between opl-webaccess and opl-browser — re-copy the region",
  );
});

// The git guard has the same duplication reason: opl-init and opl-footer are installed as
// separate directories and can neither share a module nor see each other's copy.
test("the two git guard copies have not drifted", () => {
  assert.equal(
    grab("../extensions/opl-init/index.ts", "SHARED GIT GUARD"),
    grab("../extensions/opl-footer/git-status.ts", "SHARED GIT GUARD"),
    "git guard drifted between opl-init and opl-footer — re-copy the region",
  );
});
