import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { HttpError } from './errors.js';

const execFileAsync = promisify(execFile);

export function decodeText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buffer).replace(/^\uFEFF/, '');
    } catch {
      return new TextDecoder('utf-8').decode(buffer).replace(/^\uFEFF/, '');
    }
  }
}

export function originalName(file) {
  const name = file?.originalname || 'file';
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('latin1') === name) return decoded;
  } catch {
    /* keep the name multer already decoded */
  }
  return name;
}

function cellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
    if (value.text != null) return String(value.text);
    if (value.result != null) return String(value.result);
    if (value.hyperlink && value.text) return String(value.text);
  }
  return String(value).trim();
}

async function extractPdf(buffer) {
  const task = getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const lines = [];
      let lastY = null;
      let buf = '';
      for (const item of content.items) {
        const y = item.transform?.[5];
        if (lastY !== null && Math.abs(y - lastY) > 3) {
          lines.push(buf);
          buf = '';
        }
        buf += `${item.str || ''} `;
        lastY = y;
      }
      if (buf) lines.push(buf);
      pages.push(lines.join('\n'));
    }
    return pages.join('\n');
  } finally {
    await doc.destroy();
  }
}

function readableLength(text) {
  return String(text || '').replace(/\s/g, '').length;
}

function commandFailure(error) {
  const stderr = error?.stderr ? error.stderr.toString() : '';
  return (stderr || error?.message || '识别失败').replace(/\s+/g, ' ').slice(0, 180);
}

async function ocrImageFile(filePath) {
  const result = await execFileAsync('tesseract', [filePath, 'stdout', '-l', 'chi_sim+eng', '--psm', '6'], {
    timeout: 120000,
    maxBuffer: 30 * 1024 * 1024,
  });
  return String(result.stdout || '').trim();
}

async function ocrImageBuffer(buffer, suffix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-ocr-'));
  try {
    const imagePath = path.join(dir, `page${suffix || '.png'}`);
    await fs.writeFile(imagePath, buffer);
    return await ocrImageFile(imagePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function ocrPdf(buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-pdf-'));
  try {
    const pdfPath = path.join(dir, 'input.pdf');
    await fs.writeFile(pdfPath, buffer);
    await execFileAsync('pdftoppm', ['-png', '-r', '200', '-f', '1', '-l', '8', pdfPath, path.join(dir, 'page')], {
      timeout: 120000,
      maxBuffer: 30 * 1024 * 1024,
    });
    const pages = (await fs.readdir(dir)).filter((name) => name.endsWith('.png')).sort();
    if (!pages.length) throw new Error('没有从 PDF 中得到可识别的页面');
    const texts = [];
    for (const page of pages) texts.push(await ocrImageFile(path.join(dir, page)));
    return texts.join('\n').trim();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function extractXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return '';
  const lines = [];
  sheet.eachRow((row) => {
    const values = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      values[col - 1] = cellText(cell.value);
    });
    lines.push(values.map((value) => value || '').join(','));
  });
  return lines.join('\n');
}

export async function extractBuffer(buffer, filename, mime = '') {
  const name = String(filename || '').toLowerCase();
  const type = String(mime || '').toLowerCase();
  if (/\.(txt|md|csv|json|html)$/i.test(name) || type.startsWith('text/')) return decodeText(buffer);
  if (/\.docx$/i.test(name)) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }
  if (/\.pdf$/i.test(name) || type === 'application/pdf') {
    let text = '';
    try { text = await extractPdf(buffer); } catch { text = ''; }
    if (readableLength(text) >= 8) return text;
    try {
      return await ocrPdf(buffer);
    } catch (error) {
      throw new Error(`扫描版 PDF 本地识别失败：${commandFailure(error)}`);
    }
  }
  if (/\.(xlsx|xlsm)$/i.test(name)) return extractXlsx(buffer);
  if (/\.xls$/i.test(name)) throw new Error('请将旧版 .xls 另存为 .xlsx 或 CSV');
  if (/\.doc$/i.test(name)) throw new Error('请将旧版 .doc 另存为 .docx，或把文字粘贴到输入框');
  if (/\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(name) || type.startsWith('image/')) {
    const suffix = path.extname(name) || '.png';
    try {
      return await ocrImageBuffer(buffer, suffix);
    } catch (error) {
      throw new Error(`图片本地识别失败：${commandFailure(error)}`);
    }
  }
  throw new Error('此格式需要人工粘贴，当前不能自动读取');
}

export function splitTeacherQuestions(raw) {
  const lines = String(raw || '').replace(/\r/g, '').split('\n');
  const parts = [];
  let current = null;
  const re = /^\s*(?:第\s*([一二三四五六七八九十百\d]+)\s*题\s*[：:.、]?|(?:题目\s*)?(\d{1,3})\s*[.．、)）:：]\s*|[（(](\d{1,3})[)）]\s*)(.*)$/;
  for (const line of lines) {
    const matched = line.match(re);
    if (matched) {
      if (current) parts.push(current);
      current = { title: `第${matched[1] || matched[2] || matched[3]}题`, content: (matched[4] || '').trim() };
    } else if (current) {
      current.content += (current.content ? '\n' : '') + line;
    } else if (line.trim()) {
      current = { title: '第1题', content: line.trim() };
    }
  }
  if (current) parts.push(current);
  return parts.filter((part) => part.content || part.title);
}

export function parseSmartAssignment(raw) {
  const normalized = String(raw || '').replace(/\r/g, '').trim();
  const answerStart = normalized.search(/(?:^|\n)\s*(?:参考答案|标准答案|答案汇总|答案与解析|Answer Key|Answers)\s*[：:\n]/im);
  const answerText = answerStart >= 0 ? normalized.slice(answerStart) : '';
  const body = answerStart >= 0 ? normalized.slice(0, answerStart) : normalized;
  const parts = splitTeacherQuestions(body);
  const answers = {};
  for (const line of answerText.split('\n')) {
    const matches = line.matchAll(/(?:第\s*)?(\d{1,3})\s*(?:题)?\s*[.．、:：)）=\-]?\s*([A-Da-d](?:\s*[,，、]\s*[A-Da-d])*|[^\s,，;；]{1,20})(?=\s|$|[,，;；])/g);
    for (const matched of matches) answers[Number(matched[1])] = matched[2].toUpperCase();
  }
  return parts.map((part, index) => {
    let content = part.content.trim();
    let options = [];
    const optionMatches = [...content.matchAll(/(?:^|\n|\s{2,})([A-F])\s*[.．、:：)）]\s*([^\n]+?)(?=(?:\s{2,}[A-F]\s*[.．、:：)）])|$|\n)/g)];
    if (optionMatches.length >= 2) {
      options = optionMatches.map((matched) => matched[2].trim());
      content = content.slice(0, optionMatches[0].index).trim();
    }
    const type = options.length >= 2
      ? 'single'
      : /(?:听录音|听力|听一听|听后)/.test(content)
        ? 'listening'
        : /(?:_{2,}|＿{2,}|（\s*）|\(\s*\)|填空)/.test(content)
          ? 'blank'
          : 'writing';
    return { ...part, content, type, options, correct: answers[index + 1] || '' };
  });
}

export function recognizeAssignment(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new HttpError(400, '请先导入可读取的文件或粘贴题目文字');
  const sections = parseSmartAssignment(text);
  if (!sections.length) throw new HttpError(400, '没有识别出题目，请检查题号');
  const matched = sections.filter((part) => part.correct).length;
  return {
    sections,
    summary: `识别出 ${sections.length} 道题，关联 ${matched} 条参考答案。请核对题型、选项和答案后发布。`,
  };
}

export function parseRoster(text) {
  const rows = String(text || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^学号\s*[,，;；\t]\s*姓名$/.test(line));
  if (!rows.length) throw new HttpError(400, '请先选择可读取的文件或输入学生名单');
  const parsed = rows.map((line) => line.split(/[,，;；\t]/).map((value) => value.trim()));
  if (parsed.some((columns) => columns.length < 2 || !columns[0] || !columns[1])) {
    throw new HttpError(400, '名单格式不正确，请按“学号,姓名”每行填写');
  }
  return parsed.map(([id, name]) => ({ id: id.slice(0, 40), name: name.slice(0, 40) }));
}

const QUESTION_TYPES = new Set(['single', 'multiple', 'blank', 'writing', 'listening']);

export function normalizeSections(input) {
  let sections = input;
  if (typeof sections === 'string') {
    try { sections = JSON.parse(sections); } catch { throw new HttpError(400, '题目数据无法读取'); }
  }
  if (!Array.isArray(sections) || !sections.length) throw new HttpError(400, '请至少保留一道题');
  return sections.slice(0, 200).map((section, index) => ({
    title: String(section?.title || `第${index + 1}题`).slice(0, 200),
    content: String(section?.content || '').slice(0, 20000),
    type: QUESTION_TYPES.has(section?.type) ? section.type : 'writing',
    options: Array.isArray(section?.options)
      ? section.options.map((option) => String(option).trim().slice(0, 500)).filter(Boolean).slice(0, 8)
      : [],
    correct: String(section?.correct || '').slice(0, 200),
    audio: String(section?.audio || '').slice(0, 1000),
  }));
}
