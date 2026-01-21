const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

const WIKI_HEADERS = {
    'User-Agent': 'WikiChallengeGame/3.0 (Educational Project)',
    'Accept-Encoding': 'gzip, deflate, br'
};

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'wiki-secret-key-pro',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

const rooms = {};

// --- AUTH ---
app.post('/login', (req, res) => {
    const username = req.body.username;
    if (!username || username.trim() === "") return res.redirect('/');
    req.session.user = {
        id: 'user_' + Date.now() + Math.floor(Math.random() * 1000),
        username: username.trim()
    };
    res.redirect('/');
});
app.get('/api/me', (req, res) => res.json(req.session.user || null));
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// --- PROXY ---
app.get('/wiki-proxy', async (req, res) => {
    const { page, room } = req.query;
    if (!page) return res.send("Erreur: Pas de page");
    const cleanPage = page.split('#')[0];

    try {
        const url = `https://fr.wikipedia.org/wiki/${encodeURIComponent(cleanPage)}`;
        const response = await axios.get(url, { headers: WIKI_HEADERS });
        const html = response.data;
        const $ = cheerio.load(html);

        $('link[rel="stylesheet"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.startsWith('/')) $(el).attr('href', 'https://fr.wikipedia.org' + href);
        });
        $('img').each((i, el) => {
            const src = $(el).attr('src');
            if (src && src.startsWith('/')) $(el).attr('src', 'https://fr.wikipedia.org' + src);
            $(el).removeAttr('srcset');
        });

        $('a').each((i, el) => {
            let href = $(el).attr('href');
            if (href && href.startsWith('/wiki/')) {
                let targetPage = href.replace('/wiki/', '').split('#')[0];
                $(el).attr('href', '#'); 
                $(el).attr('data-target-page', targetPage);
                $(el).addClass('game-link');
                $(el).css('cursor', 'pointer');
            } else {
                $(el).removeAttr('href').css('color', 'gray').css('cursor', 'not-allowed');
            }
        });

        $('head').append(`<base href="/wiki-proxy?room=${room}&page=">`);
        $('script').remove(); 
        $('.mw-page-container-header, #mw-navigation, #footer, .mw-editsection, #siteNotice, .mw-ui-icon, .reference').remove();

        $('body').append(`
            <script>
                document.addEventListener('click', function(e) {
                    const link = e.target.closest('.game-link');
                    if (link) {
                        e.preventDefault();
                        const targetPage = link.getAttribute('data-target-page');
                        if (targetPage) {
                            window.parent.postMessage({ type: 'page_click', page: decodeURIComponent(targetPage) }, '*');
                        }
                    }
                });
            </script>
            <style>
                body { background: #fff; overflow-x: hidden; padding: 15px; }
                .mw-page-container { max-width: 100% !important; }
                #content { margin: 0 !important; padding: 0 !important; border: none !important; }
                .game-link { color: #0645ad; text-decoration: none; }
                .game-link:hover { text-decoration: underline; }
            </style>
        `);
        res.send($.html());
    } catch (error) {
        res.send(`<div style="padding:50px; text-align:center"><h2>⚠️ Page inaccessible</h2></div>`);
    }
});
app.get('/wiki/*', (req, res) => res.redirect('/'));

// --- SOCKET ---
io.on('connection', (socket) => {
    socket.on('recover_session', (user) => {
        if (!user) return;
        socket.user = user;
        let foundRoom = null;
        for (const code in rooms) {
            const room = rooms[code];
            const player = room.players.find(p => p.id === user.id);
            if (player) {
                foundRoom = room;
                player.socketId = socket.id;
                socket.join(room.code);
                break;
            }
        }
        if (foundRoom) {
            socket.emit('room_joined', foundRoom);
            if (foundRoom.state === 'PLAYING') {
                const player = foundRoom.players.find(p => p.id === user.id);
                socket.emit('round_start_immediate', { 
                    startPage: foundRoom.startPage, 
                    targetPage: foundRoom.targetPage,
                    round: foundRoom.currentRound,
                    totalRounds: foundRoom.settings.rounds,
                    recoverPage: player.currentPage,
                    startTime: foundRoom.startTime,
                    settings: foundRoom.settings
                });
            }
        }
    });

    socket.on('join_lobby', ({ user, roomCode }) => {
        if(!user) return;
        socket.user = user;
        
        if (!roomCode) {
            const code = Math.random().toString(36).substring(2, 7).toUpperCase();
            rooms[code] = {
                code, host: user.id, players: [], state: 'LOBBY',
                settings: { mode: 'SPEED', timeLimit: 0, rounds: 3, visibility: true }, 
                currentRound: 0, startTime: 0
            };
            addPlayerToRoom(socket, code, user);
        } else {
            if (rooms[roomCode]) addPlayerToRoom(socket, roomCode, user);
            else socket.emit('error', 'Partie introuvable.');
        }
    });

    socket.on('update_settings', ({ roomCode, settings }) => {
        const room = rooms[roomCode];
        if (room && room.host === socket.user.id && room.state === 'LOBBY') {
            room.settings = { ...room.settings, ...settings };
            io.to(roomCode).emit('settings_updated', room.settings);
        }
    });

    socket.on('start_game', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.host === socket.user.id) {
            // Si c'est le début d'une NOUVELLE partie (round 0 ou après game over), on reset les scores
            if (room.currentRound === 0 || room.currentRound >= room.settings.rounds) {
                 room.currentRound = 0;
                 room.players.forEach(p => p.score = 0);
                 io.to(roomCode).emit('room_update', room); // Update UI scores
            }
            startRound(roomCode);
        }
    });

    socket.on('player_navigated', ({ roomCode, page }) => {
        const room = rooms[roomCode];
        if (!room || room.state !== 'PLAYING') return;
        const player = room.players.find(p => p.socketId === socket.id);
        
        if (player && !player.finished && !player.forfeited) {
            player.clicks++;
            player.currentPage = decodeURIComponent(page).replace(/_/g, ' ');

            const cleanPage = player.currentPage.toLowerCase();
            const cleanTarget = decodeURIComponent(room.targetPage).replace(/_/g, ' ').toLowerCase();

            if (cleanPage === cleanTarget) {
                player.finished = true;
                player.finishTime = Date.now();
                io.to(roomCode).emit('notification', { 
                    type: 'success', 
                    message: `🏁 ${player.username} a trouvé la page !` 
                });
                io.to(roomCode).emit('player_finished', { player: player.username });
                checkEndRound(roomCode);
            } else {
                io.to(roomCode).emit('progress_update', { 
                    playerId: player.id, 
                    clicks: player.clicks, 
                    currentPage: room.settings.visibility ? player.currentPage : '???' 
                });
            }
        }
    });

    socket.on('forfeit', (roomCode) => {
        const room = rooms[roomCode];
        if (!room || room.state !== 'PLAYING') return;
        const player = room.players.find(p => p.socketId === socket.id);
        if (player && !player.finished && !player.forfeited) {
            player.forfeited = true;
            io.to(roomCode).emit('notification', { type: 'info', message: `${player.username} a abandonné.` });
            io.to(roomCode).emit('player_forfeited', { playerId: player.id });
            checkEndRound(roomCode);
        }
    });
});

function addPlayerToRoom(socket, code, user) {
    const room = rooms[code];
    const existing = room.players.find(p => p.id === user.id);
    if (!existing) {
        room.players.push({ ...user, socketId: socket.id, score: 0, clicks: 0, currentPage: 'Lobby', finished: false, forfeited: false });
    } else { existing.socketId = socket.id; }
    socket.join(code);
    socket.emit('room_joined', room);
    io.to(code).emit('room_update', room);
}

async function startRound(roomCode) {
    const room = rooms[roomCode];
    
    try {
        const api = "https://fr.wikipedia.org/w/api.php?action=query&format=json&list=random&rnnamespace=0&rnlimit=2";
        const res = await axios.get(api, { headers: WIKI_HEADERS });
        const articles = res.data.query.random;
        
        room.startPage = articles[0].title;
        room.targetPage = articles[1].title;
        
        room.players.forEach(p => { 
            p.clicks = 0; p.currentPage = room.startPage; 
            p.finished = false; p.forfeited = false; p.finishTime = null;
        });

        room.currentRound++;

        io.to(roomCode).emit('round_prepare', { 
            startPage: room.startPage, 
            targetPage: room.targetPage,
            round: room.currentRound, 
            totalRounds: room.settings.rounds
        });

        setTimeout(() => {
            room.state = 'PLAYING';
            room.startTime = Date.now();
            io.to(roomCode).emit('round_start', { 
                startTime: room.startTime,
                settings: room.settings
            });
        }, 3500);

    } catch (e) { console.error("Erreur API:", e.message); }
}

function checkEndRound(roomCode) {
    const room = rooms[roomCode];
    const allDone = room.players.every(p => p.finished || p.forfeited);
    if (allDone) endRound(roomCode);
}

function endRound(roomCode) {
    const room = rooms[roomCode];
    room.state = 'LOBBY';
    
    // Attribution des points du round
    const finishers = room.players.filter(p => p.finished);
    let roundWinner = null;

    if (finishers.length > 0) {
        if (room.settings.mode === 'SPEED') finishers.sort((a, b) => a.finishTime - b.finishTime);
        else finishers.sort((a, b) => a.clicks - b.clicks);

        finishers.forEach((p, index) => {
            if (index === 0) p.score += 10;
            else if (index === 1) p.score += 5;
            else p.score += 2;
        });
        roundWinner = finishers[0];
    }

    // VÉRIFICATION FIN DE PARTIE
    if (room.currentRound >= room.settings.rounds) {
        // C'est le dernier round -> GAME OVER
        // On trie le classement général par SCORE total
        const leaderboard = [...room.players].sort((a, b) => b.score - a.score);
        
        // On reset le compteur de round pour la prochaine fois
        room.currentRound = 0; 
        
        io.to(roomCode).emit('game_over', { 
            leaderboard: leaderboard, 
            room 
        });
    } else {
        // Simple fin de round
        io.to(roomCode).emit('round_end', { 
            winnerName: roundWinner ? roundWinner.username : null, 
            room 
        });
    }
}

server.listen(PORT, () => {
    console.log(`Serveur lancé sur http://localhost:${PORT}`);
});