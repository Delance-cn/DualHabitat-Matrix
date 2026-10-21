// 从 token 里挖 account id：Workers AI 的端点必须带 account id，
// 但这个 token 只授了 Workers AI 权限，所以正经的 /accounts 列表是空的。
// 这里依次试几个可能泄露/返回 account id 的接口。
import fs from 'node:fs';

const secrets = JSON.parse(fs.readFileSync(new URL('../secrets.json', import.meta.url), 'utf8'));
const token = process.env.CF_TOKEN_CHECK || secrets.CLOUDFLARE_API_TOKEN;
const tokenId = process.env.CF_TOKEN_ID || null;

const tries = [
  ['/user', '客户端身份'],
  ['/memberships', '账号成员关系（最可能给出 account id）'],
  ['/user/tokens', 'token 列表'],
  [tokenId ? `/user/tokens/${tokenId}` : null, 'token 详情（含授权策略里的 account id）'],
  ['/accounts?per_page=50', '账号列表（重试）'],
  ['/zones?per_page=5', 'zone 列表（zone 结果里也带 account id）']
].filter(([p]) => p);

for (const [p, label] of tries) {
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4${p}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const text = await res.text();
    console.log(`=== ${p}  (${label})  status=${res.status}`);
    console.log('   ' + text.slice(0, 500).replace(/\n/g, '\n   '));
    console.log('');
  } catch (error) {
    console.log(`=== ${p}  → 请求失败: ${error?.message ?? error}\n`);
  }
}
