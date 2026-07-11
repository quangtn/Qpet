# QPet contributor instructions

QPet is a local-first, notification-only macOS companion for Codex and Claude
Code. Keep it compact and privacy-preserving.

## Before changing code

- Read `README.md` and the relevant tests first.
- Preserve unrelated working-tree changes.
- Do not add analytics, cloud sync, prompt/transcript persistence, embedded
  chat, or agent SDKs without explicit direction.

## Security boundaries

- Keep Node disabled and context isolation enabled in renderers.
- Expose only narrow preload APIs. Do not introduce unrestricted filesystem,
  shell, or Electron APIs in the renderer.
- Never log or persist prompts, transcripts, commands, assistant responses, or
  raw hook payloads.
- Hook configuration changes must remain atomic, idempotent, and limited to
  QPet-owned entries. Preserve unrelated Codex and Claude settings.
- Do not bypass Codex hook trust. The user approves QPet through `/hooks`.

## Verification

Run the smallest relevant tests while developing, then run:

```bash
npm run typecheck
npm test
```

Run `npm run test:e2e` for renderer, Electron, or window-behavior changes. Run
`npm run package:mac && npm run smoke:package` for packaging changes.

## Local installation

Use `npm run install:mac` for a source install. The script builds and installs
the app only. It must not edit `~/.codex` or `~/.claude`; integration setup is
performed interactively inside QPet so the user can review and trust it.
