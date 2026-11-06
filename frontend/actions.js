Object.assign(UI_TRANSLATIONS, {
  "课件文件保存在本机服务器，同一台电脑上的浏览器都可以下载。": ["تُحفظ ملفات الدروس على خدمة هذا الجهاز.", "Les fichiers de cours sont enregistrés sur cet ordinateur.", "Course files are stored on this computer."],
  "文件保存在本机服务器。": ["تُحفظ الملفات على هذا الجهاز.", "Les fichiers sont enregistrés sur cet ordinateur.", "Files are stored on this computer."],
  "服务会读取 TXT、CSV、Excel、Word、PDF 和图片，扫描件由本机文字识别处理，旧版 DOC / XLS 请先另存。": ["يقرأ TXT وCSV وExcel وWord وPDF والصور، ويتعرف على المسح محليًا.", "TXT, CSV, Excel, Word, PDF et images sont lus ; le scan est reconnu sur cet ordinateur.", "TXT, CSV, Excel, Word, PDFs, and images are read; scans are recognized on this computer."],
  "支持读取 DOCX、PDF、PPTX、TXT、Excel 和图片并自动分题；扫描件由本机文字识别处理。旧版 DOC、XLS、PPT 在安装 LibreOffice 后会自动转换，否则请另存。多选题请在答案里写两个以上字母。识别结果请教师核对。": ["يمكن قراءة DOCX وPDF وPPTX وTXT وExcel والصور وتقسيم الأسئلة.", "DOCX, PDF, PPTX, TXT, Excel et images sont lus et découpés.", "DOCX, PDF, PPTX, TXT, Excel, and images are read and split."],
  "修改密码": ["تغيير كلمة المرور", "Changer le mot de passe", "Change Password"],
  "当前密码": ["كلمة المرور الحالية", "Mot de passe actuel", "Current Password"],
  "新密码": ["كلمة المرور الجديدة", "Nouveau mot de passe", "New Password"],
  "示例名称": ["اسم تجريبي", "Nom d’exemple", "Sample Name"],
  "可下载": ["قابل للتنزيل", "Téléchargeable", "Downloadable"],
  "上传到本机": ["رفع إلى هذا الجهاز", "Envoyer sur cet ordinateur", "Upload to this computer"]
});

async function api(path, options = {}) {
  const opts = { credentials: "include", ...options };
  if (opts.body && typeof opts.body === "object" && !(opts.body instanceof FormData)) {
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    opts.body = JSON.stringify(opts.body);
  }
  let response;
  try {
    response = await fetch((window.YIZUOYE_API || "") + path, opts);
  } catch (error) {
    const failure = new Error("无法连接本机服务");
    failure.status = 0;
    throw failure;
  }
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch (error) { payload = { error: text.slice(0, 180) }; }
  }
  if (!response.ok) {
    const failure = new Error((payload && payload.error) || "请求失败");
    failure.status = response.status;
    throw failure;
  }
  return payload;
}

async function loadState() {
  const state = await api("/api/state");
  session = { role: state.role, account: state.account, name: state.name };
  role = state.role;
  data = state;
  return state;
}

function showLogin() {
  $("shell").style.display = "none";
  $("login").style.display = "grid";
  closeModal();
  translateLoginUI();
}

async function enterApp(loginReward) {
  await loadState();
  $("login").style.display = "none";
  $("shell").style.display = "block";
  page = "classrooms";
  currentClass = 0;
  render();
  if (loginReward) notify("每日首次登录，积分 +1");
}

async function login() {
  try {
    const result = await api("/api/auth/login", {
      method: "POST",
      body: {
        role,
        account: $("account").value.trim(),
        password: $("password").value,
        name: $("studentname").value.trim()
      }
    });
    await enterApp(result.loginReward);
  } catch (error) {
    notify(error.message || "登录失败");
  }
}

async function logout() {
  try { await api("/api/auth/logout", { method: "POST", body: {} }); } catch (error) { /* 本地退出仍要回到登录页 */ }
  showLogin();
}

async function addClass() {
  const name = $("cc").value.trim();
  const startDate = $("cs").value;
  const endDate = $("ce").value;
  if (!name || !startDate) return notify("请填写课程名称和开始日期");
  if (endDate && endDate < startDate) return notify("课程结束日期不能早于开始日期");
  try {
    await api("/api/classes", { method: "POST", body: { name, startDate, endDate } });
    await loadState();
    closeModal();
    render();
    notify("班级创建成功");
  } catch (error) { notify(error.message); }
}

async function saveCourseware() {
  const classId = $("coursewareClass").value;
  const mode = $("coursewareMode").value;
  const form = new FormData();
  form.append("mode", mode);
  try {
    if (mode === "file") {
      const files = [...$("coursewareFile").files];
      if (!files.length) return notify("请选择至少一个文件");
      files.forEach((file) => form.append("files", file));
    } else if (mode === "link") {
      const url = $("coursewareUrl").value.trim();
      if (!/^https?:\/\//i.test(url)) return notify("请输入有效的 http 或 https 链接");
      form.append("title", $("coursewareTitle").value.trim());
      form.append("url", url);
    } else {
      const body = $("coursewareBody").value.trim();
      if (!body) return notify("请输入分享内容");
      form.append("title", $("coursewareTextTitle").value.trim());
      form.append("body", body);
    }
    await api("/api/classes/" + classId + "/courseware", { method: "POST", body: form });
    await loadState();
    closeModal();
    render();
    notify("课件已分享到所选班级");
  } catch (error) { notify(error.message); }
}

function openCoursewareFile(id) {
  const link = document.createElement("a");
  link.href = (window.YIZUOYE_API || "") + "/api/files/" + encodeURIComponent(id);
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function confirmDeleteTeacherTask(id) {
  try {
    await api("/api/tasks/" + encodeURIComponent(id), { method: "DELETE" });
    await loadState();
    closeModal();
    render();
    notify("作业已成功删除");
  } catch (error) { notify(error.message); }
}

async function deleteTaskOriginal(taskId, fileId) {
  try {
    await api("/api/tasks/" + encodeURIComponent(taskId) + "/files/" + encodeURIComponent(fileId), { method: "DELETE" });
    await loadState();
    manageTaskOriginals(taskId);
    notify("原始文档已删除，在线题目和提交记录已保留");
  } catch (error) { notify(error.message); }
}

async function teacherTaskFilesChanged(input) {
  renderSelectedTaskFiles();
  const files = [...input.files];
  importedTaskTexts.clear();
  const status = $("teacherTaskStatus");
  if (!files.length) {
    if (status) status.textContent = "支持读取 DOCX、PDF、TXT、Excel 和图片并自动分题；扫描件由本机文字识别处理，旧版 DOC 请另存。识别结果请教师核对。";
    return;
  }
  if (status) status.textContent = "正在读取 " + files.length + " 份文件，请稍候……";
  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  try {
    const result = await api("/api/tasks/extract", { method: "POST", body: form });
    result.files.forEach((item) => { if (item.ok) importedTaskTexts.set(item.name, item.text); });
    if (status) status.textContent = result.summary;
  } catch (error) {
    if (status) status.textContent = error.message;
  }
}

async function recognizeTeacherQuestions() {
  const raw = mergedTeacherTaskText().trim();
  if (!raw) return notify("请先导入可读取的文件或粘贴题目文字");
  try {
    const result = await api("/api/tasks/recognize", { method: "POST", body: { raw } });
    $("sections").innerHTML = result.sections.map(smartQuestionEditor).join("");
    const status = $("teacherTaskStatus");
    if (status) status.textContent = result.summary;
  } catch (error) { notify(error.message); }
}

async function publishTask() {
  const cards = [...document.querySelectorAll("#sections > .field")];
  if (!cards.length) return notify("请至少保留一道题");
  const sections = cards.map((card, index) => ({
    title: card.querySelector(".st")?.value || ("题目" + (index + 1)),
    content: card.querySelector(".sc")?.value || "",
    type: card.querySelector(".qtype")?.value || "writing",
    options: [...card.querySelectorAll(".qoption")].map((input) => input.value.trim()).filter(Boolean),
    correct: card.querySelector(".qcorrect")?.value.trim() || "",
    audio: card.querySelector(".qaudio")?.value || ""
  }));
  const form = new FormData();
  form.append("title", $("smartTaskTitle")?.value.trim() || "课堂作业");
  form.append("week", $("taskweek").value);
  form.append("deadline", $("deadline").value);
  form.append("types", $("types").value);
  form.append("notes", $("notes").value);
  form.append("points", $("reward").value);
  form.append("sections", JSON.stringify(sections));
  [...($("teacherTaskFiles")?.files || [])].forEach((file) => form.append("files", file));
  cards.forEach((card, index) => {
    const audio = card.querySelector(".qaudiofile")?.files?.[0];
    if (audio) form.append("audio_" + index, audio);
  });
  try {
    await api("/api/classes/" + encodeURIComponent(currentClass) + "/tasks", { method: "POST", body: form });
    await loadState();
    closeModal();
    render();
    notify("作业发布成功");
  } catch (error) { notify(error.message); }
}

function editTask(id) {
  window.editingTaskId = id;
  newTask();
}

function fillTaskEditor(id) {
  const task = data.tasks.find((item) => String(item.id) === String(id));
  if (!task) return;
  $("modaltitle").textContent = "修改作业";
  if ($("smartTaskTitle")) $("smartTaskTitle").value = task.title || "";
  if ($("taskweek")) $("taskweek").value = String(task.week || 0);
  if ($("deadline")) $("deadline").value = task.deadline || "";
  if ($("types")) {
    const select = $("types");
    if (task.types && ![...select.options].some((option) => option.value === task.types)) {
      const option = document.createElement("option");
      option.value = task.types;
      option.textContent = task.types;
      select.appendChild(option);
    }
    select.value = task.types || "";
  }
  if ($("notes")) $("notes").value = task.notes || "";
  if ($("reward")) $("reward").value = task.points || 1;
  if ($("sections")) $("sections").innerHTML = (task.sections || []).map(smartQuestionEditor).join("");
  const button = document.querySelector("#modalbody button.primary");
  if (button) {
    button.textContent = "保存修改";
    button.dataset.taskId = String(id);
    button.setAttribute("onclick", "saveTaskEdit()");
  }
}

function taskForm() {
  const cards = [...document.querySelectorAll("#sections > .field")];
  const sections = cards.map((card, index) => ({
    title: card.querySelector(".st")?.value || ("题目" + (index + 1)),
    content: card.querySelector(".sc")?.value || "",
    type: card.querySelector(".qtype")?.value || "writing",
    options: [...card.querySelectorAll(".qoption")].map((input) => input.value.trim()).filter(Boolean),
    correct: card.querySelector(".qcorrect")?.value.trim() || "",
    audio: card.querySelector(".qaudio")?.value || ""
  }));
  const form = new FormData();
  form.append("title", $("smartTaskTitle")?.value.trim() || "课堂作业");
  form.append("week", $("taskweek").value);
  form.append("deadline", $("deadline").value);
  form.append("types", $("types").value);
  form.append("notes", $("notes").value);
  form.append("points", $("reward").value);
  form.append("sections", JSON.stringify(sections));
  cards.forEach((card, index) => {
    const audio = card.querySelector(".qaudiofile")?.files?.[0];
    if (audio) form.append("audio_" + index, audio);
  });
  return form;
}

async function saveTaskEdit() {
  const id = document.querySelector("#modalbody button.primary")?.dataset.taskId;
  if (!id) return notify("找不到要修改的作业");
  const cards = [...document.querySelectorAll("#sections > .field")];
  if (!cards.length) return notify("请至少保留一道题");
  try {
    await api("/api/tasks/" + encodeURIComponent(id), { method: "PUT", body: taskForm() });
    await loadState();
    closeModal();
    render();
    notify("作业已更新");
  } catch (error) { notify(error.message); }
}

async function doSubmit(taskId) {
  const task = data.tasks.find((item) => String(item.id) === String(taskId));
  if (!task) return notify("作业不存在");
  const cards = [...document.querySelectorAll(".smart-student-question")];
  const parts = [];
  const form = new FormData();
  for (let index = 0; index < cards.length; index++) {
    const card = cards[index];
    const question = task.sections[index] || {};
    const type = question.type || "writing";
    const filesInput = card.querySelector(".answer-file");
    const answer = type === "single"
      ? (card.querySelector("input[type=radio]:checked")?.value || "")
      : type === "multiple"
        ? [...card.querySelectorAll("input[type=checkbox]:checked")].map((input) => input.value).join("")
        : (card.querySelector(".answer-part")?.value.trim() || "");
    if (!answer && !filesInput?.files.length) return notify("请完成第" + (index + 1) + "题");
    parts.push({ answer });
    [...(filesInput?.files || [])].forEach((file) => form.append("file_" + index, file));
  }
  form.append("parts", JSON.stringify(parts));
  try {
    const result = await api("/api/tasks/" + encodeURIComponent(taskId) + "/submissions", { method: "POST", body: form });
    await loadState();
    closeModal();
    render();
    notify(result.message || "全部题目提交成功，积分+1");
  } catch (error) { notify(error.message); }
}

function editClass(id) {
  const course = data.classes.find((item) => String(item.id) === String(id));
  if (!course) return notify("班级不存在");
  openModal("修改班级", `<div class="field"><label>课程名称</label><input id="cc" value="${esc(course.name)}"></div><div class="row"><div class="field" style="flex:1;min-width:180px"><label>课程开始日期</label><input id="cs" type="date" value="${esc(course.startDate || "")}"></div><div class="field" style="flex:1;min-width:180px"><label>课程结束日期（选填）</label><input id="ce" type="date" value="${esc(course.endDate || "")}"></div></div><button class="primary" onclick="saveClass(${course.id})">保存班级</button>`);
}

async function saveClass(id) {
  try {
    await api("/api/classes/" + encodeURIComponent(id), { method: "PATCH", body: { name: $("cc").value, startDate: $("cs").value, endDate: $("ce").value } });
    await loadState();
    closeModal();
    render();
    notify("班级已更新");
  } catch (error) { notify(error.message); }
}

function deleteClassAsk(id) {
  const course = data.classes.find((item) => String(item.id) === String(id));
  if (!course) return notify("班级不存在");
  openModal("删除班级", `<p>确定删除 <strong>${esc(course.name)}</strong> 吗？这个班的作业、签到、课件和名单会一起删除。</p><div class="row" style="justify-content:flex-end;gap:12px"><button class="secondary" onclick="closeModal()">取消</button><button class="primary" style="background:#b42318;border-color:#b42318" onclick="confirmDeleteClass(${course.id})">确认删除</button></div>`);
}

async function confirmDeleteClass(id) {
  try {
    await api("/api/classes/" + encodeURIComponent(id), { method: "DELETE" });
    currentClass = 0;
    await loadState();
    closeModal();
    render();
    notify("班级已删除");
  } catch (error) { notify(error.message); }
}

function removeStudentAsk(account, name) {
  openModal("移出学生", `<p>确定把 ${esc(name)}（${esc(account)}）移出当前班级吗？账号仍保留，只是不再出现在这份名单里。</p><div class="row" style="justify-content:flex-end;gap:12px"><button class="secondary" onclick="closeModal()">取消</button><button class="primary" style="background:#b42318;border-color:#b42318" onclick="confirmRemoveStudent('${esc(account)}')">确认移出</button></div>`);
}

async function confirmRemoveStudent(account) {
  try {
    await api("/api/classes/" + encodeURIComponent(currentClass) + "/roster/" + encodeURIComponent(account), { method: "DELETE" });
    await loadState();
    closeModal();
    render();
    notify("已从名单移出");
  } catch (error) { notify(error.message); }
}

function resetStudentPasswordAsk(account) {
  openModal("重置学生密码", `<p class="muted">学号 ${esc(account)}</p><div class="field"><label>新密码</label><input id="studentNewPassword" value="123"></div><button class="primary" onclick="confirmResetStudentPassword('${esc(account)}')">保存新密码</button>`);
}

async function confirmResetStudentPassword(account) {
  try {
    await api("/api/classes/" + encodeURIComponent(currentClass) + "/roster/" + encodeURIComponent(account) + "/password", {
      method: "POST",
      body: { password: $("studentNewPassword").value }
    });
    closeModal();
    notify("学生密码已重置");
  } catch (error) { notify(error.message); }
}

function newNotice() {
  const options = data.classes.map((course) => `<option value="${esc(course.id)}">${esc(course.name)}</option>`).join("");
  openModal("发布通知", `<div class="field"><label>发送范围</label><select id="noticeClass"><option value="">全部班级</option>${options}</select></div><div class="field"><label>通知内容</label><textarea id="noticeBody" rows="4" placeholder="写给这个班或全部班级的通知"></textarea></div><button class="primary" onclick="publishNotice()">发布</button>`);
}

async function publishNotice() {
  const body = $("noticeBody")?.value.trim() || "";
  if (!body) return notify("请填写通知内容");
  try {
    await api("/api/notices", { method: "POST", body: { classId: $("noticeClass").value, body } });
    await loadState();
    closeModal();
    render();
    notify("通知已发布");
  } catch (error) { notify(error.message); }
}

const liveRecorders = new Map();

function stopAllRecordings() {
  for (const item of liveRecorders.values()) {
    try { item.rec.stop(); } catch { /* already stopped */ }
    item.stream.getTracks().forEach((track) => track.stop());
  }
  liveRecorders.clear();
}

async function toggleAnswerRecord(index) {
  const existing = liveRecorders.get(index);
  const button = document.getElementById("record-btn-" + index);
  if (existing) {
    existing.rec.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    return notify("当前浏览器不能录音，请改用附件上传");
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return notify("无法使用麦克风，请改用附件上传录音");
  }
  const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
  rec.onstop = () => {
    stream.getTracks().forEach((track) => track.stop());
    liveRecorders.delete(index);
    const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
    const ext = String(blob.type).includes("mp4") ? "m4a" : "webm";
    const file = new File([blob], "录音-第" + (index + 1) + "题." + ext, { type: blob.type || "audio/webm" });
    const input = document.getElementById("answer-file-" + index);
    if (input) {
      const transfer = new DataTransfer();
      [...input.files].forEach((item) => transfer.items.add(item));
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event("change"));
    }
    if (button) button.textContent = "录制本题语音";
    notify("录音已加入本题附件");
  };
  liveRecorders.set(index, { rec, stream });
  rec.start();
  if (button) button.textContent = "停止录音";
}

function review(taskId) {
  const task = data.tasks.find((item) => String(item.id) === String(taskId));
  const submissions = data.submissions.filter((item) => String(item.tid) === String(taskId));
  if (!submissions.length) return openModal("批改学生作业", "<p class=\"muted\">该作业暂无学生提交。</p>");
  const body = submissions.map((submission) => {
    const questions = (submission.parts || []).map((part, index) => {
      const question = task?.sections?.[index] || {};
      const files = (part.files || []).map((file) => `<button class="secondary" onclick="openCoursewareFile('${esc(file.id)}')">${esc(file.name)}</button>`).join(" ");
      return `<div class="item"><b>${esc(part.title || ("第" + (index + 1) + "题"))}</b><p>学生答案：${esc(part.answer || "（附件）")}</p>${question.correct ? `<p class="muted">参考答案：${esc(question.correct)}</p>` : ""}${files ? `<div class="row">${files}</div>` : ""}</div>`;
    }).join("");
    return `<div class="card" style="margin-bottom:12px"><p><b>${esc(submission.studentName)}</b> · ${esc(submission.studentId)}</p><p class="muted">状态：${esc(submission.status)}${submission.autoScore ? " · 客观题 " + esc(submission.autoScore) : ""}</p>${questions || `<p>${esc(submission.answer || "")}</p><p>附件：${esc(submission.file || "无")}</p>`}<textarea id="feedback-${esc(submission.studentId)}" placeholder="请输入批改意见">${esc(submission.feedback || "")}</textarea><button class="primary" onclick="confirmReview('${esc(String(taskId))}','${esc(submission.studentId)}')">确认批改并通知学生</button></div>`;
  }).join("");
  openModal("批改学生作业", `<p class="muted">客观题由服务器按参考答案自动计分，书写题和听力题请教师批改。</p>${body}`);
}

async function confirmReview(taskId, studentId) {
  try {
    await api("/api/tasks/" + encodeURIComponent(taskId) + "/review", {
      method: "POST",
      body: { studentId, feedback: $("feedback-" + studentId)?.value || "" }
    });
    await loadState();
    closeModal();
    render();
    notify("批改已确认");
  } catch (error) { notify(error.message); }
}

async function sendInlineMessage() {
  const body = $("inlineMsg")?.value.trim();
  if (!body) return notify("请输入留言内容");
  try {
    await api("/api/messages", { method: "POST", body: { body } });
    await loadState();
    render();
    notify("留言已发送");
  } catch (error) { notify(error.message); }
}

async function sendMessage() {
  const body = $("msg")?.value.trim();
  if (!body) return;
  try {
    await api("/api/messages", { method: "POST", body: { body } });
    await loadState();
    closeModal();
    notify("留言已发送");
  } catch (error) { notify(error.message); }
}

async function previewStudentFile() {
  const file = $("studentFile").files[0];
  if (!file) return;
  $("selectedStudentFile").textContent = file.name;
  const form = new FormData();
  form.append("file", file);
  try {
    const result = await api("/api/roster/parse", { method: "POST", body: form });
    if (result.text) $("studentsInput").value = result.text;
    $("importHint").textContent = result.message || ("已读取 " + file.name);
  } catch (error) {
    $("importHint").textContent = error.message;
  }
}

async function importStudents() {
  const text = $("studentsInput").value.trim();
  if (!text) return notify("请先选择可读取的文件或输入学生名单");
  try {
    const result = await api("/api/classes/" + encodeURIComponent(currentClass) + "/roster", { method: "POST", body: { text } });
    await loadState();
    closeModal();
    render();
    notify(result.message || "名单已导入");
  } catch (error) { notify(error.message); }
}

async function publishAttendance() {
  const start = $("attendanceStart").value;
  const end = $("attendanceEnd").value;
  if (!start || !end) return notify("请填写签到开始和结束时间");
  if (new Date(end) <= new Date(start)) return notify("结束时间必须晚于开始时间");
  try {
    await api("/api/attendance", { method: "POST", body: { classId: $("attendanceClass").value, start, end } });
    await loadState();
    render();
    notify("签到已发布到指定班级");
  } catch (error) { notify(error.message); }
}

async function releaseMakeup(id) {
  const start = $("makeupStart").value;
  const end = $("makeupEnd").value;
  if (!start || !end) return notify("请选择补签起止时间");
  if (new Date(end) <= new Date(start)) return notify("补签结束时间必须晚于开始时间");
  try {
    await api("/api/attendance/" + encodeURIComponent(id) + "/makeup-window", { method: "POST", body: { start, end } });
    await loadState();
    closeModal();
    render();
    notify("补签已发布，学生可在开放时段自行补签");
  } catch (error) { notify(error.message); }
}

async function studentCheckin(id, isMakeup, reason) {
  try {
    const result = await api("/api/attendance/" + encodeURIComponent(id) + "/checkin", {
      method: "POST",
      body: { makeup: Boolean(isMakeup), reason: reason || "" }
    });
    await loadState();
    closeModal();
    render();
    notify(result.message);
  } catch (error) { notify(error.message); }
}

async function redeem(id) {
  try {
    await api("/api/products/" + encodeURIComponent(id) + "/redeem", { method: "POST", body: {} });
    await loadState();
    render();
    notify("兑换成功！");
  } catch (error) { notify(error.message); }
}

async function addProduct() {
  const name = $("pn").value.trim();
  if (!name) return notify("请输入商品名称");
  try {
    await api("/api/products", {
      method: "POST",
      body: { name, cost: Number($("pc").value), stock: Number($("ps").value), emoji: $("pe").value }
    });
    await loadState();
    closeModal();
    render();
    notify("商品已上架");
  } catch (error) { notify(error.message); }
}

async function addResource() {
  const file = $("resource").files[0];
  if (!file) return notify("请选择文件");
  const form = new FormData();
  form.append("file", file);
  try {
    await api("/api/resources", { method: "POST", body: form });
    await loadState();
    closeModal();
    render();
    notify("资源已上传，可以下载");
  } catch (error) { notify(error.message); }
}

function resources() {
  const items = data.resources.map((item) => {
    const name = esc(item.name || item);
    const action = item.hasFile
      ? `<button class="secondary right" onclick="openCoursewareFile('${esc(item.fileId)}')">下载文件</button>`
      : `<span class="pill right">示例名称</span>`;
    return `<div class="item">📄 ${name} ${item.hasFile ? '<span class="pill">可下载</span>' : ""} ${action}</div>`;
  }).join("");
  const upload = role === "teacher"
    ? `<button class="primary" onclick="openModal('上传资源','<input id=resource type=file><p><button class=primary onclick=addResource()>上传到本机</button></p>')">＋ 上传资源</button>`
    : "";
  return banner("教学资源中心", "知识共享，让学习触手可及", "📚") + `<div class="card">${items}<p class="muted">带“可下载”标记的文件保存在本机，可以下载；没有文件的条目只是示例名称。</p>${upload}</div>`;
}

function account() {
  const teacher = role === "teacher";
  return banner("账号管理", "安全管理你的易作业账户", "⚙️") + `<div class="card"><h3>个人资料</h3><p>身份：${teacher ? "教师" : "学生"}</p><p>账号：${esc(session.account)}</p><p>姓名：${esc(session.name)}</p><p class="muted">演示账号初始密码为 123。可以在这里修改密码；教师可以重置本机示例数据。</p><div class="field"><label>当前密码</label><input id="oldpass" type="password" autocomplete="current-password"></div><div class="field"><label>新密码</label><input id="newpass" type="password" autocomplete="new-password"></div><button class="primary" onclick="changePassword()">修改密码</button>${teacher ? '<div style="height:16px"></div><button class="secondary" onclick="resetDemo()">重置演示数据</button>' : ""}</div>`;
}

async function changePassword() {
  try {
    await api("/api/account/password", { method: "POST", body: { oldPassword: $("oldpass").value, newPassword: $("newpass").value } });
    $("oldpass").value = "";
    $("newpass").value = "";
    notify("密码已更新");
  } catch (error) { notify(error.message); }
}

async function resetDemo() {
  if (!confirm("清除本机数据并恢复默认示例？已登录的学生需要重新登录。")) return;
  try {
    await api("/api/admin/reset", { method: "POST", body: {} });
    await loadState();
    page = "classrooms";
    currentClass = 0;
    render();
    notify("已重置演示数据");
  } catch (error) { notify(error.message); }
}

let authMode = "login";

function authCopy() {
  const lang = ($("loginLanguageSelect") && $("loginLanguageSelect").value) || "zh";
  const copy = {
    zh: { create: "注册新账号", back: "已有账号？返回登录", submit: "注册并进入 →", teacher: "教师姓名", student: "学生姓名" },
    en: { create: "Create an account", back: "Already registered? Sign in", submit: "Create and enter →", teacher: "Teacher name", student: "Student name" },
    fr: { create: "Créer un compte", back: "Déjà inscrit ? Se connecter", submit: "Créer et entrer →", teacher: "Nom de l’enseignant", student: "Nom de l’étudiant" },
    ar: { create: "إنشاء حساب", back: "لديك حساب؟ تسجيل الدخول", submit: "إنشاء والدخول →", teacher: "اسم المعلم", student: "اسم الطالب" }
  };
  return copy[lang] || copy.zh;
}

function syncAuthMode() {
  const register = authMode === "register";
  const copy = authCopy();
  const nameField = $("namefield");
  if (nameField) nameField.classList.toggle("hidden", !register && role !== "student");
  if (register && nameField) {
    const label = nameField.querySelector("label");
    if (label) label.textContent = role === "teacher" ? copy.teacher : copy.student;
  }
  const submit = $("submitAuth");
  const toggle = $("toggleAuth");
  if (submit && register) submit.textContent = copy.submit;
  if (toggle) toggle.textContent = register ? copy.back : copy.create;
}

function toggleAuthMode() {
  authMode = authMode === "login" ? "register" : "login";
  if (authMode === "register") {
    $("account").value = "";
    $("studentname").value = "";
    $("password").value = "";
  } else {
    $("studentname").value = "张三";
    $("password").value = "123";
    setRoleBase(role);
  }
  syncAuthMode();
}

async function submitAuth() {
  if (authMode === "register") return registerAccount();
  return login();
}

async function registerAccount() {
  try {
    const result = await api("/api/auth/register", {
      method: "POST",
      body: {
        role,
        account: $("account").value.trim(),
        password: $("password").value,
        name: $("studentname").value.trim()
      }
    });
    authMode = "login";
    await enterApp(result.loginReward);
  } catch (error) {
    notify(error.message || "注册失败");
  }
}

const translateLoginBase = translateLoginUI;
translateLoginUI = function () {
  translateLoginBase();
  syncAuthMode();
};
const setRoleBase = setRole;
setRole = function (next) {
  setRoleBase(next);
  syncAuthMode();
};

async function boot() {
  translateLoginUI();
  try {
    const me = await api("/api/auth/me");
    if (me?.user) await enterApp(false);
  } catch (error) {
    if (error.status !== 401) notify(error.message || "无法连接本机服务");
  }
}

boot();
