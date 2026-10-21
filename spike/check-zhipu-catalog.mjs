// 智谱在 OpenCode 里的两套 provider（zhipuai 国内 / zai 国际）+ 模型标记。
// 关键：glm-4.5-flash 的 reasoning 是"开关型"，要确认 OpenCode 关得掉 ——
// 不关的话每次 17 秒，群聊没法用。
const all = await (await fetch('https://models.dev/api.json')).json();

for (const pid of ['zhipuai', 'zai']) {
  const p = all[pid];
  if (!p) continue;
  console.log(`\n═══════ ${pid}  (${p.api}) ═══════`);
  console.log(`env=${JSON.stringify(p.env)}  npm=${p.npm}  模型数=${Object.keys(p.models ?? {}).length}`);
  for (const [mid, m] of Object.entries(p.models ?? {})) {
    const bits = [
      m.reasoning ? `reasoning=${JSON.stringify(m.reasoning_options ?? true)}` : 'reasoning=no',
      m.tool_call ? 'tools=✓' : 'tools=✗',
      m.interleaved ? `interleaved=${JSON.stringify(m.interleaved)}` : null,
      m.limit ? `ctx=${m.limit.context}` : null,
      m.cost ? `cost(in/out)=${m.cost.input}/${m.cost.output}` : null
    ].filter(Boolean);
    console.log(`  ${mid.padEnd(22)} ${bits.join('  ')}`);
  }
}

// glm-4.5-flash 的完整定义（看 OpenCode 能从哪些字段推断如何关思维链）
console.log('\n═══════ glm-4.5-flash 完整定义 ═══════');
console.log(JSON.stringify(all.zhipuai?.models?.['glm-4.5-flash'], null, 2));
