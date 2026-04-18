const params = new URLSearchParams(window.location.search);
const seekerId = params.get("seekerId");
const bookingList = document.getElementById("bookingList");
const answerList = document.getElementById("answerList");
const errorBox = document.getElementById("errorBox");
const lineButton = document.getElementById("lineButton");

initialize().catch((error) => {
  showError(error.message || "画面表示に失敗しました。");
});

async function initialize() {
  if (!seekerId) {
    throw new Error("seekerId が指定されていません。");
  }

  const [bookingResponse, configResponse] = await Promise.all([
    fetch(`/api/bookings/seeker/${encodeURIComponent(seekerId)}`),
    fetch("/api/public-config"),
  ]);
  const bookingData = await bookingResponse.json();
  const configData = await configResponse.json();

  if (!bookingResponse.ok) {
    throw new Error(bookingData.error || "予約一覧の取得に失敗しました。");
  }

  renderBookings(bookingData.bookings || []);
  renderAnswers(bookingData.seeker?.answers || {});

  const lineUrl = configData?.lineRegistrationUrl || "https://line.me";
  lineButton.href = lineUrl;
}

function renderBookings(bookings) {
  if (!bookings.length) {
    bookingList.innerHTML = `<p class="row">予約はまだありません。</p>`;
    return;
  }
  bookingList.innerHTML = bookings
    .map((booking) => {
      const start = formatDateTime(booking.start_at);
      const end = formatTime(booking.end_at);
      return `
      <article class="item">
        <h3>${escapeHtml(booking.company_name)}</h3>
        <p class="row">予約完了時間: ${start} - ${end}</p>
        <p class="row">担当者: ${escapeHtml(booking.rep_name)} (${escapeHtml(booking.rep_email)})</p>
      </article>
      `;
    })
    .join("");
}

function renderAnswers(answers) {
  const entries = Object.entries(answers || {});
  if (!entries.length) {
    answerList.innerHTML = `<p class="row">回答情報がありません。</p>`;
    return;
  }
  answerList.innerHTML = entries
    .map(([key, value]) => `<p><strong>${escapeHtml(key)}</strong>: ${escapeHtml(value)}</p>`)
    .join("");
}

function showError(message) {
  errorBox.classList.add("show");
  errorBox.textContent = message;
}

function formatDateTime(iso) {
  const date = new Date(iso);
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(
    date.getDate()
  ).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}`;
}

function formatTime(iso) {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
