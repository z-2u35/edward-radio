# Edward ϟ Radio

Discord Music Bot dùng **Discord.js v14 + Lavalink v4 + Shoukaku**. Lavalink đảm nhiệm toàn bộ kết nối stream, vì vậy tiến trình bot không chạy yt-dlp/FFmpeg và không phải tự tải audio từ YouTube trên Render.

## Tính năng

- Phát YouTube, SoundCloud, truy vấn tìm kiếm và link playlist.
- Spotify Web API Client Credentials cho track, album và playlist; tên nghệ sĩ, ảnh bìa và thời lượng lấy từ Spotify.
- Queue, shuffle, skip, tổng thời lượng, volume 1-100 và tự động chuyển bài.
- Radio Lofi, Chillsynth, Smooth Jazz, Peaceful Piano qua URL stream cấu hình trong `.env`.
- Chế độ treo phòng 24/7 và lưu trạng thái vào `state.json`.
- Slash commands và prefix aliases: `/join`, `/leave`, `edj`, `edl`, `edp`, `edsf`, `eds`, `edq`, `eddlall`, `eddl <n>`, `edt`, `edvol`, `ed247`, `edstop`.

## Cài đặt

1. Cài Node.js 20+ và chạy Lavalink v4 trên một máy chủ riêng (Render cần một service Lavalink riêng hoặc Lavalink host bên ngoài).
2. Sao chép `.env.example` thành `.env`, điền token Discord, Client ID, thông tin Lavalink và Spotify.
3. Cài dependencies và chạy:

```bash
npm install
npm start
```

`DISCORD_GUILD_ID` là tùy chọn. Nếu đặt, slash commands được đăng ký tức thời trong guild đó; nếu bỏ trống, commands đăng ký toàn cầu và có thể mất thời gian đồng bộ.

## Lavalink

Lavalink phải cho phép kết nối từ service bot và dùng cùng `LAVALINK_PASSWORD`.
Mẫu cấu hình chuẩn nằm tại [`lavalink/application.yml.example`](./lavalink/application.yml.example).
Lưu ý dependency YouTube phải nằm dưới `lavalink.plugins`; đặt ở cấp YAML root sẽ khiến Lavalink khởi động nhưng không nạp plugin.

Chạy Lavalink trên cùng VM với bot:

```bash
sudo mkdir -p /opt/lavalink
sudo cp lavalink/application.yml.example /opt/lavalink/application.yml
# Sửa password trong /opt/lavalink/application.yml
sudo docker run -d \
  --name lavalink \
  --restart unless-stopped \
  -p 127.0.0.1:2333:2333 \
  -v /opt/lavalink/application.yml:/opt/Lavalink/application.yml:ro \
  -e _JAVA_OPTIONS="-Xms128M -Xmx420M" \
  ghcr.io/lavalink-devs/lavalink:4
```

Nếu VM chưa có Docker, cài trước:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
newgrp docker
```

Sau khi khởi động, kiểm tra `docker logs lavalink` phải có `Lavalink is ready to accept connections`.
Mẫu config đã bật OAuth cho YouTube. Lần đầu chạy, xem:

```bash
docker logs -f lavalink
```

Mở URL và nhập code mà Lavalink in ra bằng một **tài khoản YouTube phụ**. Không dùng tài khoản Google/YouTube chính. Sau khi xác thực thành công, log sẽ in `refreshToken`; đặt token đó vào `plugins.youtube.oauth.refreshToken` trong `/opt/lavalink/application.yml`, rồi restart container:

```bash
docker restart lavalink
```

Không commit refresh token vào GitHub. Nếu đã đặt refresh token, có thể bỏ `oauth.enabled` hoặc giữ nguyên đều được.

Nếu log YouTube báo `This video requires login` hoặc `No supported audio streams available`,
hãy kiểm tra config OAuth trong container đang chạy thực sự, không chỉ file `.example`. Log
phải có client `TV` và OAuth đã hoàn tất. Không dùng OAuth với tài khoản chính; một số video
bị giới hạn bản quyền vẫn có thể không phát được.

Kiểm tra source YouTube trực tiếp trên VM:

```bash
curl -H "Authorization: MAT_KHAU_LAVALINK" \
  "http://127.0.0.1:2333/v4/loadtracks?identifier=ytsearch%3Atest"
```

Kết quả phải có `"loadType":"search"`. Nếu là `empty` hoặc `error`, sửa Lavalink trước khi kiểm tra bot Discord.

## Lệnh

| Lệnh | Tác dụng |
| --- | --- |
| `/join room:<room>` | Vào room chỉ định và tự phát Lofi; bỏ trống room để dùng voice hiện tại hoặc `DEFAULT_VOICE_CHANNEL_ID` |
| `/leave` | Rời room; chỉ người đã mời bot vào room mới dùng được |
| `/play query:<query>` | Thêm tên bài, URL YouTube hoặc Spotify vào queue; mode mặc định là queue |
| `/play mode:station station:<station>` | Phát `lofi`, `chillsynth`, `jazz` hoặc `piano` |
| `/shuffle`, `/skip`, `/queue`, `/total` | Quản lý hàng đợi |
| `/deleteall` | Xóa toàn bộ bài đang chờ, không dừng bài hiện tại |
| `/delete position:<n>` | Xóa bài ở vị trí `n` trong hàng đợi |
| `/volume <1-100>` | Chỉnh âm lượng |
| `/247` | Bật/tắt treo phòng |
| `/stop` | Dừng và rời phòng, cũng yêu cầu quyền của người mời |

Prefix tương ứng: `edj [#room]`, `edl`, `edp <query>`, `eddlall` xóa toàn bộ queue, `eddl <n>` xóa bài ở vị trí `n`.
Nếu gọi `edj` từ text channel khi không ở voice, điền `DEFAULT_VOICE_CHANNEL_ID` trong `.env` hoặc chỉ rõ `edj #voice-room`.

## Test trên Google Cloud

Trong Discord Developer Portal bật **Message Content Intent** và cấp quyền View Channel,
Send Messages, Embed Links, Read Message History, Connect, Speak, Use Voice Activity.

Trên VM:

```bash
cp .env.example .env
nano .env
npm install
npm start
```

Test lần lượt:

```text
/join room:<voice-room>
/play mode:station station:lofi
/play query:lofi hip hop radio
/play query:https://www.youtube.com/watch?v=...
/play query:https://open.spotify.com/track/...
edj #voice-room
edp tên bài hát
edl
```

Spotify dùng Web API để lấy metadata rồi tìm audio tương ứng qua Lavalink; Spotify không cung cấp audio stream trực tiếp cho bot.

Khi thêm playlist Spotify, bot lấy toàn bộ các trang track từ Spotify Web API, resolve từng bài qua Lavalink và báo rõ số bài đã thêm cùng các bài không resolve được.

## Deploy trên Railway

Railway cần hai service trong cùng một project:

1. **Lavalink**: tạo service từ image `ghcr.io/lavalink-devs/lavalink:4`, mount file `lavalink/application.yml` từ một volume/secret phù hợp, và đặt `server.password`.
2. **Edward Radio**: deploy repository này. Railway sẽ dùng `Dockerfile` và `railway.toml` có sẵn.

Trong service bot đặt các biến:

```env
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_ID=...
LAVALINK_HOST=<private-domain-cua-service-lavalink>
LAVALINK_PORT=2333
LAVALINK_PASSWORD=<cung-gia-tri-voi-lavalink>
LAVALINK_SECURE=false
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
```

Hai service phải dùng cùng một Railway project/private network. Không expose Lavalink public nếu bot dùng private domain. Trong Lavalink service, port nội bộ vẫn là `2333`; nếu dùng YouTube OAuth, lưu `refreshToken` trong config/secret của service Lavalink, không commit vào GitHub.

Railway Free chỉ bao gồm `$1/tháng` credit và tối đa `0.5 GB` cho mỗi service; không đủ tin cậy để chạy bot + Lavalink 24/7. Free Trial có `$5` dùng một lần trong 30 ngày. Chạy 24/7 thực tế cần Hobby `$5/tháng` hoặc dùng lại Google Cloud/Oracle Always Free.
