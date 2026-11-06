import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts', 'deploy-ocr.sh');

function listed(output, language) {
  return output.split(/\r?\n/).some((line) => line.trim() === language);
}

export async function ocrStatus() {
  try {
    const langs = await exec('tesseract', ['--list-langs'], { timeout: 15000 });
    const text = `${langs.stdout}\n${langs.stderr}`;
    await exec('pdftoppm', ['-h'], { timeout: 15000 });
    const chi = listed(text, 'chi_sim');
    const eng = listed(text, 'eng');
    return { ready: chi && eng, chi, eng };
  } catch {
    return { ready: false, chi: false, eng: false };
  }
}

export async function deployOcr() {
  const current = await ocrStatus();
  if (current.ready) {
    console.log('OCR 已就绪：Tesseract chi_sim+eng，pdftoppm');
    return current;
  }
  console.log('正在部署本地 OCR（Tesseract chi_sim+eng 与 Poppler）…');
  await exec('bash', [script], { timeout: 600000 });
  const after = await ocrStatus();
  if (!after.ready) throw new Error('OCR 部署未完成：缺少 tesseract chi_sim/eng 或 pdftoppm');
  console.log('OCR 部署完成：Tesseract chi_sim+eng，pdftoppm');
  return after;
}
