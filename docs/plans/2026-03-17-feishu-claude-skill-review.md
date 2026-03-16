# Feishu Claude + Local Skill Review Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Route Feishu bot review requests through Claude plus a configurable local `SKILL.md`, without changing the existing web prompt pipeline.

**Architecture:** Add a local skill loader and a Feishu-specific prompt builder, then thread a Feishu-only runtime mode through the existing review pipeline so the bot can override both provider and prompt source. Keep the normalized JSON report contract unchanged so downstream Feishu reply formatting does not need a redesign.

**Tech Stack:** Node.js commonjs, built-in `node:test`, native `fs/path`, current Anthropic/OpenAI-compatible fetch flow, existing Feishu bot and review pipeline in `server.js`.

---

### Task 1: Add tests for local skill loading

**Files:**
- Create: `/Users/tang/Desktop/AI/test/review-skill-loader.test.js`
- Create: `/Users/tang/Desktop/AI/review-skills/.gitkeep`
- Modify: `/Users/tang/Desktop/AI/package.json`

**Step 1: Write the failing test**

Write `node:test` cases that assert:
- the loader reads `/tmp/.../<skill-id>/SKILL.md`
- missing files throw a configuration error
- empty files throw a configuration error

**Step 2: Run test to verify it fails**

Run: `node --test test/review-skill-loader.test.js`
Expected: FAIL because `review-skill-loader.js` does not exist yet.

**Step 3: Write minimal implementation**

Create `/Users/tang/Desktop/AI/review-skill-loader.js` with:
- config parsing helpers for Feishu skill env
- `resolveFeishuSkillPath()`
- `loadFeishuActiveSkill()`
- validation for missing and empty files

**Step 4: Run test to verify it passes**

Run: `node --test test/review-skill-loader.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add /Users/tang/Desktop/AI/test/review-skill-loader.test.js /Users/tang/Desktop/AI/review-skill-loader.js /Users/tang/Desktop/AI/review-skills/.gitkeep
git commit -m "test: add review skill loader coverage"
```

### Task 2: Add tests for Feishu skill prompt composition

**Files:**
- Create: `/Users/tang/Desktop/AI/test/review-prompt-builder.test.js`
- Create: `/Users/tang/Desktop/AI/review-prompt-builder.js`

**Step 1: Write the failing test**

Add tests asserting the Feishu prompt contains:
- the raw skill text
- a JSON-only runtime contract
- the Feishu text input block
- the transcript block
- the required JSON schema keys such as `report_markdown` and `insights`

**Step 2: Run test to verify it fails**

Run: `node --test test/review-prompt-builder.test.js`
Expected: FAIL because `review-prompt-builder.js` does not exist yet.

**Step 3: Write minimal implementation**

Create `/Users/tang/Desktop/AI/review-prompt-builder.js` with:
- `buildPrompt()` moved here or re-exported for the current path
- `buildFeishuSkillPrompt({ skillText, transcript, textInput })`
- a stable runtime contract that enforces JSON output

**Step 4: Run test to verify it passes**

Run: `node --test test/review-prompt-builder.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add /Users/tang/Desktop/AI/test/review-prompt-builder.test.js /Users/tang/Desktop/AI/review-prompt-builder.js
git commit -m "test: add feishu skill prompt builder coverage"
```

### Task 3: Thread Feishu-specific provider and prompt selection through the review pipeline

**Files:**
- Modify: `/Users/tang/Desktop/AI/server.js`
- Test: `/Users/tang/Desktop/AI/test/review-prompt-builder.test.js`
- Test: `/Users/tang/Desktop/AI/test/review-skill-loader.test.js`

**Step 1: Write the failing test**

Add focused tests for new runtime selection helpers in `server.js` or extracted helper functions. Assert:
- Feishu mode resolves `FEISHU_ACTIVE_PROVIDER`
- Feishu mode uses `buildFeishuSkillPrompt()`
- default mode keeps using the current provider and prompt path

**Step 2: Run test to verify it fails**

Run: `node --test test/review-skill-loader.test.js test/review-prompt-builder.test.js`
Expected: FAIL because the runtime selection logic is not implemented.

**Step 3: Write minimal implementation**

Update `/Users/tang/Desktop/AI/server.js` to:
- import the new modules
- add helpers for Feishu-specific env/config
- extend `runSingleReviewPipeline(payload)` to accept `payload.source`
- select provider override for `source === 'feishu'`
- select skill prompt mode for `source === 'feishu'`
- keep web paths on the current `buildPrompt()`

**Step 4: Run test to verify it passes**

Run: `node --test test/review-skill-loader.test.js test/review-prompt-builder.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add /Users/tang/Desktop/AI/server.js /Users/tang/Desktop/AI/review-skill-loader.js /Users/tang/Desktop/AI/review-prompt-builder.js /Users/tang/Desktop/AI/test/review-skill-loader.test.js /Users/tang/Desktop/AI/test/review-prompt-builder.test.js
git commit -m "feat: add feishu claude skill review path"
```

### Task 4: Switch Feishu entry points to the new runtime mode

**Files:**
- Modify: `/Users/tang/Desktop/AI/server.js`
- Modify: `/Users/tang/Desktop/AI/feishu-bot.js`

**Step 1: Write the failing test**

Add or extend tests around the Feishu message path so the review pipeline receives:
- `source: 'feishu'`
- Feishu text input
- downloaded audio payload

If full message-path testing is too expensive in this file layout, extract a small helper and test that helper directly.

**Step 2: Run test to verify it fails**

Run: `node --test`
Expected: FAIL because Feishu entry points still call the default review mode.

**Step 3: Write minimal implementation**

Update the Feishu bot review call to pass `source: 'feishu'` into `runSingleReviewPipeline()`. Leave web `/api/review` and `/api/analyze` unchanged.

**Step 4: Run test to verify it passes**

Run: `node --test`
Expected: PASS

**Step 5: Commit**

```bash
git add /Users/tang/Desktop/AI/server.js /Users/tang/Desktop/AI/feishu-bot.js
git commit -m "feat: route feishu bot reviews through skill mode"
```

### Task 5: Document configuration and deployment changes

**Files:**
- Modify: `/Users/tang/Desktop/AI/README.md`
- Modify: `/Users/tang/Desktop/AI/deploy/volcengine/lumo-review.env.example`
- Modify: `/Users/tang/Desktop/AI/deploy/railway/variables.min.example`

**Step 1: Write the failing test**

Not applicable for docs-only changes. Instead, define a manual verification checklist that must be completed before commit.

**Step 2: Run check to verify docs are outdated**

Run: `rg -n "FEISHU_REVIEW_SKILL|FEISHU_ACTIVE_PROVIDER" /Users/tang/Desktop/AI/README.md /Users/tang/Desktop/AI/deploy/volcengine/lumo-review.env.example /Users/tang/Desktop/AI/deploy/railway/variables.min.example`
Expected: no matches

**Step 3: Write minimal implementation**

Document:
- skill directory layout
- Feishu-specific env variables
- provider override behavior
- restart-based skill replacement process

**Step 4: Run check to verify docs include the new config**

Run: `rg -n "FEISHU_REVIEW_SKILL|FEISHU_ACTIVE_PROVIDER" /Users/tang/Desktop/AI/README.md /Users/tang/Desktop/AI/deploy/volcengine/lumo-review.env.example /Users/tang/Desktop/AI/deploy/railway/variables.min.example`
Expected: matches in all three files

**Step 5: Commit**

```bash
git add /Users/tang/Desktop/AI/README.md /Users/tang/Desktop/AI/deploy/volcengine/lumo-review.env.example /Users/tang/Desktop/AI/deploy/railway/variables.min.example
git commit -m "docs: add feishu skill review configuration"
```

### Task 6: Verify the full rollout contract

**Files:**
- Modify: `/Users/tang/Desktop/AI/docs/plans/2026-03-17-feishu-claude-skill-review-design.md`
- Modify: `/Users/tang/Desktop/AI/docs/plans/2026-03-17-feishu-claude-skill-review.md`

**Step 1: Run full test suite**

Run: `node --test`
Expected: PASS

**Step 2: Run targeted config checks**

Run: `rg -n "FEISHU_ACTIVE_PROVIDER|FEISHU_REVIEW_SKILL_DIR|FEISHU_REVIEW_SKILL_ID|FEISHU_REVIEW_PROMPT_MODE" /Users/tang/Desktop/AI/server.js /Users/tang/Desktop/AI/README.md /Users/tang/Desktop/AI/deploy/volcengine/lumo-review.env.example /Users/tang/Desktop/AI/deploy/railway/variables.min.example`
Expected: matches in code and docs

**Step 3: Run manual Feishu verification**

Manual checklist:
- set `FEISHU_ACTIVE_PROVIDER=anthropic`
- set `FEISHU_REVIEW_SKILL_DIR`
- set `FEISHU_REVIEW_SKILL_ID`
- restart service
- send Feishu text plus audio
- confirm reply changes when the active skill id changes

**Step 4: Record verification notes**

Update the plan docs with any rollout caveats discovered during implementation.

**Step 5: Commit**

```bash
git add /Users/tang/Desktop/AI/docs/plans/2026-03-17-feishu-claude-skill-review-design.md /Users/tang/Desktop/AI/docs/plans/2026-03-17-feishu-claude-skill-review.md
git commit -m "docs: finalize feishu claude skill rollout plan"
```
