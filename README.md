# 易作业

绿色教学平台的同机部署版本。原来的单个 HTML 预览页拆成了浏览器页面和本机 API：页面负责展示和操作，账号、班级、作业、签到、积分和课件写入 PostgreSQL，登录会话放在 Redis，上传文件留在本机磁盘。

## 启动

需要 Node.js 22、PostgreSQL、Redis，以及本机 OCR：Tesseract（`chi_sim` 和 `eng`）与 Poppler 的 `pdftoppm`。

```bash
# 若系统服务被策略拦住，可以直接拉起本机实例
sudo pg_ctlcluster 16 main start
redis-server --daemonize yes --bind 127.0.0.1 --port 6379 --protected-mode yes

npm install
npm start
```

默认连接：

- `DATABASE_URL=postgres://yizuoye:yizuoye@127.0.0.1:5432/yizuoye`
- `REDIS_URL=redis://127.0.0.1:6379/0`

浏览器打开 http://127.0.0.1:8080 。页面和 API 由同一个进程提供，默认只监听本机。数据库为空时会写入演示数据。

演示账号：

- 教师：`teacher` / `123`
- 学生：学号 `2026001`，姓名 `张三`，密码 `123`
- 教师导入的学生使用初始密码 `123`，登录时要填写名单上的学号和姓名
- 登录页可以注册新账号。新密码至少 6 位；学生注册后当天第一次进入仍加 1 分

上传文件在 `data/uploads/`。教师可以在「账号管理」里修改密码，或重置演示数据。不要在正式环境设置 `YIZUOYE_RESET=1`，那会清空当前库并重建演示数据。

让同一台电脑上的其他设备访问时：

```bash
HOST=0.0.0.0 npm start
```

演示密码是公开的，面向真实班级前请先修改密码。

## 目录

- `frontend/`：登录页、班级、作业、签到、积分和多语言界面
- `server/`：登录校验、业务规则、PostgreSQL、Redis 会话和文件解析
- `data/uploads/`：运行后保存的上传文件，不纳入版本库

前端通过 `/api` 访问后端。`frontend/config.js` 里的 `window.YIZUOYE_API` 默认为空，表示使用当前网站。如果页面和 API 分开到两个端口，把该值设成 API 地址，并在启动 API 时设置 `CORS_ORIGIN` 为页面地址。

## 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/auth/register` | 注册教师或学生，写入用户表并登录 |
| POST | `/api/auth/login` | 教师或学生登录，会话写入 Redis |
| POST | `/api/auth/logout` | 退出 |
| GET | `/api/auth/me` | 当前登录身份 |
| GET | `/api/state` | 当前用户可见的班级、作业、签到、积分和通知 |
| POST | `/api/classes` | 创建班级 |
| POST | `/api/classes/:id/roster` | 按「学号,姓名」导入名单 |
| POST | `/api/roster/parse` | 解析 TXT、CSV、Excel、Word、PDF 或图片名单 |
| POST | `/api/tasks/extract` | 提取作业原件中的文字；扫描件走本机 OCR |
| POST | `/api/tasks/recognize` | 按题号拆分题目、选项和参考答案 |
| POST | `/api/classes/:id/tasks` | 发布作业并保存原始文件 |
| DELETE | `/api/tasks/:id` | 删除作业及其提交 |
| POST | `/api/tasks/:id/submissions` | 学生提交答案；客观题在服务端计分 |
| POST | `/api/tasks/:id/review` | 教师批改 |
| POST | `/api/classes/:id/courseware` | 分享文件、链接或文字课件 |
| POST | `/api/attendance` | 发布签到 |
| POST | `/api/attendance/:id/checkin` | 学生签到或补签 |
| POST | `/api/products` | 上架积分商品 |
| POST | `/api/products/:id/redeem` | 学生兑换 |
| GET | `/api/files/:id` | 下载已登录用户有权访问的文件 |

学生请求作业时不会收到参考答案。每日首次登录、完成签到或补签、提交一次作业各加 1 分，规则在服务端执行。

文字型 PDF 直接抽字。抽不出文字的 PDF 和图片用本机 Tesseract（`chi_sim+eng`）识别，PDF 先由 `pdftoppm` 转成图片，最多 8 页。旧版 `.doc` 和 `.xls` 仍需另存为 `.docx`、`.xlsx` 或 CSV。课件里的 PPT 只保存原件，不自动拆题。

## 测试

```bash
npm test
```

测试使用数据库 `yizuoye_test` 和 Redis 的 1 号库，开始时会清空这两处并重建演示数据。正式库 `yizuoye` 不受影响。
