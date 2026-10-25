import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ACCOUNT_ID,
  accountPorts,
  canonicalConvKey,
  isDefaultAccount,
  isValidAccountId,
  nextAccountId,
  normalizeQQAccounts,
  policyAllows,
  resolveAccountPolicy,
  scopedConvKey,
  splitConvKey,
  toConfigAccount
} from '../../src/qq-accounts.js';

test('旧配置（只有 snowluma）合成一个 qq1，端口从 URL 解析', () => {
  const { accounts, legacy } = normalizeQQAccounts({
    snowluma: {
      wsUrl: 'ws://127.0.0.1:3001',
      httpUrl: 'http://127.0.0.1:3000',
      accessToken: 'tok',
      homeDir: 'C:\\napcat\\app\\napcat'
    }
  });
  assert.equal(legacy, true);
  assert.equal(accounts.length, 1);
  const [a] = accounts;
  assert.equal(a.id, DEFAULT_ACCOUNT_ID);
  assert.equal(a.enabled, true);
  assert.equal(a.wsUrl, 'ws://127.0.0.1:3001');
  assert.equal(a.wsPort, 3001);
  assert.equal(a.httpPort, 3000);
  assert.equal(a.webuiPort, 6099);
  assert.equal(a.token, 'tok');
  assert.equal(a.homeDir, 'C:\\napcat\\app\\napcat');
});

test('新配置：端口按序号错开，非法 id 补位，重复 id 丢弃', () => {
  const { accounts, legacy } = normalizeQQAccounts({
    platforms: {
      qq: {
        accounts: [
          { id: 'qq1', qq: '10001', homeDir: 'D:\\a' },
          { id: 'bad id!', qq: '10002', homeDir: 'D:\\b' },
          { id: 'qq1', qq: '10003' },
          { id: 'qq3', qq: '10004', enabled: false }
        ]
      }
    }
  });
  assert.equal(legacy, false);
  assert.deepEqual(accounts.map((a) => a.id), ['qq1', 'qq2', 'qq3']);
  assert.deepEqual(accounts.map((a) => a.wsPort), [3001, 3011, 3021]);
  assert.deepEqual(accounts.map((a) => a.httpPort), [3000, 3010, 3020]);
  assert.deepEqual(accounts.map((a) => a.webuiPort), [6099, 6109, 6119]);
  assert.equal(accounts[1].qq, '10002');
  assert.equal(accounts[2].enabled, false);
});

test('配置里删掉 qq1 时自动补回默认号（qq1 是兼容键基准）', () => {
  const { accounts } = normalizeQQAccounts({
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', accessToken: 'tok' },
    platforms: {
      qq: {
        accounts: [
          { id: 'qq2', qq: '10002', wsPort: 3011, httpPort: 3010, webuiPort: 6109 }
        ]
      }
    }
  });
  assert.deepEqual(accounts.map((a) => a.id), ['qq1', 'qq2']);
  assert.equal(accounts[0].token, 'tok');
  assert.equal(accounts[1].wsPort, 3011);
});

test('账号 id 分配不重用空洞（会话键里嵌着 id）', () => {
  assert.equal(nextAccountId([]), 'qq1');
  assert.equal(nextAccountId([{ id: 'qq1' }, { id: 'qq3' }]), 'qq4');
  assert.equal(isValidAccountId('qq12'), true);
  assert.equal(isValidAccountId('QQ12'), false);
  assert.equal(isValidAccountId('../x'), false);
});

test('会话键：qq1 保持旧格式，其余加前缀；规范化可往返', () => {
  assert.equal(isDefaultAccount('qq1'), true);
  assert.equal(isDefaultAccount(''), true);
  assert.equal(scopedConvKey('qq1', 'group', 123), 'group:123');
  assert.equal(scopedConvKey('qq2', 'group', 123), 'qq2:group:123');
  assert.equal(scopedConvKey('qq2', 'private', 123), 'qq2:private:123');

  assert.deepEqual(splitConvKey('group:0123'), { accountId: 'qq1', kind: 'group', id: '123' });
  assert.deepEqual(splitConvKey('qq2:private:456'), { accountId: 'qq2', kind: 'private', id: '456' });
  assert.equal(canonicalConvKey('group:00123'), 'group:123');
  assert.equal(canonicalConvKey('qq2:group:00123'), 'qq2:group:123');

  for (const bad of ['', 'group:', 'qq1:group:0', 'group:abc', 'qq1:qq2:group:1', 'GROUP:1', null]) {
    assert.equal(splitConvKey(bad), null, `应拒绝：${String(bad)}`);
  }
});

test('白名单策略：账号 allow 覆盖全局，deny 取并集，空名单不放开', () => {
  const global = {
    allow: { private: ['1'], groups: ['10'] },
    deny: { private: [], groups: ['99'] },
    allowAllWhenEmpty: true
  };

  // 没配账号策略 → 完全继承
  const inherited = resolveAccountPolicy(global, {});
  assert.deepEqual(inherited.allow, { private: ['1'], groups: ['10'] });
  assert.deepEqual(inherited.deny.groups, ['99']);
  assert.equal(inherited.allowAllWhenEmpty, true);
  assert.equal(policyAllows(inherited, 'group', '10'), true);
  assert.equal(policyAllows(inherited, 'group', '99'), false);

  // 账号自己配了 allow → 只用自己的（不与全局并集）
  const own = resolveAccountPolicy(global, { policy: { allow: { groups: ['20'] } } });
  assert.deepEqual(own.allow.groups, ['20']);
  assert.equal(policyAllows(own, 'group', '10'), false);
  assert.equal(policyAllows(own, 'group', '20'), true);
  // 但全局 deny 依旧生效
  assert.equal(policyAllows(own, 'group', '99'), false);

  // 简写 { groups: [...] } 等价于 allow
  const short = resolveAccountPolicy(global, { policy: { groups: ['30'] } });
  assert.deepEqual(short.allow.groups, ['30']);

  // 账号可以收紧 allowAllWhenEmpty
  const strict = resolveAccountPolicy(global, { policy: { allowAllWhenEmpty: false } });
  assert.equal(strict.allowAllWhenEmpty, false);
  assert.equal(policyAllows(strict, 'private', '777'), false);

  // 通配符
  const wild = resolveAccountPolicy({ allow: { groups: ['*'] }, deny: {} }, {});
  assert.equal(policyAllows(wild, 'group', '123'), true);

  // 单数写法（历史配置）也要认：group / private
  const singular = resolveAccountPolicy({ allow: { group: ['40'], private: ['5'] }, deny: {} }, {});
  assert.equal(policyAllows(singular, 'group', '40'), true);
  assert.equal(policyAllows(singular, 'private', '5'), true);
  const singularOwn = resolveAccountPolicy(global, { policy: { allow: { group: ['50'] } } });
  assert.deepEqual(singularOwn.allow.groups, ['50']);
  assert.equal(policyAllows(singularOwn, 'group', '10'), false);
  assert.equal(policyAllows(singularOwn, 'group', '50'), true);
  const singularDeny = resolveAccountPolicy({ allow: { groups: ['*'] }, deny: { group: ['99'] } }, {});
  assert.equal(policyAllows(singularDeny, 'group', '99'), false);
});

test('toConfigAccount 只保留可落盘字段', () => {
  const account = {
    id: 'qq2',
    qq: '10002',
    enabled: true,
    dir: 'D:\\napcat',
    homeDir: 'D:\\napcat\\app',
    wsPort: 3011,
    httpPort: 3010,
    webuiPort: 6109,
    token: 't',
    label: '小号',
    policy: { groups: ['1'] },
    wsUrl: 'ws://127.0.0.1:3011',
    runtime: { pid: 1 }
  };
  const out = toConfigAccount(account);
  assert.equal(out.wsUrl, undefined);
  assert.equal(out.runtime, undefined);
  assert.deepEqual(out, {
    id: 'qq2',
    qq: '10002',
    enabled: true,
    dir: 'D:\\napcat',
    homeDir: 'D:\\napcat\\app',
    wsPort: 3011,
    httpPort: 3010,
    webuiPort: 6109,
    label: '小号',
    token: 't',
    policy: { groups: ['1'] }
  });
});

test('accountPorts 单调错开且不重叠', () => {
  const a = accountPorts(0);
  const b = accountPorts(1);
  const c = accountPorts(2);
  assert.deepEqual(a, { wsPort: 3001, httpPort: 3000, webuiPort: 6099 });
  assert.deepEqual(b, { wsPort: 3011, httpPort: 3010, webuiPort: 6109 });
  assert.deepEqual(c, { wsPort: 3021, httpPort: 3020, webuiPort: 6119 });
  const all = [a, b, c].flatMap((x) => [x.wsPort, x.httpPort, x.webuiPort]);
  assert.equal(new Set(all).size, all.length);
});
