# Feishu Direct Document Link Design

**Date:** 2026-04-21

## Goal

Enable the Feishu bot to create a Feishu cloud document for each completed review and send the document link back to the chat, without requiring a target folder or folder-level authorization flow.

## Scope

In scope:
- removing the runtime dependency on `FEISHU_DOCS_FOLDER_TOKEN`
- creating a Feishu document directly through the existing app identity
- keeping the current short-text fallback when document creation fails
- preserving existing title generation and markdown-to-doc block conversion
- updating tests, docs, and env examples to match the new behavior

Out of scope:
- folder archival, folder naming rules, or category management
- automatic share-permission adjustments after document creation
- administrator OAuth storage or user-impersonation writing
- migration of historical review documents

## Why The Previous Route Was Rejected

The previous implementation assumed the bot could gain access to a target folder through a collaborator-grant flow. That assumption does not hold for the API route we tested:

- the collaborator API rejected `type=folder`
- the API error showed that supported resource types do not include folders
- this means the "grant app access to folder, then write into folder" design cannot be the primary path

The product requirement has also been simplified. The current user goal is no longer "archive into a designated folder." The goal is only "create a Feishu document and send the link back to the group."

That removes the need to keep investing in folder-level authorization.

## Product Decision

The bot should:

1. receive text and audio as before
2. generate the review report as before
3. create a Feishu document directly, without `folder_token`
4. append the rendered markdown blocks to that document
5. reply to the chat with the document link and short summary

If direct document creation fails, the bot should continue to use the existing short-text fallback reply.

## Recommended Approach

### Option A: Direct document creation without folder token

Description:
- call the Feishu doc creation API with only a title
- do not send `folder_token`
- keep the rest of the pipeline unchanged

Pros:
- smallest code change
- fully aligned with the new requirement
- avoids the unsupported folder-permission branch
- keeps runtime identity as the existing app token model

Cons:
- document location is no longer controlled by a configured folder
- document visibility still depends on Feishu's default sharing behavior

### Option B: User-authorized document creation

Description:
- store a user OAuth grant and create documents with `user_access_token`

Pros:
- likely stronger control over where documents live and who can access them

Cons:
- much larger scope
- needs token storage, refresh logic, and operational controls
- no longer necessary for the new product target

### Option C: Keep folder logic and only relax validation

Description:
- keep the folder-based implementation but make `folderToken` optional

Pros:
- superficially low-effort

Cons:
- keeps dead architecture in the core path
- makes behavior harder to reason about
- preserves confusion around unsupported folder authorization

## Decision

Adopt **Option A**.

The code should be refocused on "create doc and return link," not "archive into folder."

## Architecture Changes

### Current behavior

- `feishu-bot.js` only enters the document branch when both:
  - `FEISHU_DOCS_ENABLED=true`
  - `FEISHU_DOCS_FOLDER_TOKEN` is non-empty
- `feishu-docs.js` always creates the document by sending `folder_token`

### New behavior

- `feishu-bot.js` should enter the document branch whenever:
  - `FEISHU_DOCS_ENABLED=true`
- `feishu-docs.js` should create the document without requiring `folder_token`
- `FEISHU_DOCS_FOLDER_TOKEN` becomes optional legacy configuration, no longer required for the main path

## Required Code Changes

### `feishu-docs.js`

- stop treating `folderToken` as a required input
- rename the document creation helper from folder-specific behavior to direct document creation behavior
- call `POST /open-apis/docx/v1/documents` with:
  - `title`
- do not send `folder_token`

### `feishu-bot.js`

- remove the `folderToken` gate from `buildFeishuReviewReply(...)`
- if docs are enabled, always attempt document creation
- keep the current fallback behavior on failure

### Tests

Update tests to reflect:
- docs-enabled path no longer depends on `folderToken`
- document creation helper is called without folder requirement
- docs-disabled path still returns plain text
- document-failure path still returns short fallback text

### README and env example

- remove language that says a folder token is required
- move folder-related guidance out of the main setup path
- explain that the first supported mode is "direct document creation and link reply"

## Acceptance Criteria

This change is complete when all of the following are true:

1. With `FEISHU_DOCS_ENABLED=true`, the bot attempts doc creation even when no folder token is configured.
2. The document creation request no longer includes `folder_token`.
3. On success, the bot replies with the document link.
4. On failure, the bot still falls back to the short text reply.
5. All updated tests and syntax checks pass.

## Risks

### Document visibility may not match group expectations

The document may be created successfully, but some recipients may not be able to open it depending on Feishu defaults.

Mitigation:
- treat this as a follow-up verification item after the direct-create path is working

### Existing folder config may create operator confusion

Operators may assume `FEISHU_DOCS_FOLDER_TOKEN` is still required.

Mitigation:
- update README and env example clearly
- describe folder behavior as deprecated or optional

## Follow-Up After This Change

If the direct-create flow succeeds but document visibility is too restrictive, the next iteration should focus on share settings for the created document, not folder authorization.
