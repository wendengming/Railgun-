const DEFAULTS = {
  targetHour: 9,
  notifyEnabled: true,
  cookieString: "",
  autoLoginEnabled: false,
  autoLoginCollapsed: false,
  railgunEmail: "",
  gmailKeywords: "railgun,access code,verification code,passcode,验证码,驗證碼",
  history: []
};

document.addEventListener("DOMContentLoaded", async () => {
  fillHourOptions();
  await renderSettings();
  bindEvents();
});

function fillHourOptions() {
  const select = document.getElementById("targetHour");
  for (let hour = 0; hour < 24; hour += 1) {
    const option = document.createElement("option");
    option.value = String(hour);
    option.textContent = `${String(hour).padStart(2, "0")}:00`;
    select.appendChild(option);
  }
}

async function renderSettings() {
  const data = await chrome.storage.local.get(DEFAULTS);

  document.getElementById("targetHour").value = String(data.targetHour);
  document.getElementById("cookieString").value = data.cookieString;
  document.getElementById("notifyToggle").checked = data.notifyEnabled !== false;
  document.getElementById("autoLoginEnabled").checked = data.autoLoginEnabled === true;
  document.getElementById("railgunEmail").value = data.railgunEmail || "";
  document.getElementById("gmailKeywords").value = data.gmailKeywords || DEFAULTS.gmailKeywords;
  setAutoLoginCollapsed(data.autoLoginCollapsed === true);
  renderGmailStatus();
  renderHistory(data.history || []);
}

function bindEvents() {
  document.getElementById("saveBtn").addEventListener("click", saveSettings);
  document.getElementById("testBtn").addEventListener("click", testCheckIn);
  document.getElementById("refreshBtn").addEventListener("click", renderSettings);
  document.getElementById("gmailFeedTestBtn").addEventListener("click", testGmailFeed);
  document.getElementById("autoLoginToggle").addEventListener("click", toggleAutoLoginSection);
}

async function saveSettings() {
  const payload = {
    targetHour: Number(document.getElementById("targetHour").value),
    cookieString: document.getElementById("cookieString").value.trim(),
    notifyEnabled: document.getElementById("notifyToggle").checked,
    autoLoginEnabled: document.getElementById("autoLoginEnabled").checked,
    autoLoginCollapsed: document.getElementById("autoLoginBody").hidden,
    railgunEmail: document.getElementById("railgunEmail").value.trim(),
    gmailKeywords: document.getElementById("gmailKeywords").value.trim() || DEFAULTS.gmailKeywords
  };

  await chrome.storage.local.set(payload);
  setStatus("设置已保存。浏览器启动或定时闹钟触发时会静默请求签到接口。");
  await renderSettings();
}

async function toggleAutoLoginSection() {
  const body = document.getElementById("autoLoginBody");
  const collapsed = !body.hidden;
  setAutoLoginCollapsed(collapsed);
  await chrome.storage.local.set({ autoLoginCollapsed: collapsed });
}

function setAutoLoginCollapsed(collapsed) {
  const body = document.getElementById("autoLoginBody");
  const button = document.getElementById("autoLoginToggle");
  body.hidden = collapsed;
  button.setAttribute("aria-expanded", String(!collapsed));
}

async function testGmailFeed() {
  const button = document.getElementById("gmailFeedTestBtn");
  button.disabled = true;
  setGmailStatus("正在读取 Gmail Feed...");

  chrome.runtime.sendMessage({ action: "testGmailFeed" }, async (response) => {
    button.disabled = false;

    if (chrome.runtime.lastError) {
      setGmailStatus(chrome.runtime.lastError.message, true);
      return;
    }

    if (!response || !response.ok) {
      setGmailStatus(response && response.error ? response.error : "Gmail Feed 读取失败。", true);
      return;
    }

    setGmailStatus(response.result.message);
  });
}

async function testCheckIn() {
  const button = document.getElementById("testBtn");
  button.disabled = true;
  setStatus("正在后台静默请求 Railgun 签到接口；如登录失效，将尝试 Gmail 验证码自动登录...");

  chrome.runtime.sendMessage({ action: "forceCheckIn" }, async (response) => {
    button.disabled = false;

    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message, true);
      return;
    }

    if (!response || !response.ok) {
      setStatus(response && response.error ? response.error : "测试签到失败。", true);
      return;
    }

    setStatus(response.result.message, Boolean(response.result.error));
    await renderSettings();
  });
}

function renderGmailStatus() {
  setGmailStatus("无需 OAuth Client ID。请先在当前 Chrome 登录 Gmail，再点击“测试 Gmail Feed”。");
}

function renderHistory(history) {
  const list = document.getElementById("historyList");
  list.innerHTML = "";

  if (!history.length) {
    const empty = document.createElement("li");
    empty.textContent = "暂无签到日志";
    list.appendChild(empty);
    return;
  }

  for (const item of history) {
    const li = document.createElement("li");
    li.textContent = `[${item.time}] ${item.result}`;
    list.appendChild(li);
  }
}

function setStatus(message, isError = false) {
  const status = document.getElementById("status");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function setGmailStatus(message, isError = false) {
  const status = document.getElementById("gmailStatus");
  status.textContent = message;
  status.classList.toggle("error", isError);
}
