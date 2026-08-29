(() => {
  const $ = (id) => document.getElementById(id);
  const keyName = "opencode-manager-admin-key";
  let adminKey = localStorage.getItem(keyName) || "";
  let machines = [];
  let toastTimer;

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#039;"}[char]));
  const api = async (path, options = {}) => {
    const response = await fetch(path, { ...options, headers: { authorization: `Bearer ${adminKey}`, ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) } });
    const text = await response.text();
    let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { error: { message: text } }; }
    if (!response.ok) { const error = new Error(data.error?.message || `请求失败 (${response.status})`); error.status = response.status; throw error; }
    return data;
  };
  const notify = (message) => { $("toast").textContent = message; $("toast").classList.add("visible"); clearTimeout(toastTimer); toastTimer = setTimeout(() => $("toast").classList.remove("visible"), 2600); };
  const setConnection = (online, label) => { $("connection").textContent = label; $("connection").className = `connection ${online ? "online" : "offline"}`; };
  const showAuth = (message = "") => { $("auth-error").textContent = message; $("auth-modal").classList.remove("hidden"); setTimeout(() => $("admin-key").focus(), 0); };
  const statusLabel = (machine) => machine.status === "healthy" ? "健康" : machine.status === "unhealthy" ? "异常" : "待检查";

  function render() {
    const healthy = machines.filter((m) => m.status === "healthy").length;
    const unhealthy = machines.filter((m) => m.status === "unhealthy").length;
    const modelCount = new Set(machines.flatMap((m) => m.models || [])).size;
    $("stat-total").textContent = machines.length; $("stat-healthy").textContent = healthy; $("stat-unhealthy").textContent = unhealthy; $("stat-models").textContent = modelCount;
    $("machines").innerHTML = machines.length ? machines.map((machine) => {
      const state = machine.status || "unknown";
      return `<article class="machine-row"><div class="machine-title"><i class="machine-dot ${escapeHtml(state)}"></i><div><strong>${escapeHtml(machine.name || machine.id)}</strong><small>${escapeHtml(machine.id)}${machine.enabled === false ? " · 已停用" : ""}</small></div></div><div class="machine-url" title="${escapeHtml(machine.baseUrl)}">${escapeHtml(machine.baseUrl)}</div><span class="status ${escapeHtml(state)}">${statusLabel(machine)}</span><div class="models">${(machine.models || []).length} 个模型${machine.latencyMs == null ? "" : ` · ${machine.latencyMs}ms`}</div><div class="row-actions"><button class="button button-ghost" data-action="check" data-id="${escapeHtml(machine.id)}" type="button">检查</button><button class="button button-ghost" data-action="toggle" data-id="${escapeHtml(machine.id)}" type="button">${machine.enabled === false ? "启用" : "停用"}</button><button class="button button-ghost" data-action="edit" data-id="${escapeHtml(machine.id)}" type="button">编辑</button><button class="button button-ghost" data-action="delete" data-id="${escapeHtml(machine.id)}" type="button">删除</button></div></article>`;
    }).join("") : '<div class="empty">暂无机器</div>';
  }

  async function load() {
    if (!adminKey) return showAuth();
    try { const result = await api("/admin/machines"); machines = result.data || []; render(); setConnection(true, "已连接"); $("last-updated").textContent = `最后更新 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`; $("auth-modal").classList.add("hidden"); }
    catch (error) { setConnection(false, "连接失败"); if (error.status === 401) { localStorage.removeItem(keyName); adminKey = ""; showAuth("管理密钥无效"); } else notify(error.message); }
  }
  const openMachine = (machine) => { $("machine-title").textContent = machine ? "编辑机器" : "添加机器"; $("machine-original-id").value = machine?.id || ""; $("machine-id").value = machine?.id || ""; $("machine-id").readOnly = !!machine; $("machine-name").value = machine?.name || ""; $("machine-url").value = machine?.baseUrl || ""; $("machine-key").value = ""; $("machine-weight").value = machine?.weight || 1; $("machine-enabled").checked = machine?.enabled !== false; $("machine-error").textContent = ""; $("machine-modal").classList.remove("hidden"); setTimeout(() => $("machine-name").focus(), 0); };
  const closeMachine = () => $("machine-modal").classList.add("hidden");

  $("auth-form").addEventListener("submit", async (event) => { event.preventDefault(); adminKey = $("admin-key").value.trim(); if (!adminKey) return; localStorage.setItem(keyName, adminKey); await load(); });
  $("refresh").addEventListener("click", load); $("logout").addEventListener("click", () => { localStorage.removeItem(keyName); adminKey = ""; machines = []; render(); setConnection(false, "未连接"); showAuth(); }); $("add-machine").addEventListener("click", () => openMachine()); $("close-machine").addEventListener("click", closeMachine); $("cancel-machine").addEventListener("click", closeMachine);
  $("machines").addEventListener("click", async (event) => { const button = event.target.closest("button[data-action]"); if (!button) return; const machine = machines.find((item) => item.id === button.dataset.id); if (!machine) return; try { if (button.dataset.action === "edit") return openMachine(machine); if (button.dataset.action === "delete") { if (!window.confirm(`确认删除机器「${machine.name || machine.id}」？`)) return; await api(`/admin/machines/${encodeURIComponent(machine.id)}`, { method: "DELETE" }); notify("机器已删除"); } if (button.dataset.action === "check") { await api(`/admin/machines/${encodeURIComponent(machine.id)}/check`, { method: "POST" }); notify("检查完成"); } if (button.dataset.action === "toggle") { const action = machine.enabled === false ? "enable" : "disable"; await api(`/admin/machines/${encodeURIComponent(machine.id)}/${action}`, { method: "POST" }); notify(action === "enable" ? "机器已启用" : "机器已停用"); } await load(); } catch (error) { notify(error.message); } });
  $("machine-form").addEventListener("submit", async (event) => { event.preventDefault(); const originalId = $("machine-original-id").value; const id = $("machine-id").value.trim(); const payload = { name: $("machine-name").value.trim(), baseUrl: $("machine-url").value.trim(), enabled: $("machine-enabled").checked, weight: Number($("machine-weight").value || 1) }; const machineKey = $("machine-key").value.trim(); if (machineKey) payload.apiKey = machineKey; if (!originalId && !machineKey) return $("machine-error").textContent = "新机器必须填写 API Key"; try { await api(`/admin/machines/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(payload) }); closeMachine(); notify("机器配置已保存"); await load(); } catch (error) { $("machine-error").textContent = error.message; } });
  render(); load(); setInterval(load, 15000);
})();
