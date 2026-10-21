// 示例插件：演示 DualHabitat Matrix 的插件格式。
//
// 放在 <桥接根>/plugins/ 下的 .js / .mjs 都会被桥接装载（QQ 与微信共用一套）。
// default 导出 { name, description, commands }，每个命令：
//   { name, usage, description, run(ctx, args) }
// ctx 提供：
//   ctx.reply(text)   回一条文字消息
//   ctx.platform      'qq' | 'wechat'
//   ctx.from          发送者 id
//   ctx.config        桥接的 config.json（只读用，别在这里写盘）
//   ctx.log(...)      写桥接日志
// 插件拥有与桥接进程相同的本机权限 —— 只装你信得过的代码。
//
// 改完插件不用重启软件：在桌面端「高级 → 插件」点「重新装载」，或发 /plugins 看装载结果。

export default {
  name: 'hello',
  description: '示例插件：打招呼与掷骰子',
  commands: [
    {
      name: 'hello',
      usage: '/hello [名字]',
      description: '打个招呼，验证插件链路通不通',
      run: async (ctx, args) => {
        await ctx.reply(`你好，${args[0] || ctx.from}！插件在跑。`);
      }
    },
    {
      name: 'roll',
      usage: '/roll [面数]',
      description: '掷骰子（默认 6 面，2~1000 面）',
      run: async (ctx, args) => {
        const n = Math.min(Math.max(Number(args[0]) || 6, 2), 1000);
        await ctx.reply(`骰子是 ${1 + Math.floor(Math.random() * n)}（1-${n}）`);
      }
    }
  ]
};
