import * as fs from "node:fs";
import * as path from "node:path";
import type { RunArtifact } from "./types";

export function artifactFileName(model: string, date = new Date()): string {
  const safeModel = model.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
  const stamp = date.toISOString().replace(/:/g, "-").replace(/\.\d{3}/, "");
  return `simplebench-${safeModel}-${stamp}.json`;
}

export function writeArtifact(artifact: RunArtifact): string {
  const output = path.resolve(process.cwd(), artifactFileName(artifact.benchmark.model));
  fs.writeFileSync(output, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  return output;
}
