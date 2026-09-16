import { describe, expect, it } from 'vitest';

import { sharedAuthHeaders, sharedServer } from './helpers/sharedServer';

describe('server-v2 OpenAPI', () => {
  async function fetchOpenApi(): Promise<Record<string, unknown>> {
    const res = await fetch(`${sharedServer().base}/openapi.json`, {
      headers: sharedAuthHeaders(),
    } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    return (await res.json()) as Record<string, unknown>;
  }

  it('returns a valid OpenAPI 3 document', async () => {
    const doc = await fetchOpenApi();

    expect(doc['openapi']).toMatch(/^3\.\d+\.\d+$/);
    const info = asRecord(doc['info']);
    expect(info['title']).toBe('Kimi Code Server API');
    expect(typeof info['version']).toBe('string');
  });

  it('covers the core /api/v1 routes v2 registers', async () => {
    const doc = await fetchOpenApi();
    const paths = asRecord(doc['paths']);

    expect(paths['/api/v1/healthz']).toBeDefined();
    expect(paths['/api/v1/meta']).toBeDefined();
    expect(paths['/api/v1/sessions']).toBeDefined();
    expect(paths['/api/v1/files']).toBeDefined();
    expect(paths['/api/v1/sessions/{session_id}/fs/{*}']).toBeDefined();
  });

  it('projects the session-action dispatcher into archive and delete only', async () => {
    const doc = await fetchOpenApi();
    const paths = asRecord(doc['paths']);

    expect(paths['/api/v1/sessions/{tail}']).toBeUndefined();
    expect(paths['/api/v1/sessions/{session_id}:archive']).toBeDefined();
    expect(paths['/api/v1/sessions/{session_id}:delete']).toBeDefined();
    expect(paths['/api/v1/sessions/{session_id}:fork']).toBeUndefined();
    expect(paths['/api/v1/sessions/{session_id}:undo']).toBeUndefined();

    const archiveOp = operation(doc, '/api/v1/sessions/{session_id}:archive', 'post');
    expect(archiveOp['operationId']).toBe('runSessionArchiveAction');
    const params = archiveOp['parameters'] as Array<Record<string, unknown>>;
    expect(params.some((p) => p['in'] === 'path' && p['name'] === 'session_id')).toBe(true);
    expect(params.some((p) => p['name'] === 'tail')).toBe(false);

    const deleteOp = operation(doc, '/api/v1/sessions/{session_id}:delete', 'post');
    expect(deleteOp['operationId']).toBe('runSessionDeleteAction');
    const deleteParams = deleteOp['parameters'] as Array<Record<string, unknown>>;
    expect(deleteParams.some((p) => p['in'] === 'path' && p['name'] === 'session_id')).toBe(true);
    expect(deleteParams.some((p) => p['name'] === 'tail')).toBe(false);

    const archiveBody = asRecord(archiveOp['requestBody']);
    const archiveSchema = asRecord(
      asRecord(asRecord(archiveBody['content'])['application/json'])['schema'],
    );
    const archiveProperties = asRecord(archiveSchema['properties']);
    expect(archiveProperties['agent_id'], 'abort agent_id body field').toMatchObject({
      type: 'string',
    });
  });

  it('describes the file upload as multipart/form-data', async () => {
    const doc = await fetchOpenApi();
    const uploadOp = operation(doc, '/api/v1/files', 'post');
    const requestBody = asRecord(uploadOp['requestBody']);
    const content = asRecord(requestBody['content']);
    expect(content['multipart/form-data']).toBeDefined();
  });

  it('describes session export as a ZIP or JSON error envelope', async () => {
    const doc = await fetchOpenApi();
    const exportOp = operation(doc, '/api/v1/sessions/{session_id}/export', 'post');
    const responses = asRecord(exportOp['responses']);
    const response = asRecord(responses['200']);
    const content = asRecord(response['content']);
    const headers = asRecord(response['headers']);
    const zipSchema = asRecord(asRecord(content['application/zip'])['schema']);
    const errorSchema = asRecord(asRecord(content['application/json'])['schema']);
    const errorProperties = asRecord(errorSchema['properties']);

    expect(zipSchema).toMatchObject({ type: 'string', format: 'binary' });
    expect(errorProperties).toMatchObject({
      code: expect.any(Object),
      msg: expect.any(Object),
      data: expect.any(Object),
      request_id: expect.any(Object),
    });
    expect(headers['content-disposition']).toBeDefined();
    expect(headers['content-length']).toBeDefined();
    expect(headers['cache-control']).toBeDefined();
  });

  it('projects the fs-action dispatcher into one operation per fs action', async () => {
    const doc = await fetchOpenApi();
    const paths = asRecord(doc['paths']);

    expect(paths['/api/v1/sessions/{session_id}/{tail}']).toBeUndefined();

    const actions = [
      'list',
      'read',
      'list_many',
      'stat',
      'stat_many',
      'mkdir',
      'search',
      'grep',
      'git_status',
      'diff',
      'open',
      'open-in',
      'reveal',
    ];
    const operationIds = new Set<string>();
    for (const action of actions) {
      const path = `/api/v1/sessions/{session_id}/fs:${action}`;
      const op = operation(doc, path, 'post');
      const operationId = `runFs${pascalAction(action)}Action`;
      expect(op['operationId'], path).toBe(operationId);
      operationIds.add(op['operationId'] as string);

      const params = op['parameters'] as Array<Record<string, unknown>>;
      expect(params.some((p) => p['name'] === 'tail'), path).toBe(false);
      expect(
        params.some((p) => p['in'] === 'path' && p['name'] === 'session_id'),
        path,
      ).toBe(true);

      const requestBody = asRecord(op['requestBody']);
      expect(requestBody['required'], path).toBe(true);
      const requestSchema = asRecord(
        asRecord(asRecord(requestBody['content'])['application/json'])['schema'],
      );
      expect(requestSchema['oneOf'], path).toBeUndefined();
      expect(requestSchema['type'], path).toBe('object');

      const responses = asRecord(op['responses']);
      expect(asRecord(responses['200'])['description'], path).toBe(
        `Filesystem ${action} response`,
      );
      const responseSchema = asRecord(
        asRecord(asRecord(asRecord(responses['200'])['content'])['application/json'])['schema'],
      );
      expect(responseSchema['oneOf'], path).toBeUndefined();
    }
    expect(operationIds.size).toBe(actions.length);
  });

  it('projects the plugins action dispatcher into enable, disable, and remove', async () => {
    const doc = await fetchOpenApi();
    const paths = asRecord(doc['paths']);

    expect(paths['/api/v1/plugins/{tail}']).toBeUndefined();

    const operationIds = new Set<string>();
    for (const action of ['enable', 'disable', 'remove']) {
      const path = `/api/v1/plugins/{plugin_id}:${action}`;
      const op = operation(doc, path, 'post');
      expect(op['operationId'], path).toBe(`runPlugin${pascalAction(action)}Action`);
      operationIds.add(op['operationId'] as string);

      const params = op['parameters'] as Array<Record<string, unknown>>;
      expect(params.some((p) => p['name'] === 'tail'), path).toBe(false);
      expect(
        params.some((p) => p['in'] === 'path' && p['name'] === 'plugin_id'),
        path,
      ).toBe(true);
    }
    expect(operationIds.size).toBe(3);
  });

  it('projects the models action dispatcher into set_default', async () => {
    const doc = await fetchOpenApi();
    const paths = asRecord(doc['paths']);

    expect(paths['/api/v1/models/{tail}']).toBeUndefined();

    const path = '/api/v1/models/{model_id}:set_default';
    const op = operation(doc, path, 'post');
    expect(op['operationId']).toBe('setDefaultModel');
    const params = op['parameters'] as Array<Record<string, unknown>>;
    expect(params.some((p) => p['name'] === 'tail')).toBe(false);
    expect(params.some((p) => p['in'] === 'path' && p['name'] === 'model_id')).toBe(true);
  });

  it('projects the mcp server action dispatcher into restart', async () => {
    const doc = await fetchOpenApi();
    const paths = asRecord(doc['paths']);

    expect(paths['/api/v1/mcp/servers/{tail}']).toBeUndefined();

    const path = '/api/v1/mcp/servers/{server_id}:restart';
    const op = operation(doc, path, 'post');
    expect(op['operationId']).toBe('restartMcpServer');
    const params = op['parameters'] as Array<Record<string, unknown>>;
    expect(params.some((p) => p['name'] === 'tail')).toBe(false);
    expect(params.some((p) => p['in'] === 'path' && p['name'] === 'server_id')).toBe(true);
  });

  it('projects the capabilities action dispatcher into install', async () => {
    const doc = await fetchOpenApi();
    const paths = asRecord(doc['paths']);

    expect(paths['/api/v1/capabilities/{tail}']).toBeUndefined();

    const path = '/api/v1/capabilities/{capability_id}:install';
    const op = operation(doc, path, 'post');
    expect(op['operationId']).toBe('installCapability');
    const params = op['parameters'] as Array<Record<string, unknown>>;
    expect(params.some((p) => p['name'] === 'tail')).toBe(false);
    expect(params.some((p) => p['in'] === 'path' && p['name'] === 'capability_id')).toBe(true);
  });

  it('projects the provider collection action dispatcher into refresh and import operations', async () => {
    const doc = await fetchOpenApi();
    const paths = asRecord(doc['paths']);

    expect(paths['/api/v1/providers{action}']).toBeUndefined();

    const refresh = operation(doc, '/api/v1/providers:refresh', 'post');
    expect(refresh['operationId']).toBe('refreshProviders');
    expect(refresh['requestBody']).toBeUndefined();
    expect(hasPathParam(refresh, 'action')).toBe(false);

    const refreshOauth = operation(doc, '/api/v1/providers:refresh_oauth', 'post');
    expect(refreshOauth['operationId']).toBe('refreshOauthProviders');
    expect(refreshOauth['requestBody']).toBeUndefined();
    expect(hasPathParam(refreshOauth, 'action')).toBe(false);

    const importCatalog = operation(doc, '/api/v1/providers:import_catalog', 'post');
    expect(importCatalog['operationId']).toBe('importCatalogProvider');
    expect(hasPathParam(importCatalog, 'action')).toBe(false);
    expect(requiredBodyProperties(importCatalog)).toContain('catalog_id');
    expect(asRecord(asRecord(importCatalog['responses'])['201'])).toBeDefined();

    const importRegistry = operation(doc, '/api/v1/providers:import_registry', 'post');
    expect(importRegistry['operationId']).toBe('importCustomRegistry');
    expect(hasPathParam(importRegistry, 'action')).toBe(false);
    expect(requiredBodyProperties(importRegistry)).toContain('url');
    expect(asRecord(asRecord(importRegistry['responses'])['201'])).toBeDefined();
  });

  it('documents MCP OAuth failures for auth completion', async () => {
    const doc = await fetchOpenApi();
    const authCompleteOp = operation(doc, '/api/v2/mcp/auth:complete', 'post');
    const responses = asRecord(authCompleteOp['responses']);
    const response = asRecord(responses['200']);
    const content = asRecord(response['content']);
    const schema = asRecord(asRecord(content['application/json'])['schema']);
    const variants = schema['oneOf'];

    expect(Array.isArray(variants)).toBe(true);
    expect(
      (variants as unknown[]).some((variant) => {
        const properties = asRecord(asRecord(variant)['properties']);
        const values = asRecord(properties['code'])['enum'];
        return Array.isArray(values) && values.includes(40929);
      }),
    ).toBe(true);
  });
});

describe('server-v2 AsyncAPI', () => {
  async function fetchAsyncApi(): Promise<Record<string, unknown>> {
    const res = await fetch(`${sharedServer().base}/asyncapi.json`, {
      headers: sharedAuthHeaders(),
    } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    return (await res.json()) as Record<string, unknown>;
  }

  function message(doc: Record<string, unknown>, id: string): Record<string, unknown> {
    const components = asRecord(doc['components']);
    const messages = asRecord(components['messages']);
    return asRecord(messages[id]);
  }

  function payloadSchema(messageRecord: Record<string, unknown>): Record<string, unknown> {
    return asRecord(messageRecord['payload']);
  }

  function sentMessageRefs(doc: Record<string, unknown>): readonly string[] {
    const operations = asRecord(doc['operations']);
    const send = asRecord(operations['sendServerMessages']);
    return (send['messages'] as Array<{ $ref: string }>).map((entry) => entry.$ref);
  }

  function literalValues(field: Record<string, unknown>): readonly unknown[] {
    if (Array.isArray(field['enum'])) return field['enum'] as unknown[];
    return field['const'] !== undefined ? [field['const']] : [];
  }

  it('documents the transcript reset and ops stream frames with schemas', async () => {
    const doc = await fetchAsyncApi();

    const reset = message(doc, 'transcript_reset');
    expect(reset['name']).toBe('transcript.reset');
    const resetPayload = asRecord(payloadSchema(reset)['properties']);
    const resetEvent = asRecord(asRecord(resetPayload['payload'])['properties']);
    expect(literalValues(asRecord(resetEvent['type']))).toEqual(['transcript.reset']);
    expect(resetEvent['agent_id']).toBeDefined();
    expect(resetEvent['snapshot']).toBeDefined();
    expect(resetEvent['has_more_older']).toBeDefined();

    const ops = message(doc, 'transcript_ops');
    expect(ops['name']).toBe('transcript.ops');
    const opsPayload = asRecord(payloadSchema(ops)['properties']);
    const opsEvent = asRecord(asRecord(opsPayload['payload'])['properties']);
    expect(literalValues(asRecord(opsEvent['type']))).toEqual(['transcript.ops']);
    expect(opsEvent['agent_id']).toBeDefined();
    expect(opsEvent['ops']).toBeDefined();

    const refs = sentMessageRefs(doc);
    expect(refs).toContain('#/components/messages/transcript_reset');
    expect(refs).toContain('#/components/messages/transcript_ops');
  });

  it('documents the terminal output and exit stream messages with schemas', async () => {
    const doc = await fetchAsyncApi();

    const output = message(doc, 'terminal_output');
    expect(output['name']).toBe('terminal_output');
    const outputPayload = asRecord(payloadSchema(output)['properties']);
    expect(literalValues(asRecord(outputPayload['type']))).toEqual(['terminal_output']);
    expect(outputPayload['terminal_id']).toBeDefined();
    expect(outputPayload['session_id']).toBeDefined();
    expect(asRecord(asRecord(outputPayload['payload'])['properties'])['data']).toBeDefined();

    const exit = message(doc, 'terminal_exit');
    expect(exit['name']).toBe('terminal_exit');
    const exitPayload = asRecord(payloadSchema(exit)['properties']);
    expect(literalValues(asRecord(exitPayload['type']))).toEqual(['terminal_exit']);
    expect(exitPayload['terminal_id']).toBeDefined();
    expect(asRecord(asRecord(exitPayload['payload'])['properties'])['exit_code']).toBeDefined();

    const refs = sentMessageRefs(doc);
    expect(refs).toContain('#/components/messages/terminal_output');
    expect(refs).toContain('#/components/messages/terminal_exit');
  });
});

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('expected object');
  }
  return value as Record<string, unknown>;
}

function hasPathParam(op: Record<string, unknown>, name: string): boolean {
  const params = op['parameters'] as Array<Record<string, unknown>> | undefined;
  return (
    Array.isArray(params) && params.some((p) => p['in'] === 'path' && p['name'] === name)
  );
}

function requiredBodyProperties(op: Record<string, unknown>): readonly string[] {
  const requestBody = asRecord(op['requestBody']);
  const schema = asRecord(asRecord(requestBody['content'])['application/json'])['schema'];
  const required = asRecord(schema)['required'];
  return Array.isArray(required) ? (required as string[]) : [];
}

function pascalAction(action: string): string {
  return action
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join('');
}

function operation(
  doc: Record<string, unknown>,
  path: string,
  method: string,
): Record<string, unknown> {
  const paths = asRecord(doc['paths']);
  const pathItem = asRecord(paths[path]);
  return asRecord(pathItem[method]);
}
