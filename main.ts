import { AbstractInputSuggest, moment, Notice, SuggestModal, TFile, TFolder } from 'obsidian';
import { App, Plugin, PluginSettingTab, requestUrl, Setting } from 'obsidian';

const PLUGIN_NAME = "IGDB Sync";

const PLATFORM_PC = 6;
const PLATFORM_SWITCH = 130;
const PLATFORM_PLAYSTATION_IDS = [7, 8, 9, 38, 46, 48, 167];

const REGION_NORTH_AMERICA = 2;
const REGION_WORLDWIDE = 8;
const SYNC_REGIONS = [REGION_NORTH_AMERICA, REGION_WORLDWIDE];

const WEBSITE_STEAM = 13;
const WEBSITE_PLAYSTATION = 23;
const WEBSITE_NINTENDO = 24;
const STORE_PRIORITY = [WEBSITE_STEAM, WEBSITE_NINTENDO, WEBSITE_PLAYSTATION];

const COVER_SIZE = "t_cover_big";
const IGDB_GAMES_FIELDS = "release_dates.date,release_dates.platform,release_dates.release_region,websites.url,websites.type,cover.image_id,platforms";
const IGDB_CHUNK_SIZE = 100;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const SEARCH_DEBOUNCE_MS = 300;

const TOKEN_KEY = "igdb_token";
const TOKEN_EXPIRY_KEY = "igdb_token_expiry";

interface IGDBSyncSettings {
	clientId: string;
	secret: string;
	gameNoteFolder: string;
	gameFileTemplate: string;
}

const DEFAULT_SETTINGS: IGDBSyncSettings = {
	clientId: "",
	secret: "",
	gameNoteFolder: "",
	gameFileTemplate: ""
}

interface IGDBTokenResponse {
	access_token: string;
	expires_in: number;
	token_type: string;
}

interface IGDBReleaseDate {
	date?: number;
	platform?: number;
	release_region?: number;
}

interface IGDBWebsite {
	url: string;
	type: number;
}

interface IGDBCover {
	image_id?: string;
}

interface IGDBInvolvedCompany {
	company: { name: string };
	developer?: boolean;
}

interface IGDBGame {
	id: number;
	release_dates?: IGDBReleaseDate[];
	websites?: IGDBWebsite[];
	cover?: IGDBCover;
	platforms?: number[];
}

interface IGDBSearchHit {
	id: number;
	name: string;
	involved_companies?: IGDBInvolvedCompany[];
	first_release_date?: number;
}

interface IGDBNoteData {
	releaseDate: string | null;
	storeLink: string | null;
	coverUrl: string | null;
	platforms: string[];
}

class IGDBAuthError extends Error {
	constructor() {
		super("IGDB authentication failed (401)");
		this.name = "IGDBAuthError";
	}
}

async function fetchIGDBToken(clientId: string, secret: string): Promise<IGDBTokenResponse> {
	const response = await requestUrl({
		url: "https://id.twitch.tv/oauth2/token",
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded"
		},
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: secret,
			grant_type: "client_credentials"
		}).toString()
	})

	return response.json as IGDBTokenResponse;
}

async function igdbPost<T>(token: string, clientId: string, endpoint: string, body: string): Promise<T> {
	const response = await requestUrl({
		url: `https://api.igdb.com/v4/${endpoint}`,
		method: "POST",
		headers: {
			"Client-ID": clientId,
			"Authorization": `Bearer ${token}`,
		},
		body,
		throw: false,
	});
	if (response.status === 401) throw new IGDBAuthError();
	if (response.status >= 400) {
		throw new Error(`IGDB API ${response.status}: ${response.text ?? ""}`);
	}
	return response.json as T;
}

async function fetchIGDBGames(token: string, clientId: string, ids: number[]): Promise<IGDBGame[]> {
	if (ids.length === 0) return [];
	const results: IGDBGame[] = [];
	for (let i = 0; i < ids.length; i += IGDB_CHUNK_SIZE) {
		const chunk = ids.slice(i, i + IGDB_CHUNK_SIZE);
		const body = `fields ${IGDB_GAMES_FIELDS}; where id = (${chunk.join(",")}); limit ${chunk.length};`;
		const games = await igdbPost<IGDBGame[]>(token, clientId, "games", body);
		results.push(...games);
	}
	return results;
}

async function searchIGDBGames(token: string, clientId: string, query: string): Promise<GameResult[]> {
	const body = `search "${query}"; fields name,id,involved_companies.company.name,first_release_date; limit 10; where involved_companies.developer = true;`;
	const hits = await igdbPost<IGDBSearchHit[]>(token, clientId, "games", body);
	return hits.map<GameResult>((hit) => ({
		id: hit.id,
		name: hit.name,
		developer: (hit.involved_companies ?? []).reduce(
			(dev, ic, i) => dev + (i == 0 ? "" : ", ") + ic.company.name,
			""
		),
		year: hit.first_release_date ? moment.utc(hit.first_release_date * 1000).format("YYYY") : "N/A"
	}));
}

function extractIGDBNoteData(game: IGDBGame): IGDBNoteData {
	const releases = (game.release_dates ?? []).filter(rd =>
		rd.release_region !== undefined && SYNC_REGIONS.includes(rd.release_region)
	);
	const pcRelease = releases.find(rd => rd.platform === PLATFORM_PC);
	const dateUnix = pcRelease?.date ?? releases[0]?.date;
	const releaseDate = dateUnix ? moment.utc(dateUnix * 1000).format("YYYY-MM-DD") : null;

	const websites = game.websites ?? [];
	let storeLink: string | null = null;
	for (const type of STORE_PRIORITY) {
		const match = websites.find(w => w.type === type);
		if (match) { storeLink = match.url; break; }
	}

	const coverUrl = game.cover?.image_id
		? `https://images.igdb.com/igdb/image/upload/${COVER_SIZE}/${game.cover.image_id}.jpg`
		: null;

	const platformIds = new Set(game.platforms ?? []);
	const platforms: string[] = [];
	if (platformIds.has(PLATFORM_PC)) platforms.push("PC");
	if (platformIds.has(PLATFORM_SWITCH)) platforms.push("Switch");
	if (PLATFORM_PLAYSTATION_IDS.some(id => platformIds.has(id))) platforms.push("PlayStation");

	return { releaseDate, storeLink, coverUrl, platforms };
}

export default class IGDBSync extends Plugin {
	settings: IGDBSyncSettings
	token: string | null;
	private tokenExpiry = 0;
	private syncing = false;

	async onload() {
		await this.loadSettings();
		this.token = this.app.loadLocalStorage(TOKEN_KEY);
		const expiryRaw = this.app.loadLocalStorage(TOKEN_EXPIRY_KEY);
		this.tokenExpiry = expiryRaw ? (parseInt(expiryRaw, 10) || 0) : 0;

		this.app.workspace.onLayoutReady(async () => {
			await this.refreshAllIGDBNotes();
		})

		this.addCommand({
			id: 'force-igdb-sync',
			name: 'Sync all IGDB notes',
			callback: () => {
				this.refreshAllIGDBNotes();
			}
		});

		this.addCommand({
			id: 'sync-current-igdb-note',
			name: 'Sync IGDB properties for current note',
			editorCheckCallback: (checking, _, view) => {
				const file = view.file;
				if (!file || file.extension !== 'md') return false;
				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
				const igdb = fm["igdb"];
				if (!igdb) return false;
				if (!checking) {
					this.refreshIGDBNote(file, igdb);
				}
				return true;
			}
		});

		this.addCommand({
			id: 'search-igdb-game-current-file',
			name: 'Search and add IGDB ID to current file',
			editorCheckCallback: (checking, _, view) => {
				const file = view.file;
				if (file?.extension == "md") {
					if (!checking) {
						new GameSearchModal(this.app, this, result => {
							this.app.fileManager.processFrontMatter(file, fm => {
								fm["igdb"] = result.id;
							}).then(() => {
								this.refreshIGDBNote(file, result.id);
							});
						}).open();
					}
					return true;
				}
			}
		})

		this.addCommand({
			id: 'search-igdb-game-new-file',
			name: 'Search and create game file from IGDB info',
			callback: () => {
				new GameSearchModal(this.app, this, async result => {
					const sanitizedTitle = result.name.replace(/[/\\?%*:|"<>]/g, '-');
					let newFileContent = "";
					if (this.settings.gameFileTemplate) {
						newFileContent = await this.app.vault.cachedRead(this.app.vault.getAbstractFileByPath(this.settings.gameFileTemplate) as TFile)
					}
					this.app.vault.create(`${this.settings.gameNoteFolder}/${sanitizedTitle}.md`, newFileContent).then(activeFile => {
						this.app.fileManager.processFrontMatter(activeFile, fm => {
							fm["igdb"] = result.id;
						}).then(() => {
							this.app.workspace.getLeaf().openFile(activeFile);
							this.refreshIGDBNote(activeFile, result.id);
						});
					});
				}).open();
			}
		})

		this.addSettingTab(new IGDBSyncSettingsTab(this.app, this));
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.tokenExpiry = 0;
		await this.ensureValidToken();
	}

	async ensureValidToken(): Promise<string | null> {
		if (this.token && Date.now() < this.tokenExpiry - TOKEN_REFRESH_BUFFER_MS) {
			return this.token;
		}
		if (!this.settings.clientId || !this.settings.secret) {
			this.token = null;
			this.tokenExpiry = 0;
			this.app.saveLocalStorage(TOKEN_KEY, null);
			this.app.saveLocalStorage(TOKEN_EXPIRY_KEY, null);
			return null;
		}
		try {
			const tokenResponse = await fetchIGDBToken(this.settings.clientId, this.settings.secret);
			this.token = tokenResponse.access_token;
			this.tokenExpiry = Date.now() + tokenResponse.expires_in * 1000;
			this.app.saveLocalStorage(TOKEN_KEY, this.token);
			this.app.saveLocalStorage(TOKEN_EXPIRY_KEY, String(this.tokenExpiry));
			return this.token;
		} catch (e) {
			new Notice(`${PLUGIN_NAME}: token refresh failed (${e.message ?? e})`);
			return null;
		}
	}

	async fetchGamesWithRetry(ids: number[]): Promise<IGDBGame[]> {
		let token = await this.ensureValidToken();
		if (!token) throw new Error("no IGDB token available");
		try {
			return await fetchIGDBGames(token, this.settings.clientId, ids);
		} catch (e) {
			if (!(e instanceof IGDBAuthError)) throw e;
			this.tokenExpiry = 0;
			token = await this.ensureValidToken();
			if (!token) throw e;
			return await fetchIGDBGames(token, this.settings.clientId, ids);
		}
	}

	async refreshAllIGDBNotes() {
		if (this.syncing) return;
		this.syncing = true;
		try {
			const fileToId = new Map<TFile, number>();
			for (const file of this.app.vault.getMarkdownFiles()) {
				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
				const igdb = fm["igdb"];
				if (igdb) fileToId.set(file, igdb);
			}
			if (fileToId.size === 0) return;

			const ids = Array.from(new Set(fileToId.values()));
			let games: IGDBGame[];
			try {
				games = await this.fetchGamesWithRetry(ids);
			} catch (e) {
				new Notice(`${PLUGIN_NAME}: sync failed (${e.message ?? e})`);
				return;
			}
			const gameById = new Map(games.map(g => [g.id, g]));

			let missing = 0;
			for (const [file, id] of fileToId) {
				const game = gameById.get(id);
				if (!game) { missing++; continue; }
				await this.applyGameData(file, game);
			}

			if (missing > 0) {
				new Notice(`${PLUGIN_NAME}: ${missing} note(s) had no matching IGDB game`);
			}
		} finally {
			this.syncing = false;
		}
	}

	async refreshIGDBNote(file: TFile, igdb: number) {
		let games: IGDBGame[];
		try {
			games = await this.fetchGamesWithRetry([igdb]);
		} catch (e) {
			new Notice(`${PLUGIN_NAME}: sync failed (${e.message ?? e})`);
			return;
		}
		const game = games[0];
		if (!game) {
			new Notice(`${PLUGIN_NAME}: game ${igdb} not found`);
			return;
		}
		await this.applyGameData(file, game);
	}

	private async applyGameData(file: TFile, game: IGDBGame) {
		const data = extractIGDBNoteData(game);
		await this.app.fileManager.processFrontMatter(file, fm => {
			fm["release_date"] = data.releaseDate ?? "TBD";
			if (data.storeLink != null) fm["store_link"] = data.storeLink;
			if (data.coverUrl != null) fm["cover_url"] = data.coverUrl;
			if (data.platforms.length > 0) fm["platforms"] = data.platforms;
		});
	}
}

interface GameResult {
	id: number;
	name: string;
	developer: string;
	year: string;
}

class GameSearchModal extends SuggestModal<GameResult> {
	private debounceTimer?: number;

	constructor(app: App, private plugin: IGDBSync, private callback: (result: GameResult) => void) {
		super(app);
	}

	getSuggestions(query: string): Promise<GameResult[]> {
		return new Promise((resolve) => {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = window.setTimeout(async () => {
				if (!this.plugin.settings.clientId) {
					resolve([]);
					return;
				}
				const token = await this.plugin.ensureValidToken();
				if (!token) {
					resolve([]);
					return;
				}
				try {
					const results = await searchIGDBGames(token, this.plugin.settings.clientId, query);
					resolve(results);
				} catch (e) {
					new Notice(`${PLUGIN_NAME}: search failed (${e.message ?? e})`);
					resolve([]);
				}
			}, SEARCH_DEBOUNCE_MS);
		});
	}

	renderSuggestion(game: GameResult, el: HTMLElement) {
		el.createEl('div', { text: game.name });
		el.createEl('small', { text: `${game.developer} (${game.year})` });
	}

	onChooseSuggestion(game: GameResult, evt: MouseEvent | KeyboardEvent) {
		this.callback(game);
	}
}

class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(app: App, private inputEl: HTMLInputElement, private plugin: IGDBSync) {
		super(app, inputEl);
	}

	protected getSuggestions(query: string): TFolder[] {
		return this.app.vault.getAllFolders().filter(f => f.path.toLowerCase().contains(query.toLowerCase()));
	}

	public renderSuggestion(value: TFolder, el: HTMLElement): void {
		el.createEl('div', { text: value.path });
	}

	public selectSuggestion(value: TFolder): void {
		this.inputEl.value = value.path;
		this.plugin.settings.gameNoteFolder = value.path
		this.plugin.saveSettings();
		this.close();
	}
}

class FileSuggest extends AbstractInputSuggest<TFile> {
	constructor(app: App, private inputEl: HTMLInputElement, private plugin: IGDBSync) {
		super(app, inputEl);
	}

	protected getSuggestions(query: string): TFile[] {
		return this.app.vault.getMarkdownFiles().filter(f => f.path.toLowerCase().contains(query.toLowerCase()));
	}

	public renderSuggestion(value: TFile, el: HTMLElement): void {
		el.createEl('div', { text: value.path });
	}

	public selectSuggestion(value: TFile): void {
		this.inputEl.value = value.path;
		this.plugin.settings.gameFileTemplate = value.path
		this.plugin.saveSettings();
		this.close();
	}
}

class IGDBSyncSettingsTab extends PluginSettingTab {
	constructor(app: App, private plugin: IGDBSync) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('IGDB Client ID')
			.addText(text => text
				.setPlaceholder('Enter your client ID')
				.setValue(this.plugin.settings.clientId)
				.onChange(async (value) => {
					this.plugin.settings.clientId = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('IGDB Secret')
			.addText(text => text
				.setPlaceholder('Enter your secret')
				.setValue(this.plugin.settings.secret)
				.onChange(async (value) => {
					this.plugin.settings.secret = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Game Note Folder')
			.addSearch(search => {
				search.setValue(this.plugin.settings.gameNoteFolder)
					.setPlaceholder('Select folder to store generated game notes')
					.onChange(async (value) => {
						console.log(value)
						this.plugin.settings.gameNoteFolder = value;
						await this.plugin.saveSettings();
					});
				new FolderSuggest(this.app, search.inputEl, this.plugin);
			});

		new Setting(containerEl)
			.setName('Game Note Template')
			.setDesc('Template for new game notes.')
			.addSearch(search => {
				search.setValue(this.plugin.settings.gameFileTemplate)
					.setPlaceholder('Select template for new game notes')
					.onChange(async (value) => {
						this.plugin.settings.gameFileTemplate = value;
						await this.plugin.saveSettings();
					});
				new FileSuggest(this.app, search.inputEl, this.plugin);
			});
	}
}
