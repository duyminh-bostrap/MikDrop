/* MikDrop - đa ngôn ngữ (Tiếng Việt / English)
 *
 * Dùng:  I18N.t('key', { name: 'An' })   -> chuỗi theo ngôn ngữ hiện tại (không có khoá thì trả lại chính khoá đó)
 * HTML:  data-i18n="key"            -> đặt textContent
 *        data-i18n-html="key"       -> đặt innerHTML (chỉ dùng với chuỗi do mình viết ở file này)
 *        data-i18n-attr="placeholder:key;aria-label:key"
 * Giá trị trong bảng là chuỗi có {tham_số}, hoặc hàm (params) => chuỗi khi cần số ít/số nhiều.
 */
(() => {
  'use strict';

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  const DICT = {
    vi: {
      // --- chung / trạng thái
      'status.connecting': 'Đang kết nối…',
      'status.ready': 'Sẵn sàng',
      'status.nearby': ({ n }) => `${n} thiết bị gần đây`,
      'status.off': 'Mất kết nối, đang thử lại…',
      'lib.fail': 'Không tải được thư viện kết nối (Socket.io). Hãy tải lại trang (Ctrl+F5) hoặc kiểm tra server MikDrop còn đang chạy.',

      // --- giao diện tĩnh
      'top.invite': 'Hiện mã QR để mở trên thiết bị khác',
      'top.inviteTitle': 'Mời thiết bị bằng mã QR',
      'top.settings': 'Cài đặt',
      'banner.clear': 'Bỏ chọn',
      'empty.text': 'Mở <b>MikDrop</b> trên thiết bị khác cùng mạng Wi-Fi để bắt đầu.',
      'empty.qr': 'Hiện mã QR để mở trên điện thoại',
      'foot.youAre': 'Bạn hiển thị là',
      'foot.nameTitle': 'Đổi tên thiết bị và ngôn ngữ',
      'foot.quit': 'Thoát MikDrop',
      'foot.speed': 'Đo tốc độ mạng',
      'foot.roomTitle': 'Kết nối thiết bị ở mạng khác bằng mã phòng',
      'drop.veil': 'Thả tệp để chọn',

      // --- bảng gửi
      'pick.photos': 'Ảnh & video',
      'pick.files': 'Tệp',
      'sheet.empty': 'Chọn ảnh, tệp hoặc kéo thả vào đây',
      'sheet.cancel': 'Huỷ',
      'sheet.send': 'Gửi',
      'sheet.pickTarget': 'Chọn thiết bị nhận',
      'sheet.to1': ({ name }) => `Gửi tới ${name}`,
      'sheet.toN': ({ n }) => `Gửi tới ${n} thiết bị`,
      'sheet.all': 'Chọn tất cả',
      'sheet.none': 'Bỏ chọn tất cả',
      'sheet.noFiles': 'Chưa chọn tệp nào',
      'sheet.sendN': ({ n }) => `Gửi ${n} tệp`,
      'sheet.sendNM': ({ n, m }) => `Gửi ${n} tệp tới ${m} máy`,
      'sheet.remove': 'Bỏ tệp này',
      'sheet.more': ({ n }) => `… và ${n} tệp khác`,

      // --- mô tả số lượng tệp
      'n.image': ({ n }) => `${n} hình ảnh`,
      'n.video': ({ n }) => `${n} video`,
      'n.file': ({ n }) => `${n} tệp`,
      'n.and': ' và ',
      'file.default': 'tệp',

      // --- nhận tệp
      'in.decline': 'Từ chối',
      'in.accept': 'Chấp nhận',
      'in.title': ({ name, what }) => `${name} muốn gửi ${what}`,
      'in.sub': ({ n, size }) => `${n} tệp · ${size}`,
      'in.bigStream': '. Bạn sẽ được chọn nơi lưu, tệp ghi thẳng ra ổ đĩa.',
      'in.bigRam': '. Tệp lớn được giữ trong bộ nhớ cho đến khi nhận xong; có thể lỗi nếu thiết bị thiếu RAM.',
      'in.queue': ({ n }) => `Còn ${n} yêu cầu khác đang chờ`,
      'in.unknown': 'Thiết bị lạ',
      'in.notify': ({ name }) => `● ${name} muốn gửi tệp`,

      // --- thẻ hoạt động
      'card.send': ({ what, name }) => `Gửi ${what} tới ${name}`,
      'card.recv': ({ what, name }) => `Nhận ${what} từ ${name}`,
      'card.cancel': 'Huỷ',
      'card.close': 'Đóng',
      'card.saveAgain': 'Lưu lại',
      'card.onDisk': 'Đã lưu vào ổ đĩa',
      'card.saveIos': 'Lưu vào Ảnh / Tệp',
      'card.saveAll': 'Lưu lại tất cả',
      'st.waiting': ({ name }) => `Đang chờ ${name} chấp nhận…`,
      'st.incoming': 'Đang chờ bạn xác nhận',
      'st.connectingSend': 'Đang kết nối trực tiếp…',
      'st.connectingRecv': 'Đang kết nối…',
      'st.finishing': 'Đang hoàn tất…',
      'st.sent': 'Đã gửi',
      'st.received': 'Đã nhận',
      'st.avg': ({ speed }) => ` · TB ${speed}/s`,
      'st.savedDisk': ' · đã lưu vào ổ đĩa',
      'st.declined': ({ name }) => `${name} đã từ chối`,
      'st.cancelled': 'Đã huỷ',
      'st.viaHost': ' · qua máy chủ nội bộ',
      'st.fallback': ' · dự phòng',
      'note.peerCancelled': ({ name }) => `${name} đã huỷ`,
      'note.youDeclined': 'Bạn đã từ chối',
      'note.youCancelled': 'Bạn đã huỷ',

      // --- lỗi
      'err.generic': 'Có lỗi xảy ra',
      'err.peerLeft': 'Thiết bị đã ngắt kết nối',
      'err.p2pBroken': 'Kết nối P2P bị gián đoạn',
      'err.connLost': 'Kết nối bị ngắt giữa chừng',
      'err.disconnected': 'Kết nối bị ngắt',
      'err.relayDisabled': 'Không kết nối trực tiếp được và máy chủ đã tắt chế độ dự phòng',
      'err.relayFailed': 'Đường truyền dự phòng bị lỗi',
      'err.sendFailed': 'Gửi thất bại',
      'err.timeout': 'Hết thời gian chờ kết nối',
      'err.disk': ({ msg }) => `Không ghi được tệp ra ổ đĩa: ${msg}`,
      'err.missingFiles': 'Nhận không đủ số tệp',
      'err.fileShort': ({ name }) => `Tệp "${name}" bị thiếu dữ liệu`,
      'err.roomFull': 'Phòng đã đầy.',
      'err.joinFailed': 'Không vào được phòng.',

      // --- thông báo ngắn
      'toast.noPeers': 'Chưa có thiết bị nào gần đây để gửi.',
      'toast.pickTarget': 'Hãy chọn ít nhất một thiết bị nhận.',
      'toast.fallback': 'Không kết nối trực tiếp được, chuyển sang chế độ dự phòng.',
      'toast.stayAwake': 'Giữ màn hình sáng và đừng chuyển sang app khác cho đến khi truyền xong.',
      'toast.copied': 'Đã sao chép liên kết mời.',
      'toast.needRoom': 'Hãy nhập hoặc tạo mã phòng trước.',
      'toast.roomFormat': 'Mã phòng gồm 3-24 ký tự: chữ không dấu, số và dấu gạch ngang.',
      'banner.selected': ({ what }) => `Đã chọn ${what} - chạm vào một thiết bị để gửi`,

      // --- đo tốc độ
      'sp.title': 'Đo tốc độ mạng',
      'sp.desc': 'Đo giữa thiết bị này và máy chạy MikDrop. Đây cũng là tốc độ tối đa khi gửi tệp giữa hai thiết bị.',
      'sp.ping': 'Độ trễ',
      'sp.down': 'Tải xuống',
      'sp.up': 'Tải lên',
      'sp.close': 'Đóng',
      'sp.rerun': 'Đo lại',
      'sp.running': 'Đang đo…',
      'sp.local': 'Bạn đang đo ngay trên máy chạy MikDrop nên số này không phản ánh Wi-Fi. <strong>Mở MikDrop trên điện thoại rồi đo ở đó</strong> để biết tốc độ thật.',
      'sp.slow': ({ v }) => `<strong>Wi-Fi đang rất chậm</strong> (khoảng ${v}), nên gửi tệp không thể nhanh hơn. Thử: lại gần router, dùng băng tần 5 GHz, tránh dùng hotspot điện thoại, tắt chế độ tiết kiệm pin trên điện thoại, tắt VPN.`,
      'sp.mid': ({ v }) => `Mạng ở mức trung bình (${v}). Tốc độ gửi tệp sẽ không vượt con số này. Băng tần 5 GHz và đứng gần router sẽ nhanh hơn.`,
      'sp.good': ({ v }) => `<strong>Mạng tốt.</strong> Tốc độ gửi tệp có thể đạt gần ${v}.`,
      'sp.highPing': ' Độ trễ cao: điện thoại có thể đang tiết kiệm điện Wi-Fi, hãy giữ màn hình sáng khi gửi.',
      'sp.fail': 'Không đo được. Kiểm tra kết nối tới máy chạy MikDrop rồi thử lại.',

      // --- mời thiết bị
      'inv.title': 'Mở MikDrop trên thiết bị khác',
      'inv.hint': 'Kết nối cùng Wi-Fi, mở app Camera (iPhone) hoặc Camera/Google Lens (Android) rồi quét mã bên dưới.',
      'inv.alt': 'Mã QR mở MikDrop',
      'inv.noUrl': 'Chưa thấy địa chỉ mạng. Hãy kết nối Wi-Fi hoặc bật Mobile Hotspot rồi thử lại.',
      'inv.helpTitle': 'Điện thoại không mở được?',
      'inv.help1': 'Điện thoại và máy này phải <b>cùng một Wi-Fi</b> (không dùng 4G/5G, tắt VPN, không dùng mạng "khách").',
      'inv.help2': 'Windows: khi hiện hộp thoại tường lửa, tick <b>Mạng riêng tư</b> rồi Cho phép. Nếu đã lỡ chặn, mở PowerShell bằng quyền <b>Administrator</b> và chạy:<br><code>New-NetFirewallRule -DisplayName "MikDrop" -Direction Inbound -Protocol TCP -LocalPort 3000-3010 -Action Allow -Profile Private,Public</code>',
      'inv.help3': 'Linux: mở cổng trên tường lửa, ví dụ <code>sudo ufw allow 3000/tcp</code> (Ubuntu/Debian) hoặc <code>sudo firewall-cmd --permanent --add-port=3000/tcp &amp;&amp; sudo firewall-cmd --reload</code> (Fedora).',
      'inv.helpAndroid': 'Android: nếu Wi-Fi không có Internet, Android có thể tự chuyển sang 4G/5G nên không vào được địa chỉ này. Hãy tắt dữ liệu di động, hoặc chọn <b>Giữ kết nối Wi-Fi</b> khi được hỏi. Địa chỉ <code>mikdrop.local</code> thường không dùng được trên Android, hãy dùng địa chỉ IP.',
      'inv.help4': 'Mạng Wi-Fi của máy này nên đặt là <b>Private</b> (Settings → Network &amp; internet → Wi-Fi → thuộc tính).',
      'inv.help5': 'Nếu địa chỉ có nhiều lựa chọn, thử từng địa chỉ ở trên. Router bật "AP isolation" cũng sẽ chặn.',
      'inv.done': 'Xong',
      'inv.shareText': 'Vào phòng MikDrop của tôi',
      'inv.copyPrompt': 'Sao chép liên kết này:',

      // --- phòng
      'room.auto': 'Cùng mạng Wi-Fi',
      'room.code': ({ code }) => `Phòng: ${code}`,
      'room.title': 'Kết nối thiết bị',
      'room.desc': 'Mặc định MikDrop tự tìm các thiết bị cùng mạng Wi-Fi với bạn. Nếu thiết bị ở mạng khác, hoặc không thấy nhau, hãy nhập chung một mã phòng.',
      'room.placeholder': 'Mã phòng, ví dụ: nha-an-123',
      'room.random': 'Tạo mã ngẫu nhiên',
      'room.invite': 'Gửi liên kết mời',
      'room.btnAuto': 'Tự động',
      'room.join': 'Vào phòng',

      // --- cài đặt
      'set.title': 'Cài đặt',
      'set.language': 'Ngôn ngữ',
      'set.name': 'Tên hiển thị',
      'set.namePh': 'Ví dụ: iPhone của An',
      'set.useMachine': ({ name }) => `Dùng tên máy: ${name}`,
      'set.hintMachine': 'Đang dùng tên máy. Các thiết bị khác sẽ thấy bạn bằng tên này.',
      'set.hintCustom': 'Tên này hiện cho các thiết bị khác thấy bạn.',
      'set.hintNoMachine': 'Trình duyệt không cho biết tên thiết bị này nên MikDrop đặt tên tạm. Bạn có thể tự đặt tên khác.',
      'set.done': 'Xong',

      // --- thoát
      'quit.confirm': 'Thoát MikDrop? Các thiết bị khác sẽ không gửi được tệp nữa.',
      'quit.bye': 'MikDrop đã tắt. Bạn có thể đóng tab này.',

      // --- tên thiết bị tạm
      'dev.tablet': 'Máy tính bảng',
      'dev.device': 'Thiết bị',
    },

    en: {
      'status.connecting': 'Connecting…',
      'status.ready': 'Ready',
      'status.nearby': ({ n }) => plural(n, 'device nearby', 'devices nearby'),
      'status.off': 'Disconnected, retrying…',
      'lib.fail': 'Could not load the connection library (Socket.io). Reload the page (Ctrl+F5) or check that the MikDrop server is still running.',

      'top.invite': 'Show a QR code to open on another device',
      'top.inviteTitle': 'Invite a device with a QR code',
      'top.settings': 'Settings',
      'banner.clear': 'Clear',
      'empty.text': 'Open <b>MikDrop</b> on another device on the same Wi-Fi network to get started.',
      'empty.qr': 'Show a QR code to open on a phone',
      'foot.youAre': 'You appear as',
      'foot.nameTitle': 'Change device name and language',
      'foot.quit': 'Quit MikDrop',
      'foot.speed': 'Test network speed',
      'foot.roomTitle': 'Connect devices on other networks with a room code',
      'drop.veil': 'Drop files to select',

      'pick.photos': 'Photos & videos',
      'pick.files': 'Files',
      'sheet.empty': 'Choose photos or files, or drag and drop them here',
      'sheet.cancel': 'Cancel',
      'sheet.send': 'Send',
      'sheet.pickTarget': 'Choose a device',
      'sheet.to1': ({ name }) => `Send to ${name}`,
      'sheet.toN': ({ n }) => `Send to ${n} devices`,
      'sheet.all': 'Select all',
      'sheet.none': 'Deselect all',
      'sheet.noFiles': 'No files selected',
      'sheet.sendN': ({ n }) => `Send ${plural(n, 'file', 'files')}`,
      'sheet.sendNM': ({ n, m }) => `Send ${plural(n, 'file', 'files')} to ${m} devices`,
      'sheet.remove': 'Remove this file',
      'sheet.more': ({ n }) => `… and ${n} more`,

      'n.image': ({ n }) => plural(n, 'image', 'images'),
      'n.video': ({ n }) => plural(n, 'video', 'videos'),
      'n.file': ({ n }) => plural(n, 'file', 'files'),
      'n.and': ' and ',
      'file.default': 'file',

      'in.decline': 'Decline',
      'in.accept': 'Accept',
      'in.title': ({ name, what }) => `${name} wants to send ${what}`,
      'in.sub': ({ n, size }) => `${plural(n, 'file', 'files')} · ${size}`,
      'in.bigStream': '. You will be asked where to save, and the file is written straight to disk.',
      'in.bigRam': '. Large files are kept in memory until received; this may fail if the device runs low on RAM.',
      'in.queue': ({ n }) => `${plural(n, 'more request', 'more requests')} waiting`,
      'in.unknown': 'Unknown device',
      'in.notify': ({ name }) => `● ${name} wants to send files`,

      'card.send': ({ what, name }) => `Sending ${what} to ${name}`,
      'card.recv': ({ what, name }) => `Receiving ${what} from ${name}`,
      'card.cancel': 'Cancel',
      'card.close': 'Close',
      'card.saveAgain': 'Save again',
      'card.onDisk': 'Saved to disk',
      'card.saveIos': 'Save to Photos / Files',
      'card.saveAll': 'Save all',
      'st.waiting': ({ name }) => `Waiting for ${name} to accept…`,
      'st.incoming': 'Waiting for your answer',
      'st.connectingSend': 'Connecting directly…',
      'st.connectingRecv': 'Connecting…',
      'st.finishing': 'Finishing…',
      'st.sent': 'Sent',
      'st.received': 'Received',
      'st.avg': ({ speed }) => ` · avg ${speed}/s`,
      'st.savedDisk': ' · saved to disk',
      'st.declined': ({ name }) => `${name} declined`,
      'st.cancelled': 'Cancelled',
      'st.viaHost': ' · via local server',
      'st.fallback': ' · fallback',
      'note.peerCancelled': ({ name }) => `${name} cancelled`,
      'note.youDeclined': 'You declined',
      'note.youCancelled': 'You cancelled',

      'err.generic': 'Something went wrong',
      'err.peerLeft': 'The device disconnected',
      'err.p2pBroken': 'The P2P connection was interrupted',
      'err.connLost': 'The connection was lost midway',
      'err.disconnected': 'Disconnected',
      'err.relayDisabled': 'A direct connection could not be made and the server has fallback mode turned off',
      'err.relayFailed': 'The fallback connection failed',
      'err.sendFailed': 'Sending failed',
      'err.timeout': 'Timed out waiting for a connection',
      'err.disk': ({ msg }) => `Could not write the file to disk: ${msg}`,
      'err.missingFiles': 'Not all files were received',
      'err.fileShort': ({ name }) => `File "${name}" is missing data`,
      'err.roomFull': 'The room is full.',
      'err.joinFailed': 'Could not join the room.',

      'toast.noPeers': 'No devices nearby to send to.',
      'toast.pickTarget': 'Choose at least one device to send to.',
      'toast.fallback': 'Could not connect directly, switching to fallback mode.',
      'toast.stayAwake': 'Keep the screen on and stay in this app until the transfer finishes.',
      'toast.copied': 'Invite link copied.',
      'toast.needRoom': 'Enter or generate a room code first.',
      'toast.roomFormat': 'A room code has 3-24 characters: letters (a-z), digits and hyphens.',
      'banner.selected': ({ what }) => `${what} selected - tap a device to send`,

      'sp.title': 'Network speed test',
      'sp.desc': 'Measured between this device and the computer running MikDrop. This is also the top speed when sending files between two devices.',
      'sp.ping': 'Latency',
      'sp.down': 'Download',
      'sp.up': 'Upload',
      'sp.close': 'Close',
      'sp.rerun': 'Test again',
      'sp.running': 'Testing…',
      'sp.local': 'You are testing on the computer running MikDrop, so this number does not reflect Wi-Fi. <strong>Open MikDrop on your phone and test there</strong> to see the real speed.',
      'sp.slow': ({ v }) => `<strong>Wi-Fi is very slow</strong> (about ${v}), so sending files cannot be any faster. Try: move closer to the router, use the 5 GHz band, avoid phone hotspots, turn off battery saver / Low Power Mode, turn off VPN.`,
      'sp.mid': ({ v }) => `The network is average (${v}). File transfers will not exceed this. The 5 GHz band and standing closer to the router will be faster.`,
      'sp.good': ({ v }) => `<strong>Good network.</strong> File transfers can reach nearly ${v}.`,
      'sp.highPing': ' High latency: the phone may be saving Wi-Fi power, so keep the screen on while sending.',
      'sp.fail': 'Could not test. Check the connection to the computer running MikDrop and try again.',

      'inv.title': 'Open MikDrop on another device',
      'inv.hint': 'Connect to the same Wi-Fi, open the Camera app (iPhone) or Camera / Google Lens (Android) and scan the code below.',
      'inv.alt': 'QR code to open MikDrop',
      'inv.noUrl': 'No network address found. Connect to Wi-Fi or turn on a Mobile Hotspot and try again.',
      'inv.helpTitle': 'Phone cannot open it?',
      'inv.help1': 'The phone and this computer must be on <b>the same Wi-Fi</b> (no 4G/5G, turn off VPN, no "guest" network).',
      'inv.help2': 'Windows: when the firewall dialog appears, tick <b>Private networks</b> and click Allow. If you already blocked it, open PowerShell as <b>Administrator</b> and run:<br><code>New-NetFirewallRule -DisplayName "MikDrop" -Direction Inbound -Protocol TCP -LocalPort 3000-3010 -Action Allow -Profile Private,Public</code>',
      'inv.help3': 'Linux: open the port in the firewall, for example <code>sudo ufw allow 3000/tcp</code> (Ubuntu/Debian) or <code>sudo firewall-cmd --permanent --add-port=3000/tcp &amp;&amp; sudo firewall-cmd --reload</code> (Fedora).',
      'inv.helpAndroid': 'Android: if the Wi-Fi has no Internet, Android may switch to 4G/5G and then cannot reach this address. Turn off mobile data, or choose <b>Stay connected</b> when asked. The <code>mikdrop.local</code> address usually does not work on Android, so use the IP address.',
      'inv.help4': 'This computer\'s Wi-Fi network should be set to <b>Private</b> (Settings → Network &amp; internet → Wi-Fi → properties).',
      'inv.help5': 'If there are several addresses, try each one above. A router with "AP isolation" turned on will also block it.',
      'inv.done': 'Done',
      'inv.shareText': 'Join my MikDrop room',
      'inv.copyPrompt': 'Copy this link:',

      'room.auto': 'Same Wi-Fi network',
      'room.code': ({ code }) => `Room: ${code}`,
      'room.title': 'Connect devices',
      'room.desc': 'By default MikDrop finds devices on the same Wi-Fi network as you. If a device is on another network, or you cannot see each other, enter the same room code on both.',
      'room.placeholder': 'Room code, e.g. home-alex-123',
      'room.random': 'Generate a random code',
      'room.invite': 'Share invite link',
      'room.btnAuto': 'Automatic',
      'room.join': 'Join room',

      'set.title': 'Settings',
      'set.language': 'Language',
      'set.name': 'Display name',
      'set.namePh': 'e.g. Alex\'s iPhone',
      'set.useMachine': ({ name }) => `Use computer name: ${name}`,
      'set.hintMachine': 'Using the computer name. Other devices will see you by this name.',
      'set.hintCustom': 'Other devices see you by this name.',
      'set.hintNoMachine': 'The browser does not reveal this device\'s name, so MikDrop picked a temporary one. You can set your own.',
      'set.done': 'Done',

      'quit.confirm': 'Quit MikDrop? Other devices will no longer be able to send files.',
      'quit.bye': 'MikDrop has stopped. You can close this tab.',

      'dev.tablet': 'Tablet',
      'dev.device': 'Device',
    },
  };

  const LANGS = [
    { code: 'vi', label: 'Tiếng Việt', locale: 'vi-VN' },
    { code: 'en', label: 'English', locale: 'en-US' },
  ];

  const KEY = 'mikdrop.lang';
  let lang = 'vi';
  try {
    const saved = localStorage.getItem(KEY);
    lang = saved && DICT[saved] ? saved : /^vi\b/i.test(navigator.language || '') ? 'vi' : 'en';
  } catch (e) {
    lang = /^vi\b/i.test(navigator.language || '') ? 'vi' : 'en';
  }

  function t(key, params) {
    const v = (DICT[lang] && DICT[lang][key]) ?? DICT.vi[key];
    if (v === undefined) return key; // không phải khoá: coi là chuỗi thô (ví dụ thông báo lỗi của trình duyệt)
    if (typeof v === 'function') return v(params || {});
    return params ? v.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m)) : v;
  }

  const has = (key) => !!(DICT[lang] && DICT[lang][key] !== undefined) || DICT.vi[key] !== undefined;

  function apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      el.dataset.i18nAttr.split(';').forEach((pair) => {
        const [attr, key] = pair.split(':');
        if (attr && key) el.setAttribute(attr.trim(), t(key.trim()));
      });
    });
    document.documentElement.lang = lang;
  }

  const listeners = [];
  function setLang(code) {
    if (!DICT[code] || code === lang) return;
    lang = code;
    try { localStorage.setItem(KEY, code); } catch (e) { /* bỏ qua */ }
    apply();
    listeners.forEach((fn) => fn(lang));
  }

  window.I18N = {
    t,
    has,
    apply,
    setLang,
    LANGS,
    get lang() { return lang; },
    get locale() { return (LANGS.find((l) => l.code === lang) || LANGS[0]).locale; },
    onChange(fn) { listeners.push(fn); },
  };

  apply();
})();
