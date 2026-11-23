import { createSshBridge } from '../sshBridge';
import type { SshPreview, SshPreviewError } from '../../types/ssh';

test('preview IPC forwards native shell commands and structured validation unchanged', async () => {
  const preview: SshPreview = {
    argv:['/usr/bin/ssh','-F','none','--','target.test'],
    commands:[{ shell:'sh', label:'sh, bash or zsh', text:'/usr/bin/ssh -F none -- target.test' }],
    storeRevision:6, configNotice:'Native, isolated configuration', wrapper:'Direct',
  };
  const error: SshPreviewError = {
    code:'Validation', message:'Check the SSH connection fields.',
    fields:[{ field:'jumpConnectionId',code:'nested',message:'Invalid jumpConnectionId: nested' }],
  };
  const invoke = jest.fn().mockResolvedValueOnce(preview).mockRejectedValueOnce(error);
  const bridge = createSshBridge(invoke, jest.fn());
  const input = { source:{ kind:'saved' as const, id:'c-target' } };
  await expect(bridge.previewConnection(input)).resolves.toBe(preview);
  await expect(bridge.previewConnection(input)).rejects.toBe(error);
  expect(invoke.mock.calls).toEqual([
    ['ssh_connection_preview',input], ['ssh_connection_preview',input],
  ]);
});
