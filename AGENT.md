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

## 📋 开发流程

1. **开发前**：阅读 `README.md` 了解项目架构
2. **开发中**：遵循上述规则
3. **开发后**：运行检测命令验证
4. **提交前**：检查代码是否符合规范

---

> ⚠️ 违反上述规则的代码将被拒绝合并。
