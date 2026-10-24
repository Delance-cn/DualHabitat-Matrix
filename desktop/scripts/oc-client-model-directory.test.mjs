import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeApiClient } from '../../src/oc-client.js';

test('validates model candidates against the configured session workspace directory', async () => {
  const modelDirectory = 'C:\\workspace\\sessions';
  const client = new NodeApiClient(undefined, undefined, { modelDirectory });
  client._chain = { restrictTo: () => [] };
  let request;
  await client._validateChainCandidates({
    model: {
      list: async (params) => {
        request = params;
        return { data: [] };
      }
    }
  });

  assert.deepEqual(request, { location: { directory: modelDirectory } });
});
