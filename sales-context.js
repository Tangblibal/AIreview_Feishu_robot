function pickFirst(value) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeOrderStatus(value) {
  const raw = `${value ?? ''}`.trim().toLowerCase();
  if (!raw || raw === 'unknown' || raw === 'unset' || raw === 'null' || raw === 'undefined') return 'unknown';
  if (['yes', 'y', 'true', '1', '是', '已下单', '已成交', '成交'].includes(raw)) return 'yes';
  if (['no', 'n', 'false', '0', '否', '未下单', '未成交'].includes(raw)) return 'no';
  return 'unknown';
}

function normalizeNonNegativeInteger(value) {
  if (value === undefined || value === null || `${value}`.trim() === '') return null;
  const parsed = Number(`${value}`.trim());
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
}

function normalizeNonNegativeAmount(value) {
  if (value === undefined || value === null || `${value}`.trim() === '') return null;
  const parsed = Number(`${value}`.trim());
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Number(parsed.toFixed(2));
}

function normalizeSalesContext(input = {}) {
  const hasOrder = normalizeOrderStatus(input.hasOrder ?? input.has_order ?? input.orderStatus ?? input.order_status);
  const orderAmount = normalizeNonNegativeAmount(input.orderAmount ?? input.order_amount);
  const indoorSets = normalizeNonNegativeInteger(input.indoorSets ?? input.indoor_sets);
  const outdoorSets = normalizeNonNegativeInteger(input.outdoorSets ?? input.outdoor_sets);
  const providedTotalSets = normalizeNonNegativeInteger(input.totalSets ?? input.total_sets);
  const totalSets =
    indoorSets !== null || outdoorSets !== null ? (indoorSets || 0) + (outdoorSets || 0) : providedTotalSets;
  const retouchedCount = normalizeNonNegativeInteger(input.retouchedCount ?? input.retouched_count);
  const productCount = normalizeNonNegativeInteger(input.productCount ?? input.product_count);
  const videoCount = normalizeNonNegativeInteger(input.videoCount ?? input.video_count);

  const hasAnyData = [
    hasOrder !== 'unknown',
    orderAmount !== null,
    indoorSets !== null,
    outdoorSets !== null,
    totalSets !== null,
    retouchedCount !== null,
    productCount !== null,
    videoCount !== null,
  ].some(Boolean);

  return {
    hasOrder,
    orderAmount,
    indoorSets,
    outdoorSets,
    totalSets,
    retouchedCount,
    productCount,
    videoCount,
    hasAnyData,
  };
}

function parseSalesContextFromFields(fields = {}) {
  const contextFieldKeys = [
    'sales_context',
    'salesContext',
    'customer_order_context',
    'customerOrderContext',
    'order_context',
    'orderContext',
  ];

  for (const key of contextFieldKeys) {
    const raw = pickFirst(fields[key]);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return normalizeSalesContext(parsed);
    } catch (error) {
      // Fallback to individual fields below.
    }
  }

  return normalizeSalesContext({
    hasOrder: pickFirst(fields.has_order ?? fields.hasOrder ?? fields.order_status ?? fields.orderStatus),
    orderAmount: pickFirst(fields.order_amount ?? fields.orderAmount),
    indoorSets: pickFirst(fields.indoor_sets ?? fields.indoorSets),
    outdoorSets: pickFirst(fields.outdoor_sets ?? fields.outdoorSets),
    totalSets: pickFirst(fields.total_sets ?? fields.totalSets),
    retouchedCount: pickFirst(fields.retouched_count ?? fields.retouchedCount),
    productCount: pickFirst(fields.product_count ?? fields.productCount),
    videoCount: pickFirst(fields.video_count ?? fields.videoCount),
  });
}

function formatAmount(amount) {
  if (amount === null) return '未提供';
  if (Number.isInteger(amount)) return `${amount} 元`;
  return `${amount.toFixed(2)} 元`;
}

function formatOrderLabel(status) {
  if (status === 'yes') return '已下单';
  if (status === 'no') return '未下单';
  return '未提供';
}

function valueOrUnknown(value) {
  return value === null ? '未提供' : `${value}`;
}

function formatSalesContextForPrompt(input = {}) {
  const context = normalizeSalesContext(input);
  if (!context.hasAnyData) return '（未提供）';

  const hasOrderText = formatOrderLabel(context.hasOrder);
  const orderAmountText = formatAmount(context.orderAmount);
  const orderSetsText =
    context.totalSets === null && context.indoorSets === null && context.outdoorSets === null
      ? '未提供'
      : `${valueOrUnknown(context.totalSets)} 套（内景 ${valueOrUnknown(context.indoorSets)}，外景 ${valueOrUnknown(context.outdoorSets)}）`;

  return [
    `- 是否订单：${hasOrderText}`,
    `- 订单金额：${orderAmountText}`,
    `- 订单套数：${orderSetsText}`,
    `- 精修数量：${valueOrUnknown(context.retouchedCount)}`,
    `- 产品数量：${valueOrUnknown(context.productCount)}`,
    `- 视频数量：${valueOrUnknown(context.videoCount)}`,
  ].join('\n');
}

module.exports = {
  normalizeSalesContext,
  parseSalesContextFromFields,
  formatSalesContextForPrompt,
};
