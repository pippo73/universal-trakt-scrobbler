import { Requests, withHeaders } from '@common/Requests';
import { Shared } from '@common/Shared';

// Scrob serves its backend through the frontend at /api/proxy, which forwards X-Api-Key.
const PROXY_PATH = '/api/proxy';

export class ScrobApi {
	requests = Requests;

	private activatedKey = '';

	isConfigured(): boolean {
		const { scrobUrl, scrobApiKey } = Shared.storage.options;
		return !!(scrobUrl && scrobApiKey);
	}

	activate(): void {
		const { scrobApiKey } = Shared.storage.options;
		if (this.activatedKey === scrobApiKey) {
			return;
		}
		this.requests = withHeaders({ 'X-Api-Key': scrobApiKey }, Requests);
		this.activatedKey = scrobApiKey;
	}

	getUrl(path: string): string {
		let base = (Shared.storage.options.scrobUrl || '').trim().replace(/\/+$/, '');
		if (!base.endsWith(PROXY_PATH)) {
			base = `${base}${PROXY_PATH}`;
		}
		return `${base}${path}`;
	}

	async send<T>(path: string, method: string, body?: unknown): Promise<T | null> {
		this.activate();
		const responseText = await this.requests.send({
			url: this.getUrl(path),
			method,
			...(body ? { body } : {}),
		});
		return responseText ? (JSON.parse(responseText) as T) : null;
	}
}
