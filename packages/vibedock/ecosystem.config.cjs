const path = require('path');

module.exports = {
  apps: [
    {
      name: 'vibedock-portal',
      cwd: __dirname,
      script: 'dist/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '256M',
      time: true,
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '39090',
        VIBEDOCK_CONFIG: path.join(__dirname, 'vibedock.config.json'),
        OPS_AUDIT_FILE: path.join(__dirname, 'data', 'audit', 'actions.jsonl'),
        CHAT_DB_FILE: path.join(__dirname, 'data', 'vibedock-chat.sqlite3'),
        AUTH_DB_FILE: path.join(__dirname, 'data', 'vibedock-auth.sqlite3'),
        AI_CONFIG_FILE: path.join(__dirname, 'data', 'secrets', 'ai.json'),
        AI_KEY_FILE: path.join(__dirname, 'data', 'secrets', 'ai.key'),
      },
    },
  ],
};
