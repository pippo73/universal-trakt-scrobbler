import { Requests, withHeaders } from '@common/Requests';
import { Shared } from '@common/Shared';

export class ScrobApi {
	requests = Requests;

	isActivated = false;

	async activate(): Promise<void> {
		if (this.isActivated) {
			return;
		}

		const { scrobUrl, scrobApiKey } = Shared.storage.options;
		if (!scrobUrl || !scrobApiKey) {
			return;
		}

		const headers: Record<string, string> = {
			'X-Api-Key': scrobApiKey,
		};

		this.requests = withHeaders(headers, this.requests);
		this.isActivated = true;
	}

	getUrl(path: string): string {
		const { scrobUrl } = Shared.storage.options;
		const base = (scrobUrl || '').replace(/\/+$/, '');
		return `${base}${path}`;
	}
}
