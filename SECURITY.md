# Security Policy

## What counts as a security issue here

- A **guardrails bypass**: a command or path that a rule claims to block but that gets through. (Known limit: guardrails checks the commands and paths an agent passes to tools; it cannot see inside scripts the agent writes and then runs. Bypasses of *that* kind are expected. Bypasses of a rule's own stated pattern are bugs.)
- A mod that leaks data: writes secrets to disk, sends anything off the machine, or shows sensitive content where it shouldn't.
- A mod that can be steered by untrusted content (file contents, tool output, web pages) into doing something the user didn't ask for.

## Reporting

Please **don't open a public issue** for these. Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository, or email golden.mihel@gmail.com.

Include the mod, your Claude Code version (`claude --version`), and the exact command or input that reproduces it. You'll get a reply within a few days. Fixes ship as a patch release with credit, if you want it.
