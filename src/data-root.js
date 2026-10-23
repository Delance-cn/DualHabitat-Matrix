// 数据根解析：运行时数据（config.json / secrets.json / state/ / .oc/ / models.local.json /
// opencode.json / audio/ …）统一落在哪里，由这里说了算。
//
// 为什么要有它：打包版的桥接代码在安装目录 resources\bridge 里，而 0.4.5 及之前的版本把
// 数据也写在同一个目录 —— 升级时旧版卸载器清点安装目录，模型池（models.local.json）、
// 微信登录态（state/wechat-token.json）、.oc 实例状态全都会跟着遭殃，用户每升一次级就要
// 重输一遍 API、重扫一次微信。
//
// 规则：
//   1. 环境变量 QQ_BRIDGE_DATA（运行时，桌面端统一注入）或 DHM_DATA_HOME（测试/特殊布局）
//      存在 → 它就是数据根（不存在会自动创建）。
//   2. 否则数据根 = 代码根。开发态两者本来就是同一个目录（仓库根），行为完全不变；
//      打包态桌面端一定会注入 QQ_BRIDGE_DATA，所以包里跑不会回落到安装目录。
//
// 代码根永远 = 本文件所在目录的上一级（src/..），与数据无关。
import fs from 'node:fs';
import path from 'node:path';

export function resolveDataRoot(codeRoot) {
  const env = (process.env.QQ_BRIDGE_DATA || process.env.DHM_DATA_HOME || '').trim();
  if (env) {
    const resolved = path.resolve(env);
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch {
      /* 建不出来就交给上层报错：写数据时自然会炸出人话 */
    }
    return resolved;
  }
  return codeRoot;
}
