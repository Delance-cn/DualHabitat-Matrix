// 转发层：真正的实现已经提升为生产代码，见 `src/cf-shim.js` / `src/cf-shim-main.js`。
//
// 保留这个文件是为了让既有的手工排障命令照旧可用：
//   node spike/cf-shim.mjs
// 正常运行时由 `src/oc-server.js` 自己拉起，不需要手动跑。
import '../src/cf-shim-main.js';
