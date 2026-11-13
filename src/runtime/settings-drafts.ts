type ServerDraft = { name: string; url: string; providerId: string };
type PlayerDraft = {
  name: string;
  executable: string;
  argumentsText: string;
  mpvIpc: boolean;
};

const servers = new Map<string, ServerDraft>();
const players = new Map<string, PlayerDraft>();

export const settingsDrafts = {
  server: (id: string) => servers.get(id),
  saveServer: (id: string, draft: ServerDraft) => servers.set(id, draft),
  clearServer: (id: string) => servers.delete(id),
  player: (id: string) => players.get(id),
  savePlayer: (id: string, draft: PlayerDraft) => players.set(id, draft),
  clearPlayer: (id: string) => players.delete(id),
  clear: () => {
    servers.clear();
    players.clear();
  },
};
