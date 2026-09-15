export interface NtfyPublishOptions {
  readonly topic: string;
  readonly message: string;
  readonly title?: string;
  readonly priority?: number;
  readonly tags?: readonly string[];
  readonly click?: string;
  readonly clear?: boolean;
}

export interface NtfyClient {
  publish(options: NtfyPublishOptions): Promise<void>;
}

export interface HttpNtfyClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetch?: typeof fetch;
}

export function createHttpNtfyClient(options: HttpNtfyClientOptions): NtfyClient {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/`;
  return {
    async publish(message: NtfyPublishOptions): Promise<void> {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.token !== undefined && options.token.length > 0) {
        headers['authorization'] = `Bearer ${options.token}`;
      }
      const response = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          topic: message.topic,
          title: message.title,
          message: message.message,
          priority: message.priority,
          tags: message.tags,
          click: message.click,
          clear: message.clear === true ? true : undefined,
        }),
      });
      if (!response.ok) {
        throw new Error(`ntfy publish failed with status ${response.status}`);
      }
    },
  };
}
