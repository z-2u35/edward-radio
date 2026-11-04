# Edward ϟ Radio

Discord Music Bot dùng **Discord.js v14 + Lavalink v4 + Shoukaku**. Lavalink đảm nhiệm toàn bộ kết nối stream, vì vậy tiến trình bot không chạy yt-dlp/FFmpeg và không phải tự tải audio từ YouTube trên Render.

## Tính năng

- Phát YouTube, SoundCloud, truy vấn tìm kiếm và link playlist.
- Spotify Web API Client Credentials cho track, album và playlist; tên nghệ sĩ, ảnh bìa và thời lượng lấy từ Spotify.
- Queue, shuffle, skip, tổng thời lượng, volume 1-100 và tự động chuyển bài.
- Radio Lofi, Chillsynth, Smooth Jazz, Peaceful Piano qua URL stream cấu hình trong `.env`.
- Chế độ treo phòng 24/7 và lưu trạng thái vào `state.json`.
- Slash commands và prefix aliases: `edp`, `edsf`, `eds`, `edq`, `edt`, `edvol`, `ed247`, `edstop`.

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

Sau khi khởi động, kiểm tra `docker logs lavalink` phải có `Lavalink is ready to accept connections`.
Bot không chứa cơ chế vượt chặn hoặc cookie YouTube; hãy dùng plugin YouTube được cập nhật theo tài liệu Lavalink.

Kiểm tra source YouTube trực tiếp trên VM:

```bash
curl -H "Authorization: MAT_KHAU_LAVALINK" \
  "http://127.0.0.1:2333/v4/loadtracks?identifier=ytsearch%3Atest"
```

Kết quả phải có `"loadType":"search"`. Nếu là `empty` hoặc `error`, sửa Lavalink trước khi kiểm tra bot Discord.

## Lệnh

| Lệnh | Tác dụng |
| --- | --- |
| `/play mode:queue query:<query>` | Thêm tên bài, URL YouTube hoặc Spotify vào queue |
| `/play mode:station station:<station>` | Phát `lofi`, `chillsynth`, `jazz` hoặc `piano` |
| `/shuffle`, `/skip`, `/queue`, `/total` | Quản lý hàng đợi |
| `/volume <1-100>` | Chỉnh âm lượng |
| `/247` | Bật/tắt treo phòng |
| `/stop` | Dừng và rời phòng |

Khi thêm playlist Spotify, bot lấy toàn bộ các trang track từ Spotify Web API, resolve từng bài qua Lavalink và báo rõ số bài đã thêm cùng các bài không resolve được.
