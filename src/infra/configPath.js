'use strict';
const fs = require('node:fs');
const path = require('node:path');

// 新目录优先；没有新配置时继续兼容根目录，读取过程不搬动用户文件。
function configPath(root) {
  const current = path.join(root, 'data', 'config.json');
  const legacy = path.join(root, 'config.json');
  return fs.existsSync(current) || !fs.existsSync(legacy) ? current : legacy;
}

module.exports = { configPath };
