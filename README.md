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
- Node.js 20 or newer
- A Gemini API key, free from [Google AI Studio](https://aistudio.google.com/apikey)
- To build the app yourself: Xcode Command Line Tools, about 150 GB of free disk
  and 16 GB of RAM (see [browser/README.md](browser/README.md))

## Getting started

### 1. Build and run Grol

```sh
cd browser
scripts/sync.sh           # download the browser engine source (first time: 1–3 h)
scripts/apply-patches.sh  # apply Grol's changes
scripts/build.sh          # build and install ~/Applications/Grol.app (first time: 3–5 h)
scripts/run.sh            # launch Grol
```

### 2. Add your API key

Click the ring icon in the toolbar to open the side panel, then paste your Gemini
API key in Settings. It's stored only in your browser profile.

### 3. (Optional) Turn on OS Control

```sh
browser/companion/install-autostart.sh
```

This installs the helper as a login item on `127.0.0.1:7777`. Then open
**System Settings → Privacy & Security** and turn on both **Accessibility** and
**Screen Recording** for the path the installer prints. Restart the helper:

```sh
launchctl kickstart -k gui/$(id -u)/com.grol.os-companion
```

To uninstall: `browser/companion/install-autostart.sh --remove`

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

The extension is plain JavaScript with no build step: edit it and relaunch with
`browser/scripts/run.sh`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Status

Early and experimental. Grol runs on Apple Silicon Macs. Expect rough edges,
and keep an eye on it during tasks that spend money or change files.

## License

[MIT](LICENSE)
