import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { HttpError } from './errors.js';
import { deployOcr, ocrStatus } from './ocr-deploy.js';
import { extractBuffer, originalName, recognizeAssignment } from './parse.js';
import { buildState } from './state.js';
import {
  addMessage,
  changePassword,
  checkin,
  createAttendance,
  createClass,
  createCourseware,
  createProduct,
  createResource,
  createSubmission,
  createTask,
  deleteTask,
  deleteTaskFile,
  destroySession,
  discardUploads,
  getDownload,
  importRoster,
  login,
  one,
  publicUser,
  ready,
  redeemProduct,
  register,
  resetDemo,
  reviewSubmission,
  setMakeupWindow,
  uploadDir,
  userFromToken,
} from './db.js';

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend');

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${randomUUID()}-tmp`),
  }),
  limits: { fileSize: 80 * 1024 * 1024, files: 20, fieldSize: 2 * 1024 * 1024 },
});

function uploadsOf(req) {
  if (Array.isArray(req?.files)) return req.files;
  if (req?.file) return [req.file];
  return [];
}

function route(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((error) => {
      discardUploads(uploadsOf(req));
      next(error);
    });
  };
}

function cookie(token, maxAge = 0) {
  const base = 'HttpOnly; Path=/; SameSite=Lax';
  if (!token) return `yz_session=; ${base}; Max-Age=0`;
  return `yz_session=${token}; ${base}; Max-Age=${maxAge}`;
}

function readCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === 'yz_session') return rest.join('=');
  }
  return '';
}

function requireUser(req, res, next) {
  userFromToken(readCookie(req)).then((user) => {
    if (!user) return res.status(401).json({ error: '请先登录' });
    req.user = user;
    next();
  }).catch(next);
}

function requireTeacher(req, res, next) {
  if (req.user?.role !== 'teacher') return res.status(403).json({ error: '只有教师可以执行此操作' });
  next();
}

async function textFromUpload(file) {
  const buffer = fs.readFileSync(file.path);
  const text = await extractBuffer(buffer, originalName(file), file.mimetype || '');
  if (!String(text || '').trim()) throw new HttpError(400, '没有提取到可识别文字');
  return text;
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (process.env.CORS_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    ready().then(() => next(), next);
  });

  app.get('/api/health', route(async (req, res) => {
    const row = await one('SELECT 1 AS ok');
    const sqliteOk = Number(row?.ok) === 1;
    const ocr = await ocrStatus();
    res.json({
      ok: sqliteOk,
      service: 'yizuoye',
      sqlite: sqliteOk,
      ocr: ocr.ready ? 'tesseract:chi_sim+eng' : 'missing',
    });
  }));

  app.post('/api/auth/register', route(async (req, res) => {
    const result = await register(req.body || {});
    res.setHeader('Set-Cookie', cookie(result.token, result.maxAge));
    res.json({ user: result.user, loginReward: result.loginReward });
  }));

  app.post('/api/auth/login', route(async (req, res) => {
    const result = await login(req.body || {});
    res.setHeader('Set-Cookie', cookie(result.token, result.maxAge));
    res.json({ user: result.user, loginReward: result.loginReward });
  }));

  app.post('/api/auth/logout', route(async (req, res) => {
    await destroySession(readCookie(req));
    res.setHeader('Set-Cookie', cookie(''));
    res.json({ ok: true });
  }));

  app.get('/api/auth/me', route(async (req, res) => {
    const user = await userFromToken(readCookie(req));
    res.json({ user: user ? publicUser(user) : null });
  }));

  app.get('/api/state', requireUser, route(async (req, res) => {
    res.json(await buildState(req.user));
  }));

  app.post('/api/classes', requireUser, requireTeacher, route(async (req, res) => {
    await createClass(req.body || {});
    res.json({ ok: true });
  }));

  app.post('/api/classes/:id/roster', requireUser, requireTeacher, route(async (req, res) => {
    const result = await importRoster(req.params.id, req.body?.text || '');
    res.json({ ok: true, ...result });
  }));

  app.post('/api/roster/parse', requireUser, requireTeacher, upload.single('file'), route(async (req, res) => {
    if (!req.file) throw new HttpError(400, '请选择名单文件');
    let text = '';
    try {
      text = await textFromUpload(req.file);
    } catch (error) {
      throw new HttpError(error.status || 400, error.message || '文件读取失败，请尝试手动粘贴名单。');
    }
    discardUploads(uploadsOf(req));
    res.json({ text, message: `已读取 ${originalName(req.file)}，请核对学号和姓名后确认导入。` });
  }));

  app.post('/api/tasks/extract', requireUser, requireTeacher, upload.array('files', 20), route(async (req, res) => {
    const files = uploadsOf(req);
    if (!files.length) throw new HttpError(400, '请选择至少一个文件');
    const results = [];
    const errors = [];
    for (const file of files) {
      try {
        const text = await textFromUpload(file);
        results.push({ name: originalName(file), key: `${originalName(file)}|${file.size}`, ok: true, text });
      } catch (error) {
        errors.push(`${originalName(file)}：${error.message}`);
        results.push({ name: originalName(file), ok: false, error: error.message });
      }
    }
    discardUploads(files);
    const ok = results.filter((item) => item.ok).length;
    let summary = `已读取 ${ok}/${files.length} 份文件。`;
    summary += errors.length
      ? ` 暂无法识别：${errors.join('；')}。可粘贴文字，或改用图片、DOCX、PDF、TXT、Excel。`
      : ' 点击「合并文档并自动分题」预览。';
    res.json({ files: results, summary });
  }));

  app.post('/api/tasks/recognize', requireUser, requireTeacher, route(async (req, res) => {
    res.json(recognizeAssignment(req.body?.raw || ''));
  }));

  app.post('/api/classes/:id/tasks', requireUser, requireTeacher, upload.array('files', 20), route(async (req, res) => {
    const files = uploadsOf(req);
    for (const file of files) file.originalname = originalName(file);
    await createTask({
      classId: req.params.id,
      title: req.body?.title,
      week: req.body?.week,
      sections: req.body?.sections,
      points: req.body?.points,
      deadline: req.body?.deadline,
      types: req.body?.types,
      notes: req.body?.notes,
      uploads: files,
      names: files.map((file) => file.originalname),
    });
    res.json({ ok: true });
  }));

  app.delete('/api/tasks/:id', requireUser, requireTeacher, route(async (req, res) => {
    await deleteTask(req.params.id);
    res.json({ ok: true });
  }));

  app.delete('/api/tasks/:id/files/:fileId', requireUser, requireTeacher, route(async (req, res) => {
    await deleteTaskFile(req.params.id, req.params.fileId);
    res.json({ ok: true });
  }));

  app.post('/api/tasks/:id/submissions', requireUser, upload.any(), route(async (req, res) => {
    const files = uploadsOf(req);
    for (const file of files) file.originalname = originalName(file);
    let parts = [];
    try { parts = JSON.parse(req.body?.parts || '[]'); } catch { throw new HttpError(400, '答案数据无法读取'); }
    const result = await createSubmission({ taskId: req.params.id, student: req.user, parts, uploads: files });
    res.json({ ok: true, ...result });
  }));

  app.post('/api/tasks/:id/review', requireUser, requireTeacher, route(async (req, res) => {
    await reviewSubmission({ taskId: req.params.id, studentId: req.body?.studentId, feedback: req.body?.feedback });
    res.json({ ok: true });
  }));

  app.post('/api/classes/:id/courseware', requireUser, requireTeacher, upload.array('files', 20), route(async (req, res) => {
    const files = uploadsOf(req);
    for (const file of files) file.originalname = originalName(file);
    await createCourseware({
      classId: req.params.id,
      mode: req.body?.mode,
      title: req.body?.title,
      url: req.body?.url,
      body: req.body?.body,
      uploads: files,
      names: files.map((file) => file.originalname),
    });
    res.json({ ok: true });
  }));

  app.post('/api/messages', requireUser, route(async (req, res) => {
    await addMessage(req.user, req.body?.body);
    res.json({ ok: true });
  }));

  app.post('/api/attendance', requireUser, requireTeacher, route(async (req, res) => {
    await createAttendance({ classId: req.body?.classId, start: req.body?.start, end: req.body?.end });
    res.json({ ok: true });
  }));

  app.post('/api/attendance/:id/makeup-window', requireUser, requireTeacher, route(async (req, res) => {
    await setMakeupWindow(req.params.id, req.body?.start, req.body?.end);
    res.json({ ok: true });
  }));

  app.post('/api/attendance/:id/checkin', requireUser, route(async (req, res) => {
    const result = await checkin({
      attendanceId: req.params.id,
      student: req.user,
      makeup: Boolean(req.body?.makeup),
      reason: req.body?.reason,
    });
    res.json({ ok: true, ...result });
  }));

  app.post('/api/products', requireUser, requireTeacher, route(async (req, res) => {
    await createProduct(req.body || {});
    res.json({ ok: true });
  }));

  app.post('/api/products/:id/redeem', requireUser, route(async (req, res) => {
    await redeemProduct(req.user, req.params.id);
    res.json({ ok: true });
  }));

  app.post('/api/resources', requireUser, requireTeacher, upload.single('file'), route(async (req, res) => {
    if (req.file) req.file.originalname = originalName(req.file);
    await createResource(req.file, req.file ? req.file.originalname : '');
    res.json({ ok: true });
  }));

  app.get('/api/files/:id', requireUser, route(async (req, res) => {
    const { file, full } = await getDownload(req.user, req.params.id);
    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.sendFile(full);
  }));

  app.post('/api/account/password', requireUser, route(async (req, res) => {
    await changePassword(req.user, req.body?.oldPassword, req.body?.newPassword);
    res.json({ ok: true });
  }));

  app.post('/api/admin/reset', requireUser, requireTeacher, route(async (req, res) => {
    await resetDemo(readCookie(req));
    res.json({ ok: true });
  }));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });
  app.use(express.static(frontendDir));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    discardUploads(uploadsOf(req));
    if (error?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '单个文件不能超过 80MB' });
    if (error?.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: '一次最多上传 20 个文件' });
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    if (error?.code === '23505' || /duplicate key|UNIQUE constraint/i.test(String(error?.message || ''))) return res.status(400).json({ error: '请勿重复操作' });
    console.error(error);
    res.status(500).json({ error: '服务器处理失败' });
  });
  return app;
}

export async function start(port = Number(process.env.PORT || 8080), host = process.env.HOST || '127.0.0.1') {
  await deployOcr();
  await ready();
  const server = createApp().listen(port, host, () => {
    const address = server.address();
    const shownHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    console.log(`易作业已启动：http://${shownHost}:${address.port}`);
  });
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
