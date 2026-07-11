# Security policy

QPet accepts local lifecycle events from Codex, Claude Code, and Cursor. Its
design goal is to retain only normalized, minimal metadata and never persist
prompts, transcripts, commands, assistant responses, or raw hook payloads.

## Supported version

Only the latest `main` branch and the newest tagged release are supported.

## Report a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting for this repository when it is enabled, or
email Quang Nguyen at [quangtn@gmail.com](mailto:quangtn@gmail.com). Include
the affected version, impact, reproduction steps, and any proof of concept
needed to validate the report.

Examples include bypassing the loopback authentication, unsafe hook merging,
unexpected persistence of private content, or renderer access to filesystem or
shell APIs.
