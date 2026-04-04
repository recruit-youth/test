var SPREADSHEET_ID = '14QAijJ_rHXxK7Kbr6704lZ2iku4VJu_ouuv5J3Ifc08';
var AGENTS_SHEET_NAME = 'agents';
var APPLICANTS_SHEET_NAME = 'applicants';
var RESERVATIONS_SHEET_NAME = 'reservations';
var DEFAULT_TOP_AGENT_COUNT = 3;
var HOLD_TTL_MINUTES = 10;

var RESERVATION_STATUS = {
  HOLDING: 'holding',
  BOOKED: 'booked',
  CANCELED: 'canceled',
  DONE: 'done',
  NO_SHOW: 'no_show'
};

var DEFAULT_TIME_SLOTS = [
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
    var payload = parsePayload_(e);
    var action = String(payload.action || '').toLowerCase();

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
    if (action === 'update_reservation_status') {
      return jsonOutput_(handleUpdateReservationStatus_(payload));
    }

    return jsonOutput_({
      ok: false,
      error: 'Unsupported action. Use diagnose, reserve, get_availability, reserve_slot, or update_reservation_status.'
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

  var postData = e.postData && e.postData.contents ? e.postData.contents : '';
  if (postData) {
    try {
      return JSON.parse(postData);
    } catch (parseErr) {
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
  var ctx = loadAgents_();
  var agents = ctx.agents;
  if (!agents.length) {
    return { ok: true, agents: [] };
  }

  var scored = agents
    .map(function(agent) {
      var scoreResult = scoreAgent_(agent, payload);
      agent._score = scoreResult.score;
      agent._reasons = scoreResult.reasons;
      agent._locationMatched = scoreResult.locationMatched;
      agent._occupationMatched = scoreResult.occupationMatched;
      return agent;
    })
    .sort(function(a, b) { return b._score - a._score; });

  var selected = pickBalancedAgents_(
    scored,
    Math.min(DEFAULT_TOP_AGENT_COUNT, scored.length)
  );

  incrementDisplayCounts_(ctx.sheet, ctx.rawHeaders, selected);

  return {
    ok: true,
    agents: selected.map(function(agent) {
      return {
        name: pickString_(agent, ['name', 'agent', 'agent_name', '会社名', 'エージェント名'], 'おすすめエージェント'),
        category: pickString_(agent, ['category', 'カテゴリ', 'tag', 'タグ'], '20代向け特化'),
        description: pickString_(agent, ['description', 'desc', '説明', '特徴'], ''),
        calendarUrl: pickString_(agent, ['calendarurl', 'calendar_url', '予約url', '予約リンク'], '#'),
        slotCandidates: extractAgentSlots_(agent),
        reasons: agent._reasons.length ? agent._reasons.slice(0, 3) : [
          'ご回答条件との一致度が高いエージェントです'
        ]
      };
    })
  };
}

function loadAgents_() {
  var sheet = getSheet_(AGENTS_SHEET_NAME);
  var values = sheet.getDataRange().getValues();
  if (values.length <= 1) {
    return {
      sheet: sheet,
      rawHeaders: [],
      agents: []
    };
  }

  var rawHeaders = values[0].map(function(v) { return String(v || '').trim(); });
  var normalizedHeaders = rawHeaders.map(normalizeHeader_);

  var rows = [];
  for (var i = 1; i < values.length; i += 1) {
    var row = values[i];
    if (row.every(function(cell) { return String(cell || '').trim() === ''; })) continue;

    var item = {};
    for (var j = 0; j < normalizedHeaders.length; j += 1) {
      var raw = rawHeaders[j];
      var key = normalizedHeaders[j];
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
  var active = pickString_(agent, ['active', 'is_active', '公開', 'enabled'], 'true');
  var val = String(active).trim().toLowerCase();
  if (!val) return true;
  return ['1', 'true', 'yes', 'on', '公開', '有効'].indexOf(val) >= 0;
}

function scoreAgent_(agent, payload) {
  var score = 0;
  var reasons = [];

  var region = String(payload.living_region || '');
  var prefecture = String(payload.living_prefecture || '');
  var recentJob = String(payload.recent_job || '');
  var interestJobs = splitMulti_(payload.interest_jobs);
  var interestIndustries = splitMulti_(payload.interest_industries);
  var challenge = String(payload.challenge_unexperienced || '');
  var whenChange = String(payload.when_change || '');
  var age = parseAgeNumber_(payload.age);

  var regions = pickMulti_(agent, ['regions', 'area', 'areas', 'target_regions', '対応地域', '対応エリア']);
  var prefectures = pickMulti_(agent, ['prefectures', 'target_prefectures', '都道府県', '対応都道府県']);
  var jobs = pickMulti_(agent, ['jobs', 'job_types', 'target_jobs', '職種', '得意職種']);
  var industries = pickMulti_(agent, ['industries', 'target_industries', '業界', '得意業界']);
  var timing = pickMulti_(agent, ['timing', 'target_timing', '転職時期']);

  var locationMatched = false;
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

  var jobCandidates = [recentJob].concat(interestJobs).filter(function(v) { return v; });
  var jobMatched = !!jobCandidates.length && (
    matchAny_(jobs, jobCandidates) || hasWideCoverage_(jobs)
  );
  var industryMatched = !!interestIndustries.length && (
    matchAny_(industries, interestIndustries) || hasWideCoverage_(industries)
  );
  var occupationMatched = jobMatched || industryMatched;

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

  var supportsUnexp = pickString_(agent, ['supports_unexperienced', '未経験対応', '未経験可'], '');
  if (challenge.indexOf('挑戦') >= 0 && String(supportsUnexp).trim()) {
    score += 4;
    reasons.push('未経験チャレンジ支援あり');
  }

  var minAge = parseInt(pickString_(agent, ['min_age', 'minage', '最低年齢'], ''), 10);
  var maxAge = parseInt(pickString_(agent, ['max_age', 'maxage', '最高年齢'], ''), 10);
  if (!isNaN(age) && !isNaN(minAge) && !isNaN(maxAge) && age >= minAge && age <= maxAge) {
    score += 3;
    reasons.push('年齢ターゲットに適合');
  }

  var displayCount = parseInt(agent._displayCount || 0, 10);
  var balanceBonus = Math.max(0, 20 - Math.min(isNaN(displayCount) ? 0 : displayCount, 20));
  score += balanceBonus * 0.25;

  var description = pickString_(agent, ['description', 'desc', '説明', '特徴'], '');
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

  var tiers = [[], [], [], []];
  agents.forEach(function(agent) {
    var inLocation = !!agent._locationMatched;
    var inOccupation = !!agent._occupationMatched;
    var tier = inLocation && inOccupation
      ? 0
      : inLocation
        ? 1
        : inOccupation
          ? 2
          : 3;
    tiers[tier].push(agent);
  });

  tiers.forEach(function(list) {
    list.sort(function(a, b) {
      var aCount = parseInt(a._displayCount || 0, 10);
      var bCount = parseInt(b._displayCount || 0, 10);
      var countDiff = (isNaN(aCount) ? 0 : aCount) - (isNaN(bCount) ? 0 : bCount);
      if (countDiff !== 0) return countDiff;

      var scoreDiff = (b._score || 0) - (a._score || 0);
      if (scoreDiff !== 0) return scoreDiff;

      return (a._rowNumber || 0) - (b._rowNumber || 0);
    });
  });

  var picked = [];
  for (var tierIdx = 0; tierIdx < tiers.length; tierIdx += 1) {
    var tier = tiers[tierIdx];
    for (var i = 0; i < tier.length; i += 1) {
      picked.push(tier[i]);
      if (picked.length >= count) return picked;
    }
  }

  return picked.slice(0, count);
}

function incrementDisplayCounts_(sheet, rawHeaders, selectedAgents) {
  if (!selectedAgents.length) return;

  var headerIndex = findHeaderIndex_(rawHeaders, ['display_count', '表示回数', '配信回数', '表示数']);
  if (headerIndex < 0) {
    rawHeaders.push('display_count');
    headerIndex = rawHeaders.length - 1;
    sheet.getRange(1, 1, 1, rawHeaders.length).setValues([rawHeaders]);
  }

  var columnNumber = headerIndex + 1;
  selectedAgents.forEach(function(agent) {
    var current = parseInt(agent._displayCount || 0, 10);
    var next = (isNaN(current) ? 0 : current) + 1;
    sheet.getRange(agent._rowNumber, columnNumber).setValue(next);
    agent._displayCount = next;
  });
}

function handleReserve_(payload) {
  var details = normalizeReservationDetails_(payload.reservation_details);
  if (!details.length) {
    return { ok: false, error: 'reservation_details is required' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  var now = new Date();
  try {
    var finalizeResult = finalizeReservationDetails_(details, now);
    if (!finalizeResult.ok) {
      return finalizeResult;
    }
  } finally {
    lock.releaseLock();
  }

  var appSheet = getOrCreateSheet_(APPLICANTS_SHEET_NAME);
  var data = Object.assign({}, payload);
  delete data.action;

  if (!data.completed_at_iso) data.completed_at_iso = now.toISOString();
  var completedAt = new Date(data.completed_at_iso);
  if (String(completedAt) === 'Invalid Date') completedAt = now;
  data.completed_at_jst = Utilities.formatDate(completedAt, 'Asia/Tokyo', 'yyyy/MM/dd/ HH:mm');
  data.received_at_iso = now.toISOString();

  migrateApplicantsHeadersToJapanese_(appSheet);
  var localizedData = localizeApplicantData_(data);
  appendObjectRowWithFirstHeader_(appSheet, localizedData, '完了時間');

  return {
    ok: true,
    sheet: APPLICANTS_SHEET_NAME,
    row: appSheet.getLastRow()
  };
}

function handleGetAvailability_(payload) {
  var agentName = String(payload.agent_name || '').trim();
  if (!agentName) {
    return { ok: false, error: 'agent_name is required' };
  }

  var days = Math.max(7, Math.min(parseInt(payload.days || '31', 10) || 31, 60));
  var payloadSlots = splitMulti_(payload.slot_candidates);
  var baseSlots = resolveSlotsForAgent_(agentName, payloadSlots);

  var now = new Date();
  var startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var reservations = loadReservationsForAgent_(agentName, startDate, days);

  var takenByDate = {};
  reservations.forEach(function(r) {
    if (!isBlockingReservation_(r, now)) return;
    if (!takenByDate[r.date]) takenByDate[r.date] = {};
    takenByDate[r.date][r.time] = true;
  });

  var available = {};
  var busyDays = [];

  for (var i = 0; i < days; i += 1) {
    var d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    var dateStr = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
    var weekday = d.getDay();

    if (weekday === 0 || weekday === 6) {
      busyDays.push(dateStr);
      available[dateStr] = [];
      continue;
    }

    var taken = takenByDate[dateStr] || {};
    var free = baseSlots.filter(function(slot) { return !taken[slot]; });
    available[dateStr] = free;
    if (!free.length) {
      busyDays.push(dateStr);
    }
  }

  return {
    ok: true,
    agent_name: agentName,
    available_slots_by_date: available,
    busy_days: busyDays,
    slot_candidates: baseSlots
  };
}

function handleReserveSlot_(payload) {
  var agentName = String(payload.agent_name || '').trim();
  var date = String(payload.date || '').trim();
  var time = String(payload.time || '').trim();
  var incomingHoldToken = String(payload.hold_token || '').trim();

  if (!agentName || !date || !time) {
    return { ok: false, error: 'agent_name, date, time are required' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    var sheet = getOrCreateSheet_(RESERVATIONS_SHEET_NAME);
    var hash = buildReservationHash_(agentName, date, time);
    var latest = getLatestReservationByHash_(sheet, hash);
    var now = new Date();

    if (latest) {
      var latestStatus = normalizeReservationStatus_(latest.status);
      var latestHoldToken = String(latest.hold_token || '').trim();

      if (latestStatus === RESERVATION_STATUS.BOOKED) {
        return { ok: false, conflict: true, error: 'その時間枠はすでに予約済みです。' };
      }

      if (latestStatus === RESERVATION_STATUS.HOLDING && !isHoldExpired_(latest, now)) {
        if (incomingHoldToken && latestHoldToken && incomingHoldToken === latestHoldToken) {
          var renewedExpiry = new Date(now.getTime() + HOLD_TTL_MINUTES * 60 * 1000);
          appendReservationEvent_(sheet, {
            reservation_hash: hash,
            agent_name: agentName,
            date: date,
            time: time,
            status: RESERVATION_STATUS.HOLDING,
            hold_token: latestHoldToken,
            hold_expires_at_iso: renewedExpiry.toISOString(),
            updated_at_iso: now.toISOString(),
            updated_at_jst: Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
          });

          return {
            ok: true,
            reservation_hash: hash,
            hold_token: latestHoldToken,
            hold_expires_at_iso: renewedExpiry.toISOString()
          };
        }

        return { ok: false, conflict: true, error: 'その時間枠は他ユーザーが仮予約中です。' };
      }
    }

    var holdToken = incomingHoldToken || Utilities.getUuid();
    var holdExpiry = new Date(now.getTime() + HOLD_TTL_MINUTES * 60 * 1000);

    appendReservationEvent_(sheet, {
      reservation_hash: hash,
      agent_name: agentName,
      date: date,
      time: time,
      status: RESERVATION_STATUS.HOLDING,
      hold_token: holdToken,
      hold_expires_at_iso: holdExpiry.toISOString(),
      updated_at_iso: now.toISOString(),
      updated_at_jst: Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
    });

    return {
      ok: true,
      reservation_hash: hash,
      hold_token: holdToken,
      hold_expires_at_iso: holdExpiry.toISOString()
    };
  } finally {
    lock.releaseLock();
  }
}

function handleUpdateReservationStatus_(payload) {
  var status = normalizeReservationStatus_(payload.status);
  var allowed = [
    RESERVATION_STATUS.CANCELED,
    RESERVATION_STATUS.DONE,
    RESERVATION_STATUS.NO_SHOW,
    RESERVATION_STATUS.BOOKED
  ];
  if (allowed.indexOf(status) < 0) {
    return { ok: false, error: 'status must be canceled, done, no_show, or booked' };
  }

  var hash = String(payload.reservation_hash || '').trim();
  if (!hash) {
    var agentName = String(payload.agent_name || '').trim();
    var date = String(payload.date || '').trim();
    var time = String(payload.time || '').trim();
    if (!agentName || !date || !time) {
      return { ok: false, error: 'reservation_hash or (agent_name/date/time) is required' };
    }
    hash = buildReservationHash_(agentName, date, time);
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    var sheet = getOrCreateSheet_(RESERVATIONS_SHEET_NAME);
    var latest = getLatestReservationByHash_(sheet, hash);
    if (!latest) {
      return { ok: false, error: 'reservation not found' };
    }

    var now = new Date();
    appendReservationEvent_(sheet, {
      reservation_hash: hash,
      agent_name: latest.agent_name,
      date: latest.date,
      time: latest.time,
      status: status,
      hold_token: '',
      hold_expires_at_iso: '',
      updated_at_iso: now.toISOString(),
      updated_at_jst: Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
    });

    return { ok: true, reservation_hash: hash, status: status };
  } finally {
    lock.releaseLock();
  }
}

function finalizeReservationDetails_(details, now) {
  var sheet = getOrCreateSheet_(RESERVATIONS_SHEET_NAME);
  var results = [];

  for (var i = 0; i < details.length; i += 1) {
    var detail = details[i];
    var agentName = String(detail.agent_name || '').trim();
    var date = String(detail.date || '').trim();
    var time = String(detail.time || '').trim();
    var hash = String(detail.reservation_hash || '').trim() || buildReservationHash_(agentName, date, time);
    var holdToken = String(detail.hold_token || '').trim();

    if (!agentName || !date || !time || !hash) {
      return { ok: false, error: 'reservation_details has invalid entry' };
    }

    var latest = getLatestReservationByHash_(sheet, hash);
    if (!latest) {
      return { ok: false, error: '予約情報が見つかりません。再度日程を選択してください。' };
    }

    var status = normalizeReservationStatus_(latest.status);
    if (status === RESERVATION_STATUS.BOOKED) {
      results.push({ reservation_hash: hash, status: 'already_booked' });
      continue;
    }

    if (status !== RESERVATION_STATUS.HOLDING) {
      return { ok: false, error: '予約ステータスが無効です。再度日程を選択してください。' };
    }

    if (isHoldExpired_(latest, now)) {
      return { ok: false, error: '仮予約の保持期限が切れました。再度日程を選択してください。' };
    }

    var latestHoldToken = String(latest.hold_token || '').trim();
    if (latestHoldToken && holdToken && latestHoldToken !== holdToken) {
      return { ok: false, error: '仮予約トークンが一致しません。再度日程を選択してください。' };
    }
    if (latestHoldToken && !holdToken) {
      return { ok: false, error: '仮予約情報が不足しています。再度日程を選択してください。' };
    }

    appendReservationEvent_(sheet, {
      reservation_hash: hash,
      agent_name: latest.agent_name,
      date: latest.date,
      time: latest.time,
      status: RESERVATION_STATUS.BOOKED,
      hold_token: latestHoldToken,
      hold_expires_at_iso: latest.hold_expires_at_iso || '',
      booked_at_iso: now.toISOString(),
      booked_at_jst: Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'),
      updated_at_iso: now.toISOString(),
      updated_at_jst: Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
    });

    results.push({ reservation_hash: hash, status: RESERVATION_STATUS.BOOKED });
  }

  return { ok: true, results: results };
}

function normalizeReservationDetails_(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  var raw = String(value || '').trim();
  if (!raw) return [];

  try {
    var parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (parseErr) {
    return [];
  }
}

function resolveSlotsForAgent_(agentName, payloadSlots) {
  var agentSlots = loadAgentSlotsByName_(agentName);
  if (agentSlots.length) return agentSlots;
  if (payloadSlots && payloadSlots.length) return payloadSlots;
  return DEFAULT_TIME_SLOTS.slice();
}

function loadAgentSlotsByName_(agentName) {
  if (!agentName) return [];
  var ctx = loadAgents_();
  for (var i = 0; i < ctx.agents.length; i += 1) {
    var agent = ctx.agents[i];
    var name = pickString_(agent, ['name', 'agent', 'agent_name', '会社名', 'エージェント名'], '');
    if (name === agentName) {
      return extractAgentSlots_(agent);
    }
  }
  return [];
}

function extractAgentSlots_(agent) {
  var slots = pickMulti_(agent, [
    'slot_candidates',
    'slots',
    'time_slots',
    'available_slots',
    'interview_slots',
    '面談可能時間',
    '面談時間'
  ]);
  return slots.length ? slots : DEFAULT_TIME_SLOTS.slice();
}

function loadReservationsForAgent_(agentName, startDate, days) {
  var sheet = getOrCreateSheet_(RESERVATIONS_SHEET_NAME);
  var values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];

  var headers = values[0].map(function(v) { return normalizeHeader_(v); });
  var idxHash = headers.indexOf('reservation_hash');
  var idxAgent = headers.indexOf('agent_name');
  var idxDate = headers.indexOf('date');
  var idxTime = headers.indexOf('time');
  var idxStatus = headers.indexOf('status');
  var idxHoldExpires = headers.indexOf('hold_expires_at_iso');

  var startStr = Utilities.formatDate(startDate, 'Asia/Tokyo', 'yyyy-MM-dd');
  var end = new Date(startDate);
  end.setDate(startDate.getDate() + days - 1);
  var endStr = Utilities.formatDate(end, 'Asia/Tokyo', 'yyyy-MM-dd');

  var byHash = {};
  for (var i = 1; i < values.length; i += 1) {
    var row = values[i];
    var rowHash = idxHash >= 0 ? String(row[idxHash] || '').trim() : '';
    var rowAgent = idxAgent >= 0 ? String(row[idxAgent] || '').trim() : '';
    var rowDate = idxDate >= 0 ? String(row[idxDate] || '').trim() : '';
    var rowTime = idxTime >= 0 ? String(row[idxTime] || '').trim() : '';
    var rowStatus = idxStatus >= 0 ? String(row[idxStatus] || '').trim() : '';
    var rowHoldExpires = idxHoldExpires >= 0 ? String(row[idxHoldExpires] || '').trim() : '';

    if (!rowHash || !rowAgent || !rowDate || !rowTime) continue;
    if (rowAgent !== agentName) continue;
    if (rowDate < startStr || rowDate > endStr) continue;

    byHash[rowHash] = {
      reservation_hash: rowHash,
      agent_name: rowAgent,
      date: rowDate,
      time: rowTime,
      status: rowStatus,
      hold_expires_at_iso: rowHoldExpires
    };
  }

  var rows = [];
  Object.keys(byHash).forEach(function(hash) {
    rows.push(byHash[hash]);
  });
  return rows;
}

function getLatestReservationByHash_(sheet, hash) {
  var values = sheet.getDataRange().getValues();
  if (values.length <= 1) return null;

  var headers = values[0].map(function(v) { return normalizeHeader_(v); });
  var idxHash = headers.indexOf('reservation_hash');
  if (idxHash < 0) return null;

  var idxAgent = headers.indexOf('agent_name');
  var idxDate = headers.indexOf('date');
  var idxTime = headers.indexOf('time');
  var idxStatus = headers.indexOf('status');
  var idxHoldToken = headers.indexOf('hold_token');
  var idxHoldExpires = headers.indexOf('hold_expires_at_iso');

  var latest = null;
  for (var i = 1; i < values.length; i += 1) {
    var row = values[i];
    if (String(row[idxHash] || '').trim() !== hash) continue;

    latest = {
      reservation_hash: String(row[idxHash] || '').trim(),
      agent_name: idxAgent >= 0 ? String(row[idxAgent] || '').trim() : '',
      date: idxDate >= 0 ? String(row[idxDate] || '').trim() : '',
      time: idxTime >= 0 ? String(row[idxTime] || '').trim() : '',
      status: idxStatus >= 0 ? String(row[idxStatus] || '').trim() : '',
      hold_token: idxHoldToken >= 0 ? String(row[idxHoldToken] || '').trim() : '',
      hold_expires_at_iso: idxHoldExpires >= 0 ? String(row[idxHoldExpires] || '').trim() : ''
    };
  }

  return latest;
}

function appendReservationEvent_(sheet, obj) {
  appendObjectRow_(sheet, obj);
}

function isBlockingReservation_(reservation, now) {
  var status = normalizeReservationStatus_(reservation.status);
  if (status === RESERVATION_STATUS.BOOKED) return true;
  if (status === RESERVATION_STATUS.HOLDING && !isHoldExpired_(reservation, now)) return true;
  return false;
}

function isHoldExpired_(reservation, now) {
  var status = normalizeReservationStatus_(reservation.status);
  if (status !== RESERVATION_STATUS.HOLDING) return false;
  var expiresIso = String(reservation.hold_expires_at_iso || '').trim();
  if (!expiresIso) return true;
  var expires = new Date(expiresIso);
  if (String(expires) === 'Invalid Date') return true;
  return expires.getTime() <= now.getTime();
}

function normalizeReservationStatus_(status) {
  return String(status || '').trim().toLowerCase();
}

function appendObjectRow_(sheet, obj) {
  var keys = Object.keys(obj);
  if (!keys.length) return;

  var headers = [];
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  if (lastRow > 0 && lastCol > 0) {
    headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
      .map(function(v) { return String(v || '').trim(); });
  }

  keys.forEach(function(key) {
    if (headers.indexOf(key) < 0) headers.push(key);
  });

  if (headers.length > 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  var row = headers.map(function(header) { return toCellValue_(obj[header]); });
  sheet.appendRow(row);
}

function appendObjectRowWithFirstHeader_(sheet, obj, firstHeader) {
  var keys = Object.keys(obj);
  if (!keys.length) return;

  var headers = [];
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  if (lastRow > 0 && lastCol > 0) {
    headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
      .map(function(v) { return String(v || '').trim(); });
  }

  keys.forEach(function(key) {
    if (headers.indexOf(key) < 0) headers.push(key);
  });

  if (firstHeader) {
    headers = headers.filter(function(h) { return h !== firstHeader; });
    headers.unshift(firstHeader);
  }

  if (headers.length > 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  var row = headers.map(function(header) { return toCellValue_(obj[header]); });
  sheet.appendRow(row);
}

function localizeApplicantData_(obj) {
  var localized = {};
  Object.keys(obj || {}).forEach(function(key) {
    var label = toApplicantsLabel_(key);
    localized[label] = obj[key];
  });

  if (!localized['完了時間']) {
    localized['完了時間'] = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd/ HH:mm');
  }
  return localized;
}

function getApplicantsLabelMap_() {
  return {
    completed_at_jst: '完了時間',
    completed_at_iso: '完了時間ISO',
    received_at_iso: '受信時間ISO',
    reserved: '予約済み',
    reserved_at: '予約送信時刻ISO',
    selected_agents: '選択エージェント',
    reservation_count: '予約件数',
    reservation_details: '予約詳細',
    answers_json: '回答JSON',
    hold_token: '仮予約トークン',
    hold_expires_at_iso: '仮予約期限ISO',
    reservation_hash: '予約ハッシュ',
    name: '氏名',
    tel: '電話番号',
    email: 'メールアドレス',
    age: '年齢',
    gender: '性別',
    employment_status: '現在の就業状況',
    living_region: '居住エリア',
    living_prefecture: '都道府県',
    final_education: '最終学歴',
    university_tier: '出身大学区分',
    company_count: '在籍企業数',
    fulltime_exp_years: '正社員経験年数',
    recent_job: '直近の職種',
    management_exp: 'マネジメント経験',
    new_env_style: '新環境での行動傾向',
    motivation_type: 'やりがいタイプ',
    strength_type: '得意領域',
    pressure_tolerance: 'プレッシャー耐性',
    work_style: '仕事の進め方',
    competition_preference: '競争志向',
    fit_working_style: '向いている働き方',
    learning_attitude: '学習姿勢',
    priority: '転職で重視するもの',
    evaluation_preference: '評価制度の希望',
    overtime_preference: '残業許容度',
    relocation: '転勤可否',
    company_environment: '希望企業環境',
    future_goal: '将来像',
    interest_jobs: '興味職種',
    interest_industries: '興味業界',
    challenge_unexperienced: '未経験挑戦意欲',
    when_change: '転職希望時期',
    desired_income_level: '希望年収水準',
    consult_request: 'キャリア相談希望'
  };
}

function toApplicantsLabel_(key) {
  var raw = String(key || '').trim();
  if (!raw) return '';

  var map = getApplicantsLabelMap_();
  if (map[raw]) return map[raw];

  var normalized = normalizeHeader_(raw);
  if (map[normalized]) return map[normalized];

  return raw;
}

function migrateApplicantsHeadersToJapanese_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return;

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function(v) { return String(v || '').trim(); });

  var seen = {};
  var converted = [];
  headers.forEach(function(header) {
    var label = toApplicantsLabel_(header);
    if (!label) return;
    if (seen[label]) return;
    seen[label] = true;
    converted.push(label);
  });

  if (!converted.length) return;

  if (converted[0] !== '完了時間') {
    converted = converted.filter(function(h) { return h !== '完了時間'; });
    converted.unshift('完了時間');
  }

  sheet.getRange(1, 1, 1, converted.length).setValues([converted]);
}

function toCellValue_(value) {
  if (value === null || value === undefined) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function getSheet_(name) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name);
  return sheet;
}

function getOrCreateSheet_(name) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function normalizeHeader_(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function pickString_(obj, keys, fallback) {
  for (var i = 0; i < keys.length; i += 1) {
    var key = keys[i];
    if (obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== '') {
      return String(obj[key]).trim();
    }
    var normalized = normalizeHeader_(key);
    if (obj[normalized] !== undefined && obj[normalized] !== null && String(obj[normalized]).trim() !== '') {
      return String(obj[normalized]).trim();
    }
  }
  return fallback || '';
}

function pickMulti_(obj, keys) {
  var raw = pickString_(obj, keys, '');
  return splitMulti_(raw);
}

function splitMulti_(value) {
  if (Array.isArray(value)) {
    return value
      .map(function(v) { return String(v || '').trim(); })
      .filter(function(v) { return v; });
  }

  return String(value || '')
    .split(/[,\n、\/|]/)
    .map(function(v) { return String(v || '').trim(); })
    .filter(function(v) { return v; });
}

function matchAny_(targets, values) {
  if (!targets.length || !values.length) return false;
  for (var i = 0; i < values.length; i += 1) {
    var value = values[i];
    if (!value) continue;
    for (var j = 0; j < targets.length; j += 1) {
      var target = targets[j];
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
  var wideKeywords = [
    '全国',
    '全国対応',
    '全エリア',
    'all',
    'any',
    'all regions',
    'all areas'
  ];
  for (var i = 0; i < values.length; i += 1) {
    var v = String(values[i] || '').toLowerCase();
    if (!v) continue;
    for (var j = 0; j < wideKeywords.length; j += 1) {
      var keyword = String(wideKeywords[j]).toLowerCase();
      if (v === keyword || v.indexOf(keyword) >= 0) return true;
    }
  }
  return false;
}

function findHeaderIndex_(headers, candidates) {
  if (!headers || !headers.length) return -1;
  var normalizedHeaders = headers.map(function(h) { return normalizeHeader_(h); });
  for (var i = 0; i < candidates.length; i += 1) {
    var c = normalizeHeader_(candidates[i]);
    var idx = normalizedHeaders.indexOf(c);
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseAgeNumber_(ageText) {
  var m = String(ageText || '').match(/\d+/);
  return m ? parseInt(m[0], 10) : NaN;
}

function buildReservationHash_(agentName, date, time) {
  return [agentName, date, time]
    .map(function(v) { return String(v || '').trim(); })
    .join('|');
}
