# Design notes and deep dives

Companion to the [README](README.md): the reasoning, history, and long
explanations behind the short callouts there. Nothing here is required
to *use* the sandbox.

## Why these design choices

**Why allow all egress?** Enumerating every domain Claude might need to
hit (npm, MDN, Stack Overflow, docs.rs, pkg.go.dev, every random blog
post linked from search results) is whack-a-mole. The threat model
treats *what Claude can read off disk* as the higher-value boundary;
once that's locked down, egress matters less because there's not much
sensitive to send. The explicit `deniedDomains` list catches the
specific exfil channels worth blocking.

**Why two postures instead of one?** Deny-by-default is the
theoretically-correct posture but in practice everyone's `~/` has
unexpected paths Claude wants to peek at. Having `ccx_permissive` as a
"loosen if it's getting annoying" option means people actually use the
sandbox instead of giving up and running Claude unsandboxed.

**Why fork instead of using upstream as-is?** Upstream rejects `"*"` in
the allowlist and `getDefaultConfig()` gives an empty allowlist that
means "deny all", so there is no path through the CLI to "no network
restrictions." The fork's `allowAllDomains: true` is the minimum change
needed and is additive — existing configs are unaffected.

## The fork

Upstream `srt` has two limitations these configs need to work around:

1. **No "allow all egress" mode.** The schema rejects `"*"` in
   `allowedDomains`, and there is no flag to disable network
   filtering from a config file. Our fork adds an
   `allowAllDomains: true` schema field that short-circuits the
   allowlist **after** `deniedDomains` is checked.
2. **A *glob* `denyRead` inside an `allowRead` region is ignored.**
   Upstream [PR #311](https://github.com/anthropic-experimental/sandbox-runtime/pull/311)
   fixed the *literal* case — a literal path in `denyRead` nested under
   an `allowRead` subtree is now re-emitted after the allow rules and
   wins. But upstream deliberately does **not** re-emit *glob* denies
   (the regex-vs-subpath nesting isn't decidable at rule-generation
   time — see the comment in `generateReadRules`), so a credential glob
   like `/**/.env*` inside a broad `allowRead` like `~/src` still does
   nothing on stock `srt`. Our fork adds a third layer,
   `denyReadAlways`, that emits glob deny rules **after** the allowRead
   rules so they win — letting credential globs like `/**/.env*`
   actually take effect inside an allowed directory.

The `-ltic.N` version suffix is the quick check that you're on the
patched fork and not upstream `srt`: the `ltic-main` branch stamps a
distinctive version and reads it from `package.json` at runtime, so
`srt --version` is a reliable build identifier. Upstream stock `srt`
reports a plain version with no `-ltic` suffix.

The README's functional check exists because upstream stock `srt`
*silently drops* the unknown `allowAllDomains` key during schema
validation — a config that looks accepted can still be deny-all. Two
traps in simpler versions of that check: `curl -sI … | head -1` prints
the proxy's `HTTP/1.1 200 Connection Established` CONNECT response even
when the request then *fails*, and without `--cacert` curl inside the
sandbox can't read its default CA bundle (`/etc/ssl/cert.pem` is caught
by the `/**/*.pem` deny glob — see [TLS inside the
sandbox](#tls-inside-the-sandbox)) and reports error 77 whether or not
the domain was allowed. The staged `.crt` copy sidesteps both.

## Credential plumbing

**Claude OAuth credential seeding.** Claude Code's OAuth credential
lives in the macOS Keychain. The sandbox denies `~/Library/Keychains`,
so Claude can't read its own credentials from inside. Claude Code has a
two-tier credential store (`fallbackStorage`): it tries the Keychain
first and falls back to a file, `~/.claude/.credentials.json`, when the
Keychain read fails — which is exactly what happens inside the sandbox.
`_ccx_run` seeds that file from the Keychain *outside* the sandbox so
Claude finds it on the fallback path.

Why a file instead of the old file-descriptor trick: the FD mechanism
(`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`) injects only a bare access
token, and Claude Code hardcodes `subscriptionType: null` for that path.
A null subscription type degrades the defaults — Sonnet instead of Opus
for Max subscribers, and one plan-mode agent instead of three. The file
store carries the full credential JSON (including `subscriptionType` and
`rateLimitTier`), so Claude reads the correct tier and picks the right
model and agent count.

**The refresh token is nulled before the file is written.** The
short-lived (~8h) access token is enough for a session; stripping the
refresh token means the sandbox can never refresh, which is deliberate:

1. The long-lived refresh token never touches disk — only the access
   token does, and only for the life of the session.
2. Because the sandbox never refreshes, it never rotates the backend
   refresh token (the refresh-token grant returns a new one each time),
   so the Keychain stays valid and authoritative — **no drift.**

When the access token expires (~8 hours), the session simply stops
authenticating — the sandboxed process cannot reach the Keychain or
complete the browser-based re-auth flow. **To refresh: exit the sandbox,
run `claude` once in a normal terminal (it silently re-auths against the
Keychain), then relaunch with `ccx` or `ccx_permissive`.** Each launch
re-seeds the file from the Keychain, so the restart picks up the freshly
refreshed credential, and because the sandbox never rotates the refresh
token this outside-refresh loop keeps working indefinitely.

The file is seeded on **every launch** (overwrite), because without
in-sandbox refresh it can't renew itself — the Keychain is the source of
truth and the file is just a per-launch snapshot. There is no
cleanup-on-exit: Claude re-reads the credential store mid-session, so
removing the file could yank it out from under a concurrent `ccx`; a
stale expired token sitting between sessions is harmless and gets
overwritten on the next launch.

**Security tradeoff (deliberate).** The access token lands on disk at
`~/.claude/.credentials.json` (mode 600) for the life of the session,
rather than streaming through a pipe and never touching disk (the old
FIFO/FD design). The refresh token does **not** — it is nulled out. The
file is readable inside the sandbox only because, being a dotfile, it
escapes the `/**/credentials.json` deny glob (the leading `.` means the
pattern doesn't match) — fragile: tightening that pattern would lock
Claude out of its own credentials.

## TLS inside the sandbox

**CA-bundle staging.** Every TLS stack that reads its trust roots from a
PEM file on disk — cargo's statically-linked libcurl, the system
`/usr/bin/curl` (LibreSSL backend), Homebrew git's libcurl, python's
certifi — defaults to `/etc/ssl/cert.pem` or similar, and every `.pem`
file is unreadable inside the sandbox (the `/**/*.pem` deny glob). The
symptom is curl error 77: `error setting certificate verify locations`.
`_ccx_run` copies `/etc/ssl/cert.pem` to `$td/ca-bundle.crt` *outside*
the sandbox (the `.crt` name escapes the glob) and points the usual env
vars at it: `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `CARGO_HTTP_CAINFO`
(cargo ignores the generic vars), `GIT_SSL_CAINFO` (so does git), and
`REQUESTS_CA_BUNDLE`. This stages *public* root certs only — the
private-key globs are untouched.

**Passthrough, not MITM.** The srt proxy here is a passthrough CONNECT
tunnel — the real upstream certificate (e.g. crates.io's GlobalSign
cert) is presented to the client, so the public root store is
sufficient. If you ever enable `network.tlsTerminate`, append srt's MITM
CA to the staged bundle.

**Tools that never needed any of this** verify through the macOS trust
store (trustd) instead of a PEM file: `gh` and other Go binaries,
SecureTransport apps, cargo's libgit2 transport, uv's rustls. They work
because of `enableWeakerNetworkIsolation: true` — still required as of
`srt 0.0.62-ltic.1`: with it set to `false`, `gh api` fails the TLS
handshake (`x509: OSStatus -26276`). The newer TLS-proxy hardening
(SKI/AKI leaf extensions, gcloud/Nix CA env injection) did **not**
remove the need for this on macOS.

**Escape hatch for mTLS / cert-pinned hosts.** If a specific host breaks
because it pins certs or requires mutual TLS, upstream `srt` supports
`network.tlsTerminate.excludeDomains` — a per-host list that skips MITM
termination for those domains (added in
[#344](https://github.com/anthropic-experimental/sandbox-runtime/pull/344)).
Prefer adding the offending host there over weakening isolation
globally. The configs here don't set it (no known offender).

**In-sandbox fallback for building a bundle:** the system roots keychain
is readable inside the sandbox, so a bundle can be rebuilt from within
if ever needed:
`security export -k /System/Library/Keychains/SystemRootCertificates.keychain -t certs -f pemseq -o bundle.crt`.

## Filesystem rule mechanics

**Glob anchoring.** `srt`'s glob patterns are CWD-relative by default: a
pattern like `**/.env*` gets normalized to `<cwd>/**/.env*` and only
matches files under wherever Claude was launched from. To match
globally, **start the pattern with a leading `/`** — `/**/.env*`
resolves to the regex `^/(.*/)?\.env[^/]*$` and matches any `.env*` file
anywhere on the filesystem. The configs in this repo use leading `/` for
all global patterns.

**Why the `.pem`/`.key` globs are so broad.** They deny *every* file
with those extensions anywhere — catching legitimate non-secret files:
test fixtures, vendored CA bundles, public certs, certs under
`node_modules`. This is deliberate: egress is allow-all, so a readable
private key is a direct exfil path, and most private keys *do* use these
extensions. The breadth is the cost of that coverage. The biggest
casualty — system CA bundles, which would break cargo/curl/git/python
TLS — is handled automatically by [CA-bundle
staging](#tls-inside-the-sandbox). For some *other* non-secret
`.pem`/`.key` a build needs: copy it to a path that doesn't match the
glob (rename to `.crt`/`.cert`, or stage it as `cert.pem.txt`) and point
the tool there; or drop the two globs from `denyReadAlways` (denyall) /
`denyRead` (allowall) if you accept the weaker posture.

**`/private/tmp`, not `/tmp`.** Seatbelt does not resolve the
`/tmp → /private/tmp` symlink in `(subpath …)` allow rules, so a bare
`/tmp` in `allowWrite` grants nothing. The configs use `/private/tmp`.
(`/tmp/claude` is always granted by `srt` itself regardless.)

**`denyWrite` for Claude's own config.** Writes to
`~/.claude/settings.json` install Claude Code hooks that execute
*outside* the sandbox on the next start; `~/.claude/CLAUDE.md` is
user-level memory the next session reads as authoritative. Both are
sandbox-escape / persistence vectors, and upstream `srt`'s auto-deny
list does not cover them.

## Cargo and Rust

Two things had to line up for cargo to work inside the sandbox:

1. **The staged CA bundle.** Cargo's statically-linked libcurl defaults
   to the blocked `/etc/ssl/cert.pem` and ignores `SSL_CERT_FILE`, hence
   the dedicated `CARGO_HTTP_CAINFO` env var.
2. **Write access to its caches:** `~/.cargo/registry`, `~/.cargo/git`,
   and the `~/.cargo/.package-cache` lock file, which both configs
   grant.

With both in place, `cargo fetch`/`build` with registry and git
dependencies work (the git transport uses libgit2 + SecureTransport, so
it verifies via trustd and needs no bundle).

Deliberately **not** granted: writes to the rest of `~/.cargo` —
`~/.cargo/bin` holds binaries on `$PATH` executed *outside* the sandbox
(a persistence/escape vector) and `~/.cargo/config.toml` could inject
rustc wrappers honored outside — so `cargo install` fails inside; run it
outside. `~/.rustup` stays read-only for the same reason (toolchains are
executed outside too): run `rustup` outside. `cargo publish` can't read
a registry token inside (the `/**/credentials.toml` glob) — also
outside. Existing toolchains compile fine inside since `~/.rustup` is
readable.

## pnpm and uv

**pnpm** has no TLS problem (Node compiles its root CAs into the
binary), but inside the sandbox it *silently* abandons its global store
under `~/Library/pnpm` and creates a `.pnpm-store/` directory inside the
project (or at the nearest writable ancestor) — losing cross-project
dedup and risking an accidental commit.

Why the permission grant alone isn't enough: pnpm's store-selection
probe (`@pnpm/store-path`) decides whether the global store is usable by
doing `mkdir ~/Library/pnpm/_tmp_<pid>_<random>` and hard-linking a
scratch file into it — it probes the **pnpm home root, not the `store/`
subdirectory it actually uses**. The configs allow writing
`~/Library/pnpm/store` only (keeping `$PNPM_HOME/bin` unwritable —
global binaries execute outside the sandbox, same escape-vector
reasoning as `~/.cargo/bin`), so the probe's `mkdir` hits EPERM one
level above the grant, pnpm concludes "unusable", and walks up from the
project to place a local `.pnpm-store` instead — even though the store
itself is fully functional.

The fix is therefore two-part: the configs allow reading
`~/Library/pnpm` and writing `~/Library/pnpm/store`, and `_ccx_run` pins
the store explicitly via the `pnpm_config_store_dir` env var — a
configured store-dir bypasses the probe entirely. (`pnpm_config_*` is
the env form pnpm ≥ 10 honors; `npm_config_store_dir` and
`PNPM_STORE_DIR` are ignored by pnpm 11.) Installs then hard-link/clone
from the global store as normal — on APFS pnpm uses copy-on-write
clones, which work inside the sandbox. `pnpm add -g` still needs to run
outside (writes to `$PNPM_HOME/bin`).

**uv needs nothing.** Its Rust TLS stack (rustls platform verifier) goes
through trustd, and its cache/data dirs (`~/.cache/uv`,
`~/.local/share/uv`) are already writable in both configs.

## git credential noise

With the stock `credential.helper = osxkeychain` config, git invokes the
helper to *save* the proxy credentials after each successful connection
through the srt proxy, and the Keychain write is blocked inside the
sandbox. The operation itself completes (exit 0, output intact) — the
`fatal: failed to store: -60008` lines are cosmetic. Silence them ad hoc
via `git -c credential.helper= …`, or per repo by *resetting* the helper
list before adding the gh helper — a lone added helper doesn't replace
the global osxkeychain one; an empty entry clears the list:

```bash
git config credential.helper ''
git config --add credential.helper '!gh auth git-credential'
```

## SSH

`denyReadAlways` includes `/**/id_*`, which covers every private key
file (e.g. `~/.ssh/id_ed25519-github`). SSH needs to read the raw key
bytes for the initial handshake, so any SSH-based operation — git over
SSH, interactive `ssh`, `sftp` — fails with EPERM. There is no `!`
escape from inside the sandbox. Options:

- **Option A — HTTPS + GH_TOKEN (GitHub only).** For `git push`/`git
  pull`, switch to HTTPS and use `gh auth git-credential` as the
  credential helper (recipe in the README gotchas). Simpler and scopes
  the credential to GitHub HTTPS only.

- **Option B — SSH agent forwarding (any SSH target).** The SSH agent
  holds keys in memory and exposes only a sign-once socket — clients
  authenticate through it without reading raw key bytes. To enable: in
  `_ccx_run`, capture `$SSH_AUTH_SOCK` *outside* the sandbox, add
  `allowRead` for that socket path (on macOS it's something like
  `/private/tmp/com.apple.launchd.*/Listeners`), and pass the env var
  in. Trade-off: Claude can authenticate as you to any SSH service
  reachable over the network, but cannot exfiltrate the key material
  itself.

- **Option C — remove `/**/id_*` from `denyReadAlways`.** Gives Claude
  read access to raw private key bytes. This allows key exfiltration
  over the network and is not recommended unless the threat model
  explicitly accepts it.

## Clipboard and OSC 52

This appears to surface only with Claude Code's **fullscreen mode** (the
mouse-selection / copy-to-clipboard rendering path, e.g. under
`CLAUDE_CODE_NO_FLICKER=1`) — that's where the in-app copy action runs.
When you copy inside Claude Code, Claude does two things at once: it
shells out to `pbcopy` **and** it emits an OSC 52 clipboard escape
sequence (`ESC]52;c;<base64>`) to the terminal. Inside the sandbox the
`pbcopy` half is dead — `pbcopy` talks to the macOS pasteboard over the
`com.apple.pasteboard` Mach service, and the Seatbelt profile `srt`
generates is default-deny for Mach lookups and does not allow-list it
(nor do these configs set `allowMachLookup`). So the copy only actually
lands on the clipboard if the **terminal** honors the OSC 52 sequence:

- **OSC 52-capable terminals — works, no sandbox change needed.** The
  terminal itself puts the text on the clipboard when it sees the escape
  sequence, entirely outside the sandbox; the sandboxed `pbcopy` failing
  in the background is harmless. **Ghostty** supports OSC 52 out of the
  box. So do **WezTerm**, **kitty**, and **Alacritty**. **iTerm2**
  supports it but it is **off by default** — enable *Settings → General
  → Selection → "Applications in terminal may access the clipboard"*.
  (Pasting *into* Claude with ⌘V is a terminal bracketed-paste and works
  everywhere regardless of the sandbox; only clipboard *reads* such as
  image-paste stay blocked.)

- **Apple Terminal.app — the copy is silently lost.** Terminal.app has
  no OSC 52 support, so the escape sequence is ignored and, with
  `pbcopy` blocked by the sandbox, the copy never reaches the system
  clipboard. (Run outside the sandbox it "works" only because `pbcopy`
  runs unrestricted.)

- **Workaround for Terminal.app —
  [`osc52pty`](https://github.com/roy2220/osc52pty).** It wraps a
  program in a PTY, watches its output for OSC 52 sequences, and runs
  `pbcopy` itself when it sees one — effectively teaching Terminal.app
  OSC 52. The critical requirement is that it must run **outside** the
  sandbox, wrapping the whole `ccx`/`srt` invocation, so its own
  `pbcopy` is unrestricted: e.g. run `osc52pty zsh` and use `ccx` inside
  it, or edit `_ccx_run` to launch `osc52pty srt --settings … -- claude
  …`. This keeps the sandbox fully tight — no pasteboard access is
  granted *inside* it; the clipboard write happens entirely outside. It
  is write-only (copy out), which is the direction the sandbox otherwise
  breaks. Simplest fix if you're flexible on terminal: just use an OSC
  52-capable terminal like Ghostty.

## gh and glab

**`gh` token injection.** `gh` stores its token in the Keychain.
`_ccx_run` extracts it via `gh auth token` outside the sandbox and
passes it as `$GH_TOKEN`. This makes read-only `gh` operations work
inside the sandbox (PR lists, issue comments, API calls). Re-auth
flows — `gh auth login`, `gh auth refresh`, `gh auth logout` — still
need to be run *outside* the sandbox, since write access to
`~/.config/gh` is intentionally not granted.

**`glab` (GitLab CLI).** Unlike `gh`, `glab` stores its token in a
config file (`~/Library/Application Support/glab-cli`) rather than the
Keychain, so no explicit injection step is needed — `glab` can read its
own credentials directly. In denyall mode this path is explicitly
`allowRead`'d; in allowall mode it is readable by default (not in the
`denyRead` list). `glab api`, `glab mr`, `glab issue`, and other
subcommands should work as-is. As an alternative to the config file, you
can inject `GITLAB_TOKEN` in `_ccx_run` the same way `GH_TOKEN` is
injected — `glab` reads it directly and it works regardless of whether
the config path is accessible.

## Using on Linux

These configs and shell functions are tested on macOS. `srt` itself
runs on Linux (via bubblewrap + seccomp), so the same patterns work
there with a few tweaks to the settings files:

- **Drop macOS-specific paths** from `denyRead`: `~/Library/*` entries,
  `/private/var/folders`, `/private/var/log/jamf.log`, `/opt/cisco`,
  `/etc/krb5.conf` (location may differ).
- **Add Linux equivalents** for the things you care about: browser/app
  data is typically under `~/.config/*` and `~/.mozilla/firefox`,
  shell histories are the same, secret stores may include `~/.config/keepassxc`,
  `~/.password-store` (pass), `~/.gnupg` (already in the list), etc.
- **`/private/tmp` → `/tmp` in `allowWrite`** — Linux has no symlink
  redirect, so the macOS-only workaround isn't needed.
- **Drop `enableWeakerNetworkIsolation` and `allowMachLookup`** — both
  are macOS-only and ignored on Linux.
- **`denyReadAlways` works on Linux for literal paths and narrow globs
  only.** Bubblewrap doesn't support regex/glob matching, so `srt`
  expands globs to concrete paths at config-load time. A pattern like
  `/**/.env*` (rooted at `/`) is rejected by the expander as "too
  broad" and silently skipped with a warning. To get coverage under
  the directories you care about, narrow the globs:
  `~/src/**/.env*`, `~/projects/**/credentials`, etc.

For the shell functions: the `security find-generic-password` block is
macOS Keychain-specific. Claude Code on Linux stores credentials
elsewhere, so the FIFO/FD trick may not be required at all — try
running `claude` from inside `srt` first, and only add token plumbing
if it actually fails to authenticate. `srtlog` uses macOS unified
logging; replace with `journalctl -k` or your distro's audit log
viewer to see seccomp/bubblewrap denials.

A maintained Linux variant would be a welcome addition to this repo.

## Future directions

`srt` has primitives this config doesn't exercise yet. Worth exploring
if/when the current posture isn't enough:

- **Native `credentials` masking block.** Upstream `srt` now ships a
  first-class `credentials` config block (`files` / `envVars`, each with
  `mode: deny | mask`, optional `extract` regex, and per-entry
  `injectHosts`). For *file* denies on macOS it's equivalent to what
  `denyReadAlways` already does (Seatbelt can't redirect reads, so
  `mask` degrades to `deny`), and it takes explicit paths rather than
  broad globs — so it's **not** a drop-in replacement for the
  credential globs here. Where it adds something this config can't do is
  **env-var masking**: substitute a sentinel for a real token in the
  environment and only swap the real value back on egress to specific
  `injectHosts` (requires `network.tlsTerminate`). Gotcha: the
  `credentials.*` sub-schema is `.strict()` — an unknown key under it is
  a hard load error (unlike top-level/network/filesystem keys, which are
  silently stripped).
- **URL/path-level filtering.** Allow/deny today is host-only. `srt`'s
  MITM TLS termination layer (`src/sandbox/tls-terminate-proxy.ts`)
  sees full request URLs, so a future schema could block on path
  patterns — e.g. allow `github.com` but block `*/raw/*` to close a
  class of exfil the bare-domain deny misses.
- **Egress audit logging.** Even with allow-all-domains, the proxy
  observes every destination and URL passing through. Routing that to
  a log file outside the sandbox would give an after-the-fact audit
  trail of what Claude actually reached out to during a session.
- **External policy via the MITM socket.** `MitmProxyConfigSchema`
  already supports routing specific domains through an upstream MITM
  proxy over a Unix socket. A separate policy engine — secret
  detection in request bodies, keyword filtering, response inspection
  — could plug in there without modifying `srt` itself.
- **Per-tool egress policies.** `ignoreViolations` lets filesystem
  rules vary by command. Extending that idea to network would let you
  say "npm can reach `*.npmjs.org`, claude can reach everywhere" —
  tightening exfil scope where you can without losing the
  no-enumeration ergonomics elsewhere.
