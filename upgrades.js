(() => {
  const style = document.createElement("style");
  style.textContent = `
    #aiUpgradeTools {
      position: fixed;
      right: 18px;
      bottom: 92px;
      z-index: 140;
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .ai-upgrade-btn {
      width: 40px;
      height: 40px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,.12);
      background: rgba(24,24,29,.94);
      color: #f5f5f7;
      box-shadow: 0 10px 30px rgba(0,0,0,.28);
      cursor: pointer;
      font-size: 17px;
    }
    .ai-upgrade-btn:hover { background: rgba(255,255,255,.08); }
    .ai-upgrade-btn.active { background: #2563eb; }
    .ai-admin-link {
      position: fixed;
      right: 18px;
      top: 72px;
      z-index: 140;
      display: none;
      padding: 7px 10px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,.1);
      background: rgba(24,24,29,.9);
      color: #aaa;
      text-decoration: none;
      font-size: 11px;
    }
    .ai-admin-link:hover { color: white; }
    .ai-message-tools {
      display: inline-flex;
      gap: 5px;
      margin-top: 7px;
    }
    .ai-speak-btn {
      min-width: 29px;
      height: 27px;
      padding: 0 8px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,.1);
      background: rgba(255,255,255,.04);
      color: #aaa;
      cursor: pointer;
      font-size: 11px;
    }
    .ai-speak-btn:hover { color: white; background: rgba(255,255,255,.08); }
    @media (max-width: 700px) {
      #aiUpgradeTools { right: 10px; bottom: 82px; }
      .ai-upgrade-btn { width: 38px; height: 38px; }
      .ai-admin-link { right: 10px; top: 66px; }
    }
  `;
  document.head.appendChild(style);

  const tools = document.createElement("div");
  tools.id = "aiUpgradeTools";

  const mic = document.createElement("button");
  mic.className = "ai-upgrade-btn";
  mic.title = "Voice input";
  mic.setAttribute("aria-label", "Voice input");
  mic.textContent = "🎙️";

  const stop = document.createElement("button");
  stop.className = "ai-upgrade-btn";
  stop.title = "Stop speaking";
  stop.setAttribute("aria-label", "Stop speaking");
  stop.textContent = "🔇";

  tools.append(mic, stop);
  document.body.appendChild(tools);

  const admin = document.createElement("a");
  admin.className = "ai-admin-link";
  admin.href = "/admin";
  admin.textContent = "Admin";
  document.body.appendChild(admin);

  fetch("/api/features", { cache: "no-store" })
    .then((r) => r.ok ? r.json() : null)
    .then((features) => {
      if (features?.webSearch || features?.fileStorage || features?.semanticMemory) {
        const badge = document.createElement("span");
        badge.textContent = "Tools";
        badge.style.cssText = "font-size:10px;color:#777;align-self:center;";
        tools.appendChild(badge);
      }
    })
    .catch(() => {});

  fetch("/api/health", { cache: "no-store" })
    .then((r) => r.json())
    .then((data) => {
      if (data?.user?.toLowerCase?.() === "thomasbateman6@gmail.com") {
        admin.style.display = "block";
      }
    })
    .catch(() => {});

  const input = document.getElementById("message");
  let recognition = null;

  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (SpeechRecognition && input) {
    recognition = new SpeechRecognition();
    recognition.lang = navigator.language || "en-GB";
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onstart = () => mic.classList.add("active");
    recognition.onend = () => mic.classList.remove("active");
    recognition.onerror = () => mic.classList.remove("active");

    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        transcript += event.results[i][0].transcript;
      }
      input.value = transcript.trim();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    };

    mic.addEventListener("click", () => {
      try {
        if (mic.classList.contains("active")) {
          recognition.stop();
        } else {
          recognition.start();
        }
      } catch {}
    });
  } else {
    mic.disabled = true;
    mic.title = "Voice input is not supported by this browser";
  }

  stop.addEventListener("click", () => {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  });

  function attachSpeechButton(message) {
    if (!message || message.querySelector(".ai-message-tools")) return;
    if (!message.classList.contains("ai")) return;

    const content = message.textContent?.trim();
    if (!content || content === "Thinking...") return;

    const tools = document.createElement("div");
    tools.className = "ai-message-tools";

    const speak = document.createElement("button");
    speak.className = "ai-speak-btn";
    speak.textContent = "🔊 Read aloud";
    speak.onclick = () => {
      if (!window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(content);
      utterance.lang = navigator.language || "en-GB";
      utterance.rate = 1;
      window.speechSynthesis.speak(utterance);
    };

    tools.appendChild(speak);
    message.appendChild(tools);
  }

  const observer = new MutationObserver(() => {
    document.querySelectorAll(".message.ai").forEach(attachSpeechButton);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  document.querySelectorAll(".message.ai").forEach(attachSpeechButton);
})();
