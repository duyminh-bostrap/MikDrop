# MikDrop

Chia sẻ ảnh và tệp ngang hàng (P2P) giữa iPhone, MacBook và Windows qua Wi-Fi cục bộ, chỉ cần trình duyệt, không cần cài app. Giao diện lấy cảm hứng từ AirDrop.

- **Tự động phát hiện thiết bị** cùng mạng (radar).
- **Truyền P2P bằng WebRTC DataChannel**: tệp đi thẳng giữa hai thiết bị, server không lưu tệp.
- **Chọn nhiều ảnh** từ Thư viện ảnh (iOS) hoặc **kéo thả** tệp (Windows/macOS).
- **Xác nhận trước khi nhận**: bên nhận thấy popup *"X muốn gửi 3 hình ảnh"* kèm ảnh xem trước, với nút [Chấp nhận] / [Từ chối].
- Có thanh tiến trình và tự lưu tệp về máy sau khi nhận.
- Có **chế độ dự phòng**: nếu mạng chặn P2P (AP isolation, mDNS lỗi), tệp được chuyển tiếp qua server trong RAM, không ghi đĩa.

## Cấu trúc thư mục

```
MikDrop/
├── package.json
├── server.js          # Signaling server: phục vụ web + discovery + chuyển tiếp offer/answer/ICE
├── render.yaml        # Cấu hình triển khai Render
├── scripts/
│   └── make-icons.js  # Tạo biểu tượng PNG cho PWA
└── public/
    ├── index.html     # Giao diện
    ├── style.css      # CSS (viết tay, không cần Internet/CDN)
    ├── app.js         # Logic client: radar, WebRTC, gửi/nhận, tiến trình, phòng
    ├── manifest.webmanifest, icon-*.png, apple-touch-icon.png   # PWA
    └── favicon.svg
```

## Chạy server

Yêu cầu: [Node.js](https://nodejs.org) phiên bản 18 trở lên.

```bash
npm install
npm start
```

Terminal sẽ in ra các địa chỉ, ví dụ:

```
  Trên máy này:      http://localhost:3000
  Thiết bị khác:     http://192.168.1.23:3000   (Wi-Fi)
  Tên miền dễ nhớ:   http://mikdrop.local:3000
```

Cùng lúc đó là mã QR để quét bằng iPhone.

### Dùng trên các thiết bị

1. Đảm bảo **tất cả thiết bị cùng một mạng Wi-Fi** (hoặc cùng router).
2. Trên mỗi thiết bị, mở địa chỉ `http://<IP-máy-chạy-server>:3000` (hoặc `http://mikdrop.local:3000`).
3. Các thiết bị sẽ hiện ra trên radar. Chạm vào thiết bị cần gửi, chọn ảnh hoặc tệp rồi bấm **Gửi**.
4. Bên nhận bấm **Chấp nhận**. Tệp được tải về và lưu tự động.

Mẹo: chạy trên cổng 80 để bỏ phần `:3000`, ví dụ `PORT=80 npm start` (macOS/Linux cần `sudo`), khi đó dùng được `http://mikdrop.local`.

### Windows: mở tường lửa

Lần đầu chạy, Windows hỏi quyền cho Node.js. Hãy tick **Mạng riêng tư (Private)**. Nếu lỡ bấm Hủy, chạy PowerShell **với quyền Administrator**:

```powershell
New-NetFirewallRule -DisplayName "MikDrop" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
```

Mạng Wi-Fi cũng phải được đặt là **Private** (Settings → Network & internet → Wi-Fi → thuộc tính mạng).

### iPhone: lưu thẳng vào Ảnh (HTTPS)

Safari chỉ cho phép bảng chia sẻ *"Lưu vào Ảnh"* trên HTTPS. Chạy:

```bash
npm run start:https
```

rồi mở `https://<IP>:3000` trên iPhone, chọn **Nâng cao → Tiếp tục truy cập** (chứng chỉ tự ký, lưu trong `.cert/`). Khi nhận tệp sẽ có nút **Lưu vào Ảnh / Tệp**. Nếu dùng HTTP thường, iPhone vẫn nhận được và lưu qua trình tải xuống của Safari (vào app Tệp).

## Chạy bằng MikDrop.exe (Windows, không cần cài Node.js)

Bản exe là một file duy nhất (khoảng 92 MB), chạy hoàn toàn offline, giao diện đã nhúng sẵn bên trong.

**Tạo file exe** (chỉ làm trên máy có Node.js 20 trở lên):

```bash
npm install
npm run build:exe
```

Kết quả nằm ở `dist/MikDrop.exe`. Copy file này sang bất kỳ máy Windows nào rồi dùng.

**Dùng:**
1. Bấm đúp `MikDrop.exe`. Trình duyệt tự mở `http://localhost:3000` và **hiện sẵn mã QR** để iPhone quét (mở lại bất cứ lúc nào bằng nút QR ở góc trên bên phải). Cửa sổ đen cũng in địa chỉ và mã QR.
2. Windows hỏi về tường lửa: tick **Mạng riêng tư (Private networks)** rồi bấm **Cho phép**, để các thiết bị khác truy cập được.
3. Trên iPhone/Mac, quét mã QR hoặc mở địa chỉ `http://<IP>:3000` được in trong cửa sổ.
4. Giữ cửa sổ mở trong lúc dùng. Đóng cửa sổ là tắt MikDrop.

**Tuỳ chọn** (chạy từ PowerShell hoặc tạo shortcut):

| Lệnh | Tác dụng |
|---|---|
| `MikDrop.exe --port 8080` | Chọn cổng. Mặc định là 3000, nếu bận sẽ tự thử 3001, 3002... |
| `MikDrop.exe --no-open` | Không tự mở trình duyệt |
| `MikDrop.exe --https` | HTTPS tự ký (để iPhone có nút "Lưu vào Ảnh"). Chứng chỉ lưu cạnh file exe, trong thư mục `.cert` |

Lưu ý: file exe chưa được ký số nên Windows SmartScreen có thể cảnh báo "Windows protected your PC". Bấm **More info → Run anyway**. Nếu muốn tránh hẳn, cần mua chứng chỉ ký mã (code signing).

## Khi không có Internet

- Bản chạy tại nhà (`npm start`) **không cần Internet**, chỉ cần các thiết bị cùng mạng cục bộ (router không nối Internet vẫn được). Giao diện không tải gì từ CDN.
- Không có router: bật **Mobile Hotspot** trên PC (Windows: Settings → Network & internet → Mobile hotspot) hoặc **Personal Hotspot** trên iPhone, cho các thiết bị kết nối vào, rồi mở địa chỉ IP của máy chạy server (thường `http://192.168.137.1:3000` với hotspot Windows).
- Bản trên Render **cần Internet** vì server nằm trên mạng ngoài.

## Triển khai lên Internet (không cần bật PC)

Server chỉ làm discovery và báo hiệu nên rất nhẹ, chạy tốt trên gói miễn phí. Khi đó bạn có một địa chỉ cố định (ví dụ `https://mikdrop.onrender.com`) và có HTTPS thật, nên iPhone có nút **Lưu vào Ảnh** mà không cần bỏ qua cảnh báo chứng chỉ.

**Cách nhóm thiết bị:** các thiết bị có **cùng địa chỉ IP công cộng** (cùng nhà/Wi-Fi) tự thấy nhau. Thiết bị ở mạng khác nhau thì bấm *"Cùng mạng Wi-Fi"* ở cuối trang, nhập chung một **mã phòng** (hoặc gửi liên kết mời `/?room=<mã>`).

### Render (khuyến nghị)

1. Đăng nhập [render.com](https://render.com) bằng GitHub.
2. **New → Blueprint** → chọn repo này. Render đọc `render.yaml` và tự cấu hình.
3. Chờ build xong, mở địa chỉ `https://<tên>.onrender.com` trên các thiết bị.
4. Trên iPhone: Safari → Chia sẻ → **Thêm vào Màn hình chính** để dùng như một app.

Fly.io, Railway... cũng chạy được: đặt biến môi trường `TRUST_PROXY=1`, lệnh khởi động `npm start`.

### Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `PORT` | Cổng lắng nghe (nền tảng thường tự đặt) |
| `TRUST_PROXY=1` | Bắt buộc khi đứng sau proxy: lấy IP thật từ `X-Forwarded-For` và tắt mDNS/QR |
| `TRUSTED_IP_HEADER` | Header do proxy đặt chứa IP thật của thiết bị, client không giả được (Render: `cf-connecting-ip`, tự nhận qua biến `RENDER`) |
| `PROXY_HOPS` | Khi không có header trên: lấy IP ở vị trí thứ N từ bên phải của `X-Forwarded-For` (mặc định 1) |
| `RELAY=0` | Tắt chế độ dự phòng qua server, tiết kiệm băng thông |
| `MAX_PEERS_PER_ROOM` | Số thiết bị tối đa mỗi phòng (mặc định 50) |
| `ICE_SERVERS` | JSON danh sách STUN/TURN, ví dụ `[{"urls":"stun:stun.l.google.com:19302"}]`. Thêm TURN nếu cần truyền qua mạng khó |

### Lưu ý khi chạy công khai

- Tệp vẫn đi P2P giữa hai thiết bị, nhưng ở **chế độ dự phòng** tệp đi qua server (chỉ trong RAM). Nếu không muốn tốn băng thông, đặt `RELAY=0`.
- Gói miễn phí có thể "ngủ" khi không dùng, nên lần mở đầu có thể chờ vài giây.
- Thiết bị dùng IPv4 và IPv6 khác nhau có thể không thấy nhau tự động. Khi đó hãy dùng mã phòng.
- Ai biết mã phòng đều vào được phòng đó, nên hãy chọn mã khó đoán cho phòng riêng tư. Mọi lần nhận tệp vẫn cần người nhận bấm **Chấp nhận**.

## Xử lý sự cố

| Triệu chứng | Cách xử lý |
|---|---|
| Thiết bị khác không mở được trang | Kiểm tra cùng Wi-Fi; mở tường lửa (xem trên); thử bằng IP thay vì `mikdrop.local` |
| Mở được trang nhưng không thấy nhau | Tắt VPN; router bật "AP/Client Isolation" hoặc đang dùng mạng khách (guest) |
| Hiện "chế độ dự phòng" | Không kết nối P2P được nên tệp đi qua server. Vẫn hoạt động nhưng chậm hơn. Thường do isolation hoặc chặn mDNS |
| `mikdrop.local` không phân giải | Dùng địa chỉ IP. Cổng 5353/UDP có thể bị chặn |
| Máy có nhiều card mạng | Chọn đúng IP của Wi-Fi/Ethernet (bỏ qua các card ảo VMware/WSL/Hyper-V) |

## Lưu ý kỹ thuật

- Tệp nhận được gom trong RAM trước khi lưu, nên tệp rất lớn (vài GB) có thể gặp giới hạn bộ nhớ, đặc biệt trên iPhone.
- iOS có thể tự chuyển HEIC thành JPEG khi chọn ảnh ở mục "Ảnh & video". Dùng mục **Tệp** để gửi bản gốc.
- Giữ trang MikDrop mở (không khóa màn hình) trong lúc truyền.
- Ứng dụng dành cho mạng nội bộ tin cậy. Đừng mở cổng ra Internet vì mọi thiết bị kết nối tới server đều thấy nhau.

## Luồng kỹ thuật

```
A --transfer-request--> server --> B      A xin gửi N tệp (kèm thumbnail)
B --transfer-accept---> server --> A      B bấm Chấp nhận
A <---- offer/answer/ICE (qua server) ----> B
A ============ WebRTC DataChannel ===========> B   (tệp đi thẳng, chia mảnh 64KB, có backpressure)
B --ack--> A
```
