# Building Grol.app

Grol is built from the upstream browser engine's source with a small set of
patches. This folder holds everything needed to build it; the engine source
itself is downloaded separately and never committed.

## Layout

    config/engine.conf     pinned engine revision, checkout location, product identity
    patches/               Grol's changes, applied in `patches/series` order
    scripts/               sync, patch, build, run and package
    agent-extension/       the Grol Agent, shipped inside the app as a built-in extension
    companion/             the OS Control helper (a launchd agent on 127.0.0.1:7777)

The engine checkout lives in `~/grol-engine` (about 100 GB). Change it with
`GROL_ENGINE_ROOT`. It's generated output: you can delete it and recreate it at
any time.

## Build

Requirements: macOS on Apple Silicon, Xcode Command Line Tools
(`xcode-select --install`),
[depot_tools](https://commondatastorage.googleapis.com/chrome-infra-docs/flat/depot_tools/docs/html/depot_tools_tutorial.html)
in `~/depot_tools`, about 150 GB of free disk and 16 GB of RAM or more.

    scripts/sync.sh            # download the engine at the pinned revision (1–3 h first time)
    scripts/apply-patches.sh   # apply the patch series and Grol's UI branding
    scripts/build.sh           # compile and install ~/Applications/Grol.app (3–5 h first time)
    scripts/run.sh             # launch with the agent loaded from this repo

- `JOBS=<n> scripts/build.sh` sets how many compile jobs run in parallel
  (default 6).
- `GROL_PROFILE=<dir> scripts/run.sh` picks the browser profile folder.
- `run.sh` loads the agent straight from `agent-extension/`, so extension
  changes apply on the next launch with no rebuild.

The Grol name and logo replace the upstream ones during `apply-patches.sh`
(`scripts/brand-strings.py` and `scripts/brand-logos.sh`). To change the logo, edit
`agent-extension/logo.svg`, run `node scripts/render-logo-masters.mjs` (needs Google
Chrome) to refresh `resources/logo/`, then re-apply and rebuild.

The extension's ID (`ebhlbffbihmgefabpeglnhjadadhcmjc`) is fixed by the `key`
field in `agent-extension/manifest.json`, so settings survive rebuilds.

## Package

    scripts/package.sh         # dist/Grol-<version>-arm64.dmg

This produces a disk image containing Grol.app, a double-click installer for OS
Control (it carries its own Node) and a short read-me. It needs the OS Control
helper installed locally first, because the helper's dependencies are reused.
Set `GROL_SIGN_ID` and `GROL_NOTARY_PROFILE` to sign and notarize with an Apple
Developer ID; without them the image is ad-hoc signed.

## Changing the browser

Each engine upgrade can break a patch, so prefer, in order:

1. a build flag or runtime switch (nothing to maintain),
2. the bundled extension (uses stable extension APIs),
3. a patch: small, single-purpose, named `NNN-area-what.patch`, and listed in
   `patches/series` with a one-line reason.
