# Hướng Dẫn Sử Dụng Search Auto

## 1. Cài extension vào Chrome/Edge

1. Tải hoặc clone repo này về máy.
2. Mở Chrome/Edge và vào trang `chrome://extensions`.
3. Bật `Developer mode`.
4. Chọn `Load unpacked`.
5. Chọn đúng thư mục `Bing 4.0`. Bản sửa hiện hiển thị version `2.0.2`.
6. Pin extension `Search Auto` lên thanh công cụ để dễ mở.

Sau mỗi lần pull code mới từ GitHub, quay lại `chrome://extensions` và bấm nút reload ở extension.

## 2. Chuẩn bị trước khi chạy

1. Đăng nhập tài khoản Microsoft/Bing trong trình duyệt.
2. Mở `https://rewards.bing.com/` một lần để chắc chắn tài khoản đã vào được dashboard.
3. Không mở DevTools cho tab extension khi đang chạy, vì extension dùng Chrome debugger để giả lập mobile.
4. Nên bật log nếu cần xem lỗi: mở extension > `Settings` > bật `Show Advance Logs`, sau đó xem console của service worker trong `chrome://extensions`.

## 3. Chạy search thủ công

1. Mở extension.
2. Vào tab `Search`.
3. Nhập số lượt:
   - `Desktop`: số search desktop.
   - `Mobile`: số search mobile.
4. Chọn delay:
   - `Min. Delay`: thời gian chờ tối thiểu giữa các search.
   - `Max. Delay`: thời gian chờ tối đa giữa các search.
5. Có thể bấm nhanh các mode:
   - `10 - 0`: chỉ desktop nhẹ.
   - `20 - 10`: desktop + mobile vừa.
   - `30 - 20`: mức thường dùng.
   - `50 - 30`: mức cao, nên dùng delay dài hơn.
6. Bấm `Search`.
7. Khi đang chạy, nút sẽ đổi thành `Stop`; bấm lại nếu muốn dừng.

Khuyến nghị: dùng delay `15-30s` hoặc cao hơn nếu chạy nhiều acc để giảm lỗi Bing không ghi nhận điểm.

## 4. Chạy daily set và Keep earning

Có 2 cách chạy:

### Chạy tự động sau search

1. Vào `Settings`.
2. Bật `Automate Activities after searches`.
3. Quay lại tab `Search`.
4. Bấm `Search`.

Sau khi search xong, extension sẽ tự mở Rewards dashboard, click `Daily set`, rồi chuyển sang trang `Keep earning` để xử lý các card còn điểm.

### Chạy riêng activity

1. Vào `Settings`.
2. Bấm `Perform` ở dòng `Perform Activities`.

Cách này dùng khi search đã xong nhưng muốn chạy lại daily set hoặc earning point.

## 5. Chạy mobile points ổn định hơn

Trong `Settings`, `Refresh Bing cache for Mobile searches` chỉ làm mới cache. Luồng tự động giữ cookie và localStorage đăng nhập Microsoft suốt lượt mobile, đồng thời vẫn giả lập thiết bị bằng debugger.

Bản 2.0.2 đọc bộ đếm trong một tab Rewards phụ cùng profile. Khi `fetch` báo lỗi kết nối, extension thử mở trực tiếp `https://rewards.bing.com/api/getuserinfo` trong tab nền, đọc JSON rồi đóng chính tab phụ đó. Mỗi lần kiểm tra mở lại API để lấy dữ liệu mới; không điều hướng tab của người dùng và không xóa cookie. Nếu API trả về dữ liệu rỗng (ví dụ `code: 9`) thì vẫn báo không đọc được điểm, không coi đó là 0 điểm hay tự kết luận bị đăng xuất.

Sau mỗi 3 search (hoặc khi kết thúc lượt ngắn), extension đợi và kiểm tra điểm mobile thật. Nếu bộ đếm không tăng hoặc không đọc được, lượt mobile dừng và hiện lý do trong popup. Search đổi URL không còn được xem là bằng chứng đã cộng điểm; việc ghi nhận điểm vẫn do Microsoft quyết định.

Nếu mobile bị dừng ở vài acc:

1. Bấm `Reset Runtime data`.
2. Kiểm tra dòng trạng thái trong popup và tài khoản Microsoft trên Rewards. Không xóa cookie để thử lại: nút `Clear Bing data & login` là thao tác thủ công có thể đăng xuất.
3. Bấm biểu tượng refresh ở dòng device để đổi thiết bị giả lập.
4. Reload extension trong `chrome://extensions`.
5. Chạy lại với delay cao hơn, ví dụ `25-45s`.

## 6. Schedule

1. Vào tab `Schedule`.
2. Nhập số lượt `Desktop`, `Mobile`, `Min. Delay`, `Max. Delay`.
3. Chọn mode:
   - `Manual Only`: không tự chạy.
   - `At Startup`: thử chạy khi mở trình duyệt; nếu chưa đọc được Rewards hoặc đang có lượt khác, thử lại tối đa 4 lần, cách nhau 1 phút. Không tự chạy khi chưa xác minh được bộ đếm.
   - `Every ~5 Minutes`: tự chạy lại sau khoảng 5 phút, có random.
   - `Every ~15 Minutes`: tự chạy lại sau khoảng 15 phút, có random.
4. Bấm `Schedule`.

Nếu đang chạy schedule và muốn dừng, mở extension rồi bấm `Stop`.

Để thử `At Startup` trên macOS, thoát Chrome hoàn toàn bằng `Cmd+Q`, rồi mở lại đúng profile. Đóng cửa sổ hoặc reload extension không phải là khởi động lại trình duyệt. [Tài liệu Chrome về onStartup](https://developer.chrome.com/docs/extensions/reference/api/runtime#event-onStartup).

## 7. Các nút trong Settings

- `User Manual / Open`: mở hướng dẫn cũ nếu có file manual đi kèm.
- `Test Device / refresh`: đổi thiết bị mobile giả lập.
- `Refresh Bing cache for Mobile searches`: bật/tắt làm mới cache; không xóa cookie đăng nhập.
- `Keep Microsoft login during mobile`: luôn bật trong luồng tự động, kể cả với cấu hình cũ.
- `Show Advance Logs`: bật log chi tiết để debug.
- `Search Niche`: chọn nhóm từ khóa search.
- `Perform`: chạy daily set và Keep earning ngay.
- `Automate Activities after searches`: tự chạy activity sau khi search xong.
- `Clear Bing data & login`: xóa dữ liệu và cookie Bing thủ công, có thể đăng xuất.

- `Simulate Tab`: bật/tắt giả lập mobile trên tab hiện tại.
- `Download search history(24Hr)`: tải lịch sử search 24 giờ.
- `Delete search history(24Hr)`: xóa lịch sử search 24 giờ.
- `Reset Runtime data`: reset trạng thái đang chạy.
- `Reset Extension`: reset toàn bộ cấu hình extension.

File chẩn đoán được lưu khi lượt chạy kết thúc trong `Downloads/bingreward-logs/diag-*.log`. Bật `Show Advance Logs` trước khi chạy để có đủ chi tiết. Daily set được xác nhận bằng điểm tăng hoặc trạng thái Completed của chính thẻ; mở một tab mới không được tính là hoàn thành. Thẻ cần thao tác riêng như referral có thể vẫn cần thực hiện thủ công.

## 8. Khi bị lỗi hoặc tự dừng

Làm theo thứ tự này:

1. Bật `Show Advance Logs`.
2. Vào `chrome://extensions`.
3. Ở extension `Search Auto`, mở `service worker` console.
4. Chạy lại acc bị lỗi.
5. Xem log các dòng có `[QUERY]`, `[PERFORM]`, `[SEARCH]`, `[EMULATION]`, `[ACTIVITY]`.
6. Nếu thấy lỗi content script hoặc mobile emulation, reload extension và chạy lại.
7. Nếu chỉ một vài acc lỗi, kiểm tra đăng nhập Microsoft, dòng trạng thái và bộ đếm trên Rewards trước khi thử lại. Không dùng nút xóa dữ liệu đăng nhập để xử lý lỗi mobile.

## 9. Cách cập nhật code mới

Trong thư mục repo:

```powershell
git pull origin main
```

Sau đó mở `chrome://extensions` và bấm reload extension.

## 10. Cách kiểm tra code trước khi dùng

Trong thư mục repo:

```powershell
npm install
npm test -- --runInBand
node tests/check_syntax.js
```

Nếu tất cả pass thì reload extension và chạy thử một acc trước khi chạy nhiều acc.
