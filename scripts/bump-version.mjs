#!/usr/bin/env node
/**
 * 版本号同步脚本 —— 事实源 = package.json 的 version 字段。
 *
 * 发版流程：
 *   1. 编辑 package.json 的 "version"（唯一要改的地方）
 *   2. 运行 npm run version:sync
 *   3. npm run bundle 打包
 *
 * 脚本把 package.json 的版本分发到（四处必须一致，否则产物名/二进制/UI 错位）：
 *   1. tauri.conf.json   → 打包脚本读取 → 产物文件名
 *   2. Cargo.toml        → Rust 二进制版本
 *   3. Cargo.lock        → 依赖锁文件里的 voxflow 版本
 *   （package.json 自身 → vite 注入前端 UI 显示，不需要分发）
 *
 * 可选：npm run version:sync -- 0.4.0 会先更新 package.json 再分发（等价于手动编辑）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

let ver = pkg.version;
const arg = process.argv[2];
if (arg) {
  if (!/^\d+\.\d+\.\d+$/.test(arg)) {
    console.error(`版本号格式应为 x.y.z（不带 v），收到: ${arg}`);
    process.exit(1);
  }
  if (arg !== ver) {
    writeFileSync(pkgPath, JSON.stringify({ ...pkg, version: arg }, null, 2) + "\n", "utf-8");
    console.log(`✓ package.json（事实源）→ ${arg}`);
    ver = arg;
  }
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

patch("src-tauri/tauri.conf.json", /("version":\s*")[\d.]+(")/, "tauri.conf.json");
patch("src-tauri/Cargo.toml", /(^version\s*=\s*")[\d.]+(")/m, "Cargo.toml");
{
  const p = path.join(root, "src-tauri/Cargo.lock");
  const s = readFileSync(p, "utf-8");
  const re = /(name = "voxflow"\nversion = ")[\d.]+(")/;
  if (!re.test(s)) {
    console.error("✗ Cargo.lock: 未找到 voxflow 版本");
    process.exit(1);
  }
  writeFileSync(p, s.replace(re, `$1${ver}$2`));
  console.log(`✓ Cargo.lock (voxflow) → ${ver}`);
}

console.log(`\n完成：四处版本号统一为 ${ver}（事实源 package.json）。下一步：npm run bundle。`);
