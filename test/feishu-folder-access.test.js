const test = require('node:test');
const assert = require('node:assert/strict');

const {
  grantFeishuFolderAccess,
  parseGrantFeishuFolderAccessArgs,
} = require('../feishu-folder-access');

function createResponse({ ok, status, payload }) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

test('grantFeishuFolderAccess posts folder permission grant with expected query and body', async () => {
  const calls = [];
  const result = await grantFeishuFolderAccess({
    folderToken: 'fldcn_test',
    userAccessToken: 'u-test',
    appOpenId: 'ou_app_test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return createResponse({
        ok: true,
        status: 200,
        payload: {
          code: 0,
          msg: 'success',
          data: {
            member: {
              member_type: 'openid',
              member_id: 'ou_app_test',
              perm: 'edit',
            },
          },
        },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://open.feishu.cn/open-apis/drive/v1/permissions/fldcn_test/members?type=folder&need_notification=false',
  );
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer u-test');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    member_type: 'openid',
    member_id: 'ou_app_test',
    perm: 'edit',
  });
  assert.equal(result.member.member_id, 'ou_app_test');
});

test('grantFeishuFolderAccess throws helpful error with Feishu response body on permission failure', async () => {
  await assert.rejects(
    grantFeishuFolderAccess({
      folderToken: 'fldcn_test',
      userAccessToken: 'u-test',
      appOpenId: 'ou_app_test',
      fetchImpl: async () =>
        createResponse({
          ok: false,
          status: 403,
          payload: {
            code: 1770040,
            msg: 'no folder permission',
          },
        }),
    }),
    (error) => {
      assert.match(error.message, /403/);
      assert.match(error.message, /no folder permission/);
      return true;
    },
  );
});

test('parseGrantFeishuFolderAccessArgs reads required inputs from argv and env defaults', () => {
  const args = parseGrantFeishuFolderAccessArgs(
    [
      '--folder-token',
      'fldcn_test',
      '--user-access-token',
      'u-test',
      '--app-open-id',
      'ou_app_test',
    ],
    {
      FEISHU_FOLDER_MEMBER_TYPE: 'openid',
      FEISHU_FOLDER_PERMISSION: 'edit',
      FEISHU_OPEN_BASE_URL: 'https://open.feishu.cn',
      FEISHU_API_TIMEOUT_MS: '45000',
    },
  );

  assert.deepEqual(args, {
    folderToken: 'fldcn_test',
    userAccessToken: 'u-test',
    appOpenId: 'ou_app_test',
    memberType: 'openid',
    perm: 'edit',
    baseUrl: 'https://open.feishu.cn',
    timeoutMs: 45000,
    needNotification: false,
  });
});

test('parseGrantFeishuFolderAccessArgs rejects missing required values', () => {
  assert.throws(
    () => parseGrantFeishuFolderAccessArgs([], {}),
    /Missing required arguments: folder-token, user-access-token, app-open-id/,
  );
});
