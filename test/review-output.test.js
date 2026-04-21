const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeReviewCompleteness, buildIncompleteReportRetryPrompt } = require('../review-output');

test('analyzeReviewCompleteness detects missing later stages for front-order review', () => {
  const markdown = [
    '📋 **场景识别：前期订单签约**',
    '## 📊 综合评估',
    '### 阶段A1：开场破冰',
    '### 阶段A1.5：价格切入时机',
    '### 阶段A2：需求挖掘',
    '### 阶段A2.5：高单机会识别',
    '### 阶段A2.8：低意向去防御承接',
    '### 阶段A3：产品/套餐介绍',
    '### 阶段A3.5：方案层级构建',
  ].join('\n');

  const result = analyzeReviewCompleteness(markdown);

  assert.equal(result.complete, false);
  assert.equal(result.scene, 'A');
  assert.equal(result.reason, 'missing_expected_stages');
  assert.equal(result.lastStage, 'A3.5');
  assert.deepEqual(result.missingStages, ['A4', 'A5', 'A6', 'A7', 'A8']);
});

test('analyzeReviewCompleteness accepts a full front-order stage sequence', () => {
  const markdown = [
    '📋 **场景识别：前期订单签约**',
    '## 📊 综合评估',
    '### 阶段A1：开场破冰',
    '### 阶段A1.5：价格切入时机',
    '### 阶段A2：需求挖掘',
    '### 阶段A2.5：高单机会识别',
    '### 阶段A2.8：低意向去防御承接',
    '### 阶段A3：产品/套餐介绍',
    '### 阶段A3.5：方案层级构建',
    '### 阶段A4：价值塑造',
    '### 阶段A5：异议处理',
    '### 阶段A6：促单成交',
    '### 阶段A7：升单 / 微拔',
    '### 阶段A8：售后铺垫',
    '结尾完整。',
  ].join('\n');

  const result = analyzeReviewCompleteness(markdown);

  assert.equal(result.complete, true);
  assert.equal(result.reason, 'ok');
  assert.equal(result.lastStage, 'A8');
  assert.deepEqual(result.missingStages, []);
});

test('analyzeReviewCompleteness flags max_tokens stop reason as incomplete', () => {
  const markdown = [
    '📋 **场景识别：前期订单签约**',
    '### 阶段A1：开场破冰',
    '### 阶段A1.5：价格切入时机',
    '### 阶段A2：需求挖掘',
    '### 阶段A2.5：高单机会识别',
    '### 阶段A2.8：低意向去防御承接',
    '### 阶段A3：产品/套餐介绍',
    '### 阶段A3.5：方案层级构建',
    '### 阶段A4：价值塑造',
    '### 阶段A5：异议处理',
    '### 阶段A6：促单成交',
    '### 阶段A7：升单 / 微拔',
    '### 阶段A8：售后铺垫',
  ].join('\n');

  const result = analyzeReviewCompleteness(markdown, { stopReason: 'max_tokens' });

  assert.equal(result.complete, false);
  assert.equal(result.reason, 'stop_reason_max_tokens');
});

test('buildIncompleteReportRetryPrompt asks for a concise but complete rewrite', () => {
  const prompt = buildIncompleteReportRetryPrompt({
    transcript: '销售：你好',
    templateBlock: '（无模板）',
    salesContextBlock: '（未提供）',
    completeness: {
      scene: 'A',
      expectedStages: ['A1', 'A1.5', 'A2', 'A2.5', 'A2.8', 'A3', 'A3.5', 'A4', 'A5', 'A6', 'A7', 'A8'],
      missingStages: ['A4', 'A5', 'A6', 'A7', 'A8'],
      lastStage: 'A3.5',
    },
  });

  assert.match(prompt, /必须覆盖这些阶段：A1、A1\.5、A2、A2\.5、A2\.8、A3、A3\.5、A4、A5、A6、A7、A8/);
  assert.match(prompt, /上一版停在：A3\.5/);
  assert.match(prompt, /输出更简洁，优先保证完整性/);
});
