var SPREADSHEET_ID = '14QAijJ_rHXxK7Kbr6704lZ2iku4VJu_ouuv5J3Ifc08';
var AGENTS_SHEET_NAME = 'agents';
var APPLICANTS_SHEET_NAME = 'applicants';
var RESERVATIONS_SHEET_NAME = 'reservations';
var DEFAULT_TOP_AGENT_COUNT = 3;
var HOLD_TTL_MINUTES = 10;
var MONTHLY_INTERVIEW_LIMIT_PER_AGENT = 14;
var COMPANY_SHEET_NAME_PREFIX = 'company_reservations_';

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
    if (action === 'get_company_reservations') {
      return jsonOutput_(handleGetCompanyReservations_(payload));
    }

    return jsonOutput_({
      ok: false,
      error: 'Unsupported action. Use diagnose, reserve, get_availability, reserve_slot, update_reservation_status, or get_company_reservations.'
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

  var applicantInfo = {
    name: String(payload.name || payload.applicant_name || '').trim(),
    tel: String(payload.tel || payload.phone || payload.applicant_tel || '').trim(),
    email: String(payload.email || payload.mail || payload.applicant_email || '').trim()
  };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  var now = new Date();
  var finalizeResult;
  try {
    finalizeResult = finalizeReservationDetails_(details, now, applicantInfo);
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
    row: appSheet.getLastRow(),
    reservation_results: finalizeResult.results || [],
    calendar_sync: finalizeResult.calendar_sync || []
  };
}

function handleGetCompanyReservations_(payload) {
  var agentName = String(payload.agent_name || '').trim();
  if (!agentName) return { ok: false, error: 'agent_name is required' };

  var token = String(payload.company_token || payload.token || '').trim();
  var auth = validateCompanyAccess_(agentName, token);
  if (!auth.ok) return auth;

  var records = listCompanyReservations_(agentName);
  var statusFilter = normalizeReservationStatus_(payload.status || 'booked');
  var filtered = records.filter(function(r) {
    if (!statusFilter || statusFilter === 'all') return true;
    return normalizeReservationStatus_(r.status) === statusFilter;
  });

  filtered.sort(function(a, b) {
    var aKey = [a.date || '', a.time || ''].join(' ');
    var bKey = [b.date || '', b.time || ''].join(' ');
    if (aKey === bKey) return 0;
    return aKey < bKey ? -1 : 1;
  });

  return {
    ok: true,
    agent_name: agentName,
    monthly_limit: MONTHLY_INTERVIEW_LIMIT_PER_AGENT,
    reservations: filtered
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
  var reservationSheet = getOrCreateSheet_(RESERVATIONS_SHEET_NAME);

  var now = new Date();
  var startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var reservations = loadReservationsForAgent_(agentName, startDate, days);

  var takenByDate = {};
  reservations.forEach(function(r) {
    if (!isBlockingReservation_(r, now)) return;
    if (!takenByDate[r.date]) takenByDate[r.date] = {};
    takenByDate[r.date][r.time] = true;
  });

  var calendarTakenByDate = getCalendarBusySlotsForAgent_(agentName, startDate, days, baseSlots);
  Object.keys(calendarTakenByDate).forEach(function(dateKey) {
    if (!takenByDate[dateKey]) takenByDate[dateKey] = {};
    var slots = calendarTakenByDate[dateKey];
    Object.keys(slots).forEach(function(slot) {
      takenByDate[dateKey][slot] = true;
    });
  });

  var monthKeys = {};
  for (var mk = 0; mk < days; mk += 1) {
    var mDate = new Date(startDate);
    mDate.setDate(startDate.getDate() + mk);
    var mDateStr = Utilities.formatDate(mDate, 'Asia/Tokyo', 'yyyy-MM-dd');
    monthKeys[mDateStr.slice(0, 7)] = true;
  }
  var bookedByMonth = countBookedReservationsForAgentMonths_(
    reservationSheet,
    agentName,
    Object.keys(monthKeys)
  );

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

    var monthKey = dateStr.slice(0, 7);
    if ((bookedByMonth[monthKey] || 0) >= MONTHLY_INTERVIEW_LIMIT_PER_AGENT) {
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
    slot_candidates: baseSlots,
    monthly_limit: MONTHLY_INTERVIEW_LIMIT_PER_AGENT,
    booked_count_by_month: bookedByMonth
  };
}

function handleReserveSlot_(payload) {
  var agentName = String(payload.agent_name || '').trim();
  var date = normalizeReservationDate_(payload.date);
  var time = normalizeReservationTimeSlot_(payload.time);
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
    var latestRowNumber = latest ? latest._rowNumber : 0;
    var monthKey = date.slice(0, 7);
    var monthBooked = countBookedReservationsForAgentMonths_(sheet, agentName, [monthKey]);

    if ((monthBooked[monthKey] || 0) >= MONTHLY_INTERVIEW_LIMIT_PER_AGENT) {
      return {
        ok: false,
        conflict: true,
        error: 'この会社の当月面談枠（14件）は上限に達しています。'
      };
    }

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
            date: toReservationSheetDate_(date),
            time: time,
            status: RESERVATION_STATUS.HOLDING,
            hold_token: latestHoldToken,
            hold_expires_at_iso: renewedExpiry.toISOString(),
            updated_at_iso: now.toISOString(),
            updated_at_jst: formatJstMinute_(now)
          }, latestRowNumber);

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
      date: toReservationSheetDate_(date),
      time: time,
      status: RESERVATION_STATUS.HOLDING,
      hold_token: holdToken,
      hold_expires_at_iso: holdExpiry.toISOString(),
      booked_at_iso: '',
      booked_at_jst: '',
      updated_at_iso: now.toISOString(),
      updated_at_jst: formatJstMinute_(now)
    }, latestRowNumber);

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
    var date = normalizeReservationDate_(payload.date);
    var time = normalizeReservationTimeSlot_(payload.time);
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
    if (status === RESERVATION_STATUS.BOOKED) {
      var monthKey = (latest.date || '').slice(0, 7);
      var bookedByMonth = countBookedReservationsForAgentMonths_(sheet, latest.agent_name, [monthKey]);
      if ((bookedByMonth[monthKey] || 0) >= MONTHLY_INTERVIEW_LIMIT_PER_AGENT) {
        return { ok: false, error: 'この会社の当月面談枠（14件）は上限に達しています。' };
      }
    }

    var rowNumber = appendReservationEvent_(sheet, {
      reservation_hash: hash,
      agent_name: latest.agent_name,
      date: toReservationSheetDate_(latest.date),
      time: latest.time,
      status: status,
      hold_token: '',
      hold_expires_at_iso: '',
      booked_at_iso: status === RESERVATION_STATUS.BOOKED ? now.toISOString() : String(latest.booked_at_iso || '').trim(),
      booked_at_jst: status === RESERVATION_STATUS.BOOKED ? formatJstMinute_(now) : String(latest.booked_at_jst || '').trim(),
      updated_at_iso: now.toISOString(),
      updated_at_jst: formatJstMinute_(now),
      applicant_name: String(latest.applicant_name || '').trim(),
      applicant_tel: String(latest.applicant_tel || '').trim(),
      applicant_email: String(latest.applicant_email || '').trim(),
      calendar_id: String(latest.calendar_id || '').trim(),
      calendar_event_id: String(latest.calendar_event_id || '').trim(),
      calendar_event_url: String(latest.calendar_event_url || '').trim()
    }, latest._rowNumber);

    syncCalendarAndCompanyByReservationHash_(sheet, hash, rowNumber, status, now);
    return { ok: true, reservation_hash: hash, status: status };
  } finally {
    lock.releaseLock();
  }
}

function finalizeReservationDetails_(details, now, applicantInfo) {
  var sheet = getOrCreateSheet_(RESERVATIONS_SHEET_NAME);
  var results = [];
  var calendarSync = [];
  var monthlyBookedCache = {};

  for (var i = 0; i < details.length; i += 1) {
    var detail = details[i];
    var agentName = String(detail.agent_name || '').trim();
    var date = normalizeReservationDate_(detail.date);
    var time = normalizeReservationTimeSlot_(detail.time);
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

    var monthKey = date.slice(0, 7);
    var cacheKey = agentName + '|' + monthKey;
    if (monthlyBookedCache[cacheKey] === undefined) {
      var monthBooked = countBookedReservationsForAgentMonths_(sheet, agentName, [monthKey]);
      monthlyBookedCache[cacheKey] = monthBooked[monthKey] || 0;
    }
    if (monthlyBookedCache[cacheKey] >= MONTHLY_INTERVIEW_LIMIT_PER_AGENT) {
      return { ok: false, error: 'この会社の当月面談枠（14件）は上限に達しています。' };
    }

    var rowNumber = appendReservationEvent_(sheet, {
      reservation_hash: hash,
      agent_name: latest.agent_name,
      date: toReservationSheetDate_(latest.date),
      time: latest.time,
      status: RESERVATION_STATUS.BOOKED,
      hold_token: latestHoldToken,
      hold_expires_at_iso: latest.hold_expires_at_iso || '',
      booked_at_iso: now.toISOString(),
      booked_at_jst: formatJstMinute_(now),
      updated_at_iso: now.toISOString(),
      updated_at_jst: formatJstMinute_(now),
      applicant_name: applicantInfo && applicantInfo.name ? applicantInfo.name : '',
      applicant_tel: applicantInfo && applicantInfo.tel ? applicantInfo.tel : '',
      applicant_email: applicantInfo && applicantInfo.email ? applicantInfo.email : ''
    }, latest._rowNumber);
    monthlyBookedCache[cacheKey] += 1;

    var synced = syncCalendarAndCompanyByReservationHash_(sheet, hash, rowNumber, RESERVATION_STATUS.BOOKED, now);
    calendarSync.push(synced);

    results.push({ reservation_hash: hash, status: RESERVATION_STATUS.BOOKED });
  }

  return { ok: true, results: results, calendar_sync: calendarSync };
}

function validateCompanyAccess_(agentName, token) {
  var config = getAgentConfigByName_(agentName);
  if (!config) return { ok: false, error: 'agent not found' };

  var requiredToken = pickString_(config, [
    'company_token',
    'access_token',
    'reservation_token',
    'api_token',
    '企業トークン',
    '閲覧トークン'
  ], '');
  if (!requiredToken) {
    return { ok: false, error: 'company token is not configured for this agent' };
  }
  if (requiredToken !== String(token || '').trim()) {
    return { ok: false, error: 'invalid company token' };
  }
  return { ok: true };
}

function getAgentConfigByName_(agentName) {
  if (!agentName) return null;
  var ctx = loadAgents_();
  for (var i = 0; i < ctx.agents.length; i += 1) {
    var agent = ctx.agents[i];
    var name = pickString_(agent, ['name', 'agent', 'agent_name', '会社名', 'エージェント名'], '');
    if (name === agentName) return agent;
  }
  return null;
}

function resolveAgentCalendarId_(agentName) {
  var config = getAgentConfigByName_(agentName);
  if (!config) return '';
  return pickString_(config, [
    'calendar_id',
    'calendarid',
    'google_calendar_id',
    'interviewer_calendar_id',
    '担当カレンダーid',
    '担当者カレンダーid',
    'カレンダーid',
    'カレンダーID'
  ], '');
}

function getCompanyReservationsSheet_(agentName) {
  var config = getAgentConfigByName_(agentName) || {};
  var spreadsheetId = pickString_(config, [
    'company_reservations_spreadsheet_id',
    'reservation_spreadsheet_id',
    'company_sheet_spreadsheet_id',
    '企業予約スプレッドシートid',
    '企業予約スプレッドシートID'
  ], '');
  var preferredSheetName = pickString_(config, [
    'company_reservations_sheet_name',
    'reservation_sheet_name',
    'company_sheet_name',
    '企業予約シート名'
  ], '');
  var sheetName = preferredSheetName || buildCompanyReservationsSheetName_(agentName);

  var ss = spreadsheetId
    ? SpreadsheetApp.openById(spreadsheetId)
    : SpreadsheetApp.openById(SPREADSHEET_ID);
  return ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
}

function buildCompanyReservationsSheetName_(agentName) {
  var safe = String(agentName || '').trim();
  if (!safe) safe = 'default';
  safe = safe.replace(/[\[\]\:\*\?\/\\]/g, '_').replace(/\s+/g, '_');
  return (COMPANY_SHEET_NAME_PREFIX + safe).slice(0, 90);
}

function ensureCompanyReservationsHeaders_(sheet) {
  var headers = [
    '予約ハッシュ',
    'エージェント名',
    '予約日',
    '予約時間枠',
    '予約ステータス',
    '求職者名',
    '電話番号',
    'メールアドレス',
    '確定時間',
    '更新時間',
    'カレンダーイベントURL'
  ];
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow >= 1 && lastCol >= headers.length) return headers;
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return headers;
}

function upsertCompanyReservationFromLatest_(latest) {
  if (!latest || !latest.agent_name) return { ok: false, error: 'latest reservation is required' };

  var sheet = getCompanyReservationsSheet_(latest.agent_name);
  var headers = ensureCompanyReservationsHeaders_(sheet);
  var idxHash = headers.indexOf('予約ハッシュ');
  var idxDate = headers.indexOf('予約日');
  var idxTime = headers.indexOf('予約時間枠');
  var idxStatus = headers.indexOf('予約ステータス');
  var idxName = headers.indexOf('求職者名');
  var idxTel = headers.indexOf('電話番号');
  var idxEmail = headers.indexOf('メールアドレス');
  var idxBooked = headers.indexOf('確定時間');
  var idxUpdated = headers.indexOf('更新時間');
  var idxUrl = headers.indexOf('カレンダーイベントURL');
  var idxAgent = headers.indexOf('エージェント名');

  var row = [];
  for (var i = 0; i < headers.length; i += 1) row.push('');
  row[idxHash] = latest.reservation_hash || '';
  row[idxAgent] = latest.agent_name || '';
  row[idxDate] = toReservationSheetDate_(latest.date || '');
  row[idxTime] = normalizeReservationTimeSlot_(latest.time || '');
  row[idxStatus] = normalizeReservationStatus_(latest.status || '');
  row[idxName] = String(latest.applicant_name || '').trim();
  row[idxTel] = String(latest.applicant_tel || '').trim();
  row[idxEmail] = String(latest.applicant_email || '').trim();
  row[idxBooked] = String(latest.booked_at_jst || '').trim();
  row[idxUpdated] = String(latest.updated_at_jst || '').trim() || formatJstMinute_(new Date());
  row[idxUrl] = String(latest.calendar_event_url || '').trim();

  var hash = String(latest.reservation_hash || '').trim();
  if (!hash) {
    sheet.appendRow(row);
    return { ok: true, row: sheet.getLastRow() };
  }

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    sheet.appendRow(row);
    return { ok: true, row: sheet.getLastRow() };
  }

  var hashRange = sheet.getRange(2, idxHash + 1, lastRow - 1, 1);
  var finder = hashRange.createTextFinder(hash).matchEntireCell(true);
  var found = finder.findNext();
  if (found) {
    sheet.getRange(found.getRow(), 1, 1, headers.length).setValues([row]);
    return { ok: true, row: found.getRow() };
  }

  sheet.appendRow(row);
  return { ok: true, row: sheet.getLastRow() };
}

function listCompanyReservations_(agentName) {
  var sheet = getCompanyReservationsSheet_(agentName);
  var headers = ensureCompanyReservationsHeaders_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var idxHash = headers.indexOf('予約ハッシュ');
  var idxDate = headers.indexOf('予約日');
  var idxTime = headers.indexOf('予約時間枠');
  var idxStatus = headers.indexOf('予約ステータス');
  var idxName = headers.indexOf('求職者名');
  var idxTel = headers.indexOf('電話番号');
  var idxEmail = headers.indexOf('メールアドレス');
  var idxBooked = headers.indexOf('確定時間');
  var idxUpdated = headers.indexOf('更新時間');
  var idxUrl = headers.indexOf('カレンダーイベントURL');

  var rows = [];
  for (var i = 0; i < values.length; i += 1) {
    var row = values[i];
    if (!String(row[idxHash] || '').trim()) continue;
    rows.push({
      reservation_hash: String(row[idxHash] || '').trim(),
      date: normalizeReservationDate_(row[idxDate]) || String(row[idxDate] || '').trim(),
      time: normalizeReservationTimeSlot_(row[idxTime]),
      status: normalizeReservationStatus_(row[idxStatus]),
      applicant_name: String(row[idxName] || '').trim(),
      applicant_tel: String(row[idxTel] || '').trim(),
      applicant_email: String(row[idxEmail] || '').trim(),
      booked_at_jst: String(row[idxBooked] || '').trim(),
      updated_at_jst: String(row[idxUpdated] || '').trim(),
      calendar_event_url: String(row[idxUrl] || '').trim()
    });
  }
  return rows;
}

function countBookedReservationsForAgentMonths_(sheet, agentName, monthKeys) {
  var counts = {};
  (monthKeys || []).forEach(function(m) { counts[m] = 0; });
  if (!monthKeys || !monthKeys.length || !agentName) return counts;

  ensureReservationHeaders_(sheet);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow <= 1 || lastCol <= 0) return counts;

  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function(v) { return String(v || '').trim(); });
  var idx = getReservationHeaderIndexes_(headers);
  if (idx.agent < 0 || idx.date < 0 || idx.status < 0) return counts;

  var targetMonths = {};
  monthKeys.forEach(function(m) { targetMonths[m] = true; });
  var byHash = {};
  for (var i = 1; i < values.length; i += 1) {
    var row = values[i];
    var rowAgent = String(row[idx.agent] || '').trim();
    if (rowAgent !== agentName) continue;

    var rowDate = normalizeReservationDate_(row[idx.date]);
    if (!rowDate) continue;
    var monthKey = rowDate.slice(0, 7);
    if (!targetMonths[monthKey]) continue;

    var rowHash = idx.hash >= 0 ? String(row[idx.hash] || '').trim() : '';
    if (!rowHash && idx.time >= 0) {
      rowHash = buildReservationHash_(rowAgent, rowDate, row[idx.time]);
    }
    if (!rowHash) rowHash = 'row_' + i;

    byHash[rowHash] = {
      status: normalizeReservationStatus_(row[idx.status]),
      month: monthKey
    };
  }

  Object.keys(byHash).forEach(function(hash) {
    var item = byHash[hash];
    if (item.status === RESERVATION_STATUS.BOOKED) {
      counts[item.month] = (counts[item.month] || 0) + 1;
    }
  });
  return counts;
}

function parseTimeSlotRange_(dateStr, slot) {
  var normalizedDate = normalizeReservationDate_(dateStr);
  var normalizedSlot = normalizeReservationTimeSlot_(slot);
  var m = normalizedSlot.match(/^(\d{2}):(\d{2})～(\d{2}):(\d{2})$/);
  if (!normalizedDate || !m) return null;

  var d = normalizedDate.split('-');
  var y = parseInt(d[0], 10);
  var mo = parseInt(d[1], 10) - 1;
  var day = parseInt(d[2], 10);
  var start = new Date(y, mo, day, parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
  var end = new Date(y, mo, day, parseInt(m[3], 10), parseInt(m[4], 10), 0, 0);
  if (end.getTime() <= start.getTime()) return null;
  return { start: start, end: end };
}

function rangesOverlap_(startA, endA, startB, endB) {
  if (!startA || !endA || !startB || !endB) return false;
  return startA.getTime() < endB.getTime() && startB.getTime() < endA.getTime();
}

function getCalendarBusySlotsForAgent_(agentName, startDate, days, slots) {
  var calendarId = resolveAgentCalendarId_(agentName);
  if (!calendarId) return {};

  var calendar = CalendarApp.getCalendarById(calendarId);
  if (!calendar) return {};

  var start = new Date(startDate);
  var end = new Date(startDate);
  end.setDate(startDate.getDate() + days);
  var events = calendar.getEvents(start, end);
  if (!events.length) return {};

  var busy = {};
  for (var i = 0; i < days; i += 1) {
    var current = new Date(startDate);
    current.setDate(startDate.getDate() + i);
    var dateStr = Utilities.formatDate(current, 'Asia/Tokyo', 'yyyy-MM-dd');
    var busySlots = {};
    for (var j = 0; j < slots.length; j += 1) {
      var slot = normalizeReservationTimeSlot_(slots[j]);
      var slotRange = parseTimeSlotRange_(dateStr, slot);
      if (!slotRange) continue;
      for (var k = 0; k < events.length; k += 1) {
        var event = events[k];
        if (rangesOverlap_(slotRange.start, slotRange.end, event.getStartTime(), event.getEndTime())) {
          busySlots[slot] = true;
          break;
        }
      }
    }
    if (Object.keys(busySlots).length) busy[dateStr] = busySlots;
  }
  return busy;
}

function syncReservationCalendar_(sheet, latest, nextStatus, rowNumber, now) {
  var status = normalizeReservationStatus_(nextStatus || latest.status);
  var calendarId = String(latest.calendar_id || '').trim() || resolveAgentCalendarId_(latest.agent_name);
  var existingEventId = String(latest.calendar_event_id || '').trim();
  var targetRow = rowNumber || latest._rowNumber;

  if (!calendarId) {
    return { ok: false, skipped: true, reason: 'calendar_id is not configured' };
  }

  var calendar = CalendarApp.getCalendarById(calendarId);
  if (!calendar) {
    return { ok: false, skipped: true, reason: 'calendar not found: ' + calendarId };
  }

  if (status === RESERVATION_STATUS.CANCELED && existingEventId) {
    try {
      var targetEvent = calendar.getEventById(existingEventId);
      if (targetEvent) targetEvent.deleteEvent();
    } catch (cancelErr) {
      // Continue and clear linkage fields anyway.
    }
    appendReservationEvent_(sheet, {
      reservation_hash: latest.reservation_hash,
      agent_name: latest.agent_name,
      date: latest.date,
      time: latest.time,
      status: status,
      calendar_id: calendarId,
      calendar_event_id: '',
      calendar_event_url: '',
      updated_at_iso: now.toISOString(),
      updated_at_jst: formatJstMinute_(now)
    }, targetRow);
    return { ok: true, deleted: true };
  }

  if (status !== RESERVATION_STATUS.BOOKED) {
    return { ok: true, skipped: true, reason: 'status is not booked' };
  }
  if (existingEventId) {
    return { ok: true, skipped: true, reason: 'event already linked', event_id: existingEventId };
  }

  var range = parseTimeSlotRange_(latest.date, latest.time);
  if (!range) return { ok: false, skipped: true, reason: 'invalid date/time slot' };

  var applicantName = String(latest.applicant_name || '').trim() || '求職者';
  var title = '【面談予約】' + applicantName + ' 様';
  var lines = [
    '予約ハッシュ: ' + String(latest.reservation_hash || ''),
    'エージェント: ' + String(latest.agent_name || ''),
    '氏名: ' + applicantName,
    '電話番号: ' + String(latest.applicant_tel || '').trim(),
    'メール: ' + String(latest.applicant_email || '').trim()
  ];
  var event = calendar.createEvent(title, range.start, range.end, {
    description: lines.join('\n')
  });
  appendReservationEvent_(sheet, {
    reservation_hash: latest.reservation_hash,
    agent_name: latest.agent_name,
    date: latest.date,
    time: latest.time,
    status: status,
    calendar_id: calendarId,
    calendar_event_id: event.getId(),
    calendar_event_url: event.getHtmlLink(),
    updated_at_iso: now.toISOString(),
    updated_at_jst: formatJstMinute_(now)
  }, targetRow);
  return {
    ok: true,
    event_id: event.getId(),
    event_url: event.getHtmlLink(),
    calendar_id: calendarId
  };
}

function syncCalendarAndCompanyByReservationHash_(sheet, hash, rowNumber, nextStatus, now) {
  var latest = getLatestReservationByHash_(sheet, hash);
  if (!latest) {
    return { ok: false, reservation_hash: hash, error: 'reservation not found after update' };
  }

  var calendarSync = syncReservationCalendar_(sheet, latest, nextStatus, rowNumber, now);
  var newest = getLatestReservationByHash_(sheet, hash) || latest;
  var companySync = upsertCompanyReservationFromLatest_(newest);

  return {
    ok: true,
    reservation_hash: hash,
    calendar: calendarSync,
    company: companySync
  };
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
  if (agentSlots.length) return normalizeReservationSlotCandidates_(agentSlots);
  if (payloadSlots && payloadSlots.length) return normalizeReservationSlotCandidates_(payloadSlots);
  return normalizeReservationSlotCandidates_(DEFAULT_TIME_SLOTS.slice());
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
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow <= 1 || lastCol <= 0) return [];

  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  if (values.length <= 1) return [];

  var headers = values[0].map(function(v) { return String(v || '').trim(); });
  var idx = getReservationHeaderIndexes_(headers);
  if (idx.hash < 0 || idx.agent < 0 || idx.date < 0 || idx.time < 0 || idx.status < 0) {
    return [];
  }

  var startStr = Utilities.formatDate(startDate, 'Asia/Tokyo', 'yyyy-MM-dd');
  var end = new Date(startDate);
  end.setDate(startDate.getDate() + days - 1);
  var endStr = Utilities.formatDate(end, 'Asia/Tokyo', 'yyyy-MM-dd');

  var byHash = {};
  for (var i = 1; i < values.length; i += 1) {
    var row = values[i];
    var rowHash = String(row[idx.hash] || '').trim();
    var rowAgent = String(row[idx.agent] || '').trim();
    var rowDate = String(row[idx.date] || '').trim();
    var rowDateNormalized = normalizeReservationDate_(rowDate);
    var rowTime = normalizeReservationTimeSlot_(row[idx.time]);
    var rowStatus = String(row[idx.status] || '').trim();
    var rowHoldExpires = idx.holdExpires >= 0 ? String(row[idx.holdExpires] || '').trim() : '';
    var effectiveHash = rowHash || buildReservationHash_(rowAgent, rowDateNormalized, rowTime);

    if (!effectiveHash || !rowAgent || !rowDateNormalized || !rowTime) continue;
    if (rowAgent !== agentName) continue;
    if (rowDateNormalized < startStr || rowDateNormalized > endStr) continue;

    byHash[effectiveHash] = {
      reservation_hash: effectiveHash,
      agent_name: rowAgent,
      date: rowDateNormalized,
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
  ensureReservationHeaders_(sheet);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow <= 1 || lastCol <= 0) return null;

  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function(v) { return String(v || '').trim(); });
  var idx = getReservationHeaderIndexes_(headers);
  if (idx.hash < 0) return null;
  var parsedHash = parseReservationHash_(hash);
  var normalizedHash = String(hash || '').trim();

  var latest = null;
  for (var i = 1; i < values.length; i += 1) {
    var row = values[i];
    var rowHash = String(row[idx.hash] || '').trim();
    var matched = rowHash === normalizedHash;
    if (!matched && parsedHash && idx.agent >= 0 && idx.date >= 0 && idx.time >= 0) {
      var rowAgent = String(row[idx.agent] || '').trim();
      var rowDate = normalizeReservationDate_(row[idx.date]);
      var rowTime = normalizeReservationTimeSlot_(row[idx.time]);
      matched = rowAgent === parsedHash.agent_name &&
        rowDate === parsedHash.date &&
        rowTime === parsedHash.time;
    }
    if (!matched) continue;

    latest = {
      _rowNumber: i + 1,
      reservation_hash: rowHash,
      agent_name: idx.agent >= 0 ? String(row[idx.agent] || '').trim() : '',
      date: idx.date >= 0 ? normalizeReservationDate_(row[idx.date]) : '',
      time: idx.time >= 0 ? normalizeReservationTimeSlot_(row[idx.time]) : '',
      status: idx.status >= 0 ? String(row[idx.status] || '').trim() : '',
      hold_token: idx.holdToken >= 0 ? String(row[idx.holdToken] || '').trim() : '',
      hold_expires_at_iso: idx.holdExpires >= 0 ? String(row[idx.holdExpires] || '').trim() : '',
      booked_at_iso: idx.bookedIso >= 0 ? String(row[idx.bookedIso] || '').trim() : '',
      booked_at_jst: idx.bookedJst >= 0 ? String(row[idx.bookedJst] || '').trim() : '',
      updated_at_iso: idx.updatedIso >= 0 ? String(row[idx.updatedIso] || '').trim() : '',
      updated_at_jst: idx.updatedJst >= 0 ? String(row[idx.updatedJst] || '').trim() : '',
      applicant_name: idx.applicantName >= 0 ? String(row[idx.applicantName] || '').trim() : '',
      applicant_tel: idx.applicantTel >= 0 ? String(row[idx.applicantTel] || '').trim() : '',
      applicant_email: idx.applicantEmail >= 0 ? String(row[idx.applicantEmail] || '').trim() : '',
      calendar_id: idx.calendarId >= 0 ? String(row[idx.calendarId] || '').trim() : '',
      calendar_event_id: idx.calendarEventId >= 0 ? String(row[idx.calendarEventId] || '').trim() : '',
      calendar_event_url: idx.calendarEventUrl >= 0 ? String(row[idx.calendarEventUrl] || '').trim() : ''
    };
  }

  return latest;
}

function appendReservationEvent_(sheet, obj, rowNumber) {
  var headers = ensureReservationHeaders_(sheet);
  var localized = localizeReservationData_(obj);
  var changed = false;
  Object.keys(localized).forEach(function(key) {
    if (headers.indexOf(key) < 0) {
      headers.push(key);
      changed = true;
    }
  });

  if (changed) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  var row = [];
  var targetRow = parseInt(rowNumber || 0, 10);
  var canUpdate = !isNaN(targetRow) && targetRow > 1 && targetRow <= sheet.getLastRow();
  if (canUpdate) {
    row = sheet.getRange(targetRow, 1, 1, headers.length).getValues()[0];
    while (row.length < headers.length) row.push('');
  } else {
    for (var i = 0; i < headers.length; i += 1) row.push('');
  }

  Object.keys(localized).forEach(function(key) {
    var idx = headers.indexOf(key);
    if (idx >= 0) row[idx] = toCellValue_(localized[key]);
  });

  if (canUpdate) {
    sheet.getRange(targetRow, 1, 1, headers.length).setValues([row]);
    return targetRow;
  }

  sheet.appendRow(row);
  return sheet.getLastRow();
}

function ensureReservationHeaders_(sheet) {
  migrateReservationsHeadersToJapanese_(sheet);

  var headers = [];
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow > 0 && lastCol > 0) {
    headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
      .map(function(v) { return String(v || '').trim(); })
      .filter(function(v) { return v; });
  }

  var required = [];
  var map = getReservationLabelMap_();
  Object.keys(map).forEach(function(key) {
    var label = map[key];
    if (required.indexOf(label) < 0) required.push(label);
  });

  required.forEach(function(header) {
    if (headers.indexOf(header) < 0) headers.push(header);
  });

  if (headers.indexOf('更新時間') < 0) {
    headers.unshift('更新時間');
  } else {
    headers = headers.filter(function(h) { return h !== '更新時間'; });
    headers.unshift('更新時間');
  }

  if (!headers.length) headers = ['更新時間'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  migrateReservationDatesToSlash_(sheet, headers);
  migrateReservationTimesToCanonical_(sheet, headers);
  return headers;
}

function migrateReservationDatesToSlash_(sheet, headers) {
  var idxDate = findHeaderIndex_(headers, ['date', '予約日']);
  if (idxDate < 0) return;

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  var range = sheet.getRange(2, idxDate + 1, lastRow - 1, 1);
  var values = range.getValues();
  var changed = false;

  for (var i = 0; i < values.length; i += 1) {
    var raw = String(values[i][0] || '').trim();
    if (!raw) continue;

    var formatted = toReservationSheetDate_(raw);
    if (formatted && formatted !== raw) {
      values[i][0] = formatted;
      changed = true;
    }
  }

  if (changed) {
    range.setValues(values);
  }
}

function migrateReservationTimesToCanonical_(sheet, headers) {
  var idxAgent = findHeaderIndex_(headers, ['agent_name', 'エージェント名']);
  var idxDate = findHeaderIndex_(headers, ['date', '予約日']);
  var idxTime = findHeaderIndex_(headers, ['time', '予約時間枠']);
  var idxHash = findHeaderIndex_(headers, ['reservation_hash', '予約ハッシュ']);
  if (idxTime < 0) return;

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  var range = sheet.getRange(2, 1, lastRow - 1, headers.length);
  var values = range.getValues();
  var changed = false;

  for (var i = 0; i < values.length; i += 1) {
    var row = values[i];
    var rawTime = String(row[idxTime] || '').trim();
    if (!rawTime) continue;

    var normalizedTime = normalizeReservationTimeSlot_(rawTime);
    if (normalizedTime && normalizedTime !== rawTime) {
      row[idxTime] = normalizedTime;
      changed = true;
    }

    if (idxHash >= 0 && idxAgent >= 0 && idxDate >= 0) {
      var agentName = String(row[idxAgent] || '').trim();
      var date = String(row[idxDate] || '').trim();
      if (agentName && date && row[idxTime]) {
        var normalizedHash = buildReservationHash_(agentName, date, row[idxTime]);
        if (normalizedHash && normalizedHash !== String(row[idxHash] || '').trim()) {
          row[idxHash] = normalizedHash;
          changed = true;
        }
      }
    }
  }

  if (changed) {
    range.setValues(values);
  }
}

function getReservationHeaderIndexes_(headers) {
  return {
    hash: findHeaderIndex_(headers, ['reservation_hash', '予約ハッシュ']),
    agent: findHeaderIndex_(headers, ['agent_name', 'エージェント名']),
    date: findHeaderIndex_(headers, ['date', '予約日']),
    time: findHeaderIndex_(headers, ['time', '予約時間枠']),
    status: findHeaderIndex_(headers, ['status', '予約ステータス']),
    holdToken: findHeaderIndex_(headers, ['hold_token', '仮予約トークン']),
    holdExpires: findHeaderIndex_(headers, ['hold_expires_at_iso', '仮予約期限ISO']),
    bookedIso: findHeaderIndex_(headers, ['booked_at_iso', '確定時間ISO']),
    bookedJst: findHeaderIndex_(headers, ['booked_at_jst', '確定時間']),
    updatedIso: findHeaderIndex_(headers, ['updated_at_iso', '更新時間ISO']),
    updatedJst: findHeaderIndex_(headers, ['updated_at_jst', '更新時間']),
    applicantName: findHeaderIndex_(headers, ['applicant_name', '予約者名']),
    applicantTel: findHeaderIndex_(headers, ['applicant_tel', '予約者電話番号']),
    applicantEmail: findHeaderIndex_(headers, ['applicant_email', '予約者メールアドレス']),
    calendarId: findHeaderIndex_(headers, ['calendar_id', '連携カレンダーID']),
    calendarEventId: findHeaderIndex_(headers, ['calendar_event_id', 'カレンダーイベントID']),
    calendarEventUrl: findHeaderIndex_(headers, ['calendar_event_url', 'カレンダーイベントURL'])
  };
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

function formatJstMinute_(date) {
  return Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy/MM/dd/ HH:mm');
}

function normalizeReservationDate_(value) {
  var raw = String(value || '').trim();
  if (!raw) return '';

  var direct = raw.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (direct) {
    return [
      direct[1],
      ('0' + parseInt(direct[2], 10)).slice(-2),
      ('0' + parseInt(direct[3], 10)).slice(-2)
    ].join('-');
  }

  var parsed = new Date(raw);
  if (String(parsed) === 'Invalid Date') return '';
  return Utilities.formatDate(parsed, 'Asia/Tokyo', 'yyyy-MM-dd');
}

function toReservationSheetDate_(value) {
  var normalized = normalizeReservationDate_(value);
  if (!normalized) return String(value || '').trim();
  return normalized.replace(/-/g, '/');
}

function normalizeReservationTimeSlot_(value) {
  var raw = String(value || '').trim();
  if (!raw) return '';

  var compact = raw.replace(/\s+/g, '');
  var m = compact.match(/^(\d{1,2}:\d{2})[〜～~\-－—–](\d{1,2}:\d{2})$/);
  if (!m) return raw;

  return normalizeHourMinute_(m[1]) + '～' + normalizeHourMinute_(m[2]);
}

function normalizeHourMinute_(hm) {
  var m = String(hm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return String(hm || '').trim();
  var h = ('0' + parseInt(m[1], 10)).slice(-2);
  return h + ':' + m[2];
}

function normalizeReservationSlotCandidates_(slots) {
  var list = Array.isArray(slots) ? slots : splitMulti_(slots);
  var seen = {};
  var normalized = [];
  for (var i = 0; i < list.length; i += 1) {
    var slot = normalizeReservationTimeSlot_(list[i]);
    if (!slot) continue;
    if (seen[slot]) continue;
    seen[slot] = true;
    normalized.push(slot);
  }
  return normalized;
}

function parseReservationHash_(hash) {
  var raw = String(hash || '').trim();
  if (!raw) return null;
  var parts = raw.split('|');
  if (parts.length < 3) return null;

  var time = parts.pop();
  var date = parts.pop();
  var agentName = parts.join('|');
  agentName = String(agentName || '').trim();
  date = normalizeReservationDate_(date);
  time = normalizeReservationTimeSlot_(time);
  if (!agentName || !date || !time) return null;

  return {
    agent_name: agentName,
    date: date,
    time: time
  };
}

function getReservationLabelMap_() {
  return {
    reservation_hash: '予約ハッシュ',
    agent_name: 'エージェント名',
    date: '予約日',
    time: '予約時間枠',
    status: '予約ステータス',
    hold_token: '仮予約トークン',
    hold_expires_at_iso: '仮予約期限ISO',
    booked_at_iso: '確定時間ISO',
    booked_at_jst: '確定時間',
    updated_at_iso: '更新時間ISO',
    updated_at_jst: '更新時間',
    applicant_name: '予約者名',
    applicant_tel: '予約者電話番号',
    applicant_email: '予約者メールアドレス',
    calendar_id: '連携カレンダーID',
    calendar_event_id: 'カレンダーイベントID',
    calendar_event_url: 'カレンダーイベントURL'
  };
}

function toReservationLabel_(key) {
  var raw = String(key || '').trim();
  if (!raw) return '';

  var map = getReservationLabelMap_();
  if (map[raw]) return map[raw];

  var normalized = normalizeHeader_(raw);
  if (map[normalized]) return map[normalized];

  return raw;
}

function localizeReservationData_(obj) {
  var clone = Object.assign({}, obj || {});
  if (clone.date !== undefined && clone.date !== null && String(clone.date).trim()) {
    clone.date = toReservationSheetDate_(clone.date);
  }
  if (clone.time !== undefined && clone.time !== null && String(clone.time).trim()) {
    clone.time = normalizeReservationTimeSlot_(clone.time);
  }
  if (
    clone.agent_name !== undefined && clone.agent_name !== null &&
    clone.date !== undefined && clone.date !== null &&
    clone.time !== undefined && clone.time !== null
  ) {
    var normalizedHash = buildReservationHash_(clone.agent_name, clone.date, clone.time);
    if (normalizedHash) clone.reservation_hash = normalizedHash;
  }

  ['updated_at_jst', 'booked_at_jst'].forEach(function(k) {
    var v = clone[k];
    if (v) {
      var raw = String(v || '').trim();
      if (/^\d{4}\/\d{2}\/\d{2}\/ \d{2}:\d{2}$/.test(raw)) {
        clone[k] = raw;
        return;
      }
      var d = new Date(v);
      if (String(d) !== 'Invalid Date') {
        clone[k] = formatJstMinute_(d);
      } else {
        clone[k] = raw;
      }
    }
  });

  var localized = {};
  Object.keys(clone).forEach(function(key) {
    localized[toReservationLabel_(key)] = clone[key];
  });

  if (!localized['更新時間']) {
    localized['更新時間'] = formatJstMinute_(new Date());
  }
  return localized;
}

function migrateReservationsHeadersToJapanese_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return;

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function(v) { return String(v || '').trim(); });

  var seen = {};
  var converted = [];
  headers.forEach(function(header) {
    var label = toReservationLabel_(header);
    if (!label) return;
    if (seen[label]) return;
    seen[label] = true;
    converted.push(label);
  });

  if (!converted.length) return;
  if (converted[0] !== '更新時間') {
    converted = converted.filter(function(h) { return h !== '更新時間'; });
    converted.unshift('更新時間');
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
  var normalizedDate = normalizeReservationDate_(date) || String(date || '').trim();
  var normalizedTime = normalizeReservationTimeSlot_(time) || String(time || '').trim();
  return [agentName, normalizedDate, normalizedTime]
    .map(function(v) { return String(v || '').trim(); })
    .join('|');
}
