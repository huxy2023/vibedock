# VibeDock Project & Engineering Rules (AGENTS.md)

## 1. 项目架构概览 (`pnpm` Monorepo)

- **`packages/vibedock` (`vibedock`)**：Hono JS + TypeScript (`strict: true`, ESM) 服务端、Node.js 内置 `node:sqlite`、CLI (`src/cli/main.ts`)、零依赖 AI Skill 客户端 (`src/skill/client.ts`) 与部署编排 (`src/deploy/*`)。
- **`packages/web` (`@vibedock/web`)**：React 19 + Vite + TypeScript + Tailwind CSS v4 + `shadcn/ui` 风格组件 + `lucide-react` 门户前端，构建产物直接输出至 `packages/vibedock/public`。
- **`packages/docs` (`@vibedock/docs`)**：VitePress 官方文档站。

---

## 2. 技术选型与三方库原则

- **允许使用三方库，只要有合理的理由，且收益大于成本即可。**
  - 前端 UI 鼓励使用成熟的现代生态（如 Tailwind CSS、`shadcn/ui`、`lucide-react`、`marked`、`dompurify`），避免手搓 fragile 的大段原生 CSS 或 DOM 拼接。
  - 服务端鼓励使用轻量、类型完备的标准库与成熟框架（如 `hono`、`@hono/node-server`、Node 内置 `node:sqlite`）。
  - 唯独分发给开发者的 AI Skill 脚本（`packages/vibedock/src/skill/client.ts` -> `scripts/client.mjs`）需保持纯 Node.js 标准库零外部依赖，确保开发者解压即用、无需 `npm install`。

---

## 3. 核心工程准则

1. **【改量最小律】**：改动范围严格聚焦目标需求或缺陷，不顺手乱改无关模块。
2. **【爆炸半径律】**：局部修复不擅动跨模块契约；确需修改公共层时先向人类说明影响面。
3. **【审查收敛律】**：Code Review 无实质 P0/P1 逻辑、安全或权限缺陷即输出 `LGTM` 收敛闭环。
4. **【质问立正律】**：人类提出反问或质疑时，立即停手核查可疑代码并给出回滚/修正方案，未经确认绝不推送远端。
