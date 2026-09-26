# Security

Grol can control your computer, so security reports matter a lot to us.

Please **don't open a public issue** for a vulnerability. Report it privately through
GitHub's [private vulnerability reporting](../../security/advisories/new) and include
steps to reproduce it. We'll acknowledge the report within a few days.

These are especially in scope:

- reaching the OS Control helper (`127.0.0.1:7777`) from a web page or another origin
- running a high-risk action without user confirmation
- file access outside the allowed folders (`desktop/`, `documents/`, `downloads/`)
- prompt injection from page content that makes the agent act against the user
