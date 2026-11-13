(() => {
  const TRANSITION_LABELS = {
    cut: "Keskin Geçiş",
    fade: "Kararma (Fade)",
    dissolve: "Sinematik Erime (Dissolve)",
    zoom_in: "Yakınlaşma Geçişi",
    slide_left: "Sola Kaydırma"
  };

  function describeAction(action) {
    switch (action.type) {
      case "select_scene":
        return `Sahne ${action.scene} seçilecek`;
      case "move_scene_to_start":
        return `Sahne ${action.scene} videonun başına alınacak`;
      case "move_scene":
        return `Sahne ${action.scene}, ${action.targetPosition}. sıraya taşınacak`;
      case "set_scene_duration":
        return `Sahne ${action.scene} süresi ${action.seconds} sn yapılacak`;
      case "adjust_scene_duration":
        return `Sahne ${action.scene} süresi ${action.delta > 0 ? "+" : ""}${action.delta} sn değiştirilecek`;
      case "select_next_alternative":
        return `Sahne ${action.scene} için sonraki görsel alternatifi seçilecek`;
      case "search_new_visual":
        return `Sahne ${action.scene} için açık kaynaklarda yeni görsel aranacak: "${action.query}"`;
      case "set_transition":
        return `Sahne ${action.scene} geçişi "${TRANSITION_LABELS[action.transition] || action.transition}" yapılacak`;
      case "set_framing":
        return `Sahne ${action.scene} kadrajı güncellenecek (Zoom: ${action.scale}x, X:${action.panX}%, Y:${action.panY}%)`;
      case "set_caption":
        return `Sahne ${action.scene} altyazısı güncellenecek`;
      case "set_audio_mix": {
        const parts = [];
        if (typeof action.voiceVolume === "number") parts.push(`Seslendirme %${Math.round(action.voiceVolume * 100)}`);
        if (typeof action.musicVolume === "number") parts.push(`Müzik %${Math.round(action.musicVolume * 100)}`);
        return `Ses miksajı güncellenecek (${parts.join(", ")})`;
      }
      case "set_pacing":
        return `Tüm sahnelerin temposu ${action.factor < 1 ? "hızlandırılacak" : "yavaşlatılacak"} (x${action.factor})`;
      case "navigate":
        return action.direction === "previous" ? "Önceki sahneye geçilecek" : "Sonraki sahneye geçilecek";
      default:
        return JSON.stringify(action);
    }
  }

  async function applyAction(ctx, action) {
    const { state, selectScene, searchVisualForScene } = ctx;
    const idx = Number(action.scene) - 1;

    switch (action.type) {
      case "navigate": {
        const next = action.direction === "previous"
          ? Math.max(0, state.activeIndex - 1)
          : Math.min(state.scenes.length - 1, state.activeIndex + 1);
        selectScene(next);
        return;
      }
      case "select_scene":
        if (idx >= 0 && idx < state.scenes.length) selectScene(idx);
        return;
      case "move_scene_to_start":
        if (idx > 0 && idx < state.scenes.length) {
          const [moved] = state.scenes.splice(idx, 1);
          state.scenes.unshift(moved);
          selectScene(0);
        }
        return;
      case "move_scene": {
        const target = Math.max(0, Math.min(state.scenes.length - 1, Number(action.targetPosition) - 1));
        if (idx >= 0 && idx < state.scenes.length && idx !== target) {
          const [moved] = state.scenes.splice(idx, 1);
          state.scenes.splice(target, 0, moved);
          selectScene(target);
        }
        return;
      }
      case "set_scene_duration":
        if (state.scenes[idx]) {
          state.scenes[idx].duration = Math.max(0.4, Math.min(180, Number(action.seconds)));
        }
        return;
      case "adjust_scene_duration":
        if (state.scenes[idx]) {
          const cur = Number(state.scenes[idx].duration) || 2.5;
          state.scenes[idx].duration = Math.max(0.4, Math.min(180, Math.round((cur + Number(action.delta)) * 10) / 10));
        }
        return;
      case "select_next_alternative": {
        const scene = state.scenes[idx];
        if (scene && Array.isArray(scene.options) && scene.options.length > 0) {
          const curPos = scene.options.findIndex(o => String(o.id) === String(scene.selectedCandidate));
          const nextOpt = scene.options[(curPos + 1) % scene.options.length];
          scene.selectedCandidate = nextOpt.id;
          scene.externalVisual = null;
        }
        return;
      }
      case "search_new_visual":
        if (state.scenes[idx] && typeof searchVisualForScene === "function") {
          await searchVisualForScene(idx, action.query, true);
        }
        return;
      case "set_transition":
        if (state.scenes[idx]) {
          state.scenes[idx].transition = action.transition;
        }
        return;
      case "set_framing":
        if (state.scenes[idx]) {
          state.scenes[idx].framing = {
            scale: Number(action.scale ?? 1.0),
            panX: Number(action.panX ?? 0),
            panY: Number(action.panY ?? 0)
          };
        }
        return;
      case "set_caption":
        if (state.scenes[idx]) {
          state.scenes[idx].text = String(action.text || "");
        }
        return;
      case "set_audio_mix":
        if (typeof action.voiceVolume === "number") state.audioMix.voiceVolume = action.voiceVolume;
        if (typeof action.musicVolume === "number") state.audioMix.musicVolume = action.musicVolume;
        return;
      case "set_pacing": {
        const factor = Number(action.factor) || 1;
        for (const s of state.scenes) {
          s.duration = Math.max(0.5, Math.round((Number(s.duration) || 2.5) * factor * 10) / 10);
        }
        return;
      }
    }
  }

  function initEditorAgent(ctx) {
    const statusBadge = document.getElementById("aiStatusBadge");
    const cmdInput = document.getElementById("aiCommand");
    const sendBtn = document.getElementById("aiSendBtn");
    const proposalBox = document.getElementById("aiProposalBox");
    const proposalReply = document.getElementById("aiProposalReply");
    const proposalList = document.getElementById("aiProposalList");
    const applyBtn = document.getElementById("aiApplyBtn");
    const rejectBtn = document.getElementById("aiRejectBtn");
    const logBox = document.getElementById("aiLog");

    let pendingPlan = null;

    function addLog(role, text) {
      const div = document.createElement("div");
      div.className = "ai-msg " + role;
      div.textContent = text;
      logBox.appendChild(div);
      logBox.scrollTop = logBox.scrollHeight;
    }

    async function checkHealth() {
      try {
        const res = await fetch("/api/editor/agent", { cache: "no-store" });
        const data = await res.json();
        if (data.connected) {
          statusBadge.textContent = "Workers AI Bağlı (" + data.model + ")";
          statusBadge.className = "badge ok";
        } else {
          statusBadge.textContent = "Workers AI Bağlı Değil";
          statusBadge.className = "badge warn";
        }
      } catch {
        statusBadge.textContent = "Ajan Erişilemiyor";
        statusBadge.className = "badge err";
      }
    }

    async function sendCommand() {
      const command = cmdInput.value.trim();
      if (!command) return;
      if (!ctx.state.scenes.length) {
        addLog("system", "Önce bir ses dosyası yükleyip sahnelerin oluşmasını bekleyin.");
        return;
      }

      sendBtn.disabled = true;
      addLog("user", command);
      cmdInput.value = "";

      try {
        const res = await fetch("/api/editor/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command,
            activeScene: ctx.state.activeIndex + 1,
            audioMix: ctx.state.audioMix,
            scenes: ctx.state.scenes.map(s => ({
              text: s.text,
              duration: s.duration,
              transition: s.transition,
              options: s.options || []
            }))
          })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          addLog("system", data.error || "Ajan komutu işleyemedi.");
          return;
        }

        addLog("assistant", data.reply);
        if (Array.isArray(data.actions) && data.actions.length > 0) {
          pendingPlan = data.actions;
          proposalReply.textContent = data.reply;
          proposalList.innerHTML = "";
          for (const act of data.actions) {
            const li = document.createElement("li");
            li.textContent = describeAction(act);
            proposalList.appendChild(li);
          }
          proposalBox.hidden = false;
        } else {
          proposalBox.hidden = true;
          pendingPlan = null;
        }
      } catch (err) {
        addLog("system", "Bağlantı hatası: " + (err?.message || err));
      } finally {
        sendBtn.disabled = false;
      }
    }

    applyBtn.addEventListener("click", async () => {
      if (!pendingPlan) return;
      applyBtn.disabled = true;
      const plan = pendingPlan;
      pendingPlan = null;
      proposalBox.hidden = true;

      for (const action of plan) {
        await applyAction(ctx, action);
      }

      ctx.recomputeTiming();
      ctx.renderAll();
      await ctx.saveDraft();
      addLog("system", "Onaylanan değişiklikler editöre ve bulut taslağına uygulandı.");
      applyBtn.disabled = false;
    });

    rejectBtn.addEventListener("click", () => {
      pendingPlan = null;
      proposalBox.hidden = true;
      addLog("system", "Öneri iptal edildi, projede değişiklik yapılmadı.");
    });

    sendBtn.addEventListener("click", sendCommand);
    cmdInput.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendCommand();
      }
    });

    checkHealth();
  }

  window.initEditorAgent = initEditorAgent;
})();
