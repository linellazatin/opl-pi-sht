/**
 * Environment for processes that run model-authored code.
 *
 * `coding_lite` and `test_all` write the model's answer to disk and execute it,
 * so whatever the model wrote runs with this process's parent environment. The
 * harness is normally started from a shell that holds provider keys, cloud
 * credentials and agent paths, and none of those belong in front of generated
 * code. This is therefore an allowlist, not a denylist: anything not listed here
 * is absent from the child, including every `*_API_KEY`, `AWS_*`, `GH_*` and
 * `PI_*` variable.
 *
 * `NODE_OPTIONS` and `NODE_PATH` are deliberately never forwarded: both can make
 * Node load attacker-chosen files.
 */
export const INHERITED_KEYS = [
  // POSIX: node resolution, temp files, locale and timezone.
  "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ", "SHELL", "USER", "LOGNAME",
  // TLS trust the child may legitimately need.
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  // Terminal capabilities only; no secrets live here.
  "TERM", "NO_COLOR", "FORCE_COLOR", "COLORTERM",
  // Windows: spawning and node resolution fail without these.
  "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA",
];

/** Build the environment for a child that executes untrusted, model-authored code. */
export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of INHERITED_KEYS) {
    const value = base[key];
    // NUL-containing values are rejected by spawn(); drop them instead of throwing.
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) out[key] = value;
  }
  return out;
}
