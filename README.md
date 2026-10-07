# Search Auto — Bing 6.0.4

Bản 6.0.4 sửa lỗi bấm **Search/Start** hoặc **Schedule** không chạy: popup còn kiểm tra trường consent đã bị worker loại bỏ, đồng thời chờ tải quảng cáo trước khi gắn sự kiện. Bản sửa lưu đúng giá trị đang nhập, bảo vệ trạng thái phiên chạy và hiển thị lỗi ngay dưới nút.

Xem [báo cáo so sánh 2.0 / 4.0 / 6.0 và kết quả kiểm thử](COMPARISON_FIX_REPORT.vi.md).

Bản 6.0.4 sửa thêm Daily set/Keep earning bị bỏ qua do dấu hoàn thành của thẻ bên cạnh hoặc class `incomplete`. Nút Perform có Stop riêng và activity kiểm tra session để dừng an toàn khi khởi chạy lại.

## 1. Cài hoặc cập nhật trên Chrome

1. Mở `chrome://extensions`, bật **Developer mode**.
2. Nếu chưa cài, chọn **Load unpacked** và chọn chính thư mục **Bing 6.0** chứa `manifest.json`.
3. Nếu đã cài từ thư mục này, bấm **Reload** trên extension **Search Auto**.
4. Kiểm tra phiên bản **6.0.4**, rồi đóng và mở lại popup.
5. Trong **Search**, chọn `1 - 0`, bấm **Search**. Nút sẽ thành **Stop**, có trạng thái dưới nút và worker mở tab Bing.

Chrome tối thiểu theo manifest là 111. Extension không cần đăng nhập Google trên profile Chrome. Để nhận điểm Rewards hoặc chạy Daily set / Keep earning, cần đăng nhập Microsoft trên Bing/Rewards.

## 2. Search thủ công

1. Vào **Search**, nhập số lượt **Desktop** và **Mobile**.
2. Nhập **Min. Delay** và **Max. Delay** theo giây. Mặc định của 6.0 là `7–14` giây; popup chuẩn hóa giá trị ngoài giới hạn.
3. Có thể chọn preset `1 - 0`, `0 - 1`, `0 - 21`, hoặc tự nhập số lượt.
4. Bấm **Search**. Giá trị đang nhập được lưu trước khi gửi lệnh, kể cả khi chưa rời ô nhập.
5. Bấm **Stop** để dừng phiên hiện tại. Trong lúc Search chạy, nút chạy ở Schedule bị vô hiệu hóa.

“Starting” xác nhận worker nhận lệnh. Khi chạy xong thành công, thông báo trạng thái được ẩn; việc Microsoft cộng điểm cần kiểm tra riêng trên Rewards. Bản 6.0 chạy theo số lượt cấu hình, không tự giảm số lượt dựa trên daily search counter.

## 3. Schedule

1. Vào **Schedule**, nhập số lượt và khoảng delay.
2. Chọn chế độ trong bảng. Chọn chế độ chỉ lưu tần suất, không tự bắt đầu và không đổi số lượt.
3. Bấm **Schedule** để chạy ngay một phiên với cấu hình đã nhập và áp dụng chế độ đó.

| Chế độ            | Sau lần chạy ngay khi bấm Schedule                                       |
| ----------------- | ------------------------------------------------------------------------ |
| Manual Only       | Không tự chạy lại.                                                       |
| At Startup        | Chạy khi Chrome khởi động qua sự kiện `runtime.onStartup`.               |
| Every ~5 Minutes  | Lần tiếp theo sau khoảng 5 phút đến 7 phút 29 giây khi phiên kết thúc.   |
| Every ~15 Minutes | Lần tiếp theo sau khoảng 15 phút đến 17 phút 29 giây khi phiên kết thúc. |

Khoảng chờ có thể dài hơn sau thất bại. Chrome phải đang chạy để thực thi alarm. Với **At Startup**, thử bằng cách thoát hẳn và mở lại Chrome; mở lại cửa sổ hoặc popup không phải khởi động trình duyệt.

Stop dừng phiên hiện tại và giữ cấu hình tần suất. Để ngừng các lần chạy tự động tiếp theo, chọn **Manual Only** và bấm **Schedule** để áp dụng.

## 4. Daily set và Keep earning

- Bật **Automate Activities after searches** trong Settings để chạy activity sau search.
- Bấm **Perform** ở **Perform Activities** để chạy riêng activity. Khi chạy, nút này thành **Stop**; Search/Schedule bị khóa để tránh chạy chồng. Nếu activity chạy sau search, dùng Stop ở nút Search/Schedule đang sở hữu phiên.
- Đăng nhập Microsoft và mở `https://rewards.bing.com/` để xác nhận tài khoản truy cập được dashboard.

Bản 6.0 đọc dữ liệu activity qua Rewards API. Nếu search chạy nhưng activity không hoàn thành, xem trạng thái dưới nút và kiểm tra phiên đăng nhập Microsoft.

### Các bước và điều kiện kết thúc ACT

1. Mở Rewards và kiểm tra phiên Microsoft.
2. Quét Daily set, click từng thẻ còn việc, xử lý tab quiz/poll và kiểm tra kết quả.
3. Chuyển Keep earning, rồi kiểm tra Ready to claim/Claim.
4. Đóng tab activity, bỏ debugger và xóa trạng thái ACT/bận.

Click một thẻ chưa phải kết thúc toàn bộ ACT. Tool vẫn có thể đang trả lời quiz, chờ điểm hoặc xử lý bước kế tiếp.

Từ 6.0.3, mỗi request Rewards API có timeout 8 giây, gồm cả đọc JSON. Lượt quét không có thẻ không chờ điểm và không gọi API điểm. Sau hai lượt quét trống, tool chuyển bước; retry cuộn đứng yên hai lần cũng dừng quét vùng đó. Tool vẫn cho phép cuộn đến vị trí mới và thử lại thẻ chưa xác nhận trong giới hạn hiện có.

Nếu dùng Schedule định kỳ, một phiên kết thúc vẫn có thể được lên lịch chạy lại ở chu kỳ sau.

## 5. Mobile và cookie đăng nhập

**Enhanced Patch v1.5.8 for Mobile points** điều khiển luồng hỗ trợ mobile. Extension dùng Chrome debugger để giả lập thiết bị; DevTools gắn vào tab Bing đang chạy có thể làm attach debugger thất bại.

Từ 6.0.4, luồng tự động chỉ xóa cache; giữ cookie và dữ liệu xác thực khi chuyển PC → mobile, chạy mobile patch và chuẩn bị ACT. Bỏ tùy chọn backup/restore cũ vì xóa đăng nhập rồi khôi phục sau mobile có thể khiến mobile chạy khi mất phiên. Bản mới vẫn thử phục hồi snapshot còn sót từ bản cũ khi worker khởi động. Nút **Clear Bing Browsing Data** trong Settings vẫn xóa dữ liệu khi người dùng chủ động bấm.

Bản 6.0 không có cơ chế xác nhận điểm mobile thực tế như 4.0. Kiểm tra điểm trên Rewards sau khi chạy thử.

## 6. Settings và xử lý lỗi

- **Test Device / refresh**: đổi thiết bị mobile giả lập.
- **Show Advance Logs**: bật log console chi tiết của worker. File diagnostic cuối phiên luôn ghi các phase, tiến độ search, trạng thái phiên ACT và lỗi dù tùy chọn này tắt; lưu ở Downloads/bingreward-logs. Log có phiên bản extension để kiểm tra đúng bản đang chạy.
- **Search Niche**: chọn nhóm từ khóa có trong dữ liệu hiện tại.
- **Download search history(24Hr)** / **Delete search history(24Hr)**: tải hoặc xóa lịch sử search trong 24 giờ.
- **Download crash log** / **Clear crash log**: tải hoặc xóa nhật ký lỗi đã lưu.
- **Reset Runtime data**: dừng phiên và xóa trạng thái chạy.
- **Reset Extension**: dừng phiên và reset cấu hình.
- **Clear Bing Browsing Data**: xóa dữ liệu Bing, có thể cần đăng nhập lại.
- **Simulate Tab**: bật/tắt giả lập mobile trên tab hiện tại.
- **User Manual / Open**: mở PDF hướng dẫn cũ; các thiết lập của bản này được mô tả trong README này.

Nếu nút không chạy:

1. Đọc thông báo dưới nút. Popup chờ phản hồi worker tối đa 20 giây rồi báo lỗi.
2. Kiểm tra đúng thư mục và phiên bản 6.0.4, rồi reload extension.
3. Bật **Show Advance Logs**, mở **service worker** trong `chrome://extensions`, thử lại với `Desktop = 1`, `Mobile = 0`.
4. Tải **crash log** nếu có lỗi. Không cần reset toàn bộ profile để kiểm tra lỗi khởi chạy.

## 7. Kiểm tra mã nguồn

Trong thư mục Bing 6.0, với Node.js và dependency đã cài:

```sh
npm ci
npm test -- --runInBand
node tests/check_syntax.js
npm run lint
```

Bản sửa đạt 400/400 kiểm thử, kiểm tra cú pháp và lint. Test popup dùng HTML/jQuery thực tế; test worker nạp graph module thực tế với Chrome API giả lập. Kết quả chưa xác nhận lượt chạy thực tế hoặc điểm Rewards trên profile Chrome của người dùng.
