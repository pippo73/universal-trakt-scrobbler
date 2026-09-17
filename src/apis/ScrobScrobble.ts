import { ScrobApi } from '@apis/ScrobApi';
import { ScrobblingDetails } from '@common/BrowserStorage';
import { RequestError } from '@common/RequestError';
import { Shared } from '@common/Shared';
import { createScrobbleItem, ScrobbleItem } from '@models/Item';
import { TraktEpisodeItem, TraktMovieItem } from '@models/TraktItem';

interface ScrobTmdbInfo {
	tmdbId: number;
	mediaType: 'movie' | 'episode';
	seriesTmdbId?: number;
	seasonNumber?: number;
	episodeNumber?: number;
	title: string;
	runtime?: number; // minutes
}

interface ScrobSessionStartResponse {
	session_key: string;
	media_id: number;
	runtime: number | null;
}

// Same threshold as ScrobbleController: below it a stopped item is only paused, not watched.
const WATCHED_THRESHOLD = 80.0;

const tmdbCache = new Map<string, ScrobTmdbInfo | null>();

class _ScrobScrobble extends ScrobApi {
	START = 1;
	PAUSE = 2;
	STOP = 3;

	async start(item: ScrobbleItem): Promise<void> {
		if (!this.isConfigured()) {
			return;
		}
		const info = await this.getTmdbInfo(item);
		if (!info) {
			return;
		}
		const session = await this.sendScrobble<ScrobSessionStartResponse>(
			item,
			this.START,
			'/history/session/start',
			'POST',
			{
				tmdb_id: info.tmdbId,
				media_type: info.mediaType,
				title: info.title,
				runtime: info.runtime,
				show_tmdb_id: info.seriesTmdbId,
				season_number: info.seasonNumber,
				episode_number: info.episodeNumber,
			}
		);
		if (!session) {
			return;
		}

		// Without Trakt, nobody else keeps scrobblingDetails, which the popup and the
		// tab-close handler rely on. With Trakt, TraktScrobble.start() has just written it.
		let { scrobblingDetails } = await Shared.storage.get('scrobblingDetails');
		if (scrobblingDetails?.tabId === Shared.tabId) {
			scrobblingDetails.isPaused = false;
		} else {
			scrobblingDetails = { item: item.save(), tabId: Shared.tabId, isPaused: false };
		}
		scrobblingDetails.scrobSessionKey = session.session_key;
		scrobblingDetails.scrobRuntime = session.runtime ?? info.runtime;
		await Shared.storage.set({ scrobblingDetails }, false);
		if (!item.trakt) {
			await Shared.events.dispatch('SCROBBLE_START', null, scrobblingDetails);
		}
	}

	async progress(item: ScrobbleItem): Promise<void> {
		const details = await this.getSessionDetails();
		if (!details) {
			return;
		}
		await this.update(item, details, 'playing');
	}

	async pause(item: ScrobbleItem): Promise<void> {
		const details = await this.getSessionDetails();
		if (!details) {
			return;
		}
		await this.update(item, details, 'paused', this.PAUSE);
		if (!item.trakt) {
			details.isPaused = true;
			await Shared.storage.set({ scrobblingDetails: details }, false);
			await Shared.events.dispatch('SCROBBLE_PAUSE', null, details);
		}
	}

	/**
	 * Called both from the content script (with the item) and from the background when the
	 * tab closes (without it). Leaves removing scrobblingDetails to TraktScrobble.stop(),
	 * which always runs right after and does it even when not logged in to Trakt.
	 */
	async stop(item?: ScrobbleItem): Promise<void> {
		const details = await this.getSessionDetails();
		if (!details) {
			return;
		}
		if (!item) {
			item = createScrobbleItem(details.item);
		}
		const key = encodeURIComponent(details.scrobSessionKey);
		if (item.progress >= WATCHED_THRESHOLD) {
			await this.sendScrobble(item, this.STOP, `/history/session/${key}/complete`, 'POST');
		} else {
			// Pausing keeps the partial progress in Scrob's "continue watching";
			// deleting the session would throw it away.
			await this.update(item, details, 'paused', this.STOP);
		}
		if (!item.trakt) {
			await Shared.events.dispatch('SCROBBLE_STOP', null, details);
		}
	}

	async syncHistory(item: ScrobbleItem): Promise<boolean> {
		if (!this.isConfigured()) {
			return false;
		}
		const info = await this.getTmdbInfo(item);
		if (!info) {
			Shared.errors.log(`Scrob: no TMDB match for "${item.getFullTitle()}"`, new Error());
			return false;
		}
		try {
			await this.send('/history', 'POST', {
				tmdb_id: info.tmdbId,
				media_type: info.mediaType,
				series_tmdb_id: info.seriesTmdbId,
				season_number: info.seasonNumber,
				episode_number: info.episodeNumber,
				// Service dates are unix seconds; an unknown date is sent as null, not "now".
				watched_at: item.watchedAt ? new Date(item.watchedAt * 1000).toISOString() : null,
				completed: true,
			});
		} catch (err) {
			// 409 = Scrob already has this watch inside its dedup window.
			if (err instanceof RequestError && err.status === 409) {
				return true;
			}
			throw err;
		}
		return true;
	}

	private async getSessionDetails(): Promise<
		(ScrobblingDetails & { scrobSessionKey: string }) | null
	> {
		if (!this.isConfigured()) {
			return null;
		}
		const { scrobblingDetails } = await Shared.storage.get('scrobblingDetails');
		if (!scrobblingDetails?.scrobSessionKey) {
			return null;
		}
		return scrobblingDetails as ScrobblingDetails & { scrobSessionKey: string };
	}

	private async update(
		item: ScrobbleItem,
		details: ScrobblingDetails & { scrobSessionKey: string },
		state: 'playing' | 'paused',
		scrobbleType?: number
	): Promise<void> {
		const runtimeSeconds = (details.scrobRuntime ?? 0) * 60;
		await this.sendScrobble(
			item,
			scrobbleType,
			`/history/session/${encodeURIComponent(details.scrobSessionKey)}`,
			'PATCH',
			{
				progress_seconds: Math.round((runtimeSeconds * item.progress) / 100),
				state,
			}
		);
	}

	private async sendScrobble<T>(
		item: ScrobbleItem,
		scrobbleType: number | undefined,
		path: string,
		method: string,
		body?: unknown
	): Promise<T | null> {
		try {
			const response = await this.send<T>(path, method, body);
			if (scrobbleType && !item.trakt) {
				await Shared.events.dispatch('SCROBBLE_SUCCESS', null, {
					item: this.getNotificationItem(item),
					scrobbleType,
				});
			}
			return response;
		} catch (err) {
			if (Shared.errors.validate(err)) {
				Shared.errors.log(`Scrob: ${method} ${path} failed`, err);
				if (scrobbleType && !item.trakt) {
					await Shared.events.dispatch('SCROBBLE_ERROR', null, {
						item: this.getNotificationItem(item),
						scrobbleType,
						error: err as Error,
					});
				}
			}
			return null;
		}
	}

	// Notifications only read the title from the item.
	private getNotificationItem(item: ScrobbleItem) {
		return { title: item.getFullTitle() } as never;
	}

	private async getTmdbInfo(item: ScrobbleItem): Promise<ScrobTmdbInfo | null> {
		if (item.trakt instanceof TraktEpisodeItem) {
			return {
				tmdbId: item.trakt.tmdbId,
				mediaType: 'episode',
				seriesTmdbId: item.trakt.show.tmdbId,
				seasonNumber: item.trakt.season,
				episodeNumber: item.trakt.number,
				title: item.getFullTitle(),
			};
		}
		if (item.trakt instanceof TraktMovieItem) {
			return { tmdbId: item.trakt.tmdbId, mediaType: 'movie', title: item.getFullTitle() };
		}

		const key =
			item.type === 'episode'
				? `${item.serviceId}_ep_${item.show.title}_s${item.season}_e${item.number}`
				: `${item.serviceId}_mv_${item.title}_${item.year}`;
		if (tmdbCache.has(key)) {
			return tmdbCache.get(key) ?? null;
		}
		let result: ScrobTmdbInfo | null = null;
		try {
			result = item.type === 'movie' ? await this.findMovie(item) : await this.findEpisode(item);
		} catch (err) {
			// Not cached: a network error should be retried on the next call.
			Shared.errors.log(`Scrob: TMDB lookup failed for "${item.getFullTitle()}"`, err as Error);
			return null;
		}
		tmdbCache.set(key, result);
		return result;
	}

	// Title lookups go through Scrob, which holds the TMDB key: the extension needs none.
	private async findMovie(item: ScrobbleItem): Promise<ScrobTmdbInfo | null> {
		if (item.type !== 'movie') {
			return null;
		}
		const match = await this.search(item.title, 'movie', item.year);
		return match ? { tmdbId: match.tmdb_id, mediaType: 'movie', title: item.title } : null;
	}

	private async findEpisode(item: ScrobbleItem): Promise<ScrobTmdbInfo | null> {
		if (item.type !== 'episode' || !item.season || !item.number) {
			return null;
		}
		const show = await this.search(item.show.title, 'series', item.show.year);
		if (!show) {
			return null;
		}
		const episode = await this.send<{ tmdb_id?: number; runtime?: number }>(
			`/shows/${show.tmdb_id}/season/${item.season}/${item.number}`,
			'GET'
		);
		if (!episode?.tmdb_id) {
			return null;
		}
		return {
			tmdbId: episode.tmdb_id,
			mediaType: 'episode',
			seriesTmdbId: show.tmdb_id,
			seasonNumber: item.season,
			episodeNumber: item.number,
			title: item.getFullTitle(),
			runtime: episode.runtime || undefined,
		};
	}

	private async search(
		title: string,
		type: 'movie' | 'series',
		year?: number
	): Promise<{ tmdb_id: number } | null> {
		const response = await this.send<{
			results?: { tmdb_id: number | null; type: string; release_date?: string | null }[];
		}>(`/media/search?q=${encodeURIComponent(title)}&type=${type}`, 'GET');
		const results = (response?.results ?? []).filter(
			(r): r is { tmdb_id: number; type: string; release_date?: string | null } =>
				r.type === type && !!r.tmdb_id
		);
		return (
			(year && results.find((r) => r.release_date?.startsWith(`${year}`))) || results[0] || null
		);
	}
}

export const ScrobScrobble = new _ScrobScrobble();
