const axios = require('axios');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

/**
 * GitHub設定が有効かチェック
 */
function isGithubConfigured() {
  return !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);
}

const githubApi = axios.create({
  baseURL: `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents`,
  headers: {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Nodejs-GitHub-Storage'
  }
});

/**
 * GitHubからJSONファイルを取得（読み込み）
 */
async function getFileFromGithub(filePath, fallback = null) {
  if (!isGithubConfigured()) return fallback;
  try {
    const response = await githubApi.get(`/${filePath}?ref=${GITHUB_BRANCH}`);
    const content = Buffer.from(response.data.content, 'base64').toString('utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return fallback;
    }
    console.error(`[GitHub Storage] Read error (${filePath}):`, error.message);
    return fallback;
  }
}

/**
 * GitHubへJSONファイルを保存/更新（書き出し）
 */
async function uploadJsonToGithub(filePath, data, commitMessage = 'Update file') {
  if (!isGithubConfigured()) {
    console.warn('[GitHub Storage] GITHUB_TOKEN / OWNER / REPO is not configured.');
    return false;
  }
  try {
    let sha = null;
    try {
      const currentFile = await githubApi.get(`/${filePath}?ref=${GITHUB_BRANCH}`);
      sha = currentFile.data.sha;
    } catch (e) {
      // ファイルが存在しない場合は新規作成
    }

    const contentBase64 = Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64');
    const body = {
      message: commitMessage,
      content: contentBase64,
      branch: GITHUB_BRANCH
    };
    if (sha) body.sha = sha;

    await githubApi.put(`/${filePath}`, body);
    return true;
  } catch (error) {
    console.error(`[GitHub Storage] Write error (${filePath}):`, error.message);
    return false;
  }
}

/**
 * GitHub上のログ配列に新しい要素を追記して書き出し
 */
async function appendLogToGithub(filePath, logEntry, commitMessage = 'Append log') {
  if (!isGithubConfigured()) return false;
  try {
    const currentLogs = (await getFileFromGithub(filePath, [])) || [];
    currentLogs.unshift(logEntry);
    if (currentLogs.length > 1000) currentLogs.pop();
    return await uploadJsonToGithub(filePath, currentLogs, commitMessage);
  } catch (error) {
    console.error(`[GitHub Storage] Append log error (${filePath}):`, error.message);
    return false;
  }
}

module.exports = {
  isGithubConfigured,
  getFileFromGithub,
  uploadJsonToGithub,
  appendLogToGithub
};