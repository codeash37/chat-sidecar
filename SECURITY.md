# Security policy

chat-sidecar runs inside Claude Code with your permissions, like every plugin. It reads the chat's own events and draws the pane. It makes no network requests and sends nothing anywhere. The only commands it runs are the read-only ones listed under [Privacy](README.md#privacy). Tasks are kept in Claude Code's plugin store on your machine.

## Reporting a vulnerability

Report security issues privately on GitHub: **Security → Report a vulnerability** in this repository. Please don't open a public issue for them.

A fix ships as a new version you can update to from `/plugin`.
