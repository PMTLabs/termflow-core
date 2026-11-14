import { buildSshArgv } from '../buildSshArgv';
const target = { host:'h', port:2222, user:'deploy', auth:'keyFile' as const, identityFile:'C:\\k ey' };
test('full exact option order, single destination last, path stays one token', () => {
  expect(buildSshArgv({ hops:[target], extraOptions:[['ServerAliveInterval','30']] })).toEqual(['-p','2222','-i','C:\\k ey','-o','ServerAliveInterval=30','deploy@h']);
});
test('port 22 omitted', () => { expect(buildSshArgv({ hops:[{ ...target, port:22 }], extraOptions:[] })).toEqual(['-i','C:\\k ey','deploy@h']); });
test('agent has no identity option', () => { expect(buildSshArgv({ hops:[{ ...target, auth:'agent' }], extraOptions:[] })).toEqual(['-p','2222','deploy@h']); });
test('blank user produces bare host', () => { expect(buildSshArgv({ hops:[{ ...target, user:'', auth:'agent', port:22 }], extraOptions:[] })).toEqual(['h']); });
test.each(['::1','[::1]'])('IPv6 positional destination is bare, jump retains brackets: %s', host => {
  expect(buildSshArgv({hops:[{...target,host,auth:'agent',port:22}],extraOptions:[]})).toEqual(['deploy@::1']);
  expect(buildSshArgv({hops:[{...target,host,auth:'agent',port:2200},{...target,host,auth:'agent',port:22}],extraOptions:[]})).toEqual(['-J','deploy@[::1]:2200','deploy@::1']);
});
test('bare IPv6 destination with port option', () => { expect(buildSshArgv({ hops:[{ ...target, host:'::1', user:'', auth:'agent' }], extraOptions:[] })).toEqual(['-p','2222','::1']); });
test('jump without identity is -J before destination', () => { expect(buildSshArgv({ hops:[{ host:'j',port:2200,user:'u',auth:'agent',identityFile:null }, { ...target,port:22,auth:'agent' }], extraOptions:[] })).toEqual(['-J','u@j:2200','deploy@h']); });
