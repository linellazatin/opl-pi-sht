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
  const output = path.resolve(process.cwd(), artifactFileName(artifact.benchmark.model, artifact.benchmark.suite || "baseline", artifact.benchmark.thinking.requested));
  fs.writeFileSync(output, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  return output;
}
