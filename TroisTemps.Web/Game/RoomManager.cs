using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.SignalR;

namespace TroisTemps.Web.Game;

/// <summary>
/// Toutes les salles en mémoire et les règles du jeu. Le serveur fait autorité : il tient le
/// chrono, le paquet et les scores. Chaque salle est verrouillée pendant qu'on la modifie, puis
/// chaque joueur reçoit sa propre vue (seul celui qui fait deviner reçoit la carte).
/// </summary>
public sealed class RoomManager(CardLibrary library, IHubContext<GameHub> hub, ILogger<RoomManager> log)
{
    public const int MaxPlayers = 20;
    public const int MaxRounds = 3;
    const string CodeLetters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    static readonly string[] TeamNames = ["Les Comètes", "Les Lucioles", "Les Ouragans", "Les Volcans"];
    static readonly TimeSpan HostGrace = TimeSpan.FromSeconds(15);
    static readonly TimeSpan LobbyGrace = TimeSpan.FromSeconds(60);
    static readonly TimeSpan EmptyRoomLifetime = TimeSpan.FromMinutes(30);
    static readonly TimeSpan MinCarryOver = TimeSpan.FromSeconds(3);

    readonly ConcurrentDictionary<string, Room> _rooms = new();
    readonly ConcurrentDictionary<string, (string code, string playerId)> _byConnection = new();

    public int RoomCount => _rooms.Count;

    // ---------- Entrée / sortie ----------

    public (Room room, Player player) Create(string name, string connectionId, bool local)
    {
        string code;
        do code = new string(Enumerable.Range(0, 4).Select(_ => CodeLetters[RandomNumberGenerator.GetInt32(CodeLetters.Length)]).ToArray());
        while (_rooms.ContainsKey(code));

        var room = new Room { Code = code, Local = local };
        room.Settings = new GameSettings().Normalized(library.CategoryIds);
        BuildTeams(room);
        var player = AddPlayer(room, name, connectionId, false);
        room.HostId = player.Id;
        _rooms[code] = room;
        log.LogInformation("Salle {Code} créée ({Mode})", code, local ? "un seul appareil" : "en ligne");
        return (room, player);
    }

    public (Room room, Player player) Join(string code, string name, string connectionId)
    {
        var room = GetRoom(code) ?? throw new HubException("Aucune salle avec ce code.");
        lock (room)
        {
            if (room.Local) throw new HubException("Cette salle se joue sur un seul appareil.");
            if (room.Players.Count >= MaxPlayers) throw new HubException($"La salle est pleine ({MaxPlayers} joueurs).");
            return (room, AddPlayer(room, name, connectionId, false));
        }
    }

    public (Room room, Player player) Rejoin(string code, string playerId, string token, string connectionId, bool onlyIfAway)
    {
        var room = GetRoom(code) ?? throw new HubException("Cette salle n'existe plus.");
        lock (room)
        {
            var p = room.Find(playerId);
            if (p is null || p.Virtual || !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(p.Token), Encoding.UTF8.GetBytes(token ?? "")))
                throw new HubException("Impossible de reprendre ta place dans cette salle.");
            // Reprise depuis un autre onglet : seulement si la place est libre, pour ne pas la voler.
            if (onlyIfAway && p.ConnectionId is not null) throw new HubException("Cette place est déjà occupée dans un autre onglet.");
            if (p.ConnectionId is not null) _byConnection.TryRemove(p.ConnectionId, out _);
            p.ConnectionId = connectionId;
            p.DisconnectedAt = null;
            _byConnection[connectionId] = (room.Code, p.Id);
            room.LastActivity = DateTimeOffset.UtcNow;
            return (room, p);
        }
    }

    Player AddPlayer(Room room, string name, string? connectionId, bool isVirtual)
    {
        name = CleanText(name, 20);
        if (name.Length == 0) throw new HubException("Choisis un pseudo.");
        var baseName = name;
        for (int i = 2; room.Players.Any(p => p.Name.Equals(name, StringComparison.OrdinalIgnoreCase)); i++)
            name = $"{baseName} {i}";
        var p = new Player
        {
            Id = Guid.NewGuid().ToString("N")[..10],
            Token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)),
            Name = name,
            ConnectionId = connectionId,
            Virtual = isVirtual,
        };
        p.TeamId = SmallestTeam(room);
        room.Players.Add(p);
        room.LastActivity = DateTimeOffset.UtcNow;
        if (connectionId is not null) _byConnection[connectionId] = (room.Code, p.Id);
        return p;
    }

    static int SmallestTeam(Room room) =>
        room.Teams.OrderBy(t => room.Players.Count(p => p.TeamId == t.Id)).ThenBy(t => t.Id).First().Id;

    /// <summary>Le joueur quitte volontairement la salle.</summary>
    public Room? Leave(string connectionId)
    {
        if (!_byConnection.TryRemove(connectionId, out var who)) return null;
        var room = GetRoom(who.code);
        if (room is null) return null;
        lock (room)
        {
            if (room.Find(who.playerId) is { } p) RemovePlayer(room, p);
            return room;
        }
    }

    /// <summary>Connexion perdue (page rechargée, réseau…) : la place est gardée.</summary>
    public Room? Disconnected(string connectionId)
    {
        if (!_byConnection.TryRemove(connectionId, out var who)) return null;
        var room = GetRoom(who.code);
        if (room is null) return null;
        lock (room)
        {
            var p = room.Find(who.playerId);
            if (p is null || p.ConnectionId != connectionId) return room;
            p.ConnectionId = null;
            p.DisconnectedAt = DateTimeOffset.UtcNow;
            return room;
        }
    }

    void RemovePlayer(Room room, Player p)
    {
        if (p.ConnectionId is not null) _byConnection.TryRemove(p.ConnectionId, out _);
        room.Players.Remove(p);
        room.CustomCards.RemoveAll(c => c.AuthorId == p.Id);
        if (room.Players.Count(x => !x.Virtual) == 0) { _rooms.TryRemove(room.Code, out _); return; }
        if (room.HostId == p.Id) PassHost(room);

        if (room.GiverId == p.Id)
        {
            if (room.Phase == Phase.Playing) EndTurn(room);
            else if (room.Phase == Phase.TurnReady) { room.CarryOver = null; ChooseGiver(room); }
        }
        if (room.Phase is not (Phase.Lobby or Phase.Final) && !CanContinue(room))
        {
            room.Phase = Phase.Lobby;
            room.GiverId = null;
            room.Deadline = null;
        }
    }

    static void PassHost(Room room)
    {
        var next = room.Players.FirstOrDefault(x => !x.Virtual && x.ConnectionId is not null) ?? room.Players.FirstOrDefault(x => !x.Virtual);
        if (next is not null) room.HostId = next.Id;
    }

    public (Room room, Player player)? Who(string connectionId)
    {
        if (!_byConnection.TryGetValue(connectionId, out var who)) return null;
        var room = GetRoom(who.code);
        var p = room?.Find(who.playerId);
        return room is null || p is null ? null : (room, p);
    }

    public bool Exists(string code) => GetRoom(code) is not null;

    Room? GetRoom(string code) => _rooms.GetValueOrDefault((code ?? "").Trim().ToUpperInvariant());

    // ---------- Salon : réglages, équipes, cartes ----------

    void BuildTeams(Room room)
    {
        int n = room.Settings.TeamCount;
        while (room.Teams.Count > n) room.Teams.RemoveAt(room.Teams.Count - 1);
        while (room.Teams.Count < n)
        {
            int id = room.Teams.Count;
            room.Teams.Add(new Team { Id = id, Name = TeamNames[id], Color = id });
        }
        foreach (var p in room.Players.Where(p => room.Teams.All(t => t.Id != p.TeamId)))
            p.TeamId = SmallestTeam(room);
    }

    public void UpdateSettings(Room room, Player p, GameSettings s)
    {
        lock (room)
        {
            RequireHost(room, p);
            RequireLobby(room);
            room.Settings = s.Normalized(library.CategoryIds);
            BuildTeams(room);
            // Si on réduit le nombre de cartes autorisées, on retire les dernières ajoutées.
            foreach (var g in room.CustomCards.GroupBy(c => c.AuthorId).ToList())
                foreach (var extra in g.Skip(CardLimit(room, room.Find(g.Key)!)).ToList())
                    room.CustomCards.Remove(extra);
        }
    }

    public void SetTeam(Room room, Player p, string playerId, int teamId)
    {
        lock (room)
        {
            var target = room.Find(playerId) ?? throw new HubException("Joueur introuvable.");
            bool self = target.Id == p.Id && room.Phase == Phase.Lobby;
            if (!self) RequireHost(room, p);
            if (room.Teams.All(t => t.Id != teamId)) throw new HubException("Équipe introuvable.");
            if (room.GiverId == target.Id && room.Phase is Phase.Playing or Phase.Review)
                throw new HubException("Attends la fin de son tour pour changer son équipe.");
            target.TeamId = teamId;
            if (room.GiverId == target.Id && room.Phase == Phase.TurnReady) ChooseGiver(room);
        }
    }

    /// <summary>Répartition automatique : équipes mélangées et équilibrées.</summary>
    public void ShuffleTeams(Room room, Player p)
    {
        lock (room)
        {
            RequireHost(room, p);
            RequireLobby(room);
            var shuffled = CardLibrary.Shuffle(room.Players.ToList());
            int offset = Random.Shared.Next(room.Teams.Count);
            for (int i = 0; i < shuffled.Count; i++)
                shuffled[i].TeamId = room.Teams[(i + offset) % room.Teams.Count].Id;
        }
    }

    public void RenameTeam(Room room, Player p, int teamId, string name)
    {
        lock (room)
        {
            RequireHost(room, p);
            var team = room.Teams.Find(t => t.Id == teamId) ?? throw new HubException("Équipe introuvable.");
            name = CleanText(name, 24);
            if (name.Length > 0) team.Name = name;
        }
    }

    public void AddLocalPlayer(Room room, Player p, string name, int? teamId)
    {
        lock (room)
        {
            RequireHost(room, p);
            if (!room.Local) throw new HubException("Seulement en mode un seul appareil.");
            if (room.Players.Count >= MaxPlayers) throw new HubException($"{MaxPlayers} joueurs au maximum.");
            var added = AddPlayer(room, name, null, true);
            if (teamId is { } t && room.Teams.Any(x => x.Id == t)) added.TeamId = t;
        }
    }

    public void Kick(Room room, Player p, string playerId)
    {
        lock (room)
        {
            RequireHost(room, p);
            var target = room.Find(playerId) ?? throw new HubException("Joueur introuvable.");
            if (target.Id == p.Id) throw new HubException("Utilise « Quitter » pour partir.");
            var conn = target.ConnectionId;
            RemovePlayer(room, target);
            if (conn is not null) _ = hub.Clients.Client(conn).SendAsync("kicked");
        }
    }

    public void MakeHost(Room room, Player p, string playerId)
    {
        lock (room)
        {
            RequireHost(room, p);
            var target = room.Find(playerId) ?? throw new HubException("Joueur introuvable.");
            if (target.Virtual) throw new HubException("Ce joueur n'a pas son propre appareil.");
            room.HostId = target.Id;
        }
    }

    int CardLimit(Room room, Player p) =>
        room.Local && p.Id == room.HostId ? Math.Max(room.Settings.CardsPerPlayer * room.Players.Count, room.Settings.CardsPerPlayer) : room.Settings.CardsPerPlayer;

    public void AddCard(Room room, Player p, string text)
    {
        lock (room)
        {
            RequireLobby(room);
            text = CleanText(text, 40);
            if (text.Length < 2) throw new HubException("Écris au moins deux lettres.");
            int limit = CardLimit(room, p);
            if (limit == 0) throw new HubException("L'hôte n'a pas activé les cartes des joueurs.");
            if (room.CustomCards.Count(c => c.AuthorId == p.Id) >= limit) throw new HubException($"Tu as déjà ajouté tes {limit} cartes.");
            if (room.CustomCards.Any(c => Same(c.Text, text))) throw new HubException("Cette carte est déjà dans le paquet.");
            room.CustomCards.Add(new Card { Id = "p" + Guid.NewGuid().ToString("N")[..8], Text = text, Category = "joueurs", Difficulty = 2, AuthorId = p.Id });
        }
    }

    public void RemoveCard(Room room, Player p, string cardId)
    {
        lock (room)
        {
            RequireLobby(room);
            room.CustomCards.RemoveAll(c => c.Id == cardId && (c.AuthorId == p.Id || room.HostId == p.Id));
        }
    }

    // ---------- Déroulement de la partie ----------

    static bool CanContinue(Room room) =>
        room.Teams.Count(t => room.Players.Count(p => p.TeamId == t.Id) >= 2) >= 2
        && room.Teams.All(t => room.Players.Count(p => p.TeamId == t.Id) != 1);

    public void Start(Room room, Player p)
    {
        lock (room)
        {
            RequireHost(room, p);
            RequireLobby(room);
            var sizes = room.Teams.Select(t => room.Members(t.Id).Count).ToList();
            if (sizes.Count(n => n > 0) < 2) throw new HubException("Il faut au moins deux équipes avec des joueurs.");
            if (sizes.Any(n => n == 1)) throw new HubException("Chaque équipe doit avoir au moins 2 joueurs (un qui fait deviner, un qui devine).");

            var cards = room.CustomCards.Select(c => new Card { Id = c.Id, Text = c.Text, Category = c.Category, Difficulty = c.Difficulty, AuthorId = c.AuthorId }).ToList();
            var fill = Math.Max(0, room.Settings.CardCount - cards.Count);
            var picked = library.Pick(room.Settings, fill, room.UsedLibraryIds);
            foreach (var c in picked) room.UsedLibraryIds.Add(c.Id);
            cards.AddRange(picked);
            if (cards.Count < 4) throw new HubException("Pas assez de cartes : ajoute des catégories ou des difficultés.");

            room.Cards = cards;
            room.Deck = CardLibrary.Shuffle(cards.ToList());
            room.Round = 1;
            room.RoundStart = true;
            room.Scores.Clear();
            foreach (var t in room.Teams) room.Scores[t.Id] = new int[MaxRounds];
            foreach (var pl in room.Players) pl.Found = 0;
            room.PlayerCursor.Clear();
            room.TeamCursor = Random.Shared.Next(room.Teams.Count);
            room.CarryOver = null;
            room.LastTurn = null;
            room.TurnNumber = 0;
            ChooseGiver(room);
            room.Phase = Phase.TurnReady;
            log.LogInformation("Salle {Code} : partie lancée avec {Count} cartes", room.Code, cards.Count);
        }
    }

    /// <summary>Désigne qui fait deviner : les équipes jouent chacune leur tour, et dans chaque équipe les joueurs tournent.</summary>
    static void ChooseGiver(Room room)
    {
        var active = room.Teams.Where(t => room.Players.Any(p => p.TeamId == t.Id)).ToList();
        if (active.Count == 0) { room.GiverId = null; return; }
        var team = active[room.TeamCursor % active.Count];
        var members = room.Members(team.Id);
        int idx = room.PlayerCursor.GetValueOrDefault(team.Id) % members.Count;
        room.GiverId = members[idx].Id;
        room.GiverTeam = team.Id;
    }

    static void AdvanceRotation(Room room)
    {
        var active = room.Teams.Where(t => room.Players.Any(p => p.TeamId == t.Id)).ToList();
        if (active.Count == 0) return;
        var team = room.Teams.Find(t => t.Id == room.GiverTeam);
        if (team is not null)
        {
            var members = room.Members(team.Id);
            int idx = members.FindIndex(m => m.Id == room.GiverId);
            room.PlayerCursor[team.Id] = idx >= 0 ? idx + 1 : room.PlayerCursor.GetValueOrDefault(team.Id);
            int teamIdx = active.FindIndex(t => t.Id == team.Id);
            room.TeamCursor = (teamIdx >= 0 ? teamIdx : room.TeamCursor) + 1;
        }
        else room.TeamCursor++;
    }

    bool CanAct(Room room, Player p) => p.Id == room.GiverId || (room.Local && p.Id == room.HostId);

    public void StartTurn(Room room, Player p)
    {
        lock (room)
        {
            if (room.Phase != Phase.TurnReady) return;
            if (!CanAct(room, p)) throw new HubException("Ce n'est pas à toi de faire deviner.");
            if (room.Deck.Count == 0) return;
            var length = room.CarryOver ?? TimeSpan.FromSeconds(room.Settings.TurnSeconds);
            room.CarryOver = null;
            CardLibrary.Shuffle(room.Deck);
            room.TurnLength = length;
            room.Deadline = DateTimeOffset.UtcNow + length;
            room.PausedRemaining = null;
            room.FoundThisTurn.Clear();
            room.Rejected.Clear();
            room.PassesThisTurn = 0;
            room.DeckEmptiedInTurn = false;
            room.RoundStart = false;
            room.TurnNumber++;
            room.Phase = Phase.Playing;
        }
    }

    public void Found(Room room, Player p, string cardId)
    {
        lock (room)
        {
            if (room.Phase != Phase.Playing || room.PausedRemaining is not null) return;
            if (!CanAct(room, p)) return;
            // L'identifiant évite de compter deux fois un double appui.
            if (room.Deck.Count == 0 || room.Deck[0].Id != cardId) return;
            room.FoundThisTurn.Add(room.Deck[0]);
            room.Deck.RemoveAt(0);
            if (room.Deck.Count == 0)
            {
                room.DeckEmptiedInTurn = true;
                EndTurn(room);
            }
        }
    }

    public void Pass(Room room, Player p, string cardId)
    {
        lock (room)
        {
            if (room.Phase != Phase.Playing || room.PausedRemaining is not null) return;
            if (!CanAct(room, p)) return;
            if (room.Round == 1 && !room.Settings.PassInRound1) throw new HubException("Pas de « Passer » en manche 1.");
            if (room.Deck.Count < 2 || room.Deck[0].Id != cardId) return;
            var card = room.Deck[0];
            room.Deck.RemoveAt(0);
            room.Deck.Add(card);
            room.PassesThisTurn++;
        }
    }

    public void TogglePause(Room room, Player p)
    {
        lock (room)
        {
            if (room.Phase != Phase.Playing) return;
            if (!CanAct(room, p) && p.Id != room.HostId) throw new HubException("Seuls l'hôte et celui qui fait deviner peuvent mettre en pause.");
            if (room.PausedRemaining is { } left)
            {
                room.Deadline = DateTimeOffset.UtcNow + left;
                room.PausedRemaining = null;
            }
            else if (room.Deadline is { } d)
            {
                room.PausedRemaining = d - DateTimeOffset.UtcNow;
                room.Deadline = null;
            }
        }
    }

    /// <summary>Fin du tour (chrono écoulé ou paquet vide) : on passe à la vérification des cartes trouvées.</summary>
    void EndTurn(Room room)
    {
        if (room.DeckEmptiedInTurn && room.Settings.CarryOver && room.Round < MaxRounds)
        {
            var left = room.PausedRemaining ?? (room.Deadline - DateTimeOffset.UtcNow) ?? TimeSpan.Zero;
            room.CarryOver = left >= MinCarryOver ? TimeSpan.FromSeconds(Math.Ceiling(left.TotalSeconds)) : null;
        }
        room.Deadline = null;
        room.PausedRemaining = null;
        room.Phase = Phase.Review;
    }

    public void EndTurnNow(Room room, Player p)
    {
        lock (room)
        {
            if (room.Phase != Phase.Playing) return;
            if (!CanAct(room, p) && p.Id != room.HostId) return;
            EndTurn(room);
        }
    }

    public void ToggleReview(Room room, Player p, string cardId)
    {
        lock (room)
        {
            if (room.Phase != Phase.Review) return;
            if (!CanAct(room, p) && p.Id != room.HostId) return;
            if (room.FoundThisTurn.All(c => c.Id != cardId)) return;
            if (!room.Rejected.Remove(cardId)) room.Rejected.Add(cardId);
        }
    }

    public void ConfirmReview(Room room, Player p)
    {
        lock (room)
        {
            if (room.Phase != Phase.Review) return;
            if (!CanAct(room, p) && p.Id != room.HostId) throw new HubException("C'est à celui qui a fait deviner de valider.");
            var accepted = room.FoundThisTurn.Where(c => !room.Rejected.Contains(c.Id)).ToList();
            var rejected = room.FoundThisTurn.Where(c => room.Rejected.Contains(c.Id)).ToList();
            room.Deck.AddRange(rejected);
            if (room.Scores.TryGetValue(room.GiverTeam, out var scores)) scores[room.Round - 1] += accepted.Count;
            var giver = room.Find(room.GiverId);
            if (giver is not null) giver.Found += accepted.Count;
            room.LastTurn = new TurnEnd(giver?.Name ?? "?", room.GiverTeam, accepted.Select(c => c.Text).ToList(), room.PassesThisTurn, room.Deck.Count == 0);
            room.FoundThisTurn.Clear();
            room.Rejected.Clear();

            if (room.Deck.Count > 0) room.CarryOver = null;
            // Avec du temps reporté, le même joueur entame la manche suivante.
            if (room.CarryOver is null) AdvanceRotation(room);

            if (room.Deck.Count == 0)
                room.Phase = room.Round >= MaxRounds ? Phase.Final : Phase.RoundEnd;
            else
            {
                ChooseGiver(room);
                room.Phase = Phase.TurnReady;
            }
        }
    }

    public void NextRound(Room room, Player p)
    {
        lock (room)
        {
            RequireHost(room, p);
            if (room.Phase != Phase.RoundEnd) return;
            room.Round++;
            room.Deck = CardLibrary.Shuffle(room.Cards.ToList());
            room.RoundStart = true;
            room.LastTurn = null;
            if (room.CarryOver is null || room.Find(room.GiverId) is null) { room.CarryOver = null; ChooseGiver(room); }
            room.Phase = Phase.TurnReady;
        }
    }

    /// <summary>L'hôte saute le tour d'un joueur absent ou qui ne veut pas jouer.</summary>
    public void SkipGiver(Room room, Player p)
    {
        lock (room)
        {
            RequireHost(room, p);
            if (room.Phase != Phase.TurnReady) return;
            room.CarryOver = null;
            AdvanceRotation(room);
            ChooseGiver(room);
        }
    }

    public void BackToLobby(Room room, Player p)
    {
        lock (room)
        {
            RequireHost(room, p);
            room.Phase = Phase.Lobby;
            room.GiverId = null;
            room.Deadline = null;
            room.PausedRemaining = null;
            room.CarryOver = null;
            room.Deck.Clear();
            room.FoundThisTurn.Clear();
        }
    }

    // ---------- Boucle de jeu ----------

    public async Task TickAsync()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var room in _rooms.Values)
        {
            bool changed = false;
            lock (room)
            {
                if (room.Phase == Phase.Playing && room.Deadline is { } d && now >= d)
                {
                    EndTurn(room);
                    changed = true;
                }
                if (room.Find(room.HostId) is { ConnectionId: null, DisconnectedAt: { } since } && now - since > HostGrace
                    && room.Players.Any(p => !p.Virtual && p.ConnectionId is not null))
                {
                    PassHost(room);
                    changed = true;
                }
                if (room.Phase == Phase.Lobby)
                {
                    foreach (var p in room.Players.Where(p => p is { Virtual: false, ConnectionId: null } && now - p.DisconnectedAt > LobbyGrace).ToList())
                    {
                        RemovePlayer(room, p);
                        changed = true;
                    }
                }
                if (changed) room.LastActivity = now;
                if (room.Players.All(p => p.Virtual || p.ConnectionId is null) && now - room.LastActivity > EmptyRoomLifetime)
                {
                    _rooms.TryRemove(room.Code, out _);
                    log.LogInformation("Salle {Code} fermée (vide)", room.Code);
                    continue;
                }
            }
            if (changed) await BroadcastAsync(room);
        }
    }

    // ---------- Envoi de l'état ----------

    public async Task BroadcastAsync(Room room)
    {
        List<(string conn, StateDto state)> outgoing;
        lock (room)
        {
            room.LastActivity = DateTimeOffset.UtcNow;
            outgoing = room.Players.Where(p => p.ConnectionId is not null)
                                   .Select(p => (p.ConnectionId!, BuildState(room, p))).ToList();
        }
        foreach (var (conn, state) in outgoing)
            await hub.Clients.Client(conn).SendAsync("state", state);
    }

    StateDto BuildState(Room room, Player me)
    {
        static CardDto Dto(Card c) => new(c.Id, c.Text, c.Category, c.Difficulty);
        bool inTurn = room.Phase is Phase.TurnReady or Phase.Playing or Phase.Review;
        TurnDto? turn = inTurn ? new TurnDto(
            room.GiverId, room.GiverTeam,
            room.Deadline?.ToUnixTimeMilliseconds(),
            room.PausedRemaining is { } pr ? (long)pr.TotalMilliseconds : null,
            (int)(room.Phase == Phase.TurnReady ? (room.CarryOver ?? TimeSpan.FromSeconds(room.Settings.TurnSeconds)) : room.TurnLength).TotalMilliseconds,
            room.FoundThisTurn.Select(Dto).ToList(), room.Rejected.ToList(), room.PassesThisTurn,
            room.Round != 1 || room.Settings.PassInRound1, room.Deck.Count == 1) : null;

        CardDto? card = room.Phase == Phase.Playing && CanAct(room, me) && room.Deck.Count > 0 ? Dto(room.Deck[0]) : null;

        return new StateDto(
            room.Code, room.Local, me.Id, room.HostId, room.Phase, room.Settings,
            room.Players.Select(p => new PlayerDto(p.Id, p.Name, p.TeamId, p.Connected, p.Virtual,
                room.CustomCards.Count(c => c.AuthorId == p.Id), p.Found)).ToList(),
            room.Teams.Select(t =>
            {
                var s = room.Scores.GetValueOrDefault(t.Id) ?? new int[MaxRounds];
                return new TeamDto(t.Id, t.Name, t.Color, s, s.Sum());
            }).ToList(),
            room.Round, room.RoundStart, room.Deck.Count, room.Cards.Count, room.CustomCards.Count,
            turn, card, room.LastTurn, room.Phase == Phase.TurnReady ? room.GiverId : null,
            room.CustomCards.Where(c => c.AuthorId == me.Id || (room.Local && me.Id == room.HostId)).Select(Dto).ToList(),
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    // ---------- Outils ----------

    static void RequireHost(Room room, Player p)
    {
        if (room.HostId != p.Id) throw new HubException("Seul l'hôte de la salle peut faire ça.");
    }

    static void RequireLobby(Room room)
    {
        if (room.Phase != Phase.Lobby) throw new HubException("Possible seulement avant le début de la partie.");
    }

    static string CleanText(string? s, int max)
    {
        s = new string((s ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();
        while (s.Contains("  ")) s = s.Replace("  ", " ");
        return s.Length > max ? s[..max].Trim() : s;
    }

    static bool Same(string a, string b) => string.Compare(a, b, System.Globalization.CultureInfo.InvariantCulture,
        System.Globalization.CompareOptions.IgnoreCase | System.Globalization.CompareOptions.IgnoreNonSpace) == 0;
}
