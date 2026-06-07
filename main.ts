import { AbstractInputSuggest, moment, SuggestModal, TFile, TFolder } from 'obsidian';
import { App, Plugin, PluginSettingTab, requestUrl, Setting } from 'obsidian';

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

async function refreshIGDBToken(clientId: string, secret: string): Promise<IGDBTokenResponse> {
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

async function fetchIGDBGameReleaseDate(token: string, clientId: string, gameId: number): Promise<string | null> {
	const response = await requestUrl({
		url: "https://api.igdb.com/v4/release_dates",
		method: "POST",
		headers: {
			"Client-ID": clientId,
			"Authorization": `Bearer ${token}`,
		},
		body: `fields *; where game = ${gameId} & release_region = (8,2);`,
	});

	const data = response.json as any[];
	const pcRelease = data.find(rd => rd.platform === 6);
	const date = pcRelease ? pcRelease.date : data.first()?.date
	if (!date) {
		return null;
	}
	return moment.utc(date * 1000).format("YYYY-MM-DD");
}

async function fetchIGDBGameStoreLink(token: string, clientId: string, gameId: number): Promise<string | null> {
	const response = await requestUrl({
		url: "https://api.igdb.com/v4/websites",
		method: "POST",
		headers: {
			"Client-ID": clientId,
			"Authorization": `Bearer ${token}`,
		},
		body: `fields url,type; where game = ${gameId} & type = (13,24,23);`,
	});

	const data = response.json as any[];
	const priority = [13, 24, 23]; // Steam, Nintendo/Switch, PlayStation
	for (const type of priority) {
		const match = data.find(w => w.type === type);
		if (match) {
			return match.url;
		}
	}
	return null;
}

async function searchIGDBGames(token: string, clientId: string, query: string): Promise<GameResult[]> {
	const response = await requestUrl({
		url: "https://api.igdb.com/v4/games",
		method: "POST",
		headers: {
			"Client-ID": clientId,
			"Authorization": `Bearer ${token}`,
		},
		body: `search "${query}"; fields name,id,involved_companies.company.name,first_release_date; limit 10; where involved_companies.developer = true;`,
	});

	return (response.json as any[]).map<GameResult>((result: any) => ({
		id: result.id,
		name: result.name,
		developer: result.involved_companies.reduce((dev: string, ic: any, i: number) => dev + (i == 0 ? "" : ", ") + ic.company.name, ""),
		year: result?.first_release_date ? moment.utc(result.first_release_date * 1000).format("YYYY") : "N/A"
	}));
}

export default class IGDBSync extends Plugin {
	settings: IGDBSyncSettings
	token: string | null;

	async onload() {
		await this.loadSettings();
		this.token = this.app.loadLocalStorage("igdb_token");
		await this.refreshIGDBToken();

		this.app.workspace.onLayoutReady(async () => {
			await this.refreshAllIGDBNotes();
		})

		this.addCommand({
			id: 'force-igdb-sync',
			name: 'Sync note properties with IGDB',
			callback: () => {
				this.refreshAllIGDBNotes();
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

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new IGDBSyncSettingsTab(this.app, this));
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		await this.refreshIGDBToken();
	}

	async refreshIGDBToken() {
		if (this.settings.clientId && this.settings.secret) {
			const tokenResponse = await refreshIGDBToken(this.settings.clientId, this.settings.secret);
			this.token = tokenResponse.access_token;
			this.app.saveLocalStorage("igdb_token", tokenResponse.access_token);
		} else {
			this.token = null;
			this.app.saveLocalStorage("igdb_token", null);
		}
	}

	async refreshAllIGDBNotes() {
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
			const igdb = fm?.["igdb"]
			if (igdb) {
				await this.refreshIGDBNote(file, igdb);
			}
		}
	}

	async refreshIGDBNote(file: TFile, igdb: number) {
		const token = this.token;
		if (token) {
			const date = await fetchIGDBGameReleaseDate(token, this.settings.clientId, igdb)
			const storeLink = await fetchIGDBGameStoreLink(token, this.settings.clientId, igdb)
			this.app.fileManager.processFrontMatter(file, fm => {
				fm["release_date"] = date ?? "TBD"
				if (storeLink != null) {
					fm["store_link"] = storeLink
				}
			})
		}
	}
}

interface GameResult {
	id: number;
	name: string;
	developer: string;
	year: string;
}

class GameSearchModal extends SuggestModal<GameResult> {
	constructor(app: App, private plugin: IGDBSync, private callback: (result: GameResult) => void) {
		super(app);
	}
	// Returns all available suggestions.
	async getSuggestions(query: string): Promise<GameResult[]> {
		if (!this.plugin.token || !this.plugin.settings.clientId) {
			return [];
		}
		const results = await searchIGDBGames(this.plugin.token, this.plugin.settings.clientId, query);
		return results
	}

	// Renders each suggestion item.
	renderSuggestion(game: GameResult, el: HTMLElement) {
		el.createEl('div', { text: game.name });
		el.createEl('small', { text: `${game.developer} (${game.year})` });
	}

	// Perform action on the selected suggestion.
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
