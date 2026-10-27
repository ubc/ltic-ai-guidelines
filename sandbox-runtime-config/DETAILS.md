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
4. **SigV4 re-signing with a signed `content-length`**
   (`src/sandbox/tls-terminate-proxy.ts`, 0.0.81-ltic.2): an AWS access
   key id and secret are shorter than srt's sentinel, so body
   substitution can't keep the request length and drops
   `content-length`; a client that signed that header — the AWS CLI's
   high-level `s3` commands, with `UNSIGNED-PAYLOAD` — then left the
   re-signer nothing to cover and got a `403`. The proxy now buffers the
   body (same 64 MiB cap as the literal-hash case) and restores the real
   length before re-signing. Candidate for upstream.

**Retired deltas**, now covered upstream: `denyReadAlways` /
`denyReadAlwaysExcept` (retired at 0.0.77 — a `denyRead` glob now beats
a broader `allowRead`), and the macOS socat `GIT_SSH_COMMAND`
ProxyCommand (retired at 0.0.81 — upstream
[#681](https://github.com/anthropic-experimental/sandbox-runtime/pull/681)
does authenticated git-over-SSH with stock `/usr/bin/nc`; fork PR
[#452](https://github.com/anthropic-experimental/sandbox-runtime/pull/452)
is superseded). socat is no longer a dependency on macOS.

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

### Upstream changes in 0.0.81

macOS-relevant changes from the 0.0.78–0.0.81 sync (upstream PR numbers
in parentheses; 0.0.81 itself is Windows-only):

- **git-over-SSH on macOS uses stock `/usr/bin/nc`** (#681). srt exports
  `SRT_SSH_PROXY_COMMAND`, a shell snippet that sends an authenticated
  `CONNECT` to the session proxy, and `GIT_SSH_COMMAND` whose
  `ProxyCommand` evals it. The proxy token lives in that variable, never
  in ssh's argv. See [SSH](#ssh).
- **A refused `CONNECT` carries the deny reason as its `403` status
  phrase** (#681), so `curl -I`, git and ssh print it in-band; the
  violations file still gets the same line.
- **Node ≥ 22.12 is required** (#636).
- **New `network.requireHostMatch`** (#663): a request inside a tunnel
  whose `Host`, TLS server name or absolute-form authority doesn't name
  the `CONNECT` target gets `421` and a violation. Adopted in both
  configs ([why](#tls-inside-the-sandbox)). Also new, not adopted:
  `refuseOpaqueTunnels` (would refuse SSH), `ambiguousRequestTarget`
  (#698), `stripResponseHeaders` and `allowPlaintextHeaderSet` (only
  matter with a library-level `filterRequest` callback).
- **TLS termination runs in-process** (#665, #700): no per-tunnel
  listener or socket file. New `tlsTerminate.maxTunnels` (default 256;
  past it a `CONNECT` gets `503` with `X-Proxy-Error: too-many-tunnels`
  and a violation) and `tlsTerminate.handshakeTimeoutMs` (default
  10000).
- **Glob brackets** (#620–#622, #687, #718): a path entry whose
  characters read as a pattern is also read as the literal path it
  spells, where that exists; brackets that spell no character set
  (`[user-id]`, `backup[2024-01-15]`) are text; `*` or `?` inside
  brackets is a set member. `{ "path": "…", "literal": true }` marks an
  entry literal in any of the four filesystem lists.
- **Read rules apply under both spellings of a path** on macOS, as
  written and with symlinks resolved (#680). `credentials.files` entries
  beat `allowRead` / `allowWrite` on every platform (#680, #686); not
  used here.
- **Library self-protection** (#595): a wrapped command is write-denied
  srt's own install directory, and `checkDependencies()` warns when srt
  is installed somewhere the sandbox can write. Under nvm that is
  `~/.nvm/…`, which neither config grants write to.
- **Proxy robustness**: an upstream answering with an invalid status
  line gets `502` instead of crashing the proxy (#660); a body longer
  than its `Content-Length` is passed whole (#717); certificate serials
  never start with a zero byte (#685).
- **Temp files**: `process.exit()` or a failed `initialize()` no longer
  leave a generated CA key behind (#670); these configs use a
  persistent CA anyway.
- The ask callback only allows on `true` (#591); the CLI has none.

### Upgrade notes by version

`just upgrade` handles the generic path (rebuild srt, re-copy configs,
reinstall shell functions and hook, verify). Per-version specifics, for
anyone migrating customized configs by hand:

**0.0.81-ltic.1 → 0.0.81-ltic.2 (AWS support).** `just upgrade` covers
it: the srt rebuild carries fork delta 4 (without it `aws s3 cp` / `rm`
inside get a `403`), and `install-shell` / `install-configs` pick up the
`CCX_AWS_PROFILES` plumbing. A customized config needs one new
`ignoreViolations["*"]` entry, `"/.aws/cli/cache/session.db"`. Behaviour
change: the outer shell's `AWS_*` credential variables no longer enter
the sandbox — use `CCX_AWS_PROFILES` ([why](#aws-credentials)).

**0.0.77-ltic.1 → 0.0.81-ltic.1.** No config migration. socat is no
longer needed (`just deps` and `just check` stop asking for it; `brew
uninstall socat` is optional). Node must be ≥ 22.12. Both configs gained
`"requireHostMatch": true` under `network` and three ssh-hop entries in
`ignoreViolations["*"]` (`mach-lookup com.apple.dnssd.service`,
`mach-lookup com.apple.usymptomsd`, `/.zshenv`); a customized config
should copy those two edits by hand. `just check` gained a
git-over-SSH smoke test (skipped when the agent holds no keys).

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
dependencies (`brew install socat jq`; socat dropped again at 0.0.81);
both configs gained `tlsTerminate`, `GH_TOKEN` masking
(`credentials.envVars`), global credential globs,
`deniedDomainReasons` and `ignoreViolations`; the
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
   (`"*"` = all) to substrings to suppress. Four entries cover benign
   macOS noise every process emits; three more cover what every
   sandboxed `ssh` hop emits — ssh runs its `ProxyCommand` via
   `$SHELL -c`, so a fresh zsh reads `~/.zshenv` (denied, harmless),
   and ssh probes the `com.apple.dnssd.service` and
   `com.apple.usymptomsd` Mach services. Without those, each `git push`
   handed the agent three non-actionable "denials". Extend it if
   recurring non-actionable noise shows up.

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

**`requireHostMatch`.** Policy and token injection are decided on the
`CONNECT` target (`api.github.com:443`), but the bytes inside the tunnel
carry their own names: the TLS server name and the `Host` header.
Without a check, sandboxed code could `CONNECT` to `github.com` (so the
real `GH_TOKEN` gets injected) while addressing the request to another
host behind the same front door. With `requireHostMatch: true` the
proxy answers `421` when the server name, `Host` or absolute-form
authority doesn't name the `CONNECT` host and port, mints the leaf
certificate for the `CONNECT` target regardless of the requested name,
and records the refusal as a violation. Well-behaved clients always
match; only deliberate domain fronting breaks, and it breaks visibly.

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
traverse the proxy. srt sets `GIT_SSH_COMMAND` whose `ProxyCommand`
runs `/bin/sh -c 'eval "$SRT_SSH_PROXY_COMMAND" sh %h %p'`; that
script (also exported to the environment) sends an authenticated
`CONNECT %h:%p` to the session proxy through `/usr/bin/nc`, reads the
response head, and relays with `cat`. The proxy token travels in the
variable, not in ssh's argv, and nothing beyond what macOS ships is
needed. A refused destination prints `sandbox proxy: host:22: 403
<reason>` on stderr and ssh exits. The proxy sniffs for a TLS
ClientHello before MITM-ing, so SSH passes through opaque: crypto stays
end-to-end, the proxy sees only `host:port`, and host-level
`deniedDomains` still apply (the portless `gist.github.com` entry
covers gist-over-SSH). For plain `ssh`/`sftp` reuse the same command:
`eval "$GIT_SSH_COMMAND git@github.com"`; a bare `ssh github.com` has
no ProxyCommand and fails to resolve the host.

**Trade-off.** While a session runs, sandboxed code can authenticate as
you to anything the agent holds keys for, though it can't exfiltrate key
material. Mitigate with `ssh-add -c` (confirm every signature) or
hardware-backed keys. SSH traffic also bypasses the proxy's visibility
and token masking; `deniedDomains` is the only lever on that channel.
The HTTPS alternative (`gh auth git-credential` / `glab auth
git-credential`, recipe in the README) keeps GitHub traffic visible to
the proxy and needs no agent. A stricter posture would add
`github.com:22` and `ssh.github.com` to `deniedDomains` (with a
`deniedDomainReasons` entry pointing at the HTTPS recipe) so every
GitHub interaction goes through the masked token; not adopted here
because SSH remotes are still the documented push path. Removing the
key globs from `denyRead` is not recommended: it allows key
exfiltration.

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

## AWS credentials

Both postures deny `~/.aws` (and the `/**/credentials` glob covers the
credentials file anyway), so `aws` and boto3 find no profiles inside.
Opening `~/.aws` would hand the sandbox real keys — every `la-*` profile
is an admin role — so the wrapper instead reuses the `GH_TOKEN` mechanism
with AWS's own twist: **SigV4 re-signing**.

**Masking plus pairs.** A SigV4 signature is an HMAC over the request
derived from the secret key, so swapping a sentinel for the real secret in
a header is not enough — the whole signature has to be recomputed. srt's
`credentials.awsPairs` links a masked access key id, secret and session
token into one credential: a request whose credential scope names the
fake access key id is re-signed with the real pair on egress to the
key-id entry's `injectHosts` (`*.amazonaws.com`); every other request is
untouched. The per-launch config gets, for each profile named in
`CCX_AWS_PROFILES`, three `mode: "mask"` entries under per-profile names
(`CCX_AWS_LA_SHARED_ACCESS_KEY_ID`, …) and one `awsPairs` entry. Several
profiles coexist because each pair is keyed on its own fake access key
id. Nothing is added when the variable is unset, so the config is then
byte-identical to the one `just install-configs` copied.

**Exporting outside.** `aws configure export-credentials --profile P
--format process` runs *outside* the sandbox, where `~/.aws` is readable.
It covers both credential shapes used here without special-casing:
saml2aws profiles (temporary keys saml2aws wrote to `~/.aws/credentials`)
and IAM Identity Center profiles (role credentials minted from the cached
SSO token, exactly as `just hc-export` does). It is preceded by `aws sts
get-caller-identity --profile P`, because `export-credentials` happily
returns an expired saml2aws key set (the CLI knows nothing of saml2aws's
`x_security_token_expires`); the STS call fails for expired and unknown
profiles alike, and its ARN is echoed at launch so you can see which role
each profile carries. Logins (`just login`, `just hc-login`, `aws sso
login`) therefore stay outside, and the credentials are a snapshot:
nothing inside can refresh them, so a saml2aws session (1 h) means a
relaunch, the same way the Claude token does after ~8 h.

**Why a generated AWS config.** botocore drops the environment credential
provider as soon as a profile is named explicitly (`--profile`,
`AWS_PROFILE`, `boto3.Session(profile_name=…)`), and the LA justfile names
one on every call. So the wrapper writes `$TMPDIR/aws-config` — pointed
at via `AWS_CONFIG_FILE` — with a `[profile P]` block per named profile
(region copied from your `~/.aws/config`, falling back to
`AWS_DEFAULT_REGION`, then `ca-central-1`) whose `credential_process` is
a tiny helper, `$TMPDIR/aws-cred <STEM>`, that prints that profile's
masked variables in the JSON shape botocore expects. The first named
profile is also `[default]`. The file and helper hold variable *names*
only. `AWS_SHARED_CREDENTIALS_FILE` points at a nonexistent path so the
CLI stops probing `~/.aws/credentials` (a violation line per call), and
`AWS_EC2_METADATA_DISABLED=true` stops the IMDS probe the proxy
otherwise refuses with a `169.254.169.254` denial. Both configs also
ignore the `~/.aws/cli/cache/session.db` metadata read aws-cli v2 makes
on every invocation.

**The outer shell's variables.** `_ccx_run` launches srt from a subshell
that first unsets `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and friends, then exports
the masked trios. Before this, a real key set exported in your shell
(`eval "$(just hc-export …)"`) entered the sandbox unmasked; now the only
way AWS credentials get in is `CCX_AWS_PROFILES`.

**What the proxy cannot re-sign.** Three SigV4 shapes are refused with a
`403` naming the case (`credentials.sigv4`, left at its fail-closed
defaults): aws-chunked streaming uploads (`x-amz-content-sha256:
STREAMING-*`, whose per-chunk signatures chain off the seed), presigned
URLs (the signature is in the URL) and SigV4A (asymmetric, nothing to
recompute). aws-cli ≥ 2.23 and recent SDKs upload in the streaming
trailer form by default for checksums, so the wrapper sets
`AWS_REQUEST_CHECKSUM_CALCULATION=when_required` (and the response
counterpart): uploads then sign `UNSIGNED-PAYLOAD` over TLS. Requests
that sign a literal body hash, or `content-length` (the CLI's `s3`
commands do; see [fork delta 4](#the-fork)), are buffered (64 MiB cap) so
the proxy can recompute the hash or restore the length over the bytes it
forwards; other `UNSIGNED-PAYLOAD` requests stream through. Verified
inside the sandbox: `aws s3 cp`, `aws s3 rm --recursive`, `s3api
put-object`, boto3 `put_object` and `upload_file`.

**Residual risk.** Masking stops credential *theft*: the real secret
never exists inside, a leaked sentinel is worthless elsewhere, and the
credentials expire with the session. It does not stop *use*: the agent
can run whatever the named roles allow, which here means admin, so name
the narrowest profiles that do the job and let Claude Code's permission
prompts do their work. One subtlety shared with the `GH_TOKEN` masking:
srt substitutes sentinels in request *bodies* at injectHosts too (so a
tool that puts a credential in a JSON payload still works), with no
opt-out — a deliberately malicious agent could therefore launder the real
secret through an AWS-hosted sink it can write to (an S3 object, an API
Gateway it controls). Strictly better than real keys in the sandbox, but
not nothing; the hour-long credential lifetime is the backstop.

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
  them (`~/src/**/.env*`). The expansion walk is ~6× faster since
  0.0.81 and no longer blocks the event loop (#627 ff.).
- **Sandboxed commands stay in their namespaces** since 0.0.81 (#588,
  #617): no new user or mount namespaces by default, so Chromium /
  Electron's own sandbox, rootless podman / buildah, nested bubblewrap
  and `unshare -r` fail inside. `allowNestedUserNamespaces: true` lifts
  it, at the cost of `denyWrite` enforcement against a hostile command;
  needs the seccomp helper, or bubblewrap ≥ 0.8.0 not installed setuid.
- **`denyWrite` beats `allowWrite` however nested** (#684): `denyWrite:
  ["~"]` makes a project under `~` read-only, and `denyWrite: ["/tmp"]`
  makes the sandbox's own `TMPDIR` read-only.
- Fixes in 0.0.81: bubblewrap 0.4 starts again (#580); a command's first
  network call is no longer refused because the in-sandbox relays
  weren't listening yet (#639); relays fall back to IPv4 without IPv6
  (#719).

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
- **URL/path-level filtering.** Since 0.0.81 the library's
  `filterRequest` callback can rewrite and observe: an allow may carry
  `removeHeaders`, `setHeaders` and `onResponse`, a deny may choose its
  status, and the callback sees `scheme`, `sni`, `target` and
  `rawHeaders` (#663). That is enough to allow `github.com` but block
  `*/raw/*` — but it is a library API, not reachable from a
  `srt --settings` config.
- **Egress audit logging.** Still open. The proxy observes every
  destination; a log outside the sandbox would give an after-the-fact
  trail of allowed traffic (the violations pipeline covers only
  denials).
- **External policy engine.** Upstreamed as `srt proxy` / `srt-proxy`
  (#666, #668): the HTTP proxy alone, with an external decider process
  answering every request (`docs/srt-proxy.md` in the fork checkout).
  A separate policy engine (secret detection, response inspection) can
  plug in without modifying srt; wiring it to the CLI's sandbox is the
  remaining work.
- **Per-tool egress policies.** Upstream now has the primitive:
  `SandboxManager.registerCommandNetworkLists(commandId, {
  allowedDomains })`, keyed by the proxy username each wrap presents
  (#591). Library-level only; a config-file spelling would be the
  fork delta that lets npm reach only `*.npmjs.org` while claude
  reaches everywhere.
