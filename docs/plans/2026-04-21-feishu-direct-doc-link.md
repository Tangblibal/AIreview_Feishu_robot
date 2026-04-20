# Feishu Direct Document Link Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the folder requirement from the Feishu docs flow so the bot can create a Feishu document directly and return the link to the chat.

**Architecture:** Keep the existing review pipeline intact, but change the document branch to depend only on `FEISHU_DOCS_ENABLED`. `feishu-docs.js` will create documents directly without `folder_token`, while `feishu-bot.js` will always attempt document creation when docs are enabled and still fall back cleanly on failure.

**Tech Stack:** Node.js, built-in test runner (`node --test`), Feishu docx API, existing bot/doc helpers

---

### Task 1: Update document creation tests for direct-create behavior

**Files:**
- Modify: `test/feishu-docs.test.js`
- Test: `test/feishu-docs.test.js`

**Step 1: Write the failing test**

Update the existing document-creation tests so they no longer require `folderToken` and assert that the injected creation helper receives no folder-specific dependency.

Expected assertions:
- `docsConfig.enabled` is enough for the docs path
- `createDocumentDirectly` receives `title`
- `createDocumentDirectly` does not need `folderToken`

**Step 2: Run test to verify it fails**

Run: `node --test test/feishu-docs.test.js`

Expected: FAIL because the production code still calls the folder-specific helper and/or still expects `folderToken`.

**Step 3: Write minimal implementation**

Modify `feishu-docs.js` to replace folder-specific creation with direct creation.

**Step 4: Run test to verify it passes**

Run: `node --test test/feishu-docs.test.js`

Expected: PASS

**Step 5: Commit**

```bash
git add feishu-docs.js test/feishu-docs.test.js
git commit -m "refactor: create feishu docs without folder token"
```

### Task 2: Update bot reply gating tests

**Files:**
- Modify: `test/feishu-bot.test.js`
- Test: `test/feishu-bot.test.js`

**Step 1: Write the failing test**

Change the docs-enabled success test so `docsConfig` contains `enabled: true` but no `folderToken`, and assert that the reply still takes the document-link path.

Keep an explicit docs-disabled test unchanged.

**Step 2: Run test to verify it fails**

Run: `node --test test/feishu-bot.test.js`

Expected: FAIL because `buildFeishuReviewReply(...)` still requires a non-empty `folderToken`.

**Step 3: Write minimal implementation**

Modify `feishu-bot.js` so the docs branch is gated only by `docsConfig.enabled`.

**Step 4: Run test to verify it passes**

Run: `node --test test/feishu-bot.test.js`

Expected: PASS

**Step 5: Commit**

```bash
git add feishu-bot.js test/feishu-bot.test.js
git commit -m "refactor: allow feishu doc replies without folder config"
```

### Task 3: Update config and documentation

**Files:**
- Modify: `README.md`
- Modify: `deploy/volcengine/lumo-review.env.example`
- Modify: `feishu-docs.js`
- Test: `test/server-config.test.js` if config behavior needs coverage

**Step 1: Write the failing test**

If config coverage is needed, add or update a test to show the docs flow does not require `FEISHU_DOCS_FOLDER_TOKEN`.

**Step 2: Run test to verify it fails**

Run: `npm test`

Expected: FAIL only if the new config expectation is not yet reflected.

**Step 3: Write minimal implementation**

Update:
- README setup instructions
- env example comments and defaults
- optional wording in `feishu-docs.js` config helper if needed

**Step 4: Run test to verify it passes**

Run: `npm test`

Expected: PASS

**Step 5: Commit**

```bash
git add README.md deploy/volcengine/lumo-review.env.example feishu-docs.js
git commit -m "docs: update feishu direct doc link setup"
```

### Task 4: Final verification

**Files:**
- Verify: `feishu-docs.js`
- Verify: `feishu-bot.js`
- Verify: `test/feishu-docs.test.js`
- Verify: `test/feishu-bot.test.js`

**Step 1: Run targeted tests**

Run:

```bash
node --test test/feishu-docs.test.js test/feishu-bot.test.js
```

Expected: PASS

**Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS

**Step 3: Run syntax checks**

Run:

```bash
node -c feishu-docs.js
node -c feishu-bot.js
```

Expected: no output

**Step 4: Commit final verification-only doc changes if any**

If no additional changes were needed, no new commit is required here.
