import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, verifyPassword } from './password.js';
import { HttpError } from './errors.js';
import { normalizeSections, parseRoster } from './parse.js';

export const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
export const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'yizuoye.sqlite'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL,
  account TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  last_login_reward TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  course TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  declared_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS roster (
  class_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  PRIMARY KEY (class_id, student_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  week INTEGER NOT NULL DEFAULT 0,
  sections_json TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 1,
  deadline TEXT,
  types TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  answer TEXT,
  parts_json TEXT NOT NULL,
  file_names TEXT,
  status TEXT NOT NULL,
  auto_score TEXT,
  feedback TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, student_id)
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  cost INTEGER NOT NULL,
  stock INTEGER NOT NULL,
  emoji TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS courseware (
  id TEXT PRIMARY KEY,
  class_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  url TEXT,
  body TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  makeup_start TEXT,
  makeup_end TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY,
  attendance_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(attendance_id, student_id)
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  user_id INTEGER,
  name TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`);

function nowIso() {
  return new Date().toISOString();
}

export function todayKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    throw error;
  }
}

function addNotice(body) {
  db.prepare('INSERT INTO notices(body, created_at) VALUES (?, ?)').run(body, nowIso());
}

function filePath(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  const full = path.resolve(uploadDir, id);
  const root = path.resolve(uploadDir) + path.sep;
  if (!full.startsWith(root)) return null;
  return full;
}

function unlinkStored(id) {
  const full = filePath(id);
  if (full) fs.rmSync(full, { force: true });
}

export function clearUploads() {
  if (!fs.existsSync(uploadDir)) return;
  for (const name of fs.readdirSync(uploadDir)) fs.rmSync(path.join(uploadDir, name), { force: true });
}

function insertFile({ kind, refId, userId, upload, name }) {
  const id = randomUUID();
  const destination = path.join(uploadDir, id);
  fs.renameSync(upload.path, destination);
  db.prepare(`INSERT INTO files(id, kind, ref_id, user_id, name, mime, size, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, kind, String(refId), userId || null, name, upload.mimetype || '', upload.size || 0, nowIso());
  return { id, name, size: upload.size || 0 };
}

function seedContent() {
  const created = nowIso();
  const teacherHash = hashPassword('123');
  const studentHash = hashPassword('123');
  db.prepare(`INSERT INTO users(role, account, name, password_hash, points, created_at)
    VALUES ('teacher', 'teacher', '演示教师', ?, 0, ?)`).run(teacherHash, created);
  db.prepare(`INSERT INTO users(role, account, name, password_hash, points, created_at)
    VALUES ('student', '2026001', '张三', ?, 16, ?)`).run(studentHash, created);
  db.prepare(`INSERT INTO classes(name, course, start_date, end_date, declared_count, created_at)
    VALUES ('HSK三级提高班', '综合汉语', '', '', 28, ?)`).run(created);
  db.prepare(`INSERT INTO classes(name, course, start_date, end_date, declared_count, created_at)
    VALUES ('汉语口语A班', '汉语口语', '', '', 22, ?)`).run(created);
  const sections = [
    { title: '任务一：自我介绍', content: '请用中文介绍你的大学和专业。', type: 'writing', options: [], correct: '', audio: '' },
    { title: '任务二：口语表达', content: '录制一段1分钟的中文音频。', type: 'writing', options: [], correct: '', audio: '' },
  ];
  db.prepare(`INSERT INTO tasks(class_id, title, week, sections_json, points, deadline, types, notes, created_at)
    VALUES (1, '第一周 · 我的大学生活', 0, ?, 5, '2026-12-15T23:59', '音频、文档', '注意语音和语法。', ?)`).run(JSON.stringify(sections), created);
  const products = [
    ['精美中文笔记本', 20, 12, '📓'],
    ['中国文化书签', 8, 30, '🔖'],
    ['熊猫小礼物', 35, 6, '🐼'],
  ];
  const insertProduct = db.prepare('INSERT INTO products(name, cost, stock, emoji) VALUES (?, ?, ?, ?)');
  for (const product of products) insertProduct.run(...product);
  const morning = new Date();
  morning.setHours(9, 30, 0, 0);
  db.prepare('INSERT INTO messages(name, body, created_at) VALUES (?, ?, ?)').run('张三', '老师，口语作业可以上传音频吗？', morning.toISOString());
  db.prepare('INSERT INTO notices(body, created_at) VALUES (?, ?)').run('第一周作业已发布，请按时完成。', created);
  db.prepare('INSERT INTO notices(body, created_at) VALUES (?, ?)').run('欢迎使用易作业！', created);
  const insertResource = db.prepare('INSERT INTO resources(name, created_at) VALUES (?, ?)');
  insertResource.run('HSK三级词汇表.pdf', created);
  insertResource.run('汉语口语练习材料.docx', created);
}

const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (!userCount) seedContent();

export function createSession(userId) {
  const token = randomUUID() + randomUUID().replace(/-/g, '');
  const created = new Date();
  const expires = new Date(created.getTime() + 7 * 24 * 3600 * 1000);
  db.prepare('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, created.toISOString(), expires.toISOString());
  return { token, maxAge: 7 * 24 * 3600 };
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}

export function userFromToken(token) {
  if (!token) return null;
  return db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?`).get(token, nowIso()) || null;
}

export function publicUser(user) {
  return { role: user.role, account: user.account, name: user.name };
}

export function login({ role, account, password, name }) {
  const normalizedRole = role === 'teacher' ? 'teacher' : role === 'student' ? 'student' : '';
  if (!normalizedRole) throw new HttpError(400, '请选择身份');
  const record = db.prepare('SELECT * FROM users WHERE account = ? AND role = ?').get(String(account || '').trim(), normalizedRole);
  if (!record || !verifyPassword(password, record.password_hash)) {
    throw new HttpError(401, normalizedRole === 'teacher' ? '账号或密码不正确' : '学号、姓名或密码不正确');
  }
  if (normalizedRole === 'student' && record.name !== String(name || '').trim()) {
    throw new HttpError(401, '学号、姓名或密码不正确');
  }
  let loginReward = false;
  if (normalizedRole === 'student') {
    const today = todayKey();
    if (record.last_login_reward !== today) {
      transaction(() => {
        const fresh = db.prepare('SELECT last_login_reward FROM users WHERE id=?').get(record.id);
        if (fresh.last_login_reward !== today) {
          db.prepare('UPDATE users SET points = points + 1, last_login_reward = ? WHERE id=?').run(today, record.id);
          addNotice('今日首次登录成功，获得1积分');
          loginReward = true;
        }
      });
    }
  }
  const session = createSession(record.id);
  return { token: session.token, maxAge: session.maxAge, loginReward, user: publicUser(record) };
}

export function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
}

export function createClass({ name, startDate, endDate }) {
  const course = String(name || '').trim();
  const start = String(startDate || '').trim();
  const end = String(endDate || '').trim();
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!course || !datePattern.test(start)) throw new HttpError(400, '请填写课程名称和开始日期');
  if (end && !datePattern.test(end)) throw new HttpError(400, '课程结束日期不正确');
  if (end && end < start) throw new HttpError(400, '课程结束日期不能早于开始日期');
  const result = db.prepare(`INSERT INTO classes(name, course, start_date, end_date, declared_count, created_at)
    VALUES (?, ?, ?, ?, 0, ?)`).run(course.slice(0, 80), course.slice(0, 80), start, end, nowIso());
  return Number(result.lastInsertRowid);
}

export function importRoster(classId, text) {
  const course = db.prepare('SELECT * FROM classes WHERE id=?').get(Number(classId));
  if (!course) throw new HttpError(404, '班级不存在');
  const rows = parseRoster(text);
  let added = 0;
  transaction(() => {
    for (const row of rows) {
      let student = db.prepare(`SELECT * FROM users WHERE account=?`).get(row.id);
      if (student && student.role !== 'student') continue;
      if (!student) {
        const result = db.prepare(`INSERT INTO users(role, account, name, password_hash, points, created_at)
          VALUES ('student', ?, ?, ?, 0, ?)`).run(row.id, row.name, hashPassword('123'), nowIso());
        student = { id: Number(result.lastInsertRowid) };
      }
      const linked = db.prepare('SELECT 1 AS ok FROM roster WHERE class_id=? AND student_id=?').get(course.id, student.id);
      if (!linked) {
        db.prepare('INSERT INTO roster(class_id, student_id) VALUES (?, ?)').run(course.id, student.id);
        added += 1;
      }
    }
    const rosterCount = db.prepare('SELECT COUNT(*) AS n FROM roster WHERE class_id=?').get(course.id).n;
    const declared = Math.max(course.declared_count || 0, rosterCount);
    db.prepare('UPDATE classes SET declared_count=? WHERE id=?').run(declared, course.id);
  });
  return { added, message: `已保存 ${added} 名学生名单，重复学号已跳过` };
}

export function createTask({ classId, title, week, sections, points, deadline, types, notes, uploads, names }) {
  const course = db.prepare('SELECT id FROM classes WHERE id=?').get(Number(classId));
  if (!course) throw new HttpError(404, '班级不存在');
  const normalized = normalizeSections(sections);
  const taskTitle = String(title || '').trim().slice(0, 120) || '课堂作业';
  let taskId = 0;
  transaction(() => {
    const result = db.prepare(`INSERT INTO tasks(class_id, title, week, sections_json, points, deadline, types, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      course.id,
      taskTitle,
      Number.isFinite(Number(week)) ? Number(week) : 0,
      JSON.stringify(normalized),
      Math.max(0, Number(points) || 0),
      String(deadline || ''),
      String(types || '').slice(0, 80),
      String(notes || '').slice(0, 4000),
      nowIso(),
    );
    taskId = Number(result.lastInsertRowid);
    (uploads || []).forEach((upload, index) => insertFile({
      kind: 'task',
      refId: taskId,
      upload,
      name: names[index] || originalFallback(upload),
    }));
    addNotice(`教师发布了新作业：${taskTitle}`);
  });
  return taskId;
}

function originalFallback(upload) {
  return upload.originalname || 'file';
}

export function deleteTask(taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(taskId));
  if (!task) throw new HttpError(404, '未找到该作业，请刷新页面后重试');
  transaction(() => {
    const submissions = db.prepare('SELECT id FROM submissions WHERE task_id=?').all(task.id);
    const fileRows = [
      ...db.prepare(`SELECT id FROM files WHERE kind='task' AND ref_id=?`).all(String(task.id)),
      ...submissions.flatMap((submission) => db.prepare(`SELECT id FROM files WHERE kind='submission' AND ref_id=?`).all(String(submission.id))),
    ];
    db.prepare(`DELETE FROM files WHERE kind='task' AND ref_id=?`).run(String(task.id));
    for (const submission of submissions) db.prepare(`DELETE FROM files WHERE kind='submission' AND ref_id=?`).run(String(submission.id));
    db.prepare('DELETE FROM submissions WHERE task_id=?').run(task.id);
    db.prepare('DELETE FROM tasks WHERE id=?').run(task.id);
    for (const file of fileRows) unlinkStored(file.id);
  });
}

export function deleteTaskFile(taskId, fileId) {
  const file = db.prepare(`SELECT * FROM files WHERE id=? AND kind='task' AND ref_id=?`).get(fileId, String(taskId));
  if (!file) throw new HttpError(404, '文件不存在');
  db.prepare('DELETE FROM files WHERE id=?').run(file.id);
  unlinkStored(file.id);
}

export function createSubmission({ taskId, student, parts, uploads }) {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(taskId));
  if (!task) throw new HttpError(404, '作业不存在');
  if (student.role !== 'student') throw new HttpError(403, '只有学生可以提交作业');
  const sections = JSON.parse(task.sections_json);
  const answers = Array.isArray(parts) ? parts : [];
  if (answers.length !== sections.length) throw new HttpError(400, '请完成全部题目');
  const grouped = new Map();
  for (const upload of uploads || []) {
    const matched = /^file_(\d+)$/.exec(upload.fieldname || '');
    if (!matched) continue;
    const index = Number(matched[1]);
    grouped.set(index, [...(grouped.get(index) || []), upload]);
  }
  const storedParts = sections.map((section, index) => {
    const answer = String(answers[index]?.answer || '').trim().slice(0, 20000);
    const files = grouped.get(index) || [];
    if (!answer && !files.length) throw new HttpError(400, `请完成第${index + 1}题`);
    return { title: section.title || `第${index + 1}题`, answer, files, pending: files };
  });
  let autoScore = '';
  transaction(() => {
    const existing = db.prepare('SELECT id FROM submissions WHERE task_id=? AND student_id=?').get(task.id, student.id);
    if (existing) throw new HttpError(400, '该作业已提交，请勿重复提交');
    const graded = grade(sections, storedParts);
    autoScore = graded.autoScore;
    const answerText = storedParts.map((part, index) => `第${index + 1}题：${part.answer || '（附件）'}`).join('\n');
    const result = db.prepare(`INSERT INTO submissions(task_id, student_id, answer, parts_json, file_names, status, auto_score, feedback, created_at)
      VALUES (?, ?, ?, '[]', '', '待批改', ?, '', ?)`).run(task.id, student.id, answerText, autoScore, nowIso());
    const submissionId = Number(result.lastInsertRowid);
    const finalParts = storedParts.map((part) => {
      const files = part.pending.map((upload) => insertFile({
        kind: 'submission',
        refId: submissionId,
        userId: student.id,
        upload,
        name: originalFallback(upload),
      }));
      return { title: part.title, answer: part.answer, files };
    });
    const fileNames = finalParts.flatMap((part) => part.files.map((file) => file.name)).join('、');
    db.prepare('UPDATE submissions SET parts_json=?, file_names=? WHERE id=?').run(JSON.stringify(finalParts), fileNames, submissionId);
    db.prepare('UPDATE users SET points = points + 1 WHERE id=?').run(student.id);
    addNotice('作业提交成功，获得1积分');
  });
  return { message: autoScore ? `全部题目提交成功，积分+1，客观题得分 ${autoScore}` : '全部题目提交成功，积分+1' };
}

function grade(sections, parts) {
  let correctCount = 0;
  let total = 0;
  let autoCount = 0;
  parts.forEach((part, index) => {
    const question = sections[index] || {};
    if (!question.correct) return;
    const type = question.type || 'writing';
    if (!['single', 'multiple', 'blank'].includes(type)) return;
    autoCount += 1;
    let expected = String(question.correct).replace(/\s/g, '').toUpperCase();
    let actual = String(part.answer || '').replace(/\s/g, '').toUpperCase();
    if (type === 'multiple') {
      expected = [...expected].sort().join('');
      actual = [...actual].sort().join('');
    }
    total += 1;
    if (expected === actual) correctCount += 1;
  });
  return { autoCount, autoScore: autoCount ? `${correctCount}/${total}` : '' };
}

export function reviewSubmission({ taskId, studentId, feedback }) {
  const student = db.prepare(`SELECT * FROM users WHERE account=? AND role='student'`).get(String(studentId || ''));
  if (!student) throw new HttpError(404, '未找到该学生的提交');
  const submission = db.prepare('SELECT * FROM submissions WHERE task_id=? AND student_id=?').get(Number(taskId), student.id);
  if (!submission) throw new HttpError(404, '该作业暂无学生提交。');
  db.prepare(`UPDATE submissions SET feedback=?, status='已批改' WHERE id=?`).run(String(feedback || '').slice(0, 4000), submission.id);
  addNotice('你的作业已批改，请查看教师反馈');
}

export function createCourseware({ classId, mode, title, url, body, uploads, names }) {
  const course = db.prepare('SELECT id FROM classes WHERE id=?').get(Number(classId));
  if (!course) throw new HttpError(404, '班级不存在');
  if (mode === 'file') {
    if (!uploads?.length) throw new HttpError(400, '请选择至少一个文件');
    transaction(() => {
      uploads.forEach((upload, index) => {
        const file = insertFile({ kind: 'courseware', refId: course.id, upload, name: names[index] || originalFallback(upload) });
        db.prepare(`INSERT INTO courseware(id, class_id, name, type, created_at) VALUES (?, ?, ?, 'file', ?)`)
          .run(file.id, course.id, file.name, nowIso());
        db.prepare(`UPDATE files SET ref_id=? WHERE id=?`).run(file.id, file.id);
      });
    });
    return;
  }
  if (mode === 'link') {
    const link = String(url || '').trim();
    if (!/^https?:\/\//i.test(link)) throw new HttpError(400, '请输入有效的 http 或 https 链接');
    const id = randomUUID();
    db.prepare(`INSERT INTO courseware(id, class_id, name, type, url, created_at) VALUES (?, ?, ?, 'link', ?, ?)`)
      .run(id, course.id, String(title || '').trim().slice(0, 200) || link, link.slice(0, 2000), nowIso());
    return;
  }
  const text = String(body || '').trim();
  if (!text) throw new HttpError(400, '请输入分享内容');
  const id = randomUUID();
  db.prepare(`INSERT INTO courseware(id, class_id, name, type, body, created_at) VALUES (?, ?, ?, 'text', ?, ?)`)
    .run(id, course.id, String(title || '').trim().slice(0, 200) || '文字资料', text.slice(0, 20000), nowIso());
}

export function addMessage(user, body) {
  const text = String(body || '').trim();
  if (!text) throw new HttpError(400, '请输入留言内容');
  db.prepare('INSERT INTO messages(name, body, created_at) VALUES (?, ?, ?)').run(user.name, text.slice(0, 2000), nowIso());
}

export function createAttendance({ classId, start, end }) {
  const course = db.prepare('SELECT id FROM classes WHERE id=?').get(Number(classId));
  if (!course) throw new HttpError(404, '班级不存在');
  if (!start || !end) throw new HttpError(400, '请填写签到开始和结束时间');
  if (new Date(end) <= new Date(start)) throw new HttpError(400, '结束时间必须晚于开始时间');
  const title = `课堂签到 · ${String(start).slice(0, 10)}`;
  db.prepare(`INSERT INTO attendance(class_id, title, start_at, end_at, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(course.id, title, start, end, nowIso());
}

export function setMakeupWindow(attendanceId, start, end) {
  const row = db.prepare('SELECT * FROM attendance WHERE id=?').get(Number(attendanceId));
  if (!row) throw new HttpError(404, '未找到该签到记录');
  if (!start || !end) throw new HttpError(400, '请选择补签起止时间');
  if (new Date(end) <= new Date(start)) throw new HttpError(400, '补签结束时间必须晚于开始时间');
  db.prepare('UPDATE attendance SET makeup_start=?, makeup_end=? WHERE id=?').run(start, end, row.id);
}

export function checkin({ attendanceId, student, makeup, reason }) {
  if (student.role !== 'student') throw new HttpError(403, '只有学生可以签到');
  const row = db.prepare('SELECT * FROM attendance WHERE id=?').get(Number(attendanceId));
  if (!row) throw new HttpError(404, '签到记录不存在');
  const existing = db.prepare('SELECT id FROM checkins WHERE attendance_id=? AND student_id=?').get(row.id, student.id);
  if (existing) throw new HttpError(400, '已经签到，无需重复操作');
  const now = new Date();
  const windowStart = makeup ? row.makeup_start : row.start_at;
  const windowEnd = makeup ? row.makeup_end : row.end_at;
  if (!windowStart || !windowEnd || now < new Date(windowStart) || now > new Date(windowEnd)) {
    throw new HttpError(400, '当前不在开放时间内');
  }
  const why = String(reason || '').trim();
  if (makeup && !why) throw new HttpError(400, '请填写补签原因');
  transaction(() => {
    const again = db.prepare('SELECT id FROM checkins WHERE attendance_id=? AND student_id=?').get(row.id, student.id);
    if (again) throw new HttpError(400, '已经签到，无需重复操作');
    db.prepare(`INSERT INTO checkins(attendance_id, student_id, kind, reason, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(row.id, student.id, makeup ? 'makeup' : 'normal', makeup ? why.slice(0, 500) : '', nowIso());
    db.prepare('UPDATE users SET points = points + 1 WHERE id=?').run(student.id);
    addNotice(`${makeup ? '补签' : '课堂签到'}完成，获得1积分`);
  });
  return { message: makeup ? '补签成功，积分 +1' : '签到成功，积分 +1' };
}

export function createProduct({ name, cost, stock, emoji }) {
  const title = String(name || '').trim();
  if (!title) throw new HttpError(400, '请输入商品名称');
  const price = Math.max(0, Math.round(Number(cost) || 0));
  const left = Math.max(0, Math.round(Number(stock) || 0));
  const icon = String(emoji || '🎁').slice(0, 8);
  db.prepare('INSERT INTO products(name, cost, stock, emoji) VALUES (?, ?, ?, ?)').run(title.slice(0, 80), price, left, icon);
}

export function redeemProduct(user, productId) {
  if (user.role !== 'student') throw new HttpError(403, '请使用学生账号兑换');
  transaction(() => {
    const product = db.prepare('SELECT * FROM products WHERE id=?').get(Number(productId));
    const fresh = db.prepare('SELECT points FROM users WHERE id=?').get(user.id);
    if (!product) throw new HttpError(404, '商品不存在');
    if (product.stock < 1 || fresh.points < product.cost) throw new HttpError(400, '积分或库存不足');
    const stock = db.prepare('UPDATE products SET stock = stock - 1 WHERE id=? AND stock > 0').run(product.id);
    const points = db.prepare('UPDATE users SET points = points - ? WHERE id=? AND points >= ?').run(product.cost, user.id, product.cost);
    if (!stock.changes || !points.changes) throw new HttpError(400, '积分或库存不足');
    addNotice(`你已成功兑换：${product.name}`);
  });
}

export function createResource(upload, name) {
  if (!upload) throw new HttpError(400, '请选择文件');
  transaction(() => {
    const result = db.prepare('INSERT INTO resources(name, created_at) VALUES (?, ?)').run(name || originalFallback(upload), nowIso());
    insertFile({ kind: 'resource', refId: Number(result.lastInsertRowid), upload, name: name || originalFallback(upload) });
  });
}

export function getDownload(user, fileId) {
  const file = db.prepare('SELECT * FROM files WHERE id=?').get(fileId);
  if (!file) throw new HttpError(404, '文件不存在或只是示例名称');
  if (file.kind === 'submission' && user.role !== 'teacher' && user.id !== file.user_id) {
    throw new HttpError(403, '只能下载自己的作业附件');
  }
  const full = filePath(file.id);
  if (!full || !fs.existsSync(full)) throw new HttpError(404, '文件未保存在本机服务器');
  return { file, full };
}

export function changePassword(user, oldPassword, newPassword) {
  const fresh = getUser(user.id);
  if (!verifyPassword(oldPassword, fresh.password_hash)) throw new HttpError(400, '当前密码不正确');
  if (!newPassword || String(newPassword).length < 3) throw new HttpError(400, '新密码至少 3 位');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(newPassword), user.id);
}

export function resetDemo(currentToken) {
  const uploads = fs.readdirSync(uploadDir);
  transaction(() => {
    for (const table of ['files', 'checkins', 'attendance', 'courseware', 'resources', 'notices', 'messages', 'products', 'submissions', 'tasks', 'roster', 'classes', 'sessions', 'users']) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    seedContent();
  });
  for (const name of uploads) fs.rmSync(path.join(uploadDir, name), { force: true });
  const teacher = db.prepare(`SELECT id FROM users WHERE account='teacher'`).get();
  if (currentToken && teacher) {
    const created = new Date();
    const expires = new Date(created.getTime() + 7 * 24 * 3600 * 1000);
    db.prepare('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(currentToken, teacher.id, created.toISOString(), expires.toISOString());
  }
}

export function discardUploads(uploads) {
  for (const upload of uploads || []) {
    if (upload?.path && fs.existsSync(upload.path)) fs.rmSync(upload.path, { force: true });
  }
}

export { db };
