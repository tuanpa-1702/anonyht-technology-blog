# TuanPA Blog

Web blog full-stack, dựng lại từ 4 màn hình thiết kế Google Stitch (`admin.html`,
`dashboard.html`, `letter.html`, `user.html`) thành một ứng dụng thật, chạy được
trên Ubuntu.

- **Backend:** Node.js + Express + SQLite (`better-sqlite3`)
- **Xác thực:** email/mật khẩu **và** đăng nhập Google (OAuth 2.0, không dùng session — phát hành JWT ngay sau khi Google xác thực xong)
- **Phân quyền:** 3 vai trò — `admin` (toàn quyền), `editor` (viết/sửa/xoá bài viết), `readonly` (chỉ đọc + bình luận, **mặc định** cho mọi tài khoản tự đăng ký bằng email hoặc Google — admin có thể nâng quyền trong Bảng quản trị)
- **Chức năng:** đăng ký/đăng nhập, CRUD bài viết (kèm bản nháp), bình luận,
  like/dislike bài viết và bình luận,
  trang cá nhân (đổi avatar bằng upload ảnh thật), trang quản trị (thống kê,
  quản lý bài viết, quản lý & tạo người dùng theo vai trò, danh sách
  subscriber bản tin, chỉnh sửa nội dung trang chủ, cấu hình email gửi đi)
- **Email:** thông báo bài viết mới + OTP quên mật khẩu, cấu hình ngay trong
  bảng quản trị (Gmail / Office 365 / SMTP tuỳ chỉnh)

## Vai trò người dùng

| Vai trò | Quyền |
|---|---|
| `admin` | Toàn quyền: quản lý bài viết của mọi người, quản lý người dùng (tạo mới, đổi vai trò, vô hiệu hoá/bật lại, đặt lại mật khẩu, xoá), chỉnh sửa cài đặt trang chủ, cấu hình email gửi đi |
| `editor` | Viết bài mới, sửa/xoá bài viết của chính mình |
| `readonly` | Chỉ đọc bài viết và bình luận — **đây là vai trò mặc định** khi ai đó tự đăng ký bằng email hoặc đăng nhập lần đầu bằng Google |

Admin nâng quyền cho người dùng tại **Bảng quản trị → Người dùng** (đổi dropdown vai trò), hoặc tạo thẳng tài khoản mới với vai trò chọn sẵn qua nút **"+ Thêm người dùng"**.

Mỗi tài khoản hiển thị thành một thẻ riêng, kèm ô tìm kiếm và các chip lọc theo
vai trò / trạng thái. Mỗi thẻ có 3 hành động:

| Hành động | Kết quả |
|---|---|
| **Vô hiệu hoá** / **Bật lại** | Đặt cột `users.is_active`. Tài khoản bị vô hiệu sẽ **bị đăng xuất ngay** (mọi request kèm JWT cũ trả về 401) và không đăng nhập lại được — kể cả qua Google — cho tới khi được bật lại. Bài viết và bình luận của họ vẫn hiển thị công khai. Đây là cách chặn truy cập mà vẫn giữ lại dữ liệu, khác với **Xoá**. |
| **Đặt lại MK** | Admin đặt trực tiếp mật khẩu mới (không cần OTP, không cần mật khẩu cũ), có nút tạo mật khẩu ngẫu nhiên. Mật khẩu chỉ hiển thị một lần, không bao giờ được lưu hay trả về dạng rõ — hãy tự gửi cho người dùng qua kênh an toàn. Mọi OTP quên-mật-khẩu đang chờ của email đó bị vô hiệu. Không áp dụng cho tài khoản Google (nút bị khoá). |
| **Xoá** | Đưa **tài khoản** vào Thùng rác: bị đăng xuất ngay và không đăng nhập lại được cho tới khi khôi phục. Bài viết và bình luận của họ **vẫn ở lại trên trang** — xoá tài khoản không còn kéo theo nội dung. Xoá vĩnh viễn từ Thùng rác mới là thao tác xoá hẳn tài khoản cùng toàn bộ bài viết và bình luận (`ON DELETE CASCADE`). |

Admin không thể tự vô hiệu hoá, tự xoá hay tự đổi vai trò của chính mình, và
không thể hạ quyền người `admin` đang hoạt động cuối cùng — nếu không sẽ không
còn ai vào được bảng quản trị.

## Đăng nhập bằng Google

1. Vào [Google Cloud Console](https://console.cloud.google.com/apis/credentials), tạo **OAuth 2.0 Client ID** loại "Web application".
2. Thêm **Authorized redirect URI** đúng bằng domain thật của bạn, dạng:
   `https://your-domain.com/api/auth/google/callback`
3. Copy Client ID / Client Secret vào `.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_CALLBACK_URL=https://your-domain.com/api/auth/google/callback
   ```
4. Khởi động lại server. Nút "Đăng nhập với Google" sẽ xuất hiện trong modal đăng nhập ở mọi trang.

Nếu để trống `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, tính năng Google login tự tắt (route trả lỗi 503 rõ ràng thay vì lỗi khó hiểu).

## Like / dislike và kiểm duyệt bình luận

Trang **Chi tiết bài viết** có hai cặp nút 👍 / 👎: một cặp cho cả bài viết (nằm
cạnh khu vực "Share"), và một cặp trên **mỗi** bình luận cũng như mỗi trả lời.

- **Cần đăng nhập để bình chọn.** Khách vẫn thấy đúng số phiếu; bấm vào nút sẽ
  mở hộp đăng nhập chứ không báo lỗi.
- **Một người một phiếu cho mỗi mục.** Bấm lại chính nút đang sáng thì bỏ phiếu;
  bấm nút bên kia thì phiếu được chuyển, không bao giờ tính hai lần. Đây là
  ràng buộc ở tầng dữ liệu (khoá chính `(mục, người dùng)` trong hai bảng
  `post_reactions` / `comment_reactions`), không chỉ ở giao diện.
- **Chỉ `admin` được xoá bình luận.** Nút "Xoá" chỉ hiện với admin và route cũng
  yêu cầu `requireAdmin` — người viết bình luận cũng không tự xoá được (nhận 403).
  Xoá một bình luận đưa cả nó và mọi trả lời bên dưới vào **Thùng rác** (chung một
  mốc `deleted_at`, nên khôi phục là khôi phục cả cây); hộp xác nhận nói rõ điều đó.
  Bản xoá hẳn chỉ có ở nút "Xoá vĩnh viễn" trong Thùng rác.

Số phiếu được **tính khi đọc** thay vì lưu sẵn trên `posts`/`comments`: cả hai
bảng phiếu đều cascade theo bài viết, bình luận và người dùng, nên xoá bất cứ thứ
gì cũng không để lại số đếm sai.

Bảng mới được tạo tự động khi khởi động (`CREATE TABLE IF NOT EXISTS` trong
`server/db.js`) — database đang có sẵn chỉ cần khởi động lại server, không cần
migration thủ công.

## Thư viện ảnh (Media Library)

**Bảng quản trị → Thư viện ảnh** là nơi quản lý toàn bộ ảnh dùng cho bài viết:
lưới thumbnail, tìm theo tên file, xem chi tiết (dung lượng, kích thước pixel,
người tải lên), copy đường dẫn, và xoá.

Trong **Viết bài**, nút **"Thư viện"** trên mỗi khối ảnh và **"Chọn từ thư viện"**
dưới ô ảnh bìa mở đúng lưới đó dưới dạng modal — cùng một `public/js/media.js`,
nên duyệt thư viện và chọn ảnh từ thư viện là cùng một giao diện. Ảnh đã upload
một lần dùng lại được cho bài khác mà không phải tải lên lần nữa.

### Giới hạn theo vai trò

| | `admin` | `editor` | `readonly` |
|---|---|---|---|
| Xem thư viện | ✅ | ✅ | ❌ |
| Upload vào thư viện | ✅ **không giới hạn dung lượng mỗi ảnh** | 8 MB/ảnh, 40 ảnh/giờ | ❌ |
| Xoá ảnh | mọi ảnh | chỉ ảnh do mình tải lên | ❌ |
| Upload avatar (`/api/upload`) | 8 MB | 8 MB | 8 MB |

Giới hạn duy nhất còn áp dụng cho admin là **dung lượng đĩa: phải còn trên 1 GB
trống**. Đây không phải sự thận trọng suông — SQLite ghi WAL vào cùng filesystem,
nên đĩa đầy không chỉ làm hỏng upload mà làm site **không ghi được bài viết, bình
luận hay cả lần đăng nhập nào nữa**. Từ chối một lần upload thì khôi phục được;
một database bị kẹt thì không.

Nếu đặt sau nginx thì `client_max_body_size` phải nâng tương ứng, và Cloudflare
Free chặn request lớn hơn **100 MB** ở tầng edge trước khi tới app.

### Xoá ảnh đang được dùng

Trước khi xoá, server đếm số bài viết đang tham chiếu ảnh đó (cả `cover_image` lẫn
ảnh trong nội dung) và giao diện hiện rõ *"Ảnh này đang được dùng trong N bài
viết"* kèm tên bài. Chỉ khi bấm **"Xác nhận xoá"** lần thứ hai thì ảnh mới bị xoá —
và "xoá" ở đây nghĩa là **vào Thùng rác**: file được dời khỏi `public/uploads/`
vào `data/media-trash/` nên mọi `<img>` trỏ vào nó 404 ngay, nhưng admin khôi phục
được từ tab Thùng rác. Cảnh báo chứ không chặn hẳn: một ảnh có thể được tham chiếu
từ nơi truy vấn này không thấy, nên chặn tuyệt đối sẽ làm một số file không bao giờ
xoá được.

#### Thùng rác phải **ghi được**, không chỉ "tồn tại"

Đây là lỗi thật đã gặp: `sudo bash scripts/security-deploy.sh` require
`server/media-store.js` bằng **root**, module tự tạo `data/media-trash/` nếu thiếu —
nên thư mục đó thuộc về root, quyền `0755`. pm2 chạy bằng user thường (đúng như
script vẫn cảnh báo), thấy thư mục đã có nên không hỏi lại, và từ đó **mọi lần xoá
ảnh đều trượt `EACCES`** ngay ở file đầu tiên. Phần còn lại của site vẫn bình
thường — upload chạy, bài vẫn lưu, database vẫn ghi — nên triệu chứng duy nhất là
một câu "Không dời được ảnh vào thùng rác" trong trang quản trị, không kèm lý do.

Ba lớp phòng vệ, theo thứ tự:

1. **Tự sửa.** `ensureTrashDir()` (chạy lúc khởi động và sau mỗi lần bị từ chối)
   ghi thử một file thăm dò vào thùng rác. Nếu bị từ chối vì quyền **và thùng rác
   rỗng**, nó dời thư mục cũ sang `data/media-trash.unwritable-<timestamp>` rồi tạo
   thư mục mới thuộc về user đang chạy. Làm được là vì *thay một thư mục chỉ cần
   quyền ghi trên thư mục CHA* — `data/`, nơi SQLite đang ghi WAL — chứ không cần
   quyền gì trên chính thư mục đó. Thùng rác **không rỗng** thì tuyệt đối không
   đụng vào: nó có thể đang giữ ảnh mà admin định khôi phục.
2. **Nói rõ lý do.** Thông báo trả về cho admin giờ kèm errno và đúng lệnh cần
   chạy (`sudo chown -R <user> data/media-trash`); errno và đường dẫn tuyệt đối
   luôn nằm trong `pm2 logs tuanpa-blog`.
3. **Không tái diễn.** `security-deploy.sh` tự tạo `data/media-trash/` TRƯỚC khi
   require module, và khi phát hiện đang chạy bằng `sudo` thì `chown` cả
   `data/tmp-uploads/` lẫn `data/media-trash/` về `$SUDO_USER`.

Không cần khởi động lại để kiểm tra hay để sửa: `GET /api/media` (admin) trả kèm
`trashDir: { writable, code }` từ lần kiểm tra gần nhất, còn `POST /api/media/sync`
(nút **Đồng bộ** trong Thư viện) kiểm tra lại ngay lúc đó — nghĩa là vừa báo thùng
rác có hỏng không, vừa tự dựng lại được nếu hỏng kiểu dựng lại được. Admin vừa
chạy `chown` xong thì lần xoá ảnh kế tiếp tự nhận ra, không cần restart.

### An toàn khi upload

- File được ghi vào `data/tmp-uploads/` — **ngoài `public/`** — và chỉ được chuyển
  vào `public/uploads/` sau khi kiểm **magic bytes**. File không phải ảnh vì thế
  **không bao giờ** truy cập được qua HTTP, kể cả trong khoảnh khắc trước khi bị xoá.
- Phần mở rộng lưu xuống đĩa lấy từ **nội dung file**, không lấy từ tên client gửi:
  một `.gif` chứa HTML bị chặn, một PNG đặt tên `.gif` được lưu thành `.png`.
- Tên file lưu trữ do server sinh (timestamp + 8 byte ngẫu nhiên), không bao giờ
  lấy từ tên client — nên không có path traversal và không ghi đè file cũ. Tên gốc
  chỉ được lưu trong database để hiển thị.

### Thư mục (lồng nhiều cấp)

Sidebar bên trái tab Thư viện là cây thư mục. Hai dòng đầu — **Tất cả ảnh** và
**Chưa phân loại** — không phải thư mục mà là *cách xem*; bên dưới là cây thật.

| Hành động | `admin` | `editor` |
|---|---|---|
| Tạo thư mục / thư mục con | ✅ | ✅ |
| Đổi tên, di chuyển | ✅ | ✅ |
| Xoá thư mục | ✅ | ❌ |

**Xoá thư mục KHÔNG xoá ảnh.** Thư mục con bên trong cũng bị xoá theo, nhưng ảnh
chuyển sang "Chưa phân loại" — file vẫn trên đĩa, vẫn trong thư viện. Hộp xác nhận
nói rõ cả hai điều đó, vì "xoá thư mục" rất dễ đọc thành "xoá ảnh trong thư mục".

Không thể chuyển một thư mục vào **chính nó hoặc vào thư mục con của nó** — làm vậy
sẽ tách cả nhánh đó khỏi gốc và không còn cách nào truy cập lại từ giao diện.

Ảnh upload khi đang mở một thư mục sẽ **vào thẳng thư mục đó**, không phải upload rồi
chuyển. Trong modal chọn ảnh ở trang viết bài, thư mục hiện dưới dạng chip đi từng
cấp — modal không có chỗ cho một cột cây, và ở đó việc cần làm là *chọn* ảnh chứ
không phải sắp xếp.

### Đồng bộ với đĩa

Bảng `media` là metadata; **file trên đĩa mới là nguồn sự thật**. Mỗi lần khởi động
(và khi bấm nút **Đồng bộ**), server nhận thêm file có trong `public/uploads/` mà
chưa có bản ghi — kể cả file copy vào bằng `scp` hay có từ trước khi có thư viện —
và xoá bản ghi mà file đã biến mất. Nhờ vậy thư viện không bao giờ hiện ảnh không
tải được, cũng không bỏ sót file thật đang nằm trên đĩa.

### Thumbnail (tối ưu cuộn thư viện)

Lưới ảnh hiển thị **thumbnail 480px** (`/uploads/thumb/<file>`) thay vì ảnh gốc —
ảnh gốc (8–14 MB mỗi tấm với ảnh chụp điện thoại) vẫn nằm nguyên tại
`/uploads/<file>` cho bài viết, panel chi tiết và việc copy đường dẫn. Thumbnail do
**ImageMagick** sinh ra; ảnh upload mới được tạo thumbnail chạy nền ngay khi upload,
ảnh có sẵn được tạo dần khi mở thư viện hoặc tạo hàng loạt bằng:

```bash
node scripts/backfill-thumbs.js
```

Nếu server **không cài ImageMagick**, mọi thứ tự thoái lùi về hành vi cũ (lưới dùng
ảnh gốc) chứ không hỏng — cài bằng `sudo apt install -y imagemagick` rồi chạy lệnh
trên để đạt tốc độ cuộn tốt nhất. Chi tiết ở `server/thumbs.js`.

## Thùng rác (Recycle Bin)

**Bảng quản trị → Thùng rác** là nơi mọi thao tác xoá trên site đi tới thay vì biến
mất: xoá bài viết, xoá bình luận, xoá người dùng và xoá ảnh đều chỉ **đánh dấu**
hàng bằng cột `deleted_at` (soft delete), không xoá hàng. Tab chia làm bốn thư mục
— **Bài viết / Bình luận / Người dùng / Media** — mỗi thư mục có số lượng trên chip
và trên badge của nút trong rail; mỗi hàng có đúng hai hành động: **Khôi phục** và
**Xoá vĩnh viễn**.

- **Bài viết đi kèm bình luận của nó.** Xoá một bài đưa cả những bình luận còn sống
  của bài vào thùng rác, chung một mốc `deleted_at`; hàng của bài ghi "+N bình luận".
  Khôi phục bài là khôi phục cả nhóm đó. Một bình luận bị xoá *riêng* từ trước giữ
  mốc của riêng nó, nên khôi phục bài không hồi sinh oan bình luận ấy — và thư mục
  Bình luận chỉ liệt kê những bình luận bị xoá riêng (mỗi cây trả lời là một hàng,
  ở gốc cây).
- **Xoá người dùng chỉ đưa tài khoản vào thùng rác.** Bài viết và bình luận của họ
  vẫn hiển thị công khai dưới tên họ; hàng trong thùng rác ghi rõ còn bao nhiêu bài
  / bình luận đang sống. Phiên đăng nhập của tài khoản chết ngay như khi bị vô hiệu
  hoá, và mọi đường đăng nhập (mật khẩu, OTP, quên mật khẩu, Google) đều từ chối.
- **Media dời file ra khỏi thư mục được phục vụ.** Ảnh đã xoá nằm ở
  `data/media-trash/` (giữ nguyên cấu trúc `thumbs/`, `w1280/`) nên không tải công
  khai được nữa; khôi phục thì dời ngược về. Nhờ vậy bước đồng bộ
  `pruneMissingFiles()` không quét sạch thùng rác vì "thiếu file".
- **Không tự dọn.** Không có cron, không có hạn giữ: mục đã xoá nằm trong thùng rác
  tới khi admin bấm **Xoá vĩnh viễn**.
- **Xoá vĩnh viễn** mới là hard delete ngày trước, kèm đúng các logger cũ: xoá hẳn
  bài kéo theo bình luận (`ON DELETE CASCADE`) và ghi vào `activity_log`; xoá hẳn
  tài khoản kéo theo toàn bộ bài viết và bình luận của họ, mỗi bài một dòng log;
  xoá hẳn ảnh unlink mọi bản sao trên đĩa. Feed **Tổng quan** vì thế chỉ ghi những
  thứ thật sự không còn.
- **Slug và email vẫn bị giữ chỗ** suốt lúc nằm trong thùng rác, để khôi phục không
  bao giờ xung đột với một bài / tài khoản mới tạo sau đó; xoá vĩnh viễn mới giải
  phóng chúng.

Chi tiết kỹ thuật: `server/trash-store.js` (trash / restore / purge / counts / list),
`server/routes/trash.js` (bốn endpoint, admin-only).

## Nhúng video / bản đồ trong bài viết

Trong **Viết bài**, nút **"+ NHÚNG"** thêm một khối nhúng: dán link, bấm "Nhúng", và
khung xem trước hiện ngay trong trình soạn thảo — tác giả thấy đúng thứ người đọc sẽ
thấy. Hỗ trợ:

| Nền tảng | Dạng link nhận được |
|---|---|
| YouTube | `watch?v=`, `youtu.be/`, `/embed/`, `/shorts/`, `/live/` (giữ mốc thời gian `?t=`) |
| Vimeo | `vimeo.com/<id>`, `player.vimeo.com/video/<id>` |
| TikTok | `/@user/video/<id>` (link `vm.tiktok.com` phải mở ra lấy link đầy đủ) |
| Spotify | track / album / playlist / episode / show / artist |
| Facebook | video và bài viết |
| Google Drive | `/file/d/<id>/view` |
| Google Maps | **chỉ** link từ "Chia sẻ → Nhúng bản đồ" |

### Vì sao phải giải link ở server

`server/embeds.js` **không lọc** URL — nó **phân tích** URL rồi **tự dựng** một `src`
mới từ id đã kiểm và một khuôn cố định trong code. Hệ quả là *tập hợp URL mà nó có thể
sinh ra được quyết định bởi code, không phải bởi input*. Điều này quan trọng vì
`<iframe src>` là một trang được tải **vào trong trang của mình**: `javascript:` chạy
trong origin của mình, `data:text/html` cũng vậy, còn một trang https tuỳ ý thì có
được một frame để clickjack hoặc dựng form đăng nhập giả.

Có hai lớp, cả hai đều cần:

1. `src` được **kiểm lại mỗi lần lưu bài** (`routes/posts.js`) — không tin giá trị
   client gửi lên, kể cả khi nó vừa được resolve xong.
2. **CSP `frame-src`** chỉ liệt kê đúng 7 origin đó, và danh sách này lấy trực tiếp từ
   `server/embeds.js` nên CSP với sanitizer không thể lệch nhau. Nếu có gì lọt qua lớp
   1, trình duyệt vẫn từ chối tải frame.

YouTube dùng `youtube-nocookie.com` — cùng player, không đặt cookie cho tới khi người
đọc thực sự bấm play.

**Không follow redirect** để giải link ngắn: làm vậy nghĩa là server tự đi fetch một
URL tuỳ ý thay cho người gửi, tức là một nguyên thuỷ SSRF. Giá phải trả là tác giả
dán link đầy đủ thay vì link `vm.tiktok.com`.

## Upload ảnh (avatar)

Trang **Trang cá nhân** có nút "Tải ảnh lên" để đổi avatar — mọi vai trò dùng
được, tối đa 8 MB, định dạng JPG/PNG/WEBP/GIF. Đây là route riêng
(`/api/upload`) chứ không phải thư viện: tài khoản `readonly` ai cũng tự đăng ký
được, nên đường này luôn có giới hạn, kể cả với admin. Vẫn có thể dán URL ảnh
ngoài thay vì upload.

## Chế độ sáng / tối

Nút chuyển nằm ở **menu tài khoản**: bấm vào avatar ở góc phải thanh điều hướng,
hàng đầu tiên là **"Chế độ tối"** — ngay trên hàng "Trang cá nhân". Menu này có
cả khi chưa đăng nhập, vì lựa chọn sáng/tối là thuộc tính của **màn hình đang
đọc**, không phải của tài khoản: nó được lưu trong `localStorage` (khoá
`tuanpa_theme`) chứ không lưu lên server, nên không theo người dùng sang máy khác
và vẫn hoạt động trước khi đăng nhập.

Trang **Trang cá nhân** có thêm một hàng y hệt ở thanh bên trái (cùng vị trí:
ngay trên "Trang cá nhân"), vì ở trang đó avatar không mở menu khi đã đăng nhập —
thanh bên đã chứa sẵn mọi hàng menu sẽ đưa ra.

Ba trạng thái, không phải hai:

| Giá trị `tuanpa_theme` | Hiển thị |
| --- | --- |
| `dark` | luôn tối |
| `light` | luôn sáng |
| *(chưa đặt)* | theo hệ điều hành (`prefers-color-scheme`), và **tiếp tục** theo nó |

Khách mới vào lần đầu nhận theo cài đặt hệ điều hành; chỉ khi bấm nút thì khoá
mới được ghi và từ đó lựa chọn của người dùng thắng. Đổi ở một tab thì các tab
khác cùng origin tự đổi theo (sự kiện `storage`).

Về mặt kỹ thuật, toàn bộ màu của trang đi qua **CSS custom property** khai báo ở
đầu `public/css/common.css`: `:root` là bảng màu sáng, `.dark` trỏ lại đúng những
biến đó cho bảng tối. Vì vậy đổi theme chỉ là thêm/bỏ một class trên `<html>` —
**không có một class `dark:` nào trong markup**. Hệ quả cần nhớ khi sửa code:

- **Đừng viết màu literal** (`#4f46e5`, `rgba(255,255,255,.5)`, `text-white`,
  `bg-black/5`) — nó sẽ không đổi theo theme. Dùng token: `text-on-primary`,
  `bg-surface-container-low`, `border-outline-variant`, `var(--c-field)`,
  `var(--glass-wash-2)`, `var(--shadow-ambient)`...
- Nền tô đậm màu nhấn phải đi kèm `text-on-primary`, **không phải** `text-white`:
  ở theme tối `electric-indigo` chuyển sang đầu nhạt của dải màu, nên chữ trắng
  sẽ nằm trên nền gần trắng.
- `js/theme.js` được nạp **blocking, trong `<head>`, trước các stylesheet** ở cả
  6 trang. Đừng `defer` hay gộp nó vào `api.js` (nạp ở cuối `<body>`) — class
  `.dark` phải có mặt trước lần vẽ đầu tiên, nếu không mỗi lần chuyển trang sẽ
  loé trắng một khung hình.
- API cho code khác: `Theme.current()`, `Theme.stored()`, `Theme.isDark()`,
  `Theme.set('dark'|'light'|null)`, `Theme.toggle()`, `Theme.onChange(fn)`
  (gọi ngay một lần, trả về hàm huỷ đăng ký).

## Cài đặt nội dung trang chủ

Bảng quản trị → tab **Quản lí trang chủ** cho phép chỉnh sửa trực tiếp: tiêu đề
tab trình duyệt (`site_title`), tên thương hiệu ở logo (`brand_name`), nhãn nhỏ
+ tiêu đề + mô tả lớn trên trang chủ, ảnh minh hoạ, và chữ ở chân trang — không
cần sửa code.

Tên thương hiệu và tiêu đề tab áp dụng cho **mọi trang** (trang chủ, bài viết,
trang cá nhân, viết bài, bảng quản trị) và cả tên người gửi trong email OTP /
thông báo bài mới. Để trống ô nào thì ô đó quay về mặc định: tiêu đề tab theo
tên thương hiệu, tên thương hiệu theo `DEFAULT_SITE_NAME` trong
`server/site.js`.


## Cài đặt email (thông báo bài mới + OTP quên mật khẩu)

Bảng quản trị → tab **Cài đặt email** cấu hình hộp thư dùng để gửi email, không
cần sửa file `.env` hay khởi động lại server:

- **Nhà cung cấp:** `Gmail / Google Workspace` (smtp.gmail.com:465, SSL/TLS),
  `Office 365 / Outlook` (smtp.office365.com:587, STARTTLS), hoặc **SMTP tuỳ
  chỉnh** (tự nhập host / cổng / chế độ bảo mật).
- **Tài khoản + mật khẩu ứng dụng:** với cả Gmail và Office 365 phải dùng *App
  Password*, không dùng mật khẩu đăng nhập thường:
  - Gmail: bật Xác minh 2 bước → tạo tại <https://myaccount.google.com/apppasswords>
  - Office 365: bật MFA → tạo tại <https://mysignins.microsoft.com/security-info>,
    và hộp thư phải được bật **Authenticated SMTP** trong Exchange admin center
- **Tên / email người gửi:** để trống thì lấy theo tên thương hiệu và tài khoản
  SMTP ở trên.
- **Địa chỉ trang:** domain công khai dùng để tạo link trong email thông báo.
  Thiếu giá trị này thì link "Đọc bài viết" sẽ bị hỏng.
- **Hai công tắc riêng biệt:** *thông báo bài viết mới* và *mã OTP quên mật
  khẩu* — tắt/bật độc lập nhau.
- **Nút "Kiểm tra":** thử đăng nhập SMTP thật (và gửi một email thử nếu nhập địa
  chỉ nhận), rồi hiện thẳng lỗi từ máy chủ mail — sai mật khẩu, chặn cổng hay
  chưa bật SMTP AUTH đều nhìn ra ngay tại đây.

Mật khẩu được lưu trong bảng `email_settings` của SQLite và **không bao giờ**
được trả về trình duyệt: API `GET /api/admin/email-settings` chỉ cho biết đã có
mật khẩu hay chưa. Bảng này tách riêng khỏi bảng `settings` vì `settings` được
phục vụ qua `GET /api/settings` công khai.

Ba biến `SMTP_USER`, `SMTP_APP_PASSWORD`, `SITE_URL` trong `.env` vẫn hoạt động
như **giá trị dự phòng**, chỉ được dùng khi ô tương ứng trong bảng quản trị đang
để trống. Cấu hình cũ chạy bằng `.env` nên không cần thay đổi gì.

Khi chưa cấu hình đủ (thiếu host/tài khoản/mật khẩu): thông báo bài viết mới bị
**bỏ qua âm thầm** (không làm hỏng việc đăng bài), còn "Quên mật khẩu" trả về lỗi
rõ ràng cho người dùng.


## Chế độ bảo trì (maintenance)

Một file cờ duy nhất bật/tắt toàn bộ chế độ, **không cần restart**:

```sh
touch data/maintenance-on     # bật: mọi request trả 503 + trang thông báo
rm    data/maintenance-on     # tắt, lập tức
```

Khi bật, `server/maintenance.js` chặn đứng trước mọi route `/api`: chỉ trang
`public/maintenance.html` và các asset nó cần (`/css/`, `/js/`, `/fonts/`,
`/uploads/`) đi qua, còn lại nhận **503** kèm `Retry-After: 600` và
`Cache-Control: no-cache` — chủ đích không trả 200, vì một trang bảo trì trả 200
là trang mà CDN sẽ cache và tiếp tục phục vụ sau khi đã bỏ cờ.

Cùng một thẻ thông báo đó xuất hiện ở ba cửa, một copy duy nhất:

1. **Trang riêng** `public/maintenance.html` — phục vụ khi cờ bật, và khi một
   request chết trong 5xx (error handler của `server.js` trả trang này cho
   request muốn HTML; caller `/api` vẫn nhận JSON để parse). Trang cố tình
   KHÔNG nạp `tailwind.css` lẫn `js/api.js`: nó là thứ được phục vụ khi phần
   còn lại đang hỏng, nên không được phụ thuộc thứ có thể là nguyên nhân.
2. **Panel trên trang đang đọc** — `js/api.js` phủ thẻ lên trang khi `fetch`
   throw (server mất hẳn) hoặc trả 5xx, một lần duy nhất, kèm nút "Thử lại"
   (reload). Lỗi 4xx không bật panel: đó là đầu vào của người đọc và mỗi form
   đã tự trả lời.
3. **Cờ file** ở trên, cho bảo trì có kế hoạch.

Thẻ vẽ bằng token của site (`.maintenance-*` trong `css/common.css`), nên theme
tối tự restyle; icon cờ-lê là `<svg>` inline vì font icon subset không có glyph
này. Kiểm thử: `t25` (stub `fs` trong `require.cache` — KHÔNG được tạo file cờ
thật trong cây live để test, vì sẽ làm web sập thật trong lúc file tồn tại).


## Cấu trúc thư mục

```
tuanpa-blog/
├── server/              # Backend Express
│   ├── server.js        # điểm khởi chạy
│   ├── compress.js      # gzip/brotli cho response text (dùng zlib, không thêm dependency)
│   ├── db.js            # kết nối + schema SQLite, seed admin đầu tiên
│   ├── env.js           # nạp .env theo __dirname, TỪ CHỐI khởi động nếu JWT_SECRET yếu
│   ├── password.js      # BCRYPT_ROUNDS + giới hạn độ dài mật khẩu, dùng chung
│   ├── sanitize-html.js # sanitizer allowlist: parse rồi tái tạo (không phải regex)
│   ├── security-headers.js # CSP, nosniff, X-Frame-Options, HSTS
│   ├── media-store.js   # lưu trữ/kiểm tra/bookkeeping ảnh + thư mục cho thư viện
│   ├── embeds.js        # giải link YouTube/Vimeo/... thành iframe src (allowlist)
│   ├── email-config.js  # cấu hình email (bảng email_settings) + preset Gmail/O365
│   ├── mailer.js        # gửi OTP / thông báo bài mới qua SMTP
│   ├── sitemap.js       # sinh GET /sitemap.xml từ các bài đã publish (không phải file tĩnh)
│   ├── middleware/
│   │   ├── auth.js      # requireAuth / requireWriter / requireAdmin
│   │   └── rate-limit.js # sliding window, đọc CF-Connecting-IP
│   └── routes/
│       ├── auth.js      # đăng ký / đăng nhập / hồ sơ
│       ├── posts.js     # CRUD bài viết + bình luận
│       ├── media.js     # thư viện ảnh (editor/admin)
│       ├── upload.js    # upload avatar (mọi role, 8 MB)
│       ├── admin.js     # thống kê + quản lý user/bài viết (yêu cầu role=admin)
│       └── subscribe.js # đăng ký bản tin
├── public/              # Frontend tĩnh, phục vụ trực tiếp bởi Express
│   ├── index.html       # Trang chủ  (từ dashboard.html)
│   ├── post.html        # Chi tiết bài viết (từ letter.html)
│   ├── profile.html     # Trang cá nhân (từ user.html)
│   ├── admin.html       # Bảng quản trị (từ admin.html)
│   ├── write.html        # Soạn / sửa bài viết
│   ├── js/, css/         # logic dùng chung
│   ├── js/media.js       # thư viện ảnh: lưới + uploader + modal chọn ảnh
│   ├── css/media.css     # style thư viện, dùng cho cả admin.html và write.html
│   ├── css/tailwind.css  # SINH RA từ tailwind.config.js — đừng sửa tay
│   ├── css/fonts.css     # SINH RA từ scripts/fetch-fonts.py — chỉ còn font ICON, đừng sửa tay
│   └── fonts/            # font icon tự host (đúng 1 file), tên có hash nội dung
├── src/tailwind.css     # file nguồn của Tailwind CLI
├── tailwind.config.js   # design token (trước đây là public/js/tailwind-config.js)
├── scripts/             # fetch-fonts.py, icon-names.py, check-icons.py, security-deploy.sh
├── data/                # blog.db (tự tạo) + tmp-uploads/ (staging upload, NGOÀI public/)
├── .env.example
└── package.json
```

## Build frontend (bắt buộc sau khi sửa markup hoặc thêm icon)

Trang không còn dùng `cdn.tailwindcss.com`: CSS được biên dịch sẵn nên không còn
cảnh cả trang hiện ra chưa có style rồi mới nhảy chữ khi F5.

Font thì chia làm đôi:

- **Font chữ — Plus Jakarta Sans — lấy từ Google Fonts** bằng một thẻ `<link>`
  trong cả 6 trang, kèm hai thẻ `preconnect` trả trước phí DNS + TLS.
  `display=swap` nên chữ hiện ngay bằng font dự phòng rồi mới đổi sang font thật.
  URL liệt kê đúng các weight design đang dùng (400/500/600/700 + 400/700
  nghiêng) vì Google phục vụ chúng như **static face**, không phải một variable
  font: thiếu weight nào trong danh sách thì weight đó bị **tổng hợp giả**.
- **Font icon — Material Symbols — vẫn tự host**, vì icon ở đây là **ligature**
  nên bắt buộc `font-display: block`, mà block chỉ chịu được khi file nhỏ
  (xem `fetch:fonts` bên dưới).

Vì font chữ nằm ở origin thứ ba nên **CSP phải cho phép** nó:
`fonts.googleapis.com` trong `style-src` và `fonts.gstatic.com` trong `font-src`
(`server/security-headers.js`). Thiếu một trong hai thì trình duyệt **không báo
lỗi gì trên trang** — nó chỉ từ chối tải, và chữ lặng lẽ render bằng font dự
phòng, trông y hệt "đổi font mà không ăn".

Đổi lại, có hai bước build cần chạy:

```bash
npm install                # lần đầu: cài tailwindcss + 2 plugin (devDependencies)

npm run build:css          # SAU MỖI LẦN thêm/đổi class trong public/*.html hoặc public/js/*.js
npm run watch:css          # hoặc để nó tự build lại khi đang sửa

npm run fetch:fonts        # CHỈ KHI thêm một icon Material Symbols mới
```

Vì sao phải chạy:

- **`build:css`** — Tailwind chỉ sinh ra những class mà nó *thấy* trong
  `public/*.html` và `public/js/*.js`. Thêm một class mới mà không build lại thì
  class đó đơn giản là không tồn tại trong `public/css/tailwind.css`, và phần tử
  mất style. Cũng vì thế mọi tên class phải là **chuỗi literal**: viết
  `'bg-' + color` sẽ biên dịch ra rỗng, còn ghép cả chuỗi vào template literal
  (như `TAG_STYLES` trong `viewall.js`) thì an toàn.

  ⚠️ **Trên mount này `build:css` KHÔNG chạy được**: `node_modules/.bin/tailwindcss`
  có tồn tại nhưng hỏng (`Cannot find module './cli/index'`). Hệ quả thực tế là
  `public/css/tailwind.css` phải **sửa tay** khi đổi thứ nằm trong config — ví dụ
  stack font `VI_SANS` được bake vào Preflight (`html{font-family:...}`) và vào mọi
  utility `font-*`, tổng cộng 4 chỗ. Đổi `tailwind.config.js` mà không sửa file đã
  biên dịch thì thay đổi **không có tác dụng gì cả**, và cũng không có lỗi nào báo
  ra. Font chữ vì thế nằm ở **ba** chỗ phải khớp nhau: token `--font-vi-sans` trong
  `common.css`, `VI_SANS` trong `tailwind.config.js`, và bản đã bake trong
  `tailwind.css`.
- **`fetch:fonts`** — font icon đã được subset xuống còn ~27 KB chứa đúng 94 icon
  đang dùng (bản đầy đủ là 1,13 MB). Icon ở đây là **ligature**: markup chứa
  nguyên chữ (`perm_media`) và font map chuỗi ký tự đó thành một glyph. Icon không
  có trong subset vì thế sẽ **không hiện gì cả** hoặc hiện **nguyên cái tên** —
  cả hai đều trông như trang bị lỗi. Script tự quét tên icon từ markup, đồng thời
  sửa luôn thẻ `<link rel="preload">` trong 6 trang (tên file có hash nên phải
  sửa theo).

  Script **không đụng tới font chữ nữa**. Từ khi Plus Jakarta Sans được nạp bằng
  `<link>`, `fonts.css` chỉ còn đúng một `@font-face` cho icon, và lần chạy đầu
  tiên sau thay đổi đó đã tự xoá 18 file `bevietnampro-*.woff2` (~350 KB) không
  ai trỏ tới nữa — cùng một cơ chế `stale()` vẫn dùng để bỏ subset icon cũ.

  Icon chỉ xuất hiện **qua biến** (ternary, bảng tra) thì regex không quét được —
  phải thêm tay vào danh sách `DYNAMIC` trong `scripts/icon-names.py`. Đây là cái
  bẫy đã làm `perm_media` và `sync` hiện thành chữ một lần.

  Kiểm tra sau khi build (cần `pip install fonttools`):

  ```bash
  python3 scripts/check-icons.py
  ```

  Nó đối chiếu mọi icon markup yêu cầu với ligature thật có trong font, **và** xác
  nhận cả 6 trang cùng `fonts.css` trỏ tới **cùng một** file font — trỏ lệch nhau
  nghĩa là có trang đang tải subset build cho tập icon khác.
  `scripts/security-deploy.sh` cũng chạy kiểm này ở bước 8.

Cả hai lệnh đều ghi vào `public/`, nên chạy trên máy dev rồi deploy kết quả cũng
được — server không cần `tailwindcss` lúc chạy.


## Chạy thử trên máy local

Yêu cầu: Node.js >= 18.

```bash
cp .env.example .env
openssl rand -hex 32          # dán kết quả vào JWT_SECRET trong .env
nano .env                      # đặt JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
npm install
npm start                      # hoặc: npm run dev (tự restart khi sửa code)
```

Mở trình duyệt tại `http://localhost:3000`.

### Về `.env` — bắt buộc, không còn giá trị mặc định

Server **từ chối khởi động** nếu `JWT_SECRET` trống, ngắn hơn 32 ký tự, hoặc vẫn
là giá trị mẫu. Trước đây nó lặng lẽ quay về chuỗi `dev_secret` — chuỗi này có
trong mã nguồn công khai, nghĩa là bất kỳ ai cũng tự ký được token admin nếu
`.env` không load được.

Tài khoản admin đầu tiên đọc từ `ADMIN_EMAIL` / `ADMIN_PASSWORD` và **chỉ** được
tạo khi database chưa có admin nào. Cũng **không còn mật khẩu mặc định**: bỏ trống
`ADMIN_PASSWORD` thì không có admin nào được tạo (server ghi một cảnh báo). Bản cũ
quay về `Admin@123` — giá trị in ngay trong README này — nên mọi deployment chưa
sửa `.env` đều chạy với mật khẩu admin ai cũng biết. Mật khẩu seed cần tối thiểu
12 ký tự.

## Triển khai trên Ubuntu Server (production)

### 1. Cài Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential
node -v
```

`build-essential` cần thiết vì `better-sqlite3` biên dịch native module khi cài đặt.

### 2. Đưa mã nguồn lên server

```bash
# ví dụ dùng git, hoặc scp/rsync thư mục tuanpa-blog lên server
git clone <repo-cua-ban> /var/www/tuanpa-blog
cd /var/www/tuanpa-blog
cp .env.example .env
nano .env     # đặt JWT_SECRET dài & ngẫu nhiên, đổi ADMIN_EMAIL/PASSWORD
npm install --omit=dev
```

`--omit=dev` bỏ qua `tailwindcss` — đúng như mong muốn: server **không build**
CSS lúc chạy. Nó phục vụ trực tiếp `public/css/tailwind.css`,
`public/css/fonts.css` và `public/fonts/` đã sinh ra sẵn, nên ba thứ đó phải
được commit / rsync lên cùng mã nguồn (chúng không nằm trong `.gitignore`). Nếu
sửa markup ngay trên server thì chạy `npm run build:css` ở đó (cần
`npm install` đầy đủ), hoặc build ở máy dev rồi đẩy file kết quả lên.

### 3. Chạy ứng dụng bằng PM2 (giữ tiến trình sống, tự khởi động lại)

```bash
sudo npm install -g pm2
pm2 start server/server.js --name tuanpa-blog
pm2 save
pm2 startup           # copy & chạy lệnh mà pm2 in ra để tự khởi động cùng hệ thống
```

Kiểm tra: `pm2 logs tuanpa-blog` / `pm2 status`.

### 4. Cấu hình Nginx làm reverse proxy (tùy chọn nhưng khuyến nghị)

```bash
sudo apt install -y nginx
```

Tạo file `/etc/nginx/sites-available/tuanpa-blog`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/tuanpa-blog /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 5. Bật HTTPS miễn phí với Let's Encrypt

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

### 6. Sao lưu dữ liệu

Toàn bộ dữ liệu (người dùng, bài viết, bình luận, subscriber) nằm trong file
`data/blog.db`. Sao lưu định kỳ file này (ví dụ bằng `cron` + `rsync`/`scp` ra
nơi lưu trữ khác) là đủ để backup toàn bộ blog. Ảnh nằm trong `public/uploads/`
(thư mục con `thumbs/` sinh ra được nên không cần backup).

### 7. Cài ImageMagick cho thumbnail thư viện ảnh (khuyến nghị)

```bash
sudo apt install -y imagemagick
cd /var/www/tuanpa-blog
node scripts/gen-derivatives.js   # tạo cả hai cỡ dẫn xuất cho ảnh đã có sẵn
```

Mỗi ảnh upload có hai bản dẫn xuất: `thumbs/` 480px cho ô lưới và card, `w1280/`
1280px cho ảnh bìa bài nổi bật, ảnh đầu bài viết và ảnh trong nội dung — những
nơi trước đây tải thẳng bản gốc 8–28 MB. Trang công khai trỏ vào bản dẫn xuất
còn thư viện giữ nguyên bản gốc để chép URL / chèn vào bài. Không cài
ImageMagick cũng không sao — các route `/uploads/thumb/…` và `/uploads/w1280/…`
tự 302 về ảnh gốc. Chi tiết ở `server/thumbs.js` và `server/server.js`.

### 8. Minify JS/CSS (khuyến nghị)

```bash
# chọn MỘT cách đưa esbuild vào máy, cách nào cũng đứng NGOÀI cây dự án:
sudo npm install -g esbuild                  # có sudo
sudo apt install -y esbuild                  # gói của distro, nằm trên PATH
npm install --prefix ~/esbuild-tool esbuild  # không cần sudo, thư mục riêng

cd /var/www/tuanpa-blog
# với cách --prefix, chỉ cho script đường dẫn (hoặc export ESBUILD_BIN một lần):
ESBUILD_BIN=~/esbuild-tool/node_modules/.bin/esbuild node scripts/build-assets.js
# hai cách kia thì esbuild đã trên PATH:
node scripts/build-assets.js                 # sinh public/js/*.min.js, public/css/*.min.css
```

`esbuild` phải đứng NGOÀI cây dự án (global, apt, hoặc `--prefix` như trên):
`npm install` trong cây sẽ resolve lại `better-sqlite3` và thay binary ELF bằng
bản win32, làm server chết (cùng lý do `compress.js` chỉ dùng zlib). Các trang
vẫn trỏ tên file chưa minify; `server/server.js` tự trỏ sang bản `.min` song
sinh khi nó tồn tại, nên chưa chạy script thì site vẫn chạy nguyên như cũ.

Kéo theo một quy tắc vận hành: **mỗi lần đổi file trong `public/js` hoặc
`public/css` phải chạy lại `node scripts/build-assets.js` trên server**, vì
trình duyệt đang nhận bản `.min` cũ cho tới khi bản mới được sinh — chính cái
bẫy này đã một lần giữ bản write.js chưa sửa lại phía editor. Muốn site tạm
dùng bản gốc đọc được (chẳng hạn khi đang gỡ lỗi) thì xoá các file `.min.*`.

## Máy chủ web "tùy chọn"

Ứng dụng Express tự phục vụ cả API lẫn giao diện tĩnh (không bắt buộc dùng
Nginx/Apache). Bạn có thể:
- Chạy thẳng Node.js/Express trên cổng 80 (cần quyền root hoặc dùng
  `setcap`/`authbind`), hoặc
- Đặt Nginx/Apache/Caddy phía trước làm reverse proxy + xử lý HTTPS/gzip/cache
  tĩnh (khuyến nghị cho production, theo hướng dẫn Nginx ở trên).

## API tổng quan

| Method | Endpoint | Mô tả | Yêu cầu |
|---|---|---|---|
| POST | `/api/auth/check-email` | Bước 1 của luồng đăng nhập: email này đã có tài khoản chưa, loại nào | - |
| POST | `/api/auth/register` | Đăng ký | - |
| POST | `/api/auth/login` | Đăng nhập | - |
| POST | `/api/auth/verify-email` | Xác thực email bằng OTP, trả về JWT | - |
| POST | `/api/auth/resend-verification` | Gửi lại mã xác thực | - |
| GET | `/api/auth/me` | Thông tin cá nhân | JWT |
| PUT | `/api/auth/me` | Cập nhật hồ sơ | JWT |
| PUT | `/api/auth/password` | Đổi mật khẩu | JWT |
| GET | `/api/posts` | Danh sách bài viết (lọc `tag`, `q`, `mine`, `page`, `limit`) | - |
| GET | `/api/posts/:slug` | Chi tiết bài viết | - |
| POST | `/api/posts` | Tạo bài viết | JWT |
| PUT | `/api/posts/:id` | Sửa bài viết (chủ bài viết hoặc admin) | JWT |
| DELETE | `/api/posts/:id` | Xoá bài viết (chủ bài viết hoặc admin) | JWT |
| GET/POST | `/api/posts/:id/comments` | Bình luận | POST cần JWT |
| POST | `/api/posts/:id/reactions` | Like/dislike bài viết (`{ value: 1 | -1 | 0 }`) | JWT |
| POST | `/api/posts/comments/:id/reactions` | Like/dislike bình luận (`{ value: 1 | -1 | 0 }`) | JWT |
| DELETE | `/api/posts/comments/:id` | Xoá bình luận (kiểm duyệt) | JWT + admin |
| POST | `/api/posts/comments/:id/report` | Báo cáo bình luận (`{ reason, note? }`). Gửi lại đúng lí do đang có = **rút** báo cáo; đổi lí do = ghi đè | JWT |
| PATCH | `/api/posts/comments/:id/hidden` | Ẩn / bỏ ẩn bình luận **và cả cây trả lời** (`{ hidden }`) - khác xoá: tác giả vẫn thấy kèm lời nhắn | JWT + admin |
| POST | `/api/subscribe` | Đăng ký nhận bản tin | - |
| POST | `/api/upload` | Upload ảnh cho avatar - mọi role, tối đa 8 MB, trả về `{ url, media }` | JWT |
| GET | `/api/media` | Thư viện ảnh (lọc `q`, `mine`, `folder`, `page`, `limit`) | JWT + editor/admin |
| POST | `/api/media` | Upload vào thư viện (`folder_id` tuỳ chọn). **admin: không giới hạn dung lượng**; editor: 8 MB, 40 ảnh/giờ | JWT + editor/admin |
| GET | `/api/media/:id/usage` | Những bài viết đang dùng ảnh này | JWT + editor/admin |
| GET | `/api/media/folders` | Cây thư mục + số ảnh mỗi thư mục | JWT + editor/admin |
| POST | `/api/media/folders` | Tạo thư mục (`{ name, parent_id }`) | JWT + editor/admin |
| PUT | `/api/media/folders/:id` | Đổi tên và/hoặc di chuyển (`{ name?, parent_id? }`) | JWT + editor/admin |
| DELETE | `/api/media/folders/:id` | Xoá thư mục + thư mục con. **Ảnh chỉ bị bỏ khỏi thư mục** | JWT + admin |
| PUT | `/api/media/move` | Chuyển ảnh vào thư mục (`{ media_ids, folder_id }`) | JWT + editor/admin |
| POST | `/api/posts/embed` | Giải link thành iframe nhúng (`{ url }`) | JWT + editor/admin |
| DELETE | `/api/media/:id` | Xoá ảnh. Ảnh đang dùng cần `?force=true`. Editor chỉ xoá ảnh của mình | JWT + editor/admin |
| POST | `/api/media/sync` | Đồng bộ lại `public/uploads/` với bảng `media` | JWT + admin |
| GET | `/api/settings` | Nội dung trang chủ có thể chỉnh sửa (tiêu đề, tagline...) | - |
| GET | `/api/auth/google` | Bắt đầu luồng đăng nhập Google | - |
| GET | `/api/auth/google/callback` | Google gọi lại; đặt cookie handoff dùng một lần rồi redirect (token **không** nằm trong URL) | - |
| POST | `/api/auth/session` | Đổi cookie handoff lấy JWT | cookie handoff |
| GET | `/api/admin/stats` | Thống kê tổng quan | JWT + admin |
| GET/POST/PUT/DELETE | `/api/admin/users(/:id)` | Xem/tạo/đổi vai trò/xoá người dùng | JWT + admin |
| PATCH | `/api/admin/users/:id/status` | Vô hiệu hoá / bật lại tài khoản (`{ is_active }`) | JWT + admin |
| POST | `/api/admin/users/:id/reset-password` | Admin đặt mật khẩu mới cho tài khoản (`{ password }`) | JWT + admin |
| GET | `/api/admin/posts` | Tất cả bài viết (kể cả nháp) | JWT + admin |
| GET | `/api/admin/subscribers` | Danh sách subscriber | JWT + admin |
| GET/PUT | `/api/admin/settings` | Xem/sửa nội dung trang chủ | JWT + admin |
| GET | `/api/admin/notifications` | Thẻ Thông báo (`page`, `limit`, `filter=unread` hoặc một kind: `comment_reported`, `new_comment`, `new_user`, `comment_hidden`). Mỗi response kèm `unread` để badge tự đúng | JWT + admin |
| GET | `/api/admin/notifications/unread-count` | Số thông báo chưa đọc, cho badge trên thanh bên | JWT + admin |
| POST | `/api/admin/notifications/:id/read` | Đánh dấu một thông báo đã đọc | JWT + admin |
| POST | `/api/admin/notifications/read-all` | Đánh dấu tất cả đã đọc | JWT + admin |
| PATCH | `/api/admin/comment-reports/:id` | Kết quả xử lí một báo cáo (`{ status: open \| resolved \| dismissed }`). Ẩn bình luận là một hành động riêng | JWT + admin |

## Mở rộng thêm

- **Soạn thảo rich text:** thay `<textarea>` trong `write.html` bằng một
  trình soạn thảo WYSIWYG (TipTap, Quill...) và lưu HTML thay vì text thuần.
- **Quản lý thẻ (tag) riêng:** hiện tag là một chuỗi tự do; có thể tách thành
  bảng `tags` riêng nếu cần lọc/thống kê theo thẻ chuẩn hoá hơn.
- **Sao lưu ảnh upload:** `public/uploads/` không nằm trong Git/backup mã
  nguồn theo mặc định — nhớ backup thư mục này cùng với `data/blog.db`.
