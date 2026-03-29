const STORAGE_KEYS = {
  bookingState: "aptitude-booking-state-v1",
  leadData: "aptitude-lead-data-v1",
};

const form = document.getElementById("diagnosis-form");
const resultSection = document.getElementById("result-section");
const calendarList = document.getElementById("calendar-list");
const bookingStatus = document.getElementById("booking-status");
const template = document.getElementById("calendar-card-template");

const domainCalendars = {
  creative: [
    {
      id: "creative-1",
      title: "クリエイティブ職キャリア相談",
      description: "デザイン・SNS運用・コンテンツ制作向けの個別相談枠です。",
      advisor: "キャリアアドバイザー: 佐藤",
      slot: "平日 19:00-20:00",
      bookingBaseUrl: "https://calendar.google.com",
    },
    {
      id: "creative-2",
      title: "マーケター適性セッション",
      description: "企画力と表現力を活かす職種を整理します。",
      advisor: "キャリアアドバイザー: 山本",
      slot: "土曜 10:00-11:00",
      bookingBaseUrl: "https://calendly.com",
    },
    {
      id: "creative-3",
      title: "ポートフォリオ改善面談",
      description: "実績の見せ方や応募戦略を一緒に見直します。",
      advisor: "キャリアアドバイザー: 鈴木",
      slot: "日曜 14:00-15:00",
      bookingBaseUrl: "https://outlook.office.com/bookwithme",
    },
  ],
  analysis: [
    {
      id: "analysis-1",
      title: "データ分析キャリア面談",
      description: "数値を扱う適性をもとに職種の方向性を提案します。",
      advisor: "キャリアアドバイザー: 中村",
      slot: "平日 20:00-21:00",
      bookingBaseUrl: "https://calendar.google.com",
    },
    {
      id: "analysis-2",
      title: "企画職キャリア相談",
      description: "課題解決型の仕事に向けた経験棚卸しを行います。",
      advisor: "キャリアアドバイザー: 田中",
      slot: "水曜 19:00-20:00",
      bookingBaseUrl: "https://calendly.com",
    },
    {
      id: "analysis-3",
      title: "業界研究ショート相談",
      description: "強みが活きる業界を複数比較して見つけます。",
      advisor: "キャリアアドバイザー: 伊藤",
      slot: "土曜 16:00-17:00",
      bookingBaseUrl: "https://outlook.office.com/bookwithme",
    },
  ],
  sales: [
    {
      id: "sales-1",
      title: "営業適性1on1セッション",
      description: "対人力を活かせる職種・企業タイプを整理します。",
      advisor: "キャリアアドバイザー: 小林",
      slot: "平日 18:00-19:00",
      bookingBaseUrl: "https://calendar.google.com",
    },
    {
      id: "sales-2",
      title: "カスタマーサクセス相談",
      description: "支援型キャリアへの転換ポイントを具体化します。",
      advisor: "キャリアアドバイザー: 斎藤",
      slot: "木曜 20:00-21:00",
      bookingBaseUrl: "https://calendly.com",
    },
    {
      id: "sales-3",
      title: "コミュニケーション職向け面談",
      description: "強み診断をもとに次の応募戦略を立てます。",
      advisor: "キャリアアドバイザー: 渡辺",
      slot: "日曜 11:00-12:00",
      bookingBaseUrl: "https://outlook.office.com/bookwithme",
    },
  ],
  tech: [
    {
      id: "tech-1",
      title: "ITエンジニア転職相談",
      description: "学習状況と希望条件から現実的なルートを提案します。",
      advisor: "キャリアアドバイザー: 加藤",
      slot: "平日 21:00-22:00",
      bookingBaseUrl: "https://calendar.google.com",
    },
    {
      id: "tech-2",
      title: "Web開発職キャリア面談",
      description: "開発・QA・PM補佐など適性に応じた職種を比較します。",
      advisor: "キャリアアドバイザー: 吉田",
      slot: "土曜 9:00-10:00",
      bookingBaseUrl: "https://calendly.com",
    },
    {
      id: "tech-3",
      title: "未経験IT相談会",
      description: "未経験からの最短アクションを明確にします。",
      advisor: "キャリアアドバイザー: 山田",
      slot: "日曜 18:00-19:00",
      bookingBaseUrl: "https://outlook.office.com/bookwithme",
    },
  ],
};

const bonusByPriority = {
  income: { analysis: 1, sales: 2, tech: 1 },
  stability: { analysis: 2, tech: 1, creative: 1 },
  challenge: { creative: 1, sales: 1, tech: 2 },
  balance: { creative: 2, analysis: 1, sales: 1 },
};

const bonusByAgeGroup = {
  teens: { creative: 1, tech: 1 },
  twenties: { creative: 1, sales: 1, tech: 1 },
  thirties: { analysis: 1, sales: 1, tech: 1 },
  fortiesPlus: { analysis: 2, sales: 1 },
};

function applyAdTrackingParams() {
  const url = new URL(window.location.href);
  const adSource = url.searchParams.get("utm_source") || "meta";
  const campaignId =
    url.searchParams.get("utm_campaign") ||
    url.searchParams.get("campaign_id") ||
    "";

  document.getElementById("adSource").value = adSource;
  document.getElementById("campaignId").value = campaignId;
}

function scoreDomains({ interest, priority, ageGroup }) {
  const score = {
    creative: 0,
    analysis: 0,
    sales: 0,
    tech: 0,
  };

  if (interest && score[interest] !== undefined) {
    score[interest] += 3;
  }

  const priorityBonus = bonusByPriority[priority] || {};
  Object.keys(priorityBonus).forEach((key) => {
    score[key] += priorityBonus[key];
  });

  const ageBonus = bonusByAgeGroup[ageGroup] || {};
  Object.keys(ageBonus).forEach((key) => {
    score[key] += ageBonus[key];
  });

  return score;
}

function deriveRecommendedCalendars(formInput) {
  const scores = scoreDomains(formInput);
  const topDomain = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]?.[0] || "analysis";
  return domainCalendars[topDomain] || domainCalendars.analysis;
}

function getBookingState() {
  const raw = localStorage.getItem(STORAGE_KEYS.bookingState);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function setBookingState(nextState) {
  localStorage.setItem(STORAGE_KEYS.bookingState, JSON.stringify(nextState));
}

function markBooked(calendarId) {
  if (!calendarId) return;

  const current = getBookingState();
  current[calendarId] = {
    booked: true,
    bookedAt: new Date().toISOString(),
  };
  setBookingState(current);
}

function isBooked(calendarId) {
  const state = getBookingState();
  return Boolean(state[calendarId] && state[calendarId].booked);
}

function buildBookingGatewayUrl(calendar, leadData) {
  const returnUrl = new URL(window.location.href);
  const gateway = new URL("./booking-complete.html", window.location.href);
  const externalCalendar = new URL(calendar.bookingBaseUrl);

  externalCalendar.searchParams.set("calendarId", calendar.id);
  externalCalendar.searchParams.set("name", leadData.name);
  externalCalendar.searchParams.set("email", leadData.email);
  externalCalendar.searchParams.set("source", leadData.adSource || "meta");
  externalCalendar.searchParams.set("campaign", leadData.campaignId || "");

  gateway.searchParams.set("calendarId", calendar.id);
  gateway.searchParams.set("calendarTitle", calendar.title);
  gateway.searchParams.set("calendarUrl", externalCalendar.toString());
  gateway.searchParams.set("returnUrl", returnUrl.toString());
  return gateway.toString();
}

function updateBookingStatusBanner(message) {
  if (message) {
    bookingStatus.classList.remove("hidden");
    bookingStatus.textContent = message;
    return;
  }

  const state = getBookingState();
  const bookedCount = Object.values(state).filter((entry) => entry.booked).length;
  if (bookedCount === 0) {
    bookingStatus.classList.add("hidden");
    bookingStatus.textContent = "";
    return;
  }

  bookingStatus.classList.remove("hidden");
  bookingStatus.textContent = `予約完了が ${bookedCount} 件反映されています。`;
}

function createMetaLines(calendar, calendarId) {
  return [
    calendar.advisor,
    `推奨時間帯: ${calendar.slot}`,
    `ID: ${calendarId}`,
    `ステータス: ${isBooked(calendarId) ? "予約済み" : "未予約"}`,
  ];
}

function applyBookedVisualState(card, reserveButton, manualButton) {
  card.classList.add("is-booked");
  reserveButton.textContent = "予約済み";
  reserveButton.setAttribute("aria-disabled", "true");
  manualButton.textContent = "予約済み（反映済み）";
  manualButton.disabled = true;
}

function renderCalendars(calendars, leadData) {
  calendarList.innerHTML = "";

  calendars.forEach((calendar) => {
    const fragment = template.content.cloneNode(true);
    const card = fragment.querySelector(".calendar-card");
    const title = fragment.querySelector(".calendar-title");
    const description = fragment.querySelector(".calendar-description");
    const metaList = fragment.querySelector(".calendar-meta");
    const reserveButton = fragment.querySelector(".reserve-button");
    const manualButton = fragment.querySelector(".mark-booked-button");

    title.textContent = calendar.title;
    description.textContent = calendar.description;
    reserveButton.href = buildBookingGatewayUrl(calendar, leadData);

    createMetaLines(calendar, calendar.id).forEach((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      metaList.appendChild(li);
    });

    if (isBooked(calendar.id)) {
      applyBookedVisualState(card, reserveButton, manualButton);
    } else {
      reserveButton.addEventListener("click", () => {
        updateBookingStatusBanner(
          `${calendar.title} の予約タブを開きました。予約後は予約完了画面からこのページへ戻れます。`
        );
      });

      manualButton.addEventListener("click", () => {
        markBooked(calendar.id);
        renderCalendars(calendars, leadData);
        updateBookingStatusBanner();
      });
    }

    calendarList.appendChild(fragment);
  });
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateRequiredFields(payload) {
  return (
    payload.name.trim().length > 0 &&
    payload.email.trim().length > 0 &&
    isValidEmail(payload.email.trim()) &&
    payload.ageGroup &&
    payload.interest &&
    payload.priority
  );
}

function persistLeadData(payload) {
  localStorage.setItem(STORAGE_KEYS.leadData, JSON.stringify(payload));
}

function loadLeadData() {
  const raw = localStorage.getItem(STORAGE_KEYS.leadData);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function hydrateFormFromSavedLead() {
  const lead = loadLeadData();
  if (!lead) return;

  ["name", "email", "ageGroup", "interest", "priority"].forEach((field) => {
    const element = document.getElementById(field);
    if (element && lead[field]) {
      element.value = lead[field];
    }
  });
}

function openResultsForLead(leadData) {
  const calendars = deriveRecommendedCalendars(leadData);
  renderCalendars(calendars, leadData);
  resultSection.classList.remove("hidden");
  updateBookingStatusBanner();
}

function reopenResultsFromSavedLead() {
  const lead = loadLeadData();
  if (!lead) return;
  openResultsForLead(lead);
}

function handleCrossTabBookingNotification(event) {
  if (event.key !== STORAGE_KEYS.bookingState) return;
  const lead = loadLeadData();
  if (!lead) return;
  openResultsForLead(lead);
}

function handleReturnFromBookingTab() {
  const currentUrl = new URL(window.location.href);
  const bookedCalendarId = currentUrl.searchParams.get("bookedCalendarId");
  if (!bookedCalendarId) return;

  markBooked(bookedCalendarId);
  currentUrl.searchParams.delete("bookedCalendarId");
  window.history.replaceState({}, "", currentUrl.toString());

  const lead = loadLeadData();
  if (!lead) return;

  openResultsForLead(lead);
  updateBookingStatusBanner("予約完了を反映しました。");
}

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const payload = {
    name: form.name.value,
    email: form.email.value,
    ageGroup: form.ageGroup.value,
    interest: form.interest.value,
    priority: form.priority.value,
    adSource: form.adSource.value || "meta",
    campaignId: form.campaignId.value || "",
  };

  if (!validateRequiredFields(payload)) {
    window.alert("未入力または形式不正があります。すべて正しく入力してください。");
    return;
  }

  persistLeadData(payload);
  openResultsForLead(payload);
  resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
});

applyAdTrackingParams();
hydrateFormFromSavedLead();
handleReturnFromBookingTab();
reopenResultsFromSavedLead();
window.addEventListener("storage", handleCrossTabBookingNotification);
