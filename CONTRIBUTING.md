# Contributing to QPet

QPet is a local, notification-only companion for Codex and Claude Code. Small,
focused changes are easiest to review and safest to maintain.

## Setup

QPet currently targets Apple Silicon macOS with Node.js 22 or newer.

```bash
npm ci
npm run dev
```

Before submitting a change, run:

```bash
npm run typecheck
npm test
```

Use `npm run test:e2e` for Electron/renderer changes. For changes that affect
packaging, run `npm run package:mac && npm run smoke:package`.

## Contribution boundaries

- Preserve QPet's local-first privacy model: do not store prompts,
  transcripts, commands, assistant responses, or raw hook JSON.
- Keep integrations notification-only. Embedded chat, approvals, file editing,
  and managed provider sessions are outside V0.
- Hook installation and removal must preserve unrelated settings and be safe to
  repeat.
- Do not make a renderer capable of arbitrary file or process access.
- Keep macOS-specific code isolated. Do not advertise Windows or Intel-Mac
  compatibility until it is tested and packaged.

## Reporting changes

Please include a short description, the verification commands you ran, and any
manual test steps. Use a security report rather than a public issue for a
potential data exposure or a way to execute untrusted code; see
[SECURITY.md](SECURITY.md).
