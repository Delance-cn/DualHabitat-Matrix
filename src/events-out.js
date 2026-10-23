// 出站事件推送（0.4.9）：机器人把「收到消息 / 发出回复」POST 到用户在扩展页配置的 URL。
// fire-and-forget：3 秒超时、失败只打一行日志，绝不阻塞收发主链路。
// 与微信侧既有的 fireHook('message.received') 互不相干：那是微信通道自己的老钩子（指向通知枢纽），
// 这是 QQ + 微信统一的事件流（扩展页配置，鉴权走 x-dhm-secret 头）。
//
// 事件体：{ event: 'message'|'reply', time: ISO, data: { platform, chatId, text, … } }
// 开关：config.events = { enabled, url, secret, onMessage, onReply }（桥接侧白名单归一化，微信侧读原文件）。

export function emitEvent(cfg, type, data) {
  try {
    const e = cfg?.events;
    if (!e || typeof e !== 'object') return;
    if (e.enabled !== true || !String(e.url ?? '').trim()) return;
    if (type === 'message' && e.onMessage === false) return;
    if (type === 'reply' && e.onReply === false) return;
    const payload = JSON.stringify({ event: type, time: new Date().toISOString(), data });
    fetch(String(e.url).trim(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(String(e.secret ?? '').trim() ? { 'x-dhm-secret': String(e.secret).trim() } : {})
      },
      body: payload,
      signal: AbortSignal.timeout(3000)
    }).catch((error) => console.log(`[events] 推送 ${type} 失败：${error?.message ?? error}`));
  } catch {
    /* 事件推送绝不影响主流程 */
  }
}
