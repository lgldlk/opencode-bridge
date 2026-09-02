(() => {
  const $ = (id) => document.getElementById(id);
  const keyName = "opencode-manager-admin-key";
  let adminKey = localStorage.getItem(keyName) || "";
  let machines = [];
  let routing = { strategy: "quota_failover", rateLimitCooldownMs: 60 * 60 * 1000 };
  let usage = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, machines: [] };
  let usageRaw = null;
  const todayStr = () => new Date().toISOString().slice(0,10);
  const yesterdayStr = () => { const d=new Date(); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); };
  let usageFilter = { range: "today", date: todayStr() };
  let requestRecords = { data: [], total: 0 };
  const requestPage = { limit: 50, offset: 0 };
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
  const formatRemaining = (milliseconds) => {
    const minutes = Math.max(1, Math.ceil(milliseconds / 60000));
    return minutes >= 60 ? `${Math.ceil(minutes / 60)} 小时冷却` : `${minutes} 分钟冷却`;
  };
  const statusLabel = (machine) => machine.cooldownRemainingMs > 0 ? formatRemaining(machine.cooldownRemainingMs) : machine.status === "healthy" ? "健康" : machine.status === "unhealthy" ? "异常" : "待检查";
  const formatNumber = (value) => new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
  const formatTokens = (value) => {
    const n = Number(value) || 0;
    const fmt = (v) => {
      const s = v>=100?Math.round(v).toString():v>=10?v.toFixed(1):v.toFixed(2);
      return parseFloat(s).toString();
    };
    if (n >= 1e9) return fmt(n/1e9)+"B";
    if (n >= 1e6) return fmt(n/1e6)+"M";
    if (n >= 1e3) return fmt(n/1e3)+"K";
    return formatNumber(n);
  };
  const formatTime = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";

  const tabNames = new Set(["overview", "usage", "requests", "routing", "machines", "guide"]);
  function activateTab(name, updateHash = true) {
    const tab = tabNames.has(name) ? name : "overview";
    document.querySelectorAll(".tab-button").forEach((button) => {
      const active = button.dataset.tabTarget === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll(".dashboard-content>[data-tab]").forEach((panel) => {
      panel.classList.toggle("tab-visible", panel.dataset.tab === tab);
    });
    if (updateHash && location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
  }
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => activateTab(button.dataset.tabTarget));
  });
  document.querySelector('a[href="#guide"]')?.addEventListener("click", (event) => {
    event.preventDefault();
    activateTab("guide");
  });
  window.addEventListener("hashchange", () => activateTab(location.hash.slice(1), false));
  activateTab(location.hash.slice(1), false);

  function computeFilteredUsage(raw, filter){
    if (!raw) return raw;
    const inRange = (day) => {
      if (filter.range === "30d") return true;
      if (filter.range === "7d") { const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-6); const c=cutoff.toISOString().slice(0,10); return day >= c; }
      return day === filter.date;
    };
    const filteredMachines = (raw.machines || []).map(m => {
      const d = (m.daily || []).filter(x => inRange(x.day));
      if (d.length === 0 && (filter.range === "today" || filter.range === "yesterday" || filter.range === "custom")) return { ...m, requests:0, inputTokens:0, outputTokens:0, cacheReadTokens:0, cacheWriteTokens:0, totalTokens:0, daily:d };
      const sum = d.reduce((a,b)=>({requests:(a.requests||0)+(b.requests||0), inputTokens:(a.inputTokens||0)+(b.inputTokens||0), outputTokens:(a.outputTokens||0)+(b.outputTokens||0), cacheReadTokens:(a.cacheReadTokens||0)+(b.cacheReadTokens||0), cacheWriteTokens:(a.cacheWriteTokens||0)+(b.cacheWriteTokens||0), totalTokens:(a.totalTokens||0)+(b.totalTokens||0)}), {requests:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,totalTokens:0});
      return { ...m, ...sum, daily:d };
    });
    const totals = filteredMachines.reduce((a,m)=>({requests:a.requests+(m.requests||0), inputTokens:a.inputTokens+(m.inputTokens||0), outputTokens:a.outputTokens+(m.outputTokens||0), cacheReadTokens:a.cacheReadTokens+(m.cacheReadTokens||0), cacheWriteTokens:a.cacheWriteTokens+(m.cacheWriteTokens||0), totalTokens:a.totalTokens+(m.totalTokens||0)}), {requests:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,totalTokens:0});
    const filteredDaily = (raw.daily || []).filter(x => inRange(x.day));
    // keep all machines for 7d/30d, but filter out zero for single day
    const finalMachines = (filter.range === "today" || filter.range === "yesterday" || filter.range === "custom") ? filteredMachines.filter(m=>m.requests>0) : filteredMachines;
    return { ...raw, ...totals, machines: finalMachines, daily: filteredDaily };
  }
  function renderUsage() {
    const filtered = computeFilteredUsage(usageRaw || usage, usageFilter);
    const view = filtered || usage;
    const meta = document.getElementById("usage-filter-meta");
    if (meta) {
      const label = usageFilter.range==="today" ? `今日 · ${usageFilter.date}` : usageFilter.range==="yesterday" ? `昨日 · ${usageFilter.date}` : usageFilter.range==="7d" ? "近7天" : usageFilter.range==="30d" ? "近30天" : usageFilter.date;
      meta.textContent = label;
    }
    const activeUsage = view;
    $("usage-total").textContent = formatTokens(activeUsage.totalTokens); $("usage-total").title = formatNumber(activeUsage.totalTokens);
    $("usage-input").textContent = formatTokens(activeUsage.inputTokens); $("usage-input").title = formatNumber(activeUsage.inputTokens);
    $("usage-output").textContent = formatTokens(activeUsage.outputTokens); $("usage-output").title = formatNumber(activeUsage.outputTokens);
    $("usage-cache-read").textContent = formatTokens(activeUsage.cacheReadTokens); $("usage-cache-read").title = formatNumber(activeUsage.cacheReadTokens);
    $("usage-cache-write").textContent = formatTokens(activeUsage.cacheWriteTokens); $("usage-cache-write").title = formatNumber(activeUsage.cacheWriteTokens);
    const cacheBase = (Number(activeUsage.inputTokens) || 0) + (Number(usage.cacheReadTokens) || 0);
    const labelEl = document.getElementById("usage-range-label"); if(labelEl){ labelEl.textContent = usageFilter.range==="today"?"今日":usageFilter.range==="yesterday"?"昨日":usageFilter.range==="7d"?"近7天":usageFilter.range==="30d"?"近30天":usageFilter.date; }
    const cacheRate = cacheBase > 0 ? ((Number(activeUsage.cacheReadTokens) || 0) / cacheBase) * 100 : 0;
    $("usage-cache-rate").textContent = `${cacheRate.toFixed(1)}%`;
    $("usage-requests").textContent = formatNumber(activeUsage.requests);
    $("usage-updated").textContent = activeUsage.machines?.length ? `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}` : "暂无数据";
    const rows = (activeUsage.machines || []).filter((machine) => machine.requests > 0);
    $("usage-machines").innerHTML = rows.length ? rows.map((machine) => `<tr><td>${escapeHtml(machine.name || machine.id)}<small> ${escapeHtml(machine.id)}</small></td><td>${formatNumber(machine.requests)}</td><td title="${formatNumber(machine.inputTokens)}">${formatTokens(machine.inputTokens)}</td><td title="${formatNumber(machine.outputTokens)}">${formatTokens(machine.outputTokens)}</td><td title="${formatNumber(machine.cacheReadTokens)}">${formatTokens(machine.cacheReadTokens)}</td><td title="${formatNumber(machine.cacheWriteTokens)}">${formatTokens(machine.cacheWriteTokens)}</td><td title="${formatNumber(machine.totalTokens)}">${formatTokens(machine.totalTokens)}</td><td>${escapeHtml(formatTime(machine.lastRequestAt))}</td></tr>`).join("") : '<tr><td colspan="8" class="usage-empty">暂无用量数据</td></tr>';
    const dailyRows = (activeUsage.machines || []).flatMap((machine) => (machine.daily || []).map((day) => ({ ...day, machine })));
    dailyRows.sort((a, b) => b.day.localeCompare(a.day) || String(a.machine.id).localeCompare(String(b.machine.id)));
    $("usage-daily").innerHTML = dailyRows.length ? dailyRows.map((item) => `<tr><td>${escapeHtml(item.day)}</td><td>${escapeHtml(item.machine.name || item.machine.id)}<small> ${escapeHtml(item.machine.id)}</small></td><td>${formatNumber(item.requests)}</td><td title="${formatNumber(item.inputTokens)}">${formatTokens(item.inputTokens)}</td><td title="${formatNumber(item.outputTokens)}">${formatTokens(item.outputTokens)}</td><td title="${formatNumber(item.cacheReadTokens)}">${formatTokens(item.cacheReadTokens)}</td><td title="${formatNumber(item.cacheWriteTokens)}">${formatTokens(item.cacheWriteTokens)}</td><td title="${formatNumber(item.totalTokens)}">${formatTokens(item.totalTokens)}</td></tr>`).join("") : '<tr><td colspan="8" class="usage-empty">暂无每日数据</td></tr>';
  }

  function renderRequests() {
    const total = Number(requestRecords.total) || 0;
    const limit = Number(requestRecords.limit) || requestPage.limit;
    const offset = Number(requestRecords.offset) || requestPage.offset;
    const count = (requestRecords.data || []).length;
    const start = total ? offset + 1 : 0;
    const end = total ? Math.min(offset + count, total) : 0;
    $("requests-meta").textContent = `最近 30 天 · ${formatNumber(total)} 条`;
    $("request-total-usage").textContent = formatTokens(usage.totalTokens); $("request-total-usage").title = formatNumber(usage.totalTokens);
    $("request-total-count").textContent = formatNumber(usage.requests || requestRecords.total);
    const rows = requestRecords.data || [];
    const status = { started: "进行中", success: "成功", rate_limited: "限流", timeout: "超时", aborted: "中断", error: "失败", empty_response: "空响应" };
    const cell = (label, value, className = "") => `<td${className ? ` class="${className}"` : ""} data-label="${label}">${value}</td>`;
    $("request-records").innerHTML = rows.length ? rows.map((item) => `<tr>${cell("时间", escapeHtml(formatTime(item.requestedAt)), "request-time")}${cell("机器", escapeHtml(item.machineId))}${cell("模型", escapeHtml(item.model || "—"), "request-model")}${cell("状态", `<span class="request-status ${escapeHtml(item.status)}">${escapeHtml(status[item.status] || item.status)}</span>`, "request-state")}${cell("输入", `<span title="${formatNumber(item.inputTokens)}">${formatTokens(item.inputTokens)}</span>`)}${cell("输出", `<span title="${formatNumber(item.outputTokens)}">${formatTokens(item.outputTokens)}</span>`)}${cell("缓存读", `<span title="${formatNumber(item.cacheReadTokens)}">${formatTokens(item.cacheReadTokens)}</span>`)}${cell("缓存写", `<span title="${formatNumber(item.cacheWriteTokens)}">${formatTokens(item.cacheWriteTokens)}</span>`)}${cell("总 Token", `<span title="${formatNumber(item.totalTokens)}">${formatTokens(item.totalTokens)}</span>`, "request-total")}</tr>`).join("") : '<tr><td colspan="9" class="usage-empty">暂无调用记录</td></tr>';
    $("requests-page-info").textContent = `显示 ${formatNumber(start)}–${formatNumber(end)} / 共 ${formatNumber(total)} 条`;
    $("requests-prev").disabled = offset <= 0;
    $("requests-next").disabled = offset + count >= total || count === 0;
    requestPage.limit = limit;
    requestPage.offset = offset;
  }

  function render() {
    const healthy = machines.filter((m) => m.status === "healthy").length;
    const unhealthy = machines.filter((m) => m.status === "unhealthy").length;
    const modelCount = new Set(machines.flatMap((m) => m.models || [])).size;
    $("stat-total").textContent = machines.length; $("stat-healthy").textContent = healthy; $("stat-unhealthy").textContent = unhealthy; $("stat-models").textContent = modelCount;
    const fc = document.getElementById("fleet-count"); if (fc) fc.textContent = `${machines.length} 台`;
    $("machines").innerHTML = machines.length ? machines.map((machine) => {
      const state = machine.cooldownRemainingMs > 0 ? "cooling_down" : machine.status || "unknown";
      return `<article class="machine-row"><div class="machine-title"><i class="machine-dot ${escapeHtml(state)}"></i><div><strong>${escapeHtml(machine.name || machine.id)}</strong><small>${escapeHtml(machine.id)}${machine.enabled === false ? " · 已停用" : ""}</small></div></div><div class="machine-url" title="${escapeHtml(machine.baseUrl)}">${escapeHtml(machine.baseUrl)}</div><span class="status ${escapeHtml(state)}">${statusLabel(machine)}</span><div class="models">${(machine.models || []).length} 个模型${machine.latencyMs == null ? "" : ` · ${machine.latencyMs}ms`}</div><div class="row-actions"><button class="btn btn-ghost btn-sm" data-action="check" data-id="${escapeHtml(machine.id)}" type="button">检查</button><button class="btn btn-ghost btn-sm" data-action="toggle" data-id="${escapeHtml(machine.id)}" type="button">${machine.enabled === false ? "启用" : "停用"}</button><button class="btn btn-ghost btn-sm" data-action="edit" data-id="${escapeHtml(machine.id)}" type="button">编辑</button><button class="btn btn-ghost btn-sm" data-action="delete" data-id="${escapeHtml(machine.id)}" type="button">删除</button></div></article>`;
    }).join("") : '<div class="empty">暂无机器</div>';
  }

  async function load() {
    if (!adminKey) return showAuth();
    try {
      // Core machine/routing data keeps the console usable during a rolling
      // upgrade. Usage and request endpoints are optional for older managers.
      const [machineResult, routingResult] = await Promise.all([api("/admin/machines"), api("/admin/routing")]);
      const [usageResult, requestResult] = await Promise.allSettled([api("/admin/usage?days=30"), api(`/admin/requests?days=30&limit=${requestPage.limit}&offset=${requestPage.offset}`)]);
      machines = machineResult.data || [];
      routing = routingResult;
      if (usageResult.status === "fulfilled") { usage = usageResult.value || usage; try{ usageRaw = JSON.parse(JSON.stringify(usage)); }catch(e){ usageRaw = usage; } }
      if (requestResult.status === "fulfilled") requestRecords = requestResult.value || requestRecords;
      $("routing-strategy").value = routing.strategy;
      $("routing-cooldown-minutes").value = Math.max(1, Math.round(routing.rateLimitCooldownMs / 60000));
      const strategyLabels = { round_robin: "自动轮询", random: "随机", quota_failover: "额度用尽后切换" };
      $("hero-strategy").textContent = strategyLabels[routing.strategy] || routing.strategy;
      $("hero-cooldown").textContent = `${Math.max(1, Math.round(routing.rateLimitCooldownMs / 60000))}m`;
      const hsDup = document.getElementById("hero-strategy-dup"); if (hsDup) hsDup.textContent = strategyLabels[routing.strategy] || routing.strategy;
      const hcDup = document.getElementById("hero-cooldown-dup"); if (hcDup) hcDup.textContent = `${Math.max(1, Math.round(routing.rateLimitCooldownMs / 60000))} 分钟`;
      render(); renderUsage(); renderRequests(); setConnection(true, "已连接");
      $("last-updated").textContent = `最后更新 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
      $("auth-modal").classList.add("hidden");
    } catch (error) { setConnection(false, "连接失败"); if (error.status === 401) { localStorage.removeItem(keyName); adminKey = ""; showAuth("管理密钥无效"); } else notify(error.message); }
  }
  const openMachine = (machine) => { $("machine-title").textContent = machine ? "编辑机器" : "添加机器"; $("machine-original-id").value = machine?.id || ""; $("machine-id").value = machine?.id || ""; $("machine-id").readOnly = !!machine; $("machine-name").value = machine?.name || ""; $("machine-url").value = machine?.baseUrl || ""; $("machine-key").value = ""; $("machine-weight").value = machine?.weight || 1; $("machine-enabled").checked = machine?.enabled !== false; $("machine-error").textContent = ""; $("machine-modal").classList.remove("hidden"); setTimeout(() => $("machine-name").focus(), 0); };
  const closeMachine = () => $("machine-modal").classList.add("hidden");

  $("auth-form").addEventListener("submit", async (event) => { event.preventDefault(); adminKey = $("admin-key").value.trim(); if (!adminKey) return; localStorage.setItem(keyName, adminKey); await load(); });
  $("routing-form").addEventListener("submit", async (event) => { event.preventDefault(); const error = $("routing-error"); error.textContent = ""; const minutes = Number($("routing-cooldown-minutes").value); if (!Number.isFinite(minutes) || minutes < 1) return error.textContent = "冷却时间至少为 1 分钟"; try { routing = await api("/admin/routing", { method: "PUT", body: JSON.stringify({ strategy: $("routing-strategy").value, rateLimitCooldownMs: Math.round(minutes * 60000) }) }); notify("调用策略已保存"); await load(); } catch (requestError) { error.textContent = requestError.message; } });
  $("refresh").addEventListener("click", load); $("logout").addEventListener("click", () => { localStorage.removeItem(keyName); adminKey = ""; machines = []; render(); setConnection(false, "未连接"); showAuth(); }); $("add-machine").addEventListener("click", () => openMachine()); $("close-machine").addEventListener("click", closeMachine); $("cancel-machine").addEventListener("click", closeMachine);
  $("requests-prev").addEventListener("click", async () => { if (requestPage.offset <= 0) return; requestPage.offset = Math.max(0, requestPage.offset - requestPage.limit); await load(); });
  $("requests-next").addEventListener("click", async () => { if (requestPage.offset + (requestRecords.data || []).length >= Number(requestRecords.total || 0)) return; requestPage.offset += requestPage.limit; await load(); });
  $("machines").addEventListener("click", async (event) => { const button = event.target.closest("button[data-action]"); if (!button) return; const machine = machines.find((item) => item.id === button.dataset.id); if (!machine) return; try { if (button.dataset.action === "edit") return openMachine(machine); if (button.dataset.action === "delete") { if (!window.confirm(`确认删除机器「${machine.name || machine.id}」？`)) return; await api(`/admin/machines/${encodeURIComponent(machine.id)}`, { method: "DELETE" }); notify("机器已删除"); } if (button.dataset.action === "check") { await api(`/admin/machines/${encodeURIComponent(machine.id)}/check`, { method: "POST" }); notify("检查完成"); } if (button.dataset.action === "toggle") { const action = machine.enabled === false ? "enable" : "disable"; await api(`/admin/machines/${encodeURIComponent(machine.id)}/${action}`, { method: "POST" }); notify(action === "enable" ? "机器已启用" : "机器已停用"); } await load(); } catch (error) { notify(error.message); } });
  $("machine-form").addEventListener("submit", async (event) => { event.preventDefault(); const originalId = $("machine-original-id").value; const id = $("machine-id").value.trim(); const payload = { name: $("machine-name").value.trim(), baseUrl: $("machine-url").value.trim(), enabled: $("machine-enabled").checked, weight: Number($("machine-weight").value || 1) }; const machineKey = $("machine-key").value.trim(); if (machineKey) payload.apiKey = machineKey; if (!originalId && !machineKey) return $("machine-error").textContent = "新机器必须填写 API Key"; try { await api(`/admin/machines/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(payload) }); closeMachine(); notify("机器配置已保存"); await load(); } catch (error) { $("machine-error").textContent = error.message; } });
  // usage date filter listeners
  const dateInput = document.getElementById("usage-date-input");
  if (dateInput) {
    dateInput.value = usageFilter.date;
    dateInput.addEventListener("change", () => {
      usageFilter.range = "custom";
      usageFilter.date = dateInput.value || todayStr();
      document.querySelectorAll(".seg-btn").forEach(b=>b.classList.remove("active"));
      renderUsage();
    });
  }
  document.querySelectorAll(".seg-btn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      document.querySelectorAll(".seg-btn").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      const r = btn.dataset.range;
      if (r==="today") { usageFilter.range="today"; usageFilter.date=todayStr(); if(dateInput) dateInput.value=usageFilter.date; }
      else if (r==="yesterday") { usageFilter.range="yesterday"; usageFilter.date=yesterdayStr(); if(dateInput) dateInput.value=usageFilter.date; }
      else if (r==="7d") usageFilter.range="7d";
      else if (r==="30d") usageFilter.range="30d";
      renderUsage();
    });
  });
  render(); load(); setInterval(load, 15000);
})();
