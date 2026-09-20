'use strict';
/**
 * transit-map.js — 交通マップ(ODPT)用バックエンド
 *
 * 目的:
 *   ・ブラウザは自サーバー(server.js)のAPIだけと通信する。ODPT / 地図タイルへの通信は全てここを経由する。
 *   ・アクセストークンはサーバー内だけで扱い、レスポンス・ログには一切出さない。
 *
 * ODPTのAPIホストとトークンの対応(データセットのURL記載に準拠):
 *   api.odpt.org             → ODPT_CONSUMER_KEY   (公共交通オープンデータセンター)
 *   api-challenge.odpt.org   → ODPT_2026_KEY       (チャレンジ2026限定データ)
 *   api-public.odpt.org      → 不要                (認証なしで公開されているデータ)
 *
 * 提供するAPI(全て要ログイン):
 *   GET /api/transit/map/config              地図の初期設定
 *   GET /api/transit/map/vehicles            列車・バスの現在位置 (bbox / modes / limit)
 *   GET /api/transit/map/stops               駅・バス停 (bbox / limit)
 *   GET /api/transit/map/info                データソースの状態と運行情報(Alert)
 *   GET /api/transit/map/admin/status        詳細状態(管理者のみ)
 *   GET /api/transit/tiles/:layer/:z/:x/:y.png  地図タイル(国土地理院)の中継
 *   GET /vendor/leaflet/*                    Leaflet本体(node_modules から配信。`npm install leaflet` が必要)
 *
 * 任意の環境変数:
 *   ODPT_RT_INTERVAL_SEC    リアルタイム取得間隔(秒)。既定30、最小15。地図を開いている人がいる間だけ取得する
 *   ODPT_RT_MAX_FEEDS       同時に扱うリアルタイムフィード数の上限。既定150
 *   ODPT_RT_ALLOW / _DENY   フィード名に含まれる文字列(カンマ区切り)で取得対象を絞る/除外する
 *   ODPT_RT_FEEDS_EXTRA     手動追加するフィード(JSON配列)
 *                           例: [{"file":"xxx_vehicle","host":"api.odpt.org","kind":"vehicle","mode":"bus","label":"○○バス"}]
 *   ODPT_GTFS_SOURCES       駅・バス停・路線名の取得元GTFS zipを追加(JSON配列。ODPTの3ホストのURLのみ可)
 *                           例: [{"id":"kanto","label":"関東バス","mode":"bus","url":"https://api.odpt.org/api/v4/files/.../xxx.zip","rtPrefix":"odpt_kanto_bus"}]
 */

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const zlib = require('zlib');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const axios = require('axios');

/* =====================================================================
 * 1. 設定
 * ===================================================================== */

const UA = 'namiki18-dashboard/1.0 (transit-map; contact: site admin)';

const ODPT_HOSTS = Object.freeze({
  'api.odpt.org': { name: 'center', envKey: 'ODPT_CONSUMER_KEY' },
  'api-challenge.odpt.org': { name: 'challenge', envKey: 'ODPT_2026_KEY' },
  'api-public.odpt.org': { name: 'public', envKey: null }
});

const CKAN_API = 'https://ckan.odpt.org/api/3/action/package_search';
const GSI_TILE_BASE = 'https://cyberjapandata.gsi.go.jp/xyz';

// 地図の初期表示位置: 茨城県立並木中等教育学校(つくば市並木4-5-1)
const SCHOOL = Object.freeze({ name: '並木中等教育学校', lat: 36.0604, lon: 140.1431 });

const TILE_LAYERS = Object.freeze({ pale: '淡色', std: '標準' });
const TILE_MIN_ZOOM = 5;
const TILE_MAX_ZOOM = 18;

const clampNum = (v, def, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const RT_INTERVAL_MS = () => clampNum(process.env.ODPT_RT_INTERVAL_SEC, 30, 15, 600) * 1000;
const ALERT_INTERVAL_MS = () => Math.max(120 * 1000, RT_INTERVAL_MS());
const MAX_FEEDS = () => clampNum(process.env.ODPT_RT_MAX_FEEDS, 150, 1, 500);
const RT_CONCURRENCY = 4;
const DEMAND_WINDOW_MS = 5 * 60 * 1000; // 直近5分間、地図を開いている人がいる時だけ更新する
const MAX_VEHICLE_AGE_S = 15 * 60; // 15分以上前の位置は表示しない
const DISCOVERY_REFRESH_MS = 12 * 60 * 60 * 1000;
const STATIC_REFRESH_MS = 24 * 60 * 60 * 1000;
const MAX_GTFS_ZIP_BYTES = 400 * 1024 * 1024;
const FEED_MAX_BYTES = 30 * 1024 * 1024;

const listEnv = (name) =>
  String(process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/* 既定のGTFS静的データ(駅・バス停・路線名の取得元)。追加は環境変数 ODPT_GTFS_SOURCES(JSON配列)で行う */
const DEFAULT_STATIC_SOURCES = [
  {
    id: 'mir',
    label: 'つくばエクスプレス',
    mode: 'rail',
    url: 'https://api.odpt.org/api/v4/files/MIR/data/MIR-Train-GTFS.zip',
    rtPrefix: 'mir_'
  },
  {
    id: 'jreast',
    label: 'JR東日本',
    mode: 'rail',
    url: 'https://api-challenge.odpt.org/api/v4/files/JR-East/data/JR-East-Train-GTFS.zip',
    rtPrefix: 'jreast_'
  }
];

/* CKANから自動検出できなかった場合の最低限のリアルタイムフィード */
const DEFAULT_RT_FEEDS = [
  { file: 'jreast_odpt_train_vehicle', host: 'api-challenge.odpt.org', kind: 'vehicle', mode: 'rail', label: 'JR東日本' },
  { file: 'jreast_odpt_train_trip_update', host: 'api-challenge.odpt.org', kind: 'trip', mode: 'rail', label: 'JR東日本' },
  { file: 'mir_odpt_train_alert', host: 'api.odpt.org', kind: 'alert', mode: 'rail', label: 'つくばエクスプレス' }
];

/* =====================================================================
 * 2. 上流(ODPT)アクセス — キー付与とログの無害化
 * ===================================================================== */

class UpstreamError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/** ログ・エラーからトークンを確実に除去する */
function scrub(text) {
  return String(text || '').replace(/(acl:consumerKey=|consumerKey=)[^&\s"'<>]+/gi, '$1***');
}

function classifyAxiosError(err) {
  if (err instanceof UpstreamError) return err.reason;
  if (err && err.response && err.response.status) return `http-${err.response.status}`;
  if (err && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.name === 'CanceledError')) return 'timeout';
  return 'network';
}

/** 許可済みホストかどうかを検証し、必要ならトークンを付与したURLを返す */
function buildOdptUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (_) {
    throw new UpstreamError('bad-url');
  }
  const host = ODPT_HOSTS[u.hostname];
  if (u.protocol !== 'https:' || !host) throw new UpstreamError('host-not-allowed');
  let out = `${u.origin}${u.pathname}${u.search}`;
  if (host.envKey) {
    const key = process.env[host.envKey];
    if (!key) throw new UpstreamError('key-missing');
    out += `${u.search ? '&' : '?'}acl:consumerKey=${encodeURIComponent(key)}`;
  }
  return out;
}

async function odptGet(rawUrl, { responseType = 'arraybuffer', timeout = 12000, maxBytes = FEED_MAX_BYTES, signal } = {}) {
  const url = buildOdptUrl(rawUrl);
  try {
    return await axios.get(url, {
      responseType,
      timeout,
      signal,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      headers: { 'User-Agent': UA, Accept: '*/*' },
      validateStatus: (s) => s === 200
    });
  } catch (err) {
    throw new UpstreamError(classifyAxiosError(err)); // URL(=トークン)を含むエラーは持ち回らない
  }
}

async function mapLimit(items, limit, fn) {
  const it = items[Symbol.iterator]();
  const worker = async () => {
    for (let r = it.next(); !r.done; r = it.next()) {
      try {
        await fn(r.value);
      } catch (_) {
        /* 個別の失敗は各fn内で記録する */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =====================================================================
 * 3. GTFS-Realtime (Protocol Buffers) 最小デコーダ
 *    必要なメッセージ(VehiclePosition / TripUpdate / Alert)だけを読み、未知のフィールドは読み飛ばす。
 * ===================================================================== */

function readVarint(c) {
  const buf = c.buf;
  let lo = 0;
  let hi = 0;
  let b;
  for (let i = 0; i < 4; i++) {
    b = buf[c.pos++];
    if (b === undefined) throw new RangeError('truncated');
    lo = (lo | ((b & 127) << (7 * i))) >>> 0;
    if (b < 128) {
      c.lo = lo;
      c.hi = 0;
      return lo;
    }
  }
  b = buf[c.pos++];
  if (b === undefined) throw new RangeError('truncated');
  lo = (lo | ((b & 127) << 28)) >>> 0;
  hi = (b & 127) >> 4;
  if (b < 128) {
    c.lo = lo;
    c.hi = hi;
    return hi * 4294967296 + lo;
  }
  for (let i = 0; i < 5; i++) {
    b = buf[c.pos++];
    if (b === undefined) throw new RangeError('truncated');
    hi = (hi | ((b & 127) << (7 * i + 3))) >>> 0;
    if (b < 128) {
      c.lo = lo;
      c.hi = hi;
      return hi * 4294967296 + lo;
    }
  }
  throw new RangeError('varint too long');
}

/** 直前に読んだ varint を int32 として解釈する(負の遅延時間に必要) */
const asInt32 = (c) => c.lo | 0;

function skipField(c, wire) {
  if (wire === 0) readVarint(c);
  else if (wire === 1) c.pos += 8;
  else if (wire === 2) {
    const len = readVarint(c); // 注意: `c.pos += readVarint(c)` は左辺が先に評価され、長さバイト分がずれる
    c.pos += len;
  } else if (wire === 5) c.pos += 4;
  else throw new RangeError('unsupported wire type');
  if (c.pos > c.buf.length) throw new RangeError('truncated');
}

function enterMessage(c) {
  const len = readVarint(c);
  const end = c.pos + len;
  if (end > c.buf.length) throw new RangeError('truncated');
  return end;
}

function readString(c) {
  const len = readVarint(c);
  const end = c.pos + len;
  if (end > c.buf.length) throw new RangeError('truncated');
  const s = c.buf.toString('utf8', c.pos, end);
  c.pos = end;
  return s;
}

function decodePosition(c, end) {
  const o = {};
  while (c.pos < end) {
    const tag = readVarint(c);
    const f = tag >>> 3;
    const w = tag & 7;
    if (w === 5 && (f === 1 || f === 2 || f === 3 || f === 5)) {
      const v = c.buf.readFloatLE(c.pos);
      c.pos += 4;
      if (f === 1) o.latitude = v;
      else if (f === 2) o.longitude = v;
      else if (f === 3) o.bearing = v;
      else o.speed = v;
    } else skipField(c, w);
  }
  c.pos = end;
  return o;
}

function decodeTrip(c, end) {
  const o = {};
  while (c.pos < end) {
    const tag = readVarint(c);
    const f = tag >>> 3;
    const w = tag & 7;
    if (f === 1 && w === 2) o.tripId = readString(c);
    else if (f === 5 && w === 2) o.routeId = readString(c);
    else if (f === 6 && w === 0) o.directionId = readVarint(c);
    else skipField(c, w);
  }
  c.pos = end;
  return o;
}

function decodeVehicleDescriptor(c, end) {
  const o = {};
  while (c.pos < end) {
    const tag = readVarint(c);
    const f = tag >>> 3;
    const w = tag & 7;
    if (f === 1 && w === 2) o.id = readString(c);
    else if (f === 2 && w === 2) o.label = readString(c);
    else skipField(c, w);
  }
  c.pos = end;
  return o;
}

function decodeVehiclePosition(c, end) {
  const o = {};
  while (c.pos < end) {
    const tag = readVarint(c);
    const f = tag >>> 3;
    const w = tag & 7;
    if (f === 1 && w === 2) o.trip = decodeTrip(c, enterMessage(c));
    else if (f === 2 && w === 2) o.position = decodePosition(c, enterMessage(c));
    else if (f === 4 && w === 0) o.currentStatus = readVarint(c);
    else if (f === 5 && w === 0) o.timestamp = readVarint(c);
    else if (f === 7 && w === 2) o.stopId = readString(c);
    else if (f === 8 && w === 2) o.vehicle = decodeVehicleDescriptor(c, enterMessage(c));
    else skipField(c, w);
  }
  c.pos = end;
  return o;
}

function decodeStopTimeEvent(c, end) {
  const o = {};
  while (c.pos < end) {
    const tag = readVarint(c);
    const f = tag >>> 3;
    const w = tag & 7;
    if (f === 1 && w === 0) {
      readVarint(c);
      o.delay = asInt32(c);
    } else skipField(c, w);
  }
  c.pos = end;
  return o;
}

function decodeStopTimeUpdate(c, end) {
  const o = {};
  while (c.pos < end) {
    const tag = readVarint(c);
    const f = tag >>> 3;
    const w = tag & 7;
    if (f === 2 && w === 2) o.arrival = decodeStopTimeEvent(c, enterMessage(c));
    else if (f === 3 && w === 2) o.departure = decodeStopTimeEvent(c, enterMessage(c));
    else skipField(c, w);
  }
  c.pos = end;
  return o;
}

function decodeTripUpdate(c, end) {
  const o = {};
  while (c.pos < end) {
    const tag = readVarint(c);
    const f = tag >>> 3;
    const w = tag & 7;
    if (f === 1 && w === 2) o.trip = decodeTrip(c, enterMessage(c));
    else if (f === 2 && w === 2) {
      const stu = decodeStopTimeUpdate(c, enterMessage(c));
      if (o.firstDelay === undefined) {
        const d = stu.arrival && stu.arrival.delay !== undefined ? stu.arrival.delay : stu.departure ? stu.departure.delay : undefined;
        if (d !== undefined) o.firstDelay = d;
      }
    } else if (f === 5 && w === 0) {
      readVarint(c);
      o.delay = asInt32(c);
    } else skipField(c, w);
  }
  c.pos = end;
  return o;
}

function decodeTranslatedString(c, end) {
  const list = [];
  while (c.pos < end) {
    const tag = readVarint(c);
    const f = tag >>> 3;
    const w = tag & 7;
    if (f === 1 && w === 2) {
      const tEnd = enterMessage(c);
      const t = {};
      while (c.pos < tEnd) {
        const tg = readVarint(c);
        const tf = tg >>> 3;
        const tw = tg & 7;
        if (tf === 1 && tw === 2) t.text = readString(c);
        else if (tf === 2 && tw === 2) t.language = readString(c);
        else skipField(c, tw);
      }
      c.pos = tEnd;
      list.push(t);
    } else skipField(c, w);
  }
  c.pos = end;
  return list;
}

function decodeEntitySelector(c, end) {
  const o = {};
  while (c.pos < end) {
    const tag = readVarint(c);
    const f = tag >>> 3;
    const w = tag & 7;
    if (f === 1 && w === 2) o.agencyId = readString(c);
    else if (f === 2 && w === 2) o.routeId = readString(c);
    else if (f === 5 && w === 2) o.stopId = readString(c);
    else skipField(c, w);
  }
  c.pos = end;
  return o;
}

function decodeTimeRange(c, end) {
  const o = {};
  while (c.pos < end) {
    const tag = readVarint(c);
    const f = tag >>> 3;
    const w = tag & 7;
    if (f === 1 && w === 0) o.start = readVarint(c);
    else if (f === 2 && w === 0) o.end = readVarint(c);
    else skipField(c, w);
  }
  c.pos = end;
  return o;
}

function decodeAlert(c, end) {
  const o = { activePeriods: [], informed: [] };
  while (c.pos < end) {
    const tag = readVarint(c);
    const f = tag >>> 3;
    const w = tag & 7;
    if (f === 1 && w === 2) o.activePeriods.push(decodeTimeRange(c, enterMessage(c)));
    else if (f === 5 && w === 2) o.informed.push(decodeEntitySelector(c, enterMessage(c)));
    else if (f === 10 && w === 2) o.header = decodeTranslatedString(c, enterMessage(c));
    else if (f === 11 && w === 2) o.description = decodeTranslatedString(c, enterMessage(c));
    else skipField(c, w);
  }
  c.pos = end;
  return o;
}

function decodeEntity(c, end) {
  const o = { id: '', deleted: false };
  while (c.pos < end) {
    const tag = readVarint(c);
    const f = tag >>> 3;
    const w = tag & 7;
    if (f === 1 && w === 2) o.id = readString(c);
    else if (f === 2 && w === 0) o.deleted = readVarint(c) !== 0;
    else if (f === 3 && w === 2) o.tripUpdate = decodeTripUpdate(c, enterMessage(c));
    else if (f === 4 && w === 2) o.vehicle = decodeVehiclePosition(c, enterMessage(c));
    else if (f === 5 && w === 2) o.alert = decodeAlert(c, enterMessage(c));
    else skipField(c, w);
  }
  c.pos = end;
  return o;
}

function decodeHeaderTimestamp(c, end) {
  let ts = 0;
  while (c.pos < end) {
    const tag = readVarint(c);
    const f = tag >>> 3;
    const w = tag & 7;
    if (f === 3 && w === 0) ts = readVarint(c);
    else skipField(c, w);
  }
  c.pos = end;
  return ts;
}

/** GTFS-RT の FeedMessage を { timestamp, entities[] } に変換する */
function decodeFeed(buf) {
  // FeedMessage は先頭フィールドが必須の header(=0x0A)。JSON/HTMLのエラー応答を早期に弾く
  if (!Buffer.isBuffer(buf) || buf.length < 2 || buf[0] !== 0x0a) throw new UpstreamError('not-protobuf');
  const c = { buf, pos: 0, lo: 0, hi: 0 };
  const feed = { timestamp: 0, entities: [] };
  try {
    while (c.pos < buf.length) {
      const tag = readVarint(c);
      const f = tag >>> 3;
      const w = tag & 7;
      if (f === 1 && w === 2) feed.timestamp = decodeHeaderTimestamp(c, enterMessage(c));
      else if (f === 2 && w === 2) feed.entities.push(decodeEntity(c, enterMessage(c)));
      else skipField(c, w);
    }
  } catch (err) {
    throw new UpstreamError('decode');
  }
  return feed;
}

const pickText = (list) => {
  if (!Array.isArray(list) || list.length === 0) return '';
  const ja = list.find((t) => /^ja/i.test(t.language || ''));
  return String((ja || list[0]).text || '').trim();
};

/* =====================================================================
 * 4. GTFS 静的データ(駅・バス停・路線名)
 *    zip を一時ファイルへストリーム保存し、必要な stops.txt / routes.txt だけを取り出す(メモリ節約)。
 * ===================================================================== */

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvToObjects(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 1 && r[0] === '') continue;
    const o = {};
    for (let j = 0; j < head.length; j++) o[head[j]] = r[j] === undefined ? '' : r[j];
    out.push(o);
  }
  return out;
}

async function readExact(fh, buf, position) {
  const { bytesRead } = await fh.read(buf, 0, buf.length, position);
  if (bytesRead !== buf.length) throw new Error('zip-truncated');
}

/** zip(ファイル)から指定エントリだけを取り出す。ZIP64・暗号化は非対応(GTFSでは通常不要) */
async function readZipEntries(filePath, wantedNames, { maxEntryBytes = 96 * 1024 * 1024 } = {}) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new Error('zip-too-small');
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await readExact(fh, tail, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('zip-eocd-not-found');
    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('zip64-unsupported');
    const cd = Buffer.alloc(cdSize);
    await readExact(fh, cd, cdOffset);

    const wanted = new Set(wantedNames);
    const found = new Map();
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const rawSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;

      const base = name.split('/').pop();
      if (!wanted.has(base) || found.has(base)) continue;
      if (flags & 1) throw new Error('zip-encrypted');
      if (rawSize > maxEntryBytes) throw new Error('zip-entry-too-large');
      const lh = Buffer.alloc(30);
      await readExact(fh, lh, localOffset);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('zip-bad-local-header');
      const dataStart = localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const comp = Buffer.alloc(compSize);
      await readExact(fh, comp, dataStart);
      if (method === 0) found.set(base, comp);
      else if (method === 8) found.set(base, zlib.inflateRawSync(comp, { maxOutputLength: maxEntryBytes }));
      else throw new Error(`zip-method-${method}`);
    }
    return found;
  } finally {
    await fh.close();
  }
}

async function downloadToFile(rawUrl, dest, maxBytes) {
  const res = await odptGet(rawUrl, {
    responseType: 'stream',
    timeout: 30000,
    signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(5 * 60 * 1000) : undefined
  });
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) cb(new UpstreamError('too-large'));
      else cb(null, chunk);
    }
  });
  try {
    await pipeline(res.data, limiter, fs.createWriteStream(dest));
  } catch (err) {
    throw new UpstreamError(classifyAxiosError(err));
  }
  return bytes;
}

const GRID = 0.02; // 約2km四方のセルで駅・バス停を索引する
const cellKey = (lat, lon) => `${Math.floor(lat / GRID)}:${Math.floor(lon / GRID)}`;

function buildStaticGroup(src, stopsText, routesText) {
  const routes = new Map();
  if (routesText) {
    for (const r of csvToObjects(routesText)) {
      const name = (r.route_long_name || r.route_short_name || '').trim();
      const color = /^[0-9a-f]{6}$/i.test((r.route_color || '').trim()) ? `#${r.route_color.trim()}` : null;
      if (r.route_id) routes.set(r.route_id, { name, color });
    }
  }
  const stopNames = new Map();
  const stops = [];
  const grid = new Map();
  const dedupe = new Set(); // のりば単位で複数行ある駅を1つにまとめる(同名・約100m以内)
  for (const s of csvToObjects(stopsText)) {
    const lat = Number(s.stop_lat);
    const lon = Number(s.stop_lon);
    const name = (s.stop_name || '').trim();
    if (s.stop_id && name) stopNames.set(s.stop_id, name);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0) || !name) continue;
    const lt = (s.location_type || '').trim();
    if (lt !== '' && lt !== '0' && lt !== '1') continue; // 出入口などは除外
    if ((s.parent_station || '').trim()) continue; // 親駅がある子(のりば等)は親駅だけ表示
    const dk = `${name}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
    if (dedupe.has(dk)) continue;
    dedupe.add(dk);
    const stop = { id: s.stop_id, n: name, la: Math.round(lat * 1e5) / 1e5, lo: Math.round(lon * 1e5) / 1e5, g: src.id, m: src.mode };
    stops.push(stop);
    const k = cellKey(lat, lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(stop);
  }
  return { routes, stopNames, stops, grid };
}

/* =====================================================================
 * 5. リアルタイムフィードの登録・自動検出
 * ===================================================================== */

const state = {
  feeds: new Map(), // id -> feed
  staticGroups: new Map(), // id -> { src, status, routes, stopNames, stops, grid }
  snapshot: [], // 車両(結合済み)
  snapshotAt: 0,
  alerts: [],
  discovery: { at: 0, source: 'none', count: 0, error: null },
  lastDemand: 0,
  lastCycleStart: 0,
  cyclePromise: null,
  timers: []
};

const rtBase = (file) =>
  file
    .toLowerCase()
    .replace(/_(vehicle_positions?|vehicles?|trip_updates?|tripupdates?|alerts?)$/i, '');

const jaPart = (s) => String(s || '').split(' / ')[0].trim();

function feedUrl(feed) {
  return `https://${feed.host}/api/v4/gtfs/realtime/${feed.file}`;
}

function parseRtUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  let u;
  try {
    u = new URL(rawUrl.split('?')[0]);
  } catch (_) {
    return null;
  }
  const m = u.pathname.match(/^\/api\/v4\/gtfs\/realtime\/([A-Za-z0-9_.-]+)$/);
  if (!m || !ODPT_HOSTS[u.hostname]) return null;
  return { host: u.hostname, file: m[1] };
}

function detectKind(file, text) {
  const f = file.toLowerCase();
  if (/vehicle/.test(f)) return 'vehicle';
  if (/trip/.test(f)) return 'trip';
  if (/alert/.test(f)) return 'alert';
  if (/VehiclePosition/i.test(text)) return 'vehicle';
  if (/TripUpdate/i.test(text)) return 'trip';
  if (/Alert/i.test(text)) return 'alert';
  return null;
}

function detectMode(tags, file) {
  const t = tags.join(' ');
  if (/バス-bus/.test(t) || /bus/i.test(file)) return 'bus';
  if (/鉄道-railway/.test(t) || /train|rail|metro|tram|subway|line/i.test(file)) return 'rail';
  return 'other';
}

function collectFeedsFromPackage(pkg, out) {
  const tags = (pkg.tags || []).map((t) => String(t.name || t));
  const label = jaPart(pkg.organization && pkg.organization.title) || jaPart(pkg.title) || pkg.name || '不明';
  for (const r of pkg.resources || []) {
    const parsed = parseRtUrl(r.url);
    if (!parsed) continue;
    const kind = detectKind(parsed.file, `${r.name || ''} ${r.description || ''}`);
    if (!kind) continue;
    out.set(parsed.file, { file: parsed.file, host: parsed.host, kind, mode: detectMode(tags, parsed.file), label });
  }
}

async function discoverFeedsFromCkan() {
  const found = new Map();
  const rows = 200;
  for (let start = 0, guard = 0; guard < 10; guard++, start += rows) {
    let res;
    try {
      res = await axios.get(CKAN_API, {
        params: { fq: 'res_format:"Protocol Buffers"', rows, start },
        timeout: 20000,
        headers: { 'User-Agent': UA },
        validateStatus: (s) => s === 200
      });
    } catch (err) {
      throw new UpstreamError(classifyAxiosError(err));
    }
    const result = res.data && res.data.result;
    if (!result || !Array.isArray(result.results)) throw new UpstreamError('ckan-bad-response');
    for (const pkg of result.results) collectFeedsFromPackage(pkg, found);
    if (result.results.length === 0 || start + rows >= Number(result.count || 0)) break;
  }
  return [...found.values()];
}

function passesFilters(f) {
  const allow = listEnv('ODPT_RT_ALLOW');
  const deny = listEnv('ODPT_RT_DENY');
  if (allow.length && !allow.some((a) => f.file.includes(a))) return false;
  if (deny.some((d) => f.file.includes(d))) return false;
  return true;
}

function extraFeedsFromEnv() {
  try {
    const arr = JSON.parse(process.env.ODPT_RT_FEEDS_EXTRA || '[]');
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((f) => f && typeof f.file === 'string' && /^[A-Za-z0-9_.-]+$/.test(f.file) && ODPT_HOSTS[f.host] && ['vehicle', 'trip', 'alert'].includes(f.kind))
      .map((f) => ({ file: f.file, host: f.host, kind: f.kind, mode: ['rail', 'bus', 'other'].includes(f.mode) ? f.mode : 'other', label: String(f.label || f.file).slice(0, 60) }));
  } catch (_) {
    return [];
  }
}

function applyFeedList(list, source) {
  const merged = new Map();
  for (const f of [...list, ...extraFeedsFromEnv()]) if (passesFilters(f)) merged.set(f.file, f);
  // 車両フィードを優先して上限内に収める(遅延=trip, 運行情報=alert は車両フィードに付随)
  const rank = { vehicle: 0, alert: 1, trip: 2 };
  const picked = [...merged.values()].sort((a, b) => rank[a.kind] - rank[b.kind]).slice(0, MAX_FEEDS());

  const next = new Map();
  for (const f of picked) {
    const prev = state.feeds.get(f.file);
    next.set(f.file, {
      id: f.file,
      host: f.host,
      file: f.file,
      kind: f.kind,
      mode: f.mode,
      label: f.label,
      group: rtBase(f.file),
      vehicles: prev ? prev.vehicles : [],
      alerts: prev ? prev.alerts : [],
      delays: prev ? prev.delays : new Map(),
      st: prev ? prev.st : { ok: null, error: null, lastOk: 0, lastTry: 0, fails: 0, nextTry: 0 }
    });
  }
  state.feeds = next;
  state.discovery = { at: Date.now(), source, count: next.size, error: null };
}

async function runDiscovery(dataDir) {
  try {
    const list = await discoverFeedsFromCkan();
    if (list.length === 0) throw new UpstreamError('ckan-empty');
    applyFeedList(list, 'ckan');
    if (dataDir) {
      fsp.writeFile(path.join(dataDir, 'transit-map-feeds.json'), JSON.stringify({ savedAt: Date.now(), feeds: list })).catch(() => {});
    }
    console.log(`[TransitMap] フィードを自動検出しました: ${state.feeds.size}件`);
  } catch (err) {
    state.discovery.error = classifyAxiosError(err);
    const using = state.discovery.source === 'default' ? '既定の一覧' : '前回の一覧';
    console.warn(`[TransitMap] フィード自動検出に失敗(${state.discovery.error})。${using}を使用します`);
    if (state.feeds.size === 0) applyFeedList(DEFAULT_RT_FEEDS, 'default');
  }
}

async function loadDiscoveryCache(dataDir) {
  try {
    const cached = JSON.parse(await fsp.readFile(path.join(dataDir, 'transit-map-feeds.json'), 'utf8'));
    if (Array.isArray(cached.feeds) && cached.feeds.length) {
      const safe = cached.feeds.filter((f) => f && typeof f.file === 'string' && ODPT_HOSTS[f.host] && ['vehicle', 'trip', 'alert'].includes(f.kind));
      if (safe.length) applyFeedList(safe, 'cache');
    }
  } catch (_) {
    /* キャッシュなしは正常 */
  }
}

/* =====================================================================
 * 6. リアルタイム取得(需要駆動)とスナップショット
 * ===================================================================== */

const intervalFor = (feed) => (feed.kind === 'alert' ? ALERT_INTERVAL_MS() : RT_INTERVAL_MS());

function staticGroupFor(feed) {
  for (const g of state.staticGroups.values()) {
    if (g.src.rtPrefix && feed.file.toLowerCase().startsWith(g.src.rtPrefix) && g.status.ok) return g;
  }
  return null;
}

function extractVehicles(feed, decoded, group) {
  const out = [];
  const nowS = Date.now() / 1000;
  for (const e of decoded.entities) {
    const v = e.vehicle;
    if (!v || e.deleted || !v.position) continue;
    const { latitude: la, longitude: lo } = v.position;
    if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180 || (la === 0 && lo === 0)) continue;
    const ts = v.timestamp || decoded.timestamp || 0;
    if (ts && nowS - ts > MAX_VEHICLE_AGE_S) continue;
    const route = group && v.trip && v.trip.routeId ? group.routes.get(v.trip.routeId) : null;
    const b = v.position.bearing;
    const sp = v.position.speed;
    out.push({
      id: `${feed.id}:${e.id || (v.vehicle && v.vehicle.id) || out.length}`,
      la: Math.round(la * 1e5) / 1e5,
      lo: Math.round(lo * 1e5) / 1e5,
      b: Number.isFinite(b) ? Math.round(b) : null,
      s: Number.isFinite(sp) ? Math.round(sp * 3.6) : null,
      m: feed.mode,
      f: feed.id,
      r: (route && route.name) || (v.trip && v.trip.routeId) || '',
      k: (route && route.color) || null,
      t: (v.trip && v.trip.tripId) || '',
      l: (v.vehicle && (v.vehicle.label || v.vehicle.id)) || '',
      d: null,
      st: Number.isInteger(v.currentStatus) ? v.currentStatus : null,
      sn: (group && v.stopId && group.stopNames.get(v.stopId)) || '',
      ts
    });
  }
  return out;
}

function extractAlerts(feed, decoded) {
  const nowS = Date.now() / 1000;
  const out = [];
  for (const e of decoded.entities) {
    const a = e.alert;
    if (!a || e.deleted) continue;
    const periods = a.activePeriods || [];
    if (periods.length && !periods.some((p) => (!p.start || p.start <= nowS) && (!p.end || p.end >= nowS))) continue;
    const header = pickText(a.header);
    const desc = pickText(a.description);
    if (!header && !desc) continue;
    const routes = [...new Set((a.informed || []).map((i) => i.routeId).filter(Boolean))].slice(0, 6);
    out.push({ f: feed.id, label: feed.label, mode: feed.mode, header: header.slice(0, 200), desc: desc.slice(0, 800), routes });
  }
  return out;
}

async function refreshFeed(feed) {
  const now = Date.now();
  const st = feed.st;
  st.lastTry = now;
  try {
    const res = await odptGet(feedUrl(feed));
    const decoded = decodeFeed(res.data);
    if (feed.kind === 'vehicle') feed.vehicles = extractVehicles(feed, decoded, staticGroupFor(feed));
    else if (feed.kind === 'alert') feed.alerts = extractAlerts(feed, decoded);
    else {
      const m = new Map();
      for (const e of decoded.entities) {
        const tu = e.tripUpdate;
        if (!tu || !tu.trip || !tu.trip.tripId) continue;
        const d = tu.delay !== undefined ? tu.delay : tu.firstDelay;
        if (d !== undefined) m.set(tu.trip.tripId, d);
      }
      feed.delays = m;
    }
    st.ok = true;
    st.error = null;
    st.lastOk = now;
    st.fails = 0;
    st.nextTry = now + intervalFor(feed);
  } catch (err) {
    const reason = classifyAxiosError(err);
    st.ok = false;
    st.error = reason;
    st.fails += 1;
    // 認証・存在エラーは長めに、一時的な失敗は短めにバックオフ(過剰リクエスト防止)
    const permanent = reason === 'key-missing' || reason === 'http-401' || reason === 'http-403' || reason === 'http-404';
    const base = permanent ? 15 * 60 * 1000 : 30 * 1000;
    st.nextTry = now + Math.min(6 * 60 * 60 * 1000, base * 2 ** Math.min(st.fails - 1, 8));
    if (st.fails === 1 || st.fails % 20 === 0) console.warn(`[TransitMap] ${feed.id}: ${scrub(reason)} (${st.fails}回目)`);
    // 直近成功から時間が経っていれば、古い位置を残さない(更新間隔の3倍)
    if (now - st.lastOk > Math.max(intervalFor(feed) * 3, 90 * 1000)) {
      feed.vehicles = [];
      feed.alerts = [];
    }
  }
}

function rebuildSnapshot() {
  const delayByGroup = new Map();
  for (const f of state.feeds.values()) if (f.kind === 'trip' && f.delays.size) delayByGroup.set(f.group, f.delays);
  const vehicles = [];
  const alerts = [];
  const seen = new Set();
  for (const f of state.feeds.values()) {
    if (f.kind === 'vehicle') {
      const dm = delayByGroup.get(f.group);
      for (const v of f.vehicles) {
        v.d = dm && v.t && dm.has(v.t) ? dm.get(v.t) : null;
        vehicles.push(v);
      }
    } else if (f.kind === 'alert') {
      for (const a of f.alerts) {
        const key = `${a.label}|${a.header}|${a.desc}`;
        if (seen.has(key)) continue;
        seen.add(key);
        alerts.push(a);
      }
    }
  }
  state.snapshot = vehicles;
  state.alerts = alerts;
  state.snapshotAt = Date.now();
}

async function runCycle() {
  const now = Date.now();
  state.lastCycleStart = now;
  const due = [...state.feeds.values()].filter((f) => f.st.nextTry <= now);
  await mapLimit(due, RT_CONCURRENCY, refreshFeed);
  rebuildSnapshot();
}

/** 直近に閲覧があり、更新間隔を過ぎていればバックグラウンドで更新を開始する */
function ensureFresh() {
  state.lastDemand = Date.now();
  if (state.feeds.size === 0) return null;
  if (!state.cyclePromise && Date.now() - state.lastCycleStart >= RT_INTERVAL_MS()) {
    state.cyclePromise = runCycle()
      .catch((err) => console.error('[TransitMap] 更新サイクル失敗:', scrub(err && err.message)))
      .finally(() => {
        state.cyclePromise = null;
      });
  }
  return state.cyclePromise;
}

/* =====================================================================
 * 7. 静的データ(駅・バス停)の読み込み
 * ===================================================================== */

function staticSources() {
  const list = [...DEFAULT_STATIC_SOURCES];
  try {
    const extra = JSON.parse(process.env.ODPT_GTFS_SOURCES || '[]');
    if (Array.isArray(extra)) {
      for (const s of extra) {
        if (!s || !/^[A-Za-z0-9_-]{1,40}$/.test(s.id || '') || typeof s.url !== 'string') continue;
        try {
          if (!ODPT_HOSTS[new URL(s.url).hostname]) continue;
        } catch (_) {
          continue;
        }
        list.push({ id: s.id, label: String(s.label || s.id).slice(0, 60), mode: s.mode === 'bus' ? 'bus' : 'rail', url: s.url.split('?')[0], rtPrefix: typeof s.rtPrefix === 'string' ? s.rtPrefix.toLowerCase() : '' });
      }
    }
  } catch (_) {
    /* 不正なJSONは無視 */
  }
  return list;
}

async function loadStaticSource(src) {
  const tmp = path.join(os.tmpdir(), `odpt-gtfs-${src.id}-${process.pid}-${Date.now()}.zip`);
  const status = { ok: false, error: null, loadedAt: 0, stops: 0 };
  const prev = state.staticGroups.get(src.id);
  try {
    await downloadToFile(src.url, tmp, MAX_GTFS_ZIP_BYTES);
    const files = await readZipEntries(tmp, ['stops.txt', 'routes.txt']);
    if (!files.has('stops.txt')) throw new UpstreamError('no-stops');
    const built = buildStaticGroup(src, files.get('stops.txt').toString('utf8'), files.has('routes.txt') ? files.get('routes.txt').toString('utf8') : '');
    status.ok = true;
    status.loadedAt = Date.now();
    status.stops = built.stops.length;
    state.staticGroups.set(src.id, { src, status, ...built });
    console.log(`[TransitMap] 静的データ読込: ${src.id} 駅・停留所 ${built.stops.length}件`);
  } catch (err) {
    status.error = err && err.reason ? err.reason : String(err && err.message ? err.message : 'error').slice(0, 60);
    if (prev && prev.status.ok) {
      prev.status.error = status.error; // 前回のデータは保持する
    } else {
      state.staticGroups.set(src.id, { src, status, routes: new Map(), stopNames: new Map(), stops: [], grid: new Map() });
    }
    console.warn(`[TransitMap] 静的データ読込失敗 ${src.id}: ${scrub(status.error)}`);
  } finally {
    fsp.unlink(tmp).catch(() => {});
  }
}

async function loadAllStatic() {
  for (const src of staticSources()) await loadStaticSource(src); // 帯域を使うため直列
}

/* =====================================================================
 * 8. 地図タイル中継(国土地理院)
 * ===================================================================== */

const TILE_CACHE_MAX = 1500;
const TILE_TTL_MS = 12 * 60 * 60 * 1000;
const tileCache = new Map(); // key -> { buf|null, at }
const tileInflight = new Map();

function tileFromCache(key) {
  const hit = tileCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > (hit.buf ? TILE_TTL_MS : 10 * 60 * 1000)) {
    tileCache.delete(key);
    return null;
  }
  tileCache.delete(key); // LRU: 末尾へ移動
  tileCache.set(key, hit);
  return hit;
}

async function fetchTile(layer, z, x, y) {
  const key = `${layer}/${z}/${x}/${y}`;
  const cached = tileFromCache(key);
  if (cached) return cached;
  if (tileInflight.has(key)) return tileInflight.get(key);
  const p = (async () => {
    try {
      const res = await axios.get(`${GSI_TILE_BASE}/${layer}/${z}/${x}/${y}.png`, {
        responseType: 'arraybuffer',
        timeout: 8000,
        maxContentLength: 2 * 1024 * 1024,
        headers: { 'User-Agent': UA },
        validateStatus: (s) => s === 200 || s === 404
      });
      const entry = { buf: res.status === 200 ? Buffer.from(res.data) : null, at: Date.now() };
      tileCache.set(key, entry);
      while (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
      return entry;
    } finally {
      tileInflight.delete(key);
    }
  })();
  tileInflight.set(key, p);
  return p;
}

/* =====================================================================
 * 9. クエリ処理
 * ===================================================================== */

function parseBbox(raw) {
  if (typeof raw !== 'string') return null;
  const p = raw.split(',').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return null;
  let [w, s, e, n] = p;
  s = Math.max(-90, s);
  n = Math.min(90, n);
  w = Math.max(-180, w);
  e = Math.min(180, e);
  if (w > e || s > n) return null;
  return { w, s, e, n };
}

function queryVehicles({ bbox, modes, limit }) {
  const modeSet = modes && modes.length ? new Set(modes) : null;
  let list = state.snapshot.filter((v) => (!bbox || (v.la >= bbox.s && v.la <= bbox.n && v.lo >= bbox.w && v.lo <= bbox.e)) && (!modeSet || modeSet.has(v.m)));
  let truncated = false;
  if (list.length > limit) {
    truncated = true;
    const cy = bbox ? (bbox.s + bbox.n) / 2 : SCHOOL.lat;
    const cx = bbox ? (bbox.w + bbox.e) / 2 : SCHOOL.lon;
    list = list
      .map((v) => ({ v, d: (v.la - cy) ** 2 + (v.lo - cx) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, limit)
      .map((x) => x.v);
  }
  return { list, truncated };
}

function queryStops({ bbox, limit }) {
  const out = [];
  const cx = (bbox.w + bbox.e) / 2;
  const cy = (bbox.s + bbox.n) / 2;
  const i0 = Math.floor(bbox.s / GRID);
  const i1 = Math.floor(bbox.n / GRID);
  const j0 = Math.floor(bbox.w / GRID);
  const j1 = Math.floor(bbox.e / GRID);
  if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4000) return { list: [], truncated: true };
  for (const g of state.staticGroups.values()) {
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const cell = g.grid.get(`${i}:${j}`);
        if (!cell) continue;
        for (const s of cell) if (s.la >= bbox.s && s.la <= bbox.n && s.lo >= bbox.w && s.lo <= bbox.e) out.push(s);
      }
    }
  }
  let truncated = false;
  let list = out;
  if (out.length > limit) {
    truncated = true;
    list = out
      .map((s) => ({ s, d: (s.la - cy) ** 2 + (s.lo - cx) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, limit)
      .map((x) => x.s);
  }
  return { list, truncated };
}

function feedSummary(detail = false) {
  return [...state.feeds.values()].map((f) => {
    const count = f.kind === 'vehicle' ? f.vehicles.length : f.kind === 'alert' ? f.alerts.length : f.delays.size;
    const o = { id: f.id, label: f.label, kind: f.kind, mode: f.mode, ok: f.st.ok, error: f.st.error, count, updatedAt: f.st.lastOk || 0 };
    if (detail) Object.assign(o, { host: ODPT_HOSTS[f.host].name, fails: f.st.fails, nextTry: f.st.nextTry });
    return o;
  });
}

/* =====================================================================
 * 10. Express への登録
 * ===================================================================== */

function register(app, deps) {
  const { express, ensureAuth, ensureAdmin, asyncHandler, rateLimit } = deps;
  const wrap = asyncHandler || ((fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next));

  const mapLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, please slow down.' } });
  const tileLimiter = rateLimit({ windowMs: 60 * 1000, max: 1500, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, please slow down.' } });
  const noStore = (res) => res.set('Cache-Control', 'no-store');

  // Leaflet を node_modules から自サーバー配信(外部CDNへ依存しない / CSP変更不要)
  try {
    const leafletDist = path.join(path.dirname(require.resolve('leaflet/package.json')), 'dist');
    app.use('/vendor/leaflet', express.static(leafletDist, { index: false, maxAge: '7d' }));
  } catch (_) {
    console.warn('[TransitMap] leaflet が見つかりません。`npm install leaflet` を実行してください。');
  }

  app.get(
    '/api/transit/map/config',
    ensureAuth,
    mapLimiter,
    (req, res) => {
      noStore(res);
      res.json({
        school: SCHOOL,
        view: { zoom: 12, minZoom: TILE_MIN_ZOOM, maxZoom: TILE_MAX_ZOOM },
        tiles: { layers: Object.entries(TILE_LAYERS).map(([id, label]) => ({ id, label })), template: '/api/transit/tiles/{layer}/{z}/{x}/{y}.png' },
        pollSec: Math.round(RT_INTERVAL_MS() / 1000)
      });
    }
  );

  app.get(
    '/api/transit/map/vehicles',
    ensureAuth,
    mapLimiter,
    wrap(async (req, res) => {
      noStore(res);
      const pending = ensureFresh();
      // 初回(まだ何も取得できていない)だけ少し待って、空の地図を返さないようにする
      if (state.snapshotAt === 0 && pending) await Promise.race([pending, sleep(8000)]);
      const bbox = parseBbox(req.query.bbox);
      const modes = String(req.query.modes || '')
        .split(',')
        .filter((m) => ['rail', 'bus', 'other'].includes(m));
      const limit = clampNum(req.query.limit, 3000, 1, 6000);
      const { list, truncated } = queryVehicles({ bbox, modes, limit });
      res.json({ updatedAt: state.snapshotAt, stale: Date.now() - state.snapshotAt > RT_INTERVAL_MS() * 3, count: list.length, truncated, vehicles: list });
    })
  );

  app.get(
    '/api/transit/map/stops',
    ensureAuth,
    mapLimiter,
    (req, res) => {
      noStore(res);
      const bbox = parseBbox(req.query.bbox);
      if (!bbox) return res.status(400).json({ error: 'bbox が不正です。' });
      const { list, truncated } = queryStops({ bbox, limit: clampNum(req.query.limit, 1500, 1, 3000) });
      res.json({ count: list.length, truncated, stops: list });
    }
  );

  app.get(
    '/api/transit/map/info',
    ensureAuth,
    mapLimiter,
    (req, res) => {
      noStore(res);
      res.json({
        updatedAt: state.snapshotAt,
        feeds: feedSummary(false),
        alerts: state.alerts.slice(0, 100),
        statics: [...state.staticGroups.values()].map((g) => ({ id: g.src.id, label: g.src.label, ok: g.status.ok, stops: g.status.stops }))
      });
    }
  );

  if (ensureAdmin) {
    app.get('/api/transit/map/admin/status', ensureAdmin, (req, res) => {
      noStore(res);
      res.json({
        keys: { center: Boolean(process.env.ODPT_CONSUMER_KEY), challenge: Boolean(process.env.ODPT_2026_KEY) },
        discovery: state.discovery,
        rtIntervalSec: RT_INTERVAL_MS() / 1000,
        lastDemandAgoSec: state.lastDemand ? Math.round((Date.now() - state.lastDemand) / 1000) : null,
        snapshotVehicles: state.snapshot.length,
        feeds: feedSummary(true),
        statics: [...state.staticGroups.values()].map((g) => ({ id: g.src.id, label: g.src.label, ...g.status })),
        tileCache: tileCache.size
      });
    });
  }

  app.get(
    '/api/transit/tiles/:layer/:z/:x/:y.png',
    ensureAuth,
    tileLimiter,
    wrap(async (req, res) => {
      const { layer } = req.params;
      // 数字だけの表記に限定する(1e3 / 0x10 / 空白付きなどの紛らわしい値を通さない)
      if (![req.params.z, req.params.x, req.params.y].every((v) => /^\d{1,7}$/.test(String(v)))) return res.status(400).end();
      const z = Number(req.params.z);
      const x = Number(req.params.x);
      const y = Number(req.params.y);
      const max = 2 ** z;
      if (!Object.prototype.hasOwnProperty.call(TILE_LAYERS, layer) || z < TILE_MIN_ZOOM || z > TILE_MAX_ZOOM || x >= max || y >= max) {
        return res.status(400).end();
      }
      let tile;
      try {
        tile = await fetchTile(layer, z, x, y);
      } catch (_) {
        return res.status(502).end();
      }
      if (!tile.buf) return res.status(404).end();
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'private, max-age=43200');
      res.send(tile.buf);
    })
  );
}

function init({ dataDir } = {}) {
  if (!process.env.ODPT_CONSUMER_KEY) console.warn('[TransitMap] ODPT_CONSUMER_KEY が未設定です(api.odpt.org のデータは取得しません)。');
  if (!process.env.ODPT_2026_KEY) console.warn('[TransitMap] ODPT_2026_KEY が未設定です(api-challenge.odpt.org のデータは取得しません)。');

  const start = async () => {
    if (dataDir) await loadDiscoveryCache(dataDir);
    if (state.feeds.size === 0) applyFeedList(DEFAULT_RT_FEEDS, 'default');
    // 静的データ(駅・路線名)とフィード検出は並行して行う。路線名は次回の更新で車両に反映される
    await Promise.all([loadAllStatic(), runDiscovery(dataDir)]);
  };
  start().catch((err) => console.error('[TransitMap] 初期化失敗:', scrub(err && err.message)));

  state.timers.push(setInterval(() => runDiscovery(dataDir), DISCOVERY_REFRESH_MS));
  state.timers.push(setInterval(() => loadAllStatic().catch(() => {}), STATIC_REFRESH_MS));
  state.timers.forEach((t) => t.unref && t.unref());
}

module.exports = {
  register,
  init,
  // 単体テスト用(本番コードからは使わない)
  _internals: {
    decodeFeed,
    parseCsv,
    csvToObjects,
    readZipEntries,
    buildStaticGroup,
    buildOdptUrl,
    scrub,
    parseRtUrl,
    detectKind,
    detectMode,
    rtBase,
    collectFeedsFromPackage,
    applyFeedList,
    refreshFeed,
    rebuildSnapshot,
    queryVehicles,
    queryStops,
    parseBbox,
    fetchTile,
    ensureFresh,
    loadStaticSource,
    state
  }
};