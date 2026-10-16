using System.Text.Json;

namespace TroisTemps.Web.Game;

/// <summary>La base de cartes (Data/cartes.json), chargée une fois au démarrage.</summary>
public sealed class CardLibrary
{
    public sealed record Category(string Id, string Name);
    sealed record Entry(string T, string C, int D);
    sealed record FileShape(List<Category> Categories, List<Entry> Cards);

    public IReadOnlyList<Category> Categories { get; }
    public IReadOnlyList<Card> Cards { get; }
    public IReadOnlyCollection<string> CategoryIds { get; }

    public CardLibrary(IWebHostEnvironment env, ILogger<CardLibrary> log)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Data", "cartes.json");
        if (!File.Exists(path)) path = Path.Combine(env.ContentRootPath, "Data", "cartes.json");
        var data = JsonSerializer.Deserialize<FileShape>(File.ReadAllText(path), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                   ?? throw new InvalidOperationException("Base de cartes illisible.");
        Categories = data.Categories;
        CategoryIds = data.Categories.Select(c => c.Id).ToHashSet();
        Cards = data.Cards
            .Where(c => CategoryIds.Contains(c.C) && !string.IsNullOrWhiteSpace(c.T))
            .Select((c, i) => new Card { Id = "b" + i, Text = c.T.Trim(), Category = c.C, Difficulty = Math.Clamp(c.D, 1, 3) })
            .ToList();
        log.LogInformation("{Count} cartes chargées dans {Cats} catégories", Cards.Count, Categories.Count);
    }

    public object Summary() => new
    {
        categories = Categories.Select(c => new
        {
            c.Id,
            c.Name,
            count = Cards.Count(x => x.Category == c.Id),
            byDifficulty = Enumerable.Range(1, 3).Select(d => Cards.Count(x => x.Category == c.Id && x.Difficulty == d)),
        }),
        total = Cards.Count,
    };

    /// <summary>Tire des cartes au hasard en évitant celles déjà jouées dans la salle tant que possible.</summary>
    public List<Card> Pick(GameSettings s, int count, ISet<string> alreadyUsed)
    {
        var pool = Cards.Where(c => s.Categories.Contains(c.Category) && s.Difficulties.Contains(c.Difficulty)).ToList();
        var fresh = pool.Where(c => !alreadyUsed.Contains(c.Id)).ToList();
        var picked = Shuffle(fresh).Take(count).ToList();
        if (picked.Count < count)
            picked.AddRange(Shuffle(pool.Except(picked).ToList()).Take(count - picked.Count));
        return picked;
    }

    public static List<T> Shuffle<T>(List<T> list)
    {
        for (int i = list.Count - 1; i > 0; i--)
        {
            int j = Random.Shared.Next(i + 1);
            (list[i], list[j]) = (list[j], list[i]);
        }
        return list;
    }
}
