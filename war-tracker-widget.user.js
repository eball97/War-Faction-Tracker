// ==UserScript==
// @name         Greater Sparta War Tracker Widget
// @namespace    greater-sparta
// @version      5.0
// @description  Works on PC (Tampermonkey) and mobile (TornPDA). Floating button you can drag anywhere, opens live enemy status with Attack + Call Hit buttons, a personal Saved Targets tab, plus a 24hr activity heat map. Talks to my own private backend so there's nothing sensitive sitting in this file. Just paste in your own API key and go.
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @updateURL    https://github.com/eball97/War-Faction-Tracker/raw/refs/heads/main/war-tracker-widget.user.js
// @downloadURL  https://github.com/eball97/War-Faction-Tracker/raw/refs/heads/main/war-tracker-widget.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------- NETWORK REQUESTS (works on PC + mobile) ----------
  // PC (Tampermonkey) and TornPDA use totally different functions for
  // making outside requests, so this is the one spot that checks which
  // one I'm running on. Everything else just calls request() normally
  // and doesn't have to care.
  //
  // Note to self: only tested the PC side so far. If something breaks
  // on TornPDA specifically, start here — the PDA_httpGet response
  // might come back shaped slightly differently than I'm expecting.
  function rawRequest(method, url, options) {
    options = options || {};
    const headers = options.headers || {};
    const data = options.data || null;

    // running on TornPDA
    if (typeof PDA_httpGet === 'function') {
      const pdaCall = method === 'POST'
        ? PDA_httpPost(url, headers, data)
        : PDA_httpGet(url, headers);

      return Promise.resolve(pdaCall).then(function (response) {
        const text = (response && (response.responseText || response.response)) || '';
        return { responseText: text };
      });
    }

    // running on PC (Tampermonkey/Greasemonkey/Violentmonkey)
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise(function (resolve, reject) {
        GM_xmlhttpRequest({
          method: method,
          url: url,
          headers: headers,
          data: data,
          onload: function (response) {
            resolve({ responseText: response.responseText });
          },
          onerror: function () {
            reject(new Error('Request failed.'));
          }
        });
      });
    }

    return Promise.reject(new Error('No supported request API found on this platform.'));
  }

  // Google Apps Script Web Apps (my proxy URL) don't respond directly —
  // they first send a redirect to a temporary script.googleusercontent.com
  // URL that holds the real response. Normal browsers follow this
  // automatically without you noticing, but not every platform's request
  // function does. If that happens we'd get Google's redirect page back
  // instead of real JSON, which shows up as "<!DOCTYPE... is not valid
  // JSON". This catches that case, pulls the real URL out of the page,
  // and quietly retries against it instead of failing.
  function request(method, url, options) {
    return rawRequest(method, url, options).then(function (response) {
      const text = response.responseText || '';
      if (text.trim().indexOf('<') === 0) {
        const match = text.match(/https:\/\/script\.googleusercontent\.com[^"'\s<>]+/);
        if (match) {
          return rawRequest(method, match[0], options);
        }
        throw new Error('Got an unexpected page back instead of data \u2014 try again in a moment.');
      }
      return response;
    });
  }

  // ---------- SAVED SETTINGS ----------
  // Just using plain localStorage here — works the same on PC and
  // TornPDA so I don't need to special-case this one.
  function storageGet(key, defaultValue) {
    const raw = window.localStorage.getItem('wt_' + key);
    if (raw === null) return defaultValue;
    try { return JSON.parse(raw); } catch (e) { return defaultValue; }
  }
  function storageSet(key, value) {
    window.localStorage.setItem('wt_' + key, JSON.stringify(value));
  }

  // ---------- CONFIG ----------
  function getApiKey() {
    return storageGet('tornApiKeyWarTracker', '');
  }
  // Points at my Apps Script backend instead of hitting Discord/Sheets
  // directly — keeps the real webhook and sheet private, this file only
  // knows about the handful of specific things the backend lets it do.
  const PROXY_URL = 'https://script.google.com/macros/s/AKfycbxcV9HcL8vZgR0RBuY8bbjNnTTW_6n1Q4IxWNzg5LqlLmKdrKspZeSGeB9iRLsNkxb3/exec';

  // Pulls the faction ID straight from my tracking sheet so nobody has
  // to type it in and risk getting it wrong.
  let cachedFactionId = null;
  let factionIdFetchPromise = null;

  function fetchTargetFactionId() {
    if (cachedFactionId) return Promise.resolve(cachedFactionId);
    if (factionIdFetchPromise) return factionIdFetchPromise;

    factionIdFetchPromise = request('GET', PROXY_URL + '?action=getFactionId').then(function (response) {
      const data = JSON.parse(response.responseText);
      if (data.factionId) {
        cachedFactionId = data.factionId;
        return cachedFactionId;
      }
      throw new Error(data.error || 'No Faction ID available yet — has tracking been started?');
    }).finally(function () {
      factionIdFetchPromise = null;
    });

    return factionIdFetchPromise;
  }

  // Grabs your name automatically off your own API key — no need to
  // type it in yourself.
  let cachedMyName = null;
  let myNameFetchPromise = null;

  function fetchMyName() {
    if (cachedMyName) return Promise.resolve(cachedMyName);
    if (myNameFetchPromise) return myNameFetchPromise;

    const key = getApiKey();
    if (!key) return Promise.reject(new Error('No API key set yet.'));

    myNameFetchPromise = request('GET', 'https://api.torn.com/v2/user/basic?key=' + key).then(function (response) {
      const data = JSON.parse(response.responseText);
      // Confirmed real shape: name sits under data.profile.name.
      const name = data.profile && data.profile.name;
      if (name) {
        cachedMyName = name;
        return cachedMyName;
      }
      throw new Error('Could not read your name from the API response.');
    }).finally(function () {
      myNameFetchPromise = null;
    });

    return myNameFetchPromise;
  }

  // ---------- LOOK & FEEL ----------
  const style = document.createElement('style');
  style.textContent = `
    #wt-toggle-btn {
      position: fixed;
      z-index: 999999;
      width: 46px;
      height: 46px;
      border-radius: 50%;
      background: #0d0d0f;
      border: 2px solid #c9a227;
      color: #c9a227;
      font-size: 20px;
      cursor: grab;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 8px rgba(0,0,0,0.5);
      user-select: none;
    }
    #wt-toggle-btn.dragging { cursor: grabbing; }
    #wt-panel {
      position: fixed;
      z-index: 999999;
      width: 380px;
      max-height: 520px;
      background: #0d0d0f;
      border: 1px solid #2a2a2d;
      border-radius: 6px;
      color: #e8e4d8;
      font-family: Arial, sans-serif;
      font-size: 13px;
      display: none;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 4px 16px rgba(0,0,0,0.6);
    }
    #wt-panel.open { display: flex; }
    #wt-tabs {
      display: flex;
      border-bottom: 1px solid #2a2a2d;
      background: #17171a;
    }
    #wt-tabs button {
      flex: 1;
      background: none;
      border: none;
      color: #8a877e;
      padding: 10px 6px;
      cursor: pointer;
      font-size: 12px;
      letter-spacing: 0.02em;
    }
    #wt-tabs button.active {
      color: #c9a227;
      border-bottom: 2px solid #c9a227;
    }
    #wt-body {
      overflow-y: auto;
      padding: 10px 12px;
      flex: 1;
    }
    .wt-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 7px 0;
      border-bottom: 1px solid #222225;
    }
    .wt-name { font-weight: bold; }
    .wt-sub { color: #8a877e; font-size: 11px; }
    .wt-status-online { color: #9fc48e; }
    .wt-status-idle { color: #d9b96a; }
    .wt-status-offline { color: #8a877e; }
    .wt-attack-btn {
      background: #7a2530;
      color: #f0dede;
      border: none;
      border-radius: 3px;
      padding: 4px 10px;
      font-size: 11px;
      cursor: pointer;
    }
    .wt-attack-btn:hover { background: #942c39; }
    .wt-call-btn {
      background: #4a4a20;
      color: #e8dfa0;
      border: none;
      border-radius: 3px;
      padding: 4px 10px;
      font-size: 11px;
      cursor: pointer;
    }
    .wt-call-btn:hover { background: #5c5c28; }
    .wt-call-btn:disabled { opacity: 0.5; cursor: default; }
    .wt-save-btn {
      background: #17171a;
      color: #8a877e;
      border: 1px solid #2a2a2d;
      border-radius: 3px;
      padding: 4px 8px;
      font-size: 11px;
      cursor: pointer;
    }
    .wt-save-btn:hover { background: #22222a; }
    .wt-save-btn.saved { color: #c9a227; border-color: #c9a227; }
    .wt-settings label {
      display: block;
      font-size: 11px;
      color: #8a877e;
      margin: 10px 0 4px;
    }
    .wt-settings input {
      width: 100%;
      background: #17171a;
      border: 1px solid #2a2a2d;
      color: #e8e4d8;
      padding: 6px 8px;
      border-radius: 3px;
      box-sizing: border-box;
    }
    .wt-settings button {
      margin-top: 12px;
      width: 100%;
      background: #c9a227;
      color: #0d0d0f;
      border: none;
      padding: 8px;
      border-radius: 3px;
      cursor: pointer;
      font-weight: bold;
    }
    .wt-empty { color: #8a877e; font-style: italic; text-align: center; padding: 20px 0; }
  `;
  document.head.appendChild(style);

  // ---------- BUILDING THE BUTTON + PANEL ----------
  const btn = document.createElement('div');
  btn.id = 'wt-toggle-btn';
  btn.textContent = '\u2694';
  document.body.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'wt-panel';
  panel.innerHTML = `
    <div id="wt-tabs">
      <button data-tab="live" class="active">Live Status</button>
      <button data-tab="targets">Targets</button>
      <button data-tab="peak">Heat Map</button>
      <button data-tab="settings">Settings</button>
    </div>
    <div id="wt-body"></div>
  `;
  document.body.appendChild(panel);

  // ---------- DRAG-TO-MOVE (remembers where you put it) ----------
  const DEFAULT_POS = { left: window.innerWidth - 66, top: window.innerHeight - 66 };

  function getSavedPosition() {
    return storageGet('warTrackerBtnPosition', DEFAULT_POS);
  }

  function applyPosition(pos) {
    btn.style.left = pos.left + 'px';
    btn.style.top = pos.top + 'px';
    positionPanel(pos);
  }

  function positionPanel(pos) {
    const panelWidth = 380;
    const panelHeight = 500;
    let panelLeft = pos.left - panelWidth + 46;
    let panelTop = pos.top - panelHeight - 10;

    if (panelLeft < 8) panelLeft = 8;
    if (panelLeft + panelWidth > window.innerWidth - 8) panelLeft = window.innerWidth - panelWidth - 8;
    if (panelTop < 8) panelTop = pos.top + 56;

    panel.style.left = panelLeft + 'px';
    panel.style.top = panelTop + 'px';
  }

  let currentPos = getSavedPosition();
  applyPosition(currentPos);

  let dragging = false;
  let dragMoved = false;
  let dragStartX, dragStartY, startLeft, startTop;

  // Handles both mouse (PC) and touch (TornPDA/mobile) the same way —
  // just pulls the x/y out of whichever kind of event actually fired.
  function pointFromEvent(e) {
    if (e.touches && e.touches.length > 0) {
      return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    return { x: e.clientX, y: e.clientY };
  }

  function dragStart(e) {
    const p = pointFromEvent(e);
    dragging = true;
    dragMoved = false;
    btn.classList.add('dragging');
    dragStartX = p.x;
    dragStartY = p.y;
    startLeft = currentPos.left;
    startTop = currentPos.top;
    // Deliberately NOT calling preventDefault() here. Doing so on every
    // single touchstart — even a simple tap — can suppress the browser's
    // synthetic "click" event that fires afterward, which is exactly
    // what was blocking the panel from opening on a plain tap. Only
    // dragMove() below calls preventDefault(), and only once real
    // movement is confirmed.
  }

  function dragMove(e) {
    if (!dragging) return;
    const p = pointFromEvent(e);
    const dx = p.x - dragStartX;
    const dy = p.y - dragStartY;
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12) dragMoved = true;

    currentPos = { left: startLeft + dx, top: startTop + dy };
    applyPosition(currentPos);
    if (dragMoved && e.cancelable) e.preventDefault();
  }

  function dragEnd() {
    if (!dragging) return;
    dragging = false;
    btn.classList.remove('dragging');
    if (dragMoved) {
      storageSet('warTrackerBtnPosition', currentPos);
    }
  }

  btn.addEventListener('mousedown', dragStart);
  document.addEventListener('mousemove', dragMove);
  document.addEventListener('mouseup', dragEnd);

  btn.addEventListener('touchstart', dragStart, { passive: false });
  document.addEventListener('touchmove', dragMove, { passive: false });
  document.addEventListener('touchend', dragEnd);

  // Live Status auto-refreshes once a minute while it's the tab you're
  // actually looking at, and stops the second you switch away or close
  // the panel — no point polling something you're not even viewing.
  let liveStatusInterval = null;

  function stopLiveStatusAutoRefresh() {
    if (liveStatusInterval) {
      clearInterval(liveStatusInterval);
      liveStatusInterval = null;
    }
  }

  function startLiveStatusAutoRefresh() {
    stopLiveStatusAutoRefresh();
    liveStatusInterval = setInterval(function () {
      if (currentTab === 'live' && panel.classList.contains('open')) {
        renderLiveStatus(document.getElementById('wt-body'));
      }
    }, 60000);
  }

  btn.addEventListener('click', function () {
    if (dragMoved) return;
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
      positionPanel(currentPos);
      renderTab(currentTab);
    } else {
      stopLiveStatusAutoRefresh();
    }
  });

  let currentTab = 'live';
  panel.querySelectorAll('#wt-tabs button').forEach(function (tabBtn) {
    tabBtn.addEventListener('click', function () {
      panel.querySelectorAll('#wt-tabs button').forEach(b => b.classList.remove('active'));
      tabBtn.classList.add('active');
      currentTab = tabBtn.dataset.tab;
      if (currentTab !== 'live') stopLiveStatusAutoRefresh();
      renderTab(currentTab);
    });
  });

  function renderTab(tab) {
    const body = document.getElementById('wt-body');
    if (tab === 'settings') {
      renderSettings(body);
    } else if (tab === 'peak') {
      renderPeakHours(body);
    } else if (tab === 'targets') {
      renderTargets(body);
    } else {
      renderLiveStatus(body);
      startLiveStatusAutoRefresh();
    }
  }

  function renderSettings(body) {
    body.innerHTML = `
      <div class="wt-settings">
        <label>Torn API Key (Public access level is enough)</label>
        <input type="text" id="wt-key-input" value="${getApiKey()}" placeholder="Paste your API key">
        <button id="wt-save-btn">Save</button>
        <div class="wt-sub" style="margin-top:10px;">Your name and the target faction are both pulled automatically \u2014 this is the only thing you need to set.</div>
      </div>
    `;
    document.getElementById('wt-save-btn').addEventListener('click', function () {
      storageSet('tornApiKeyWarTracker', document.getElementById('wt-key-input').value.trim());
      cachedMyName = null;
      renderLiveStatus(body);
      startLiveStatusAutoRefresh();
      panel.querySelectorAll('#wt-tabs button').forEach(b => b.classList.remove('active'));
      panel.querySelector('[data-tab="live"]').classList.add('active');
      currentTab = 'live';
    });
  }

  function renderLiveStatus(body) {
    const key = getApiKey();

    if (!key) {
      body.innerHTML = '<div class="wt-empty">Welcome! Before this works, click the Settings tab above and add your own Torn API key (Public access level is enough \u2014 no need for anything higher).</div>';
      return;
    }

    body.innerHTML = '<div class="wt-empty">Loading...</div>';

    fetchTargetFactionId().then(function (factionId) {
      return loadLiveStatus(body, key, factionId);
    }).catch(function (err) {
      body.innerHTML = '<div class="wt-empty">' + escapeHtml(err.message) + '</div>';
    });
  }

  // ---------- SAVED TARGETS ----------
  // Personal per-member list, stored locally \u2014 not shared with anyone
  // else, just your own quick reference for who you've identified as
  // beatable.
  function getSavedTargets() {
    return storageGet('savedTargets', []);
  }
  function isTargetSaved(id) {
    return getSavedTargets().some(function (t) { return String(t.id) === String(id); });
  }
  function saveTarget(id, name) {
    const targets = getSavedTargets();
    if (!targets.some(function (t) { return String(t.id) === String(id); })) {
      targets.push({ id: id, name: name });
      storageSet('savedTargets', targets);
    }
  }
  function removeTarget(id) {
    const targets = getSavedTargets().filter(function (t) { return String(t.id) !== String(id); });
    storageSet('savedTargets', targets);
  }

  // Shared row builder \u2014 used by both Live Status (all members) and
  // the Targets tab (filtered to just your saved list), so both stay in
  // sync automatically instead of duplicating this markup twice.
  function buildMemberRowHtml(m) {
    const status = (m.last_action && m.last_action.status) || 'Offline';
    const statusClass = status === 'Online' ? 'wt-status-online' : status === 'Idle' ? 'wt-status-idle' : 'wt-status-offline';
    const relative = (m.last_action && m.last_action.relative) || '';
    const stateDesc = (m.status && m.status.description) || '';
    const saved = isTargetSaved(m.id);
    return (
      '<div class="wt-row">' +
        '<div>' +
          '<div class="wt-name">' + escapeHtml(m.name) + '</div>' +
          '<div class="wt-sub"><span class="' + statusClass + '">' + status + '</span> \u00b7 ' + escapeHtml(relative) + ' \u00b7 ' + escapeHtml(stateDesc) + '</div>' +
        '</div>' +
        '<div style="display:flex; gap:6px;">' +
          '<button class="wt-save-btn' + (saved ? ' saved' : '') + '" data-id="' + m.id + '" data-name="' + escapeHtml(m.name) + '">' + (saved ? '\u2605 Saved' : '\u2606 Save') + '</button>' +
          '<button class="wt-call-btn" data-id="' + m.id + '" data-name="' + escapeHtml(m.name) + '">Call Hit</button>' +
          '<button class="wt-attack-btn" data-id="' + m.id + '">Attack</button>' +
        '</div>' +
      '</div>'
    );
  }

  // Wires up all three buttons for whatever rows are currently in body.
  // onSaveToggle lets the caller customize what happens after a
  // save/unsave (Live Status just refreshes the star; Targets removes
  // the whole row since it no longer belongs on that list).
  function attachRowHandlers(body, onSaveToggle) {
    body.querySelectorAll('.wt-attack-btn').forEach(function (attackBtn) {
      attackBtn.addEventListener('click', function () {
        const id = attackBtn.dataset.id;
        window.open('https://www.torn.com/page.php?sid=attack&user2ID=' + id, '_blank');
      });
    });

    body.querySelectorAll('.wt-call-btn').forEach(function (callBtn) {
      callBtn.addEventListener('click', function () {
        callHit(callBtn.dataset.id, callBtn.dataset.name, callBtn);
      });
    });

    body.querySelectorAll('.wt-save-btn').forEach(function (saveBtn) {
      saveBtn.addEventListener('click', function () {
        const id = saveBtn.dataset.id;
        const name = saveBtn.dataset.name;
        if (isTargetSaved(id)) {
          removeTarget(id);
        } else {
          saveTarget(id, name);
        }
        onSaveToggle(id, saveBtn);
      });
    });
  }

  function loadLiveStatus(body, key, factionId) {
    return request('GET', 'https://api.torn.com/v2/faction/' + factionId + '/members?key=' + key).then(function (response) {
      const data = JSON.parse(response.responseText);
      const members = data.members || [];
      if (members.length === 0) {
        body.innerHTML = '<div class="wt-empty">No members found \u2014 check the Faction ID in Settings.</div>';
        return;
      }

      members.sort(function (a, b) {
        const rank = { Online: 0, Idle: 1, Offline: 2 };
        const ra = rank[a.last_action && a.last_action.status] ?? 3;
        const rb = rank[b.last_action && b.last_action.status] ?? 3;
        if (ra !== rb) return ra - rb;
        return a.name.localeCompare(b.name);
      });

      body.innerHTML = members.map(buildMemberRowHtml).join('');

      attachRowHandlers(body, function (id, saveBtn) {
        const saved = isTargetSaved(id);
        saveBtn.classList.toggle('saved', saved);
        saveBtn.textContent = saved ? '\u2605 Saved' : '\u2606 Save';
      });
    }).catch(function () {
      body.innerHTML = '<div class="wt-empty">Error loading data \u2014 check your API key and Faction ID.</div>';
    });
  }

  function renderTargets(body) {
    const key = getApiKey();
    if (!key) {
      body.innerHTML = '<div class="wt-empty">Set your API key in Settings first.</div>';
      return;
    }

    const saved = getSavedTargets();
    if (saved.length === 0) {
      body.innerHTML = '<div class="wt-empty">No saved targets yet \u2014 click \u2606 Save next to anyone on the Live Status tab to add them here.</div>';
      return;
    }

    body.innerHTML = '<div class="wt-empty">Loading...</div>';

    fetchTargetFactionId().then(function (factionId) {
      return request('GET', 'https://api.torn.com/v2/faction/' + factionId + '/members?key=' + key);
    }).then(function (response) {
      const data = JSON.parse(response.responseText);
      const members = data.members || [];
      const savedIds = saved.map(function (t) { return String(t.id); });
      const filtered = members.filter(function (m) { return savedIds.indexOf(String(m.id)) !== -1; });

      // A saved target might have left the enemy faction and no longer
      // show up in the live roster \u2014 still list them (using the name
      // we stored), just without live status, rather than silently
      // dropping them.
      const foundIds = filtered.map(function (m) { return String(m.id); });
      const missing = saved.filter(function (t) { return foundIds.indexOf(String(t.id)) === -1; });

      const rowsHtml = filtered.map(buildMemberRowHtml).join('') +
        missing.map(function (t) {
          return (
            '<div class="wt-row">' +
              '<div>' +
                '<div class="wt-name">' + escapeHtml(t.name) + '</div>' +
                '<div class="wt-sub">No longer in that faction</div>' +
              '</div>' +
              '<div style="display:flex; gap:6px;">' +
                '<button class="wt-save-btn saved" data-id="' + t.id + '" data-name="' + escapeHtml(t.name) + '">\u2605 Saved</button>' +
              '</div>' +
            '</div>'
          );
        }).join('');

      body.innerHTML = rowsHtml;

      attachRowHandlers(body, function () {
        renderTargets(body); // re-render so removed targets disappear immediately
      });
    }).catch(function () {
      body.innerHTML = '<div class="wt-empty">Error loading data \u2014 check your API key.</div>';
    });
  }

  function renderPeakHours(body) {
    body.innerHTML = '<div class="wt-empty">Loading...</div>';

    request('GET', PROXY_URL + '?action=getHeatMap').then(function (response) {
      const data = JSON.parse(response.responseText);
      if (data.error) {
        body.innerHTML = '<div class="wt-empty">' + escapeHtml(data.error) + '</div>';
        return;
      }

      const hourly = (data.hours || []).slice().sort(function (a, b) { return a.hour - b.hour; });

      if (hourly.length === 0) {
        body.innerHTML = '<div class="wt-empty">No activity data yet \u2014 tracking may have just started.</div>';
        return;
      }

      const maxAvg = Math.max.apply(null, hourly.map(function (r) { return r.avg; }));

      body.innerHTML =
        '<div class="wt-sub" style="margin-bottom:8px;">All 24 hours, TCT (highest highlighted)</div>' +
        hourly.map(function (r) {
          const isPeak = r.avg === maxAvg && maxAvg > 0;
          const style = isPeak ? 'color:#c9a227; font-weight:bold;' : '';
          return (
            '<div class="wt-row">' +
              '<div class="wt-name">' + String(r.hour).padStart(2, '0') + ':00</div>' +
              '<div style="' + style + '">' + r.avg.toFixed(1) + ' avg active' + (isPeak ? ' \u2605' : '') + '</div>' +
            '</div>'
          );
        }).join('');
    }).catch(function () {
      body.innerHTML = '<div class="wt-empty">Couldn\'t read activity data \u2014 the tracker service may be unavailable.</div>';
    });
  }

  function callHit(targetId, targetName, buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = 'Calling...';

    fetchMyName().then(function (myName) {
      const url = PROXY_URL + '?action=callHit'
        + '&myName=' + encodeURIComponent(myName)
        + '&targetName=' + encodeURIComponent(targetName)
        + '&targetId=' + encodeURIComponent(targetId);

      return request('GET', url).then(function (response) {
        const data = JSON.parse(response.responseText);
        if (data.success) {
          buttonEl.textContent = 'Called!';
        } else {
          buttonEl.textContent = 'Call Hit';
          alert('Failed to send: ' + (data.error || 'unknown error'));
        }
        setTimeout(function () {
          buttonEl.disabled = false;
          buttonEl.textContent = 'Call Hit';
        }, 4000);
      });
    }).catch(function (err) {
      buttonEl.disabled = false;
      buttonEl.textContent = 'Call Hit';
      alert('Failed to send: ' + err.message);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
