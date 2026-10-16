using Microsoft.AspNetCore.SignalR;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.Json.Serialization;
using TroisTemps.Web.Game;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<CardLibrary>();
builder.Services.AddSignalR(o => o.AddFilter<HubErrorFilter>())
    .AddJsonProtocol(o => o.PayloadSerializerOptions.Converters.Add(new JsonStringEnumConverter()));
builder.Services.AddSingleton<RoomManager>();
builder.Services.AddHostedService<GameLoop>();

var app = builder.Build();
app.Services.GetRequiredService<CardLibrary>(); // charge la base dès le démarrage

app.UseDefaultFiles();
app.UseStaticFiles();

// Catégories de la base, pour l'écran de réglages.
app.MapGet("/api/cartes", (CardLibrary lib) => lib.Summary());

app.MapGet("/api/salle/{code}", (string code, RoomManager rooms) => new { exists = rooms.Exists(code) });

// Adresses de ce PC sur le réseau local : le lien d'invitation doit marcher depuis les téléphones.
app.MapGet("/api/reseau", (HttpContext ctx) =>
{
    var port = ctx.Connection.LocalPort;
    var addresses = NetworkInterface.GetAllNetworkInterfaces()
        .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType is not (NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel))
        .Where(n => !n.Description.Contains("Virtual", StringComparison.OrdinalIgnoreCase) && !n.Description.Contains("Hyper-V", StringComparison.OrdinalIgnoreCase))
        .SelectMany(n => n.GetIPProperties().UnicastAddresses)
        .Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork)
        .Select(a => a.Address.ToString())
        .Where(a => !a.StartsWith("169.254."))
        .Distinct()
        .Select(a => $"http://{a}:{port}")
        .ToList();
    return new { addresses };
});

app.MapHub<GameHub>("/hub/jeu");

app.Run();
