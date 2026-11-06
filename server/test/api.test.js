import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { after, test } from 'node:test';
import ExcelJS from 'exceljs';
import { recognizeAssignment } from '../parse.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yizuoye-'));
process.env.DATA_DIR = dataDir;
process.env.YIZUOYE_RESET = '1';

let server;
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  const { closeStores } = await import('../db.js');
  await closeStores();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function pad(value) {
  return String(value).padStart(2, '0');
}

function localInput(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
    local.writeUInt16LE(0, 8);
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

function makePdf(text) {
  const content = `BT /F1 18 Tf 40 120 Td (${text}) Tj ET`;
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

function makeDocx(paragraphs) {
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

function client(base) {
  let cookie = '';
  return async function request(method, urlPath, { json, form } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let body;
    if (form) body = form;
    else if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const response = await fetch(base + urlPath, { method, headers, body });
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    for (const item of cookies) {
      const matched = /yz_session=([^;]*)/.exec(item);
      if (matched) cookie = matched[1] ? `yz_session=${matched[1]}` : '';
    }
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
    return { status: response.status, body: payload, headers: response.headers };
  };
}

function expect(response, status) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  return response.body;
}

test('题目识别按题号、选项和参考答案拆分', () => {
  const sections = recognizeAssignment(`1. 中国的首都是哪里？
A. 上海
B. 北京
C. 广州
D. 深圳

2. 请写一段自我介绍。

参考答案
1. B
`).sections;
  assert.equal(sections.length, 2);
  assert.equal(sections[0].type, 'single');
  assert.deepEqual(sections[0].options, ['上海', '北京', '广州', '深圳']);
  assert.equal(sections[0].correct, 'B');
  assert.equal(sections[1].type, 'writing');
  assert.equal(sections[1].correct, '');
});

test('多选题按多个选项字母识别', () => {
  const sections = recognizeAssignment(`1. 选出北方的城市（多选）
A. 北京
B. 上海
C. 哈尔滨
D. 广州

参考答案
1. A、C
`).sections;
  assert.equal(sections[0].type, 'multiple');
  assert.equal(sections[0].correct, 'AC');
});

test('同机 API 覆盖登录、作业、签到、积分和文件', async () => {
  const { createApp } = await import('../index.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const teacher = client(base);
  const zhang = client(base);
  const li = client(base);

  const health = expect(await teacher('GET', '/api/health'), 200);
  assert.equal(health.sqlite, true);
  assert.equal(health.ok, true);
  assert.match(health.ocr, /tesseract/);
  const page = await teacher('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /易作业/);
  assert.match(page.body, /注册新账号/);
  assert.match(page.body, /\/actions\.js/);
  expect(await teacher('GET', '/api/state'), 401);
  expect(await teacher('POST', '/api/auth/login', { json: { role: 'teacher', account: 'teacher', password: 'nope' } }), 401);

  const loggedIn = expect(await teacher('POST', '/api/auth/login', { json: { role: 'teacher', account: 'teacher', password: '123' } }), 200);
  assert.equal(loggedIn.user.role, 'teacher');
  const state = expect(await teacher('GET', '/api/state'), 200);
  assert.equal(state.classes.length, 2);
  assert.equal(state.classes[0].name, 'HSK三级提高班');
  assert.equal(state.classes[0].students, 28);
  assert.equal(state.notices[0], '欢迎使用易作业！');
  assert.equal(state.tasks[0].points, 1);
  assert.equal(state.resources.find((item) => item.name === 'HSK三级词汇表.pdf').hasFile, true);
  assert.equal(state.tasks[0].sections[0].correct, '');

  expect(await teacher('POST', '/api/auth/register', { json: { role: 'student', account: '2026888', name: '新同学', password: '12345' } }), 400);
  const newbie = client(base);
  const registered = expect(await newbie('POST', '/api/auth/register', { json: { role: 'student', account: '2026888', name: '新同学', password: 'secret1' } }), 200);
  assert.equal(registered.user.name, '新同学');
  assert.equal(registered.loginReward, true);
  assert.equal(expect(await newbie('GET', '/api/state'), 200).points, 1);
  expect(await teacher('POST', '/api/auth/register', { json: { role: 'teacher', account: '2026888', name: '重复', password: 'secret1' } }), 400);
  expect(await newbie('POST', '/api/auth/logout'), 200);

  expect(await teacher('POST', '/api/classes', { json: { name: '汉语写作班', startDate: '2026-11-06', endDate: '2026-11-01' } }), 400);
  expect(await teacher('POST', '/api/classes', { json: { name: '汉语写作班', startDate: '2026-11-06', endDate: '2027-01-20' } }), 200);
  const roster = expect(await teacher('POST', '/api/classes/1/roster', { json: { text: '学号,姓名\n2026002,李四\n2026002,李四\n2026003,王五' } }), 200);
  assert.equal(roster.added, 2);
  const again = expect(await teacher('POST', '/api/classes/1/roster', { json: { text: '2026002,李四' } }), 200);
  assert.equal(again.added, 0);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('名单');
  sheet.addRow(['学号', '姓名']);
  sheet.addRow(['2026004', '赵六']);
  const xlsx = await workbook.xlsx.writeBuffer();
  const rosterForm = new FormData();
  rosterForm.append('file', new Blob([xlsx], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), '名单.xlsx');
  const parsedRoster = expect(await teacher('POST', '/api/roster/parse', { form: rosterForm }), 200);
  assert.match(parsedRoster.text, /2026004/);
  assert.match(parsedRoster.text, /赵六/);

  const docxForm = new FormData();
  docxForm.append('files', new Blob([makeDocx(['1. 中国的首都是哪里？', 'A. 上海', 'B. 北京', '参考答案', '1. B'])], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }), '题目.docx');
  const extracted = expect(await teacher('POST', '/api/tasks/extract', { form: docxForm }), 200);
  assert.equal(extracted.files[0].ok, true);
  assert.match(extracted.files[0].text, /首都/);
  const recognized = expect(await teacher('POST', '/api/tasks/recognize', { json: { raw: extracted.files[0].text } }), 200);
  assert.equal(recognized.sections[0].correct, 'B');

  const pdfForm = new FormData();
  pdfForm.append('files', new Blob([makePdf('1. Hello Beijing')], { type: 'application/pdf' }), '阅读.pdf');
  const pdf = expect(await teacher('POST', '/api/tasks/extract', { form: pdfForm }), 200);
  assert.match(pdf.files[0].text, /Hello Beijing/);

  const slide = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>1. 中国的首都是北京</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:sld>`;
  const pptxForm = new FormData();
  pptxForm.append('files', new Blob([zipStore([['ppt/slides/slide1.xml', slide]])], {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }), '课件.pptx');
  const slides = expect(await teacher('POST', '/api/tasks/extract', { form: pptxForm }), 200);
  assert.match(slides.files[0].text, /首都是北京/);

  const image = fs.readFileSync(new URL('./fixtures/question.png', import.meta.url));
  const imageForm = new FormData();
  imageForm.append('files', new Blob([image], { type: 'image/png' }), 'question.png');
  const ocr = expect(await teacher('POST', '/api/tasks/extract', { form: imageForm }), 200);
  assert.equal(ocr.files[0].ok, true, JSON.stringify(ocr.files[0]));
  assert.match(ocr.files[0].text, /北京/);
  assert.match(ocr.files[0].text, /上海/);

  const taskForm = new FormData();
  taskForm.append('title', '首都测验');
  taskForm.append('week', '3');
  taskForm.append('deadline', '2026-12-20T23:59');
  taskForm.append('types', '文档');
  taskForm.append('notes', '认真作答');
  taskForm.append('points', '1');
  taskForm.append('sections', JSON.stringify([
    { title: '第1题', content: '中国的首都是哪里？', type: 'single', options: ['上海', '北京', '广州', '深圳'], correct: 'B', audio: '' },
    { title: '第2题', content: '听录音并填空 ____', type: 'blank', options: [], correct: '北京', audio: '' },
  ]));
  taskForm.append('files', new Blob(['原始题目'], { type: 'text/plain' }), '作业原文.txt');
  expect(await teacher('POST', '/api/classes/1/tasks', { form: taskForm }), 200);
  const taught = expect(await teacher('GET', '/api/state'), 200);
  const task = taught.tasks.find((item) => item.title === '首都测验');
  assert.equal(task.week, 3);
  assert.equal(task.sections[0].correct, 'B');
  assert.equal(task.attachments.length, 1);
  assert.equal(task.attachments[0].name, '作业原文.txt');
  const classOne = taught.classes.find((item) => item.id === 1);
  assert.equal(classOne.roster.length, 2);
  assert.equal(classOne.students, 2);
  expect(await teacher('POST', '/api/classes/1/roster/2026003/password', { json: { password: 'secret9' } }), 200);
  const wang = client(base);
  expect(await wang('POST', '/api/auth/login', { json: { role: 'student', account: '2026003', name: '王五', password: 'secret9' } }), 200);
  expect(await teacher('DELETE', '/api/classes/1/roster/2026003'), 200);
  const afterRemove = expect(await teacher('GET', '/api/state'), 200);
  const trimmed = afterRemove.classes.find((item) => item.id === 1);
  assert.equal(trimmed.roster.length, 1);
  assert.equal(trimmed.students, 1);
  expect(await teacher('POST', '/api/notices', { json: { classId: 1, body: '明天小测' } }), 200);
  expect(await teacher('PATCH', '/api/classes/3', { json: { name: '汉语写作提高班', startDate: '2026-11-06', endDate: '2027-01-20' } }), 200);

  expect(await teacher('POST', '/api/messages', { json: { body: '请按时完成首都测验。' } }), 200);
  expect(await teacher('POST', '/api/classes/1/courseware', { form: (() => {
    const form = new FormData();
    form.append('mode', 'text');
    form.append('title', '第三课补充');
    form.append('body', '今天练习首都和自我介绍。');
    return form;
  })() }), 200);
  const resourceForm = new FormData();
  resourceForm.append('file', new Blob(['词汇'], { type: 'text/plain' }), '词汇表.txt');
  expect(await teacher('POST', '/api/resources', { form: resourceForm }), 200);

  const now = new Date();
  const openStart = localInput(new Date(now.getTime() - 60 * 1000));
  const openEnd = localInput(new Date(now.getTime() + 30 * 60 * 1000));
  const closedStart = localInput(new Date(now.getTime() - 10 * 60 * 1000));
  const closedEnd = localInput(new Date(now.getTime() - 2 * 60 * 1000));
  expect(await teacher('POST', '/api/attendance', { json: { classId: 1, start: openStart, end: openEnd } }), 200);
  expect(await teacher('POST', '/api/attendance', { json: { classId: 1, start: closedStart, end: closedEnd } }), 200);
  const withAttendance = expect(await teacher('GET', '/api/state'), 200);
  const openAttendance = withAttendance.attendance.find((item) => item.end === openEnd);
  const closedAttendance = withAttendance.attendance.find((item) => item.end === closedEnd);
  const makeupStart = localInput(new Date(now.getTime() - 60 * 1000));
  const makeupEnd = localInput(new Date(now.getTime() + 20 * 60 * 1000));
  expect(await teacher('POST', `/api/attendance/${closedAttendance.id}/makeup-window`, { json: { start: makeupStart, end: makeupEnd } }), 200);

  const firstLogin = expect(await zhang('POST', '/api/auth/login', { json: { role: 'student', account: '2026001', name: '张三', password: '123' } }), 200);
  assert.equal(firstLogin.loginReward, true);
  const zhangState = expect(await zhang('GET', '/api/state'), 200);
  assert.equal(zhangState.points, 17);
  assert.equal('correct' in zhangState.tasks.find((item) => item.title === '首都测验').sections[0], false);
  expect(await zhang('POST', '/api/classes', { json: { name: '不该成功', startDate: '2026-11-06' } }), 403);
  expect(await zhang('POST', '/api/auth/logout'), 200);
  const secondLogin = expect(await zhang('POST', '/api/auth/login', { json: { role: 'student', account: '2026001', name: '张三', password: '123' } }), 200);
  assert.equal(secondLogin.loginReward, false);
  assert.equal(expect(await zhang('GET', '/api/state'), 200).points, 17);
  expect(await zhang('POST', '/api/auth/login', { json: { role: 'student', account: '2026001', name: '李四', password: '123' } }), 401);

  function submissionForm() {
    const form = new FormData();
    form.append('parts', JSON.stringify([{ answer: 'B' }, { answer: '北京' }]));
    form.append('file_1', new Blob(['口语录音说明'], { type: 'text/plain' }), '说明.txt');
    return form;
  }
  const submitted = expect(await zhang('POST', `/api/tasks/${task.id}/submissions`, { form: submissionForm() }), 200);
  assert.match(submitted.message, /客观题得分 2\/2/);
  assert.match(submitted.message, /积分\+1/);
  assert.equal(expect(await zhang('GET', '/api/state'), 200).points, 18);
  assert.equal(expect(await zhang('GET', '/api/state'), 200).notices.some((item) => item.includes('明天小测')), false);
  const revised = expect(await zhang('POST', `/api/tasks/${task.id}/submissions`, { form: submissionForm() }), 200);
  assert.match(revised.message, /不重复加分/);
  assert.equal(expect(await zhang('GET', '/api/state'), 200).points, 18);
  const lateForm = new FormData();
  lateForm.append('title', '已过期作业');
  lateForm.append('week', '1');
  lateForm.append('deadline', '2020-01-01T00:00');
  lateForm.append('types', '文档');
  lateForm.append('notes', '');
  lateForm.append('points', '1');
  lateForm.append('sections', JSON.stringify([{ title: '第1题', content: '写一句', type: 'writing', options: [], correct: '', audio: '' }]));
  expect(await teacher('POST', '/api/classes/1/tasks', { form: lateForm }), 200);
  const lateTask = expect(await teacher('GET', '/api/state'), 200).tasks.find((item) => item.title === '已过期作业');
  const lateAnswer = new FormData();
  lateAnswer.append('parts', JSON.stringify([{ answer: '来不及了' }]));
  expect(await zhang('POST', `/api/tasks/${lateTask.id}/submissions`, { form: lateAnswer }), 400);
  const checked = expect(await zhang('POST', `/api/attendance/${openAttendance.id}/checkin`, { json: { makeup: false } }), 200);
  assert.match(checked.message, /签到成功/);
  expect(await zhang('POST', `/api/attendance/${openAttendance.id}/checkin`, { json: { makeup: false } }), 400);
  expect(await zhang('POST', `/api/attendance/${closedAttendance.id}/checkin`, { json: { makeup: false } }), 400);
  expect(await zhang('POST', `/api/attendance/${closedAttendance.id}/checkin`, { json: { makeup: true, reason: '' } }), 400);
  const madeUp = expect(await zhang('POST', `/api/attendance/${closedAttendance.id}/checkin`, { json: { makeup: true, reason: '校车晚点' } }), 200);
  assert.match(madeUp.message, /补签成功/);
  assert.equal(expect(await zhang('GET', '/api/state'), 200).points, 20);

  const bookmark = zhangState.products.find((item) => item.name === '中国文化书签');
  expect(await zhang('POST', `/api/products/${bookmark.id}/redeem`, { json: {} }), 200);
  const afterRedeem = expect(await zhang('GET', '/api/state'), 200);
  assert.equal(afterRedeem.points, 12);
  assert.equal(afterRedeem.products.find((item) => item.id === bookmark.id).stock, 29);
  assert.equal(afterRedeem.submissions.length, 1);
  assert.equal(afterRedeem.courseware.some((item) => item.name === '第三课补充'), true);

  expect(await li('POST', '/api/auth/login', { json: { role: 'student', account: '2026002', name: '李四', password: '123' } }), 200);
  const liState = expect(await li('GET', '/api/state'), 200);
  assert.equal(liState.points, 1);
  assert.equal(liState.notices.some((item) => item.includes('明天小测')), true);
  assert.equal(liState.submissions.length, 0);
  assert.equal('correct' in liState.tasks.find((item) => item.title === '首都测验').sections[0], false);
  const secretFile = afterRedeem.submissions[0].parts[1].files[0].id;
  expect(await li('GET', `/api/files/${secretFile}`), 403);
  const ownFile = await zhang('GET', `/api/files/${secretFile}`);
  assert.equal(ownFile.status, 200);
  const encodedName = /filename\*=UTF-8''([^;]+)/.exec(ownFile.headers.get('content-disposition'))[1];
  assert.equal(decodeURIComponent(encodedName), '说明.txt');
  expect(await teacher('POST', `/api/tasks/${task.id}/review`, { json: { studentId: '2026001', feedback: '选择和填空都正确。' } }), 200);

  const reviewed = expect(await zhang('GET', '/api/state'), 200);
  assert.equal(reviewed.submissions[0].status, '已批改');
  assert.match(reviewed.submissions[0].feedback, /都正确/);
  const teacherView = expect(await teacher('GET', '/api/state'), 200);
  assert.equal(teacherView.submissions.length, 1);
  assert.equal(teacherView.attendance.find((item) => item.id === openAttendance.id).checkins[0], '2026001');
  assert.equal(teacherView.attendance.find((item) => item.id === closedAttendance.id).makeups[0].reason, '校车晚点');
  const download = await teacher('GET', `/api/files/${task.attachments[0].id}`);
  assert.equal(download.status, 200);
  assert.equal(download.body, '原始题目');
  expect(await teacher('GET', '/api/files/not-a-file'), 404);
  expect(await teacher('DELETE', `/api/tasks/${task.id}/files/${task.attachments[0].id}`), 200);
  assert.equal(expect(await teacher('GET', '/api/state'), 200).tasks.find((item) => item.id === task.id).attachments.length, 0);
  const edited = new FormData();
  edited.append('title', '首都测验（修订）');
  edited.append('week', '3');
  edited.append('deadline', '2026-12-21T23:59');
  edited.append('types', '文档');
  edited.append('notes', '已改截止时间');
  edited.append('points', '1');
  edited.append('sections', JSON.stringify([
    { title: '第1题', content: '中国的首都是哪里？', type: 'single', options: ['上海', '北京', '广州', '深圳'], correct: 'B', audio: '' },
    { title: '第2题', content: '听录音并填空 ____', type: 'blank', options: [], correct: '北京', audio: '' },
  ]));
  expect(await teacher('PUT', `/api/tasks/${task.id}`, { form: edited }), 200);
  const renamed = expect(await teacher('GET', '/api/state'), 200).tasks.find((item) => item.id === task.id);
  assert.equal(renamed.title, '首都测验（修订）');
  assert.equal(renamed.deadline, '2026-12-21T23:59');
  const writingClass = expect(await teacher('GET', '/api/state'), 200).classes.find((item) => item.name === '汉语写作提高班');
  expect(await teacher('DELETE', `/api/classes/${writingClass.id}`), 200);
  assert.equal(expect(await teacher('GET', '/api/state'), 200).classes.some((item) => item.id === writingClass.id), false);
  expect(await teacher('DELETE', `/api/tasks/${task.id}`), 200);
  assert.equal(expect(await teacher('GET', '/api/state'), 200).tasks.some((item) => item.id === task.id), false);
  assert.equal(expect(await zhang('GET', '/api/state'), 200).submissions.length, 0);

  expect(await teacher('POST', '/api/account/password', { json: { oldPassword: '123', newPassword: 'abc' } }), 200);
  expect(await teacher('POST', '/api/auth/login', { json: { role: 'teacher', account: 'teacher', password: '123' } }), 401);
  expect(await teacher('POST', '/api/admin/reset', { json: {} }), 200);
  const resetState = expect(await teacher('GET', '/api/state'), 200);
  assert.equal(resetState.classes.length, 2);
  assert.equal(resetState.classes[0].roster.length, 0);
  assert.equal(resetState.tasks.length, 1);
  expect(await li('GET', '/api/state'), 401);
  const restored = client(base);
  expect(await restored('POST', '/api/auth/login', { json: { role: 'teacher', account: 'teacher', password: '123' } }), 200);
  expect(await restored('POST', '/api/auth/login', { json: { role: 'student', account: '2026002', name: '李四', password: '123' } }), 401);
});
