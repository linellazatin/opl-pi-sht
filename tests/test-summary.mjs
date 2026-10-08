import { spawn } from "node:child_process";

const scripts = [
  "test:shared",
  "test:opl-browser",
  "test:opl-footer",
  "test:opl-guardian",
  "test:opl-init",
  "test:opl-input",
  "test:opl-modes",
  "test:opl-questionnaire",
  "test:opl-todo",
  "test:opl-webaccess",
  "test:opl-simplebench",
  "test:opl-ctxtrim",
  "test:pi-host",
];

const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const RESET = "\u001b[39m";

function colorizeLine(line) {
  return line
    .replace(/^\((pass|fail)\)/, (_, w) => `(${w === "pass" ? GREEN : RED}${w}${RESET})`)
    .replace(/^(\s*\d+)\s+(pass|fail)(\s*)$/, (_, num, w, trail) => `${num} ${w === "pass" ? GREEN : RED}${w}${RESET}${trail}`);
}

function runScript(script) {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", script], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let pending = "";
    const onData = (chunk) => {
      const text = chunk.toString();
      output += text;
      pending += text;
      let nl;
      while ((nl = pending.indexOf("\n")) !== -1) {
        process.stdout.write(colorizeLine(pending.slice(0, nl)) + "\n");
        pending = pending.slice(nl + 1);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => {
      if (pending) process.stdout.write(colorizeLine(pending));
      resolve({ code, output });
    });
  });
}

function counts(output) {
  const sum = (re) => [...output.matchAll(re)].reduce((acc, m) => acc + Number(m[1]), 0);
  return {
    pass: sum(/^\s*(\d+) pass\s*$/gm),
    fail: sum(/^\s*(\d+) fail\s*$/gm),
  };
}

let pass = 0;
let fail = 0;
const failed = [];

for (const script of scripts) {
  const { code, output } = await runScript(script);
  const c = counts(output);
  pass += c.pass;
  fail += c.fail;
  if (code !== 0 || c.fail > 0) failed.push(script);
}

console.log(`\nSummary: ${GREEN}${pass} passed${RESET}, ${RED}${fail} failed${RESET}`);
if (failed.length > 0) {
  console.log(`${RED}Failed suites: ${failed.join(", ")}${RESET}`);
  process.exit(1);
}