/**
 * 把 build/agreement.txt 变成 NSIS 的 !macro DHM_FILL_AGREEMENT。
 *
 * 为什么不是「File 解到临时目录再读」：那套在别人的机器上会翻车 ——
 * 临时目录被安全软件拦、解压没落地，都会让安装停在「提示文本读取失败」。
 * 编进脚本就没有运行时依赖了。
 *
 * 单独拆出来是为了能脱离完整打包流程单独验证（见 nsis-test/verify.mjs）。
 */
import fs from 'node:fs';

/** 一行文本 → NSIS 双引号字面量里的内容。$ 写成 $$，引号写成 $\" */
export const nsisLiteral = (s) => s.replace(/\$/g, '$$$$').replace(/"/g, '$\\"');

/** 单条 NSIS 字符串有 1024 字符上限，长行在空格处断开分几次灌 */
export function splitLong(line, max = 400) {
  const out = [];
  let rest = line;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

/**
 * @param {string} agreementPath build/agreement.txt 的路径
 * @returns {{ macro: string, lines: number, chunks: number }}
 */
export function buildAgreementMacro(agreementPath) {
  const lines = fs.readFileSync(agreementPath, 'utf8').split(/\r?\n/);
  const body = [];
  for (const line of lines) {
    for (const chunk of splitLong(line)) {
      body.push(`  SendMessage \${CTRL} \${EM_REPLACESEL} 0 "STR:${nsisLiteral(chunk)}$\\r$\\n"`);
    }
  }
  const macro = [
    '; 由 scripts/lib/agreement-nsh.mjs 生成，别手改',
    '!macro DHM_FILL_AGREEMENT CTRL',
    '  SendMessage ${CTRL} ${EM_SETSEL} -1 -1',
    ...body,
    '!macroend'
  ].join('\n');
  return { macro, lines: lines.length, chunks: body.length };
}
