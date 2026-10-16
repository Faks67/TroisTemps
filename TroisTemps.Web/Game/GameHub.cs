using Microsoft.AspNetCore.SignalR;

namespace TroisTemps.Web.Game;

/// <summary>Point d'entrée temps réel (SignalR) des navigateurs : /hub/jeu.</summary>
public sealed class GameHub(RoomManager rooms) : Hub
{
    public sealed record Joined(string Code, string PlayerId, string Token);

    public async Task<Joined> CreateRoom(string name, bool local)
    {
        await LeaveCurrent();
        var (room, p) = rooms.Create(name, Context.ConnectionId, local);
        await rooms.BroadcastAsync(room);
        return new(room.Code, p.Id, p.Token);
    }

    public async Task<Joined> JoinRoom(string code, string name)
    {
        await LeaveCurrent();
        var (room, p) = rooms.Join(code, name, Context.ConnectionId);
        await rooms.BroadcastAsync(room);
        return new(room.Code, p.Id, p.Token);
    }

    public async Task<Joined> Rejoin(string code, string playerId, string token, bool onlyIfAway)
    {
        var (room, p) = rooms.Rejoin(code, playerId, token, Context.ConnectionId, onlyIfAway);
        await rooms.BroadcastAsync(room);
        return new(room.Code, p.Id, p.Token);
    }

    public Task Leave() => LeaveCurrent();

    // Salon
    public Task UpdateSettings(GameSettings settings) => Act((r, p) => rooms.UpdateSettings(r, p, settings));
    public Task SetTeam(string playerId, int teamId) => Act((r, p) => rooms.SetTeam(r, p, playerId, teamId));
    public Task ShuffleTeams() => Act(rooms.ShuffleTeams);
    public Task RenameTeam(int teamId, string name) => Act((r, p) => rooms.RenameTeam(r, p, teamId, name));
    public Task AddLocalPlayer(string name, int? teamId) => Act((r, p) => rooms.AddLocalPlayer(r, p, name, teamId));
    public Task Kick(string playerId) => Act((r, p) => rooms.Kick(r, p, playerId));
    public Task MakeHost(string playerId) => Act((r, p) => rooms.MakeHost(r, p, playerId));
    public Task AddCard(string text) => Act((r, p) => rooms.AddCard(r, p, text));
    public Task RemoveCard(string cardId) => Act((r, p) => rooms.RemoveCard(r, p, cardId));
    public Task StartGame() => Act(rooms.Start);

    // Partie
    public Task StartTurn() => Act(rooms.StartTurn);
    public Task Found(string cardId) => Act((r, p) => rooms.Found(r, p, cardId));
    public Task Pass(string cardId) => Act((r, p) => rooms.Pass(r, p, cardId));
    public Task TogglePause() => Act(rooms.TogglePause);
    public Task EndTurn() => Act(rooms.EndTurnNow);
    public Task ToggleReview(string cardId) => Act((r, p) => rooms.ToggleReview(r, p, cardId));
    public Task ConfirmReview() => Act(rooms.ConfirmReview);
    public Task NextRound() => Act(rooms.NextRound);
    public Task SkipGiver() => Act(rooms.SkipGiver);
    public Task BackToLobby() => Act(rooms.BackToLobby);

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var room = rooms.Disconnected(Context.ConnectionId);
        if (room is not null) await rooms.BroadcastAsync(room);
        await base.OnDisconnectedAsync(exception);
    }

    async Task Act(Action<Room, Player> action)
    {
        var (room, p) = rooms.Who(Context.ConnectionId) ?? throw new HubException("Tu n'es dans aucune salle.");
        action(room, p);
        await rooms.BroadcastAsync(room);
    }

    async Task LeaveCurrent()
    {
        var room = rooms.Leave(Context.ConnectionId);
        if (room is not null) await rooms.BroadcastAsync(room);
    }
}

/// <summary>
/// Les HubException sont des refus normaux (« salle pleine »…) affichés au joueur : inutile de les
/// journaliser comme des erreurs. Les vraies erreurs sont journalisées ici.
/// </summary>
public sealed class HubErrorFilter(ILogger<HubErrorFilter> log) : IHubFilter
{
    public async ValueTask<object?> InvokeMethodAsync(HubInvocationContext ctx, Func<HubInvocationContext, ValueTask<object?>> next)
    {
        try { return await next(ctx); }
        catch (Exception ex) when (ex is not HubException)
        {
            log.LogError(ex, "Erreur dans la méthode {Method}", ctx.HubMethodName);
            throw;
        }
    }
}

/// <summary>Fait tourner les chronomètres des salles.</summary>
public sealed class GameLoop(RoomManager rooms, ILogger<GameLoop> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(200));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try { await rooms.TickAsync(); }
            catch (Exception ex) { log.LogError(ex, "Erreur dans la boucle de jeu"); }
        }
    }
}
