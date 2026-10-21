// 诊断 HF token：它是谁的、有什么权限、推理路由的真实错误码。
// 刻意从 secrets.json 读，避免 token 出现在命令行/历史里。
import fs from 'node:fs';

const token = JSON.parse(fs.readFileSync(new URL('../secrets.json', import.meta.url), 'utf8')).HF_TOKEN;
if (!token) {
  console.error('secrets.json 里没有 HF_TOKEN');
  process.exit(1);
}

const show = async (label, url, init) => {
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    console.log(`=== ${label} ===`);
    console.log('status:', res.status);
    console.log(text.slice(0, 900));
    console.log('');
  } catch (error) {
    console.log(`=== ${label} ===`);
    console.log('请求失败:', error?.message ?? error);
    console.log('');
  }
};

await show('whoami-v2（token 身份与权限）', 'https://huggingface.co/api/whoami-v2', {
  headers: { Authorization: `Bearer ${token}` }
});

await show('router chat/completions（真实推理）', 'https://router.huggingface.co/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'deepseek-ai/DeepSeek-V4.1-Flash',
    messages: [{ role: 'user', content: '只回一个字：好' }],
    max_tokens: 8
  })
});
