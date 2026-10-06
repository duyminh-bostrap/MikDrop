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
└── public/
    ├── index.html     # Giao diện
    ├── style.css      # CSS (viết tay, không cần Internet/CDN)
    ├── app.js         # Logic client: radar, WebRTC, gửi/nhận, tiến trình
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
