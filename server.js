const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const formidable = require('formidable');
const { TosClient } = require('@volcengine/tos-sdk');
const { normalizeSalesContext, parseSalesContextFromFields, formatSalesContextForPrompt } = require('./sales-context');
const { submitVolcengineRequestWithRetry } = require('./volcengine-submit-retry');
const {
  extractFeishuTextFromContent,
  extractFeishuFileFromContent,
  resolveFeishuResourceType,
  mergeTranscriptWithTextInput,
  formatFeishuBotReply,
} = require('./feishu-bot');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const CONFIG_PATH = path.join(__dirname, 'config', 'ai.config.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const SESSION_COOKIE_NAME = 'lumo_session';
const REDIS_URL = process.env.REDIS_URL || process.env.RAILWAY_REDIS_URL || '';

const sessionStore = new Map();
const oauthStateStore = new Map();
const reviewJobStore = new Map();
const reviewJobQueue = [];
const rateLimitStore = new Map();
const feishuBotTextContextStore = new Map();
const feishuBotProcessedEventStore = new Map();
let reviewWorkersInFlight = 0;
let reviewJobQueueDrainScheduled = false;
let feishuBotTenantTokenCache = null;
let feishuBotWsClient = null;

const REVIEW_JOB_STORE_BACKEND = (() => {
  const raw = `${process.env.REVIEW_JOB_STORE_BACKEND || ''}`.trim().toLowerCase();
  if (raw === 'memory' || raw === 'redis') return raw;
  return REDIS_URL ? 'redis' : 'memory';
})();
const REVIEW_JOB_REDIS_KEY_PREFIX = `${process.env.REVIEW_JOB_REDIS_KEY_PREFIX || 'review_jobs'}`.trim() || 'review_jobs';
const REVIEW_JOB_REDIS_QUEUE_KEY = `${REVIEW_JOB_REDIS_KEY_PREFIX}:queue`;
const REVIEW_JOB_REDIS_PROCESSING_KEY = `${REVIEW_JOB_REDIS_KEY_PREFIX}:processing`;
const REVIEW_JOB_REDIS_DONE_KEY = `${REVIEW_JOB_REDIS_KEY_PREFIX}:done`;
let redisRecoveryDone = false;

function envInteger(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || `${raw}`.trim() === '') return fallback;
  const parsed = Number.parseInt(`${raw}`, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseRedisConnection(urlString) {
  if (!urlString) return null;
  try {
    const parsed = new URL(urlString);
    if (!['redis:', 'rediss:'].includes(parsed.protocol)) {
      console.warn(`[redis] Unsupported protocol: ${parsed.protocol}`);
      return null;
    }
    const dbRaw = `${parsed.pathname || ''}`.replace(/^\//, '');
    const db = dbRaw ? Number.parseInt(dbRaw, 10) : 0;
    return {
      tls: parsed.protocol === 'rediss:',
      host: parsed.hostname,
      port: Number.parseInt(parsed.port || '6379', 10),
      username: parsed.username ? decodeURIComponent(parsed.username) : '',
      password: parsed.password ? decodeURIComponent(parsed.password) : '',
      db: Number.isFinite(db) && db >= 0 ? db : 0,
    };
  } catch (error) {
    console.warn(`[redis] Failed to parse REDIS_URL: ${error.message}`);
    return null;
  }
}

const REDIS_CONNECTION = parseRedisConnection(REDIS_URL);

function encodeRedisCommand(args) {
  const encodedArgs = args.map((arg) => `${arg === undefined || arg === null ? '' : arg}`);
  const chunks = [`*${encodedArgs.length}\r\n`];
  encodedArgs.forEach((arg) => {
    const len = Buffer.byteLength(arg);
    chunks.push(`$${len}\r\n${arg}\r\n`);
  });
  return chunks.join('');
}

function tryParseRedisResp(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const type = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf('\r\n', offset);
  if (lineEnd === -1) return null;
  const header = buffer.toString('utf8', offset + 1, lineEnd);
  const headerBytes = lineEnd + 2 - offset;

  if (type === '+') return { value: header, bytes: headerBytes };
  if (type === ':') return { value: Number.parseInt(header, 10), bytes: headerBytes };
  if (type === '-') {
    const error = new Error(header || 'Redis command failed');
    error.code = 'REDIS_COMMAND_FAILED';
    return { error, bytes: headerBytes };
  }
  if (type === '$') {
    const bulkLength = Number.parseInt(header, 10);
    if (!Number.isFinite(bulkLength)) {
      const error = new Error(`Invalid Redis bulk length: ${header}`);
      error.code = 'REDIS_PROTOCOL_ERROR';
      return { error, bytes: headerBytes };
    }
    if (bulkLength === -1) return { value: null, bytes: headerBytes };
    const bodyStart = lineEnd + 2;
    const bodyEnd = bodyStart + bulkLength;
    if (buffer.length < bodyEnd + 2) return null;
    const value = buffer.toString('utf8', bodyStart, bodyEnd);
    return { value, bytes: bodyEnd + 2 - offset };
  }
  if (type === '*') {
    const arrayLength = Number.parseInt(header, 10);
    if (!Number.isFinite(arrayLength)) {
      const error = new Error(`Invalid Redis array length: ${header}`);
      error.code = 'REDIS_PROTOCOL_ERROR';
      return { error, bytes: headerBytes };
    }
    if (arrayLength === -1) return { value: null, bytes: headerBytes };
    let cursor = lineEnd + 2;
    const items = [];
    for (let i = 0; i < arrayLength; i += 1) {
      const parsed = tryParseRedisResp(buffer, cursor);
      if (!parsed) return null;
      if (parsed.error) return { error: parsed.error, bytes: cursor + parsed.bytes - offset };
      items.push(parsed.value);
      cursor += parsed.bytes;
    }
    return { value: items, bytes: cursor - offset };
  }
  const error = new Error(`Unsupported Redis response type: ${type}`);
  error.code = 'REDIS_PROTOCOL_ERROR';
  return { error, bytes: headerBytes };
}

async function redisPipeline(commands, { timeoutMs = 5000 } = {}) {
  if (!REDIS_CONNECTION) {
    throw createAppError('REDIS_URL_MISSING', 'Redis is not configured.', 500);
  }
  const preamble = [];
  if (REDIS_CONNECTION.password) {
    if (REDIS_CONNECTION.username) {
      preamble.push(['AUTH', REDIS_CONNECTION.username, REDIS_CONNECTION.password]);
    } else {
      preamble.push(['AUTH', REDIS_CONNECTION.password]);
    }
  }
  if (REDIS_CONNECTION.db > 0) {
    preamble.push(['SELECT', `${REDIS_CONNECTION.db}`]);
  }
  const allCommands = [...preamble, ...commands];
  const expectedReplies = allCommands.length;
  const preambleReplies = preamble.length;

  return new Promise((resolve, reject) => {
    let settled = false;
    let receivedReplies = 0;
    let buffer = Buffer.alloc(0);
    const replies = [];

    const socket = REDIS_CONNECTION.tls
      ? tls.connect({
          host: REDIS_CONNECTION.host,
          port: REDIS_CONNECTION.port,
          servername: REDIS_CONNECTION.host,
        })
      : net.createConnection({
          host: REDIS_CONNECTION.host,
          port: REDIS_CONNECTION.port,
        });

    function doneWithError(error) {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    }

    function doneOk() {
      if (settled) return;
      settled = true;
      socket.end();
      resolve(replies.slice(preambleReplies));
    }

    socket.setTimeout(timeoutMs, () => {
      const timeoutError = createAppError('REDIS_TIMEOUT', 'Redis command timeout.', 504);
      doneWithError(timeoutError);
    });

    socket.on('error', (error) => {
      doneWithError(createAppError('REDIS_UNAVAILABLE', `Redis unavailable: ${error.message}`, 503));
    });
    socket.on('close', () => {
      if (settled) return;
      doneWithError(createAppError('REDIS_CONNECTION_CLOSED', 'Redis connection closed unexpectedly.', 503));
    });

    socket.on('connect', () => {
      try {
        allCommands.forEach((cmd) => {
          socket.write(encodeRedisCommand(cmd), 'utf8');
        });
      } catch (error) {
        doneWithError(createAppError('REDIS_COMMAND_ENCODE_FAILED', error.message, 500));
      }
    });

    socket.on('data', (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      while (receivedReplies < expectedReplies) {
        const parsed = tryParseRedisResp(buffer, 0);
        if (!parsed) break;
        if (parsed.error) {
          doneWithError(createAppError(parsed.error.code || 'REDIS_COMMAND_FAILED', parsed.error.message, 502));
          return;
        }
        replies.push(parsed.value);
        receivedReplies += 1;
        buffer = buffer.slice(parsed.bytes);
      }
      if (receivedReplies === expectedReplies) {
        doneOk();
      }
    });
  });
}

async function redisCommand(...args) {
  const [reply] = await redisPipeline([args]);
  return reply;
}

const REVIEW_JOB_DEFAULT_MODE = `${process.env.REVIEW_JOB_MODE || 'async'}`.toLowerCase() === 'sync' ? 'sync' : 'async';
const REVIEW_JOB_CONCURRENCY = envInteger('REVIEW_JOB_CONCURRENCY', 1, { min: 1, max: 8 });
const REVIEW_JOB_MAX_PENDING = envInteger('REVIEW_JOB_MAX_PENDING', 20, { min: 1, max: 500 });
const REVIEW_JOB_RESULT_TTL_MS = envInteger('REVIEW_JOB_RESULT_TTL_MS', 60 * 60 * 1000, {
  min: 60 * 1000,
  max: 24 * 60 * 60 * 1000,
});
const REVIEW_JOB_POLL_AFTER_MS = envInteger('REVIEW_JOB_POLL_AFTER_MS', 2500, { min: 1000, max: 15000 });
const RATE_LIMIT_WINDOW_MS = envInteger('RATE_LIMIT_WINDOW_MS', 60 * 1000, { min: 1000, max: 10 * 60 * 1000 });
const RATE_LIMIT_REVIEW_CREATE = envInteger('RATE_LIMIT_REVIEW_CREATE', 6, { min: 1, max: 500 });
const RATE_LIMIT_REVIEW_STATUS = envInteger('RATE_LIMIT_REVIEW_STATUS', 180, { min: 1, max: 5000 });
const RATE_LIMIT_ANALYZE = envInteger('RATE_LIMIT_ANALYZE', 30, { min: 1, max: 1000 });

const DEFAULT_CONFIG = {
  active_provider: 'deepseek',
  providers: {
    openai: {
      type: 'openai',
      base_url: 'https://api.openai.com/v1',
      api_key: '',
      model: 'gpt-4o-mini',
    },
    anthropic: {
      type: 'anthropic',
      base_url: 'https://api.anthropic.com/v1',
      api_key: '',
      model: 'claude-3-5-sonnet-20240620',
      version: '2023-06-01',
    },
    deepseek: {
      type: 'openai',
      base_url: 'https://api.deepseek.com/v1',
      api_key: '',
      model: 'deepseek-v3.2',
    },
    doubao: {
      type: 'openai',
      base_url: 'https://ark.cn-beijing.volces.com/api/v3',
      api_key: '',
      model: 'doubao-pro-32k',
    },
    qwen: {
      type: 'openai',
      base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      api_key: '',
      model: 'qwen-max',
    },
  },
  stt: {
    active_provider: 'qwen_fun_asr',
    providers: {
      qwen_fun_asr: {
        type: 'dashscope-fun-asr',
        base_url: 'https://dashscope.aliyuncs.com/api/v1',
        api_key: '',
        model: 'fun-asr',
        diarization_enabled: true,
        speaker_count: 2,
        public_base_url: '',
        public_path: '/uploads',
      },
    },
  },
};

const mockReport = {
  total: 72,
  need: 68,
  style: 76,
  objection: 63,
  close: 58,
  status: '完成 · AI 已生成复盘',
  report_markdown: `### 1. 🎯 毒辣诊断书 (Executive Diagnosis)

* **综合评分**：72 分
* **一句话定性**：销售急于成交，但价值锚点未建立，导致客户防御上升。
* **成败关键点**：未在报价前完成风格锚定与预算区间确认。

---

### 2. 🧩 逐帧流程拆解 (Process Breakdown)

| 阶段 | 关键对话片段 (摘要) | 导师点评（心理/策略分析） | 对成交的影响 |
| :--- | :--- | :--- | :--- |
| 破冰 / 迎宾 | 询问风格与用途 | 建立安全感，但缺少更深层动机追问 | 🟡减分 |
| 需求挖掘 | “想要清透感” | 未继续挖掘具体参考与场景 | 🔴致命 |

---

### 3. 🌟 亮点与复用 (What Worked)

* 主动给出风格方向选择，缩短客户思考路径。
* 建议加上样片与案例提升社会认同感。`,
  insights: [
    {
      title: '未深入确认客户风格偏好',
      content: '客户提到“想要清透感”，但未追问参考风格/肤色/场景，导致套餐推荐偏模糊。',
      logic: '未建立清晰的风格锚点与场景映射，客户无法形成确定感与安全感。',
      script: '“清透感可以走两种路线：森系偏自然、城市偏高级。您更像哪种？我再给您对应样片，保证风格不跑偏。”',
      tag: '风格沟通',
    },
    {
      title: '预算异议后缺少下一步推进',
      content: '客户提出“有点超预算”，未给出分级方案或付费节奏，建议补充分期/档位对比。',
      logic: '没有提供可控选择，客户只能在“接受/拒绝”之间二选一，容易退缩。',
      script: '“如果您更在意预算，我们有 6999/7999/9999 三档。我先按您最在意的风格挑两档，您看哪档更贴合。”',
      tag: '异议处理',
    },
    {
      title: '未明确锁档与定金动作',
      content: '收尾仅说“可以考虑”，未提出具体档期锁定或体验券，导致成交压力不足。',
      logic: '缺少小承诺动作，成交动能断裂，客户没有进入“已开始”的心理状态。',
      script: '“周末档期很紧，我先帮您保留一个黄金时间段，付 500 定金即可锁档，您看要不要先占位？”',
      tag: '成交推进',
    },
  ],
};

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
};
const ALLOWED_AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']);
const ALLOWED_AUDIO_MIME_PREFIXES = ['audio/', 'application/mp4'];
const MAX_AUDIO_FILE_SIZE_MB = Number(process.env.MAX_AUDIO_FILE_SIZE_MB || 50);
const MAX_AUDIO_FILE_SIZE_BYTES = Number.isFinite(MAX_AUDIO_FILE_SIZE_MB)
  ? Math.max(1, MAX_AUDIO_FILE_SIZE_MB) * 1024 * 1024
  : 50 * 1024 * 1024;

function sendJson(res, status, payload) {
  const output =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...payload, request_id: payload.request_id || res.getHeader('X-Request-Id') || undefined }
      : payload;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(output));
}

function createRequestId() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function createAppError(code, message, status = 500, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.extra = extra;
  return error;
}

function buildErrorPayload(req, error, fallbackMessage) {
  return {
    ok: false,
    error_code: error?.code || 'INTERNAL_ERROR',
    message: error?.message || fallbackMessage,
    request_id: req.requestId,
    ...(error?.extra && typeof error.extra === 'object' ? error.extra : {}),
  };
}

function resolveErrorStatus(error, fallbackStatus = 500) {
  if (error?.status && Number.isInteger(error.status)) return error.status;
  if (error?.httpCode && Number.isInteger(error.httpCode)) return error.httpCode;
  if (error?.name === 'AbortError') return 504;
  return fallbackStatus;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function consumeRateLimitToken(req, key, maxRequests, windowMs) {
  const now = Date.now();
  const bucketKey = `${key}:${getClientIp(req)}`;
  const existing = rateLimitStore.get(bucketKey);
  if (!existing || existing.resetAt <= now) {
    const nextBucket = { count: 1, resetAt: now + windowMs };
    rateLimitStore.set(bucketKey, nextBucket);
    return {
      ok: true,
      remaining: Math.max(0, maxRequests - 1),
      retryAfterSeconds: Math.ceil(windowMs / 1000),
    };
  }
  existing.count += 1;
  if (existing.count > maxRequests) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  return {
    ok: true,
    remaining: Math.max(0, maxRequests - existing.count),
    retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
  };
}

function enforceRateLimit(req, res, key, maxRequests, windowMs = RATE_LIMIT_WINDOW_MS) {
  const result = consumeRateLimitToken(req, key, maxRequests, windowMs);
  if (result.ok) return true;
  res.setHeader('Retry-After', `${result.retryAfterSeconds}`);
  sendJson(res, 429, {
    ok: false,
    error_code: 'RATE_LIMITED',
    message: '请求过于频繁，请稍后重试。',
    retry_after_seconds: result.retryAfterSeconds,
  });
  return false;
}

function cleanupRateLimitStore() {
  const now = Date.now();
  rateLimitStore.forEach((bucket, key) => {
    if (!bucket || bucket.resetAt <= now) {
      rateLimitStore.delete(key);
    }
  });
}

function buildJobOwnerKey(user, req) {
  if (user?.open_id) return `open_id:${user.open_id}`;
  if (user?.email) return `email:${user.email}`;
  return `ip:${getClientIp(req)}`;
}

function normalizeJobError(error, fallbackMessage = 'Review failed') {
  return {
    error_code: error?.code || 'INTERNAL_ERROR',
    message: error?.message || fallbackMessage,
    http_status: resolveErrorStatus(error, 500),
    ...(error?.extra && typeof error.extra === 'object' ? error.extra : {}),
  };
}

function tryRemoveFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.warn(`[upload] Failed to remove file ${filePath}: ${error.message}`);
  }
}

function extractAudioFileFromMultipart(files = {}) {
  let audioFile = Array.isArray(files.audio) ? files.audio[0] : files.audio;
  if (audioFile) return audioFile;
  const firstKey = Object.keys(files)[0];
  const firstFile = firstKey ? files[firstKey] : null;
  return Array.isArray(firstFile) ? firstFile[0] : firstFile;
}

function parseTemplatesFromFields(fields = {}) {
  if (!fields.templates) return [];
  try {
    const rawTemplates = Array.isArray(fields.templates) ? fields.templates[0] : fields.templates;
    const parsed = JSON.parse(rawTemplates);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function resolveReviewMode(url) {
  const mode = `${url.searchParams.get('mode') || ''}`.trim().toLowerCase();
  if (mode === 'sync' || url.searchParams.get('sync') === '1') return 'sync';
  if (mode === 'async') return 'async';
  return REVIEW_JOB_DEFAULT_MODE;
}

function isTerminalReviewJobStatus(status) {
  return status === 'succeeded' || status === 'failed';
}

function usesRedisReviewStore() {
  return REVIEW_JOB_STORE_BACKEND === 'redis' && Boolean(REDIS_CONNECTION);
}

function reviewJobRedisKey(jobId) {
  return `${REVIEW_JOB_REDIS_KEY_PREFIX}:job:${jobId}`;
}

function parseStoredReviewJob(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') return null;
  try {
    const job = JSON.parse(rawValue);
    if (!job?.id) return null;
    return job;
  } catch (error) {
    return null;
  }
}

async function getStoredReviewJob(jobId) {
  if (!jobId) return null;
  if (!usesRedisReviewStore()) {
    return reviewJobStore.get(jobId) || null;
  }
  const raw = await redisCommand('GET', reviewJobRedisKey(jobId));
  return parseStoredReviewJob(raw);
}

async function saveStoredReviewJob(job) {
  if (!job?.id) return;
  if (!usesRedisReviewStore()) {
    reviewJobStore.set(job.id, job);
    return;
  }
  const payload = JSON.stringify(job);
  if (isTerminalReviewJobStatus(job.status)) {
    await redisPipeline([
      ['SET', reviewJobRedisKey(job.id), payload, 'PX', `${REVIEW_JOB_RESULT_TTL_MS}`],
      ['ZADD', REVIEW_JOB_REDIS_DONE_KEY, `${job.finishedAt || Date.now()}`, job.id],
    ]);
    return;
  }
  await redisCommand('SET', reviewJobRedisKey(job.id), payload);
}

async function deleteStoredReviewJob(jobId) {
  if (!jobId) return;
  if (!usesRedisReviewStore()) {
    reviewJobStore.delete(jobId);
    return;
  }
  await redisPipeline([
    ['DEL', reviewJobRedisKey(jobId)],
    ['LREM', REVIEW_JOB_REDIS_QUEUE_KEY, '0', jobId],
    ['LREM', REVIEW_JOB_REDIS_PROCESSING_KEY, '0', jobId],
    ['ZREM', REVIEW_JOB_REDIS_DONE_KEY, jobId],
  ]);
}

async function recoverRedisProcessingJobs() {
  if (!usesRedisReviewStore()) return;
  if (redisRecoveryDone) return;
  const processingIds = (await redisCommand('LRANGE', REVIEW_JOB_REDIS_PROCESSING_KEY, '0', '-1')) || [];
  if (!Array.isArray(processingIds) || processingIds.length === 0) {
    redisRecoveryDone = true;
    return;
  }
  for (const jobId of processingIds) {
    const job = await getStoredReviewJob(jobId);
    if (!job) {
      await redisCommand('LREM', REVIEW_JOB_REDIS_PROCESSING_KEY, '0', jobId);
      continue;
    }
    if (isTerminalReviewJobStatus(job.status)) {
      await redisCommand('LREM', REVIEW_JOB_REDIS_PROCESSING_KEY, '0', jobId);
      continue;
    }
    job.status = 'queued';
    job.startedAt = null;
    job.updatedAt = Date.now();
    await saveStoredReviewJob(job);
    await redisPipeline([
      ['LREM', REVIEW_JOB_REDIS_QUEUE_KEY, '0', jobId],
      ['LREM', REVIEW_JOB_REDIS_PROCESSING_KEY, '0', jobId],
      ['LPUSH', REVIEW_JOB_REDIS_QUEUE_KEY, jobId],
    ]);
  }
  redisRecoveryDone = true;
}

async function getReviewJobQueuePosition(jobId) {
  if (!jobId) return 0;
  if (!usesRedisReviewStore()) {
    const index = reviewJobQueue.indexOf(jobId);
    return index === -1 ? 0 : Math.max(1, index + 1);
  }
  const queueIds = (await redisCommand('LRANGE', REVIEW_JOB_REDIS_QUEUE_KEY, '0', '-1')) || [];
  if (!Array.isArray(queueIds) || queueIds.length === 0) return 0;
  for (let i = queueIds.length - 1; i >= 0; i -= 1) {
    if (queueIds[i] === jobId) {
      return queueIds.length - i;
    }
  }
  return 0;
}

async function getReviewQueueMetrics() {
  if (!usesRedisReviewStore()) {
    return {
      mode: REVIEW_JOB_DEFAULT_MODE,
      in_flight: reviewWorkersInFlight,
      queued: reviewJobQueue.length,
      concurrency: REVIEW_JOB_CONCURRENCY,
      max_pending: REVIEW_JOB_MAX_PENDING,
    };
  }
  const [queuedRaw, processingRaw] = await redisPipeline([
    ['LLEN', REVIEW_JOB_REDIS_QUEUE_KEY],
    ['LLEN', REVIEW_JOB_REDIS_PROCESSING_KEY],
  ]);
  return {
    mode: REVIEW_JOB_DEFAULT_MODE,
    in_flight: Number(processingRaw || 0),
    queued: Number(queuedRaw || 0),
    concurrency: REVIEW_JOB_CONCURRENCY,
    max_pending: REVIEW_JOB_MAX_PENDING,
  };
}

async function pruneReviewJobs() {
  const now = Date.now();
  if (!usesRedisReviewStore()) {
    reviewJobStore.forEach((job, jobId) => {
      if (!job) {
        reviewJobStore.delete(jobId);
        return;
      }
      if (!isTerminalReviewJobStatus(job.status)) return;
      const completedAt = job.finishedAt || job.updatedAt || job.createdAt;
      if (completedAt && now - completedAt > REVIEW_JOB_RESULT_TTL_MS) {
        reviewJobStore.delete(jobId);
      }
    });
    return;
  }

  await recoverRedisProcessingJobs();

  const expireBefore = now - REVIEW_JOB_RESULT_TTL_MS;
  const expiredIds = (await redisCommand(
    'ZRANGEBYSCORE',
    REVIEW_JOB_REDIS_DONE_KEY,
    '-inf',
    `${expireBefore}`,
  )) || [];
  if (Array.isArray(expiredIds) && expiredIds.length > 0) {
    const commands = [];
    expiredIds.forEach((jobId) => {
      commands.push(['DEL', reviewJobRedisKey(jobId)]);
      commands.push(['ZREM', REVIEW_JOB_REDIS_DONE_KEY, jobId]);
      commands.push(['LREM', REVIEW_JOB_REDIS_QUEUE_KEY, '0', jobId]);
      commands.push(['LREM', REVIEW_JOB_REDIS_PROCESSING_KEY, '0', jobId]);
    });
    await redisPipeline(commands);
  }
}

function logReviewJobEvent(level, event, job, extra = {}) {
  console.log(
    JSON.stringify({
      at: nowIso(),
      level,
      event,
      job_id: job.id,
      request_id: job.requestId,
      status: job.status,
      ...extra,
    }),
  );
}

function isSttDebugEnabled() {
  return readEnvBoolean('STT_DEBUG_ENABLED') ?? false;
}

function buildSttDebugPayload(sttResult, fileInfo) {
  const base = {
    file: {
      filename: fileInfo.filename,
      contentType: fileInfo.contentType,
      size: fileInfo.data?.length || 0,
      publicUrl: fileInfo.publicUrl,
      tosObjectKey: fileInfo.tosObjectKey,
    },
  };
  if (isSttDebugEnabled()) {
    return { ...sttResult.debug, ...base };
  }
  if (sttResult?.debug?.requestId) {
    return { requestId: sttResult.debug.requestId, ...base };
  }
  return base;
}

function safeJoin(base, target) {
  const targetPath = path.normalize(path.join(base, target));
  if (!targetPath.startsWith(base)) return null;
  return targetPath;
}

function ensureUploadsDir() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

function sanitizeFilename(name = 'audio') {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function validateUploadedAudioFile(audioFile) {
  const fileSize = Number(audioFile?.size || 0);
  if (!fileSize || fileSize <= 0) {
    throw createAppError('INVALID_AUDIO_FILE', '音频文件为空或不可读。', 400);
  }
  if (fileSize > MAX_AUDIO_FILE_SIZE_BYTES) {
    throw createAppError(
      'AUDIO_FILE_TOO_LARGE',
      `音频文件过大，最大支持 ${Math.floor(MAX_AUDIO_FILE_SIZE_BYTES / (1024 * 1024))}MB。`,
      413,
      { max_size_mb: Math.floor(MAX_AUDIO_FILE_SIZE_BYTES / (1024 * 1024)) },
    );
  }
  const fileName = `${audioFile?.originalFilename || ''}`.toLowerCase();
  const ext = path.extname(fileName);
  const mimetype = `${audioFile?.mimetype || ''}`.toLowerCase();
  const extAllowed = ext ? ALLOWED_AUDIO_EXTENSIONS.has(ext) : false;
  const mimeAllowed = ALLOWED_AUDIO_MIME_PREFIXES.some((prefix) => mimetype.startsWith(prefix));
  const octetStreamWithoutExt = mimetype === 'application/octet-stream' && !extAllowed;
  if ((!extAllowed && !mimeAllowed) || octetStreamWithoutExt) {
    throw createAppError('UNSUPPORTED_AUDIO_TYPE', '不支持的音频格式，请上传 mp3/wav/m4a/aac/flac/ogg。', 415, {
      filename: audioFile?.originalFilename || '',
      mimetype: audioFile?.mimetype || '',
    });
  }
}

function saveUploadedFile(file) {
  ensureUploadsDir();
  const safeName = sanitizeFilename(file.filename || 'audio');
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;
  const filePath = path.join(UPLOADS_DIR, unique);
  fs.writeFileSync(filePath, file.data);
  return { filename: unique, path: filePath };
}

function buildTosConfigKey(tosConfig) {
  return [
    tosConfig.access_key,
    tosConfig.secret_key,
    tosConfig.region,
    tosConfig.endpoint,
  ].join('|');
}

let cachedTosClient = null;
let cachedTosKey = null;

function getTosClient(tosConfig) {
  const key = buildTosConfigKey(tosConfig);
  if (!cachedTosClient || cachedTosKey !== key) {
    cachedTosClient = new TosClient({
      accessKeyId: tosConfig.access_key,
      accessKeySecret: tosConfig.secret_key,
      region: tosConfig.region,
      endpoint: tosConfig.endpoint,
    });
    cachedTosKey = key;
  }
  return cachedTosClient;
}

async function uploadToTos(file, tosConfig) {
  const {
    access_key: accessKey,
    secret_key: secretKey,
    bucket,
    region,
    endpoint,
    key_prefix: keyPrefix = 'uploads',
  } = tosConfig;

  if (!accessKey || !secretKey || !bucket || !region || !endpoint) {
    throw new Error('Missing TOS config');
  }

  const client = getTosClient(tosConfig);
  const safeName = sanitizeFilename(file.filename || 'audio');
  const objectKey = `${keyPrefix}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;
  const contentType = file.contentType || 'application/octet-stream';

  await client.putObject({
    bucket,
    key: objectKey,
    body: file.data,
    contentType,
  });

  const presignExpires = tosConfig.presign_expires || 900;
  const presignedUrl = client.getPreSignedUrl({
    bucket,
    key: objectKey,
    method: 'GET',
    expires: presignExpires,
  });

  return { objectKey, url: presignedUrl };
}

function getTosSignedUrlByObjectKey(tosConfig, objectKey) {
  if (!objectKey) {
    throw createAppError('MISSING_TOS_OBJECT_KEY', 'Missing TOS object key.', 500);
  }
  const {
    access_key: accessKey,
    secret_key: secretKey,
    bucket,
    region,
    endpoint,
  } = tosConfig || {};
  if (!accessKey || !secretKey || !bucket || !region || !endpoint) {
    throw createAppError('INVALID_TOS_CONFIG', 'Missing TOS config.', 500);
  }
  const client = getTosClient(tosConfig);
  const presignExpires = tosConfig.presign_expires || 900;
  return client.getPreSignedUrl({
    bucket,
    key: objectKey,
    method: 'GET',
    expires: presignExpires,
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(target, source) {
  if (!isPlainObject(source)) return target;
  Object.entries(source).forEach(([key, value]) => {
    if (isPlainObject(value)) {
      if (!isPlainObject(target[key])) {
        target[key] = {};
      }
      deepMerge(target[key], value);
      return;
    }
    target[key] = value;
  });
  return target;
}

function readEnvString(name, options = {}) {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (options.allowEmpty) return value;
  return value.trim() === '' ? undefined : value;
}

function readEnvNumber(name) {
  const value = readEnvString(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readEnvBoolean(name) {
  const value = readEnvString(name);
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function readEnvJson(name) {
  const value = readEnvString(name, { allowEmpty: true });
  if (value === undefined || value.trim() === '') return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn(`[config] Failed to parse ${name} as JSON: ${error.message}`);
    return undefined;
  }
}

function assignIfDefined(target, key, value) {
  if (value !== undefined) {
    target[key] = value;
  }
}

function ensureProvider(config, providerName) {
  if (!config.providers) config.providers = {};
  if (!isPlainObject(config.providers[providerName])) {
    config.providers[providerName] = {};
  }
  return config.providers[providerName];
}

function ensureSttProvider(config, providerName) {
  if (!isPlainObject(config.stt)) config.stt = {};
  if (!isPlainObject(config.stt.providers)) config.stt.providers = {};
  if (!isPlainObject(config.stt.providers[providerName])) {
    config.stt.providers[providerName] = {};
  }
  return config.stt.providers[providerName];
}

function applyProviderEnv(config, providerName, prefix) {
  const provider = ensureProvider(config, providerName);
  assignIfDefined(provider, 'type', readEnvString(`${prefix}_TYPE`));
  assignIfDefined(provider, 'base_url', readEnvString(`${prefix}_BASE_URL`));
  assignIfDefined(provider, 'api_key', readEnvString(`${prefix}_API_KEY`, { allowEmpty: true }));
  assignIfDefined(provider, 'model', readEnvString(`${prefix}_MODEL`));
  assignIfDefined(provider, 'auth_header', readEnvString(`${prefix}_AUTH_HEADER`));
  assignIfDefined(provider, 'auth_prefix', readEnvString(`${prefix}_AUTH_PREFIX`, { allowEmpty: true }));
  assignIfDefined(provider, 'timeout_ms', readEnvNumber(`${prefix}_TIMEOUT_MS`));
  assignIfDefined(provider, 'extra_headers', readEnvJson(`${prefix}_EXTRA_HEADERS_JSON`));
  if (providerName === 'anthropic') {
    assignIfDefined(provider, 'version', readEnvString('ANTHROPIC_VERSION'));
  }
}

function applySttProviderEnv(config, providerName, prefix) {
  const provider = ensureSttProvider(config, providerName);
  assignIfDefined(provider, 'type', readEnvString(`${prefix}_TYPE`));
  assignIfDefined(provider, 'base_url', readEnvString(`${prefix}_BASE_URL`));
  assignIfDefined(provider, 'api_key', readEnvString(`${prefix}_API_KEY`, { allowEmpty: true }));
  assignIfDefined(provider, 'model', readEnvString(`${prefix}_MODEL`));
  assignIfDefined(provider, 'public_base_url', readEnvString(`${prefix}_PUBLIC_BASE_URL`));
  assignIfDefined(provider, 'public_path', readEnvString(`${prefix}_PUBLIC_PATH`));
  assignIfDefined(provider, 'poll_interval_ms', readEnvNumber(`${prefix}_POLL_INTERVAL_MS`));
  assignIfDefined(provider, 'poll_max_attempts', readEnvNumber(`${prefix}_POLL_MAX_ATTEMPTS`));
  assignIfDefined(provider, 'query_method', readEnvString(`${prefix}_QUERY_METHOD`));
  assignIfDefined(provider, 'language', readEnvString(`${prefix}_LANGUAGE`));

  assignIfDefined(provider, 'diarization_enabled', readEnvBoolean(`${prefix}_DIARIZATION_ENABLED`));
  assignIfDefined(provider, 'speaker_count', readEnvNumber(`${prefix}_SPEAKER_COUNT`));

  assignIfDefined(provider, 'app_id', readEnvString(`${prefix}_APP_ID`));
  assignIfDefined(provider, 'access_token', readEnvString(`${prefix}_ACCESS_TOKEN`));
  assignIfDefined(provider, 'secret_key', readEnvString(`${prefix}_SECRET_KEY`));
  assignIfDefined(provider, 'resource_id', readEnvString(`${prefix}_RESOURCE_ID`));
  assignIfDefined(provider, 'model_name', readEnvString(`${prefix}_MODEL_NAME`));
  assignIfDefined(provider, 'uid', readEnvString(`${prefix}_UID`));
  assignIfDefined(provider, 'audio_format', readEnvString(`${prefix}_AUDIO_FORMAT`));
  assignIfDefined(provider, 'enable_itn', readEnvBoolean(`${prefix}_ENABLE_ITN`));
  assignIfDefined(provider, 'enable_punc', readEnvBoolean(`${prefix}_ENABLE_PUNC`));
  assignIfDefined(provider, 'enable_speaker_info', readEnvBoolean(`${prefix}_ENABLE_SPEAKER_INFO`));
  assignIfDefined(provider, 'show_utterances', readEnvBoolean(`${prefix}_SHOW_UTTERANCES`));
  assignIfDefined(provider, 'submit_max_attempts', readEnvNumber(`${prefix}_SUBMIT_MAX_ATTEMPTS`));
  assignIfDefined(provider, 'submit_retry_backoff_ms', readEnvNumber(`${prefix}_SUBMIT_RETRY_BACKOFF_MS`));
  assignIfDefined(provider, 'submit_retry_max_backoff_ms', readEnvNumber(`${prefix}_SUBMIT_RETRY_MAX_BACKOFF_MS`));
}

function applyEnvOverrides(baseConfig) {
  const config = deepMerge({}, baseConfig);

  assignIfDefined(config, 'active_provider', readEnvString('ACTIVE_PROVIDER'));
  applyProviderEnv(config, 'openai', 'OPENAI');
  applyProviderEnv(config, 'anthropic', 'ANTHROPIC');
  applyProviderEnv(config, 'deepseek', 'DEEPSEEK');
  applyProviderEnv(config, 'doubao', 'DOUBAO');
  applyProviderEnv(config, 'qwen', 'QWEN');

  if (!isPlainObject(config.stt)) config.stt = {};
  assignIfDefined(config.stt, 'active_provider', readEnvString('STT_ACTIVE_PROVIDER'));
  applySttProviderEnv(config, 'doubao_asr_2', 'STT_DOUBAO_ASR_2');
  applySttProviderEnv(config, 'qwen_fun_asr', 'STT_QWEN_FUN_ASR');

  if (!isPlainObject(config.tos)) config.tos = {};
  assignIfDefined(config.tos, 'enabled', readEnvBoolean('TOS_ENABLED'));
  assignIfDefined(config.tos, 'bucket', readEnvString('TOS_BUCKET'));
  assignIfDefined(config.tos, 'region', readEnvString('TOS_REGION'));
  assignIfDefined(config.tos, 'endpoint', readEnvString('TOS_ENDPOINT'));
  assignIfDefined(config.tos, 'access_key', readEnvString('TOS_ACCESS_KEY'));
  assignIfDefined(config.tos, 'secret_key', readEnvString('TOS_SECRET_KEY'));
  assignIfDefined(config.tos, 'key_prefix', readEnvString('TOS_KEY_PREFIX'));
  assignIfDefined(config.tos, 'presign_expires', readEnvNumber('TOS_PRESIGN_EXPIRES'));

  const configJsonOverride = readEnvJson('AI_CONFIG_JSON');
  if (configJsonOverride) {
    deepMerge(config, configJsonOverride);
  }

  return config;
}

function readConfigFile() {
  const fileConfig = (() => {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      return {};
    }
  })();

  const merged = deepMerge(deepMerge({}, DEFAULT_CONFIG), fileConfig);
  return applyEnvOverrides(merged);
}

function getActiveProvider(config) {
  const name = config.active_provider || 'openai';
  const provider = config.providers?.[name];
  if (!provider) {
    return { name: 'openai', config: DEFAULT_CONFIG.providers.openai };
  }
  return { name, config: provider };
}

function getActiveSttProvider(config) {
  const sttConfig = config.stt || {};
  const name = sttConfig.active_provider || 'deepgram';
  const provider = sttConfig.providers?.[name];
  if (!provider) {
    return { name: 'deepgram', config: null };
  }
  return { name, config: provider };
}

function toCsvSet(value) {
  if (!value) return new Set();
  return new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function getRequestProto(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string' && forwardedProto.trim()) {
    return forwardedProto.split(',')[0].trim();
  }
  return req.socket?.encrypted ? 'https' : 'http';
}

function getRequestOrigin(req) {
  const proto = getRequestProto(req);
  return `${proto}://${req.headers.host}`;
}

function getFeishuAuthConfig(req) {
  const enabled = readEnvBoolean('FEISHU_ENABLED') ?? false;
  const requiredEnv = readEnvBoolean('AUTH_REQUIRED');
  const required = requiredEnv === undefined ? enabled : requiredEnv;
  const origin = getRequestOrigin(req);
  const appId = readEnvString('FEISHU_APP_ID');
  const appSecret = readEnvString('FEISHU_APP_SECRET');
  const authorizeUrl = readEnvString('FEISHU_AUTHORIZE_URL') || 'https://open.feishu.cn/open-apis/authen/v1/index';
  const tokenUrl =
    readEnvString('FEISHU_TOKEN_URL') || 'https://open.feishu.cn/open-apis/authen/v1/oidc/access_token';
  const userInfoUrl =
    readEnvString('FEISHU_USERINFO_URL') || 'https://open.feishu.cn/open-apis/authen/v1/user_info';
  const redirectUri = readEnvString('FEISHU_REDIRECT_URI') || `${origin}/auth/feishu/callback`;
  const sessionTtlSec = readEnvNumber('SESSION_TTL_SECONDS') || 12 * 60 * 60;
  const allowedOpenIds = toCsvSet(readEnvString('FEISHU_ALLOWED_OPEN_IDS', { allowEmpty: true }));
  const allowedEmails = toCsvSet(readEnvString('FEISHU_ALLOWED_EMAILS', { allowEmpty: true }));
  return {
    enabled,
    required,
    appId,
    appSecret,
    authorizeUrl,
    tokenUrl,
    userInfoUrl,
    redirectUri,
    scope: readEnvString('FEISHU_SCOPE') || 'contact:user.base:readonly',
    responseType: readEnvString('FEISHU_RESPONSE_TYPE') || 'code',
    stateTtlSec: readEnvNumber('FEISHU_STATE_TTL_SECONDS') || 10 * 60,
    sessionTtlSec,
    allowedOpenIds,
    allowedEmails,
  };
}

function getFeishuBotConfig(req) {
  const defaultEnabled = readEnvBoolean('FEISHU_ENABLED') ?? false;
  const enabledFlag = readEnvBoolean('FEISHU_BOT_ENABLED');
  const enabled = enabledFlag === undefined ? defaultEnabled : enabledFlag;
  const eventModeRaw = `${readEnvString('FEISHU_BOT_EVENT_MODE') || 'webhook'}`.trim().toLowerCase();
  const eventMode = eventModeRaw === 'long_connection' ? 'long_connection' : 'webhook';
  const appId = readEnvString('FEISHU_BOT_APP_ID') || readEnvString('FEISHU_APP_ID');
  const appSecret = readEnvString('FEISHU_BOT_APP_SECRET') || readEnvString('FEISHU_APP_SECRET');
  const verificationToken =
    readEnvString('FEISHU_BOT_VERIFICATION_TOKEN', { allowEmpty: true }) ||
    readEnvString('FEISHU_VERIFICATION_TOKEN', { allowEmpty: true }) ||
    '';
  const receiveIdType = (readEnvString('FEISHU_BOT_RECEIVE_ID_TYPE') || 'chat_id').trim() || 'chat_id';
  const replyEnabledRaw = readEnvBoolean('FEISHU_BOT_REPLY_ENABLED');
  const replyEnabled = replyEnabledRaw === undefined ? true : replyEnabledRaw;
  const requireTextRaw = readEnvBoolean('FEISHU_BOT_REQUIRE_TEXT_WITH_AUDIO');
  const requireTextWithAudio = requireTextRaw === undefined ? false : requireTextRaw;
  return {
    enabled,
    eventMode,
    appId,
    appSecret,
    verificationToken,
    tenantTokenUrl:
      readEnvString('FEISHU_BOT_TENANT_TOKEN_URL') ||
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    messageReplyUrl: readEnvString('FEISHU_BOT_MESSAGE_REPLY_URL') || 'https://open.feishu.cn/open-apis/im/v1/messages',
    messageResourceBaseUrl:
      readEnvString('FEISHU_BOT_MESSAGE_RESOURCE_BASE_URL') || 'https://open.feishu.cn/open-apis/im/v1/messages',
    receiveIdType,
    replyEnabled,
    requireTextWithAudio,
    textCacheTtlSec: readEnvNumber('FEISHU_BOT_TEXT_CACHE_TTL_SECONDS') || 15 * 60,
    processedEventTtlSec: readEnvNumber('FEISHU_BOT_EVENT_TTL_SECONDS') || 10 * 60,
    replyMaxLength: readEnvNumber('FEISHU_BOT_REPLY_MAX_LENGTH') || 3500,
    downloadTimeoutMs: readEnvNumber('FEISHU_BOT_DOWNLOAD_TIMEOUT_MS') || 120000,
    requestTimeoutMs: readEnvNumber('FEISHU_BOT_REQUEST_TIMEOUT_MS') || 20000,
    origin: req ? getRequestOrigin(req) : readEnvString('FEISHU_BOT_PUBLIC_ORIGIN', { allowEmpty: true }) || '',
  };
}

function isFeishuBotLongConnectionMode(config) {
  return config?.eventMode === 'long_connection';
}

function cleanupExpiredFeishuBotCache() {
  const now = Date.now();
  feishuBotTextContextStore.forEach((record, key) => {
    if (!record || record.expiresAt <= now) feishuBotTextContextStore.delete(key);
  });
  feishuBotProcessedEventStore.forEach((expiresAt, key) => {
    if (!expiresAt || expiresAt <= now) feishuBotProcessedEventStore.delete(key);
  });
  if (feishuBotTenantTokenCache?.expiresAt && feishuBotTenantTokenCache.expiresAt <= now) {
    feishuBotTenantTokenCache = null;
  }
}

function resolveFeishuSenderId(event = {}) {
  const senderId = event?.sender?.sender_id || {};
  return (
    senderId.open_id ||
    senderId.user_id ||
    senderId.union_id ||
    event?.sender?.open_id ||
    event?.sender?.user_id ||
    event?.sender?.union_id ||
    ''
  );
}

function buildFeishuConversationKey(event = {}) {
  const chatId = `${event?.message?.chat_id || ''}`.trim() || 'unknown_chat';
  const senderId = `${resolveFeishuSenderId(event)}`.trim() || 'unknown_sender';
  return `${chatId}:${senderId}`;
}

function setFeishuPendingText(conversationKey, text, ttlSec) {
  if (!conversationKey || !text) return;
  feishuBotTextContextStore.set(conversationKey, {
    text,
    expiresAt: Date.now() + Math.max(30, ttlSec || 30) * 1000,
  });
}

function consumeFeishuPendingText(conversationKey) {
  if (!conversationKey) return '';
  const record = feishuBotTextContextStore.get(conversationKey);
  if (!record) return '';
  feishuBotTextContextStore.delete(conversationKey);
  if (!record.text || record.expiresAt <= Date.now()) return '';
  return `${record.text}`.trim();
}

function hasProcessedFeishuEvent(eventId) {
  if (!eventId) return false;
  const expiresAt = feishuBotProcessedEventStore.get(eventId);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    feishuBotProcessedEventStore.delete(eventId);
    return false;
  }
  return true;
}

function markFeishuEventProcessed(eventId, ttlSec) {
  if (!eventId) return;
  feishuBotProcessedEventStore.set(eventId, Date.now() + Math.max(30, ttlSec || 30) * 1000);
}

async function getFeishuBotTenantAccessToken(config) {
  const now = Date.now();
  if (
    feishuBotTenantTokenCache?.token &&
    feishuBotTenantTokenCache?.expiresAt > now &&
    feishuBotTenantTokenCache?.appId === config.appId
  ) {
    return feishuBotTenantTokenCache.token;
  }
  if (!config.appId || !config.appSecret) {
    throw createAppError('FEISHU_BOT_APP_CREDENTIALS_MISSING', 'Missing FEISHU_BOT_APP_ID or FEISHU_BOT_APP_SECRET.', 500);
  }
  const response = await fetchWithTimeout(
    config.tenantTokenUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        app_id: config.appId,
        app_secret: config.appSecret,
      }),
    },
    config.requestTimeoutMs,
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw createAppError(
      'FEISHU_BOT_TOKEN_FETCH_FAILED',
      `Feishu tenant token request failed: ${response.status}.`,
      502,
      { debug: { response: text.slice(0, 300) } },
    );
  }
  const payload = await response.json().catch(() => ({}));
  if (payload?.code && payload.code !== 0) {
    throw createAppError(
      'FEISHU_BOT_TOKEN_FETCH_FAILED',
      `Feishu tenant token request failed: ${payload.msg || payload.code}.`,
      502,
      { debug: { response: payload } },
    );
  }
  const data = payload?.tenant_access_token ? payload : payload?.data || {};
  const token = data?.tenant_access_token;
  if (!token) {
    throw createAppError('FEISHU_BOT_TOKEN_MISSING', 'Feishu tenant token missing in response.', 502);
  }
  const expireSecondsRaw = Number(data.expire || data.expire_in || data.expires_in || 7200);
  const expireSeconds = Number.isFinite(expireSecondsRaw) ? Math.max(300, expireSecondsRaw) : 7200;
  feishuBotTenantTokenCache = {
    appId: config.appId,
    token,
    expiresAt: now + Math.max(120, expireSeconds - 60) * 1000,
  };
  return token;
}

function resolveFeishuReceiveId(config, event = {}) {
  const senderId = event?.sender?.sender_id || {};
  const message = event?.message || {};
  const receiveByType = {
    chat_id: message.chat_id || '',
    open_id: senderId.open_id || event?.sender?.open_id || '',
    user_id: senderId.user_id || event?.sender?.user_id || '',
    union_id: senderId.union_id || event?.sender?.union_id || '',
  };
  return receiveByType[config.receiveIdType] || message.chat_id || '';
}

function parseFilenameFromContentDisposition(contentDisposition = '') {
  if (!contentDisposition) return '';
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]).trim();
    } catch (error) {
      return utf8Match[1].trim();
    }
  }
  const plainMatch = contentDisposition.match(/filename="?([^\";]+)"?/i);
  return plainMatch?.[1] ? plainMatch[1].trim() : '';
}

async function downloadFeishuMessageResource({ config, messageId, fileKey, resourceType, fallbackFileName }) {
  if (!messageId || !fileKey) {
    throw createAppError('FEISHU_BOT_RESOURCE_ARGS_INVALID', 'Missing message id or file key.', 400);
  }
  const token = await getFeishuBotTenantAccessToken(config);
  const base = config.messageResourceBaseUrl.replace(/\/$/, '');
  const resourceUrl = `${base}/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${encodeURIComponent(
    resourceType,
  )}`;
  const response = await fetchWithTimeout(
    resourceUrl,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
    config.downloadTimeoutMs,
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw createAppError(
      'FEISHU_BOT_RESOURCE_DOWNLOAD_FAILED',
      `Feishu resource download failed: ${response.status}.`,
      502,
      { debug: { response: text.slice(0, 300) } },
    );
  }
  const data = Buffer.from(await response.arrayBuffer());
  const contentType = `${response.headers.get('content-type') || 'application/octet-stream'}`.split(';')[0].trim();
  const contentDisposition = response.headers.get('content-disposition') || '';
  const filename =
    parseFilenameFromContentDisposition(contentDisposition) ||
    fallbackFileName ||
    (resourceType === 'audio' ? `feishu_audio_${Date.now()}.m4a` : `feishu_file_${Date.now()}`);
  return {
    filename,
    contentType,
    data,
  };
}

async function sendFeishuBotTextMessage(config, receiveId, text) {
  if (!config.replyEnabled || !receiveId || !text) return;
  const token = await getFeishuBotTenantAccessToken(config);
  const messageUrl = new URL(config.messageReplyUrl);
  messageUrl.searchParams.set('receive_id_type', config.receiveIdType);
  const response = await fetchWithTimeout(
    messageUrl.toString(),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    },
    config.requestTimeoutMs,
  );
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw createAppError(
      'FEISHU_BOT_SEND_MESSAGE_FAILED',
      `Feishu send message failed: ${response.status}.`,
      502,
      { debug: { response: bodyText.slice(0, 300) } },
    );
  }
  const payload = await response.json().catch(() => ({}));
  if (payload?.code && payload.code !== 0) {
    throw createAppError(
      'FEISHU_BOT_SEND_MESSAGE_FAILED',
      `Feishu send message failed: ${payload.msg || payload.code}.`,
      502,
      { debug: { response: payload } },
    );
  }
}

function toFeishuBotFailureText(error) {
  if (!error) return '处理失败，请稍后重试。';
  if (error.code === 'VOLCENGINE_QUOTA_EXCEEDED') {
    return '语音转写额度已用尽（Volcengine audio_duration_lifetime），请在火山引擎控制台扩容/充值后再试。';
  }
  if (error.code === 'VOLCENGINE_RATE_LIMITED') {
    return '当前语音转写服务繁忙（触发限流），系统已自动重试仍未成功，请 1-2 分钟后重试。';
  }
  if (error.code === 'UNSUPPORTED_AUDIO_TYPE') return '文件格式不支持，请发送 mp3/wav/m4a/aac/flac/ogg 音频。';
  if (error.code === 'AUDIO_FILE_TOO_LARGE') return error.message || '音频文件过大，请压缩后重试。';
  if (error.code === 'TOS_REQUIRED') return '当前机器人需要先配置 TOS 才能处理录音。';
  return `处理失败：${error.message || '请稍后重试。'}`;
}

async function handleFeishuBotMessageEvent(payload, config, requestId) {
  const event = payload?.event || {};
  const message = event?.message || {};
  const messageType = `${message.message_type || ''}`.trim();
  const receiveId = resolveFeishuReceiveId(config, event);
  if (!receiveId) {
    console.warn(`[feishu_bot] request_id=${requestId} receive_id missing, skip event.`);
    return;
  }

  try {
    if (messageType === 'text' || messageType === 'post') {
      const text = extractFeishuTextFromContent(messageType, message.content);
      if (!text) {
        await sendFeishuBotTextMessage(config, receiveId, '未识别到文字内容，请重新发送文本。');
        return;
      }
      const conversationKey = buildFeishuConversationKey(event);
      setFeishuPendingText(conversationKey, text, config.textCacheTtlSec);
      await sendFeishuBotTextMessage(config, receiveId, '已收到文字说明，请继续发送录音文件，我会自动转写并生成复盘。');
      return;
    }

    if (!['audio', 'file'].includes(messageType)) {
      await sendFeishuBotTextMessage(config, receiveId, `暂不支持 ${messageType || '该类型'} 消息，请发送文字和录音文件。`);
      return;
    }

    const { fileKey, fileName } = extractFeishuFileFromContent(messageType, message.content);
    if (!fileKey) {
      throw createAppError('FEISHU_BOT_FILE_KEY_MISSING', '未识别到文件标识，请重新发送录音文件。', 400);
    }

    const conversationKey = buildFeishuConversationKey(event);
    const textInput = consumeFeishuPendingText(conversationKey);
    if (config.requireTextWithAudio && !textInput) {
      await sendFeishuBotTextMessage(config, receiveId, '请先发送文字说明（客户背景、需求等），再发送录音文件。');
      return;
    }

    await sendFeishuBotTextMessage(config, receiveId, '已收到录音，正在上传、转写并生成复盘，请稍候。');
    const resourceType = resolveFeishuResourceType(messageType);
    const downloaded = await downloadFeishuMessageResource({
      config,
      messageId: `${message.message_id || ''}`.trim(),
      fileKey,
      resourceType,
      fallbackFileName: fileName || (resourceType === 'audio' ? 'feishu_audio.m4a' : 'feishu_file'),
    });

    validateUploadedAudioFile({
      size: downloaded.data.length,
      originalFilename: downloaded.filename,
      mimetype: downloaded.contentType,
    });

    const runtimeConfig = readConfigFile();
    if (!runtimeConfig?.tos?.enabled) {
      throw createAppError('TOS_REQUIRED', '飞书机器人模式要求先启用并配置 TOS。', 503);
    }

    const result = await runSingleReviewPipeline({
      templates: [],
      salesContext: {},
      text_input: textInput,
      file: {
        filename: downloaded.filename,
        contentType: downloaded.contentType,
        data_base64: downloaded.data.toString('base64'),
      },
    });
    const replyText = formatFeishuBotReply({
      report: result.report,
      transcript: result.transcript,
      textInput,
      maxLength: config.replyMaxLength,
    });
    await sendFeishuBotTextMessage(config, receiveId, replyText);
  } catch (error) {
    console.error(`[feishu_bot] request_id=${requestId} handle message failed: ${error.message}`);
    await sendFeishuBotTextMessage(config, receiveId, toFeishuBotFailureText(error)).catch((sendError) => {
      console.error(`[feishu_bot] request_id=${requestId} send failure notice failed: ${sendError.message}`);
    });
  }
}

async function startFeishuBotLongConnectionIfNeeded() {
  const botConfig = getFeishuBotConfig();
  if (!botConfig.enabled) return;
  if (!isFeishuBotLongConnectionMode(botConfig)) return;
  if (!botConfig.appId || !botConfig.appSecret) {
    console.error('[feishu_bot] long_connection skipped: missing app credentials.');
    return;
  }
  if (feishuBotWsClient) return;

  let Lark;
  try {
    Lark = require('@larksuiteoapi/node-sdk');
  } catch (error) {
    console.error(
      '[feishu_bot] long_connection init failed: @larksuiteoapi/node-sdk is missing. Please run npm install.',
    );
    return;
  }

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (eventData) => {
      try {
        cleanupExpiredFeishuBotCache();
        const syntheticEventId = `ws:${eventData?.message?.message_id || crypto.randomUUID()}`;
        if (hasProcessedFeishuEvent(syntheticEventId)) return;
        markFeishuEventProcessed(syntheticEventId, botConfig.processedEventTtlSec);
        await handleFeishuBotMessageEvent(
          {
            header: {
              event_type: 'im.message.receive_v1',
              event_id: syntheticEventId,
            },
            event: eventData || {},
          },
          botConfig,
          `ws_${createRequestId()}`,
        );
      } catch (error) {
        console.error(`[feishu_bot] long_connection event handling failed: ${error.message}`);
      }
    },
  });

  feishuBotWsClient = new Lark.WSClient({
    appId: botConfig.appId,
    appSecret: botConfig.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });
  feishuBotWsClient.start({ eventDispatcher });
  console.log('[feishu_bot] long_connection mode enabled.');
}

function parseCookieHeader(headerValue = '') {
  const cookies = {};
  headerValue
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const equalIndex = pair.indexOf('=');
      if (equalIndex === -1) return;
      const key = pair.slice(0, equalIndex).trim();
      const value = pair.slice(equalIndex + 1).trim();
      try {
        cookies[key] = decodeURIComponent(value);
      } catch (error) {
        cookies[key] = value;
      }
    });
  return cookies;
}

function logRequestStart(req) {
  console.log(
    JSON.stringify({
      at: nowIso(),
      level: 'info',
      event: 'request_start',
      request_id: req.requestId,
      method: req.method,
      path: req.url,
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
    }),
  );
}

function logRequestFinish(req, statusCode, extra = {}) {
  const elapsedMs = Date.now() - (req.startedAt || Date.now());
  console.log(
    JSON.stringify({
      at: nowIso(),
      level: statusCode >= 500 ? 'error' : 'info',
      event: 'request_finish',
      request_id: req.requestId,
      method: req.method,
      path: req.url,
      status: statusCode,
      elapsed_ms: elapsedMs,
      ...extra,
    }),
  );
}

function isSecureRequest(req) {
  return getRequestProto(req) === 'https';
}

function appendSetCookie(res, cookieValue) {
  const current = res.getHeader('Set-Cookie');
  if (!current) {
    res.setHeader('Set-Cookie', cookieValue);
    return;
  }
  const next = Array.isArray(current) ? [...current, cookieValue] : [current, cookieValue];
  res.setHeader('Set-Cookie', next);
}

function setCookie(res, name, value, options = {}) {
  const attributes = [`${name}=${encodeURIComponent(value)}`];
  attributes.push(`Path=${options.path || '/'}`);
  if (options.httpOnly !== false) attributes.push('HttpOnly');
  if (options.sameSite) attributes.push(`SameSite=${options.sameSite}`);
  if (options.secure) attributes.push('Secure');
  if (typeof options.maxAge === 'number') attributes.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.expires instanceof Date) attributes.push(`Expires=${options.expires.toUTCString()}`);
  appendSetCookie(res, attributes.join('; '));
}

function readSessionRecord(req) {
  const cookies = parseCookieHeader(req.headers.cookie || '');
  const sid = cookies[SESSION_COOKIE_NAME];
  if (!sid) return null;
  const record = sessionStore.get(sid);
  if (!record) return null;
  if (record.expiresAt <= Date.now()) {
    sessionStore.delete(sid);
    return null;
  }
  return { sid, record };
}

function clearSession(req, res) {
  const session = readSessionRecord(req);
  if (session) {
    sessionStore.delete(session.sid);
  }
  setCookie(res, SESSION_COOKIE_NAME, '', {
    path: '/',
    maxAge: 0,
    expires: new Date(0),
    sameSite: 'Lax',
    secure: isSecureRequest(req),
  });
}

function createSession(res, req, user, ttlSeconds) {
  const sid = crypto.randomUUID();
  const expiresAt = Date.now() + ttlSeconds * 1000;
  sessionStore.set(sid, { user, expiresAt });
  setCookie(res, SESSION_COOKIE_NAME, sid, {
    path: '/',
    maxAge: ttlSeconds,
    sameSite: 'Lax',
    secure: isSecureRequest(req),
  });
  return sid;
}

function normalizeReturnPath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return '/';
  if (!rawPath.startsWith('/')) return '/';
  if (rawPath.startsWith('//')) return '/';
  return rawPath;
}

function cleanupExpiredAuthCache() {
  const now = Date.now();
  sessionStore.forEach((record, sid) => {
    if (record.expiresAt <= now) {
      sessionStore.delete(sid);
    }
  });
  oauthStateStore.forEach((record, state) => {
    if (record.expiresAt <= now) {
      oauthStateStore.delete(state);
    }
  });
}

function buildLoginUrl(returnTo = '/') {
  return `/auth/feishu/login?return_to=${encodeURIComponent(normalizeReturnPath(returnTo))}`;
}

async function exchangeFeishuToken(config, code) {
  const payload = {
    grant_type: 'authorization_code',
    code,
    app_id: config.appId,
    app_secret: config.appSecret,
    redirect_uri: config.redirectUri,
  };
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Feishu token API error: ${response.status}`);
  }
  const data = await response.json().catch(() => ({}));
  const tokenData = data?.data || data;
  const accessToken = tokenData?.access_token;
  if (!accessToken) {
    throw new Error(`Feishu token response missing access_token (${tokenData?.code || 'unknown'})`);
  }
  return accessToken;
}

async function fetchFeishuUserProfile(config, accessToken) {
  const response = await fetch(config.userInfoUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
  if (!response.ok) {
    throw new Error(`Feishu user info API error: ${response.status}`);
  }
  const data = await response.json().catch(() => ({}));
  const profile = data?.data || data || {};
  return {
    open_id: profile.open_id || profile.openId || '',
    union_id: profile.union_id || profile.unionId || '',
    name: profile.name || profile.en_name || profile.display_name || '飞书用户',
    email: profile.email || profile.enterprise_email || '',
    avatar_url: profile.avatar_url || profile.avatar_url_big || profile.avatar_url_240 || '',
    raw: profile,
  };
}

function isAuthorizedEmployee(config, profile) {
  if (!config.allowedOpenIds.size && !config.allowedEmails.size) return true;
  if (profile.open_id && config.allowedOpenIds.has(profile.open_id)) return true;
  if (profile.email && config.allowedEmails.has(profile.email)) return true;
  return false;
}

function getAuthContext(req, urlPathForLogin = '/') {
  cleanupExpiredAuthCache();
  const authConfig = getFeishuAuthConfig(req);
  const session = readSessionRecord(req);
  const user = session?.record?.user || null;
  if (!authConfig.required) {
    return { ok: true, authConfig, user, loginUrl: buildLoginUrl(urlPathForLogin) };
  }
  if (!user) {
    return { ok: false, authConfig, user: null, loginUrl: buildLoginUrl(urlPathForLogin) };
  }
  return { ok: true, authConfig, user, loginUrl: buildLoginUrl(urlPathForLogin) };
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

function buildPrompt(transcript, templates, salesContext = {}) {
  const templateText = templates
    .map((section) => `- ${section.title}: ${section.items.join('、')}`)
    .join('\n');
  const transcriptText = transcript || '（空）';
  const templateBlock = templateText || '（无模板）';
  const salesContextBlock = formatSalesContextForPrompt(salesContext);

  return `# Role: 顶级销售实战导师 & 消费心理学教授
(Master Sales Mentor & Behavioral Psychologist)

## 1. Profile（你是谁）

你不仅是拥有 20 年一线高客单价销售经验的金牌销售总监（奢侈品、汽车、婚纱摄影、医美、房产），也是一位深谙行为经济学与消费心理学的商学院教授。

你具备“双重人格”：

1. 实战派总监
   - 极度敏锐，能听懂客户“没说出口的话”
   - 痛恨空洞理论，只看结果：**成交率 / 客单价 / 复购推荐**

2. 学术派教授
   - 习惯从行为经济学和消费心理学出发，解释销售成败的根本原因
   - 熟练运用：损失厌恶、锚定效应、社会认同、互惠原则、承诺与一致、稀缺效应等原理，解构对话中的心理博弈

你说话风格：锋利、直白、不哄人。看到垃圾话术会直接指出“这是自杀式销售”。

---

## 2. Core Philosophy（核心哲学）

你的所有分析和建议，必须严格服务于以下三个商业指标：

- **成交率（Conversion Rate）**
- **客单价（Average Order Value）**
- **复购与转介绍（Repeat & Referral）**

你拒绝：
- “要多关心客户”“要提升服务态度”这类空话
你只提供：
- “下一句具体该怎么说”
- “这个阶段应该多问哪三个问题”
- “这类客户应该用哪种成交路径”

---

## 3. Context & Task（场景与任务）

用户会提供一份 **线下门店接待销售对话记录**（通常来自录音转写 / PDF，已区分说话人）。行业多为：摄影工作室 / 美业 / 高客单体验店等；如有特写，以用户说明为准。

你的任务是：
像给你的亲传弟子做复盘一样，**对这份对话进行“全维度尸检级拆解”**：

- 指出哪里是「自杀式销售」
- 哪里是「神来之笔」
- 为什么会这样（背后是哪个心理机制在起作用）
- 该如何修正，才能实实在在提高成交率和客单价

---

## 4. Input Format（期望用户提供的信息）

用户后续可能会以文字 / PDF 转写的形式提供对话。请默认按下列结构理解输入（有些字段可能为空，你也要能工作）：

1. 门店与产品背景（可选）
   - 行业与门店类型（如：男士写真摄影工作室）
   - 主打客群（性别 / 年龄段 / 消费层级）
   - 主推产品或套餐价位区间（如：起拍 599，主推 3999–6999）
   - 当下门店目标（提高成交率 / 拉高客单 / 提升加片率 等）

2. 本次顾客与结果
   - 顾客基本画像：性别、年龄区间、是否独自前来 / 带伴侣 / 带家人
   - 本次接待结果：是否成交？成交价格与产品？如未成交，离店时的表面理由
   - 服务该顾客的销售是新人 / 中阶 / 老销售（如果有）

3. 本次接待的预期目标（可选）
   - 例如：目标签 3999 套餐，底线 1999；
   - 或：老客复购，目标升级高客单等

4. 完整销售对话
   - 以清晰区分说话人的形式提供，例如：
     - 【S】：销售
     - 【C】：客户
   - 如果来源是 PDF，请视为已经转写为文本或由系统自动抽取

5. 其他补充信息（可选）
   - 当时门店客流情况、时间压力
   - 是否有活动价 / 团购价
   - 是否存在硬性话术规定

---

## 5. Analytical Framework（你的思考流程）

在输出回答前，请在内部按以下步骤进行深度思考（**无需展示推理过程，只展示最后的结论与报告结构**）：

1. 画像侧写（Client & Sales Profiling）
   - 根据对话，判断客户类型：
     - 价格敏感型 / 体验享受型 / 信息搜集型 / 陪同决策型 / 已有强需求但不信任型 等
   - 判断销售员段位：
     - 话术生硬、节奏混乱 → 小白
     - 流程完整但缺乏深度 → 中阶
     - 会主动设计节奏与情绪 → 高手或以上

2. 流程扫描（Against Standard SOP）
   - 对比经典销售路径：
     **破冰 → 建立安全感与信任 → 挖掘动机与痛点 → 定制化呈现方案与价值 → 报价与锚定 → 异议处理 → 成交 / 收口与铺垫复购**
   - 查找：
     - 哪些环节完全缺失？
     - 哪些环节顺序错乱或过早暴露价格？
     - 哪些地方“讲太多”但没让客户开口？

3. 心理博弈轨迹（Power & Psychology Dynamics）
   - 分析每个关键回合：
     - 此刻谁在高位？（掌控节奏的一方）
     - 谁在低位？（被动解释、一直辩解的一方）
   - 标记：
     - 哪一句话让客户的防御明显上升？
     - 哪一句话成功建立了信任或价值锚点？

4. 行为经济学视角
   - 判断本次对话中是否合理利用或错用：
     - 锚定效应：是否先建立了“价值锚点”再报价格？
     - 损失厌恶：是否让客户意识到“不做这个决策会失去什么”？
     - 社会认同：是否合理引用案例 / 其他客户选择？
     - 稀缺效应：是否虚假或过度使用“仅限今天/名额不多”，导致反感？
     - 互惠原则：是否先提供价值，还是一上来就索取？

5. 找出 1–3 个关键杠杆点（Leverage Points）
   - 如果只改对话中三个节点，最可能直接拉高成交率的，会是哪三处？
   - 这些节点将作为后面“话术重构”与“训练重点”的核心。

---

## 6. Output Structure（严格按以下格式输出报告）

### 1. 🎯 毒辣诊断书 (Executive Diagnosis)

* **综合评分**：0–100 分（直接给分，80 以上为可复制模板，60 以下为问题较多，40 以下为高危）
* **一句话定性**：
  用犀利直白的语言概括这次接待，例如：
  - “这是一场从一开始就站在被告席上的销售，全程在被客户审讯。”
  - “销售太急着证明自己专业，却从未证明自己‘懂客户’。”
* **成败关键点**：
  用 1 句话点名当前结果的核心原因：
  - 是信任没建立？
  - 是价值没讲透？
  - 是过早报价格导致防御拉满？
  - 还是逼单太软 / 完全不敢收口？

---

### 2. 🧩 逐帧流程拆解 (Process Breakdown)

请绘制一个表格，对关键对话节点进行点评：

| 阶段 | 关键对话片段 (摘要) | 导师点评（心理/策略分析） | 对成交的影响 |
| :--- | :--- | :--- | :--- |
| 破冰 / 迎宾 | *简要引用原话或概括* | *销售此时的意图 vs 客户实际感受；是否建立安全感* | 🔴致命 / 🟡减分 / 🟢加分 |
| 需求挖掘 | ... | ... | ... |
| 方案呈现 | ... | ... | ... |
| 报价/锚定 | ... | ... | ... |
| 异议处理 | ... | ... | ... |
| 逼单收口 | ... | ... | ... |
| 收尾/铺垫复购 | ... | ... | ... |

要求：
- 不要逐句流水账，而是抓关键节点
- 每个点评都要包含：**销售动机猜测 + 客户心理感受 + 心理位置变化**

---

### 3. 🌟 亮点与复用 (What Worked)

* 挑出 **2–3 个值得全店推广的亮点**（可以是某句话、某个节奏、某个态度）。
* 对每个亮点，必须回答三点：
  1. 具体是哪一句 / 哪个动作？
  2. 它满足了客户哪种心理需求？（例如：安全感、被理解感、控制感、占便宜感）
  3. 建议如何在全店范围内标准化复用？（写成一句 SOP 式话术或一个动作）

---

### 4. 🔪 手术刀式话术重构 (Script Optimization) —— 最重要部分

针对对话中出现的 **3–4 个严重错误节点**（例如：错误的提问方式、生硬报价、无效安抚、把路人聊成敌人），逐一进行“换头手术”。

每个错误节点按以下格式输出：

1) **错误点**：用一句话点名问题本质
   - 例如：“在完全不了解客户真实预算之前就直接丢出底价，是自杀式报价。”

* ❌ 原文糟糕示范：
  > 引用原始对话中销售的原话（简要即可）

* ✅ 导师金牌话术（如果你在现场，你会怎么说）：
  > 写出一段可直接在门店使用的口语化话术，要求：
  > - 有逻辑、有情绪、有姿态
  > - 能兼顾客户感受与成交目标
  > - 不虚假、不油腻，但有“杀伤力”

* 💡 底层逻辑（心理学解释）：
  - 说明这段话术如何利用了哪一两个心理学机制：
    - 如：锚定效应、损失厌恶、互惠原则、社会认同、赋予选择感等
  - 解释：为什么这样说，客户更容易点头？更不容易升起防御？

对所有严重错误节点，都按这一结构展开（3–4 个为宜，宁少但深）。

---

### 5. 🛠️ 门店落地训练方案 (Actionable Training)

为避免这份复盘沦为“看完就算”，请直接给店长 / 管理层输出可执行的训练与 SOP 建议：

1. **明日早会练什么？（Role-Play 设计）**
   - 给出 1–2 个可直接拿来演的角色扮演场景，例如：
     - “客户说‘太贵了，我再考虑一下’时，全员轮流说出自己的回答版本，由店长评估谁的话术更好。”
   - 写清楚：
     - 场景设定
     - 销售目标（比如：至少锁定预约，或留下联系方式）
     - 评价标准（是否缓和防御、是否重建价值感等）

2. **SOP 修正建议**
   - 明确指出：
     - 现有话术本 / 接待流程中，哪两三条是“必须立刻修改”的？
   - 直接给出修正版 SOP 示例，例如：
     - “禁止在未了解客户使用场景前直接报价”
     - “每次报价前必须先完成以下三步：A、确认需求场景；B、建立一个高于实际报价的价值锚点；C、询问客户对预算的大致接受区间”

如有必要，可以建议：
- 统一一套「必问问题清单」
- 统一几段「应对常见异议」的标准话术
- 规划一周内可以完成的小规模训练计划

---

## 7. Constraints & Tone（约束与语气）

- **语气**：严厉、专业、一针见血。
  - 避免使用：“你已经做得很好了，但是……”这种 AI 式安慰句。
  - 如果是垃圾话术，请直接点名：“这是垃圾话术”“这是明显的自杀式操作”。

- **细节**：
  - 不说“要多挖掘需求”，要直接给出**三句可以用来挖需求的问题**。
  - 不说“要提升服务意识”，要说明**在某一轮对话中应该如何改说下一句**。

- **立场**：
  - 你永远站在“帮门店赚钱、帮销售成长”的立场上
  - 既不讨好顾客，也不纵容销售的懒惰

---

## 8. Initialization（初始化回答）

当用户第一次发送对话内容（或说明已上传文件）时，请先回复：

“销售导师已就位。请发送本次接待的基础信息和完整对话内容（或转写后的文字），我将为你出一份刀刀见骨的销售复盘报告。”

随后，严格按照上述 Output Structure 输出分析。

---

## 系统提供的输入

人工补充成交信息（门店填写，若有则必须视为客观事实参与诊断）：
${salesContextBlock}

复盘模板：
${templateBlock}

对话转写：
${transcriptText}

---

【输出要求】
必须输出 JSON（不要输出多余文本），结构如下：
{
  "total": number,
  "need": number,
  "style": number,
  "objection": number,
  "close": number,
  "status": string,
  "insights": [
    { "title": string, "content": string, "logic": string, "script": string, "tag": string }
  ],
  "report_markdown": string
}

说明：
- report_markdown 必须严格按上面的 Output Structure 组织为 Markdown。
- insights 中每一项必须包含 logic（底层逻辑分析）与 script（满分话术模板）。
- 如果对话转写为空或信息不足，请在 status 中明确说明，insights 置空，report_markdown 说明信息不足。`;
}

function buildAuthHeaders(provider) {
  const headers = { 'Content-Type': 'application/json' };
  const authHeader = provider.auth_header || 'Authorization';
  const authPrefix = provider.auth_prefix === undefined ? 'Bearer ' : provider.auth_prefix;
  if (provider.api_key) {
    headers[authHeader] = `${authPrefix}${provider.api_key}`;
  }
  if (provider.extra_headers && typeof provider.extra_headers === 'object') {
    Object.assign(headers, provider.extra_headers);
  }
  return headers;
}

function buildPublicFileUrl(provider, filename) {
  const base = provider.public_base_url;
  if (!base) {
    throw new Error('Missing public_base_url for STT provider. A public file URL is required.');
  }
  const publicPath = provider.public_path || '/uploads';
  const pathSegment = publicPath.startsWith('/') ? publicPath : `/${publicPath}`;
  return `${base.replace(/\/$/, '')}${pathSegment}/${encodeURIComponent(filename)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function stripCodeFences(text) {
  return text
    .replace(/```json/gi, '```')
    .replace(/```/g, '')
    .trim();
}

function stripJsonComments(text) {
  return text
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
}

function removeTrailingCommas(text) {
  return text.replace(/,\s*([}\]])/g, '$1');
}

function extractFirstJson(text) {
  const cleaned = removeTrailingCommas(stripJsonComments(stripCodeFences(text)));
  const startIndex = cleaned.search(/[\{\[]/);
  if (startIndex === -1) {
    throw new Error('No JSON object found in model response.');
  }
  const openChar = cleaned[startIndex];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === openChar) depth += 1;
    if (char === closeChar) depth -= 1;
    if (depth === 0) {
      const jsonText = cleaned.slice(startIndex, i + 1);
      return JSON.parse(jsonText);
    }
  }
  throw new Error('Incomplete JSON in model response.');
}

function autoCloseJson(text) {
  const cleaned = stripCodeFences(text);
  const startIndex = cleaned.search(/[\{\[]/);
  if (startIndex === -1) {
    return cleaned;
  }
  const segment = cleaned.slice(startIndex);
  let output = '';
  let inString = false;
  let escaped = false;
  const closeStack = [];

  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];
    output += char;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') closeStack.push('}');
    if (char === '[') closeStack.push(']');
    if ((char === '}' || char === ']') && closeStack.length) {
      const expected = closeStack[closeStack.length - 1];
      if (char === expected) {
        closeStack.pop();
      }
    }
  }

  if (inString) {
    output += '"';
  }
  while (closeStack.length) {
    output += closeStack.pop();
  }
  return removeTrailingCommas(stripJsonComments(output));
}

function tryParseJsonCandidates(candidates) {
  for (const candidate of candidates) {
    if (!candidate || !candidate.trim()) continue;
    try {
      return JSON.parse(candidate);
    } catch (error) {
      try {
        return extractFirstJson(candidate);
      } catch (innerError) {
        // continue trying
      }
    }
  }
  throw new Error('Model response is not valid JSON.');
}

function parseModelJson(text) {
  const cleanedQuotes = stripCodeFences(text).replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const autoClosed = autoCloseJson(cleanedQuotes);
  const normalized = removeTrailingCommas(stripJsonComments(cleanedQuotes));
  return tryParseJsonCandidates([text, normalized, autoClosed]);
}

function clampScore(value, fallbackValue) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallbackValue;
  return Math.max(0, Math.min(100, Math.round(next)));
}

function normalizeReport(report) {
  const fallback = mockReport;
  const source = report && typeof report === 'object' ? report : {};
  const insights = Array.isArray(source.insights) ? source.insights : fallback.insights;
  return {
    total: clampScore(source.total, fallback.total),
    need: clampScore(source.need, fallback.need),
    style: clampScore(source.style, fallback.style),
    objection: clampScore(source.objection, fallback.objection),
    close: clampScore(source.close, fallback.close),
    status: typeof source.status === 'string' && source.status.trim() ? source.status : fallback.status,
    report_markdown:
      typeof source.report_markdown === 'string' && source.report_markdown.trim()
        ? source.report_markdown
        : fallback.report_markdown,
    insights: insights
      .map((item) => ({
        title: item?.title || '待补充问题点',
        content: item?.content || '请补充具体问题描述。',
        logic: item?.logic || item?.logic_analysis || '请补充底层逻辑分析。',
        script: item?.script || item?.template || '请补充可直接复用的话术。',
        tag: item?.tag || '待分类',
      }))
      .slice(0, 8),
  };
}

function shouldRetryForJsonError(error) {
  const message = `${error?.message || ''}`.toLowerCase();
  return message.includes('json') || message.includes('content');
}

async function callOpenAICompatible({ provider, prompt, forceJsonMode = true }) {
  const baseUrl = provider.base_url || 'https://api.openai.com/v1';
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const payload = {
    model: provider.model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: '你是销售复盘专家，请严格输出 JSON。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
  };
  if (forceJsonMode) {
    payload.response_format = { type: 'json_object' };
  }

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: buildAuthHeaders(provider),
      body: JSON.stringify(payload),
    },
    provider.timeout_ms || 600000,
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`OpenAI-compatible API error: ${response.status} ${errorText}`.trim());
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI-compatible response missing content');
  return parseModelJson(text);
}

async function callAnthropic({ provider, prompt }) {
  const baseUrl = provider.base_url || 'https://api.anthropic.com/v1';
  const url = `${baseUrl.replace(/\/$/, '')}/messages`;
  const payload = {
    model: provider.model || 'claude-3-5-sonnet-20240620',
    max_tokens: 900,
    system: '你是销售复盘专家，请严格输出 JSON。',
    messages: [{ role: 'user', content: prompt }],
  };

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'x-api-key': provider.api_key,
        'anthropic-version': provider.version || '2023-06-01',
        'Content-Type': 'application/json',
        ...(provider.extra_headers || {}),
      },
      body: JSON.stringify(payload),
    },
    provider.timeout_ms || 600000,
  );

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = await response.json();
  const text = data?.content?.[0]?.text;
  if (!text) throw new Error('Anthropic API response missing content');
  return parseModelJson(text);
}

async function callModelWithRetry({ provider, prompt }) {
  const repairPrompt = `${prompt}

请务必只输出一个完整 JSON 对象，不要输出任何解释、代码块标记、前后缀文本。`;

  try {
    if (provider.type === 'anthropic') {
      return await callAnthropic({ provider, prompt });
    }
    return await callOpenAICompatible({ provider, prompt, forceJsonMode: true });
  } catch (error) {
    if (!shouldRetryForJsonError(error)) throw error;
    if (provider.type === 'anthropic') {
      return callAnthropic({ provider, prompt: repairPrompt });
    }
    return callOpenAICompatible({ provider, prompt: repairPrompt, forceJsonMode: true });
  }
}

function splitBuffer(buffer, separator) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(separator, start);
  while (index !== -1) {
    parts.push(buffer.slice(start, index));
    start = index + separator.length;
    index = buffer.indexOf(separator, start);
  }
  parts.push(buffer.slice(start));
  return parts;
}

function parseMultipart(buffer, boundary) {
  const results = { fields: {}, files: {} };
  const boundaryBuffer = Buffer.from(boundary);
  const parts = splitBuffer(buffer, boundaryBuffer);

  parts.forEach((part) => {
    if (!part.length) return;
    if (part.equals(Buffer.from('--\r\n')) || part.equals(Buffer.from('--'))) return;
    let cleaned = part;
    if (cleaned.startsWith(Buffer.from('\r\n'))) {
      cleaned = cleaned.slice(2);
    } else if (cleaned.startsWith(Buffer.from('\n'))) {
      cleaned = cleaned.slice(1);
    }
    const headerEnd = cleaned.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const headerText = cleaned.slice(0, headerEnd).toString('utf8');
    let body = cleaned.slice(headerEnd + 4);
    if (body.endsWith(Buffer.from('\r\n'))) {
      body = body.slice(0, -2);
    } else if (body.endsWith(Buffer.from('\n'))) {
      body = body.slice(0, -1);
    }

    const dispositionMatch = headerText.match(/content-disposition:.*name=\"([^\"]+)\"(?:; filename=\"([^\"]+)\")?/i);
    const typeMatch = headerText.match(/content-type:\\s*([^\\r\\n]+)/i);
    if (!dispositionMatch) return;
    const name = dispositionMatch[1];
    const filename = dispositionMatch[2];
    if (filename) {
      results.files[name] = {
        filename,
        contentType: typeMatch ? typeMatch[1] : 'application/octet-stream',
        data: body,
      };
    } else {
      results.fields[name] = body.toString('utf8');
    }
  });

  return results;
}

function normalizeUtterances(rawUtterances = [], fallbackWords = []) {
  if (rawUtterances.length) {
    return rawUtterances.map((utterance) => ({
      speaker: Number.parseInt(
        utterance.speaker ??
          utterance.speaker_id ??
          utterance.speakerId ??
          utterance.channel_id ??
          utterance.channelId ??
          utterance?.additions?.speaker_id ??
          0,
        10,
      ),
      start: utterance.start,
      end: utterance.end,
      text: utterance.transcript || utterance.text || '',
    }));
  }

  if (!fallbackWords.length) return [];
  const grouped = [];
  let current = null;
  fallbackWords.forEach((word) => {
    const speaker = word.speaker ?? 0;
    if (!current || current.speaker !== speaker) {
      if (current) grouped.push(current);
      current = {
        speaker,
        start: word.start,
        end: word.end,
        text: word.word || word.text || '',
      };
    } else {
      current.text = `${current.text} ${word.word || word.text || ''}`.trim();
      current.end = word.end;
    }
  });
  if (current) grouped.push(current);
  return grouped;
}

function labelUtterances(utterances) {
  return utterances.map((item) => {
    let role = 'client';
    if (item.speaker === 0) role = 'sales';
    if (item.speaker > 1) role = 'other';
    return { ...item, role };
  });
}

function buildTranscript(utterances) {
  return utterances
    .map((item) => {
      const label = item.role === 'sales' ? '销售' : item.role === 'client' ? '客户' : `发言者${item.speaker}`;
      return `${label}: ${item.text}`.trim();
    })
    .join('\n');
}

async function transcribeWithDeepgram(provider, file) {
  const params = new URLSearchParams();
  if (provider.model) params.set('model', provider.model);
  if (provider.language) params.set('language', provider.language);
  if (provider.diarize) params.set('diarize', 'true');
  if (provider.utterances) params.set('utterances', 'true');
  if (provider.punctuate) params.set('punctuate', 'true');
  if (provider.smart_format) params.set('smart_format', 'true');

  const baseUrl = provider.base_url || 'https://api.deepgram.com/v1/listen';
  const url = `${baseUrl.replace(/\\?$/, '')}?${params.toString()}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${provider.api_key}`,
      'Content-Type': file.contentType || 'application/octet-stream',
    },
    body: file.data,
  });

  if (!response.ok) {
    throw new Error(`Deepgram API error: ${response.status}`);
  }

  const data = await response.json();
  const alt = data?.results?.channels?.[0]?.alternatives?.[0] || {};
  return {
    transcript: alt.transcript || '',
    utterances: alt.utterances || data?.results?.utterances || [],
    words: alt.words || [],
  };
}

function extractDashScopeTranscript(resultJson) {
  const transcripts = resultJson?.transcripts || resultJson?.result?.transcripts || [];
  const transcriptText = transcripts.map((item) => item.text || '').filter(Boolean).join('\n');
  const utterances = [];
  transcripts.forEach((item) => {
    const sentences = item.sentences || [];
    sentences.forEach((sentence) => {
      utterances.push({
        speaker: sentence.speaker_id ?? sentence.speakerId ?? 0,
        start: sentence.begin_time ? sentence.begin_time / 1000 : undefined,
        end: sentence.end_time ? sentence.end_time / 1000 : undefined,
        text: sentence.text || '',
      });
    });
  });
  return { transcript: transcriptText, utterances };
}

function inferAudioFormat(file) {
  const name = file.filename || '';
  const ext = path.extname(name).toLowerCase().replace('.', '');
  if (ext) return ext;
  const contentType = file.contentType || '';
  if (contentType.includes('mpeg')) return 'mp3';
  if (contentType.includes('wav')) return 'wav';
  if (contentType.includes('mp4') || contentType.includes('m4a')) return 'm4a';
  if (contentType.includes('aac')) return 'aac';
  if (contentType.includes('flac')) return 'flac';
  if (contentType.includes('ogg')) return 'ogg';
  return 'mp3';
}

function buildVolcengineHeaders(provider, requestId) {
  return {
    'Content-Type': 'application/json',
    'X-Api-App-Key': provider.app_id,
    'X-Api-Access-Key': provider.access_token,
    'X-Api-Resource-Id': provider.resource_id || 'volc.seedasr.auc',
    'X-Api-Request-Id': requestId,
    'X-Api-Sequence': '-1',
  };
}

function extractVolcengineResult(result) {
  const text = result?.text || '';
  const utterances = (result?.utterances || []).map((item) => ({
    speaker: item.speaker_id ?? item.speakerId ?? item.speaker ?? item.channel_id ?? item.channelId ?? 0,
    start: item.start_time !== undefined ? item.start_time / 1000 : item.start,
    end: item.end_time !== undefined ? item.end_time / 1000 : item.end,
    text: item.text || '',
  }));
  return { transcript: text, utterances, words: [] };
}

async function submitVolcengineAsr2(provider, fileInfo, requestId) {
  const baseUrl = provider.base_url || 'https://openspeech.bytedance.com/api/v3/auc/bigmodel';
  const submitUrl = `${baseUrl.replace(/\/$/, '')}/submit`;
  const audioUrl = fileInfo.publicUrl || buildPublicFileUrl(provider, fileInfo.filename);
  const payload = {
    user: { uid: provider.uid || provider.app_id || 'uid' },
    audio: {
      url: audioUrl,
      format: provider.audio_format || inferAudioFormat(fileInfo),
      language: provider.language,
    },
    request: {
      model_name: provider.model_name || 'bigmodel',
      enable_itn: provider.enable_itn !== false,
      enable_punc: provider.enable_punc !== false,
      enable_speaker_info: provider.enable_speaker_info !== false,
      show_utterances: provider.show_utterances !== false,
    },
  };

  await submitVolcengineRequestWithRetry({
    fetchImpl: fetch,
    sleepImpl: sleep,
    submitUrl,
    headers: buildVolcengineHeaders(provider, requestId),
    payload,
    maxAttempts: provider.submit_max_attempts || 4,
    retryBaseMs: provider.submit_retry_backoff_ms || 1200,
    retryMaxBackoffMs: provider.submit_retry_max_backoff_ms || 15000,
  });
}

async function pollVolcengineAsr2(provider, requestId) {
  const baseUrl = provider.base_url || 'https://openspeech.bytedance.com/api/v3/auc/bigmodel';
  const queryUrl = `${baseUrl.replace(/\/$/, '')}/query`;
  const maxAttempts = provider.poll_max_attempts || 40;
  const interval = provider.poll_interval_ms || 2000;
  let lastData = null;
  let lastCode = null;
  let lastMessage = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(queryUrl, {
      method: 'POST',
      headers: buildVolcengineHeaders(provider, requestId),
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      throw new Error(`Volcengine query error: ${response.status}`);
    }

    const data = await response.json().catch(() => ({}));
    lastData = data;
    const result = Array.isArray(data?.result) ? data.result[0] : data?.result;
    if (result) {
      const text = typeof result.text === 'string' ? result.text : '';
      const utterances = Array.isArray(result.utterances) ? result.utterances : [];
      const status = `${result.status || data.status || ''}`.toLowerCase();
      if (status.includes('fail') || status.includes('error')) {
        throw new Error(`Volcengine ASR failed: ${status}`);
      }
      if (text.trim().length > 0 || utterances.length > 0) {
        return { data, result: extractVolcengineResult(result) };
      }
    }

    const code = response.headers.get('x-api-status-code');
    lastCode = code;
    if (code && code !== '20000000') {
      const message = response.headers.get('x-api-message') || 'Volcengine query failed';
      lastMessage = message;
      const lowerMessage = message.toLowerCase();
      if (code === '20000001' || lowerMessage.includes('processing')) {
        await sleep(interval);
        continue;
      }
      throw new Error(`${message} (${code})`);
    }

    await sleep(interval);
  }

  const timeoutError = new Error('Volcengine ASR timeout or empty result');
  timeoutError.debug = {
    requestId,
    lastCode,
    lastMessage,
    lastData,
  };
  throw timeoutError;
}

async function transcribeWithVolcengineAsr2(provider, fileInfo) {
  if (!provider.app_id || !provider.access_token) {
    throw new Error('Missing Volcengine app_id or access_token');
  }
  const requestId = crypto.randomUUID();
  await submitVolcengineAsr2(provider, fileInfo, requestId);
  const result = await pollVolcengineAsr2(provider, requestId);
  return {
    ...result.result,
    debug: {
      requestId,
      raw: result.data,
    },
  };
}

async function pollDashScopeTask(provider, taskId) {
  const baseUrl = provider.base_url || 'https://dashscope.aliyuncs.com/api/v1';
  const url = `${baseUrl.replace(/\/$/, '')}/tasks/${taskId}`;
  const headers = buildAuthHeaders(provider);
  const maxAttempts = provider.poll_max_attempts || 30;
  const interval = provider.poll_interval_ms || 2000;
  const primaryMethod = provider.query_method || 'POST';

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response = await fetch(url, {
      method: primaryMethod,
      headers,
    });
    if (!response.ok && primaryMethod !== 'GET') {
      response = await fetch(url, {
        method: 'GET',
        headers,
      });
    }
    if (!response.ok) {
      throw new Error(`DashScope task query error: ${response.status}`);
    }
    const data = await response.json();
    const status =
      data?.output?.task_status || data?.output?.taskStatus || data?.task_status || data?.taskStatus || '';
    if (status === 'SUCCEEDED') {
      return data;
    }
    if (status === 'FAILED') {
      throw new Error('DashScope task failed');
    }
    await sleep(interval);
  }

  throw new Error('DashScope task timeout');
}

async function transcribeWithDashScopeFunAsr(provider, fileInfo) {
  const fileUrl = fileInfo.publicUrl || buildPublicFileUrl(provider, fileInfo.filename);
  const baseUrl = provider.base_url || 'https://dashscope.aliyuncs.com/api/v1';
  const submitUrl = `${baseUrl.replace(/\/$/, '')}/services/audio/asr/transcription`;
  const payload = {
    model: provider.model || 'fun-asr',
    input: { file_urls: [fileUrl] },
    parameters: {
      diarization_enabled: provider.diarization_enabled !== false,
      speaker_count: provider.speaker_count || 2,
    },
  };

  const response = await fetch(submitUrl, {
    method: 'POST',
    headers: {
      ...buildAuthHeaders(provider),
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`DashScope submit error: ${response.status}`);
  }

  const submitData = await response.json();
  const taskId =
    submitData?.output?.task_id || submitData?.output?.taskId || submitData?.task_id || submitData?.taskId;
  if (!taskId) {
    throw new Error('DashScope task_id missing');
  }

  const taskData = await pollDashScopeTask(provider, taskId);
  const results = taskData?.output?.results || [];
  const transcriptionUrl = results[0]?.transcription_url || results[0]?.transcriptionUrl;
  if (!transcriptionUrl) {
    return { transcript: '', utterances: [], words: [] };
  }

  const transcriptionResponse = await fetch(transcriptionUrl);
  if (!transcriptionResponse.ok) {
    throw new Error(`DashScope transcription fetch error: ${transcriptionResponse.status}`);
  }
  const transcriptionJson = await transcriptionResponse.json();
  const { transcript, utterances } = extractDashScopeTranscript(transcriptionJson);
  return { transcript, utterances, words: [] };
}

async function transcribeAudio(config, file) {
  const { config: provider } = getActiveSttProvider(config);
  if (!provider) {
    throw new Error('Missing STT config');
  }

  if (provider.type === 'deepgram') {
    if (!provider.api_key) {
      throw new Error('Missing Deepgram API key');
    }
    return transcribeWithDeepgram(provider, file);
  }
  if (provider.type === 'dashscope-fun-asr') {
    if (!provider.api_key) {
      throw new Error('Missing DashScope API key');
    }
    return transcribeWithDashScopeFunAsr(provider, file);
  }
  if (provider.type === 'volcengine-asr2') {
    return transcribeWithVolcengineAsr2(provider, file);
  }

  throw new Error(`Unsupported STT provider: ${provider.type}`);
}

async function runSingleReviewPipeline(payload) {
  const config = readConfigFile();
  const { config: provider } = getActiveProvider(config);
  const { config: sttProvider } = getActiveSttProvider(config);
  if (!provider?.api_key) {
    throw createAppError('MISSING_PROVIDER_API_KEY', 'Missing API key for active provider.', 500);
  }

  let runtimePath = payload?.file?.path || '';
  let runtimeFilename = payload?.file?.filename || 'audio';
  let runtimePublicUrl = payload?.file?.publicUrl || '';
  const runtimeTosObjectKey = payload?.file?.tosObjectKey || '';

  try {
    let fileBuffer = null;
    if (payload?.file?.data_base64) {
      fileBuffer = Buffer.from(payload.file.data_base64, 'base64');
    } else if (runtimePath) {
      fileBuffer = fs.readFileSync(runtimePath);
    }
    if (runtimeTosObjectKey && config.tos?.enabled) {
      runtimePublicUrl = getTosSignedUrlByObjectKey(config.tos, runtimeTosObjectKey);
    }
    if ((!fileBuffer || fileBuffer.length === 0) && sttProvider?.type === 'deepgram' && runtimePublicUrl) {
      const remoteFileResponse = await fetchWithTimeout(runtimePublicUrl, { method: 'GET' }, 120000);
      if (!remoteFileResponse.ok) {
        throw createAppError(
          'FETCH_REMOTE_AUDIO_FAILED',
          `Failed to fetch audio from TOS: ${remoteFileResponse.status}`,
          502,
        );
      }
      fileBuffer = Buffer.from(await remoteFileResponse.arrayBuffer());
    }

    let fileInfo = {
      filename: runtimeFilename,
      contentType: payload?.file?.contentType || 'application/octet-stream',
      path: runtimePath,
      data: fileBuffer,
      publicUrl: runtimePublicUrl,
      tosObjectKey: runtimeTosObjectKey || undefined,
    };
    if (config.tos?.enabled && !fileInfo.publicUrl && fileInfo.data?.length) {
      const uploaded = await uploadToTos(fileInfo, config.tos);
      fileInfo = { ...fileInfo, publicUrl: uploaded.url, tosObjectKey: uploaded.objectKey };
    }
    if (!fileInfo.data?.length && !fileInfo.publicUrl) {
      throw createAppError('INVALID_AUDIO_FILE', '音频文件为空或不可读。', 400);
    }

    const sttResult = await transcribeAudio(config, fileInfo);
    const normalized = normalizeUtterances(sttResult.utterances, sttResult.words);
    const labeled = labelUtterances(normalized);
    const transcript = buildTranscript(labeled) || sttResult.transcript || '';
    const enrichedTranscript = mergeTranscriptWithTextInput(
      transcript,
      payload?.text_input || payload?.textInput || payload?.text || '',
    );
    const prompt = buildPrompt(enrichedTranscript, payload.templates || [], payload.salesContext || {});
    const report = normalizeReport(await callModelWithRetry({ provider, prompt }));

    return {
      report,
      transcript,
      utterances: labeled,
      stt_debug: buildSttDebugPayload(sttResult, fileInfo),
    };
  } finally {
    if (runtimePath) {
      tryRemoveFile(runtimePath);
    }
  }
}

function createReviewJobRecord({ requestId, ownerKey, payload }) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    requestId,
    ownerKey,
    payload,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
  };
}

async function enqueueReviewJob({ requestId, ownerKey, payload }) {
  let queuedCount = reviewJobQueue.length + reviewWorkersInFlight;
  if (usesRedisReviewStore()) {
    await recoverRedisProcessingJobs();
    const [queuedRaw, processingRaw] = await redisPipeline([
      ['LLEN', REVIEW_JOB_REDIS_QUEUE_KEY],
      ['LLEN', REVIEW_JOB_REDIS_PROCESSING_KEY],
    ]);
    queuedCount = Number(queuedRaw || 0) + Number(processingRaw || 0);
  }
  if (queuedCount >= REVIEW_JOB_MAX_PENDING) {
    throw createAppError('REVIEW_QUEUE_FULL', '当前排队任务较多，请稍后重试。', 503, {
      queue_length: queuedCount,
      max_pending: REVIEW_JOB_MAX_PENDING,
    });
  }
  const job = createReviewJobRecord({ requestId, ownerKey, payload });
  await saveStoredReviewJob(job);
  if (usesRedisReviewStore()) {
    await redisCommand('LPUSH', REVIEW_JOB_REDIS_QUEUE_KEY, job.id);
  } else {
    reviewJobQueue.push(job.id);
  }
  return job;
}

async function buildReviewJobPublicPayload(job) {
  const base = {
    ok: job.status !== 'failed',
    job_id: job.id,
    status: job.status,
    created_at: new Date(job.createdAt).toISOString(),
    started_at: job.startedAt ? new Date(job.startedAt).toISOString() : null,
    finished_at: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    poll_after_ms: REVIEW_JOB_POLL_AFTER_MS,
  };

  if (job.status === 'queued') {
    return {
      ...base,
      queue_position: await getReviewJobQueuePosition(job.id),
      message: '任务已提交，正在排队处理中。',
    };
  }
  if (job.status === 'processing') {
    return {
      ...base,
      message: '任务处理中，正在进行转写与复盘。',
    };
  }
  if (job.status === 'succeeded') {
    return {
      ...base,
      ...job.result,
      message: '复盘已完成。',
    };
  }
  return {
    ...base,
    ...(job.error || {}),
    http_status: job.error?.http_status || 500,
    message: job.error?.message || '复盘失败。',
  };
}

async function claimNextQueuedReviewJob() {
  if (!usesRedisReviewStore()) {
    while (reviewJobQueue.length > 0) {
      const jobId = reviewJobQueue.shift();
      const job = reviewJobStore.get(jobId);
      if (!job || job.status !== 'queued') continue;
      return job;
    }
    return null;
  }

  while (true) {
    const jobId = await redisCommand('RPOPLPUSH', REVIEW_JOB_REDIS_QUEUE_KEY, REVIEW_JOB_REDIS_PROCESSING_KEY);
    if (!jobId) return null;
    const job = await getStoredReviewJob(jobId);
    if (!job) {
      await redisCommand('LREM', REVIEW_JOB_REDIS_PROCESSING_KEY, '0', jobId);
      continue;
    }
    if (isTerminalReviewJobStatus(job.status)) {
      await redisCommand('LREM', REVIEW_JOB_REDIS_PROCESSING_KEY, '0', jobId);
      continue;
    }
    if (job.status !== 'queued') {
      job.status = 'queued';
    }
    return job;
  }
}

function scheduleReviewJobQueueDrain() {
  if (reviewJobQueueDrainScheduled) return;
  reviewJobQueueDrainScheduled = true;
  setImmediate(() => {
    reviewJobQueueDrainScheduled = false;
    runReviewJobQueue().catch((error) => {
      console.error(`[review_job_queue] drain failed: ${error.message}`);
    });
  });
}

async function runReviewJobQueue() {
  if (usesRedisReviewStore()) {
    await recoverRedisProcessingJobs();
  }
  while (reviewWorkersInFlight < REVIEW_JOB_CONCURRENCY) {
    const job = await claimNextQueuedReviewJob();
    if (!job) break;

    reviewWorkersInFlight += 1;
    job.status = 'processing';
    job.startedAt = Date.now();
    job.updatedAt = job.startedAt;
    await saveStoredReviewJob(job);
    logReviewJobEvent('info', 'review_job_start', job);

    void runSingleReviewPipeline(job.payload)
      .then((result) => {
        job.result = result;
        job.status = 'succeeded';
      })
      .catch((error) => {
        job.error = normalizeJobError(error, 'Review failed');
        job.status = 'failed';
      })
      .finally(async () => {
        job.finishedAt = Date.now();
        job.updatedAt = job.finishedAt;
        logReviewJobEvent(job.status === 'failed' ? 'error' : 'info', 'review_job_finish', job, {
          elapsed_ms: job.startedAt ? job.finishedAt - job.startedAt : undefined,
          error_code: job.error?.error_code,
        });
        tryRemoveFile(job.payload?.file?.path);
        try {
          await saveStoredReviewJob(job);
          if (usesRedisReviewStore()) {
            await redisCommand('LREM', REVIEW_JOB_REDIS_PROCESSING_KEY, '0', job.id);
          }
          await pruneReviewJobs();
        } catch (error) {
          console.error(`[review_job_queue] persist failed: ${error.message}`);
        } finally {
          reviewWorkersInFlight -= 1;
          scheduleReviewJobQueueDrain();
        }
      });
  }
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function collectBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipartForm(req) {
  return new Promise((resolve, reject) => {
    const { IncomingForm } = formidable;
    const form = new IncomingForm({
      multiples: false,
      keepExtensions: true,
      maxFileSize: MAX_AUDIO_FILE_SIZE_BYTES,
      maxTotalFileSize: MAX_AUDIO_FILE_SIZE_BYTES,
    });
    form.parse(req, (err, fields, files) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ fields, files });
    });
  });
}

const server = http.createServer(async (req, res) => {
  req.requestId = createRequestId();
  req.startedAt = Date.now();
  res.setHeader('X-Request-Id', req.requestId);
  logRequestStart(req);
  res.on('finish', () => {
    logRequestFinish(req, res.statusCode);
  });

  applySecurityHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestPath = `${url.pathname}${url.search || ''}`;

  if (url.pathname === '/api/health') {
    try {
      await pruneReviewJobs();
      cleanupRateLimitStore();
      return sendJson(res, 200, { ok: true, review_queue: await getReviewQueueMetrics() });
    } catch (error) {
      return sendJson(res, resolveErrorStatus(error, 503), buildErrorPayload(req, error, 'Health check failed'));
    }
  }

  if (url.pathname === '/api/feishu/bot/events' && req.method === 'POST') {
    const botConfig = getFeishuBotConfig(req);
    if (!botConfig.enabled) {
      return sendJson(res, 503, { ok: false, message: 'Feishu bot disabled' });
    }
    if (isFeishuBotLongConnectionMode(botConfig)) {
      return sendJson(res, 200, {
        ok: true,
        ignored: true,
        message: 'Feishu bot is running in long_connection mode.',
      });
    }
    try {
      const raw = await collectBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch (error) {
        throw createAppError('INVALID_REQUEST_BODY', 'Invalid JSON body.', 400);
      }

      if (body?.type === 'url_verification') {
        if (botConfig.verificationToken && body?.token && body.token !== botConfig.verificationToken) {
          throw createAppError('FEISHU_BOT_TOKEN_MISMATCH', 'Invalid verification token.', 403);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ challenge: body?.challenge || '' }));
      }

      if (body?.encrypt) {
        throw createAppError(
          'FEISHU_BOT_ENCRYPTED_EVENT_UNSUPPORTED',
          'Encrypted Feishu event payload is not supported yet.',
          400,
        );
      }

      const eventToken = `${body?.header?.token || body?.token || ''}`.trim();
      if (botConfig.verificationToken && eventToken && eventToken !== botConfig.verificationToken) {
        throw createAppError('FEISHU_BOT_TOKEN_MISMATCH', 'Invalid event token.', 403);
      }

      const eventType = `${body?.header?.event_type || ''}`.trim();
      const eventId = `${body?.header?.event_id || body?.event_id || ''}`.trim();
      if (eventId) {
        if (hasProcessedFeishuEvent(eventId)) {
          return sendJson(res, 200, { ok: true, duplicate: true });
        }
        markFeishuEventProcessed(eventId, botConfig.processedEventTtlSec);
      }

      if (eventType !== 'im.message.receive_v1') {
        return sendJson(res, 200, { ok: true, ignored: true, event_type: eventType || 'unknown' });
      }

      setImmediate(() => {
        handleFeishuBotMessageEvent(body, botConfig, req.requestId).catch((error) => {
          console.error(`[feishu_bot] request_id=${req.requestId} async handle failed: ${error.message}`);
        });
      });
      return sendJson(res, 200, { ok: true, accepted: true });
    } catch (error) {
      const status = resolveErrorStatus(error, 500);
      return sendJson(res, status, buildErrorPayload(req, error, 'Feishu bot event handling failed'));
    }
  }

  if (url.pathname === '/api/me') {
    const authConfig = getFeishuAuthConfig(req);
    const session = readSessionRecord(req);
    return sendJson(res, 200, {
      ok: true,
      authenticated: Boolean(session?.record?.user),
      user: session?.record?.user || null,
      auth: {
        enabled: authConfig.enabled,
        required: authConfig.required,
        login_url: buildLoginUrl('/'),
      },
    });
  }

  if (url.pathname === '/auth/feishu/login' && req.method === 'GET') {
    const authConfig = getFeishuAuthConfig(req);
    if (!authConfig.enabled) {
      return sendJson(res, 503, { ok: false, message: 'Feishu auth disabled' });
    }
    if (!authConfig.appId || !authConfig.appSecret) {
      return sendJson(res, 500, { ok: false, message: 'Missing FEISHU_APP_ID or FEISHU_APP_SECRET' });
    }
    const returnTo = normalizeReturnPath(url.searchParams.get('return_to') || '/');
    const state = crypto.randomUUID();
    oauthStateStore.set(state, {
      expiresAt: Date.now() + authConfig.stateTtlSec * 1000,
      returnTo,
    });
    const authorizeUrl = new URL(authConfig.authorizeUrl);
    authorizeUrl.searchParams.set('app_id', authConfig.appId);
    authorizeUrl.searchParams.set('redirect_uri', authConfig.redirectUri);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('response_type', authConfig.responseType);
    if (authConfig.scope) {
      authorizeUrl.searchParams.set('scope', authConfig.scope);
    }
    res.writeHead(302, { Location: authorizeUrl.toString() });
    return res.end();
  }

  if (url.pathname === '/auth/feishu/callback' && req.method === 'GET') {
    const authConfig = getFeishuAuthConfig(req);
    if (!authConfig.enabled) {
      return sendJson(res, 503, { ok: false, message: 'Feishu auth disabled' });
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) {
      return sendJson(res, 400, { ok: false, message: 'Missing code or state' });
    }
    const stateRecord = oauthStateStore.get(state);
    if (!stateRecord || stateRecord.expiresAt <= Date.now()) {
      oauthStateStore.delete(state);
      return sendJson(res, 400, { ok: false, message: 'Invalid or expired state' });
    }
    oauthStateStore.delete(state);
    try {
      const accessToken = await exchangeFeishuToken(authConfig, code);
      const profile = await fetchFeishuUserProfile(authConfig, accessToken);
      if (!isAuthorizedEmployee(authConfig, profile)) {
        return sendJson(res, 403, { ok: false, message: 'Account is not in allowed employee list' });
      }
      const user = {
        name: profile.name,
        open_id: profile.open_id,
        email: profile.email,
        avatar_url: profile.avatar_url,
        login_at: new Date().toISOString(),
      };
      createSession(res, req, user, authConfig.sessionTtlSec);
      console.log(
        `[auth] feishu login success open_id=${user.open_id || 'unknown'} email=${user.email || 'unknown'}`,
      );
      res.writeHead(302, { Location: stateRecord.returnTo || '/' });
      return res.end();
    } catch (error) {
      return sendJson(res, 500, { ok: false, message: error.message });
    }
  }

  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    clearSession(req, res);
    return sendJson(res, 200, { ok: true });
  }

  const reviewJobMatch = url.pathname.match(/^\/api\/review\/jobs\/([a-f0-9-]+)$/i);
  if (reviewJobMatch && req.method === 'GET') {
    try {
      if (!enforceRateLimit(req, res, 'review_status', RATE_LIMIT_REVIEW_STATUS)) return;
      await pruneReviewJobs();
      const auth = getAuthContext(req, requestPath);
      if (!auth.ok) {
        return sendJson(res, 401, {
          ok: false,
          message: '请先通过飞书登录后再使用复盘功能',
          login_url: auth.loginUrl,
        });
      }
      const jobId = reviewJobMatch[1];
      const job = await getStoredReviewJob(jobId);
      if (!job) {
        return sendJson(res, 404, {
          ok: false,
          error_code: 'REVIEW_JOB_NOT_FOUND',
          message: '任务不存在，可能已过期。',
        });
      }
      const currentOwnerKey = buildJobOwnerKey(auth.user, req);
      if (job.ownerKey && currentOwnerKey !== job.ownerKey) {
        return sendJson(res, 403, {
          ok: false,
          error_code: 'REVIEW_JOB_FORBIDDEN',
          message: '无权查看该任务。',
        });
      }
      return sendJson(res, 200, await buildReviewJobPublicPayload(job));
    } catch (error) {
      const status = resolveErrorStatus(error, 503);
      return sendJson(res, status, buildErrorPayload(req, error, '读取任务状态失败'));
    }
  }

  if (url.pathname === '/api/review' && req.method === 'POST') {
    if (!enforceRateLimit(req, res, 'review_create', RATE_LIMIT_REVIEW_CREATE)) return;
    const auth = getAuthContext(req, requestPath);
    if (!auth.ok) {
      return sendJson(res, 401, {
        ok: false,
        message: '请先通过飞书登录后再使用复盘功能',
        login_url: auth.loginUrl,
      });
    }
    try {
      const config = readConfigFile();
      if (!config?.tos?.enabled) {
        throw createAppError('TOS_REQUIRED', '当前已启用 TOS-only 存储策略，请先开启并配置 TOS。', 503);
      }
      const { fields, files } = await parseMultipartForm(req);
      const audioFile = extractAudioFileFromMultipart(files);
      if (!audioFile) {
        const missingFileError = createAppError('MISSING_AUDIO_FILE', 'Missing audio file.', 400, {
          debug: {
            contentType: req.headers['content-type'] || '',
            fileKeys: Object.keys(files || {}),
            fieldKeys: Object.keys(fields || {}),
          },
        });
        return sendJson(res, 400, {
          ...buildErrorPayload(req, missingFileError, 'Missing audio file.'),
        });
      }

      validateUploadedAudioFile(audioFile);
      let uploadedToTos;
      let inputFile;
      try {
        const fileBuffer = fs.readFileSync(audioFile.filepath);
        inputFile = {
          filename: audioFile.originalFilename || 'audio',
          contentType: audioFile.mimetype || 'application/octet-stream',
          data: fileBuffer,
        };
        uploadedToTos = await uploadToTos(inputFile, config.tos);
      } finally {
        tryRemoveFile(audioFile.filepath);
      }
      const templates = parseTemplatesFromFields(fields);
      const salesContext = parseSalesContextFromFields(fields);
      const mode = resolveReviewMode(url);
      const tosFilePayload = {
        filename: inputFile.filename,
        contentType: inputFile.contentType,
        tosObjectKey: uploadedToTos.objectKey,
      };

      if (mode === 'sync') {
        const result = await runSingleReviewPipeline({
          templates,
          salesContext,
          file: tosFilePayload,
        });
        return sendJson(res, 200, {
          ok: true,
          mode: 'sync',
          ...result,
        });
      }

      let job;
      try {
        job = await enqueueReviewJob({
          requestId: req.requestId,
          ownerKey: buildJobOwnerKey(auth.user, req),
          payload: {
            templates,
            salesContext,
            file: tosFilePayload,
          },
        });
      } catch (error) {
        throw error;
      }
      scheduleReviewJobQueueDrain();
      return sendJson(res, 202, {
        ok: true,
        accepted: true,
        mode: 'async',
        job_id: job.id,
        status: job.status,
        queue_position: job.status === 'queued' ? await getReviewJobQueuePosition(job.id) : 0,
        poll_url: `/api/review/jobs/${job.id}`,
        poll_after_ms: REVIEW_JOB_POLL_AFTER_MS,
        message: '任务已提交，正在排队处理中。',
      });
    } catch (error) {
      const status = resolveErrorStatus(error, 500);
      return sendJson(res, status, {
        ...buildErrorPayload(req, error, 'Review failed'),
        stt_debug: error.debug,
      });
    }
  }

  if (url.pathname === '/api/analyze' && req.method === 'POST') {
    if (!enforceRateLimit(req, res, 'analyze', RATE_LIMIT_ANALYZE)) return;
    const auth = getAuthContext(req, requestPath);
    if (!auth.ok) {
      return sendJson(res, 401, {
        ok: false,
        message: '请先通过飞书登录后再使用复盘功能',
        login_url: auth.loginUrl,
      });
    }
    try {
      const raw = await collectBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch (error) {
        throw createAppError('INVALID_REQUEST_BODY', 'Invalid JSON body.', 400);
      }
      const config = readConfigFile();
      const { config: provider } = getActiveProvider(config);

      if (!provider?.api_key) {
        const missingKeyError = createAppError('MISSING_PROVIDER_API_KEY', 'Missing API key for active provider.', 500);
        return sendJson(res, 500, buildErrorPayload(req, missingKeyError, 'Missing API key for active provider.'));
      }

      const salesContext = normalizeSalesContext(
        body.sales_context || body.salesContext || body.customer_order_context || body.customerOrderContext || {},
      );
      const prompt = buildPrompt(body.transcript || '', body.templates || [], salesContext);
      const report = normalizeReport(await callModelWithRetry({ provider, prompt }));

      return sendJson(res, 200, { ok: true, report });
    } catch (error) {
      const status = resolveErrorStatus(error, 500);
      return sendJson(res, status, buildErrorPayload(req, error, 'Analyze failed'));
    }
  }

  const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const fullPath = safeJoin(PUBLIC_DIR, filePath);
  if (!fullPath) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(fullPath);
    const headers = { 'Content-Type': contentTypes[ext] || 'text/plain' };
    if (ext === '.html') {
      headers['Cache-Control'] = 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(
    `[review_job_queue] mode=${REVIEW_JOB_DEFAULT_MODE} store=${usesRedisReviewStore() ? 'redis' : 'memory'}`,
  );
  if (REVIEW_JOB_DEFAULT_MODE === 'async') {
    scheduleReviewJobQueueDrain();
  }
  startFeishuBotLongConnectionIfNeeded().catch((error) => {
    console.error(`[feishu_bot] long_connection start failed: ${error.message}`);
  });
});

const maintenanceTimer = setInterval(() => {
  cleanupExpiredAuthCache();
  cleanupExpiredFeishuBotCache();
  cleanupRateLimitStore();
  pruneReviewJobs().catch((error) => {
    console.error(`[review_job_queue] maintenance prune failed: ${error.message}`);
  });
}, 60 * 1000);
if (typeof maintenanceTimer.unref === 'function') {
  maintenanceTimer.unref();
}
