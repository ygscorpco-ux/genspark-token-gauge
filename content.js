// ====================================================
// Genspark Token Gauge v3.0
// User/AI 정확 구분 + 이관버튼 토스트 내장 + md 마크다운 보존
// + 압축 감지 자동리셋 + 대시보드 + 입력창 토큰 미리보기
// ====================================================

(function () {
  "use strict";

  // ===== 설정 =====
  const DEFAULT_CONFIG = {
    contextWindow: 55000,
    thresholdNotice: 50,
    thresholdWarning: 70,
    thresholdDanger: 85,
    thresholdCritical: 95,
    scanInterval: 2000,
    koreanTokenRatio: 1.5,
    englishTokenRatio: 0.25,
    codeTokenMultiplier: 1.3,
    perMessageOverhead: 8,
    messageSelectors: [
      ".bubble:not(.image_url)",
      '[class*="conversation"] [class*="item"]',
      '[class*="chat-msg"]',
      '[class*="turn"]',
      '[class*="markdown"]',
      ".prose",
      '[data-testid*="message"]',
      '[class*="dialog"] [class*="content"]',
    ],
  };

  let CONFIG = { ...DEFAULT_CONFIG };
  let manualOffset = 0;
  let prevMessageCount = 0;
  let notifiedLevels = new Set();
  let gaugeElement = null;
  let scanTimer = null;
  let lastUrl = "";
  let isExpanded = false;
  // 마지막으로 압축 감지 체크한 AI 메시지 인덱스 (중복 알림 방지)
  let lastCheckedCompressIdx = -1;
  const ASSISTANT_ROLE_RE = /(?:^|[\s:_-])(assistant|bot|ai|model|gpt)(?=$|[\s:_-])/i;
  const USER_ROLE_RE = /(?:^|[\s:_-])(user|human|me|member|self)(?=$|[\s:_-])/i;
  let lastAnalyzedData = {
    messageCount: 0,
    totalTokens: 0,
    rawTokens: 0,
    userTokens: 0,
    aiTokens: 0,
    pct: 0,
    remaining: DEFAULT_CONFIG.contextWindow,
    codesLeft: Math.floor(DEFAULT_CONFIG.contextWindow / 6000),
  };

  function toFiniteInt(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.trunc(parsed);
  }

  function sanitizeLoadedConfig(data) {
    const contextWindowRaw = toFiniteInt(
      data.contextWindow,
      DEFAULT_CONFIG.contextWindow,
    );
    const contextWindow =
      contextWindowRaw >= 10000 && contextWindowRaw <= 200000
        ? contextWindowRaw
        : DEFAULT_CONFIG.contextWindow;

    const thresholdNotice = toFiniteInt(
      data.thresholdNotice,
      DEFAULT_CONFIG.thresholdNotice,
    );
    const thresholdWarning = toFiniteInt(
      data.thresholdWarning,
      DEFAULT_CONFIG.thresholdWarning,
    );
    const thresholdDanger = toFiniteInt(
      data.thresholdDanger,
      DEFAULT_CONFIG.thresholdDanger,
    );
    const thresholdCritical = toFiniteInt(
      data.thresholdCritical,
      DEFAULT_CONFIG.thresholdCritical,
    );

    const inRange = [thresholdNotice, thresholdWarning, thresholdDanger].every(
      (v) => v >= 0 && v <= 99,
    );
    const criticalInRange = thresholdCritical >= 1 && thresholdCritical <= 100;
    const inOrder =
      thresholdNotice < thresholdWarning &&
      thresholdWarning < thresholdDanger &&
      thresholdDanger < thresholdCritical;

    if (!inRange || !criticalInRange || !inOrder) {
      return {
        contextWindow,
        thresholdNotice: DEFAULT_CONFIG.thresholdNotice,
        thresholdWarning: DEFAULT_CONFIG.thresholdWarning,
        thresholdDanger: DEFAULT_CONFIG.thresholdDanger,
        thresholdCritical: DEFAULT_CONFIG.thresholdCritical,
      };
    }

    return {
      contextWindow,
      thresholdNotice,
      thresholdWarning,
      thresholdDanger,
      thresholdCritical,
    };
  }

  // ===== 설정 불러오기 =====
  function loadConfig() {
    return new Promise((resolve) => {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(
          [
            "contextWindow",
            "thresholdNotice",
            "thresholdWarning",
            "thresholdDanger",
            "thresholdCritical",
          ],
          (data) => {
            const safe = sanitizeLoadedConfig(data || {});
            Object.assign(CONFIG, safe);
            lastAnalyzedData.remaining = CONFIG.contextWindow;
            lastAnalyzedData.codesLeft = Math.floor(CONFIG.contextWindow / 6000);
            resolve();
          },
        );
      } else {
        resolve();
      }
    });
  }

  // ===== 토큰 추정 =====
  function estimateTokens(text) {
    if (!text || !text.trim()) return 0;

    let total = 0;
    const codeRegex = /```[\s\S]*?```|`[^`]+`/g;
    const codeBlocks = text.match(codeRegex) || [];
    let plain = text.replace(codeRegex, " ");

    for (const block of codeBlocks) {
      const cleaned = block.replace(/```\w*\n?|```|`/g, "");
      total += countTokens(cleaned) * CONFIG.codeTokenMultiplier;
    }

    total += countTokens(plain);
    total += CONFIG.perMessageOverhead;

    return Math.ceil(total);
  }

  function countTokens(text) {
    if (!text) return 0;
    let t = 0;
    const korean = (text.match(/[가-힣ㄱ-ㅎㅏ-ㅣ]/g) || []).length;
    t += korean * CONFIG.koreanTokenRatio;
    const nonKorean = text.replace(/[가-힣ㄱ-ㅎㅏ-ㅣ\s]/g, "");
    t += nonKorean.length * CONFIG.englishTokenRatio;
    t += (text.match(/\s/g) || []).length * 0.1;
    return t;
  }

  function getNodeHints(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return "";
    const parts = [];
    const className = typeof node.className === "string" ? node.className : "";
    if (className) parts.push(className);

    const attrs = [
      "aria-label",
      "role",
      "data-role",
      "data-author",
      "data-testid",
    ];
    for (const name of attrs) {
      const value = node.getAttribute(name);
      if (value) parts.push(value);
    }
    return parts.join(" ").toLowerCase();
  }

  function detectMessageRole(el) {
    let node = el;
    for (let depth = 0; depth < 6 && node; depth += 1) {
      const hints = getNodeHints(node);
      if (ASSISTANT_ROLE_RE.test(hints)) return "assistant";
      if (USER_ROLE_RE.test(hints)) return "user";
      node = node.parentElement;
    }
    return "unknown";
  }

  // ===== 메시지 찾기 =====
  function findMessages() {
    for (const sel of CONFIG.messageSelectors) {
      try {
        const els = document.querySelectorAll(sel);
        const filtered = Array.from(els).filter((el) => {
          const text = (el.innerText || el.textContent || "").trim();
          return text.length > 0;
        });
        if (filtered.length > 0) {
          // 다중 힌트 기반으로 user/assistant 구분 후, 불명확하면 대화 흐름으로 보정
          let lastKnownRole = null;
          return filtered.map((el) => {
            let role = detectMessageRole(el);
            if (role === "unknown" && lastKnownRole) {
              role = lastKnownRole === "user" ? "assistant" : "user";
            }
            if (role !== "unknown") lastKnownRole = role;
            return { el, role };
          });
        }
      } catch (e) {}
    }
    return [];
  }

  // ===== 분석 =====
  function analyze(msgs = null) {
    const messageList = msgs || findMessages();
    const count = messageList.length;
    let total = 0;
    let userTok = 0;
    let aiTok = 0;

    messageList.forEach((m) => {
      const t = estimateTokens(m.el.innerText || m.el.textContent || "");
      total += t;
      // role 기반으로 정확하게 분류 (짝수/홀수 방식 대체)
      if (m.role === "user") userTok += t;
      else aiTok += t;
    });

    const adjusted = Math.max(0, total - manualOffset);

    return {
      messageCount: count,
      totalTokens: adjusted,
      rawTokens: total,
      userTokens: userTok,
      aiTokens: aiTok,
      pct: Math.min((adjusted / CONFIG.contextWindow) * 100, 100),
      remaining: Math.max(CONFIG.contextWindow - adjusted, 0),
      codesLeft: Math.floor(
        Math.max(CONFIG.contextWindow - adjusted, 0) / 6000,
      ),
    };
  }

  // ===== HTML → 마크다운 변환 =====
  // AI 답변의 렌더된 HTML을 마크다운 원문 형태로 복원
  function htmlToMarkdown(el) {
    function walk(node, listType, listDepth) {
      // 텍스트 노드는 그대로 반환
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return "";

      const tag = node.tagName.toLowerCase();
      const children = () =>
        Array.from(node.childNodes)
          .map((c) => walk(c, listType, listDepth))
          .join("");

      // 코드블록: 언어 class에서 언어명 추출
      if (tag === "pre") {
        const codeEl = node.querySelector("code");
        const langClass = codeEl?.className?.match(/language-(\S+)/);
        const lang = langClass ? langClass[1] : "";
        const code = (codeEl?.innerText || codeEl?.textContent || "").trimEnd();
        return `\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
      }

      // 인라인 코드 (pre 안의 code는 위에서 처리됨)
      if (tag === "code") {
        return `\`${node.textContent}\``;
      }

      // 헤딩
      if (/^h[1-6]$/.test(tag)) {
        const level = "#".repeat(parseInt(tag[1]));
        return `\n${level} ${children().trim()}\n\n`;
      }

      // 굵게 / 기울임
      if (tag === "strong" || tag === "b") return `**${children()}**`;
      if (tag === "em" || tag === "i") return `*${children()}*`;

      // 취소선
      if (tag === "del" || tag === "s") return `~~${children()}~~`;

      // 링크
      if (tag === "a") {
        const href = node.getAttribute("href") || "";
        return `[${children()}](${href})`;
      }

      // 이미지
      if (tag === "img") {
        const alt = node.getAttribute("alt") || "";
        const src = node.getAttribute("src") || "";
        return `![${alt}](${src})`;
      }

      // 수평선
      if (tag === "hr") return "\n---\n\n";

      // 인용구
      if (tag === "blockquote") {
        return (
          children()
            .trim()
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n") + "\n\n"
        );
      }

      // 순서 없는 목록
      if (tag === "ul") {
        return (
          Array.from(node.children)
            .map(
              (li) =>
                `${"  ".repeat(listDepth)}- ${walk(li, "ul", listDepth + 1).trim()}`,
            )
            .join("\n") + "\n\n"
        );
      }

      // 순서 있는 목록
      if (tag === "ol") {
        return (
          Array.from(node.children)
            .map(
              (li, idx) =>
                `${"  ".repeat(listDepth)}${idx + 1}. ${walk(li, "ol", listDepth + 1).trim()}`,
            )
            .join("\n") + "\n\n"
        );
      }

      // 목록 아이템 (ul/ol 안에서 위에서 처리하지만 중첩 대비)
      if (tag === "li") return children();

      // 문단
      if (tag === "p") return `${children().trim()}\n\n`;

      // 줄바꿈
      if (tag === "br") return "\n";

      // 테이블
      if (tag === "table") {
        let rows = Array.from(node.querySelectorAll("tr"));
        if (rows.length === 0) return children();
        const headerRow = rows[0];
        const headers = Array.from(headerRow.querySelectorAll("th,td")).map(
          (c) => c.innerText.trim(),
        );
        let table = `| ${headers.join(" | ")} |\n`;
        table += `| ${headers.map(() => "---").join(" | ")} |\n`;
        rows.slice(1).forEach((row) => {
          const cells = Array.from(row.querySelectorAll("td")).map((c) =>
            c.innerText.trim(),
          );
          table += `| ${cells.join(" | ")} |\n`;
        });
        return table + "\n";
      }

      // div, span 등 기타 블록 요소는 그냥 자식 탐색
      return children();
    }

    return walk(el, null, 0)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // ===== .md 다운로드 =====
  async function downloadConversation() {
    const msgs = findMessages();
    if (msgs.length === 0) {
      alert("대화 내용이 감지되지 않았습니다.");
      return;
    }

    const data = analyze();
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 16).replace("T", " ");
    const fileDate = now.toISOString().slice(0, 10);

    // --- 파일명 자동 넘버링 ---
    const savedNames = await new Promise((resolve) => {
      chrome.storage.local.get("gsFileNameCounts", (d) =>
        resolve(d.gsFileNameCounts || {}),
      );
    });

    const defaultName = `genspark-chat-${fileDate}`;
    const lastUsedBase = await new Promise((resolve) => {
      chrome.storage.local.get("gsLastFileName", (d) =>
        resolve(d.gsLastFileName || defaultName),
      );
    });

    let suggestedName = lastUsedBase;
    const baseMatch = lastUsedBase.match(/^(.*?)(\s+\d+)?$/);
    const baseName = baseMatch ? baseMatch[1] : lastUsedBase;
    const currentCount = savedNames[baseName] || 0;
    if (currentCount > 0) {
      suggestedName = `${baseName} ${currentCount + 1}`;
    }

    const userInput = prompt(
      "저장할 파일명을 입력하세요 (.md 자동 추가)",
      suggestedName,
    );
    if (userInput === null) return;
    const rawName = (userInput.trim() || defaultName).replace(/\.md$/i, "");

    const inputMatch = rawName.match(/^(.*?)(\s+\d+)?$/);
    const inputBase = inputMatch ? inputMatch[1].trim() : rawName;
    const inputNum = inputMatch && inputMatch[2] ? parseInt(inputMatch[2]) : 1;
    savedNames[inputBase] = inputNum;

    chrome.storage.local.set({
      gsFileNameCounts: savedNames,
      gsLastFileName: inputBase,
    });

    const fileName = rawName + ".md";
    // --- 파일명 자동 넘버링 끝 ---

    let md = `# Genspark 대화 기록\n`;
    md += `- 날짜: ${dateStr}\n`;
    md += `- 메시지: ${data.messageCount}개\n`;
    md += `- 추정 토큰: ${data.totalTokens.toLocaleString()}\n`;
    md += `\n---\n\n`;

    let qNum = 0;
    let aNum = 0;

    msgs.forEach((m) => {
      if (!m.el) return;

      // 사용자 메시지: 순수 텍스트 / AI 답변: HTML → 마크다운 변환으로 코드블록·헤딩·리스트 보존
      const text =
        m.role === "user"
          ? (m.el.innerText || m.el.textContent || "").trim()
          : htmlToMarkdown(m.el);

      if (!text) return;

      if (m.role === "user") {
        qNum++;
        md += `──── 질문 #${qNum} ────\n\n`;
      } else {
        aNum++;
        md += `──── 답변 #${aNum} ────\n\n`;
      }

      md += text + "\n\n";
    });

    md += `---\n`;
    md += `*Genspark Token Gauge v3.0에서 내보냄*\n`;

    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // 대시보드용 히스토리 저장 (최대 50개 유지)
    chrome.storage.local.get("gsHistory", (d) => {
      const hist = d.gsHistory || [];
      hist.unshift({
        name: rawName,
        date: dateStr,
        tokens: data.totalTokens,
        messages: data.messageCount,
        userTokens: data.userTokens,
        aiTokens: data.aiTokens,
        contextWindow: CONFIG.contextWindow,
      });
      if (hist.length > 50) hist.pop();
      chrome.storage.local.set({ gsHistory: hist });
    });
  }

  // ===== 이관 프롬프트 복사 =====
  function copyHandoverPrompt() {
    const promptText = `지금까지 대화를 기반으로 프로젝트 이관 문서를 작성해줘.

포함할 내용:
1) 프로젝트 개요 및 목적
2) 파일 구조와 각 파일의 역할
3) 핵심 설정값과 근거
4) 완성된 기능 목록
5) 이번 대화에서 변경/결정된 사항
6) 알려진 이슈와 다음 할 일
7) 버전 이력

규칙:
- 코드는 포함하지 마.
- 문서 마지막에 이 안내를 넣어줘:
  "코드는 이 문서에 포함되어 있지 않습니다. 수정이 필요하면 해당 파일의 코드를 요청하세요. 수정 지시는 Ctrl+H로 검색/치환할 수 있도록 [검색할 정확한 코드] → [바꿀 코드] 형식으로 주세요. 검색할 코드를 정확히 모르겠으면 해당 부분의 코드를 먼저 요청하세요."

이 문서를 새 채팅 첫 메시지에 붙여넣으면 AI가 프로젝트 맥락을 완전히 파악하고 바로 작업을 이어갈 수 있게 해줘.`;

    navigator.clipboard
      .writeText(promptText)
      .then(() => {
        showToast(
          "📋 이관 프롬프트 복사됨",
          "채팅창에 붙여넣기(Ctrl+V) 하세요.",
          "#58a6ff",
        );
      })
      .catch(() => {
        const ta = document.createElement("textarea");
        ta.value = promptText;
        ta.style.cssText = "position:fixed;left:-9999px;";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showToast(
          "📋 이관 프롬프트 복사됨",
          "채팅창에 붙여넣기(Ctrl+V) 하세요.",
          "#58a6ff",
        );
      });
  }

  // ===== 상태 =====
  function getStatus(pct) {
    if (pct >= CONFIG.thresholdCritical) {
      return {
        color: "#ff1744",
        bg: "#2d0008",
        border: "#ff174450",
        emoji: "🔴",
        label: "즉시 정리!",
        pulse: true,
      };
    }
    if (pct >= CONFIG.thresholdDanger) {
      return {
        color: "#ff6d00",
        bg: "#2d1a00",
        border: "#ff6d0050",
        emoji: "🟠",
        label: "압축 임박",
        pulse: true,
      };
    }
    if (pct >= CONFIG.thresholdWarning) {
      return {
        color: "#ffd600",
        bg: "#2d2800",
        border: "#ffd60050",
        emoji: "🟡",
        label: "주의",
        pulse: false,
      };
    }
    if (pct >= CONFIG.thresholdNotice) {
      return {
        color: "#00b0ff",
        bg: "#001a2d",
        border: "#00b0ff50",
        emoji: "🔵",
        label: "절반 사용",
        pulse: false,
      };
    }
    return {
      color: "#00e676",
      bg: "#002d15",
      border: "#00e67650",
      emoji: "🟢",
      label: "여유 있음",
      pulse: false,
    };
  }

  // ===== CSS =====
  function injectStyles() {
    if (document.getElementById("gs-styles")) return;
    const s = document.createElement("style");
    s.id = "gs-styles";
    s.textContent = `
      @keyframes gs-pulse {
        0% { box-shadow: 0 0 0 0 rgba(255,23,68,0.5); }
        50% { box-shadow: 0 0 0 8px rgba(255,23,68,0); }
        100% { box-shadow: 0 0 0 0 rgba(255,23,68,0); }
      }
      @keyframes gs-slideIn {
        from { transform: translateX(120%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes gs-fadeOut {
        from { opacity: 1; }
        to { opacity: 0; transform: translateY(-20px); }
      }
      #gs-gauge { opacity: 0.9; transition: opacity 0.2s; }
      #gs-gauge:hover { opacity: 1; }
    `;
    document.head.appendChild(s);
  }

  // ===== 게이지 생성 =====
  function createGauge() {
    const old = document.getElementById("gs-gauge");
    if (old) old.remove();

    const el = document.createElement("div");
    el.id = "gs-gauge";
    el.style.cssText = `
      position: fixed;
      bottom: 14px;
      right: 14px;
      z-index: 999999;
      font-family: 'Consolas','SF Mono','Menlo','Malgun Gothic',monospace;
      user-select: none;
    `;
    document.body.appendChild(el);
    return el;
  }

  // ===== 컴팩트 렌더 (기본) =====
  function renderCompact(gauge, data) {
    const s = getStatus(data.pct);
    const pct = data.pct.toFixed(1);

    gauge.innerHTML = `
      <div id="gs-compact" style="
        background: #0d1117;
        border: 1.5px solid ${s.border};
        border-radius: 10px;
        padding: 8px 12px;
        display: flex;
        align-items: center;
        gap: 10px;
        cursor: pointer;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
        min-width: 200px;
        ${s.pulse ? "animation: gs-pulse 1.5s infinite;" : ""}
      ">
        <span style="font-size: 14px;">${s.emoji}</span>

        <div style="flex: 1; min-width: 60px;">
          <div style="
            background: #21262d;
            border-radius: 4px;
            height: 6px;
            overflow: hidden;
            position: relative;
          ">
            <div style="
              position: absolute; left: ${CONFIG.thresholdWarning}%;
              top: 0; bottom: 0; width: 1px; background: #ffd60040;
            "></div>
            <div style="
              position: absolute; left: ${CONFIG.thresholdDanger}%;
              top: 0; bottom: 0; width: 1px; background: #ff6d0040;
            "></div>
            <div style="
              background: ${s.color};
              width: ${Math.min(data.pct, 100)}%;
              height: 100%;
              border-radius: 4px;
              transition: width 0.5s;
            "></div>
          </div>
        </div>

        <span style="
          font-size: 13px;
          font-weight: 800;
          color: ${s.color};
          min-width: 42px;
          text-align: right;
        ">${pct}%</span>

        <button id="gs-download-btn" title="대화 저장 (.md)" style="
          background: none; border: 1px solid #30363d;
          color: #8b949e; border-radius: 6px;
          width: 28px; height: 28px; font-size: 15px;
          cursor: pointer; display: flex;
          align-items: center; justify-content: center;
          flex-shrink: 0;
        ">💾</button>

        <button id="gs-handover-btn" title="이관 프롬프트 복사" style="
          background: none; border: 1px solid #30363d;
          color: #8b949e; border-radius: 6px;
          width: 28px; height: 28px; font-size: 15px;
          cursor: pointer; display: flex;
          align-items: center; justify-content: center;
          flex-shrink: 0;
        ">📋</button>

        <button id="gs-reset-btn" title="리셋" style="
          background: none; border: 1px solid #30363d;
          color: #8b949e; border-radius: 6px;
          width: 28px; height: 28px; font-size: 15px;
          cursor: pointer; display: flex;
          align-items: center; justify-content: center;
          flex-shrink: 0;
        ">↻</button>
      </div>
    `;

    const compact = gauge.querySelector("#gs-compact");
    compact.addEventListener("click", (e) => {
      if (
        e.target.id === "gs-reset-btn" ||
        e.target.id === "gs-download-btn" ||
        e.target.id === "gs-handover-btn"
      )
        return;
      isExpanded = true;
      renderExpanded(gauge, data);
    });

    gauge.querySelector("#gs-download-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      downloadConversation();
    });

    gauge.querySelector("#gs-handover-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      copyHandoverPrompt();
    });

    gauge.querySelector("#gs-reset-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      manualOffset = data.rawTokens;
      notifiedLevels.clear();
      scan();
    });
  }

  // ===== 확장 렌더 (클릭 시) =====
  function renderExpanded(gauge, data) {
    const s = getStatus(data.pct);
    const pct = data.pct.toFixed(1);

    gauge.innerHTML = `
      <div id="gs-expanded" style="
        background: #0d1117;
        border: 1.5px solid ${s.border};
        border-radius: 12px;
        padding: 14px 16px;
        min-width: 260px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        cursor: pointer;
        ${s.pulse ? "animation: gs-pulse 1.5s infinite;" : ""}
      ">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:14px;">${s.emoji}</span>
            <span style="font-size:11px;font-weight:700;color:#e6edf3;">Token Gauge</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <button id="gs-download-btn-exp" title="대화 저장 (.md)" style="
              background:none;border:1px solid #30363d;
              color:#8b949e;border-radius:4px;
              padding:2px 6px;font-size:10px;cursor:pointer;
            ">💾 저장</button>
            <button id="gs-handover-btn-exp" title="이관 프롬프트 복사" style="
              background:none;border:1px solid #30363d;
              color:#8b949e;border-radius:4px;
              padding:2px 6px;font-size:10px;cursor:pointer;
            ">📋 이관</button>
            <span style="font-size:9px;color:#484f58;">클릭하면 접기</span>
          </div>
        </div>

        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px;">
          <span style="font-size:28px;font-weight:800;color:${s.color};line-height:1;">
            ${pct}<span style="font-size:13px;">%</span>
          </span>
          <span style="font-size:10px;color:#8b949e;">
            ${data.totalTokens.toLocaleString()} / ${CONFIG.contextWindow.toLocaleString()}
          </span>
        </div>

        <div style="background:#21262d;border-radius:5px;height:10px;overflow:hidden;margin-bottom:8px;position:relative;">
          <div style="position:absolute;left:${CONFIG.thresholdWarning}%;top:0;bottom:0;width:1px;background:#ffd60050;"></div>
          <div style="position:absolute;left:${CONFIG.thresholdDanger}%;top:0;bottom:0;width:1px;background:#ff6d0050;"></div>
          <div style="background:${s.color};width:${Math.min(data.pct, 100)}%;height:100%;border-radius:5px;transition:width 0.5s;"></div>
        </div>

        <div style="font-size:12px;font-weight:700;color:${s.color};margin-bottom:10px;">${s.label}</div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;font-size:10px;color:#8b949e;">
          <div>💬 메시지 <span style="color:#e6edf3;font-weight:600;">${data.messageCount}개</span></div>
          <div>🔤 남은 토큰 <span style="color:#e6edf3;font-weight:600;">${data.remaining.toLocaleString()}</span></div>
          <div>👤 내 토큰 <span style="color:#e6edf3;font-weight:600;">${data.userTokens.toLocaleString()}</span></div>
          <div>🤖 AI 토큰 <span style="color:#e6edf3;font-weight:600;">${data.aiTokens.toLocaleString()}</span></div>
        </div>

        ${
          data.pct >= CONFIG.thresholdWarning
            ? `
          <div style="
            margin-top:10px;padding:8px 10px;
            background:${s.color}12;border:1px solid ${s.color}30;
            border-radius:6px;font-size:10px;color:${s.color};line-height:1.5;
          ">
            ${
              data.pct >= CONFIG.thresholdDanger
                ? '⚡ <strong>"프로젝트 현황 정리해줘"</strong> → 복사 → 새 채팅'
                : "💡 전체 파일 대신 <strong>부분 수정</strong>으로 요청하세요"
            }
          </div>
        `
            : ""
        }

        <div style="margin-top:6px;font-size:9px;color:#484f58;text-align:right;">
          ${data.messageCount > 0 ? "✅ 감지 중" : "⚠️ 메시지 미감지"}
        </div>
      </div>
    `;

    const expanded = gauge.querySelector("#gs-expanded");
    expanded.addEventListener("click", (e) => {
      if (
        e.target.id === "gs-download-btn-exp" ||
        e.target.id === "gs-handover-btn-exp"
      )
        return;
      isExpanded = false;
      renderCompact(gauge, data);
    });

    gauge
      .querySelector("#gs-download-btn-exp")
      .addEventListener("click", (e) => {
        e.stopPropagation();
        downloadConversation();
      });

    gauge
      .querySelector("#gs-handover-btn-exp")
      .addEventListener("click", (e) => {
        e.stopPropagation();
        copyHandoverPrompt();
      });
  }

  // ===== 렌더 분기 =====
  function renderGauge(gauge, data) {
    if (isExpanded) {
      renderExpanded(gauge, data);
    } else {
      renderCompact(gauge, data);
    }
  }

  // ===== 토스트 =====
  // withHandover: true이면 토스트 안에 📋 이관 버튼 표시
  function showToast(title, body, color, withHandover = false) {
    document.querySelectorAll(".gs-toast").forEach((el) => el.remove());
    const t = document.createElement("div");
    t.className = "gs-toast";
    t.style.cssText = `
      position:fixed;top:20px;right:20px;z-index:9999999;
      background:#0d1117;border:1.5px solid ${color}40;color:white;
      padding:14px 18px;border-radius:10px;
      box-shadow:0 8px 32px rgba(0,0,0,0.5);
      font-family:'Segoe UI','Malgun Gothic',sans-serif;
      max-width:360px;animation:gs-slideIn 0.3s ease;
    `;
    t.innerHTML = `
      <div style="font-weight:700;font-size:13px;margin-bottom:4px;color:${color};">${title}</div>
      <div style="font-size:11px;color:#ccc;line-height:1.5;">${body}</div>
      ${
        withHandover
          ? `
        <button id="gs-toast-handover" style="
          margin-top:10px;width:100%;padding:6px 0;
          background:${color}20;border:1px solid ${color}60;
          color:${color};border-radius:6px;font-size:11px;
          font-weight:700;cursor:pointer;
        ">📋 이관 프롬프트 복사 → 새 채팅 시작</button>
      `
          : ""
      }
    `;
    document.body.appendChild(t);

    // 이관 버튼 클릭 시 프롬프트 복사 후 토스트 즉시 닫기
    if (withHandover) {
      t.querySelector("#gs-toast-handover").addEventListener("click", () => {
        copyHandoverPrompt();
        t.remove();
      });
    }

    setTimeout(() => {
      t.style.animation = "gs-fadeOut 0.5s ease forwards";
      setTimeout(() => t.remove(), 500);
    }, 6000);
  }

  // ===== 알림 =====
  function checkNotify(data) {
    const p = data.pct;
    if (p >= CONFIG.thresholdCritical && !notifiedLevels.has("critical")) {
      notifiedLevels.add("critical");
      // 위험 단계: 이관 버튼 포함 (원클릭으로 경고 → 이관 처리)
      showToast(
        "🔴 컨텍스트 한계!",
        `${p.toFixed(0)}% — 즉시 정리 후 새 채팅으로 이동하세요.`,
        "#ff1744",
        true,
      );
    } else if (p >= CONFIG.thresholdDanger && !notifiedLevels.has("danger")) {
      notifiedLevels.add("danger");
      // 압축 임박 단계: 이관 버튼 포함
      showToast(
        "🟠 압축 임박",
        `${p.toFixed(0)}% — 코드 출력 ${data.codesLeft}회 남음. 현황 정리하세요.`,
        "#ff6d00",
        true,
      );
    } else if (p >= CONFIG.thresholdWarning && !notifiedLevels.has("warning")) {
      notifiedLevels.add("warning");
      showToast(
        "🟡 토큰 주의",
        `${p.toFixed(0)}% — 부분 수정 방식으로 전환하세요.`,
        "#ffd600",
      );
    } else if (p >= CONFIG.thresholdNotice && !notifiedLevels.has("notice")) {
      notifiedLevels.add("notice");
      showToast(
        "🔵 절반 사용",
        `${p.toFixed(0)}% — 코드 출력 ${data.codesLeft}회 남음.`,
        "#00b0ff",
      );
    }
  }

  // ===== 압축 감지 =====
  // AI 응답에 요약 패턴이 나오면 서버 측 컨텍스트 압축이 발생했을 가능성이 높음
  const COMPRESSION_PATTERNS = [
    /이전 대화(를| 내용을) 요약/,
    /앞서 (논의|대화|작업)한/,
    /지금까지의 대화를/,
    /대화 내용을 정리하면/,
    /이전 맥락(을| 상)/,
    /context (has been|was) compressed/i,
    /previous conversation summary/i,
    /위의 대화에서/,
    /지난 대화를 바탕/,
  ];

  function detectCompression(msgs) {
    // 마지막 AI 메시지만 확인 (매번 전체 스캔 방지)
    const aiMsgs = msgs
      .map((m, i) => ({ ...m, idx: i }))
      .filter((m) => m.role === "assistant" || m.role === "unknown");

    if (aiMsgs.length === 0) return;

    const last = aiMsgs[aiMsgs.length - 1];

    // 이미 체크한 메시지면 스킵
    if (last.idx === lastCheckedCompressIdx) return;
    lastCheckedCompressIdx = last.idx;

    const text = (last.el.innerText || last.el.textContent || "").slice(0, 300);
    const matched = COMPRESSION_PATTERNS.some((re) => re.test(text));

    if (matched) {
      // 압축 감지 시 게이지 자동 리셋
      manualOffset = 0;
      notifiedLevels.clear();
      showToast(
        "🔁 압축 발생 추정",
        "AI가 이전 대화를 요약했습니다. 게이지가 자동 리셋됩니다.",
        "#b388ff",
      );
    }
  }

  // ===== 새 채팅 감지 =====
  function detectNewChat(data) {
    if (prevMessageCount > 5 && data.messageCount <= 2) {
      manualOffset = 0;
      notifiedLevels.clear();
      prevMessageCount = 0;
      return true;
    }
    return false;
  }

  // ===== URL 변경 감지 =====
  function detectUrlChange() {
    const currentUrl = location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      manualOffset = 0;
      notifiedLevels.clear();
      prevMessageCount = 0;
      lastCheckedCompressIdx = -1;
      setTimeout(scan, 500);
      setTimeout(scan, 1500);
      setTimeout(scan, 3000);
    }
  }

  // ===== 스캔 =====
  function scan() {
    if (!gaugeElement) return;

    const msgs = findMessages();
    const data = analyze(msgs);

    if (detectNewChat(data)) {
      // 새 채팅이면 압축 감지 인덱스도 초기화
      lastCheckedCompressIdx = -1;
      const fresh = analyze(msgs);
      lastAnalyzedData = fresh;
      renderGauge(gaugeElement, fresh);
      prevMessageCount = fresh.messageCount;
      return;
    }

    // 새 메시지가 추가됐을 때만 압축 패턴 체크 (성능 최적화)
    if (msgs.length > prevMessageCount) {
      detectCompression(msgs);
    }

    lastAnalyzedData = data;
    renderGauge(gaugeElement, data);
    checkNotify(data);
    prevMessageCount = data.messageCount;
  }

  // ===== 입력창 토큰 미리보기 =====
  // 메시지 전송 전 입력 토큰 수와 전송 후 예상 % 표시
  function watchInput() {
    // 젠스파크 입력창 후보 셀렉터 (Vue SFC라 여러 경우 대비)
    const INPUT_SELECTORS = [
      "textarea[placeholder]",
      '[contenteditable="true"]',
      "textarea",
    ];

    let badge = null; // 미리보기 뱃지 DOM 요소
    let attachedEl = null; // 현재 감시 중인 입력 요소
    let inputPreviewTimer = null;

    // 뱃지 생성 (처음 한 번만)
    function ensureBadge() {
      if (badge) return;
      badge = document.createElement("div");
      badge.id = "gs-input-preview";
      badge.style.cssText = `
        position:fixed;bottom:60px;right:14px;
        z-index:999998;
        background:#0d1117;
        border:1px solid #30363d;
        border-radius:8px;
        padding:5px 10px;
        font-family:'Consolas','Malgun Gothic',monospace;
        font-size:11px;
        color:#8b949e;
        display:none;
        pointer-events:none;
      `;
      document.body.appendChild(badge);
    }

    function updateBadge(inputEl) {
      const text =
        inputEl.value || inputEl.innerText || inputEl.textContent || "";
      if (!text.trim()) {
        badge.style.display = "none";
        return;
      }

      const inputTok = estimateTokens(text);
      const baseTotal = lastAnalyzedData ? lastAnalyzedData.totalTokens : 0;
      // 현재 총 토큰 + 입력 토큰 = 전송 후 예상 토큰
      const afterTok = baseTotal + inputTok;
      const afterPct = Math.min((afterTok / CONFIG.contextWindow) * 100, 100);
      const pctColor =
        afterPct >= 85 ? "#ff6d00" : afterPct >= 70 ? "#ffd600" : "#3fb950";

      badge.innerHTML = `✏️ <strong style="color:#e6edf3">~${inputTok.toLocaleString()} tok</strong> → 전송 시 <strong style="color:${pctColor}">${afterPct.toFixed(1)}%</strong>`;
      badge.style.display = "block";
    }

    // 입력 요소 감지 및 이벤트 연결
    function tryAttach() {
      // 이미 유효한 요소에 붙어 있으면 스킵
      if (attachedEl && document.contains(attachedEl)) return;

      let found = null;
      for (const sel of INPUT_SELECTORS) {
        try {
          const els = document.querySelectorAll(sel);
          // 실제 채팅 입력창: 화면에 보이고 크기가 있는 것
          for (const el of els) {
            const r = el.getBoundingClientRect();
            if (r.width > 100 && r.height > 20) {
              found = el;
              break;
            }
          }
          if (found) break;
        } catch (e) {}
      }

      if (!found) return;
      ensureBadge();
      attachedEl = found;

      found.addEventListener("input", () => {
        clearTimeout(inputPreviewTimer);
        inputPreviewTimer = setTimeout(() => updateBadge(found), 80);
      });
      found.addEventListener("focus", () => updateBadge(found));
      found.addEventListener("blur", () => {
        // 포커스 잃으면 뱃지 숨김
        setTimeout(() => {
          if (badge) badge.style.display = "none";
        }, 200);
      });
    }

    // 페이지 렌더링 후 입력창 감지 (지연 재시도)
    setTimeout(tryAttach, 2000);
    setTimeout(tryAttach, 4000);
    setInterval(tryAttach, 10000); // URL 변경 등 대비 주기적 재확인
  }

  // ===== 메인 =====
  async function main() {
    await loadConfig();
    injectStyles();
    gaugeElement = createGauge();
    lastUrl = location.href;

    scan();

    scanTimer = setInterval(scan, CONFIG.scanInterval);

    setInterval(detectUrlChange, 500);

    // 입력창 토큰 미리보기 시작
    watchInput();

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        detectUrlChange();
        setTimeout(scan, 300);
      }
    });

    window.addEventListener("focus", () => {
      detectUrlChange();
      setTimeout(scan, 300);
    });

    const observer = new MutationObserver(() => {
      clearTimeout(window._gsScanDebounce);
      window._gsScanDebounce = setTimeout(scan, 800);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    console.log(
      "[Genspark Token Gauge v3.0] 로드 완료\n" +
        "  셀렉터: .bubble:not(.image_url)\n" +
        "  컨텍스트: " +
        CONFIG.contextWindow.toLocaleString() +
        " tok\n" +
        "  경고: " +
        CONFIG.thresholdNotice +
        "→" +
        CONFIG.thresholdWarning +
        "→" +
        CONFIG.thresholdDanger +
        "→" +
        CONFIG.thresholdCritical +
        "%\n" +
        "  💾 대화 저장(자동넘버링) + 📋 이관 프롬프트 활성화",
    );
  }

  // ===== 실행 =====
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(main, 1000));
  } else {
    setTimeout(main, 1000);
  }
})();
