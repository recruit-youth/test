const state = {
  questions: [],
  answers: {},
  seekerId: null,
  recommendations: [],
};

const introScreen = document.getElementById("introScreen");
const introStartBtn = document.getElementById("introStartBtn");
const questionFields = document.getElementById("questionFields");
const questionForm = document.getElementById("questionForm");
const recommendBtn = document.getElementById("recommendBtn");
const progressFill = document.getElementById("progressFill");
const progressText = document.getElementById("progressText");
const formAlert = document.getElementById("formAlert");
const resultCard = document.getElementById("resultCard");
const companyGrid = document.getElementById("companyGrid");
const bookingAlert = document.getElementById("bookingAlert");

introStartBtn.addEventListener("click", () => {
  introScreen.classList.add("is-hidden");
  document.body.classList.remove("intro-active");
  window.scrollTo({ top: 0, behavior: "smooth" });
});

questionForm.addEventListener("submit", onSubmitQuestionnaire);

initialize().catch((error) => showAlert(formAlert, error.message || "初期化に失敗しました。"));

async function initialize() {
  const response = await fetch("/api/questions");
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "質問情報の取得に失敗しました。");
  }
  state.questions = data.questions || [];
  renderQuestionFields();
  updateProgress();
}

function renderQuestionFields() {
  const fragment = document.createDocumentFragment();
  for (const question of state.questions) {
    const field = document.createElement("div");
    field.className = "field";
    field.innerHTML = `
      <p class="field-label">${escapeHtml(question.label)} <span class="req">*</span></p>
      <div class="pill-grid" data-question="${escapeHtml(question.key)}"></div>
    `;
    const grid = field.querySelector(".pill-grid");
    for (const option of question.options || []) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pill";
      btn.textContent = option;
      btn.dataset.value = option;
      btn.addEventListener("click", () => {
        selectAnswer(question.key, option, grid);
      });
      grid.appendChild(btn);
    }
    fragment.appendChild(field);
  }
  questionFields.innerHTML = "";
  questionFields.appendChild(fragment);
}

function selectAnswer(questionKey, value, grid) {
  state.answers[questionKey] = value;
  Array.from(grid.querySelectorAll(".pill")).forEach((pill) => {
    pill.classList.toggle("is-active", pill.dataset.value === value);
  });
  updateProgress();
}

function updateProgress() {
  const totalQuestions = state.questions.length;
  const answered = state.questions.filter((q) => state.answers[q.key]).length;
  const pct = totalQuestions > 0 ? Math.floor((answered / totalQuestions) * 100) : 0;
  progressFill.style.width = `${pct}%`;
  progressText.textContent = `${pct}%`;
}

async function onSubmitQuestionnaire(event) {
  event.preventDefault();
  hideAlert(formAlert);
  hideAlert(bookingAlert);

  const profile = {
    name: document.getElementById("name").value.trim(),
    email: document.getElementById("email").value.trim(),
    phone: document.getElementById("phone").value.trim(),
  };
  if (!profile.name || !profile.email || !profile.phone) {
    showAlert(formAlert, "お名前・メール・電話番号は必須です。");
    return;
  }

  for (const question of state.questions) {
    if (!state.answers[question.key]) {
      showAlert(formAlert, `${question.label}を選択してください。`);
      return;
    }
  }

  recommendBtn.disabled = true;
  recommendBtn.textContent = "提案を作成中...";
  try {
    const response = await fetch("/api/recommendations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, answers: state.answers }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "提案取得に失敗しました。");

    state.seekerId = data.seekerId;
    state.recommendations = data.recommendations || [];
    renderRecommendations();
    resultCard.classList.remove("hidden");
    resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showAlert(formAlert, error.message || "提案取得に失敗しました。");
  } finally {
    recommendBtn.disabled = false;
    recommendBtn.textContent = "3社を提案してもらう";
  }
}

function renderRecommendations() {
  companyGrid.innerHTML = "";
  if (!state.recommendations.length) {
    companyGrid.innerHTML = `<p class="muted">今月の面談上限により提案可能な会社が見つかりませんでした。</p>`;
    return;
  }

  for (const company of state.recommendations) {
    const el = document.createElement("article");
    el.className = "company-card";
    el.innerHTML = `
      <div class="company-row">
        <div>
          <p class="company-name">${escapeHtml(company.name)}</p>
          <p class="company-meta">${escapeHtml(company.industry)} / 担当: ${escapeHtml(company.repName)}</p>
        </div>
        <span class="badge">今月残り ${company.remainingSlots} 枠</span>
      </div>
      <p class="company-meta" style="margin-top:6px">${escapeHtml(company.description)}</p>
      <div class="strengths">
        ${(company.strengths || []).map((item) => `<span class="strength">${escapeHtml(item)}</span>`).join("")}
      </div>
      <div class="company-actions">
        <button class="btn-sub" type="button" data-action="toggle-slots">日程を調整する</button>
        <span class="status" data-role="status">未選択</span>
      </div>
      <div class="slots" data-role="slots">
        <p class="muted">空き枠を取得していません</p>
      </div>
    `;

    const slotSection = el.querySelector('[data-role="slots"]');
    const status = el.querySelector('[data-role="status"]');
    const toggleBtn = el.querySelector('[data-action="toggle-slots"]');
    let loaded = false;

    toggleBtn.addEventListener("click", async () => {
      slotSection.classList.toggle("show");
      if (!slotSection.classList.contains("show")) return;

      if (!loaded) {
        slotSection.innerHTML = `<p class="muted">空き枠を読み込み中...</p>`;
        try {
          const slots = await fetchSlots(company.id);
          renderSlots(slotSection, slots, async (slotStart) => {
            await bookSlot(company, slotStart, status);
          });
          loaded = true;
        } catch (error) {
          slotSection.innerHTML = `<p class="muted">空き枠の取得に失敗しました: ${escapeHtml(
            error.message || "unknown"
          )}</p>`;
        }
      }
    });

    companyGrid.appendChild(el);
  }
}

async function fetchSlots(companyId) {
  const response = await fetch(`/api/companies/${encodeURIComponent(companyId)}/slots`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "空き枠の取得に失敗しました。");
  }
  return data.slots || [];
}

function renderSlots(container, slots, onSelect) {
  if (!slots.length) {
    container.innerHTML = `<p class="muted">現在表示できる空き枠がありません。</p>`;
    return;
  }
  const days = slots
    .map((day) => {
      const slotButtons = (day.slots || [])
        .map(
          (slot) =>
            `<button type="button" class="slot-btn" data-start="${escapeHtml(slot.startAt)}">${escapeHtml(
              slot.label
            )}</button>`
        )
        .join("");
      return `
        <div>
          <p class="slots-date">${escapeHtml(day.date)}</p>
          <div class="slot-list">${slotButtons}</div>
        </div>
      `;
    })
    .join("");

  container.innerHTML = `<div class="slots-days">${days}</div>`;
  Array.from(container.querySelectorAll(".slot-btn")).forEach((btn) => {
    btn.addEventListener("click", () => onSelect(btn.dataset.start));
  });
}

async function bookSlot(company, slotStart, statusEl) {
  hideAlert(bookingAlert);
  statusEl.textContent = "予約処理中...";
  try {
    const response = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seekerId: state.seekerId, companyId: company.id, slotStart }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "予約に失敗しました。");

    statusEl.textContent = `予約完了: ${formatDateTime(data.startAt)}`;
    window.location.href = data.redirectTo;
  } catch (error) {
    statusEl.textContent = "未選択";
    showAlert(bookingAlert, error.message || "予約に失敗しました。");
  }
}

function showAlert(target, message) {
  target.classList.add("show");
  target.textContent = message;
}

function hideAlert(target) {
  target.classList.remove("show");
  target.textContent = "";
}

function formatDateTime(iso) {
  const date = new Date(iso);
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(
    date.getDate()
  ).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
