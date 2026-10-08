/* MikDrop - client
 *
 * Luồng một lần gửi:
 *   A --transfer-request--> (server) --> B        : A xin phép gửi N tệp (kèm ảnh xem trước)
 *   B --transfer-accept---> (server) --> A        : B bấm [Chấp nhận]
 *   A <--signal (offer/answer/ICE)--> B           : thương lượng WebRTC qua server
 *   A ==== DataChannel (P2P) ====> B              : tệp đi thẳng từ A sang B
 *   B --ack--> A                                  : B báo đã nhận đủ
 * Nếu WebRTC không kết nối được (mạng chặn P2P) thì A chuyển sang chế độ "relay" dự phòng.
 */
(() => {
  'use strict';

  const tr = I18N.t; // dịch chuỗi (biến t trong file này dùng cho "lần truyền")

  if (typeof io === 'undefined') {
    document.body.innerHTML = `<p style="padding:32px;font:16px sans-serif;color:#fff4ec">${tr('lib.fail')}</p>`;
    return;
  }

  // ------------------------------------------------------------------ Hằng số
  // Mảnh gửi qua DataChannel: lấy theo giới hạn thông điệp SCTP hai bên thoả thuận (Chrome/Safari: 256 KB).
  // Mảnh lớn giảm số thông điệp phải xử lý. Không biết giới hạn thì dùng 64 KB cho an toàn.
  const CHUNK_MAX = 256 * 1024;
  const CHUNK_MIN = 16 * 1024;
  const CHUNK_FALLBACK = 64 * 1024;
  const READ_BLOCK = 8 * 1024 * 1024; // đọc tệp theo khối lớn và đọc trước khối kế tiếp trong lúc đang gửi
  const RELAY_CHUNK = 256 * 1024;    // mảnh gửi qua server ở chế độ dự phòng
  const RELAY_WINDOW = 8;             // số mảnh relay được phép "đang bay"
  // Chrome từ chối send() khi hàng đợi vượt ~16 MB, nên giữ ngưỡng thấp hơn đáng kể
  const HIGH_WATER = 8 * 1024 * 1024; // bufferedAmount tối đa trước khi chờ
  const LOW_WATER = 2 * 1024 * 1024;
  const STREAM_MIN = 200 * 1024 * 1024; // từ cỡ này trở lên, máy nhận (Chrome/Edge) ghi thẳng ra ổ đĩa thay vì giữ trong RAM
  const RTC_TIMEOUT = 9000;           // quá thời gian này chưa mở được kênh P2P -> dự phòng
  const RECV_TIMEOUT = 40000;         // người nhận chờ dữ liệu tối đa bao lâu
  const MAX_FILES = 2000;

  const TERMINAL = new Set(['done', 'declined', 'cancelled', 'error']);

  // ------------------------------------------------------------------ Tiện ích
  const $ = (sel, root = document) => root.querySelector(sel);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return `${n.toLocaleString(I18N.locale, { maximumFractionDigits: n >= 100 ? 0 : 1 })} ${units[i]}`;
  }

  function kindOf(f) {
    const t = (f.type || '').toLowerCase();
    const n = (f.name || '').toLowerCase();
    if (t.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|svg)$/.test(n)) return 'image';
    if (t.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi)$/.test(n)) return 'video';
    return 'file';
  }

  function describeFiles(metas) {
    const c = { image: 0, video: 0, file: 0 };
    metas.forEach((m) => c[kindOf(m)]++);
    const parts = [];
    if (c.image) parts.push(tr('n.image', { n: c.image }));
    if (c.video) parts.push(tr('n.video', { n: c.video }));
    if (c.file) parts.push(tr('n.file', { n: c.file }));
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')}${tr('n.and')}${parts[parts.length - 1]}` : parts[0] || tr('n.file', { n: 0 });
  }

  const safeName = (n) => String(n || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200) || 'file';

  // ------------------------------------------------------------------ Thiết bị của mình
  const ICONS = {
    phone: '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.6"/><path d="M11 18.6h2"/></svg>',
    tablet: '<svg viewBox="0 0 24 24"><rect x="4.5" y="3" width="15" height="18" rx="2.6"/><path d="M11 18h2"/></svg>',
    laptop: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="10" rx="1.8"/><path d="M2.5 18.5h19"/></svg>',
    desktop: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v5h5"/></svg>',
    video: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="m16 10.5 5-3v9l-5-3"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M12 19V5m0 0-6 6m6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M12 5v14m0 0-6-6m6 6 6-6"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    warn: '<svg viewBox="0 0 24 24"><path d="M12 8v5m0 3.5v.01M10.3 4.2 2.9 17.4A2 2 0 0 0 4.7 20.4h14.6a2 2 0 0 0 1.8-3L13.7 4.2a2 2 0 0 0-3.4 0Z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  };

  function detectDevice() {
    const ua = navigator.userAgent;
    const touch = navigator.maxTouchPoints > 1;
    if (/iPhone|iPod/.test(ua)) return { type: 'phone', label: 'iPhone' };
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch)) return { type: 'tablet', label: 'iPad' };
    if (/Android/.test(ua)) return /Mobile/.test(ua) ? { type: 'phone', label: 'Android' } : { type: 'tablet', labelKey: 'dev.tablet' };
    if (/Macintosh|Mac OS X/.test(ua)) return { type: 'laptop', label: 'Mac' };
    if (/Windows/.test(ua)) return { type: 'desktop', label: 'Windows PC' };
    if (/CrOS/.test(ua)) return { type: 'laptop', label: 'Chromebook' };
    if (/Linux/.test(ua)) return { type: 'desktop', label: 'Linux PC' };
    return { type: 'desktop', labelKey: 'dev.device' };
  }

  const device = detectDevice();
  const deviceLabel = () => (device.labelKey ? tr(device.labelKey) : device.label);
  const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const CAN_SHARE_FILES = (() => {
    try {
      return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] }));
    } catch (e) { return false; }
  })();
  // iPhone/iPad + HTTPS: dùng bảng chia sẻ của iOS để lưu thẳng vào Ảnh. Còn lại: tự tải xuống.
  const AUTO_SAVE = !(IS_IOS && CAN_SHARE_FILES);

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* bỏ qua */ } },
  };

  // Tên hiển thị: 'auto' = tên máy (máy chạy MikDrop: hostname; điện thoại Android: model; mạng LAN: tên router đặt cho máy)
  // hoặc tên tạm theo loại thiết bị; 'custom' = người dùng tự đặt trong Cài đặt.
  const OLD_AUTO_NAME = /^(iPhone|iPad|Android|Mac|Windows PC|Linux PC|Chromebook|Máy tính bảng|Tablet|Thiết bị|Device) ([A-Z0-9]{2})$/;
  let myName = store.get('mikdrop.name');
  let nameMode = store.get('mikdrop.nameMode');
  if (nameMode !== 'auto' && nameMode !== 'custom') nameMode = myName && !OLD_AUTO_NAME.test(myName) ? 'custom' : 'auto';
  const nameCode = store.get('mikdrop.code') || (OLD_AUTO_NAME.exec(myName || '') || [])[2] || Math.random().toString(36).slice(2, 4).toUpperCase();
  store.set('mikdrop.code', nameCode);
  let serverName = null; // tên máy do server cho biết (/api/whoami)
  let modelName = null;  // model máy Android do trình duyệt cho biết
  const machineName = () => modelName || serverName;
  const generatedName = () => `${deviceLabel()} ${nameCode}`;
  const autoName = () => machineName() || generatedName();
  if (nameMode === 'auto' || !myName) myName = autoName();
  store.set('mikdrop.nameMode', nameMode);
  store.set('mikdrop.name', myName);

  // ------------------------------------------------------------------ Trạng thái
  const peers = new Map();      // id -> { id, name, type, slot }
  const transfers = new Map();  // transferId -> transfer
  const incoming = [];          // các yêu cầu đang chờ người dùng quyết định
  let pending = [];             // tệp đã chọn nhưng chưa gửi
  let sheetPeerId = null;       // thiết bị được chạm để mở bảng gửi (dùng làm cờ "bảng đang mở")
  const sheetTargets = new Set(); // các thiết bị sẽ nhận (có thể chọn nhiều)

  // ------------------------------------------------------------------ Socket
  const socket = io({ transports: ['websocket', 'polling'], reconnectionDelayMax: 3000 });

  const statusEl = $('#status');
  let statusKind = 'connecting';
  function setStatus(kind) {
    statusKind = kind;
    statusEl.className = 'status ' + kind;
    const n = peers.size;
    $('span', statusEl).textContent =
      kind === 'on' ? (n ? tr('status.nearby', { n }) : tr('status.ready')) : kind === 'off' ? tr('status.off') : tr('status.connecting');
  }

  // Phòng: mặc định để trống = tự nhóm theo mạng. Có mã = chỉ thấy thiết bị cùng mã.
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) {
    store.set('mikdrop.room', urlRoom.trim().toLowerCase());
    history.replaceState(null, '', location.pathname);
  }
  let myRoom = store.get('mikdrop.room') || '';

  // Cấu hình ICE (STUN/TURN) do server cung cấp
  let iceServers = [];
  let relayEnabled = true;
  let shareEnabled = false; // server có nhận tệp từ Phím tắt iPhone không
  let iAmHost = false; // thiết bị này có phải chính máy chạy server (mạng nội bộ) không
  fetch('/api/config')
    .then((r) => r.json())
    .then((c) => {
      if (Array.isArray(c.iceServers)) iceServers = c.iceServers;
      relayEnabled = c.relay !== false;
      shareEnabled = c.share === true;
    })
    .catch(() => {});

  socket.on('connect', () => {
    socket.emit('join', { name: myName, type: device.type, room: myRoom });
    setStatus('on');
  });
  let activeRoom = null;
  const renderRoomLabel = () => { $('#room-label').textContent = activeRoom ? tr('room.code', { code: activeRoom }) : tr('room.auto'); };
  socket.on('room', ({ code, host }) => {
    iAmHost = !!host;
    activeRoom = code || null;
    renderRoomLabel();
  });
  socket.on('join-error', ({ code, message }) => toast(code === 'full' ? tr('err.roomFull') : message || tr('err.joinFailed'), true));
  socket.on('disconnect', () => {
    peers.clear();
    renderPeers();
    setStatus('off');
  });
  socket.on('connect_error', () => setStatus('off'));

  socket.on('peers', (list) => {
    peers.clear();
    list.forEach(addPeer);
    renderPeers();
    setStatus('on');
  });
  socket.on('peer-joined', (p) => { addPeer(p); renderPeers(); setStatus('on'); });
  socket.on('peer-updated', (p) => {
    const cur = peers.get(p.id);
    if (cur) { cur.name = p.name; cur.type = p.type; renderPeers(); }
  });
  socket.on('peer-left', ({ id }) => {
    peers.delete(id);
    renderPeers();
    setStatus('on');
    for (const t of transfers.values()) {
      if (t.peerId === id && !TERMINAL.has(t.status)) fail(t, 'err.peerLeft');
    }
  });
  socket.on('peer-gone', ({ transferId }) => {
    const t = transfers.get(transferId);
    if (t && !TERMINAL.has(t.status)) fail(t, 'err.peerLeft');
  });

  function addPeer(p) {
    // Gán "ô" cố định để biểu tượng không nhảy vị trí khi có thiết bị khác vào/ra
    const used = new Set([...peers.values()].map((x) => x.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    peers.set(p.id, { ...p, slot });
  }

  // ------------------------------------------------------------------ Radar
  const peersEl = $('#peers');
  const GOLDEN = 137.508;
  const RADII = [0.5, 0.74, 0.62];

  function renderPeers() {
    peersEl.innerHTML = '';
    for (const p of peers.values()) {
      const ang = ((p.slot * GOLDEN + 205) * Math.PI) / 180;
      const r = RADII[p.slot % RADII.length] * (1 - Math.floor(p.slot / 9) * 0.08);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'peer';
      el.dataset.id = p.id;
      el.style.left = `${50 + Math.cos(ang) * r * 50}%`;
      el.style.top = `${50 + Math.sin(ang) * r * 50}%`;
      el.innerHTML = `<span class="avatar">${ICONS[p.type] || ICONS.desktop}</span><span class="name">${esc(p.name)}</span>`;
      peersEl.appendChild(el);
    }
    $('#empty').hidden = peers.size > 0;
    $('#invitebtn').hidden = peers.size === 0;
    if (typeof sheet !== 'undefined' && !sheet.hidden) renderSheet();
  }

  peersEl.addEventListener('click', (e) => {
    const el = e.target.closest('.peer');
    if (el) openSheet(el.dataset.id);
  });

  $('#me').innerHTML = ICONS[device.type];
  $('#my-name').textContent = myName;

  // ------------------------------------------------------------------ Chọn tệp / kéo thả
  const inputPhotos = $('#input-photos');
  const inputFiles = $('#input-files');
  $('#pick-photos').addEventListener('click', () => inputPhotos.click());
  $('#pick-files').addEventListener('click', () => inputFiles.click());
  for (const input of [inputPhotos, inputFiles]) {
    input.addEventListener('change', () => {
      addFiles([...input.files]);
      input.value = '';
    });
  }

  function addFiles(list) {
    const seen = new Set(pending.map((f) => `${f.name}|${f.size}|${f.lastModified}`));
    for (const f of list) {
      const key = `${f.name}|${f.size}|${f.lastModified}`;
      if (!seen.has(key) && pending.length < MAX_FILES) { pending.push(f); seen.add(key); }
    }
    renderSheet();
    renderBanner();
  }

  function renderBanner() {
    const showBanner = pending.length > 0 && !sheetPeerId;
    $('#banner').hidden = !showBanner;
    if (showBanner) $('#banner-text').textContent = tr('banner.selected', { what: describeFiles(pending) });
  }
  $('#banner-clear').addEventListener('click', () => { pending = []; renderBanner(); });

  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { e.preventDefault(); dragDepth++; $('#dropveil').hidden = false; } });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#dropveil').hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    document.querySelectorAll('.peer.drop').forEach((n) => n.classList.remove('drop'));
    const el = e.target.closest && e.target.closest('.peer');
    if (el) el.classList.add('drop');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#dropveil').hidden = true;
    document.querySelectorAll('.peer.drop').forEach((n) => n.classList.remove('drop'));
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    const el = e.target.closest && e.target.closest('.peer');
    addFiles(files);
    if (el && !sheetPeerId) openSheet(el.dataset.id);
    else if (!peers.size) toast(tr('toast.noPeers'));
  });

  // ------------------------------------------------------------------ Ảnh xem trước
  const thumbCache = new WeakMap();
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }
  function getThumb(file) {
    if (thumbCache.has(file)) return thumbCache.get(file);
    const job = (async () => {
      if (kindOf(file) !== 'image' || file.size > 60 * 1024 * 1024) return null;
      const url = URL.createObjectURL(file);
      try {
        const img = await loadImage(url);
        const size = 160;
        const scale = Math.max(size / img.naturalWidth, size / img.naturalHeight);
        const w = img.naturalWidth * scale;
        const h = img.naturalHeight * scale;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        canvas.getContext('2d').drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        return canvas.toDataURL('image/jpeg', 0.7);
      } catch (e) {
        return null; // ví dụ HEIC trên trình duyệt không giải mã được
      } finally {
        URL.revokeObjectURL(url);
      }
    })();
    thumbCache.set(file, job);
    return job;
  }

  // ------------------------------------------------------------------ Bảng gửi tệp
  const sheet = $('#sheet');
  function openSheet(peerId) {
    const p = peers.get(peerId);
    if (!p) return;
    sheetPeerId = peerId;
    sheetTargets.clear();
    sheetTargets.add(peerId);
    sheet.hidden = false;
    renderSheet();
    renderBanner();
  }
  function closeSheet() {
    sheetPeerId = null;
    sheetTargets.clear();
    sheet.hidden = true;
    renderBanner();
  }

  function renderSheet() {
    if (sheet.hidden) return;
    // Bỏ các thiết bị đã rời mạng khỏi danh sách nhận
    for (const id of [...sheetTargets]) if (!peers.has(id)) sheetTargets.delete(id);
    if (!peers.size) { closeSheet(); return; }

    const chosen = [...sheetTargets].map((id) => peers.get(id));
    const first = chosen[0];
    $('#sheet-avatar').innerHTML = first ? ICONS[first.type] || ICONS.desktop : ICONS.desktop;
    $('#sheet-title').textContent = !chosen.length ? tr('sheet.pickTarget') : chosen.length === 1 ? tr('sheet.to1', { name: first.name }) : tr('sheet.toN', { n: chosen.length });

    // Danh sách thiết bị: chạm để chọn/bỏ chọn (chỉ hiện khi có từ 2 thiết bị trở lên)
    const targets = $('#sheet-targets');
    targets.hidden = peers.size < 2;
    if (peers.size >= 2) {
      const all = sheetTargets.size === peers.size;
      targets.innerHTML =
        [...peers.values()].map((p) => `<button type="button" class="target${sheetTargets.has(p.id) ? ' on' : ''}" data-id="${esc(p.id)}" aria-pressed="${sheetTargets.has(p.id)}"><span class="mini">${ICONS[p.type] || ICONS.desktop}</span><span class="tn">${esc(p.name)}</span></button>`).join('') +
        `<button type="button" class="target all" data-all="1">${all ? tr('sheet.none') : tr('sheet.all')}</button>`;
    }

    const list = $('#sheet-list');
    const total = pending.reduce((s, f) => s + f.size, 0);
    $('#sheet-sub').textContent = pending.length ? `${describeFiles(pending)} · ${fmtBytes(total)}` : tr('sheet.noFiles');
    $('#sheet-empty').hidden = pending.length > 0;
    $('#sheet-send').disabled = pending.length === 0 || chosen.length === 0;
    $('#sheet-send').textContent = !pending.length ? tr('sheet.send') : chosen.length > 1 ? tr('sheet.sendNM', { n: pending.length, m: chosen.length }) : tr('sheet.sendN', { n: pending.length });

    list.innerHTML = '';
    pending.slice(0, 200).forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'file-row';
      const kind = kindOf(f);
      row.innerHTML = `
        <div class="thumb">${kind === 'video' ? ICONS.video : ICONS.file}</div>
        <div class="info"><div class="fn">${esc(f.name)}</div><div class="fs">${fmtBytes(f.size)}</div></div>
        <button class="icon-btn" type="button" data-i="${i}" aria-label="${tr('sheet.remove')}">${ICONS.close}</button>`;
      list.appendChild(row);
      if (kind === 'image') {
        getThumb(f).then((d) => { if (d) $('.thumb', row).innerHTML = `<img alt="" src="${d}">`; });
      }
    });
    if (pending.length > 200) {
      const more = document.createElement('div');
      more.className = 'fs muted';
      more.style.padding = '6px';
      more.textContent = tr('sheet.more', { n: pending.length - 200 });
      list.appendChild(more);
    }
  }

  $('#sheet-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    pending.splice(Number(b.dataset.i), 1);
    renderSheet();
  });
  $('#sheet-targets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.all) {
      if (sheetTargets.size === peers.size) sheetTargets.clear();
      else peers.forEach((_, id) => sheetTargets.add(id));
    } else if (!sheetTargets.delete(b.dataset.id)) {
      sheetTargets.add(b.dataset.id);
    }
    renderSheet();
  });
  $('#sheet-cancel').addEventListener('click', closeSheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
  $('#sheet-send').addEventListener('click', () => {
    const targets = [...sheetTargets].map((id) => peers.get(id)).filter(Boolean);
    if (!targets.length) { toast(tr('toast.pickTarget'), true); return; }
    if (!pending.length) return;
    const files = pending;
    pending = [];
    closeSheet();
    // Mỗi thiết bị có một lần truyền P2P riêng, chạy song song
    targets.forEach((p) => startSend(p, files));
  });

  // ------------------------------------------------------------------ Phía gửi
  function startSend(peer, files) {
    const t = {
      id: uid(), dir: 'send', peerId: peer.id, peerName: peer.name, peerType: peer.type,
      files, metas: files.map((f) => ({ name: f.name, size: f.size, type: f.type || '' })),
      total: files.reduce((s, f) => s + f.size, 0), done: 0, sent: 0, status: 'waiting',
      mode: 'rtc', pendingCands: [], remoteSet: false,
    };
    transfers.set(t.id, t);
    upsertCard(t);

    (async () => {
      const thumbs = [];
      for (let i = 0; i < files.length && thumbs.length < 4; i++) {
        const d = await getThumb(files[i]);
        if (d) thumbs.push({ i, d });
      }
      if (t.cancelled) return;
      socket.emit('transfer-request', { to: peer.id, transferId: t.id, files: t.metas, thumbs });
    })();
  }

  // Lấy transfer tương ứng, chỉ chấp nhận thông điệp đến từ đúng thiết bị đối tác
  function mine(msg, dir) {
    const t = transfers.get(msg && msg.transferId);
    return t && t.peerId === msg.from && (!dir || t.dir === dir) ? t : null;
  }

  socket.on('transfer-accept', async (m) => {
    const t = mine(m, 'send');
    if (!t || t.status !== 'waiting') return;
    t.status = 'connecting';
    upsertCard(t);
    // Chạy trong mạng nội bộ và một đầu là chính máy chạy server (ví dụ PC chạy MikDrop.exe):
    // gửi thẳng qua WebSocket tới server nhanh hơn WebRTC (không bị giới hạn CPU của SCTP) mà không tốn thêm
    // lượt truyền Wi-Fi nào. Hai thiết bị khác thì vẫn đi P2P trực tiếp.
    const peer = peers.get(t.peerId);
    if (relayEnabled && (iAmHost || (peer && peer.host))) {
      startRelay(t, true);
      return;
    }
    await connectAsSender(t);
  });

  socket.on('transfer-decline', (m) => {
    const t = mine(m, 'send');
    if (t && !TERMINAL.has(t.status)) { t.status = 'declined'; upsertCard(t); }
  });

  socket.on('transfer-cancel', (m) => {
    const t = mine(m);
    if (!t || TERMINAL.has(t.status)) return;
    t.cancelled = true;
    t.status = 'cancelled';
    t.note = { k: 'note.peerCancelled', p: { name: t.peerName } };
    cleanup(t);
    removeIncoming(t);
    upsertCard(t);
  });

  async function connectAsSender(t) {
    try {
      const pc = new RTCPeerConnection({ iceServers });
      t.pc = pc;
      pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit('signal', { to: t.peerId, transferId: t.id, candidate: e.candidate.toJSON() });
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
          if (!t.opened) fallbackToRelay(t);
          else if (!TERMINAL.has(t.status)) fail(t, 'err.p2pBroken');
        }
      };
      const dc = pc.createDataChannel('mikdrop');
      dc.binaryType = 'arraybuffer';
      t.dc = dc;
      dc.onopen = () => {
        if (t.mode !== 'rtc' || t.started) return;
        t.opened = true;
        clearTimeout(t.connTimer);
        runSend(t, dataChannelIO(t, dc, pickChunk(pc)));
      };
      dc.onmessage = (e) => { if (typeof e.data === 'string') onSenderCtrl(t, JSON.parse(e.data)); };
      dc.onclose = () => {
        if (t.opened && !TERMINAL.has(t.status) && t.status !== 'finishing') fail(t, 'err.connLost');
      };
      t.connTimer = setTimeout(() => { if (!t.opened) fallbackToRelay(t); }, RTC_TIMEOUT);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: t.peerId, transferId: t.id, description: { type: offer.type, sdp: offer.sdp } });
    } catch (err) {
      fallbackToRelay(t);
    }
  }

  function fallbackToRelay(t) {
    startRelay(t, false);
  }

  // fast = true: chủ động chọn đường qua server nội bộ vì nhanh hơn; false: P2P không kết nối được nên dùng dự phòng
  function startRelay(t, fast) {
    if (TERMINAL.has(t.status) || t.mode === 'relay' || t.started) return;
    clearTimeout(t.connTimer);
    closePeer(t);
    t.mode = 'relay';
    t.fast = fast;
    socket.emit('use-relay', { to: t.peerId, transferId: t.id, fast });
    if (!fast) toast(tr('toast.fallback'));
    runSend(t, relayIO(t));
  }

  function closePeer(t) {
    try { if (t.dc) { t.dc.onclose = null; t.dc.close(); } } catch (e) { /* bỏ qua */ }
    try { if (t.pc) { t.pc.onconnectionstatechange = null; t.pc.close(); } } catch (e) { /* bỏ qua */ }
    t.dc = t.pc = null;
  }

  async function drain(dc) {
    while (dc.bufferedAmount > HIGH_WATER) {
      if (dc.readyState !== 'open') throw new Error('err.disconnected');
      await new Promise((resolve) => {
        dc.bufferedAmountLowThreshold = LOW_WATER;
        dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; resolve(); };
        setTimeout(resolve, 500);
      });
    }
    if (dc.readyState !== 'open') throw new Error('err.disconnected');
  }

  function pickChunk(pc) {
    const max = pc && pc.sctp && Number(pc.sctp.maxMessageSize);
    if (!max || !isFinite(max)) return CHUNK_FALLBACK;
    return Math.max(CHUNK_MIN, Math.min(CHUNK_MAX, Math.floor(max)));
  }

  function dataChannelIO(t, dc, chunk) {
    return {
      chunk,
      async sendCtrl(obj) { await drain(dc); dc.send(JSON.stringify(obj)); },
      async sendBin(buf) { await drain(dc); dc.send(buf); },
      inflight: () => dc.bufferedAmount,
    };
  }

  function relayIO(t) {
    let inflight = 0;
    let inflightBytes = 0;
    const waiters = [];
    let error = null;
    async function send(kind, data, bytes) {
      while (inflight >= RELAY_WINDOW) {
        if (error) throw error;
        await new Promise((r) => waiters.push(r));
      }
      if (error) throw error;
      inflight++;
      inflightBytes += bytes;
      socket.emit('relay', { to: t.peerId, transferId: t.id, kind, data }, (err) => {
        inflight--;
        inflightBytes -= bytes;
        if (err) {
          error = new Error(err === 'gone' ? 'err.peerLeft' : err === 'disabled' ? 'err.relayDisabled' : 'err.relayFailed');
        }
        const w = waiters.shift();
        if (w) w();
      });
    }
    return {
      chunk: RELAY_CHUNK,
      sendCtrl: (obj) => send('ctrl', obj, 0),
      sendBin: (buf) => send('bin', buf, buf.byteLength),
      inflight: () => inflightBytes,
    };
  }

  async function runSend(t, io) {
    t.started = true;
    t.status = 'sending';
    t.startedAt = performance.now();
    upsertCard(t);
    try {
      for (let i = 0; i < t.files.length; i++) {
        const f = t.files[i];
        await io.sendCtrl({ t: 'start', i, name: f.name, size: f.size, type: f.type || '' });
        // Đọc theo khối lớn và đọc trước khối kế tiếp trong lúc đang gửi khối hiện tại,
        // để việc đọc ổ đĩa (hoặc thư viện ảnh) không làm đường truyền phải chờ.
        const readBlock = (off) => f.slice(off, Math.min(off + READ_BLOCK, f.size)).arrayBuffer();
        let next = f.size > 0 ? readBlock(0) : null;
        for (let blockOff = 0; blockOff < f.size; blockOff += READ_BLOCK) {
          const block = await next;
          next = blockOff + READ_BLOCK < f.size ? readBlock(blockOff + READ_BLOCK) : null;
          for (let p = 0; p < block.byteLength; p += io.chunk) {
            if (t.cancelled) return;
            const buf = block.slice(p, p + io.chunk);
            await io.sendBin(buf);
            t.sent += buf.byteLength;
            t.done = Math.max(0, t.sent - io.inflight());
            tick(t);
          }
        }
        await io.sendCtrl({ t: 'end', i });
      }
      await io.sendCtrl({ t: 'done' });
      if (!TERMINAL.has(t.status)) { t.status = 'finishing'; upsertCard(t); }
    } catch (err) {
      if (!t.cancelled && !TERMINAL.has(t.status)) fail(t, err.message || 'err.sendFailed');
    }
  }

  function onSenderCtrl(t, msg) {
    if (msg && msg.t === 'ack' && !TERMINAL.has(t.status)) {
      t.done = t.total;
      t.status = 'done';
      t.finishedAt = performance.now();
      cleanupSoon(t);
      upsertCard(t);
    }
  }

  // ------------------------------------------------------------------ Phía nhận
  socket.on('transfer-request', (m) => {
    if (!m || typeof m.transferId !== 'string' || !Array.isArray(m.files) || !m.files.length || m.files.length > MAX_FILES) return;
    const metas = m.files.map((f) => ({ name: safeName(f.name), size: Math.max(0, Number(f.size) || 0), type: String(f.type || '') }));
    const peer = peers.get(m.from);
    const t = {
      id: m.transferId, dir: 'recv', peerId: m.from, peerName: peer ? peer.name : String(m.fromName || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || tr('in.unknown'),
      peerType: peer ? peer.type : ['phone', 'tablet', 'laptop', 'desktop'].includes(m.fromType) ? m.fromType : 'desktop',
      metas, thumbs: Array.isArray(m.thumbs) ? m.thumbs.slice(0, 4) : [], total: metas.reduce((s, f) => s + f.size, 0),
      done: 0, status: 'incoming', received: [], cur: null, pendingCands: [], remoteSet: false, mode: 'rtc',
    };
    transfers.set(t.id, t);
    incoming.push(t);
    showIncoming();
    alertUser(t);
  });

  const incomingEl = $('#incoming');
  function removeIncoming(t) {
    const i = incoming.indexOf(t);
    if (i !== -1) incoming.splice(i, 1);
    showIncoming();
  }

  function showIncoming() {
    const t = incoming[0];
    incomingEl.hidden = !t;
    if (!t) return;
    $('#in-avatar').innerHTML = ICONS[t.peerType] || ICONS.desktop;
    $('#in-title').textContent = tr('in.title', { name: t.peerName, what: describeFiles(t.metas) });
    let sub = tr('in.sub', { n: t.metas.length, size: fmtBytes(t.total) });
    if (t.total >= STREAM_MIN) {
      sub += CAN_STREAM ? tr('in.bigStream') : tr('in.bigRam');
    }
    $('#in-sub').textContent = sub;

    const pv = $('#in-previews');
    pv.innerHTML = '';
    t.thumbs.forEach((th) => {
      if (typeof th.d !== 'string' || !th.d.startsWith('data:image/')) return;
      const d = document.createElement('div');
      d.className = 'pv';
      const img = document.createElement('img');
      img.alt = '';
      img.src = th.d;
      d.appendChild(img);
      pv.appendChild(d);
    });
    const hiddenCount = t.metas.length - t.thumbs.length;
    if (t.thumbs.length && hiddenCount > 0) pv.insertAdjacentHTML('beforeend', `<div class="pv">+${hiddenCount}</div>`);

    const names = $('#in-names');
    names.innerHTML = '';
    if (!t.thumbs.length) t.metas.slice(0, 4).forEach((f) => names.insertAdjacentHTML('beforeend', `<li>${esc(f.name)} · ${fmtBytes(f.size)}</li>`));
    if (!t.thumbs.length && t.metas.length > 4) names.insertAdjacentHTML('beforeend', `<li>${tr('sheet.more', { n: t.metas.length - 4 })}</li>`);

    const q = $('#in-queue');
    q.hidden = incoming.length < 2;
    q.textContent = tr('in.queue', { n: incoming.length - 1 });
  }

  $('#in-accept').addEventListener('click', async () => {
    const t = incoming.shift();
    if (!t) return;
    const sinkPromise = chooseSink(t); // gọi ngay, không có await phía trước, để còn "thao tác của người dùng"
    showIncoming();
    t.sink = await sinkPromise;
    if (TERMINAL.has(t.status)) return; // người gửi đã huỷ trong lúc chọn nơi lưu
    t.status = 'connecting';
    t.recvTimer = setTimeout(() => { if (t.status === 'connecting') fail(t, 'err.timeout'); }, RECV_TIMEOUT);
    socket.emit('transfer-accept', { to: t.peerId, transferId: t.id });
    upsertCard(t);
    showIncoming();
  });
  $('#in-decline').addEventListener('click', () => {
    const t = incoming.shift();
    if (!t) return;
    t.status = 'declined';
    t.note = { k: 'note.youDeclined' };
    socket.emit('transfer-decline', { to: t.peerId, transferId: t.id });
    upsertCard(t);
    showIncoming();
  });

  socket.on('use-relay', (m) => {
    const t = mine(m, 'recv');
    if (!t || TERMINAL.has(t.status)) return;
    t.mode = 'relay';
    t.fast = !!m.fast;
    closePeer(t);
    upsertCard(t);
  });

  socket.on('signal', async (m) => {
    const t = mine(m);
    if (!t || TERMINAL.has(t.status)) return;
    try {
      if (m.description) {
        if (t.dir === 'recv') {
          if (t.mode === 'relay' || t.status === 'incoming') return;
          const pc = t.pc || createReceiverPeer(t);
          await pc.setRemoteDescription(m.description);
          t.remoteSet = true;
          await flushCandidates(t);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('signal', { to: t.peerId, transferId: t.id, description: { type: answer.type, sdp: answer.sdp } });
        } else if (t.pc) {
          await t.pc.setRemoteDescription(m.description);
          t.remoteSet = true;
          await flushCandidates(t);
        }
      } else if (m.candidate) {
        t.pendingCands.push(m.candidate);
        if (t.remoteSet) await flushCandidates(t);
      }
    } catch (err) {
      if (t.dir === 'send') fallbackToRelay(t);
    }
  });

  async function flushCandidates(t) {
    const list = t.pendingCands.splice(0);
    for (const c of list) {
      try { await t.pc.addIceCandidate(c); } catch (e) { /* ứng viên lỗi có thể bỏ qua */ }
    }
  }

  function createReceiverPeer(t) {
    const pc = new RTCPeerConnection({ iceServers });
    t.pc = pc;
    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('signal', { to: t.peerId, transferId: t.id, candidate: e.candidate.toJSON() });
    };
    pc.ondatachannel = (e) => {
      const dc = e.channel;
      dc.binaryType = 'arraybuffer';
      t.dc = dc;
      dc.onmessage = (ev) => {
        if (typeof ev.data === 'string') onRecvCtrl(t, JSON.parse(ev.data));
        else onRecvBin(t, ev.data);
      };
      dc.onclose = () => {
        if (!TERMINAL.has(t.status) && t.mode === 'rtc') fail(t, 'err.connLost');
      };
    };
    return pc;
  }

  // --- Ghi thẳng ra ổ đĩa cho tệp lớn (File System Access API: Chrome/Edge, trên localhost hoặc HTTPS) ---
  const CAN_STREAM = !!(window.isSecureContext && window.showSaveFilePicker && window.showDirectoryPicker);

  // Phải gọi ngay trong sự kiện bấm "Chấp nhận" vì hộp thoại chọn nơi lưu cần thao tác của người dùng
  async function chooseSink(t) {
    if (!CAN_STREAM || t.total < STREAM_MIN) return null;
    try {
      if (t.metas.length === 1) return { kind: 'file', handle: await window.showSaveFilePicker({ suggestedName: t.metas[0].name }) };
      return { kind: 'dir', dir: await window.showDirectoryPicker({ mode: 'readwrite' }) };
    } catch (err) {
      return null; // người dùng đóng hộp thoại: nhận vào bộ nhớ như bình thường
    }
  }

  async function uniqueFileHandle(dir, name) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let i = 1; ; i++) {
      try { await dir.getFileHandle(candidate); } catch (err) { return dir.getFileHandle(candidate, { create: true }); }
      candidate = `${base} (${i})${ext}`; // đã tồn tại: không ghi đè
    }
  }

  // Các thao tác ghi đĩa chạy tuần tự theo thứ tự dữ liệu đến
  function enqueue(t, fn) {
    t.chain = (t.chain || Promise.resolve())
      .then(() => (TERMINAL.has(t.status) ? null : fn()))
      .catch((err) => fail(t, 'err.disk', { msg: (err && err.message) || String(err) }));
  }

  function finishRecv(t) {
    if (TERMINAL.has(t.status)) return;
    if (t.received.length !== t.metas.length) return fail(t, 'err.missingFiles');
    t.done = t.total;
    t.status = 'done';
    t.finishedAt = performance.now();
    sendBack(t, { t: 'ack' });
    setTimeout(() => closePeer(t), 3000);
    upsertCard(t);
  }

  function onRecvCtrl(t, msg) {
    if (TERMINAL.has(t.status) || !msg) return;
    if (msg.t === 'start') {
      clearTimeout(t.recvTimer);
      if (t.status !== 'receiving') { t.status = 'receiving'; t.startedAt = performance.now(); upsertCard(t); }
      const c = { i: msg.i, name: safeName(msg.name), size: Number(msg.size) || 0, type: String(msg.type || ''), chunks: [], got: 0, writer: null };
      t.cur = c;
      if (t.sink) {
        enqueue(t, async () => {
          const handle = t.sink.kind === 'file' ? t.sink.handle : await uniqueFileHandle(t.sink.dir, c.name);
          c.savedName = handle.name;
          c.writer = await handle.createWritable();
        });
      }
    } else if (msg.t === 'end') {
      const c = t.cur;
      if (!c) return;
      if (c.got !== c.size) return fail(t, 'err.fileShort', { name: c.name });
      t.cur = null;
      if (t.sink) {
        enqueue(t, async () => {
          await c.writer.close();
          t.received.push({ name: c.savedName || c.name, size: c.size, type: c.type, url: null, disk: true });
        });
        return;
      }
      const blob = new Blob(c.chunks, { type: c.type || 'application/octet-stream' });
      const rec = { name: c.name, size: blob.size, type: c.type, blob, url: URL.createObjectURL(blob) };
      t.received.push(rec);
      if (AUTO_SAVE) saveFile(rec);
    } else if (msg.t === 'done') {
      if (t.sink) enqueue(t, () => finishRecv(t));
      else finishRecv(t);
    }
  }

  function onRecvBin(t, buf) {
    const c = t.cur;
    if (TERMINAL.has(t.status) || !c) return;
    c.got += buf.byteLength;
    t.done += buf.byteLength;
    if (t.sink) enqueue(t, () => c.writer.write(buf));
    else c.chunks.push(buf);
    tick(t);
  }

  function sendBack(t, obj) {
    if (t.mode === 'relay') socket.emit('relay', { to: t.peerId, transferId: t.id, kind: 'ctrl', data: obj }, () => {});
    else if (t.dc && t.dc.readyState === 'open') t.dc.send(JSON.stringify(obj));
  }

  // Dữ liệu đi qua server ở chế độ dự phòng
  socket.on('relay', (m, cb) => {
    if (typeof cb === 'function') cb();
    const t = mine(m);
    if (!t || t.mode !== 'relay') return;
    if (t.dir === 'recv') {
      if (m.kind === 'ctrl') onRecvCtrl(t, m.data);
      else if (m.kind === 'bin') onRecvBin(t, m.data instanceof ArrayBuffer ? m.data : new Uint8Array(m.data).buffer);
    } else if (m.kind === 'ctrl') {
      onSenderCtrl(t, m.data);
    }
  });

  // ------------------------------------------------------------------ Lưu tệp
  function saveFile(rec) {
    const a = document.createElement('a');
    a.href = rec.url;
    a.download = rec.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function saveAll(t) {
    if (CAN_SHARE_FILES && IS_IOS) {
      try {
        const files = t.received.filter((r) => r.blob).map((r) => new File([r.blob], r.name, { type: r.type || r.blob.type }));
        if (navigator.canShare({ files })) {
          await navigator.share({ files });
          return;
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    for (const r of t.received) { if (r.url) { saveFile(r); await sleep(250); } }
  }

  // ------------------------------------------------------------------ Huỷ / lỗi / dọn dẹp
  function cancelTransfer(t) {
    if (TERMINAL.has(t.status)) return;
    t.cancelled = true;
    t.status = 'cancelled';
    t.note = { k: 'note.youCancelled' };
    socket.emit('transfer-cancel', { to: t.peerId, transferId: t.id });
    cleanup(t);
    upsertCard(t);
  }

  // reason là khoá trong bảng dịch (hoặc thông báo thô của hệ thống); params dùng cho khoá có tham số
  function fail(t, reason, params) {
    if (TERMINAL.has(t.status)) return;
    t.status = 'error';
    t.note = { k: reason, p: params };
    cleanup(t);
    upsertCard(t);
  }

  function cleanup(t) {
    clearTimeout(t.connTimer);
    clearTimeout(t.recvTimer);
    closePeer(t);
    // Đang ghi dở ra ổ đĩa: huỷ để không để lại tệp dang dở
    if (t.cur && t.cur.writer) t.cur.writer.abort().catch(() => {});
    if (t.cur) t.cur = null;
  }
  function cleanupSoon(t) {
    clearTimeout(t.connTimer);
    setTimeout(() => closePeer(t), 600);
  }

  function dismiss(t) {
    if (!TERMINAL.has(t.status)) return;
    (t.received || []).forEach((r) => { if (r.url) URL.revokeObjectURL(r.url); });
    transfers.delete(t.id);
    const el = document.getElementById('t-' + t.id);
    if (el) el.remove();
    syncTray();
  }

  // ------------------------------------------------------------------ Khay hoạt động
  const tray = $('#tray');
  function syncTray() {
    tray.hidden = tray.children.length === 0;
  }

  const noteText = (t) => (t.note ? tr(t.note.k, t.note.p) : '');

  function statusText(t) {
    const who = esc(t.peerName);
    switch (t.status) {
      case 'waiting': return tr('st.waiting', { name: who });
      case 'incoming': return tr('st.incoming');
      case 'connecting': return t.dir === 'send' ? tr('st.connectingSend') : tr('st.connectingRecv');
      case 'sending': case 'receiving': return progressText(t);
      case 'finishing': return tr('st.finishing');
      case 'done': {
        const secs = t.startedAt && t.finishedAt ? (t.finishedAt - t.startedAt) / 1000 : 0;
        const speed = secs > 0.3 && t.total > 1024 * 1024 ? tr('st.avg', { speed: fmtBytes(t.total / secs) }) : '';
        const where = t.sink ? tr('st.savedDisk') : '';
        return `${t.dir === 'send' ? tr('st.sent') : tr('st.received')} · ${fmtBytes(t.total)}${speed}${where}`;
      }
      case 'declined': return t.note ? esc(noteText(t)) : tr('st.declined', { name: who });
      case 'cancelled': return t.note ? esc(noteText(t)) : tr('st.cancelled');
      case 'error': return esc(t.note ? noteText(t) : tr('err.generic'));
      default: return '';
    }
  }

  function progressText(t) {
    const pct = t.total ? Math.min(100, Math.floor((t.done / t.total) * 100)) : 0;
    const secs = (performance.now() - (t.startedAt || performance.now())) / 1000;
    const speed = secs > 0.5 ? ` · ${fmtBytes(t.done / secs)}/s` : '';
    return `${pct}% · ${fmtBytes(t.done)} / ${fmtBytes(t.total)}${speed}${t.mode === 'relay' ? (t.fast ? tr('st.viaHost') : tr('st.fallback')) : ''}`;
  }

  function cardHTML(t) {
    const ok = t.status === 'done';
    const bad = t.status === 'error' || t.status === 'declined' || t.status === 'cancelled';
    const active = !TERMINAL.has(t.status);
    const icon = ok ? ICONS.check : bad ? ICONS.warn : t.dir === 'send' ? ICONS.up : ICONS.down;
    const title = tr(t.dir === 'send' ? 'card.send' : 'card.recv', { what: describeFiles(t.metas), name: esc(t.peerName) });
    const indeterminate = ['waiting', 'incoming', 'connecting', 'finishing'].includes(t.status);

    let extra = '';
    if (t.dir === 'recv' && ok) {
      const chips = t.received.slice(0, 6).map((r, i) => {
        const media = r.url && kindOf(r) === 'image'
          ? `<img alt="" loading="lazy" decoding="async" src="${r.url}">`
          : `<span class="ph">${kindOf(r) === 'video' ? ICONS.video : ICONS.file}</span>`;
        // Tệp đã ghi thẳng ra ổ đĩa không còn trong bộ nhớ nên không có nút "lưu lại"
        return r.url
          ? `<button class="chip" type="button" data-act="save" data-i="${i}" title="${tr('card.saveAgain')}">${media}<span>${esc(r.name)}</span></button>`
          : `<span class="chip" title="${tr('card.onDisk')}">${media}<span>${esc(r.name)}</span></span>`;
      }).join('');
      const more = t.received.length > 6 ? `<span class="chip" style="padding:4px 10px">+${t.received.length - 6}</span>` : '';
      extra = `<div class="got">${chips}${more}</div>`;
      const label = IS_IOS && CAN_SHARE_FILES ? tr('card.saveIos') : tr('card.saveAll');
      if (!t.sink && (!AUTO_SAVE || t.received.length > 1)) extra +=`<button class="btn small ${AUTO_SAVE ? '' : 'primary'}" type="button" data-act="saveall">${label}</button>`;
    }

    return `
      <div class="card-row">
        <div class="dir">${icon}</div>
        <div class="card-main">
          <div class="card-title">${title}</div>
          <div class="card-meta" data-role="meta">${statusText(t)}</div>
        </div>
        <button class="icon-btn" type="button" data-act="${active ? 'cancel' : 'dismiss'}" aria-label="${active ? tr('card.cancel') : tr('card.close')}">${ICONS.close}</button>
      </div>
      ${t.status === 'incoming' || TERMINAL.has(t.status) && !ok ? '' : `<div class="bar ${indeterminate ? 'indeterminate' : ''}" data-role="bar"><i style="width:${t.total ? Math.min(100, (t.done / t.total) * 100) : ok ? 100 : 0}%"></i></div>`}
      ${extra}`;
  }

  function upsertCard(t) {
    let el = document.getElementById('t-' + t.id);
    if (!el) {
      el = document.createElement('div');
      el.id = 't-' + t.id;
      tray.prepend(el);
    }
    const ok = t.status === 'done';
    const bad = t.status === 'error' || t.status === 'declined' || t.status === 'cancelled';
    el.className = 'card' + (ok ? ' done' : bad ? ' fail' : '');
    el.innerHTML = cardHTML(t);
    syncTray();
    syncWakeLock();
  }

  // ------------------------------------------------------------------ Giữ màn hình sáng khi đang truyền
  // Trình duyệt di động tạm dừng trang web khi khoá màn hình hoặc chuyển sang app khác, làm đứt kết nối.
  // Wake Lock (cần HTTPS hoặc localhost) giữ màn hình sáng cho đến khi truyền xong.
  const BUSY_STATES = ['connecting', 'sending', 'receiving', 'finishing'];
  const IS_MOBILE = IS_IOS || /Android/i.test(navigator.userAgent);
  let wakeLock = null;
  let warnedAwake = false;

  async function syncWakeLock() {
    const busy = [...transfers.values()].some((t) => BUSY_STATES.includes(t.status));
    if (busy && !warnedAwake && IS_MOBILE && !('wakeLock' in navigator)) {
      warnedAwake = true;
      toast(tr('toast.stayAwake'));
    }
    if (busy && !wakeLock && 'wakeLock' in navigator && !document.hidden) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } catch (err) { /* không bắt buộc */ }
    } else if (!busy && wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncWakeLock(); });

  let lastTick = 0;
  function tick(t) {
    const now = performance.now();
    if (now - lastTick < 100) return;
    lastTick = now;
    const el = document.getElementById('t-' + t.id);
    if (!el) return;
    const meta = $('[data-role="meta"]', el);
    const fill = $('[data-role="bar"] > i', el);
    if (meta) meta.textContent = statusText(t).replace(/&amp;/g, '&');
    if (fill) fill.style.width = `${t.total ? Math.min(100, (t.done / t.total) * 100) : 0}%`;
  }

  tray.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const card = e.target.closest('.card');
    if (!btn || !card) return;
    const t = transfers.get(card.id.slice(2));
    if (!t) return;
    switch (btn.dataset.act) {
      case 'cancel': cancelTransfer(t); break;
      case 'dismiss': dismiss(t); break;
      case 'save': { const r = t.received[Number(btn.dataset.i)]; if (r) saveFile(r); break; }
      case 'saveall': saveAll(t); break;
    }
  });

  // ------------------------------------------------------------------ Thông báo
  const baseTitle = document.title;
  let flashTimer = null;
  function alertUser(t) {
    if (navigator.vibrate) navigator.vibrate([90, 50, 90]);
    if (!document.hidden) return;
    let on = false;
    clearInterval(flashTimer);
    flashTimer = setInterval(() => {
      on = !on;
      document.title = on ? tr('in.notify', { name: t.peerName }) : baseTitle;
    }, 900);
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('MikDrop', { body: tr('in.title', { name: t.peerName, what: describeFiles(t.metas) }) });
      }
    } catch (e) { /* bỏ qua */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { clearInterval(flashTimer); document.title = baseTitle; }
  });

  const toastsEl = $('#toasts');
  function toast(text, isErr) {
    const el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = text;
    toastsEl.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // ------------------------------------------------------------------ Cài đặt: tên hiển thị + ngôn ngữ
  const settingsEl = $('#settings');
  const nameInput = $('#name-input');
  const langSeg = $('#lang-seg');

  function setName(name) {
    myName = name;
    store.set('mikdrop.name', name);
    $('#my-name').textContent = name;
    socket.emit('rename', name);
  }

  // Lưu tên người dùng nhập: để trống hoặc trùng tên máy thì quay về chế độ tự động
  function saveName(raw) {
    const v = raw.trim().slice(0, 40);
    if (!v) nameMode = 'auto';
    else if (machineName() && v === machineName()) nameMode = 'auto';
    else if (v !== myName) nameMode = 'custom';
    store.set('mikdrop.nameMode', nameMode);
    setName(v || autoName());
  }

  function setMachineName(kind, value) {
    const v = String(value || '').trim().slice(0, 40);
    if (!v) return;
    if (kind === 'server') serverName = v; else modelName = v;
    if (nameMode === 'auto' && autoName() !== myName) setName(autoName());
    renderSettings();
  }

  function renderSettings() {
    langSeg.innerHTML = I18N.LANGS
      .map((l) => `<button type="button" class="target${l.code === I18N.lang ? ' on' : ''}" data-lang="${l.code}" aria-pressed="${l.code === I18N.lang}">${esc(l.label)}</button>`)
      .join('');
    const m = machineName();
    const useBtn = $('#use-machine');
    useBtn.hidden = !m || nameInput.value.trim() === m;
    if (m) useBtn.textContent = tr('set.useMachine', { name: m });
    $('#name-hint').textContent = nameMode === 'auto' ? (m ? tr('set.hintMachine') : tr('set.hintNoMachine')) : tr('set.hintCustom');
  }

  function openSettings() {
    nameInput.value = myName;
    renderSettings();
    settingsEl.hidden = false;
    setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);
  }
  $('#whoami').addEventListener('click', openSettings);
  $('#settingsbtn').addEventListener('click', openSettings);
  function closeSettings() {
    if (settingsEl.hidden) return;
    saveName(nameInput.value);
    settingsEl.hidden = true;
  }
  settingsEl.addEventListener('click', (e) => { if (e.target === settingsEl) closeSettings(); });
  nameInput.addEventListener('input', renderSettings);
  langSeg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (b) I18N.setLang(b.dataset.lang); // áp dụng ngay, refreshAll() chạy qua I18N.onChange
  });
  $('#use-machine').addEventListener('click', () => { nameInput.value = machineName() || ''; renderSettings(); });
  $('#settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    closeSettings();
  });

  // Tên máy: server biết hostname của máy chạy MikDrop (và tên mà router đặt cho các máy khác trong LAN);
  // Android Chrome (HTTPS/localhost) cho biết model máy.
  fetch('/api/whoami').then((r) => r.json()).then((i) => setMachineName('server', i && i.machineName)).catch(() => {});
  try {
    if (navigator.userAgentData && /Android/i.test(navigator.userAgent)) {
      navigator.userAgentData.getHighEntropyValues(['model']).then((v) => setMachineName('model', v && v.model)).catch(() => {});
    }
  } catch (e) { /* bỏ qua */ }

  // Đổi ngôn ngữ: vẽ lại mọi chuỗi đang hiển thị
  function refreshAll() {
    if (nameMode === 'auto' && !machineName() && myName !== generatedName()) setName(generatedName());
    setStatus(statusKind);
    renderRoomLabel();
    renderBanner();
    renderSheet();
    showIncoming();
    for (const t of transfers.values()) upsertCard(t);
    if (!inviteEl.hidden) renderInvite();
    $('#speed-run').textContent = speedBusy ? tr('sp.running') : tr('sp.rerun');
    if (!settingsEl.hidden) renderSettings();
  }
  I18N.onChange(refreshAll);

  // ------------------------------------------------------------------ Đo tốc độ mạng
  const speedEl = $('#speed');
  let speedBusy = false;
  const mbps = (bytes, ms) => bytes / 1048576 / (ms / 1000);
  const fmtSpeed = (v) => `${v >= 10 ? Math.round(v) : v.toFixed(1).replace('.', I18N.lang === 'vi' ? ',' : '.')} MB/s`;

  async function timedDown(mb) {
    const t0 = performance.now();
    const buf = await (await fetch(`/api/speedtest/down?mb=${mb}&t=${Date.now()}`, { cache: 'no-store' })).arrayBuffer();
    return mbps(buf.byteLength, performance.now() - t0);
  }
  async function timedUp(mb) {
    const body = new Blob([new Uint8Array(mb * 1048576)]);
    const t0 = performance.now();
    await fetch('/api/speedtest/up', { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' }, cache: 'no-store' });
    return mbps(body.size, performance.now() - t0);
  }

  async function runSpeedTest() {
    if (speedBusy) return;
    speedBusy = true;
    const run = $('#speed-run');
    run.disabled = true;
    run.textContent = tr('sp.running');
    for (const id of ['#sp-ping', '#sp-down', '#sp-up']) $(id).textContent = '…';
    $('#sp-note').textContent = '';
    try {
      const pings = [];
      for (let i = 0; i < 6; i++) {
        const t0 = performance.now();
        await fetch(`/healthz?t=${Date.now()}${i}`, { cache: 'no-store' });
        pings.push(performance.now() - t0);
      }
      pings.shift(); // lần đầu có thể gồm cả thời gian mở kết nối
      pings.sort((a, b) => a - b);
      const ping = pings[Math.floor(pings.length / 2)];
      $('#sp-ping').textContent = `${Math.round(ping)} ms`;

      // Đo thử nhỏ để chọn dung lượng sao cho mỗi lần đo kéo dài vài giây
      const size = (probe) => Math.max(4, Math.min(60, Math.round(probe * 3)));
      const down = await timedDown(size(await timedDown(2)));
      $('#sp-down').textContent = fmtSpeed(down);
      const up = await timedUp(size(await timedUp(2)));
      $('#sp-up').textContent = fmtSpeed(up);

      const worst = Math.min(down, up);
      const local = /^(localhost|127\.)/.test(location.hostname);
      let note;
      if (local) {
        note = tr('sp.local');
      } else if (worst < 3) {
        note = tr('sp.slow', { v: fmtSpeed(worst) });
      } else if (worst < 15) {
        note = tr('sp.mid', { v: fmtSpeed(worst) });
      } else {
        note = tr('sp.good', { v: fmtSpeed(worst) });
      }
      if (!local && ping > 80) note += tr('sp.highPing');
      $('#sp-note').innerHTML = note;
    } catch (err) {
      $('#sp-note').textContent = tr('sp.fail');
    } finally {
      speedBusy = false;
      run.disabled = false;
      run.textContent = tr('sp.rerun');
    }
  }
  $('#speedbtn').addEventListener('click', () => { closeSettings(); speedEl.hidden = false; runSpeedTest(); });
  $('#speed-run').addEventListener('click', runSpeedTest);
  $('#speed-close').addEventListener('click', () => { speedEl.hidden = true; });
  speedEl.addEventListener('click', (e) => { if (e.target === speedEl && !speedBusy) speedEl.hidden = true; });

  // ------------------------------------------------------------------ Mời thiết bị bằng mã QR
  const inviteEl = $('#invite');
  let inviteUrls = [];
  let inviteIdx = 0;

  async function loadInviteUrls() {
    // Mở từ localhost thì iPhone không dùng được địa chỉ đó, nên hỏi server địa chỉ mạng LAN của máy
    const isLocal = /^(localhost|127\.|\[?::1\]?$)/.test(location.hostname);
    let urls = [];
    if (isLocal) {
      try { urls = ((await (await fetch('/api/info')).json()).urls) || []; } catch (e) { /* bỏ qua */ }
    } else {
      urls = [location.origin];
    }
    return urls.map((u) => (myRoom ? `${u}/?room=${encodeURIComponent(myRoom)}` : u));
  }

  function renderInvite() {
    const box = $('#qr-box');
    const url = inviteUrls[inviteIdx];
    box.hidden = !url;
    $('#invite-url').textContent = url || tr('inv.noUrl');
    if (url) $('#qr-img').src = `/api/qr.svg?u=${encodeURIComponent(url)}`;
    const list = $('#invite-urls');
    list.hidden = inviteUrls.length < 2;
    list.innerHTML = inviteUrls.length < 2 ? '' : inviteUrls
      .map((u, i) => `<button type="button" class="target${i === inviteIdx ? ' on' : ''}" data-i="${i}">${esc(u.replace(/^https?:\/\//, '').replace(/\/\?room=.*$/, ''))}</button>`)
      .join('');
  }

  async function openInvite() {
    inviteEl.hidden = false;
    inviteUrls = await loadInviteUrls();
    inviteIdx = 0;
    renderInvite();
  }
  $('#invitebtn').addEventListener('click', openInvite);
  $('#empty-qr').addEventListener('click', openInvite);
  $('#invite-close').addEventListener('click', () => { inviteEl.hidden = true; });
  inviteEl.addEventListener('click', (e) => { if (e.target === inviteEl) inviteEl.hidden = true; });
  $('#invite-urls').addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) { inviteIdx = Number(b.dataset.i); renderInvite(); }
  });

  // ------------------------------------------------------------------ Chia sẻ từ app khác
  const shareHelpEl = $('#sharehelp');

  function copyText(text) {
    const done = () => toast(tr('toast.copiedText'));
    const legacy = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* người dùng tự chọn và sao chép */ }
      ta.remove();
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, legacy);
    else legacy();
  }

  async function openShareHelp() {
    shareHelpEl.hidden = false;
    $('#sh-ios').hidden = !shareEnabled;
    $('#sh-ios-off').hidden = shareEnabled;
    $('#sh-android-warn').hidden = window.isSecureContext;
    const isLocal = /^(localhost|127\.|\[?::1\]?$)/.test(location.hostname);
    let base = location.origin;
    if (isLocal) {
      try { base = ((await (await fetch('/api/info')).json()).urls || [])[0] || base; } catch (e) { /* dùng localhost */ }
    }
    const room = myRoom ? `room=${encodeURIComponent(myRoom)}` : '';
    $('#sh-devices').textContent = `${base}/api/devices${room ? '?' + room : ''}`;
    $('#sh-share').textContent = `${base}/api/share?${room ? room + '&' : ''}to=`;
  }
  $('#sharebtn').addEventListener('click', () => { closeSettings(); openShareHelp(); });
  $('#sharehelp-close').addEventListener('click', () => { shareHelpEl.hidden = true; });
  shareHelpEl.addEventListener('click', (e) => { if (e.target === shareHelpEl) shareHelpEl.hidden = true; });
  $('#sh-devices').addEventListener('click', (e) => copyText(e.currentTarget.textContent));
  $('#sh-share').addEventListener('click', (e) => copyText(e.currentTarget.textContent));

  // Android: nút Chia sẻ của hệ điều hành gửi tệp tới /share-target; service worker cất tệp vào cache rồi chuyển về /?share=1
  async function takeSharedFiles() {
    if (new URLSearchParams(location.search).get('share') !== '1') return;
    history.replaceState(null, '', location.pathname);
    try {
      const cache = await caches.open('mikdrop-share');
      const files = [];
      for (const req of await cache.keys()) {
        const res = await cache.match(req);
        const blob = await res.blob();
        files.push(new File([blob], decodeURIComponent(res.headers.get('X-Name') || 'file'), {
          type: res.headers.get('Content-Type') || blob.type,
          lastModified: Number(res.headers.get('X-Modified')) || Date.now(),
        }));
        await cache.delete(req);
      }
      if (files.length) addFiles(files); // thanh "Đã chọn N tệp - chạm vào một thiết bị để gửi" hiện ra
    } catch (e) { /* không có cache: bỏ qua */ }
  }
  takeSharedFiles();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  // Bản exe chạy nền (không có cửa sổ để đóng): hiện nút thoát khi mở từ chính máy chạy server
  if (/^(localhost|127\.)/.test(location.hostname)) {
    fetch('/api/info').then((r) => r.json()).then((info) => { if (info.canQuit) $('#quitbtn').hidden = false; }).catch(() => {});
  }
  $('#quitbtn').addEventListener('click', async () => {
    if (!window.confirm(tr('quit.confirm'))) return;
    try { await fetch('/api/quit', { method: 'POST', headers: { 'X-MikDrop': '1' } }); } catch (e) { /* server đã tắt */ }
    document.body.innerHTML = '<p style="padding:32px;font:16px sans-serif;color:#fff4ec">' + tr('quit.bye') + '</p>';
  });

  // Lần đầu mở trên chính máy chạy server (ví dụ vừa bấm đúp MikDrop.exe): tự hiện mã QR một lần
  if (/^(localhost|127\.)/.test(location.hostname) && !store.get('mikdrop.qrshown')) {
    store.set('mikdrop.qrshown', '1');
    setTimeout(() => { if (!peers.size) openInvite(); }, 1500);
  }

  // ------------------------------------------------------------------ Phòng
  const roomEl = $('#room');
  const roomInput = $('#room-input');
  const randomCode = () => {
    const words = ['nha', 'meo', 'cam', 'bien', 'sao', 'gio', 'mua', 'tra'];
    return `${words[Math.floor(Math.random() * words.length)]}-${Math.random().toString(36).slice(2, 7)}`;
  };
  function joinRoom(code) {
    myRoom = code;
    store.set('mikdrop.room', code);
    pending.length = 0;
    socket.emit('join', { name: myName, type: device.type, room: myRoom });
  }
  $('#roombtn').addEventListener('click', () => {
    roomInput.value = myRoom;
    roomEl.hidden = false;
  });
  $('#room-random').addEventListener('click', () => { roomInput.value = randomCode(); });
  $('#room-auto').addEventListener('click', () => { joinRoom(''); roomEl.hidden = true; });
  roomEl.addEventListener('click', (e) => { if (e.target === roomEl) roomEl.hidden = true; });
  $('#room-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = roomInput.value.trim().toLowerCase();
    if (code && !/^[a-z0-9][a-z0-9-]{2,23}$/.test(code)) {
      toast(tr('toast.roomFormat'), true);
      return;
    }
    joinRoom(code);
    roomEl.hidden = true;
  });
  $('#room-invite').addEventListener('click', async () => {
    if (!myRoom) { toast(tr('toast.needRoom')); return; }
    const link = `${location.origin}/?room=${encodeURIComponent(myRoom)}`;
    try {
      if (navigator.share) await navigator.share({ title: 'MikDrop', text: tr('inv.shareText'), url: link });
      else { await navigator.clipboard.writeText(link); toast(tr('toast.copied')); }
    } catch (err) {
      if (!err || err.name !== 'AbortError') window.prompt(tr('inv.copyPrompt'), link);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!speedEl.hidden && !speedBusy) speedEl.hidden = true;
    else if (!inviteEl.hidden) inviteEl.hidden = true;
    else if (!roomEl.hidden) roomEl.hidden = true;
    else if (!shareHelpEl.hidden) shareHelpEl.hidden = true;
    else if (!settingsEl.hidden) closeSettings();
    else if (!sheet.hidden) closeSheet();
  });

  window.addEventListener('beforeunload', (e) => {
    const busy = [...transfers.values()].some((t) => ['sending', 'receiving', 'connecting', 'finishing'].includes(t.status));
    if (busy) { e.preventDefault(); e.returnValue = ''; }
  });

  setStatus('connecting');
  renderRoomLabel();
  $('#speed-run').textContent = tr('sp.rerun');
  renderPeers();
})();
