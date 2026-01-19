// 安全版接口（JavaScript版）：不依赖 next/server，适配 Vercel “Other + ./” 项目
// 使用 CommonJS 导出，避免 TypeScript/@types/node 的构建报错
// 文件建议放到：api/feishu-video.js

module.exports = async function handler(req, res) {
  // 1) GET：浏览器直接访问用
  if (req.method === 'GET') {
    return res.status(200).json({ msg: 'Service Running' });
  }

  // 2) POST：完整安全流程
  try {
    // 2.1 读取 JSON 请求体（兼容飞书自动化 Raw JSON）
    let body = req.body;
    if (!body) {
      body = await new Promise((resolve) => {
        let data = '';
        req.on('data', (chunk) => (data += chunk.toString()));
        req.on('end', () => {
          try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
        });
      });
    }

    const { record_id, prompt, image_file_token, model } = body || {};

    // 2.2 环境变量防呆（缺就返回提示，不抛错）
    const envs = [
      'FEISHU_APP_ID','FEISHU_APP_SECRET','BITABLE_APP_TOKEN',
      'BITABLE_TABLE_ID','BITABLE_VIDEO_FIELD','VIDEO_API_BASE','VIDEO_API_KEY'
    ];
    const missing = envs.filter((k) => !process.env[k]);
    if (missing.length) {
      return res.status(200).json({ code: 1, msg: 'Missing env', detail: missing });
    }

    // 2.3 简单参数校验（兼容飞书自动化）
    if (!record_id) {
      return res.status(200).json({ code: 2, msg: 'Missing record_id' });
    }
    if (!prompt && !image_file_token) {
      return res.status(200).json({ code: 3, msg: 'Missing prompt or image_file_token' });
    }

    // 2.4 获取飞书 tenant_access_token（严格判错）
    let tenant_access_token = '';
    try {
      const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: process.env.FEISHU_APP_ID,
          app_secret: process.env.FEISHU_APP_SECRET,
        }),
      });
      if (!tokenRes.ok) {
        return res.status(200).json({ code: 4, msg: 'Feishu token fetch failed', status: tokenRes.status });
      }
      const tokenJson = await tokenRes.json().catch(() => ({}));
      tenant_access_token = (tokenJson && tokenJson.tenant_access_token) || '';
      if (!tenant_access_token) {
        return res.status(200).json({ code: 5, msg: 'No tenant_access_token in response' });
      }
    } catch (e) {
      return res.status(200).json({ code: 6, msg: 'Feishu token exception', detail: e && e.message ? e.message : String(e) });
    }

    // 2.5 调用视频生成 API（严格判错）
    const apiBase = String(process.env.VIDEO_API_BASE || '').replace(/\/$/, '');
    const apiKey = process.env.VIDEO_API_KEY;

    let taskId = '';
    try {
      const videoRes = await fetch(`${apiBase}/videos`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model || 'kling-v1',
          prompt,
          image: image_file_token,
        }),
      });
      if (!videoRes.ok) {
        return res.status(200).json({ code: 7, msg: 'Video API create failed', status: videoRes.status });
      }
      const videoJson = await videoRes.json().catch(() => ({}));
      taskId = (videoJson && (videoJson.id || videoJson.task_id)) || '';
      if (!taskId) {
        return res.status(200).json({ code: 8, msg: 'No taskId returned from video API' });
      }
    } catch (e) {
      return res.status(200).json({ code: 9, msg: 'Video API exception (create)', detail: e && e.message ? e.message : String(e) });
    }

    // 2.6 轮询任务结果（最多 5 分钟，每 5 秒一次；严格判错）
    let videoUrl = '';
    try {
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const checkRes = await fetch(`${apiBase}/videos/${taskId}`, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (!checkRes.ok) {
          continue; // 下轮再试
        }
        const checkJson = await checkRes.json().catch(() => ({}));
        const status = (checkJson && (checkJson.status || checkJson.state)) || '';
        if (status === 'succeeded') {
          videoUrl = (checkJson && (checkJson.url || checkJson.result_url)) || '';
          break;
        }
        if (status === 'failed') {
          break;
        }
      }
    } catch (_) {
      // 忽略轮询异常，最后统一返回
    }

    // 2.7 成功则写回飞书多维表格（严格判错）
    if (videoUrl) {
      try {
        const putRes = await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${process.env.BITABLE_APP_TOKEN}/tables/${process.env.BITABLE_TABLE_ID}/records/${record_id}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${tenant_access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            fields: {
              [String(process.env.BITABLE_VIDEO_FIELD)]: { text: videoUrl, link: videoUrl },
            },
          }),
        });
        if (!putRes.ok) {
          return res.status(200).json({ code: 10, msg: 'Writeback failed', status: putRes.status, videoUrl });
        }
      } catch (e) {
        return res.status(200).json({ code: 11, msg: 'Writeback exception', detail: e && e.message ? e.message : String(e), videoUrl });
      }
      return res.status(200).json({ code: 0, msg: 'Succeeded', videoUrl });
    }

    // 2.8 未成功生成则返回任务信息（不崩）
    return res.status(200).json({ code: 12, msg: 'Task not completed within 5min', taskId });
  } catch (err) {
    // 兜底：任何异常都以 200 返回，避免 500
    return res.status(200).json({ code: 13, msg: 'Caught top-level error', detail: err && err.message ? err.message : String(err) });
  }
};
