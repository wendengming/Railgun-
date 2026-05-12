const DEFAULTS = {
  targetHour: 9,
  autoLoginEnabled: false,
  history: []
};

document.addEventListener("DOMContentLoaded", async () => {
  await renderPopup();
  document.getElementById("checkBtn").addEventListener("click", forceCheckIn);
  document.getElementById("settingsBtn").addEventListener("click", openSettings);
});

async function renderPopup() {
  const data = await chrome.storage.local.get(DEFAULTS);
  document.getElementById("targetHour").textContent = `${String(data.targetHour).padStart(2, "0")}:00`;
  document.getElementById("autoLogin").textContent = data.autoLoginEnabled ? "已启用" : "未启用";

  const latest = Array.isArray(data.history) && data.history.length > 0 ? data.history[0] : null;
  document.getElementById("lastLog").textContent = latest ? `[${latest.time}] ${latest.result}` : "暂无签到日志";
  document.getElementById("statePill").textContent = latest ? "已记录" : "待检测";
}

function forceCheckIn() {
  const button = document.getElementById("checkBtn");
  button.disabled = true;
  setStatus("正在后台检测...");

  chrome.runtime.sendMessage({ action: "forceCheckIn" }, async (response) => {
    button.disabled = false;

    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message, true);
      return;
    }

    if (!response || !response.ok) {
      setStatus(response && response.error ? response.error : "检测失败。", true);
      return;
    }

    setStatus(response.result.message, Boolean(response.result.error));
    await renderPopup();
  });
}

function openSettings() {
  chrome.runtime.openOptionsPage();
  window.close();
}

function setStatus(message, isError = false) {
  const status = document.getElementById("status");
  status.textContent = message;
  status.classList.toggle("error", isError);
}
