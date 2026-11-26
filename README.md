<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" width="96" alt="fastpipe logo">
  </picture>
</p>

<h1 align="center">fastpipe</h1>

<p align="center">A local proxy that sends the bulky parts of a coding agent's context as images, so the same session costs fewer input tokens. A faster fork of pxpipe.</p>

<p align="center">
  <a href="LICENSE"><img alt="Licence: MIT" src="https://img.shields.io/badge/licence-MIT-blue"></a>
  <a href="#install"><img alt="Node 20.19 or later" src="https://img.shields.io/badge/node-%3E%3D20.19-339933?logo=nodedotjs&logoColor=white"></a>
  <a href="tsconfig.json"><img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white"></a>
  <a href="#commands"><img alt="Platforms: macOS, Linux and Windows" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-555555"></a>
  <a href="https://github.com/teamchong/pxpipe"><img alt="Fork of pxpipe 0.16.0" src="https://img.shields.io/badge/fork%20of-pxpipe%200.16.0-1f6feb"></a>
</p>

<p align="center">
  <a href="#install">Install</a> |
  <a href="#commands">Commands</a> |
  <a href="#what-the-fork-changes">What the fork changes</a> |
  <a href="#benchmarks">Benchmarks</a> |
  <a href="docs/pxpipe.md">pxpipe guide</a> |
  <a href="SECURITY.md">Security</a>
</p>

fastpipe runs on your machine, between a coding agent and the model provider. Before a request leaves, it renders the system prompt, the tool documentation and the older history as dense PNG pages, and leaves the recent turns as text. An image is billed by its pixel size, not by the amount of text inside it, so the same context costs fewer input tokens. Responses pass through unchanged.

The method, the renderer and the model evaluations come from [pxpipe](https://github.com/teamchong/pxpipe) by teamchong. This fork is based on pxpipe 0.16.0. It makes the local transform faster, adds a service launcher for macOS, Linux and Windows, and replaces the dashboard. The [pxpipe guide](docs/pxpipe.md) holds the upstream README, with the full method, the supported models and their limits.

## Install

You need Node 20.19 or later and pnpm.

```bash
git clone https://github.com/rospocroccante/fastpipe
cd fastpipe
pnpm install
pnpm run build
node scripts/fastpipe-ctl.mjs install   # copies the build to ~/.fastpipe/app and adds the fastpipe command
fastpipe on                             # starts the service and hooks Claude Code
```

`fastpipe on` writes `ANTHROPIC_BASE_URL` into `~/.claude/settings.json`, which Claude Code reads when a session starts. Sessions that are already open keep their old connection, so start a new one. To upgrade, pull, build and run the last two commands again.

With nothing set, fastpipe images the requests for Fable 5, Opus 5.5 and the Gemini models (default `PXPIPE_MODELS=claude-fable-5,claude-opus-5-5,gemini`). Every other model passes through as text until you turn it on in the dashboard. Image compression is validated for Fable 5, Gemini 3.6 Flash and Gemini 3.7 Flash, and other families can use more tokens instead of fewer. The [pxpipe guide](docs/pxpipe.md#the-honest-part) has the measurements per model.

## Commands

The commands are the same on macOS, Linux and Windows.

```bash
fastpipe on        # start the service, wait until it answers, then hook Claude Code
fastpipe status    # what is running, hooked and paused
fastpipe pause     # pass every request through untouched, no restart
fastpipe resume    # transform again
fastpipe restart   # load a newly installed build
fastpipe off       # pause, unhook Claude Code and stop the service
fastpipe direct    # run one Claude Code session straight to Anthropic
```

A watchdog removes the `ANTHROPIC_BASE_URL` setting after two failed health checks and restores it when the proxy answers again, so a stopped proxy cannot leave new sessions without a connection.

The service runs under launchd on macOS and under the systemd user manager on Linux. On Windows, and on Linux without systemd, it runs as a detached background process, and a login entry (the Startup folder on Windows, XDG autostart on Linux desktops) brings it back after a reboot. `FASTPIPE_SERVICE=launchd|systemd|process` overrides the choice.

The launcher has been in daily use on macOS. The Linux and Windows paths are covered by the test suite and have not yet been run for a full week on those systems.

Any other command goes to the proxy CLI of pxpipe, so `fastpipe warp -- claude` and `fastpipe stats` work as the [pxpipe guide](docs/pxpipe.md) describes for `pxpipe`.

## Dashboard

The dashboard is at <http://127.0.0.1:47821/>. It opens on one strip: the share of input tokens saved, then tokens, dollars, cost per request, requests and uptime, and under them a pipe that shows how much of the context was sent and how much was not. The compression switch and the day and night switch sit at the right of the bar. The Advanced button opens four views: the images of the latest request next to their source text, the sessions, the model setup and the formulas behind every number.

## What the fork changes

- **Faster local transform.** Rendered pages are written as palette PNGs at 1 to 8 bits per pixel, base64 uses the native encoder and is kept per page, the scan that builds the exact-value factsheet is kept per text, and a few pages render at the same time. The pixels are the ones pxpipe produces. The numbers are under [Benchmarks](#benchmarks).
- **Service launcher.** `fastpipe on` and `fastpipe off` replace the manual setup of the proxy and of the Claude Code setting, with a watchdog, a pause switch and a way back to a direct connection.
- **One-screen dashboard.** It reads from left to right, starts with the saving and keeps the detail behind one button.
- **One retry on a dropped connection.** A request that fails before any response arrives is sent once more on a fresh connection.
- **Request bodies up to 32 MiB.** Long Claude Code sessions pass the 16 MiB limit of pxpipe and were refused with a 413. `PXPIPE_MAX_REQUEST_BYTES` still overrides the default.
- **Tool changes survive history collapse.** A tool added in the collapsed part of a conversation and removed later no longer makes the API refuse the request with `tool_reference_unresolved`.
- **No conversation capture by default.** The launcher no longer writes the body of refused requests to disk. `FASTPIPE_DEBUG_CAPTURE_4XX=1 fastpipe on` turns it on for debugging.
- **Local by default.** The proxy listens on `127.0.0.1`, and the event log and the session state stay in `~/.fastpipe` on the machine that runs it.

The [changelog](CHANGELOG.md) has the detail of each change.

## Benchmarks

### Local transform

The time fastpipe adds to a request before it goes upstream, on the same request for both trees. The request is synthetic and shaped like a long Claude Code session: 200 tool-call turns, 40 tool definitions and a large system prompt, 1.02 MB of JSON that becomes 55 pages on the `claude-fable-5-2` profile.

| | pxpipe 0.16.0 | fastpipe | Change |
|---|---:|---:|---:|
| First request of a process | 2,715 ms | 1,086 ms | 2.5 times faster |
| Same request again | 433 ms | 115 ms | 3.8 times faster |
| Next turn of the session | 425 ms | 109 ms | 3.9 times faster |
| Request body sent upstream | 10.57 MB | 4.51 MB | 57% smaller |
| Images in the request | 55 | 55 | same |

Each figure is the median of 7 runs, every run in a fresh process, on an Apple M4 Pro with Node 24.22. The `claude-fable-5` and `gemini-4-argon` profiles give 2,684 to 1,103 ms and 2,700 to 1,110 ms on the first request, with bodies of 10.32 and 4.43 MB.

The second script checks that the speed costs nothing in content. On five model profiles the JSON around the images is identical in the two trees, and every image decodes to the same pixels. Image tokens are billed on pixel size, so the smaller body changes the upload time and leaves the bill as it was.

To run both on your machine, from the root of this repository:

```bash
git remote add upstream https://github.com/teamchong/pxpipe
git fetch upstream --tags
git worktree add ../pxpipe-0.16.0 v0.16.0
ln -s "$PWD/node_modules" ../pxpipe-0.16.0/node_modules

npx tsx bench/latency.mts ../pxpipe-0.16.0     # pxpipe
npx tsx bench/latency.mts .                    # fastpipe
npx tsx bench/equivalence.mts ../pxpipe-0.16.0 # same JSON, same pixels
```

These numbers cover the local work only. The time the provider takes to read the images is the larger part of the latency of an imaged request, and this fork does not change the number of images.

### Real use

During the trial on one machine, from 11 to 26 November 2026, the proxy handled 9,736 Claude Code requests and imaged 9,545 of them. They were billed for 169 million input tokens where the same context as text would have been billed for 354 million, both after cache discounts: 52% fewer.

Two limits apply to this figure. The text side is the proxy's own count of what each request would have cost without imaging, taken on the same request, and not a second session run without the proxy. And the saving comes from the method of pxpipe: the fork changes how fast a request is prepared, not which parts of it become images.

## Licence

MIT, as pxpipe. See [LICENSE](LICENSE). The bundled fonts keep their own licences, in `assets/`.
