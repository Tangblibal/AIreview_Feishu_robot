const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSalesContext, parseSalesContextFromFields, formatSalesContextForPrompt } = require('../sales-context');

test('normalizeSalesContext normalizes order details and derives total sets', () => {
  const result = normalizeSalesContext({
    hasOrder: 'yes',
    orderAmount: '6999',
    indoorSets: '2',
    outdoorSets: '1',
    retouchedCount: '30',
    productCount: '4',
    videoCount: '2',
  });

  assert.deepEqual(result, {
    hasOrder: 'yes',
    orderAmount: 6999,
    indoorSets: 2,
    outdoorSets: 1,
    totalSets: 3,
    retouchedCount: 30,
    productCount: 4,
    videoCount: 2,
    hasAnyData: true,
  });
});

test('formatSalesContextForPrompt outputs provided facts for LLM prompt', () => {
  const text = formatSalesContextForPrompt({
    hasOrder: 'no',
    orderAmount: null,
    indoorSets: 0,
    outdoorSets: 0,
    totalSets: 0,
    retouchedCount: 0,
    productCount: 0,
    videoCount: 0,
    hasAnyData: true,
  });

  assert.match(text, /是否订单：未下单/);
  assert.match(text, /订单金额：未提供/);
  assert.match(text, /订单套数：0 套（内景 0，外景 0）/);
  assert.match(text, /精修数量：0/);
  assert.match(text, /产品数量：0/);
  assert.match(text, /视频数量：0/);
});

test('parseSalesContextFromFields parses multipart json field', () => {
  const parsed = parseSalesContextFromFields({
    sales_context: JSON.stringify({
      hasOrder: 'yes',
      orderAmount: '8888',
      indoorSets: '1',
      outdoorSets: '2',
      retouchedCount: '20',
      productCount: '3',
      videoCount: '1',
    }),
  });

  assert.equal(parsed.hasOrder, 'yes');
  assert.equal(parsed.orderAmount, 8888);
  assert.equal(parsed.totalSets, 3);
  assert.equal(parsed.retouchedCount, 20);
});
