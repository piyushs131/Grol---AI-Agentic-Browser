# Contributing

Thanks for helping. A few ground rules keep the fork maintainable.

## Where changes go

- **Agent behaviour or UI** → `browser/agent-extension/`. Plain ES modules with no
  build step. Reload by relaunching with `browser/scripts/run.sh`.
- **Desktop automation** → `ai-agent-os/modules/<module>/`. Each module registers
  its actions with a risk level. Anything that writes, deletes or executes must be
  `high` so the user is asked first.
- **The browser engine** → a new patch in `browser/patches/`, only when a flag or the
  extension can't do it. Keep each patch single-purpose and add it to
  `patches/series` with a one-line reason.

## Style

- Match the surrounding code: 2-space indent, single quotes, small focused functions.
- Comment only what the code can't say itself, such as a platform quirk or a
  security reason. Skip comments that restate the code.
- No new dependencies without a good reason. The extension has none.

## Before opening a PR

```sh
npm install      # installs the daemon's dependencies in ai-agent-os/
npm run check    # syntax, daemon smoke test and the full test suite
```

Describe what you tested by hand. For agent changes, include the task you ran.
