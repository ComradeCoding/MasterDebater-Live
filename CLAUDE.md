# Token budget

Read this before starting any work. One Claude Code session on another of
this owner's repos (exalted, 14 September 2026) spent 164 million cache-read
tokens: two multi-agent "workflows" spawned 175 subagents, each re-reading a
large context on every turn, on a 4-CPU box that ran two at a time for two
hours. Nothing they found was worth a tenth of that. These rules are the
owner's, and they are not optional.

The bill is agents × turns × context. Every tool call an agent makes
re-reads everything that agent has read so far, so one agent that opens
thirty files across thirty turns costs more than ten agents that each make
five targeted calls. Keep every context small and the count bounded, and
workflows are affordable.

1. **Workflows are off until switched on.** `.claude/settings.json` blocks
   the Workflow tool unless the environment sets `CLAUDE_ALLOW_WORKFLOWS=1`
   (in the claude.ai environment's variables, or the shell). The word
   "ultracode" in a message does not count, and a fan-out the user did not
   ask for is never spawned. Leave the hook in place.
2. **When they are on, build them small.** Every workflow script obeys all
   of these, and a script that cannot is done solo instead:
   - at most six agents in total, and one Agent call beats a Workflow for
     fewer than five items;
   - one pass: no critic round, no loop-until-dry, one verifier per batch of
     five or more findings, never two or three refuters per finding;
   - a brief under 200 words that names file paths and line ranges, never
     pastes file contents or JSON; anything large is written to a file in
     the scratchpad and the agent gets the path;
   - every agent prompt ends with: "At most 10 tool calls. Grep, and Read
     with offset and limit; never cat a whole file; no WebSearch unless
     this brief asks for one. When the budget is spent, return what you
     have.";
   - `effort: "low"` or `"medium"`; `model: "haiku"` for grep-and-list
     work, `"sonnet"` for checking a finding, the session model only for
     the one agent that writes the synthesis.
3. **Read less.** Grep for the lines you need. Read with offset and limit.
   Never cat a file over 300 lines, never dump a whole-tree `git diff`, never
   re-read a file already in context, never read a workflow's raw result
   file. A tool output over 30 KB is a wrong query, not a big answer.
4. **One build, one test run, one lint per milestone**, not per edit. The
   typecheck is the cheap check between edits.
5. **Never poll.** Background tasks notify on their own: no sleep loops, no
   repeated status checks, no Monitor for a single completion.
6. **Every wake-up re-reads the whole context.** Do not schedule recurring
   check-ins (`send_later`, cron) unless the user asks for one; a PR's
   subscription already wakes the session when something happens. Past about
   100k tokens of context, finish the milestone, commit, and say so rather
   than pressing on; a fresh session is cheaper than a long one.
7. **Do not re-derive settled decisions.** The README and any TODO file
   record them; audit the gaps, not the choices.
