import {
  fsDiffRequestSchema,
  fsDiffResponseSchema,
  fsGitStatusRequestSchema,
  fsGitStatusResponseSchema,
} from '@moonshot-ai/agent-core-v2/app/git/git';
import {
  fsGrepRequestSchema,
  fsGrepResponseSchema,
  fsListManyRequestSchema,
  fsListManyResponseSchema,
  fsListRequestSchema,
  fsListResponseSchema,
  fsMkdirRequestSchema,
  fsMkdirResponseSchema,
  fsReadRequestSchema,
  fsReadResponseSchema,
  fsSearchRequestSchema,
  fsSearchResponseSchema,
  fsStatManyRequestSchema,
  fsStatManyResponseSchema,
  fsStatRequestSchema,
  fsStatResponseSchema,
} from '@moonshot-ai/agent-core-v2/workspace/workspaceFs/fs';
import { z } from 'zod';

import {
  openApiDocumentEnvelopeJsonSchema,
  openApiDocumentJsonSchema,
} from '../middleware/schema';
import {
  fsOpenInRequestSchema,
  fsOpenInResponseSchema,
  fsOpenRequestSchema,
  fsOpenResponseSchema,
  fsRevealRequestSchema,
  fsRevealResponseSchema,
} from '../protocol/rest-fs';
import {
  questionDismissResultSchema,
  questionResolveRequestSchema,
  questionResolveResultSchema,
} from '../protocol/rest-question';
import {
  importCatalogProviderResponseSchema,
  importCustomRegistryResponseSchema,
  providerCollectionActionBodySchema,
} from '../protocol/rest-modelCatalog';
import {
  archiveSessionResponseSchema,
  deleteSessionResponseSchema,
} from '../protocol/rest-session';

const binarySchema = {
  type: 'string',
  format: 'binary',
} as const;

const fileUploadMultipartSchema = {
  type: 'object',
  properties: {
    file: binarySchema,
    name: { type: 'string' },
    expires_in_sec: { type: 'number', minimum: 0 },
  },
  required: ['file'],
} as const;

const errorEnvelopeSchema = openApiDocumentEnvelopeJsonSchema(z.null());

const questionResponseSchema = {
  oneOf: [
    openApiDocumentEnvelopeJsonSchema(questionResolveResultSchema),
    openApiDocumentEnvelopeJsonSchema(questionDismissResultSchema),
  ],
} as const;

const importCatalogProviderBodySchema = providerCollectionActionBodySchema.required({
  catalog_id: true,
});

const importRegistryBodySchema = providerCollectionActionBodySchema.required({
  url: true,
});

const fsActionSchemas = [
  { action: 'list', request: fsListRequestSchema, response: fsListResponseSchema },
  { action: 'read', request: fsReadRequestSchema, response: fsReadResponseSchema },
  {
    action: 'list_many',
    request: fsListManyRequestSchema,
    response: fsListManyResponseSchema,
  },
  { action: 'stat', request: fsStatRequestSchema, response: fsStatResponseSchema },
  {
    action: 'stat_many',
    request: fsStatManyRequestSchema,
    response: fsStatManyResponseSchema,
  },
  { action: 'mkdir', request: fsMkdirRequestSchema, response: fsMkdirResponseSchema },
  { action: 'search', request: fsSearchRequestSchema, response: fsSearchResponseSchema },
  { action: 'grep', request: fsGrepRequestSchema, response: fsGrepResponseSchema },
  {
    action: 'git_status',
    request: fsGitStatusRequestSchema,
    response: fsGitStatusResponseSchema,
  },
  { action: 'diff', request: fsDiffRequestSchema, response: fsDiffResponseSchema },
  { action: 'open', request: fsOpenRequestSchema, response: fsOpenResponseSchema },
  { action: 'open-in', request: fsOpenInRequestSchema, response: fsOpenInResponseSchema },
  { action: 'reveal', request: fsRevealRequestSchema, response: fsRevealResponseSchema },
] as const satisfies ReadonlyArray<{
  readonly action: string;
  readonly request: z.ZodTypeAny;
  readonly response: z.ZodTypeAny;
}>;

interface ActionRouteProjection {
  readonly path: string;
  readonly operationId: string;
  readonly description?: string;
  readonly renameTailTo?: string;
  readonly removeParams?: readonly string[];
  readonly dropRequestBody?: boolean;
  readonly requestBody?: Record<string, unknown>;
  readonly responses?: Record<string, Record<string, unknown>>;
}

export function transformOpenApiDocument(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const paths = asRecord(document['paths']);
  if (paths === undefined) return document;

  patchFileUpload(paths);
  patchFileDownload(paths);
  patchSessionExport(paths);
  expandSessionActions(paths);
  expandFsActions(paths);
  expandPluginActions(paths);
  expandModelActions(paths);
  expandMcpServerActions(paths);
  expandCapabilityActions(paths);
  expandProviderCollectionActions(paths);
  patchFsDownload(paths);
  patchQuestionResolveOrDismiss(paths);

  return document;
}

function patchSessionExport(paths: Record<string, unknown>): void {
  const operation = getOperation(paths, '/api/v1/sessions/{session_id}/export', 'post');
  if (operation === undefined) return;

  setResponse(operation, '200', {
    description: 'Session export archive or JSON error envelope',
    headers: {
      'content-disposition': headerString(),
      'content-length': headerInteger(),
      'cache-control': headerString(),
    },
    content: {
      'application/zip': {
        schema: binarySchema,
      },
      ...jsonContent(errorEnvelopeSchema),
    },
  });
}

function patchFileUpload(paths: Record<string, unknown>): void {
  const operation = getOperation(paths, '/api/v1/files', 'post');
  if (operation === undefined) return;

  operation['requestBody'] = {
    required: true,
    content: {
      'multipart/form-data': {
        schema: fileUploadMultipartSchema,
      },
    },
  };
}

function patchFileDownload(paths: Record<string, unknown>): void {
  const operation = getOperation(paths, '/api/v1/files/{file_id}', 'get');
  if (operation === undefined) return;

  setResponse(operation, '200', {
    description: 'Binary file download',
    headers: {
      'content-disposition': headerString(),
      'content-length': headerInteger(),
      etag: headerString(),
    },
    content: {
      'application/octet-stream': {
        schema: binarySchema,
      },
    },
  });
  setResponse(operation, '404', {
    description: 'File not found',
    content: jsonContent(errorEnvelopeSchema),
  });
}

function expandSessionActions(paths: Record<string, unknown>): void {
  projectActionRoutes(paths, '/api/v1/sessions/{tail}', 'post', [
    {
      path: '/api/v1/sessions/{session_id}:archive',
      operationId: 'runSessionArchiveAction',
      renameTailTo: 'session_id',
      responses: {
        '200': {
          description: 'Session archive response',
          content: jsonContent(
            openApiDocumentEnvelopeJsonSchema(archiveSessionResponseSchema),
          ),
        },
      },
    },
    {
      path: '/api/v1/sessions/{session_id}:delete',
      operationId: 'runSessionDeleteAction',
      renameTailTo: 'session_id',
      responses: {
        '200': {
          description: 'Session delete response',
          content: jsonContent(
            openApiDocumentEnvelopeJsonSchema(deleteSessionResponseSchema),
          ),
        },
      },
    },
  ]);
}

function expandFsActions(paths: Record<string, unknown>): void {
  projectActionRoutes(
    paths,
    '/api/v1/sessions/{session_id}/{tail}',
    'post',
    fsActionSchemas.map(({ action, request, response }) => ({
      path: `/api/v1/sessions/{session_id}/fs:${action}`,
      operationId: `runFs${pascalActionName(action)}Action`,
      description: `Filesystem ${action} action for the session workspace.`,
      removeParams: ['tail'],
      requestBody: requiredJsonBody(openApiDocumentJsonSchema(request)),
      responses: {
        '200': {
          description: `Filesystem ${action} response`,
          content: jsonContent(openApiDocumentEnvelopeJsonSchema(response)),
        },
      },
    })),
  );
}

function expandPluginActions(paths: Record<string, unknown>): void {
  projectActionRoutes(paths, '/api/v1/plugins/{tail}', 'post', [
    {
      path: '/api/v1/plugins/{plugin_id}:enable',
      operationId: 'runPluginEnableAction',
      description: 'Enable an installed plugin',
      renameTailTo: 'plugin_id',
    },
    {
      path: '/api/v1/plugins/{plugin_id}:disable',
      operationId: 'runPluginDisableAction',
      description: 'Disable an installed plugin',
      renameTailTo: 'plugin_id',
    },
    {
      path: '/api/v1/plugins/{plugin_id}:remove',
      operationId: 'runPluginRemoveAction',
      description: 'Remove an installed plugin',
      renameTailTo: 'plugin_id',
    },
  ]);
}

function expandModelActions(paths: Record<string, unknown>): void {
  projectActionRoutes(paths, '/api/v1/models/{tail}', 'post', [
    {
      path: '/api/v1/models/{model_id}:set_default',
      operationId: 'setDefaultModel',
      renameTailTo: 'model_id',
    },
  ]);
}

function expandMcpServerActions(paths: Record<string, unknown>): void {
  projectActionRoutes(paths, '/api/v1/mcp/servers/{tail}', 'post', [
    {
      path: '/api/v1/mcp/servers/{server_id}:restart',
      operationId: 'restartMcpServer',
      renameTailTo: 'server_id',
    },
  ]);
}

function expandCapabilityActions(paths: Record<string, unknown>): void {
  projectActionRoutes(paths, '/api/v1/capabilities/{tail}', 'post', [
    {
      path: '/api/v1/capabilities/{capability_id}:install',
      operationId: 'installCapability',
      renameTailTo: 'capability_id',
    },
  ]);
}

function expandProviderCollectionActions(paths: Record<string, unknown>): void {
  projectActionRoutes(paths, '/api/v1/providers{action}', 'post', [
    {
      path: '/api/v1/providers:refresh',
      operationId: 'refreshProviders',
      description: 'Refresh model metadata for all configured providers.',
      removeParams: ['action'],
      dropRequestBody: true,
    },
    {
      path: '/api/v1/providers:refresh_oauth',
      operationId: 'refreshOauthProviders',
      description: 'Refresh model metadata for OAuth-backed providers only.',
      removeParams: ['action'],
      dropRequestBody: true,
    },
    {
      path: '/api/v1/providers:import_catalog',
      operationId: 'importCatalogProvider',
      description: 'Import a models.dev directory entry as a configured provider (201).',
      removeParams: ['action'],
      requestBody: requiredJsonBody(
        openApiDocumentJsonSchema(importCatalogProviderBodySchema),
      ),
      responses: {
        '201': {
          description: 'Provider imported from the catalog',
          content: jsonContent(
            openApiDocumentEnvelopeJsonSchema(importCatalogProviderResponseSchema),
          ),
        },
      },
    },
    {
      path: '/api/v1/providers:import_registry',
      operationId: 'importCustomRegistry',
      description: 'Import a models.dev-shaped private registry as configured providers (201).',
      removeParams: ['action'],
      requestBody: requiredJsonBody(openApiDocumentJsonSchema(importRegistryBodySchema)),
      responses: {
        '201': {
          description: 'Registry imported',
          content: jsonContent(
            openApiDocumentEnvelopeJsonSchema(importCustomRegistryResponseSchema),
          ),
        },
      },
    },
  ]);
}

function projectActionRoutes(
  paths: Record<string, unknown>,
  sourcePath: string,
  method: string,
  projections: readonly ActionRouteProjection[],
): void {
  const pathItem = asRecord(paths[sourcePath]);
  if (pathItem === undefined || asRecord(pathItem[method]) === undefined) return;

  for (const projection of projections) {
    const cloned = cloneRecord(pathItem);
    if (projection.removeParams !== undefined) {
      removePathParams(cloned, projection.removeParams);
    }
    if (projection.renameTailTo !== undefined) {
      replacePathParamName(cloned, 'tail', projection.renameTailTo);
    }
    const clonedOperation = asRecord(cloned[method]);
    if (clonedOperation !== undefined) {
      clonedOperation['operationId'] = projection.operationId;
      if (projection.description !== undefined) {
        clonedOperation['description'] = projection.description;
      }
      if (projection.dropRequestBody === true) {
        delete clonedOperation['requestBody'];
      }
      if (projection.requestBody !== undefined) {
        clonedOperation['requestBody'] = projection.requestBody;
      }
      if (projection.responses !== undefined) {
        for (const [statusCode, response] of Object.entries(projection.responses)) {
          setResponse(clonedOperation, statusCode, response);
        }
      }
    }
    paths[projection.path] = cloned;
  }
  delete paths[sourcePath];
}

function patchFsDownload(paths: Record<string, unknown>): void {
  const operation = getOperation(paths, '/api/v1/sessions/{session_id}/fs/{*}', 'get');
  if (operation === undefined) return;

  setResponse(operation, '200', {
    description: 'Binary workspace file download',
    headers: {
      'content-disposition': headerString(),
      'content-length': headerInteger(),
      etag: headerString(),
      'last-modified': headerString(),
    },
    content: {
      'application/octet-stream': {
        schema: binarySchema,
      },
    },
  });
  setResponse(operation, '206', {
    description: 'Partial binary workspace file download',
    headers: {
      'content-disposition': headerString(),
      'content-length': headerInteger(),
      'content-range': headerString(),
      etag: headerString(),
      'last-modified': headerString(),
    },
    content: {
      'application/octet-stream': {
        schema: binarySchema,
      },
    },
  });
  setResponse(operation, '304', {
    description: 'Not modified',
    headers: {
      etag: headerString(),
    },
  });
}

function patchQuestionResolveOrDismiss(paths: Record<string, unknown>): void {
  const operation = getOperation(paths, '/api/v1/sessions/{session_id}/questions/{tail}', 'post');
  if (operation === undefined) return;

  operation['description'] = appendDescription(
    operation['description'],
    'Resolve uses the question response body; `:dismiss` sends an empty body.',
  );
  operation['requestBody'] = {
    required: false,
    content: jsonContent(openApiDocumentJsonSchema(questionResolveRequestSchema)),
  };
  setResponse(operation, '200', {
    description: 'Question resolved or dismissed',
    content: jsonContent(questionResponseSchema),
  });
}

function getOperation(
  paths: Record<string, unknown>,
  path: string,
  method: string,
): Record<string, unknown> | undefined {
  const pathItem = asRecord(paths[path]);
  if (pathItem === undefined) return undefined;
  return asRecord(pathItem[method]);
}

function setResponse(
  operation: Record<string, unknown>,
  statusCode: string,
  response: Record<string, unknown>,
): void {
  const responses = asRecord(operation['responses']) ?? {};
  responses[statusCode] = response;
  operation['responses'] = responses;
}

function jsonContent(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    'application/json': {
      schema,
    },
  };
}

function requiredJsonBody(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    required: true,
    content: jsonContent(schema),
  };
}

function pascalActionName(action: string): string {
  return action
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join('');
}

function removePathParams(container: Record<string, unknown>, names: readonly string[]): void {
  const params = container['parameters'];
  if (Array.isArray(params)) {
    container['parameters'] = params.filter((param) => {
      const record = asRecord(param);
      return !(record?.['in'] === 'path' && names.includes(record['name'] as string));
    });
  }

  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const operation = asRecord(container[method]);
    if (operation !== undefined) {
      removePathParams(operation, names);
    }
  }
}

function headerString(): Record<string, unknown> {
  return {
    schema: {
      type: 'string',
    },
  };
}

function headerInteger(): Record<string, unknown> {
  return {
    schema: {
      type: 'integer',
    },
  };
}

function appendDescription(existing: unknown, extra: string): string {
  if (typeof existing !== 'string' || existing.length === 0) return extra;
  return `${existing} ${extra}`;
}

function replacePathParamName(
  container: Record<string, unknown>,
  from: string,
  to: string,
): void {
  const params = container['parameters'];
  if (Array.isArray(params)) {
    for (const param of params) {
      const record = asRecord(param);
      if (record?.['in'] === 'path' && record['name'] === from) {
        record['name'] = to;
      }
    }
  }

  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const operation = asRecord(container[method]);
    if (operation !== undefined) {
      replacePathParamName(operation, from, to);
    }
  }
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return value as Record<string, unknown>;
}
