# Grol

**An AI browser for macOS.** Tell Grol what you want done: it can browse websites
for you and, if you allow it, use the apps on your Mac.

> "Find an LG TV under ₹25,000 on amazon.in and add the cheapest one to the cart."
>
> "Open Notes and write a shopping list: milk, eggs, bread."

## Features

- **Browser tasks.** Grol reads each page from a screenshot plus a map of its
  clickable elements, then clicks, types and scrolls until the job is done. It
  checks its own work before calling a task finished.
- **OS Control (optional).** A small local helper lets Grol open apps, take
  screenshots, type and click on your Mac. Risky actions, such as running a
  command or deleting or overwriting a file, always ask you first.
- **Hands back when it should.** On sign-in pages, one-time codes, captchas or
  payments, Grol pauses and asks you to take over.
- **Bring your own model key.** Uses Google Gemini with your own API key. If a
  model is busy or out of quota, Grol moves to the next one.
- **Built-in ad blocking.** Ads and trackers are blocked on every site using
  EasyList, EasyPrivacy, EasyList India and Peter Lowe's list (refreshed daily),
  including YouTube video ads and sponsored results on Google Search. Nothing to
  install.
- **A full browser.** Your usual sites, extensions and Google sign-in all work,
  with vertical tabs on by default.

## How it works

```
┌──────────────────────────── Grol.app ────────────────────────────┐
│  New-tab page and side panel                                     │
│        │                                                         │
│        ▼                                                         │
│  Grol Agent (built-in extension)                                 │
│   • Browser agent: screenshot → plan → act, over DevTools        │
│   • OS agent:      look → think → act, through the helper        │
└────────────────────────────────┬─────────────────────────────────┘
                                 │  HTTP, 127.0.0.1:7777 only
┌────────────────────────────────▼─────────────────────────────────┐
│  OS Control helper (ai-agent-os)                                 │
│   desktop · screen · process · filesystem · browser · scheduler  │
│   every action is risk-rated; risky ones need your approval      │
└──────────────────────────────────────────────────────────────────┘
```

| Folder | What's inside |
|---|---|
| [`browser/agent-extension/`](browser/agent-extension/) | The agent: side panel, planners, page automation |
| [`browser/companion/`](browser/companion/) | Installer and launcher for the OS Control helper |
| [`ai-agent-os/`](ai-agent-os/) | The local automation daemon behind OS Control |
| [`browser/`](browser/) | Build scripts, patches and packaging for Grol.app |
| [`tests/`](tests/) | Automated tests (`npm test`) |

## Requirements

- A Mac with Apple Silicon (M1 or newer)
- A Gemini API key, free from [Google AI Studio](https://aistudio.google.com/apikey)
- Only to build the app yourself: Node.js 22 or newer, Xcode Command Line Tools,
  about 150 GB of free disk and 16 GB of RAM (see [browser/README.md](browser/README.md))

## Getting started

### 1. Install Grol

Paste this into Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/piyushs131/Grol---AI-Agentic-Browser/main/install.sh | bash
```

It installs Grol into `/Applications` together with the OS Control helper (a
login item on `127.0.0.1:7777`), then opens Grol. Run it again to update; your
profile and settings are kept. Downloading this way avoids the "Apple could not
verify Grol" dialog that the test builds otherwise show. To install only the
browser, end the command with `bash -s -- --no-os-control`.

<details>
<summary>Prefer the disk image?</summary>

Download `Grol-<version>-arm64.dmg` from
[Releases](https://github.com/piyushs131/Grol---AI-Agentic-Browser/releases),
drag Grol into Applications and open it. When macOS says it can't verify Grol,
click **Done**, then **System Settings → Privacy & Security → Open Anyway**. You
only do this once. Open `Install OS Control.command` from the disk image the
same way to add OS Control.
</details>

### 2. Allow OS Control

System Settings opens during the install. In **Privacy & Security**, turn on
**node** (the helper, at the path the installer prints) under both
**Accessibility** and **Screen Recording**. The installer waits, notices when
both are on and finishes by itself. If they're already on, this step is skipped.

### 3. Add your API key

Press **⌘ Shift Y** to open the side panel, click the **key icon**, choose a
provider and paste your key. A Gemini key is free from
[Google AI Studio](https://aistudio.google.com/apikey). It's stored only in your
browser profile.

From a clone of this repo you can use `browser/companion/install-autostart.sh`
instead, and `browser/companion/install-autostart.sh --remove` to uninstall.

## Privacy and security

- The helper listens on your own machine only and refuses requests from websites.
- The model only proposes actions. Grol validates each one, and risky actions
  wait for your approval.
- Credential folders (such as `~/.ssh`) and system folders are off limits.
- Your API key is sent only to Google's Gemini API, in a request header.

Found a vulnerability? Please report it privately. See [SECURITY.md](SECURITY.md).

## Development

```sh
npm install       # installs the helper's dependencies
npm run check     # syntax checks, daemon smoke test and the full test suite
```

You don't need to build the browser to work on the agent. Pick one:

- **Stock Chromium (recommended):** `browser/scripts/run-chromium.sh` downloads
  an official Chromium build once (~180 MB) and launches it with the agent
  loaded from `browser/agent-extension/`.
- **Your own Chrome:** open `chrome://extensions`, turn on **Developer mode**,
  click **Load unpacked** and choose `browser/agent-extension/`. Chrome shows a
  "started debugging this browser" bar while the agent works.
- **The installed Grol app:** `browser/scripts/run.sh` uses `~/Applications/Grol.app`
  with the agent from this repo.

All three give you the agent, side panel, ad blocking and OS Control. Only
Grol's browser patches (branding, theme, tab defaults) are missing. The extension
is plain JavaScript with no build step: edit it and relaunch. Building the browser
itself (4–8 hours the first time) is only needed to change `browser/patches/`;
see [browser/README.md](browser/README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Status

Early and experimental. Grol runs on Apple Silicon Macs. Expect rough edges,
and keep an eye on it during tasks that spend money or change files.

## License

[MIT](LICENSE)
