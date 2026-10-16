# Trois Temps

Jeu d'ambiance en équipes, en français, à jouer à plusieurs depuis vos téléphones ou ordinateurs
(ou sur un seul appareil qu'on se passe). Les mêmes cartes servent pendant trois manches, de plus
en plus dures :

1. **Décrire** : tout est permis, sauf les mots de la carte.
2. **Un seul mot** : un mot, pas un de plus, et une seule proposition par carte.
3. **Mime** : plus aucun mot ni aucun son, seulement des gestes.

L'équipe qui a fait deviner le plus de cartes à la fin des trois manches gagne.

## Lancer le jeu

Il faut le [SDK .NET 8](https://dotnet.microsoft.com/download/dotnet/8.0).

- **Sous Windows** : double-cliquez sur `lancer_jeu.cmd`. Le serveur démarre et le navigateur
  s'ouvre sur <http://localhost:5190>. Fermez la fenêtre noire pour arrêter le jeu.
- **En ligne de commande** :

  ```bash
  dotnet run --project TroisTemps.Web --launch-profile http
  ```

### Jouer avec des téléphones

Le serveur écoute sur tout le réseau local (port 5190). Les téléphones doivent être connectés au
**même Wi-Fi** que le PC. Dans le salon, le QR code et le lien d'invitation utilisent
automatiquement l'adresse du PC sur le réseau (par exemple `http://192.168.1.20:5190`).

Au premier lancement, Windows peut demander d'autoriser `TroisTemps.Web` dans le pare-feu :
acceptez pour les **réseaux privés**, sinon les téléphones ne pourront pas se connecter.

Pour tester seul sur un PC, ouvrez un onglet par joueur (chaque onglet est un joueur différent).

## Comment jouer

1. Un joueur **crée une salle**. Les autres la rejoignent avec le **code** à 4 lettres, le
   **lien** ou le **QR code**.
2. Le créateur de la salle (l'hôte) règle la partie et répartit les équipes : au hasard en un
   clic, ou à la main (chacun peut aussi choisir son équipe). Il faut au moins 2 équipes de
   2 joueurs.
3. À chaque tour, un joueur fait deviner son équipe. **Lui seul voit la carte** ; les autres
   voient le chrono, le score et les cartes déjà trouvées.
   - **Trouvé** : la carte est gagnée, la suivante apparaît.
   - **Passer** : la carte retourne dans le paquet.
4. À la fin du chrono, celui qui a fait deviner vérifie les cartes trouvées (il peut en annuler
   une en cas d'erreur) et valide. C'est ensuite à l'équipe suivante, puis au joueur suivant de
   chaque équipe.
5. La manche se termine quand le paquet est vide. S'il restait du temps, le joueur le garde pour
   commencer la manche suivante (réglage « Temps reporté »).
6. Après la troisième manche : classement final, scores par manche et meilleurs orateurs.
   L'hôte peut relancer une partie avec de nouvelles cartes.

### Mode « un seul appareil »

Sur l'accueil, choisissez **Un seul appareil** : ajoutez les prénoms des joueurs, répartissez-les
en équipes, puis passez-vous le téléphone. Avant chaque tour, l'écran indique à qui le donner ;
la carte n'apparaît qu'une fois le tour lancé.

### Réglages (hôte)

| Réglage | Par défaut |
|---|---|
| Durée d'un tour | 30 s (de 15 à 120 s) |
| Nombre de cartes | 40 (de 10 à 100) |
| Nombre d'équipes | 2 (jusqu'à 4) |
| Catégories | toutes |
| Difficulté | facile et moyen |
| Cartes ajoutées par chaque joueur | aucune (jusqu'à 10) |
| « Passer » autorisé en manche 1 | oui |
| Temps reporté | oui |

Quand les cartes des joueurs sont activées, chacun écrit ses propres cartes dans le salon (des
proches, des souvenirs…) ; elles sont mélangées aux cartes de la base.

### Pendant la partie

- **Menu** (en haut à droite) : sons, vibrations, thème clair ou sombre, règles, quitter.
- L'hôte peut aussi y **gérer les joueurs** (changer d'équipe, retirer, nommer un autre hôte)
  et **arrêter la partie**.
- **Pause** : celui qui fait deviner ou l'hôte peut arrêter le chrono (la carte est alors cachée).
- **Passer son tour** : l'hôte peut sauter un joueur absent.
- **Reconnexion** : si un joueur recharge la page ou perd le réseau, il retrouve sa place
  automatiquement. Un joueur peut aussi rejoindre une partie déjà commencée.
- Sur ordinateur, celui qui fait deviner peut utiliser le clavier : **Espace** ou **Entrée** pour
  « Trouvé », **flèche droite** ou **P** pour « Passer ».
- L'écran du téléphone reste allumé pendant la partie (si le navigateur le permet).

## Les cartes

La base `TroisTemps.Web/Data/cartes.json` contient plus de 800 cartes en français, réparties en
11 catégories (personnalités, personnages de fiction, lieux et monuments, objets, animaux, métiers,
cuisine, sports et loisirs, films-séries-livres, expressions, notions et actions) et 3 niveaux de
difficulté. Pour en ajouter, complétez le fichier en respectant le format :

```json
{ "t": "La tour Eiffel", "c": "lieux", "d": 1 }
```

`t` est le texte, `c` l'identifiant de la catégorie et `d` la difficulté (1 facile, 2 moyen,
3 difficile). Redémarrez le serveur pour prendre en compte les changements.

## Technique

- **Serveur** : ASP.NET Core 8 (minimal API) et **SignalR** pour le temps réel. Le serveur fait
  autorité : il tient le paquet, le chrono, la rotation des joueurs et les scores, et n'envoie la
  carte en cours qu'à celui qui fait deviner. Les salles sont gardées en mémoire (elles
  disparaissent à l'arrêt du serveur).
- **Navigateur** : HTML, CSS et JavaScript (modules ES), sans étape de compilation. Sons générés
  avec Web Audio, vibrations avec l'API Vibration.
- Bibliothèques incluses dans `wwwroot/lib` : le client SignalR et
  [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (licence MIT).

```
TroisTemps.Web/
  Program.cs            démarrage, API (cartes, adresses réseau) et hub
  Game/RoomManager.cs   salles et règles du jeu
  Game/GameHub.cs       méthodes appelées par les navigateurs, boucle du chrono
  Game/CardLibrary.cs   chargement et tirage des cartes
  Game/Models.cs        modèles et données envoyées aux navigateurs
  Data/cartes.json      base de cartes
  wwwroot/              page, styles et scripts du jeu
```
