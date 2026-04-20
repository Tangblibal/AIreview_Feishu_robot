function parseGrantFeishuFolderAccessArgs(argv, env = process.env) {
  const args = parseCliArgs(argv);
  const folderToken = `${args['folder-token'] || env.FEISHU_FOLDER_TOKEN || ''}`.trim();
  const userAccessToken = `${args['user-access-token'] || env.FEISHU_USER_ACCESS_TOKEN || ''}`.trim();
  const appOpenId = `${args['app-open-id'] || env.FEISHU_APP_OPEN_ID || ''}`.trim();
  const memberType = `${args['member-type'] || env.FEISHU_FOLDER_MEMBER_TYPE || 'openid'}`.trim() || 'openid';
  const perm = `${args.perm || env.FEISHU_FOLDER_PERMISSION || 'edit'}`.trim() || 'edit';
  const baseUrl = `${args['base-url'] || env.FEISHU_OPEN_BASE_URL || 'https://open.feishu.cn'}`.trim() || 'https://open.feishu.cn';
  const timeoutMs = parsePositiveNumber(args['timeout-ms'] || env.FEISHU_API_TIMEOUT_MS) || 30000;
  const needNotification = parseBooleanFlag(args['need-notification'], env.FEISHU_NEED_NOTIFICATION);

  const missing = [];
  if (!folderToken) missing.push('folder-token');
  if (!userAccessToken) missing.push('user-access-token');
  if (!appOpenId) missing.push('app-open-id');
  if (missing.length) {
    throw new Error(`Missing required arguments: ${missing.join(', ')}`);
  }

  return {
    folderToken,
    userAccessToken,
    appOpenId,
    memberType,
    perm,
    baseUrl,
    timeoutMs,
    needNotification,
  };
}

async function grantFeishuFolderAccess({
  folderToken,
  userAccessToken,
  appOpenId,
  memberType = 'openid',
  perm = 'edit',
  baseUrl = 'https://open.feishu.cn',
  timeoutMs = 30000,
  needNotification = false,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required to grant Feishu folder access.');
  }

  const trimmedBaseUrl = `${baseUrl || 'https://open.feishu.cn'}`.replace(/\/$/, '');
  const url = new URL(`${trimmedBaseUrl}/open-apis/drive/v1/permissions/${encodeURIComponent(folderToken)}/members`);
  url.searchParams.set('type', 'folder');
  url.searchParams.set('need_notification', needNotification ? 'true' : 'false');

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer =
    controller && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error('Request timed out.')), timeoutMs)
      : null;

  try {
    const response = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userAccessToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        member_type: memberType,
        member_id: appOpenId,
        perm,
      }),
      signal: controller?.signal,
    });

    const payload = await parseJsonOrText(response);
    if (!response.ok) {
      throw new Error(`Feishu folder access grant failed: ${response.status} ${formatPayload(payload)}`.trim());
    }
    if (payload?.code && payload.code !== 0) {
      throw new Error(`Feishu folder access grant failed: ${payload.code} ${payload.msg || formatPayload(payload)}`.trim());
    }
    return payload?.data || payload || {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function parseJsonOrText(response) {
  if (!response) return {};
  try {
    return await response.json();
  } catch (error) {
    const text = await response.text().catch(() => '');
    try {
      return JSON.parse(text);
    } catch (jsonError) {
      return text;
    }
  }
}

function formatPayload(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch (error) {
    return `${payload}`;
  }
}

function parseCliArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function parsePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBooleanFlag(cliValue, envValue) {
  if (cliValue !== undefined) {
    return ['1', 'true', 'yes', 'on'].includes(`${cliValue}`.trim().toLowerCase());
  }
  if (envValue === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(`${envValue}`.trim().toLowerCase());
}

module.exports = {
  grantFeishuFolderAccess,
  parseGrantFeishuFolderAccessArgs,
};
