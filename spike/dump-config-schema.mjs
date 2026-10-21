/**
 * 读 opencode 官方 config schema（`https://opencode.ai/config.json`），
 * 只打印我们关心的几段：权限、工具、agent 条目。
 *
 *   node spike/dump-config-schema.mjs
 */

import fs from 'node:fs';

const raw = fs.readFileSync('.oc/logs/opencode-config-schema.json', 'utf8').replace(/^\uFEFF/, '');
const j = JSON.parse(raw);
const p = j.properties ?? {};

const show = (key, depth = 2) => {
  console.log(`\n════ ${key} ════`);
  console.log(JSON.stringify(p[key], null, 1)?.slice(0, 1200));
};

show('permissions');
show('tools');
show('policies');
show('permission');

// agents 可能是一张 map（additionalProperties）或 object
const ag = p.agents ?? {};
console.log('\n════ agents (keys) ════');
console.log(Object.keys(ag).join(', '));
const ref = ag.additionalProperties ?? ag.items ?? ag;
console.log('\n════ agent entry ════');
console.log(JSON.stringify(ref, null, 1).slice(0, 2000));
