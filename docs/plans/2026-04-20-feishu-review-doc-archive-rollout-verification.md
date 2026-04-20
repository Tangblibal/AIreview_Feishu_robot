# Feishu Review Doc Archive Rollout Verification

## Status
- Implementation tasks 1-6 completed in the `codex/feishu-review-doc-archive` worktree.
- Task 7 automated verification completed on 2026-04-20.
- Task 7 manual Feishu smoke test is pending because the current local session has no `FEISHU_*`, `TOS_*`, or STT runtime environment configured.

## Automated Verification
Executed in `/Users/tang/Desktop/AI/.worktrees/codex-feishu-review-doc-archive`:

```bash
node --test /Users/tang/Desktop/AI/.worktrees/codex-feishu-review-doc-archive/test/feishu-bot.test.js /Users/tang/Desktop/AI/.worktrees/codex-feishu-review-doc-archive/test/feishu-docs.test.js
node -c /Users/tang/Desktop/AI/.worktrees/codex-feishu-review-doc-archive/server.js
node -c /Users/tang/Desktop/AI/.worktrees/codex-feishu-review-doc-archive/feishu-bot.js
node -c /Users/tang/Desktop/AI/.worktrees/codex-feishu-review-doc-archive/feishu-docs.js
```

Result:
- `node --test ...` passed with 16 tests, 0 failures.
- `node -c server.js` passed with no output.
- `node -c feishu-bot.js` passed with no output.
- `node -c feishu-docs.js` passed with no output.

## Manual Verification Checklist
Run the following in an environment that has valid Feishu bot, Docs, TOS, and STT configuration:

1. Send a text message to the bot and confirm the pre-audio guidance reply.
2. Send a short audio file and confirm:
   - review completes
   - a new document appears in folder `VsF6flLpqlHbUjdlelJcCwMFnEb`
   - title follows `群名-年月日-录音发送人名称`
   - if metadata is missing, title falls back to `录音原文件名-年月日`
   - bot replies with the document link
3. Set an invalid `FEISHU_DOCS_FOLDER_TOKEN`, restart the service, send a short audio file, and confirm:
   - review still completes
   - bot sends short fallback text instead of failing silently
   - logs contain the document flow error

## Notes
- The current branch contains the Docs success path, short text fallback path, and operator configuration documentation.
- Manual Feishu validation was not executed in this local session because no deployable runtime credentials were present.
