const fs = require('fs');
const path = require('path');

function sanitizeDebugArtifactName(value) {
  const clean = `${value || ''}`.trim();
  if (!clean) return 'review_debug';
  return clean.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function buildReviewDebugArtifactPath(exportDir, requestId) {
  const safeDir = `${exportDir || ''}`.trim();
  const fileName = `${sanitizeDebugArtifactName(requestId)}.json`;
  return path.join(safeDir, fileName);
}

async function writeReviewDebugArtifact({
  exportDir,
  requestId,
  provider = {},
  transcript = '',
  enrichedTranscript = '',
  prompt = '',
  report = {},
  modelMeta = {},
  completeness = {},
  now = new Date(),
}) {
  const safeDir = `${exportDir || ''}`.trim();
  if (!safeDir) {
    return { written: false, reason: 'disabled' };
  }

  const filePath = buildReviewDebugArtifactPath(safeDir, requestId);
  const payload = {
    request_id: `${requestId || ''}`.trim() || 'n/a',
    exported_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    provider: {
      type: `${provider?.type || ''}`.trim(),
      model: `${provider?.model || ''}`.trim(),
    },
    lengths: {
      transcript: `${transcript || ''}`.length,
      enriched_transcript: `${enrichedTranscript || ''}`.length,
      prompt: `${prompt || ''}`.length,
      report_markdown: `${report?.report_markdown || ''}`.length,
    },
    transcript: `${transcript || ''}`,
    enriched_transcript: `${enrichedTranscript || ''}`,
    prompt: `${prompt || ''}`,
    report: {
      status: `${report?.status || ''}`.trim(),
      report_markdown: `${report?.report_markdown || ''}`,
    },
    model_meta: {
      stop_reason: `${modelMeta?.stopReason || modelMeta?.stop_reason || ''}`.trim(),
      finish_reason: `${modelMeta?.finishReason || modelMeta?.finish_reason || ''}`.trim(),
    },
    completeness: {
      complete: Boolean(completeness?.complete),
      reason: `${completeness?.reason || ''}`.trim(),
      scene: `${completeness?.scene || ''}`.trim(),
      stop_reason: `${completeness?.stopReason || ''}`.trim(),
      expected_stages: Array.isArray(completeness?.expectedStages) ? completeness.expectedStages : [],
      present_stages: Array.isArray(completeness?.presentStages) ? completeness.presentStages : [],
      missing_stages: Array.isArray(completeness?.missingStages) ? completeness.missingStages : [],
      last_stage: `${completeness?.lastStage || ''}`.trim(),
      abrupt_ending: Boolean(completeness?.abruptEnding),
    },
  };

  fs.mkdirSync(safeDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return { written: true, filePath };
}

module.exports = {
  sanitizeDebugArtifactName,
  buildReviewDebugArtifactPath,
  writeReviewDebugArtifact,
};
