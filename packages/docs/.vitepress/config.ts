import { defineConfig } from 'vitepress';

export default defineConfig({
  lang: 'zh-CN',
  title: 'VibeDock',
  description: 'Self-Hosted AI-Native Team App & Database Cloud — 一句话让 Claude Code / Codex / Cursor 把本地项目与独立数据库推上团队服务器',
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '快速开始', link: '/guide/getting-started' },
      { text: '架构设计', link: '/guide/architecture' },
      { text: '部署契约', link: '/guide/deploy-contract' },
      { text: '共享数据库', link: '/guide/databases' },
    ],
    sidebar: [
      {
        text: '指南与架构',
        items: [
          { text: '5 分钟快速开始', link: '/guide/getting-started' },
          { text: '核心架构与安全边界', link: '/guide/architecture' },
          { text: 'publish.json 与 Skill 契约', link: '/guide/deploy-contract' },
          { text: '一键数据库底座与隔离', link: '/guide/databases' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/huxy2023/vibedock' },
    ],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 VibeDock Contributors',
    },
  },
});
