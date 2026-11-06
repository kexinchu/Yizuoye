import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, verifyPassword } from './password.js';
import { HttpError } from './errors.js';
import { normalizeSections, parseRoster } from './parse.js';

export const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
export const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const SESSION_TTL = 7 * 24 * 3600;
const sqlite = new DatabaseSync(path.join(dataDir, 'yizuoye.sqlite'));
sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA busy_timeout = 5000');

const queryContext = new AsyncLocalStorage();
let queue = Promise.resolve();

function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

function adaptSql(sql) {
  const now = new Date().toISOString();
  const text = sql.replace(/\bNOW\(\)/gi, `'${now}'`).replace(/::(?:int|integer|bigint|text)\b/gi, '');
  const order = [];
  const rewritten = text.replace(/\$(\d+)/g, (_, index) => {
    order.push(Number(index) - 1);
    return '?';
  });
  return { sql: rewritten, order };
}

function bind(params, order) {
  return order.map((index) => (params[index] === undefined ? null : params[index]));
}

function qSync(text, params = []) {
  const { sql, order } = adaptSql(text);
  const values = bind(params, order);
  const statement = sqlite.prepare(sql);
  const readsRows = /^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql);
  try {
    if (readsRows) {
      const rows = statement.all(...values).map((row) => ({ ...row }));
      return { rows, rowCount: rows.length };
    }
    const result = statement.run(...values);
    return { rows: [], rowCount: Number(result.changes || 0) };
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE')) error.code = '23505';
    throw error;
  }
}

export function q(text, params = []) {
  if (queryContext.getStore()) return Promise.resolve(qSync(text, params));
  return enqueue(() => qSync(text, params));
}

export async function one(text, params = []) {
  const result = await q(text, params);
  return result.rows[0] || null;
}

export async function many(text, params = []) {
  const result = await q(text, params);
  return result.rows;
}

export function transaction(fn) {
  if (queryContext.getStore()) return fn();
  return enqueue(() => queryContext.run(true, async () => {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn();
      sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      try { sqlite.exec('ROLLBACK'); } catch { /* already closed */ }
      throw error;
    }
  }));
}

function adaptSchema(sql) {
  return sql
    .replace(/SERIAL PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT')
    .replace(/TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/g, "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  role TEXT NOT NULL,
  account TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  last_login_reward TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS classes (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  course TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  declared_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS roster (
  class_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  PRIMARY KEY (class_id, student_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  class_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  week INTEGER NOT NULL DEFAULT 0,
  sections_json TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 1,
  deadline TEXT,
  types TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS submissions (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  answer TEXT,
  parts_json TEXT NOT NULL,
  file_names TEXT,
  status TEXT NOT NULL,
  auto_score TEXT,
  feedback TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(task_id, student_id)
);
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  cost INTEGER NOT NULL,
  stock INTEGER NOT NULL,
  emoji TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS notices (
  id SERIAL PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS resources (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS courseware (
  id TEXT PRIMARY KEY,
  class_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  url TEXT,
  body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  class_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  makeup_start TEXT,
  makeup_end TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS checkins (
  id SERIAL PRIMARY KEY,
  attendance_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS files_kind_ref ON files(kind, ref_id);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
`;

export function todayKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function addNotice(body, classId = null) {
  await q('INSERT INTO notices(body, class_id, created_at) VALUES ($1, $2, NOW())', [body, classId]);
}

export async function postNotice({ classId, body }) {
  const text = String(body || '').trim();
  if (!text) throw new HttpError(400, '请填写通知内容');
  let courseId = null;
  if (classId) {
    const course = await one('SELECT id FROM classes WHERE id=$1', [Number(classId)]);
    if (!course) throw new HttpError(404, '班级不存在');
    courseId = course.id;
  }
  await addNotice(text.slice(0, 2000), courseId);
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

async function insertFile({ kind, refId, userId, upload, name }) {
  const id = randomUUID();
  const destination = path.join(uploadDir, id);
  fs.renameSync(upload.path, destination);
  try {
    await q(`INSERT INTO files(id, kind, ref_id, user_id, name, mime, size, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`, [
      id, kind, String(refId), userId || null, name, upload.mimetype || '', upload.size || 0,
    ]);
  } catch (error) {
    unlinkStored(id);
    throw error;
  }
  return { id, name, size: upload.size || 0 };
}

function zipStore(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name);
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const crc = crc32(content) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, content);
    central.push(centralHeader, nameBuf);
    offset += local.length + nameBuf.length + content.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

function miniPdf(text) {
  const content = `BT /F1 18 Tf 40 120 Td (${String(text).replace(/[()\\]/g, '')}) Tj ET`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += object;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (let index = 1; index <= 5; index += 1) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

function miniDocx(paragraphs) {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
${paragraphs.map((line) => `<w:p><w:r><w:t xml:space="preserve">${line}</w:t></w:r></w:p>`).join('')}
</w:body></w:document>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  return zipStore([
    ['[Content_Types].xml', types],
    ['_rels/.rels', rels],
    ['word/document.xml', document],
  ]);
}

async function storeNamedFile({ kind, refId, name, bytes, mime }) {
  const id = randomUUID();
  fs.writeFileSync(path.join(uploadDir, id), bytes);
  await q(`INSERT INTO files(id, kind, ref_id, user_id, name, mime, size, created_at)
    VALUES ($1, $2, $3, NULL, $4, $5, $6, NOW())`, [id, kind, String(refId), name, mime, bytes.length]);
  return id;
}

async function seedContent() {
  const teacherHash = hashPassword('123');
  const studentHash = hashPassword('123');
  await q(`INSERT INTO users(role, account, name, password_hash, points, created_at)
    VALUES ('teacher', 'teacher', '演示教师', $1, 0, NOW())`, [teacherHash]);
  await q(`INSERT INTO users(role, account, name, password_hash, points, created_at)
    VALUES ('student', '2026001', '张三', $1, 16, NOW())`, [studentHash]);
  await q(`INSERT INTO classes(name, course, start_date, end_date, declared_count, created_at)
    VALUES ('HSK三级提高班', '综合汉语', '', '', 28, NOW())`);
  await q(`INSERT INTO classes(name, course, start_date, end_date, declared_count, created_at)
    VALUES ('汉语口语A班', '汉语口语', '', '', 22, NOW())`);
  const sections = [
    { title: '任务一：自我介绍', content: '请用中文介绍你的大学和专业。', type: 'writing', options: [], correct: '', audio: '' },
    { title: '任务二：口语表达', content: '录制一段1分钟的中文音频。', type: 'writing', options: [], correct: '', audio: '' },
  ];
  await q(`INSERT INTO tasks(class_id, title, week, sections_json, points, deadline, types, notes, created_at)
    VALUES (1, '第一周 · 我的大学生活', 0, $1, 1, '2026-12-15T23:59', '音频、文档', '注意语音和语法。', NOW())`, [JSON.stringify(sections)]);
  const products = [
    ['精美中文笔记本', 20, 12, '📓'],
    ['中国文化书签', 8, 30, '🔖'],
    ['熊猫小礼物', 35, 6, '🐼'],
  ];
  for (const [name, cost, stock, emoji] of products) {
    await q('INSERT INTO products(name, cost, stock, emoji) VALUES ($1, $2, $3, $4)', [name, cost, stock, emoji]);
  }
  const morning = new Date();
  morning.setHours(9, 30, 0, 0);
  await q('INSERT INTO messages(name, body, created_at) VALUES ($1, $2, $3)', ['张三', '老师，口语作业可以上传音频吗？', morning.toISOString()]);
  await q('INSERT INTO notices(body, created_at) VALUES ($1, NOW())', ['第一周作业已发布，请按时完成。']);
  await q('INSERT INTO notices(body, created_at) VALUES ($1, NOW())', ['欢迎使用易作业！']);
  const vocabulary = await one('INSERT INTO resources(name, created_at) VALUES ($1, NOW()) RETURNING id', ['HSK三级词汇表.pdf']);
  await storeNamedFile({
    kind: 'resource',
    refId: vocabulary.id,
    name: 'HSK三级词汇表.pdf',
    bytes: miniPdf('HSK vocabulary'),
    mime: 'application/pdf',
  });
  const speaking = await one('INSERT INTO resources(name, created_at) VALUES ($1, NOW()) RETURNING id', ['汉语口语练习材料.docx']);
  await storeNamedFile({
    kind: 'resource',
    refId: speaking.id,
    name: '汉语口语练习材料.docx',
    bytes: miniDocx(['请用中文介绍你的大学和专业。']),
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

let starting;
export function ready() {
  if (!starting) {
    starting = migrateAndSeed().catch((error) => {
      starting = null;
      throw error;
    });
  }
  return starting;
}

function columnExists(table, name) {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name);
}

async function repairExistingData() {
  await q(`UPDATE tasks SET points=1 WHERE title=$1 AND points=5`, ['第一周 · 我的大学生活']);
  const missing = await many(`SELECT r.id, r.name FROM resources r
    LEFT JOIN files f ON f.kind='resource' AND f.ref_id = CAST(r.id AS TEXT)
    WHERE f.id IS NULL`);
  for (const row of missing) {
    if (row.name === 'HSK三级词汇表.pdf') {
      await storeNamedFile({ kind: 'resource', refId: row.id, name: row.name, bytes: miniPdf('HSK vocabulary'), mime: 'application/pdf' });
    } else if (row.name === '汉语口语练习材料.docx') {
      await storeNamedFile({
        kind: 'resource',
        refId: row.id,
        name: row.name,
        bytes: miniDocx(['请用中文介绍你的大学和专业。']),
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
    }
  }
}

async function migrateAndSeed() {
  sqlite.exec(adaptSchema(SCHEMA));
  if (!columnExists('notices', 'class_id')) sqlite.exec('ALTER TABLE notices ADD COLUMN class_id INTEGER');
  if (process.env.YIZUOYE_RESET === '1') {
    process.env.YIZUOYE_RESET = '0';
    await resetDemo(null);
    return;
  }
  const count = await one('SELECT COUNT(*) AS n FROM users');
  if (Number(count?.n || 0) === 0) await transaction(seedContent);
  await repairExistingData();
}

export async function closeStores() {
  try { sqlite.close(); } catch { /* already closed */ }
}

export async function createSession(userId) {
  const token = randomUUID() + randomUUID().replace(/-/g, '');
  const expires = new Date(Date.now() + SESSION_TTL * 1000).toISOString();
  await q('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES ($1, $2, NOW(), $3)', [token, userId, expires]);
  return { token, maxAge: SESSION_TTL };
}

export async function destroySession(token) {
  if (token) await q('DELETE FROM sessions WHERE token=$1', [token]);
}

export async function userFromToken(token) {
  if (!token) return null;
  const now = new Date().toISOString();
  await q('DELETE FROM sessions WHERE expires_at <= $1', [now]);
  return one('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token=$1', [token]);
}

export function publicUser(user) {
  return { role: user.role, account: user.account, name: user.name };
}

export async function register({ role, account, name, password }) {
  const normalizedRole = role === 'teacher' ? 'teacher' : role === 'student' ? 'student' : '';
  if (!normalizedRole) throw new HttpError(400, '请选择身份');
  const accountText = String(account || '').trim().slice(0, 40);
  const nameText = String(name || '').trim().slice(0, 40);
  const secret = String(password || '');
  if (!accountText || !nameText) throw new HttpError(400, '请填写账号和姓名');
  if (secret.length < 6) throw new HttpError(400, '新注册密码至少 6 位');
  const existing = await one('SELECT id FROM users WHERE account=$1', [accountText]);
  if (existing) throw new HttpError(400, '该账号已注册');
  try {
    await q(`INSERT INTO users(role, account, name, password_hash, points, created_at)
      VALUES ($1, $2, $3, $4, 0, NOW())`, [normalizedRole, accountText, nameText, hashPassword(secret)]);
  } catch (error) {
    if (error.code === '23505') throw new HttpError(400, '该账号已注册');
    throw error;
  }
  return login({ role: normalizedRole, account: accountText, password: secret, name: nameText });
}

export async function login({ role, account, password, name }) {
  const normalizedRole = role === 'teacher' ? 'teacher' : role === 'student' ? 'student' : '';
  if (!normalizedRole) throw new HttpError(400, '请选择身份');
  const record = await one('SELECT * FROM users WHERE account=$1 AND role=$2', [String(account || '').trim(), normalizedRole]);
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
      await transaction(async () => {
        const fresh = await one('SELECT last_login_reward FROM users WHERE id=$1', [record.id]);
        if (fresh.last_login_reward !== today) {
          await q('UPDATE users SET points = points + 1, last_login_reward=$1 WHERE id=$2', [today, record.id]);
          await addNotice('今日首次登录成功，获得1积分');
          loginReward = true;
        }
      });
    }
  }
  const session = await createSession(record.id);
  return { token: session.token, maxAge: session.maxAge, loginReward, user: publicUser(record) };
}

export async function getUser(id) {
  return one('SELECT * FROM users WHERE id=$1', [id]);
}

export async function createClass({ name, startDate, endDate }) {
  const course = String(name || '').trim();
  const start = String(startDate || '').trim();
  const end = String(endDate || '').trim();
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!course || !datePattern.test(start)) throw new HttpError(400, '请填写课程名称和开始日期');
  if (end && !datePattern.test(end)) throw new HttpError(400, '课程结束日期不正确');
  if (end && end < start) throw new HttpError(400, '课程结束日期不能早于开始日期');
  const row = await one(`INSERT INTO classes(name, course, start_date, end_date, declared_count, created_at)
    VALUES ($1, $2, $3, $4, 0, NOW()) RETURNING id`, [course.slice(0, 80), course.slice(0, 80), start, end]);
  return row.id;
}

export async function importRoster(classId, text) {
  const course = await one('SELECT * FROM classes WHERE id=$1', [Number(classId)]);
  if (!course) throw new HttpError(404, '班级不存在');
  const rows = parseRoster(text);
  let added = 0;
  await transaction(async () => {
    for (const row of rows) {
      let student = await one('SELECT * FROM users WHERE account=$1', [row.id]);
      if (student && student.role !== 'student') continue;
      if (!student) {
        try {
          student = await one(`INSERT INTO users(role, account, name, password_hash, points, created_at)
            VALUES ('student', $1, $2, $3, 0, NOW()) RETURNING id`, [row.id, row.name, hashPassword('123')]);
        } catch (error) {
          if (error.code !== '23505') throw error;
          student = await one('SELECT * FROM users WHERE account=$1', [row.id]);
          if (!student || student.role !== 'student') continue;
        }
      }
      const linked = await one('SELECT 1 AS ok FROM roster WHERE class_id=$1 AND student_id=$2', [course.id, student.id]);
      if (!linked) {
        await q('INSERT INTO roster(class_id, student_id) VALUES ($1, $2)', [course.id, student.id]);
        added += 1;
      }
    }
    const rosterCount = (await one('SELECT COUNT(*) AS n FROM roster WHERE class_id=$1', [course.id])).n;
    await q('UPDATE classes SET declared_count=$1 WHERE id=$2', [rosterCount, course.id]);
  });
  return { added, message: `已保存 ${added} 名学生名单，重复学号已跳过` };
}

export async function updateClass({ id, name, startDate, endDate }) {
  const course = await one('SELECT * FROM classes WHERE id=$1', [Number(id)]);
  if (!course) throw new HttpError(404, '班级不存在');
  const title = String(name || '').trim().slice(0, 80);
  if (!title) throw new HttpError(400, '请填写课程名称');
  const start = String(startDate || '').trim();
  const end = String(endDate || '').trim();
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (start && !datePattern.test(start)) throw new HttpError(400, '课程开始日期不正确');
  if (end && !datePattern.test(end)) throw new HttpError(400, '课程结束日期不正确');
  if (start && end && end < start) throw new HttpError(400, '课程结束日期不能早于开始日期');
  await q('UPDATE classes SET name=$1, course=$1, start_date=$2, end_date=$3 WHERE id=$4', [title, start, end, course.id]);
}

async function deleteStoredIds(rows) {
  for (const row of rows) unlinkStored(row.id);
}

export async function deleteClass(classId) {
  const course = await one('SELECT * FROM classes WHERE id=$1', [Number(classId)]);
  if (!course) throw new HttpError(404, '班级不存在');
  const removed = [];
  await transaction(async () => {
    const tasks = await many('SELECT id FROM tasks WHERE class_id=$1', [course.id]);
    const submissions = [];
    for (const task of tasks) submissions.push(...await many('SELECT id FROM submissions WHERE task_id=$1', [task.id]));
    const attendance = await many('SELECT id FROM attendance WHERE class_id=$1', [course.id]);
    removed.push(...await many(`SELECT id FROM files WHERE kind='courseware' AND ref_id=$1`, [String(course.id)]));
    for (const task of tasks) {
      removed.push(...await many(`SELECT id FROM files WHERE kind IN ('task','task-audio') AND ref_id=$1`, [String(task.id)]));
    }
    for (const submission of submissions) {
      removed.push(...await many(`SELECT id FROM files WHERE kind='submission' AND ref_id=$1`, [String(submission.id)]));
    }
    for (const row of attendance) await q('DELETE FROM checkins WHERE attendance_id=$1', [row.id]);
    for (const submission of submissions) await q(`DELETE FROM files WHERE kind='submission' AND ref_id=$1`, [String(submission.id)]);
    for (const task of tasks) {
      await q(`DELETE FROM files WHERE kind IN ('task','task-audio') AND ref_id=$1`, [String(task.id)]);
      await q('DELETE FROM submissions WHERE task_id=$1', [task.id]);
    }
    await q(`DELETE FROM files WHERE kind='courseware' AND ref_id=$1`, [String(course.id)]);
    await q('DELETE FROM tasks WHERE class_id=$1', [course.id]);
    await q('DELETE FROM courseware WHERE class_id=$1', [course.id]);
    await q('DELETE FROM attendance WHERE class_id=$1', [course.id]);
    await q('DELETE FROM roster WHERE class_id=$1', [course.id]);
    await q('DELETE FROM notices WHERE class_id=$1', [course.id]);
    await q('DELETE FROM classes WHERE id=$1', [course.id]);
  });
  await deleteStoredIds(removed);
}

export async function removeRosterStudent(classId, account) {
  const course = await one('SELECT * FROM classes WHERE id=$1', [Number(classId)]);
  if (!course) throw new HttpError(404, '班级不存在');
  const student = await one(`SELECT * FROM users WHERE account=$1 AND role='student'`, [String(account || '').trim()]);
  if (!student) throw new HttpError(404, '未找到该学生');
  const linked = await one('SELECT 1 AS ok FROM roster WHERE class_id=$1 AND student_id=$2', [course.id, student.id]);
  if (!linked) throw new HttpError(404, '该学生不在这个班级');
  await q('DELETE FROM roster WHERE class_id=$1 AND student_id=$2', [course.id, student.id]);
  const rosterCount = (await one('SELECT COUNT(*) AS n FROM roster WHERE class_id=$1', [course.id])).n;
  await q('UPDATE classes SET declared_count=$1 WHERE id=$2', [rosterCount, course.id]);
}

export async function resetStudentPassword(classId, account, password) {
  const course = await one('SELECT id FROM classes WHERE id=$1', [Number(classId)]);
  if (!course) throw new HttpError(404, '班级不存在');
  const student = await one(`SELECT * FROM users WHERE account=$1 AND role='student'`, [String(account || '').trim()]);
  if (!student) throw new HttpError(404, '未找到该学生');
  const linked = await one('SELECT 1 AS ok FROM roster WHERE class_id=$1 AND student_id=$2', [course.id, student.id]);
  if (!linked) throw new HttpError(404, '该学生不在这个班级');
  const next = String(password || '').trim();
  if (next.length < 3) throw new HttpError(400, '新密码至少 3 位');
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPassword(next), student.id]);
}

function originalFallback(upload) {
  return upload.originalname || 'file';
}

export async function createTask({ classId, title, week, sections, points, deadline, types, notes, uploads, names }) {
  const course = await one('SELECT id FROM classes WHERE id=$1', [Number(classId)]);
  if (!course) throw new HttpError(404, '班级不存在');
  const normalized = normalizeSections(sections);
  const taskTitle = String(title || '').trim().slice(0, 120) || '课堂作业';
  const stored = [];
  let taskId = 0;
  const originals = [];
  const audios = [];
  for (const upload of uploads || []) {
    if (/^audio_\d+$/.test(upload.fieldname || '')) audios.push(upload);
    else originals.push(upload);
  }
  try {
    await transaction(async () => {
      const row = await one(`INSERT INTO tasks(class_id, title, week, sections_json, points, deadline, types, notes, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) RETURNING id`, [
        course.id,
        taskTitle,
        Number.isFinite(Number(week)) ? Number(week) : 0,
        JSON.stringify(normalized),
        Math.max(1, Math.round(Number(points) || 1)),
        String(deadline || ''),
        String(types || '').slice(0, 80),
        String(notes || '').slice(0, 4000),
      ]);
      taskId = row.id;
      for (const [index, upload] of originals.entries()) {
        const file = await insertFile({
          kind: 'task',
          refId: taskId,
          upload,
          name: originalFallback(upload),
        });
        stored.push(file.id);
      }
      const audio = await attachSectionAudio(normalized, audios, taskId);
      stored.push(...audio.created);
      if (audio.created.length) await q('UPDATE tasks SET sections_json=$1 WHERE id=$2', [JSON.stringify(normalized), taskId]);
      await addNotice(`教师发布了新作业：${taskTitle}`);
    });
  } catch (error) {
    for (const id of stored) unlinkStored(id);
    throw error;
  }
  return taskId;
}

function taskFields({ title, week, sections, points, deadline, types, notes }) {
  return [
    String(title || '').trim().slice(0, 120) || '课堂作业',
    Number.isFinite(Number(week)) ? Number(week) : 0,
    Math.max(1, Math.round(Number(points) || 1)),
    String(deadline || ''),
    String(types || '').slice(0, 80),
    String(notes || '').slice(0, 4000),
    sections,
  ];
}

async function attachSectionAudio(sections, audios, taskId) {
  const created = [];
  const replaced = [];
  for (const upload of audios) {
    const index = Number(upload.fieldname.slice('audio_'.length));
    if (!sections[index]) continue;
    const previous = String(sections[index].audio || '');
    const oldId = previous.startsWith('/api/files/') ? previous.slice('/api/files/'.length) : '';
    const file = await insertFile({
      kind: 'task-audio',
      refId: taskId,
      upload,
      name: originalFallback(upload),
    });
    created.push(file.id);
    sections[index].audio = `/api/files/${file.id}`;
    if (oldId) {
      const old = await one(`SELECT id FROM files WHERE id=$1 AND kind='task-audio' AND ref_id=$2`, [oldId, String(taskId)]);
      if (old) {
        await q('DELETE FROM files WHERE id=$1', [old.id]);
        replaced.push(old.id);
      }
    }
  }
  return { created, replaced };
}

export async function updateTask({ taskId, title, week, sections, points, deadline, types, notes, uploads }) {
  const task = await one('SELECT * FROM tasks WHERE id=$1', [Number(taskId)]);
  if (!task) throw new HttpError(404, '未找到该作业，请刷新页面后重试');
  const normalized = normalizeSections(sections);
  const [taskTitle, weekNumber, reward, due, typeText, noteText] = taskFields({ title, week, points, deadline, types, notes, sections: normalized });
  const audios = (uploads || []).filter((upload) => /^audio_\d+$/.test(upload.fieldname || ''));
  let created = [];
  let replaced = [];
  try {
    await transaction(async () => {
      const audio = await attachSectionAudio(normalized, audios, task.id);
      created = audio.created;
      replaced = audio.replaced;
      await q(`UPDATE tasks SET title=$1, week=$2, sections_json=$3, points=$4, deadline=$5, types=$6, notes=$7 WHERE id=$8`, [
        taskTitle, weekNumber, JSON.stringify(normalized), reward, due, typeText, noteText, task.id,
      ]);
    });
  } catch (error) {
    for (const id of created) unlinkStored(id);
    throw error;
  }
  for (const id of replaced) unlinkStored(id);
}

export async function deleteTask(taskId) {
  const task = await one('SELECT * FROM tasks WHERE id=$1', [Number(taskId)]);
  if (!task) throw new HttpError(404, '未找到该作业，请刷新页面后重试');
  const removed = [];
  await transaction(async () => {
    const submissions = await many('SELECT id FROM submissions WHERE task_id=$1', [task.id]);
    const fileRows = [
      ...await many(`SELECT id FROM files WHERE kind IN ('task', 'task-audio') AND ref_id=$1`, [String(task.id)]),
      ...(await Promise.all(submissions.map((submission) => many(`SELECT id FROM files WHERE kind='submission' AND ref_id=$1`, [String(submission.id)])))).flat(),
    ];
    await q(`DELETE FROM files WHERE kind IN ('task', 'task-audio') AND ref_id=$1`, [String(task.id)]);
    for (const submission of submissions) await q(`DELETE FROM files WHERE kind='submission' AND ref_id=$1`, [String(submission.id)]);
    await q('DELETE FROM submissions WHERE task_id=$1', [task.id]);
    await q('DELETE FROM tasks WHERE id=$1', [task.id]);
    removed.push(...fileRows.map((file) => file.id));
  });
  for (const id of removed) unlinkStored(id);
}

export async function deleteTaskFile(taskId, fileId) {
  const file = await one(`SELECT * FROM files WHERE id=$1 AND kind='task' AND ref_id=$2`, [fileId, String(taskId)]);
  if (!file) throw new HttpError(404, '文件不存在');
  await q('DELETE FROM files WHERE id=$1', [file.id]);
  unlinkStored(file.id);
}

function pastDeadline(deadline) {
  const text = String(deadline || '').trim();
  if (!text) return false;
  const time = new Date(text).getTime();
  return Number.isFinite(time) && Date.now() > time;
}

function rewardPoints(task) {
  const points = Math.round(Number(task.points));
  return Number.isFinite(points) && points > 0 ? points : 1;
}

export async function createSubmission({ taskId, student, parts, uploads }) {
  const task = await one('SELECT * FROM tasks WHERE id=$1', [Number(taskId)]);
  if (!task) throw new HttpError(404, '作业不存在');
  if (student.role !== 'student') throw new HttpError(403, '只有学生可以提交作业');
  if (pastDeadline(task.deadline)) throw new HttpError(400, '已过截止时间，不能提交或修改');
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
    return { title: section.title || `第${index + 1}题`, answer, pending: files };
  });
  let autoScore = '';
  let replaced = false;
  const stored = [];
  const removed = [];
  const gained = rewardPoints(task);
  try {
    await transaction(async () => {
      const graded = grade(sections, storedParts);
      autoScore = graded.autoScore;
      const answerText = storedParts.map((part, index) => `第${index + 1}题：${part.answer || '（附件）'}`).join('\n');
      const existing = await one('SELECT id FROM submissions WHERE task_id=$1 AND student_id=$2', [task.id, student.id]);
      let submissionId = existing?.id;
      if (existing) {
        replaced = true;
        removed.push(...await many(`SELECT id FROM files WHERE kind='submission' AND ref_id=$1`, [String(existing.id)]));
        await q(`DELETE FROM files WHERE kind='submission' AND ref_id=$1`, [String(existing.id)]);
        await q(`UPDATE submissions SET answer=$1, parts_json='[]', file_names='', status='待批改', auto_score=$2, feedback='' WHERE id=$3`, [
          answerText, autoScore, existing.id,
        ]);
      } else {
        const row = await one(`INSERT INTO submissions(task_id, student_id, answer, parts_json, file_names, status, auto_score, feedback, created_at)
          VALUES ($1, $2, $3, '[]', '', '待批改', $4, '', NOW()) RETURNING id`, [task.id, student.id, answerText, autoScore]);
        submissionId = row.id;
      }
      const finalParts = [];
      for (const part of storedParts) {
        const files = [];
        for (const upload of part.pending) {
          const file = await insertFile({
            kind: 'submission',
            refId: submissionId,
            userId: student.id,
            upload,
            name: originalFallback(upload),
          });
          stored.push(file.id);
          files.push(file);
        }
        finalParts.push({ title: part.title, answer: part.answer, files });
      }
      const fileNames = finalParts.flatMap((part) => part.files.map((file) => file.name)).join('、');
      await q('UPDATE submissions SET parts_json=$1, file_names=$2 WHERE id=$3', [JSON.stringify(finalParts), fileNames, submissionId]);
      if (!replaced) {
        await q('UPDATE users SET points = points + $1 WHERE id=$2', [gained, student.id]);
        await addNotice(`作业提交成功，获得${gained}积分`);
      } else {
        await addNotice('作业已修改，请等待教师重新批改');
      }
    });
  } catch (error) {
    for (const id of stored) unlinkStored(id);
    if (error.code === '23505') throw new HttpError(400, '该作业已提交，请在截止前修改');
    throw error;
  }
  for (const row of removed) unlinkStored(row.id);
  const scoreText = autoScore ? `，客观题得分 ${autoScore}` : '';
  return {
    replaced,
    message: replaced ? `已更新提交，不重复加分${scoreText}` : `全部题目提交成功，积分+${gained}${scoreText}`,
  };
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

export async function reviewSubmission({ taskId, studentId, feedback }) {
  const student = await one(`SELECT * FROM users WHERE account=$1 AND role='student'`, [String(studentId || '')]);
  if (!student) throw new HttpError(404, '未找到该学生的提交');
  const submission = await one('SELECT * FROM submissions WHERE task_id=$1 AND student_id=$2', [Number(taskId), student.id]);
  if (!submission) throw new HttpError(404, '该作业暂无学生提交。');
  await q(`UPDATE submissions SET feedback=$1, status='已批改' WHERE id=$2`, [String(feedback || '').slice(0, 4000), submission.id]);
  await addNotice('你的作业已批改，请查看教师反馈');
}

export async function createCourseware({ classId, mode, title, url, body, uploads, names }) {
  const course = await one('SELECT id FROM classes WHERE id=$1', [Number(classId)]);
  if (!course) throw new HttpError(404, '班级不存在');
  if (mode === 'file') {
    if (!uploads?.length) throw new HttpError(400, '请选择至少一个文件');
    const stored = [];
    try {
      await transaction(async () => {
        for (const [index, upload] of uploads.entries()) {
          const file = await insertFile({ kind: 'courseware', refId: course.id, upload, name: names[index] || originalFallback(upload) });
          stored.push(file.id);
          await q(`INSERT INTO courseware(id, class_id, name, type, created_at) VALUES ($1, $2, $3, 'file', NOW())`, [file.id, course.id, file.name]);
          await q(`UPDATE files SET ref_id=$1 WHERE id=$2`, [file.id, file.id]);
        }
      });
    } catch (error) {
      for (const id of stored) unlinkStored(id);
      throw error;
    }
    return;
  }
  if (mode === 'link') {
    const link = String(url || '').trim();
    if (!/^https?:\/\//i.test(link)) throw new HttpError(400, '请输入有效的 http 或 https 链接');
    const id = randomUUID();
    await q(`INSERT INTO courseware(id, class_id, name, type, url, created_at) VALUES ($1, $2, $3, 'link', $4, NOW())`, [
      id, course.id, String(title || '').trim().slice(0, 200) || link, link.slice(0, 2000),
    ]);
    return;
  }
  const text = String(body || '').trim();
  if (!text) throw new HttpError(400, '请输入分享内容');
  const id = randomUUID();
  await q(`INSERT INTO courseware(id, class_id, name, type, body, created_at) VALUES ($1, $2, $3, 'text', $4, NOW())`, [
    id, course.id, String(title || '').trim().slice(0, 200) || '文字资料', text.slice(0, 20000),
  ]);
}

export async function addMessage(user, body) {
  const text = String(body || '').trim();
  if (!text) throw new HttpError(400, '请输入留言内容');
  await q('INSERT INTO messages(name, body, created_at) VALUES ($1, $2, NOW())', [user.name, text.slice(0, 2000)]);
}

export async function createAttendance({ classId, start, end }) {
  const course = await one('SELECT id FROM classes WHERE id=$1', [Number(classId)]);
  if (!course) throw new HttpError(404, '班级不存在');
  if (!start || !end) throw new HttpError(400, '请填写签到开始和结束时间');
  if (new Date(end) <= new Date(start)) throw new HttpError(400, '结束时间必须晚于开始时间');
  const title = `课堂签到 · ${String(start).slice(0, 10)}`;
  await q(`INSERT INTO attendance(class_id, title, start_at, end_at, created_at) VALUES ($1, $2, $3, $4, NOW())`, [course.id, title, start, end]);
}

export async function setMakeupWindow(attendanceId, start, end) {
  const row = await one('SELECT * FROM attendance WHERE id=$1', [Number(attendanceId)]);
  if (!row) throw new HttpError(404, '未找到该签到记录');
  if (!start || !end) throw new HttpError(400, '请选择补签起止时间');
  if (new Date(end) <= new Date(start)) throw new HttpError(400, '补签结束时间必须晚于开始时间');
  await q('UPDATE attendance SET makeup_start=$1, makeup_end=$2 WHERE id=$3', [start, end, row.id]);
}

export async function checkin({ attendanceId, student, makeup, reason }) {
  if (student.role !== 'student') throw new HttpError(403, '只有学生可以签到');
  const row = await one('SELECT * FROM attendance WHERE id=$1', [Number(attendanceId)]);
  if (!row) throw new HttpError(404, '签到记录不存在');
  const existing = await one('SELECT id FROM checkins WHERE attendance_id=$1 AND student_id=$2', [row.id, student.id]);
  if (existing) throw new HttpError(400, '已经签到，无需重复操作');
  const now = new Date();
  const windowStart = makeup ? row.makeup_start : row.start_at;
  const windowEnd = makeup ? row.makeup_end : row.end_at;
  if (!windowStart || !windowEnd || now < new Date(windowStart) || now > new Date(windowEnd)) {
    throw new HttpError(400, '当前不在开放时间内');
  }
  const why = String(reason || '').trim();
  if (makeup && !why) throw new HttpError(400, '请填写补签原因');
  await transaction(async () => {
    const again = await one('SELECT id FROM checkins WHERE attendance_id=$1 AND student_id=$2', [row.id, student.id]);
    if (again) throw new HttpError(400, '已经签到，无需重复操作');
    await q(`INSERT INTO checkins(attendance_id, student_id, kind, reason, created_at) VALUES ($1, $2, $3, $4, NOW())`, [
      row.id, student.id, makeup ? 'makeup' : 'normal', makeup ? why.slice(0, 500) : '',
    ]);
    await q('UPDATE users SET points = points + 1 WHERE id=$1', [student.id]);
    await addNotice(`${makeup ? '补签' : '课堂签到'}完成，获得1积分`);
  });
  return { message: makeup ? '补签成功，积分 +1' : '签到成功，积分 +1' };
}

export async function createProduct({ name, cost, stock, emoji }) {
  const title = String(name || '').trim();
  if (!title) throw new HttpError(400, '请输入商品名称');
  const price = Math.max(0, Math.round(Number(cost) || 0));
  const left = Math.max(0, Math.round(Number(stock) || 0));
  const icon = String(emoji || '🎁').slice(0, 8);
  await q('INSERT INTO products(name, cost, stock, emoji) VALUES ($1, $2, $3, $4)', [title.slice(0, 80), price, left, icon]);
}

export async function redeemProduct(user, productId) {
  if (user.role !== 'student') throw new HttpError(403, '请使用学生账号兑换');
  await transaction(async () => {
    const product = await one('SELECT * FROM products WHERE id=$1', [Number(productId)]);
    const fresh = await one('SELECT points FROM users WHERE id=$1', [user.id]);
    if (!product) throw new HttpError(404, '商品不存在');
    if (product.stock < 1 || fresh.points < product.cost) throw new HttpError(400, '积分或库存不足');
    const stock = await q('UPDATE products SET stock = stock - 1 WHERE id=$1 AND stock > 0', [product.id]);
    const points = await q('UPDATE users SET points = points - $1 WHERE id=$2 AND points >= $1', [product.cost, user.id]);
    if (!stock.rowCount || !points.rowCount) throw new HttpError(400, '积分或库存不足');
    await addNotice(`你已成功兑换：${product.name}`);
  });
}

export async function createResource(upload, name) {
  if (!upload) throw new HttpError(400, '请选择文件');
  const stored = [];
  try {
    await transaction(async () => {
      const row = await one('INSERT INTO resources(name, created_at) VALUES ($1, NOW()) RETURNING id', [name || originalFallback(upload)]);
      const file = await insertFile({ kind: 'resource', refId: row.id, upload, name: name || originalFallback(upload) });
      stored.push(file.id);
    });
  } catch (error) {
    for (const id of stored) unlinkStored(id);
    throw error;
  }
}

export async function getDownload(user, fileId) {
  const file = await one('SELECT * FROM files WHERE id=$1', [fileId]);
  if (!file) throw new HttpError(404, '文件不存在或只是示例名称');
  if (file.kind === 'submission' && user.role !== 'teacher' && user.id !== file.user_id) {
    throw new HttpError(403, '只能下载自己的作业附件');
  }
  const full = filePath(file.id);
  if (!full || !fs.existsSync(full)) throw new HttpError(404, '文件未保存在本机服务器');
  return { file, full };
}

export async function changePassword(user, oldPassword, newPassword) {
  const fresh = await getUser(user.id);
  if (!fresh || !verifyPassword(oldPassword, fresh.password_hash)) throw new HttpError(400, '当前密码不正确');
  if (!newPassword || String(newPassword).length < 3) throw new HttpError(400, '新密码至少 3 位');
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPassword(newPassword), user.id]);
}

export async function resetDemo(currentToken) {
  const uploads = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : [];
  await transaction(async () => {
    for (const table of ['files', 'checkins', 'attendance', 'courseware', 'resources', 'notices', 'messages', 'products', 'submissions', 'tasks', 'roster', 'classes', 'sessions', 'users']) {
      await q(`DELETE FROM ${table}`);
    }
    try { sqlite.exec('DELETE FROM sqlite_sequence'); } catch { /* no autoincrement rows yet */ }
    await seedContent();
    if (currentToken) {
      const teacher = await one(`SELECT id FROM users WHERE account='teacher'`);
      if (teacher) {
        const expires = new Date(Date.now() + SESSION_TTL * 1000).toISOString();
        await q('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES ($1, $2, NOW(), $3)', [currentToken, teacher.id, expires]);
      }
    }
  });
  for (const name of uploads) fs.rmSync(path.join(uploadDir, name), { force: true });
}

export function discardUploads(uploads) {
  for (const upload of uploads || []) {
    if (upload?.path && fs.existsSync(upload.path)) fs.rmSync(upload.path, { force: true });
  }
}
