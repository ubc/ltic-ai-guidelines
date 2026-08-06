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

The fork carries five deltas over upstream `srt`. The first two work
around upstream limitations:

1. **No "allow all egress" mode.** The schema rejects `"*"` in
   `allowedDomains`, and there is no flag to disable network
   filtering from a config file. Our fork adds an
   `allowAllDomains: true` schema field that short-circuits the
   allowlist **after** `deniedDomains` is checked. (As of
   `0.0.70-ltic.3` the flag is also honored by the config validator's
   `injectHosts`-reachability cross-check, so credential masking with
   `allowedDomains: []` loads as written.)
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

The third delta (in `src/cli.ts`, no upstream PR) makes denials
*observable*: the CLI enables the seatbelt log monitor (upstream only
collects proxy denials in CLI mode) and streams every violation line to
`~/.local/state/srt/violations-<pid>.log`, exporting the path to the
sandboxed child as `$SRT_VIOLATIONS_FILE`. See [the violations
pipeline](#the-violations-pipeline).

The fourth delta (in `src/utils/config-loader.ts`, no upstream PR)
makes misconfiguration *visible*: upstream's zod schema silently strips
any settings key it doesn't recognize — a typo'd `allowAllDomainz`
loads with zero feedback and runs as a deny-all sandbox. The fork
prints a stderr warning at launch naming every unrecognized key with
its full path (for both `--settings` files and control-fd config
updates). It warns rather than errors, so nothing existing breaks.

The fifth delta (in `src/sandbox/sandbox-utils.ts`, `0.0.70-ltic.4`,
upstream [PR #452](https://github.com/anthropic-experimental/sandbox-runtime/pull/452))
makes sandboxed git-over-SSH work on macOS:
when socat is on PATH, `GIT_SSH_COMMAND` uses the auth-capable socat
HTTP CONNECT spelling instead of BSD `nc`, which cannot authenticate
to the session proxy ([details](#ssh)).

The `-ltic.N` version suffix is the quick check that you're on the
patched fork and not upstream `srt`: the `ltic-main` branch stamps a
distinctive version and reads it from `package.json` at runtime, so
`srt --version` is a reliable build identifier. Upstream stock `srt`
reports a plain version with no `-ltic` suffix.

The README's functional check exists because upstream stock `srt`
*silently drops* the unknown `allowAllDomains` key during schema
validation — a config that looks accepted can still be deny-all. (The
fork itself no longer fails this way: delta 4 warns at launch about
any unrecognized key.) One trap in simpler versions of that check: `curl -sI … | head -1` prints
the proxy's `HTTP/1.1 200 Connection Established` CONNECT response even
when the request then *fails*, so check the real HTTP status instead.
(Historically the check also had to stage a `.crt` CA bundle — curl's
default `/etc/ssl/cert.pem` is caught by the `/**/*.pem` deny glob and
fails with error 77 whether or not the domain was allowed. With
`tlsTerminate` enabled, srt points curl at its own injected bundle, so
that trap is gone — see [TLS inside the
sandbox](#tls-inside-the-sandbox).)

## The violations pipeline

Without it, the agent inside the sandbox sees only a generic `403` or
`EPERM` on a policy denial and tends to misread it as a broken tool or
network — a false positive it may burn time retrying. The pipeline
lands each denial, with its configured reason, in the agent's context
right after the failed command:

1. **srt side (fork delta 3).** Every violation — filesystem (seatbelt
   log monitor) and network (proxy denial) — is appended, timestamped
   and one per line, to `~/.local/state/srt/violations-<pid>.log`.
   The path is exported as `$SRT_VIOLATIONS_FILE` to the sandboxed
   child, so concurrent sessions are isolated for free; logs older
   than 7 days are pruned at startup.
2. **Claude Code side (`srt-violations.mjs`).** A PostToolUse(Bash)
   hook reads the file from the offset it last reached (state in
   `~/.cache/srt-hook/`) and, if new lines exist, injects them as
   `additionalContext` wrapped in a `<sandbox_violations>` block with
   a preamble telling the model these are policy blocks, not errors.
   When `$SRT_VIOLATIONS_FILE` is unset (any non-sandbox session) the
   hook exits immediately.
3. **Config side.** `network.deniedDomainReasons` — keyed by the
   **exact** `deniedDomains` entry string — replaces the generic deny
   text on the violation line; add a reason for every domain you deny,
   and always name the sanctioned alternative (e.g. "write to a file
   in the repo instead"). `ignoreViolations` maps command patterns
   (`"*"` = all) to substrings of violation lines to suppress; the
   four entries in these configs cover benign macOS noise every
   process emits (sysctl `kern.*`, configd Mach lookups, preferences
   plists). Extend it if recurring non-actionable noise shows up.

**Security invariant — do not break this.** Violation lines flow into
the agent's context, so `~/.local/state/srt` must be **readable but
never writable** from inside the sandbox — if sandboxed code could
write that file, it would be a prompt-injection channel. Both configs
satisfy this today (denyall: `~/.local` is in `allowRead` while
`allowWrite` grants only `~/.local/state/claude` and
`~/.local/share/uv`; allowall: the path is in neither `denyRead` nor
`allowWrite`). Never add `~/.local/state/srt` — or a parent like
`~/.local` — to `allowWrite`.

**Known limitations.** Proxy (network) denials appear in the file
instantly; filesystem (seatbelt) denials arrive with ~1–2 s of `log
stream` latency, so a session that exits immediately after a denial
can miss the trailing line (interactive sessions pick it up on the
next Bash command). Attribution is session-global — lines are
timestamped, not tied to a specific command — so correlate by recency.
Violation-line URLs are redacted by srt (query strings collapse to
`?…`, userinfo dropped) so runtime-interpolated secrets can't leak
into the transcript.

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

**The problem.** Every TLS stack that reads its trust roots from a PEM
file on disk — cargo's statically-linked libcurl, the system
`/usr/bin/curl` (LibreSSL backend), Homebrew git's libcurl, python's
certifi — defaults to `/etc/ssl/cert.pem` or similar, and every `.pem`
file is unreadable inside the sandbox (the `/**/*.pem` deny glob). The
symptom is curl error 77: `error setting certificate verify locations`.

**Solved natively by `tlsTerminate`.** With `network.tlsTerminate`
enabled (both configs), srt's proxy terminates TLS (MITM): it re-signs
upstream certificates with its own per-session CA, builds a trust
bundle — MITM CA + host roots + any
`network.tlsTerminate.extraCaCertPaths` — at a temp path the `.pem`
glob doesn't cover, and sets `SSL_CERT_FILE`, `CURL_CA_BUNDLE`,
`CARGO_HTTP_CAINFO` (cargo ignores the generic vars), `GIT_SSL_CAINFO`
(so does git), and `REQUESTS_CA_BUNDLE` for the sandboxed process
itself. Nothing to stage, nothing for the wrapper to export — in fact
the wrapper must *not* set those vars, or its values would shadow
srt's and break TLS inside. `extraCaCertPaths` is also the supported
way to trust site-local/internal CAs if that ever comes up.

*Historical note:* before 0.70, the proxy here ran as a passthrough
CONNECT tunnel and `_ccx_run` staged `/etc/ssl/cert.pem` at a `.crt`
path with the five env vars exported by hand. `tlsTerminate` retired
that hack.

**Tools that verify via trustd need the CA trusted in the keychain.**
`gh` and other Go binaries, SecureTransport apps, and cargo's libgit2
transport don't read PEM bundles or the env vars — they ask the macOS
trust store, which knows nothing about srt's MITM CA, so under
`tlsTerminate` they fail with `x509: certificate signed by unknown
authority`. Two pieces fix this (README setup step 4):

- srt's default MITM CA is *ephemeral per session* — untrustable in
  practice. `_ccx_run` therefore generates a **persistent** CA once
  (`~/.config/srt/mitm-ca.{crt,key}`, RSA-2048, key mode 600) and
  injects its paths via `tlsTerminate.{caCertPath,caKeyPath}` in the
  per-launch config copy (those fields do no tilde expansion, hence
  the wrapper rather than the template).
- A one-time `security add-trusted-cert -p ssl` marks that CA
  SSL-trusted for your user, after which trustd accepts the
  proxy-minted leaves.

Key-custody note: whoever holds `mitm-ca.key` can MITM TLS *for apps
that trust it*. The key is sandbox-unreadable (the `/**/*.key` deny
glob plus, in denyall, `~/.config/srt` not being in `allowRead`), so
only host processes running as you could use it — and those could
install their own CA anyway. This mirrors srt's own Windows
persistent-CA design.

`enableWeakerNetworkIsolation: true` is still required as of
`srt 0.0.70-ltic.4` — it's what lets sandboxed processes reach trustd
at all: with it set to `false`, `gh api` fails the TLS handshake with
`x509: OSStatus -26276` regardless of keychain trust. It is also
load-bearing for `GH_TOKEN` masking, which happens inside the
terminated TLS stream.

**Escape hatch for mTLS / cert-pinned hosts.** A host that pins certs
or requires mutual TLS breaks under MITM termination. Upstream `srt`
supports `network.tlsTerminate.excludeDomains` — a per-host list that
skips termination for those domains (added in
[#344](https://github.com/anthropic-experimental/sandbox-runtime/pull/344)).
Prefer adding the offending host there over turning `tlsTerminate` off
globally (which would resurrect the CA-staging problem and disable
token masking). The configs here don't set it (no known offender);
note that excluded hosts also lose token injection, since substitution
happens inside the terminated stream.

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
TLS — is handled automatically by [srt's injected trust
bundle](#tls-inside-the-sandbox). For some *other* non-secret
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

1. **A readable CA bundle.** Cargo's statically-linked libcurl defaults
   to the blocked `/etc/ssl/cert.pem` and ignores `SSL_CERT_FILE`, so it
   needs the dedicated `CARGO_HTTP_CAINFO` env var — which srt sets
   itself under `tlsTerminate`, pointing at its injected bundle
   ([details](#tls-inside-the-sandbox)).
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
bytes for the initial handshake, so key-file auth is impossible inside
the sandbox. Instead, **SSH works through agent forwarding** — the
implemented default:

The SSH agent holds keys in memory and exposes only a signing socket —
clients authenticate through it without ever reading raw key bytes.
Two pieces make it reachable:

1. **The env var.** `_ccx_run` passes `$SSH_AUTH_SOCK` through to the
   sandboxed process.
2. **A seatbelt allowance for the socket.** Unix-socket connects are
   gated by seatbelt *network* rules, not file rules — srt exposes
   this as `network.allowUnixSockets` (macOS-only; it emits
   `system-socket` + `network-bind`/`network-outbound` rules for the
   listed paths). The launchd agent socket lives at
   `/var/run/com.apple.launchd.<random>/Listeners`, a path that
   changes every login session, so it can't be hardcoded in the JSON:
   `_ccx_run` injects the live `$SSH_AUTH_SOCK` value into a
   per-launch copy of the config (`jq … > "$td/settings.json"`) and
   launches srt with that. srt realpaths the entry, so the
   `/var → /private/var` symlink is handled.

Keys must be loaded (`ssh-add`) before launching.

**`IdentitiesOnly yes` blocks the agent path — add a sandbox-scoped
override.** With `IdentitiesOnly yes` (common in per-host multi-key
setups), ssh offers *only* the listed `IdentityFile` identities — and
inside the sandbox it can read neither the private key nor its `.pub`
sibling (both match the `/**/id_*` globs), so it offers nothing and
auth fails with `Permission denied (publickey)` even though the agent
holds the key. ssh config is first-obtained-value-wins, so a `Match`
block at the **top** of `~/.ssh/config`, keyed on the sandbox-only
`SRT_VIOLATIONS_FILE` env var, relaxes it for sandbox sessions only:

```
Match exec "test -n \"$SRT_VIOLATIONS_FILE\""
    IdentitiesOnly no
```

Outside the sandbox the variable is unset, the block doesn't match,
and the per-host `IdentitiesOnly yes` behaves exactly as before.

**The transport: socat through the proxy (requires
`brew install socat`).** Authentication is only half of SSH; the TCP
connection itself must traverse the srt proxy (direct DNS/egress is
blocked — bare `ssh` fails with "Could not resolve hostname"). srt
handles this by setting `GIT_SSH_COMMAND` with a `ProxyCommand`, and
as of `0.0.70-ltic.4` (fork delta 5) the macOS spelling is
`socat - PROXY:localhost:%h:%p,proxyport=<port>,proxyauth=<user>:<token>` —
an HTTP CONNECT tunnel that authenticates to the proxy, same as Linux
has always used. (The previous BSD `nc -X 5` spelling could not speak
SOCKS5 auth, so git-over-SSH always died at the handshake against the
auth-required session proxy; `nc` remains the fallback when socat is
missing, with the old failure mode.) The proxy sniffs for a TLS
ClientHello before MITM-ing, so SSH bytes pass through as an opaque
tunnel: SSH crypto stays end-to-end, the proxy sees only `host:port`,
and host-level `deniedDomains` still apply (the portless
`gist.github.com` entry covers gist-over-SSH).

For plain `ssh`/`sftp` (outside git), srt only wires the ProxyCommand
into `GIT_SSH_COMMAND` — reuse it from inside the sandbox:
`eval "$GIT_SSH_COMMAND git@github.com"` (the value contains a
single-quoted ProxyCommand, so `eval` it rather than word-splitting).

**Trade-off:** while a session runs, sandboxed code can authenticate
as you to anything the agent holds keys for — but it cannot
exfiltrate the key material itself (the `/**/id_*` globs still deny
every key file). Mitigations: load keys with `ssh-add -c` so the
agent prompts for confirmation on every signature, or use
hardware-backed keys that require a touch. Note also that SSH traffic
bypasses the srt proxy's visibility and token masking — host-level
`deniedDomains` is the only network lever on that channel (the
`gist.github.com` deny entry is portless, so gist-over-SSH stays
blocked).

Alternatives:

- **HTTPS + credential helpers (no agent needed).** For `git
  push`/`git pull`, use HTTPS remotes with `gh auth git-credential` /
  `glab auth git-credential` (recipe in the README gotchas). Scopes
  the credential to that host's HTTPS endpoint, and GitHub traffic
  stays visible to the proxy.

- **Removing `/**/id_*` from `denyReadAlways` — not recommended.**
  Gives Claude read access to raw private key bytes, which allows key
  exfiltration over the network. Only if the threat model explicitly
  accepts it.

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

**`gh` token, masked.** `gh` stores its token in the Keychain.
`_ccx_run` extracts it via `gh auth token` outside the sandbox and
passes it as `$GH_TOKEN` — but the sandbox never sees the real value.
The `credentials.envVars` block masks it: the sandboxed process gets a
structurally valid fake token, and the TLS-terminating proxy swaps the
real one in — in headers *and* request bodies — only on egress to
`github.com` / `*.github.com`. A process that exfiltrates `$GH_TOKEN`
to any other host leaks a worthless sentinel. Caveats:

- **`injectHosts` is mandatory in these configs.** Its default is
  `network.allowedDomains`, which is `[]` here (the fork's
  `allowAllDomains` does the allowing) — so omitting it would mask the
  token but inject the real one *nowhere*. As of `0.0.70-ltic.3` that
  spelling is a load-time error telling you to list the inject hosts
  (before, `gh` just silently failed auth).
- **Requires `network.tlsTerminate`** (substitution happens inside the
  terminated stream) and `enableWeakerNetworkIsolation: true` (`gh` is
  a Go binary and needs trustd on macOS).
- **The `credentials.*` sub-schema is `.strict()`** — a typo'd key
  under it is a hard config-load error. (Keys elsewhere are stripped
  rather than rejected, but the fork warns about them at launch —
  fork delta 4.)
- Tools that bypass the proxy send the fake token and fail GitHub
  auth — a functionality caveat, not a leak.

`gh` operations work inside the sandbox (PR lists, issue comments, API
calls). Re-auth flows — `gh auth login`, `gh auth refresh`, `gh auth
logout` — still need to be run *outside* the sandbox, since write
access to `~/.config/gh` is intentionally not granted.

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
  are macOS-only and ignored on Linux. `network.allowUnixSockets` is
  also macOS-only (seccomp can't filter by path), so the SSH
  agent-forwarding allowance doesn't apply.
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

- **`credentials.files` masking — deliberately not adopted.** Env-var
  masking is in use (see [gh and glab](#gh-and-glab)), but *file*
  masking is Linux-only — on macOS Seatbelt can't redirect reads, so
  `mask` degrades to plain `deny`, and it takes explicit paths rather
  than broad globs. `denyReadAlways` already provides everything it
  could offer here, and the Keychain→`~/.claude/.credentials.json`
  seeding scheme remains the right approach on a Mac.
- **URL/path-level filtering.** Allow/deny today is host-only. `srt`'s
  MITM TLS termination layer (`src/sandbox/tls-terminate-proxy.ts`)
  sees full request URLs, so a future schema could block on path
  patterns — e.g. allow `github.com` but block `*/raw/*` to close a
  class of exfil the bare-domain deny misses.
- **Egress audit logging.** Even with allow-all-domains, the proxy
  observes every destination and URL passing through. Routing that to
  a log file outside the sandbox would give an after-the-fact audit
  trail of what Claude actually reached out to during a session. (The
  [violations pipeline](#the-violations-pipeline) realizes the *denial*
  half of this; allowed traffic is still unlogged.)
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
