const ring = document.getElementById('ringProgress');
const scoreValue = document.getElementById('scoreValue');
const statusText = document.getElementById('statusText');
const needScore = document.getElementById('needScore');
const styleScore = document.getElementById('styleScore');
const objectionScore = document.getElementById('objectionScore');
const closeScore = document.getElementById('closeScore');
const analyzeBtn = document.getElementById('analyzeBtn');
const quickDemo = document.getElementById('quickDemo');
const audioUpload = document.getElementById('audioUpload');
const uploadArea = document.querySelector('.upload-area');
const exportPdf = document.getElementById('exportPdf');
const exportReport = document.getElementById('exportReport');
const insightList = document.getElementById('insightList');
const dialogue = document.querySelector('.dialogue');
const templateEditor = document.getElementById('templateEditor');
const templatePreview = document.getElementById('templatePreview');
const addTemplate = document.getElementById('addTemplate');
const saveTemplate = document.getElementById('saveTemplate');
const reportContent = document.getElementById('reportContent');
const authUser = document.getElementById('authUser');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const hasOrderInput = document.getElementById('hasOrder');
const orderAmountInput = document.getElementById('orderAmount');
const indoorSetsInput = document.getElementById('indoorSets');
const outdoorSetsInput = document.getElementById('outdoorSets');
const retouchedCountInput = document.getElementById('retouchedCount');
const productCountInput = document.getElementById('productCount');
const videoCountInput = document.getElementById('videoCount');
const CIRCUMFERENCE = 327;
const ANALYZE_TIMEOUT_MS = 15 * 60 * 1000;
const REVIEW_POLL_FALLBACK_MS = 3000;
const STORAGE_KEYS = {
  template: 'lumo_templates',
};

let selectedFile = null;
let latestReportMarkdown = '';
let isAnalyzing = false;
let authState = {
  authenticated: false,
  user: null,
  auth: { enabled: false, required: false, login_url: '/auth/feishu/login?return_to=%2F' },
};

const defaultTemplates = [
  {
    title: '需求引导',
    items: ['拍摄目的', '风格偏好', '穿搭/场景期待'],
  },
  {
    title: '价值呈现',
    items: ['样片展示', '摄影师风格匹配', '妆造与道具体验'],
  },
  {
    title: '套餐清晰度',
    items: ['张数/精修', '服装套数', '附加赠品'],
  },
  {
    title: '异议处理',
    items: ['预算', '档期', '修图周期', '家人意见'],
  },
  {
    title: '成交推进',
    items: ['锁档话术', '定金动作', '二次邀约'],
  },
];

const mockReport = {
  total: 72,
  need: 68,
  style: 76,
  objection: 63,
  close: 58,
  status: '完成 · 复盘耗时 2 分 18 秒',
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

function setRingScore(score) {
  const offset = CIRCUMFERENCE - (score / 100) * CIRCUMFERENCE;
  ring.style.strokeDashoffset = `${offset}`;
  scoreValue.textContent = `${score}`;
}

function fillScores(data) {
  needScore.textContent = `${data.need}/100`;
  styleScore.textContent = `${data.style}/100`;
  objectionScore.textContent = `${data.objection}/100`;
  closeScore.textContent = `${data.close}/100`;
  statusText.textContent = data.status;
}

function renderInsights(insights) {
  if (!insightList) return;
  insightList.innerHTML = '';
  insights.forEach((item) => {
    const logicText = item.logic || item.logic_analysis || item.logicAnalysis || '待补充底层逻辑分析。';
    const scriptText = item.script || item.template || item.full_score_script || '待补充满分话术模板。';
    const card = document.createElement('div');
    card.className = 'insight';
    card.innerHTML = `
      <div class="insight-title">${item.title}</div>
      <p>${item.content}</p>
      <div class="insight-meta">
        <div class="insight-label">底层逻辑分析</div>
        <p>${logicText}</p>
      </div>
      <div class="insight-meta">
        <div class="insight-label">满分话术模板</div>
        <div class="insight-script">${scriptText}</div>
      </div>
      <span class="tag">${item.tag}</span>
    `;
    insightList.appendChild(card);
  });
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatInline(text) {
  let safe = escapeHtml(text);
  safe = safe.replace(/`([^`]+)`/g, '<code>$1</code>');
  safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  safe = safe.replace(/\*(.+?)\*/g, '<em>$1</em>');
  return safe;
}

function isTableRow(line) {
  return /^\s*\|/.test(line) && line.includes('|');
}

function isTableDivider(line) {
  return /^\s*\|?(\s*:?-+:?\s*\|)+\s*$/.test(line);
}

function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => formatInline(cell.trim()));
}

function markdownToHtml(markdown = '') {
  if (!markdown.trim()) return '<p>暂无复盘报告。</p>';
  const lines = markdown.split(/\r?\n/);
  let i = 0;
  let html = '';

  const pushParagraph = (text) => {
    if (!text.trim()) return;
    html += `<p>${formatInline(text.trim())}</p>`;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const headers = splitTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      const headerHtml = headers.map((cell) => `<th>${cell}</th>`).join('');
      const rowHtml = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
        .join('');
      html += `<table><thead><tr>${headerHtml}</tr></thead><tbody>${rowHtml}</tbody></table>`;
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = formatInline(headingMatch[2]);
      html += `<h${level}>${text}</h${level}>`;
      i += 1;
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      html += '<hr />';
      i += 1;
      continue;
    }

    if (/^\s*>\s+/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s+/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s+/, ''));
        i += 1;
      }
      html += `<blockquote>${formatInline(quoteLines.join('<br />'))}</blockquote>`;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      html += `<ul>${items.map((item) => `<li>${formatInline(item)}</li>`).join('')}</ul>`;
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i += 1;
      }
      html += `<ol>${items.map((item) => `<li>${formatInline(item)}</li>`).join('')}</ol>`;
      continue;
    }

    pushParagraph(line);
    i += 1;
  }

  return html;
}

function renderReportMarkdown(markdown) {
  if (!reportContent) return;
  const html = markdownToHtml(markdown);
  reportContent.innerHTML = html;
}

function updateAnalyzeAvailability() {
  const requiresAuth = Boolean(authState.auth?.required);
  const disabledByAuth = requiresAuth && !authState.authenticated;
  const disabled = disabledByAuth || isAnalyzing;
  if (analyzeBtn) analyzeBtn.disabled = disabled;
  if (audioUpload) audioUpload.disabled = disabled;
  [hasOrderInput, orderAmountInput, indoorSetsInput, outdoorSetsInput, retouchedCountInput, productCountInput, videoCountInput]
    .filter(Boolean)
    .forEach((input) => {
      input.disabled = disabled;
    });
  if (uploadArea) uploadArea.classList.toggle('disabled', disabled);
}

function getCurrentPath() {
  return `${window.location.pathname}${window.location.search || ''}`;
}

function getLoginUrl() {
  const raw = authState.auth?.login_url;
  if (raw) return raw;
  return `/auth/feishu/login?return_to=${encodeURIComponent(getCurrentPath())}`;
}

function renderAuthState() {
  const authenticated = Boolean(authState.authenticated);
  const required = Boolean(authState.auth?.required);
  const enabled = Boolean(authState.auth?.enabled);

  if (authUser) {
    if (authenticated) {
      const name = authState.user?.name || authState.user?.email || '已登录';
      authUser.textContent = `员工：${name}`;
    } else if (!enabled) {
      authUser.textContent = '登录未启用';
    } else if (required) {
      authUser.textContent = '请先飞书登录';
    } else {
      authUser.textContent = '未登录（可匿名使用）';
    }
  }

  if (loginBtn) {
    loginBtn.hidden = authenticated || !enabled;
  }
  if (logoutBtn) {
    logoutBtn.hidden = !authenticated;
  }

  updateAnalyzeAvailability();
}

async function refreshAuthState() {
  try {
    const response = await fetch('/api/me', { credentials: 'include' });
    const data = await response.json();
    if (data?.ok) {
      authState = {
        authenticated: Boolean(data.authenticated),
        user: data.user || null,
        auth: data.auth || { enabled: false, required: false },
      };
    }
  } catch (error) {
    authState = {
      authenticated: false,
      user: null,
      auth: { enabled: false, required: false, login_url: '/auth/feishu/login?return_to=%2F' },
    };
  }
  renderAuthState();
}

async function parseJsonSafe(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    return { ok: false, message: text.slice(0, 200) };
  }
}

function exportReportPdf() {
  if (!latestReportMarkdown) {
    statusText.textContent = '暂无可导出的复盘报告';
    return;
  }
  const html = markdownToHtml(latestReportMarkdown);
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    statusText.textContent = '弹窗被拦截，无法导出报告';
    return;
  }
  printWindow.document.write(`
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>复盘报告</title>
        <style>
          body { font-family: 'Manrope', 'PingFang SC', 'Microsoft YaHei', sans-serif; padding: 24px; color: #151515; }
          h1, h2, h3, h4 { margin: 16px 0 8px; }
          p { color: #6f6a63; line-height: 1.7; }
          ul, ol { padding-left: 20px; color: #6f6a63; }
          li { margin: 6px 0; }
          table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; vertical-align: top; }
          th { background: #f4ece5; }
          blockquote { border-left: 3px solid #c86b3c; padding-left: 12px; background: #fffaf5; border-radius: 8px; }
          hr { border: none; border-top: 1px solid #ddd; margin: 12px 0; }
        </style>
      </head>
      <body>
        ${html}
      </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  printWindow.onload = () => {
    printWindow.print();
    printWindow.close();
  };
}

function renderTranscript(utterances = []) {
  if (!dialogue) return;
  if (!utterances.length) return;
  dialogue.innerHTML = '';
  utterances.forEach((entry) => {
    const bubble = document.createElement('div');
    const role = entry.role || (entry.speaker === 0 ? 'sales' : 'client');
    bubble.className = `bubble ${role === 'sales' ? 'sales' : 'client'}`;
    bubble.textContent = entry.text || entry.transcript || '';
    dialogue.appendChild(bubble);
  });
}

function setSelectedFile(file) {
  selectedFile = file;
  if (!file) return;
  const maxAudioMb = 50;
  if (file.size > maxAudioMb * 1024 * 1024) {
    selectedFile = null;
    statusText.textContent = `文件过大，最大支持 ${maxAudioMb}MB`;
    const uploadText = uploadArea?.querySelector('.upload-text');
    if (uploadText) {
      uploadText.textContent = '拖拽或点击上传销售录音';
    }
    if (audioUpload) audioUpload.value = '';
    return;
  }
  statusText.textContent = `已上传：${file.name}`;
  const uploadText = uploadArea?.querySelector('.upload-text');
  if (uploadText) {
    uploadText.textContent = file.name;
  }
}

function simulateAnalysis() {
  statusText.textContent = '分析中 · 正在提取关键片段';
  let current = 0;
  const target = mockReport.total;
  const timer = setInterval(() => {
    current += 4;
    if (current >= target) {
      current = target;
      clearInterval(timer);
      fillScores(mockReport);
      renderInsights(mockReport.insights);
      latestReportMarkdown = mockReport.report_markdown || '';
      renderReportMarkdown(latestReportMarkdown);
    }
    setRingScore(current);
  }, 60);
}

function loadTemplates() {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.template);
    if (!saved) return defaultTemplates;
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? parsed : defaultTemplates;
  } catch (error) {
    return defaultTemplates;
  }
}

function saveTemplates(templates) {
  localStorage.setItem(STORAGE_KEYS.template, JSON.stringify(templates));
}

function renderTemplatePreview(templates) {
  if (!templatePreview) return;
  templatePreview.innerHTML = '';
  templates.forEach((section) => {
    const block = document.createElement('div');
    block.className = 'template-block';
    block.innerHTML = `
      <div class="template-title">${section.title}</div>
      <ul>
        ${section.items.map((item) => `<li>• ${item}</li>`).join('')}
      </ul>
    `;
    templatePreview.appendChild(block);
  });
}

function renderTemplateEditor(templates) {
  if (!templateEditor) return;
  templateEditor.innerHTML = '';
  templates.forEach((section, index) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'template-item';
    wrapper.innerHTML = `
      <label>模块名称</label>
      <input class="template-title-input" value="${section.title}" />
      <label>话术要点（每行一个）</label>
      <textarea class="template-items-input">${section.items.join('\n')}</textarea>
      <button class="ghost remove-template" data-index="${index}">删除模块</button>
    `;
    templateEditor.appendChild(wrapper);
  });
}

function collectTemplates() {
  const sections = [];
  const items = document.querySelectorAll('.template-item');
  items.forEach((item) => {
    const title = item.querySelector('.template-title-input')?.value.trim();
    const content = item.querySelector('.template-items-input')?.value.trim();
    if (!title) return;
    const list = content ? content.split('\n').map((line) => line.trim()).filter(Boolean) : [];
    sections.push({ title, items: list });
  });
  return sections.length ? sections : defaultTemplates;
}

function parseOptionalNumberInput(input, { integer = false } = {}) {
  if (!input) return null;
  const raw = input.value?.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  if (integer) return Math.trunc(value);
  return Number(value.toFixed(2));
}

function collectSalesContext() {
  return {
    hasOrder: hasOrderInput?.value || 'unknown',
    orderAmount: parseOptionalNumberInput(orderAmountInput),
    indoorSets: parseOptionalNumberInput(indoorSetsInput, { integer: true }),
    outdoorSets: parseOptionalNumberInput(outdoorSetsInput, { integer: true }),
    retouchedCount: parseOptionalNumberInput(retouchedCountInput, { integer: true }),
    productCount: parseOptionalNumberInput(productCountInput, { integer: true }),
    videoCount: parseOptionalNumberInput(videoCountInput, { integer: true }),
  };
}

function formatErrorMessage(message, requestId, fallback = '分析失败') {
  const text = message || fallback;
  return requestId ? `${text} · 请求ID ${requestId}` : text;
}

function applyReviewResult(data) {
  const needScoreValue = Number(data.report?.need);
  const styleScoreValue = Number(data.report?.style);
  const objectionScoreValue = Number(data.report?.objection);
  const closeScoreValue = Number(data.report?.close);
  setRingScore(Number.isFinite(Number(data.report?.total)) ? Number(data.report?.total) : 0);
  fillScores({
    need: Number.isFinite(needScoreValue) ? needScoreValue : 0,
    style: Number.isFinite(styleScoreValue) ? styleScoreValue : 0,
    objection: Number.isFinite(objectionScoreValue) ? objectionScoreValue : 0,
    close: Number.isFinite(closeScoreValue) ? closeScoreValue : 0,
    status: data.report?.status || '复盘结果不完整，请检查模型输出。',
  });
  if (data.message) {
    statusText.textContent = data.message;
  }
  renderInsights(Array.isArray(data.report?.insights) ? data.report.insights : []);
  latestReportMarkdown = data.report?.report_markdown || '';
  renderReportMarkdown(latestReportMarkdown || '暂无复盘报告。');
  if (Array.isArray(data.utterances) && data.utterances.length) {
    renderTranscript(data.utterances);
  } else if (data.transcript) {
    renderTranscript([{ role: 'sales', text: data.transcript }]);
  }
}

function waitFor(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function pollReviewJobUntilDone(jobId, pollUrl, deadlineAt) {
  while (Date.now() < deadlineAt) {
    const response = await fetch(pollUrl, {
      method: 'GET',
      credentials: 'include',
    });

    if (response.status === 401) {
      const unauthorized = await parseJsonSafe(response);
      return { ok: false, unauthorized: true, ...unauthorized };
    }

    const data = await parseJsonSafe(response);

    if (response.status === 429) {
      const waitSeconds = Number(data.retry_after_seconds || response.headers.get('Retry-After') || 3);
      statusText.textContent = `系统繁忙，${waitSeconds} 秒后重试（任务 ${jobId.slice(0, 8)}）`;
      await waitFor(Math.max(1000, waitSeconds * 1000));
      continue;
    }

    if (!response.ok) {
      return {
        ok: false,
        message: formatErrorMessage(data.message || `服务异常（${response.status}）`, data.request_id, '任务查询失败'),
      };
    }

    const status = `${data.status || ''}`.toLowerCase();
    if (status === 'queued') {
      const queuePosition = Number(data.queue_position || 0);
      statusText.textContent = queuePosition > 0 ? `任务排队中（前方 ${queuePosition - 1} 个）` : '任务排队中';
      await waitFor(Math.max(1000, Number(data.poll_after_ms) || REVIEW_POLL_FALLBACK_MS));
      continue;
    }
    if (status === 'processing') {
      statusText.textContent = '任务处理中 · 正在转写并生成复盘';
      await waitFor(Math.max(1000, Number(data.poll_after_ms) || REVIEW_POLL_FALLBACK_MS));
      continue;
    }
    if (status === 'succeeded') {
      return { ok: true, ...data };
    }
    if (status === 'failed' || data.ok === false) {
      return {
        ok: false,
        message: formatErrorMessage(data.message, data.request_id, '分析失败'),
      };
    }

    await waitFor(REVIEW_POLL_FALLBACK_MS);
  }

  return {
    ok: false,
    message: '分析超时，请稍后重试（建议缩短录音或分段上传）',
  };
}

async function runAnalysisWithApi() {
  if (isAnalyzing) {
    statusText.textContent = '分析任务正在进行中，请稍候...';
    return false;
  }
  if (authState.auth?.required && !authState.authenticated) {
    statusText.textContent = '请先飞书登录';
    window.location.href = getLoginUrl();
    return false;
  }
  if (!selectedFile) {
    statusText.textContent = '请先上传录音文件';
    return null;
  }
  statusText.textContent = '分析中 · 正在调用 AI 引擎（通常 1-3 分钟）';
  isAnalyzing = true;
  updateAnalyzeAvailability();

  const progressMessages = [
    '分析中 · 正在上传并转写音频',
    '分析中 · 正在提炼关键销售节点',
    '分析中 · 正在生成复盘报告',
    '分析中 · 正在做结果校验，请稍候',
  ];
  let progressStep = 0;
  const progressTimer = setInterval(() => {
    if (progressStep < progressMessages.length && statusText.textContent.startsWith('分析中')) {
      statusText.textContent = progressMessages[progressStep];
      progressStep += 1;
    }
  }, 15000);
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => {
    controller.abort();
  }, ANALYZE_TIMEOUT_MS);
  const deadlineAt = Date.now() + ANALYZE_TIMEOUT_MS;

  try {
    const payload = new FormData();
    payload.append('audio', selectedFile);
    payload.append('templates', JSON.stringify(collectTemplates()));
    payload.append('sales_context', JSON.stringify(collectSalesContext()));

    const response = await fetch('/api/review', {
      method: 'POST',
      body: payload,
      credentials: 'include',
      signal: controller.signal,
    });
    if (response.status === 401) {
      const unauthorized = await parseJsonSafe(response);
      statusText.textContent = unauthorized.message || '请先飞书登录';
      if (unauthorized.login_url) {
        window.location.href = unauthorized.login_url;
      } else {
        window.location.href = getLoginUrl();
      }
      return false;
    }
    const data = await parseJsonSafe(response);
    if (!response.ok) {
      statusText.textContent = formatErrorMessage(data.message || `服务异常（${response.status}）`, data.request_id, '服务异常');
      return false;
    }

    if ((response.status === 202 || data.accepted || data.job_id) && data.job_id) {
      const pollUrl = data.poll_url || `/api/review/jobs/${data.job_id}`;
      statusText.textContent = `任务已提交，正在排队（任务 ${data.job_id.slice(0, 8)}）`;
      const finalResult = await pollReviewJobUntilDone(data.job_id, pollUrl, deadlineAt);

      if (finalResult.unauthorized) {
        statusText.textContent = finalResult.message || '请先飞书登录';
        if (finalResult.login_url) {
          window.location.href = finalResult.login_url;
        } else {
          window.location.href = getLoginUrl();
        }
        return false;
      }
      if (!finalResult.ok) {
        statusText.textContent = finalResult.message || '分析失败';
        return false;
      }

      applyReviewResult(finalResult);
      return true;
    }

    if (!data.ok || !data.report) {
      statusText.textContent = formatErrorMessage(data.message, data.request_id, '分析失败');
      return false;
    }
    applyReviewResult(data);
    return true;
  } catch (error) {
    if (error?.name === 'AbortError') {
      statusText.textContent = '分析超时，请稍后重试（建议缩短录音或分段上传）';
    } else {
      statusText.textContent = error?.message || '服务不可用';
    }
    return false;
  } finally {
    clearInterval(progressTimer);
    clearTimeout(timeoutTimer);
    isAnalyzing = false;
    updateAnalyzeAvailability();
  }
}

function initTemplates() {
  const templates = loadTemplates();
  renderTemplateEditor(templates);
  renderTemplatePreview(templates);
}

analyzeBtn?.addEventListener('click', async () => {
  const success = await runAnalysisWithApi();
  if (success === null) return;
});

quickDemo?.addEventListener('click', () => {
  simulateAnalysis();
});

audioUpload?.addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  setSelectedFile(file);
});

uploadArea?.addEventListener('dragover', (event) => {
  event.preventDefault();
  uploadArea.classList.add('drag');
});

uploadArea?.addEventListener('dragleave', () => {
  uploadArea.classList.remove('drag');
});

uploadArea?.addEventListener('drop', (event) => {
  event.preventDefault();
  uploadArea.classList.remove('drag');
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  setSelectedFile(file);
});

exportPdf?.addEventListener('click', () => {
  exportReportPdf();
});

exportReport?.addEventListener('click', () => {
  exportReportPdf();
});

addTemplate?.addEventListener('click', () => {
  const templates = loadTemplates();
  templates.push({ title: '新模块', items: ['示例要点'] });
  saveTemplates(templates);
  renderTemplateEditor(templates);
  renderTemplatePreview(templates);
});

templateEditor?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.classList.contains('remove-template')) {
    const index = Number(target.dataset.index);
    const templates = loadTemplates();
    templates.splice(index, 1);
    saveTemplates(templates);
    renderTemplateEditor(templates);
    renderTemplatePreview(templates);
  }
});

saveTemplate?.addEventListener('click', () => {
  const templates = collectTemplates();
  saveTemplates(templates);
  renderTemplatePreview(templates);
});

loginBtn?.addEventListener('click', () => {
  window.location.href = getLoginUrl();
});

logoutBtn?.addEventListener('click', async () => {
  try {
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
  } finally {
    await refreshAuthState();
    statusText.textContent = '已退出登录';
  }
});

initTemplates();
renderReportMarkdown('');
refreshAuthState();
