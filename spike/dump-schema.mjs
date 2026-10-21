// 打印 OpenCode 配置 schema 里的关键 $defs（供 ② 配置生成器照抄形状）。
import fs from 'node:fs';

const s = JSON.parse(fs.readFileSync('spike/opencode-config.schema.json', 'utf8'));
const D = s.$defs ?? {};

console.log('=== $defs 键 ===');
console.log(Object.keys(D).join(', '));

const want = process.argv.slice(2);
for (const k of want) {
  console.log(`\n=== ${k} ===`);
  console.log(JSON.stringify(D[k], null, 2));
}
