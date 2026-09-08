# AI Agent 开发规范

> 本文件是 AI Agent（Copilot/Cursor/Claude等）的**强制性开发规范**。
> 项目文档请查看 `README.md`。

---

## 🚨 硬性规则

### 规则 1：国际化（i18n）

**禁止硬编码任何用户可见的中文文本**，所有面向用户的文本必须通过 `t(locale, key)` 函数调用：

- UI 标签、按钮文本、标题、描述
- 提示信息、占位符、错误消息
- 日志消息（`addLog()` 的 msg 参数）
- aria-label 等无障碍属性
- title 属性

**唯一例外**：纯注释代码（`//` 或 `/* */`）可以保留中文。

#### 新增 i18n 键的流程

1. 先在 `zh` 字典添加中文翻译
2. **同步在 `en` 字典添加英文翻译**（必须同时添加，不能遗漏）
3. 使用 `t(locale, "your.key")` 调用

#### 禁止中文标点符号

- 使用英文冒号 `:` 而不是 `：`
- 使用英文逗号 `,` 而不是 `，`
- 其他标点同理

#### 检测与验证

完成开发后，运行以下命令检查是否有遗漏：

```bash
# 检查是否有硬编码中文（排除注释和 i18n.ts）
grep -rn '"[^"]*[一-龥][^"]*"' src --include="*.tsx" --include="*.ts" | grep -v "i18n.ts" | grep -v "//"
```

---

### 规则 2：代码质量

#### TypeScript 严格模式

- 禁止使用 `any` 类型
- 优先使用 `unknown` + 类型守卫
- 接口和类型定义放在 `src/types/` 目录

#### 命名规范

- 组件：PascalCase（如 `UserCard.tsx`）
- 工具函数：camelCase（如 `formatDate.ts`）
- 常量：UPPER_SNAKE_CASE
- CSS 类名：使用 Tailwind CSS，避免自定义类名

#### 导入顺序

```typescript
// 1. React 相关
import { useState, useEffect } from 'react';

// 2. 第三方库
import { format } from 'date-fns';

// 3. 项目内部
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/stores/app';
import { t } from '@/lib/i18n';
```

---

### 规则 3：状态管理

- 全局状态使用 Zustand（`src/stores/`）
- 组件本地状态使用 `useState` / `useReducer`
- 避免 prop drilling，超过 3 层使用状态管理或 Context

---

### 规则 4：组件开发

#### 文件结构

```
src/components/
├── ui/              # shadcn 生成的基础组件（勿手动修改）
├── layout/          # 布局组件
└── features/        # 业务功能组件
```

#### 组件规范

- 单个文件不超过 300 行，超过则拆分
- 组件 Props 必须定义 interface
- 复杂逻辑抽取为自定义 Hook（`src/hooks/`）

---

### 规则 5：样式规范

- 优先使用 Tailwind CSS
- 颜色使用 CSS 变量（`hsl(var(--primary))`）
- 响应式断点：`sm:640px` / `md:768px` / `lg:1024px` / `xl:1280px`

---

### 规则 6：性能优化

- 列表渲染必须提供 `key`
- 避免不必要的 re-render（使用 `React.memo` / `useMemo`）
- 大型列表使用虚拟滚动
- 图片懒加载

---

### 规则 7：错误处理

- API 调用必须 try-catch
- 用户可见的错误使用 Toast 提示
- 开发环境显示详细错误，生产环境隐藏敏感信息

---

### 规则 8：Git 提交规范

提交信息格式：

```
<type>(<scope>): <subject>

<body>

<footer>
```

类型：
- `feat`: 新功能
- `fix`: 修复
- `docs`: 文档
- `style`: 代码格式
- `refactor`: 重构
- `test`: 测试
- `chore`: 构建/工具

---

### 规则 9：文件组织

#### 目录结构

```
src/
├── components/      # 组件
├── hooks/           # 自定义 Hook
├── stores/          # Zustand 状态
├── lib/             # 工具函数
├── types/           # TypeScript 类型
├── styles/          # 全局样式
└── assets/          # 静态资源
```

#### 文件命名

- 组件文件：PascalCase（`UserProfile.tsx`）
- 工具文件：camelCase（`formatDate.ts`）
- 测试文件：`*.test.ts` / `*.spec.ts`

---

### 规则 10：禁止事项

- ❌ 禁止在组件中直接调用 `localStorage`
- ❌ 禁止使用 `console.log`（生产环境）
- ❌ 禁止在 JSX 中写复杂逻辑
- ❌ 禁止使用内联样式（除非动态计算）
- ❌ 禁止硬编码字符串（使用 i18n）
- ❌ 禁止使用 `index` 作为 `key`

---

### 规则 11：推理引擎横向扩展（ASR/TTS 引擎注册表）

**核心原则**：新增推理框架（如 PyTorch）**禁止**在 `lib.rs` / `hotkey.rs` / `get_vram_status` 中追加 `if/else` 分支。必须通过引擎注册表横向扩展。

#### 架构定位

```
src-tauri/src/inference/
├── engine.rs       # AsrEngine trait（统一接口，唯一契约）
├── registry.rs     # 注册表：统一路由 + ASR 互斥（同一时间只加载一个引擎）
├── llama_server.rs # GGUF → llama-server 子进程（ASR 主引擎）
├── sherpa_asr.rs   # ONNX → sherpa-onnx websocket server（低端设备）
├── pytorch.rs      # 未来：PyTorch 子进程 HTTP 服务
├── commands.rs     # Tauri 命令桥接（只调 registry，不感知具体框架）
└── errors.rs       # 错误类型
```

#### 新增引擎的三步流程

1. **实现 `AsrEngine` trait**（新建 `pytorch.rs` 或类似文件）：
   ```rust
   use crate::inference::engine::AsrEngine;

   pub struct PyTorchAsrAdapter { /* 内部持有子进程/客户端 */ }

   impl AsrEngine for PyTorchAsrAdapter {
       fn framework(&self) -> &'static str { "pytorch" }  // 唯一框架标识
       fn load_model(&self, name: &str) -> Result<(), String> { /* ... */ }
       fn load_model_with_stage(&self, name: &str, on_stage: &mut dyn FnMut(&str)) -> Result<(), String> { /* ... */ }
       fn unload(&self) -> Result<(), String> { /* ... */ }
       fn is_loaded(&self) -> bool { /* ... */ }
       fn current_model(&self) -> String { /* ... */ }
       fn transcribe(&self, samples: &[f32], sample_rate: u32) -> Result<String, String> { /* ... */ }
       fn vram_estimate_mb(&self) -> Option<u64> { /* ... */ }  // 显存监控自动接入
   }
   ```
   **必须实现全部方法**，任何方法缺失 = 编译错误（trait 契约强制）。

2. **注册到 registry**（`registry.rs` 的 `AsrRegistry::new()`）：
   ```rust
   engines: vec![
       ("gguf", Arc::new(llama_server::LlamaAsrAdapter::new()) as Arc<dyn AsrEngine>),
       ("onnx", Arc::new(sherpa_asr::SherpaAsrAdapter::new()) as Arc<dyn AsrEngine>),
       ("pytorch", Arc::new(pytorch::PyTorchAsrAdapter::new()) as Arc<dyn AsrEngine>),  // ← 加这一行
   ],
   ```

3. **模型清单注册**（`model_manager.rs` 的 REGISTRY）：
   - 新增 `ModelFormat::PyTorch` 变体（如有新格式）
   - 模型条目加 `format: ModelFormat::PyTorch`

**完成以上三步，以下功能自动生效（禁止再改调用方）**：
- `lib.rs` 的 `load_model` 路由（按 format 自动分发到对应框架）
- `hotkey.rs` 录音转写（`registry.active_engine()` 自动选当前加载引擎）
- `is_model_in_use` 删除保护（模型使用中禁止删除）
- `get_vram_status` 显存监控（`vram_estimate_mb()` 自动接入）
- **ASR 互斥**：加载新框架模型时，registry 自动卸载其他框架的模型

#### 禁止事项

- ❌ 禁止在 `lib.rs` / `hotkey.rs` 里加 `if framework == "pytorch"` 这类分支
- ❌ 禁止绕过 registry 直接调用具体引擎（`sherpa_asr::global_engine()` 只允许在 adapter 内部用）
- ❌ 禁止改动 `AsrEngine` trait 的既有方法签名（新增方法用默认实现向下兼容）

#### 现有框架映射

| 模型格式 | 框架标识 | 引擎 | 进程 |
|---|---|---|---|
| GGUF | `gguf` | llama-server | 子进程 + HTTP |
| ONNX (ASR) | `onnx` | sherpa-onnx | websocket server 子进程 |
| PyTorch (未来) | `pytorch` | PyTorch 服务 | 子进程 + HTTP |

---

### 规则 12：音频解码可插拔

音频解码（`audio/` 模块）必须做成**可插拔解码器**，禁止在转写链路里写死格式判断。

```
src-tauri/src/audio/
├── mod.rs        # 统一入口（decode_audio → 自动选择解码器）
├── decoder.rs    # 解码器注册表（wav/ffmpeg/symphonia）
├── wav.rs        # WAV 解码（hound）
├── resample.rs   # 重采样
└── capture.rs    # 录音采集
```

- 新增解码格式 = 在 `decoder.rs` 注册一个解码器，不碰转写链路
- 上层（`transcribe_file_via_llama_server` 等）只调 `audio::decode_audio()`，不感知格式

---

### 规则 13：发版流程（严格遵循，禁止另起炉灶）

**版本号单一事实源 = `package.json` 的 `version` 字段**。禁止在代码/脚本里硬编码版本号。

#### 命令一览

| 命令 | 用途 |
|---|---|
| `npm run bundle` | **仅打包本地验证**（不推送不上传）：产 `dist-bundle/VoxFlow-Portable-<ver>.zip` + `VoxFlow-Setup-<ver>.exe` |
| `npm run bundle:portable` | 只打便携版 zip（本地快速验证） |
| `npm run version:sync` | 把 package.json 的版本分发到 tauri.conf.json / Cargo.toml / Cargo.lock |
| `npm run release` | **一键正式发版**：校验版本一致 → bundle → git push → gh release + 上传资产 |

#### 正式发版流程（vX.Y.Z 示例）

```
1. 编辑 package.json 的 "version" 为 "0.4.0"   ← 唯一手改点（文件，不是命令参数）
2. npm run version:sync                        ← 同步其余三处
3. npm run release                             ← 打包+推送+建 release+传资产
```

#### 命名规则（必须与历史队列一致）

| 位置 | 格式 | 示例 |
|---|---|---|
| package.json / tauri.conf.json / Cargo.toml | `X.Y.Z`（无 v） | `0.4.0` |
| git tag / release tag | `vX.Y.Z`（带 v） | `v0.4.0` |
| release 标题 | 纯 `vX.Y.Z`（不带产品名前缀） | `v0.4.0` |
| 资产文件名 | `VoxFlow-Portable-X.Y.Z.zip` / `VoxFlow-Setup-X.Y.Z.exe`（无 v） | `VoxFlow-Portable-0.4.0.zip` |

#### 禁止事项

- ❌ 禁止在命令里敲版本号作为唯一设置方式（改 package.json 文件 + version:sync）
- ❌ 禁止在 UI/代码里硬编码版本号（前端用 `__APP_VERSION__`，vite 构建注入）
- ❌ 禁止改动远程已存在的 release（v0.1.0 / v0.2.0 / v0.3.x / runtime-assets 保持原样）
- ❌ 禁止改资产命名规则（无 v 前缀；v0.2.0 那次带 -v 是跑偏，勿模仿）
- ❌ 禁止手动分别改 4 处版本号（会漏 → 用 version:sync）
- ❌ 禁止给 release 标题加产品名前缀（纯版本号）

#### 本地验证（非发版）

只打包不上传：`npm run bundle`（产物在 dist-bundle/，已 gitignore）。验证 UI 版本号应显示 `vX.Y.Z`（构建注入自动）。

---

## 📋 开发流程

1. **开发前**：阅读 `README.md` 了解项目架构
2. **开发中**：遵循上述规则
3. **开发后**：运行检测命令验证
4. **提交前**：检查代码是否符合规范

---

> ⚠️ 违反上述规则的代码将被拒绝合并。
