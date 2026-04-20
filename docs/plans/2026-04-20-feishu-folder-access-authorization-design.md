# Feishu Folder Access Authorization Design

**Date:** 2026-04-20

## Goal

Enable the Feishu bot to create review documents inside a configured Feishu folder reliably, without weakening the current bot runtime model or coupling normal message processing to administrator login state.

## Scope

In scope:
- Explaining why the current doc archive path falls back to text replies
- Defining the token and permission model for Feishu folder access
- Choosing a stable authorization strategy for the target folder
- Describing the recommended one-time administrator authorization workflow
- Defining implementation phases, verification steps, and operational checkpoints

Out of scope:
- Replacing the current Feishu bot runtime with a user-impersonation model
- Building a full administrator web console in this iteration
- Automatic folder authorization during normal bot message handling
- General-purpose file or permission management beyond the target review folder

## Current State

The Feishu bot review flow already works through message receipt, audio download, STT, LLM analysis, and Feishu text reply. The current archive flow also reaches the document branch correctly:

1. The bot receives text, then audio, and starts the review pipeline.
2. Review generation succeeds.
3. The service attempts to create a Feishu document inside `FEISHU_DOCS_FOLDER_TOKEN`.
4. Feishu returns `1770040 no folder permission`.
5. The service falls back to the short text reply by design.

This means the primary business path is healthy. The failure is specifically the authorization boundary between the app identity and the target Feishu folder.

## Problem Definition

The current bot uses `tenant_access_token` for runtime API calls. That model is correct for long-lived bot execution. The issue is that the configured target folder has not granted the app identity sufficient access to create documents.

The design problem is therefore not "how to make the bot behave like a user." The design problem is:

- how to keep the bot running as an app with `tenant_access_token`
- while introducing a separate low-frequency mechanism to grant the app access to the target folder

## Permission Model

### Runtime identity

The Feishu bot should continue using:

- `tenant_access_token`

Responsibilities:
- receive and reply to bot messages
- download audio resources
- resolve chat and sender metadata
- create and update Feishu documents after folder access has already been granted

### Administrative identity

Folder authorization should use:

- `user_access_token`

Responsibilities:
- act as a human administrator with permission to manage the target folder
- execute a one-time or low-frequency authorization action that adds the app identity as a folder collaborator

### Resource identity

The authorization workflow depends on:

- `folder_token`
- `app_open_id`

Definitions:
- `folder_token` identifies the target Feishu folder
- `app_open_id` identifies the app identity to be granted access

## Design Principles

1. Keep bot runtime and administrator authorization separate.
2. Do not make normal message handling depend on a human session.
3. Solve the folder permission gap once, not on every audio message.
4. Prefer explicit and observable tooling over hidden retries or implicit permission hacks.
5. Fail clearly when authorization is missing, rather than masking the issue with silent behavior.

## Options Considered

### Option A: One-time administrator authorization tool

Description:
- Keep the bot runtime unchanged.
- Add a standalone tool that uses `user_access_token` to add the app identity as a collaborator to the target folder.

Pros:
- Smallest code and operational change
- Preserves the current bot runtime model
- Easier to debug and audit
- Low risk to production message handling

Cons:
- Requires a manual authorization step when onboarding a new folder
- Needs access to `user_access_token` and `app_open_id`

### Option B: Built-in administrator authorization center

Description:
- Add a dedicated admin OAuth path and management interface to authorize folders from inside the system.

Pros:
- Better long-term product shape
- Easier repeated authorization for many folders

Cons:
- Larger scope
- Introduces administrator login state, token lifecycle management, and UI or operator endpoints
- Slows down resolution of the current problem

### Option C: Continue relying on group sharing and manual Feishu-side configuration

Description:
- Avoid code changes and keep trying group-based sharing or client-side sharing rules only.

Pros:
- Lowest implementation effort on paper

Cons:
- Already shown to be unreliable in the current scenario
- Hard to standardize or document as a repeatable operational process
- Weak evidence trail when failures recur

## Recommended Option

Adopt **Option A: one-time administrator authorization tool**.

Rationale:
- It directly addresses the current failure mode without changing the current bot execution model.
- It limits the new surface area to a small, explicit permission utility.
- It provides a clear bridge from today's issue to a future richer admin flow if needed.

## Recommended Architecture

The system should be divided into two independent flows.

### 1. Business flow

Purpose:
- normal bot message handling and document archive behavior

Components:
- `server.js`
- `feishu-bot.js`
- `feishu-docs.js`

Identity:
- `tenant_access_token`

Behavior:
- receive text and audio
- run STT and review generation
- create Feishu documents after folder access exists
- reply with doc links or fallback text

### 2. Authorization flow

Purpose:
- grant the app identity access to a target folder

Components:
- `feishu-folder-access.js`
- `scripts/grant-feishu-folder-access.js`

Identity:
- `user_access_token`

Behavior:
- execute a one-time or low-frequency permission grant
- add the app identity to the target folder using the Feishu permissions API
- print raw success or failure information for operator review

## Implementation Shape

### Core module

Add a dedicated module:

- `/Users/tang/Desktop/AI/feishu-folder-access.js`

Responsibilities:
- parse and validate explicit input values
- build the Feishu permission grant request
- send the request using `user_access_token`
- surface Feishu error bodies without hiding details

### CLI wrapper

Add a small runnable script:

- `/Users/tang/Desktop/AI/scripts/grant-feishu-folder-access.js`

Responsibilities:
- accept command-line or environment input
- call `grantFeishuFolderAccess(...)`
- print JSON success output
- exit non-zero on failure

### Tests

Add a focused test file:

- `/Users/tang/Desktop/AI/test/feishu-folder-access.test.js`

Coverage:
- correct request path, query, headers, and body
- helpful error propagation when Feishu rejects the request
- argument parsing and missing-input validation

## Inputs Required for Execution

The one-time authorization tool requires:

1. `folder_token`
2. `user_access_token`
3. `app_open_id`

Optional:
- permission level, default `edit`
- base URL override
- timeout override
- notification flag

## Data Flow

### Authorization flow

1. Operator obtains `folder_token`.
2. Operator obtains a `user_access_token` from a human administrator who can manage that folder.
3. Operator obtains `app_open_id` for the Feishu app identity.
4. Operator runs the authorization script.
5. The script calls the Feishu permissions API for the target folder.
6. If successful, the app identity becomes an authorized collaborator for that folder.

### Business flow after authorization

1. Bot receives text and audio.
2. Bot runs the review pipeline.
3. Bot creates a document inside the configured folder using `tenant_access_token`.
4. Bot appends content blocks to the new document.
5. Bot replies with the document link instead of the text fallback.

## Execution Preconditions

Before running the authorization tool, all of the following must be true:

### App-side checks

- The correct Feishu app is identified.
- The app has the required Docs permissions, including document creation/edit capability.
- The app version with those permissions has been published.
- The app's availability scope covers the relevant users and resource owners.

### Folder-side checks

- The target token is a folder token, not a document token.
- The target folder is the real folder intended for review archives.
- The human executing authorization can manage that folder.
- `FEISHU_DOCS_FOLDER_TOKEN` matches the intended target folder.

### User token checks

- The `user_access_token` belongs to a real administrator or collaborator with folder management rights.
- The token is not expired.
- The token is not a tenant token.

### App identity checks

- `app_open_id` is confirmed to represent the app identity, not a user identity.
- The app identity matches the same app used by the bot runtime.

## Phased Rollout Plan

### Phase 1: Design and interface confirmation

Output:
- this design document
- fixed architecture and token model

Success criteria:
- the team understands the runtime versus authorization split

### Phase 2: Build the one-time authorization tool

Output:
- `feishu-folder-access.js`
- CLI wrapper
- unit tests
- README usage note

Success criteria:
- tests pass
- syntax checks pass
- operator-facing command shape is stable

### Phase 3: Gather external inputs

Output:
- confirmed `folder_token`
- confirmed `user_access_token`
- confirmed `app_open_id`

Success criteria:
- all required values are available and trustworthy

### Phase 4: Execute one-time authorization

Output:
- successful permission grant for the target folder

Success criteria:
- authorization tool succeeds without Feishu permission errors

### Phase 5: Re-verify the bot archive flow

Output:
- a successful end-to-end bot archive run

Success criteria:
- no `1770040 no folder permission`
- a document is created in the target folder
- the bot replies with a document link

### Phase 6: Operationalization

Output:
- documented operator workflow for new folders
- optional future ideas for startup self-checks or admin UI

Success criteria:
- future folder onboarding no longer relies on guesswork

## Verification Strategy

### Tool verification

The authorization tool is considered healthy when:
- request construction is correct
- argument parsing is deterministic
- Feishu failures are surfaced with original body details

### Runtime verification

The business flow is considered fixed when:
- text guidance reply still works
- audio review still works
- the bot no longer falls back after document creation is attempted
- the target folder contains the new document

## Acceptance Criteria

This effort is complete when all of the following are true:

1. The app identity has explicit access to the target folder.
2. The bot can create a document in that folder using the existing runtime path.
3. The bot replies with the document link instead of fallback text.
4. The fallback path remains available for genuine downstream failures.
5. The operator workflow for authorizing a new folder is documented.

## Risks

### `app_open_id` acquisition remains unclear

If the app identity value is misidentified, the script may succeed against the wrong collaborator type or fail in a misleading way.

Mitigation:
- treat `app_open_id` acquisition as a first-class precondition, not a guess

### `user_access_token` acquisition is operationally awkward

If the project does not yet expose a reliable admin OAuth path, operators may need a temporary manual token acquisition flow.

Mitigation:
- keep the first iteration manual
- document the exact token acquisition path once confirmed

### Folder rights may vary across spaces

Not all Feishu folders behave the same across personal, shared, and org-managed contexts.

Mitigation:
- validate against the real production target folder, not a synthetic sample only

## Future Enhancements

After the one-time authorization route is stable, consider:

- startup checks for folder accessibility
- a clearer operator endpoint for validating `FEISHU_DOCS_FOLDER_TOKEN`
- a dedicated administrator OAuth flow for repeated folder onboarding
- friendlier runtime logging when `1770040` recurs
