// ContestLog Helper — frontend logic.
//
// This script talks to the Go backend through Wails' window.go bindings and
// listens for backend events (phase changes, log lines, rigctld parameters,
// connection status) via window.runtime.EventsOn.

const PHASES = [
  {
    id: "baud",
    label: "Testing baud rate",
    // tabler-icons "gauge"
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M13.41 10.59l2.59 -2.59"/><path d="M7 12a5 5 0 0 1 8 -4"/></svg>',
  },
  {
    id: "connecting",
    label: "Connecting",
    // tabler-icons "plug-connected"
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 12l5 -5"/><path d="M17 12l-5 5"/><path d="M3 21l3 -3"/><path d="M18 6l3 -3"/><path d="M5.5 13.5l5 5"/><path d="M13.5 5.5l5 5"/></svg>',
  },
  {
    id: "connected",
    label: "Connected",
    // tabler-icons "circle-check"
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 12l2 2l4 -4"/></svg>',
  },
];

// ---- DOM ----------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const phaseListEl    = $("phase-list");
const phaseMessageEl = $("phase-message");
const logEl          = $("log");
const profileSelect  = $("profile-select");
const versionEl      = $("version");

const cfgEls = {
  name:        $("cfg-name"),
  server:      $("cfg-server"),
  token:       $("cfg-token"),
  rigName:     $("cfg-rig-name"),
  rigModel:    $("cfg-rig-model"),          // hidden input — stores model number
  rigModelSearch: $("cfg-rig-model-search"), // visible combobox text field
  rigModelCustom: $("cfg-rig-model-custom"),
  rigDevice:   $("cfg-rig-device"),
  rigDeviceCustom: $("cfg-rig-device-custom"),
  rigSpeed:    $("cfg-rig-speed"),
  rigctldBin:  $("cfg-rigctld-bin"),
  interval:    $("cfg-interval"),
  autoDetect:  $("auto-detect"),
};

// State -------------------------------------------------------------------
let profileStore = { profiles: [], last_used: "" };
let detectedPorts = [];
let allRigs = [];

// ---- Rig model combobox -------------------------------------------------
let comboOpen = false;
let comboHighlighted = -1;
const rigListEl = $("cfg-rig-model-list");

function filterRigs(query) {
  if (!query.trim()) return allRigs;
  const lower = query.toLowerCase();
  return allRigs.filter(r =>
    r.label.toLowerCase().includes(lower) ||
    r.vendor.toLowerCase().includes(lower) ||
    String(r.model).includes(lower)
  );
}

function rigLabel(r) {
  return `${r.label} (${r.vendor}, model ${r.model})`;
}

function renderRigList(query) {
  rigListEl.innerHTML = "";
  comboHighlighted = -1;
  const matches = filterRigs(query);
  const show = matches.slice(0, 100);
  for (const r of show) {
    const li = document.createElement("li");
    li.dataset.model = String(r.model);
    li.dataset.label = rigLabel(r);
    li.setAttribute("role", "option");
    li.innerHTML =
      `<span class="combo-vendor">${escapeHtml(r.vendor)}</span>` +
      ` ${escapeHtml(r.label)}` +
      `<span class="combo-num">#${r.model}</span>`;
    rigListEl.appendChild(li);
  }
  if (matches.length > 100) {
    const li = document.createElement("li");
    li.className = "combo-hint";
    li.textContent = `Showing 100 of ${matches.length} — type more to narrow down`;
    rigListEl.appendChild(li);
  } else if (matches.length === 0) {
    const li = document.createElement("li");
    li.className = "combo-hint";
    li.textContent = "No matching rigs — use Custom model # below for unlisted models";
    rigListEl.appendChild(li);
  }
}

function openRigCombo() {
  if (comboOpen) return;
  renderRigList(cfgEls.rigModelSearch.value);
  rigListEl.hidden = false;
  comboOpen = true;
}
function closeRigCombo() {
  rigListEl.hidden = true;
  comboOpen = false;
  comboHighlighted = -1;
}
function highlightRigItem(index) {
  const items = [...rigListEl.querySelectorAll("li[data-model]")];
  items.forEach(li => li.classList.remove("combo-active"));
  if (index >= 0 && index < items.length) {
    items[index].classList.add("combo-active");
    items[index].scrollIntoView({ block: "nearest" });
    comboHighlighted = index;
  } else {
    comboHighlighted = -1;
  }
}
function commitRigSelection(model, label) {
  cfgEls.rigModel.value = String(model);
  cfgEls.rigModelSearch.value = label;
  cfgEls.rigModelCustom.value = "";
  closeRigCombo();
}

cfgEls.rigModelSearch.addEventListener("focus", () => openRigCombo());
cfgEls.rigModelSearch.addEventListener("input", () => {
  cfgEls.rigModel.value = "";   // clear until user picks from list
  renderRigList(cfgEls.rigModelSearch.value);
  if (!comboOpen) { rigListEl.hidden = false; comboOpen = true; }
});
cfgEls.rigModelSearch.addEventListener("keydown", (e) => {
  const items = [...rigListEl.querySelectorAll("li[data-model]")];
  if (e.key === "ArrowDown") {
    e.preventDefault();
    openRigCombo();
    highlightRigItem(Math.min(comboHighlighted + 1, items.length - 1));
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    highlightRigItem(Math.max(comboHighlighted - 1, 0));
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (comboHighlighted >= 0 && comboHighlighted < items.length) {
      const li = items[comboHighlighted];
      commitRigSelection(li.dataset.model, li.dataset.label);
    } else {
      closeRigCombo();
    }
  } else if (e.key === "Escape") {
    closeRigCombo();
  }
});
rigListEl.addEventListener("mousedown", (e) => {
  const li = e.target.closest("li[data-model]");
  if (!li) return;
  e.preventDefault(); // keep focus on input
  commitRigSelection(li.dataset.model, li.dataset.label);
});
document.addEventListener("click", (e) => {
  if (!$("rig-model-combobox").contains(e.target)) closeRigCombo();
});

// ---- Phase rendering ----------------------------------------------------
function renderPhases() {
  phaseListEl.innerHTML = "";
  for (const p of PHASES) {
    const li = document.createElement("li");
    li.className = "phase idle";
    li.dataset.phase = p.id;
    li.innerHTML = `
      <span class="phase-icon" aria-hidden="true">${p.svg}</span>
      <span class="phase-label">${p.label}</span>
    `;
    phaseListEl.appendChild(li);
  }
}
function setPhaseState(phaseId, state, message) {
  const el = phaseListEl.querySelector(`[data-phase="${phaseId}"]`);
  if (!el) return;
  el.classList.remove("idle", "active", "done", "error", "skipped");
  el.classList.add(state);
  if (message) {
    phaseMessageEl.textContent = message;
    phaseMessageEl.classList.toggle("error", state === "error");
  }
}
function resetPhases() {
  for (const p of PHASES) setPhaseState(p.id, "idle", "");
  phaseMessageEl.textContent = "Click Connect to start.";
  phaseMessageEl.classList.remove("error");
  $("readout-card").classList.add("hidden");
}

// ---- Log ----------------------------------------------------------------
function appendLog(line, isErr = false) {
  const ts = new Date().toLocaleTimeString();
  const span = document.createElement("span");
  if (isErr) span.className = "err";
  span.textContent = `[${ts}] ${line}\n`;
  logEl.appendChild(span);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---- Profile management -------------------------------------------------
function refreshProfileSelect() {
  const cur = profileSelect.value;
  profileSelect.innerHTML = '<option value="">— new profile —</option>';
  for (const p of profileStore.profiles || []) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.name;
    profileSelect.appendChild(opt);
  }
  const want = cur || profileStore.last_used || "";
  if (want && [...profileSelect.options].some(o => o.value === want)) {
    profileSelect.value = want;
  } else {
    profileSelect.value = "";
  }
}
function applyProfileToForm(p) {
  cfgEls.name.value      = p.name || "";
  cfgEls.server.value    = p.server || "http://localhost:8080";
  cfgEls.token.value     = p.token || "";
  cfgEls.rigName.value   = p.rig_name || "";
  applyRigModel(p.rig_model || 0);
  selectOrCustom(cfgEls.rigDevice, cfgEls.rigDeviceCustom, p.rig_device || "");
  cfgEls.rigSpeed.value  = String(p.rig_speed || 0);
  cfgEls.rigctldBin.value = p.rigctld_bin || "";
  cfgEls.interval.value  = String(p.interval_ms || 1000);
  cfgEls.autoDetect.checked = !!p.auto_detect;
}
function applyRigModel(value) {
  if (!value) {
    cfgEls.rigModel.value = "";
    cfgEls.rigModelSearch.value = "";
    cfgEls.rigModelCustom.value = "";
    return;
  }
  const target = String(value);
  const rig = allRigs.find(r => String(r.model) === target);
  if (rig) {
    cfgEls.rigModel.value = target;
    cfgEls.rigModelSearch.value = rigLabel(rig);
    cfgEls.rigModelCustom.value = "";
  } else {
    cfgEls.rigModel.value = "";
    cfgEls.rigModelSearch.value = "";
    cfgEls.rigModelCustom.value = target;
  }
}
function selectOrCustom(selectEl, customEl, value) {
  if (value === 0 || value === "") {
    selectEl.value = "";
    customEl.value = "";
    return;
  }
  const target = String(value);
  const matches = [...selectEl.options].some(o => o.value === target);
  if (matches) {
    selectEl.value = target;
    customEl.value = "";
  } else {
    selectEl.value = "";
    customEl.value = target;
  }
}
function readForm() {
  const modelFromSelect = parseInt(cfgEls.rigModel.value || "0", 10) || 0;
  const modelFromCustom = parseInt(cfgEls.rigModelCustom.value || "0", 10) || 0;
  const deviceFromSelect = cfgEls.rigDevice.value || "";
  const deviceFromCustom = cfgEls.rigDeviceCustom.value || "";
  return {
    name:        cfgEls.name.value.trim(),
    server:      cfgEls.server.value.trim(),
    token:       cfgEls.token.value,
    rig_name:    cfgEls.rigName.value.trim(),
    rig_model:   modelFromCustom || modelFromSelect,
    rig_device:  deviceFromCustom || deviceFromSelect,
    rig_speed:   parseInt(cfgEls.rigSpeed.value || "0", 10) || 0,
    rigctld_bin: cfgEls.rigctldBin.value.trim(),
    interval_ms: parseInt(cfgEls.interval.value || "1000", 10) || 1000,
    auto_detect: cfgEls.autoDetect.checked,
  };
}

// ---- Backend wiring -----------------------------------------------------
const Backend = window.go && window.go.main && window.go.main.App;
const Runtime = window.runtime;

async function loadInitialState() {
  if (!Backend) return; // running in a plain browser preview
  versionEl.textContent = "v" + (await Backend.Version());
  detectedPorts = (await Backend.DetectPorts()) || [];
  allRigs = (await Backend.AllRigs()) || [];

  // Populate serial device dropdown.
  cfgEls.rigDevice.innerHTML = '<option value="">— pick or type below —</option>';
  for (const dev of detectedPorts) {
    const opt = document.createElement("option");
    opt.value = dev;
    opt.textContent = dev;
    cfgEls.rigDevice.appendChild(opt);
  }

  cfgEls.rigctldBin.value = await Backend.DefaultRigctldBin();

  profileStore = (await Backend.LoadProfiles()) || { profiles: [] };
  refreshProfileSelect();
  if (profileStore.last_used) {
    const p = (profileStore.profiles || []).find(x => x.name === profileStore.last_used);
    if (p) applyProfileToForm(p);
  } else {
    applyProfileToForm({ server: "http://localhost:8080", auto_detect: true, interval_ms: 1000 });
  }

  // Reflect current daemon state on window reopen.
  const running = await Backend.IsRunning();
  setConnectedUI(running);
}

function setConnectedUI(running) {
  $("btn-connect").disabled = running;
  $("btn-disconnect").disabled = !running;
}

if (Runtime) {
  Runtime.EventsOn("phase", (ev) => {
    setPhaseState(ev.phase, ev.state, ev.message || "");
  });
  Runtime.EventsOn("log", (msg) => appendLog(String(msg)));
  Runtime.EventsOn("rigctld-params", (p) => {
    const body = $("readout-body");
    body.innerHTML = "";
    const rows = [
      ["Binary", p.binary || ""],
      ["Rig", p.rig_label ? `${p.rig_label} (model ${p.model})` : `model ${p.model}`],
      ["Device", p.device || "(default)"],
      ["Baud rate", p.speed ? `${p.speed} baud` : "(default)"],
      ["Listen", `${p.host}:${p.port}`],
      ["Argv", `${p.binary} ${p.args}`],
    ];
    for (const [k, v] of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="k">${k}</td><td class="v">${escapeHtml(v)}</td>`;
      body.appendChild(tr);
    }
    $("readout-card").classList.remove("hidden");
  });
  Runtime.EventsOn("status", (ev) => {
    setConnectedUI(!!ev.running);
    if (ev.error) appendLog("error: " + ev.error, true);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// ---- Buttons ------------------------------------------------------------
$("btn-connect").addEventListener("click", async () => {
  if (!Backend) return;
  const cfg = readForm();
  if (!cfg.server)   return appendLog("server URL is required", true);
  if (!cfg.token)    return appendLog("helper token is required", true);
  if (!cfg.rig_name) return appendLog("rig display name is required", true);
  if (!cfg.rig_model) return appendLog("rig model is required — pick one from the list", true);
  if (!cfg.rig_device) return appendLog("serial device is required", true);
  if (!cfg.auto_detect && !cfg.rig_speed) {
    return appendLog("baud rate is required when auto-detect is off", true);
  }
  resetPhases();
  try {
    await Backend.Connect(cfg);
    appendLog("connect requested");
  } catch (err) {
    appendLog("connect failed: " + err, true);
  }
});

$("btn-disconnect").addEventListener("click", async () => {
  if (!Backend) return;
  await Backend.Disconnect();
  appendLog("disconnect requested");
});

$("btn-clear-log").addEventListener("click", () => { logEl.innerHTML = ""; });

profileSelect.addEventListener("change", () => {
  const name = profileSelect.value;
  if (!name) {
    applyProfileToForm({ server: "http://localhost:8080", auto_detect: true, interval_ms: 1000 });
    return;
  }
  const p = (profileStore.profiles || []).find(x => x.name === name);
  if (p) {
    applyProfileToForm(p);
    if (Backend) Backend.SetLastProfile(p.name);
  }
});

$("btn-new-profile").addEventListener("click", () => {
  profileSelect.value = "";
  applyProfileToForm({ server: "http://localhost:8080", auto_detect: true, interval_ms: 1000 });
  cfgEls.name.focus();
});

$("btn-save-profile").addEventListener("click", async () => {
  if (!Backend) return;
  const cfg = readForm();
  if (!cfg.name) {
    appendLog("set a profile name before saving", true);
    cfgEls.name.focus();
    return;
  }
  try {
    profileStore = await Backend.SaveProfile(cfg);
    refreshProfileSelect();
    profileSelect.value = cfg.name;
    appendLog(`profile "${cfg.name}" saved`);
  } catch (err) {
    appendLog("save failed: " + err, true);
  }
});

$("btn-delete-profile").addEventListener("click", async () => {
  if (!Backend) return;
  const name = profileSelect.value;
  if (!name) return;
  if (!confirm(`Delete profile "${name}"?`)) return;
  profileStore = await Backend.DeleteProfile(name);
  refreshProfileSelect();
  applyProfileToForm({ server: "http://localhost:8080", auto_detect: true, interval_ms: 1000 });
  appendLog(`profile "${name}" deleted`);
});

// ---- Boot ---------------------------------------------------------------
renderPhases();
resetPhases();
loadInitialState().catch(err => appendLog("init: " + err, true));
