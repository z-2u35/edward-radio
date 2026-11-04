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

Lavalink phải cho phép kết nối từ service bot và dùng cùng `LAVALINK_PASSWORD`. Với Lavalink v4, cài plugin source phù hợp cho YouTube theo tài liệu Lavalink hiện hành; bot không chứa cơ chế vượt chặn hoặc cookie YouTube.

## Lệnh

| Lệnh | Tác dụng |
| --- | --- |
| `/play <query>` | Phát tên, URL, Spotify hoặc `lofi`, `chillsynth`, `jazz`, `piano` |
| `/shuffle`, `/skip`, `/queue`, `/total` | Quản lý hàng đợi |
| `/volume <1-100>` | Chỉnh âm lượng |
| `/247` | Bật/tắt treo phòng |
| `/stop` | Dừng và rời phòng |
