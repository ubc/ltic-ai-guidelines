# Sandboxed Claude Code on macOS

Settings files and shell functions for running
[Claude Code](https://claude.com/claude-code) inside a sandbox provided
by [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
— Anthropic's general-purpose process sandbox; `srt` is its CLI. These
configs require a [patched
fork](https://github.com/ubc/sandbox-runtime/tree/ltic-main)
that adds two schema fields: `allowAllDomains` (drop the egress allowlist)
and `denyReadAlways` (read denies that beat `allowRead`). See *Setup*
for why each is needed. All web egress is allowed — filesystem
restrictions are the primary boundary.

## Contents

| File | Purpose |
|---|---|
| `.srt-claude-denyall.json` | Restrictive posture — default-deny reads under `/Users`, explicit allow-list |
| `.srt-claude-allowall.json` | Permissive posture — default-allow reads, explicit deny-list for sensitive paths |
| `.zshrc.example` | Shell functions (`ccx`, `ccx_permissive`, `srtlog`) for zsh |
| `.bashrc.example` | Same functions ported to bash |

## The two postures

### `ccx` — restrictive (uses `.srt-claude-denyall.json`)

Denies reads under `/Users` and re-allows only the specific paths Claude
needs (`~/src`, `~/.config/gh`, `~/.gitconfig`, `~/.ssh/config`, etc).
Anything you forget to allow stays blocked. Use this when you're not
sure what Claude needs to touch and you'd rather be told.

### `ccx_permissive` — permissive (uses `.srt-claude-allowall.json`)

Allows reads broadly under `/Users` but blocks an enumerated set of
sensitive paths: `~/.aws`, `~/.gnupg`, `~/.docker/config.json`, shell
histories (`.zsh_history`, `.viminfo`, …), browser data, Slack/Signal/
iMessage caches, `~/Documents`/`~/Desktop`/`~/Downloads`, all mounted
volumes (`/Volumes`), and the enterprise/Cisco paths
(`/opt/cisco`, `/etc/krb5.conf`, …). Use this when the strict posture is
generating too much friction.

### Shared between both

- **`allowAllDomains: true`** — no DNS allow-list; everything except
  explicit denies is reachable. Requires the forked `srt` (see *Setup*
  below).
- **`deniedDomains: ["gist.github.com"]`** — explicit denies still take
  precedence over allow-all, closing one easy exfil channel via the
  general `github.com` reachability.
- **`denyReadAlways`** (`/**/.env*`, `/**/credentials`, `/**/id_*`,
  `/**/*.pem`, `/**/*.key`, etc.) — credential-style globs that deny
  reads **everywhere**, including inside paths that `allowRead`
  re-allows. Without this, an `.env` file inside an `allowRead`'d
  directory like `~/src` would be readable. Requires the forked `srt`.
  See *Glob anchoring* below for why these patterns start with `/`.
- **`denyWrite`** for `~/.claude/settings.json`,
  `~/.claude/settings.local.json`, and `~/.claude/CLAUDE.md` — closes
  sandbox-escape / persistence vectors: writes to `settings.json`
  install Claude Code hooks that execute *outside* the sandbox on the
  next start; `CLAUDE.md` is user-level memory the next session reads
  as authoritative. The auto-deny list in upstream `srt` does not
  cover these files.
- **`allowWrite`** uses `/private/tmp`, not `/tmp` — Seatbelt does not
  resolve the `/tmp → /private/tmp` symlink in `(subpath …)` allow
  rules, so a bare `/tmp` allow grants nothing. (`/tmp/claude` is
  always granted by `srt` itself regardless.)
- **`enableWeakerNetworkIsolation: true`** — needed for `gh` and other
  Go binaries to use macOS trustd for TLS verification through the
  MITM proxy.

#### Glob anchoring (gotcha)

`srt`'s glob patterns are CWD-relative by default: a pattern like
`**/.env*` gets normalized to `<cwd>/**/.env*` and only matches files
under wherever Claude was launched from. To match globally, **start the
pattern with a leading `/`** — `/**/.env*` resolves to the regex
`^/(.*/)?\.env[^/]*$` and matches any `.env*` file anywhere on the
filesystem. The configs in this repo use leading `/` for all global
patterns.

## Setup

### 1. Install the patched `srt` from the fork

Upstream `srt` has two limitations these configs need to work around:

1. **No "allow all egress" mode.** The schema rejects `"*"` in
   `allowedDomains`, and there is no flag to disable network
   filtering from a config file. Our fork adds an
   `allowAllDomains: true` schema field that short-circuits the
   allowlist **after** `deniedDomains` is checked.
2. **`allowRead` unconditionally beats `denyRead`.** That means a
   broad `allowRead` like `~/src` exposes every `.env` and credential
   file inside, regardless of what you put in `denyRead`. Our fork
   adds a third layer, `denyReadAlways`, that emits deny rules
   **after** the allowRead rules so they win — letting credential
   globs like `/**/.env*` actually do something inside an allowed
   directory.

The branch `ltic-main` contains both features merged on top of upstream main (tracks PRs #283 and #284):

```bash
git clone https://github.com/ubc/sandbox-runtime.git
cd sandbox-runtime
git checkout ltic-main
npm install           # fetch build deps
npm run build         # build dist/
npm install -g .      # install srt globally (goes in nvm's node bin, already on $PATH)
```

Verify the install:

```bash
which srt          # → ~/.nvm/versions/node/<ver>/bin/srt
srt --version      # → 0.0.62-ltic.1   (the -ltic suffix confirms the patched fork)
```

The `-ltic.N` suffix is the quick check that you're on the patched
fork and not upstream `srt`: the `ltic-main` branch stamps a
distinctive version and reads it from `package.json` at runtime, so
`srt --version` is a reliable build identifier. Upstream stock `srt`
reports a plain version with no `-ltic` suffix.

For defense-in-depth (or if you're on an older build before the
version stamp), confirm functionally that `allowAllDomains` is
honored — upstream stock `srt` *silently drops* the unknown
`allowAllDomains` key during schema validation (requires the config
files from step 2 below):

```bash
srt --settings ~/.srt-claude-denyall.json -- \
  curl -sI --max-time 5 https://example.com/ | head -1
# HTTP/2 200 ...   → patched srt: allowAllDomains is honored
# (no output / hang) → stock srt: example.com isn't in allowedDomains,
#                       so the connection was blocked at the proxy
```

PRs tracking the patches upstream:
- [#283 — allowAllDomains](https://github.com/anthropic-experimental/sandbox-runtime/pull/283)
- [#284 — denyReadAlways](https://github.com/anthropic-experimental/sandbox-runtime/pull/284)
  (stacks on #283)

Once both merge, you can skip the fork step and install the published
package: `npm install -g @anthropic-ai/sandbox-runtime`.

### 2. Copy the config files into your home directory

```bash
cp .srt-claude-denyall.json .srt-claude-allowall.json ~/
```

### 3. Wire up the shell functions

**zsh** — append the example to your `~/.zshrc`:
```bash
cat .zshrc.example >> ~/.zshrc
```

**bash** — append to `~/.bashrc` (or `~/.bash_profile` on macOS, which
is what login shells source by default):
```bash
cat .bashrc.example >> ~/.bash_profile
```

Then `source ~/.zshrc` (or open a new terminal).

**other shells**

One option is to reuse the existing bashrc example, but wrap it in some entrypoint scripts.

e.g.
```bash
cp .bashrc.example ~/.claude-sandbox.bash

printf '#!/usr/bin/env bash\n source ~/.claude-sandbox.bash\n ccx "$@"\n' > ~/.local/bin/ccx
printf '#!/usr/bin/env bash\n source ~/.claude-sandbox.bash\n ccx_permissive "$@"\n' > ~/.local/bin/ccx_permissive
printf '#!/usr/bin/env bash\n source ~/.claude-sandbox.bash\n srtlog "$@"\n' > ~/.local/bin/srtlog
chmod +x ~/.local/bin/ccx ~/.local/bin/ccx_permissive ~/.local/bin/srtlog
```

### 4. Use it

```bash
cd ~/src/your-project
ccx              # strict sandbox
ccx_permissive   # deny-list sandbox
```

`srtlog` tails macOS sandbox-exec denials in real time (or pass a
number for "last N minutes" of history). Useful when something inside
the sandbox fails with EPERM and you want to know why.

## What the shell functions do

Two non-obvious things `_ccx_run` handles:

**Claude OAuth credential plumbing.** Claude Code's OAuth credential
lives in the macOS Keychain. The sandbox denies `~/Library/Keychains`,
so Claude can't read its own credentials from inside. Claude Code has a
two-tier credential store (`fallbackStorage`): it tries the Keychain
first and falls back to a file, `~/.claude/.credentials.json`, when the
Keychain read fails — which is exactly what happens inside the sandbox.
The function seeds that file from the Keychain *outside* the sandbox so
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

When the access token expires, the session simply stops authenticating;
refresh it the normal way (see the token-expiry gotcha below). The file
is seeded on **every launch** (overwrite), because without in-sandbox
refresh it can't renew itself — the Keychain is the source of truth and
the file is just a per-launch snapshot. There is no cleanup-on-exit:
Claude re-reads the credential store mid-session, so removing the file
could yank it out from under a concurrent `ccx`; a stale expired token
sitting between sessions is harmless and gets overwritten on the next
launch.

**Security tradeoff (deliberate).** The access token now lands on disk
at `~/.claude/.credentials.json` (mode 600) for the life of the session,
rather than streaming through a pipe and never touching disk (the old
FIFO/FD design). The refresh token does **not** — it is nulled out. The
file is readable inside the sandbox only because, being a dotfile, it
escapes the `/**/credentials.json` deny glob (see *Glob anchoring* — the
leading `.` means the pattern doesn't match, so this is fragile:
tightening that pattern would lock Claude out of its own credentials).

**`gh` token injection.** `gh` also stores its token in the Keychain.
The function extracts it via `gh auth token` outside the sandbox and
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
subcommands should work as-is. As an alternative to the config file,
you can inject `GITLAB_TOKEN` in `_ccx_run` the same way `GH_TOKEN` is
injected — `glab` reads it directly and it works regardless of whether
the config path is accessible.

## Known gotchas

Each item is labelled *(both)*, *(denyall)*, or *(allowall)* to indicate
which config posture it affects.

- **The access token expires roughly every 8 hours and must be refreshed outside the sandbox.**
  *(both)* Claude Code's access token has a ~8-hour lifetime, and the shell functions null the
  refresh token before seeding the file, so the sandbox cannot refresh on its own. When the
  token expires, Claude fails to authenticate from inside the sandbox — the sandboxed process
  cannot reach the Keychain or complete the browser-based re-auth flow. **To refresh: exit the
  sandbox, run `claude` once in a normal terminal (it silently re-auths against the Keychain),
  then relaunch with `ccx` or `ccx_permissive`.** Each launch re-seeds the file from the
  Keychain, so the restart picks up the freshly refreshed credential. Because the sandbox never
  refreshes, it never rotates the Keychain's refresh token — the Keychain stays authoritative and
  this outside-refresh loop keeps working indefinitely.

- **The access token lands on disk for the session; the refresh token does not.** *(both)* The
  seeded `~/.claude/.credentials.json` (mode 600) holds the short-lived access token but has its
  `refreshToken` nulled, so the long-lived credential never touches disk — a deliberate weakening
  of the old FIFO/FD "nothing on disk" property, scoped to the throwaway token. The file survives
  the `denyReadAlways` globs only because it is a dotfile (`/**/credentials.json` does not match
  `.credentials.json`) — fragile, see *Glob anchoring*.

- **All SSH operations are blocked — git over SSH, interactive `ssh` login, and `sftp`.**
  *(both)* `denyReadAlways` includes `/**/id_*` (shared between both configs), which covers
  every private key file (e.g. `~/.ssh/id_ed25519-github`). SSH needs to read the raw key
  bytes for the initial handshake, so any SSH-based operation fails with EPERM.
  There is no `!` escape from inside the sandbox. Two workarounds:

  - **Option A — HTTPS + GH_TOKEN (GitHub only).** For `git push`/`git pull`, switch to
    HTTPS and use `gh auth git-credential` as the credential helper (see next bullet).
    Simpler and scopes the credential to GitHub HTTPS only.

  - **Option B — SSH agent forwarding (any SSH target).** The SSH agent holds keys in
    memory and exposes only a sign-once socket — clients authenticate through it without
    reading raw key bytes. To enable: in `_ccx_run`, capture `$SSH_AUTH_SOCK` *outside*
    the sandbox, add `allowRead` for that socket path (on macOS it's something like
    `/private/tmp/com.apple.launchd.*/Listeners`), and pass the env var in.
    Trade-off: Claude can authenticate as you to any SSH service reachable over the network,
    but cannot exfiltrate the key material itself.

  - **Option C — remove `/**/id_*` from `denyReadAlways`.** Gives Claude read access to
    raw private key bytes. This allows key exfiltration over the network and is not
    recommended unless the threat model explicitly accepts it.

- **`git push`/`git pull` over HTTPS works with a one-time credential helper setup.**
  *(both)* For GitHub, since `GH_TOKEN` is already injected (see *What the shell functions
  do*), point git at `gh auth git-credential` and it will use the token directly — no
  Keychain, no `~/.config/gh` access needed:
  ```bash
  # GitHub — one-time setup per repo
  git remote set-url origin https://github.com/ORG/REPO.git
  git config credential.helper '!gh auth git-credential'
  ```
  For GitLab, `glab`'s config is readable inside the sandbox (see *What the shell functions
  do*), so the equivalent works without any extra token injection:
  ```bash
  # GitLab — one-time setup per repo
  git remote set-url origin https://gitlab.com/ORG/REPO.git
  git config credential.helper '!glab auth git-credential'
  ```
  After either setup, `git push` and `git pull` resolve credentials through the respective
  CLI without touching the Keychain.

- **`gh api`, `gh pr`, `gh issue`, and other `gh` subcommands work as-is.**
  *(both)* The injected `$GH_TOKEN` is enough; no re-auth or keychain access is required.

- **`gh auth login` from inside the sandbox fails.** *(both)* Neither config grants write
  access to `~/.config/gh`. Auth outside, run `gh` inside.

- **Tools that write directly to `/tmp/<not-claude>/...`** *(both)* will hit
  EPERM despite `/tmp` (canonically `/private/tmp`) being in
  `allowWrite`. Most CLIs respect `$TMPDIR` which `srt` overrides to
  `/tmp/claude`, so this is rare in practice.

- **Bare `/tmp` in `allowWrite` is a no-op** *(both)* in upstream `srt` — the
  symlink isn't resolved for subpath allows. The configs in this repo
  use `/private/tmp` to work around this. Tracked / could be a
  separate upstream patch.

- **Concurrent `ccx` sessions are isolated** *(both)* via per-PID
  `/tmp/claude/ccx-<pid>` TMPDIRs. No cleanup required — `/tmp` is
  wiped on reboot.

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

## Rationale for the design choices

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

## Future directions

`srt` has primitives this config doesn't exercise yet. Worth exploring
if/when the current posture isn't enough:

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
