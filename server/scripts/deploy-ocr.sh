#!/usr/bin/env bash
# 安装本机作业识别所需的 Tesseract 简体中文/英文模型和 Poppler。
# 已安装时直接退出。需要 root；普通用户会尝试免密 sudo。
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

has_lang() {
  local lang="$1"
  tesseract --list-langs 2>&1 | grep -qx "$lang"
}

need_install=0
command -v tesseract >/dev/null 2>&1 || need_install=1
command -v pdftoppm >/dev/null 2>&1 || need_install=1
if command -v tesseract >/dev/null 2>&1; then
  has_lang chi_sim || need_install=1
  has_lang eng || need_install=1
fi

if [[ "$need_install" -eq 0 ]]; then
  echo "OCR 已安装：tesseract chi_sim+eng，pdftoppm"
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    exec sudo -E bash "$0" "$@"
  fi
  echo "无法安装 OCR：需要 root 或免密 sudo，安装 tesseract-ocr、tesseract-ocr-chi-sim、tesseract-ocr-eng 和 poppler-utils" >&2
  exit 1
fi

apt-get update
apt-get install -y tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng poppler-utils
tesseract --list-langs
command -v pdftoppm >/dev/null
echo "OCR 安装完成"
