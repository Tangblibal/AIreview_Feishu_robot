function escapeRegExp(value) {
  return `${value || ''}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SCENE_STAGE_SEQUENCES = {
  A: ['A1', 'A1.5', 'A2', 'A2.5', 'A2.8', 'A3', 'A3.5', 'A4', 'A5', 'A6', 'A7', 'A8'],
  B: [],
};

function inferReviewScene(markdown = '') {
  const text = `${markdown || ''}`;
  if (text.includes('场景识别：前期订单签约')) return 'A';
  if (text.includes('场景识别：后期选片加片')) return 'B';
  return '';
}

function hasStageHeading(markdown = '', stageToken = '') {
  if (!markdown || !stageToken) return false;
  const pattern = new RegExp(`(?:^|\\n)###\\s*阶段${escapeRegExp(stageToken)}(?:\\s|：|:)`);
  return pattern.test(markdown);
}

function detectAbruptEnding(markdown = '') {
  const trimmed = `${markdown || ''}`.trim();
  if (!trimmed) return false;
  if (/[“"'‘（([{【]$/.test(trimmed)) return true;
  if (/[、，：:,;；]$/.test(trimmed)) return true;
  return false;
}

function analyzeReviewCompleteness(markdown = '', options = {}) {
  const trimmed = `${markdown || ''}`.trim();
  const stopReason = `${options?.stopReason || ''}`.trim();
  const scene = inferReviewScene(trimmed);
  const expectedStages = scene ? SCENE_STAGE_SEQUENCES[scene] || [] : [];
  const presentStages = expectedStages.filter((stage) => hasStageHeading(trimmed, stage));
  const missingStages = expectedStages.filter((stage) => !hasStageHeading(trimmed, stage));
  const lastStage = presentStages[presentStages.length - 1] || '';
  const abruptEnding = detectAbruptEnding(trimmed);

  let reason = 'ok';
  if (!trimmed) {
    reason = 'empty_report';
  } else if (stopReason === 'max_tokens') {
    reason = 'stop_reason_max_tokens';
  } else if (expectedStages.length && missingStages.length) {
    reason = 'missing_expected_stages';
  } else if (abruptEnding) {
    reason = 'abrupt_ending';
  }

  return {
    complete: reason === 'ok',
    reason,
    scene,
    stopReason,
    expectedStages,
    presentStages,
    missingStages,
    lastStage,
    abruptEnding,
  };
}

function buildIncompleteReportRetryPrompt({
  transcript = '',
  templateBlock = '（无模板）',
  salesContextBlock = '（未提供）',
  completeness = {},
}) {
  const scene =
    completeness?.scene === 'A'
      ? '前期订单签约'
      : completeness?.scene === 'B'
        ? '后期选片加片'
        : '自动识别';
  const expectedStages = Array.isArray(completeness?.expectedStages) ? completeness.expectedStages : [];
  const missingStages = Array.isArray(completeness?.missingStages) ? completeness.missingStages : [];
  const lastStage = `${completeness?.lastStage || '未识别'}`.trim() || '未识别';

  return [
    '你刚才输出的摄影门店销售复盘 Markdown 不完整，请从头重写一份更精简但完整的版本。',
    '',
    '硬性要求：',
    `1. 场景按“${scene}”处理。`,
    `2. 必须覆盖这些阶段：${expectedStages.length ? expectedStages.join('、') : '该场景的全部阶段'}。如果信息不足，也要明确写“⚠️ 阶段缺失”，不能省略后续阶段。`,
    '3. 必须保留这些模块：场景识别、高单潜力、客户类型、防御水平、成交路径、价格异议根因、综合评估、逐阶段复盘。',
    '4. 输出更简洁，优先保证完整性。每个阶段控制在 4 个小节内，不要展开过长。',
    `5. 上一版停在：${lastStage}。缺失阶段：${missingStages.length ? missingStages.join('、') : '未知'}。`,
    '6. 直接输出完整 Markdown 正文，不要 JSON，不要代码块，不要额外解释。',
    '',
    '人工补充成交信息（门店填写，若有则必须视为客观事实参与诊断）：',
    salesContextBlock || '（未提供）',
    '',
    '复盘模板：',
    templateBlock || '（无模板）',
    '',
    '对话转写：',
    transcript || '（空）',
  ].join('\n');
}

module.exports = {
  SCENE_STAGE_SEQUENCES,
  inferReviewScene,
  analyzeReviewCompleteness,
  buildIncompleteReportRetryPrompt,
};
