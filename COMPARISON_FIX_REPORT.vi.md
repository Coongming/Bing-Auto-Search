# So sánh Bing 2.0 / 4.0 / 6.0 và bản sửa 6.0.5

Đã sửa lỗi khởi chạy trong thư mục **Bing 6.0**, đổi manifest thành **6.0.5**. Hai nguyên nhân chính là popup yêu cầu consent mà worker đã xóa và chờ quảng cáo trước khi gắn handler cho nút. Không cần đăng nhập Google để chạy extension trên profile Chrome mới.

## Bổ sung ở 6.0.5: timeout 4 giây và chẩn đoán điểm mobile

Log `diag-2026-10-07T04-33-47-465Z-run.txt` của bản 6.0.4 ghi 1 PC + 21 mobile, tổng 22 lượt gửi, 0 lỗi; mobile giả lập hoàn tất và ACT nhận Microsoft session active. Daily set xử lý ba thẻ, Keep earning xử lý Quote of the day. Tuy nhiên mọi chênh lệch điểm đều `null`, và log chưa đọc PC/mobile counter nên chưa xác định được các lượt mobile được cộng vào counter nào hoặc không được cộng.

Theo yêu cầu người dùng, request Rewards giới hạn **4 giây**, bao gồm cả HTTP và JSON body; timeout abort request và dọn timer. Reader 6.0 trước đây chỉ lấy `status.userStatus`; bổ sung `dashboard.userStatus` đã được reader 4.0 hỗ trợ. API không có dữ liệu hợp lệ giờ báo rõ cấu trúc phản hồi thay vì trả null im lặng; không ghi giá trị tài khoản/cookie vào log.

Ghi counter PC/mobile trước và sau mobile, gồm progress, max, tên counter và chênh lệch. Nếu thiếu counter hoặc request lỗi, ghi unknown/lý do lỗi. Không sửa số lượt cấu hình, không tự áp quota hoặc khôi phục cơ chế dừng mobile của 4.0. Chưa thể khẳng định đã sửa việc Microsoft cộng điểm cho lượt mobile; cần counter từ lượt chạy thực tế.

Log cũng ghi ACT click nhầm Today's points / Points breakdown bốn lần, retry và chờ điểm không cần thiết. Scanner Keep earning giờ bỏ qua mục thống kê này, vẫn chọn thẻ Quote of the day có +5.

Kiểm thử bao gồm deadline 4 giây và JSON treo, parser hai dạng API, dữ liệu không hợp lệ, counter thiếu là unknown, PC tăng mà mobile không tăng, API lỗi không làm đổi kế hoạch search và bỏ qua mục thống kê. Tổng **410/410 test**, 24 suite; cú pháp 55 file, lint đạt.

Thông tin từ [Microsoft Support](https://support.microsoft.com/en-us/accounts-billing/rewards/learn-about-microsoft-rewards): không cộng điểm có thể liên quan tài khoản/đồng bộ dữ liệu, counter đạt giới hạn, truy vấn tự động hoặc thị trường. Đây là các khả năng để đối chiếu, chưa phải kết luận về tài khoản của người dùng.

## Bổ sung ở 6.0.4: giữ đăng nhập qua PC → mobile → ACT

File `diag-2026-10-07T04-02-34-443Z-schedule.txt` do người dùng cung cấp chỉ có hai dòng sự kiện: nhận Schedule và bắt đầu 31 desktop / 21 mobile, thiết bị Realme 50, mode m2, ACT bật. Log chưa có dữ liệu tại thời điểm logout nên không xác nhận được nguyên nhân từ log riêng lẻ.

Đối chiếu source thấy hai đường tự động xóa dữ liệu xác thực: clear trước mobile và clear khi mobile cần patch. Trước mobile, backup được khôi phục sau lượt mobile cuối cùng; vì vậy các lượt mobile có thể chạy không đăng nhập. Clear cũng xóa localStorage nhưng backup chỉ chứa một số cookie, nên không đảm bảo khôi phục nguyên phiên. Đường patch còn xóa cookie lần nữa. 4.0 giữ auth storage ở luồng tự động.

Đã đổi cả hai đường sang xóa cache, giữ cookie/localStorage, bỏ dependency backup/restore ở `runSearchPhases()` và bỏ tùy chọn backup cũ khỏi popup. Recovery vẫn đọc snapshot còn sót từ bản cũ; thao tác Clear Bing Browsing Data thủ công giữ hành vi cũ. Stop trong mobile không chạy thêm bước clear cuối.

Diagnostic mới ghi phase/progress, trạng thái đăng nhập ACT, kết quả quét và lỗi dù Show Advance Logs tắt. File có version và tổng số search đã gửi/thất bại; số lượt gửi không được coi là bằng chứng cộng điểm.

Test mô phỏng auth cookie + auth storage tái hiện mất phiên ở mã cũ cả khi preserveRewards bật/tắt, rồi đạt sau sửa cho PC → mobile → ACT. Test nạp graph worker thực kiểm tra patch không gửi cookies/localStorage vào browsingData.remove và diagnostic ACT vẫn có tiến trình khi log console tắt. Chưa xác nhận điểm mobile trên tài khoản thực.

## Bổ sung ở 6.0.3: ACT kết thúc sau khi hết việc

ACT chạy Daily set → Keep earning → Ready to claim, rồi đóng tab và xóa trạng thái runtime. Trước sửa, mỗi lượt quét kể cả không có thẻ vẫn đọc điểm, chờ 4–6,5 giây và kiểm tra tab. Các request `getuserinfo` không có timeout; một request hoặc JSON body treo có thể giữ phiên ACT vô thời hạn. `retry = true` cũng luôn reset idle, nên cuộn không tiến triển có thể kéo dài tới giới hạn 35 lượt Daily set hoặc 45 lượt Keep earning.

Đã thêm `js/activity-runtime.js`: request Rewards giới hạn 8 giây và abort khi hết hạn; tracker dừng sau hai lượt không có thẻ, hoặc hai retry liên tiếp không đổi vị trí cuộn. Có click/thao tác thực hoặc cuộn tới vị trí mới vẫn được tiếp tục. Không coi click hay thẻ bị skip là bằng chứng Microsoft cộng điểm.

Scanner chọn thẻ trước; chỉ đọc baseline điểm và chờ tab nếu thật sự có thẻ để click. Daily set, Keep earning và Claim dùng deferred CDP click để lấy baseline trước thao tác. Lượt quét trống không gọi API điểm, không chờ thời gian sau click. Giữ các bước giải quiz/poll và giới hạn thử lại thẻ hiện có.

Thêm 12 test cho API/JSON treo, timer cleanup, quét trống, retry đứng yên, cuộn có tiến triển, CDP Keep earning và toàn bộ phiên ACT rỗng kết thúc. Kiểm thử graph worker xác nhận tab đóng, `running/act = 0`, session được xóa và không polling điểm trên các lượt quét rỗng. Ở bản 6.0.3 đạt **396/396 test, 24/24 suite**, cú pháp **55 file** và lint đạt.

Chưa xác nhận request hoặc DOM đang kẹt trên profile Chrome thực tế. Các điểm treo trong mã đã được sửa và kiểm thử; log ACTIVITY của người dùng giúp xác định nếu còn lỗi khác.

## Bổ sung ở 6.0.2: Daily set và Start/Stop lúc ACT

Phần click Daily set nằm trong `createDashboardActivityScript()` ở `js/injected-scripts.js`, được worker gọi từ `runDashboardActivityPass()`. Nó kế thừa bản 4.0; bản 2.0 còn để scanner trực tiếp trong `service.js`. 6.0 sửa thêm phần nhận diện completed/locked, và chính phần sửa này tạo regression:

- Dò tối đa sáu cấp cha rồi tìm checkmark trong toàn bộ vùng chứa. Dấu tích của thẻ đã làm khiến thẻ bên cạnh chưa làm bị coi là hoàn thành.
- `className.includes('complete')` nhận nhầm cả `incomplete`.
- Luồng Keep earning còn match chuỗi `lock` quá rộng, có thể nhận nhầm class CSS như `block`.

Đã đưa nhận diện completed/locked về phạm vi thẻ/control như 4.0 và dùng token class rõ ràng. Giữ luồng trusted CDP click của Daily set.

Lỗi Daily set không trực tiếp chặn message Start/Stop. Tuy nhiên activity giữ `runtime.running = 1`, nên Start mới bị từ chối trong khi ACT còn chạy. Popup trước 6.0.2 khóa cả Perform lẫn hai nút Search/Schedule trong phiên manual activity, khiến người dùng không có Stop dùng được ở popup.

Bản 6.0.2 cho Perform chuyển thành Stop khi chạy riêng activity, lưu ID tab activity để Stop đóng đúng tab, và gắn activity cùng các pass/quiz/claim với session ban đầu. Sau Stop hoặc khi đã có phiên mới, activity cũ không được click tiếp hay ghi đè runtime của phiên mới. Trạng thái lỗi/activity cũng hiện trong Settings.

Bổ sung tám test: dấu tích thẻ bên cạnh, class incomplete, Keep earning không bị block nhầm, Stop của Perform, Stop đóng tab và Start lại, wait cũ hoàn tất sau Start mới, phản hồi Rewards đến muộn sau Stop, và Perform khi offline. Kết quả ở bản 6.0.2: **384/384 test đạt**. Các lỗi nhận diện/Stop ban đầu được tái hiện bằng test thực thi trước khi sửa.

Chưa xác nhận DOM hoặc log của tài khoản đang gặp lỗi ngoài Chrome thực tế. Nếu sau reload vẫn không click, cần dùng trạng thái/log ACTIVITY để phân biệt lỗi session Microsoft, không thấy heading/thẻ, hoặc attach debugger.

## Phạm vi đối chiếu

Đối chiếu cây mã của `Bing 2.0 goc`, `Bing 4.0 van` và `Bing 6.0`: manifest, popup/HTML/CSS, worker, content script, module cấu hình/lưu trữ, session, schedule, search, activity, cookie, debugger và catalog từ khóa. Thư viện đóng gói và catalog được kiểm tra theo cách chúng được nạp/sử dụng; không coi chạy test là kiểm toán mọi byte của thư viện minify. `Bing_Script` là ứng dụng riêng, ngoài phạm vi này.

Tên thư mục không khớp manifest ban đầu: 2.0 ghi `2.0`, 4.0 ghi `2.0.2`, 6.0 cũng ghi `2.0`. Bản sửa ghi `6.0.5` để nhận diện đúng sau khi reload.

## Khác biệt giữa ba bản

| Nội dung               | 2.0 gốc                                                | 4.0                                                                                     | 6.0 trước sửa / 6.0.5                                                                                                     |
| ---------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Tổ chức mã             | 10 file JS, phần lớn logic trong worker/popup.         | 28 file JS, tách cấu hình, session, search, activity, schedule và storage.              | Ban đầu 28 file JS, bản sửa có 29; worker kế thừa nhiều module 4.0, popup cũ giống 2.0. Bản sửa đồng bộ popup với worker. |
| Chrome tối thiểu       | 102.                                                   | 111.                                                                                    | 111.                                                                                                                      |
| Quyền host             | `<all_urls>`, content script quảng cáo trên mọi trang. | Giới hạn Bing và các host Microsoft được khai báo.                                      | Cùng nhóm host như 4.0, thêm quyền `webNavigation`; bản sửa không thêm quyền.                                             |
| Popup                  | Luồng consent/Pro/quảng cáo cũ.                        | Canonical defaults, mutation storage, phản hồi worker có timeout.                       | Còn kiểm tra consent/Pro, chờ quảng cáo, ghi cả config. Bản sửa dùng defaults/mutation/timeout, giữ preset 6.0.           |
| Đọc Rewards            | Luồng cũ trong worker.                                 | `rewards-client.js` đọc qua tab Rewards.                                                | Không có module đó; fetch Rewards API trong worker cho activity/score.                                                    |
| Daily search counter   | Luồng cũ.                                              | Kiểm tra counter và giảm kế hoạch khi daily quota hoàn tất.                             | Refresh counter bị vô hiệu hóa; chạy theo số lượt cấu hình. Giữ hành vi này trong bản sửa.                                |
| Xác nhận điểm mobile   | Không có module guard riêng như 4.0.                   | `mobile-credit.js` kiểm tra điểm thực tế.                                               | 6.0.5 ghi counter trước/sau mobile; giữ số lượt cấu hình. Gửi search không đồng nghĩa nhận điểm.                          |
| Retry khi startup      | Luồng cũ.                                              | `startup-retry.js` lưu trạng thái retry qua worker restart.                             | Module retry riêng bị bỏ. Báo lỗi khởi động rõ hơn, chưa khôi phục retry của 4.0.                                         |
| Cookie ở luồng tự động | Luồng clear cũ.                                        | Luồng tự động giữ dữ liệu xác thực.                                                     | Bản cũ backup/xóa/restore cookie; 6.0.4 giữ auth trong mọi clear tự động. Vẫn phục hồi snapshot cũ khi khởi động.         |
| Nhóm từ khóa           | anime, education, movie, music, random, tech, travel.  | finance, food, gaming, health, history, nature, random, science, sports, tech, vietnam. | Cùng bộ dữ liệu như 4.0; popup cũ còn một số nhóm 2.0. Bản sửa đồng bộ danh sách.                                         |

6.0 không được nâng cấp đồng nhất từ 4.0 ở mọi phần. Ghép popup cũ với worker mới tạo lỗi khởi chạy; một số lớp kiểm tra điểm và retry của 4.0 cũng đã bị bỏ. Kết luận này dựa trên mã nguồn hiện có.

## Vì sao Search/Start và Schedule không chạy

### Consent bị xóa nhưng nút vẫn yêu cầu

`applyConfigDefaults()` trong `js/utils.js` loại bỏ `control.consent` và `pro`. Worker áp dụng hàm này rồi lưu config. Popup cũ merge nông, thay toàn bộ `control`, nhưng handler Search/Schedule vẫn kiểm tra `config.control.consent`.

Khi trường này không còn, handler trả về trước khi gửi message. Consent form bị comment trong HTML, nên người dùng nhìn thấy nút nhưng không hoàn tất được nhánh đó. Đây là đường lỗi tái hiện được với config do worker lưu; phù hợp báo cáo chỉ 6.0 bị lỗi.

Bản sửa dùng `createDefaultConfig()`/`applyConfigDefaults()` và bỏ nhánh consent/Pro khỏi khởi chạy.

### Chờ mạng quảng cáo trước khi gắn handler

Popup cũ gọi `await handleAds()` trước khi đăng ký handler. Hàm này fetch cấu hình quảng cáo từ `buildwithkt.dev`; request không trả về khiến nút chưa được gắn sự kiện.

Bản sửa bỏ dependency này khỏi khởi tạo popup. Test giữ request quảng cáo không bao giờ hoàn tất vẫn bấm chạy được.

### Config và trạng thái chạy có thể bị ghi đè

Popup cũ ghi nguyên config đang giữ vào storage. Khi worker cập nhật session/progress, thao tác ở popup có thể ghi lại runtime cũ. Input cũng có thể chưa lưu nếu chưa phát sự kiện `change`.

Bản sửa áp dụng mutation vào config mới nhất qua `atomicUpdate()`. Bấm Search/Schedule đọc và lưu form hiện tại trước khi gửi message. Render UI không ghi lại config.

### Schedule đổi lịch dù worker từ chối lệnh

Worker cũ lưu kế hoạch và sửa alarm trước khi kiểm tra phiên đang chạy. Vì vậy lệnh Schedule bị từ chối vẫn làm đổi lịch.

Bản sửa đưa `RunCoordinator.canStartNewRun()` lên trước thay đổi config/alarm. Test xác nhận lệnh bị từ chối giữ nguyên lịch và phiên.

## Các thay đổi đã hoàn tất

- `js/popup.js`: đồng bộ defaults/message, lưu form lúc bấm, mutation storage, khóa click trùng, timeout 20 giây, xử lý lỗi/trạng thái worker. Stop chỉ hiện trên nút sở hữu phiên.
- `js/service.js`: kiểm tra Schedule trước khi sửa lịch; lưu trạng thái bắt đầu/chạy/dừng/lỗi/kết quả. Popup nhận được lỗi offline hoặc attach debugger sau khi worker đã nhận Start.
- `popup.html`, `css/popup.css`: thêm trạng thái dưới nút, đồng bộ niche/preset, bỏ setting backup Rewards login cũ; thêm nút tải/xóa crash log.
- `manifest.json`: phiên bản `6.0.5`.
- `eslint.config.js`: loại vendor bundle `js/stats.js` khỏi lint. Worker 6.0 không import bundle này; giữ nguyên nội dung minify.
- Xóa mã daily-counter không thể chạy sau `return` và nhánh kiểm tra giả `countersRefreshed = true`; ghi rõ hành vi configured count, giữ chính sách đếm lượt 6.0.
- Cập nhật README và bổ sung test thực thi luồng popup/worker.

`js/cookies.js`, `js/helper.js`, `js/jquery.js` đã có thay đổi EOL trước khi sửa; không bổ sung thay đổi chức năng vào chúng. Không sửa mã nguồn 2.0/4.0, không tạo commit hoặc push.

## Schedule sau bản sửa

Chọn mode chỉ lưu tần suất. Bấm **Schedule** chạy ngay phiên hiện tại; các lần tự động sau đó tùy mode:

| Mode                   | Hành vi                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------- |
| m1 — Manual Only       | Một lần khi bấm, không tự chạy lại.                                                |
| m2 — At Startup        | Chạy qua `runtime.onStartup`; daily-refresh alarm không kích hoạt chế độ này.      |
| m3 — Every ~5 Minutes  | Alarm sau 300–449 giây từ lúc kết thúc phiên; thất bại có thể kéo dài khoảng chờ.  |
| m4 — Every ~15 Minutes | Alarm sau 900–1049 giây từ lúc kết thúc phiên; thất bại có thể kéo dài khoảng chờ. |

Chrome phải đang chạy để alarm thực thi. Stop dừng phiên và giữ cấu hình tần suất; để ngừng tự chạy về sau, chuyển Manual Only và áp dụng bằng Schedule.

## Bằng chứng kiểm thử

| Kiểm tra                                         | Kết quả                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 4.0 trước sửa                                    | 389/389 test, 25/25 suite đạt.                                                                                                       |
| 6.0 ban đầu                                      | 336/350 test đạt; 14 test thất bại trong 3 suite. Một phần là fixture/assertion cũ không khớp 6.0, không tương đương 14 lỗi độc lập. |
| Nhóm regression popup ban đầu chạy trên popup cũ | 9/10 thất bại, tái hiện lỗi nút và các lỗi liên quan.                                                                                |
| 6.0.5, toàn bộ suite sau sửa                     | **410/410 test, 24/24 suite đạt**.                                                                                                   |
| Kiểm tra cú pháp                                 | **55 file đạt**.                                                                                                                     |
| `npm run lint`                                   | **Đạt**.                                                                                                                             |

`tests/popupRuntime.test.js` dùng HTML/jQuery đóng gói thực tế. Nó kiểm tra config bỏ consent/Pro, profile chưa có config, quảng cáo treo, input chưa phát `change`, mutation giữ runtime mới, lỗi/timeout, Stop theo mode và lỗi worker sau Start.

`tests/startCommands.test.js` cùng `tests/worker-harness.js` nạp graph module worker thực tế, giả lập Chrome API. Chúng kiểm tra Start/Schedule mở tab Bing, m2 startup, m3/m4 alarm, alarm đánh thức worker, session bị bỏ dở, lệnh trùng, offline và giữ số lượt cấu hình. Các test dừng trước search ra mạng, không kiểm chứng Bing cộng điểm.

Assertion cũ được cập nhật theo dữ liệu/hành vi 6.0: union niche gồm `queries_v1`, fixture cookie dùng cookie xác thực thay vì analytics, configured count và label Stop theo chủ phiên. Lỗi khởi chạy được bảo vệ thêm bằng test thực thi thay vì chỉ kiểm tra chuỗi nguồn.

## Xác nhận trên Chrome của người dùng

1. Mở `chrome://extensions`, reload đúng extension từ **Bing 6.0**, xác nhận **6.0.5**.
2. Mở lại popup, chọn `Desktop = 1`, `Mobile = 0`, bấm Search.
3. Xác nhận nút thành Stop, có trạng thái và tab Bing mở. Thử Schedule với Manual Only và cùng số lượt.
4. Để kiểm tra điểm/activity, đăng nhập Microsoft trên Bing/Rewards và xem dashboard.
5. Nếu lỗi, lấy thông báo dưới nút hoặc tải crash log trong Settings.

Chưa xác nhận chạy trực tiếp trên profile Chrome của người dùng. Chưa thay đổi cài đặt hoặc reload trình duyệt trong phiên sửa mã này. Kết quả đã xác nhận là mã sửa xong và các kiểm tra tự động đạt.
