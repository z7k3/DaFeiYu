'use strict';

/**
 * 关怀路由：判断群聊里一条「非召唤消息」（没人 @ 她）是否在表达
 * 关心/慰问/健康/情绪支持——这类消息值得温柔回应，requireAt 的沉默
 * 在关怀场景（群友生病、互相叮嘱、情绪低落）会显得冷漠。
 *
 * 为什么用语义路由而不是关键词表：关心的表达方式无穷（"照顾好自己"/"多喝热水"/
 * 藏在互怼里的"你个傻冒赶紧去医院"），关键词永远追不上——和 searchRouter 同一
 * 思路：一次很短的 LLM 调用做语义判断，判断失败按「非关怀」处理，保证不劣化。
 *
 * 成本控制：调用方负责节流（每会话路由冷却 + 关怀回应回收），本模块只管判断。
 */

const SYSTEM = ['你在判断一条群聊消息的社交意图：说话人是否在向他人表达「关心/慰问/情感支持」，或在播报需要他人回应的健康/情绪状况。',
  '算「关心」：关心健康（生病/发烧/受伤/打针/去医院/熬夜辛苦）、叮嘱注意身体（"照顾好自己"、"多喝热水"）、安慰鼓励（情绪低落/考试失败/工作不顺）、道别与祝福、表达担心。',
  '藏在那怕是互怼语气里的真关心也算（比如"你个傻冒赶紧去医院"）。',
  '不算：单纯玩梗互怼没有关心实质、点名让助手回答问题或做事、与任何人无关的陈述、对助手本人的提问。',
  '只输出 JSON：{"care": true} 或 {"care": false}，不要解释。'].join('\n');

function parseCare(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const jsonText = (text.match(/\{[\s\S]*\}/) || [''])[0];
  if (!jsonText) return null;
  try {
    const obj = JSON.parse(jsonText);
    return typeof obj.care === 'boolean' ? { care: obj.care } : null;
  } catch {
    return null;
  }
}

async function routeCare(llm, text, opts = {}) {
  const said = String(text || '').trim().slice(0, 200);
  if (!llm || typeof llm.complete !== 'function' || !said) return { care: false };
  let timer, abort;
  const controller = new AbortController();
  try {
    const timeoutMs = Math.max(500, Number(opts.timeoutMs) || 2500);
    const raw = await Promise.race([
      Promise.resolve().then(() => llm.complete({
        system: SYSTEM,
        turns: [{ role: 'user', content: said }],
        maxTokens: 60,
        signal: controller.signal,
      })),
      new Promise((_, reject) => {
        abort = () => { controller.abort(); reject(new Error('aborted')); };
        if (opts.signal) opts.signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => { controller.abort(); reject(new Error('care timeout')); }, timeoutMs);
      }),
    ]);
    const parsed = parseCare(raw);
    return parsed || { care: false };
  } catch {
    return { care: false };
  } finally {
    clearTimeout(timer);
    if (abort && opts.signal) opts.signal.removeEventListener('abort', abort);
  }
}

module.exports = { routeCare, parseCare, SYSTEM };
