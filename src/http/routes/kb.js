'use strict';

const { json, readBody } = require('../util');
const { isLoopbackRequest } = require('../security');

/**
 * 知识库（KB）管理路由。
 *
 * 知识库可能装着主人的私人资料，正文绝不走远程：全部接口只允许本机调用；
 * runtime.kb 未初始化（功能没开 / 存储没起来）时一律 503，不读盘、不报错细节。
 */
module.exports = function register(router) {
  // 统一闸门：非本机 → 403；知识库未启用 → 503
  const guard = (runtime, req, res) => {
    if (!isLoopbackRequest(req)) {
      json(res, 403, { ok: false, error: '知识库管理只允许在本机操作' });
      return true;
    }
    if (!runtime.kb) {
      json(res, 503, { ok: false, error: '知识库未启用' });
      return true;
    }
    return false;
  };

  // 状态总览：文档数 / 分块数 / 全局与人物配置 / 数据目录
  router.get('/api/kb/status', (runtime, req, res) => {
    if (guard(runtime, req, res)) return null;
    return json(res, 200, { ok: true, ...runtime.kb.status() });
  });

  // 重新扫描 docs 目录（手动删改文件后同步内存索引）
  router.post('/api/kb/reload', (runtime, req, res) => {
    if (guard(runtime, req, res)) return null;
    const out = runtime.kb.docsReload();
    return json(res, 200, { ok: true, docsDir: out.docsDir, docs: out.docs, chunks: out.chunks });
  });

  // 新增 / 整体替换一篇文档（name 同时是文件名：白名单字符集，防路径穿越）
  router.post('/api/kb/docs', async (runtime, req, res) => {
    if (guard(runtime, req, res)) return null;
    const body = await readBody(req);
    const name = body && body.name;
    if (typeof name !== 'string' || !/^[\w\u4e00-\u9fa5-]{1,64}$/.test(name)) {
      return json(res, 400, { ok: false, error: '文档名不合法：只能用中英文、数字、下划线和连字符，长度 1~64' });
    }
    const text = body && body.text;
    if (typeof text !== 'string' || !text.trim()) {
      return json(res, 400, { ok: false, error: '文档内容不能为空' });
    }
    if (text.length > 200000) {
      return json(res, 400, { ok: false, error: '文档内容太长（上限 200000 字）' });
    }
    const out = runtime.kb.setDoc(name, text);
    return json(res, 200, { ok: true, name, chunks: out.chunks });
  });

  // 删除一篇文档
  router.post('/api/kb/docs/delete', async (runtime, req, res) => {
    if (guard(runtime, req, res)) return null;
    const body = await readBody(req);
    const name = body && body.name;
    if (typeof name !== 'string' || !name.trim()) {
      return json(res, 400, { ok: false, error: '文档名不能为空' });
    }
    const out = runtime.kb.removeDoc(name);
    if (!out || out.removed !== true) {
      return json(res, 404, { ok: false, error: '没有这个文档' });
    }
    return json(res, 200, { ok: true, name });
  });
};
