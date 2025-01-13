import express from 'express';
import fs from 'fs';
import { Server } from 'socket.io';
import { createServer } from 'https';
import { Quiz } from "./game/Quiz.class.js";
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import config from '../config.json' with { type: 'json' };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

var options = null;
if (config.SSL) {
    options = {
        key: fs.readFileSync('./privkey.pem', 'utf8'),
        cert: fs.readFileSync('./fullchain.pem', 'utf8'),
        ca: fs.readFileSync('./chain.pem', 'utf8')
    };
}

const app = express();
const server = createServer(options, app);
const io = new Server(server);

// Stockage des différentes instances de quiz
const games = new Map();

// Constantes uniques pour l'ensemble des parties
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 10;

// Route pour rejoindre une partie
app.get('/:gameId/:token', express.json(), (req, res) => {
    const gameId = req.params.gameId;
    const token = req.params.token;

    // Vérifier si la partie existe
    if (!games.has(gameId)) {
        res.redirect('/404');
        return;
    }

    // Vérifier si le token est valide en parcourant les joueurs
    let playerFound = false;
    let playerUuid = '';
    games.get(gameId)._scores.forEach((playerData, playerName) => {
        if (playerData.token === token) {
            playerFound = true;
            playerUuid = token;
        }
    });
    if (playerFound) {
        res.sendFile(path.join(__dirname, '../public', 'game.html'));
    }
    else {
        // Rediriger vers une page 403 si le token n'est pas trouvé
        res.redirect('/403');
    }
});

// Route pour initialiser une partie
app.post('/:gameId/init', express.json(), (req, res) => {
    const gameId = req.params.gameId;
    const { settings, players } = req.body;
    if (players.length > MAX_PLAYERS) {
        res.status(409).json({
            success: false,
            message: 'Trop de joueurs pour la partie'
        });
        return;
    }
    if (players.length < MIN_PLAYERS) {
        res.status(409).json({
            success: false,
            message: 'Pas assez de joueurs pour la partie'
        });
        return;
    }
    try {
        games.set(gameId, new Quiz(gameId, settings.nbRounds, settings.roundDuration, players));
        res.status(200).json({
            success: true,
            message: 'Partie initialisée avec succès'
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de l\'initialisation de la partie'
        });
    }

});

// Route d'erreur 404 (page introuvable)
app.get('/404', (req, res) => {
    res.sendFile(path.join(__dirname, '../public', '404.html'));
});

// Route d'erreur 403 (accès interdit)
app.get('/403', (req, res) => {
    res.sendFile(path.join(__dirname, '../public', '403.html'));
});

// Définition du répertoire racine du serveur
app.use(express.static('public'));

// Connexion des utilisateurs
io.on('connection', (socket) => {
    // Récupération du token et de l'ID de la partie depuis la requête de connexion Socket.IO
    const token = socket.handshake.query.token;
    const gameId = socket.handshake.query.gameId;

    // Vérifier si la partie existe
    if (!games.has(gameId)) {
        return;
    }

    let currentGame = games.get(gameId);
    let pseudonyme = '';

    // Récupération du pseudonyme du joueur
    currentGame._scores.forEach((playerData, playerName) => {
        if (playerData.token === token) {
            pseudonyme = playerName;
            currentGame._scores.get(playerName).connected = true;
        }
    });

    // Rejoindre la room de cette partie
    socket.join(gameId);
    socket.username = pseudonyme;
    socket.emit('join', pseudonyme);
    socket.emit('update leaderboard', currentGame.getLeaderboard());

    // Envoi de la manche déjà en cours (s'il y en a une)
    if (currentGame.isRoundActive) {
        socket.emit('new round', {
            roundNumber: currentGame.currentRound,
            personality: currentGame.currentPersonality
        });
        socket.emit('timer', {
            totalTime: currentGame.roundDuration,
            timeLeft: currentGame.timeLeft
        });
    }

    // Envoi du leaderboard à jour
    io.to(gameId).emit('update leaderboard', currentGame.getLeaderboard());

    // Annonce dans le chat
    socket.to(gameId).emit('message', {
        playerName: 'System',
        msg: `${pseudonyme} a rejoint la partie !`,
    });

    // Vérification si la partie peut commencer
    // currentGame.scores.size >= MIN_PLAYERS &&
    if (!currentGame.isRoundActive && !currentGame.isGameOver()) {
        io.to(gameId).emit('message', {
            playerName: 'System',
            msg: 'La partie commence !'
        });
        currentGame.startNewRound(currentGame.getRandomPersonality());
        io.to(gameId).emit('new round', {
            roundNumber: currentGame.currentRound,
            personality: currentGame.currentPersonality
        });
        io.to(gameId).emit('timer', {
            totalTime: currentGame.roundDuration,
            timeLeft: currentGame.timeLeft
        });
        currentGame.startTimer(io);
    }

    // Lorsque l'utilisateur se déconnecte
    socket.on('disconnect', () => {
        currentGame._usedPersonalities.delete(socket.username);  // Re-liberer le pseudonyme
        currentGame._scores.get(socket.username).connected = false; // Mettre le statut du joueur en deconnecté

        // Mise à jour du leaderboard après la déconnexion
        io.to(gameId).emit('update leaderboard', currentGame.getLeaderboard());

        // Si après la déconnexion il n'y a plus assez de joueurs, on arrête la partie
        if (Array.from(currentGame.scores).filter(player => player.connected).length < currentGame.minPlayers) {
            io.to(gameId).emit('message', {
                playerName: 'System',
                msg: 'Pas assez de joueurs pour continuer la partie, elle va être fermée.'
            });
            currentGame.endRound();
            currentGame.endGame(io);
        }
    });

    // Lorsque les joueurs envoient une proposition de réponse
    socket.on('guess', async ({playerName, message}) => {
        const sendDelayedMessage = (message, delay) => {
            return new Promise(resolve => {
                setTimeout(() => {
                    io.to(gameId).emit('message', message);
                    resolve();
                }, delay);
            });
        };

        const sendDelayedMessageToSocket = (message, delay) => {
            return new Promise(resolve => {
                setTimeout(() => {
                    socket.emit('message', message);
                    resolve();
                }, delay);
            });
        };

        // Envoi immédiat du message du joueur
        io.to(gameId).emit('message', {
            playerName: playerName,
            msg: message,
        });

        if (!currentGame.isRoundActive) {
            return;
        }

        if (currentGame.currentPersonality.answer.map(answer => answer.toLowerCase()).includes(message.toLowerCase())) {
            // Arrêt du round en cours pour éviter les multiples réponses
            let personality = currentGame.currentPersonality;
            currentGame.endRound();

            // Incrémentation du score
            let player = currentGame.scores.get(playerName);
            player.score++;
            currentGame.scores.set(playerName, player);

            // Envoi de messages aux joueurs
            io.to(gameId).emit('message', {
                playerName: 'System',
                msg: `Bonne réponse de ${playerName}, la personnalité était ${personality.answer[0]} !`
            });

            // Envoyer la mise à jour du leaderboard à tous les clients
            io.to(gameId).emit('update leaderboard', currentGame.getLeaderboard());

            await sendDelayedMessageToSocket({
                playerName: 'System',
                msg: `Votre score : ${currentGame.scores.get(playerName).score} point(s)`
            }, 1000);

            if (currentGame.isGameOver()) {
                if (currentGame.endGame(io)) {
                    setTimeout(() => {
                        io.to(gameId).emit('redirect', {
                            url: `${config.URL_COMUS}`,
                        });
                    }, 7500);
                    games.delete(gameId);
                }
            } else {
                setTimeout(() => {
                    currentGame.startNewRound(currentGame.getRandomPersonality());
                    io.to(gameId).emit('new round', {
                        roundNumber: currentGame.currentRound,
                        personality: currentGame.currentPersonality,
                    });
                    io.to(gameId).emit('timer', {
                        totalTime: currentGame.roundDuration,
                        timeLeft: currentGame.timeLeft
                    });
                    currentGame.startTimer(io);
                }, 3000);
            }
        } else {
            // Message d'erreur
            socket.emit('message', {
                playerName: 'System',
                msg: `${message} : Mauvaise réponse ! Tenez bon...`
            });
        }
    });
});

server.listen(config.PORT, () => {
    console.log(`Server running on port ${config.PORT}`);
});
