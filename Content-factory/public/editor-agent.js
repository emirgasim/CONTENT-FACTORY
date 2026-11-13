(() => {
  const commandInput = document.getElementById("command");
  const sendButton = document.getElementById("send");
  const connection = document.getElementById("connection");
  const logLine = message => {
    const log = document.getElementById("log");
    log.textContent += "\n\n› " + message;
    log.scrollTop = log.scrollHeight;
  };

  const panel = document.createElement("section");
  panel.id = "aiProposal";
  panel.className = "status hidden";
  panel.style.marginTop = "10px";
  panel.innerHTML = '<strong>Yapay zekâ kurgu önerisi</strong><p id="aiReply" style="margin:8px 0"></p><ol id="aiActions" style="padding-left:20px"></ol><div class="actions"><button class="btn" id="aiApply" type="button">Öneriyi taslağa uygula</button><button class="secondary" id="aiReject" type="button">Reddet</button></div>';
  sendButton.closest(".agentform").insertAdjacentElement("afterend", panel);

  let pendingActions = [];

  fetch("/api/editor/agent")
    .then(response => response.json())
    .then(data => {
      connection.textContent = data.connected ? "Gemma 4 · Bağlı" : "AI bağlantısı bekleniyor";
      connection.title = data.connected ? data.model : (data.error || "Cloudflare AI binding gerekli");
    })
    .catch(() => { connection.textContent = "Ajan bağlantısı kontrol edilemedi"; });

  function describe(action) {
    const n = action.scene;
    if (action.type === "select_scene") return n + ". sahneyi aç";
    if (action.type === "move_scene_to_start") return n + ". sahneyi en başa taşı";
    if (action.type === "set_scene_duration") return n + ". sahnenin süresini " + action.seconds + " saniye yap";
    if (action.type === "select_next_alternative") return n + ". sahnenin sonraki mevcut görsel alternatifini seç";
    if (action.type === "navigate") return action.direction === "next" ? "Sonraki sahneye geç" : "Önceki sahneye geç";
    return "Kurgu işlemi";
  }

  function showProposal(data) {
    pendingActions = Array.isArray(data.actions) ? data.actions : [];
    document.getElementById("aiReply").textContent = data.reply || "Öneri hazır.";
    const list = document.getElementById("aiActions");
    list.replaceChildren();
    pendingActions.forEach(action => {
      const item = document.createElement("li");
      item.textContent = describe(action);
      list.append(item);
    });
    panel.classList.remove("hidden");
    document.getElementById("aiApply").disabled = pendingActions.length === 0;
    document.getElementById("aiReject").textContent = pendingActions.length ? "Reddet" : "Kapat";
  }

  sendButton.onclick = async () => {
    const command = commandInput.value.trim();
    if (!command) return;
    if (!Array.isArray(scenes) || !scenes.length) {
      logLine("Önce ses dosyanı yükle ve sahnelerin hazırlanmasını bekle.");
      return;
    }
    sendButton.disabled = true;
    sendButton.textContent = "Gemma 4 düşünüyor…";
    panel.classList.add("hidden");
    try {
      const response = await fetch("/api/editor/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command,
          activeScene: active + 1,
          scenes: scenes.map(scene => ({
            text: scene.text,
            start: scene.start,
            end: scene.end,
            options: (scene.options || []).map(option => ({
              title: option.title,
              source: option.source
            }))
          }))
        })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Ajan isteği başarısız.");
      logLine("Komut: " + command);
      showProposal(data);
      if (!data.actions?.length) logLine(data.reply || "Bu komut için güvenli bir işlem önerilemedi.");
      commandInput.value = "";
    } catch (error) {
      logLine("Ajan bağlantı hatası: " + error.message);
    } finally {
      sendButton.disabled = false;
      sendButton.textContent = "Gönder";
    }
  };

  commandInput.onkeydown = event => {
    if (event.key === "Enter") sendButton.click();
  };

  document.getElementById("aiReject").onclick = () => {
    pendingActions = [];
    panel.classList.add("hidden");
    logLine("Yapay zekâ önerisi reddedildi; zaman çizelgesi değiştirilmedi.");
  };

  document.getElementById("aiApply").onclick = () => {
    if (!pendingActions.length || !scenes.length) return;
    snapshot();
    for (const action of pendingActions) {
      if (action.type === "navigate") {
        active = Math.max(0, Math.min(scenes.length - 1, active + (action.direction === "next" ? 1 : -1)));
        continue;
      }
      const index = Number(action.scene) - 1;
      if (index < 0 || index >= scenes.length) continue;
      if (action.type === "select_scene") {
        active = index;
      } else if (action.type === "move_scene_to_start") {
        const [scene] = scenes.splice(index, 1);
        scenes.unshift(scene);
        active = 0;
        let cursor = 0;
        scenes.forEach(item => {
          const duration = Math.max(0.3, Number(item.end) - Number(item.start));
          item.start = Number(cursor.toFixed(2));
          item.end = Number((cursor + duration).toFixed(2));
          cursor += duration;
        });
      } else if (action.type === "set_scene_duration") {
        const scene = scenes[index];
        const oldDuration = Number(scene.end) - Number(scene.start);
        const newDuration = Number(action.seconds);
        const delta = newDuration - oldDuration;
        scene.end = Number((scene.start + newDuration).toFixed(2));
        for (let i = index + 1; i < scenes.length; i++) {
          scenes[i].start = Number((Number(scenes[i].start) + delta).toFixed(2));
          scenes[i].end = Number((Number(scenes[i].end) + delta).toFixed(2));
        }
        active = index;
      } else if (action.type === "select_next_alternative") {
        const scene = scenes[index];
        if (scene.options?.length) {
          const current = scene.options.findIndex(option => option.id === scene.selected);
          scene.selected = scene.options[(current + 1) % scene.options.length].id;
        }
        active = index;
      }
    }
    render();
    logLine(pendingActions.length + " yapay zekâ işlemi senin onayınla zaman çizelgesi taslağına uygulandı.");
    pendingActions = [];
    panel.classList.add("hidden");
  };
})();
