import { getUser, many } from './db.js';

function displayTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (date.toDateString() === new Date().toDateString()) return `今天 ${time}`;
  return `${date.toLocaleDateString('zh-CN')} ${time}`;
}

export async function buildState(user) {
  const fresh = await getUser(user.id) || user;
  const classes = [];
  for (const course of await many('SELECT * FROM classes ORDER BY id')) {
    const roster = (await many(`SELECT u.account AS id, u.name AS name
      FROM roster r JOIN users u ON u.id = r.student_id
      WHERE r.class_id = $1 ORDER BY u.account`, [course.id]))
      .map((row) => ({ id: row.id, name: row.name }));
    classes.push({
      id: course.id,
      name: course.name,
      course: course.course,
      students: Math.max(course.declared_count || 0, roster.length),
      startDate: course.start_date || '',
      endDate: course.end_date || '',
      roster,
    });
  }

  const tasks = [];
  for (const task of await many('SELECT * FROM tasks ORDER BY id')) {
    const sections = JSON.parse(task.sections_json).map((section) => {
      if (fresh.role === 'teacher') return section;
      const hidden = { ...section };
      delete hidden.correct;
      return hidden;
    });
    const attachments = await many(`SELECT id, name FROM files WHERE kind='task' AND ref_id=$1 ORDER BY created_at`, [String(task.id)]);
    tasks.push({
      id: task.id,
      cid: task.class_id,
      title: task.title,
      week: task.week || 0,
      sections,
      points: task.points,
      deadline: task.deadline || '',
      types: task.types || '',
      notes: task.notes || '',
      attachments,
    });
  }

  const submissionRows = fresh.role === 'teacher'
    ? await many(`SELECT s.*, u.account AS student_account, u.name AS student_name
      FROM submissions s JOIN users u ON u.id = s.student_id ORDER BY s.id`)
    : await many(`SELECT s.*, u.account AS student_account, u.name AS student_name
      FROM submissions s JOIN users u ON u.id = s.student_id WHERE s.student_id = $1 ORDER BY s.id`, [fresh.id]);
  const submissions = submissionRows.map((row) => ({
    tid: row.task_id,
    studentId: row.student_account,
    studentName: row.student_name,
    answer: row.answer || '',
    file: row.file_names || '',
    parts: JSON.parse(row.parts_json || '[]'),
    status: row.status,
    autoScore: row.auto_score || '',
    feedback: row.feedback || '',
  }));

  const attendance = [];
  for (const row of await many('SELECT * FROM attendance ORDER BY id DESC')) {
    const checks = await many(`SELECT c.kind, c.reason, c.created_at, u.account, u.name
      FROM checkins c JOIN users u ON u.id = c.student_id WHERE c.attendance_id=$1`, [row.id]);
    attendance.push({
      id: row.id,
      cid: row.class_id,
      title: row.title,
      start: row.start_at,
      end: row.end_at,
      time: displayTime(row.created_at),
      checkins: checks.filter((item) => item.kind === 'normal').map((item) => item.account),
      makeups: checks.filter((item) => item.kind === 'makeup').map((item) => ({
        studentId: item.account,
        studentName: item.name,
        reason: item.reason || '',
        submittedAt: item.created_at,
        source: 'student',
      })),
      makeupWindow: row.makeup_start ? { start: row.makeup_start, end: row.makeup_end } : null,
    });
  }

  return {
    role: fresh.role,
    account: fresh.account,
    name: fresh.name,
    classes,
    tasks,
    products: await many('SELECT id, name, cost, stock, emoji FROM products ORDER BY id'),
    messages: (await many('SELECT name, body, created_at FROM messages ORDER BY id DESC LIMIT 200'))
      .map((row) => ({ name: row.name, body: row.body, time: displayTime(row.created_at) })),
    notices: (await many('SELECT body FROM notices ORDER BY id DESC LIMIT 100')).map((row) => row.body),
    resources: (await many(`SELECT r.id, r.name, f.id AS file_id
      FROM resources r LEFT JOIN files f ON f.kind = 'resource' AND f.ref_id = r.id::text
      ORDER BY r.id`)).map((row) => ({
      id: row.id,
      name: row.name,
      hasFile: Boolean(row.file_id),
      fileId: row.file_id || '',
    })),
    submissions,
    points: fresh.role === 'student' ? fresh.points : 0,
    lastLoginReward: fresh.last_login_reward || '',
    attendance,
    courseware: (await many('SELECT * FROM courseware ORDER BY created_at DESC')).map((row) => ({
      id: row.id,
      cid: row.class_id,
      name: row.name,
      date: new Date(row.created_at).toLocaleDateString('zh-CN'),
      type: row.type,
      url: row.url || '',
      body: row.body || '',
    })),
  };
}
