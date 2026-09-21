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
 * @returns {string} - YYYYMMDDHHMM 形式の文字列（分は5分単位に切り捨て）
 */
function formatJarticTime(date) {
  const d = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(Math.floor(d.getMinutes() / 5) * 5).padStart(2, '0');
  return `${y}${m}${day}${h}${min}`;
}

/**
 * サーバーに存在する最新のタイムスタンプを特定します
 * （配信のタイムラグを考慮し、10分前を起点として5分ずつ遡り、最大12回アクセスを試行）
 * @returns {Promise<string>} - 有効なタイムスタンプ
 */
async function getLatestTimestamp() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - 10);

  for (let i = 1; i <= 12; i++) {
    const timestamp = formatJarticTime(d);
    const testUrl = `https://www.jartic.or.jp/d/traffic_info/r1/${timestamp}/d/201/A03.json`;
    
    console.log(`[タイムスタンプ検索] 試行 ${i}/12: ${timestamp} をテスト中 (${testUrl})`);
    
    try {
      const response = await fetch(testUrl, {
        headers: {
          'Referer': 'https://www.jartic.or.jp/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      if (response.ok) {
        console.log(`[タイムスタンプ検索] 成功: 有効なタイムスタンプ ${timestamp} を確認しました。`);
        return timestamp;
      } else {
        console.log(`[タイムスタンプ検索] 失敗: ステータスコード ${response.status}`);
      }
    } catch (error) {
      console.log(`[タイムスタンプ検索] 通信エラー: ${error.message}`);
    }
    // さらに5分遡る
    d.setMinutes(d.getMinutes() - 5);
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
  const url = `https://www.jartic.or.jp/d/traffic_info/r1/${timestamp}/d/201/${code}.json`;
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
    
    // 次のチャンクを処理する前に少し待機
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
    console.log('JARTICデータの最新タイムスタンプを検索中...');
    const timestamp = await getLatestTimestamp();
    console.log(`最新のタイムスタンプを確認しました: ${timestamp}`);

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