# ⚡ Edward ϟ Radio (Discord 24/7 Lofi Bot)

Bot Discord phát nhạc Lofi, Chill, Jazz và Piano trực tuyến hoạt động 24/7 tương tự **Lofi Radio**.

## ✨ Tính năng chính
- **`/play [station/query]`**: Gọi bot vào phòng thoại và phát radio hoặc nguồn nhạc.
- **`/join [room]`**, **`edj [#room]`**: Đưa bot vào phòng thoại; có thể chỉ định room khi người gọi không ở voice.
- **`/leave`**, **`edl`**: Đưa bot rời phòng. Chỉ người đã gọi `/join`, `/play` hoặc `edj` để mời bot vào room hiện tại mới dùng được.
- **`/play [query]`**, **`edp [query]`**: Phát tên bài hát, link YouTube hoặc link Spotify. Link Spotify được dùng để lấy metadata rồi tìm bản tương ứng trên YouTube.
- **`/247`**: Bật/Tắt chế độ treo 24/7 (tự nhớ phòng trong `state.json` ngay cả khi khởi động lại máy chủ).
- **`/station`**: Xem danh sách các đài Radio hiện có.
- **`/volume [1-100]`**: Điều chỉnh âm lượng trực tiếp.
- **`/nowplaying`**: Hiển thị bảng điều khiển kèm nút bấm nhanh (Tạm dừng, Đổi đài ngẫu nhiên, Bật/Tắt 24/7).
- **`/stop`**: Dừng phát nhạc và cho bot rời phòng thoại.

Bot dùng `ffmpeg-static` để chuyển các URL radio trực tuyến thành audio Discord,
nên không cần chạy Lavalink cho các đài radio này.

## 🚀 Hướng dẫn cài đặt & chạy Bot

1. **Cài đặt thư viện:**
   ```bash
   npm install
   ```

2. **Cấu hình biến môi trường:**
   - Đổi tên file `.env.example` thành `.env`.
   - Điền `TOKEN` và `CLIENT_ID` của bot vào file `.env`.
   - Có thể điền `GUILD_ID` để cập nhật Slash Command gần như ngay lập tức trong một server.

3. **Khởi chạy Bot:**
   ```bash
   npm start
   ```

## Cấu hình Discord bắt buộc

Trong Discord Developer Portal:

1. Bot > **Privileged Gateway Intents**: bật **Message Content Intent** để `edj`, `edl`, `edp` hoạt động.
2. OAuth2 > URL Generator: chọn `bot` và `applications.commands`.
3. Cấp quyền tối thiểu: View Channel, Send Messages, Connect, Speak, Use Voice Activity.

## Test chức năng

Sau khi bot online, test theo thứ tự:

```text
/join room:<voice-room>
/play station:lofi
/play query:lofi hip hop radio
/play query:https://www.youtube.com/watch?v=...
/play query:https://open.spotify.com/track/...
edj
edp tên bài hát
edl
```

Spotify không được phát trực tiếp từ Spotify. Bot lấy tên nghệ sĩ/bài hát từ link Spotify rồi tìm audio tương ứng trên YouTube; kết quả có thể khác bản gốc.

## Chạy trên Google Cloud trước

Trên Compute Engine, nên dùng Debian 12 hoặc Ubuntu LTS. VM chỉ cần kết nối outbound, không cần mở port HTTP cho bot:

```bash
sudo apt update
sudo apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
git clone <URL_REPOSITORY> edward-radio
cd edward-radio
npm install
cp .env.example .env
nano .env
npm start
```

Khi test xong, chạy nền tự khởi động lại bằng PM2:

```bash
sudo npm install -g pm2
pm2 start index.js --name edward-radio
pm2 save
pm2 startup
```

Chạy lệnh `pm2 startup` rồi thực hiện đúng lệnh mà terminal in ra. Giữ file `state.json` trên VM để bot nhớ room và người có quyền `/leave` sau khi restart.

## Chạy 24/7

- Google Cloud Compute Engine `e2-micro` có thể thuộc Free Tier nếu tài khoản, khu vực và quota đủ điều kiện; hãy kiểm tra bảng giá trong Billing trước khi tạo máy. Không nên coi VM này là miễn phí tuyệt đối nếu tài khoản đã hết trial hoặc dùng tài nguyên ngoài hạn mức.
- Lựa chọn miễn phí lâu dài thường dùng là Oracle Cloud Always Free (VM Ampere A1), nhưng phụ thuộc khu vực còn quota và vẫn yêu cầu phương thức thanh toán để xác minh.
- Trên Debian/Ubuntu, cài Node.js rồi chạy bot bằng `systemd` hoặc PM2 để tự khởi động lại. Không cần cài Lavalink với kiến trúc hiện tại.
