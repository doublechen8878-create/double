
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'edge'; // 使用 Edge Runtime 避免超时

export default async function handler(req: NextRequest) {
  // 1. 预检请求处理
  if (req.method === 'GET') return NextResponse.json({ msg: 'Service Running' });
  
  // 2. 解析请求体
  const body = await req.json();
  const { record_id, prompt, image_file_token, model } = body;

  console.log(`收到任务: ${record_id}, Prompt: ${prompt}`);

  // 3. 定义后台任务 (WaitUntil 逻辑)
  const processTask = async () => {
    try {
      // (A) 获取飞书 Tenant Token
      const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: process.env.FEISHU_APP_ID,
          app_secret: process.env.FEISHU_APP_SECRET
        })
      });
      const { tenant_access_token } = await tokenRes.json();
      
      // (B) 调用云雾视频 API
      // 这里假设云雾 API 支持 image_file_token 或 URL。如果需要临时 URL，需额外调用飞书 drive API。
      // 为简化，此处演示直接透传 token 或 prompt 调用
      const videoRes = await fetch(`${process.env.VIDEO_API_BASE}/videos`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.VIDEO_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: model || 'kling-v1', // 默认模型
          prompt: prompt,
          image: image_file_token // 视具体 API 定义，可能需要换成 URL
        })
      });
      
      const videoData = await videoRes.json();
      const taskId = videoData.id || videoData.task_id;
      
      if (! taskId) throw new Error('未获取到视频任务 ID');

      // (C) 轮询等待结果 (最多轮询 5 分钟)
      let videoUrl = '';
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 5000)); // 等 5 秒
        const checkRes = await fetch(`${process.env.VIDEO_API_BASE}/videos/${taskId}`, {
          headers: { 'Authorization': `Bearer ${process.env.VIDEO_API_KEY}` }
        });
        const checkData = await checkRes.json();
        
        if (checkData.status === 'succeeded' || checkData.state === 'succeeded') {
          videoUrl = checkData.url || checkData.result_url;
          break;
        }
        if (checkData.status === 'failed') break;
      }

      // (D) 写回飞书多维表格
      if (videoUrl) {
        await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${process.env.BITABLE_APP_TOKEN}/tables/${process.env.BITABLE_TABLE_ID}/records/${record_id}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${tenant_access_token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            fields: {
              [process.env.BITABLE_VIDEO_FIELD]: { text: videoUrl, link: videoUrl }
            }
          })
        });
        console.log('写回成功');
      }

    } catch (err) {
      console.error('后台任务出错:', err);
    }
  };

  // 4. 触发后台任务并立即返回 200
  // @ts-ignore
  if (req.after) req.after(processTask()); // Vercel Edge 兼容写法
  // @ts-ignore
  else if (context?.waitUntil) context.waitUntil(processTask());
  else processTask(); // 降级处理

  return NextResponse.json({ code: 0, msg: "Task accepted, processing in background" });
}
