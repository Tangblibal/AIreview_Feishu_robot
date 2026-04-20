#!/usr/bin/env node

const {
  grantFeishuFolderAccess,
  parseGrantFeishuFolderAccessArgs,
} = require('../feishu-folder-access');

async function main() {
  try {
    const options = parseGrantFeishuFolderAccessArgs(process.argv.slice(2), process.env);
    const result = await grantFeishuFolderAccess(options);
    process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  }
}

void main();
