#!/usr/bin/env node
/**
 * 统一版本号脚本 —— 发版只需一处：npm run version:bump -- 0.4.0
 *
 * 同步修改（四处必须一致，否则打包产物名/二进制版本/UI 显示会错位）：
 *   1. package.json      → vite 注入前端 UI 显示
 *   2. tauri.conf.json   → 打包脚本读取 → 产物文件名
 *   3. Cargo.toml        → Rust 二进制版本
 *   4. Cargo.lock        → 依赖锁文件里的 voxflow 版本
 *
 * 用法: npm run version:bump -- 0.4.0
 * 校验: 只接受 x.y.z（semver，不带 v）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ver = process.argv[2];

if (!ver) {
  console.error("用法: npm run version:bump -- 0.4.0");
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+$/.test(ver)) {
  console.error(`版本号格式应为 x.y.z（不带 v），收到: ${ver}`);
  process.exit(1);
}

function patch(rel, regex, label) {
  const p = path.join(root, rel);
  const s = readFileSync(p, "utf-8");
  if (!regex.test(s)) {
    console.error(`✗ ${rel}: 未找到可替换的版本号`);
    process.exit(1);
  }
  writeFileSync(p, s.replace(regex, `$1${ver}$2`));
  console.log(`✓ ${label} (${rel}) → ${ver}`);
}

patch("package.json", /("version":\s*")[\d.]+(")/, "package.json");
patch("src-tauri/tauri.conf.json", /("version":\s*")[\d.]+(")/, "tauri.conf.json");
patch("src-tauri/Cargo.toml", /(^version\s*=\s*")[\d.]+(")/m, "Cargo.toml");

// Cargo.lock: voxflow 包条目（只改第一个 name=voxflow 的 version）
{
  const p = path.join(root, "src-tauri/Cargo.lock");
  const s = readFileSync(p, "utf-8");
  // 找 "name = \"voxflow\"" 后紧跟的 version
  const re = /(name = "voxflow"\nversion = ")[\d.]+(")/;
  if (!re.test(s)) {
    console.error("✗ Cargo.lock: 未找到 voxflow 版本");
    process.exit(1);
  }
  writeFileSync(p, s.replace(re, `$1${ver}$2`));
  console.log(`✓ Cargo.lock (voxflow) → ${ver}`);
}

console.log(`\n完成：版本号统一为 ${ver}。下一步：npm run bundle 打包。`);
