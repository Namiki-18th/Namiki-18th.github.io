import fs from 'fs/promises';
import path from 'path';

// Excelファイルから抽出した全エリアコード
const EXPW_CODES = [
  'A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10'
];

const LOCAL_CODES = [
  'R01_1', 'R01_2', 'R01_3', 'R01_4', 'R01_5', 'R02', 'R03', 'R04', 'R05',
  'R06', 'R07', 'R08', 'R09', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15',
  'R16', 'R17', 'R18', 'R19', 'R20', 'R21', 'R22', 'R23', 'R24', 'R25',
  'R26', 'R27', 'R28', 'R29', 'R30', 'R31', 'R32', 'R33', 'R34', 'R35',
  'R36', 'R37', 'R38', 'R39', 'R40', 'R41', 'R42', 'R43', 'R44', 'R45',
  'R46', 'R47'
];

/**
 * 日本標準時（JST）を基準に、JARTICのURL用タイムスタンプを生成します
 * @param {Date} date - 基準となる日時
 * @returns {string} - YYYYMMDDHHMM 形式の文字列（1分単位）
 */
function formatJarticTime(date) {
  const d = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}${m}${day}${h}${min}`;
}

/**
 * YYYYMMDDHHMM 形式の文字列を JST の Date オブジェクトに変換します
 * @param {string} str 
 * @returns {Date}
 */
function parseJarticTimestamp(str) {
  const y = str.slice(0, 4);
  const m = str.slice(4, 6);
  const d = str.slice(6, 8);
  const h = str.slice(8, 10);
  const min = str.slice(10, 12);
  return new Date(`${y}-${m}-${d}T${h}:${min}:00+09:00`);
}

/**
 * 指定されたタイムスタンプが有効かどうかをテストします
 * @param {string} timestamp 
 * @returns {Promise<boolean>}
 */
async function testTimestamp(timestamp) {
  const testUrl = `https://www.jartic.or.jp/d/traffic_info/r1/${timestamp}/d/301/A03.json`;
  try {
    const response = await fetch(testUrl, {
      headers: {
        'Referer': 'https://www.jartic.or.jp/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * キャッシュをファイルに保存します
 * @param {string} cachePath 
 * @param {string} timestamp 
 */
async function saveCache(cachePath, timestamp) {
  try {
    await fs.writeFile(cachePath, timestamp, 'utf-8');
    console.log(`[キャッシュ保存] タイムスタンプ ${timestamp} をファイルに保存しました。`);
  } catch (err) {
    console.warn(`[キャッシュ保存警告] ${err.message}`);
  }
}

/**
 * 最新の有効なタイムスタンプを特定します
 * @returns {Promise<string>} - 有効なタイムスタンプ
 */
async function getLatestTimestamp() {
  const dataDir = path.join(process.cwd(), 'data');
  const cachePath = path.join(dataDir, 'timestamp_cache.txt');

  await fs.mkdir(dataDir, { recursive: true });

  let cachedTimestamp = null;
  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    const trimmed = raw.trim();
    if (trimmed.length === 12) {
      cachedTimestamp = trimmed;
    }
  } catch {
    // キャッシュファイルが存在しない場合
  }

  if (cachedTimestamp) {
    const cachedDate = parseJarticTimestamp(cachedTimestamp);
    const now = new Date();
    const diffMinutes = (now.getTime() - cachedDate.getTime()) / (60 * 1000);

    console.log(`[キャッシュ確認] 保持しているタイムスタンプ: ${cachedTimestamp} (経過約 ${Math.floor(diffMinutes)} 分)`);

    if (diffMinutes >= 5) {
      // 1. キャッシュから5分以上経過している場合：時間 + 5分 から試す
      const targetDate = new Date(cachedDate.getTime() + 5 * 60 * 1000);
      const targetTs = formatJarticTime(targetDate);
      console.log(`[キャッシュ確認] 5分以上経過のため、+5分後のタイムスタンプ (${targetTs}) をテスト中...`);

      if (await testTimestamp(targetTs)) {
        console.log(`[キャッシュ有効] タイムスタンプ ${targetTs} は有効です。`);
        await saveCache(cachePath, targetTs);
        return targetTs;
      }

      console.log(`[キャッシュ確認] +5分のテストに失敗しました。+1分と-1分を試行します...`);

      // 2. ヒットしなかったら +1分 をテスト
      const plus1Date = new Date(targetDate.getTime() + 1 * 60 * 1000);
      const plus1Ts = formatJarticTime(plus1Date);
      console.log(`[タイムスタンプ調整] +1分 (${plus1Ts}) をテスト中...`);
      if (await testTimestamp(plus1Ts)) {
        console.log(`[タイムスタンプ調整] 成功: ${plus1Ts} が有効です。`);
        await saveCache(cachePath, plus1Ts);
        return plus1Ts;
      }

      // 3. それもダメなら -1分 をテスト
      const minus1Date = new Date(targetDate.getTime() - 1 * 60 * 1000);
      const minus1Ts = formatJarticTime(minus1Date);
      console.log(`[タイムスタンプ調整] -1分 (${minus1Ts}) をテスト中...`);
      if (await testTimestamp(minus1Ts)) {
        console.log(`[タイムスタンプ調整] 成功: ${minus1Ts} が有効です。`);
        await saveCache(cachePath, minus1Ts);
        return minus1Ts;
      }

      console.log(`[タイムスタンプ調整] それでも無理だったため、通常の全体再検索に移行します。`);
    } else {
      // 5分未満の場合：まずはそのままテスト
      console.log(`[キャッシュ確認] 保存されていたタイムスタンプ (${cachedTimestamp}) をテスト中...`);
      if (await testTimestamp(cachedTimestamp)) {
        console.log(`[キャッシュ有効] 記憶されていたタイムスタンプ ${cachedTimestamp} は現在も有効です。`);
        return cachedTimestamp;
      }
      console.log(`[キャッシュ無効] 記憶されていたタイムスタンプのテストに失敗しました。再検索に移行します。`);
    }
  }

  // 4. それでも無理（またはキャッシュがない）場合は、1分前〜15分前まで順番に再検索
  const now = new Date();
  for (let i = 1; i <= 15; i++) {
    const d = new Date(now.getTime() - i * 60 * 1000);
    const timestamp = formatJarticTime(d);
    
    console.log(`[タイムスタンプ検索] ${i}分前 (タイムスタンプ: ${timestamp}) をテスト中...`);
    
    if (await testTimestamp(timestamp)) {
      console.log(`[タイムスタンプ検索] 成功: 有効なタイムスタンプ ${timestamp} を確認しました。`);
      await saveCache(cachePath, timestamp);
      return timestamp;
    } else {
      console.log(`[タイムスタンプ検索] 失敗`);
    }
  }
  throw new Error('有効なJARTICデータのタイムスタンプが見つかりませんでした。');
}

/**
 * 指定されたタイムスタンプとエリアコードのデータを取得します
 * @param {string} timestamp 
 * @param {string} code 
 * @returns {Promise<Object|null>} - JSONデータ、失敗時はnull
 */
async function fetchArea(timestamp, code) {
  const url = `https://www.jartic.or.jp/d/traffic_info/r1/${timestamp}/d/301/${code}.json`;
  const startTime = Date.now();
  try {
    const response = await fetch(url, {
      headers: {
        'Referer': 'https://www.jartic.or.jp/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    const duration = Date.now() - startTime;
    if (!response.ok) {
      console.warn(`[取得失敗] エリア: ${code} | ステータス: ${response.status} | 経過時間: ${duration}ms`);
      return null;
    }
    const data = await response.json();
    const featureCount = Array.isArray(data.features) ? data.features.length : 0;
    console.log(`[取得成功] エリア: ${code.padEnd(6)} | 地物数: ${String(featureCount).padStart(3)}件 | 経過時間: ${duration}ms`);
    return data;
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[通信エラー] エリア: ${code} | エラー: ${error.message} | 経過時間: ${duration}ms`);
    return null;
  }
}

/**
 * 配列を指定されたサイズのチャンク（塊）に分割します
 */
function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * 複数のエリアコードのデータを取得し、1つのFeatureCollectionに結合します
 * @param {string} timestamp 
 * @param {string[]} codes 
 * @returns {Promise<Object>} - 結合されたGeoJSONオブジェクト
 */
async function aggregateData(timestamp, codes) {
  const combinedGeoJSON = {
    type: 'FeatureCollection',
    features: []
  };

  const chunks = chunkArray(codes, 10);
  let processedCount = 0;
  
  for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
    const chunk = chunks[cIdx];
    console.log(`[進捗] チャンク ${cIdx + 1}/${chunks.length} を処理中 (${chunk.length}エリア)...`);
    
    const promises = chunk.map(code => fetchArea(timestamp, code));
    const results = await Promise.all(promises);
    
    for (const data of results) {
      if (data && Array.isArray(data.features)) {
        combinedGeoJSON.features.push(...data.features);
      }
    }
    
    processedCount += chunk.length;
    console.log(`[進捗] 完了: ${processedCount}/${codes.length} エリア処理済み`);
    
    if (cIdx < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return combinedGeoJSON;
}

/**
 * メイン処理
 */
async function main() {
  const scriptStartTime = Date.now();
  try {
    console.log('=== JARTICデータ取得スクリプト開始 ===');
    console.log('JARTICデータのタイムスタンプを確認中...');
    const timestamp = await getLatestTimestamp();
    console.log(`利用するタイムスタンプ: ${timestamp}`);

    const dataDir = path.join(process.cwd(), 'data');
    console.log(`データ保存ディレクトリを確認/作成中: ${dataDir}`);
    await fs.mkdir(dataDir, { recursive: true });

    // 1. 高速道路のデータを取得して保存
    console.log(`\n--- [1/2] 高速道路データの取得開始 (${EXPW_CODES.length}エリア) ---`);
    const expwData = await aggregateData(timestamp, EXPW_CODES);
    const expwPath = path.join(dataDir, 'jartic_expw.json');
    const expwString = JSON.stringify(expwData);
    await fs.writeFile(expwPath, expwString, 'utf-8');
    console.log(`高速道路のデータを保存しました: ${expwPath}`);
    console.log(`  - 合計地物数: ${expwData.features.length}件`);
    console.log(`  - ファイルサイズ: ${(Buffer.byteLength(expwString, 'utf-8') / 1024).toFixed(2)} KB`);

    // 2. 一般道のデータを取得して保存
    console.log(`\n--- [2/2] 一般道データの取得開始 (${LOCAL_CODES.length}エリア) ---`);
    const localData = await aggregateData(timestamp, LOCAL_CODES);
    const localPath = path.join(dataDir, 'jartic_local.json');
    const localString = JSON.stringify(localData);
    await fs.writeFile(localPath, localString, 'utf-8');
    console.log(`一般道のデータを保存しました: ${localPath}`);
    console.log(`  - 合計地物数: ${localData.features.length}件`);
    console.log(`  - ファイルサイズ: ${(Buffer.byteLength(localString, 'utf-8') / 1024).toFixed(2)} KB`);

    const totalDuration = ((Date.now() - scriptStartTime) / 1000).toFixed(2);
    console.log(`\n=== すべての処理が正常に完了しました (総所要時間: ${totalDuration}秒) ===`);
  } catch (error) {
    console.error('\n[致命的エラー] 予期せぬエラーが発生しました:', error);
    process.exit(1);
  }
}

main();