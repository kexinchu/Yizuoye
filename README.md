# 易作业

绿色教学平台的同机部署版本。原来的单个 HTML 预览页拆成了浏览器页面和本机 API：页面负责展示和操作，班级、作业、签到、积分、课件和上传文件由本机服务保存。

## 启动

需要 Node.js 22.13 或更新版本。

```bash
npm install
npm start
```

浏览器打开 http://127.0.0.1:8080 。页面和 API 由同一个进程提供，默认只监听本机。

演示账号：

- 教师：`teacher` / `123`
- 学生：学号 `2026001`，姓名 `张三`，密码 `123`
- 教师导入的学生使用初始密码 `123`，登录时要填写名单上的学号和姓名

数据保存在项目下的 `data/`：SQLite 数据库是 `data/yizuoye.sqlite`，上传文件在 `data/uploads/`。教师可以在「账号管理」里修改密码，或重置演示数据。

让同一台电脑上的其他设备访问时：

```bash
HOST=0.0.0.0 npm start
```

演示密码是公开的，面向真实班级前请先修改密码。

## 目录

- `frontend/`：登录页、班级、作业、签到、积分和多语言界面
- `server/`：登录校验、业务规则、SQLite 和文件解析
- `data/`：运行后自动生成，不纳入版本库

前端通过 `/api` 访问后端。`frontend/config.js` 里的 `window.YIZUOYE_API` 默认为空，表示使用当前网站。如果页面和 API 分开到两个端口，把该值设成 API 地址，并在启动 API 时设置 `CORS_ORIGIN` 为页面地址。

## 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/auth/login` | 教师或学生登录，写入会话 Cookie |
| POST | `/api/auth/logout` | 退出 |
| GET | `/api/auth/me` | 当前登录身份 |
| GET | `/api/state` | 当前用户可见的班级、作业、签到、积分和通知 |
| POST | `/api/classes` | 创建班级 |
| POST | `/api/classes/:id/roster` | 按「学号,姓名」导入名单 |
| POST | `/api/roster/parse` | 解析 TXT、CSV、Excel、Word 或文字型 PDF 名单 |
| POST | `/api/tasks/extract` | 提取作业原件中的文字 |
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

扫描图片、旧版 `.doc` 和 `.xls` 不能自动识别。旧版 Excel 请另存为 `.xlsx` 或 CSV，旧版 Word 请另存为 `.docx`。

## 测试

```bash
npm test
```
