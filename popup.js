document.addEventListener("DOMContentLoaded", () => {
  function toInt(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && Number.isInteger(parsed) ? parsed : NaN;
  }

  function parseSettings() {
    const contextWindow = toInt(fields.contextWindow.value);
    const thresholdNotice = toInt(fields.thresholdNotice.value);
    const thresholdWarning = toInt(fields.thresholdWarning.value);
    const thresholdDanger = toInt(fields.thresholdDanger.value);
    const thresholdCritical = toInt(fields.thresholdCritical.value);

    if (!Number.isInteger(contextWindow) || contextWindow < 10000 || contextWindow > 200000) {
      throw new Error("임계값(토큰)은 10,000~200,000 사이 정수여야 합니다.");
    }
    if (!Number.isInteger(thresholdNotice) || thresholdNotice < 0 || thresholdNotice > 99) {
      throw new Error("알림(%)은 0~99 사이 정수여야 합니다.");
    }
    if (!Number.isInteger(thresholdWarning) || thresholdWarning < 0 || thresholdWarning > 99) {
      throw new Error("주의(%)은 0~99 사이 정수여야 합니다.");
    }
    if (!Number.isInteger(thresholdDanger) || thresholdDanger < 0 || thresholdDanger > 99) {
      throw new Error("위험(%)은 0~99 사이 정수여야 합니다.");
    }
    if (!Number.isInteger(thresholdCritical) || thresholdCritical < 1 || thresholdCritical > 100) {
      throw new Error("긴급(%)은 1~100 사이 정수여야 합니다.");
    }

    return {
      contextWindow,
      thresholdNotice,
      thresholdWarning,
      thresholdDanger,
      thresholdCritical,
    };
  }

  function toSafeCount(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.trunc(parsed));
  }

  function normalizeHistoryEntry(entry) {
    if (!entry || typeof entry !== "object") return null;
    const name =
      typeof entry.name === "string" && entry.name.trim().length > 0
        ? entry.name.trim()
        : "(이름 없음)";
    const date = typeof entry.date === "string" ? entry.date : "";
    const messages = toSafeCount(entry.messages);
    const tokens = toSafeCount(entry.tokens);
    const contextWindow = toSafeCount(entry.contextWindow);
    return { name, date, messages, tokens, contextWindow };
  }

  // ===== 탭 전환 =====
  const tabSettings = document.getElementById("tab-settings");
  const tabDashboard = document.getElementById("tab-dashboard");
  const panelSettings = document.getElementById("panel-settings");
  const panelDashboard = document.getElementById("panel-dashboard");

  tabSettings.addEventListener("click", () => {
    tabSettings.classList.add("active");
    tabDashboard.classList.remove("active");
    panelSettings.style.display = "block";
    panelDashboard.style.display = "none";
  });

  tabDashboard.addEventListener("click", () => {
    tabDashboard.classList.add("active");
    tabSettings.classList.remove("active");
    panelDashboard.style.display = "block";
    panelSettings.style.display = "none";
    loadDashboard();
  });

  // ===== 설정 탭 =====
  const fields = {
    contextWindow: document.getElementById("contextWindow"),
    thresholdNotice: document.getElementById("thresholdNotice"),
    thresholdWarning: document.getElementById("thresholdWarning"),
    thresholdDanger: document.getElementById("thresholdDanger"),
    thresholdCritical: document.getElementById("thresholdCritical"),
  };

  const saveBtn = document.getElementById("saveBtn");
  const savedMsg = document.getElementById("savedMsg");

  // 프리셋 버튼
  document.getElementById("preset-30k").addEventListener("click", () => {
    fields.contextWindow.value = 30000;
  });
  document.getElementById("preset-45k").addEventListener("click", () => {
    fields.contextWindow.value = 45000;
  });
  document.getElementById("preset-55k").addEventListener("click", () => {
    fields.contextWindow.value = 55000;
  });

  // 저장된 설정 불러오기
  chrome.storage.local.get(Object.keys(fields), (data) => {
    for (const key of Object.keys(fields)) {
      if (data[key] !== undefined) fields[key].value = data[key];
    }
  });

  // 설정 저장
  saveBtn.addEventListener("click", () => {
    let values;
    try {
      values = parseSettings();
    } catch (err) {
      alert(err.message);
      return;
    }

    if (values.thresholdNotice >= values.thresholdWarning) {
      alert("알림(%) < 주의(%) 이어야 합니다.");
      return;
    }
    if (values.thresholdWarning >= values.thresholdDanger) {
      alert("주의(%) < 위험(%) 이어야 합니다.");
      return;
    }
    if (values.thresholdDanger >= values.thresholdCritical) {
      alert("위험(%) < 긴급(%) 이어야 합니다.");
      return;
    }
    chrome.storage.local.set(values, () => {
      savedMsg.style.display = "block";
      setTimeout(() => {
        savedMsg.style.display = "none";
      }, 4000);
    });
  });

  // ===== 대시보드 탭 =====
  function loadDashboard() {
    chrome.storage.local.get("gsHistory", (data) => {
      const hist = data.gsHistory || [];
      renderDashboard(hist);
    });
  }

  function renderDashboard(hist) {
    const history = Array.isArray(hist) ? hist : [];

    // 통계 계산
    const count = history.length;
    const avgTok =
      count > 0
        ? Math.round(history.reduce((s, h) => s + toSafeCount(h.tokens), 0) / count)
        : 0;
    const totalMsg = history.reduce((s, h) => s + toSafeCount(h.messages), 0);

    // 숫자를 K 단위로 표시
    const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n));

    document.getElementById("d-count").textContent = count;
    document.getElementById("d-avg").textContent = fmt(avgTok);
    document.getElementById("d-total").textContent = totalMsg;

    const list = document.getElementById("d-hist-list");
    if (count === 0) {
      list.innerHTML =
        '<div class="empty-state">📭 저장된 대화가 없습니다.<br>💾 버튼으로 대화를 저장하면 여기에 표시됩니다.</div>';
      return;
    }

    // 대화 목록 렌더링 (최신순)
    list.textContent = "";
    const fragment = document.createDocumentFragment();
    for (const rawEntry of history) {
      const h = normalizeHistoryEntry(rawEntry);
      if (!h) continue;

      const pct = h.contextWindow
        ? Math.min(Math.round((h.tokens / h.contextWindow) * 100), 100)
        : null;
      const pctColor = pct >= 85 ? "#ff6d00" : pct >= 70 ? "#ffd600" : "#3fb950";

      const item = document.createElement("div");
      item.className = "hist-item";

      const left = document.createElement("div");
      left.style.cssText = "flex:1;min-width:0;";

      const name = document.createElement("div");
      name.className = "name";
      name.title = h.name;
      name.textContent = h.name;

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = h.date
        ? `${h.date} · ${h.messages}개 메시지`
        : `${h.messages}개 메시지`;

      left.appendChild(name);
      left.appendChild(meta);

      const right = document.createElement("div");
      right.className = "tok";

      const tokenText = document.createElement("span");
      tokenText.style.color = pctColor;
      tokenText.textContent = h.tokens.toLocaleString();

      const detail = document.createElement("small");
      detail.textContent = pct !== null ? `tok · ${pct}%` : "tok";

      right.appendChild(tokenText);
      right.appendChild(detail);

      item.appendChild(left);
      item.appendChild(right);
      fragment.appendChild(item);
    }

    if (fragment.childNodes.length === 0) {
      list.innerHTML =
        '<div class="empty-state">📭 저장된 대화가 없습니다.<br>💾 버튼으로 대화를 저장하면 여기에 표시됩니다.</div>';
      return;
    }
    list.appendChild(fragment);
  }

  // 기록 초기화 버튼
  document.getElementById("d-clear-btn").addEventListener("click", () => {
    if (!confirm("저장된 대화 기록을 모두 삭제할까요?")) return;
    chrome.storage.local.remove("gsHistory", () => {
      loadDashboard();
    });
  });
});
