# Sandboxed Claude Code on macOS

Settings files and shell functions for running
[Claude Code](https://claude.com/claude-code) inside
[sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
(`srt`), Anthropic's general-purpose process sandbox. All web egress is
allowed — filesystem restrictions are the primary boundary
([why](DETAILS.md#why-these-design-choices)). Requires a
[patched fork](https://github.com/ubc/sandbox-runtime/tree/ltic-main)
of `srt` ([what it adds and why](DETAILS.md#the-fork)).

This README covers setup and day-to-day use. The reasoning, history,
and deep dives live in [DETAILS.md](DETAILS.md).

## Contents

| File | Purpose |
|---|---|
| `.srt-claude-denyall.json` | Restrictive posture — default-deny reads under `/Users`, explicit allow-list |
| `.srt-claude-allowall.json` | Permissive posture — default-allow reads, explicit deny-list for sensitive paths |
| `.zshrc.example` | Shell functions (`ccx`, `ccx_permissive`, `srtlog`) for zsh |
| `.bashrc.example` | Same functions ported to bash |
| `DETAILS.md` | Design notes and deep dives behind the callouts here |

## The two postures

### `ccx` — restrictive (uses `.srt-claude-denyall.json`)

Denies reads under `/Users` and re-allows only the specific paths Claude
needs (`~/src`, `~/.config/gh`, `~/.gitconfig`, `~/.ssh/config`, etc).
Anything you forget to allow stays blocked. Use this when you're not
sure what Claude needs to touch and you'd rather be told.

### `ccx_permissive` — permissive (uses `.srt-claude-allowall.json`)

Allows reads broadly under `/Users` but blocks an enumerated set of
sensitive paths: `~/.aws`, `~/.gnupg`, `~/.docker/config.json`, shell
histories, browser data, Slack/Signal/iMessage caches,
`~/Documents`/`~/Desktop`/`~/Downloads`, `/Volumes`, and
enterprise/Cisco paths. Use this when the strict posture is generating
too much friction.

### Shared between both

- **`allowAllDomains: true`** — no domain allow-list; requires the
  forked `srt` ([details](DETAILS.md#the-fork)).
- **`deniedDomains: ["gist.github.com"]`** — explicit denies beat
  allow-all; closes one easy exfil channel.
- **`denyReadAlways`** — credential globs (`/**/.env*`, `/**/*.pem`,
  `/**/id_*`, …) that deny reads everywhere, even inside `allowRead`'d
  paths. Fork-only field; patterns need a leading `/` to be global
  ([details](DETAILS.md#filesystem-rule-mechanics)).
- **`denyWrite`** for `~/.claude/settings*.json` and
  `~/.claude/CLAUDE.md` — closes hook-installation persistence vectors
  ([details](DETAILS.md#filesystem-rule-mechanics)).
- **`allowWrite`** uses `/private/tmp`, not `/tmp` — Seatbelt doesn't
  resolve the symlink ([details](DETAILS.md#filesystem-rule-mechanics)).
- **`enableWeakerNetworkIsolation: true`** — required for trustd-based
  TLS verification (`gh`, Go binaries, etc.)
  ([details](DETAILS.md#tls-inside-the-sandbox)).
- Cert-pinned / mTLS hosts can be excluded per-domain via
  `network.tlsTerminate.excludeDomains` — not set here
  ([details](DETAILS.md#tls-inside-the-sandbox)).

## Setup

### 1. Install the patched `srt` from the fork

Upstream `srt` has no allow-all-egress mode and ignores glob denies
inside `allowRead` regions; the fork adds `allowAllDomains` and
`denyReadAlways` to fix both ([details](DETAILS.md#the-fork), upstream
PRs [#283](https://github.com/anthropic-experimental/sandbox-runtime/pull/283)
and [#284](https://github.com/anthropic-experimental/sandbox-runtime/pull/284) —
once merged, plain `npm install -g @anthropic-ai/sandbox-runtime` will do).

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

Functional check that `allowAllDomains` is honored — stock `srt`
silently drops the unknown key (needs the configs from step 2; the
`--cacert` staging matters, [details](DETAILS.md#the-fork)):

```bash
mkdir -p /tmp/claude && cp /etc/ssl/cert.pem /tmp/claude/ca-bundle.crt
srt --settings ~/.srt-claude-denyall.json -- \
  curl --cacert /tmp/claude/ca-bundle.crt -s -o /dev/null \
       -w '%{http_code}\n' --max-time 5 https://example.com/
# 200          → patched srt: allowAllDomains is honored
# 000 / hang   → stock srt: the connection was blocked at the proxy
```

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

**other shells** — reuse the bashrc example via entrypoint scripts:
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

`_ccx_run` handles several pieces of plumbing on every launch:

- **Seeds Claude's credentials** — copies the OAuth credential from the
  Keychain (unreadable inside) to `~/.claude/.credentials.json`, with
  the refresh token nulled so only the short-lived access token touches
  disk ([details](DETAILS.md#credential-plumbing)).
- **Stages a CA bundle** — copies `/etc/ssl/cert.pem` (blocked inside by
  the `*.pem` glob) to `$td/ca-bundle.crt` and sets `SSL_CERT_FILE`,
  `CURL_CA_BUNDLE`, `CARGO_HTTP_CAINFO`, `GIT_SSL_CAINFO`,
  `REQUESTS_CA_BUNDLE` — fixes cargo, curl, git-over-HTTPS, python TLS
  ([details](DETAILS.md#tls-inside-the-sandbox)).
- **Injects `GH_TOKEN`** via `gh auth token`, so `gh` works inside
  ([details](DETAILS.md#gh-and-glab)). `glab` needs nothing — it reads
  its own config file.
- **Pins pnpm's global store** via `pnpm_config_store_dir`, preventing
  silent per-project `.pnpm-store/` fallback
  ([details](DETAILS.md#pnpm-and-uv)).
- **Per-PID `TMPDIR`** (`/tmp/claude/ccx-<pid>`) so concurrent sessions
  don't trample each other.

## Known gotchas

Each item is labelled *(both)*, *(denyall)*, or *(allowall)* for which
posture it affects.

- **Access token expires every ~8h.** *(both)* The sandbox can't
  refresh. Exit, run `claude` once in a normal terminal, relaunch
  `ccx` ([details](DETAILS.md#credential-plumbing)).

- **`.pem`/`.key` files are blocked everywhere — including non-secret
  ones.** *(both)* System CA bundles are handled automatically by the
  CA staging; for anything else, rename/copy to `.crt` or `.pem.txt`
  ([details](DETAILS.md#filesystem-rule-mechanics)).

- **cargo works inside; `cargo install`, `cargo publish`, and `rustup`
  run outside.** *(both)* Registry/git caches are writable;
  `~/.cargo/bin` and `~/.rustup` deliberately aren't
  ([details](DETAILS.md#cargo-and-rust)).

- **pnpm works via the pinned global store; `pnpm add -g` runs
  outside.** *(both)* Without the pin it silently creates a per-project
  `.pnpm-store/`. uv needs nothing
  ([details](DETAILS.md#pnpm-and-uv)).

- **git prints `fatal: failed to store: -60008` noise but succeeds.**
  *(both)* The osxkeychain helper can't save proxy credentials inside;
  harmless. Silence per repo ([details](DETAILS.md#git-credential-noise)):
  ```bash
  git config credential.helper ''
  git config --add credential.helper '!gh auth git-credential'
  ```

- **All SSH is blocked** — git-over-SSH, `ssh`, `sftp` — because raw
  private keys are unreadable. *(both)* Use HTTPS + token (below), or
  SSH agent forwarding ([details](DETAILS.md#ssh)).

- **`git push`/`git pull` over HTTPS works with a one-time credential
  helper setup.** *(both)*
  ```bash
  # GitHub — one-time setup per repo
  git remote set-url origin https://github.com/ORG/REPO.git
  git config credential.helper '!gh auth git-credential'

  # GitLab — one-time setup per repo
  git remote set-url origin https://gitlab.com/ORG/REPO.git
  git config credential.helper '!glab auth git-credential'
  ```

- **`gh api`, `gh pr`, `gh issue`, etc. work as-is.** *(both)* The
  injected `$GH_TOKEN` is enough.

- **`gh auth login` from inside fails.** *(both)* No write access to
  `~/.config/gh`. Auth outside, run `gh` inside.

- **Clipboard copy works only in OSC 52-capable terminals** (Ghostty,
  WezTerm, kitty, Alacritty; iTerm2 needs it enabled). *(both)* Apple
  Terminal.app silently drops the copy — `pbcopy` is blocked inside;
  wrap the session in `osc52pty` or switch terminals
  ([details](DETAILS.md#clipboard-and-osc-52)).

- **Writes to `/tmp/<not-claude>/…` hit EPERM.** *(both)* Most CLIs
  respect `$TMPDIR` (overridden to `/tmp/claude`), so rare in practice.

- **Concurrent `ccx` sessions are isolated** *(both)* via per-PID
  TMPDIRs; no cleanup needed.

- **`*.local` hostnames route through the proxy** (as of srt
  [#349](https://github.com/anthropic-experimental/sandbox-runtime/pull/349)).
  *(both)* Reachable under allow-all; remember them if you ever switch
  to an explicit allowlist.

## More

- [Why these design choices](DETAILS.md#why-these-design-choices) —
  allow-all egress, two postures, why a fork.
- [Using on Linux](DETAILS.md#using-on-linux) — config tweaks for
  bubblewrap/seccomp.
- [Future directions](DETAILS.md#future-directions) — srt primitives
  not exercised yet (credential masking, URL filtering, egress audit).
