namespace TroisTemps.Web.Game;

public enum Phase { Lobby, TurnReady, Playing, Review, RoundEnd, Final }

/// <summary>Une salle de jeu, gardée en mémoire. Toujours modifiée sous <c>lock (room)</c>.</summary>
public sealed class Room
{
    public required string Code { get; init; }
    /// <summary>Mode « un seul appareil » : l'appareil de l'hôte joue pour tout le monde.</summary>
    public bool Local { get; init; }
    public string HostId { get; set; } = "";
    public List<Player> Players { get; } = [];
    public List<Team> Teams { get; } = [];
    public GameSettings Settings { get; set; } = new();
    public Phase Phase { get; set; } = Phase.Lobby;
    public DateTimeOffset LastActivity { get; set; } = DateTimeOffset.UtcNow;

    // Cartes proposées par les joueurs dans le salon
    public List<Card> CustomCards { get; } = [];
    /// <summary>Cartes de la base déjà jouées dans cette salle, pour varier d'une partie à l'autre.</summary>
    public HashSet<string> UsedLibraryIds { get; } = [];

    // ---------- Partie en cours ----------
    public List<Card> Cards { get; set; } = [];
    /// <summary>Cartes encore à faire deviner dans la manche ; la carte en jeu est Deck[0].</summary>
    public List<Card> Deck { get; set; } = [];
    public int Round { get; set; } = 1;
    /// <summary>Points par équipe et par manche : Scores[teamId][round - 1].</summary>
    public Dictionary<int, int[]> Scores { get; } = [];
    public int TeamCursor { get; set; }
    public Dictionary<int, int> PlayerCursor { get; } = [];
    public bool RoundStart { get; set; } = true;

    // Tour en cours
    public string? GiverId { get; set; }
    public int GiverTeam { get; set; }
    public DateTimeOffset? Deadline { get; set; }
    public TimeSpan? PausedRemaining { get; set; }
    /// <summary>Temps restant gardé quand le paquet se vide en plein tour (règle du temps reporté).</summary>
    public TimeSpan? CarryOver { get; set; }
    public TimeSpan TurnLength { get; set; }
    public List<Card> FoundThisTurn { get; } = [];
    public HashSet<string> Rejected { get; } = [];
    public int PassesThisTurn { get; set; }
    public bool DeckEmptiedInTurn { get; set; }
    public TurnEnd? LastTurn { get; set; }
    public int TurnNumber { get; set; }

    public Player? Find(string? id) => id is null ? null : Players.Find(p => p.Id == id);
    public Team? TeamOf(Player p) => Teams.Find(t => t.Id == p.TeamId);
    public List<Player> Members(int teamId) => Players.Where(p => p.TeamId == teamId).ToList();
}

public sealed class Player
{
    public required string Id { get; init; }
    public required string Token { get; init; }
    public required string Name { get; set; }
    public int TeamId { get; set; } = -1;
    public string? ConnectionId { get; set; }
    public DateTimeOffset? DisconnectedAt { get; set; }
    /// <summary>Joueur ajouté sur l'appareil de l'hôte (mode un seul appareil) : jamais connecté.</summary>
    public bool Virtual { get; init; }
    public int Found { get; set; }
    public bool Connected => Virtual || ConnectionId is not null;
}

public sealed class Team
{
    public required int Id { get; init; }
    public required string Name { get; set; }
    public required int Color { get; init; }
}

public sealed class Card
{
    public required string Id { get; init; }
    public required string Text { get; init; }
    public required string Category { get; init; }
    public int Difficulty { get; init; } = 2;
    /// <summary>Auteur d'une carte proposée par un joueur.</summary>
    public string? AuthorId { get; init; }
}

public sealed record TurnEnd(string GiverName, int TeamId, List<string> Found, int Passes, bool DeckEmpty);

public sealed class GameSettings
{
    public int TurnSeconds { get; set; } = 30;
    public int CardCount { get; set; } = 40;
    public int TeamCount { get; set; } = 2;
    public List<string> Categories { get; set; } = [];
    public List<int> Difficulties { get; set; } = [1, 2];
    /// <summary>Nombre de cartes que chaque joueur peut ajouter (0 : désactivé).</summary>
    public int CardsPerPlayer { get; set; } = 0;
    public bool PassInRound1 { get; set; } = true;
    public bool CarryOver { get; set; } = true;

    public GameSettings Normalized(IReadOnlyCollection<string> knownCategories) => new()
    {
        TurnSeconds = Math.Clamp(TurnSeconds / 5 * 5, 15, 120),
        CardCount = Math.Clamp(CardCount, 10, 100),
        TeamCount = Math.Clamp(TeamCount, 2, 4),
        Categories = (Categories ?? []).Where(knownCategories.Contains).Distinct().ToList() is { Count: > 0 } c ? c : [.. knownCategories],
        Difficulties = (Difficulties ?? []).Where(d => d is >= 1 and <= 3).Distinct().Order().ToList() is { Count: > 0 } d ? d : [1, 2, 3],
        CardsPerPlayer = Math.Clamp(CardsPerPlayer, 0, 10),
        PassInRound1 = PassInRound1,
        CarryOver = CarryOver,
    };
}

// ---------- Ce que reçoit chaque navigateur ----------

public sealed record PlayerDto(string Id, string Name, int TeamId, bool Connected, bool Virtual, int CardCount, int Found);
public sealed record TeamDto(int Id, string Name, int Color, int[] Scores, int Total);
public sealed record CardDto(string Id, string Text, string Category, int Difficulty);
public sealed record TurnDto(
    string? GiverId, int TeamId, long? Deadline, long? PausedMs, int TurnMs,
    List<CardDto> Found, List<string> Rejected, int Passes, bool CanPass, bool LastCard);

public sealed record StateDto(
    string Code, bool Local, string MeId, string HostId, Phase Phase, GameSettings Settings,
    List<PlayerDto> Players, List<TeamDto> Teams,
    int Round, bool RoundStart, int DeckLeft, int DeckTotal, int CustomTotal,
    TurnDto? Turn, CardDto? Card, TurnEnd? LastTurn, string? NextGiverId,
    List<CardDto> MyCards, long ServerNow);
