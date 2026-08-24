import * as fs from "node:fs";
import * as path from "node:path";
import type { RunArtifact } from "./types";

export function artifactFileName(model: string, suite: "baseline" | "coding-lite" | "test-all" = "baseline", thinking: "default" | "max" = "default", date = new Date()): string {
  const safeModel = model.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
  const stamp = date.toISOString().replace(/:/g, "-").replace(/\.\d{3}/, "");
  const suiteName = suite === "baseline" ? "3ptest" : suite;
  return `simplebench--${suiteName}-${safeModel}-${thinking}-${stamp}.json`;
}

export function writeArtifact(artifact: RunArtifact): string {
  const name = artifactFileName(artifact.benchmark.model, artifact.benchmark.suite || "baseline", artifact.benchmark.thinking.requested);
  const extension = path.extname(name);
  const base = name.slice(0, -extension.length);
  const contents = JSON.stringify(artifact, null, 2) + "\n";
  for (let suffix = 0; ; suffix += 1) {
    const output = path.resolve(process.cwd(), suffix ? `${base}-${suffix}${extension}` : name);
    try {
      fs.writeFileSync(output, contents, { encoding: "utf8", flag: "wx" });
      return output;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}
