# Feishu Claude + Local Skill Review Design

**Date:** 2026-03-17

## Goal

Upgrade the Feishu bot review path to use Claude plus a server-local `SKILL.md` as the review rule source, while keeping the existing web review and analyze endpoints on the current prompt path.

## Scope

In scope:
- Feishu bot review requests only
- Anthropic/Claude as a Feishu-specific LLM provider override
- Loading one active local skill from a configurable directory
- Building a Feishu-specific prompt from `SKILL.md`, runtime output constraints, user text input, and ASR transcript
- Validation, error reporting, and tests for the new path

Out of scope:
- Replacing the web `/api/analyze` prompt path
- Replacing the web `/api/review` prompt path
- Hot reload for skill changes
- Multi-skill orchestration
- Frontend skill selection

## Current State

The service already supports Anthropic as a provider in [`server.js`](/Users/tang/Desktop/AI/server.js), and the Feishu bot currently reaches the same prompt pipeline as the web entry points:

1. `handleFeishuBotMessageEvent()` downloads the Feishu audio resource and collects optional text input.
2. `runSingleReviewPipeline()` uploads audio to TOS if needed, runs STT, merges transcript with text input, builds the prompt, and calls the active LLM provider.
3. `formatFeishuBotReply()` formats the normalized report into a Feishu-safe text reply.

The current design problem is not provider access. It is prompt control. Feishu currently uses the same generic `buildPrompt()` as the web endpoints, so prompt iteration remains code-heavy and hard to swap.

## Desired Behavior

When Feishu bot review is enabled with the new configuration:

1. The Feishu review path uses `FEISHU_ACTIVE_PROVIDER`, expected to be `anthropic`.
2. The service loads the active skill from `FEISHU_REVIEW_SKILL_DIR/<skill-id>/SKILL.md`, where `<skill-id>` is `FEISHU_REVIEW_SKILL_ID`.
3. The service builds a Feishu-specific prompt using:
   - the loaded `SKILL.md`
   - a server-controlled runtime contract that forces JSON output and evidence-based analysis
   - Feishu user text input
   - ASR transcript
4. Claude returns JSON in the existing normalized report shape.
5. Feishu sends the formatted reply back to the user.

The web endpoints continue using the existing prompt builder and existing provider selection.

## Architecture

### 1. Local skill loading

Add a dedicated loader module to read and validate the active skill:

- Directory layout:
  - `review-skills/<skill-id>/SKILL.md`
- Configuration:
  - `FEISHU_REVIEW_SKILL_DIR`
  - `FEISHU_REVIEW_SKILL_ID`
  - `FEISHU_REVIEW_SKILL_REQUIRED`
- Behavior:
  - Resolve the active skill path from directory plus skill id
  - Read `SKILL.md` from disk
  - Reject missing or empty files
  - Cache the loaded content in memory for normal runtime use
  - Reload on process start only

This keeps skill replacement operationally simple: copy a new skill folder, change env, restart the service.

### 2. Feishu-specific prompt building

Keep the existing `buildPrompt()` for the web path. Add a new Feishu-only prompt builder that composes:

- `Skill section`: full `SKILL.md` body
- `Runtime contract`: server-owned constraints such as:
  - output must be a single JSON object
  - conclusions must be evidence-based
  - do not fabricate facts
  - preserve current report schema
- `Context section`: optional Feishu text input
- `Transcript section`: merged transcript from ASR and Feishu text cache

This split is deliberate:
- `SKILL.md` defines how to analyze
- the runtime contract defines how to behave inside this system

That prevents skill replacement from breaking reply parsing.

### 3. Pipeline selection

Extend `runSingleReviewPipeline()` to accept a runtime mode or source flag, for example:

- `source: 'default'`
- `source: 'feishu'`

Selection rules:

- `source === 'feishu'`
  - choose provider from `FEISHU_ACTIVE_PROVIDER` if set, otherwise fall back to standard active provider
  - if `FEISHU_REVIEW_PROMPT_MODE=skill`, build the new Feishu skill prompt
- otherwise
  - use existing provider resolution
  - use existing `buildPrompt()`

This isolates the upgrade to Feishu without introducing branching logic across the whole request handler stack.

### 4. Error handling

Error policy for the Feishu skill path:

- Missing skill file:
  - treat as configuration error
  - fail the request
  - do not silently fall back to the old prompt
- Claude API failure:
  - fail the request
  - send a Feishu-safe failure message
- Invalid JSON from Claude:
  - retry once using the existing repair prompt pattern
  - fail if still invalid
  - do not silently fall back to the old prompt

This keeps rollout honest. If the new path is unhealthy, operations should see it immediately.

## Configuration

Recommended environment variables:

- `FEISHU_ACTIVE_PROVIDER=anthropic`
- `FEISHU_REVIEW_SKILL_DIR=/opt/qjgroup-ai-review/review-skills`
- `FEISHU_REVIEW_SKILL_ID=default-review`
- `FEISHU_REVIEW_SKILL_REQUIRED=true`
- `FEISHU_REVIEW_PROMPT_MODE=skill`

Behavior:

- Provider override applies only to Feishu review execution
- Skill directory and skill id define the active local rule source
- Required mode enforces startup or runtime failure if the selected skill is unavailable
- Prompt mode gates the Feishu-specific prompt builder

## File Changes

Expected new files:

- `/Users/tang/Desktop/AI/review-skill-loader.js`
- `/Users/tang/Desktop/AI/review-prompt-builder.js`
- `/Users/tang/Desktop/AI/test/review-skill-loader.test.js`
- `/Users/tang/Desktop/AI/test/review-prompt-builder.test.js`

Expected modified files:

- `/Users/tang/Desktop/AI/server.js`
- `/Users/tang/Desktop/AI/README.md`
- `/Users/tang/Desktop/AI/deploy/volcengine/lumo-review.env.example`
- `/Users/tang/Desktop/AI/deploy/railway/variables.min.example`

## Data Flow

1. Feishu sends text and/or audio.
2. `handleFeishuBotMessageEvent()` collects the pending text input and audio resource.
3. `runSingleReviewPipeline({ source: 'feishu', ... })` runs STT and prepares the merged transcript.
4. The Feishu pipeline resolves the active provider override and active skill.
5. `buildFeishuSkillPrompt()` composes the final Claude prompt.
6. `callModelWithRetry()` calls Anthropic and parses JSON.
7. `normalizeReport()` standardizes the report.
8. `formatFeishuBotReply()` sends the final text reply back to Feishu.

## Testing Strategy

### Unit tests

- skill loader reads the configured `SKILL.md`
- skill loader rejects missing file
- skill loader rejects empty file
- Feishu prompt builder includes:
  - skill body
  - runtime contract
  - text input
  - transcript
  - JSON output contract

### Integration-focused tests

- Feishu review pipeline selects the Feishu provider override
- Feishu review pipeline uses skill prompt mode when enabled
- Web analyze/review paths remain unchanged

### Manual verification

1. Place a test skill under `review-skills/default-review/SKILL.md`
2. Set Feishu env vars to use Anthropic plus the new skill
3. Send Feishu text plus audio
4. Confirm the reply reflects the skill instructions
5. Replace `FEISHU_REVIEW_SKILL_ID`, restart the service, and confirm output changes

## Risks

### Skill content too long

Long `SKILL.md` files may raise prompt size and latency. The first iteration will accept that cost because operational simplicity matters more than prompt optimization. If needed later, the runtime contract can support a distilled skill format.

### Skill content conflicts with runtime schema

The runtime contract must always win on output shape. The parser and normalization logic assume a stable JSON object and should not depend on skill-specific formatting preferences.

### Hidden fallback masking rollout issues

Silent fallback to the old prompt would make quality validation impossible. This design intentionally avoids that.

## Rollout Plan

1. Add loader and prompt builder modules
2. Add Feishu-only provider override and prompt selection
3. Add tests
4. Update docs and env templates
5. Deploy with one server-local skill
6. Validate on Feishu traffic
7. Expand to web endpoints only after quality is proven

## Acceptance Criteria

- Feishu review requests use Claude when `FEISHU_ACTIVE_PROVIDER=anthropic`
- Feishu review requests load the configured local `SKILL.md`
- Replacing the active skill requires only file placement, env change, and restart
- Web endpoints remain on the old prompt path
- Missing skill configuration fails loudly
- Test coverage exists for loader and prompt composition
