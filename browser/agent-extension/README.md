# Grol Agent extension

Grol's AI agent, shipped as a built-in MV3 component extension (plain ES
modules, no bundler). It relies only on stable extension and DevTools-protocol
APIs, so engine updates don't break it (tier 2 of the layering rule in
`../README.md`).

| File | Role |
| --- | --- |
| `background.js` | Service worker. Hosts both agents and wires the pages' messages to them. |
| `message-router.js` | The `chrome.runtime.onMessage` listener: accepts only the extension's own pages, refuses unknown or malformed messages. |
| `vision-agent.js` | Browser agent facade and loop: observe, decide, act, verify. |
| `vision-run.js`, `vision-observer.js`, `vision-actions.js`, `vision-progress.js` | Per-task state, page observation, action execution, and loop/stuck detection. |
| `vision-helpers.js` | Pure helpers (URLs, key chords, text matching, deadlines). |
| `vision-planner.js` | The browser agent's model calls (plan, decide, verify done). |
| `vision-prompts.js`, `vision-normalize.js` | Its prompts, and the parser that turns a messy model reply into one valid action. |
| `cdp-page-target.js` | Drives tabs over `chrome.debugger` (input, JS, screenshots, navigation). |
| `page-scripts.js`, `mark-render.js` | Injected page analysis and screenshot marks. |
| `os-agent.js` | OS Control: a look/think/act loop over the local helper at `127.0.0.1:7777`. |
| `os-task.js` | The worker's OS task: pause/resume/stop, confirmations, and an event log that survives a worker restart. |
| `os-daemon.js`, `os-describe.js`, `intent-engine.js` | Helper HTTP client, activity-log labels, and the model-free path for one-line commands. |
| `gemini-*.js` | Gemini REST client (typed errors, key sent as a header and never logged), model discovery, the retrying model ladder, JSON parsing. |
| `settings.js` | API key storage (`chrome.storage.local`, key `ai`). |
| `sleep.js` | A sleep that ends as soon as a task is stopped. |
| `sidepanel.*`, `newtab.*` | UI. The toolbar button opens the side panel. |

Tests live in `tests/extension/` (`node --test tests/extension/*.test.mjs`). They
mock Gemini and run OS Control against a fake helper, so they need no network or
key; `GROL_LIVE=1 GROL_LIVE_KEY_FILE=<json with an apiKey>` adds one live call.

`build.js` is rewritten by `browser/scripts/run.sh` on every launch so the
worker can detect that it is a stale cached copy.
