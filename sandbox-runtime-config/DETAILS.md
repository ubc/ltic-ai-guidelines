# Design notes and deep dives

Companion to the [README](README.md): the reasoning behind the short
callouts there. Nothing here is required to *use* the sandbox.

## Why these design choices

**Why allow all egress?** Enumerating every domain Claude might need
(npm, MDN, docs.rs, every blog post linked from a search result) is
whack-a-mole. The threat model treats *what Claude can read off disk*
as the higher-value boundary; once that's locked down there's little
sensitive to send. `deniedDomains` catches the specific exfil channels
worth blocking.

**Why two postures?** Deny-by-default is the correct posture, but
everyone's `~/` has unexpected paths Claude wants to peek at.
`ccx_permissive` is the "loosen if it's getting annoying" option that
keeps people using a sandbox instead of giving up on it.

**Why a fork?** Upstream rejects `"*"` in `allowedDomains` and an empty
allowlist means deny-all, so there is no way to say "no network
restrictions" from a config file. `allowAllDomains` is the minimum
additive change.

## The fork

Four deltas over upstream `srt`:

1. **`allowAllDomains: true`** short-circuits the allowlist *after*
   `deniedDomains` is checked. It covers hostnames only: IP literals
   and `localhost` / `*.localhost` still need an `allowedDomains`
   entry, and upstream's resolved-address guard refuses loopback,
   link-local and cloud-metadata destinations (and hostnames that
   resolve to them) with a 403.
2. **Observable denials** (`src/cli.ts`): the CLI enables the seatbelt
   log monitor and streams every violation to
   `~/.local/state/srt/violations-<pid>.log`, exported to the child as
   `$SRT_VIOLATIONS_FILE`. See [the violations
   pipeline](#the-violations-pipeline).
3. **Visible misconfiguration** (`src/utils/config-loader.ts`):
   upstream's zod schema silently strips unknown settings keys, so a
   typo'd `allowAllDomainz` runs as a deny-all sandbox with no
   feedback. The fork prints a launch-time warning naming every
   unrecognized key. `just check` fails on that warning.
4. **Working git-over-SSH on macOS** (`src/sandbox/sandbox-utils.ts`,
   upstream [PR #452](https://github.com/anthropic-experimental/sandbox-runtime/pull/452)):
   when socat is on PATH, `GIT_SSH_COMMAND` uses an auth-capable socat
   HTTP CONNECT ProxyCommand instead of BSD `nc`, which can't
   authenticate to the session proxy ([details](#ssh)).

`srt --version` reports `<upstream>-ltic.N`; the suffix is the quick
check that you're on the fork. `just check` also verifies egress end to
end with a real HTTP status (a bare `curl -sI … | head -1` is misleading:
it prints the proxy's `200 Connection Established` even when the
request then fails).

### Upstream changes in 0.0.77

Behaviour changes from the upstream sync that matter here:

- An invalid, empty or unreadable settings file makes srt **exit 1**
  instead of running with defaults.
- A `denyRead` glob now beats a broader `allowRead` region (see
  [filesystem rule mechanics](#filesystem-rule-mechanics)); the fork's
  `denyReadAlways` workaround was retired.
- Deny globs ending in `/` are rejected; IPv6 literals must be
  bracketed (`[::1]:443`).
- Default write paths obey a covering `denyRead`.
- New optional `network.deniedResolvedAddresses`: extra CIDRs an
  allowed hostname must not resolve to (RFC1918 is *not* built in).
- Gradle, Maven and Bazel honour the proxy automatically (JVM agent).
- Violation lines are sanitized to one physical line each.
- Seatbelt profiles are roughly 6–10× smaller.

### Upgrade notes by version

`just upgrade` handles the generic path (rebuild srt, re-copy configs,
reinstall shell functions and hook, verify). Per-version specifics, for
anyone migrating customized configs by hand:

**0.0.70-ltic.N → 0.0.77-ltic.1.** The fork-only `denyReadAlways` /
`denyReadAlwaysExcept` keys are gone; an un-migrated config silently
loses every credential glob, and the launch-time "unrecognized settings
key" warning is the only signal. Move each `denyReadAlways` entry into
`denyRead` and each `denyReadAlwaysExcept` entry into `allowRead`, then
delete both keys. Next to `/**/id_*.pub` in `allowRead`, add
`/**/id_rsa*.pub` and `/**/id_ed25519*.pub` (both configs), or public
keys stay denied ([why](#filesystem-rule-mechanics)). Cloud metadata
(`169.254.169.254`) now gets a 403 instead of being forwarded.

**0.0.62-ltic.1 → later.** Four things changed: socat and jq became
dependencies (`brew install socat jq`); both configs gained
`tlsTerminate`, `GH_TOKEN` masking (`credentials.envVars`), global
credential globs, `deniedDomainReasons` and `ignoreViolations`; the
shell functions were rewritten (persistent MITM CA, per-launch config
with the ssh-agent socket and CA paths, pinned pnpm store) and won't
work with the old configs; and two setup steps are new — trusting the
CA (step 4) and the violations hook (step 5). `just check`'s `gh api
user` smoke test exercises all of it at once.

## The violations pipeline

Without it, a policy denial looks to the agent like a broken tool or
network (a bare `403` or `EPERM`), which it may burn time retrying. The
pipeline lands each denial, with its configured reason, in the agent's
context right after the failed command:

1. **srt side (fork delta 2).** Every filesystem (seatbelt) and network
   (proxy) violation is appended, timestamped, one per line, to
   `~/.local/state/srt/violations-<pid>.log`; the path is exported as
   `$SRT_VIOLATIONS_FILE`. Concurrent sessions are isolated for free;
   logs older than 7 days are pruned at startup.
2. **Claude Code side (`srt-violations.mjs`, installed by `just
   install-hook`).** A PostToolUse(Bash) hook reads the file from the
   offset it last reached (state in `~/.cache/srt-hook/`) and injects
   new lines as `additionalContext` inside a `<sandbox_violations>`
   block, with a preamble saying these are policy blocks, not errors.
   With `$SRT_VIOLATIONS_FILE` unset the hook exits immediately.
3. **Config side.** `network.deniedDomainReasons` (keyed by the exact
   `deniedDomains` string) replaces the generic deny text — always name
   the sanctioned alternative. `ignoreViolations` maps command patterns
   (`"*"` = all) to substrings to suppress; the four entries cover
   benign macOS noise every process emits. Extend it if recurring
   non-actionable noise shows up.

**Security invariant.** Violation lines flow into the agent's context,
so `~/.local/state/srt` must be readable but **never writable** from
inside the sandbox, or it becomes a prompt-injection channel. Both
configs satisfy this; never add `~/.local/state/srt` or a parent like
`~/.local` to `allowWrite`.

**Limitations.** Network denials appear instantly; filesystem denials
arrive with ~1–2 s of `log stream` latency, so a session that exits
right after a denial can miss the last line. Lines are timestamped, not
tied to a command — correlate by recency. URLs on violation lines are
redacted (query strings collapse to `?…`, userinfo dropped).

## Credential plumbing

Claude Code's OAuth credential lives in the macOS Keychain, which the
sandbox denies (`~/Library/Keychains`). Claude Code falls back to a file
store, `~/.claude/.credentials.json`, when the Keychain read fails, so
`_ccx_run` seeds that file from the Keychain *outside* the sandbox on
every launch — the Keychain is the source of truth and the file is a
per-launch snapshot.

The refresh token is nulled before writing. The ~8h access token is
enough for a session, and without a refresh token the sandbox can never
refresh, which is deliberate: the long-lived token never touches disk,
and the sandbox never rotates the backend refresh token, so the Keychain
stays valid with no drift. When the access token expires the session
stops authenticating; exit, run `claude` once outside (it refreshes
silently), relaunch. The write is atomic (temp file + rename) because
Claude re-reads the store mid-session, and there is no cleanup on exit —
a stale expired token between sessions is harmless and an `rm` could
yank the file from under a concurrent session.

Why a file rather than the `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`
path: that injects only a bare token and hardcodes `subscriptionType:
null`, which degrades defaults (Sonnet instead of Opus for Max
subscribers, one plan-mode agent instead of three). The file carries the
full credential. Note the file is readable inside only because, as a
dotfile, it escapes the `/**/credentials.json` deny glob — tightening
that pattern would lock Claude out of its own credentials.

## TLS inside the sandbox

Every TLS stack that reads its roots from a PEM file (curl, cargo's
libcurl, git, python's certifi) defaults to `/etc/ssl/cert.pem`, which
the `/**/*.pem` deny glob makes unreadable — curl error 77. With
`network.tlsTerminate` enabled, srt's proxy terminates TLS: it re-signs
upstream certificates with its MITM CA, builds a trust bundle (MITM CA
+ host roots + any `tlsTerminate.extraCaCertPaths`) at a path the glob
doesn't cover, and sets `SSL_CERT_FILE`, `CURL_CA_BUNDLE`,
`CARGO_HTTP_CAINFO`, `GIT_SSL_CAINFO` and `REQUESTS_CA_BUNDLE` itself.
The wrapper must *not* set those vars — its values would shadow srt's.
`extraCaCertPaths` is also the supported way to trust internal CAs.

**Tools that verify via trustd** — `gh` and other Go binaries,
SecureTransport apps, cargo's libgit2 transport — ignore PEM bundles and
ask the macOS trust store, which fails with `x509: certificate signed by
unknown authority`. Two pieces fix this: srt's default MITM CA is
ephemeral per session, so `_ccx_ensure_ca` generates a persistent one
(`~/.config/srt/mitm-ca.{crt,key}`, RSA-2048, key mode 600) and
`_ccx_run` injects its paths via `tlsTerminate.{caCertPath,caKeyPath}`
in the per-launch config (those fields do no tilde expansion); then a
one-time `security add-trusted-cert -p ssl` (`just trust-ca`) marks it
SSL-trusted for your user. Whoever holds `mitm-ca.key` can MITM TLS for
apps that trust it; the key is sandbox-unreadable (the `/**/*.key` glob,
and in denyall `~/.config/srt` isn't in `allowRead`), so only host
processes running as you could use it — and those could install their
own CA anyway.

`enableWeakerNetworkIsolation: true` is required: it's what lets
sandboxed processes reach trustd at all (without it `gh` fails the
handshake with `OSStatus -26276` regardless of keychain trust), and
`GH_TOKEN` masking happens inside the terminated stream.

**Cert-pinned or mTLS hosts** break under termination. Add them to
`network.tlsTerminate.excludeDomains` rather than turning termination
off globally; excluded hosts also lose token injection.

## Filesystem rule mechanics

**Glob anchoring.** srt globs are CWD-relative by default: `**/.env*`
becomes `<cwd>/**/.env*`. A leading `/` makes a pattern global —
`/**/.env*` matches any `.env*` file anywhere. All global patterns in
these configs start with `/`.

**Why the `.pem`/`.key` globs are so broad.** They catch non-secret
files too (fixtures, vendored CA bundles, certs under `node_modules`).
That's the cost of coverage: egress is allow-all, so a readable private
key is a direct exfil path, and most private keys use these extensions.
The biggest casualty, system CA bundles, is handled by srt's injected
trust bundle ([above](#tls-inside-the-sandbox)).

**How `denyRead` and `allowRead` interact.** A `denyRead` beats a
*broader* `allowRead` region (`/**/.env*` stays denied under
`allowRead: ["~/src"]`), and a *narrower* `allowRead` beats the deny —
that's how known-safe names are carved out of a broad glob. Under the
hood srt emits the denies, then the allows, then re-emits each glob
deny minus (`require-not`) every allow it covers, since Seatbelt is
last-match-wins. One trap: an allow only counts as a carve-out if it
has the deny glob's *shape* (srt turns each wildcard into `x` and tests
the sample path against the deny's regex). `/**/id_ed25519*.pub` →
`/x/id_ed25519x.pub` matches `/**/id_ed25519*` and carves out;
`/**/id_*.pub` → `/x/id_x.pub` doesn't. Hence the per-key-type `.pub`
entries in both configs.

**Deny globs also cover everything inside a matching folder.** srt
appends `(/.*)?` to glob denies, so `/**/.env*` hides a Python venv
named `.env/` and `/**/credentials` hides a `credentials/` directory.
Rename such venvs to `.venv`. Both configs carve out `.env.example`,
`.env.sample`, `.env.template`, `.env.dist` and public keys. For a
one-off non-secret `.pem`/`.key`, add its exact path or a narrower glob
to `allowRead`, or stage it under a name the glob misses (`.crt`,
`cert.pem.txt`).

**`/private/tmp`, not `/tmp`.** Seatbelt doesn't resolve the symlink in
`(subpath …)` rules, so a bare `/tmp` in `allowWrite` grants nothing.
(`/tmp/claude` is always granted by srt itself.)

**`denyWrite` for Claude's own config.** Writes to
`~/.claude/settings.json` install hooks that execute *outside* the
sandbox on the next start, and `~/.claude/CLAUDE.md` is memory the next
session treats as authoritative. Both are persistence vectors upstream's
auto-deny list doesn't cover.

## Cargo and Rust

Cargo's statically-linked libcurl ignores `SSL_CERT_FILE` and needs
`CARGO_HTTP_CAINFO`, which srt sets under `tlsTerminate`. Both configs
grant writes to `~/.cargo/registry`, `~/.cargo/git` and
`~/.cargo/.package-cache`, so `cargo fetch`/`build` with registry and
git dependencies work (the git transport verifies via trustd and needs
no bundle).

Deliberately not granted: the rest of `~/.cargo` (`~/.cargo/bin` holds
binaries on `$PATH` executed outside the sandbox; `config.toml` could
inject rustc wrappers) and `~/.rustup` (toolchains run outside too). So
`cargo install` and `rustup` run outside, and `cargo publish` can't read
its token inside (`/**/credentials.toml`). Existing toolchains compile
fine inside.

## pnpm and uv

**pnpm** has no TLS problem but, inside the sandbox, silently abandons
its global store and creates a per-project `.pnpm-store/` — losing
dedup and risking an accidental commit. Its store-selection probe
`mkdir`s a scratch dir under the pnpm home root (`~/Library/pnpm`), not
the `store/` subdirectory it actually uses; the configs allow writing
only `~/Library/pnpm/store` (keeping `$PNPM_HOME/bin` unwritable — same
escape-vector reasoning as `~/.cargo/bin`), so the probe hits EPERM and
pnpm concludes the store is unusable. `_ccx_run` therefore pins the
store via `pnpm_config_store_dir` (the env form pnpm ≥10 honours), which
bypasses the probe. Installs then clone from the global store as
normal. `pnpm add -g` still runs outside.

**uv needs nothing.** Its rustls platform verifier goes through trustd,
and `~/.cache/uv` / `~/.local/share/uv` are writable in both configs.

## git credential noise

With the stock `credential.helper = osxkeychain`, git tries to *save*
the proxy credentials after each connection, and the Keychain write is
blocked inside. The operation completes; `fatal: failed to store:
-60008` is cosmetic. Silence it per repo by resetting the helper list
before adding the gh helper (a lone added helper doesn't replace the
global one; an empty entry clears the list):

```bash
git config credential.helper ''
git config --add credential.helper '!gh auth git-credential'
```

## SSH

`/**/id_rsa*` and `/**/id_ed25519*` deny every private key file, and
SSH needs raw key bytes for key-file auth — so SSH works through
**agent forwarding** instead. The agent holds keys in memory and
exposes a signing socket; `_ccx_run` passes `$SSH_AUTH_SOCK` through
and, because Unix-socket connects are gated by Seatbelt *network* rules,
injects the live socket path into `network.allowUnixSockets` in the
per-launch config (the launchd path
`/var/run/com.apple.launchd.<random>/Listeners` changes every login, so
it can't be static JSON; srt realpaths it). Load keys with `ssh-add`
before launching.

`IdentitiesOnly yes` works because public keys are readable: when
OpenSSH can't load a listed private key it reads `<IdentityFile>.pub`
and asks the agent to sign for that key. Both configs carve public keys
out of the deny globs (`/**/id_rsa*.pub`, `/**/id_ed25519*.pub`,
spelled per key type — see [carve-out
shape](#filesystem-rule-mechanics)).

**Transport.** Direct egress is blocked, so the TCP connection must
traverse the proxy. srt sets `GIT_SSH_COMMAND` with a `ProxyCommand`;
with socat on PATH (fork delta 4) that is an authenticated HTTP CONNECT
tunnel — without socat srt falls back to `nc`, which can't authenticate,
and git-over-SSH dies at the handshake. The proxy sniffs for a TLS
ClientHello before MITM-ing, so SSH passes through opaque: crypto stays
end-to-end, the proxy sees only `host:port`, and host-level
`deniedDomains` still apply (the portless `gist.github.com` entry
covers gist-over-SSH). For plain `ssh`/`sftp` reuse the same command:
`eval "$GIT_SSH_COMMAND git@github.com"`.

**Trade-off.** While a session runs, sandboxed code can authenticate as
you to anything the agent holds keys for, though it can't exfiltrate key
material. Mitigate with `ssh-add -c` (confirm every signature) or
hardware-backed keys. SSH traffic also bypasses the proxy's visibility
and token masking; `deniedDomains` is the only lever on that channel.
The HTTPS alternative (`gh auth git-credential` / `glab auth
git-credential`, recipe in the README) keeps GitHub traffic visible to
the proxy and needs no agent. Removing the key globs from `denyRead` is
not recommended: it allows key exfiltration.

## Clipboard and OSC 52

When you copy inside Claude Code (fullscreen mode, e.g.
`CLAUDE_CODE_NO_FLICKER=1`), it shells out to `pbcopy` *and* emits an
OSC 52 escape sequence. `pbcopy` is dead inside the sandbox — it talks
to the pasteboard over a Mach service the generated Seatbelt profile
denies — so the copy lands only if the **terminal** honours OSC 52.
Ghostty, WezTerm, kitty and Alacritty do; iTerm2 does once *Settings →
General → Selection → "Applications in terminal may access the
clipboard"* is on. Pasting with ⌘V works everywhere (it's a terminal
bracketed paste); only clipboard *reads* such as image-paste stay
blocked.

Apple Terminal.app has no OSC 52 support, so the copy is silently lost.
Workaround: [`osc52pty`](https://github.com/roy2220/osc52pty) wraps a
program in a PTY and runs `pbcopy` itself when it sees OSC 52. It must
run *outside* the sandbox, wrapping the whole launch (`osc52pty zsh`,
then `ccx` inside), so no pasteboard access is granted inside. Or just
use an OSC 52-capable terminal.

## gh and glab

**`gh` token, masked.** `gh` keeps its token in the Keychain.
`_ccx_run` extracts it with `gh auth token` outside and passes it as
`$GH_TOKEN`; `credentials.envVars` masks it, so the sandboxed process
sees a structurally valid fake and the TLS-terminating proxy swaps the
real one in — headers and bodies — only on egress to `github.com` /
`*.github.com`. Exfiltrating `$GH_TOKEN` anywhere else leaks a
worthless sentinel; tools that bypass the proxy send the sentinel and
fail GitHub auth. Two config requirements: `injectHosts` must be listed
explicitly (its default is `allowedDomains`, which is `[]` here), and
`tlsTerminate` plus `enableWeakerNetworkIsolation: true` must be on.
The `credentials.*` sub-schema is strict — a typo there is a hard
config-load error. Re-auth flows (`gh auth login` / `refresh` /
`logout`) run outside, since `~/.config/gh` isn't writable inside.

**`glab`** stores its token in a config file
(`~/Library/Application Support/glab-cli`), not the Keychain, so it
needs nothing: denyall `allowRead`s that path, allowall doesn't deny
it. Alternatively inject `GITLAB_TOKEN` in `_ccx_run` the way
`GH_TOKEN` is.

## Using on Linux

Tested on macOS only. `srt` runs on Linux (bubblewrap + seccomp) and
the same patterns should work with these config tweaks:

- Drop the macOS-specific `denyRead` paths (`~/Library/*`,
  `/private/var/folders`, `/private/var/log/jamf.log`, `/opt/cisco`,
  `/etc/krb5.conf`) and add Linux equivalents (`~/.config/*` and
  `~/.mozilla/firefox` for browser/app data, `~/.password-store`,
  `~/.config/keepassxc`, …).
- `/private/tmp` → `/tmp` in `allowWrite`.
- Drop `enableWeakerNetworkIsolation` (macOS-only). `network.allowUnixSockets`
  is also macOS-only (seccomp can't filter by path), so the ssh-agent
  forwarding allowance doesn't apply.
- **Re-verify the credential globs.** Bubblewrap can't glob, so srt
  expands root-anchored patterns to concrete paths at startup. This
  config hasn't been verified on Linux since the 0.0.77 rework of that
  expansion, so probe that `.env` and key files are actually denied
  before relying on it; if root-anchored globs are skipped, narrow
  them (`~/src/**/.env*`).

In the shell functions, the `security find-generic-password` seeding is
macOS Keychain-specific; Claude Code on Linux already uses the file
store, so try `srt -- claude` first and add plumbing only if auth
fails. `srtlog` uses macOS unified logging; use `journalctl` or your
distro's audit log for seccomp/bubblewrap denials. A maintained Linux
variant would be welcome.

## Future directions

srt primitives this config doesn't exercise yet:

- **`credentials.files` masking** — deliberately not adopted: file
  masking is Linux-only (Seatbelt can't redirect reads, so `mask`
  degrades to `deny`), and the `denyRead` globs already cover it.
- **URL/path-level filtering.** The TLS-termination layer sees full
  URLs, so a future schema could allow `github.com` but block
  `*/raw/*`.
- **Egress audit logging.** The proxy observes every destination; a
  log outside the sandbox would give an after-the-fact trail of allowed
  traffic (the violations pipeline covers only denials).
- **External policy via the MITM socket.** `MitmProxyConfigSchema` can
  route domains through an upstream MITM proxy over a Unix socket, so a
  separate policy engine (secret detection, response inspection) could
  plug in without modifying srt.
- **Per-tool egress policies.** `ignoreViolations` varies filesystem
  rules by command; the same idea for network would let npm reach only
  `*.npmjs.org` while claude reaches everywhere.
