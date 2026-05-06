// ContestLog frontend
(() => {
  const MODES = ['CW', 'SSB', 'USB', 'LSB', 'FM', 'AM', 'RTTY', 'FT8', 'FT4', 'PSK31', 'PSK63', 'JT65', 'DIGI'];
  const BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '4m', '2m', '70cm', '23cm'];

  // ----- geo utilities -----

  // Simplified continent polygons [[lon, lat], …]
  const WORLD = [
    [[-170,71],[-140,70],[-120,68],[-100,70],[-80,62],[-65,47],[-67,45],[-70,43],[-75,44],[-82,42],[-88,42],[-88,29],[-92,29],[-97,28],[-97,20],[-90,18],[-85,16],[-83,10],[-79,9],[-75,10],[-72,12],[-60,11],[-62,10],[-67,11],[-75,10],[-80,9],[-85,11],[-88,16],[-95,22],[-105,20],[-110,25],[-117,32],[-122,37],[-125,48],[-130,54],[-138,59],[-148,61],[-160,60],[-168,58],[-170,65],[-170,71]],
    [[-55,60],[-45,58],[-42,64],[-35,70],[-20,80],[-15,83],[0,83],[15,81],[33,74],[25,70],[0,74],[-20,72],[-28,68],[-40,65],[-48,62],[-55,60]],
    [[-80,10],[-78,8],[-75,11],[-68,12],[-60,9],[-51,4],[-50,0],[-50,-4],[-45,-5],[-36,-5],[-35,-9],[-40,-20],[-45,-24],[-49,-29],[-54,-33],[-57,-38],[-62,-40],[-65,-43],[-67,-55],[-67,-54],[-64,-46],[-63,-40],[-65,-42],[-69,-48],[-71,-42],[-71,-35],[-70,-28],[-72,-22],[-70,-18],[-76,-12],[-80,-5],[-80,0],[-80,10]],
    [[-10,36],[-9,39],[-9,43],[-5,44],[0,43],[5,43],[8,43],[10,44],[15,37],[18,40],[24,38],[28,37],[36,37],[36,41],[40,42],[42,43],[36,47],[30,46],[30,47],[32,52],[35,52],[38,46],[40,43],[44,41],[42,42],[40,42],[36,46],[32,52],[28,58],[25,60],[28,64],[25,65],[20,68],[15,70],[13,68],[10,63],[5,62],[0,58],[-5,58],[-8,52],[-5,48],[0,46],[3,43],[0,43],[-9,43],[-10,36]],
    [[-25,63],[-24,66],[-20,66],[-17,65],[-13,65],[-13,64],[-22,63],[-25,63]],
    [[40,43],[44,41],[48,38],[55,26],[57,22],[60,22],[65,25],[70,22],[75,22],[80,28],[88,22],[95,22],[100,3],[105,0],[110,0],[115,4],[120,10],[125,10],[130,13],[140,35],[141,42],[145,44],[145,48],[141,52],[135,56],[132,42],[130,44],[135,48],[142,53],[144,45],[144,42],[140,40],[140,36],[136,35],[130,32],[122,30],[120,25],[115,20],[113,22],[110,20],[108,16],[104,10],[102,4],[100,3],[95,10],[92,22],[88,22],[84,26],[80,28],[74,20],[68,22],[60,24],[58,26],[55,24],[52,26],[50,29],[44,30],[40,37],[36,35],[36,38],[40,43]],
    [[130,31],[131,33],[132,34],[136,34],[137,36],[140,36],[141,38],[141,40],[140,42],[135,42],[130,31]],
    [[-18,15],[-16,20],[-13,22],[-8,27],[0,30],[10,37],[20,37],[25,37],[30,31],[33,30],[36,22],[38,15],[42,12],[44,10],[50,12],[44,12],[40,8],[38,4],[36,0],[38,-5],[35,-12],[32,-18],[28,-22],[25,-28],[30,-35],[28,-35],[20,-35],[17,-32],[12,-17],[8,-5],[2,4],[0,5],[-5,5],[-5,2],[-10,0],[-14,3],[-16,5],[-18,5],[-18,10],[-18,15]],
    [[44,-12],[46,-14],[48,-18],[50,-20],[48,-25],[45,-25],[44,-23],[43,-18],[43,-14],[44,-12]],
    [[114,-22],[116,-20],[118,-18],[122,-17],[127,-15],[130,-12],[135,-13],[138,-15],[140,-17],[145,-18],[148,-20],[152,-25],[152,-30],[150,-38],[146,-40],[144,-38],[140,-36],[136,-35],[130,-33],[125,-34],[117,-35],[114,-30],[114,-22]],
    [[174,-37],[178,-38],[178,-41],[176,-43],[174,-41],[172,-38],[174,-37]],
    [[172,-43],[175,-44],[172,-46],[170,-44],[168,-42],[172,-43]],
    [[-180,-68],[-90,-70],[0,-68],[90,-70],[180,-68],[180,-90],[-180,-90],[-180,-68]],
  ];

  function locatorToLatLon(loc) {
    if (!loc || loc.length < 4) return null;
    loc = loc.toUpperCase();
    const c0 = loc.charCodeAt(0) - 65, c1 = loc.charCodeAt(1) - 65;
    if (c0 < 0 || c0 > 17 || c1 < 0 || c1 > 17) return null;
    let lon = c0 * 20 - 180 + parseInt(loc[2]) * 2;
    let lat = c1 * 10 - 90  + parseInt(loc[3]);
    if (loc.length >= 6) {
      lon += (loc.charCodeAt(4) - 65) / 12 + 1/24;
      lat += (loc.charCodeAt(5) - 65) / 24 + 1/48;
    } else {
      lon += 1; lat += 0.5;
    }
    return { lat, lon };
  }

  function bearingTo(lat1, lon1, lat2, lon2) {
    const R = Math.PI / 180;
    const φ1 = lat1 * R, φ2 = lat2 * R, Δλ = (lon2 - lon1) * R;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  }

  function bearingCompass(deg) {
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
  }

  function greatCirclePoints(lat1, lon1, lat2, lon2, n) {
    const R = Math.PI / 180;
    const φ1 = lat1 * R, λ1 = lon1 * R, φ2 = lat2 * R, λ2 = lon2 * R;
    const cosD = Math.sin(φ1)*Math.sin(φ2) + Math.cos(φ1)*Math.cos(φ2)*Math.cos(λ2-λ1);
    const D = Math.acos(Math.max(-1, Math.min(1, cosD)));
    if (D < 1e-9) return [[lat1, lon1]];
    const sinD = Math.sin(D);
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const A = Math.sin((1-f)*D) / sinD, B = Math.sin(f*D) / sinD;
      const x = A*Math.cos(φ1)*Math.cos(λ1) + B*Math.cos(φ2)*Math.cos(λ2);
      const y = A*Math.cos(φ1)*Math.sin(λ1) + B*Math.cos(φ2)*Math.sin(λ2);
      const z = A*Math.sin(φ1) + B*Math.sin(φ2);
      pts.push([Math.atan2(z, Math.sqrt(x*x+y*y)) * 180/Math.PI, Math.atan2(y, x) * 180/Math.PI]);
    }
    return pts;
  }

  function drawMap(canvas, myLocStr, targetLocStr) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const lx = lon => (lon + 180) / 360 * W;
    const ly = lat => (90 - lat) / 180 * H;

    ctx.fillStyle = '#152030';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = '#1e2d40';
    ctx.lineWidth = 0.5;
    for (let lon = -180; lon <= 180; lon += 30) {
      ctx.beginPath(); ctx.moveTo(lx(lon), 0); ctx.lineTo(lx(lon), H); ctx.stroke();
    }
    for (let lat = -90; lat <= 90; lat += 30) {
      ctx.beginPath(); ctx.moveTo(0, ly(lat)); ctx.lineTo(W, ly(lat)); ctx.stroke();
    }

    ctx.fillStyle = '#2a3d2a';
    ctx.strokeStyle = '#3a4f3a';
    ctx.lineWidth = 0.5;
    for (const poly of WORLD) {
      ctx.beginPath();
      poly.forEach(([lon, lat], i) => i ? ctx.lineTo(lx(lon), ly(lat)) : ctx.moveTo(lx(lon), ly(lat)));
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }

    const my  = myLocStr     ? locatorToLatLon(myLocStr)     : null;
    const tgt = targetLocStr ? locatorToLatLon(targetLocStr) : null;

    if (my && tgt) {
      const pts = greatCirclePoints(my.lat, my.lon, tgt.lat, tgt.lon, 80);
      ctx.strokeStyle = 'rgba(79,195,247,0.65)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      let prevX = null;
      for (const [lat, lon] of pts) {
        const x = lx(lon), y = ly(lat);
        if (prevX !== null && Math.abs(x - prevX) > W * 0.4) {
          ctx.stroke(); ctx.beginPath(); ctx.moveTo(x, y);
        } else if (prevX === null) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        prevX = x;
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (my) {
      ctx.fillStyle = '#66bb6a'; ctx.strokeStyle = '#0e1a0e'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(lx(my.lon), ly(my.lat), 3.5, 0, 2*Math.PI); ctx.fill(); ctx.stroke();
    }
    if (tgt) {
      ctx.fillStyle = '#ef5350'; ctx.strokeStyle = '#1a0e0e'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(lx(tgt.lon), ly(tgt.lat), 3.5, 0, 2*Math.PI); ctx.fill(); ctx.stroke();
    }
  }

  const $ = (id) => document.getElementById(id);

  // ----- state -----
  let me = null;          // {username, callsign, permissions, selected_rig, contest_id, contest_status, contest_call, contest_name, contest_qth}
  let csrfToken = null;
  let qsos = [];
  let operators = [];
  let rigs = [];          // [{name, freq_hz, mode, band, in_use_by, connected, error, helper_count}]
  let settings = null;
  let allRoles = [];
  let allPerms = [];
  let allContests = [];
  let ws = null;
  let wsRetry = 0;
  let nrReserved = false; // true once a serial number has been reserved for the current QSO entry
  let currentTargetLocator = null; // Maidenhead locator of the station being looked up

  function hasPerm(p) {
    if (!me) return false;
    return me.permissions.includes('*') || me.permissions.includes(p);
  }

  function contestIsOpen() {
    return me && me.contest_status === 'open';
  }

  // ----- screens -----
  function show(which) {
    ['setup-screen', 'login-screen', 'contest-screen', 'app'].forEach(id => $(id).classList.add('hidden'));
    $(which).classList.remove('hidden');
    if (which === 'setup-screen') $('setup-username').focus();
    if (which === 'login-screen') $('login-username').focus();
  }

  // ----- API helper -----
  async function api(path, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (csrfToken && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      headers['X-CSRF-Token'] = csrfToken;
    }
    const res = await fetch(path, {
      ...opts,
      headers,
      credentials: 'same-origin',
    });
    if (res.status === 401 && me) {
      me = null;
      csrfToken = null;
      show('login-screen');
      throw new Error('unauthorized');
    }
    return res;
  }

  // ----- setup flow -----
  $('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('setup-error').textContent = '';
    const body = {
      username: $('setup-username').value.trim(),
      password: $('setup-password').value,
      callsign: $('setup-callsign').value.trim().toUpperCase(),
    };
    const res = await api('/api/setup', { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      $('setup-error').textContent = j.error || 'Setup failed';
      return;
    }
    await bootstrap();
  });

  // ----- login flow -----
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    const body = {
      username: $('login-username').value.trim(),
      password: $('login-password').value,
    };
    const res = await api('/api/login', { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      if (res.status === 423) {
        $('login-error').textContent = `Account locked for ${j.locked_seconds || '?'}s`;
      } else {
        $('login-error').textContent = j.error || 'Login failed';
      }
      return;
    }
    const loginData = await res.json().catch(() => ({}));
    csrfToken = loginData.csrf_token || null;
    await bootstrap();
  });

  $('logout-btn').addEventListener('click', doLogout);
  $('contest-logout-btn').addEventListener('click', doLogout);

  async function doLogout() {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    me = null;
    csrfToken = null;
    if (ws) try { ws.close(); } catch {}
    ws = null;
    show('login-screen');
  }

  // ----- contest selection screen -----
  $('station-pill').addEventListener('click', () => showContestScreen());

  $('create-contest-btn').addEventListener('click', () => contestCreateModal());

  async function showContestScreen() {
    $('contest-pick-error').textContent = '';
    const res = await api('/api/contests');
    if (res.ok) allContests = await res.json();
    renderContestPicker();
    show('contest-screen');
  }

  function renderContestPicker() {
    const list = $('contest-picker-list');
    list.innerHTML = '';
    if (!allContests || allContests.length === 0) {
      list.innerHTML = '<p class="muted" style="text-align:center;padding:20px">No contests yet.</p>';
    } else {
      for (const c of allContests) {
        const item = document.createElement('div');
        item.className = 'contest-picker-item' + (c.status === 'finished' ? ' finished' : '');
        item.innerHTML = `
          <div>
            <div class="contest-picker-call">${escHtml(fmtCall(c.station_call))}</div>
            <div class="contest-picker-name">${escHtml(c.name)}</div>
          </div>
          <span class="contest-picker-status ${c.status}">${c.status}</span>
        `;
        item.addEventListener('click', async () => {
          $('contest-pick-error').textContent = '';
          const r = await api('/api/contests/' + c.id + '/select', { method: 'POST' });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            $('contest-pick-error').textContent = j.error || 'Failed to select contest';
            return;
          }
          const j = await r.json();
          if (me) {
            me.contest_id = j.contest_id;
            me.contest_status = j.contest_status;
            me.contest_call = j.contest_call;
            me.contest_name = j.contest_name;
            me.contest_qth = j.contest_qth || '';
          }
          await enterApp();
        });
        list.appendChild(item);
      }
    }
    $('contest-create-section').classList.toggle('hidden', !hasPerm('contests.manage'));
  }

  // ----- enter main app after contest selected -----
  async function enterApp() {
    show('app');
    updateContestDisplay();
    applyContestReadonly();
    qsos = [];
    nrReserved = false;
    const [qres, ores, rres] = await Promise.all([
      api('/api/qsos'), api('/api/operators'), api('/api/rigs')
    ]);
    if (qres.ok) qsos = await qres.json();
    if (ores.ok) operators = await ores.json();
    if (rres.ok) rigs = await rres.json();
    renderQsos();
    renderOperators();
    renderRigSelect();
    renderRigList();
    applySelectedRigToForm();
    clearLeftPanel();
    if (!ws) connectWS();
    $('q-call').focus();
  }

  function updateContestDisplay() {
    const call = me?.contest_call || '—';
    const name = me?.contest_name || '';
    $('station-call').textContent = fmtCall(call);
    $('station-contest-name').textContent = name;
    $('ops-station-call').textContent = fmtCall(call);
  }

  function applyContestReadonly() {
    const isOpen = contestIsOpen();
    const banner = $('contest-readonly-banner');
    banner.classList.toggle('hidden', isOpen || !me?.contest_id);
    const form = $('qso-form');
    Array.from(form.elements).forEach(el => { el.disabled = !isOpen; });
    $('log-qso-btn').disabled = !isOpen;
    renderQsos();
  }

  // ----- tabs -----
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      $('tab-' + t.dataset.tab).classList.add('active');
      if (t.dataset.tab === 'log') $('q-call').focus();
      if (t.dataset.tab === 'users') refreshUsers();
      if (t.dataset.tab === 'contests') refreshContests();
      if (t.dataset.tab === 'settings') loadPasskeys();
      if (t.dataset.tab === 'audit') refreshAuditLog(true);
    });
  });

  function applyPermissionsToUI() {
    document.querySelectorAll('.tab-perm').forEach(t => {
      if (hasPerm(t.dataset.perm)) t.classList.add('visible');
      else t.classList.remove('visible');
    });
    document.querySelectorAll('.perm-required').forEach(el => {
      if (hasPerm(el.dataset.perm)) el.removeAttribute('data-perm-denied');
      else el.setAttribute('data-perm-denied', '1');
    });
  }

  // ----- mode/band fillers -----
  function fillSelect(sel, options, def) {
    sel.innerHTML = '';
    for (const v of options) {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      if (v === def) o.selected = true;
      sel.appendChild(o);
    }
  }
  function applyDefaults() {
    fillSelect($('q-mode'), MODES, settings?.default_mode || 'SSB');
    fillSelect($('q-band'), BANDS, settings?.default_band || '20m');
    fillSelect($('s-mode'), MODES, settings?.default_mode || 'SSB');
    fillSelect($('s-band'), BANDS, settings?.default_band || '20m');
    applyRSTDefaults($('q-mode').value);
  }
  function defaultRST(m) {
    if (['SSB','USB','LSB','FM','AM'].includes(m)) return '59';
    if (['CW','RTTY','FT8','FT4','PSK31','PSK63','JT65','JT9','MFSK','OLIVIA','DIGI'].includes(m)) return '599';
    return '';
  }
  function applyRSTDefaults(m) {
    const def = defaultRST(m);
    $('q-rst-sent').placeholder = def;
    $('q-rst-rcvd').placeholder = def;
  }
  $('q-mode').addEventListener('change', () => applyRSTDefaults($('q-mode').value));

  // ----- left panel -----
  function updateLeftPanel(callsign, hasPicture, locator) {
    if (hasPicture) {
      $('left-pic').src = '/api/lookup/picture?callsign=' + encodeURIComponent(callsign);
      $('left-pic').classList.remove('hidden');
      $('left-pic-placeholder').classList.add('hidden');
    } else {
      $('left-pic').src = '';
      $('left-pic').classList.add('hidden');
      $('left-pic-placeholder').classList.remove('hidden');
    }
    currentTargetLocator = locator || null;
    updateMap();
  }

  function clearLeftPanel() {
    $('left-pic').src = '';
    $('left-pic').classList.add('hidden');
    $('left-pic-placeholder').classList.remove('hidden');
    currentTargetLocator = null;
    updateMap();
  }

  function updateMap() {
    const canvas = $('map-canvas');
    if (!canvas) return;
    const myLoc = me?.contest_qth || null;
    drawMap(canvas, myLoc, currentTargetLocator);
    if (myLoc && currentTargetLocator) {
      const my  = locatorToLatLon(myLoc);
      const tgt = locatorToLatLon(currentTargetLocator);
      if (my && tgt) {
        const b = bearingTo(my.lat, my.lon, tgt.lat, tgt.lon);
        $('bearing-value').textContent = Math.round(b) + '° ' + bearingCompass(b);
        $('bearing-display').classList.remove('hidden');
        return;
      }
    }
    $('bearing-display').classList.add('hidden');
  }

  // ----- QRZ lookup -----
  let qrzLookupTimer = null;

  function clearQRZInfo() {
    $('qrz-info-bar').classList.add('hidden');
    $('qrz-info-name').textContent = '';
    clearLeftPanel();
  }

  async function triggerQRZLookup(callsign) {
    clearQRZInfo();
    if (!callsign || callsign.length < 3) return;
    try {
      const res = await api('/api/lookup?callsign=' + encodeURIComponent(callsign));
      if (!res.ok) return;
      const j = await res.json();
      if (j.name && !$('q-name').value) $('q-name').value = j.name;
      if (j.locator && !$('q-loc').value) $('q-loc').value = j.locator.toUpperCase();
      if (j.name) {
        $('qrz-info-name').textContent = j.name;
        $('qrz-info-bar').classList.remove('hidden');
      }
      const loc = j.locator ? j.locator.toUpperCase() : ($('q-loc').value.trim().toUpperCase() || null);
      updateLeftPanel(callsign, !!j.has_picture, loc);
    } catch {}
  }

  // Redraw map when the locator field is edited manually.
  let locTimer = null;
  $('q-loc').addEventListener('input', () => {
    clearTimeout(locTimer);
    locTimer = setTimeout(() => {
      const loc = $('q-loc').value.trim().toUpperCase();
      currentTargetLocator = loc.length >= 4 ? loc : null;
      updateMap();
    }, 400);
  });

  // Reserve a serial number the first time the operator starts typing a callsign.
  $('q-call').addEventListener('input', async () => {
    // QRZ timer must be set synchronously before any await so rapid typing
    // always resets it correctly regardless of the NR reservation flight time.
    clearTimeout(qrzLookupTimer);
    const call = $('q-call').value.trim().toUpperCase();
    if (call.length >= 3) {
      qrzLookupTimer = setTimeout(() => triggerQRZLookup(call), 600);
    } else {
      clearQRZInfo();
    }

    if (!nrReserved && contestIsOpen() && call.length > 0) {
      nrReserved = true;
      const res = await api('/api/qsos/reserve-nr', { method: 'POST' });
      if (res.ok) {
        const j = await res.json();
        $('q-nr-sent').value = j.nr;
      }
    }
  });

  // ----- QSO entry -----
  $('qso-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!contestIsOpen()) return;
    const body = {
      callsign: $('q-call').value.trim().toUpperCase(),
      name: $('q-name').value.trim(),
      nr_received: parseInt($('q-nr-rcvd').value || '0', 10) || 0,
      nr_sent: parseInt($('q-nr-sent').value || '0', 10) || 0,
      mode: $('q-mode').value,
      band: $('q-band').value,
      freq_hz: Math.round(parseFloat($('q-freq').value || '0') * 1000),
      rst_sent: $('q-rst-sent').value.trim() || $('q-rst-sent').placeholder,
      rst_received: $('q-rst-rcvd').value.trim() || $('q-rst-rcvd').placeholder,
      dok: $('q-dok').value.trim().toUpperCase(),
      locator: $('q-loc').value.trim().toUpperCase(),
      itu_zone: $('q-itu').value.trim(),
      cq_zone: $('q-cq').value.trim(),
      lighthouse: $('q-lh').value.trim(),
      notes: $('q-notes').value.trim(),
    };
    const t = $('q-time').value;
    if (t) body.time = new Date(t + 'Z').toISOString();

    $('qso-error').textContent = '';
    let res = await api('/api/qsos', { method: 'POST', body: JSON.stringify(body) });
    if (res.status === 409) {
      if (!confirm('Possible duplicate QSO with this station, band, and mode in the last 10 minutes. Log anyway?')) return;
      res = await api('/api/qsos?force=1', { method: 'POST', body: JSON.stringify(body) });
    }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      $('qso-error').textContent = j.error || 'Failed to save QSO';
      return;
    }
    ['q-call','q-name','q-nr-rcvd','q-nr-sent','q-dok','q-loc','q-itu','q-cq','q-lh','q-notes','q-time'].forEach(id => $(id).value = '');
    clearQRZInfo();
    currentTargetLocator = null;
    nrReserved = false;
    $('q-call').focus();
  });

  // ----- rig selection / rig list -----
  function applySelectedRigToForm() {
    const r = rigs.find(x => x.name === me?.selected_rig);
    if (r && r.connected) {
      $('q-freq').value = (r.freq_hz / 1000).toFixed(2);
      if (r.band) $('q-band').value = r.band;
    }
  }
  function renderRigSelect() {
    const sel = $('rig-select');
    const cur = me?.selected_rig || '';
    sel.innerHTML = '<option value="">— none (manual entry) —</option>';
    for (const r of rigs) {
      const o = document.createElement('option');
      o.value = r.name;
      let label = r.name;
      if (r.connected) label += ` — ${(r.freq_hz/1_000_000).toFixed(4)} MHz ${r.mode}`;
      else label += ' — disconnected';
      const others = (r.in_use_by || []).filter(c => c !== me?.callsign);
      if (others.length) label += ` (in use by ${others.map(fmtCall).join(', ')})`;
      o.textContent = label;
      if (r.name === cur) o.selected = true;
      sel.appendChild(o);
    }
    const r = rigs.find(x => x.name === cur);
    $('rig-bar-detail').textContent = r
      ? (r.connected
          ? `${(r.freq_hz/1_000_000).toFixed(4)} MHz · ${r.mode || ''} · ${r.band || ''}`
          : (r.error || 'rig offline'))
      : '';
    updateRigStatusPill();
  }
  $('rig-select').addEventListener('change', async (e) => {
    const name = e.target.value;
    const res = await api('/api/rigs/select', { method: 'POST', body: JSON.stringify({ name }) });
    if (res.ok) {
      const j = await res.json();
      if (me) me.selected_rig = j.selected_rig || '';
      renderRigSelect();
      renderRigList();
      applySelectedRigToForm();
    }
  });
  function renderRigList() {
    const list = $('rig-list');
    list.innerHTML = '';
    if (rigs.length === 0) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No helpers connected.';
      li.style.cursor = 'default';
      list.appendChild(li);
      return;
    }
    for (const r of rigs) {
      const li = document.createElement('li');
      if (r.name === me?.selected_rig) li.classList.add('selected');
      const data = r.connected
        ? `${escHtml((r.freq_hz/1_000_000).toFixed(4))} MHz · ${escHtml(r.mode || '-')} · ${escHtml(r.band || '-')}`
        : 'disconnected';
      const inUse = (r.in_use_by || []);
      let useLine = '';
      if (inUse.length) {
        useLine = `<div class="in-use">in use by ${escHtml(inUse.map(fmtCall).join(', '))}</div>`;
      }
      let errLine = (r.error && !r.connected) ? `<div class="rig-err">rigctld: ${escHtml(r.error)}</div>` : '';
      li.innerHTML = `<div class="rig-name">${escHtml(r.name)}</div>
                     <div class="rig-data">${data}</div>${useLine}${errLine}`;
      li.addEventListener('click', async () => {
        const target = (r.name === me?.selected_rig) ? '' : r.name;
        const res = await api('/api/rigs/select', { method: 'POST', body: JSON.stringify({ name: target }) });
        if (res.ok) {
          const j = await res.json();
          if (me) me.selected_rig = j.selected_rig || '';
          renderRigSelect();
          renderRigList();
          applySelectedRigToForm();
        }
      });
      list.appendChild(li);
    }
  }
  function updateRigStatusPill() {
    const el = $('rig-status');
    el.classList.remove('ok', 'err');
    const detail = el.querySelector('.rig-detail');
    const cur = me?.selected_rig;
    if (!cur) { detail.textContent = 'no rig selected'; return; }
    const r = rigs.find(x => x.name === cur);
    if (!r) { detail.textContent = `${cur} (offline)`; return; }
    if (r.connected) {
      el.classList.add('ok');
      detail.textContent = `${cur} · ${(r.freq_hz/1_000_000).toFixed(4)} MHz`;
    } else {
      el.classList.add('err');
      detail.textContent = `${cur}: ${r.error || 'disconnected'}`;
    }
  }

  // ----- operators panel -----
  function renderOperators() {
    const list = $('ops-list');
    list.innerHTML = '';
    for (const op of operators) {
      const li = document.createElement('li');
      const rigForOp = rigs.find(r => Array.isArray(r.in_use_by) && r.in_use_by.includes(op.callsign));
      li.textContent = fmtCall(op.callsign) + (rigForOp ? ' · ' + rigForOp.name : '');
      if (me && op.callsign === me.callsign) li.classList.add('me');
      list.appendChild(li);
    }
  }

  // ----- QSO history table -----
  function renderQsos(highlightId) {
    const filter = $('history-filter').value.trim().toLowerCase();
    const tbody = $('qso-tbody');
    tbody.innerHTML = '';
    let shown = 0;
    const canDelete = hasPerm('qso.write') && contestIsOpen();
    for (const q of qsos) {
      if (filter) {
        const hay = `${q.callsign} ${q.band} ${q.mode} ${q.operator} ${q.locator} ${q.dok || ''}`.toLowerCase();
        if (!hay.includes(filter)) continue;
      }
      const tr = document.createElement('tr');
      if (q.id === highlightId) tr.classList.add('fresh');
      const t = new Date(q.time);
      const utc = t.toISOString().substring(0, 19).replace('T', ' ');
      const mhz = q.freq_hz ? (q.freq_hz / 1_000_000).toFixed(4) : '';
      const zone = (q.itu_zone || q.cq_zone) ? `${escHtml(q.itu_zone || '-')}/${escHtml(q.cq_zone || '-')}` : '';
      tr.innerHTML = `
        <td>${escHtml(utc)}</td>
        <td><strong>${escHtml(fmtCall(q.callsign))}</strong></td>
        <td>${q.nr_sent ? escHtml(String(q.nr_sent)) : ''}</td>
        <td>${escHtml(q.band)}</td>
        <td>${escHtml(mhz)}</td>
        <td>${escHtml(q.mode)}</td>
        <td>${escHtml(q.rst_sent)}</td>
        <td>${escHtml(q.rst_received)}</td>
        <td>${escHtml(q.locator || '')}</td>
        <td>${zone}</td>
        <td>${escHtml(fmtCall(q.operator))}</td>
        <td>${canDelete ? `<button class="del-btn" data-id="${Number(q.id)}">✕</button>` : ''}</td>
      `;
      tbody.appendChild(tr);
      shown++;
    }
    $('qso-count').textContent = `${shown} QSO${shown===1?'':'s'}` + (filter ? ` (filtered from ${qsos.length})` : '');
  }
  $('history-filter').addEventListener('input', () => renderQsos());
  $('qso-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('.del-btn');
    if (!btn) return;
    if (!contestIsOpen()) return;
    if (!confirm('Delete this QSO?')) return;
    const id = parseInt(btn.dataset.id, 10);
    const res = await api('/api/qsos/' + id, { method: 'DELETE' });
    if (res.ok) { qsos = qsos.filter(q => q.id !== id); renderQsos(); }
  });

  // ----- settings -----
  async function loadSettings() {
    const res = await api('/api/settings');
    if (!res.ok) return;
    settings = await res.json();
    fillSelect($('s-mode'), MODES, settings.default_mode || 'SSB');
    fillSelect($('s-band'), BANDS, settings.default_band || '20m');
    if ('helper_token' in settings) {
      $('s-token').value = settings.helper_token || '';
      $('hint-token').textContent = settings.helper_token || '...';
    }
    $('hint-server').textContent = location.origin;
    if ('qrz_username' in settings) {
      $('s-qrz-user').value = settings.qrz_username || '';
      $('qrz-status').textContent = settings.qrz_configured
        ? 'QRZ.com lookup is configured.'
        : 'QRZ.com lookup is not configured.';
    }
  }
  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('settings-error').textContent = '';
    const body = {
      default_mode: $('s-mode').value,
      default_band: $('s-band').value,
      qrz_username: $('s-qrz-user')?.value?.trim() || '',
      qrz_password: $('s-qrz-pass')?.value || '',
    };
    const res = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      $('settings-error').textContent = j.error || 'Save failed';
      return;
    }
    if ($('s-qrz-pass')) $('s-qrz-pass').value = '';
    await loadSettings();
    applyDefaults();
  });
  $('qrz-test-btn').addEventListener('click', async () => {
    const username = $('s-qrz-user').value.trim();
    const password = $('s-qrz-pass').value;
    if (!username) {
      $('qrz-status').textContent = 'Enter a username first.';
      $('qrz-status').style.color = 'var(--error)';
      return;
    }
    $('qrz-test-btn').disabled = true;
    $('qrz-status').textContent = 'Testing…';
    $('qrz-status').style.color = '';
    const res = await api('/api/qrz/test', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    $('qrz-test-btn').disabled = false;
    const j = await res.json().catch(() => ({}));
    if (j.ok) {
      $('qrz-status').textContent = `Connected — W1AW: ${j.name || '(no name)'}`;
      $('qrz-status').style.color = 'var(--success)';
    } else {
      $('qrz-status').textContent = 'Failed: ' + (j.error || 'unknown error');
      $('qrz-status').style.color = 'var(--error)';
    }
  });
  $('regen-token').addEventListener('click', async () => {
    if (!confirm('Generate a new helper token?  All existing helpers will need to be restarted with the new value.')) return;
    const res = await api('/api/settings', { method: 'PUT', body: JSON.stringify({
      default_mode: $('s-mode').value,
      default_band: $('s-band').value,
      regen_helper_token: true,
    })});
    if (res.ok) {
      const j = await res.json();
      if (j.helper_token) {
        $('s-token').value = j.helper_token;
        $('hint-token').textContent = j.helper_token;
      }
    }
  });
  $('copy-token').addEventListener('click', () => {
    const v = $('s-token').value;
    if (!v) return;
    navigator.clipboard.writeText(v).catch(() => {});
  });
  $('own-pwd-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('op-error').textContent = '';
    const body = { Old: $('op-old').value, New: $('op-new').value };
    const res = await api('/api/me/password', { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      $('op-error').textContent = j.error || 'Change failed';
      return;
    }
    $('op-old').value = ''; $('op-new').value = '';
    $('op-error').textContent = 'Password changed.';
    $('op-error').style.color = 'var(--success)';
  });

  // ----- contests tab -----
  $('new-contest-btn').addEventListener('click', () => contestCreateModal());

  async function refreshContests() {
    if (!hasPerm('contests.manage')) return;
    const res = await api('/api/contests');
    if (!res.ok) return;
    allContests = await res.json();
    renderContestsTable();
  }

  function renderContestsTable() {
    const tbody = $('contests-tbody');
    tbody.innerHTML = '';
    for (const c of allContests) {
      const tr = document.createElement('tr');
      const date = c.created_at ? new Date(c.created_at).toLocaleDateString() : '';
      tr.innerHTML = `
        <td>${escHtml(c.name)}</td>
        <td style="color:var(--accent);font-weight:600">${escHtml(fmtCall(c.station_call))}</td>
        <td class="muted">${escHtml(c.qth || '—')}</td>
        <td><span class="badge ${c.status}">${escHtml(c.status)}</span></td>
        <td class="muted">${date}</td>
        <td class="actions">
          <button class="ghost" data-action="edit" data-id="${Number(c.id)}">Edit</button>
          <button class="ghost" data-action="toggle" data-id="${Number(c.id)}"
            data-status="${escHtml(c.status)}">${c.status === 'open' ? 'Finish' : 'Reopen'}</button>
        </td>
      `;
      tr.querySelectorAll('button').forEach(b => b.addEventListener('click', () => contestAction(c, b.dataset.action)));
      tbody.appendChild(tr);
    }
  }

  function contestAction(c, action) {
    if (action === 'edit') {
      contestEditModal(c);
    } else if (action === 'toggle') {
      const newStatus = c.status === 'open' ? 'finished' : 'open';
      const label = newStatus === 'finished' ? 'Mark this contest as finished (read-only)?' : 'Reopen this contest?';
      if (!confirm(label)) return;
      api('/api/contests/' + c.id, {
        method: 'PUT',
        body: JSON.stringify({ name: c.name, station_call: c.station_call, qth: c.qth || '', status: newStatus }),
      }).then(r => { if (r.ok) refreshContests(); });
    }
  }

  function contestCreateModal() {
    showModal(`
      <h3>New Contest</h3>
      <form>
        <label>Contest name</label>
        <input name="name" placeholder="e.g. CQ-WW-DX-CW 2025" required />
        <label>Station callsign</label>
        <input name="station_call" autocapitalize="characters" placeholder="e.g. DK0XYZ" required />
        <label>QTH locator (optional)</label>
        <input name="qth" placeholder="e.g. JO50de" maxlength="6" autocapitalize="characters" style="text-transform:uppercase" />
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">Cancel</button>
          <button type="submit" class="primary">Create</button>
        </div>
      </form>
    `, async (form) => {
      const res = await api('/api/contests', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.value.trim(),
          station_call: form.station_call.value.trim().toUpperCase(),
          qth: form.qth.value.trim().toUpperCase(),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Failed to create contest');
      }
      await refreshContests();
      // Also refresh the picker list if we're on contest-screen
      if (!$('contest-screen').classList.contains('hidden')) {
        const r = await api('/api/contests');
        if (r.ok) allContests = await r.json();
        renderContestPicker();
      }
    });
  }

  function contestEditModal(c) {
    showModal(`
      <h3>Edit Contest</h3>
      <form>
        <label>Contest name</label>
        <input name="name" value="${escHtml(c.name)}" required />
        <label>Station callsign</label>
        <input name="station_call" value="${escHtml(c.station_call)}" autocapitalize="characters" required />
        <label>QTH locator (optional)</label>
        <input name="qth" value="${escHtml(c.qth || '')}" placeholder="e.g. JO50de" maxlength="6" autocapitalize="characters" style="text-transform:uppercase" />
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">Cancel</button>
          <button type="submit" class="primary">Save</button>
        </div>
      </form>
    `, async (form) => {
      const res = await api('/api/contests/' + c.id, {
        method: 'PUT',
        body: JSON.stringify({
          name: form.name.value.trim(),
          station_call: form.station_call.value.trim().toUpperCase(),
          qth: form.qth.value.trim().toUpperCase(),
          status: c.status,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Failed to update contest');
      }
      await refreshContests();
    });
  }

  // ----- users tab -----
  async function refreshUsers() {
    if (!hasPerm('users.manage')) return;
    const [uR, rR, pR] = await Promise.all([
      api('/api/users'), api('/api/roles'), api('/api/permissions')
    ]);
    if (!uR.ok || !rR.ok || !pR.ok) return;
    const users = await uR.json();
    allRoles = await rR.json();
    allPerms = await pR.json();
    renderUsers(users);
    renderRoles();
  }
  function renderUsers(users) {
    const tbody = $('users-tbody');
    tbody.innerHTML = '';
    for (const u of users) {
      const tr = document.createElement('tr');
      const roles = (u.roles || []).map(r =>
        `<span class="badge ${r === 'admin' ? 'admin' : ''}">${escHtml(r)}</span>`).join('');
      const status = [];
      if (u.disabled) status.push('<span class="badge disabled">disabled</span>');
      if (u.locked_until && new Date(u.locked_until) > new Date()) {
        status.push(`<span class="badge locked">locked (${Number(u.failed_attempts)} fails)</span>`);
      }
      if (!status.length) status.push('<span class="muted">active</span>');
      tr.innerHTML = `
        <td>${escHtml(u.username)}</td>
        <td>${escHtml(fmtCall(u.callsign))}</td>
        <td>${roles}</td>
        <td>${status.join(' ')}</td>
        <td class="actions">
          <button class="ghost" data-action="edit" data-id="${Number(u.id)}">Edit</button>
          <button class="ghost" data-action="password" data-id="${Number(u.id)}">Reset password</button>
          <button class="ghost" data-action="unlock" data-id="${Number(u.id)}">Unlock</button>
          <button class="ghost" data-action="toggle" data-id="${Number(u.id)}" data-disabled="${u.disabled ? '1' : ''}">${u.disabled ? 'Enable' : 'Disable'}</button>
          <button class="ghost" data-action="delete" data-id="${Number(u.id)}">Delete</button>
        </td>
      `;
      tr.querySelectorAll('button').forEach(b => b.addEventListener('click', () => userAction(u, b.dataset.action)));
      tbody.appendChild(tr);
    }
  }
  function renderRoles() {
    const root = $('roles-list');
    root.innerHTML = '';
    for (const r of allRoles) {
      const card = document.createElement('div');
      card.className = 'role-card';
      const perms = (r.permissions || []).map(p =>
        `<span class="perm-chip">${p === '*' ? 'all permissions' : escHtml(p)}</span>`).join('');
      card.innerHTML = `
        <div class="role-head">
          <div>
            <span class="role-name">${escHtml(r.name)}</span>
            ${r.is_builtin ? '<span class="badge">built-in</span>' : ''}
          </div>
          <div>
            ${r.name === 'admin' ? '' : `<button class="ghost" data-action="edit-role" data-id="${Number(r.id)}">Edit perms</button>`}
            ${r.is_builtin ? '' : `<button class="ghost" data-action="del-role" data-id="${Number(r.id)}">Delete</button>`}
          </div>
        </div>
        <div class="perms">${perms}</div>
      `;
      card.querySelectorAll('button').forEach(b => b.addEventListener('click', () => roleAction(r, b.dataset.action)));
      root.appendChild(card);
    }
  }

  $('new-user-btn').addEventListener('click', () => userModal(null));
  $('new-role-btn').addEventListener('click', () => roleModal(null));

  function userAction(u, action) {
    switch (action) {
      case 'edit': userModal(u); return;
      case 'password': passwordModal(u); return;
      case 'unlock':
        api('/api/users/' + u.id + '/unlock', { method: 'POST' }).then(refreshUsers);
        return;
      case 'toggle':
        api('/api/users/' + u.id, {
          method: 'PUT',
          body: JSON.stringify({ disabled: !u.disabled }),
        }).then(refreshUsers);
        return;
      case 'delete':
        if (confirm(`Delete user ${u.username}?`)) {
          api('/api/users/' + u.id, { method: 'DELETE' }).then(refreshUsers);
        }
        return;
    }
  }

  function roleAction(r, action) {
    switch (action) {
      case 'edit-role': roleModal(r); return;
      case 'del-role':
        if (confirm(`Delete role ${r.name}?`)) {
          api('/api/roles/' + r.id, { method: 'DELETE' }).then(refreshUsers);
        }
        return;
    }
  }

  // ----- modals -----
  function showModal(html, onSubmit) {
    const root = $('modal-root');
    const card = $('modal-card');
    card.innerHTML = html;
    root.classList.remove('hidden');
    const form = card.querySelector('form');
    const close = () => root.classList.add('hidden');
    card.querySelector('.cancel-btn')?.addEventListener('click', close);
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await onSubmit(form);
          close();
        } catch (err) {
          const errEl = card.querySelector('.modal-err');
          if (errEl) errEl.textContent = err.message;
        }
      });
    }
  }

  function userModal(u) {
    const isNew = u === null;
    const roleOptions = allRoles.map(r =>
      `<label><input type="checkbox" value="${escHtml(r.name)}" ${(!isNew && u.roles?.includes(r.name)) || (isNew && r.name === 'user') ? 'checked' : ''}/> ${escHtml(r.name)}</label>`
    ).join('');
    showModal(`
      <h3>${isNew ? 'New user' : 'Edit user: ' + escHtml(u.username)}</h3>
      <form>
        ${isNew ? `<label>Username</label><input name="username" required />
          <label>Password (min 8)</label><input type="password" name="password" minlength="8" required />` : ''}
        <label>Callsign</label>
        <input name="callsign" value="${isNew ? '' : escHtml(u.callsign)}" required />
        <label>Roles</label>
        <div class="perm-grid">${roleOptions}</div>
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">Cancel</button>
          <button type="submit" class="primary">Save</button>
        </div>
      </form>
    `, async (form) => {
      const roles = Array.from(form.querySelectorAll('input[type=checkbox]:checked')).map(i => i.value);
      const callsign = form.callsign.value.trim().toUpperCase();
      let res;
      if (isNew) {
        res = await api('/api/users', { method: 'POST', body: JSON.stringify({
          username: form.username.value.trim(),
          password: form.password.value,
          callsign, roles,
        })});
      } else {
        res = await api('/api/users/' + u.id, { method: 'PUT', body: JSON.stringify({ callsign, roles })});
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'failed');
      }
      refreshUsers();
    });
  }

  function passwordModal(u) {
    showModal(`
      <h3>Reset password for ${escHtml(u.username)}</h3>
      <form>
        <label>New password (min 8)</label>
        <input type="password" name="password" minlength="8" required />
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">Cancel</button>
          <button type="submit" class="primary">Set password</button>
        </div>
      </form>
    `, async (form) => {
      const res = await api('/api/users/' + u.id + '/password', {
        method: 'POST',
        body: JSON.stringify({ Password: form.password.value }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'failed');
      }
    });
  }

  function roleModal(r) {
    const isNew = r === null;
    const isAdmin = !isNew && r.name === 'admin';
    const checks = allPerms.map(p => {
      const checked = !isNew && r.permissions?.includes(p);
      return `<label><input type="checkbox" value="${escHtml(p)}" ${checked ? 'checked' : ''} ${isAdmin ? 'disabled' : ''}/> ${escHtml(p)}</label>`;
    }).join('');
    showModal(`
      <h3>${isNew ? 'New role' : 'Edit role: ' + escHtml(r.name)}</h3>
      <form>
        ${isNew ? '<label>Name</label><input name="name" required />' : ''}
        ${isAdmin ? '<p class="muted small">The admin role has all permissions and cannot be modified.</p>' : ''}
        <label>Permissions</label>
        <div class="perm-grid">${checks}</div>
        <div class="modal-err error"></div>
        <div class="modal-actions">
          <button type="button" class="ghost cancel-btn">Cancel</button>
          <button type="submit" class="primary" ${isAdmin ? 'disabled' : ''}>Save</button>
        </div>
      </form>
    `, async (form) => {
      const perms = Array.from(form.querySelectorAll('input[type=checkbox]:checked')).map(i => i.value);
      let res;
      if (isNew) {
        res = await api('/api/roles', { method: 'POST', body: JSON.stringify({
          name: form.name.value.trim(),
          permissions: perms,
        })});
      } else {
        res = await api('/api/roles/' + r.id, { method: 'PUT', body: JSON.stringify({ permissions: perms })});
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'failed');
      }
      refreshUsers();
    });
  }

  // ----- websocket -----
  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/ws');
    ws.onopen = () => {
      if (wsRetry > 0 && me?.contest_id) {
        api('/api/qsos').then(r => r.ok ? r.json() : null).then(d => {
          if (d) { qsos = d; renderQsos(); }
        }).catch(() => {});
      }
      wsRetry = 0;
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case 'qso':
          if (msg.payload && msg.payload.contest_id === me?.contest_id &&
              !qsos.find(q => q.id === msg.payload.id)) {
            qsos.unshift(msg.payload);
            renderQsos(msg.payload.id);
          }
          break;
        case 'qso_deleted':
          qsos = qsos.filter(q => q.id !== msg.payload.id);
          renderQsos();
          break;
        case 'operators':
          operators = msg.payload || [];
          renderOperators();
          break;
        case 'rigs':
          rigs = msg.payload || [];
          renderRigSelect();
          renderRigList();
          renderOperators();
          applySelectedRigToForm();
          break;
        case 'contest_updated':
          if (me && msg.payload.id === me.contest_id) {
            me.contest_status = msg.payload.status;
            me.contest_call = msg.payload.station_call;
            me.contest_name = msg.payload.name;
            if ('qth' in msg.payload) me.contest_qth = msg.payload.qth;
            updateContestDisplay();
            applyContestReadonly();
            updateMap();
          }
          break;
      }
    };
    ws.onclose = () => {
      ws = null;
      if (!me) return;
      const delay = Math.min(15000, 500 * Math.pow(2, wsRetry++));
      setTimeout(connectWS, delay);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  // ----- bootstrap -----
  async function refreshMe() {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (!res.ok) return false;
    const j = await res.json();
    if (j.setup_required) {
      show('setup-screen');
      return false;
    }
    me = j;
    csrfToken = j.csrf_token || null;
    $('current-op').textContent = fmtCall(me.callsign);
    return true;
  }

  async function bootstrap() {
    const ok = await refreshMe();
    if (!ok) return;
    applyPermissionsToUI();
    await loadSettings();
    applyDefaults();
    if (!me.contest_id) {
      await showContestScreen();
      return;
    }
    await enterApp();
  }

  // ----- passkey helpers -----
  function passkeyAvailable() {
    if (typeof window.PublicKeyCredential === 'undefined') return false;
    if (typeof navigator.credentials === 'undefined') return false;
    return true;
  }

  function b64url(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
  function fromB64url(s) {
    const pad = s + '==='.slice((s.length + 3) % 4);
    const bin = atob(pad.replace(/-/g, '+').replace(/_/g, '/'));
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b.buffer;
  }

  // ----- passkey login -----
  $('passkey-login-btn').addEventListener('click', async () => {
    $('passkey-login-error').textContent = '';
    if (!passkeyAvailable()) {
      $('passkey-login-error').textContent = 'Passkeys require a secure connection (HTTPS or localhost).';
      return;
    }
    try {
      const beginRes = await fetch('/api/passkey/login/begin', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!beginRes.ok) {
        const j = await beginRes.json().catch(() => ({}));
        throw new Error(j.error || 'Failed to start passkey login');
      }
      const pk = await beginRes.json();
      pk.publicKey.challenge = fromB64url(pk.publicKey.challenge);
      if (pk.publicKey.allowCredentials) {
        pk.publicKey.allowCredentials = pk.publicKey.allowCredentials.map(c => ({
          ...c, id: fromB64url(c.id),
        }));
      }

      const assertion = await navigator.credentials.get({ publicKey: pk.publicKey });
      const payload = {
        id: assertion.id,
        rawId: b64url(assertion.rawId),
        type: assertion.type,
        response: {
          clientDataJSON: b64url(assertion.response.clientDataJSON),
          authenticatorData: b64url(assertion.response.authenticatorData),
          signature: b64url(assertion.response.signature),
          userHandle: assertion.response.userHandle ? b64url(assertion.response.userHandle) : null,
        },
      };

      const finishRes = await fetch('/api/passkey/login/finish', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!finishRes.ok) {
        const j = await finishRes.json().catch(() => ({}));
        throw new Error(j.error || 'Passkey login failed');
      }
      await bootstrap();
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        $('passkey-login-error').textContent = err.message || 'Passkey login failed';
      }
    }
  });

  // ----- passkey management -----
  async function loadPasskeys() {
    const el = $('passkey-list');
    const res = await api('/api/passkey/credentials');
    if (!res.ok) return;
    const list = await res.json();
    if (!list || list.length === 0) {
      el.innerHTML = '<p class="muted small">No passkeys registered yet.</p>';
      return;
    }
    el.innerHTML = list.map(pk => {
      const date = pk.created_at ? new Date(pk.created_at).toLocaleDateString() : '';
      return `<div class="passkey-item">
        <span class="passkey-name">&#128273; ${escHtml(pk.name || 'Passkey')}</span>
        <span class="muted small">${date}</span>
        <button class="ghost small" data-delete-passkey="${escHtml(pk.id)}">Remove</button>
      </div>`;
    }).join('');
    el.querySelectorAll('[data-delete-passkey]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const credID = btn.dataset.deletePasskey;
        const res = await api('/api/passkey/credentials/' + encodeURIComponent(credID), { method: 'DELETE' });
        if (res.ok || res.status === 204) loadPasskeys();
      });
    });
  }

  $('register-passkey-btn').addEventListener('click', async () => {
    $('passkey-error').textContent = '';
    if (!passkeyAvailable()) {
      $('passkey-error').textContent = 'Passkeys require a secure connection (HTTPS or localhost).';
      return;
    }
    const name = encodeURIComponent($('passkey-name').value.trim() || 'Passkey');
    try {
      const beginRes = await api('/api/passkey/register/begin', { method: 'POST' });
      if (!beginRes.ok) {
        const j = await beginRes.json().catch(() => ({}));
        throw new Error(j.error || 'Failed to start passkey registration');
      }
      const pk = await beginRes.json();
      pk.publicKey.challenge = fromB64url(pk.publicKey.challenge);
      pk.publicKey.user.id = fromB64url(pk.publicKey.user.id);
      if (pk.publicKey.excludeCredentials) {
        pk.publicKey.excludeCredentials = pk.publicKey.excludeCredentials.map(c => ({
          ...c, id: fromB64url(c.id),
        }));
      }

      const cred = await navigator.credentials.create({ publicKey: pk.publicKey });
      const payload = {
        id: cred.id,
        rawId: b64url(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: b64url(cred.response.clientDataJSON),
          attestationObject: b64url(cred.response.attestationObject),
        },
      };

      const finishRes = await api('/api/passkey/register/finish?name=' + name, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!finishRes.ok) {
        const j = await finishRes.json().catch(() => ({}));
        throw new Error(j.error || 'Passkey registration failed');
      }
      $('passkey-name').value = '';
      await loadPasskeys();
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        $('passkey-error').textContent = err.message || 'Registration failed';
      }
    }
  });

  // ----- audit log -----
  let auditEntries = [];
  let auditTotal = 0;
  let auditOffset = 0;
  const auditPageSize = 100;
  let auditSort = { col: 'timestamp', desc: true };
  let auditActions = [];

  function auditFilterParams(offset) {
    const params = new URLSearchParams();
    const level = $('audit-level').value;
    const action = $('audit-action').value;
    const search = $('audit-search').value.trim();
    const since = $('audit-since').value;
    const until = $('audit-until').value;
    if (level) params.set('level', level);
    if (action) params.set('action', action);
    if (search) params.set('search', search);
    if (since) params.set('since', new Date(since).toISOString());
    if (until) params.set('until', new Date(until).toISOString());
    params.set('sort', auditSort.col);
    params.set('dir', auditSort.desc ? 'desc' : 'asc');
    params.set('limit', String(auditPageSize));
    params.set('offset', String(offset));
    return params;
  }

  async function refreshAuditLog(reset) {
    if (!hasPerm('audit.log')) return;
    if (reset) { auditEntries = []; auditOffset = 0; }
    const res = await api('/api/audit?' + auditFilterParams(auditOffset));
    if (!res.ok) return;
    const j = await res.json();
    auditTotal = j.total || 0;
    if (reset) auditEntries = j.entries || [];
    else auditEntries = auditEntries.concat(j.entries || []);
    auditOffset = auditEntries.length;
    // Populate action dropdown on first load
    if (auditActions.length === 0 && j.actions && j.actions.length) {
      auditActions = j.actions;
      const sel = $('audit-action');
      for (const a of auditActions) {
        const o = document.createElement('option');
        o.value = a; o.textContent = a;
        sel.appendChild(o);
      }
    }
    renderAuditLog();
  }

  function renderAuditLog() {
    const tbody = $('audit-tbody');
    tbody.innerHTML = '';
    for (const e of auditEntries) {
      const tr = document.createElement('tr');
      const ts = new Date(e.timestamp);
      const utc = ts.toISOString().substring(0, 19).replace('T', ' ');
      tr.innerHTML = `
        <td class="mono">${escHtml(utc)}</td>
        <td><span class="audit-level audit-level-${escHtml(e.level)}">${escHtml(e.level)}</span></td>
        <td class="mono small">${escHtml(e.action)}</td>
        <td>${escHtml(e.actor)}</td>
        <td>${escHtml(e.target)}</td>
        <td class="muted small">${escHtml(e.details)}</td>
        <td class="mono small muted">${escHtml(e.ip)}</td>
      `;
      tbody.appendChild(tr);
    }
    const shown = auditEntries.length;
    $('audit-status').textContent = `Showing ${shown} of ${auditTotal} entries`;
    const moreBtn = $('audit-load-more');
    if (shown < auditTotal) {
      moreBtn.classList.remove('hidden');
      moreBtn.textContent = `Load more (${auditTotal - shown} remaining)`;
    } else {
      moreBtn.classList.add('hidden');
    }
    updateAuditSortArrows();
  }

  function updateAuditSortArrows() {
    document.querySelectorAll('#audit-table th.sortable').forEach(th => {
      const arrow = th.querySelector('.sort-arrow');
      if (th.dataset.col === auditSort.col) {
        arrow.textContent = auditSort.desc ? ' ▼' : ' ▲';
        th.classList.add('sort-active');
      } else {
        arrow.textContent = '';
        th.classList.remove('sort-active');
      }
    });
  }

  document.querySelectorAll('#audit-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (auditSort.col === col) {
        auditSort.desc = !auditSort.desc;
      } else {
        auditSort.col = col;
        auditSort.desc = col === 'timestamp'; // default desc for time, asc for text cols
      }
      refreshAuditLog(true);
    });
  });

  $('audit-apply').addEventListener('click', () => refreshAuditLog(true));
  $('audit-reset').addEventListener('click', () => {
    $('audit-level').value = '';
    $('audit-action').value = '';
    $('audit-search').value = '';
    $('audit-since').value = '';
    $('audit-until').value = '';
    auditSort = { col: 'timestamp', desc: true };
    refreshAuditLog(true);
  });
  $('audit-load-more').addEventListener('click', () => refreshAuditLog(false));
  $('audit-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') refreshAuditLog(true);
  });

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtCall(s) {
    return String(s).replace(/0/g, 'Ø');
  }

  // Initial route.
  (async () => {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.ok) {
      const j = await res.json();
      if (j.setup_required) { show('setup-screen'); return; }
      me = j;
      csrfToken = j.csrf_token || null;
      $('current-op').textContent = fmtCall(me.callsign);
      applyPermissionsToUI();
      await loadSettings();
      applyDefaults();
      if (!me.contest_id) {
        await showContestScreen();
      } else {
        await enterApp();
      }
    } else if (res.status === 401) {
      show('login-screen');
    } else {
      show('login-screen');
    }
  })();
})();
