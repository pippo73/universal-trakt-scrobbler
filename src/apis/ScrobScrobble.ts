import { ScrobApi } from '@apis/ScrobApi';
import { TmdbApi } from '@apis/TmdbApi';
import { Shared } from '@common/Shared';
import { ScrobbleItem } from '@models/Item';
import { TraktEpisodeItem, TraktMovieItem } from '@models/TraktItem';

interface ScrobTmdbInfo {
	tmdbId: number;
	mediaType: 'movie' | 'episode';
	seriesTmdbId?: number;
	seasonNumber?: number;
	episodeNumber?: number;
}

interface ScrobWatchData {
	tmdb_id: number;
	media_type: 'movie' | 'episode';
	series_tmdb_id?: number;
	season_number?: number;
	episode_number?: number;
	watched_at?: string;
	completed: boolean;
}

const tmdbCache = new Map<string, ScrobTmdbInfo | null>();

class _ScrobScrobble extends ScrobApi {
	isConfigured(): boolean {
		const { scrobUrl, scrobApiKey } = Shared.storage.options;
		return !!(scrobUrl && scrobApiKey);
	}

	async start(item: ScrobbleItem): Promise<void> {
		if (!this.isConfigured()) {
			return;
		}
		// Pre-resolve TMDB info so it's ready when stop() is called.
		if (!this.getTmdbFromTrakt(item)) {
			const key = this.getCacheKey(item);
			if (!tmdbCache.has(key)) {
				this.resolveAndCacheTmdb(item).catch(() => {
					// Resolution will be retried on stop() if needed.
				});
			}
		}
	}

	async pause(_item: ScrobbleItem): Promise<void> {
		// Scrob doesn't have real-time pause tracking via API.
	}

	async stop(item?: ScrobbleItem): Promise<void> {
		if (!this.isConfigured()) {
			return;
		}

		const { scrobblingDetails } = await Shared.storage.get('scrobblingDetails');
		if (!scrobblingDetails && !item) {
			return;
		}
		if (!item && scrobblingDetails) {
			const { createScrobbleItem } = await import('@models/Item');
			item = createScrobbleItem(scrobblingDetails.item);
		}
		if (!item) {
			return;
		}

		const tmdbInfo = await this.getTmdbInfo(item);
		if (!tmdbInfo) {
			return;
		}

		const completed = (item.trakt?.progress ?? item.progress ?? 0) >= 80;
		const data: ScrobWatchData = {
			tmdb_id: tmdbInfo.tmdbId,
			media_type: tmdbInfo.mediaType,
			...(tmdbInfo.seriesTmdbId ? { series_tmdb_id: tmdbInfo.seriesTmdbId } : {}),
			...(tmdbInfo.seasonNumber ? { season_number: tmdbInfo.seasonNumber } : {}),
			...(tmdbInfo.episodeNumber ? { episode_number: tmdbInfo.episodeNumber } : {}),
			watched_at: item.watchedAt ? new Date(item.watchedAt).toISOString() : undefined,
			completed,
		};

		await this.send(data);
	}

	private getTmdbFromTrakt(item: ScrobbleItem): ScrobTmdbInfo | null {
		if (!item.trakt) {
			return null;
		}
		if (item.trakt instanceof TraktEpisodeItem) {
			return {
				tmdbId: item.trakt.tmdbId,
				mediaType: 'episode',
				seriesTmdbId: item.trakt.show.tmdbId,
				seasonNumber: item.trakt.season,
				episodeNumber: item.trakt.number,
			};
		}
		if (item.trakt instanceof TraktMovieItem) {
			return {
				tmdbId: item.trakt.tmdbId,
				mediaType: 'movie',
			};
		}
		return null;
	}

	private async getTmdbInfo(item: ScrobbleItem): Promise<ScrobTmdbInfo | null> {
		const fromTrakt = this.getTmdbFromTrakt(item);
		if (fromTrakt) {
			return fromTrakt;
		}
		return this.resolveAndCacheTmdb(item);
	}

	private getCacheKey(item: ScrobbleItem): string {
		if (item.type === 'episode') {
			return `${item.serviceId}_ep_${item.show.title}_s${item.season}_e${item.number}`;
		}
		return `${item.serviceId}_mv_${item.title}_${item.year}`;
	}

	private async resolveAndCacheTmdb(item: ScrobbleItem): Promise<ScrobTmdbInfo | null> {
		const key = this.getCacheKey(item);
		const cached = tmdbCache.get(key);
		if (cached !== undefined) {
			return cached;
		}

		let result: ScrobTmdbInfo | null = null;

		try {
			if (item.type === 'movie') {
				const tmdbId = await this.searchMovie(item.title, item.year);
				if (tmdbId) {
					result = { tmdbId, mediaType: 'movie' };
				}
			} else if (item.type === 'episode') {
				const showTmdb = await TmdbApi.searchTvShow(
					item.show.title,
					item.show.year,
					item.serviceId
				);
				if (showTmdb) {
					const tmdbEpId = await this.searchEpisode(showTmdb.id, item.season, item.number);
					if (tmdbEpId) {
						result = {
							tmdbId: tmdbEpId,
							mediaType: 'episode',
							seriesTmdbId: showTmdb.id,
							seasonNumber: item.season,
							episodeNumber: item.number,
						};
					}
				}
			}
		} catch (_err) {
			// Resolution failed, will try again later
		}

		tmdbCache.set(key, result);
		return result;
	}

	private async searchMovie(title: string, year: number): Promise<number | null> {
		if (!Shared.tmdbApiKey) {
			console.warn('[UTS] TMDb API key is not set, skipping movie search');
			return null;
		}
		try {
			const url = `https://api.themoviedb.org/3/search/movie?api_key=${Shared.tmdbApiKey}&query=${encodeURIComponent(title)}`;
			const responseText = await this.requests.send({ url, method: 'GET' });
			const response = JSON.parse(responseText) as {
				results?: { id: number; title: string; release_date?: string }[];
			};

			if (!response.results?.length) {
				return null;
			}

			if (year) {
				const match = response.results.find((r) => {
					if (!r.release_date) return false;
					return parseInt(r.release_date.split('-')[0], 10) === year;
				});
				if (match) return match.id;
			}

			return response.results[0].id;
		} catch (_err) {
			return null;
		}
	}

	private async searchEpisode(
		showTmdbId: number,
		season: number,
		episode: number
	): Promise<number | null> {
		try {
			const url = `https://api.themoviedb.org/3/tv/${showTmdbId}/season/${season}/episode/${episode}?api_key=${Shared.tmdbApiKey}`;
			const responseText = await this.requests.send({ url, method: 'GET' });
			const response = JSON.parse(responseText) as { id?: number };
			return response.id || null;
		} catch (_err) {
			return null;
		}
	}

	async send(data: ScrobWatchData): Promise<void> {
		await this.activate();
		const responseText = await this.requests.send({
			url: this.getUrl('/history/watched'),
			method: 'POST',
			body: data,
		});
		try {
			const response = JSON.parse(responseText);
			console.log('[UTS] Scrob sync OK:', response);
		} catch (_e) {
			console.log('[UTS] Scrob sync OK (raw):', responseText);
		}
		await Shared.events.dispatch('SCROBBLE_SUCCESS', null, {
			item: { type: data.media_type } as never,
			scrobbleType: 3,
		});
	}

	async syncHistory(item: ScrobbleItem): Promise<void> {
		if (!this.isConfigured()) {
			console.log('[UTS] Scrob syncHistory skipped: not configured');
			return;
		}

		const tmdbInfo = await this.getTmdbInfo(item);
		if (!tmdbInfo) {
			console.warn(`[UTS] Scrob syncHistory skipped for "${item.getFullTitle()}": no TMDB info`);
			return;
		}

		console.log(`[UTS] Scrob syncing: ${item.getFullTitle()} → TMDB ${tmdbInfo.tmdbId}`);

		const data: ScrobWatchData = {
			tmdb_id: tmdbInfo.tmdbId,
			media_type: tmdbInfo.mediaType,
			...(tmdbInfo.seriesTmdbId ? { series_tmdb_id: tmdbInfo.seriesTmdbId } : {}),
			...(tmdbInfo.seasonNumber ? { season_number: tmdbInfo.seasonNumber } : {}),
			...(tmdbInfo.episodeNumber ? { episode_number: tmdbInfo.episodeNumber } : {}),
			watched_at: item.watchedAt ? new Date(item.watchedAt).toISOString() : undefined,
			completed: true,
		};

		await this.send(data);
	}
}

export const ScrobScrobble = new _ScrobScrobble();
