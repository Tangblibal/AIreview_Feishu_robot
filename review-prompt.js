const fs = require('fs');
const path = require('path');

const REVIEW_PROMPT_TEMPLATE_PATH = path.join(__dirname, 'prompts', 'review-prompt.md');

function loadReviewPromptTemplate() {
  return fs.readFileSync(REVIEW_PROMPT_TEMPLATE_PATH, 'utf8');
}

function buildReviewPrompt({ salesContextBlock, templateBlock, transcriptText }) {
  return loadReviewPromptTemplate()
    .replace(/\$\{salesContextBlock\}/g, salesContextBlock)
    .replace(/\$\{templateBlock\}/g, templateBlock)
    .replace(/\$\{transcriptText\}/g, transcriptText);
}

module.exports = {
  REVIEW_PROMPT_TEMPLATE_PATH,
  loadReviewPromptTemplate,
  buildReviewPrompt,
};
