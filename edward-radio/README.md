# 📻 Edward ϟ Radio

Bot Discord đa năng kết hợp giữa **Phát sóng Radio trực tuyến 24/7** và **Hệ thống phát nhạc theo yêu cầu (YouTube, Hàng đợi, Playlist cá nhân)** với giao diện lệnh viết tắt nhanh chóng (`ed`) cùng Slash Commands (`/`).

---

## ✨ Tính năng chính

* **📻 24/7 Radio Streaming**: Phát các kênh Lofi, Chill, Jazz, Piano trực tuyến không giới hạn thời gian.
* **🎶 Phát nhạc theo yêu cầu (Jockie Music Style)**: Hỗ trợ tìm kiếm bài hát qua tên hoặc link YouTube, tự động xếp vào hàng đợi (`queue`) mà không làm gián đoạn bài hát đang phát.
* **📚 Quản lý Playlist cá nhân (Collections)**: Cho phép người dùng tự tạo, thêm bài hát và phát bộ sưu tập yêu thích riêng (`/playlist`).
* **⚡ Hệ thống lệnh viết tắt (Prefix Commands)**: Thao tác cực nhanh với tiền tố `ed` (ví dụ: `edp`, `eds`, `edq`, `edvol`, `ed247`, `ednp`, `edstop`).
* **♾️ Chế độ treo 24/7**: Tự động duy trì kết nối trong phòng thoại kể cả khi phòng trống.

---

## 🛠️ Công nghệ sử dụng

* **Node.js** (v18+)
* **Discord.js** (`v14`)
* **@discordjs/voice** & `@snazzah/davey` (Hỗ trợ giao thức thoại DAVE mới nhất của Discord)
* **ffmpeg-static** & **youtube-dl-exec** (Trích xuất và xử lý luồng âm thanh)

---

## 🚀 Hướng dẫn cài đặt & Chạy Local

1. **Clone dự án về máy:**
   ```bash
   git clone [https://github.com/Tên_Tài_Khoản/edward-radio.git](https://github.com/Tên_Tài_Khoản/edward-radio.git)
   cd edward-radio