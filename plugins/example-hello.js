// 示例插件：演示 DualHabitat Matrix 的插件格式（命令 + 事件钩子）。
//
// 放在 <桥接根>/plugins/ 下的 .js / .mjs 都会被桥接装载（QQ 与微信共用一套）。
// default 导出 { name, description, commands, hooks }：
//   commands: [{ name, usage, description, run(ctx, args) }]   —— 斜杠命令
//   hooks:    { onMessage(ctx), onBotReply(ctx), onTick(ctx) } —— 事件钩子（可选）
//
// ctx 提供：
//   ctx.reply(text)          回一条文字消息
//   ctx.sendVoice(filePath)  发本地音频文件为语音消息（QQ 支持；微信侧无此能力）
//   ctx.platform             'qq' | 'wechat'
//   ctx.chatId               会话键（如 group:123 / private:456 / 微信 id）
//   ctx.from                 发送者 id
//   ctx.text                 消息文本（onMessage 钩子里是完整正文）
//   ctx.isOwner              发送者是不是管理员
//   ctx.config               桥接的 config.json（只读用，别在这里写盘）
//   ctx.log(...)             写桥接日志
//
// 事件钩子（挂在 hooks 字段上，QQ 和微信都会触发）：
//   onMessage(ctx)   每条收到的消息（过了白名单/模式闸门之后）
//   onBotReply(ctx)  机器人每次发出回复（ctx.text = 回复内容）
//   onTick(ctx)      每分钟一次（时段判断自己做；没挂的插件零开销）
//
// 钩子里 return/抛错都不影响主流程；插件互相之间也隔离。
// 插件拥有与桥接进程相同的本机权限 —— 只装你信得过的代码。
//
// 改完插件不用重启软件：在桌面端「高级 → 插件」点「重新装载」，或发 /plugins 看装载结果。

// 简单的内存统计（重启清零）——演示 onMessage / onBotReply 的用法
const stats = { seen: 0, replied: 0, perChat: new Map() };

export default {
  name: 'hello',
  description: '示例插件：打招呼、掷骰子、消息统计与语音',
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
    },
    {
      name: 'voice',
      usage: '/voice <音频文件路径>',
      description: '把本地音频文件作为语音消息发出去（QQ；自己接 TTS 就能做语音回复）',
      run: async (ctx, args) => {
        if (!args[0]) return ctx.reply('用法：/voice <音频文件路径>（wav/mp3 等，QQ 支持）');
        if (typeof ctx.sendVoice !== 'function') return ctx.reply('当前通道不支持发语音（微信侧）');
        await ctx.sendVoice(args[0]);
        await ctx.reply('语音已发送');
      }
    },
    {
      name: '统计',
      usage: '/统计',
      description: '看本插件统计的消息量',
      run: async (ctx) => {
        await ctx.reply(`已收到 ${stats.seen} 条消息，机器人发过 ${stats.replied} 条回复。`);
      }
    }
  ],
  hooks: {
    // 每条收到的消息都会到这（过了白名单/模式闸门之后）
    onMessage(ctx) {
      stats.seen += 1;
      const n = (stats.perChat.get(ctx.chatId) ?? 0) + 1;
      stats.perChat.set(ctx.chatId, n);
      // 想自动回话就调 ctx.reply(...)——注意别做成复读机
    },
    // 机器人每次发出回复都会到这
    onBotReply(ctx) {
      stats.replied += 1;
    },
    // 每分钟一次；想每小时整点报时就在这判断分钟 === 0
    onTick(ctx) {
      // 例：每天 8 点整提醒（自己判断，不在这里写死）
    }
  }
};
