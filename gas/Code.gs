const SPREADSHEET_ID = '14QAijJ_rHXxK7Kbr6704lZ2iku4VJu_ouuv5J3Ifc08';
const AGENTS_SHEET_NAME = 'agents';
const APPLICATIONS_SHEET_NAME = 'applications';
const DEFAULT_TOP_AGENT_COUNT = 3;

function doPost(e) {
  try {
    const payload = parsePayload_(e);
    const action = String(payload.action || '').toLowerCase();

    if (action === 'diagnose') {
      return jsonOutput_(handleDiagnose_(payload));
    }
    if (action === 'reserve') {
      return jsonOutput_(handleReserve_(payload));
    }

    return jsonOutput_({
      ok: false,
      error: 'Unsupported action. Use diagnose or reserve.'
    });
  } catch (error) {
    return jsonOutput_({
      ok: false,
      error: String(error && error.message ? error.message : error)
    });
  }
}

function parsePayload_(e) {
  if (!e) return {};

  const postData = e.postData && e.postData.contents ? e.postData.contents : '';
  if (postData) {
    try {
      return JSON.parse(postData);
    } catch (_) {
      // Fallback to query payload when body is not JSON.
    }
  }

  return e.parameter || {};
}

function jsonOutput_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleDiagnose_(payload) {
  const agents = loadAgents_();
  if (!agents.length) {
    return { ok: true, agents: [] };
  }

  const scored = agents
    .map(agent => {
      const scoreResult = scoreAgent_(agent, payload);
      agent._score = scoreResult.score;
      agent._reasons = scoreResult.reasons;
      return agent;
    })
    .sort((a, b) => b._score - a._score);

  return {
    ok: true,
    agents: scored.slice(0, DEFAULT_TOP_AGENT_COUNT).map(agent => ({
      name: pickString_(agent, ['name', 'agent', 'agent_name', '会社名', 'エージェント名'], 'おすすめエージェント'),
      category: pickString_(agent, ['category', 'カテゴリ', 'tag', 'タグ'], '20代向け特化'),
      description: pickString_(agent, ['description', 'desc', '説明', '特徴'], ''),
      calendarUrl: pickString_(agent, ['calendarurl', 'calendar_url', '予約url', '予約リンク'], '#'),
      reasons: agent._reasons.length ? agent._reasons.slice(0, 3) : [
        'ご回答条件との一致度が高いエージェントです'
      ]
    }))
  };
}

function loadAgents_() {
  const sheet = getSheet_(AGENTS_SHEET_NAME);
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];

  const rawHeaders = values[0].map(v => String(v || '').trim());
  const normalizedHeaders = rawHeaders.map(normalizeHeader_);

  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    const row = values[i];
    if (row.every(cell => String(cell || '').trim() === '')) continue;

    const item = {};
    for (let j = 0; j < normalizedHeaders.length; j += 1) {
      const raw = rawHeaders[j];
      const key = normalizedHeaders[j];
      item[key] = row[j];
      if (raw && item[raw] === undefined) item[raw] = row[j];
    }

    if (isAgentEnabled_(item)) rows.push(item);
  }

  return rows;
}

function isAgentEnabled_(agent) {
  const active = pickString_(agent, ['active', 'is_active', '公開', 'enabled'], 'true');
  const val = String(active).trim().toLowerCase();
  if (!val) return true;
  return ['1', 'true', 'yes', 'on', '公開', '有効'].indexOf(val) >= 0;
}

function scoreAgent_(agent, payload) {
  let score = 0;
  const reasons = [];

  const region = String(payload.living_region || '');
  const prefecture = String(payload.living_prefecture || '');
  const recentJob = String(payload.recent_job || '');
  const interestJobs = splitMulti_(payload.interest_jobs);
  const interestIndustries = splitMulti_(payload.interest_industries);
  const challenge = String(payload.challenge_unexperienced || '');
  const whenChange = String(payload.when_change || '');
  const age = parseAgeNumber_(payload.age);

  const regions = pickMulti_(agent, ['regions', 'area', 'areas', 'target_regions', '対応地域', '対応エリア']);
  const prefectures = pickMulti_(agent, ['prefectures', 'target_prefectures', '都道府県', '対応都道府県']);
  const jobs = pickMulti_(agent, ['jobs', 'job_types', 'target_jobs', '職種', '得意職種']);
  const industries = pickMulti_(agent, ['industries', 'target_industries', '業界', '得意業界']);
  const timing = pickMulti_(agent, ['timing', 'target_timing', '転職時期']);

  if (matchAny_(regions, [region])) {
    score += 20;
    reasons.push('居住エリアとの相性が良い');
  }
  if (matchAny_(prefectures, [prefecture])) {
    score += 20;
    reasons.push('都道府県条件に対応');
  }
  if (matchAny_(jobs, [recentJob].concat(interestJobs))) {
    score += 25;
    reasons.push('経験職種・興味職種に強みあり');
  }
  if (matchAny_(industries, interestIndustries)) {
    score += 20;
    reasons.push('希望業界にマッチ');
  }
  if (matchAny_(timing, [whenChange])) {
    score += 8;
    reasons.push('転職希望時期と合致');
  }

  const supportsUnexp = pickString_(agent, ['supports_unexperienced', '未経験対応', '未経験可'], '');
  if (challenge.indexOf('挑戦') >= 0 && String(supportsUnexp).trim()) {
    score += 8;
    reasons.push('未経験チャレンジ支援あり');
  }

  const minAge = parseInt(pickString_(agent, ['min_age', 'minage', '最低年齢'], ''), 10);
  const maxAge = parseInt(pickString_(agent, ['max_age', 'maxage', '最高年齢'], ''), 10);
  if (!isNaN(age) && !isNaN(minAge) && !isNaN(maxAge) && age >= minAge && age <= maxAge) {
    score += 6;
    reasons.push('年齢ターゲットに適合');
  }

  const description = pickString_(agent, ['description', 'desc', '説明', '特徴'], '');
  if (!reasons.length && description) {
    reasons.push(description);
  }

  return { score: score, reasons: reasons };
}

function handleReserve_(payload) {
  const sheet = getOrCreateSheet_(APPLICATIONS_SHEET_NAME);
  const now = new Date();
  const data = Object.assign({}, payload);
  delete data.action;

  if (!data.completed_at_iso) data.completed_at_iso = now.toISOString();
  if (!data.completed_at_jst) {
    data.completed_at_jst = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  }
  data.received_at_iso = now.toISOString();

  appendObjectRow_(sheet, data);

  return {
    ok: true,
    sheet: APPLICATIONS_SHEET_NAME,
    row: sheet.getLastRow()
  };
}

function appendObjectRow_(sheet, obj) {
  const keys = Object.keys(obj);
  if (!keys.length) return;

  let headers = [];
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  if (lastRow > 0 && lastCol > 0) {
    headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
      .map(v => String(v || '').trim());
  }

  keys.forEach(key => {
    if (headers.indexOf(key) < 0) headers.push(key);
  });

  if (headers.length > 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  const row = headers.map(header => toCellValue_(obj[header]));
  sheet.appendRow(row);
}

function toCellValue_(value) {
  if (value === null || value === undefined) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function getSheet_(name) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name);
  return sheet;
}

function getOrCreateSheet_(name) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function normalizeHeader_(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function pickString_(obj, keys, fallback) {
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== '') {
      return String(obj[key]).trim();
    }
    const normalized = normalizeHeader_(key);
    if (obj[normalized] !== undefined && obj[normalized] !== null && String(obj[normalized]).trim() !== '') {
      return String(obj[normalized]).trim();
    }
  }
  return fallback || '';
}

function pickMulti_(obj, keys) {
  const raw = pickString_(obj, keys, '');
  return splitMulti_(raw);
}

function splitMulti_(value) {
  return String(value || '')
    .split(/[,\n、\/|]/)
    .map(v => String(v || '').trim())
    .filter(v => v);
}

function matchAny_(targets, values) {
  if (!targets.length || !values.length) return false;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value) continue;
    for (let j = 0; j < targets.length; j += 1) {
      const target = targets[j];
      if (!target) continue;
      if (target === value || target.indexOf(value) >= 0 || value.indexOf(target) >= 0) {
        return true;
      }
    }
  }
  return false;
}

function parseAgeNumber_(ageText) {
  const m = String(ageText || '').match(/\d+/);
  return m ? parseInt(m[0], 10) : NaN;
}
