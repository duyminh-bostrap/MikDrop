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

  // ------------------------------------------------------------------ Hằng số
  const CHUNK = 64 * 1024;            // mảnh gửi qua DataChannel (an toàn với mọi trình duyệt)
  const RELAY_CHUNK = 256 * 1024;     // mảnh gửi qua server ở chế độ dự phòng
  const RELAY_WINDOW = 6;             // số mảnh relay được phép "đang bay"
  const HIGH_WATER = 4 * 1024 * 1024; // bufferedAmount tối đa trước khi chờ
  const LOW_WATER = 1024 * 1024;
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
    return `${n.toLocaleString('vi-VN', { maximumFractionDigits: n >= 100 ? 0 : 1 })} ${units[i]}`;
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
    if (c.image) parts.push(`${c.image} hình ảnh`);
    if (c.video) parts.push(`${c.video} video`);
    if (c.file) parts.push(`${c.file} tệp`);
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} và ${parts[parts.length - 1]}` : parts[0] || '0 tệp';
  }

  const safeName = (n) => String(n || 'tệp').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200) || 'tệp';

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
    if (/Android/.test(ua)) return /Mobile/.test(ua) ? { type: 'phone', label: 'Android' } : { type: 'tablet', label: 'Máy tính bảng' };
    if (/Macintosh|Mac OS X/.test(ua)) return { type: 'laptop', label: 'Mac' };
    if (/Windows/.test(ua)) return { type: 'desktop', label: 'Windows PC' };
    if (/CrOS/.test(ua)) return { type: 'laptop', label: 'Chromebook' };
    if (/Linux/.test(ua)) return { type: 'desktop', label: 'Linux PC' };
    return { type: 'desktop', label: 'Thiết bị' };
  }

  const device = detectDevice();
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

  let myName = store.get('mikdrop.name');
  if (!myName) {
    const code = Math.random().toString(36).slice(2, 4).toUpperCase();
    myName = `${device.label} ${code}`;
    store.set('mikdrop.name', myName);
  }

  // ------------------------------------------------------------------ Trạng thái
  const peers = new Map();      // id -> { id, name, type, slot }
  const transfers = new Map();  // transferId -> transfer
  const incoming = [];          // các yêu cầu đang chờ người dùng quyết định
  let pending = [];             // tệp đã chọn nhưng chưa gửi
  let sheetPeerId = null;

  // ------------------------------------------------------------------ Socket
  const socket = io({ transports: ['websocket', 'polling'], reconnectionDelayMax: 3000 });

  const statusEl = $('#status');
  function setStatus(kind) {
    statusEl.className = 'status ' + kind;
    const n = peers.size;
    $('span', statusEl).textContent =
      kind === 'on' ? (n ? `${n} thiết bị gần đây` : 'Sẵn sàng') : kind === 'off' ? 'Mất kết nối, đang thử lại…' : 'Đang kết nối…';
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
  fetch('/api/config')
    .then((r) => r.json())
    .then((c) => { if (Array.isArray(c.iceServers)) iceServers = c.iceServers; })
    .catch(() => {});

  socket.on('connect', () => {
    socket.emit('join', { name: myName, type: device.type, room: myRoom });
    setStatus('on');
  });
  socket.on('room', ({ code }) => {
    $('#room-label').textContent = code ? `Phòng: ${code}` : 'Cùng mạng Wi-Fi';
  });
  socket.on('join-error', ({ message }) => toast(message || 'Không vào được phòng.', true));
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
      if (t.peerId === id && !TERMINAL.has(t.status)) fail(t, 'Thiết bị đã ngắt kết nối');
    }
  });
  socket.on('peer-gone', ({ transferId }) => {
    const t = transfers.get(transferId);
    if (t && !TERMINAL.has(t.status)) fail(t, 'Thiết bị đã ngắt kết nối');
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
    if (showBanner) $('#banner-text').textContent = `Đã chọn ${describeFiles(pending)} - chạm vào một thiết bị để gửi`;
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
    else if (!peers.size) toast('Chưa có thiết bị nào gần đây để gửi.');
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
    $('#sheet-avatar').innerHTML = ICONS[p.type] || ICONS.desktop;
    $('#sheet-title').textContent = `Gửi tới ${p.name}`;
    sheet.hidden = false;
    renderSheet();
    renderBanner();
  }
  function closeSheet() {
    sheetPeerId = null;
    sheet.hidden = true;
    renderBanner();
  }

  function renderSheet() {
    if (sheet.hidden && !sheetPeerId) return;
    const list = $('#sheet-list');
    const total = pending.reduce((s, f) => s + f.size, 0);
    $('#sheet-sub').textContent = pending.length ? `${describeFiles(pending)} · ${fmtBytes(total)}` : 'Chưa chọn tệp nào';
    $('#sheet-empty').hidden = pending.length > 0;
    $('#sheet-send').disabled = pending.length === 0;
    $('#sheet-send').textContent = pending.length ? `Gửi ${pending.length} tệp` : 'Gửi';

    list.innerHTML = '';
    pending.slice(0, 200).forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'file-row';
      const kind = kindOf(f);
      row.innerHTML = `
        <div class="thumb">${kind === 'video' ? ICONS.video : ICONS.file}</div>
        <div class="info"><div class="fn">${esc(f.name)}</div><div class="fs">${fmtBytes(f.size)}</div></div>
        <button class="icon-btn" type="button" data-i="${i}" aria-label="Bỏ tệp này">${ICONS.close}</button>`;
      list.appendChild(row);
      if (kind === 'image') {
        getThumb(f).then((d) => { if (d) $('.thumb', row).innerHTML = `<img alt="" src="${d}">`; });
      }
    });
    if (pending.length > 200) {
      const more = document.createElement('div');
      more.className = 'fs muted';
      more.style.padding = '6px';
      more.textContent = `… và ${pending.length - 200} tệp khác`;
      list.appendChild(more);
    }
  }

  $('#sheet-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    pending.splice(Number(b.dataset.i), 1);
    renderSheet();
  });
  $('#sheet-cancel').addEventListener('click', closeSheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
  $('#sheet-send').addEventListener('click', () => {
    const p = peers.get(sheetPeerId);
    if (!p) { toast('Thiết bị này không còn trong mạng.', true); closeSheet(); return; }
    if (!pending.length) return;
    const files = pending;
    pending = [];
    closeSheet();
    startSend(p, files);
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
    t.note = `${t.peerName} đã huỷ`;
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
          else if (!TERMINAL.has(t.status)) fail(t, 'Kết nối P2P bị gián đoạn');
        }
      };
      const dc = pc.createDataChannel('mikdrop');
      dc.binaryType = 'arraybuffer';
      t.dc = dc;
      dc.onopen = () => {
        if (t.mode !== 'rtc' || t.started) return;
        t.opened = true;
        clearTimeout(t.connTimer);
        runSend(t, dataChannelIO(t, dc));
      };
      dc.onmessage = (e) => { if (typeof e.data === 'string') onSenderCtrl(t, JSON.parse(e.data)); };
      dc.onclose = () => {
        if (t.opened && !TERMINAL.has(t.status) && t.status !== 'finishing') fail(t, 'Kết nối bị ngắt giữa chừng');
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
    if (TERMINAL.has(t.status) || t.mode === 'relay' || t.started) return;
    clearTimeout(t.connTimer);
    closePeer(t);
    t.mode = 'relay';
    t.note = 'Chế độ dự phòng qua máy chủ';
    socket.emit('use-relay', { to: t.peerId, transferId: t.id });
    toast('Không kết nối trực tiếp được, chuyển sang chế độ dự phòng.');
    runSend(t, relayIO(t));
  }

  function closePeer(t) {
    try { if (t.dc) { t.dc.onclose = null; t.dc.close(); } } catch (e) { /* bỏ qua */ }
    try { if (t.pc) { t.pc.onconnectionstatechange = null; t.pc.close(); } } catch (e) { /* bỏ qua */ }
    t.dc = t.pc = null;
  }

  async function drain(dc) {
    while (dc.bufferedAmount > HIGH_WATER) {
      if (dc.readyState !== 'open') throw new Error('Kết nối bị ngắt');
      await new Promise((resolve) => {
        dc.bufferedAmountLowThreshold = LOW_WATER;
        dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; resolve(); };
        setTimeout(resolve, 500);
      });
    }
    if (dc.readyState !== 'open') throw new Error('Kết nối bị ngắt');
  }

  function dataChannelIO(t, dc) {
    return {
      chunk: CHUNK,
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
          error = new Error(
            err === 'gone' ? 'Thiết bị đã ngắt kết nối'
              : err === 'disabled' ? 'Không kết nối trực tiếp được và máy chủ đã tắt chế độ dự phòng'
                : 'Đường truyền dự phòng bị lỗi'
          );
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
        for (let off = 0; off < f.size; off += io.chunk) {
          if (t.cancelled) return;
          const buf = await f.slice(off, off + io.chunk).arrayBuffer();
          await io.sendBin(buf);
          t.sent += buf.byteLength;
          t.done = Math.max(0, t.sent - io.inflight());
          tick(t);
        }
        await io.sendCtrl({ t: 'end', i });
      }
      await io.sendCtrl({ t: 'done' });
      if (!TERMINAL.has(t.status)) { t.status = 'finishing'; upsertCard(t); }
    } catch (err) {
      if (!t.cancelled && !TERMINAL.has(t.status)) fail(t, err.message || 'Gửi thất bại');
    }
  }

  function onSenderCtrl(t, msg) {
    if (msg && msg.t === 'ack' && !TERMINAL.has(t.status)) {
      t.done = t.total;
      t.status = 'done';
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
      id: m.transferId, dir: 'recv', peerId: m.from, peerName: peer ? peer.name : 'Thiết bị lạ', peerType: peer ? peer.type : 'desktop',
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
    $('#in-title').textContent = `${t.peerName} muốn gửi ${describeFiles(t.metas)}`;
    $('#in-sub').textContent = `${t.metas.length} tệp · ${fmtBytes(t.total)}`;

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
    if (!t.thumbs.length && t.metas.length > 4) names.insertAdjacentHTML('beforeend', `<li>… và ${t.metas.length - 4} tệp khác</li>`);

    const q = $('#in-queue');
    q.hidden = incoming.length < 2;
    q.textContent = `Còn ${incoming.length - 1} yêu cầu khác đang chờ`;
  }

  $('#in-accept').addEventListener('click', () => {
    const t = incoming.shift();
    if (!t) return;
    t.status = 'connecting';
    t.recvTimer = setTimeout(() => { if (t.status === 'connecting') fail(t, 'Hết thời gian chờ kết nối'); }, RECV_TIMEOUT);
    socket.emit('transfer-accept', { to: t.peerId, transferId: t.id });
    upsertCard(t);
    showIncoming();
  });
  $('#in-decline').addEventListener('click', () => {
    const t = incoming.shift();
    if (!t) return;
    t.status = 'declined';
    t.note = 'Bạn đã từ chối';
    socket.emit('transfer-decline', { to: t.peerId, transferId: t.id });
    upsertCard(t);
    showIncoming();
  });

  socket.on('use-relay', (m) => {
    const t = mine(m, 'recv');
    if (!t || TERMINAL.has(t.status)) return;
    t.mode = 'relay';
    t.note = 'Chế độ dự phòng qua máy chủ';
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
        if (!TERMINAL.has(t.status) && t.mode === 'rtc') fail(t, 'Kết nối bị ngắt giữa chừng');
      };
    };
    return pc;
  }

  function onRecvCtrl(t, msg) {
    if (TERMINAL.has(t.status) || !msg) return;
    if (msg.t === 'start') {
      clearTimeout(t.recvTimer);
      if (t.status !== 'receiving') { t.status = 'receiving'; t.startedAt = performance.now(); upsertCard(t); }
      t.cur = { i: msg.i, name: safeName(msg.name), size: Number(msg.size) || 0, type: String(msg.type || ''), chunks: [], got: 0 };
    } else if (msg.t === 'end') {
      const c = t.cur;
      if (!c) return;
      if (c.got !== c.size) return fail(t, `Tệp "${c.name}" bị thiếu dữ liệu`);
      const blob = new Blob(c.chunks, { type: c.type || 'application/octet-stream' });
      const rec = { name: c.name, size: blob.size, type: c.type, blob, url: URL.createObjectURL(blob) };
      t.received.push(rec);
      t.cur = null;
      if (AUTO_SAVE) saveFile(rec);
    } else if (msg.t === 'done') {
      if (t.received.length !== t.metas.length) return fail(t, 'Nhận không đủ số tệp');
      t.done = t.total;
      t.status = 'done';
      sendBack(t, { t: 'ack' });
      setTimeout(() => closePeer(t), 3000);
      upsertCard(t);
    }
  }

  function onRecvBin(t, buf) {
    if (TERMINAL.has(t.status) || !t.cur) return;
    t.cur.chunks.push(buf);
    t.cur.got += buf.byteLength;
    t.done += buf.byteLength;
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
        const files = t.received.map((r) => new File([r.blob], r.name, { type: r.type || r.blob.type }));
        if (navigator.canShare({ files })) {
          await navigator.share({ files });
          return;
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    for (const r of t.received) { saveFile(r); await sleep(250); }
  }

  // ------------------------------------------------------------------ Huỷ / lỗi / dọn dẹp
  function cancelTransfer(t) {
    if (TERMINAL.has(t.status)) return;
    t.cancelled = true;
    t.status = 'cancelled';
    t.note = 'Bạn đã huỷ';
    socket.emit('transfer-cancel', { to: t.peerId, transferId: t.id });
    cleanup(t);
    upsertCard(t);
  }

  function fail(t, reason) {
    if (TERMINAL.has(t.status)) return;
    t.status = 'error';
    t.note = reason;
    cleanup(t);
    upsertCard(t);
  }

  function cleanup(t) {
    clearTimeout(t.connTimer);
    clearTimeout(t.recvTimer);
    closePeer(t);
    if (t.cur) t.cur = null;
  }
  function cleanupSoon(t) {
    clearTimeout(t.connTimer);
    setTimeout(() => closePeer(t), 600);
  }

  function dismiss(t) {
    if (!TERMINAL.has(t.status)) return;
    (t.received || []).forEach((r) => URL.revokeObjectURL(r.url));
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

  function statusText(t) {
    const who = esc(t.peerName);
    switch (t.status) {
      case 'waiting': return `Đang chờ ${who} chấp nhận…`;
      case 'incoming': return 'Đang chờ bạn xác nhận';
      case 'connecting': return t.dir === 'send' ? 'Đang kết nối trực tiếp…' : 'Đang kết nối…';
      case 'sending': case 'receiving': return progressText(t);
      case 'finishing': return 'Đang hoàn tất…';
      case 'done': return t.dir === 'send' ? `Đã gửi · ${fmtBytes(t.total)}` : `Đã nhận · ${fmtBytes(t.total)}`;
      case 'declined': return t.note || `${who} đã từ chối`;
      case 'cancelled': return t.note || 'Đã huỷ';
      case 'error': return esc(t.note || 'Có lỗi xảy ra');
      default: return '';
    }
  }

  function progressText(t) {
    const pct = t.total ? Math.min(100, Math.floor((t.done / t.total) * 100)) : 0;
    const secs = (performance.now() - (t.startedAt || performance.now())) / 1000;
    const speed = secs > 0.5 ? ` · ${fmtBytes(t.done / secs)}/s` : '';
    return `${pct}% · ${fmtBytes(t.done)} / ${fmtBytes(t.total)}${speed}${t.mode === 'relay' ? ' · dự phòng' : ''}`;
  }

  function cardHTML(t) {
    const ok = t.status === 'done';
    const bad = t.status === 'error' || t.status === 'declined' || t.status === 'cancelled';
    const active = !TERMINAL.has(t.status);
    const icon = ok ? ICONS.check : bad ? ICONS.warn : t.dir === 'send' ? ICONS.up : ICONS.down;
    const title = t.dir === 'send' ? `Gửi ${describeFiles(t.metas)} tới ${esc(t.peerName)}` : `Nhận ${describeFiles(t.metas)} từ ${esc(t.peerName)}`;
    const indeterminate = ['waiting', 'incoming', 'connecting', 'finishing'].includes(t.status);

    let extra = '';
    if (t.dir === 'recv' && ok) {
      const chips = t.received.slice(0, 6).map((r, i) => {
        const media = kindOf(r) === 'image'
          ? `<img alt="" loading="lazy" decoding="async" src="${r.url}">`
          : `<span class="ph">${kindOf(r) === 'video' ? ICONS.video : ICONS.file}</span>`;
        return `<button class="chip" type="button" data-act="save" data-i="${i}" title="Lưu lại">${media}<span>${esc(r.name)}</span></button>`;
      }).join('');
      const more = t.received.length > 6 ? `<span class="chip" style="padding:4px 10px">+${t.received.length - 6}</span>` : '';
      extra = `<div class="got">${chips}${more}</div>`;
      const label = IS_IOS && CAN_SHARE_FILES ? 'Lưu vào Ảnh / Tệp' : 'Lưu lại tất cả';
      if (!AUTO_SAVE || t.received.length > 1) extra += `<button class="btn small ${AUTO_SAVE ? '' : 'primary'}" type="button" data-act="saveall">${label}</button>`;
    }

    return `
      <div class="card-row">
        <div class="dir">${icon}</div>
        <div class="card-main">
          <div class="card-title">${title}</div>
          <div class="card-meta" data-role="meta">${statusText(t)}</div>
        </div>
        <button class="icon-btn" type="button" data-act="${active ? 'cancel' : 'dismiss'}" aria-label="${active ? 'Huỷ' : 'Đóng'}">${ICONS.close}</button>
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
  }

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
      document.title = on ? `● ${t.peerName} muốn gửi tệp` : baseTitle;
    }, 900);
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('MikDrop', { body: `${t.peerName} muốn gửi ${describeFiles(t.metas)}` });
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

  // ------------------------------------------------------------------ Đổi tên
  const renameEl = $('#rename');
  const renameInput = $('#rename-input');
  $('#whoami').addEventListener('click', () => {
    renameInput.value = myName;
    renameEl.hidden = false;
    setTimeout(() => { renameInput.focus(); renameInput.select(); }, 50);
  });
  $('#rename-cancel').addEventListener('click', () => { renameEl.hidden = true; });
  renameEl.addEventListener('click', (e) => { if (e.target === renameEl) renameEl.hidden = true; });
  $('#rename-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = renameInput.value.trim().slice(0, 40);
    if (name) {
      myName = name;
      store.set('mikdrop.name', name);
      $('#my-name').textContent = name;
      socket.emit('rename', name);
    }
    renameEl.hidden = true;
  });

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
      toast('Mã phòng gồm 3-24 ký tự: chữ không dấu, số và dấu gạch ngang.', true);
      return;
    }
    joinRoom(code);
    roomEl.hidden = true;
  });
  $('#room-invite').addEventListener('click', async () => {
    if (!myRoom) { toast('Hãy nhập hoặc tạo mã phòng trước.'); return; }
    const link = `${location.origin}/?room=${encodeURIComponent(myRoom)}`;
    try {
      if (navigator.share) await navigator.share({ title: 'MikDrop', text: 'Vào phòng MikDrop của tôi', url: link });
      else { await navigator.clipboard.writeText(link); toast('Đã sao chép liên kết mời.'); }
    } catch (err) {
      if (!err || err.name !== 'AbortError') window.prompt('Sao chép liên kết này:', link);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!roomEl.hidden) roomEl.hidden = true;
    else if (!renameEl.hidden) renameEl.hidden = true;
    else if (!sheet.hidden) closeSheet();
  });

  window.addEventListener('beforeunload', (e) => {
    const busy = [...transfers.values()].some((t) => ['sending', 'receiving', 'connecting', 'finishing'].includes(t.status));
    if (busy) { e.preventDefault(); e.returnValue = ''; }
  });

  setStatus('connecting');
  renderPeers();
})();
