# Installing claude-mods (instructions for Claude Code)

You are Claude Code and the user asked you to install mods from this repository. Do this:

1. Check the version: `claude --version` must be **2.1.286 or newer**. If it is older, tell the user to update first (`claude update`) and stop.
2. Ask the user which mods they want, using these one-line descriptions (offer "all" as the first option):
   - **quickbar**: launcher above the prompt with live context %
   - **context-keeper**: context panel, handoff checkpoints, compaction archive
   - **usage-meter**: plan limits, burn rate, cost, cache hit ratio
   - **notify**: inbox + OS notifications for finished turns/agents/tasks and pending approvals
   - **activity**: live view of what Claude is running and waiting for
   - **guardrails**: clickable safety rules (turns on "Safe defaults" on first load)
   - **prompt-coach**: suggests better prompts before sending (asks first, never silent)
   - **toolbox**: all tools explained + project-specific suggestions
   - **command-hub**: discover/search/create slash commands
   - **changes**: files changed this session with line counts
   - **loop-breaker**: stops Claude going in circles
3. Add the marketplace (once):
   ```
   claude plugin marketplace add OWNER/claude-mods
   ```
4. Install each chosen mod:
   ```
   claude plugin install <mod>@claude-mods
   ```
5. Tell the user to restart Claude Code (or run `/reload-plugins` if available), then type `/quickbar` or the mod's command from the README table.

Do not change any other settings. If an install fails, show the error and stop.
