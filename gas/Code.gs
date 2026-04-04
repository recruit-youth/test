const SPREADSHEET_ID = '14QAijJ_rHXxK7Kbr6704lZ2iku4VJu_ouuv5J3Ifc08';
const AGENTS_SHEET_NAME = 'agents';
const APPLICATIONS_SHEET_NAME = 'applications';
const RESERVATIONS_SHEET_NAME = 'reservations';
const DEFAULT_TOP_AGENT_COUNT = 3;
const DEFAULT_TIME_SLOTS = [
  '10:00～11:00',
  '11:00～12:00',
  '12:00～13:00',
  '13:00～14:00',
  '14:00～15:00',
  '15:00～16:00',
  '16:00～17:00',
  '17:00～18:00'
];

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
    if (action === 'get_availability') {
      return jsonOutput_(handleGetAvailability_(payload));
    }
    if (action === 'reserve_slot') {
      return jsonOutput_(handleReserveSlot_(payload));
    }

    return jsonOutput_({
      ok: false,
      error: 'Unsupported action. Use diagnose, reserve, get_availability, or reserve_slot.'
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
  const ctx = loadAgents_();
  const agents = ctx.agents;
  if (!agents.length) {
    return { ok: true, agents: [] };
  }

  const scored = agents
    .map(agent => {
      const scoreResult = scoreAgent_(agent, payload);
      agent._score = scoreResult.score;
      agent._reasons = scoreResult.reasons;
      agent._locationMatched = scoreResult.locationMatched;
      agent._occupationMatched = scoreResult.occupationMatched;
      return agent;
    })
    .sort((a, b) => b._score - a._score);

  const selected = pickBalancedAgents_(
    scored,
    Math.min(DEFAULT_TOP_AGENT_COUNT, scored.length)
  );

  incrementDisplayCounts_(ctx.sheet, ctx.rawHeaders, selected);

  return {
    ok: true,
    agents: selected.map(agent => ({
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
  if (values.length <= 1) {
    return {
      sheet: sheet,
      rawHeaders: [],
      agents: []
    };
  }

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
    item._rowNumber = i + 1;
    item._displayCount = parseInt(
      pickString_(item, ['display_count', '表示回数', '配信回数', '表示数'], '0'),
      10
    );
    if (isNaN(item._displayCount)) item._displayCount = 0;

    if (isAgentEnabled_(item)) rows.push(item);
  }

  return {
    sheet: sheet,
    rawHeaders: rawHeaders,
    agents: rows
  };
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

  let locationMatched = false;
  if (prefecture && matchAny_(prefectures, [prefecture])) {
    score += 55;
    locationMatched = true;
    reasons.push('居住都道府県に対応');
  } else if (region && matchAny_(regions, [region])) {
    score += 45;
    locationMatched = true;
    reasons.push('居住エリアに対応');
  } else if (hasWideCoverage_(prefectures) || hasWideCoverage_(regions)) {
    score += 20;
    locationMatched = true;
    reasons.push('全国・広域対応');
  }

  const jobCandidates = [recentJob].concat(interestJobs).filter(v => v);
  const jobMatched = !!jobCandidates.length && (
    matchAny_(jobs, jobCandidates) || hasWideCoverage_(jobs)
  );
  const industryMatched = !!interestIndustries.length && (
    matchAny_(industries, interestIndustries) || hasWideCoverage_(industries)
  );
  const occupationMatched = jobMatched || industryMatched;

  if (jobMatched) {
    score += 45;
    reasons.push('希望・経験職種に強み');
  }
  if (industryMatched) {
    score += 35;
    reasons.push('興味業界とマッチ');
  }
  if (jobMatched && industryMatched) {
    score += 10;
  }
  if (matchAny_(timing, [whenChange])) {
    score += 5;
    reasons.push('転職希望時期と合致');
  }

  const supportsUnexp = pickString_(agent, ['supports_unexperienced', '未経験対応', '未経験可'], '');
  if (challenge.indexOf('挑戦') >= 0 && String(supportsUnexp).trim()) {
    score += 4;
    reasons.push('未経験チャレンジ支援あり');
  }

  const minAge = parseInt(pickString_(agent, ['min_age', 'minage', '最低年齢'], ''), 10);
  const maxAge = parseInt(pickString_(agent, ['max_age', 'maxage', '最高年齢'], ''), 10);
  if (!isNaN(age) && !isNaN(minAge) && !isNaN(maxAge) && age >= minAge && age <= maxAge) {
    score += 3;
    reasons.push('年齢ターゲットに適合');
  }

  // 表示回数が少ないエージェントを優先して、提案の偏りを抑える。
  const displayCount = parseInt(agent._displayCount || 0, 10);
  const balanceBonus = Math.max(0, 20 - Math.min(isNaN(displayCount) ? 0 : displayCount, 20));
  score += balanceBonus * 0.25;

  const description = pickString_(agent, ['description', 'desc', '説明', '特徴'], '');
  if (!reasons.length && description) {
    reasons.push(description);
  }

  return {
    score: score,
    reasons: reasons,
    locationMatched: locationMatched,
    occupationMatched: occupationMatched
  };
}

function pickBalancedAgents_(agents, count) {
  if (count <= 0) return [];
  if (agents.length <= count) return agents.slice(0, count);

  const tiers = [[], [], [], []];
  agents.forEach(agent => {
    const inLocation = !!agent._locationMatched;
    const inOccupation = !!agent._occupationMatched;
    const tier = inLocation && inOccupation
      ? 0
      : inLocation
        ? 1
        : inOccupation
          ? 2
          : 3;
    tiers[tier].push(agent);
  });

  tiers.forEach(list => {
    list.sort((a, b) => {
      const aCount = parseInt(a._displayCount || 0, 10);
      const bCount = parseInt(b._displayCount || 0, 10);
      const countDiff = (isNaN(aCount) ? 0 : aCount) - (isNaN(bCount) ? 0 : bCount);
      if (countDiff !== 0) return countDiff;

      const scoreDiff = (b._score || 0) - (a._score || 0);
      if (scoreDiff !== 0) return scoreDiff;

      return (a._rowNumber || 0) - (b._rowNumber || 0);
    });
  });

  const picked = [];
  for (let tierIdx = 0; tierIdx < tiers.length; tierIdx += 1) {
    const tier = tiers[tierIdx];
    for (let i = 0; i < tier.length; i += 1) {
      picked.push(tier[i]);
      if (picked.length >= count) return picked;
    }
  }

  return picked.slice(0, count);
}

function incrementDisplayCounts_(sheet, rawHeaders, selectedAgents) {
  if (!selectedAgents.length) return;

  let headerIndex = findHeaderIndex_(rawHeaders, ['display_count', '表示回数', '配信回数', '表示数']);
  if (headerIndex < 0) {
    rawHeaders.push('display_count');
    headerIndex = rawHeaders.length - 1;
    sheet.getRange(1, 1, 1, rawHeaders.length).setValues([rawHeaders]);
  }

  const columnNumber = headerIndex + 1;
  selectedAgents.forEach(agent => {
    const current = parseInt(agent._displayCount || 0, 10);
    const next = (isNaN(current) ? 0 : current) + 1;
    sheet.getRange(agent._rowNumber, columnNumber).setValue(next);
    agent._displayCount = next;
  });
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

function handleGetAvailability_(payload) {
  const agentName = String(payload.agent_name || '').trim();
  if (!agentName) {
    return { ok: false, error: 'agent_name is required' };
  }

  const days = Math.max(7, Math.min(parseInt(payload.days || '31', 10) || 31, 60));
  const slotCandidates = splitMulti_(payload.slot_candidates);
  const baseSlots = slotCandidates.length ? slotCandidates : DEFAULT_TIME_SLOTS;

  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const reservations = loadReservationsForAgent_(agentName, startDate, days);

  const takenByDate = {};
  reservations.forEach(r => {
    if (!takenByDate[r.date]) takenByDate[r.date] = {};
    takenByDate[r.date][r.time] = true;
  });

  const available = {};
  const busyDays = [];

  for (var i = 0; i < days; i += 1) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    const dateStr = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
    const weekday = d.getDay();

    if (weekday === 0 || weekday === 6) {
      busyDays.push(dateStr);
      available[dateStr] = [];
      continue;
    }

    const taken = takenByDate[dateStr] || {};
    const free = baseSlots.filter(slot => !taken[slot]);
    available[dateStr] = free;
    if (!free.length) {
      busyDays.push(dateStr);
    }
  }

  return {
    ok: true,
    agent_name: agentName,
    available_slots_by_date: available,
    busy_days: busyDays
  };
}

function handleReserveSlot_(payload) {
  const agentName = String(payload.agent_name || '').trim();
  const date = String(payload.date || '').trim();
  const time = String(payload.time || '').trim();

  if (!agentName || !date || !time) {
    return { ok: false, error: 'agent_name, date, time are required' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const sheet = getOrCreateSheet_(RESERVATIONS_SHEET_NAME);
    const hash = buildReservationHash_(agentName, date, time);

    if (reservationExistsByHash_(sheet, hash)) {
      return { ok: false, conflict: true, error: 'その時間枠はすでに予約済みです。' };
    }

    const now = new Date();
    appendObjectRow_(sheet, {
      reservation_hash: hash,
      agent_name: agentName,
      date: date,
      time: time,
      status: 'booked',
      booked_at_iso: now.toISOString(),
      booked_at_jst: Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
    });

    return { ok: true, reservation_hash: hash };
  } finally {
    lock.releaseLock();
  }
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

function hasWideCoverage_(values) {
  if (!values || !values.length) return false;
  const wideKeywords = [
    '全国',
    '全国対応',
    '全エリア',
    'all',
    'any',
    'all regions',
    'all areas'
  ];
  for (let i = 0; i < values.length; i += 1) {
    const v = String(values[i] || '').toLowerCase();
    if (!v) continue;
    for (let j = 0; j < wideKeywords.length; j += 1) {
      const keyword = String(wideKeywords[j]).toLowerCase();
      if (v === keyword || v.indexOf(keyword) >= 0) return true;
    }
  }
  return false;
}

function findHeaderIndex_(headers, candidates) {
  if (!headers || !headers.length) return -1;
  const normalizedHeaders = headers.map(h => normalizeHeader_(h));
  for (let i = 0; i < candidates.length; i += 1) {
    const c = normalizeHeader_(candidates[i]);
    const idx = normalizedHeaders.indexOf(c);
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseAgeNumber_(ageText) {
  const m = String(ageText || '').match(/\d+/);
  return m ? parseInt(m[0], 10) : NaN;
}


function loadReservationsForAgent_(agentName, startDate, days) {
  const sheet = getOrCreateSheet_(RESERVATIONS_SHEET_NAME);
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];

  const headers = values[0].map(v => normalizeHeader_(v));
  const idxAgent = headers.indexOf('agent_name');
  const idxDate = headers.indexOf('date');
  const idxTime = headers.indexOf('time');
  const idxStatus = headers.indexOf('status');

  const startStr = Utilities.formatDate(startDate, 'Asia/Tokyo', 'yyyy-MM-dd');
  const end = new Date(startDate);
  end.setDate(startDate.getDate() + days - 1);
  const endStr = Utilities.formatDate(end, 'Asia/Tokyo', 'yyyy-MM-dd');

  const rows = [];
  for (var i = 1; i < values.length; i += 1) {
    const row = values[i];
    const rowAgent = idxAgent >= 0 ? String(row[idxAgent] || '').trim() : '';
    const rowDate = idxDate >= 0 ? String(row[idxDate] || '').trim() : '';
    const rowTime = idxTime >= 0 ? String(row[idxTime] || '').trim() : '';
    const rowStatus = idxStatus >= 0 ? String(row[idxStatus] || '').trim().toLowerCase() : 'booked';

    if (!rowAgent || !rowDate || !rowTime) continue;
    if (rowAgent !== agentName) continue;
    if (rowStatus && rowStatus !== 'booked') continue;
    if (rowDate < startStr || rowDate > endStr) continue;

    rows.push({ agent_name: rowAgent, date: rowDate, time: rowTime });
  }

  return rows;
}

function reservationExistsByHash_(sheet, hash) {
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return false;

  const headers = values[0].map(v => normalizeHeader_(v));
  const idxHash = headers.indexOf('reservation_hash');
  if (idxHash < 0) {
    return false;
  }

  for (var i = 1; i < values.length; i += 1) {
    if (String(values[i][idxHash] || '').trim() === hash) {
      return true;
    }
  }

  return false;
}

function buildReservationHash_(agentName, date, time) {
  return [agentName, date, time]
    .map(v => String(v || '').trim())
    .join('|');
}
